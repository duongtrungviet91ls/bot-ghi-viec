'use strict';
/*
 * Trình cập nhật của Bot Mặt trận Lạng Sơn — chạy ĐỘC LẬP, do bot.js gọi khi đã tải xong
 * bản mới về thư mục update-staging và ghi update-pending.json.
 *
 * Việc của nó:
 *   1. Chờ bot cũ thoát hẳn (và ép thoát nếu nó còn treo).
 *   2. Sao lưu các file sắp thay vào backup/v<bản cũ>.
 *   3. Thay file mới, khởi động lại bot (chạy nền, ghi log vào bot.log).
 *   4. Theo dõi update-state.json: bot mới ghi "ok" đúng phiên bản mới trong thời hạn
 *      (mặc định 120 giây) → cập nhật thành công, dọn dẹp.
 *   5. Quá hạn mà bot mới chưa "ok" → KHÔI PHỤC bản sao lưu, chạy lại bản cũ, ghi
 *      update-rollback.json để bản cũ nhắn báo cho chủ bot khi nó lên.
 *
 * File này KHÔNG bao giờ tự cập nhật (bot.js cũng từ chối bản kê có chứa nó).
 * Nhật ký của trình cập nhật: update.log cùng thư mục.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const stagingDir = path.join(DIR, 'update-staging');
const stateFile = path.join(DIR, 'update-state.json');
const pendingFile = path.join(DIR, 'update-pending.json');
const rollbackFile = path.join(DIR, 'update-rollback.json');
const DEADLINE_MS = Number(process.env.BOT_UPDATE_DEADLINE_MS || 120000);

function log(...a) {
  const line = `[${new Date().toISOString()}] ` + a.join(' ');
  try { fs.appendFileSync(path.join(DIR, 'update.log'), line + '\n'); } catch {}
  console.log(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function startBot() {
  const out = fs.openSync(path.join(DIR, 'bot.log'), 'a');
  const child = spawn(process.execPath, [path.join(DIR, 'bot.js')], { cwd: DIR, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  return child.pid;
}

async function main() {
  const pending = readJson(pendingFile);
  if (!pending || !pending.toVersion || !pending.fromVersion) { log('Không có update-pending.json hợp lệ — bỏ qua.'); return; }
  let files = [];
  try { files = fs.readdirSync(stagingDir).filter((f) => fs.statSync(path.join(stagingDir, f)).isFile()); } catch {}
  if (!files.length) { log('Thư mục update-staging rỗng — bỏ qua.'); return; }
  log(`Bắt đầu cập nhật v${pending.fromVersion} → v${pending.toVersion} (${files.length} file).`);

  // 1) Chờ bot cũ thoát; quá 15 giây mà còn sống thì ép thoát (nó đã bàn giao xong rồi).
  const t0 = Date.now();
  while (pidAlive(pending.pid) && Date.now() - t0 < 15000) await sleep(500);
  if (pidAlive(pending.pid)) {
    log(`Bot cũ (pid ${pending.pid}) chưa thoát — ép thoát.`);
    try { process.kill(pending.pid); } catch {}
    await sleep(2000);
  }
  await sleep(1500); // nhả hẳn cổng cầu nối + phiên nghe tin

  // 2) Sao lưu + 3) thay file
  const backupDir = path.join(DIR, 'backup', 'v' + pending.fromVersion);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const f of files) {
    const cur = path.join(DIR, f);
    if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(backupDir, f));
  }
  for (const f of files) fs.copyFileSync(path.join(stagingDir, f), path.join(DIR, f));
  log('Đã thay file. Khởi động bot mới…');
  try { fs.rmSync(stateFile); } catch {} // xóa trạng thái cũ để khỏi đọc nhầm "ok" của bản trước
  const newPid = startBot();

  // 4) Theo dõi bot mới
  const deadline = Date.now() + DEADLINE_MS;
  let ok = false;
  while (Date.now() < deadline) {
    await sleep(3000);
    const st = readJson(stateFile);
    if (st && st.status === 'ok' && st.version === pending.toVersion) { ok = true; break; }
  }
  if (ok) {
    log(`✅ Bot v${pending.toVersion} đã chạy ổn định. Cập nhật hoàn tất.`);
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    return; // update-pending.json để lại cho bot mới tự đọc và nhắn báo chủ bot, nó sẽ xóa
  }

  // 5) Quay lui
  log(`⚠️ Bot v${pending.toVersion} không khởi động ổn trong ${Math.round(DEADLINE_MS / 1000)} giây — khôi phục v${pending.fromVersion}.`);
  if (pidAlive(newPid)) { try { process.kill(newPid); } catch {} await sleep(2000); }
  for (const f of files) {
    const bak = path.join(backupDir, f);
    if (fs.existsSync(bak)) fs.copyFileSync(bak, path.join(DIR, f));
  }
  fs.writeFileSync(rollbackFile, JSON.stringify({ failedVersion: pending.toVersion, backTo: pending.fromVersion, at: new Date().toISOString() }));
  // Ghi vào "sổ đen" để bot không thử lại chính phiên bản lỗi này (tránh vòng lặp vô hạn);
  // bản sửa phải mang số phiên bản cao hơn thì bot mới lên tiếp.
  try { fs.writeFileSync(path.join(DIR, 'update-failed.json'), JSON.stringify({ version: pending.toVersion, at: new Date().toISOString() })); } catch {}
  try { fs.rmSync(pendingFile); } catch {}
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(stateFile); } catch {}
  startBot();
  log(`Đã khôi phục và chạy lại bot v${pending.fromVersion}.`);
}

main().catch((e) => log('updater lỗi:', e.message));

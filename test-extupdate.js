// Kiểm thử mục TỰ CẬP NHẬT EXTENSION (v3.9) + LỆNH TRẠNG THÁI (v3.10) của bot.js:
// trích đúng đoạn code thật (giữa hai mốc [EXTUPDATE-SECTION]) và chạy với kho GitHub
// giả lập trên đĩa.
// 5 ca cập nhật: chưa khai báo thư mục / đã mới nhất / có bản mới → chép đúng + báo tín
// hiệu / sai mã băm → hủy, thư mục nguyên vẹn / thư mục mới hơn (cài tay) → không hạ cấp.
// 4 ca trạng thái: chưa ghé lần nào / đang sống + đếm hàng lệnh / mất tín hiệu /
// cập nhật đang chờ nạp rồi khớp.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const botSrc = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
const region = botSrc.slice(botSrc.indexOf('// [EXTUPDATE-SECTION]'), botSrc.indexOf('// [/EXTUPDATE-SECTION]'));
if (!region.includes('async function checkExtUpdate') || !region.includes('function extSignalFor')) {
  console.error('Không trích được mục cập nhật extension từ bot.js'); process.exit(2);
}
// Tiện ích thật của bot (bản sao nguyên văn các hàm thuần, để nạp đoạn trích)
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readJsonFile(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra ? '→ ' + extra : ''); }
}

function setup(repoVersion, opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extupd-'));
  const botDir = path.join(root, 'bot'); fs.mkdirSync(botDir);
  const extDir = path.join(root, 'mttq-auto-post'); fs.mkdirSync(path.join(extDir, 'icons'), { recursive: true });
  const repoDir = path.join(root, 'repo'); fs.mkdirSync(path.join(repoDir, 'ext', 'icons'), { recursive: true });
  // Thư mục extension hiện tại: v2.40.0 (hoặc opts.folderVersion)
  const folderVer = opts.folderVersion || '2.40.0';
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({ version: folderVer }));
  fs.writeFileSync(path.join(extDir, 'background.js'), 'OLD-BG');
  // Kho giả lập: bản repoVersion
  const repoFiles = {
    'manifest.json': Buffer.from(JSON.stringify({ version: repoVersion })),
    'background.js': Buffer.from('NEW-BG-' + repoVersion),
    'content.js': Buffer.from('NEW-CONTENT'),
    'icons/icon128.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
  };
  const manFiles = {};
  for (const [name, buf] of Object.entries(repoFiles)) {
    fs.writeFileSync(path.join(repoDir, 'ext', name), buf);
    manFiles[name] = { sha256: opts.corrupt === name ? '0'.repeat(64) : sha256hex(buf) };
  }
  fs.writeFileSync(path.join(repoDir, 'ext-version.json'), JSON.stringify({ version: repoVersion, notes: 'bản kiểm thử', files: manFiles }));
  if (!opts.unconfigured) fs.writeFileSync(path.join(botDir, 'ext-update.json'), JSON.stringify({ folder: extDir, enabled: true }));

  const sent = [];
  const CONFIG = { extManifestUrl: 'https://repo.test/ext-version.json', extFilesBase: 'https://repo.test/ext/', extCheckMs: 30 * 60 * 1000 };
  const fetchBuf = async (url) => {
    const clean = url.split('?')[0];
    if (clean === CONFIG.extManifestUrl) return fs.readFileSync(path.join(repoDir, 'ext-version.json'));
    if (clean.startsWith(CONFIG.extFilesBase)) return fs.readFileSync(path.join(repoDir, 'ext', clean.slice(CONFIG.extFilesBase.length)));
    throw new Error('URL lạ: ' + url);
  };
  const store = { posters: ['owner1'], chats: {}, postQueue: [] };
  const bridgeWatch = { lastPollAt: 0, lastLaunchAt: 0, extVersion: '' };
  const factory = new Function('fs', 'path', '__dirname', 'CONFIG', 'fetchBuf', 'send', 'store', 'readJsonFile', 'cmpVersion', 'sha256hex', 'bridgeWatch',
    region + '\nreturn { checkExtUpdate, extSignalFor, validExtManifest, bridgeStatusText };');
  const api = factory(fs, path, botDir, CONFIG, fetchBuf, async (to, text) => { sent.push({ to, text }); }, store, readJsonFile, cmpVersion, sha256hex, bridgeWatch);
  return { root, botDir, extDir, api, sent, store, bridgeWatch };
}

(async () => {
  console.log('== Ca 1: chưa khai báo thư mục → bỏ qua êm ==');
  {
    const s = setup('2.41.0', { unconfigured: true });
    const r = await s.api.checkExtUpdate(true);
    check('trả unconfigured', r === 'unconfigured', r);
    check('thư mục không bị đụng', fs.readFileSync(path.join(s.extDir, 'background.js'), 'utf8') === 'OLD-BG');
  }
  console.log('== Ca 2: kho bằng bản thư mục → đã mới nhất ==');
  {
    const s = setup('2.40.0');
    const r = await s.api.checkExtUpdate(true);
    check('trả uptodate', r === 'uptodate', r);
    check('không chép gì', fs.readFileSync(path.join(s.extDir, 'background.js'), 'utf8') === 'OLD-BG');
  }
  console.log('== Ca 3: có bản mới → chép đúng, ghi sổ, có tín hiệu nạp lại ==');
  {
    const s = setup('2.41.0');
    const r = await s.api.checkExtUpdate(true);
    check('trả updated', r === 'updated', r);
    check('background.js đã là bản mới', fs.readFileSync(path.join(s.extDir, 'background.js'), 'utf8') === 'NEW-BG-2.41.0');
    check('content.js mới được thêm', fs.readFileSync(path.join(s.extDir, 'content.js'), 'utf8') === 'NEW-CONTENT');
    check('icon chép đúng từng byte', fs.readFileSync(path.join(s.extDir, 'icons', 'icon128.png')).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])));
    check('manifest.json trong thư mục ghi 2.41.0', JSON.parse(fs.readFileSync(path.join(s.extDir, 'manifest.json'), 'utf8')).version === '2.41.0');
    const inst = readJsonFile(path.join(s.botDir, 'ext-installed.json'));
    check('ext-installed.json ghi 2.41.0', !!inst && inst.version === '2.41.0', JSON.stringify(inst));
    check('tín hiệu cho extension 2.40.0: có extUpdate', JSON.stringify(s.api.extSignalFor('2.40.0')) === JSON.stringify({ version: '2.41.0' }));
    check('tín hiệu cho extension 2.41.0: hết báo', s.api.extSignalFor('2.41.0') === null);
    check('chủ bot được nhắn 🧩', s.sent.length === 1 && s.sent[0].text.includes('🧩') && s.sent[0].text.includes('2.41.0'), JSON.stringify(s.sent));
    const r2 = await s.api.checkExtUpdate(true);
    check('kiểm tra lại ngay: uptodate (không chép lặp)', r2 === 'uptodate', r2);
  }
  console.log('== Ca 4: sai mã băm 1 file → hủy cả đợt, thư mục nguyên vẹn ==');
  {
    const s = setup('2.41.0', { corrupt: 'content.js' });
    const r = await s.api.checkExtUpdate(true);
    check('trả error', r === 'error', r);
    check('background.js vẫn bản cũ', fs.readFileSync(path.join(s.extDir, 'background.js'), 'utf8') === 'OLD-BG');
    check('manifest.json vẫn 2.40.0', JSON.parse(fs.readFileSync(path.join(s.extDir, 'manifest.json'), 'utf8')).version === '2.40.0');
    check('không ghi ext-installed.json', !fs.existsSync(path.join(s.botDir, 'ext-installed.json')));
    check('không nhắn chủ bot', s.sent.length === 0);
  }
  console.log('== Ca 5: thư mục đã cài tay bản MỚI HƠN kho → tôn trọng, không hạ cấp ==');
  {
    const s = setup('2.41.0', { folderVersion: '2.42.0' });
    const r = await s.api.checkExtUpdate(true);
    check('trả uptodate', r === 'uptodate', r);
    check('manifest.json vẫn 2.42.0', JSON.parse(fs.readFileSync(path.join(s.extDir, 'manifest.json'), 'utf8')).version === '2.42.0');
    check('background.js không bị chép đè', fs.readFileSync(path.join(s.extDir, 'background.js'), 'utf8') === 'OLD-BG');
  }
  console.log('== Ca 6 (trạng thái): extension chưa ghé cầu nối lần nào ==');
  {
    const s = setup('2.41.0', { unconfigured: true });
    const t = s.api.bridgeStatusText(Date.now());
    check('báo CHƯA THẤY GHÉ CẦU NỐI', t.includes('CHƯA THẤY GHÉ CẦU NỐI LẦN NÀO'), t);
    check('báo chưa khai báo thư mục', t.includes('chưa khai báo thư mục'), t);
    check('hàng lệnh 0 chờ · 0 chạy', t.includes('0 đang chờ · 0 đang chạy'), t);
  }
  console.log('== Ca 7 (trạng thái): đang sống, có phiên bản, đếm đúng hàng lệnh ==');
  {
    const s = setup('2.41.0');
    s.bridgeWatch.lastPollAt = Date.now() - 50 * 1000;
    s.bridgeWatch.extVersion = '2.41.0';
    s.store.postQueue = [{ status: 'queued' }, { status: 'running' }, { status: 'done' }];
    const t = s.api.bridgeStatusText(Date.now());
    check('báo ĐANG SỐNG', t.includes('ĐANG SỐNG'), t);
    check('kèm phiên bản v2.41.0', t.includes('v2.41.0'), t);
    check('đếm 1 đang chờ · 1 đang chạy', t.includes('1 đang chờ · 1 đang chạy'), t);
  }
  console.log('== Ca 8 (trạng thái): mất tín hiệu 30 phút ==');
  {
    const s = setup('2.41.0');
    s.bridgeWatch.lastPollAt = Date.now() - 30 * 60 * 1000;
    s.bridgeWatch.extVersion = '2.41.0';
    const t = s.api.bridgeStatusText(Date.now());
    check('báo MẤT TÍN HIỆU', t.includes('MẤT TÍN HIỆU'), t);
    check('nhắc trực ban tự mở lại Chrome', t.includes('tự mở lại Chrome'), t);
    check('ghi 30 phút trước', t.includes('30 phút trước'), t);
  }
  console.log('== Ca 9 (trạng thái): cập nhật chờ nạp → nạp xong thì khớp ==');
  {
    const s = setup('2.41.0'); // thư mục đang 2.40.0, kho có 2.41.0
    await s.api.checkExtUpdate(true); // bot chép 2.41.0 vào thư mục
    s.bridgeWatch.lastPollAt = Date.now();
    s.bridgeWatch.extVersion = '2.40.0'; // extension vẫn chạy bản cũ
    let t = s.api.bridgeStatusText(Date.now());
    check('báo sẽ tự nạp bản mới khi rảnh', t.includes('sẽ tự nạp bản mới khi rảnh'), t);
    s.bridgeWatch.extVersion = '2.41.0'; // extension đã nạp lại
    t = s.api.bridgeStatusText(Date.now());
    check('báo khớp, không có gì chờ nạp', t.includes('khớp, không có gì chờ nạp'), t);
  }
  console.log('\nKẾT QUẢ: ' + pass + ' đạt, ' + fail + ' lỗi');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('LỖI CHẠY TEST:', e); process.exit(2); });

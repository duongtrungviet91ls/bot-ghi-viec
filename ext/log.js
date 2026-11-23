const $ = (id) => document.getElementById(id);
function fmtTime(ts) { try { return new Date(ts).toLocaleString('vi-VN'); } catch (e) { return ''; } }

document.addEventListener('DOMContentLoaded', async () => {
  const { lastRun } = await chrome.storage.local.get(['lastRun']);
  const box = $('content');
  if (!lastRun || !lastRun.items || !lastRun.items.length) {
    box.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = 'Chưa có đợt đăng nào được ghi lại. (Extension ghi log đợt đăng từ bản 2.32 — các đợt chạy trước đó không xem lại được.)';
    box.appendChild(p);
    $('copy').style.display = 'none';
    return;
  }
  const st = (v) => v === 'ok' ? '✔ Xong' : v === 'duplicate' ? '⏭ Đã có bài này' : v === 'skipped' ? '⏭ Chưa chạy' : v === 'stopped' ? '⛔ Đã dừng' : '✖ Chưa xong';
  let text = 'Đợt đăng: ' + fmtTime(lastRun.at) + ' — ' + lastRun.items.length + ' bài\n';
  box.innerHTML = '';
  const head = document.createElement('p');
  head.textContent = 'Đợt đăng bắt đầu ' + fmtTime(lastRun.at) + ' — ' + lastRun.items.length + ' bài. Cần gửi log để hỗ trợ thì bấm “Sao chép toàn bộ log” ở trên rồi dán vào nơi cần gửi.';
  box.appendChild(head);
  lastRun.items.forEach((it, i) => {
    const parts = [];
    if (it.mttq) parts.push('Cổng MTTQ: ' + st(it.mttq) + (it.mttqUrl ? ' — ' + it.mttqUrl : ''));
    if (it.zalo) parts.push('Zalo OA: ' + st(it.zalo));
    if (it.stopped) parts.push('⛔ Bị dừng khẩn cấp giữa chừng');
    const h = document.createElement('h2');
    h.textContent = (i + 1) + '. ' + (it.title || it.url || '(không rõ bài)');
    box.appendChild(h);
    const meta = document.createElement('p');
    meta.textContent = parts.join(' · ');
    box.appendChild(meta);
    const src = document.createElement('p');
    src.appendChild(document.createTextNode('Link nguồn: '));
    const a = document.createElement('a');
    a.href = it.url || '#'; a.textContent = it.url || ''; a.target = '_blank'; a.rel = 'noopener';
    src.appendChild(a);
    box.appendChild(src);
    const pre = document.createElement('pre');
    pre.textContent = (it.lines || []).join('\n');
    box.appendChild(pre);
    text += '\n=== ' + (i + 1) + '. ' + (it.title || it.url || '') + ' ===\n' + parts.join(' · ') + '\nLink nguồn: ' + (it.url || '') + '\n' + (it.lines || []).join('\n') + '\n';
  });
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(text); $('msg').textContent = '✔ Đã sao chép — dán vào nơi cần gửi là được.'; }
    catch (e) { $('msg').textContent = 'Không sao chép được: ' + (e && e.message || e); }
  };
});

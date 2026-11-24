const $ = (id) => document.getElementById(id);
document.addEventListener('DOMContentLoaded', async () => {
  const { mttqCreds } = await chrome.storage.local.get(['mttqCreds']);
  if (mttqCreds && mttqCreds.u) {
    $('u').value = mttqCreds.u;
    $('msg').textContent = 'Đã có tài khoản được lưu: ' + mttqCreds.u + ' (mật khẩu không hiển thị). Nhập mật khẩu mới rồi bấm Lưu nếu muốn thay.';
  }
  $('save').onclick = async () => {
    const u = $('u').value.trim(), p = $('p').value;
    if (!u || !p) { $('msg').textContent = 'Hãy nhập đủ tài khoản và mật khẩu.'; return; }
    await chrome.storage.local.set({ mttqCreds: { u: u, p: p } });
    $('p').value = '';
    $('msg').textContent = '✔ Đã lưu. Từ giờ extension sẽ tự đăng nhập khi cần.';
  };
  $('clear').onclick = async () => {
    await chrome.storage.local.remove(['mttqCreds']);
    $('u').value = ''; $('p').value = '';
    $('msg').textContent = 'Đã xóa thông tin đăng nhập đã lưu.';
  };
});

// ---- Radar bài mới + quét từ khóa (v2.42) ----
document.addEventListener('DOMContentLoaded', async () => {
  const { radarCfg } = await chrome.storage.local.get(['radarCfg']);
  const cfg = radarCfg || { enabled: true, keywords: ['Mặt trận', 'MTTQ', 'Đại đoàn kết'] };
  $('radarEnabled').checked = cfg.enabled !== false;
  $('radarKeywords').value = (cfg.keywords || []).join('\n');
  if (radarCfg) $('radarMsg').textContent = 'Đã có cấu hình radar được lưu.';
  $('radarSave').onclick = async () => {
    const keywords = $('radarKeywords').value.split('\n').map(s => s.trim()).filter(Boolean);
    await chrome.storage.local.set({ radarCfg: { enabled: $('radarEnabled').checked, keywords: keywords } });
    $('radarMsg').textContent = '✔ Đã lưu. Radar quét mỗi 15 phút khi Chrome mở' + (keywords.length ? ' — đang theo dõi ' + keywords.length + ' từ khóa.' : ' — chưa có từ khóa nào thì bài mới sẽ không được báo (vẫn ghi nhận mốc).');
  };
  $('radarScanNow').onclick = async () => {
    $('radarMsg').textContent = 'Đang quét 3 báo…';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'RADAR_SCAN_NOW' });
      const s = (r && r.summary) || {};
      if (s.busy) $('radarMsg').textContent = 'Đang có 1 lượt quét khác chạy — chờ chút rồi mở popup xem kết quả.';
      else if (s.error) $('radarMsg').textContent = 'Quét lỗi: ' + s.error;
      else if (s.seeded) $('radarMsg').textContent = '✔ Quét xong lần đầu: đã ghi nhận ' + s.found + ' bài hiện có làm mốc — từ lần quét sau mới báo bài mới.';
      else $('radarMsg').textContent = '✔ Quét xong: ' + s.found + ' link trên trang chủ, ' + s.fresh + ' bài mới, ' + s.matched + ' bài trúng từ khóa' + (s.matched ? ' — xem trong popup của extension.' : '.');
    } catch (e) {
      $('radarMsg').textContent = 'Không gọi được lượt quét: ' + (e && e.message || e);
    }
  };
});

// ---- Thông báo về Zalo cá nhân qua Bot nội bộ (v2.13) ----
document.addEventListener('DOMContentLoaded', async () => {
  const botApi = (token, method) => 'https://bot-api.zaloplatforms.com/bot' + token + '/' + method;
  async function callBot(token, method, payload) {
    const res = await fetch(botApi(token, method), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) throw new Error('HTTP ' + res.status + ' — ' + JSON.stringify(data));
    return data.result ?? data.data ?? data;
  }
  const saved = (await chrome.storage.local.get(['zaloBotNotify'])).zaloBotNotify;
  if (saved && saved.chatId) {
    $('botChat').value = saved.chatId;
    $('botMsg').textContent = 'Đã có cấu hình thông báo Zalo (token đã lưu, không hiển thị). Nhập token mới nếu muốn thay.';
  }
  $('botGetChat').onclick = async () => {
    const token = $('botToken').value.trim();
    if (!token || !token.includes(':')) { $('botMsg').textContent = 'Hãy dán token của bot trước (định dạng bot_id:secret).'; return; }
    $('botMsg').textContent = 'Đang hỏi bot…';
    try {
      await callBot(token, 'getMe', {});
      const updates = await callBot(token, 'getUpdates', {});
      const list = Array.isArray(updates) ? updates : (updates && updates.updates) || [];
      const seen = new Map();
      for (const u of list) {
        const m = (u && u.message) || u;
        const cid = m && m.chat && m.chat.id;
        if (cid && !seen.has(String(cid))) seen.set(String(cid), (m.from && m.from.display_name) || '');
      }
      if (!seen.size) { $('botMsg').textContent = 'Bot chưa thấy cuộc chat nào — anh mở app Zalo, nhắn /start cho bot rồi bấm lại nút này.'; return; }
      const box = $('botChats');
      box.innerHTML = '';
      for (const [cid, name] of seen) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Dùng chat_id ' + cid + (name ? ' (' + name + ')' : '');
        b.style.cssText = 'display:block;margin-top:6px;';
        b.onclick = () => { $('botChat').value = cid; $('botMsg').textContent = 'Đã chọn chat_id ' + cid + ' — bấm “Lưu thông báo Zalo” rồi “Gửi tin thử” để kiểm tra.'; };
        box.appendChild(b);
      }
      $('botMsg').textContent = 'Thấy ' + seen.size + ' cuộc chat — bấm vào đúng tên của anh để điền chat_id:';
    } catch (e) {
      $('botMsg').textContent = 'Không gọi được bot: ' + (e && e.message || e);
    }
  };
  $('botSave').onclick = async () => {
    const chatId = $('botChat').value.trim();
    const token = $('botToken').value.trim();
    const cur = (await chrome.storage.local.get(['zaloBotNotify'])).zaloBotNotify || {};
    const finalToken = token || cur.token || '';
    if (!finalToken || !chatId) { $('botMsg').textContent = 'Cần có đủ token và chat_id mới lưu được.'; return; }
    await chrome.storage.local.set({ zaloBotNotify: { token: finalToken, chatId: chatId } });
    $('botToken').value = '';
    $('botMsg').textContent = '✔ Đã lưu. Từ giờ đăng bài xong, bot sẽ nhắn về Zalo cá nhân của anh.';
  };
  $('botTest').onclick = async () => {
    const cur = (await chrome.storage.local.get(['zaloBotNotify'])).zaloBotNotify || {};
    const token = $('botToken').value.trim() || cur.token || '';
    const chatId = $('botChat').value.trim() || cur.chatId || '';
    if (!token || !chatId) { $('botMsg').textContent = 'Chưa có token/chat_id để gửi thử.'; return; }
    try {
      await callBot(token, 'sendMessage', { chat_id: chatId, text: '🔔 Tin thử từ extension Tự đăng bài MTTQ: anh nhận được tin này là thông báo Zalo cá nhân đã thông!' });
      $('botMsg').textContent = '✔ Đã gửi tin thử — anh kiểm tra Zalo trên điện thoại nhé.';
    } catch (e) {
      $('botMsg').textContent = 'Gửi thử thất bại: ' + (e && e.message || e);
    }
  };
  $('botClear').onclick = async () => {
    await chrome.storage.local.remove(['zaloBotNotify']);
    $('botToken').value = ''; $('botChat').value = '';
    $('botMsg').textContent = 'Đã xóa cấu hình thông báo Zalo.';
  };
});

// ---- Đăng bài từ xa qua bot Zalo: mã cầu nối tới bot đang chạy trên máy (v2.29) ----
document.addEventListener('DOMContentLoaded', async () => {
  const saved = (await chrome.storage.local.get(['bridge'])).bridge;
  if (saved && saved.secret) $('bridgeMsg').textContent = 'Đã có mã cầu nối được lưu (không hiển thị). Dán mã mới nếu muốn thay.';
  async function bridgeCall(secret, method, path, body) {
    const r = await fetch('http://127.0.0.1:8791' + path, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'x-bridge-secret': secret },
      body: body ? JSON.stringify(body) : undefined
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.ok === false) throw new Error('HTTP ' + r.status + (d && d.error ? ' — ' + d.error : ''));
    return d;
  }
  $('bridgeSave').onclick = async () => {
    const secret = $('bridgeSecret').value.trim();
    if (!secret) { $('bridgeMsg').textContent = 'Hãy dán mã cầu nối trước (mở file bridge-secret.txt cạnh file bot.js, sao chép dòng mã trong đó).'; return; }
    await chrome.storage.local.set({ bridge: { secret: secret } });
    $('bridgeSecret').value = '';
    $('bridgeMsg').textContent = '✔ Đã lưu. Extension sẽ tự hỏi bot mỗi phút xem có lệnh đăng nào không.';
    try { chrome.runtime.sendMessage({ type: 'BRIDGE_POLL_NOW' }); } catch (e) {}
  };
  $('bridgeTest').onclick = async () => {
    const cur = (await chrome.storage.local.get(['bridge'])).bridge || {};
    const secret = $('bridgeSecret').value.trim() || cur.secret || '';
    if (!secret) { $('bridgeMsg').textContent = 'Chưa có mã cầu nối để kiểm tra.'; return; }
    $('bridgeMsg').textContent = 'Đang gọi bot…';
    try {
      const d = await bridgeCall(secret, 'GET', '/jobs');
      $('bridgeMsg').textContent = '✔ Kết nối được với bot! Hiện có ' + (d.jobs || []).length + ' lệnh đăng đang chờ.';
    } catch (e) {
      $('bridgeMsg').textContent = 'Chưa nối được: ' + (e && e.message || e) + ' — kiểm tra bot đã chạy chưa và mã có đúng không.';
    }
  };
  $('bridgeClear').onclick = async () => {
    await chrome.storage.local.remove(['bridge']);
    $('bridgeSecret').value = '';
    $('bridgeMsg').textContent = 'Đã tắt cầu nối — extension không nhận lệnh từ bot nữa.';
  };
});

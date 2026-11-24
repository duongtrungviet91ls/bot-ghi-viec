// Service worker: cầu nối tải dữ liệu (tránh CORS) + cầu nối vào CKEditor ở main world.
function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Hàm này được tiêm vào MAIN world của trang cổng để thao tác CKEditor (nếu có).
function setEditorsInPage(summaryHtml, bodyHtml) {
  return new Promise((resolve) => {
    try {
      const CK = window.CKEDITOR;
      if (!CK || !CK.instances) { resolve({ ck: false, error: 'no CKEDITOR global' }); return; }
      const insts = Object.values(CK.instances).filter(i => i && i.element && i.element.$ && document.contains(i.element.$));
      insts.sort((a, b) => {
        const ea = (a.container && a.container.$) || a.element.$;
        const eb = (b.container && b.container.$) || b.element.$;
        const pos = ea.compareDocumentPosition(eb);
        return (pos & Node.DOCUMENT_POSITION_PRECEDING) ? 1 : -1;
      });
      if (insts.length < 2) { resolve({ ck: true, count: insts.length, error: 'less than 2 editor instances' }); return; }
      const sum = insts[0], body = insts[1];
      let done = 0;
      const finish = () => {
        if (++done < 2) return;
        try {
          const data = body.getData() || '';
          const d = new DOMParser().parseFromString(data, 'text/html');
          resolve({
            ck: true, count: insts.length,
            bodyImgs: d.querySelectorAll('img').length,
            bodyTextLen: (d.body.textContent || '').replace(/\s+/g, ' ').trim().length,
            sumLen: (sum.getData() || '').length
          });
        } catch (e) { resolve({ ck: true, count: insts.length, error: String(e) }); }
      };
      sum.setData(summaryHtml, { callback: finish });
      body.setData(bodyHtml, { callback: finish });
    } catch (e) { resolve({ ck: false, error: String(e) }); }
  });
}

function getEditorsInPage() {
  try {
    const CK = window.CKEDITOR;
    if (!CK || !CK.instances) return { ck: false };
    const insts = Object.values(CK.instances).filter(i => i && i.element && i.element.$ && document.contains(i.element.$));
    return {
      ck: true,
      editors: insts.map(i => {
        const data = i.getData() || '';
        const d = new DOMParser().parseFromString(data, 'text/html');
        return {
          id: i.element.$.id || '', name: i.name || '',
          len: data.length, imgs: d.querySelectorAll('img').length,
          textLen: (d.body.textContent || '').replace(/\s+/g, ' ').trim().length
        };
      })
    };
  } catch (e) { return { ck: false, error: String(e) }; }
}

// Bản cho Zalo OA: trang tạo bài chỉ có 1 CKEditor (Nội dung) — đổ bodyHtml vào instance đó.
function setBodyEditorInPage(bodyHtml) {
  return new Promise((resolve) => {
    try {
      const CK = window.CKEDITOR;
      if (!CK || !CK.instances) { resolve({ ck: false, error: 'no CKEDITOR global' }); return; }
      const startedAt = Date.now();
      // Chọn editor đã SẴN SÀNG (status 'ready') và có vùng soạn thảo lớn nhất — editor Nội dung là ô lớn.
      // Bản cũ lấy editor cuối cùng rồi đổ ngay: tab vừa mở, editor chưa nạp xong thì dữ liệu bị ghi đè mất (đọc lại 0 ảnh/0 chữ).
      const pickReady = () => {
        const insts = Object.values(CK.instances).filter(i => i && i.element && i.element.$ && document.contains(i.element.$));
        const ready = insts.filter(i => i.status === 'ready');
        if (!ready.length) return { insts, body: null };
        let best = null, bestArea = -1;
        for (const i of ready) {
          let area = 0;
          try { const r = i.container && i.container.$ ? i.container.$.getBoundingClientRect() : null; if (r) area = r.width * r.height; } catch (e) {}
          if (area > bestArea) { bestArea = area; best = i; }
        }
        return { insts, body: best || ready[ready.length - 1] };
      };
      const attemptSet = (body, triesLeft) => {
        body.setData(bodyHtml, { callback: () => {
          try { if (body.updateElement) body.updateElement(); } catch (e) {} // đồng bộ dữ liệu về ô gốc cho Angular nhận
          try {
            const data = body.getData() || '';
            const d = new DOMParser().parseFromString(data, 'text/html');
            const res = {
              ck: true,
              bodyImgs: d.querySelectorAll('img').length,
              bodyTextLen: (d.body.textContent || '').replace(/\s+/g, ' ').trim().length
            };
            if (res.bodyTextLen === 0 && triesLeft > 0) { setTimeout(() => attemptSet(body, triesLeft - 1), 1200); return; }
            resolve(res);
          } catch (e) { resolve({ ck: true, error: String(e) }); }
        }});
      };
      const waitReady = () => {
        const picked = pickReady();
        if (picked.body) { attemptSet(picked.body, 1); return; }
        if (Date.now() - startedAt > 15000) {
          if (picked.insts.length) { attemptSet(picked.insts[picked.insts.length - 1], 0); return; }
          resolve({ ck: true, count: 0, error: 'no editor instance' });
          return;
        }
        setTimeout(waitReady, 500);
      };
      waitReady();
    } catch (e) { resolve({ ck: false, error: String(e) }); }
  });
}

// Bản blob cho Zalo OA (v2.37 — chữa chặn referer của CDN Dân Trí phía Zalo): thay link ảnh
// trong thân bài bằng blob URL tạo ngay trong trang (từ tệp ảnh extension đã tải về), y hệt cách
// hộp thoại "Thuộc tính của ảnh" của Zalo chèn ảnh người dùng chọn (kết quả do thám 18/11: ảnh
// chèn qua hộp thoại mang URL blob:https://oa.nhatkyzalo.vn/<uuid>). Khi Zalo lưu nháp/xuất bản,
// nó tự tải các blob này lên kho ảnh của nó. files = [{url, b64, mime, name}].
function setBodyEditorWithBlobsInPage(bodyHtml, files) {
  return new Promise((resolve) => {
    try {
      let finalHtml = bodyHtml, blobbed = 0;
      (files || []).forEach(f => {
        try {
          const bin = atob(f.b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          const file = new File([arr], f.name || 'anh.jpg', { type: f.mime || 'image/jpeg' });
          const bu = URL.createObjectURL(file);
          if (finalHtml.indexOf(f.url) >= 0) { finalHtml = finalHtml.split(f.url).join(bu); blobbed++; }
        } catch (e) {}
      });
      const CK = window.CKEDITOR;
      if (!CK || !CK.instances) { resolve({ ck: false, error: 'no CKEDITOR global', blobbed: blobbed }); return; }
      const startedAt = Date.now();
      const pickReady = () => {
        const insts = Object.values(CK.instances).filter(i => i && i.element && i.element.$ && document.contains(i.element.$));
        const ready = insts.filter(i => i.status === 'ready');
        if (!ready.length) return { insts, body: null };
        let best = null, bestArea = -1;
        for (const i of ready) {
          let area = 0;
          try { const r = i.container && i.container.$ ? i.container.$.getBoundingClientRect() : null; if (r) area = r.width * r.height; } catch (e) {}
          if (area > bestArea) { bestArea = area; best = i; }
        }
        return { insts, body: best || ready[ready.length - 1] };
      };
      const attemptSet = (body, triesLeft) => {
        body.setData(finalHtml, { callback: () => {
          try { if (body.updateElement) body.updateElement(); } catch (e) {}
          try {
            const data = body.getData() || '';
            const d = new DOMParser().parseFromString(data, 'text/html');
            const res = {
              ck: true, blobbed: blobbed,
              bodyImgs: d.querySelectorAll('img').length,
              bodyBlobImgs: Array.from(d.querySelectorAll('img')).filter(im => (im.getAttribute('src') || '').indexOf('blob:') === 0).length,
              bodyTextLen: (d.body.textContent || '').replace(/\s+/g, ' ').trim().length
            };
            if (res.bodyTextLen === 0 && triesLeft > 0) { setTimeout(() => attemptSet(body, triesLeft - 1), 1200); return; }
            resolve(res);
          } catch (e) { resolve({ ck: true, blobbed: blobbed, error: String(e) }); }
        }});
      };
      const waitReady = () => {
        const picked = pickReady();
        if (picked.body) { attemptSet(picked.body, 1); return; }
        if (Date.now() - startedAt > 15000) {
          if (picked.insts.length) { attemptSet(picked.insts[picked.insts.length - 1], 0); return; }
          resolve({ ck: true, count: 0, blobbed: blobbed, error: 'no editor instance' });
          return;
        }
        setTimeout(waitReady, 500);
      };
      waitReady();
    } catch (e) { resolve({ ck: false, error: String(e) }); }
  });
}

// Đọc trạng thái ảnh trong trình soạn Zalo (chẩn đoán v2.37): sau khi trang lưu nháp, các blob
// đã được Zalo đổi thành link máy chủ của nó chưa, hay vẫn còn nguyên blob/link ngoài?
function getBodyImgStateInPage() {
  try {
    const CK = window.CKEDITOR;
    if (!CK || !CK.instances) return { ck: false };
    const insts = Object.values(CK.instances).filter(i => i && i.status === 'ready' && i.element && i.element.$ && document.contains(i.element.$));
    if (!insts.length) return { ck: false };
    let best = insts[0], bestArea = -1;
    for (const i of insts) {
      let area = 0;
      try { const r = i.container && i.container.$ ? i.container.$.getBoundingClientRect() : null; if (r) area = r.width * r.height; } catch (e) {}
      if (area > bestArea) { bestArea = area; best = i; }
    }
    const data = best.getData() || '';
    const d = new DOMParser().parseFromString(data, 'text/html');
    const srcs = Array.from(d.querySelectorAll('img')).map(im => im.getAttribute('src') || '');
    return {
      ck: true, total: srcs.length,
      blob: srcs.filter(s => s.indexOf('blob:') === 0).length,
      http: srcs.filter(s => /^https?:/i.test(s)).length,
      hosts: Array.from(new Set(srcs.filter(s => /^https?:/i.test(s)).map(s => { try { return new URL(s).hostname; } catch (e) { return s.slice(0, 30); } }))).slice(0, 4)
    };
  } catch (e) { return { ck: false, error: String(e) }; }
}

// Thông báo kết quả trên máy tính (v2.12) + nhắn Zalo cá nhân qua bot nội bộ (v2.13).
// Dùng chung cho JOB_DONE (chạy xong bình thường) và EMERGENCY_STOP (summary.stopped = true).
async function showDoneNotification(s) {
  const lines = s.batchLines ? s.batchLines.slice() : [];
  if (!s.batchLines) {
    if (s.mttq) lines.push('Cổng MTTQ: ' + (s.mttq === 'ok' ? '✔ Xong' + (s.mttqUrl ? ' — ' + s.mttqUrl : '') : s.mttq === 'duplicate' ? '⏭ Đã có bài này' + (s.mttqUrl ? ' — ' + s.mttqUrl : '') : s.mttq === 'stopped' ? '⛔ Đã dừng' : s.mttq === 'skipped' ? '⏭ Chưa chạy (Zalo chưa đạt)' : '✖ Chưa xong — mở bảng log xem chi tiết'));
    if (s.zalo) lines.push('Zalo OA: ' + (s.zalo === 'ok' ? '✔ Xong' : s.zalo === 'duplicate' ? '⏭ Đã có bài này' : s.zalo === 'stopped' ? '⛔ Đã dừng' : s.zalo === 'skipped' ? '⏭ Chưa chạy (cổng chưa đạt)' : '✖ Chưa xong — mở bảng log xem chi tiết'));
    if (s.stopped) lines.push('Đã xóa lịch sử của bài này — dán link là đăng lại từ đầu được ngay.');
    if (s.batchNote) lines.push(s.batchNote);
  }
  const okish = (v) => !v || v === 'ok' || v === 'duplicate';
  const allOk = s.allOk !== undefined ? s.allOk : okish(s.mttq) && okish(s.zalo);
  const anyStopped = s.mttq === 'stopped' || s.zalo === 'stopped';
  const head = s.head || (anyStopped ? '⛔ Đã dừng đăng bài' : allOk ? '✔ Đăng bài xong!' : '⚠ Đăng bài xong — có nơi chưa đạt');
  await chrome.storage.local.set({ lastDoneUrl: s.url || '' });
  try {
    chrome.notifications.create('mttq-done-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: head,
      message: s.batchLines ? lines.join('\n') : (s.title || 'Bài viết') + (lines.length ? '\n' + lines.join('\n') : ''),
      priority: 1
    });
  } catch (e) {}
  try {
    chrome.action.setBadgeText({ text: allOk && !anyStopped ? '✔' : '!' });
    chrome.action.setBadgeBackgroundColor({ color: allOk && !anyStopped ? '#2e7d32' : '#c62828' });
  } catch (e) {}
  // Nhắn thêm về Zalo cá nhân qua Bot nội bộ nếu đã cấu hình trong Cài đặt (v2.13)
  try {
    const { zaloBotNotify } = await chrome.storage.local.get(['zaloBotNotify']);
    if (zaloBotNotify && zaloBotNotify.token && zaloBotNotify.chatId) {
      const text = s.batchLines ? head + (lines.length ? '\n' + lines.join('\n') : '') : head + '\n' +
        'Bài: ' + (s.title || 'Bài viết') +
        (lines.length ? '\n' + lines.join('\n') : '');
      const r = await fetch('https://bot-api.zaloplatforms.com/bot' + zaloBotNotify.token + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: zaloBotNotify.chatId, text: text.slice(0, 2000) })
      });
      const d = await r.json().catch(() => null);
      await chrome.storage.local.set({ lastBotNotify: { at: Date.now(), ok: !!(r.ok && d && d.ok !== false), status: r.status } });
    }
  } catch (e) {
    try { await chrome.storage.local.set({ lastBotNotify: { at: Date.now(), ok: false, error: String(e && e.message || e) } }); } catch (e2) {}
  }
}

// ----- Hàng chờ đăng nhiều bài (v2.19) -----
// Đánh thức tab của đích ưu tiên (cổng trước, Zalo sau qua bàn giao sẵn có) để chạy bài kế tiếp:
// dùng lại tab đang có (điều hướng về trang bắt đầu cho sạch trạng thái), chưa có thì mở mới.
// Từ v2.34: luôn ở TAB NỀN (không active) — đăng bài không giành màn hình của người dùng.
async function pokeTargetTabs(targets) {
  const PORTAL_START = 'https://mttq.langson.gov.vn/page/CMS/Article/list';
  const ZALO_START = 'https://oa.nhatkyzalo.vn/manage/content/article/';
  try {
    if (targets && targets.mttq) {
      const tabs = await chrome.tabs.query({ url: 'https://mttq.langson.gov.vn/*' });
      const score = (t) => { const u = t.url || ''; if (u.includes('/page/')) return 0; if (u.endsWith('.html')) return 2; return 1; };
      const tab = tabs.slice().sort((a, b) => score(a) - score(b))[0];
      if (tab) await chrome.tabs.update(tab.id, { url: PORTAL_START });
      else await chrome.tabs.create({ url: PORTAL_START, active: false });
    } else if (targets && targets.zalo) {
      const tabs = await chrome.tabs.query({ url: 'https://oa.nhatkyzalo.vn/*' });
      if (tabs.length) await chrome.tabs.update(tabs[0].id, { url: ZALO_START });
      else await chrome.tabs.create({ url: ZALO_START, active: false });
    }
  } catch (e) {}
}

// Dựng thông báo TỔNG cuối hàng chờ: mỗi bài 2 dòng (tiêu đề + kết quả từng nơi, cổng kèm link).
function buildBatchSummary(queue, results) {
  const items = queue.items || [];
  const lines = [];
  let okCount = 0;
  const st = (v) => v === 'ok' ? '✔' : v === 'duplicate' ? '⏭ đã có' : v === 'skipped' ? '⏭ chưa chạy' : v === 'stopped' ? '⛔ dừng' : '✖';
  const okish = (v) => !v || v === 'ok' || v === 'duplicate';
  for (let i = 0; i < items.length; i++) {
    const r = results[i];
    if (!r) { lines.push((i + 1) + '. (chưa có kết quả)'); continue; }
    const title = r.title || items[i];
    lines.push((i + 1) + '. ' + (title.length > 70 ? title.slice(0, 70) + '…' : title));
    const parts = [];
    if (queue.targets && queue.targets.mttq) parts.push('Cổng: ' + st(r.mttq) + (r.mttq === 'ok' && r.mttqUrl ? ' ' + r.mttqUrl : ''));
    if (queue.targets && queue.targets.zalo) parts.push('Zalo: ' + st(r.zalo));
    lines.push('   ' + parts.join(' · '));
    if (okish(r.mttq) && okish(r.zalo)) okCount++;
  }
  const allOk = okCount === items.length;
  return {
    batchLines: lines,
    head: (allOk ? '✔' : '⚠') + ' Đã đăng xong ' + items.length + ' bài (' + okCount + '/' + items.length + ' đạt)',
    title: 'Tổng kết đăng hàng loạt',
    allOk: allOk,
    url: (results[0] && results[0].mttqUrl) || ''
  };
}

// ----- Đăng bài từ xa qua bot Zalo (v2.29): cầu nối tới bot đang chạy trên cùng máy -----
// Bot giữ hàng đợi lệnh đăng (người dùng ra lệnh bằng cách nhắn link cho bot trên Zalo).
// Extension hỏi bot mỗi phút qua http://127.0.0.1:8791 (chỉ trong máy, có mã bí mật chung):
// có lệnh + đang rảnh -> nhận lệnh, dựng job như popup vẫn dựng (nơi đăng + chuyên mục lấy theo
// lựa chọn gần nhất trong popup), các tab đích tự chạy; xong thì báo kết quả về cho bot để bot
// nhắn lại vào Zalo — vì vậy lệnh từ xa KHÔNG dùng thông báo Zalo riêng của extension (tránh trùng).
const BRIDGE_BASE = 'http://127.0.0.1:8791';
async function bridgeFetch(secret, method, path, body) {
  const r = await fetch(BRIDGE_BASE + path, {
    method: method,
    headers: { 'Content-Type': 'application/json', 'x-bridge-secret': secret },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.ok === false) throw new Error('bridge HTTP ' + r.status + (d && d.error ? ' ' + d.error : ''));
  return d;
}
let bridgeBusy = false;
async function bridgePoll() {
  if (bridgeBusy) return;
  bridgeBusy = true;
  try {
    const { bridge, job, queue, bridgeJob } = await chrome.storage.local.get(['bridge', 'job', 'queue', 'bridgeJob']);
    if (!bridge || !bridge.secret) return;
    if (bridgeJob && bridgeJob.reported) { await chrome.storage.local.remove(['bridgeJob']); return; }
    let d;
    try { d = await bridgeFetch(bridge.secret, 'GET', '/jobs?extv=' + encodeURIComponent(chrome.runtime.getManifest().version)); }
    catch (e) { return; } // bot chưa chạy / sai mã — im lặng, phút sau thử lại
    // v2.41: bot báo đã chép bản extension mới vào thư mục (tự cập nhật qua bot) →
    // ghi nhận để tự nạp lại khi rảnh. Việc này đứng TRƯỚC các chốt "đang bận" bên dưới
    // để tín hiệu không bị trễ vì đang đăng bài; nạp lại thì vẫn chờ rảnh mới làm.
    if (d && d.extUpdate && d.extUpdate.version) await extUpdateSignal(d.extUpdate.version);
    if (job && job.active) return;                    // đang có việc chạy (kể cả việc của cầu nối) — chờ xong đã
    if (queue && queue.active) return;                // hàng chờ nhiều bài của popup đang chạy
    if (bridgeJob && !bridgeJob.reported) return;     // job cầu nối vừa khép, đang chờ báo kết quả — nhịp sau sẽ báo
    const jobs = d.jobs || [];
    if (!jobs.length) return;
    const first = jobs[0];
    try { await bridgeFetch(bridge.secret, 'POST', '/jobs/' + first.id + '/take', {}); }
    catch (e) { return; } // nơi khác vừa nhận mất — bỏ qua
    const { uiTargets, uiCategory } = await chrome.storage.local.get(['uiTargets', 'uiCategory']);
    let targets = uiTargets && (uiTargets.mttq || uiTargets.zalo) ? { mttq: !!uiTargets.mttq, zalo: !!uiTargets.zalo } : { mttq: true, zalo: true };
    // Lệnh qua bot có chỉ định nơi đăng (bot v3.4: "đăng bài lên cổng / lên zalo") → theo lệnh, ghi đè lựa chọn trong popup.
    if (first.targets && (first.targets.mttq || first.targets.zalo)) targets = { mttq: !!first.targets.mttq, zalo: !!first.targets.zalo };
    const category = uiCategory || 'Tin hoạt động';
    const jobId = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await chrome.storage.local.set({
      jobStop: 0,
      bridgeJob: { id: first.id, url: first.url, jobId: jobId, reported: false, at: Date.now() },
      job: { active: true, step: 'start', url: first.url, category: category, targets: targets, startedAt: Date.now(), log: [], fromQueue: true, jobId: jobId, viaBridge: true }
    });
    await pokeTargetTabs(targets);
  } catch (e) {
  } finally { bridgeBusy = false; }
}
// Báo kết quả 1 job cầu nối về cho bot (bot nhắn tiếp vào Zalo). Mất kết nối thì để nhịp sau báo lại;
// quá 2 giờ không báo được thì bỏ để khỏi kẹt cầu nối.
async function bridgeReport(summary) {
  const { bridge, bridgeJob } = await chrome.storage.local.get(['bridge', 'bridgeJob']);
  if (!bridgeJob || bridgeJob.reported) return;
  if (!bridge || !bridge.secret) { await chrome.storage.local.remove(['bridgeJob']); return; }
  try {
    await bridgeFetch(bridge.secret, 'POST', '/jobs/' + bridgeJob.id + '/done', {
      title: summary.title || '', mttq: summary.mttq || null, zalo: summary.zalo || null,
      mttqUrl: summary.mttqUrl || '', zaloUrl: summary.zaloUrl || ''
    });
    await chrome.storage.local.set({ bridgeJob: Object.assign({}, bridgeJob, { reported: true }) });
  } catch (e) { /* bot đang tắt — nhịp sau báo lại */ }
}
async function bridgeSweep() {
  const { bridgeJob } = await chrome.storage.local.get(['bridgeJob']);
  if (bridgeJob && !bridgeJob.reported && Date.now() - (bridgeJob.at || 0) > 2 * 3600 * 1000) {
    await chrome.storage.local.remove(['bridgeJob']);
  }
}

// ----- Tự cập nhật qua bot (v2.41) -----
// Bot (v3.9+) tự tải bản extension mới từ GitHub, kiểm mã băm rồi chép đè vào thư mục
// này; xong nó báo qua cầu nối /jobs (trường extUpdate, khi extension hỏi kèm extv).
// Extension chỉ việc TỰ NẠP LẠI (chrome.runtime.reload đọc lại thư mục) — nhưng chỉ khi
// đang rảnh: đang đăng bài thì ghi nhận "chờ nạp" (extUpdPending) và nạp ở nhịp báo thức
// phút sau, khi việc đã xong. Chống vòng lặp: mỗi phiên bản chỉ tự nạp tối đa 2 lần/giờ;
// nạp 2 lần mà vẫn chạy bản cũ (file trên đĩa chưa đổi thật) thì báo 1 lần rồi thôi.
function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
function extNotify(title, message) {
  try { chrome.notifications.create('mttq-extupd-' + Date.now(), { type: 'basic', iconUrl: 'icons/icon128.png', title: title, message: message, priority: 1 }); } catch (e) {}
}
async function extUpdateSignal(version) {
  const running = chrome.runtime.getManifest().version;
  if (cmpVer(version, running) <= 0) return;
  const { extUpdPending } = await chrome.storage.local.get(['extUpdPending']);
  if (extUpdPending !== version) await chrome.storage.local.set({ extUpdPending: version });
  await maybeReloadForUpdate();
}
async function maybeReloadForUpdate() {
  try {
    const running = chrome.runtime.getManifest().version;
    const st = await chrome.storage.local.get(['extUpdPending', 'extUpdGuard', 'job', 'queue']);
    const version = st.extUpdPending;
    if (!version) return;
    if (cmpVer(version, running) <= 0) { // đã lên bản này rồi (nạp lại thành công) — dọn sổ
      await chrome.storage.local.remove(['extUpdPending', 'extUpdGuard']);
      return;
    }
    if ((st.job && st.job.active) || (st.queue && st.queue.active)) return; // đang đăng bài — hoãn, nhịp sau nạp
    const now = Date.now();
    let g = st.extUpdGuard;
    if (!g || g.version !== version || now - (g.firstAt || 0) > 3600 * 1000) g = { version: version, count: 0, firstAt: now };
    if (g.count >= 2) {
      if (!g.notified) {
        g.notified = true;
        await chrome.storage.local.set({ extUpdGuard: g });
        extNotify('⚠ Cập nhật extension chưa ăn', 'Bot đã chép bản ' + version + ' nhưng extension vẫn chạy bản ' + running + ' sau 2 lần nạp lại. Anh kiểm tra lại thư mục extension giúp em.');
      }
      return;
    }
    g.count++;
    await chrome.storage.local.set({ extUpdGuard: g });
    extNotify('🧩 Extension đăng bài đã có bản mới', 'Bot vừa chép bản ' + version + ' vào thư mục (đang chạy ' + running + ') — extension tự nạp lại ngay bây giờ.');
    setTimeout(() => { try { chrome.runtime.reload(); } catch (e) {} }, 1500);
  } catch (e) {}
}
chrome.alarms.create('mttqBridgePoll', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'mttqBridgePoll') { bridgeSweep(); bridgePoll(); maybeReloadForUpdate(); }
  if (a.name === 'mttqRadar') radarScan(false);
});
chrome.runtime.onStartup.addListener(() => { bridgePoll(); radarScan(false); });
chrome.runtime.onInstalled.addListener(() => { bridgePoll(); radarScan(false); });

// ----- Radar bài mới + quét từ khóa (v2.42) -----
// Mỗi 15 phút (alarm mttqRadar) background tải trang chủ 3 báo, trích link bài viết theo
// mẫu URL của từng báo (chốt từ mẫu trang thật 24/11), đối chiếu sổ radarSeen: bài CHƯA
// TỪNG THẤY mà tiêu đề trúng từ khóa (đặt trong Cài đặt — radarCfg) thì ghi vào radarHits,
// hiện thông báo trên máy + nhắn Zalo cá nhân qua bot nội bộ (nếu đã cấu hình), và hiện
// trong popup để đăng 1 chạm. Lần quét ĐẦU TIÊN chỉ gieo hạt: ghi mọi link hiện có vào sổ
// đã thấy, không báo gì — tránh dội bom thông báo bài cũ. Khớp từ khóa theo tiêu đề trên
// trang chủ, không tải từng bài. Chỉ chạy khi Chrome đang mở (giới hạn của extension).
// [RADAR-SECTION]
const RADAR_SOURCES = [
  { key: 'bls', name: 'Báo Lạng Sơn', home: 'https://baolangson.vn/', base: 'https://baolangson.vn', pat: /^\/[^/]+-\d{5,}\.html$/ },
  { key: 'ddk', name: 'Đại Đoàn Kết', home: 'https://daidoanket.vn/', base: 'https://daidoanket.vn', pat: /^\/(?!chuyen-muc\/)[^/]{25,}\.html$/ },
  { key: 'dt', name: 'Dân Trí', home: 'https://dantri.com.vn/', base: 'https://dantri.com.vn', pat: /^https:\/\/dantri\.com\.vn\/[^/]+\/[^/]+-\d{10,}\.htm$/ }
];
const RADAR_DEFAULT_KEYWORDS = ['Mặt trận', 'MTTQ', 'Đại đoàn kết'];
// Bỏ dấu tiếng Việt + thường hóa để khớp từ khóa không phụ thuộc dấu/hoa thường.
function radarFold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd');
}
function radarEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}
// Trích {url, title, source} từ HTML trang chủ: duyệt mọi thẻ <a>, lọc href theo mẫu của
// báo, tiêu đề lấy từ chữ trong thẻ (bỏ thẻ con, giải mã thực thể, gọt dấu đầu dòng kiểu
// "• "); thiếu chữ thì lấy thuộc tính title. Trùng URL giữ tiêu đề DÀI NHẤT (trang chủ có
// cả thẻ bọc ảnh — title ngắn — lẫn thẻ tiêu đề đầy đủ cho cùng 1 bài).
function radarExtract(html, src) {
  const byUrl = new Map();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const hm = attrs.match(/href="([^"]+)"/i);
    if (!hm) continue;
    const href = hm[1];
    if (!src.pat.test(href)) continue;
    const url = href.startsWith('http') ? href : src.base + href;
    let title = radarEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().replace(/^[•·\-–—\s]+/, '');
    if (title.length < 15) {
      const tm = attrs.match(/title="([^"]+)"/i);
      const t2 = tm ? radarEntities(tm[1]).replace(/\s+/g, ' ').trim() : '';
      if (t2.length > title.length) title = t2;
    }
    if (title.length < 15) continue;
    const cur = byUrl.get(url);
    if (!cur || title.length > cur.title.length) byUrl.set(url, { url: url, title: title, source: src.name });
  }
  return Array.from(byUrl.values());
}
// Trả danh sách từ khóa (nguyên dạng đã đặt) trúng trong tiêu đề.
function radarMatch(title, keywords) {
  const ft = radarFold(title);
  return (keywords || []).filter((k) => { const fk = radarFold(k).trim(); return fk.length >= 2 && ft.includes(fk); });
}
// [/RADAR-SECTION]

// Nhắn Zalo cá nhân qua bot nội bộ — cùng cách của thông báo đăng bài xong (v2.13).
async function botZaloSend(text) {
  try {
    const { zaloBotNotify } = await chrome.storage.local.get(['zaloBotNotify']);
    if (!zaloBotNotify || !zaloBotNotify.token || !zaloBotNotify.chatId) return false;
    const r = await fetch('https://bot-api.zaloplatforms.com/bot' + zaloBotNotify.token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: zaloBotNotify.chatId, text: text.slice(0, 2000) })
    });
    const d = await r.json().catch(() => null);
    return !!(r.ok && d && d.ok !== false);
  } catch (e) { return false; }
}

let radarBusy = false;
async function radarScan(manual) {
  if (radarBusy) return { busy: true };
  radarBusy = true;
  try {
    const st = await chrome.storage.local.get(['radarCfg', 'radarSeen', 'radarHits']);
    let cfg = st.radarCfg;
    if (!cfg) { cfg = { enabled: true, keywords: RADAR_DEFAULT_KEYWORDS.slice() }; await chrome.storage.local.set({ radarCfg: cfg }); }
    if (!cfg.enabled && !manual) return { skipped: 'disabled' };
    const keywords = (cfg.keywords || []).filter((k) => radarFold(k).trim().length >= 2);
    const seeding = !st.radarSeen;
    const seen = st.radarSeen || {};
    const now = Date.now();
    let found = 0;
    const fresh = [];
    for (const src of RADAR_SOURCES) {
      try {
        const r = await fetch(src.home, { credentials: 'omit' });
        if (!r.ok) continue;
        const items = radarExtract(await r.text(), src);
        found += items.length;
        for (const it of items) {
          if (seen[it.url]) { seen[it.url] = now; continue; }
          seen[it.url] = now;
          if (!seeding) fresh.push(it);
        }
      } catch (e) { /* 1 báo lỗi không làm hỏng cả lượt quét */ }
    }
    const keys = Object.keys(seen);
    if (keys.length > 900) { keys.sort((a, b) => seen[a] - seen[b]); for (const k of keys.slice(0, keys.length - 700)) delete seen[k]; }
    const newHits = [];
    if (!seeding) {
      for (const it of fresh) {
        const kw = radarMatch(it.title, keywords);
        if (kw.length) newHits.push({ url: it.url, title: it.title, source: it.source, kw: kw, at: now });
      }
    }
    const hits = newHits.length ? newHits.concat(st.radarHits || []).slice(0, 50) : (st.radarHits || []);
    await chrome.storage.local.set({ radarSeen: seen, radarHits: hits, radarLast: { at: now, found: found, fresh: fresh.length, matched: newHits.length, seeded: seeding } });
    if (newHits.length) {
      await chrome.storage.local.set({ radarLastHitUrl: newHits[0].url });
      try {
        chrome.notifications.create('mttq-radar-' + now, {
          type: 'basic', iconUrl: 'icons/icon128.png',
          title: '📡 Radar: ' + newHits.length + ' bài mới trúng từ khóa',
          message: newHits.slice(0, 3).map((h) => h.title).join('\n') + (newHits.length > 3 ? '\n… và ' + (newHits.length - 3) + ' bài nữa — mở popup của extension để xem.' : ''),
          priority: 1
        });
      } catch (e) {}
      const lines = newHits.slice(0, 8).map((h, i) => (i + 1) + '. ' + h.title + ' (' + h.source + ')\n' + h.url);
      await botZaloSend('📡 Radar bài mới: ' + newHits.length + ' bài trúng từ khóa\n' + lines.join('\n') +
        (newHits.length > 8 ? '\n… và ' + (newHits.length - 8) + ' bài nữa.' : '') + '\nMở popup của extension trên máy tính để đăng ngay.');
    }
    return { seeded: seeding, found: found, fresh: fresh.length, matched: newHits.length };
  } catch (e) {
    return { error: String(e && e.message || e) };
  } finally { radarBusy = false; }
}
chrome.alarms.create('mttqRadar', { periodInMinutes: 15 });

// ----- Sổ log đợt đăng gần nhất (v2.32) -----
// Mỗi job khép lại (xong / lỗi / dừng khẩn cấp) thì chụp toàn bộ log của nó vào `lastRun`,
// gom theo đợt (hàng chờ nhiều bài = 1 đợt, bài lẻ/lệnh qua bot = đợt 1 bài) để popup mở
// trang log.html xem lại và sao chép gửi đi khi cần. Chụp TRƯỚC khi job bị thay bằng bài kế.
async function captureRunItem(s, stopped) {
  try {
    const { job, queue, lastRun } = await chrome.storage.local.get(['job', 'queue', 'lastRun']);
    if (!job || !s.jobId || job.jobId !== s.jobId) return;
    const key = s.fromQueue && queue && queue.startedAt ? 'q' + queue.startedAt : 'j' + (job.startedAt || s.jobId);
    const run = lastRun && lastRun.key === key ? lastRun : { key: key, at: Date.now(), items: [] };
    if (run.items.some((it) => it.jobId === s.jobId)) return;
    run.items.push({
      jobId: s.jobId, url: job.url || s.url || '', title: s.title || (job.article && job.article.title) || '',
      mttq: s.mttq || null, zalo: s.zalo || null, mttqUrl: s.mttqUrl || '', zaloUrl: s.zaloUrl || '',
      stopped: !!stopped, at: Date.now(), lines: (job.log || []).slice()
    });
    if (run.items.length > 30) run.items = run.items.slice(-30);
    await chrome.storage.local.set({ lastRun: run });
  } catch (e) {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'BRIDGE_POLL_NOW') {
        bridgePoll();
        sendResponse({ ok: true });
      } else if (msg.type === 'RADAR_SCAN_NOW') {
        const summary = await radarScan(true);
        sendResponse({ ok: true, summary: summary });
      } else if (msg.type === 'FETCH_TEXT') {
        const r = await fetch(msg.url, { credentials: msg.credentials || 'omit', redirect: 'follow' });
        const text = await r.text();
        sendResponse({ ok: r.ok, status: r.status, finalUrl: r.url, text: text });
      } else if (msg.type === 'FETCH_IMAGE_B64') {
        const r = await fetch(msg.url, { credentials: 'omit' });
        if (!r.ok) { sendResponse({ ok: false, status: r.status }); return; }
        const buf = await r.arrayBuffer();
        sendResponse({ ok: true, b64: b64FromBuffer(buf), mime: r.headers.get('content-type') || 'image/jpeg' });
      } else if (msg.type === 'SET_EDITORS') {
        const tabId = sender.tab && sender.tab.id;
        const res = await chrome.scripting.executeScript({
          target: { tabId: tabId }, world: 'MAIN',
          func: setEditorsInPage, args: [msg.summaryHtml, msg.bodyHtml]
        });
        sendResponse({ ok: true, result: res && res[0] ? res[0].result : null });
      } else if (msg.type === 'SET_BODY_EDITOR') {
        const tabId = sender.tab && sender.tab.id;
        const res = await chrome.scripting.executeScript({
          target: { tabId: tabId }, world: 'MAIN',
          func: setBodyEditorInPage, args: [msg.bodyHtml]
        });
        sendResponse({ ok: true, result: res && res[0] ? res[0].result : null });
      } else if (msg.type === 'SET_BODY_EDITOR_BLOBS') {
        const tabId = sender.tab && sender.tab.id;
        const res = await chrome.scripting.executeScript({
          target: { tabId: tabId }, world: 'MAIN',
          func: setBodyEditorWithBlobsInPage, args: [msg.bodyHtml, msg.files || []]
        });
        sendResponse({ ok: true, result: res && res[0] ? res[0].result : null });
      } else if (msg.type === 'GET_BODY_IMG_STATE') {
        const tabId = sender.tab && sender.tab.id;
        const res = await chrome.scripting.executeScript({
          target: { tabId: tabId }, world: 'MAIN',
          func: getBodyImgStateInPage, args: []
        });
        sendResponse({ ok: true, result: res && res[0] ? res[0].result : null });
      } else if (msg.type === 'OPEN_TAB') {
        // Mở ở TAB NỀN (v2.34 — đăng bài không giành màn hình): bài đã đăng nằm chờ ở thanh tab,
        // anh rảnh thì bấm vào xem; thông báo "đã xong" bấm vào cũng mở bài đó.
        const t = await chrome.tabs.create({ url: msg.url, active: false });
        sendResponse({ ok: true, tabId: t.id });
      } else if (msg.type === 'OPEN_OR_FOCUS_TAB') {
        // Bàn giao giữa 2 đích (v2.19): có tab của miền đó rồi thì dùng lại + điều hướng về trang bắt đầu, chưa có mới mở mới.
        // Từ v2.34 mọi thao tác đều ở tab nền: không kích hoạt tab, không kéo cửa sổ Chrome lên trước.
        const pattern = msg.url.includes('zalo') ? 'https://oa.nhatkyzalo.vn/*' : 'https://mttq.langson.gov.vn/*';
        const tabs = await chrome.tabs.query({ url: pattern });
        if (tabs.length) {
          await chrome.tabs.update(tabs[0].id, { url: msg.url });
          sendResponse({ ok: true, tabId: tabs[0].id, reused: true });
        } else {
          const t = await chrome.tabs.create({ url: msg.url, active: false });
          sendResponse({ ok: true, tabId: t.id, reused: false });
        }
      } else if (msg.type === 'JOB_DONE') {
        const s = msg.summary || {};
        await captureRunItem(s, false);
        const { bridgeJob } = await chrome.storage.local.get(['bridgeJob']);
        const isBridge = !!(bridgeJob && s.jobId && bridgeJob.jobId === s.jobId);
        if (isBridge) {
          // Lệnh đăng từ xa qua bot: bot sẽ là người nhắn kết quả vào Zalo — extension chỉ hiện
          // thông báo trên máy tính (bỏ phần nhắn Zalo riêng để khỏi trùng 2 tin).
          try {
            const lines = [];
            if (s.mttq) lines.push('Cổng MTTQ: ' + (s.mttq === 'ok' ? '✔ Xong' + (s.mttqUrl ? ' — ' + s.mttqUrl : '') : s.mttq === 'duplicate' ? '⏭ Đã có bài này' : s.mttq === 'skipped' ? '⏭ Chưa chạy' : '✖ Chưa xong'));
            if (s.zalo) lines.push('Zalo OA: ' + (s.zalo === 'ok' ? '✔ Xong' : s.zalo === 'duplicate' ? '⏭ Đã có bài này' : s.zalo === 'skipped' ? '⏭ Chưa chạy' : '✖ Chưa xong'));
            const okish = (v) => !v || v === 'ok' || v === 'duplicate';
            chrome.notifications.create('mttq-done-' + Date.now(), {
              type: 'basic', iconUrl: 'icons/icon128.png',
              title: (okish(s.mttq) && okish(s.zalo) ? '✔' : '⚠') + ' Đăng bài từ xa xong (lệnh qua bot Zalo)',
              message: (s.title || 'Bài viết') + (lines.length ? '\n' + lines.join('\n') : ''), priority: 1
            });
          } catch (e) {}
          await bridgeReport(s);
        }
        if (s.fromQueue && !isBridge) {
          // Bài thuộc hàng chờ nhiều bài (v2.19): không báo lẻ từng bài — ghi kết quả rồi chuyển bài kế,
          // xong bài cuối mới gửi 1 thông báo tổng. Kết quả lệch mã job (bài cũ/hàng đã dừng) thì bỏ qua lặng lẽ.
          const { queue } = await chrome.storage.local.get(['queue']);
          if (queue && queue.active && queue.jobId === s.jobId) {
            const results = (queue.results || []).slice();
            results[queue.idx] = { title: s.title || '', mttq: s.mttq || null, zalo: s.zalo || null, mttqUrl: s.mttqUrl || '', zaloUrl: s.zaloUrl || '', url: s.url || '' };
            const nextIdx = (queue.idx || 0) + 1;
            if (nextIdx < queue.items.length) {
              const jobId = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
              await chrome.storage.local.set({
                queue: Object.assign({}, queue, { idx: nextIdx, results: results, jobId: jobId }),
                jobStop: 0,
                job: { active: true, step: 'start', url: queue.items[nextIdx], category: queue.category, targets: queue.targets, startedAt: Date.now(), log: [], fromQueue: true, jobId: jobId }
              });
              await pokeTargetTabs(queue.targets);
            } else {
              const doneQueue = Object.assign({}, queue, { active: false, results: results });
              await chrome.storage.local.set({ queue: doneQueue });
              await showDoneNotification(buildBatchSummary(doneQueue, results));
            }
          }
        } else {
          await showDoneNotification(s);
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'EMERGENCY_STOP') {
        // Nút DỪNG KHẨN CẤP (v2.18): bật cờ jobStop để các tab đang chạy dừng ngay tại nhịp chờ kế tiếp,
        // báo "đã dừng" (kèm phần nào đã kịp xong), rồi xóa job + xóa lịch sử đăng của ĐÚNG bài này
        // và cấp 1 lượt bỏ qua kiểm tra trùng — để dán link là đăng lại từ đầu được ngay.
        await chrome.storage.local.set({ jobStop: Date.now() });
        const { job, queue } = await chrome.storage.local.get(['job', 'queue']);
        if (job && job.jobId) {
          const stOf = (r, sel) => !sel ? null : !r ? 'stopped' : r.ok ? 'ok' : r.reason === 'duplicate' ? 'duplicate' : 'fail';
          const tt = job.targets || { mttq: true };
          await captureRunItem({ jobId: job.jobId, fromQueue: !!job.fromQueue, title: (job.article && job.article.title) || '', mttq: stOf(job.mttqResult, !!tt.mttq), zalo: stOf(job.zaloResult, !!tt.zalo), mttqUrl: (job.mttqResult && job.mttqResult.url) || '', zaloUrl: (job.zaloResult && job.zaloResult.url) || '', url: job.url || '' }, true);
        }
        let batchNote = '';
        if (queue && queue.active) {
          // Dừng khẩn cấp giữa hàng chờ = hủy cả hàng: các bài chưa chạy sẽ không chạy nữa
          const left = (queue.items || []).length - (queue.idx || 0) - 1;
          if (left > 0) batchNote = 'Đã hủy ' + left + ' bài còn lại trong hàng chờ.';
          await chrome.storage.local.set({ queue: Object.assign({}, queue, { active: false }) });
        }
        if (job) {
          // Dừng khẩn cấp trúng job cầu nối: báo "thất bại — đã dừng" về bot cho đủ vòng đời lệnh,
          // tránh lệnh treo ở trạng thái đang chạy tới 45 phút.
          if (job.viaBridge) {
            try {
              const { bridge, bridgeJob } = await chrome.storage.local.get(['bridge', 'bridgeJob']);
              if (bridge && bridge.secret && bridgeJob && !bridgeJob.reported && bridgeJob.jobId === job.jobId) {
                await bridgeFetch(bridge.secret, 'POST', '/jobs/' + bridgeJob.id + '/fail', { error: 'Đã bấm DỪNG KHẨN CẤP trên máy tính — bài chưa đăng. Muốn đăng lại thì ra lệnh lại cho bot.' });
                await chrome.storage.local.remove(['bridgeJob']);
              }
            } catch (e) {}
          }
          const t = job.targets || { mttq: true };
          const stateOf = (r, sel) => !sel ? null : !r ? 'stopped' : r.ok ? 'ok' : r.reason === 'duplicate' ? 'duplicate' : (r.reason || '').indexOf('skipped') === 0 ? 'skipped' : r.reason === 'stopped' ? 'stopped' : 'fail';
          if (job.active) {
            await showDoneNotification({
              title: (job.article && job.article.title) || 'Bài viết',
              mttq: stateOf(job.mttqResult, !!t.mttq),
              zalo: stateOf(job.zaloResult, !!t.zalo),
              url: (job.mttqResult && job.mttqResult.url) || (job.zaloResult && job.zaloResult.url) || '',
              mttqUrl: (job.mttqResult && job.mttqResult.url) || '',
              zaloUrl: (job.zaloResult && job.zaloResult.url) || '',
              stopped: true,
              batchNote: batchNote
            });
          }
          const title = job.article && job.article.title;
          if (title) {
            const norm = (x) => (x || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const { postedHistory } = await chrome.storage.local.get(['postedHistory']);
            await chrome.storage.local.set({
              postedHistory: (postedHistory || []).filter(h => norm(h.t) !== norm(title)),
              repostBypass: { t: title, at: Date.now() }
            });
          }
          await chrome.storage.local.remove(['job']);
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'GET_EDITORS') {
        const tabId = sender.tab && sender.tab.id;
        const res = await chrome.scripting.executeScript({
          target: { tabId: tabId }, world: 'MAIN', func: getEditorsInPage
        });
        sendResponse({ ok: true, result: res && res[0] ? res[0].result : null });
      } else {
        sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // giữ kênh async
});

// Bấm vào thông báo "đã xong" -> mở bài vừa đăng (hoặc trang đích tương ứng);
// bấm vào thông báo radar -> mở bài mới nhất vừa trúng từ khóa.
chrome.notifications.onClicked.addListener(async (notifId) => {
  if (notifId.startsWith('mttq-radar-')) {
    try {
      const { radarLastHitUrl } = await chrome.storage.local.get(['radarLastHitUrl']);
      if (radarLastHitUrl) await chrome.tabs.create({ url: radarLastHitUrl, active: true });
    } catch (e) {}
    try { chrome.notifications.clear(notifId); } catch (e) {}
    return;
  }
  if (!notifId.startsWith('mttq-done-')) return;
  try {
    const { lastDoneUrl } = await chrome.storage.local.get(['lastDoneUrl']);
    if (lastDoneUrl) await chrome.tabs.create({ url: lastDoneUrl, active: true });
  } catch (e) {}
  try { chrome.notifications.clear(notifId); } catch (e) {}
});

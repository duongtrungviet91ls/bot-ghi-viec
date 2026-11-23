// Content script cho đích Zalo OA (v2.0): dùng phiên đăng nhập QR sẵn trên Chrome của anh
// -> chọn OA "Mặt trận số Xứ Lạng" -> mở form "Soạn bài viết mới" -> điền -> xuất bản -> kiểm chứng trong danh sách.
// Chạy song song với content.js (cổng MTTQ) trên cùng 1 job; mỗi đích có runner/result riêng.
(function () {
  'use strict';
  const ARTICLE_URL = 'https://oa.nhatkyzalo.vn/manage/content/article/';
  const OA_NAME = 'Mặt trận số Xứ Lạng';
  const RUNNER_ID = 'z' + Math.random().toString(36).slice(2, 10);
  let myJobId = null; // mã job bản script này đang chạy — nếu job trong máy đã là bài khác (hàng chờ) thì kết quả cũ bị bỏ qua
  const sleepRaw = (ms) => new Promise(r => setTimeout(r, ms));
  // ----- Dừng khẩn cấp (v2.18): nút dừng (bảng tiến trình/popup) nhờ background bật cờ jobStop.
  // Mọi nhịp chờ đều kiểm tra cờ (trễ tối đa ~0,7 giây) và ném StopError để hủy ngay tại chỗ.
  class StopError extends Error { constructor() { super('Đã dừng khẩn cấp'); this.isStop = true; } }
  let stopCache = { at: 0, val: 0 };
  async function stopRequested() {
    if (Date.now() - stopCache.at < 700) return !!stopCache.val;
    try { const { jobStop } = await chrome.storage.local.get(['jobStop']); stopCache = { at: Date.now(), val: jobStop || 0 }; }
    catch (e) { return !!stopCache.val; }
    return !!stopCache.val;
  }
  async function checkStop() { if (await stopRequested()) throw new StopError(); }
  const sleep = async (ms) => {
    let left = ms;
    while (left > 0) { const c = Math.min(left, 500); await sleepRaw(c); left -= c; await checkStop(); }
  };

  // ---------- storage ----------
  async function patchJob(patch) {
    const { job } = await chrome.storage.local.get(['job']);
    const next = Object.assign({}, job || {}, patch);
    if (next.active) {
      next.runners = Object.assign({}, next.runners || {}, { zalo: { id: RUNNER_ID, at: Date.now() } });
    }
    await chrome.storage.local.set({ job: next });
    return next;
  }
  async function targetDone(result) {
    const { job } = await chrome.storage.local.get(['job']);
    if (!job) return;
    if (myJobId && job.jobId && job.jobId !== myJobId) return; // job đã sang bài khác trong hàng chờ — kết quả này là của bài cũ
    const next = Object.assign({}, job, { zaloResult: result });
    const t = job.targets || {};
    // Đối xứng với phía cổng (v2.14): Zalo chạy trước mà KHÔNG đạt thì phía cổng cũng "bỏ qua", khép job và báo rõ
    if (result && !result.ok && result.reason !== 'duplicate' && t.mttq && !next.mttqResult) {
      next.mttqResult = { ok: false, reason: 'skipped-zalo-not-ok' };
    }
    const doneM = !t.mttq || !!next.mttqResult;
    const doneZ = !t.zalo || !!next.zaloResult;
    next.active = !(doneM && doneZ);
    if (!next.active) { next.step = 'done'; next.doneAt = Date.now(); }
    await chrome.storage.local.set({ job: next });
    if (result && result.ok && job.article && job.article.title) { try { await historyAdd('zalo', job.article.title, result.url || ''); } catch (e) {} }
    if (!next.active) {
      // Mọi đích đã xong -> nhờ background bật thông báo "đã xong" trên máy tính (v2.12)
      try {
        await sendMsg({ type: 'JOB_DONE', summary: {
          title: (job.article && job.article.title) || 'Bài viết',
          mttq: t.mttq ? (next.mttqResult && next.mttqResult.ok ? 'ok' : (next.mttqResult && next.mttqResult.reason === 'skipped-zalo-not-ok' ? 'skipped' : 'fail')) : null,
          zalo: t.zalo ? (next.zaloResult && next.zaloResult.ok ? 'ok' : (next.zaloResult && next.zaloResult.reason === 'duplicate' ? 'duplicate' : 'fail')) : null,
          url: (next.mttqResult && next.mttqResult.url) || (result && result.url) || '',
          mttqUrl: (next.mttqResult && next.mttqResult.url) || '',
          zaloUrl: (next.zaloResult && next.zaloResult.url) || '',
          fromQueue: !!job.fromQueue,
          jobId: job.jobId || ''
        } });
      } catch (e) {}
    }
    // Bàn giao ngược sang đích cổng MTTQ (v2.10): nếu Zalo chạy trước mà phía cổng chưa chạy ở tab nào
    // thì tự mở tab cổng để script bên đó tiếp quản (kèm kiểm tra nhịp tim runner như bên cổng)
    const mRun = job.runners && job.runners.mttq;
    const mRunning = !!(mRun && mRun.at && Date.now() - mRun.at < 25000);
    if (next.active && result && (result.ok || result.reason === 'duplicate') && t.mttq && !next.mttqResult && !job.mttqTabOpened && !mRunning) {
      await patchJob({ mttqTabOpened: true, startedAt: Date.now() });
      await log('Zalo OA xong — tự mở tab cổng MTTQ để đăng tiếp…');
      try { await sendMsg({ type: 'OPEN_OR_FOCUS_TAB', url: 'https://mttq.langson.gov.vn/page/CMS/Article/list' }); } catch (e) {}
    }
  }

  // ---------- overlay ----------
  let overlayEl = null, logEl = null, titleEl = null;
  function ensureOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'mttq-auto-overlay';
    overlayEl.style.cssText = 'position:fixed;top:12px;right:12px;width:360px;max-height:70vh;overflow:auto;z-index:2147483647;background:#fff;border:2px solid #0068FF;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);font:13px/1.5 Arial,sans-serif;color:#222;';
    titleEl = document.createElement('div');
    titleEl.style.cssText = 'background:#0068FF;color:#fff;font-weight:bold;padding:8px 12px;border-radius:8px 8px 0 0;';
    titleEl.textContent = 'MTTQ – Tự đăng bài (Zalo OA)';
    logEl = document.createElement('div');
    logEl.style.cssText = 'padding:8px 12px;white-space:pre-wrap;word-break:break-word;';
    const close = document.createElement('button');
    close.textContent = 'Đóng bảng này';
    close.style.cssText = 'margin:0 12px 10px;padding:4px 10px;cursor:pointer;';
    close.onclick = () => overlayEl.remove();
    const stop = document.createElement('button');
    stop.textContent = '⛔ DỪNG KHẨN CẤP';
    stop.title = 'Dừng ngay việc đang chạy, xóa lịch sử của bài này để đăng lại từ đầu';
    stop.style.cssText = 'margin:0 0 10px 8px;padding:4px 10px;cursor:pointer;background:#c62828;color:#fff;border:0;border-radius:6px;font-weight:bold;';
    stop.onclick = async () => {
      stop.disabled = true; stop.textContent = 'ĐÃ BẤM DỪNG…';
      try { await sendMsg({ type: 'EMERGENCY_STOP' }); } catch (e) {}
      if (titleEl) titleEl.textContent = 'Zalo OA – ĐÃ DỪNG ⛔';
    };
    overlayEl.appendChild(titleEl); overlayEl.appendChild(logEl); overlayEl.appendChild(close); overlayEl.appendChild(stop);
    document.documentElement.appendChild(overlayEl);
  }
  async function log(line) {
    ensureOverlay();
    const time = new Date().toLocaleTimeString('vi-VN');
    logEl.textContent += '[' + time + '] ' + line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
    const { job } = await chrome.storage.local.get(['job']);
    if (job) {
      job.log = ((job.log || []).concat(['[' + time + '] [Zalo] ' + line])).slice(-120);
      if (job.active && job.runners && job.runners.zalo && job.runners.zalo.id === RUNNER_ID) job.runners.zalo.at = Date.now();
      await chrome.storage.local.set({ job });
    }
    console.log('[MTTQ-Auto-Zalo]', line);
  }
  async function replayLog() {
    const { job } = await chrome.storage.local.get(['job']);
    if (job && job.log && job.log.length) { ensureOverlay(); logEl.textContent = job.log.map(l => '· ' + l).join('\n') + '\n'; }
  }

  // ---------- DOM helpers ----------
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  function setVal(el, val) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  // Điền chữ kiểu "gõ thật" (execCommand insertText) để AngularJS ghi nhận thay đổi như người dùng gõ;
  // nếu không ăn mới quay về cách gán giá trị trực tiếp
  function fillText(el, val) {
    try {
      el.focus();
      if (el.setSelectionRange) { const len = (el.value || '').length; el.setSelectionRange(0, len); }
      const ok = document.execCommand && document.execCommand('insertText', false, val);
      if (ok && el.value === val) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return;
      }
    } catch (e) {}
    setVal(el, val);
  }
  function realClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }
  async function waitFor(fn, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 10000)) {
      const v = fn();
      if (v) return v;
      await sleep(300);
    }
    throw new Error('Hết thời gian chờ: ' + (label || 'phần tử'));
  }
  function findClickable(text) {
    const els = Array.from(document.querySelectorAll('a, button, input, [role="button"], li, span, div'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay') &&
        ((el.textContent || '').replace(/\s+/g, ' ').trim() === text || (el.tagName === 'INPUT' && (el.value || '').trim() === text)));
    const score = (el) => {
      let s = (el.textContent || el.value || '').length;
      if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT') s -= 100000;
      else if (el.getAttribute && el.getAttribute('role') === 'button') s -= 50000;
      else if (el.tagName === 'LI' || el.tagName === 'SPAN') s -= 10000;
      return s;
    };
    els.sort((a, b) => score(a) - score(b));
    return els[0] || null;
  }
  function climb(el, pred, max) {
    let cur = el, i = 0;
    while (cur && i < (max || 7)) { if (pred(cur)) return cur; cur = cur.parentElement; i++; }
    return null;
  }
  const normLabel = (s) => (s || '').replace(/[*：:]/g, '').replace(/\s+/g, ' ').trim();
  function fieldByLabel(labelText) {
    const lab = Array.from(document.querySelectorAll('label, span, div, td, th'))
      .filter(el => visible(el) && normLabel(el.textContent) === labelText)
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    if (!lab) return null;
    const row = climb(lab, el => el.querySelector('input, textarea'), 7);
    return row ? (row.querySelector('input:not([type="hidden"]):not([type="file"]), textarea')) : null;
  }
  function findInputByPlaceholder(substr) {
    const s = substr.toLowerCase();
    return Array.from(document.querySelectorAll('input, textarea'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay') &&
        ((el.getAttribute('placeholder') || '').toLowerCase().includes(s) ||
         (el.getAttribute('aria-label') || '').toLowerCase().includes(s)))[0] || null;
  }
  function firstFormTextInput() {
    // Ô nhập chữ đầu tiên của form tạo bài (bỏ qua ô tìm kiếm kiểu "Tìm…")
    return Array.from(document.querySelectorAll('input'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay') &&
        ['text', 'search', ''].includes(el.type || '') &&
        !/tìm|search/i.test(el.getAttribute('placeholder') || ''))[0] || null;
  }
  function dumpInputs() {
    const list = Array.from(document.querySelectorAll('input, textarea'))
      .filter(el => !el.closest('#mttq-auto-overlay'))
      .slice(0, 14)
      .map(el => el.tagName + '[type=' + (el.type || '') + ', ph="' + (el.getAttribute('placeholder') || '') + '", name="' + (el.getAttribute('name') || '') + '", class="' + (typeof el.className === 'string' ? el.className : '').slice(0, 40) + '", ' + (visible(el) ? 'hiện' : 'ẩn') + ']');
    return 'URL: ' + location.href + ' | Các ô nhập trên trang: ' + (list.length ? list.join(' ; ') : '(không có)');
  }
  function describeEl(el) {
    if (!el) return '(không có)';
    const t = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 50);
    return el.tagName + ' "' + t + '" class="' + cls + '"';
  }
  function trunc(s, n) {
    s = (s || '').trim();
    if (s.length <= n) return s;
    const cut = s.slice(0, n - 1);
    const sp = cut.lastIndexOf(' ');
    return (sp > 40 ? cut.slice(0, sp) : cut) + '…';
  }
  const sendMsg = (m) => chrome.runtime.sendMessage(m);
  let blobImgCount = 0; // số ảnh thân bài đã chèn dạng blob trong lượt này (v2.37 — ảnh Dân Trí)

  // ---------- các bước ----------
  async function attachCover(article) {
    if (!article.firstImage) throw new Error('Bài nguồn không có ảnh — Zalo bắt buộc có Ảnh đại diện nên dừng lại.');
    const resp = await sendMsg({ type: 'FETCH_IMAGE_B64', url: article.firstImage });
    if (!resp || !resp.ok) throw new Error('Không tải được ảnh đại diện từ nguồn (' + (resp && resp.status || 'lỗi mạng') + ').');
    const bytes = Uint8Array.from(atob(resp.b64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: resp.mime || 'image/jpeg' });
    let fname = 'anh-dai-dien.jpg';
    try { fname = decodeURIComponent(new URL(article.firstImage).pathname.split('/').pop()) || fname; } catch (e) {}
    const file = new File([blob], fname, { type: blob.type });

    // Vùng "Ảnh/Video đại diện" và hàm kiểm tra ảnh xem trước (thẻ <img> hoặc nền background-image)
    const labEl = Array.from(document.querySelectorAll('div, span, label, p'))
      .filter(el => visible(el) && (el.textContent || '').includes('Ảnh/Video đại diện'))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    // Khu vực ảnh bìa = khối tổ tiên chứa cả nhãn lẫn ô file/vùng "Tải ảnh"
    // (bản cũ chỉ tìm BÊN TRONG phần tử nhãn nhỏ xíu nên không bao giờ thấy ảnh xem trước)
    const section = labEl ? (climb(labEl, el => !!el.querySelector('input[type="file"]') || /Tải ảnh/.test(el.textContent || ''), 10) || document.body) : document.body;
    const zoneAll = section;
    const hasPreview = () => {
      if (Array.from(section.querySelectorAll('img')).some(im => (im.getAttribute('src') || '').length > 8)) return true;
      return Array.from(section.querySelectorAll('*')).some(el => {
        const bg = (el.style && el.style.backgroundImage) || '';
        return bg.includes('blob:') || bg.includes('http') || bg.includes('data:');
      });
    };
    const setFile = (inp) => {
      const dt = new DataTransfer();
      dt.items.add(file);
      inp.files = dt.files;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    };
    // Liệt kê MỌI ô chọn file trên trang vào log — trang Zalo có nhiều ô file (bìa ảnh, bìa video, hộp thoại chèn ảnh…)
    // và bản trước có thể đã gắn nhầm ô (vd ô của tab Video) nên Zalo báo "Ảnh đại diện không được để trống"
    const allFileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!allFileInputs.length) throw new Error('Không thấy ô chọn file nào trên form Zalo.');
    const inZone = (el) => !!(zoneAll && zoneAll !== document.body && zoneAll.contains(el));
    const candDesc = (el) => {
      const near = climb(el, x => (x.textContent || '').trim().length > 0, 3);
      return '#' + allFileInputs.indexOf(el) + ' accept="' + (el.getAttribute('accept') || '') + '" class="' +
        (typeof el.className === 'string' ? el.className : '').slice(0, 40) + '" ' + (visible(el) ? 'hiện' : 'ẩn') +
        (inZone(el) ? ' [trong vùng đại diện]' : '') + ' gần chữ: "' + ((near && near.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 50) + '"';
    };
    await log('Ảnh đại diện (' + fname + ', ' + Math.round(file.size / 1024) + ' KB). Trang có ' + allFileInputs.length + ' ô chọn file: ' + allFileInputs.map(candDesc).join(' ; '));
    // v2.4 — đi theo đúng luồng người dùng thật: bấm vào vùng tải ảnh để mở hộp thoại/thư viện ảnh
    // của Zalo, tải file lên ngay trong hộp thoại đó, chọn ảnh vừa tải, bấm xác nhận.
    // (Nhét file thẳng vào ô file ẩn như các bản trước: Zalo bỏ qua, vẫn báo thiếu ảnh đại diện.)
    let attached = false;
    const dzText = Array.from(document.querySelectorAll('div, span, a, p'))
      .filter(el => visible(el) && /Nhấn để tải ảnh|Tải ảnh/.test((el.textContent || '').replace(/\s+/g, ' ').trim()) && (el.textContent || '').replace(/\s+/g, ' ').trim().length < 120)
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    if (dzText) {
      realClick(dzText);
      await log('Đã bấm vào vùng tải ảnh bìa (“' + (dzText.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) + '”), chờ hộp thoại của Zalo…');
      await sleep(1800);
    } else await log('Không thấy vùng “Tải ảnh” để bấm — sẽ gắn thẳng vào ô file của bìa.');

    // Panel ảnh bìa của Zalo là 1 trình CẮT ảnh (ghi rõ "Kích thước yêu cầu: 16:9", vùng an toàn 14:9):
    // tải ảnh vào panel xong PHẢI bấm nút "Đồng ý" của panel thì ảnh bìa mới được tính
    // (Duong chỉ ra điểm này sau lượt v2.4 — các bản trước đều thiếu đúng cú bấm đó).
    const panelAnchor = () => Array.from(document.querySelectorAll('div, span, p'))
      .filter(el => visible(el) && (el.textContent || '').includes('Kích thước yêu cầu'))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0] || null;
    let panel = panelAnchor();
    const panelOpened = !!panel;
    if (panel) {
      panel = climb(panel, el => !!el.querySelector('input[type="file"]'), 8) || panel;
      await log('Panel ảnh bìa đã mở: “' + (panel.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180) + '”');
      const inp = panel.querySelector('input[type="file"]') || document.querySelector('input[type="file"]');
      if (inp) { setFile(inp); await log('Đã đưa file ảnh vào panel, chờ trình cắt ảnh sẵn sàng (nút Đồng ý hiện ra)…'); }
      const findAgree = () => Array.from(document.querySelectorAll('a, button, input, [role="button"], div, span'))
        .filter(el => visible(el) && !el.closest('#mttq-auto-overlay') &&
          (el.textContent || el.value || '').replace(/\s+/g, ' ').trim() === 'Đồng ý')
        .sort((a, b) => (a.textContent || a.value || '').length - (b.textContent || b.value || '').length)[0] || null;
      let agree = null;
      for (let i = 0; i < 40 && !agree; i++) { await sleep(750); agree = findAgree(); }
      if (agree) {
        await log('Thấy nút xác nhận của panel ảnh bìa: ' + describeEl(agree));
        realClick(agree);
        await log('Đã bấm “Đồng ý” trong panel ảnh bìa.');
        await sleep(1500);
        for (let i = 0; i < 20 && !attached; i++) {
          await sleep(750);
          if (!panelAnchor() || hasPreview()) attached = true; // panel đã đóng hoặc ảnh đã hiện ở form
        }
        if (attached) await log('Ảnh bìa đã được xác nhận và hiện ở form.');
        else await log('Đã bấm Đồng ý nhưng chưa rõ ảnh bìa đã vào form chưa — để khâu kiểm chứng cuối phán quyết.');
      } else {
        await log('⚠ Chờ 30 giây không thấy nút “Đồng ý” của panel ảnh bìa — ảnh có thể chưa vào được trình cắt.');
      }
    } else {
      await log('Không thấy panel cắt ảnh bìa (không có chữ “Kích thước yêu cầu”).');
    }

    // Dự phòng CHỈ khi panel chưa từng mở: gắn thẳng vào ô file của bìa (bỏ qua ô video)
    if (!attached && !panelOpened) {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter(el => !/mp4|avi|video/i.test(el.getAttribute('accept') || ''));
      const coverInput = inputs.find(el => {
        const near = climb(el, x => (x.textContent || '').trim().length > 0, 3);
        return /tải ảnh|Thay đổi ảnh/i.test((near && near.textContent) || '');
      }) || inputs[0];
      if (coverInput) {
        setFile(coverInput);
        await log('Dự phòng: đã gắn thẳng file vào ô bìa, chờ tối đa 30 giây…');
        for (let i = 0; i < 40 && !attached; i++) { await sleep(750); if (hasPreview()) attached = true; }
        if (attached) await log('Ảnh bìa đã hiện ở form (gắn thẳng).');
      }
    }
    if (!attached) await log('⚠ Mọi cách gắn ảnh bìa đều chưa cho ảnh xem trước — vẫn bấm đăng tiếp để Zalo xác nhận bằng thông báo của nó.');
  }

  async function clickPublishZalo() {
    await patchJob({ zaloPhase: 'verify', zaloDialogOk: false }); // nếu trang nạp lại sau khi đăng, lần chạy sau đi thẳng vào kiểm chứng
    try { sessionStorage.removeItem('mttqZaloReloaded'); } catch (e) {}
    let dialogOk = false;
    // CHỜ DÒNG LƯU NHÁP (bước Duong tự test tay và chỉ ra, 21:16): sau khi ảnh bìa được xác nhận,
    // phải chờ trang hiện dòng "Bản nháp được lưu lúc…" (bản nháp đã gồm ảnh bìa được lưu lên máy chủ)
    // rồi mới bấm Xuất bản — bấm sớm hơn là nút không ăn, bài ở lại dạng nháp.
    const saveLine = () => Array.from(document.querySelectorAll('div, span, p'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .find(t => /được lưu lúc|Đã lưu lúc/.test(t) && t.length < 120) || null;
    let sl = null;
    for (let i = 0; i < 40 && !sl; i++) { sl = saveLine(); if (!sl) await sleep(750); }
    if (sl) { await log('Thấy dòng lưu nháp: “' + sl + '” — chờ thêm 3 giây cho chắc rồi mới bấm Xuất bản.'); await sleep(3000); }
    else await log('Chưa thấy dòng “Bản nháp được lưu lúc…” sau 30 giây — vẫn bấm Xuất bản thử.');
    // Chẩn đoán blob (v2.37): sau lượt lưu nháp, Zalo đã đổi các blob thành link máy chủ của nó chưa?
    if (blobImgCount > 0) {
      try {
        const st = await sendMsg({ type: 'GET_BODY_IMG_STATE' });
        if (st && st.ok && st.result && st.result.ck) {
          const r = st.result;
          await log('Chẩn đoán ảnh trong thân sau lưu nháp: tổng ' + r.total + ' ảnh — còn blob: ' + r.blob + ', link http: ' + r.http + (r.hosts && r.hosts.length ? ' (miền: ' + r.hosts.join(', ') + ')' : '') + '.');
        } else await log('Chẩn đoán ảnh sau lưu nháp: không đọc được trạng thái trình soạn.');
      } catch (e) { await log('Chẩn đoán ảnh sau lưu nháp lỗi: ' + (e && e.message || e)); }
    }
    // Chẩn đoán trạng thái form theo AngularJS: trường nào đang bị đánh dấu không hợp lệ (class ng-invalid)
    // thì nút Xuất bản có thể bị khóa ngầm — ghi hết ra log trước khi bấm
    const invalids = Array.from(document.querySelectorAll('.ng-invalid')).filter(el => !el.closest('#mttq-auto-overlay')).slice(0, 10);
    await log('Chẩn đoán form: ' + (invalids.length
      ? invalids.map(el => el.tagName + '[name="' + (el.getAttribute('name') || '') + '", ng-model="' + (el.getAttribute('ng-model') || '') + '", ph="' + (el.getAttribute('placeholder') || '') + '", class="' + (typeof el.className === 'string' ? el.className : '').slice(0, 60) + '"]').join(' ; ')
      : 'không có trường nào bị đánh dấu không hợp lệ (ng-invalid)'));
    // Liệt kê MỌI phần tử mang chữ đúng "Xuất bản" (Duong nghi bấm nhầm nút) —
    // ưu tiên phần tử nằm cùng hàng thao tác với "Lưu nháp"/"Xem trước" ở cuối form
    const pubCands = () => Array.from(document.querySelectorAll('a, button, input, [role="button"], div, span'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay') &&
        (el.textContent || el.value || '').replace(/\s+/g, ' ').trim() === 'Xuất bản');
    await waitFor(() => pubCands()[0] || null, 10000, 'nút Xuất bản');
    const all = pubCands();
    for (const c of all) {
      const row = climb(c, el => /Lưu nháp/.test(el.textContent || ''), 6);
      await log('Ứng viên nút “Xuất bản”: ' + describeEl(c) + (row ? ' [cùng hàng với Lưu nháp]' : ''));
    }
    const target = all.find(c => climb(c, el => /Lưu nháp/.test(el.textContent || ''), 6)) || all[0];
    await log('Sẽ bấm: ' + describeEl(target));
    // Chụp danh sách nút đang hiện TRƯỚC cú bấm — để lát nhận ra nút nào MỚI xuất hiện (nút của hộp thoại xác nhận)
    const btnLabels = () => Array.from(document.querySelectorAll('a, button, input, [role="button"]'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
      .map(el => (el.textContent || el.value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const beforeBtns = new Set(btnLabels());
    // Chụp cả các đoạn chữ ngắn đang hiện — để lát bắt được bất kỳ dòng chữ nào MỚI xuất hiện (thông báo, menu, gợi ý…)
    const shortTexts = () => new Set(Array.from(document.querySelectorAll('div, span, p, a, button, li, td, h1, h2, h3, h4'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 0 && t.length <= 80));
    const beforeTexts = shortTexts();
    const freshTextSeen = new Set();
    realClick(target);
    await log('Đã bấm “Xuất bản”, theo dõi phản hồi của trang…');
    // Theo dõi tối đa ~30 giây. Hộp thoại xác nhận của Zalo chưa rõ mẫu chữ nên:
    // nhận diện mọi hộp thoại/modal hiện ra sau cú bấm, GHI LẠI nguyên văn + các nút của nó vào log,
    // rồi bấm nút xác nhận theo danh sách nhãn mở rộng.
    const CONFIRM_LABELS = ['Xuất bản', 'Đăng bài', 'Đăng ngay', 'Xuất bản ngay', 'Đồng ý', 'Xác nhận', 'OK', 'Tiếp tục', 'Có'];
    const findDialog = () => {
      const cands = Array.from(document.querySelectorAll('div, section, aside'))
        .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
        .filter(el => {
          const cls = (typeof el.className === 'string' ? el.className : '');
          const style = window.getComputedStyle(el);
          const modalish = /modal|dialog|popup|confirm/i.test(cls) || el.getAttribute('role') === 'dialog' ||
            (style.position === 'fixed' && parseInt(style.zIndex || '0', 10) >= 100);
          if (!modalish) return false;
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.includes('Mã SP') || t.includes('Chọn sản phẩm')) return false; // hộp thoại chọn sản phẩm đính kèm — không phải hộp thoại đăng bài
          if (t.includes('Kích thước yêu cầu')) return false; // panel cắt ảnh bìa — không phải hộp thoại đăng bài
          return t.length > 0 && t.length < 600 && el.querySelector('a, button, input, [role="button"]');
        })
        .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      return cands[0] || null;
    };
    let dialogSeen = '';
    let errSeen = false;
    let freshLogged = false;
    let reacted = false;
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      // Hộp thoại thành công của Zalo: "Thông báo — Xuất bản thành công — [Đóng]"
      const succEl = Array.from(document.querySelectorAll('div, p, span'))
        .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
        .find(el => (el.textContent || '').replace(/\s+/g, ' ').trim() === 'Xuất bản thành công');
      if (succEl) {
        reacted = true;
        dialogOk = true;
        await patchJob({ zaloDialogOk: true });
        await log('🎉 Zalo báo: “Xuất bản thành công”!');
        const closeBtn = findClickable('Đóng');
        if (closeBtn) { realClick(closeBtn); await log('Đã bấm “Đóng” hộp thoại thông báo.'); }
        break;
      }
      const dlg = findDialog();
      if (dlg) {
        const dtxt = (dlg.textContent || '').replace(/\s+/g, ' ').trim();
        const btns = Array.from(dlg.querySelectorAll('a, button, input, [role="button"]')).filter(visible)
          .map(el => (el.textContent || el.value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (dtxt !== dialogSeen) {
          dialogSeen = dtxt;
          await log('Thấy hộp thoại: “' + dtxt.slice(0, 200) + '” — các nút: [' + btns.join(' | ') + ']');
        }
        const cb = Array.from(dlg.querySelectorAll('a, button, input, [role="button"]')).filter(visible)
          .find(el => CONFIRM_LABELS.includes((el.textContent || el.value || '').replace(/\s+/g, ' ').trim()));
        if (cb) { reacted = true; realClick(cb); await log('Đã bấm nút xác nhận “' + (cb.textContent || cb.value || '').replace(/\s+/g, ' ').trim() + '” trong hộp thoại.'); await sleep(1500); }
      }
      // Hộp thoại neo theo CHỮ (phòng khi hộp thoại xác nhận của Zalo không mang class modal/fixed)
      const qEl = Array.from(document.querySelectorAll('div, p, span, h2, h3'))
        .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
        .find(el => /chắc chắn|muốn xuất bản|xác nhận đăng|đăng bài viết này/i.test(el.textContent || '') && (el.textContent || '').length < 300);
      if (qEl) {
        let box = qEl;
        for (let k = 0; k < 7 && box; k++) {
          const b = Array.from(box.querySelectorAll('a, button, input, [role="button"]')).filter(visible)
            .find(el => CONFIRM_LABELS.includes((el.textContent || el.value || '').replace(/\s+/g, ' ').trim()));
          if (b) {
            reacted = true;
            await log('Thấy hộp thoại hỏi xác nhận: “' + (qEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) + '”');
            realClick(b);
            await log('Đã bấm nút xác nhận “' + (b.textContent || b.value || '').replace(/\s+/g, ' ').trim() + '” trong hộp thoại hỏi.');
            await sleep(1500);
            break;
          }
          box = box.parentElement;
        }
      }
      // CHỮ mới xuất hiện sau cú bấm — bắt mọi thông báo/menu/gợi ý dù cấu trúc thế nào
      const freshTexts = Array.from(shortTexts()).filter(t => !beforeTexts.has(t) && !freshTextSeen.has(t));
      for (const t of freshTexts.slice(0, 6)) { freshTextSeen.add(t); await log('Chữ mới xuất hiện: “' + t + '”'); }
      const ACTION_LABELS = ['Xuất bản ngay', 'Đăng ngay', 'Đăng bài', 'Đồng ý', 'Xác nhận', 'Hoàn tất'];
      const actEl = Array.from(document.querySelectorAll('a, button, input, [role="button"], div, span, li'))
        .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
        .find(el => ACTION_LABELS.includes((el.textContent || el.value || '').replace(/\s+/g, ' ').trim()) &&
          freshTexts.includes((el.textContent || el.value || '').replace(/\s+/g, ' ').trim()));
      if (actEl) { reacted = true; realClick(actEl); await log('Đã bấm phần tử mới “' + (actEl.textContent || actEl.value || '').replace(/\s+/g, ' ').trim() + '”.'); await sleep(1500); }
      // Sau ~6 giây vẫn không phản hồi: bấm lại nút Xuất bản lần 2 với đủ chuỗi sự kiện pointer/mouse
      if (i === 12 && !reacted) {
        await log('Chưa thấy phản hồi — bấm lại nút Xuất bản lần 2 (đủ sự kiện pointer/mouse)…');
        const o2 = { bubbles: true, cancelable: true };
        target.dispatchEvent(new PointerEvent('pointerdown', o2));
        target.dispatchEvent(new MouseEvent('mousedown', o2));
        target.dispatchEvent(new PointerEvent('pointerup', o2));
        target.dispatchEvent(new MouseEvent('mouseup', o2));
        target.click();
      }
      // Nút MỚI xuất hiện sau cú bấm (so với ảnh chụp trước khi bấm) — ghi lại, và bấm nếu là nút xác nhận
      const fresh = btnLabels().filter(x => !beforeBtns.has(x));
      if (fresh.length && !freshLogged) {
        freshLogged = true;
        await log('Các nút mới xuất hiện sau cú bấm: [' + fresh.slice(0, 10).join(' | ') + ']');
        const fb = Array.from(document.querySelectorAll('a, button, input, [role="button"]'))
          .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
          .find(el => fresh.includes((el.textContent || el.value || '').replace(/\s+/g, ' ').trim()) &&
            CONFIRM_LABELS.includes((el.textContent || el.value || '').replace(/\s+/g, ' ').trim()));
        if (fb) { reacted = true; realClick(fb); await log('Đã bấm nút mới “' + (fb.textContent || fb.value || '').replace(/\s+/g, ' ').trim() + '”.'); await sleep(1500); }
      }
      if (!errSeen) {
        const errEl = Array.from(document.querySelectorAll('div, span, p'))
          .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
          .find(el => /vui lòng|bắt buộc|không được để trống|chưa chọn|chưa tải|thất bại|có lỗi/i.test(el.textContent || '') && (el.textContent || '').length < 200);
        if (errEl) { errSeen = true; await log('⚠ Trang báo: “' + (errEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) + '”'); }
      }
      if (!location.pathname.includes('/create')) { await log('Đã rời trang soạn bài.'); break; }
      const toast = !dlg && Array.from(document.querySelectorAll('div, span, p'))
        .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
        .some(el => /thành công/i.test(el.textContent || '') && (el.textContent || '').length < 200);
      if (toast) { reacted = true; await log('Thấy thông báo thành công.'); break; }
    }
    if (!reacted && !errSeen && location.pathname.includes('/create')) {
      await log('Sau 45 giây trang không đổi, không thấy hộp thoại/thông báo nào. Các nút đang hiện: [' + btnLabels().slice(0, 15).join(' | ') + ']');
    }
    await sleep(1500);
    return dialogOk;
  }

  // ---------- sổ đăng cục bộ (chống đăng trùng, v2.16) ----------
  const normTitle = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  async function historyFind(target, title) {
    const { postedHistory } = await chrome.storage.local.get(['postedHistory']);
    return (postedHistory || []).find(h => h.g === target && normTitle(h.t) === normTitle(title)) || null;
  }
  async function historyAdd(target, title, url) {
    const { postedHistory } = await chrome.storage.local.get(['postedHistory']);
    const list = (postedHistory || []).filter(h => !(h.g === target && normTitle(h.t) === normTitle(title)));
    list.unshift({ t: title, g: target, u: url || '', at: Date.now() });
    await chrome.storage.local.set({ postedHistory: list.slice(0, 200) });
  }
  async function historyRemove(target, title) {
    try {
      const { postedHistory } = await chrome.storage.local.get(['postedHistory']);
      const list = (postedHistory || []).filter(h => !(h.g === target && normTitle(h.t) === normTitle(title)));
      await chrome.storage.local.set({ postedHistory: list });
    } catch (e) {}
  }
  // Kiểm tra trùng phía Zalo: TRẠNG THÁI THẬT trên OA quyết định — chỉ nhìn TRANG 1 của danh
  // sách (20 bài mới nhất), KHÔNG lật các trang sau. Chỉ bản ĐÃ XUẤT BẢN trùng tiêu đề mới tính
  // là trùng; bản nháp trùng tên không chặn. Sổ cục bộ chỉ còn là dự phòng: nếu sổ ghi đã đăng
  // GẦN ĐÂY (≤3 ngày, bài còn mới thì phải nằm ở trang 1) mà trang 1 không thấy bài nữa thì
  // hiểu là bài đã bị xóa → cho đăng lại; sổ ghi đã lâu thì có thể bài còn nhưng đã trôi khỏi
  // trang 1 → vẫn tin sổ tay. (v2.24: sửa lỗi anh xóa bài trên OA mà extension vẫn báo "đã có"
  // vì sổ cục bộ ghi trùng là bỏ qua ngay, không thèm nhìn OA.)
  async function findDuplicateOnZalo(article) {
    // Vừa dừng khẩn cấp bài này = anh chủ động muốn đăng lại từ đầu: bỏ qua kiểm tra trùng đúng 1 lần (hạn 24 giờ)
    try {
      const { repostBypass } = await chrome.storage.local.get(['repostBypass']);
      if (repostBypass && normTitle(repostBypass.t) === normTitle(article.title) && Date.now() - (repostBypass.at || 0) < 24 * 3600 * 1000) {
        await chrome.storage.local.remove(['repostBypass']);
        await log('Đăng lại từ đầu theo lệnh dừng khẩn cấp trước đó — lần này bỏ qua kiểm tra trùng.');
        return null;
      }
    } catch (e) {}
    const hit = await historyFind('zalo', article.title);
    if (location.pathname.includes('/content/article/create')) {
      // Đang ở form soạn — không có danh sách để đối chiếu trạng thái thật, đành tin sổ tay
      return hit ? { url: hit.u || ARTICLE_URL } : null;
    }
    let st = null;
    try { st = await waitFor(() => rowStatusFor(trunc(article.title, 150)), 6000, 'dòng bài trong danh sách'); }
    catch (e) { if (e && e.isStop) throw e; st = null; }
    if (st === 'published') return { url: ARTICLE_URL };
    if (st === 'draft') return null; // bản nháp trùng tên không chặn (quy tắc cũ)
    // Đã chờ đủ mà không thấy dòng bài ở trang 1: bài đã bị xóa, hoặc đã trôi khỏi trang 1
    if (!hit) return null;
    if (Date.now() - (hit.at || 0) < 3 * 24 * 3600 * 1000) {
      await log('Sổ tay ghi bài này đã đăng Zalo, nhưng không thấy trên OA nữa (có thể anh đã xóa) — sẽ đăng lại.');
      await historyRemove('zalo', article.title);
      return null;
    }
    return { url: hit.u || ARTICLE_URL };
  }

  // Đọc trạng thái của ĐÚNG dòng chứa bài này: chỉ leo tối đa 6 tầng và chỉ nhận khối nào
  // chứa tiêu đề đúng 1 lần và không quá dài (tránh leo lên cả bảng rồi đọc nhầm trạng thái của bài khác)
  function rowStatusFor(title) {
    const hits = Array.from(document.querySelectorAll('a, div, span, td'))
      .filter(el => visible(el) && (el.textContent || '').replace(/\s+/g, ' ').trim() === title)
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    for (const hit of hits) {
      let cur = hit;
      for (let i = 0; i < 6 && cur; i++) {
        const t = (cur.textContent || '').replace(/\s+/g, ' ');
        if (t.length > 900) break;
        if (t.split(title).length - 1 > 1) break; // khối chứa nhiều dòng bài — không phải dòng của bài này
        const badgeEls = Array.from(cur.querySelectorAll('span, div, td, a'))
          .filter(el => { const x = (el.textContent || '').replace(/\s+/g, ' ').trim(); return x === 'Đã xuất bản' || x === 'Nháp'; });
        if (badgeEls.length) {
          // Khối leo lên có thể lẫn nhãn trạng thái của dòng khác — lấy nhãn GẦN tiêu đề nhất theo chiều dọc (đúng dòng của bài)
          const hr = hit.getBoundingClientRect();
          let best = null, bestDy = Infinity;
          for (const b of badgeEls) {
            const r = b.getBoundingClientRect();
            const dy = Math.abs((r.top + r.bottom) / 2 - (hr.top + hr.bottom) / 2);
            if (dy < bestDy) { bestDy = dy; best = b; }
          }
          return (best.textContent || '').replace(/\s+/g, ' ').trim() === 'Nháp' ? 'draft' : 'published';
        }
        cur = cur.parentElement;
      }
    }
    return null;
  }

  async function searchListFor(article) {
    for (let i = 0; i < 10; i++) {
      const st = rowStatusFor(article.title);
      if (st) return st;
      await sleep(3000);
    }
    return null;
  }

  async function finishVerify(article, dialogOk) {
    await log('Đang kiểm chứng trong danh sách bài viết Zalo OA…');
    if (!location.pathname.startsWith('/manage/content/article') || location.pathname.includes('/create')) {
      location.href = ARTICLE_URL;
      await sleep(3000);
    }
    let res = await searchListFor(article);
    if (res !== 'published' && !sessionStorage.getItem('mttqZaloReloaded')) {
      // Danh sách có thể đang là bản cũ chưa kịp cập nhật trạng thái — nạp lại 1 lần rồi tìm lại trước khi kết luận
      sessionStorage.setItem('mttqZaloReloaded', '1');
      await log('Chưa thấy trạng thái Đã xuất bản — tải lại danh sách một lần rồi kiểm chứng lại…');
      location.reload();
      await sleep(3500);
      res = await searchListFor(article);
    }
    if (res === 'published') {
      await targetDone({ ok: true, url: ARTICLE_URL });
      if (titleEl) titleEl.textContent = 'Zalo OA – ĐÃ ĐĂNG XONG ✔';
      await log('✔ ĐÃ ĐĂNG LÊN ZALO OA “' + OA_NAME + '”: bài có trong danh sách, trạng thái Đã xuất bản.');
    } else if (res === 'draft' && dialogOk) {
      // Chính Zalo đã hiện hộp thoại "Xuất bản thành công" — tin hộp thoại của Zalo hơn dòng trạng thái đọc được
      await targetDone({ ok: true, url: ARTICLE_URL });
      if (titleEl) titleEl.textContent = 'Zalo OA – ĐÃ ĐĂNG ✔';
      await log('✔ Zalo đã hiện hộp thoại “Xuất bản thành công” nên bài ĐÃ ĐĂNG — chỉ là trạng thái trong danh sách em đọc được vẫn ghi NHÁP (danh sách cập nhật chậm). Anh lướt danh sách xác nhận giúp em nhé.');
    } else if (res === 'draft') {
      await targetDone({ ok: false, reason: 'draft' });
      if (titleEl) titleEl.textContent = 'Zalo OA – BÀI ĐANG LÀ NHÁP';
      await log('Bài đã được lưu nhưng đang ở trạng thái NHÁP — cú bấm Xuất bản chưa hoàn tất. Anh mở bài trong danh sách và bấm Xuất bản tay giúp em lần này; em đã gắn chẩn đoán ở khâu đăng trong bản sau để sửa tận gốc.');
    } else {
      await targetDone({ ok: false, reason: 'unverified' });
      await log('Đã bấm đăng nhưng chưa thấy bài trong danh sách sau khi chờ — anh mở trang Quản lý bài viết Zalo OA kiểm tra giúp em.');
    }
  }

  // ---------- luồng chính ----------
  async function runZalo() {
    if (window.__zaloRunning) return;
    const { job } = await chrome.storage.local.get(['job']);
    if (!job || !job.active) return;
    const targets = job.targets || {};
    if (!targets.zalo) return;
    if (job.zaloResult) return;
    if (job.startedAt && Date.now() - job.startedAt > 12 * 60 * 1000) {
      ensureOverlay();
      if (job.fromQueue) {
        // Hàng chờ nhiều bài: chốt luôn kết quả "quá hạn" cho cả 2 đích để background chuyển sang bài kế tiếp, tránh kẹt hàng
        const next = Object.assign({}, job, { active: false, step: 'expired' });
        if (!next.zaloResult) next.zaloResult = { ok: false, reason: 'expired' };
        if (job.targets && job.targets.mttq && !next.mttqResult) next.mttqResult = { ok: false, reason: 'expired' };
        await chrome.storage.local.set({ job: next });
        const stOf = (r) => !r ? 'fail' : r.ok ? 'ok' : r.reason === 'duplicate' ? 'duplicate' : 'fail';
        await sendMsg({ type: 'JOB_DONE', summary: {
          title: (job.article && job.article.title) || 'Bài viết',
          mttq: job.targets && job.targets.mttq ? stOf(next.mttqResult) : null,
          zalo: stOf(next.zaloResult),
          url: '', mttqUrl: '', zaloUrl: '',
          fromQueue: true, jobId: job.jobId || ''
        } });
        await log('Bài này đã quá hạn 12 phút trong hàng chờ — chốt lỗi và chuyển sang bài kế tiếp.');
        return;
      }
      await patchJob({ active: false, step: 'expired' });
      await log('Đã hủy 1 job cũ quá 12 phút chưa chạy xong (tránh đăng trùng).');
      return;
    }
    if (await stopRequested()) return; // vừa bấm dừng khẩn cấp — background đang dọn job, tab này đứng yên
    const r = job.runners && job.runners.zalo;
    if (r && r.id !== RUNNER_ID && r.at && Date.now() - r.at < 25000) {
      setTimeout(runZalo, 26000);
      return;
    }
    await patchJob({});
    myJobId = job.jobId || null;
    window.__zaloRunning = true;
    ensureOverlay();
    await replayLog();

    try {
      // Trang đăng nhập QR: chỉ thông báo, chờ anh quét — sau khi vào OA, script bên oa.nhatkyzalo.vn tự tiếp tục
      if (location.hostname === 'id.zalo.me') {
        await log('Phiên Zalo đã hết hạn — anh quét mã QR trên trang này để đăng nhập lại; vào được OA là em tự chạy tiếp.');
        return;
      }

      // Pha kiểm chứng (sau khi đã bấm Xuất bản ở lần chạy trước)
      if (job.zaloPhase === 'verify' && job.article) {
        await finishVerify(job.article, !!job.zaloDialogOk);
        return;
      }

      // Chọn OA nếu đang ở trang danh sách OA
      if (location.pathname === '/manage/oa' || location.pathname === '/manage' || location.pathname === '/manage/') {
        await log('Đang chọn OA “' + OA_NAME + '”…');
        const oaEl = await waitFor(() => {
          const els = Array.from(document.querySelectorAll('a, div, span, td')).filter(visible);
          return els.filter(el => (el.textContent || '').includes(OA_NAME))
            .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0] || null;
        }, 12000, 'tên OA trong danh sách');
        realClick(oaEl);
        await sleep(2500);
        return; // trang chuyển sang bảng điều khiển, script chạy lại
      }

      // Tới trang quản lý bài viết
      if (!location.pathname.startsWith('/manage/content/article')) {
        location.href = ARTICLE_URL;
        return;
      }

      // Bài viết: dùng bản đã đọc sẵn (đích cổng đọc trước) hoặc tự đọc
      let article = job.article || null;
      if (!article) {
        await log('Đang đọc bài nguồn: ' + job.url);
        const r = await sendMsg({ type: 'FETCH_TEXT', url: job.url, credentials: 'omit' });
        if (!r || !r.ok) throw new Error('Không tải được bài nguồn (HTTP ' + (r && r.status) + ').');
        article = window.MTTQParser.parseArticle(r.text, job.url);
        await patchJob({ article: article });
        await log('Đã đọc bài: “' + article.title + '” — ' + article.images.length + ' ảnh, tác giả: ' + (article.author || '(trống)'));
      }

      // Chống đăng trùng: bài này đã xuất bản trên OA rồi thì bỏ qua, không mở form nữa
      const dupZ = await findDuplicateOnZalo(article);
      if (dupZ) {
        await targetDone({ ok: false, reason: 'duplicate', url: dupZ.url });
        if (titleEl) titleEl.textContent = 'Zalo OA – ĐÃ CÓ BÀI NÀY ⏭';
        await log('⏭ Bài này ĐÃ CÓ trên Zalo OA (đã xuất bản) — bỏ qua, không đăng lại.');
        return;
      }

      // Mở form soạn bài mới
      if (!location.pathname.includes('/content/article/create')) {
        const btn = await waitFor(() => findClickable('Soạn bài viết mới'), 12000, 'nút Soạn bài viết mới');
        await log('Bấm “Soạn bài viết mới”…');
        realClick(btn);
        await sleep(2500);
        if (!location.pathname.includes('/content/article/create')) return; // chưa chuyển trang — lần chạy sau tiếp tục
      }

      // Điền các trường (giới hạn của Zalo: Tiêu đề 150, Trích dẫn 300, Tác giả 50 ký tự)
      let titleIn = null;
      try {
        titleIn = await waitFor(() =>
          document.querySelector('input[placeholder="Nhập tiêu đề bài viết"]') ||
          findInputByPlaceholder('tiêu đề') || fieldByLabel('Tiêu đề') || firstFormTextInput(),
          20000, 'ô Tiêu đề');
      } catch (e) {
        await log('Chẩn đoán khi không thấy ô Tiêu đề — ' + dumpInputs());
        throw e;
      }
      await log('Ô tiêu đề tìm được: ' + describeEl(titleIn));
      fillText(titleIn, trunc(article.title, 150));
      await log('Đã điền tiêu đề. (trạng thái Angular của ô sau khi điền: ' + (typeof titleIn.className === 'string' ? titleIn.className : '').slice(0, 90) + ')');
      const quoteIn = findInputByPlaceholder('trích dẫn') || fieldByLabel('Trích dẫn');
      if (quoteIn) { fillText(quoteIn, trunc(article.summaryText, 300)); await log('Đã điền trích dẫn.'); }
      else await log('⚠ Không thấy ô Trích dẫn — bỏ qua.');
      const authorIn = findInputByPlaceholder('tác giả') || fieldByLabel('Tác giả');
      if (authorIn && article.author) { fillText(authorIn, trunc(article.author, 50)); await log('Đã điền tác giả: ' + article.author); }

      // RIÊNG ảnh Dân Trí (v2.37): CDN của họ chặn referer nên Zalo từ chối xuất bản khi thân bài
      // chứa link ảnh Dân Trí (lỗi "Không thể tải ảnh"). Cách chữa: tải các ảnh đó về trước, lát nữa
      // cầu nối sẽ tạo blob ngay trong trang và thay link — Zalo tự tải blob lên kho ảnh của nó khi
      // lưu nháp/xuất bản, đúng như ảnh người dùng tự chèn qua hộp thoại của Zalo.
      const dtImgs = (article.images || []).filter(u => /dantri\.com\.vn/i.test(u));
      let blobFiles = [];
      if (dtImgs.length) {
        for (const u of dtImgs) {
          const resp = await sendMsg({ type: 'FETCH_IMAGE_B64', url: u });
          if (resp && resp.ok) {
            let fname = 'anh-dan-tri.jpg';
            try { fname = decodeURIComponent(new URL(u).pathname.split('/').pop()) || fname; } catch (e) {}
            blobFiles.push({ url: u, b64: resp.b64, mime: resp.mime || 'image/jpeg', name: fname });
          } else {
            await log('⚠ Không tải được 1 ảnh Dân Trí để chèn blob (' + u.slice(-45) + ') — ảnh đó đành giữ link gốc.');
          }
        }
        if (blobFiles.length) await log('Đã tải ' + blobFiles.length + '/' + dtImgs.length + ' ảnh Dân Trí về để chèn dạng blob vào thân bài.');
      }

      // Nội dung qua CKEditor (cùng họ CKEditor 4 như cổng MTTQ) — thử tối đa 3 lần:
      // tab Zalo vừa được mở tự động thì trình soạn thảo có thể chưa kịp sẵn sàng, lần đầu đọc lại sẽ trống
      let bodyOk = false, lastErr = '';
      for (let attempt = 1; attempt <= 3 && !bodyOk; attempt++) {
        const setRes = blobFiles.length
          ? await sendMsg({ type: 'SET_BODY_EDITOR_BLOBS', bodyHtml: article.bodyHtml, files: blobFiles })
          : await sendMsg({ type: 'SET_BODY_EDITOR', bodyHtml: article.bodyHtml });
        if (setRes && setRes.ok && setRes.result && setRes.result.ck) {
          const r = setRes.result;
          blobImgCount = r.blobbed || 0;
          await log('Đã đổ nội dung vào trình soạn thảo (ảnh: ' + r.bodyImgs + '/' + article.images.length + ', chữ: ' + r.bodyTextLen + (r.blobbed ? ', ' + r.blobbed + ' ảnh đã thay bằng blob' : '') + ').');
          if (r.bodyImgs && r.bodyTextLen >= 50) bodyOk = true;
          else { lastErr = 'nội dung đọc lại vẫn trống'; await log('⚠ Lần ' + attempt + ': nội dung chưa vào trình soạn thảo — chờ 3 giây rồi đổ lại…'); await sleep(3000); }
        } else {
          lastErr = (setRes && setRes.result && setRes.result.error) || 'không rõ lý do';
          await log('⚠ Lần ' + attempt + ': chưa đổ được nội dung (' + lastErr + ') — chờ 3 giây rồi thử lại…');
          await sleep(3000);
        }
      }
      if (!bodyOk) throw new Error('Không đổ được nội dung vào trình soạn thảo Zalo sau 3 lần thử (' + lastErr + ') — dừng lại để tránh đăng bài lỗi.');

      // Kiểm tra lại tiêu đề lần cuối (bài học lỗi v1.7 bên cổng: combobox từng ghi đè tiêu đề)
      const tNow = document.querySelector('input[placeholder="Nhập tiêu đề bài viết"]') || findInputByPlaceholder('tiêu đề') || titleIn;
      if (tNow && tNow.value !== trunc(article.title, 150)) {
        await log('⚠ Tiêu đề đang lệch (“' + tNow.value + '”) — đặt lại cho đúng.');
        fillText(tNow, trunc(article.title, 150));
      }

      await attachCover(article);
      const dialogOk = await clickPublishZalo();
      await finishVerify(article, dialogOk);
    } catch (e) {
      if (e && e.isStop) {
        // Dừng khẩn cấp: background đã dọn job + xóa lịch sử của bài này — ở đây chỉ báo trên bảng, không ghi kết quả
        ensureOverlay();
        if (titleEl) titleEl.textContent = 'Zalo OA – ĐÃ DỪNG ⛔';
        if (logEl) logEl.textContent += '· ⛔ ĐÃ DỪNG KHẨN CẤP — việc đã hủy sạch, dán link là đăng lại từ đầu được.\n';
      } else {
        await targetDone({ ok: false, error: String(e && e.message || e) });
        if (titleEl) titleEl.textContent = 'Zalo OA – GẶP LỖI';
        await log('✖ LỖI: ' + (e && e.message || e));
      }
    } finally {
      window.__zaloRunning = false;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runZalo);
  else runZalo();
})();

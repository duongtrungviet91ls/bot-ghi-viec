// Content script: tự đăng nhập (nếu cần) -> mở form "Thêm tin tức" -> điền -> xuất bản -> kiểm chứng.
// Trạng thái việc chạy lưu ở chrome.storage.local (job) nên nạp lại trang vẫn tiếp tục được.
(function () {
  'use strict';
  const LIST_URL = 'https://mttq.langson.gov.vn/page/CMS/Article/list';
  const CATEGORY_PUBLIC = { 'Tin hoạt động': 'https://mttq.langson.gov.vn/tin-tuc-su-kien/tin-hoat-dong' };
  const RUNNER_ID = 'r' + Math.random().toString(36).slice(2, 10); // mỗi bản content script 1 mã — chống 2 tab chạy cùng 1 job
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
  async function getStore() { return await chrome.storage.local.get(['job', 'mttqCreds']); }
  async function patchJob(patch) {
    const { job } = await chrome.storage.local.get(['job']);
    const next = Object.assign({}, job || {}, patch);
    if (next.active) { // nhịp tim của tab đang chạy — tách theo từng đích (cổng và Zalo chạy ở 2 tab khác nhau)
      next.runners = Object.assign({}, next.runners || {}, { mttq: { id: RUNNER_ID, at: Date.now() } });
    }
    await chrome.storage.local.set({ job: next });
    return next;
  }

  // Đánh dấu đích cổng MTTQ đã xong (đăng được / chưa kiểm chứng được / lỗi);
  // chỉ tắt job khi MỌI đích đã chọn đều xong (v2.0: thêm đích Zalo OA chạy song song ở tab khác)
  async function targetDone(result) {
    const { job } = await chrome.storage.local.get(['job']);
    if (!job) return;
    if (myJobId && job.jobId && job.jobId !== myJobId) return; // job đã sang bài khác trong hàng chờ — kết quả này là của bài cũ
    const next = Object.assign({}, job, { mttqResult: result });
    const t = job.targets || { mttq: true };
    // Đăng 2 nơi mà cổng KHÔNG đạt (v2.14 — theo ý anh: cổng OK rồi mới mở Zalo làm):
    // đánh dấu phía Zalo là "bỏ qua" để khép job và thông báo nói rõ, thay vì treo chờ vô định
    if (result && !result.ok && result.reason !== 'duplicate' && t.zalo && !next.zaloResult) {
      next.zaloResult = { ok: false, reason: 'skipped-portal-not-ok' };
    }
    const doneM = !t.mttq || !!next.mttqResult;
    const doneZ = !t.zalo || !!next.zaloResult;
    next.active = !(doneM && doneZ);
    if (!next.active) { next.step = 'done'; next.doneAt = Date.now(); if (result && result.url) next.resultUrl = result.url; }
    await chrome.storage.local.set({ job: next });
    if (result && result.ok && job.article && job.article.title) { try { await historyAdd('mttq', job.article.title, result.url || ''); } catch (e) {} }
    if (!next.active) {
      // Mọi đích đã xong -> nhờ background bật thông báo "đã xong" trên máy tính (v2.12)
      try {
        await sendMsg({ type: 'JOB_DONE', summary: {
          title: (job.article && job.article.title) || 'Bài viết',
          mttq: t.mttq ? (next.mttqResult && next.mttqResult.ok ? 'ok' : (next.mttqResult && next.mttqResult.reason === 'duplicate' ? 'duplicate' : 'fail')) : null,
          zalo: t.zalo ? (next.zaloResult && next.zaloResult.ok ? 'ok' : (next.zaloResult && next.zaloResult.reason === 'skipped-portal-not-ok' ? 'skipped' : 'fail')) : null,
          url: next.resultUrl || (next.zaloResult && next.zaloResult.url) || '',
          mttqUrl: (next.mttqResult && next.mttqResult.url) || '',
          zaloUrl: (next.zaloResult && next.zaloResult.url) || '',
          fromQueue: !!job.fromQueue,
          jobId: job.jobId || ''
        } });
      } catch (e) {}
    }
    // Bàn giao sang đích Zalo (v2.10): chọn đăng cả 2 nơi mà phía Zalo chưa chạy ở tab nào
    // thì tự mở tab Zalo OA để script bên đó tiếp quản — trước đây không ai mở tab nên chặng Zalo không bao giờ bắt đầu.
    // (Nếu nhịp tim runner của Zalo còn mới tức là Zalo đang chạy ở tab khác rồi — không mở thêm.)
    const zRun = job.runners && job.runners.zalo;
    const zRunning = !!(zRun && zRun.at && Date.now() - zRun.at < 25000);
    if (next.active && result && (result.ok || result.reason === 'duplicate') && t.zalo && !next.zaloResult && !job.zaloTabOpened && !zRunning) {
      await patchJob({ zaloTabOpened: true, startedAt: Date.now() }); // làm mới đồng hồ 12 phút cho chặng 2
      await log('Cổng MTTQ đã kiểm chứng OK — tự mở tab Zalo OA để đăng tiếp…');
      try { await sendMsg({ type: 'OPEN_OR_FOCUS_TAB', url: 'https://oa.nhatkyzalo.vn/manage/content/article/' }); } catch (e) {}
    }
  }

  // ---------- overlay ----------
  let overlayEl = null, logEl = null, titleEl = null;
  function ensureOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'mttq-auto-overlay';
    overlayEl.style.cssText = 'position:fixed;top:12px;right:12px;width:360px;max-height:70vh;overflow:auto;z-index:2147483647;background:#fff;border:2px solid #8C1D2F;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);font:13px/1.5 Arial,sans-serif;color:#222;';
    titleEl = document.createElement('div');
    titleEl.style.cssText = 'background:#8C1D2F;color:#F7C948;font-weight:bold;padding:8px 12px;border-radius:8px 8px 0 0;';
    titleEl.textContent = 'MTTQ – Tự đăng bài';
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
      if (titleEl) titleEl.textContent = 'MTTQ – ĐÃ DỪNG ⛔';
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
      job.log = ((job.log || []).concat(['[' + time + '] ' + line])).slice(-120);
      if (job.active && job.runners && job.runners.mttq && job.runners.mttq.id === RUNNER_ID) job.runners.mttq.at = Date.now();
      await chrome.storage.local.set({ job });
    }
    console.log('[MTTQ-Auto]', line);
  }
  async function replayLog() {
    const { job } = await chrome.storage.local.get(['job']);
    if (job && job.log && job.log.length) { ensureOverlay(); logEl.textContent = job.log.map(l => '· ' + l).join('\n') + '\n'; }
  }

  // ---------- DOM helpers ----------
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  function allByText(text, selector) {
    const els = Array.from(document.querySelectorAll(selector || 'a, button, li, span, div, label, td'));
    return els.filter(el => visible(el) && ((el.textContent || '').replace(/\s+/g, ' ').trim() === text || (el.tagName === 'INPUT' && (el.value || '').trim() === text)));
  }
  function findClickable(text) {
    const cands = allByText(text, 'a, button, input, [role="button"], li, span, div');
    // Ưu tiên phần tử bấm được thật (button/a/input) rồi tới phần tử ít chữ nhất —
    // tránh bấm nhầm tiêu đề chữ giống hệt (vd chữ "Đăng nhập" là tiêu đề trang)
    const score = (el) => {
      let s = (el.textContent || el.value || '').length;
      if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT') s -= 100000;
      else if (el.getAttribute && el.getAttribute('role') === 'button') s -= 50000;
      else if (el.tagName === 'LI' || el.tagName === 'SPAN') s -= 10000;
      return s;
    };
    cands.sort((a, b) => score(a) - score(b));
    return cands[0] || null;
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
  function setVal(el, val) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  function pressEnter(el) {
    ['keydown', 'keypress', 'keyup'].forEach(t => el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })));
  }
  function findLabelEl(text) {
    const els = Array.from(document.querySelectorAll('label, span, div, td, th'));
    return els.filter(el => visible(el) && (el.textContent || '').replace(/\s+/g, ' ').trim().replace(/[:*]\s*$/, '') === text)
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0] || null;
  }
  function climb(el, pred, max) {
    let cur = el, i = 0;
    while (cur && i < (max || 7)) { if (pred(cur)) return cur; cur = cur.parentElement; i++; }
    return null;
  }
  function fieldRow(labelText) {
    const lab = findLabelEl(labelText);
    if (!lab) return null;
    return climb(lab, el => el.querySelector('input, textarea, button, [contenteditable="true"], select'), 7);
  }
  const sendMsg = (m) => chrome.runtime.sendMessage(m);

  // ---------- bước 1: đăng nhập ----------
  // Gia cố v2.40: sau khi điền, CANH ô đăng nhập ~1,5 giây — trình quản lý mật khẩu của
  // Chrome hay điền đè mật khẩu cũ sau khi extension điền (nghi phạm chính của lỗi "sai mật
  // khẩu" 16/11 và lệnh 5 ngày 23/11, trong khi đăng nhập tay bằng đúng mật khẩu đó lại vào
  // thẳng). Bị đè là điền lại ngay; nhịp cuối đối chiếu → điền lại → bấm liền một mạch,
  // không chừa khoảng trống cho kẻ điền đè. Cổng từ chối thì tự thử lại 1 lần bằng lượt điền
  // mới; cổng bắt đổi mật khẩu thì báo riêng, không thử lại vô ích.
  async function doLogin(creds) {
    await log('Đang ở trang đăng nhập — tiến hành tự đăng nhập…');
    if (!creds || !creds.u || !creds.p) throw new Error('Chưa lưu tài khoản/mật khẩu. Mở trang cài đặt của extension để nhập 1 lần.');
    // Chẩn đoán (v2.31): chỉ ghi ĐỘ DÀI mật khẩu đã lưu, không ghi giá trị — để đối chiếu với mật khẩu thật.
    // Trang cài đặt không hiển thị lại mật khẩu đã lưu nên gõ sai lúc lưu là không nhìn thấy được; độ dài lệch là lộ ngay.
    await log('Đăng nhập bằng tài khoản đã lưu: ' + creds.u + ' — mật khẩu đã lưu dài ' + creds.p.length + ' ký tự.');
    let lastMsg = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await loginAttempt(creds);
      if (r.ok) { await log('Đăng nhập xong.'); return; }
      lastMsg = r.msg;
      if (r.fatal) break;
      if (attempt === 1) await log('⚠ Đăng nhập lần 1 chưa được — em thử lại lần 2 bằng lượt điền mới…');
    }
    throw new Error(lastMsg);
  }

  // Một lượt điền + canh + bấm Đăng nhập. Trả {ok:true} hoặc {ok:false, msg, fatal?}.
  async function loginAttempt(creds) {
    // Chỉ nhận ô ĐANG HIỂN THỊ thật: trang có thể chứa ô mật khẩu ẩn ở nơi khác,
    // và form đăng nhập hiện ra sau một nhịp — phải chờ đúng ô nhìn thấy được.
    const pass = await waitFor(() => Array.from(document.querySelectorAll('input[type="password"]')).find(visible), 15000, 'ô mật khẩu (hiển thị)');
    const findUser = () => {
      const inputs = Array.from(document.querySelectorAll('input')).filter(i => visible(i) && !['password', 'checkbox', 'hidden', 'file', 'radio', 'submit', 'button'].includes(i.type));
      if (!inputs.length) return null;
      const form = pass.closest('form') || climb(pass, el => el.querySelectorAll('input').length >= 2, 6);
      if (form) { const inForm = inputs.filter(i => form.contains(i)); if (inForm.length) return inForm[0]; }
      return inputs[0];
    };
    const user = await waitFor(findUser, 15000, 'ô tài khoản (hiển thị)');
    setVal(user, creds.u);
    setVal(pass, creds.p);
    const cb = Array.from(document.querySelectorAll('input[type="checkbox"]')).find(i => visible(i));
    if (cb && !cb.checked) cb.click(); // ô "Ghi nhớ mật khẩu" — để ít phải đăng nhập lại
    // CANH ĐIỀN ĐÈ ~1,5 giây, nhịp 120ms: ô lệch khỏi giá trị đã lưu là điền lại ngay tại chỗ.
    let overwrites = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      if (user.value !== creds.u || pass.value !== creds.p) {
        overwrites++;
        setVal(user, creds.u);
        setVal(pass, creds.p);
      }
      await sleep(120);
    }
    if (overwrites) await log('⚠ Trong lúc canh, ô đăng nhập bị điền đè ' + overwrites + ' lần (nghi trình quản lý mật khẩu điền mật khẩu cũ) — em đã điền lại bằng tài khoản/mật khẩu đã lưu.');
    await patchJob({ step: 'afterLogin' });
    const btn = findClickable('Đăng nhập') || document.querySelector('button[type="submit"], input[type="submit"]');
    if (!btn) return { ok: false, msg: 'Không thấy nút Đăng nhập.' };
    // Nhịp cuối KHÔNG chờ: đối chiếu → lệch thì điền lại → bấm ngay trong cùng một mạch.
    if (user.value !== creds.u || pass.value !== creds.p) { setVal(user, creds.u); setVal(pass, creds.p); }
    const passLenAtClick = pass.value.length;
    btn.click();
    await log('Đã bấm Đăng nhập (ô mật khẩu lúc bấm dài ' + passLenAtClick + ' ký tự), chờ vào hệ thống…');
    // Chờ tối đa 12 giây: rời khỏi form đăng nhập = thành công; cổng hiện thông báo lỗi = báo lại nguyên văn
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const pwFields = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
      const stillLogin = location.pathname.includes('/login') && pwFields.length > 0;
      if (!stillLogin) return { ok: true };
      // Cổng bắt đổi mật khẩu: form đăng nhập 1 ô mật khẩu hóa thành ≥2 ô (cũ/mới/nhập lại)
      // hoặc trang hiện chữ đặt mật khẩu mới — extension không tự qua được, báo riêng để anh xử lý tay.
      const pageText = ((document.body && document.body.textContent) || '').replace(/\s+/g, ' ');
      if (pwFields.length >= 2 || /mật khẩu mới|đổi mật khẩu lần đầu|cập nhật mật khẩu/i.test(pageText)) {
        return { ok: false, fatal: true, msg: 'Cổng đang BẮT ĐỔI MẬT KHẨU (hiện form đặt mật khẩu mới) nên extension không tự qua được. Anh đăng nhập tay 1 lần, đặt mật khẩu mới, rồi vào Cài đặt của extension lưu lại mật khẩu mới đó giúp em.' };
      }
      const errEl = Array.from(document.querySelectorAll('.alert, .error, .text-danger, [class*="error"]')).find(el => visible(el) && (el.textContent || '').trim().length > 3);
      if (errEl && i > 3) return { ok: false, msg: 'Cổng báo lỗi đăng nhập: ' + (errEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) + ' (đã gửi: tài khoản ' + creds.u + ', mật khẩu đã lưu ' + creds.p.length + ' ký tự, ô lúc bấm ' + passLenAtClick + ' ký tự)' };
    }
    return { ok: false, msg: 'Bấm Đăng nhập rồi nhưng vẫn ở trang đăng nhập sau 12 giây — có thể sai mật khẩu hoặc cổng đổi giao diện. Anh thử đăng nhập tay 1 lần rồi bấm Đăng bài lại.' };
  }

  // ---------- kiểm tra đăng nhập cổng (v2.33) ----------
  // Popup bấm "Kiểm tra đăng nhập cổng" -> ghi cờ loginCheck vào storage + mở tab cổng về
  // trang danh sách; script ở tab này thấy cờ thì kiểm tra: còn phiên thì báo OK, hết phiên
  // thì tự đăng nhập lại bằng tài khoản đã lưu (dùng lại doLogin), kết quả ghi vào
  // loginCheckResult để popup hiển thị. Trang có thể nạp lại giữa lúc đăng nhập nên tiến
  // trình được ghi dở vào chính cờ loginCheck (phase) — bản script sau khi nạp lại vào chốt nốt.
  async function runLoginCheck() {
    const { loginCheck } = await chrome.storage.local.get(['loginCheck']);
    if (!loginCheck || !loginCheck.id || Date.now() - (loginCheck.at || 0) > 3 * 60 * 1000) return;
    const { job } = await chrome.storage.local.get(['job']);
    if (job && job.active) return; // đang có việc đăng bài — không chen ngang (popup cũng đã chặn từ trước)
    // Tab cổng khác đang giữ việc kiểm tra này thì nhường — trừ khi lần trước đã bấm Đăng nhập
    // mà trang nạp lại giữa chừng (phase 'logging-in') thì bản script mới phải vào chốt kết quả thay.
    if (loginCheck.by && loginCheck.by !== RUNNER_ID && Date.now() - (loginCheck.claimedAt || 0) < 60000 && loginCheck.phase !== 'logging-in') return;
    await chrome.storage.local.set({ loginCheck: Object.assign({}, loginCheck, { by: RUNNER_ID, claimedAt: Date.now() }) });
    const finish = async (ok, state, detail) => {
      await chrome.storage.local.set({ loginCheckResult: { id: loginCheck.id, ok: ok, state: state, detail: detail, at: Date.now() } });
      await chrome.storage.local.remove(['loginCheck']);
      // doLogin có patchJob({step:'afterLogin'}) — nếu nó để lại 1 job ma (không active, không link bài) thì dọn luôn cho sạch
      const { job: j2 } = await chrome.storage.local.get(['job']);
      if (j2 && !j2.active && !j2.url && j2.step === 'afterLogin') await chrome.storage.local.remove(['job']);
      if (titleEl) titleEl.textContent = ok ? 'MTTQ – Đăng nhập cổng OK ✔' : 'MTTQ – Kiểm tra đăng nhập: CHƯA ĐƯỢC';
      await log(detail);
    };
    try {
      ensureOverlay();
      titleEl.textContent = 'MTTQ – Kiểm tra đăng nhập cổng';
      const onLoginPage = () => location.pathname.includes('/login') || Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
      const loggedIn = () => !onLoginPage() && (location.href.includes('/page/') || !!findClickable('Thêm mới') || !!findClickable('Quản lý bài viết'));
      // Chờ trang ổn định: hoặc thấy form đăng nhập, hoặc thấy giao diện quản trị
      const t0 = Date.now();
      while (Date.now() - t0 < 12000 && !onLoginPage() && !loggedIn()) await sleepRaw(400);
      if (loggedIn()) {
        if (loginCheck.phase === 'logging-in') await finish(true, 'relogged', 'Phiên đăng nhập đã hết — extension vừa tự đăng nhập lại xong. Đăng bài được ngay.');
        else await finish(true, 'alive', 'Phiên đăng nhập cổng còn sống — đăng bài được ngay, không cần đăng nhập lại.');
        return;
      }
      if (!onLoginPage()) { await finish(false, 'unknown', 'Chưa nhận diện được trạng thái đăng nhập của cổng (trang không giống trang đăng nhập lẫn trang quản trị) — anh mở tab cổng xem giúp em.'); return; }
      // Đang ở trang đăng nhập = phiên đã hết -> đăng nhập lại bằng tài khoản đã lưu
      if (loginCheck.phase === 'logging-in') {
        // Lần trước đã bấm Đăng nhập mà vẫn ở trang này: chờ thêm 1 nhịp rồi chốt, không bấm lại lần 2
        await sleepRaw(6000);
        if (loggedIn()) { await finish(true, 'relogged', 'Phiên đăng nhập đã hết — extension vừa tự đăng nhập lại xong. Đăng bài được ngay.'); return; }
        await finish(false, 'failed', 'Đã thử tự đăng nhập lại nhưng cổng vẫn ở trang đăng nhập — anh đăng nhập tay 1 lần giúp em, và kiểm tra lại tài khoản/mật khẩu đã lưu trong Cài đặt của extension.');
        return;
      }
      await log('Phiên đăng nhập cổng đã hết — tiến hành tự đăng nhập lại…');
      await chrome.storage.local.set({ loginCheck: Object.assign({}, loginCheck, { by: RUNNER_ID, claimedAt: Date.now(), phase: 'logging-in' }) });
      const store = await getStore();
      await doLogin(store.mttqCreds);
      // doLogin trở về = đã rời khỏi form đăng nhập; chờ giao diện quản trị hiện hẳn rồi chốt
      await sleepRaw(1500);
      if (loggedIn()) await finish(true, 'relogged', 'Phiên đăng nhập đã hết — extension vừa tự đăng nhập lại xong. Đăng bài được ngay.');
      else await finish(true, 'relogged', 'Đã tự đăng nhập lại xong (đã rời khỏi trang đăng nhập).');
    } catch (e) {
      await finish(false, 'failed', 'Tự đăng nhập lại không được: ' + (e && e.message || e));
    }
  }

  // Bấm "như người thật": phát đủ chuỗi sự kiện chuột rồi mới click()
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
  // Liệt kê các mục bấm được đang thấy — để log tự chẩn đoán khi kẹt
  function dumpVisibleClickables() {
    const seen = new Set(); const out = [];
    Array.from(document.querySelectorAll('a, button, li, [role="menuitem"], [role="option"], input[type="button"], input[type="submit"]')).forEach(el => {
      if (!visible(el) || el.closest('#mttq-auto-overlay')) return;
      const t = ((el.textContent || el.value || '').replace(/\s+/g, ' ').trim());
      if (t && t.length <= 42 && !seen.has(t)) { seen.add(t); out.push(t); }
    });
    return out.slice(0, 30);
  }
  function findMenuItemContains(part) {
    const els = Array.from(document.querySelectorAll('a, button, li, span, div, [role="menuitem"], [role="option"]'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay') && (el.textContent || '').replace(/\s+/g, ' ').trim().includes(part));
    els.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    return els[0] || null;
  }
  function describeEl(el) {
    if (!el) return '(không có)';
    const t = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 50);
    const p = el.parentElement;
    const pdesc = p ? p.tagName + '.' + (typeof p.className === 'string' ? p.className : '').slice(0, 40) : '';
    return el.tagName + ' "' + t + '" class="' + cls + '" cha: ' + pdesc;
  }
  function snapshotVisible() {
    return new Set(Array.from(document.querySelectorAll('a, button, li, span, div, [role="menuitem"], [role="option"]')).filter(el => visible(el) && !el.closest('#mttq-auto-overlay')));
  }
  function appearedItem(beforeSet, exactText, partText) {
    const now = Array.from(document.querySelectorAll('a, button, li, span, div, [role="menuitem"], [role="option"]'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay') && !beforeSet.has(el));
    const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const exact = now.filter(el => norm(el) === exactText).sort((a, b) => norm(a).length - norm(b).length)[0];
    if (exact) return exact;
    const part = now.filter(el => norm(el).includes(partText) && norm(el).length <= partText.length + 25).sort((a, b) => norm(a).length - norm(b).length)[0];
    return part || null;
  }

  // ---------- bước 2: mở form tạo bài ----------
  async function openCreateForm() {
    const formReady = () => { const el = document.querySelector('input[name="fields[title]"]'); return (el && visible(el)) ? el : null; };
    if (formReady()) return;
    if (!location.href.includes('/page/CMS/Article/list')) { location.href = LIST_URL; await sleep(3000); }
    const addBtn = await waitFor(() => findClickable('Thêm mới'), 12000, 'nút Thêm mới').catch(async (e) => {
      await log('Các mục bấm được đang thấy: ' + dumpVisibleClickables().join(' | '));
      throw e;
    });
    await log('Nút Thêm mới là: ' + describeEl(addBtn));
    // Mở menu Thêm mới → Tin tức.
    // Cách chính (v2.23): neo theo ĐÚNG cấu trúc thật của cổng, đã kiểm chứng ở lượt chạy v1.3
    // ngày 15/11 (lượt menu mở thành công): mục cần bấm là thẻ A.dropdown-item "Tin tức" nằm
    // trong DIV.dropdown-menu, thuộc LI.dropdown có nút gạt "Thêm mới" riêng. Trang có tới 2
    // nút chữ "Thêm mới": một A.add-new-btn đứng riêng trong UL (bấm nó menu KHÔNG mở — đây
    // là nút findClickable chọn nhầm ở các lượt kẹt 16/11) và nút gạt thật trong LI.dropdown.
    // Cách tìm theo khối chữ của v2.22 không khớp được cấu trúc thật nên đã trượt thẳng xuống
    // dự phòng cũ. Lần này: tìm thẳng A.dropdown-item "Tin tức" trong DOM (không cần menu đã
    // mở), suy ra khối menu + nút gạt đúng của nó, rồi thử lần lượt: bấm nút gạt đúng + hover
    // → ép hiện menu (class show/open + gỡ ẩn) → bấm thẳng vào mục dù đang ẩn. Cách cũ (chờ
    // mục mới xuất hiện) giữ làm dự phòng cuối.
    const formPresent = () => document.querySelector('input[name="fields[title]"]');
    const normT = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    let formOpened = false;
    const findNewsDeep = () => {
      const inNewsMenu = (el) => { const m = el.closest('.dropdown-menu'); return !!(m && normT(m).includes('Công báo')); };
      let item = Array.from(document.querySelectorAll('a.dropdown-item, .dropdown-item'))
        .filter(el => !el.closest('#mttq-auto-overlay') && normT(el) === 'Tin tức')
        .sort((a, b) => (inNewsMenu(a) ? 0 : 1) - (inNewsMenu(b) ? 0 : 1))[0] || null;
      if (!item) {
        item = Array.from(document.querySelectorAll('.dropdown-menu a, .dropdown-menu li, .dropdown-menu span, .dropdown-menu div'))
          .filter(el => !el.closest('#mttq-auto-overlay') && normT(el) === 'Tin tức' && !Array.from(el.children).some(ch => normT(ch) === 'Tin tức'))
          .sort((a, b) => normT(a).length - normT(b).length)[0] || null;
      }
      if (!item) return null;
      const clickEl = item.closest('a, li, button') || item;
      const menu = item.closest('.dropdown-menu');
      const box = (menu && menu.closest('li.dropdown, .dropdown, li')) || item.closest('li.dropdown, .dropdown, li, ul, div');
      let toggle = null;
      if (box) {
        toggle = Array.from(box.querySelectorAll('a, button, span'))
          .filter(el => normT(el) === 'Thêm mới' && !(menu && menu.contains(el)) && !Array.from(el.children).some(ch => normT(ch) === 'Thêm mới'))[0] || null;
      }
      return { box: box, menu: menu, clickEl: clickEl, toggle: toggle };
    };
    // Nút gạt ĐÚNG của menu Thêm mới: phần tử chữ "Thêm mới" nằm trong LI.dropdown (trong
    // cùng là SPAN.ml-5 nằm trong A.btn — bấm vào SPAN, sự kiện nổi lên A vẫn ăn). Trang còn
    // một A.add-new-btn đứng riêng trong UL; findClickable hòa điểm giữa 2 nút nên có lượt
    // chọn nhầm nút đứng riêng, bấm mãi menu không mở (các lượt kẹt 09:38 và 10:28 ngày 16/11,
    // trong khi lượt thành công 10:19 chọn đúng nút trong LI.dropdown).
    const findAddNewToggle = () => {
      const cands = Array.from(document.querySelectorAll('a, button, span, li, div'))
        .filter(el => visible(el) && !el.closest('#mttq-auto-overlay') && normT(el) === 'Thêm mới')
        .filter(el => !Array.from(el.children).some(ch => normT(ch) === 'Thêm mới'));
      const inLi = cands.filter(el => el.closest('li.dropdown'));
      return (inLi[0] || cands[0]) || null;
    };
    let deep = findNewsDeep();
    if (!deep) {
      // Menu CHƯA được cổng dựng vào trang: tab mới mở thì DOM chưa hề có mục Tin tức (log
      // chẩn đoán 10:28 liệt kê 40 dropdown-item mà toàn là menu của từng dòng bài: Gỡ bài,
      // Delete1, Tạo thư viện ảnh...). Phải bấm nút gạt đúng 1 lần để cổng dựng menu, tìm lại.
      const tgl = findAddNewToggle();
      if (tgl) {
        await log('Menu chưa có trong trang — bấm nút gạt đúng để cổng dựng menu: ' + describeEl(tgl));
        realClick(tgl);
        const li = tgl.closest('li.dropdown');
        if (li) {
          const r = li.getBoundingClientRect();
          const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
          li.dispatchEvent(new MouseEvent('mouseover', o));
          li.dispatchEvent(new MouseEvent('mouseenter', o));
          li.dispatchEvent(new MouseEvent('mousemove', o));
        }
        await sleep(1200);
        deep = findNewsDeep();
        if (!deep) { await sleep(1800); deep = findNewsDeep(); }
        if (deep) await log('Cổng đã dựng menu sau cú bấm gạt.');
      }
    }
    if (deep) {
      await log('Khối menu Thêm mới: ' + describeEl(deep.box) + ' | Menu: ' + describeEl(deep.menu) + ' | Nút gạt đúng: ' + describeEl(deep.toggle) + ' | Mục Tin tức: ' + describeEl(deep.clickEl) + (deep.clickEl.getAttribute && deep.clickEl.getAttribute('href') ? ' | href: ' + deep.clickEl.getAttribute('href') : ''));
      const clickAndWait = async (label) => {
        realClick(deep.clickEl);
        const ok = await waitFor(() => formPresent(), 4000, 'form').catch(() => null);
        if (ok) { formOpened = true; await log('Mở được form nhờ: ' + label); }
        return !!ok;
      };
      // A) Bấm nút gạt ĐÚNG trong khối menu (không phải A.add-new-btn đứng riêng) + rà chuột.
      // Chỉ bấm gạt khi mục còn đang ẩn — menu đã mở sẵn mà bấm gạt nữa thì nó lại ĐÓNG
      // (trường hợp vừa bấm gạt ở bước dựng menu phía trên, menu đang mở sẵn rồi).
      const firstBtn = deep.toggle || addBtn;
      if (!visible(deep.clickEl) && firstBtn && firstBtn !== deep.clickEl) realClick(firstBtn);
      [deep.box, deep.toggle].forEach(el => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        el.dispatchEvent(new MouseEvent('mouseover', o));
        el.dispatchEvent(new MouseEvent('mouseenter', o));
        el.dispatchEvent(new MouseEvent('mousemove', o));
      });
      await sleep(800);
      if (visible(deep.clickEl)) await clickAndWait('bấm mục Tin tức sau khi mở menu');
      // B) Ép menu hiện: class open/show vào khối + class show vào dropdown-menu + gỡ ẩn
      if (!formOpened) {
        try {
          if (deep.box) { deep.box.classList.add('open'); deep.box.classList.add('show'); }
          if (deep.menu) { deep.menu.classList.add('show'); deep.menu.style.display = 'block'; deep.menu.style.visibility = 'visible'; deep.menu.style.opacity = '1'; }
          let cur = deep.clickEl;
          while (cur && cur !== deep.box && cur !== document.body) { cur.style.display = 'block'; cur.style.visibility = 'visible'; cur.style.opacity = '1'; cur = cur.parentElement; }
        } catch (e) {}
        await sleep(500);
        await clickAndWait('ép hiện menu rồi bấm mục Tin tức');
      }
      // C) Bấm thẳng vào mục dù còn ẩn + leo lên thẻ cha a/li
      if (!formOpened) {
        try { deep.clickEl.click(); } catch (e) {}
        let anc = deep.clickEl.parentElement, tries = 0;
        while (anc && tries < 3 && !formPresent()) { realClick(anc); anc = anc.parentElement; tries++; await sleep(1200); }
        if (formPresent()) formOpened = true;
      }
    } else {
      // Không tìm thấy mục Tin tức trong DOM — liệt kê các dropdown-item đang có để chẩn đoán
      const ddItems = Array.from(document.querySelectorAll('.dropdown-item')).map(el => normT(el)).filter(Boolean);
      await log('Không thấy mục “Tin tức” (dropdown-item) trong DOM. Các dropdown-item đang có (' + ddItems.length + '): ' + (ddItems.slice(0, 20).join(' | ') || '(không có cái nào)'));
    }
    if (!formOpened) {
      // Dự phòng: cách cũ — bấm nút Thêm mới rồi chờ mục Tin tức MỚI XUẤT HIỆN
      // (tránh bấm nhầm chữ "Tin tức" ở menu điều hướng sẵn có của trang)
      let newsItem = null;
      for (let attempt = 1; attempt <= 2 && !newsItem; attempt++) {
        const before = snapshotVisible();
        realClick((deep && deep.toggle) || findAddNewToggle() || addBtn);
        await sleep(900);
        await log('Sau khi bấm Thêm mới (lần ' + attempt + '), các mục bấm được: ' + dumpVisibleClickables().join(' | '));
        newsItem = await waitFor(() => appearedItem(before, 'Tin tức', 'Tin tức'), 5000, 'mục Tin tức mới xuất hiện (lần ' + attempt + ')').catch(() => null);
        if (!newsItem && attempt === 2) {
          newsItem = findClickable('Tin tức');
          if (!newsItem) { const c = findMenuItemContains('Tin tức'); if (c && normT(c).length <= 40) newsItem = c; }
        }
      }
      if (!newsItem) {
        throw new Error('Không thấy mục Tin tức sau khi bấm Thêm mới (xem các dòng log trên: nút Thêm mới là gì, menu hiện ra gồm những mục nào).');
      }
      await log('Sẽ bấm mục: ' + describeEl(newsItem));
      realClick(newsItem);
      // Nếu bấm vào chữ chưa ăn, bấm tiếp vào thẻ cha chứa nó (li/a/button)
      const ok = await waitFor(() => formPresent() || formReady(), 5000, 'form sau khi bấm Tin tức').catch(() => null);
      if (!ok) {
        let anc = newsItem.parentElement, tries = 0;
        while (anc && tries < 3 && !formPresent()) { realClick(anc); anc = anc.parentElement; tries++; await sleep(1200); }
      }
    }
    const present = await waitFor(formPresent, 12000, 'form Thêm tin tức').catch(() => null);
    if (!present) {
      await log('URL lúc kẹt: ' + location.href + ' | Các mục bấm được: ' + dumpVisibleClickables().join(' | '));
      throw new Error('Đã bấm mục Tin tức nhưng form không hiện (xem 2 dòng log trên để biết trang đang ở đâu và có gì).');
    }
    if (!formReady()) {
      await log('⚠ Thấy ô tiêu đề trong trang nhưng chưa ở trạng thái hiển thị — vẫn thử điền tiếp, theo dõi các bước sau.');
    }
    await log('Đã mở form “Thêm tin tức”.');
  }

  // ---------- các thao tác trên form ----------
  async function ensureCategory(name) {
    const row = fieldRow('Danh mục');
    if (!row) throw new Error('Không thấy trường Danh mục.');
    const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

    const btns = Array.from(row.querySelectorAll('button, [role="combobox"], [role="button"]')).filter(visible);
    const btn = btns.find(b => /chọn|tin|danh mục/i.test(b.textContent || '')) || btns[0] || row;
    const shown = () => (btn.textContent || '').replace(/\s+/g, ' ');
    if (shown().includes(name)) {
      const selInfo = Array.from(document.querySelectorAll('select'))
        .filter(s => Array.from(s.options).some(o => (o.textContent || '').replace(/\s+/g, ' ').trim() === name))
        .map(s => (s.name || s.id || '?') + '=' + (s.value || '(trống)')).join(', ');
      await log('Danh mục đã là: ' + name + (selInfo ? ' | các select chứa mục này đang chọn: ' + selInfo : ''));
      return;
    }
    const container = btn.closest('.smartselect') || btn.closest('.dropdown') || btn.parentElement;
    await log('Nút Danh mục là: ' + describeEl(btn) + ' | khối chứa: ' + (container ? container.tagName + '.' + (typeof container.className === 'string' ? container.className : '') : '?'));

    // Cách 0: đặt qua <select> gốc. Có thể có nhiều select chứa mục này (cả của các khối khác
    // còn sót trong trang) — thử theo thứ tự GẦN ô Danh mục nhất, giữ lại select nào làm nút
    // hiển thị cập nhật; các select đặt thử còn lại sẽ được gỡ để tránh tác dụng phụ.
    const setSelectVal = (s, opt) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(s, opt.value);
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const resetSelect = (s) => { try { s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} };
    const distToBtn = (s) => { let d = 0, cur = btn; while (cur && d < 30) { if (cur.contains(s)) return d; cur = cur.parentElement; d++; } return 99; };
    const allSelects = Array.from(document.querySelectorAll('select'));
    await log('Số <select> trong trang: ' + allSelects.length + (allSelects.length ? ' | ' + allSelects.map(s => (s.name || s.id || '?') + '(' + s.options.length + ' mục)').join(', ') : ''));
    const candidates = allSelects
      .map(s => ({ s: s, opt: Array.from(s.options).find(o => (o.textContent || '').replace(/\s+/g, ' ').trim() === name) }))
      .filter(x => x.opt)
      .sort((a, b) => distToBtn(a.s) - distToBtn(b.s));
    if (candidates.length) {
      const tried = [];
      let winner = null;
      for (const c of candidates) {
        setSelectVal(c.s, c.opt);
        tried.push(c);
        await sleep(600);
        await log('Đặt thử <select> "' + (c.s.name || c.s.id || '?') + '" value="' + c.opt.value + '" (khoảng cách tới ô Danh mục: ' + distToBtn(c.s) + ') — nút hiển thị: "' + shown().trim().slice(0, 50) + '"');
        if (shown().includes(name)) { winner = c; break; }
      }
      if (winner) {
        for (const t of tried) if (t.s !== winner.s) resetSelect(t.s);
        await log('Đã chọn danh mục: ' + name + ' (qua <select> "' + (winner.s.name || winner.s.id) + '").');
        return;
      }
      const keep = candidates[0];
      for (const t of tried) if (t.s !== keep.s) resetSelect(t.s);
      setSelectVal(keep.s, keep.opt);
      await log('⚠ Không select nào làm nút Danh mục cập nhật chữ — giữ select gần nhất "' + (keep.s.name || keep.s.id) + '" (widget thường đọc từ select khi lưu), kiểm chứng sau khi đăng.');
      return;
    }

    const panelOf = () => {
      if (!container) return null;
      const kids = Array.from(container.querySelectorAll('div, ul'));
      return kids.find(el => visible(el) && el !== btn && !btn.contains(el) && el.querySelectorAll('input, li, label').length >= 2) || null;
    };
    const isOpen = () => !!panelOf() || (container && /open|show|active|expanded/i.test(container.className || '')) || btn.getAttribute('aria-expanded') === 'true';
    const findItemIn = (rootEl) => {
      if (!rootEl) return null;
      const els = Array.from(rootEl.querySelectorAll('span, div, li, label, a, td'))
        .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'));
      return els.filter(el => norm(el) === name).sort((a, b) => norm(a).length - norm(b).length)[0]
        || els.filter(el => norm(el).startsWith(name) && norm(el).length <= name.length + 14).sort((a, b) => norm(a).length - norm(b).length)[0]
        || null;
    };

    // Mở panel bằng nhiều cách — dừng ngay khi thấy panel mở
    const openTries = [
      ['bấm nút', async () => { realClick(btn); }],
      ['focus + Enter', async () => { btn.focus(); btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); realClick(btn); }],
      ['bấm khối chứa', async () => { if (container) realClick(container); }],
      ['di chuột vào khối chứa', async () => { if (container) { container.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); } }]
    ];
    let panel = null;
    for (const [label, act] of openTries) {
      if (isOpen()) { panel = panelOf(); break; }
      await act();
      await sleep(900);
      if (isOpen()) { panel = panelOf(); await log('Panel danh mục đã mở bằng cách: ' + label + (panel ? ' | panel: ' + describeEl(panel) : ' | (chưa xác định được phần tử panel)')); break; }
    }
    if (!isOpen()) {
      const struct = container ? Array.from(container.querySelectorAll('*')).slice(0, 40).map(el => el.tagName + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '')).join(' > ') : '(không có khối chứa)';
      await log('Cấu trúc khối Danh mục: ' + struct);
      throw new Error('Không mở được panel danh mục bằng 4 cách (xem dòng cấu trúc ngay trên).');
    }

    const searchRoot = panel || container || document;
    let item = findItemIn(searchRoot) || findItemIn(document);
    if (!item) {
      // Mục có thể bị gấp dưới nút cha trong cây: tìm trong panel kể cả đang ẩn, mở các nút cha bên trong panel
      const anyInPanel = Array.from(searchRoot.querySelectorAll('span, div, li, label, a, td'))
        .filter(el => !el.closest('#mttq-auto-overlay') && norm(el) === name)
        .sort((a, b) => norm(a).length - norm(b).length)[0];
      if (anyInPanel) {
        await log('Mục “' + name + '” có trong panel nhưng đang ẩn — mở các nút cha bên trong panel…');
        let anc = anyInPanel.parentElement, hops = 0;
        while (anc && anc !== searchRoot && hops < 6 && !item) {
          const expander = Array.from(anc.querySelectorAll('[class*="toggle"], [class*="expand"], [class*="caret"], [class*="switcher"], [class*="arrow"], .fa-plus, .fa-chevron-right, .fa-caret-right, .fa-angle-right')).find(visible);
          if (expander) realClick(expander);
          else if (anc.previousElementSibling) realClick(anc.previousElementSibling);
          anc = anc.parentElement; hops++;
          await sleep(350);
          item = findItemIn(searchRoot);
        }
      }
    }
    if (!item) {
      const search = Array.from(searchRoot.querySelectorAll('input')).filter(i => visible(i) && /tìm|search/i.test(i.placeholder || ''))[0]
        || Array.from(document.querySelectorAll('input')).filter(i => visible(i) && /tìm|search/i.test(i.placeholder || ''))[0];
      if (search) {
        await log('Dùng ô tìm kiếm của cây danh mục để lọc “' + name + '”…');
        setVal(search, name);
        await sleep(1000);
        item = findItemIn(searchRoot) || findItemIn(document);
      }
    }
    if (!item) {
      const ptext = searchRoot ? (searchRoot.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      await log('Nội dung panel (300 ký tự đầu): ' + ptext);
      throw new Error('Panel danh mục đã mở nhưng không thấy mục “' + name + '” (xem dòng nội dung panel ngay trên).');
    }
    await log('Sẽ chọn mục: ' + describeEl(item));
    const rowEl = climb(item, x => x.querySelector && !!x.querySelector('input[type="checkbox"]'), 4);
    const cb = rowEl ? rowEl.querySelector('input[type="checkbox"]') : null;
    if (cb) { if (!cb.checked) realClick(cb); } else { realClick(item); }
    await sleep(600);
    const okState = (cb && cb.checked) || shown().includes(name);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await log(okState ? 'Đã chọn danh mục: ' + name : '⚠ Đã bấm chọn “' + name + '” nhưng chưa xác nhận được trạng thái — vẫn tiếp tục, kiểm chứng ở khâu cuối.');
  }

  async function ensureStatusShown() {
    // Ưu tiên select gốc fields[isDisplay] (2 lựa chọn: Ẩn / Hiển thị)
    const sDisplay = document.querySelector('select[name="fields[isDisplay]"]');
    if (sDisplay) {
      const opt = Array.from(sDisplay.options).find(o => (o.textContent || '').includes('Hiển thị'));
      if (opt) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(sDisplay, opt.value);
        sDisplay.dispatchEvent(new Event('change', { bubbles: true }));
        await log('Đã đặt trạng thái “Hiển thị bài viết” qua <select> fields[isDisplay].');
        return;
      }
    }
    const row = fieldRow('Trạng thái');
    if (!row) { await log('⚠ Không thấy trường Trạng thái — bỏ qua.'); return; }
    const ctrl = row.querySelector('input, button, [role="combobox"]') || row;
    const val = () => ((ctrl.value !== undefined ? ctrl.value : ctrl.textContent) || '').replace(/\s+/g, ' ');
    if (val().includes('Hiển thị')) return;
    realClick(ctrl); await sleep(600);
    const opt = await waitFor(() => findClickable('Hiển thị bài viết'), 6000, 'lựa chọn Hiển thị bài viết').catch(() => null);
    if (opt) { realClick(opt); await sleep(300); await log('Đã đặt trạng thái: Hiển thị bài viết.'); }
  }

  async function fillComboNew(label, value, selectName) {
    // Trường combobox "Nhập mới hoặc chọn" (Tác giả / Nguồn):
    // cách 1 — select gốc có sẵn lựa chọn khớp thì đặt luôn;
    // cách 2 — mở combobox, tìm ô nhập trong lớp dropdown vừa hiện, gõ + Enter, chọn mục khớp nếu có.
    try {
      if (!value) return;
      if (selectName) {
        const s = document.querySelector('select[name="' + selectName + '"]');
        if (s) {
          const opt = Array.from(s.options).find(o => (o.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === value.toLowerCase());
          if (opt) {
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
            setter.call(s, opt.value);
            s.dispatchEvent(new Event('change', { bubbles: true }));
            await log('Đã đặt ' + label + ' qua <select> gốc: ' + value);
            return;
          }
        }
      }
      const row = fieldRow(label);
      if (!row) return;
      const ctrl = row.querySelector('input, button, [role="combobox"]') || row;
      const before = snapshotVisible();
      const beforeInputs = new Set(Array.from(document.querySelectorAll('input')).filter(visible));
      realClick(ctrl); await sleep(700);
      // CHỈ lấy ô nhập MỚI XUẤT HIỆN sau khi mở combobox (ô nhập của lớp dropdown).
      // Lỗi v1.7: lấy ô nhập hiển thị đầu tiên ngoài hàng -> vớ phải ô TIÊU ĐỀ ở đầu form,
      // gõ "Báo Lạng Sơn" đè lên tiêu đề bài viết.
      const layerEdit = Array.from(document.querySelectorAll('input'))
        .filter(i => visible(i) && !beforeInputs.has(i) && !row.contains(i) && i.name !== 'fields[title]' && !['hidden', 'file', 'checkbox', 'radio', 'submit', 'button'].includes(i.type))[0];
      const edit = layerEdit || Array.from(row.querySelectorAll('input')).find(i => !i.readOnly);
      if (edit) {
        setVal(edit, value);
        await sleep(400);
        let optEl = appearedItem(before, value, value);
        if (!optEl) { pressEnter(edit); await sleep(700); optEl = appearedItem(before, value, value) || findClickable(value); }
        if (optEl) { realClick(optEl); await log('Đã chọn ' + label + ': ' + value); return; }
        await log('Đã thử nhập mới ' + label + ': “' + value + '” (chưa xác nhận được lựa chọn — kiểm tra sau khi đăng).');
        return;
      }
      await log('⚠ Trường ' + label + ' không cho nhập trực tiếp — để trống, anh bổ sung sau nếu cần.');
    } catch (e) { await log('⚠ Bỏ qua trường ' + label + ' (' + e.message + ')'); }
  }

  async function attachRepresentativeImage(article) {
    if (!article.firstImage) { await log('Bài nguồn không có ảnh — bỏ qua ảnh đại diện.'); return; }
    const resp = await sendMsg({ type: 'FETCH_IMAGE_B64', url: article.firstImage });
    if (!resp || !resp.ok) throw new Error('Không tải được ảnh đại diện từ nguồn (' + (resp && resp.status || 'lỗi mạng') + ').');
    const bytes = Uint8Array.from(atob(resp.b64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: resp.mime || 'image/jpeg' });
    let fname = 'anh-dai-dien.jpg';
    try { fname = decodeURIComponent(new URL(article.firstImage).pathname.split('/').pop()) || fname; } catch (e) {}
    const file = new File([blob], fname, { type: blob.type });

    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!inputs.length) throw new Error('Không thấy ô chọn file cho ảnh đại diện.');
    let target = null, bestLen = Infinity;
    for (const inp of inputs) {
      const anc = climb(inp, el => (el.textContent || '').includes('Ảnh đại diện'), 9);
      if (anc) { const len = (anc.textContent || '').length; if (len < bestLen) { bestLen = len; target = inp; } }
    }
    if (!target) {
      target = inputs.filter(i => { const a = climb(i, el => (el.textContent || '').includes('Danh sách file'), 9); return !a; })[0] || inputs[inputs.length - 1];
      await log('⚠ Không định vị chắc chắn ô Ảnh đại diện — dùng ô file khả nghi nhất.');
    }
    const dt = new DataTransfer();
    dt.items.add(file);
    target.files = dt.files;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    await log('Đã gắn ảnh đại diện (' + fname + ', ' + Math.round(file.size / 1024) + ' KB), chờ hệ thống tải lên…');
    await sleep(3500);
  }

  async function clickPublish() {
    await patchJob({ step: 'published' }); // ghi trước khi bấm — nếu trang nạp lại thì đi thẳng tới bước kiểm chứng
    const btn = await waitFor(() => findClickable('Xuất bản') || findClickable('Lưu'), 8000, 'nút Xuất bản/Lưu');
    await log('Nút đăng là: ' + describeEl(btn));
    realClick(btn);
    await log('Đã bấm “' + (btn.textContent || '').trim() + '”, chờ hệ thống xử lý…');
    // Hộp thoại xác nhận của cổng: "Bạn có chắc chắn muốn xuất bản bài viết?" — nút "Xuất bản" / "Hủy bỏ".
    // Neo theo chính câu hỏi đang HIỂN THỊ rồi leo lên khung chứa để tìm nút "Xuất bản" bên trong.
    // LƯU Ý: không dùng body.textContent để đoán "thành công" — nó chứa cả chữ trong thẻ <script>
    // và các nút ẩn của trang danh sách SPA, làm vòng chờ thoát giả chỉ sau ~3 giây (lỗi v1.5/v1.6:
    // hộp thoại thực ra xuất hiện muộn hơn, sau khi vòng chờ đã thoát).
    const dialogQuestion = () => Array.from(document.querySelectorAll('div, p, span, h2, h3, td'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
      .find(el => (el.textContent || '').includes('Bạn có chắc chắn muốn xuất bản'));
    const findDialogBtn = () => {
      const q = dialogQuestion();
      if (q) {
        let box = q;
        for (let i = 0; i < 7 && box; i++) {
          const btns = Array.from(box.querySelectorAll('a, button, input')).filter(visible);
          const b = btns.find(el => ['Xuất bản', 'Đồng ý', 'Xác nhận', 'OK', 'Có'].includes((el.textContent || el.value || '').replace(/\s+/g, ' ').trim()));
          if (b) return b;
          box = box.parentElement;
        }
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .modal-dialog, .modal-content, .swal2-popup, .bootbox, [class*="modal"], [class*="dialog"]')).filter(visible);
      for (const d of dialogs) {
        if (d.closest('#mttq-auto-overlay')) continue;
        if (!/chắc chắn|muốn xuất bản|xác nhận/i.test(d.textContent || '')) continue;
        const btns = Array.from(d.querySelectorAll('a, button, input')).filter(visible);
        const byText = btns.find(el => ['Xuất bản', 'Đồng ý', 'Xác nhận', 'OK', 'Có'].includes((el.textContent || el.value || '').replace(/\s+/g, ' ').trim()));
        if (byText) return byText;
        const primary = btns.find(el => /btn-primary|btn-info|btn-success/.test(typeof el.className === 'string' ? el.className : ''));
        if (primary) return primary;
      }
      return null;
    };
    const successToast = () => Array.from(document.querySelectorAll('div, span, p'))
      .filter(el => visible(el) && !el.closest('#mttq-auto-overlay'))
      .some(el => /thành công/i.test(el.textContent || '') && (el.textContent || '').length < 200);
    let confirmed = false;
    for (let i = 0; i < 50; i++) { // chờ hộp thoại tối đa ~25 giây
      await sleep(500);
      const db = findDialogBtn();
      if (db) {
        realClick(db);
        await log('Đã bấm xác nhận “' + (db.textContent || db.value || '').replace(/\s+/g, ' ').trim() + '” trong hộp thoại.');
        confirmed = true;
        break;
      }
      if (!dialogQuestion() && successToast()) { await log('Thấy thông báo thành công (không có hộp thoại xác nhận).'); confirmed = true; break; }
      if (!document.querySelector('[name="fields[title]"]')) { await log('Form đã đóng sau khi bấm đăng.'); confirmed = true; break; }
    }
    if (!confirmed) await log('⚠ Chờ 25 giây không thấy hộp thoại xác nhận — chuyển sang kiểm chứng.');
    else {
      for (let i = 0; i < 20 && dialogQuestion(); i++) await sleep(500); // chờ hộp thoại đóng hẳn
      await sleep(1500);
    }
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
  // Kiểm tra trùng phía cổng: TRẠNG THÁI THẬT trên web quyết định — "gõ cửa" đúng địa chỉ bài
  // theo slug (tối đa thêm địa chỉ thật đã ghi trong sổ nếu khác), KHÔNG quét danh sách/chuyên
  // mục. Sổ cục bộ chỉ còn là dự phòng khi không kiểm tra được trạng thái thật (mất mạng...).
  // (v2.24: trước đây sổ ghi trùng là bỏ qua ngay, nên anh xóa bài trên web rồi extension vẫn
  // báo "đã có" — nay link bài không còn nội dung thì hiểu là bài đã bị xóa và cho đăng lại.)
  async function findDuplicateOnPortal(article, category) {
    // Vừa dừng khẩn cấp bài này = anh chủ động muốn đăng lại từ đầu: bỏ qua kiểm tra trùng đúng 1 lần (hạn 24 giờ)
    try {
      const { repostBypass } = await chrome.storage.local.get(['repostBypass']);
      if (repostBypass && normTitle(repostBypass.t) === normTitle(article.title) && Date.now() - (repostBypass.at || 0) < 24 * 3600 * 1000) {
        await chrome.storage.local.remove(['repostBypass']);
        await log('Đăng lại từ đầu theo lệnh dừng khẩn cấp trước đó — lần này bỏ qua kiểm tra trùng.');
        return null;
      }
    } catch (e) {}
    const hit = await historyFind('mttq', article.title);
    const catUrl = CATEGORY_PUBLIC[category];
    if (!catUrl) return hit ? { url: hit.u || '' } : null;
    const slug = window.MTTQParser.slugifyVi(article.title);
    const guess = catUrl + '/' + slug + '.html';
    // Gõ cửa tối đa 2 địa chỉ: link theo slug, rồi link thật đã ghi trong sổ (nếu khác —
    // cổng có thể đã thêm số vào slug khi từng trùng). Bài còn ở 1 trong 2 nơi là còn.
    const urls = [guess];
    if (hit && hit.u && hit.u !== guess) urls.push(hit.u);
    let live = null, liveUrl = ''; // true = bài còn trên web · false = không còn · null = không kiểm tra được
    for (const u of urls) {
      try {
        const r = await sendMsg({ type: 'FETCH_TEXT', url: u, credentials: 'omit' });
        if (r && r.ok && r.text && normTitle(r.text).includes(normTitle(article.title))) { live = true; liveUrl = u; break; }
        if (r && (r.ok || r.status === 404)) live = false; // mở được trang/404 mà không thấy tiêu đề = bài không còn ở địa chỉ này
      } catch (e) {}
    }
    if (live === true) return { url: liveUrl };
    if (live === false) {
      if (hit) { await log('Sổ tay ghi bài này đã đăng, nhưng link bài trên cổng không còn nội dung nữa (có thể anh đã xóa) — sẽ đăng lại.'); await historyRemove('mttq', article.title); }
      return null;
    }
    // Không kiểm tra được trạng thái thật → tin sổ tay cho an toàn (thà bỏ qua còn hơn đăng trùng)
    return hit ? { url: hit.u || '' } : null;
  }

  async function verifyPublic(article, category) {
    const catUrl = CATEGORY_PUBLIC[category];
    if (!catUrl) { await log('Chưa có đường dẫn công khai của chuyên mục “' + category + '” để kiểm chứng — bỏ qua bước này.'); return null; }
    const slug = window.MTTQParser.slugifyVi(article.title);
    for (let i = 0; i < 8; i++) {
      const r = await sendMsg({ type: 'FETCH_TEXT', url: catUrl, credentials: 'omit' });
      if (r && r.ok) {
        const d = new DOMParser().parseFromString(r.text, 'text/html');
        const a = Array.from(d.querySelectorAll('a')).find(x => (x.getAttribute('href') || '').includes(slug));
        if (a) return new URL(a.getAttribute('href'), catUrl).href;
        if (r.text.includes(article.title)) return catUrl;
      }
      await sleep(4000);
    }
    return null;
  }

  // ---------- luồng chính ----------
  async function runJob() {
    if (window.__mttqRunning) return;
    const store = await getStore();
    const job = store.job;
    if (!job || !job.active) return;
    const targets0 = job.targets || { mttq: true };
    if (!targets0.mttq) return; // job này không có đích cổng MTTQ
    if (job.mttqResult) return; // đích MTTQ đã xong — đang chờ đích còn lại (Zalo)
    // Job quá hạn (lượt chạy dở từ lâu, vd tab bị đóng giữa chừng) — hủy để tránh đăng trùng
    if (job.startedAt && Date.now() - job.startedAt > 12 * 60 * 1000) {
      ensureOverlay();
      if (job.fromQueue) {
        // Hàng chờ nhiều bài: chốt luôn kết quả "quá hạn" cho cả 2 đích để background chuyển sang bài kế tiếp, tránh kẹt hàng
        const next = Object.assign({}, job, { active: false, step: 'expired' });
        if (!next.mttqResult) next.mttqResult = { ok: false, reason: 'expired' };
        if (job.targets && job.targets.zalo && !next.zaloResult) next.zaloResult = { ok: false, reason: 'expired' };
        await chrome.storage.local.set({ job: next });
        const stOf = (r) => !r ? 'fail' : r.ok ? 'ok' : r.reason === 'duplicate' ? 'duplicate' : 'fail';
        await sendMsg({ type: 'JOB_DONE', summary: {
          title: (job.article && job.article.title) || 'Bài viết',
          mttq: stOf(next.mttqResult),
          zalo: job.targets && job.targets.zalo ? stOf(next.zaloResult) : null,
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
    // Khóa chạy theo đích: một tab cổng khác vừa nhận job này (nhịp tim còn mới) thì nhường, hẹn kiểm tra lại sau
    const r0 = job.runners && job.runners.mttq;
    if (r0 && r0.id !== RUNNER_ID && r0.at && Date.now() - r0.at < 25000) {
      setTimeout(runJob, 26000);
      return;
    }
    await patchJob({}); // patchJob tự đóng dấu runner của đích mttq
    myJobId = job.jobId || null;
    window.__mttqRunning = true;
    ensureOverlay();
    await replayLog();

    try {
      const onLogin = location.pathname.includes('/login') || (!location.href.includes('/page/') && Array.from(document.querySelectorAll('input[type="password"]')).some(visible) && !!findClickable('Đăng nhập'));
      if (onLogin) {
        if (job.step === 'afterLogin') throw new Error('Đăng nhập không thành công — kiểm tra lại tài khoản/mật khẩu trong trang cài đặt của extension.');
        await doLogin(store.mttqCreds);
        return; // trang sẽ nạp lại, job tự chạy tiếp
      }

      // Đã đăng nhập: bảo đảm đang ở trang danh sách / form
      await openCreateForm();

      // Lấy + đọc bài nguồn
      let article = job.article || null;
      if (!article) {
        await log('Đang đọc bài nguồn: ' + job.url);
        const r = await sendMsg({ type: 'FETCH_TEXT', url: job.url, credentials: 'omit' });
        if (!r || !r.ok) throw new Error('Không tải được bài nguồn (HTTP ' + (r && r.status) + ').');
        article = window.MTTQParser.parseArticle(r.text, job.url);
        await patchJob({ article: article });
        await log('Đã đọc bài: “' + article.title + '” — ' + article.images.length + ' ảnh, tác giả: ' + (article.author || '(trống)'));
      }

      // Chống đăng trùng: bài này đã có trên cổng thì bỏ qua luôn, không điền form nữa
      const dupP = await findDuplicateOnPortal(article, job.category || 'Tin hoạt động');
      if (dupP) {
        await targetDone({ ok: false, reason: 'duplicate', url: dupP.url });
        titleEl.textContent = 'MTTQ – ĐÃ CÓ BÀI NÀY ⏭';
        await log('⏭ Bài này ĐÃ CÓ trên cổng MTTQ' + (dupP.url ? ' (' + dupP.url + ')' : '') + ' — bỏ qua, không đăng lại.');
        return;
      }

      // Điền form
      const titleInput = await waitFor(() => document.querySelector('input[name="fields[title]"]'), 10000, 'ô Tiêu đề');
      setVal(titleInput, article.title);
      await log('Đã điền tiêu đề.');
      await ensureCategory(job.category || 'Tin hoạt động');

      const setRes = await sendMsg({ type: 'SET_EDITORS', summaryHtml: '<p>' + article.summaryText + '</p>', bodyHtml: article.bodyHtml });
      if (setRes && setRes.ok && setRes.result && setRes.result.ck) {
        const rr = setRes.result;
        await log('Đã đổ nội dung vào trình soạn thảo (ảnh trong bài: ' + rr.bodyImgs + '/' + article.images.length + ', chữ: ' + rr.bodyTextLen + ').');
        if (!rr.bodyImgs || rr.bodyTextLen < 50) throw new Error('Nội dung đổ vào trình soạn thảo có vẻ trống/không đủ — dừng lại để tránh đăng bài lỗi.');
      } else {
        // Dự phòng: không thấy CKEditor — thử contenteditable theo thứ tự trong form
        const eds = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible);
        if (eds.length < 2) throw new Error('Không tìm được trình soạn thảo nội dung (không có CKEditor, không đủ ô contenteditable).');
        const setEditable = (el, html) => { el.focus(); const sel = window.getSelection(); sel.selectAllChildren(el); document.execCommand('insertHTML', false, html); };
        setEditable(eds[0], '<p>' + article.summaryText + '</p>');
        setEditable(eds[1], article.bodyHtml);
        await log('Đã đổ nội dung bằng cách dự phòng (contenteditable).');
        if (!eds[1].querySelector('img')) throw new Error('Đổ nội dung dự phòng không có ảnh — dừng lại để tránh đăng bài lỗi.');
      }

      await fillComboNew('Tác giả', article.author, 'fields[author]');
      await fillComboNew('Nguồn', job.url, 'fields[source]'); // ô Nguồn để LINK bài nguồn đã dán (theo ý anh, 15/11)
      await ensureStatusShown();
      // Kiểm tra lại tiêu đề lần cuối trước khi gắn ảnh/đăng: các bước combobox phía trên
      // từng ghi nhầm giá trị vào ô tiêu đề (bản v1.7 tiêu đề bị thành "Báo Lạng Sơn") — lệch là đặt lại ngay.
      const titleNow = document.querySelector('input[name="fields[title]"]');
      if (titleNow && titleNow.value !== article.title) {
        await log('⚠ Tiêu đề đang lệch (“' + titleNow.value + '”) — đặt lại cho đúng bài nguồn.');
        setVal(titleNow, article.title);
      }
      await attachRepresentativeImage(article);

      if (job.step !== 'published') {
        await clickPublish();
      }

      await log('Đang kiểm chứng bài trên trang công khai…');
      const publicUrl = await verifyPublic(article, job.category || 'Tin hoạt động');
      if (publicUrl) {
        await targetDone({ ok: true, url: publicUrl });
        titleEl.textContent = 'MTTQ – ĐÃ ĐĂNG XONG ✔';
        await log('✔ ĐÃ ĐĂNG VÀ HIỆN CÔNG KHAI: ' + publicUrl);
        if ((job.targets || {}).zalo) {
          // Chế độ đăng 2 nơi (v2.14 — theo ý anh): đã kiểm chứng OK ngay trên trang công khai nên
          // KHÔNG mở tab bài viết, tab này giữ nguyên; tab Zalo đã được mở ở bước bàn giao để làm tiếp
          await log('Đăng 2 nơi: cổng đã OK, không mở tab bài viết — chuyển sang Zalo làm tiếp.');
        } else {
          // Đăng riêng cổng: mở bài vừa đăng ở tab mới để anh kiểm tra, tab hiện tại về trang chủ cổng
          try { await sendMsg({ type: 'OPEN_TAB', url: publicUrl }); } catch (e) {}
          await log('Đã mở bài viết ở tab mới để anh kiểm tra; tab này sẽ về trang chủ cổng.');
          await sleep(1200);
          location.href = 'https://mttq.langson.gov.vn/';
        }
      } else {
        await targetDone({ ok: false, reason: 'unverified' });
        await log('Đã bấm đăng nhưng chưa thấy bài trên trang chuyên mục sau khi chờ — anh kiểm tra lại trong Danh sách bài viết giúp em (có thể cổng duyệt chậm hoặc trạng thái chưa bật hiển thị).');
      }
    } catch (e) {
      if (e && e.isStop) {
        // Dừng khẩn cấp: background đã dọn job + xóa lịch sử của bài này — ở đây chỉ báo trên bảng, không ghi kết quả
        ensureOverlay();
        titleEl.textContent = 'MTTQ – ĐÃ DỪNG ⛔';
        if (logEl) logEl.textContent += '· ⛔ ĐÃ DỪNG KHẨN CẤP — việc đã hủy sạch, dán link là đăng lại từ đầu được.\n';
      } else {
        await targetDone({ ok: false, error: String(e && e.message || e) });
        titleEl.textContent = 'MTTQ – GẶP LỖI';
        await log('✖ LỖI: ' + (e && e.message || e));
      }
    } finally {
      window.__mttqRunning = false;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { runJob(); runLoginCheck(); });
  else { runJob(); runLoginCheck(); }
})();

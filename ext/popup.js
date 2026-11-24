const CATEGORIES = [
  'Tin hoạt động', 'Tin tức - Sự kiện', 'Hoạt động MTTQ các xã, phường',
  'Liên đoàn Lao động tỉnh', 'Hoạt động của Công đoàn cơ sở', 'Hội Nông dân tỉnh',
  'Hội Liên hiệp Phụ nữ', 'Hội Cựu chiến binh tỉnh', 'Đoàn TNCS Hồ Chí Minh tỉnh Lạng Sơn',
  'Đoàn TNCS HCM các xã, phường', 'Các tổ chức Hội quần chúng',
  'Học tập và làm theo tư tưởng, đạo đức, phong cách Hồ Chí Minh',
  'Thông tin chuyên ngành', 'Thông tin tổng hợp', 'Chương trình công tác trọng tâm',
  'Lịch công tác', 'Lịch tiếp dân', 'Thông tin dự án, đấu thầu, mua sắm công',
  'Chiến lược định hướng phát triển', 'Thông tin quy hoạch', 'Công khai ngân sách',
  'Báo cáo kinh tế xã hội', 'Công khai tiến độ giải ngân', 'Thông tin tuyển dụng',
  'Thông tin tuyên truyền', 'Tuyên truyền A', 'Tuyên truyền B', 'Tuyên truyền C',
  'Đa phương tiện', 'ĐẠI HỘI ĐẠI BIỂU MTTQ LẠNG SƠN KHOÁ XV',
  'Danh sách Uỷ viên Uỷ ban Mặt trận Tổ quốc Việt Nam tỉnh Lạng Sơn khoá XV, nhiệm kỳ 2024 - 2029'
];
const LIST_URL = 'https://mttq.langson.gov.vn/page/CMS/Article/list';
const ZALO_URL = 'https://oa.nhatkyzalo.vn/manage/content/article/';
const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  try { chrome.action.setBadgeText({ text: '' }); } catch (e) {} // mở popup = đã xem thông báo xong, xóa dấu ✔/! trên biểu tượng
  const sel = $('cat');
  CATEGORIES.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
  sel.value = 'Tin hoạt động';

  // Gợi ý link từ tab hiện tại nếu đang mở bài Báo Lạng Sơn
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && (tab.url.includes('baolangson.vn') || tab.url.includes('daidoanket.vn') || tab.url.includes('dantri.com.vn'))) $('url').value = tab.url;

  const { job, mttqCreds, uiTargets, queue, uiCategory, linkDraft, loginCheckResult, loginCheckShown } = await chrome.storage.local.get(['job', 'mttqCreds', 'uiTargets', 'queue', 'uiCategory', 'linkDraft', 'loginCheckResult', 'loginCheckShown']);
  // Danh sách link đang gom dở được lưu tạm tự động: đóng popup đi cop tiếp rồi mở lại vẫn còn nguyên.
  // Có bản nháp thì nó thắng gợi ý link từ tab hiện tại. Bấm "Đăng bài ngay" xong thì xóa nháp.
  if (linkDraft && linkDraft.trim()) $('url').value = linkDraft;
  let draftTimer = null;
  $('url').addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { try { chrome.storage.local.set({ linkDraft: $('url').value }); } catch (e) {} }, 300);
  });
  $('logBtn').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('log.html') });
  if (uiCategory && CATEGORIES.includes(uiCategory)) sel.value = uiCategory; // nhớ chuyên mục lần trước (cũng là mặc định cho lệnh đăng từ xa qua bot)
  sel.onchange = () => chrome.storage.local.set({ uiCategory: sel.value });
  if (uiTargets) { $('tMttq').checked = !!uiTargets.mttq; $('tZalo').checked = !!uiTargets.zalo; }
  const saveTargets = () => chrome.storage.local.set({ uiTargets: { mttq: $('tMttq').checked, zalo: $('tZalo').checked } });
  $('tMttq').onchange = saveTargets;
  $('tZalo').onchange = saveTargets;

  if (!mttqCreds) $('status').textContent = '⚠ Chưa lưu tài khoản đăng nhập cổng. Bấm “Cài đặt tài khoản đăng nhập” ở dưới để nhập 1 lần (nếu cổng đang còn phiên đăng nhập thì chưa cần).';
  else if (queue && queue.active) { $('status').textContent = 'Hàng chờ nhiều bài: đang xử lý bài ' + ((queue.idx || 0) + 1) + '/' + queue.items.length + ' — các bài chạy lần lượt, xong hết sẽ có 1 thông báo tổng. Bấm nút đỏ ở dưới nếu muốn dừng cả hàng.'; $('stop').style.display = 'block'; }
  else if (job && job.active) { $('status').textContent = 'Đang có 1 việc đăng bài đang chạy… Cần dừng thì bấm nút đỏ ở dưới: dừng ngay, xóa lịch sử của bài này để đăng lại từ đầu.'; $('stop').style.display = 'block'; }
  else if (loginCheckResult && loginCheckResult.at && Date.now() - loginCheckResult.at < 15 * 60 * 1000 && loginCheckShown !== loginCheckResult.id) { $('status').textContent = (loginCheckResult.ok ? '✔ ' : '✖ ') + loginCheckResult.detail; chrome.storage.local.set({ loginCheckShown: loginCheckResult.id }); }
  else if (queue && queue.results && queue.results.length) { const okN = queue.results.filter(r => r && (!r.mttq || r.mttq === 'ok' || r.mttq === 'duplicate') && (!r.zalo || r.zalo === 'ok' || r.zalo === 'duplicate')).length; $('status').textContent = 'Hàng chờ gần nhất: ' + okN + '/' + queue.items.length + ' bài đạt (chi tiết từng bài ở thông báo tổng lúc đăng xong).'; }
  else if (job && (job.mttqResult || job.zaloResult)) {
    const parts = [];
    if (job.mttqResult) parts.push('Cổng MTTQ: ' + (job.mttqResult.ok ? '✔ ' + (job.mttqResult.url || '') : '✖ ' + (job.mttqResult.error || job.mttqResult.reason || '')));
    if (job.zaloResult) parts.push('Zalo OA: ' + (job.zaloResult.ok ? '✔ đã đăng' : '✖ ' + (job.zaloResult.error || job.zaloResult.reason || '')));
    $('status').textContent = 'Lần đăng gần nhất — ' + parts.join(' · ');
  }
  else if (job && job.resultUrl) $('status').textContent = 'Bài gần nhất đã đăng: ' + job.resultUrl;
  else if (job && job.error) $('status').textContent = 'Lần chạy gần nhất lỗi: ' + job.error;

  // Nút "cho đăng lại": hiện khi lần đăng gần nhất có nơi bị chống trùng bỏ qua.
  // Dùng khi anh đã xóa bài ở nơi đăng mà extension vẫn ghi trùng (vd bài cũ đã trôi khỏi
  // trang 1 Zalo nên nó không tự nhận ra) — bấm nút này để gỡ ghi trùng + miễn kiểm tra 1 lần.
  const dupTitle = job && job.article && job.article.title;
  const dupHit = job && !job.active && ((job.mttqResult && job.mttqResult.reason === 'duplicate') || (job.zaloResult && job.zaloResult.reason === 'duplicate'));
  if (dupTitle && dupHit) {
    const rb = $('repost');
    rb.style.display = 'block';
    rb.textContent = '↩ Bài “' + (dupTitle.length > 42 ? dupTitle.slice(0, 42) + '…' : dupTitle) + '” bị báo trùng — cho đăng lại';
    rb.onclick = async () => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const { postedHistory } = await chrome.storage.local.get(['postedHistory']);
      await chrome.storage.local.set({
        postedHistory: (postedHistory || []).filter(h => norm(h.t) !== norm(dupTitle)),
        repostBypass: { t: dupTitle, at: Date.now() }
      });
      if (job.url) $('url').value = job.url;
      $('status').textContent = 'Đã gỡ ghi trùng cho bài này và điền sẵn link — chọn nơi đăng rồi bấm “Đăng bài ngay” để đăng lại.';
      rb.style.display = 'none';
    };
  }

  // Nút "Kiểm tra đăng nhập cổng" (v2.33): ghi cờ loginCheck + mở tab cổng; script trên tab
  // cổng tự kiểm tra phiên, hết phiên thì đăng nhập lại bằng tài khoản đã lưu, kết quả trả về
  // qua loginCheckResult. Popup thường bị đóng khi tab cổng được kích hoạt — kết quả vẫn lưu
  // trong máy, mở lại popup là thấy (nhánh hiển thị loginCheckResult ở trên).
  $('loginCheck').onclick = async () => {
    const st = await chrome.storage.local.get(['job', 'queue']);
    if ((st.job && st.job.active) || (st.queue && st.queue.active)) { $('status').textContent = 'Đang có việc đăng bài chạy — chờ việc đó xong rồi hẵng kiểm tra đăng nhập anh nhé.'; return; }
    const id = 'lc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await chrome.storage.local.remove(['loginCheckResult']);
    await chrome.storage.local.set({ loginCheck: { id: id, at: Date.now() } });
    $('loginCheck').disabled = true;
    $('status').textContent = 'Đang kiểm tra phiên đăng nhập cổng… extension mở tab cổng để kiểm tra, hết phiên là tự đăng nhập lại. Có kết quả em hiện ngay ở đây.';
    const tabs = await chrome.tabs.query({ url: 'https://mttq.langson.gov.vn/*' });
    if (tabs.length) await chrome.tabs.update(tabs[0].id, { url: LIST_URL });
    else await chrome.tabs.create({ url: LIST_URL, active: false });
    const t0 = Date.now();
    const timer = setInterval(async () => {
      const got = await chrome.storage.local.get(['loginCheckResult']);
      const r = got.loginCheckResult;
      if (r && r.id === id) {
        clearInterval(timer);
        $('status').textContent = (r.ok ? '✔ ' : '✖ ') + r.detail;
        $('loginCheck').disabled = false;
        chrome.storage.local.set({ loginCheckShown: id });
      } else if (Date.now() - t0 > 90000) {
        clearInterval(timer);
        $('status').textContent = 'Chưa thấy tab cổng trả kết quả kiểm tra — anh mở tab cổng xem bảng tiến trình giúp em, hoặc bấm kiểm tra lại.';
        $('loginCheck').disabled = false;
      }
    }, 1000);
  };

  // ---------- Kiểm tra link trước khi đăng (v2.39) ----------
  // Dán link là extension tự tải thử bài nguồn (qua FETCH_TEXT của background, KHÔNG mở tab),
  // đọc bằng chính bộ parser dùng lúc đăng, rồi hiện ngay dưới ô link: tiêu đề, tác giả, số ảnh,
  // cờ "đã đăng" theo sổ cục bộ postedHistory cho từng nơi, và các cảnh báo (link chết, nguồn lạ,
  // bài không ảnh, tiêu đề/trích dẫn quá giới hạn của Zalo). Thuần xem trước — không chặn nút Đăng.
  const lcBox = $('linkCheck');
  const lcCache = {}; // url -> {state:'loading'|'done'|'error', ...}
  let lcTimer = null;
  const lcNorm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  function lcSourceName(url) {
    if (/baolangson\.vn/i.test(url)) return 'Báo Lạng Sơn';
    if (/daidoanket\.vn/i.test(url)) return 'Báo Đại Đoàn Kết';
    if (/dantri\.com\.vn/i.test(url)) return 'Báo Dân Trí';
    return '';
  }
  function lcLinks() {
    return Array.from(new Set($('url').value.split(/\s+/).map(x => x.trim()).filter(x => /^https?:\/\//.test(x))));
  }
  function lcEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function lcDate(ts) {
    const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function lcRender() {
    lcBox.textContent = '';
    lcLinks().forEach((url, i) => {
      const c = lcCache[url];
      const item = lcEl('div', 'lc-item');
      if (!c || c.state === 'loading') {
        item.appendChild(lcEl('div', '', (i + 1) + '. ⏳ Đang kiểm tra link…'));
        item.appendChild(lcEl('div', 'lc-meta', url));
      } else if (c.state === 'error') {
        item.className += ' err';
        item.appendChild(lcEl('div', 'lc-err', (i + 1) + '. ✖ ' + c.msg));
        item.appendChild(lcEl('div', 'lc-meta', url));
        const rt = lcEl('span', 'lc-retry', 'kiểm tra lại');
        rt.onclick = () => { delete lcCache[url]; lcRun(); };
        item.appendChild(rt);
      } else if (c.foreign) {
        item.className += ' warn';
        item.appendChild(lcEl('div', '', (i + 1) + '. ⚠ Nguồn lạ — extension mới đọc tốt 3 báo: Lạng Sơn, Đại Đoàn Kết, Dân Trí.'));
        item.appendChild(lcEl('div', 'lc-meta', url));
      } else {
        item.className += (c.warns.length ? ' warn' : ' ok');
        item.appendChild(lcEl('div', 'lc-title', (i + 1) + '. ' + c.title));
        item.appendChild(lcEl('div', 'lc-meta', c.src + (c.author ? ' • Tác giả: ' + c.author : '') + ' • ' + c.nImg + ' ảnh'));
        const badges = lcEl('div', 'lc-badges');
        [['Cổng', c.mttq], ['Zalo', c.zalo]].forEach(([name, h]) => {
          const b = lcEl('span', 'lc-badge' + (h ? ' posted' : ''), name + ': ' + (h ? '✔ đã đăng ' + lcDate(h.at) : 'chưa đăng'));
          if (h && h.u) { const a = lcEl('a', '', ' (mở bài)'); a.href = h.u; a.target = '_blank'; b.appendChild(a); }
          badges.appendChild(b);
        });
        item.appendChild(badges);
        if (c.mttq && c.zalo) item.appendChild(lcEl('div', 'lc-warn', '⚠ Bài này đã đăng cả 2 nơi — đăng nữa sẽ bị chống trùng bỏ qua.'));
        c.warns.forEach(w => item.appendChild(lcEl('div', 'lc-warn', '⚠ ' + w)));
      }
      lcBox.appendChild(item);
    });
  }
  async function lcCheck(url) {
    if (!lcSourceName(url)) { lcCache[url] = { state: 'done', foreign: true }; lcRender(); return; }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'FETCH_TEXT', url: url, credentials: 'omit' });
      if (!r || !r.ok) { lcCache[url] = { state: 'error', msg: 'Không tải được bài (HTTP ' + (r ? r.status : '?') + ') — link chết, sai link hoặc trang báo đang chặn.' }; lcRender(); return; }
      let art = null;
      try { art = window.MTTQParser.parseArticle(r.text, url); } catch (e) {}
      if (!art || !art.title) { lcCache[url] = { state: 'error', msg: 'Tải được trang nhưng không đọc ra bài — có thể trang đã đổi cấu trúc.' }; lcRender(); return; }
      const { postedHistory } = await chrome.storage.local.get(['postedHistory']);
      const hist = postedHistory || [];
      const find = (g) => hist.find(h => h.g === g && lcNorm(h.t) === lcNorm(art.title)) || null;
      const warns = [];
      if (!art.images || !art.images.length) warns.push('Bài không có ảnh nào.');
      if ((art.title || '').length > 150) warns.push('Tiêu đề dài ' + art.title.length + ' ký tự — quá giới hạn 150 của Zalo OA.');
      if ((art.summaryText || '').length > 300) warns.push('Trích dẫn dài ' + art.summaryText.length + ' ký tự — Zalo OA giới hạn 300, khi đăng sẽ bị cắt bớt.');
      if (!art.author) warns.push('Không thấy tên tác giả trong bài.');
      lcCache[url] = { state: 'done', src: lcSourceName(url), title: art.title, author: art.author || '', nImg: (art.images || []).length, mttq: find('mttq'), zalo: find('zalo'), warns: warns };
    } catch (e) {
      lcCache[url] = { state: 'error', msg: 'Có lỗi khi kiểm tra link này — bấm kiểm tra lại.' };
    }
    lcRender();
  }
  function lcRun() {
    lcLinks().forEach(u => { if (!lcCache[u]) { lcCache[u] = { state: 'loading' }; lcCheck(u); } });
    lcRender();
  }
  $('url').addEventListener('input', () => { clearTimeout(lcTimer); lcTimer = setTimeout(lcRun, 700); });
  lcRun(); // mở popup là kiểm tra luôn các link đang có sẵn (từ bản nháp hoặc tab hiện tại)

  // ---------- Radar bài mới + quét từ khóa (v2.42) ----------
  // background quét trang chủ 3 báo mỗi 15 phút; bài mới trúng từ khóa nằm trong radarHits.
  // Mỗi bài: "Đăng bài này" = điền link vào ô rồi bấm nút Đăng hộ (đang có việc chạy thì chỉ
  // điền sẵn, không chen ngang), "Mở bài" xem trước, "Bỏ qua" xóa khỏi danh sách.
  const rdHitsBox = $('radarHits'), rdMeta = $('radarMeta');
  function rdTime(ts) {
    const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  async function rdRender() {
    const { radarHits, radarLast, radarCfg } = await chrome.storage.local.get(['radarHits', 'radarLast', 'radarCfg']);
    const hits = radarHits || [];
    if (radarCfg && radarCfg.enabled === false) rdMeta.textContent = 'Radar đang TẮT — bật lại trong Cài đặt (mục Radar bài mới).';
    else if (radarLast) rdMeta.textContent = 'Quét gần nhất ' + rdTime(radarLast.at) + ': ' + radarLast.found + ' link, ' + radarLast.fresh + ' bài mới, ' + radarLast.matched + ' trúng từ khóa.';
    else rdMeta.textContent = 'Radar chưa quét lần nào — bấm “Quét ngay”. Lần đầu chỉ ghi mốc, chưa báo bài.';
    rdHitsBox.textContent = '';
    if (!hits.length) { rdHitsBox.appendChild(lcEl('div', 'lc-meta', 'Chưa có bài nào trúng từ khóa.')); return; }
    hits.slice(0, 8).forEach(h => {
      const item = lcEl('div', 'lc-item ok');
      item.appendChild(lcEl('div', 'lc-title', h.title));
      item.appendChild(lcEl('div', 'lc-meta', h.source + ' • ' + rdTime(h.at) + ((h.kw && h.kw.length) ? ' • từ khóa: ' + h.kw.join(', ') : '')));
      const row = lcEl('div', 'lc-badges');
      const post = lcEl('a', '', 'Đăng bài này');
      post.style.fontWeight = 'bold';
      post.onclick = async () => {
        $('url').value = h.url;
        try { chrome.storage.local.set({ linkDraft: h.url }); } catch (e) {}
        lcRun();
        const st = await chrome.storage.local.get(['job', 'queue']);
        if ((st.job && st.job.active) || (st.queue && st.queue.active)) {
          $('status').textContent = 'Đã điền link bài radar vào ô — đang có việc đăng chạy, chờ xong rồi bấm “Đăng bài ngay” anh nhé.';
          return;
        }
        $('go').click();
      };
      const open = lcEl('a', '', 'Mở bài');
      open.href = h.url; open.target = '_blank';
      const del = lcEl('a', '', 'Bỏ qua');
      del.onclick = async () => {
        const cur = (await chrome.storage.local.get(['radarHits'])).radarHits || [];
        await chrome.storage.local.set({ radarHits: cur.filter(x => x.url !== h.url) });
        rdRender();
      };
      row.appendChild(post);
      row.appendChild(document.createTextNode(' · '));
      row.appendChild(open);
      row.appendChild(document.createTextNode(' · '));
      row.appendChild(del);
      item.appendChild(row);
      rdHitsBox.appendChild(item);
    });
    if (hits.length > 8) rdHitsBox.appendChild(lcEl('div', 'lc-meta', '… và ' + (hits.length - 8) + ' bài nữa (lưu tối đa 50 bài gần nhất).'));
  }
  $('radarScan').onclick = async () => {
    rdMeta.textContent = 'Đang quét 3 báo…';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'RADAR_SCAN_NOW' });
      if (r && r.summary && r.summary.seeded) $('status').textContent = 'Radar vừa ghi nhận các bài hiện có làm mốc — từ lần quét sau mới báo bài mới.';
    } catch (e) {}
    rdRender();
  };
  $('radarClear').onclick = async () => { await chrome.storage.local.set({ radarHits: [] }); rdRender(); };
  rdRender();

  $('stop').onclick = async () => {
    $('stop').disabled = true;
    try { await chrome.runtime.sendMessage({ type: 'EMERGENCY_STOP' }); } catch (e) {}
    $('status').textContent = '⛔ Đã dừng khẩn cấp và xóa lịch sử của bài đang đăng — dán link là đăng lại từ đầu được ngay.';
    $('stop').style.display = 'none';
    $('stop').disabled = false;
  };

  $('opts').onclick = () => chrome.runtime.openOptionsPage();
  $('openPortal').onclick = () => chrome.tabs.create({ url: LIST_URL });

  $('go').onclick = async () => {
    const raw = $('url').value.trim();
    const category = sel.value;
    const targets = { mttq: $('tMttq').checked, zalo: $('tZalo').checked };
    const items = Array.from(new Set(raw.split(/\s+/).map(x => x.trim()).filter(x => /^https?:\/\//.test(x))));
    if (!items.length) { $('status').textContent = 'Hãy dán ít nhất 1 link bài hợp lệ (bắt đầu bằng https://).'; return; }
    if (!targets.mttq && !targets.zalo) { $('status').textContent = 'Hãy chọn ít nhất 1 nơi đăng (Cổng MTTQ hoặc Zalo OA).'; return; }
    if (items.some(u => !u.includes('baolangson.vn') && !u.includes('daidoanket.vn') && !u.includes('dantri.com.vn'))) $('status').textContent = 'Lưu ý: bản này đọc tốt nhất bài từ baolangson.vn, daidoanket.vn và dantri.com.vn — vẫn thử với các link đã dán.';
    $('go').disabled = true;
    const jobId = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    if (items.length > 1) {
      // Đăng nhiều bài: lập hàng chờ, bài đầu chạy ngay; các bài sau do background chuyển tiếp, cuối buổi 1 thông báo tổng
      await chrome.storage.local.set({ jobStop: 0,
        queue: { active: true, items: items, idx: 0, targets: targets, category: category, results: [], jobId: jobId, startedAt: Date.now() },
        job: { active: true, step: 'start', url: items[0], category: category, targets: targets, startedAt: Date.now(), log: [], fromQueue: true, jobId: jobId } });
    } else {
      await chrome.storage.local.remove(['queue']);
      await chrome.storage.local.set({ jobStop: 0, job: { active: true, step: 'start', url: items[0], category: category, targets: targets, startedAt: Date.now(), log: [], jobId: jobId } });
    }
    await chrome.storage.local.remove(['linkDraft']); // danh sách đã vào hàng chờ — xóa bản nháp để lần gom sau bắt đầu sạch
    // Mở/điều hướng tab đích ở chế độ NỀN (v2.34): không kích hoạt tab, không kéo Chrome lên
    // trước — việc đăng chạy ngầm, người dùng cứ làm việc khác; tiến trình xem ở popup/thông báo.
    if (targets.mttq) {
      const tabs = await chrome.tabs.query({ url: 'https://mttq.langson.gov.vn/*' });
      if (tabs.length) {
        await chrome.tabs.update(tabs[0].id, { url: LIST_URL });
      } else {
        await chrome.tabs.create({ url: LIST_URL, active: false });
      }
    }
    if (targets.zalo) {
      const ztabs = await chrome.tabs.query({ url: 'https://oa.nhatkyzalo.vn/*' });
      if (ztabs.length) {
        await chrome.tabs.update(ztabs[0].id, { url: ZALO_URL });
      } else {
        await chrome.tabs.create({ url: ZALO_URL, active: false });
      }
    }
    $('status').textContent = items.length > 1 ? 'Đã xếp hàng ' + items.length + ' bài — chạy lần lượt từng bài, xong hết sẽ có 1 thông báo tổng. Xem tiến trình ở bảng góc phải trên các tab đích.' : 'Đã bắt đầu! Xem bảng tiến trình ở góc phải trên tab của từng nơi đăng.';
    $('go').disabled = false;
  };
});

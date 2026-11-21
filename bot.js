'use strict';
/*
 * Bot Báo việc MTTQ — bot Zalo ghi việc trong nhóm / chat riêng và nhắc hạn theo giờ hành chính.
 * v3.6: TỰ CẬP NHẬT — bot tự kiểm tra bản mới trên kho GitHub của chủ bot (version.json),
 * tự tải + kiểm tra mã băm từng file, sao lưu bản cũ, nhờ updater.js thay file và khởi động
 * lại; bản mới lỗi lúc khởi động thì tự quay về bản cũ và nhắn báo. Lệnh: "bot, phiên bản",
 * "bot, kiểm tra cập nhật". v3.5: việc lặp định kỳ + trực ban Chrome. v3.3: bản tin sáng 07:45.
 *
 * Nền tảng: Zalo Bot Platform (Bot Creator). Nhận tin bằng long polling (getUpdates),
 * gửi tin bằng sendMessage — không cần tên miền hay cổng công khai.
 *
 * Chạy:  BOT_TOKEN='123456789:abc-xyz' node bot.js
 * Dữ liệu: ./data/tasks.json (việc theo từng chat) + ./data/state.json (offset getUpdates).
 *
 * Trong nhóm Zalo, nền tảng chỉ chuyển cho bot các tin: (1) @nhắc tên bot, (2) trả lời (quote)
 * một tin của bot — đúng với cách dùng "gọi bot" trong nhóm. Chat riêng: mọi tin đều tới bot.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOT_VERSION = '3.6.0';

// ============================== CẤU HÌNH ==============================
const CONFIG = {
  // Giờ hành chính: Thứ 2–Thứ 6, sáng 07:30–11:30, chiều 13:30–17:30.
  // Muốn đổi giờ của cơ quan thì sửa ở đây (định dạng [giờ, phút]).
  officeDays: [1, 2, 3, 4, 5], // 0=Chủ nhật … 6=Thứ 7 (theo Date.getDay())
  officeSessions: [[[7, 30], [11, 30]], [[13, 30], [17, 30]]],
  briefingTime: [7, 45], // Bản tin sáng (v3.3): thứ 2–6 lúc 07:45 gửi việc đến hạn hôm nay + quá hạn.
  // Trực ban Chrome (v3.5): lệnh đăng bài chờ quá lâu mà extension không ghé cầu nối thì bot tự xử.
  watchdogStaleMs: 3 * 60 * 1000,   // lệnh chờ >3 phút + extension vắng >3 phút → coi như Chrome đang tắt/ngủ
  watchdogRelaunchMs: 10 * 60 * 1000, // tối thiểu 10 phút giữa 2 lần tự mở Chrome
  watchdogWarnMs: 10 * 60 * 1000,   // lệnh chờ >10 phút vẫn không ai nhận → nhắn cảnh báo vào chat đã ra lệnh (1 lần/lệnh)
  // Tự cập nhật (v3.6): kho GitHub công khai chứa version.json + các file chương trình.
  // Mã nguồn trên kho KHÔNG chứa token/khóa (chúng nằm ở file riêng trên máy này).
  // Biến môi trường BOT_UPDATE_MANIFEST / BOT_UPDATE_BASE cho phép trỏ sang nguồn khác khi kiểm thử.
  updateManifestUrl: process.env.BOT_UPDATE_MANIFEST || 'https://raw.githubusercontent.com/duongtrungviet91ls/bot-ghi-viec/main/version.json',
  updateFilesBase: process.env.BOT_UPDATE_BASE || 'https://raw.githubusercontent.com/duongtrungviet91ls/bot-ghi-viec/main/',
  updateCheckMs: 6 * 60 * 60 * 1000, // 6 giờ tự kiểm tra bản mới 1 lần (và ngay khi khởi động)
  updateOkDelayMs: Number(process.env.BOT_UPDATE_OK_DELAY_MS || 60000), // chạy ổn đủ lâu thì coi như cập nhật thành công
  defaultDueTime: [17, 0],      // Không nói giờ → hạn lúc 17:00 ngày hạn
  pollTimeoutSec: 20,
  reminderTickMs: 60 * 1000,
  dataDir: path.join(__dirname, 'data'),
  // Lớp AI (Gemini) — hiểu câu nói tự nhiên. Tắt khi không có khóa (ai-key.txt / GEMINI_API_KEY).
  // Danh sách model thử lần lượt: model nào bị Google cho nghỉ hưu (lỗi 404) thì tự nhảy sang model kế tiếp.
  // Thứ tự ưu tiên: bản Lite lên đầu — nó KHÔNG "suy nghĩ" mặc định, sinh ra cho việc trích xuất/phân loại
  // nên trả lời trong 1–3 giây; bản Flash thường thông minh hơn nhưng mặc định bật suy nghĩ mức trung bình
  // (có câu nghĩ quá 30 giây) nên để dự phòng và bị giới hạn token suy nghĩ cho nhanh.
  aiModels: [
    { id: 'gemini-3.5-flash-lite' },
    { id: 'gemini-3.8-flash', thinkingBudget: 256 },
    { id: 'gemini-3.6-flash', thinkingBudget: 256 },
  ],
  aiTimeoutMs: 30000,
  searchTimeoutMs: 9000,   // chờ tối đa cho 1 lần tìm web / đọc trang ở chế độ thư ký
  historyMax: 12,          // số lượt hội thoại thư ký ghi nhớ cho mỗi chat (để hiểu câu hỏi tiếp nối)
  bridgePort: 8791,        // cổng cầu nối ngay trên máy này để extension Chrome lấy lệnh đăng bài (chỉ nghe 127.0.0.1)
};

// ============================== TIỆN ÍCH CHỮ ==============================
// Gấp tiếng Việt về không dấu, GIỮ NGUYÊN độ dài chuỗi (để cắt chuỗi gốc theo vị trí tìm được).
function foldVN(s) {
  const map = {
    'àáảãạăằắẳẵặâầấẩẫậ': 'a', 'èéẻẽẹêềếểễệ': 'e', 'ìíỉĩị': 'i',
    'òóỏõọôồốổỗộơờớởỡợ': 'o', 'ùúủũụưừứửữự': 'u', 'ỳýỷỹỵ': 'y', 'đ': 'd',
  };
  let out = s.toLowerCase();
  for (const chars in map) for (const ch of chars) out = out.split(ch).join(map[chars]);
  return out;
}
const pad = (n) => String(n).padStart(2, '0');
function fmtDT(d) {
  const days = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
  return `${days[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function atTime(base, [h, m]) { const d = new Date(base); d.setHours(h, m, 0, 0); return d; }
function addDays(base, n) { const d = new Date(base); d.setDate(d.getDate() + n); return d; }

// ============================== GIỜ HÀNH CHÍNH ==============================
function isOffice(dt) {
  if (!CONFIG.officeDays.includes(dt.getDay())) return false;
  const mins = dt.getHours() * 60 + dt.getMinutes();
  return CONFIG.officeSessions.some(([[h1, m1], [h2, m2]]) => mins >= h1 * 60 + m1 && mins <= h2 * 60 + m2);
}
// Thời điểm trong giờ hành chính gần nhất NHỎ HƠN HOẶC BẰNG dt (nếu dt đang trong giờ thì là chính dt).
function prevOfficeTime(dt) {
  for (let back = 0; back < 10; back++) {
    const day = atTime(addDays(dt, -back), [0, 0]);
    if (!CONFIG.officeDays.includes(day.getDay())) continue;
    for (const [start, end] of [...CONFIG.officeSessions].reverse()) {
      const sessStart = atTime(day, start), sessEnd = atTime(day, end);
      if (+dt >= +sessEnd) return sessEnd;          // buổi đã kết thúc → cuối buổi là mốc gần nhất
      if (+dt >= +sessStart) return new Date(dt);   // đang trong buổi → chính dt
    }
  }
  return new Date(dt);
}
// Thời điểm trong giờ hành chính gần nhất LỚN HƠN HOẶC BẰNG dt.
function nextOfficeTime(dt) {
  let d = new Date(dt);
  for (let i = 0; i < 10; i++) {
    if (CONFIG.officeDays.includes(d.getDay())) {
      const mins = d.getHours() * 60 + d.getMinutes();
      for (const [[h1, m1], [h2, m2]] of CONFIG.officeSessions) {
        if (mins < h1 * 60 + m1) return atTime(d, [h1, m1]);
        if (mins < h2 * 60 + m2) return new Date(d);
      }
    }
    d = atTime(addDays(d, 1), [0, 0]);
  }
  return new Date(dt);
}
// Lập các mốc nhắc cho một hạn: 24 giờ trước, sáng ngày đến hạn (07:45), 1 giờ trước.
// Mọi mốc đều được kéo về giờ hành chính và phải nằm TRƯỚC hạn.
function planReminders(due, now) {
  const dueDayStart = atTime(due, [0, 0]);
  const raw = [new Date(+due - 24 * 3600 * 1000), atTime(dueDayStart, [7, 45]), new Date(+due - 3600 * 1000)];
  const out = [];
  for (let t of raw) {
    if (!isOffice(t)) t = prevOfficeTime(t);
    if (+t >= +due) t = prevOfficeTime(new Date(+due - 60 * 1000));
    if (+t > +now && +t < +due && !out.some((x) => +x === +t)) out.push(t);
  }
  if (!out.length) { // Việc tạo sát hạn: nhắc ngay khi tới giờ hành chính gần nhất (hoặc ngay nếu còn kịp)
    const t = isOffice(now) ? new Date(now) : nextOfficeTime(now);
    if (+t < +due) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

// ============================== PHÂN TÍCH HẠN (tiếng Việt) ==============================
// Trả về { due: Date, start, end } — đoạn [start,end) trong chuỗi ĐÃ GẤP là phần diễn tả hạn, hoặc null.
function parseDeadline(folded, now) {
  let m;
  // Giờ cụ thể: 14h, 14h30, 14:30
  let time = null;
  const tm = folded.match(/(\d{1,2})\s*h\s*(\d{2})?|(\d{1,2}):(\d{2})/);
  if (tm) time = [parseInt(tm[1] || tm[3], 10), parseInt(tm[2] || tm[4] || '0', 10)];

  // "X phút nữa" / "sau X phút" — hạn tương đối theo phút (cho kiểu nhắc nhanh)
  if ((m = folded.match(/(\d+)\s*phut\s*nua/)) || (m = folded.match(/sau\s*(\d+)\s*phut/))) {
    return { due: new Date(+now + parseInt(m[1], 10) * 60 * 1000), start: m.index, end: m.index + m[0].length };
  }
  // "sau X giờ"
  if ((m = folded.match(/sau\s*(\d+)\s*gio/))) {
    return { due: new Date(+now + parseInt(m[1], 10) * 3600 * 1000), start: m.index, end: m.index + m[0].length };
  }

  const sessionTime = () => {
    if (/\b(sang|trua)\b/.test(folded)) return [11, 30];
    if (/\bchieu\b/.test(folded)) return [17, 0];
    return null;
  };
  const pickTime = () => time || sessionTime() || CONFIG.defaultDueTime;

  // "X giờ nữa" — hạn tương đối theo giờ
  if ((m = folded.match(/(\d+)\s*gio\s*nua/))) {
    return { due: new Date(+now + parseInt(m[1], 10) * 3600 * 1000), start: m.index, end: m.index + m[0].length };
  }
  // Ngày cụ thể: 25/11 hoặc 25/11/2026
  if ((m = folded.match(/(\d{1,2})\/(\d{1,2})(\/(\d{4}))?/))) {
    const day = parseInt(m[1], 10), mon = parseInt(m[2], 10) - 1;
    let year = m[4] ? parseInt(m[4], 10) : now.getFullYear();
    let due = atTime(new Date(year, mon, day), pickTime());
    if (!m[4] && +due < +now - 12 * 3600 * 1000) { due = atTime(new Date(year + 1, mon, day), pickTime()); }
    return { due, start: m.index, end: m.index + m[0].length };
  }
  // "X ngày nữa"
  if ((m = folded.match(/(\d+)\s*ngay\s*nua/))) {
    const due = atTime(addDays(now, parseInt(m[1], 10)), pickTime());
    return { due, start: m.index, end: m.index + m[0].length };
  }
  // Thứ trong tuần: thứ 2..thứ 7, thứ hai.., chủ nhật / cn
  const wd = { 'thu 2': 1, 'thu hai': 1, 'thu 3': 2, 'thu ba': 2, 'thu 4': 3, 'thu tu': 3, 'thu 5': 4, 'thu nam': 4, 'thu 6': 5, 'thu sau': 5, 'thu 7': 6, 'thu bay': 6, 'chu nhat': 0, 'cn': 0 };
  for (const k in wd) {
    const idx = folded.indexOf(k);
    if (idx !== -1) {
      let add = (wd[k] - now.getDay() + 7) % 7;
      let due = atTime(addDays(now, add), pickTime());
      if (+due <= +now) due = atTime(addDays(now, add + 7), pickTime());
      if (/tuan\s*sau/.test(folded)) due = atTime(addDays(due, 7), pickTime()); // "thứ 3 tuần sau"
      return { due, start: idx, end: idx + k.length };
    }
  }
  // Cuối tháng
  if ((m = folded.match(/cuoi\s*thang/))) {
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { due: atTime(last, pickTime()), start: m.index, end: m.index + m[0].length };
  }
  // Cuối tuần (Thứ 6 tuần này) / tuần sau (Thứ 6 tuần sau)
  if ((m = folded.match(/cuoi\s*tuan\s*sau|tuan\s*sau/))) {
    const add = (5 - now.getDay() + 7) % 7 + 7; // Thứ 6 tuần sau
    return { due: atTime(addDays(now, add), pickTime()), start: m.index, end: m.index + m[0].length };
  }
  if ((m = folded.match(/cuoi\s*tuan/))) {
    let add = (5 - now.getDay() + 7) % 7;
    let due = atTime(addDays(now, add), pickTime());
    if (+due <= +now) due = atTime(addDays(now, add + 7), pickTime());
    return { due, start: m.index, end: m.index + m[0].length };
  }
  // Hôm nay / ngày mai / ngày kia (mốt)
  const rel = [ [/ngay\s*kia|\bmot\b/, 2], [/ngay\s*mai|\bmai\b/, 1], [/hom\s*nay|\bnay\b/, 0] ];
  for (const [re, add] of rel) {
    if ((m = folded.match(re))) {
      let due = atTime(addDays(now, add), pickTime());
      if (add === 0 && +due <= +now && time) due = atTime(addDays(now, 1), pickTime()); // nói giờ hôm nay nhưng đã qua → mai
      return { due, start: m.index, end: m.index + m[0].length };
    }
  }
  // Chỉ có giờ, không có ngày → hôm nay, nếu đã qua giờ đó thì mai
  if (time) {
    let due = atTime(now, time);
    if (+due <= +now) due = atTime(addDays(now, 1), time);
    const idx = folded.indexOf(tm[0]);
    return { due, start: idx, end: idx + tm[0].length };
  }
  // Chỉ có buổi (sáng/chiều) không ngày → buổi gần nhất còn ở phía trước
  const st = sessionTime();
  if (st) {
    let due = atTime(now, st);
    if (+due <= +now) due = atTime(addDays(now, 1), st);
    return { due, start: 0, end: folded.length };
  }
  return null;
}

// ============================== PHÂN TÍCH LỆNH ==============================
// Tách một câu lệnh "ghi việc" thành { title, assignee, due, dueText }
function parseAddCommand(rawText, now) {
  let text = rawText.trim();
  let folded = foldVN(text);
  let due = null;

  // Việc lặp (v3.5): có cụm chu kỳ ("lặp … hằng tuần", "mỗi tháng"…) thì nhận diện và cắt khỏi tiêu đề.
  let recur = null;
  const rm = folded.match(/(lap\s+lai\s+|lap\s+|dinh\s+ky\s+)?(hang|moi)\s+(tuan|thang|ngay)\b/);
  if (rm) {
    recur = detectRecur(folded);
    if (recur) {
      text = (text.slice(0, rm.index) + ' ' + text.slice(rm.index + rm[0].length)).replace(/\s{2,}/g, ' ').trim();
      // Chữ "lặp / lặp lại / định kỳ" thường đứng ở đầu câu, tách khỏi cụm chu kỳ → bỏ riêng.
      const lm = foldVN(text).match(/^(lap\s+lai|lap|dinh\s+ky)\s*[:：]?\s*/);
      if (lm) text = text.slice(lm[0].length).trim();
      folded = foldVN(text);
    }
  }
  // Lặp hằng tháng kiểu "ngày 25 … 17h": bộ phân tích hạn hiểu sai "ngày X" đứng một mình
  // (nó gán thành hôm nay) → tự dựng hạn kỳ đầu, đồng thời cắt "ngày X" và giờ khỏi tiêu đề TRƯỚC.
  if (recur && recur.type === 'monthly') {
    const fM = foldVN(text);
    const dm = fM.match(/ngay\s+(\d{1,2})\b/);
    if (dm) {
      const day = Math.min(31, Math.max(1, parseInt(dm[1], 10)));
      const tm = fM.match(/(\d{1,2})\s*h\s*(\d{2})?|(\d{1,2}):(\d{2})/);
      const hh = tm ? parseInt(tm[1] ?? tm[3], 10) : CONFIG.defaultDueTime[0];
      const mm = tm ? parseInt((tm[2] ?? tm[4]) || '0', 10) : CONFIG.defaultDueTime[1];
      let cand = new Date(now.getFullYear(), now.getMonth(), Math.min(day, daysInMonth(now.getFullYear(), now.getMonth())), hh, mm);
      if (cand <= now) cand = new Date(now.getFullYear(), now.getMonth() + 1, Math.min(day, daysInMonth(now.getFullYear(), now.getMonth() + 1)), hh, mm);
      due = cand;
      const spans = [[dm.index, dm.index + dm[0].length]];
      if (tm) spans.push([tm.index, tm.index + tm[0].length]);
      spans.sort((a, b) => b[0] - a[0]);
      for (const [s, e] of spans) text = (text.slice(0, s) + ' ' + text.slice(e));
      text = text.replace(/\s{2,}/g, ' ').trim();
      folded = foldVN(text);
    }
  }

  // Tìm đoạn hạn: ưu tiên phần sau từ "hạn"/"trước"; không có thì quét cả câu.
  // (Bỏ qua nếu hạn đã được dựng ở nhánh lặp hằng tháng phía trên.)
  let parsed = null;
  if (!due) {
    const hanIdx = folded.search(/\bhan\b|\btruoc\b/);
    if (hanIdx !== -1) { parsed = parseDeadline(folded.slice(hanIdx), now); if (parsed) { parsed.start += hanIdx; parsed.end += hanIdx; } }
    if (!parsed) parsed = parseDeadline(folded, now);
  }
  if (parsed) {
    due = parsed.due;
    // Cắt đoạn hạn khỏi tiêu đề: từ từ khóa hạn (nếu có ngay trước) tới hết đoạn hạn + phần giờ phía sau
    let cutStart = parsed.start, cutEnd = parsed.end;
    const before = folded.slice(Math.max(0, cutStart - 6), cutStart);
    if (/\bhan\s*$|\btruoc\s*$/.test(before)) cutStart -= before.match(/\b(han|truoc)\s*$/)[0].length;
    // giờ có thể nằm ngay sau ngày (vd "thứ 6 17h" — đã nằm trong đoạn nếu cùng vùng; quét thêm tối đa 8 ký tự)
    const tail = folded.slice(cutEnd, cutEnd + 9);
    const tailTime = tail.match(/^\s*(\d{1,2})\s*h\s*(\d{2})?|^\s*(\d{1,2}):(\d{2})/);
    if (tailTime) cutEnd += tailTime[0].length;
    text = (text.slice(0, cutStart) + ' ' + text.slice(cutEnd)).trim();
  }


  // Người được giao: "giao cho anh Tùng" / "cho chị Lan làm"
  let assignee = null;
  const f2 = foldVN(text);
  const am = f2.match(/giao\s*cho\s+([^,.;]+)/) || f2.match(/cho\s+(anh|chi|em|ban|ong|ba)\s+([^,.;]+)/);
  if (am) {
    assignee = text.slice(am.index + (am[0].length - (am[2] || am[1]).length)).trim();
    if (am[1] && /^(anh|chi|em|ban|ong|ba)$/.test(foldVN(am[1]))) assignee = text.slice(am.index, am.index + am[0].length).replace(/^.*?cho\s+/i, '').trim();
    text = (text.slice(0, am.index) + ' ' + text.slice(am.index + am[0].length)).trim();
  }

  const title = text.replace(/^[:：\-\s]+/, '').replace(/[,;\s]+$/, '').trim();
  return { title: title ? title[0].toUpperCase() + title.slice(1) : '', assignee, due, recur };
}

function parseCommandInner(rawText, now) {
  let text = rawText.trim();
  // Bỏ tiếng gọi đầu câu: "@Bot …", "bot ơi", "bot," …
  text = text.replace(/^@\S+\s*/, '').replace(/^bot(\s+oi)?[\s,:]*/i, '').trim();
  const f = foldVN(text);
  let m;
  if (/^(tro giup|help|huong dan)/.test(f) || f === '') return { type: 'help' };
  if (/^(viec hom nay|viec sang|ban tin sang|hom nay co viec gi|viec can lam hom nay)/.test(f)) return { type: 'briefing' };
  if (/^(phien ban|version)/.test(f)) return { type: 'version' };
  if (/^(kiem tra cap nhat|cap nhat(\s+(di|bot|len))?$)/.test(f)) return { type: 'update' };
  if ((m = f.match(/^xong\s+(viec\s*)?(\d+)/)) || (m = f.match(/^da\s+xong\s+(viec\s*)?(\d+)/))) return { type: 'done', n: parseInt(m[2], 10) };
  if ((m = f.match(/^(xoa|huy)\s+(viec\s*)?(\d+)/))) return { type: 'delete', n: parseInt(m[3], 10) };
  if ((m = f.match(/^sua\s+han\s+(viec\s*)?(\d+)\s+(.+)/))) {
    const p = parseDeadline(foldVN(m[3]), now);
    return p ? { type: 'redue', n: parseInt(m[2], 10), due: p.due } : { type: 'unknown' };
  }
  if (/^(danh sach|liet ke|xem viec|viec nao|viec)$/.test(f) || /^viec\s+(sắp|sắp den|sắp tới)/.test(f) || /^viec/.test(f) && /den han|sap/.test(f)) return { type: 'list' };
  // Nhắc nhanh kiểu tự nhiên: "nhắc tao, 2 phút nữa đi ngủ", "nhắc mình đi ngủ sau 5 phút"
  if (/(^|\s)nhac\s+(tao|toi|minh|anh|chi|em)\b/.test(f) || /^nhac\b/.test(f)) {
    const p = parseDeadline(f, now);
    if (p) {
      let body = text.slice(0, p.start) + ' ' + text.slice(p.end);
      // Bỏ phần "nhắc tao/…" VÀ mọi chữ phía trước nó (thường là tên bot bị @gọi, vd "Mặt trận Lạng Sơn nhắc tao")
      const nm = foldVN(body).match(/nhac\s+(tao|toi|minh|anh|chi|em)/);
      if (nm) body = body.slice(nm.index + nm[0].length);
      else { const nm2 = foldVN(body).match(/^\s*nhac\s*/); if (nm2) body = body.slice(nm2[0].length); }
      let title = body.replace(/^[\s,:]+/, '').replace(/[\s,]+$/, '').trim();
      title = title ? title[0].toUpperCase() + title.slice(1) : 'Việc được nhắc';
      return { type: 'remind', title, due: p.due };
    }
  }
  const mAdd = f.match(/^(ghi viec|them viec|giao viec|nhac viec|viec moi)/);
  if (mAdd) {
    // Cắt theo bản đã gấp (giữ nguyên độ dài) nên áp được cho cả câu có dấu và không dấu
    let body = text.slice(mAdd[0].length);
    const mCho = foldVN(body).match(/^\s*(cho\s+(tao|toi|minh))?\s*[:：]?\s*/);
    body = body.slice(mCho[0].length);
    return { type: 'add', ...parseAddCommand(body, now) };
  }
  return { type: 'unknown' };
}

function parseCommand(rawText, now) {
  const first = parseCommandInner(rawText, now);
  if (first.type !== 'unknown') return first;
  // Dự phòng cho tin @nhắc tên bot dài trong nhóm (vd "@Bot Mặt trận Lạng Sơn ghi việc: …"):
  // tìm vị trí bắt đầu của từ khóa lệnh trong câu và phân tích lại từ đó.
  const f = foldVN(rawText);
  const m = f.match(/(ghi viec|them viec|giao viec|nhac viec|nhac\s+(tao|toi|minh)|tro giup|danh sach|liet ke|xem viec|viec hom nay|ban tin sang|sua han|xong\s+\d|xoa\s+\d)/);
  if (m && m.index > 0) return parseCommandInner(rawText.slice(m.index), now);
  return first;
}

// ============================== LƯU TRỮ ==============================
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}
const tasksFile = path.join(CONFIG.dataDir, 'tasks.json');
const stateFile = path.join(CONFIG.dataDir, 'state.json');
let store = loadJson(tasksFile, { chats: {}, pending: {} }); // chats[chatId] = [task], pending["chatId|userId"] = {title, assignee}
if (!store.users) store.users = {}; // users[userId] = { name, privateChatId, lastSeen } — nạp 1 lần khi người dùng chat riêng với bot
if (!store.history) store.history = {}; // history[chatId] = [{r:'u'|'a', t}] — mạch hội thoại của chế độ thư ký
if (!store.posters) store.posters = []; // posters = [userId] — những người được quyền ra lệnh đăng bài qua bot
if (!store.postQueue) store.postQueue = []; // postQueue = [{id,url,by,byId,chatId,at,status}] — hàng đợi lệnh đăng bài chờ extension xử lý
let state = loadJson(stateFile, { seen: [] });
if (!Array.isArray(state.seen)) state.seen = []; // chống trùng theo message_id (Zalo không có offset/update_id)
const saveStore = () => saveJson(tasksFile, store);
const saveState = () => saveJson(stateFile, state);
let seq = Math.max(0, ...Object.values(store.chats).flat().map((t) => t.seq || 0));

// ============================== ZALO API ==============================
// Token lấy từ biến môi trường BOT_TOKEN; nếu không có thì đọc file token.txt cạnh bot.js
// (file này do Chay_Bot.bat tạo ở lần chạy đầu — chỉ lưu trên máy của người dùng, không commit).
let TOKEN = (process.env.BOT_TOKEN || '').trim();
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').split(/\r?\n/)[0].trim(); } catch { TOKEN = ''; }
}
const api = (method) => `https://bot-api.zaloplatforms.com/bot${TOKEN}/${method}`;
async function callApi(method, payload) {
  const res = await fetch(api(method), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false || (data.error && data.error !== 0)) {
    throw new Error(`${method}: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data.result ?? data.data ?? data;
}
async function send(chatId, text) {
  // Zalo giới hạn 2.000 ký tự/tin: ưu tiên cắt theo đoạn văn cho dễ đọc, đoạn quá dài mới cắt cứng.
  text = String(text);
  const chunks = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if (cur && (cur + '\n\n' + para).length <= 1900) { cur += '\n\n' + para; continue; }
    if (cur) chunks.push(cur);
    let p = para;
    while (p.length > 1900) { chunks.push(p.slice(0, 1900)); p = p.slice(1900); }
    cur = p;
  }
  if (cur) chunks.push(cur);
  for (const c of chunks) await callApi('sendMessage', { chat_id: chatId, text: c });
}
// Bóc tách phản hồi getUpdates của Zalo. Khác Telegram: Zalo trả TỪNG SỰ KIỆN MỘT dưới dạng
// { ok:true, result:{ message:{...}, event_name:"message.text.received" } } — result KHÔNG phải mảng,
// không có update_id/offset. (Bản cũ chờ mảng nên đã bỏ qua mọi tin nhắn — bot "điếc" dù đăng nhập tốt.)
function extractUpdates(data) {
  const r = data?.result ?? data?.data ?? data;
  if (!r || typeof r !== 'object') return [];
  if (Array.isArray(r)) return r;
  if (Array.isArray(r.updates)) return r.updates;
  if (r.message || r.event_name) return [r];
  return [];
}
// Long polling riêng cho getUpdates: Zalo trả error_code 408 "Request timeout" khi hết
// thời gian chờ mà không có tin mới — đó là trạng thái BÌNH THƯỜNG (không có tin), không phải lỗi.
async function pollUpdates() {
  const res = await fetch(api('getUpdates'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeout: CONFIG.pollTimeoutSec }), // getUpdates của Zalo chỉ nhận timeout
  });
  const data = await res.json().catch(() => null);
  const errCode = data?.error_code ?? data?.error?.code;
  if (errCode === 408 || data?.description === 'Request timeout') return [];
  if (!res.ok || !data || data.ok === false || (data.error && data.error !== 0)) {
    throw new Error(`getUpdates: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return extractUpdates(data);
}

// ============================== XỬ LÝ VIỆC ==============================
function openTasks(chatId) { return (store.chats[chatId] || []).filter((t) => !t.done); }
function listText(chatId) {
  const list = openTasks(chatId).sort((a, b) => new Date(a.due) - new Date(b.due));
  if (!list.length) return 'Hiện không có việc nào đang mở. Gọi “bot, ghi việc: … hạn …” để thêm việc mới.';
  return '📌 Việc đang mở (theo hạn gần nhất):\n' + list.map((t, i) => {
    const due = new Date(t.due);
    const overdue = +due < Date.now() ? ' ⛔ QUÁ HẠN' : '';
    return `${i + 1}. ${t.title}\n   ⏰ Hạn: ${fmtDT(due)}${t.assignee ? `\n   👤 ${t.assignee}` : ''}${t.recur ? `\n   🔁 Lặp ${t.recur.label}` : ''}${overdue}`;
  }).join('\n');
}

// ============================== BẢN TIN SÁNG (v3.3) ==============================
// Mỗi sáng ngày làm việc lúc 07:45 bot tự gửi vào từng chat có việc mở: việc quá hạn +
// việc đến hạn hôm nay + việc đến hạn ngày mai. Không có việc nào trong 3 nhóm thì im lặng.
// Gọi "bot, việc hôm nay" để xem ngay bất cứ lúc nào (không cần chờ 07:45).
function briefingText(chatId, now) {
  const list = openTasks(chatId).sort((a, b) => new Date(a.due) - new Date(b.due));
  if (!list.length) return null;
  const tomorrow = atTime(addDays(now, 1), [0, 0]);
  const dayAfter = atTime(addDays(now, 2), [0, 0]);
  const overdue = list.filter((t) => +new Date(t.due) < +now);
  const today = list.filter((t) => +new Date(t.due) >= +now && +new Date(t.due) < +tomorrow);
  const next = list.filter((t) => +new Date(t.due) >= +tomorrow && +new Date(t.due) < +dayAfter);
  if (!overdue.length && !today.length && !next.length) return null;
  const line = (t) => `• ${t.title} — ⏰ ${fmtDT(new Date(t.due))}${t.assignee ? ` — 👤 ${t.assignee}` : ''}${t.recur ? ' 🔁' : ''}`;
  const dayLabel = fmtDT(now).split(' ').slice(0, 3).join(' ');
  const parts = [`☀️ BẢN TIN VIỆC SÁNG — ${dayLabel}`];
  if (overdue.length) parts.push(`⛔ Quá hạn (${overdue.length}):\n${overdue.map(line).join('\n')}`);
  if (today.length) parts.push(`📌 Đến hạn hôm nay (${today.length}):\n${today.map(line).join('\n')}`);
  if (next.length) parts.push(`🔜 Đến hạn ngày mai (${next.length}):\n${next.map(line).join('\n')}`);
  parts.push('Xong việc nào thì báo: “bot, xong …” theo số trong danh sách việc (“bot, việc”).');
  return parts.join('\n\n');
}

// Gọi từ reminderTick (chạy mỗi phút): chỉ bắn đúng phút 07:45 ngày làm việc, mỗi ngày 1 lần.
// Ghi briefingLast TRƯỚC khi gửi để bot khởi động lại trong cùng phút không gửi trùng;
// nếu gửi lỗi thì ngày đó bỏ qua (sáng hôm sau gửi lại bình thường).
async function morningBriefingTick(now) {
  if (!CONFIG.officeDays.includes(now.getDay())) return;
  const [h, m] = CONFIG.briefingTime;
  if (now.getHours() !== h || now.getMinutes() !== m) return;
  const today = now.toDateString();
  if (store.briefingLast === today) return;
  store.briefingLast = today; saveStore();
  for (const chatId of Object.keys(store.chats)) {
    const text = briefingText(chatId, now);
    if (text) await send(chatId, text).catch((e) => console.error('send briefing:', e.message));
  }
}

// ============================== VIỆC LẶP ĐỊNH KỲ (v3.5) ==============================
// Nhận diện chu kỳ từ câu chữ đã gấp dấu: "hằng tuần / mỗi tuần", "hằng tháng / mỗi tháng", "hằng ngày / mỗi ngày".
function detectRecur(folded) {
  const f = String(folded || '');
  if (/(hang|moi)\s+tuan/.test(f)) return { type: 'weekly', label: 'hằng tuần' };
  if (/(hang|moi)\s+thang/.test(f)) return { type: 'monthly', label: 'hằng tháng' };
  if (/(hang|moi)\s+ngay/.test(f)) return { type: 'daily', label: 'hằng ngày' };
  return null;
}
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
// Hạn kỳ sau: giữ nguyên giờ; tháng thì giữ ngày (tháng ngắn hơn thì lùi về ngày cuối tháng đó).
function advanceDue(due, recur) {
  const d = new Date(due);
  if (!recur) return d;
  if (recur.type === 'weekly') d.setDate(d.getDate() + 7);
  else if (recur.type === 'daily') d.setDate(d.getDate() + 1);
  else if (recur.type === 'monthly') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  }
  return d;
}
// Sinh việc kỳ sau cho 1 việc lặp (gọi khi việc được báo xong, hoặc khi đã qua hạn mà chưa sinh).
// Cờ spawnedNext trên việc cũ chống sinh trùng; việc mới tự lên lịch nhắc như việc thường.
function spawnNext(chatId, task, now) {
  if (!task.recur || task.spawnedNext) return null;
  task.spawnedNext = true;
  const next = addTask(chatId, task.createdBy, {
    title: task.title, assignee: task.assignee, due: advanceDue(new Date(task.due), task.recur),
    assigneeId: task.assigneeId, recur: task.recur,
  });
  console.log(`[Việc lặp] Đã sinh kỳ sau cho "${task.title}" → hạn ${fmtDT(new Date(next.due))}`);
  return next;
}

function addTask(chatId, fromName, { title, assignee, due, assigneeId, recur }) {
  const now = new Date();
  const task = {
    seq: ++seq, title, assignee: assignee || fromName, assigneeId: assigneeId || null, due: due.toISOString(),
    createdBy: fromName, createdAt: now.toISOString(), done: false,
    reminders: planReminders(due, now).map((d) => ({ at: d.toISOString(), sent: false })),
    overdueLast: null, recur: recur || null, spawnedNext: false,
  };
  (store.chats[chatId] = store.chats[chatId] || []).push(task);
  saveStore();
  return task;
}

// ===== Nhắc riêng (DM) cho người được giao việc =====
// Chuẩn hóa tên để khớp: bỏ dấu + bỏ xưng hô đầu tên ("anh Tùng" → "tung").
function normName(name) {
  return foldVN(name || '').replace(/^(anh|chi|em|ong|ba|co|chu|bac)\s+/, '').trim();
}
// Tìm người dùng đã đăng ký theo tên hiển thị. Chỉ trả về khi khớp CHẮC CHẮN (khớp đúng 1 người).
function findUserByName(users, name) {
  const q = normName(name);
  if (!q) return null;
  const entries = Object.entries(users || {});
  const exact = entries.filter(([, u]) => normName(u.name) === q);
  if (exact.length === 1) return { id: exact[0][0], ...exact[0][1] };
  const partial = entries.filter(([, u]) => { const n = normName(u.name); return n.length >= 2 && (n.includes(q) || q.includes(n)); });
  if (partial.length === 1) return { id: partial[0][0], ...partial[0][1] };
  return null;
}
// Phân giải người được giao: tự giao (assigneeId = chính người ghi) hay giao cho người khác (khớp theo tên).
function resolveAssignee(assigneeName, fromName, userId) {
  const isForOther = !!assigneeName && normName(assigneeName) !== normName(fromName);
  if (!isForOther) return { isForOther: false, assigneeId: userId || null, matched: null };
  const matched = findUserByName(store.users, assigneeName);
  return { isForOther: true, assigneeId: matched?.id || null, matched };
}
// Dòng ghi chú sau khi giao việc cho người khác: có nhắn riêng được không.
function assignNote(r) {
  if (!r.isForOther) return '';
  if (r.matched?.privateChatId) return '\nBot sẽ nhắn nhắc riêng cho người được giao khi tới hạn.';
  if (r.matched) return '\nBot đã nhận diện được người được giao và sẽ thử nhắn riêng khi tới hạn (muốn chắc chắn: nhờ anh/chị ấy gọi “@Bot /start” ngay trong nhóm 1 lần).';
  return '\n(Lưu ý: bot chưa nhận diện được người được giao trong hệ thống. Nhờ anh/chị ấy gọi “@Bot /start” ngay trong nhóm, hoặc nhắn /start ở chat riêng với bot — chỉ 1 lần duy nhất.)';
}
// Ghi 1 việc đã đủ hạn: lưu + nhắn riêng cho người được giao (nếu nhận diện được) + xác nhận trong chat.
// Dùng chung cho lệnh cứng, luồng chờ-hạn và lớp AI.
async function createTaskWithNotes(chatId, fromName, userId, { title, assignee, due, recur }) {
  const r = resolveAssignee(assignee, fromName, userId);
  const task = addTask(chatId, fromName, { title, assignee, due, assigneeId: r.assigneeId, recur });
  if (r.isForOther && r.matched) {
    const target = r.matched.privateChatId || r.matched.id;
    try {
      await send(target, `📋 Bạn được giao việc: ${task.title}\n⏰ Hạn: ${fmtDT(new Date(task.due))}\n👤 Người giao: ${fromName}\nTới hạn bot sẽ nhắc bạn tại đây và trong nhóm.`);
      if (!r.matched.privateChatId && store.users[r.matched.id]) { store.users[r.matched.id].privateChatId = target; saveStore(); }
    } catch (e) { console.error('DM giao việc:', e.message); }
  }
  await send(chatId, `✅ Đã ghi việc: ${task.title}\n⏰ Hạn: ${fmtDT(new Date(task.due))}\n👤 ${task.assignee}${task.recur ? `\n🔁 Việc lặp ${task.recur.label} — kỳ sau sẽ tự sinh khi kỳ này báo xong hoặc qua hạn.` : ''}\nBot sẽ nhắc trước hạn trong giờ hành chính.${assignNote(r)}`);
  return task;
}

// Gửi thêm 1 bản nhắc vào chat RIÊNG của người được giao.
// Đã biết địa chỉ chat riêng thì dùng; chưa biết thì thử gửi thẳng tới mã người dùng
// (ở Zalo, địa chỉ chat riêng trùng mã người dùng) — gửi được thì ghi nhớ luôn cho lần sau.
async function dmCopy(chatId, task, text) {
  if (!task.assigneeId) return;
  const u = store.users?.[task.assigneeId];
  if (!u) return;
  const target = u.privateChatId || task.assigneeId;
  if (target === chatId) return; // việc vốn nằm ở đúng chat riêng đó rồi
  try {
    await send(target, text + '\n— Đây là bản nhắc riêng cho bạn; việc này cũng được nhắc trong nhóm.');
    if (!u.privateChatId) { u.privateChatId = target; saveStore(); console.log(`[nhắc riêng] Tự mở được chat riêng với ${u.name} — đã ghi nhớ.`); }
  } catch (e) { console.error('dmCopy:', e.message); }
}

// ============================== LỚP AI (Gemini) ==============================
// Khóa lấy từ biến môi trường GEMINI_API_KEY hoặc file ai-key.txt cạnh bot.js (Chay_Bot.bat hỏi ở lần chạy đầu).
// AI chỉ làm nhiệm vụ HIỂU câu nói tự nhiên và trích xuất ý định dạng JSON; việc tính hạn, ghi việc,
// nhắc hạn vẫn do mã cứng đảm nhiệm (parseDeadline/addTask/reminderTick) — AI sai thì bot quay về lệnh cứng.
let AI_KEY = (process.env.GEMINI_API_KEY || '').trim();
if (!AI_KEY) { try { AI_KEY = fs.readFileSync(path.join(__dirname, 'ai-key.txt'), 'utf8').split(/\r?\n/)[0].trim(); } catch { AI_KEY = ''; } }

function parseAiJson(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const actions = ['add_task', 'quick_remind', 'list', 'briefing', 'done', 'delete', 'change_due', 'answer', 'clarify', 'chat', 'secretary'];
    if (!o || typeof o !== 'object' || !actions.includes(o.action)) return null;
    return o;
  } catch { return null; }
}

async function aiUnderstand(text, now, fromName, chatId) {
  const tasks = openTasks(chatId).sort((a, b) => new Date(a.due) - new Date(b.due));
  const taskLines = tasks.length
    ? tasks.map((t, i) => `${i + 1}. ${t.title} — hạn ${fmtDT(new Date(t.due))} — người làm: ${t.assignee}`).join('\n')
    : '(chưa có việc nào đang mở)';
  const userNames = Object.values(store.users || {}).map((u) => u.name).filter(Boolean).join(', ') || '(chưa rõ)';
  const prompt = `Bạn là lớp hiểu ngôn ngữ cho một bot Zalo ghi việc và nhắc hạn trong nhóm công tác ở Việt Nam. Nhiệm vụ: đọc tin nhắn của người dùng và trả về DUY NHẤT một JSON đúng mẫu dưới đây, không giải thích thêm.

Bối cảnh:
- Bây giờ là: ${fmtDT(now)}.
- Người nhắn: ${fromName}.
- Danh sách việc đang mở (đánh số theo thứ tự này):
${taskLines}
- Thành viên bot đã biết: ${userNames}.

Mẫu JSON: {"action": "...", "title": string|null, "assignee": string|null, "due_text": string|null, "task_ref": number|null, "reply": string|null}

Quy tắc chọn action:
- "add_task": người dùng muốn ghi một việc công tác có hạn chót. title = nội dung việc (ngắn gọn, bỏ phần hạn và phần giao việc). assignee = tên người được giao như viết trong câu (vd "anh Tùng"); nếu việc của chính người nhắn thì null. due_text = trích NGUYÊN VĂN đoạn chữ diễn tả thời hạn trong câu (vd "mai 9h", "thứ 6 17h", "25/11", "cuối tháng"); không thấy thời hạn thì null. TUYỆT ĐỐI không tự bịa thời hạn.
- "quick_remind": nhắc hẹn cá nhân kiểu "nhắc tao/tôi/mình ... nữa" hoặc hẹn đúng một giờ cụ thể để nhắc (vd "nhắc tao 2 phút nữa đi ngủ", "15h nhắc mình gọi điện"). due_text trích nguyên văn như trên.
- "list": muốn xem danh sách việc.
- "briefing": muốn xem bản tin việc sáng / việc hôm nay (vd "việc hôm nay", "bản tin sáng").
- "done" / "delete": báo xong hoặc xóa một việc — task_ref là số thứ tự của việc đó trong danh sách trên (suy ra từ nội dung câu nếu họ không nói số).
- "change_due": đổi hạn một việc — task_ref + due_text mới.
- "answer": hỏi về tình hình/danh sách việc (vd "tuần này còn việc gì?", "việc nào quá hạn?") — trả lời ngắn gọn, đúng dữ kiện đã cho, viết vào reply.
- "clarify": không đủ thông tin cốt yếu để làm (không rõ việc gì) — reply là một câu hỏi lại lịch sự, ngắn.
- "chat": chào hỏi, xã giao đơn thuần — reply thân thiện, rất ngắn.
- "secretary": MỌI yêu cầu còn lại có nội dung — hỏi kiến thức, tra cứu thông tin bên ngoài (số điện thoại, địa chỉ, quy định, tin tức, thời tiết...), soạn thảo văn bản, dịch, tóm tắt, giải thích, tư vấn. Khi phân vân giữa "answer" và "secretary": chỉ dùng "answer" khi câu trả lời nằm trọn trong danh sách việc đã cho ở trên; ngoài ra cứ dùng "secretary".

Ví dụ:
- "mai 9h nhắc tao qua tỉnh ủy họp giao ban" → {"action":"quick_remind","title":"Qua tỉnh ủy họp giao ban","assignee":null,"due_text":"mai 9h","task_ref":null,"reply":null}
- "ghi việc chuẩn bị tài liệu hội nghị giao cho anh Tùng, hạn thứ 5 tuần này" → {"action":"add_task","title":"Chuẩn bị tài liệu hội nghị","assignee":"anh Tùng","due_text":"thứ 5 tuần này","task_ref":null,"reply":null}
- "việc nộp báo cáo xong rồi" (nếu đó là việc số 2 trong danh sách) → {"action":"done","title":null,"assignee":null,"due_text":null,"task_ref":2,"reply":null}

Tin nhắn của người dùng: "${text.replace(/"/g, '“')}"`;
  const raw = await callGemini(prompt, true);
  const parsed = parseAiJson(raw);
  if (raw && !parsed) console.error('[AI] Không đọc được phản hồi:', String(raw).slice(0, 300));
  return parsed;
}
let aiModelWorking = null;

// Gọi Gemini dùng chung cho mọi nhu cầu AI (hiểu lệnh, quyết định tra cứu, thư ký soạn trả lời):
// thử lần lượt các model trong CONFIG.aiModels, model nào chạy được thì ghi nhớ dùng tiếp;
// mọi lỗi (404 model nghỉ hưu, 429 hết hạn mức của model đó, treo quá giờ, lỗi mạng) đều nhảy sang model kế tiếp.
// jsonMode=true ép trả JSON (nhiệt độ thấp); false trả văn bản tự do.
async function callGemini(promptText, jsonMode = true) {
  const order = aiModelWorking ? [...CONFIG.aiModels.filter((m) => m.id === aiModelWorking), ...CONFIG.aiModels.filter((m) => m.id !== aiModelWorking)] : CONFIG.aiModels;
  for (const spec of order) {
    const model = spec.id;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.aiTimeoutMs);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': AI_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: {
            ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
            temperature: jsonMode ? 0.2 : 0.4,
            ...(spec.thinkingBudget ? { thinkingConfig: { thinkingBudget: spec.thinkingBudget } } : {}),
          },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const why = res.status === 404 ? 'không còn hoạt động (404)' : `trả lỗi ${res.status}: ${JSON.stringify(data).slice(0, 200)}`;
        console.error(`[AI] Model ${model} ${why} — thử model khác.`);
        continue;
      }
      if (!aiModelWorking) { aiModelWorking = model; console.log(`[AI] Đang dùng model: ${model}`); }
      return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    } catch (e) {
      const why = e && e.name === 'AbortError' ? `quá ${Math.round(CONFIG.aiTimeoutMs / 1000)} giây không trả lời` : (e && e.message) || String(e);
      console.error(`[AI] Model ${model} lỗi: ${why} — thử model khác.`);
      continue;
    } finally { clearTimeout(timer); }
  }
  console.error('[AI] Tất cả model đều không dùng được — bot tạm quay về lệnh cứng.');
  return null;
}

// Thực thi ý định do AI trích xuất. Trả về true nếu đã xử lý xong; false để nơi gọi quay về lệnh cứng.
async function handleViaAI(text, chatId, fromName, userId, pKey, now) {
  let ai;
  try { ai = await aiUnderstand(text, now, fromName, chatId); }
  catch (e) { console.error('[AI] Lỗi gọi Gemini:', e.message); return false; }
  if (!ai) return false;
  console.log(`[AI] action=${ai.action} title=${ai.title || ''} due_text=${ai.due_text || ''} ref=${ai.task_ref || ''}`);
  const due = ai.due_text ? (parseDeadline(foldVN(String(ai.due_text)), now)?.due || null) : null;
  switch (ai.action) {
    case 'add_task': {
      if (!ai.title) return false;
      if (!due) {
        store.pending[pKey] = { title: ai.title, assignee: ai.assignee || fromName };
        saveStore();
        await send(chatId, ai.reply || `Đã nhận việc “${ai.title}” nhưng chưa rõ hạn. Hạn lúc nào anh/chị? (ví dụ: “mai 9h”, “thứ 6 17h”, “25/11”)`);
        return true;
      }
      await createTaskWithNotes(chatId, fromName, userId, { title: ai.title, assignee: ai.assignee || fromName, due, recur: detectRecur(foldVN(text)) });
      return true;
    }
    case 'quick_remind': {
      if (!due) return false;
      const task = {
        seq: ++seq, title: ai.title || 'Việc được nhắc', assignee: fromName, assigneeId: userId || null,
        due: due.toISOString(), createdBy: fromName, createdAt: now.toISOString(), done: false, exact: true,
        reminders: [{ at: due.toISOString(), sent: false }], overdueLast: null,
      };
      (store.chats[chatId] = store.chats[chatId] || []).push(task);
      saveStore();
      await send(chatId, `⏰ Ok! Đúng ${fmtDT(due)} mình sẽ nhắc: ${task.title}`);
      return true;
    }
    case 'list': await send(chatId, listText(chatId)); return true;
    case 'briefing': { const t = briefingText(chatId, now); await send(chatId, t || 'Hôm nay không có việc nào đến hạn, cũng không có việc quá hạn.'); return true; }
    case 'done': case 'delete': {
      const list = openTasks(chatId).sort((a, b) => new Date(a.due) - new Date(b.due));
      const task = ai.task_ref ? list[ai.task_ref - 1] : null;
      if (!task) return false;
      if (ai.action === 'done') { task.done = true; task.doneAt = new Date().toISOString(); const nt = spawnNext(chatId, task, new Date()); saveStore(); await send(chatId, `🎉 Đã xong: ${task.title}. Cảm ơn anh/chị!${nt ? `\n🔁 Đã sinh kỳ sau (${task.recur.label}): hạn ${fmtDT(new Date(nt.due))}.` : ''}`); }
      else { store.chats[chatId] = store.chats[chatId].filter((t) => t.seq !== task.seq); saveStore(); await send(chatId, `🗑 Đã xóa việc: ${task.title}.`); }
      return true;
    }
    case 'change_due': {
      const list = openTasks(chatId).sort((a, b) => new Date(a.due) - new Date(b.due));
      const task = ai.task_ref ? list[ai.task_ref - 1] : null;
      if (!task || !due) return false;
      task.due = due.toISOString();
      task.reminders = planReminders(due, now).map((d) => ({ at: d.toISOString(), sent: false }));
      task.overdueLast = null;
      saveStore();
      await send(chatId, `✅ Đã đổi hạn việc “${task.title}” → ${fmtDT(due)}.`);
      return true;
    }
    case 'secretary': return await handleSecretary(text, chatId, fromName);
    case 'answer': case 'clarify': case 'chat': {
      if (ai.reply) { await send(chatId, String(ai.reply).slice(0, 1900)); return true; }
      return false;
    }
    default: return false;
  }
}

// ============================== TRA CỨU WEB (miễn phí, không cần khóa) ==============================
function decodeEntities(s) {
  return String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function stripHtml(html) {
  return decodeEntities(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.searchTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept-Language': 'vi,en;q=0.8' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; } finally { clearTimeout(timer); }
}
function parseBingResults(html) {
  const out = [];
  for (const chunk of String(html).split('b_algo').slice(1)) {
    const m = chunk.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/);
    if (!m) continue;
    const p = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: stripHtml(m[2]), url: decodeEntities(m[1]), snippet: p ? stripHtml(p[1]) : '' });
    if (out.length >= 5) break;
  }
  return out.filter((r) => r.title && r.url.startsWith('http'));
}
function parseDdgResults(html) {
  const links = [...String(html).matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snips = [...String(html).matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  const out = [];
  links.forEach((m, i) => {
    let url = decodeEntities(m[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* giữ nguyên nếu giải mã lỗi */ } }
    out.push({ title: stripHtml(m[2]), url, snippet: snips[i] ? stripHtml(snips[i][1]) : '' });
  });
  return out.filter((r) => r.title && r.url.startsWith('http')).slice(0, 5);
}
async function wikiSearch(query) {
  const raw = await fetchText(`https://vi.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5`);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return (data?.query?.search || []).map((it) => ({ title: it.title, url: `https://vi.wikipedia.org/wiki/${encodeURIComponent(it.title.replace(/ /g, '_'))}`, snippet: stripHtml(it.snippet || '') }));
  } catch { return []; }
}
// Vì sao bot không tìm thẳng bằng Google: google.com/search CHẶN chương trình — chỉ trả trang
// "hãy bật JavaScript" + CAPTCHA (đã kiểm chứng thực tế 2026-11-16; các cổng trung gian như Ecosia,
// Brave, Startpage, Mojeek, Yandex, Cốc Cốc cũng đều chặn/vỏ rỗng với truy vấn tự động).
// Đường Google thật duy nhất là tính năng tra cứu tích sẵn trong Gemini (cần bật thanh toán) — để dành khi cần.
// Hiện tại bot GỘP kết quả Bing + DuckDuckGo (bỏ trùng) cho phủ rộng, cộng thêm Google Tin tức cho câu hỏi tin tức.
function parseGoogleNews(xml) {
  const out = [];
  for (const item of String(xml).split('<item>').slice(1)) {
    const t = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const l = item.match(/<link>(https?:[^<]+)<\/link>/);
    if (!t || !l) continue;
    const d = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    const p = item.match(/<pubDate>([^<]+)<\/pubDate>/);
    out.push({ title: decodeEntities(t[1].trim()), url: l[1].trim(), snippet: (d ? stripHtml(d[1]) : '') + (p ? ` (${p[1].trim()})` : '') });
    if (out.length >= 5) break;
  }
  return out.filter((r) => r.title && r.url.startsWith('http'));
}
async function googleNews(query) {
  const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=vi&gl=VN&ceid=VN:vi`);
  return xml ? parseGoogleNews(xml) : [];
}
// Tìm web: gộp Bing + DuckDuckGo (bỏ trùng theo đường link); câu hỏi mùi tin tức thì gộp thêm Google Tin tức;
// cả hai nguồn chính đều trống mới lùi về Wikipedia tiếng Việt.
async function webSearch(query) {
  const q = encodeURIComponent(query);
  const [bingHtml, ddgHtml] = await Promise.all([
    fetchText(`https://www.bing.com/search?q=${q}&setlang=vi`),
    fetchText(`https://html.duckduckgo.com/html/?q=${q}`),
  ]);
  const merged = [];
  const seen = new Set();
  const push = (r) => { const k = r.url.replace(/\/+$/, ''); if (!seen.has(k)) { seen.add(k); merged.push(r); } };
  const bingR = bingHtml ? parseBingResults(bingHtml) : [];
  const ddgR = ddgHtml ? parseDdgResults(ddgHtml) : [];
  bingR.forEach(push);
  ddgR.forEach(push);
  const srcs = [];
  if (bingR.length) srcs.push('Bing');
  if (ddgR.length) srcs.push('DuckDuckGo');
  if (/(tin tuc|tin moi|hom nay|su kien|thoi su)/.test(foldVN(query))) {
    const news = await googleNews(query);
    news.forEach(push);
    if (news.length) srcs.push('Google Tin tức');
  }
  const out = merged.slice(0, 6);
  if (out.length) { console.log(`[Tra cứu] "${query}" → ${out.length} kết quả (${srcs.join(' + ') || 'web'})`); return out; }
  const wiki = await wikiSearch(query);
  if (wiki.length) { console.log(`[Tra cứu] "${query}" → ${wiki.length} kết quả (Wikipedia)`); return wiki; }
  console.log(`[Tra cứu] "${query}" → không lấy được kết quả`);
  return [];
}
async function fetchPageText(url) {
  const html = await fetchText(url);
  if (!html) return null;
  const t = stripHtml(html);
  return t ? t.slice(0, 5000) : null;
}

// ============================== CHẾ ĐỘ THƯ KÝ ==============================
function pushHistory(chatId, role, text) {
  const h = (store.history[chatId] = store.history[chatId] || []);
  h.push({ r: role, t: String(text).slice(0, 800) });
  while (h.length > CONFIG.historyMax) h.shift();
  saveStore();
}
function historyText(chatId) {
  const h = store.history[chatId] || [];
  if (!h.length) return '(chưa có)';
  return h.map((m) => `${m.r === 'u' ? 'Người dùng' : 'Bot'}: ${m.t}`).join('\n');
}
// Hỏi AI xem câu này có cần tra cứu web không, và nếu có thì tìm bằng cụm từ nào.
async function secretaryDecideSearch(text, chatId) {
  const prompt = `Quyết định xem câu hỏi sau có cần TRA CỨU WEB hay không. Trả về DUY NHẤT JSON {"search": true|false, "query": string|null}.
Cần tra cứu (search=true) khi câu hỏi đòi hỏi dữ kiện cụ thể/bên ngoài/mới nhất: số điện thoại, địa chỉ, người đứng đầu, quy định/văn bản, tin tức, thời tiết, giá cả, lịch trình, thông tin về một cơ quan/tổ chức/cá nhân cụ thể.
Không cần (search=false) khi: soạn thảo văn bản, dịch, sửa câu chữ, giải thích kiến thức phổ thông, tính toán, tư vấn cách làm, trò chuyện.
query: cụm từ tìm kiếm ngắn gọn rõ nghĩa bằng tiếng Việt, suy từ câu hỏi và mạch hội thoại; search=false thì query=null.
Mạch hội thoại gần đây:
${historyText(chatId)}
Câu hỏi: "${text.replace(/"/g, '“')}"`;
  const raw = await callGemini(prompt, true);
  if (!raw) return null;
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const o = JSON.parse(m[0]); return { search: !!o.search, query: o.query ? String(o.query) : null }; } catch { return null; }
}
// Thư ký toàn năng: hỏi đáp tự do + tra cứu ngoài + soạn thảo, có nhớ mạch hội thoại của từng chat.
async function handleSecretary(text, chatId, fromName) {
  try {
    let ctx = '';
    const urlM = text.match(/https?:\/\/[^\s)]+/);
    if (urlM) {
      const page = await fetchPageText(urlM[0]);
      if (page) ctx = `\n\nNội dung trang web người dùng gửi kèm (${urlM[0]}):\n${page}`;
    }
    if (!ctx) {
      const dec = await secretaryDecideSearch(text, chatId);
      if (dec && dec.search && dec.query) {
        const results = await webSearch(dec.query);
        if (results.length) ctx = '\n\nKết quả tra cứu web vừa thực hiện:\n' + results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\nNguồn: ${r.url}`).join('\n');
        else ctx = '\n\n(Vừa thử tra cứu web nhưng không lấy được kết quả. Hãy nói rõ lần này chưa tra cứu được; chỉ trả lời phần kiến thức chắc chắn và khuyên người dùng kiểm chứng lại các dữ kiện cụ thể.)';
      }
    }
    const prompt = `Bạn là "Bot Mặt trận Lạng Sơn" — thư ký AI hỗ trợ một nhóm công tác của Mặt trận Tổ quốc Việt Nam tỉnh Lạng Sơn trên Zalo.
Hãy trả lời bằng tiếng Việt, đúng mực, hữu ích; súc tích nhưng đủ ý; liệt kê bằng gạch đầu dòng khi cần; KHÔNG dùng bảng và không dùng ký hiệu ** (Zalo hiển thị xấu).
Nguyên tắc dữ kiện: số điện thoại, địa chỉ, tên người, ngày tháng, số liệu cụ thể CHỈ được lấy từ kết quả tra cứu hoặc nội dung trang kèm theo dưới đây (nếu có). Không có trong đó thì nói rõ là chưa có/chưa tra được — TUYỆT ĐỐI không bịa.
Nếu có dùng kết quả tra cứu, ghi nguồn ở cuối câu trả lời, mỗi nguồn một dòng dạng "Nguồn: <đường link>".
Nếu người dùng nhờ soạn thảo/dịch/tóm tắt thì làm luôn nội dung hoàn chỉnh để họ sao chép sử dụng.
Ghi việc và nhắc hạn do bộ phận khác của bot phụ trách; đừng tự hứa ghi việc tại đây.

Mạch hội thoại trước trong cuộc chat này:
${historyText(chatId)}

${fromName} vừa nhắn: "${text.replace(/"/g, '“')}"${ctx}

Hãy trả lời tin nhắn trên:`;
    const answer = await callGemini(prompt, false);
    if (!answer || !answer.trim()) return false;
    const out = answer.trim().slice(0, 7500);
    pushHistory(chatId, 'u', text);
    pushHistory(chatId, 'a', out);
    await send(chatId, out);
    console.log(`[Thư ký] chat=${chatId} đã trả lời (${out.length} ký tự)`);
    return true;
  } catch (e) { console.error('[Thư ký] Lỗi:', e.message); return false; }
}

// ============================== ĐĂNG BÀI QUA BOT (cầu nối với extension Chrome) ==============================
// Nhận diện lệnh đăng bài: có chữ "đăng bài"/"dang bai" kèm 1 đường link http(s).
// Trong chat RIÊNG, người có quyền chỉ cần gửi mỗi đường link cũng tính là lệnh đăng.
function parsePostCommand(text, isPrivate) {
  const urlM = String(text).match(/https?:\/\/[^\s)]+/);
  if (!urlM) return null;
  const isCmd = /(^|\s)(dang bai|đăng bài)(\s|:|$)/.test(foldVN(text));
  if (!isCmd && !(isPrivate && String(text).trim() === urlM[0])) return null;
  // Nơi đăng (v3.4): quét phần chữ NGOÀI đường link. "lên cổng / chỉ cổng / ttđt / web" → chỉ Cổng TTĐT;
  // "lên zalo / chỉ zalo" → chỉ Zalo OA; "cả hai" hoặc nhắc cả 2 nơi → cả hai; không nhắc gì → targets=null
  // (extension dùng lựa chọn gần nhất trong popup như trước). Token "cong" bị loại khi đi với "khai"
  // ("đăng bài công khai" là nói cách đăng, không phải nơi đăng).
  const words = foldVN(String(text).replace(urlM[0], ' '));
  const toks = words.split(/[^a-z0-9]+/).filter(Boolean);
  const congIdx = toks.indexOf('cong');
  const wantPortal = toks.includes('ttdt') || toks.includes('web') || words.includes('trang thong tin') || (congIdx >= 0 && toks[congIdx + 1] !== 'khai');
  const wantZalo = toks.includes('zalo');
  let targets = null;
  if (words.includes('ca hai') || (wantZalo && wantPortal)) targets = { mttq: true, zalo: true };
  else if (wantZalo) targets = { mttq: false, zalo: true };
  else if (wantPortal) targets = { mttq: true, zalo: false };
  return { url: urlM[0], targets };
}
function targetsLabel(t) {
  if (!t) return '';
  if (t.mttq && t.zalo) return 'cả Cổng TTĐT và Zalo OA';
  if (t.mttq) return 'chỉ Cổng TTĐT';
  if (t.zalo) return 'chỉ Zalo OA';
  return '';
}
let postSeq = Math.max(0, ...((store.postQueue || []).map((j) => j.id || 0)));
function posterNames() {
  return (store.posters || []).map((id) => (store.users[id] && store.users[id].name) || id).join(', ') || '(chưa có ai)';
}
// Xử lý 1 lệnh đăng bài. Trả về true nếu đã xử lý (kể cả khi từ chối vì chưa có quyền).
async function handlePostOrder(pc, chatId, fromName, userId) {
  // Chưa ai có quyền → người ra lệnh đầu tiên tự thành "chủ đăng bài" (bot vừa cài xong, chủ máy là người thử đầu tiên).
  if (!store.posters.length && userId) {
    store.posters.push(userId);
    saveStore();
    await send(chatId, `🔐 Bot ghi nhận ${fromName} là người đầu tiên ra lệnh đăng bài — từ nay chỉ những người được cấp quyền mới ra lệnh đăng được. Thêm người: nhắn riêng cho bot “thêm người đăng bài: <tên>”.`);
  }
  if (!userId || !store.posters.includes(userId)) {
    await send(chatId, `⛔ ${fromName} chưa có quyền ra lệnh đăng bài. Người có quyền hiện tại: ${posterNames()}.`);
    return true;
  }
  const job = { id: ++postSeq, url: pc.url, targets: pc.targets || null, by: fromName, byId: userId, chatId, at: new Date().toISOString(), status: 'queued' };
  store.postQueue.push(job);
  saveStore();
  console.log(`[Đăng bài] Nhận lệnh #${job.id} từ ${fromName}: ${pc.url}${job.targets ? ' — nơi đăng: ' + targetsLabel(job.targets) : ''}`);
  await send(chatId, `📰 Đã nhận lệnh đăng bài (số ${job.id}):\n${pc.url}${job.targets ? '\nNơi đăng: ' + targetsLabel(job.targets) : ''}\nBài đang chờ extension trên máy tính xử lý — đăng xong bot sẽ báo ngay tại đây. Nếu máy tính/Chrome chưa mở thì lệnh vẫn nằm chờ, mở lên là chạy.`);
  return true;
}
// Extension báo kết quả 1 lệnh đăng → bot nhắn kết quả vào đúng cuộc chat đã ra lệnh.
async function reportPostResult(job, payload) {
  const st = (v) => v === 'ok' ? '✔ Xong' : v === 'duplicate' ? '⏭ Đã có bài này' : v === 'skipped' ? '⏭ Chưa chạy' : '✖ Chưa xong';
  const lines = [`📰 Kết quả đăng bài (lệnh ${job.id})${payload && payload.title ? `\nBài: ${payload.title}` : ''}`];
  if (payload && payload.mttq) lines.push(`Cổng MTTQ: ${st(payload.mttq)}${payload.mttqUrl ? ' — ' + payload.mttqUrl : ''}`);
  if (payload && payload.zalo) lines.push(`Zalo OA: ${st(payload.zalo)}`);
  if (!payload || (!payload.mttq && !payload.zalo)) lines.push('✖ Extension không gửi được kết quả chi tiết — kiểm tra bảng tiến trình trên trình duyệt.');
  try { await send(job.chatId, lines.join('\n')); } catch (e) { console.error('[Đăng bài] Báo kết quả lỗi:', e.message); }
}
// Link dán vào Zalo KHÔNG đến dạng tin văn bản: Zalo phát sự kiện "message.unsupported.received"
// với text rỗng, đường link nằm sâu trong payload. Hàm này moi đường link ra: ưu tiên các vị trí
// quen thuộc (links[0].link/url, link, url, href), không thấy thì quét đệ quy lấy URL đầu tiên
// không phải link ảnh (bỏ qua ảnh xem trước .jpg/.png...).
function isImageUrl(u) { return /\.(jpe?g|png|gif|webp|bmp|svg)(\?|#|$)/i.test(u); }
function findSharedLink(message) {
  if (!message || typeof message !== 'object') return '';
  const first = Array.isArray(message.links) ? message.links[0] : null;
  const direct = [first && first.link, first && first.url, message.link, message.url, message.href];
  for (const c of direct) if (typeof c === 'string' && /^https?:\/\//i.test(c) && !isImageUrl(c)) return c;
  let found = '';
  (function walk(o, d) {
    if (found || d > 4 || !o || typeof o !== 'object') return;
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && /^https?:\/\//i.test(v) && !isImageUrl(v)) { found = v; return; }
      if (v && typeof v === 'object') { walk(v, d + 1); if (found) return; }
    }
  })(message, 0);
  return found;
}
// Sự kiện unsupported ở CHAT RIÊNG mà moi được link → coi như lệnh đăng bài (như gửi mỗi link dạng chữ).
// Trong nhóm thì bỏ qua: ở nhóm phải gõ chữ "đăng bài: <link>" để tránh ai chia sẻ link chơi cũng thành lệnh.
// THỰC TẾ (chạy thật 16/11): payload của sự kiện unsupported RỖNG nội dung — chỉ có chat/message_id/date/from,
// Zalo không đưa link/ảnh/file cho bot xem. Moi được link chỉ là phòng xa; trường hợp thường gặp là
// không có gì để moi → bot nhắn gợi ý (tối đa 1 lần/10 phút/chat riêng) để người gửi biết mà gửi lại dạng chữ.
const unsupportedHintAt = {};
async function handleUnsupported(msg) {
  const chatId = String(msg.chat?.id ?? '');
  const fromName = msg.from?.display_name || 'Một thành viên';
  const userId = String(msg.from?.id ?? '');
  const url = findSharedLink(msg);
  if (!url) {
    console.log('[tin unsupported] payload không có nội dung để đọc:', JSON.stringify(msg).slice(0, 600));
    const last = unsupportedHintAt[chatId] || 0;
    if (msg.chat?.chat_type === 'PRIVATE' && chatId && Date.now() - last > 10 * 60 * 1000) {
      unsupportedHintAt[chatId] = Date.now();
      await send(chatId, 'Tin đính kèm kiểu này (link / ảnh / file) thì Zalo không cho bot xem nội dung — em chỉ đọc được tin chữ thôi ạ.\n• Muốn đăng bài: gửi dạng chữ “đăng bài: <dán link vào đây>”.\n• Muốn em đọc hay tóm tắt một trang: cũng dán link vào trong câu chữ giúp em nhé.');
    }
    return;
  }
  console.log('[tin unsupported] link chia sẻ:', url);
  if (msg.chat?.chat_type !== 'PRIVATE' || !chatId) return;
  if (userId) {
    const u = store.users[userId] || (store.users[userId] = { name: fromName, privateChatId: null });
    u.name = fromName;
    u.privateChatId = chatId;
    u.lastSeen = new Date().toISOString();
    saveStore();
  }
  await handlePostOrder({ url }, chatId, fromName, userId);
}

// Máy chủ nhỏ chỉ nghe trong máy (127.0.0.1) để extension Chrome lấy lệnh đăng và báo kết quả.
// Chìa khóa là file bridge-secret.txt cạnh bot.js — dán 1 lần vào Cài đặt của extension.
function startBridge() {
  const http = require('http');
  const crypto = require('crypto');
  const secretFile = path.join(__dirname, 'bridge-secret.txt');
  let secret = '';
  try { secret = fs.readFileSync(secretFile, 'utf8').split(/\r?\n/)[0].trim(); } catch { secret = ''; }
  if (!secret) {
    secret = crypto.randomBytes(12).toString('hex');
    try { fs.writeFileSync(secretFile, secret + '\n'); } catch (e) { console.error('[Cầu nối] Không ghi được bridge-secret.txt:', e.message); }
  }
  const server = http.createServer((req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-bridge-secret'] !== secret) { reply(403, { ok: false, error: 'bad secret' }); return; }
    bridgeWatch.lastPollAt = Date.now(); // Trực ban Chrome (v3.5): extension vừa ghé — ghi nhận nó còn sống.
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/jobs') {
      // Lệnh "đang chạy" quá 45 phút mà chưa có kết quả → coi như extension gặp sự cố, đưa về hàng chờ.
      let changed = false;
      const nowMs = Date.now();
      for (const j of store.postQueue) {
        if (j.status === 'running' && j.handedAt && nowMs - Date.parse(j.handedAt) > 45 * 60 * 1000) { j.status = 'queued'; delete j.handedAt; changed = true; }
      }
      const jobs = store.postQueue.filter((j) => j.status === 'queued').map((j) => ({ id: j.id, url: j.url, targets: j.targets || null, by: j.by, at: j.at }));
      if (changed) saveStore();
      reply(200, { ok: true, jobs });
      return;
    }
    const mTake = u.pathname.match(/^\/jobs\/(\d+)\/take$/);
    if (req.method === 'POST' && mTake) {
      const job = store.postQueue.find((j) => j.id === Number(mTake[1]));
      if (!job || job.status !== 'queued') { reply(409, { ok: false, error: 'job not available' }); return; }
      job.status = 'running';
      job.handedAt = new Date().toISOString();
      saveStore();
      reply(200, { ok: true });
      return;
    }
    const mDone = u.pathname.match(/^\/jobs\/(\d+)\/(done|fail)$/);
    if (req.method === 'POST' && mDone) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
      req.on('end', async () => {
        const job = store.postQueue.find((j) => j.id === Number(mDone[1]));
        if (!job) { reply(404, { ok: false, error: 'no such job' }); return; }
        if (job.status === 'done' || job.status === 'failed') { reply(200, { ok: true, already: true }); return; }
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
        job.status = mDone[2] === 'done' ? 'done' : 'failed';
        job.finishedAt = new Date().toISOString();
        job.result = payload;
        saveStore();
        reply(200, { ok: true });
        console.log(`[Đăng bài] Lệnh #${job.id} ${job.status === 'done' ? 'hoàn thành' : 'thất bại'}`);
        if (job.status === 'done') await reportPostResult(job, payload);
        else { try { await send(job.chatId, `📰 Lệnh đăng bài ${job.id} không chạy được: ${payload.error || 'extension báo lỗi không rõ'}\n${job.url}`); } catch (e) { /* bỏ qua */ } }
      });
      return;
    }
    reply(404, { ok: false, error: 'not found' });
  });
  server.on('error', (e) => console.error('[Cầu nối] Lỗi máy chủ nhỏ:', e.message));
  server.listen(CONFIG.bridgePort, '127.0.0.1', () => {
    console.log(`[Cầu nối] Đang nghe lệnh đăng bài cho extension ở 127.0.0.1:${CONFIG.bridgePort} — mã cầu nối nằm trong file bridge-secret.txt cạnh bot.js (dán 1 lần vào Cài đặt của extension).`);
  });
  // Cổng cầu nối đang bận = gần như chắc chắn đã có một tiến trình bot khác đang chạy
  // (hai bot cùng nghe tin Zalo sẽ tranh nhau tin nhắn). Thử lại 1 lần sau 5 giây
  // (tránh đúng khoảnh khắc chuyển giao khi tự cập nhật), vẫn bận thì thoát.
  let bridgeRetries = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && bridgeRetries < 1) {
      bridgeRetries++;
      console.error(`[Cầu nối] Cổng ${CONFIG.bridgePort} đang bận — thử nghe lại sau 5 giây…`);
      setTimeout(() => server.listen(CONFIG.bridgePort, '127.0.0.1'), 5000);
    } else if (e.code === 'EADDRINUSE') {
      console.error('[Cầu nối] Cổng vẫn bận — bot có thể đang chạy ở một cửa sổ/tiến trình khác. Tiến trình này thoát để tránh hai bot cùng nghe tin.');
      process.exit(1);
    } else console.error('[Cầu nối] Lỗi máy chủ:', e.message);
  });
}

// ============================== TRỰC BAN CHROME (v3.5) ==============================
// Bệnh cũ: bot nhận lệnh đăng bài nhưng Chrome đang tắt/ngủ thì extension không bao giờ
// tới lấy lệnh — lệnh nằm chờ im lặng. Từ v3.5 bot tự trông: extension mỗi phút ghé cầu
// nối 1 lần (mốc lastPollAt). Có lệnh chờ mà extension vắng mặt quá lâu thì:
//   - Chrome đang tắt → bot tự mở Chrome dạng THU NHỎ (chỉ hiện biểu tượng ở taskbar,
//     không bật cửa sổ, không cướp màn hình người đang làm việc);
//   - Chrome đang mở mà lệnh chờ >10 phút vẫn không ai nhận → nhắn cảnh báo 1 lần vào
//     đúng chat đã ra lệnh (nghi extension bị tắt/gỡ — bot không tự bật lại extension được).
// Chỉ chạy trên Windows (máy của chủ bot); hệ điều hành khác thì bỏ qua lặng lẽ.
const { execFile, exec, spawn } = require('child_process');
const bridgeWatch = { lastPollAt: 0, lastLaunchAt: 0 };
// Hàm quyết định THUẦN (có kiểm thử): nhìn đồng hồ + sổ ghé thăm → hành động.
function watchdogDecision(o) {
  if (!o.jobAtMs) return 'none';
  const age = o.nowMs - o.jobAtMs;
  if (age < CONFIG.watchdogStaleMs) return 'none';                       // lệnh còn mới — cho extension nhịp của nó
  if (o.lastPollAt && o.nowMs - o.lastPollAt < CONFIG.watchdogStaleMs) return 'none'; // extension vừa ghé — nó còn sống
  if (o.chromeRunning === false) return o.nowMs - (o.lastLaunchAt || 0) > CONFIG.watchdogRelaunchMs ? 'launch' : 'none';
  if (age > CONFIG.watchdogWarnMs && !o.warned) return 'warn';
  return 'none';
}
function chromeExePath() {
  const cands = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
function isChromeRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null); // không rõ → coi như không biết, tránh mở thừa
      resolve(/chrome\.exe/i.test(String(stdout)));
    });
  });
}
function launchChromeMinimized() {
  const exe = chromeExePath();
  if (!exe) { console.log('[Trực ban] Không tìm thấy chrome.exe ở các đường dẫn quen thuộc — bỏ qua lần này.'); return false; }
  try {
    exec(`start /min "" "${exe}"`, { windowsHide: true }, (e) => { if (e) console.error('[Trực ban] Mở Chrome lỗi:', e.message); });
    return true;
  } catch (e) { console.error('[Trực ban] Mở Chrome lỗi:', e.message); return false; }
}
async function watchdogTick(now) {
  try {
    if (process.platform !== 'win32') return;
    const queued = (store.postQueue || []).filter((j) => j.status === 'queued');
    if (!queued.length) return;
    const job = queued[0];
    const nowMs = now.getTime();
    const jobAtMs = Date.parse(job.at) || nowMs;
    if (nowMs - jobAtMs < CONFIG.watchdogStaleMs) return;                              // lệnh còn mới
    if (bridgeWatch.lastPollAt && nowMs - bridgeWatch.lastPollAt < CONFIG.watchdogStaleMs) return; // extension còn sống
    const chromeRunning = await isChromeRunning();
    const act = watchdogDecision({ nowMs, jobAtMs, lastPollAt: bridgeWatch.lastPollAt, lastLaunchAt: bridgeWatch.lastLaunchAt, chromeRunning, warned: !!job.watchdogWarned });
    if (act === 'launch') {
      if (launchChromeMinimized()) {
        bridgeWatch.lastLaunchAt = nowMs;
        console.log(`[Trực ban] Lệnh đăng #${job.id} đang chờ mà Chrome đang tắt — đã tự mở Chrome (thu nhỏ).`);
      }
    } else if (act === 'warn') {
      job.watchdogWarned = true;
      saveStore();
      console.log(`[Trực ban] Lệnh đăng #${job.id} chờ >10 phút, extension chưa nhận — đã nhắn cảnh báo.`);
      await send(job.chatId, `⚠️ Lệnh đăng bài số ${job.id} đã chờ hơn 10 phút mà extension chưa nhận.\n${job.url}\nChrome có thể đang mở nhưng extension bị tắt/gỡ, hoặc mã cầu nối bị lệch. Anh kiểm tra Chrome + extension giúp em — lệnh vẫn nằm chờ, xử lý xong là nó tự chạy tiếp.`).catch((e) => console.error('[Trực ban] Gửi cảnh báo lỗi:', e.message));
    }
  } catch (e) { console.error('watchdogTick:', e.message); }
}

// ============================== TỰ CẬP NHẬT (v3.6) ==============================
// Luồng: kiểm tra version.json trên kho GitHub → có bản mới thì tải từng file về thư mục
// update-staging, đối chiếu mã băm SHA-256 trong bản kê (sai một file là hủy, thử lại sau),
// kiểm tra cú pháp bản bot.js mới → ghi update-pending.json → gọi updater.js (tiến trình
// riêng) rồi tự thoát. updater.js sao lưu bản hiện tại vào backup/v<bản cũ>, thay file,
// khởi động bot mới và theo dõi: bot mới ghi update-state.json "ok" đúng phiên bản trong
// thời hạn thì xong; không thì updater khôi phục bản sao lưu, chạy lại bản cũ và ghi
// update-rollback.json để bản cũ nhắn báo cho chủ bot khi nó lên.
// TUYỆT ĐỐI không cập nhật các file dữ liệu/bí mật: token.txt, ai-key.txt,
// bridge-secret.txt, data/ — bản kê chỉ được liệt kê file chương trình (bot.js là chính),
// và updater.js không bao giờ nằm trong danh sách tự cập nhật.
const updateStagingDir = path.join(__dirname, 'update-staging');
const updateStateFile = path.join(__dirname, 'update-state.json');
const updatePendingFile = path.join(__dirname, 'update-pending.json');
const updateRollbackFile = path.join(__dirname, 'update-rollback.json');
const updateFailedFile = path.join(__dirname, 'update-failed.json'); // phiên bản đã từng lỗi lúc khởi động — không thử lại nữa, chờ bản cao hơn
let lastUpdateCheckAt = 0;
let updateInProgress = false;
let inFlightMessages = 0; // số tin đang xử lý dở — chờ về 0 mới thoát để cập nhật

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
// Bản kê hợp lệ: có phiên bản dạng x.y.z và ít nhất 1 file, tên file "sạch" (không chui ra
// khỏi thư mục bot), mỗi file có mã băm SHA-256 đủ 64 ký tự hex.
function validManifest(m) {
  if (!m || typeof m !== 'object') return false;
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version || ''))) return false;
  const files = m.files;
  if (!files || typeof files !== 'object' || !Object.keys(files).length) return false;
  return Object.entries(files).every(([name, f]) => /^[\w][\w.\-]*$/.test(name) && !name.includes('..') && name !== 'updater.js' && f && /^[0-9a-f]{64}$/.test(String(f.sha256 || '')));
}
function isFailedVersion(failed, version) { return !!failed && failed.version === version; }
function writeUpdateState(status) {
  try { fs.writeFileSync(updateStateFile, JSON.stringify({ status, version: BOT_VERSION, pid: process.pid, at: new Date().toISOString() })); } catch {}
}
function readJsonFile(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
async function fetchBuf(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'MTTQ-Bot-Updater' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(timer); }
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Kiểm tra + thực hiện cập nhật. manualChatId != null khi chủ bot gõ "bot, kiểm tra cập nhật"
// (bot trả lời kết quả vào chat đó). Trả về: 'uptodate' | 'updating' | 'error' | 'busy'.
async function checkForUpdate(manualChatId) {
  if (updateInProgress) { if (manualChatId) await send(manualChatId, 'Đang có một đợt kiểm tra cập nhật chạy dở — anh đợi chút nhé.').catch(() => {}); return 'busy'; }
  updateInProgress = true;
  try {
    const raw = await fetchBuf(CONFIG.updateManifestUrl + (CONFIG.updateManifestUrl.includes('?') ? '&' : '?') + 't=' + Date.now());
    const m = JSON.parse(raw.toString('utf8'));
    if (!validManifest(m)) throw new Error('bản kê cập nhật không hợp lệ');
    if (cmpVersion(m.version, BOT_VERSION) <= 0) {
      console.log(`[Cập nhật] Đang ở bản mới nhất (v${BOT_VERSION}).`);
      if (manualChatId) await send(manualChatId, `Bot đang ở bản mới nhất rồi (v${BOT_VERSION}).`).catch(() => {});
      return 'uptodate';
    }
    // Bản đã từng lỗi lúc khởi động (đã quay lui một lần) thì KHÔNG thử lại — tránh vòng lặp
    // cập nhật → lỗi → quay lui → lại cập nhật. Bản sửa phải mang số phiên bản cao hơn.
    if (isFailedVersion(readJsonFile(updateFailedFile), m.version)) {
      console.log(`[Cập nhật] Bản v${m.version} đã từng lỗi khi khởi động — bỏ qua, chờ bản cao hơn.`);
      if (manualChatId) await send(manualChatId, `Bản v${m.version} đã từng lỗi khi khởi động nên bot đang bỏ qua bản đó (vẫn chạy v${BOT_VERSION}). Khi nào có bản cao hơn bot sẽ tự lên.`).catch(() => {});
      return 'skipped-failed';
    }
    console.log(`[Cập nhật] Có bản mới v${m.version} (đang chạy v${BOT_VERSION}) — tự tải về…`);
    if (manualChatId) await send(manualChatId, `Có bản mới v${m.version} — bot đang tự cập nhật và sẽ khởi động lại trong ít giây.${m.notes ? `\nNội dung: ${m.notes}` : ''}`).catch(() => {});
    // Tải từng file vào thư mục chờ, đối chiếu mã băm ngay tại chỗ.
    fs.rmSync(updateStagingDir, { recursive: true, force: true });
    fs.mkdirSync(updateStagingDir, { recursive: true });
    for (const [name, f] of Object.entries(m.files)) {
      const buf = await fetchBuf(CONFIG.updateFilesBase + name + '?t=' + Date.now());
      if (sha256hex(buf) !== String(f.sha256)) throw new Error(`mã băm của ${name} không khớp — hủy cập nhật, lần sau thử lại`);
      fs.writeFileSync(path.join(updateStagingDir, name), buf);
    }
    // Kiểm tra cú pháp bản bot.js mới TRƯỚC khi thay — chặn phần lớn cập nhật lỗi ngay từ đây.
    const stagedBot = path.join(updateStagingDir, 'bot.js');
    if (fs.existsSync(stagedBot)) {
      await new Promise((resolve, reject) => {
        execFile(process.execPath, ['--check', stagedBot], (e) => (e ? reject(new Error('bot.js mới lỗi cú pháp — hủy cập nhật')) : resolve()));
      });
    }
    // Bàn giao cho updater.js rồi thoát (chờ tin đang xử lý dở kết thúc, tối đa 20 giây).
    fs.writeFileSync(updatePendingFile, JSON.stringify({ fromVersion: BOT_VERSION, toVersion: m.version, notes: m.notes || '', pid: process.pid, at: new Date().toISOString() }));
    const child = spawn(process.execPath, [path.join(__dirname, 'updater.js')], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log('[Cập nhật] Đã bàn giao cho updater.js — bot thoát để thay bản mới.');
    const t0 = Date.now();
    while (inFlightMessages > 0 && Date.now() - t0 < 20000) await sleepMs(500);
    process.exit(0);
  } catch (e) {
    console.error('[Cập nhật] Lỗi:', e.message);
    try { fs.rmSync(updateStagingDir, { recursive: true, force: true }); } catch {}
    if (manualChatId) await send(manualChatId, `Em kiểm tra cập nhật nhưng gặp lỗi: ${e.message}. Bot vẫn chạy bản v${BOT_VERSION} bình thường.`).catch(() => {});
    return 'error';
  } finally { updateInProgress = false; }
}

// Sau khi khởi động ổn định: báo kết quả cập nhật (thành công / đã quay lui) cho chủ bot.
async function notifyUpdateOutcome() {
  const target = (store.posters && store.posters[0]) || Object.keys(store.chats || {})[0];
  const rb = readJsonFile(updateRollbackFile);
  if (rb) {
    try { fs.rmSync(updateRollbackFile); } catch {}
    console.log(`[Cập nhật] Đã quay lui: bản v${rb.failedVersion} lỗi → đang chạy v${rb.backTo}.`);
    if (target) await send(target, `⚠️ Bản bot v${rb.failedVersion} bị lỗi khi khởi động nên bot đã TỰ QUAY VỀ bản v${rb.backTo} và đang chạy bình thường. Anh không cần làm gì — Muse sẽ kiểm tra lại bản mới trước khi phát hành lại.`).catch(() => {});
    return;
  }
  const pd = readJsonFile(updatePendingFile);
  if (pd) {
    try { fs.rmSync(updatePendingFile); } catch {}
    if (pd.toVersion === BOT_VERSION) {
      const failed = readJsonFile(updateFailedFile);
      if (failed && failed.version !== BOT_VERSION) { try { fs.rmSync(updateFailedFile); } catch {} } // đã qua được bản khác — dọn sổ đen cũ
      console.log(`[Cập nhật] Đã lên bản v${BOT_VERSION} thành công.`);
      if (target) await send(target, `✅ Bot đã tự cập nhật lên bản v${BOT_VERSION} và chạy ổn định.${pd.notes ? `\nNội dung bản mới: ${pd.notes}` : ''}`).catch(() => {});
    } else {
      console.log('[Cập nhật] Còn sót update-pending.json không khớp phiên bản — đã dọn.');
    }
  }
}
// Chỉ tính khi /start đứng đầu câu, hoặc là từ đầu tiên sau khối @gọi tên — tránh nuốt nhầm nội dung việc có chứa "/start".
function isStartCommand(text) {
  const t = (text || '').trim();
  if (/^\/start(\s|$)/i.test(t)) return true;
  if (t.startsWith('@')) return /^@[^\n]*?\/start(\s|$)/i.test(t);
  return false;
}

const HELP = `Cách dùng Bot Báo việc:
• Nói tự nhiên (khi bot có AI): cứ nhắn như nói chuyện — “mai 9h nhắc tao họp giao ban”, “ghi việc soạn công văn giao cho chị Lan trước thứ 5”, “tuần này còn việc gì chưa xong?” — bot tự hiểu.
• Thư ký AI: hỏi kiến thức, tra cứu thông tin (số điện thoại cơ quan, quy định, tin tức…), nhờ soạn thảo/dịch/tóm tắt (dán cả đường link bài viết vào cũng được) — cứ @gọi bot rồi hỏi như hỏi người.
• Đăng bài lên cổng + Zalo OA (chỉ người có quyền): “đăng bài: <link bài>” — bot chuyển lệnh cho extension trên máy tính đăng hộ, xong báo lại tại đây. Muốn đăng MỘT nơi thì nói rõ: “đăng bài lên cổng: <link>” (chỉ trang TTĐT) hoặc “đăng bài lên zalo: <link>” (chỉ Zalo OA); không nói thì đăng theo lựa chọn đang đặt trong extension. Chat riêng với bot thì chỉ cần gửi mỗi đường link.
• Nhắc nhanh: “nhắc tao, 2 phút nữa đi ngủ” — bot nhắc đúng giờ hẹn, kể cả ngoài giờ hành chính
• Ghi việc: “bot, ghi việc: Nộp báo cáo TTND, hạn thứ 6 17h”
• Việc lặp: “bot, ghi việc lặp: Họp giao ban, thứ 2 hằng tuần 8h” (hoặc “ngày 25 hằng tháng”, “hằng ngày”) — báo xong hoặc qua hạn là bot tự sinh kỳ sau; muốn dừng chuỗi thì xóa việc đang mở của chuỗi đó
• Đăng bài mà Chrome đang tắt: bot tự mở Chrome dạng thu nhỏ cho extension chạy, anh không phải mở sẵn; lệnh kẹt quá 10 phút bot sẽ nhắn cảnh báo
• Phiên bản: “bot, phiên bản” — bot tự cập nhật khi có bản mới; muốn kiểm tra ngay: “bot, kiểm tra cập nhật”
• Giao cho người khác: “bot, ghi việc giao cho anh Tùng: Kiểm tra máy in, hạn mai 9h”
• Xem việc: “bot, việc”
• Bản tin sáng: mỗi sáng thứ 2–6 lúc 07:45 bot tự gửi việc đến hạn hôm nay + việc quá hạn; gọi “bot, việc hôm nay” để xem ngay lúc nào cũng được
• Xong việc: “bot, xong 2” (số theo danh sách)
• Đổi hạn: “bot, sửa hạn 2 sang thứ 3 tuần sau” — viết: “bot, sửa hạn 2 thứ 3”
• Xóa việc: “bot, xóa 2”
• Nhận nhắc RIÊNG: gọi “@Bot … /start” ngay trong nhóm (hoặc nhắn /start ở chat riêng với bot) — chỉ 1 lần duy nhất, từ đó việc giao cho bạn sẽ được bot nhắn riêng vào chat cá nhân mỗi lần tới hạn (kèm bản trong nhóm).
Bot tự nhắc trước hạn 1 ngày, sáng ngày đến hạn và trước 1 giờ — chỉ trong giờ hành chính (Thứ 2–6, 07:30–11:30 & 13:30–17:30). Việc quá hạn sẽ bị nhắc lại mỗi sáng ngày làm việc cho tới khi báo xong.`;

async function handleMessage(msg) {
  const chatId = String(msg.chat?.id ?? '');
  const fromName = msg.from?.display_name || 'Một thành viên';
  const userId = String(msg.from?.id ?? '');
  const text = (msg.text || '').trim();
  if (!chatId || !text) return;
  const now = new Date();

  // Ghi nhớ người dùng: ai từng chat RIÊNG với bot thì lưu địa chỉ chat riêng (để nhắc riêng khi họ được giao việc).
  // Chỉ cần làm 1 lần — thông tin lưu trên đĩa, bot khởi động lại vẫn nhớ.
  if (userId) {
    const u = store.users[userId] || (store.users[userId] = { name: fromName, privateChatId: null });
    u.name = fromName;
    if (msg.chat?.chat_type === 'PRIVATE') u.privateChatId = chatId;
    u.lastSeen = now.toISOString();
    saveStore();
  }

  // /start — câu chào + "đăng ký" nhận nhắc riêng. Trong nhóm, tin có dạng "@Bot … /start"
  // nên phải nhận diện /start ở bất kỳ vị trí nào sau phần @gọi tên, không chỉ đầu câu.
  if (isStartCommand(text)) {
    if (msg.chat?.chat_type === 'PRIVATE') {
      await send(chatId, `Xin chào ${fromName}! Mình là Bot Mặt trận Lạng Sơn — ghi việc và nhắc hạn cho nhóm.\n✅ Đã ghi nhớ bạn: từ nay việc được giao cho bạn sẽ được bot nhắn nhắc riêng vào đây khi tới hạn.\nGọi “bot, trợ giúp” để xem cách dùng.`);
      return;
    }
    // Trong NHÓM: bot thử tự mở chat riêng cho người gọi bằng 1 tin chào.
    // Mở được → đăng ký xong ngay tại nhóm; không được → hướng dẫn vào chat riêng /start 1 lần.
    let okDm = false;
    if (userId) {
      try {
        await send(userId, `Xin chào ${fromName}! Mình là Bot Mặt trận Lạng Sơn. Bạn đã được đăng ký nhận nhắc riêng: từ nay việc giao cho bạn, bot sẽ nhắn vào đây khi tới hạn.`);
        okDm = true;
        const u = store.users[userId];
        if (u && !u.privateChatId) { u.privateChatId = userId; saveStore(); }
      } catch (e) { console.error('DM /start trong nhóm:', e.message); }
    }
    await send(chatId, okDm
      ? `✅ Đã đăng ký nhắc riêng cho ${fromName} — mình vừa nhắn vào chat riêng của bạn, kiểm tra nhé!`
      : `Xin chào ${fromName}! Mình chưa tự nhắn riêng cho bạn được. Bạn chạm vào tên bot → mở chat riêng → nhắn /start một lần giúp mình nhé.`);
    return;
  }

  // Đang chờ bổ sung hạn cho một việc vừa ghi thiếu hạn?
  const pKey = `${chatId}|${userId}`;
  if (store.pending[pKey]) {
    const p = parseDeadline(foldVN(text), now);
    if (p) {
      const pending = store.pending[pKey];
      delete store.pending[pKey];
      await createTaskWithNotes(chatId, fromName, userId, { ...pending, due: p.due });
      return;
    }
  }

  // Lệnh đăng bài (v3.2): nhận diện bằng luật cứng, xử lý TRƯỚC lớp AI — lệnh đăng không được phép mơ hồ.
  const pc = parsePostCommand(text, msg.chat?.chat_type === 'PRIVATE');
  if (pc) { await handlePostOrder(pc, chatId, fromName, userId); return; }
  // Chủ đăng bài cấp thêm quyền qua chat riêng: "thêm người đăng bài: <tên>"
  const addPosterM = foldVN(text).match(/them nguoi dang bai\s*:\s*(.+)$/);
  if (addPosterM && msg.chat?.chat_type === 'PRIVATE' && userId && store.posters.includes(userId)) {
    const found = findUserByName(addPosterM[1].trim(), store.users);
    if (found && found.user) {
      if (!store.posters.includes(found.user.id)) { store.posters.push(found.user.id); saveStore(); }
      await send(chatId, `✅ Đã cấp quyền đăng bài cho ${found.user.name}. Danh sách hiện tại: ${posterNames()}.`);
    } else {
      await send(chatId, 'Mình chưa nhận diện được người đó — họ cần nhắn riêng /start cho bot một lần trước, rồi bạn cấp quyền lại nhé.');
    }
    return;
  }

  const cmd = parseCommand(text, now);
  console.log(`[lệnh] chat=${chatId} → ${cmd.type}`);
  // Lệnh cứng rõ ràng thì chạy ngay (nhanh, miễn phí). Câu mơ hồ / nói tự nhiên / hỏi đáp → nhờ AI hiểu trước;
  // AI lỗi hoặc không có khóa thì quay về hành vi lệnh cứng như cũ.
  const ruleStrong = ['help', 'list', 'briefing', 'done', 'delete', 'redue', 'remind'].includes(cmd.type) || (cmd.type === 'add' && !!cmd.due);
  if (!ruleStrong && AI_KEY) {
    if (await handleViaAI(text, chatId, fromName, userId, pKey, now)) return;
  }
  switch (cmd.type) {
    case 'help': await send(chatId, HELP); break;
    case 'remind': {
      const task = {
        seq: ++seq, title: cmd.title, assignee: fromName, assigneeId: userId || null, due: cmd.due.toISOString(),
        createdBy: fromName, createdAt: now.toISOString(), done: false, exact: true,
        reminders: [{ at: cmd.due.toISOString(), sent: false }], overdueLast: null,
      };
      (store.chats[chatId] = store.chats[chatId] || []).push(task);
      saveStore();
      await send(chatId, `⏰ Ok! Đúng ${fmtDT(cmd.due)} mình sẽ nhắc: ${task.title}`);
      break;
    }
    case 'list': await send(chatId, listText(chatId)); break;
    case 'briefing': { const t = briefingText(chatId, now); await send(chatId, t || 'Hôm nay không có việc nào đến hạn, cũng không có việc quá hạn.'); break; }
    case 'version': await send(chatId, `🤖 Bot Mặt trận Lạng Sơn — phiên bản v${BOT_VERSION}.\nBot tự kiểm tra bản mới mỗi 6 giờ và tự cập nhật khi có; cần kiểm tra ngay thì gọi “bot, kiểm tra cập nhật”.`); break;
    case 'update': checkForUpdate(chatId).catch((e) => console.error('[Cập nhật] Lỗi:', e.message)); break;
    case 'add': {
      if (!cmd.title) { await send(chatId, 'Anh/chị muốn ghi việc gì? Ví dụ: “bot, ghi việc: Nộp báo cáo, hạn thứ 6”.'); break; }
      if (!cmd.due) {
        store.pending[pKey] = { title: cmd.title, assignee: cmd.assignee, recur: cmd.recur || null };
        saveStore();
        await send(chatId, `Đã nhận việc “${cmd.title}” nhưng chưa rõ hạn. Hạn lúc nào anh/chị? (ví dụ: “mai 9h”, “thứ 6 17h”, “25/11”)`);
        break;
      }
      await createTaskWithNotes(chatId, fromName, userId, cmd);
      break;
    }
    case 'done': case 'delete': {
      const list = openTasks(chatId).sort((a, b) => new Date(a.due) - new Date(b.due));
      const task = list[cmd.n - 1];
      if (!task) { await send(chatId, `Không thấy việc số ${cmd.n} trong danh sách đang mở. Gọi “bot, việc” để xem lại.`); break; }
      if (cmd.type === 'done') { task.done = true; task.doneAt = new Date().toISOString(); const nt = spawnNext(chatId, task, new Date()); saveStore(); await send(chatId, `🎉 Đã xong: ${task.title}. Cảm ơn anh/chị!${nt ? `\n🔁 Đã sinh kỳ sau (${task.recur.label}): hạn ${fmtDT(new Date(nt.due))}.` : ''}`); }
      else { store.chats[chatId] = store.chats[chatId].filter((t) => t.seq !== task.seq); saveStore(); await send(chatId, `🗑 Đã xóa việc: ${task.title}.`); }
      break;
    }
    case 'redue': {
      const list = openTasks(chatId).sort((a, b) => new Date(a.due) - new Date(b.due));
      const task = list[cmd.n - 1];
      if (!task) { await send(chatId, `Không thấy việc số ${cmd.n}.`); break; }
      task.due = cmd.due.toISOString();
      task.reminders = planReminders(cmd.due, now).map((d) => ({ at: d.toISOString(), sent: false }));
      task.overdueLast = null;
      saveStore();
      await send(chatId, `✅ Đã đổi hạn việc “${task.title}” → ${fmtDT(cmd.due)}.`);
      break;
    }
    default:
      await send(chatId, 'Em chưa hiểu lệnh này. Gọi “bot, trợ giúp” để xem cách dùng nhé.');
  }
}

// ============================== VÒNG NHẮC HẠN ==============================
async function reminderTick() {
  const now = new Date();
  await morningBriefingTick(now);
  await watchdogTick(now);
  // Tự cập nhật (v3.6): tới hạn 6 giờ thì kiểm tra bản mới 1 lần (lần đầu do main() gọi lúc khởi động).
  if (Date.now() - lastUpdateCheckAt > CONFIG.updateCheckMs) { lastUpdateCheckAt = Date.now(); checkForUpdate(null).catch((e) => console.error('[Cập nhật] Lỗi:', e.message)); }
  let changed = false;
  for (const chatId of Object.keys(store.chats)) {
    for (const task of store.chats[chatId]) {
      if (task.done) continue;
      // Nhắc nhanh (kiểu "nhắc tao X phút nữa"): bắn đúng giờ hẹn, kể cả ngoài giờ hành chính, bắn 1 lần là xong.
      if (task.exact) {
        const r = task.reminders[0];
        if (r && !r.sent && +now >= +new Date(r.at)) {
          r.sent = true; task.done = true; task.doneAt = now.toISOString(); changed = true;
          const txt = `⏰ Tới giờ rồi!\n📌 ${task.title}\n👤 ${task.assignee}`;
          await send(chatId, txt).catch((e) => console.error('send exact reminder:', e.message));
          await dmCopy(chatId, task, txt);
        }
        continue;
      }
      // Việc lặp (v3.5): qua hạn mà chưa sinh kỳ sau thì sinh ngay, kể cả chưa ai báo xong —
      // chuỗi việc không được đứt chỉ vì một kỳ bị bỏ quên.
      if (task.recur && !task.spawnedNext && +new Date(task.due) <= +now) { spawnNext(chatId, task, now); changed = true; }
      const due = new Date(task.due);
      for (const r of task.reminders) {
        if (!r.sent && +now >= +new Date(r.at) && isOffice(now)) {
          r.sent = true; changed = true;
          const left = Math.max(0, Math.round((+due - +now) / 3600000));
          const txt = `⏰ NHẮC VIỆC — còn khoảng ${left} giờ nữa tới hạn:\n📌 ${task.title}\n⏰ Hạn: ${fmtDT(due)}\n👤 ${task.assignee}\nXong rồi thì báo: “bot, xong …” theo số trong danh sách việc.`;
          await send(chatId, txt).catch((e) => console.error('send reminder:', e.message));
          await dmCopy(chatId, task, txt);
        }
      }
      // Quá hạn: nhắc lại lúc 08:00 mỗi ngày hành chính (tối đa 5 lần)
      if (+due < +now && isOffice(now) && now.getHours() === 8 && now.getMinutes() < 5) {
        const today = now.toDateString();
        if (task.overdueLast !== today && (task.overdueCount || 0) < 5) {
          task.overdueLast = today; task.overdueCount = (task.overdueCount || 0) + 1; changed = true;
          const txt = `⛔ QUÁ HẠN — việc này đã quá hạn từ ${fmtDT(due)} mà chưa báo xong:\n📌 ${task.title}\n👤 ${task.assignee}`;
          await send(chatId, txt).catch((e) => console.error('send overdue:', e.message));
          await dmCopy(chatId, task, txt);
        }
      }
    }
  }
  if (changed) saveStore();
}

// ============================== CHẠY CHÍNH ==============================
async function main() {
  writeUpdateState('booting'); // Trình cập nhật (updater.js) theo dõi file này để biết bot mới đã lên hay chưa.
  if (!TOKEN || !TOKEN.includes(':')) { console.error('Thiếu BOT_TOKEN (định dạng <bot_id>:<secret>). Chạy: BOT_TOKEN=... node bot.js'); process.exit(1); }
  const me = await callApi('getMe');
  console.log('Bot đã đăng nhập:', JSON.stringify(me));
  console.log('Phiên bản bot: v' + BOT_VERSION);
  console.log(AI_KEY ? 'AI Gemini: BẬT — bot hiểu được câu nói tự nhiên.' : 'AI Gemini: TẮT (chưa có ai-key.txt) — bot chỉ hiểu lệnh theo mẫu cứng.');
  // getUpdates sẽ KHÔNG hoạt động nếu bot đang gắn webhook — kiểm tra, có thì gỡ để quay lại polling.
  try {
    const wh = await callApi('getWebhookInfo');
    console.log('Thông tin webhook:', JSON.stringify(wh));
    if (wh && typeof wh === 'object' && wh.url) {
      await callApi('deleteWebhook');
      console.log('Đã gỡ webhook cũ — bot chuyển sang cơ chế nghe tin trực tiếp (polling).');
    }
  } catch (e) {
    // Một số bot trả 404 cho getWebhookInfo (không có thông tin webhook) — coi như không có webhook, khỏi in lỗi dài.
    if (/404|Not Found/i.test(e.message)) console.log('Thông tin webhook: không có (bot dùng cơ chế nghe tin trực tiếp).');
    else console.log('Không kiểm tra được webhook (bỏ qua):', e.message);
  }
  startBridge();
  if (process.platform === 'win32') console.log('[Trực ban] BẬT — có lệnh đăng bài chờ mà extension vắng mặt, bot sẽ tự mở Chrome (thu nhỏ) và cảnh báo nếu lệnh kẹt quá 10 phút.');
  // Tự cập nhật (v3.6): kiểm tra bản mới ngay khi khởi động; chạy ổn định đủ lâu thì
  // ghi nhận "ok" cho updater.js và nhắn báo kết quả cập nhật (nếu có) cho chủ bot.
  lastUpdateCheckAt = Date.now();
  checkForUpdate(null).catch((e) => console.error('[Cập nhật] Lỗi:', e.message));
  setTimeout(() => { writeUpdateState('ok'); notifyUpdateOutcome().catch((e) => console.error('[Cập nhật] Báo kết quả lỗi:', e.message)); }, CONFIG.updateOkDelayMs);
  setInterval(() => reminderTick().catch((e) => console.error('reminderTick:', e.message)), CONFIG.reminderTickMs);
  console.log('Đang nghe tin nhắn (long polling)… Nhấn Ctrl+C để dừng.');
  for (;;) {
    try {
      const list = await pollUpdates();
      for (const u of list) {
        const msg = u.message || u;
        const mid = msg?.message_id;
        // Zalo không có cơ chế xác nhận đã nhận và có thể phát lại cùng một sự kiện — tự chống trùng theo message_id.
        if (mid && state.seen.includes(mid)) continue;
        // Nhật ký chẩn đoán: mọi tin bot nhận được đều in ra cửa sổ để đối soát với Zalo
        console.log(`[tin mới] event=${u.event_name ?? '?'} chat=${msg?.chat?.id ?? '?'} (${msg?.chat?.chat_type ?? '?'}) từ=${msg?.from?.display_name ?? '?'}: ${JSON.stringify((msg?.text ?? '').slice(0, 100))}`);
        inFlightMessages++;
        try {
          if (msg && msg.text) await handleMessage(msg).catch((e) => console.error('handleMessage:', e.message));
          else if (msg && u.event_name === 'message.unsupported.received') await handleUnsupported(msg).catch((e) => console.error('handleUnsupported:', e.message));
        } finally { inFlightMessages--; }
        if (mid) { state.seen.push(mid); if (state.seen.length > 500) state.seen = state.seen.slice(-500); saveState(); }
      }
    } catch (e) {
      console.error('getUpdates:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { foldVN, parseDeadline, parseCommand, parseAddCommand, isOffice, prevOfficeTime, nextOfficeTime, planReminders, extractUpdates, normName, findUserByName, isStartCommand, parseAiJson, stripHtml, parseBingResults, parseDdgResults, parseGoogleNews, parsePostCommand, findSharedLink, briefingText, morningBriefingTick, detectRecur, advanceDue, watchdogDecision, BOT_VERSION, cmpVersion, validManifest, sha256hex, isFailedVersion, store, CONFIG };

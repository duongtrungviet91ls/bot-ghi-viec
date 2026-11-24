'use strict';
// Kiểm thử SỔ HẠN CÔNG VIỆC (v3.12): bộ phân tích thời hạn xác định (giờ VN), tách câu
// ghi hạn, khớp từ khóa đóng việc, chọn mốc nhắc + chống trùng, và lớp gọi API với
// fetch GIẢ LẬP (không gọi mạng thật, không token thật). Chạy: node test-sohan.js
const assert = require('assert');
const { foldVN, parseCommand, parseSohanDeadline, parseSohanAdd, matchSohanItems, sohanMilestones, chooseSohanReminders, fmtSohanDue, vnDateStr, sohanListText, sohanBriefingSection, setSohanCache, loadSohanConfig, setSohanTestDeps, sohanGetOpen, sohanCreate, sohanDone, sohanMove, sohanReminded } = require('./bot.js');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); passed++; };

// "Bây giờ" cố định: Thứ 2, 16/11/2026, 09:00 (giờ máy UTC = 16:00 VN cùng ngày).
const NOW = new Date(2026, 10, 16, 9, 0);
// Epoch giây của một thời điểm giờ VN, tính độc lập để đối chiếu với bot.
const vn = (y, mo, d, h, mi) => Math.floor((Date.UTC(y, mo - 1, d, h, mi, 0) - 7 * 3600 * 1000) / 1000);
const P = (s) => parseSohanDeadline(foldVN(s), NOW);

// --- (a) Bộ phân tích thời hạn ---
eq(P('24/11/2026').epochSec, vn(2026, 11, 24, 23, 59), 'dd/mm/yyyy, không giờ → 23:59 VN');
eq(P('24/11').epochSec, vn(2026, 11, 24, 23, 59), 'dd/mm chưa qua → năm nay');
eq(P('15/11').epochSec, vn(2027, 11, 15, 23, 59), 'dd/mm đã qua → sang năm sau');
eq(P('16/11').epochSec, vn(2026, 11, 16, 23, 59), 'dd/mm đúng hôm nay → giữ hôm nay');
eq(P('23:59 ngày 24/11').epochSec, vn(2026, 11, 24, 23, 59), 'giờ hh:mm đứng trước ngày');
eq(P('24/11 17:00').epochSec, vn(2026, 11, 24, 17, 0), 'giờ hh:mm đứng sau ngày');
eq(P('17h30 24/11').epochSec, vn(2026, 11, 24, 17, 30), 'giờ 17h30 đứng trước ngày');
eq(P('24/11 17h').epochSec, vn(2026, 11, 24, 17, 0), 'giờ 17h đứng sau ngày');
eq(P('hôm nay').epochSec, vn(2026, 11, 16, 23, 59), 'hôm nay → 23:59 hôm nay');
eq(P('hôm nay 17h').epochSec, vn(2026, 11, 16, 17, 0), 'hôm nay kèm giờ');
eq(P('mai').epochSec, vn(2026, 11, 17, 23, 59), 'mai → ngày mai 23:59');
eq(P('ngày mai 9h').epochSec, vn(2026, 11, 17, 9, 0), 'ngày mai kèm giờ');
eq(P('thứ 6').epochSec, vn(2026, 11, 20, 23, 59), 'thứ 6 sắp tới');
eq(P('thứ 2').epochSec, vn(2026, 11, 16, 23, 59), 'thứ 2 trùng hôm nay → hôm nay');
eq(P('thứ bảy').epochSec, vn(2026, 11, 21, 23, 59), 'thứ bảy sắp tới');
eq(P('chủ nhật').epochSec, vn(2026, 11, 22, 23, 59), 'chủ nhật sắp tới');
eq(P('31/2/2027'), null, 'ngày không tồn tại → null');
eq(P('nộp báo cáo thường kỳ'), null, 'không có hạn → null');
eq(fmtSohanDue(vn(2026, 11, 20, 17, 0)), 'Thứ 6, 20/11/2026 lúc 17:00', 'diễn giải hạn đầy đủ');
eq(vnDateStr(vn(2026, 11, 20, 17, 0) * 1000), '2026-11-20', 'ngày VN dạng yyyy-mm-dd');

// --- Tách câu ghi hạn + nhận diện lệnh ---
let c = parseCommand('bot, hạn: Nộp báo cáo — 24/11 17:00', NOW);
eq(c.type, 'sohan_add'); eq(c.title, 'Nộp báo cáo'); eq(c.dueEpoch, vn(2026, 11, 24, 17, 0), 'ghi hạn có dấu —');
c = parseCommand('bot, thêm hạn Gửi công văn - mai', NOW);
eq(c.type, 'sohan_add'); eq(c.title, 'Gửi công văn'); eq(c.dueEpoch, vn(2026, 11, 17, 23, 59), 'thêm hạn, dấu - và mai');
c = parseCommand('bot, hạn: Họp giao ban thứ 6', NOW);
eq(c.type, 'sohan_add'); eq(c.title, 'Họp giao ban', 'không dấu phân cách: cắt đoạn hạn khỏi tiêu đề');
eq(c.dueEpoch, vn(2026, 11, 20, 23, 59));
c = parseCommand('bot, hạn: Nộp báo cáo hạn 25/11', NOW);
eq(c.title, 'Nộp báo cáo', 'chữ hạn thừa trước ngày bị cắt khỏi tiêu đề');
eq(c.dueEpoch, vn(2026, 11, 25, 23, 59));
eq(parseSohanAdd('Việc gì đó không rõ ngày', NOW).dueEpoch, null, 'không bóc được → dueEpoch null (để AI/hỏi lại)');
eq(parseCommand('bot, sổ hạn', NOW).type, 'sohan_list', 'xem sổ');
eq(parseCommand('bot, hạn', NOW).type, 'sohan_list', 'bot, hạn trơ → xem sổ');
eq(parseCommand('bot, xong 2', NOW).type, 'done', 'xong <số> vẫn là việc nội bộ như cũ');
c = parseCommand('xong báo cáo', NOW);
eq(c.type, 'sohan_done'); eq(c.keyword, 'báo cáo', 'xong <từ khóa> không cần tiền tố bot');
c = parseCommand('bot, dời hạn báo cáo sang 28/11 17:00', NOW);
eq(c.type, 'sohan_move'); eq(c.keyword, 'báo cáo'); eq(c.dueEpoch, vn(2026, 11, 28, 17, 0), 'dời hạn');
eq(parseCommand('dời hạn báo cáo sang tuần sau đó', NOW).type, 'sohan_move_bad', 'dời hạn không bóc được ngày mới');

// --- (b) Khớp từ khóa đóng việc ---
const ITEMS = [
  { id: 'a1', tieu_de: 'Nộp báo cáo TTND tháng 11', han_luc: vn(2026, 11, 20, 17, 0), cac_moc_da_nhac: [] },
  { id: 'a2', tieu_de: 'Nộp báo cáo GSĐTCĐ', han_luc: vn(2026, 11, 25, 23, 59), cac_moc_da_nhac: [] },
  { id: 'a3', tieu_de: 'Họp giao ban tuần', han_luc: vn(2026, 11, 17, 9, 0), cac_moc_da_nhac: [] },
];
eq(matchSohanItems(ITEMS, 'họp giao ban').length, 1, 'khớp đúng 1 (không dấu, không hoa thường)');
eq(matchSohanItems(ITEMS, 'Họp Giao Ban').length, 1, 'khớp hoa thường lẫn lộn');
eq(matchSohanItems(ITEMS, 'báo cáo').length, 2, 'khớp nhiều kết quả → để người dùng chọn');
eq(matchSohanItems(ITEMS, 'báo cáo TTND').length, 1, 'từ khóa dài hơn → đúng 1');
eq(matchSohanItems(ITEMS, 'không có việc này').length, 0, 'không khớp → rỗng');

// --- (c) Chọn mốc nhắc + chống trùng ---
const M8 = vn(2026, 11, 16, 8, 0) * 1000; // Thứ 2 16/11/2026 08:00 VN
const mk = (dueEpoch, rec = []) => ({ id: 'x', tieu_de: 'Việc mẫu', han_luc: dueEpoch, cac_moc_da_nhac: rec });
eq(JSON.stringify(sohanMilestones(mk(vn(2026, 11, 19, 23, 59)), M8, { morning: true })), JSON.stringify([{ kind: 'T3', key: 'T3@2026-11-19' }]), 'còn đúng 3 ngày → T3');
eq(JSON.stringify(sohanMilestones(mk(vn(2026, 11, 17, 23, 59)), M8, { morning: true })), JSON.stringify([{ kind: 'T1', key: 'T1@2026-11-17' }]), 'còn 1 ngày → T1');
ok(sohanMilestones(mk(vn(2026, 11, 16, 23, 59)), M8, { morning: true }).some((x) => x.kind === 'DUE' && x.key === 'DUE@2026-11-16'), 'hết hạn hôm nay → DUE');
eq(JSON.stringify(sohanMilestones(mk(vn(2026, 11, 15, 17, 0)), M8, { morning: true })), JSON.stringify([{ kind: 'OD', key: 'OD@2026-11-15:2026-11-16' }]), 'quá hạn → OD kèm ngày gửi');
eq(JSON.stringify(sohanMilestones(mk(vn(2026, 11, 15, 17, 0)), vn(2026, 11, 17, 8, 0) * 1000, { morning: true })), JSON.stringify([{ kind: 'OD', key: 'OD@2026-11-15:2026-11-17' }]), 'OD ngày hôm sau là khóa MỚI (nhắc mỗi ngày)');
eq(sohanMilestones(mk(vn(2026, 11, 19, 23, 59), ['T3@2026-11-19']), M8, { morning: true }).length, 0, 'đã có khóa T3 → không nhắc lại (chống trùng qua khởi động lại)');
eq(sohanMilestones(mk(vn(2026, 11, 15, 17, 0), ['OD@2026-11-15:2026-11-16']), M8, { morning: true }).length, 0, 'OD đã nhắc hôm nay → thôi');
eq(sohanMilestones(mk(vn(2026, 11, 20, 23, 59)), M8, { morning: true }).length, 0, 'còn 4 ngày → chưa mốc nào');
eq(JSON.stringify(sohanMilestones(mk(vn(2026, 11, 16, 10, 30)), M8, { morning: false })), JSON.stringify([{ kind: 'SOON', key: 'SOON@2026-11-16' }]), 'còn 2,5 giờ → SOON');
eq(sohanMilestones(mk(vn(2026, 11, 16, 11, 30)), M8, { morning: false }).length, 0, 'còn 3,5 giờ → chưa SOON');
eq(sohanMilestones(mk(vn(2026, 11, 16, 7, 0)), M8, { morning: false }).length, 0, 'đã quá hạn → không SOON');
eq(sohanMilestones(mk(vn(2026, 11, 16, 10, 30), ['SOON@2026-11-16']), M8, { morning: false }).length, 0, 'đã có khóa SOON → không nhắc lại');
const picks = chooseSohanReminders([mk(vn(2026, 11, 19, 23, 59)), mk(vn(2026, 11, 17, 9, 0))], M8, true);
eq(picks.map((x) => x.kind).sort().join(','), 'T1,T3', 'chooseSohanReminders gộp nhiều hạn');

// --- Văn bản sổ + mục bản tin ---
ok(sohanListText([], M8).includes('đang trống'), 'sổ trống → câu báo trống');
ok(sohanListText(ITEMS, M8).includes('còn 4 ngày') || sohanListText(ITEMS, M8).includes('Nộp báo cáo TTND'), 'danh sách sổ có tên việc + nhãn');
setSohanCache(ITEMS);
ok(sohanBriefingSection(new Date(M8)).includes('Họp giao ban tuần'), 'mục bản tin: hạn trong 3 ngày tới');
setSohanCache([]);
ok(sohanBriefingSection(new Date(M8)).includes('Không có hạn nào sắp tới.'), 'mục bản tin khi không có hạn');
setSohanCache(null);

// --- Lớp gọi API với fetch giả lập ---
(async () => {
  const calls = [];
  const stub = async (url, opts) => {
    calls.push({ url, opts });
    const reply = (status, obj) => ({ ok: status < 300, status, json: async () => obj });
    if (url.endsWith('/api/bot/so-han/open')) return reply(200, { items: ITEMS, now: Math.floor(M8 / 1000) });
    if (url.endsWith('/api/bot/so-han') && opts.method === 'POST') { const b = JSON.parse(opts.body); return reply(201, { id: 'new1', ...b }); }
    if (url.includes('/done')) return reply(200, { ok: true });
    if (url.includes('/move')) return reply(200, { id: 'a1', han_luc: JSON.parse(opts.body).han_luc });
    if (url.includes('/reminded')) return reply(200, { ok: true, recorded: true });
    return reply(404, { error: 'not found' });
  };
  setSohanTestDeps({ config: { url: 'https://example.test', token: 'token-gia-lap' }, fetch: stub });
  const open = await sohanGetOpen();
  eq(open.items.length, 3, 'GET open qua stub');
  eq(calls[0].opts.headers['X-Bot-Token'], 'token-gia-lap', 'mọi yêu cầu kèm header X-Bot-Token');
  const created = await sohanCreate({ tieu_de: 'Việc mới', han_luc: vn(2026, 11, 24, 17, 0) });
  eq(created.id, 'new1', 'POST tạo hạn');
  eq(JSON.parse(calls[1].opts.body).han_luc, vn(2026, 11, 24, 17, 0), 'body tạo hạn đúng hợp đồng');
  eq((await sohanDone('a3')).ok, true, 'POST done');
  eq((await sohanMove('a1', vn(2026, 11, 28, 17, 0))).han_luc, vn(2026, 11, 28, 17, 0), 'POST move');
  eq((await sohanReminded('a1', 'T3@2026-11-19')).recorded, true, 'POST reminded ghi mốc');
  ok(calls.every((x) => x.opts.headers['X-Bot-Token'] === 'token-gia-lap'), 'mọi cuộc gọi đều có token');
  // Lỗi HTTP kèm {error} → ném lỗi mang thông điệp máy chủ
  setSohanTestDeps({ fetch: async () => ({ ok: false, status: 401, json: async () => ({ error: 'bad token' }) }) });
  await assert.rejects(() => sohanGetOpen(), /bad token/); passed++;
  // Thiếu cấu hình → lỗi rõ ràng NOT_CONFIGURED, không ghi hạn "ảo"
  setSohanTestDeps({ config: null, fetch: null });
  eq(loadSohanConfig(), null, 'không file cấu hình (môi trường test) → null');
  await assert.rejects(() => sohanGetOpen(), (e) => e.code === 'NOT_CONFIGURED'); passed++;

  console.log(`✅ test-sohan: ${passed} kiểm thử đạt.`);
})().catch((e) => { console.error(e); process.exit(1); });

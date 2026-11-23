'use strict';
// Kiểm thử bộ phân tích hạn + giờ hành chính. Chạy: node test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { foldVN, parseDeadline, parseCommand, isOffice, prevOfficeTime, nextOfficeTime, planReminders, extractUpdates, normName, findUserByName, isStartCommand, parseAiJson, stripHtml, parseBingResults, parseDdgResults, parseGoogleNews, parsePostCommand, findSharedLink, briefingText, morningBriefingTick, detectRecur, advanceDue, watchdogDecision, BOT_VERSION, cmpVersion, validManifest, sha256hex, isFailedVersion, handleViaAI, parseFxXml, fxText, fxCodeOf, wmoText, weatherText, parseNewsItems, newsText, isLookupQuestion, isRuleStrong, enqueueChatWork, store } = require('./bot.js');

// "Bây giờ" cố định: Thứ 2, 16/11/2026, 09:00
const NOW = new Date(2026, 10, 16, 9, 0);
assert.strictEqual(NOW.getDay(), 1, '16/11/2026 phải là Thứ 2');

const eq = (d, y, mo, da, h, mi) => {
  const want = new Date(y, mo, da, h, mi);
  assert.strictEqual(+d, +want, `muốn ${want}, được ${d}`);
};

// --- parseDeadline ---
eq(parseDeadline(foldVN('hạn 25/11 14h'), NOW).due, 2026, 10, 25, 14, 0);
eq(parseDeadline(foldVN('hạn mai 9h'), NOW).due, 2026, 10, 17, 9, 0);
eq(parseDeadline(foldVN('chiều nay'), NOW).due, 2026, 10, 16, 17, 0);
eq(parseDeadline(foldVN('sáng mai'), NOW).due, 2026, 10, 17, 11, 30);
eq(parseDeadline(foldVN('thứ 6 17h'), NOW).due, 2026, 10, 20, 17, 0);
eq(parseDeadline(foldVN('thứ 3 tuần sau'), NOW).due, 2026, 10, 24, 17, 0);
eq(parseDeadline(foldVN('2 ngày nữa'), NOW).due, 2026, 10, 18, 17, 0);
eq(parseDeadline(foldVN('cuối tháng'), NOW).due, 2026, 10, 30, 17, 0);
eq(parseDeadline(foldVN('cuối tuần'), NOW).due, 2026, 10, 20, 17, 0);
eq(parseDeadline(foldVN('25/12/2026'), NOW).due, 2026, 11, 25, 17, 0);
assert.strictEqual(parseDeadline(foldVN('nộp báo cáo thường kỳ'), NOW), null);

// --- parseCommand: ghi việc ---
let c = parseCommand('bot, ghi việc cho tao: Nộp báo cáo TTND, hạn thứ 6 17h', NOW);
assert.strictEqual(c.type, 'add'); assert.strictEqual(c.title, 'Nộp báo cáo TTND');
eq(c.due, 2026, 10, 20, 17, 0);

c = parseCommand('@BotBaoViec ghi viec: Kiem tra may in, han mai 9h', NOW);
assert.strictEqual(c.type, 'add'); assert.strictEqual(c.title, 'Kiem tra may in');
eq(c.due, 2026, 10, 17, 9, 0);

c = parseCommand('bot, ghi việc giao cho anh Tùng: Đổ mực máy in tầng 2, hạn 25/11', NOW);
assert.strictEqual(c.type, 'add'); assert.ok(/Tùng/.test(c.assignee), 'người được giao: ' + c.assignee);
assert.ok(!/Tùng/.test(c.title), 'tiêu đề không dính tên: ' + c.title);
eq(c.due, 2026, 10, 25, 17, 0);

c = parseCommand('bot, ghi việc: Họp giao ban', NOW);
assert.strictEqual(c.type, 'add'); assert.strictEqual(c.due, null); // thiếu hạn → bot hỏi lại

c = parseCommand('@Bot Mặt trận Lạng Sơn ghi việc: Họp nhóm tuần, hạn mai 9h', NOW);
assert.strictEqual(c.type, 'add'); assert.strictEqual(c.title, 'Họp nhóm tuần');
eq(c.due, 2026, 10, 17, 9, 0);

// --- Nhắc nhanh kiểu tự nhiên (ca thật: "@Bot … nhắc tao, 2 phút nữa đi ngủ") ---
eq(parseDeadline(foldVN('2 phút nữa'), NOW).due, 2026, 10, 16, 9, 2);
c = parseCommand('@Bot Mặt trận Lạng Sơn nhắc tao, 2 phút nữa đi ngủ', NOW);
assert.strictEqual(c.type, 'remind'); assert.strictEqual(c.title, 'Đi ngủ');
eq(c.due, 2026, 10, 16, 9, 2);
c = parseCommand('bot, nhắc tao đi ngủ sau 5 phút', NOW);
assert.strictEqual(c.type, 'remind'); assert.strictEqual(c.title, 'Đi ngủ');
eq(c.due, 2026, 10, 16, 9, 5);
c = parseCommand('nhắc mình 10 phút nữa uống thuốc', NOW);
assert.strictEqual(c.type, 'remind'); assert.strictEqual(c.title, 'Uống thuốc');
eq(c.due, 2026, 10, 16, 9, 10);

// --- Bóc tách phản hồi getUpdates (đúng khuôn tài liệu Zalo: từng sự kiện một) ---
const zaloPayload = { ok: true, result: { message: { from: { id: 'u1', display_name: 'Duong' }, chat: { id: 'u1', chat_type: 'PRIVATE' }, text: 'Bot, trợ giúp', message_id: 'msg_1', date: 1750316131602 }, event_name: 'message.text.received' } };
const ex = extractUpdates(zaloPayload);
assert.strictEqual(ex.length, 1);
assert.strictEqual(ex[0].message.text, 'Bot, trợ giúp');
assert.strictEqual(ex[0].event_name, 'message.text.received');
assert.deepStrictEqual(extractUpdates({ ok: true, result: [] }), []);
assert.deepStrictEqual(extractUpdates({ ok: true, result: [{ message: { text: 'a' } }] }).length, 1);
assert.deepStrictEqual(extractUpdates(null), []);
assert.deepStrictEqual(extractUpdates({ ok: true }), []);

// --- Khớp tên người được giao (nhắc riêng DM) ---
assert.strictEqual(normName('anh Tùng'), 'tung');
assert.strictEqual(normName('Việt Ls'), 'viet ls');
const USERS = { u1: { name: 'Việt Ls', privateChatId: 'u1' }, u2: { name: 'Nguyễn Văn Tùng', privateChatId: 'u2' }, u3: { name: 'Trần Tùng', privateChatId: null } };
assert.strictEqual(findUserByName(USERS, 'Việt Ls').id, 'u1');
assert.strictEqual(findUserByName(USERS, 'anh Việt').id, 'u1');       // khớp một phần duy nhất
assert.strictEqual(findUserByName(USERS, 'Tùng'), null);              // 2 người trùng → không đoán
assert.strictEqual(findUserByName(USERS, 'Nguyễn Văn Tùng').id, 'u2'); // khớp đúng tuyệt đối
assert.strictEqual(findUserByName(USERS, 'Không Có Người Này'), null);

// --- /start trong nhóm (ca thật 23:51: "@Bot Mặt trận Lạng Sơn /start" bị trả "chưa hiểu lệnh") ---
assert.strictEqual(isStartCommand('/start'), true);
assert.strictEqual(isStartCommand('@Bot Mặt trận Lạng Sơn /start'), true);
assert.strictEqual(isStartCommand('@BotBaoViec /start'), true);
assert.strictEqual(isStartCommand('bot, ghi việc: /start dự án'), false);
assert.strictEqual(isStartCommand('khởi đầu /startup'), false);

// --- Tra cứu web: bóc HTML kết quả tìm kiếm ---
assert.strictEqual(stripHtml('<p>Xin <b>chào</b> &amp; tạm biệt</p><script>var x=1;</script>'), 'Xin chào & tạm biệt');
const bingSample = '<li class="b_algo" data-id="1"><h2 class=""><a target="_blank" href="https://mttq.langson.gov.vn/lien-he" h="ID">Liên hệ — MTTQ <strong>Lạng Sơn</strong></a></h2><div class="b_caption"><p class="b_lineclamp">Số điện thoại đường dây nóng 0205 3xxx</p></div></li><li class="b_algo"><h2><a href="https://example.com/a">Trang A</a></h2><p>Mô tả A</p></li>';
const br = parseBingResults(bingSample);
assert.strictEqual(br.length, 2);
assert.strictEqual(br[0].url, 'https://mttq.langson.gov.vn/lien-he');
assert.ok(br[0].title.includes('Lạng Sơn') && br[0].snippet.includes('đường dây nóng'));
const ddgSample = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvi.wikipedia.org%2Fwiki%2FLang_Son&rut=abc">Lạng Sơn – Wikipedia</a><a class="result__snippet" href="#">Tỉnh ở vùng Đông Bắc Việt Nam</a>';
const dr = parseDdgResults(ddgSample);
assert.strictEqual(dr.length, 1);
assert.strictEqual(dr[0].url, 'https://vi.wikipedia.org/wiki/Lang_Son');
assert.ok(dr[0].snippet.includes('Đông Bắc'));
assert.strictEqual(parseAiJson('{"action":"secretary","title":null,"assignee":null,"due_text":null,"task_ref":null,"reply":null}').action, 'secretary');
const newsSample = '<?xml version="1.0"?><rss><channel><item><title><![CDATA[Ngày hội Đại đoàn kết ở Lạng Sơn - Báo Lạng Sơn]]></title><link>https://news.google.com/rss/articles/ABC123</link><description><![CDATA[<a href="x">Ngày hội Đại đoàn kết</a>&nbsp;tại xã Bắc Sơn]]></description><pubDate>Sat, 15 Nov 2026 08:00:00 GMT</pubDate></item><item><title>Tin thứ hai</title><link>https://news.google.com/rss/articles/DEF456</link><description>Mô tả hai</description></item></channel></rss>';
const nr = parseGoogleNews(newsSample);
assert.strictEqual(nr.length, 2);
assert.ok(nr[0].title.includes('Đại đoàn kết') && nr[0].url.includes('ABC123') && nr[0].snippet.includes('15 Nov 2026'));

// --- Lệnh đăng bài (parsePostCommand) ---
assert.deepStrictEqual(parsePostCommand('đăng bài: https://baolangson.vn/abc-123.html', false), { url: 'https://baolangson.vn/abc-123.html', targets: null });
assert.deepStrictEqual(parsePostCommand('@Bot Mặt trận Lạng Sơn đăng bài https://daidoanket.vn/xyz.html nhé', false), { url: 'https://daidoanket.vn/xyz.html', targets: null });
assert.deepStrictEqual(parsePostCommand('https://baolangson.vn/chi-link.html', true), { url: 'https://baolangson.vn/chi-link.html', targets: null }); // chat riêng: mỗi link cũng là lệnh
// Nơi đăng (v3.4)
assert.deepStrictEqual(parsePostCommand('đăng bài lên cổng: https://baolangson.vn/a.html', false).targets, { mttq: true, zalo: false });
assert.deepStrictEqual(parsePostCommand('đăng bài lên zalo: https://baolangson.vn/a.html', false).targets, { mttq: false, zalo: true });
assert.deepStrictEqual(parsePostCommand('@Bot Mặt trận Lạng Sơn đăng bài chỉ cổng thôi https://dantri.com.vn/a.htm', false).targets, { mttq: true, zalo: false });
assert.deepStrictEqual(parsePostCommand('đăng bài cả hai: https://baolangson.vn/a.html', false).targets, { mttq: true, zalo: true });
assert.deepStrictEqual(parsePostCommand('đăng bài lên cổng và zalo: https://baolangson.vn/a.html', false).targets, { mttq: true, zalo: true });
assert.strictEqual(parsePostCommand('đăng bài công khai: https://baolangson.vn/a.html', false).targets, null); // "công khai" không phải nơi đăng
assert.strictEqual(parsePostCommand('đăng bài: https://zalo.me/bai-viet', false).targets, null);              // chữ zalo nằm trong link thì không tính
assert.strictEqual(parsePostCommand('https://baolangson.vn/chi-link.html', false), null);   // trong nhóm: link trơ không phải lệnh đăng
assert.strictEqual(parsePostCommand('xem bài này hay https://baolangson.vn/a.html', true), null); // chat riêng nhưng có chữ khác → không phải lệnh
assert.strictEqual(parsePostCommand('đăng bài đi bạn', false), null);                        // không có link → không phải lệnh

// --- Moi link từ sự kiện unsupported (findSharedLink) ---
assert.strictEqual(findSharedLink({ links: [{ link: 'https://baolangson.vn/a-1.html', thumb: 'https://img.vn/x.jpg' }] }), 'https://baolangson.vn/a-1.html');
assert.strictEqual(findSharedLink({ url: 'https://daidoanket.vn/b.html' }), 'https://daidoanket.vn/b.html');
assert.strictEqual(findSharedLink({ attachments: [{ payload: { url: 'https://baolangson.vn/c.html' } }] }), 'https://baolangson.vn/c.html');
assert.strictEqual(findSharedLink({ photo: 'https://img.vn/p.jpg' }), '');   // chỉ có link ảnh → không phải bài
assert.strictEqual(findSharedLink({ text: '' }), '');
assert.strictEqual(findSharedLink(null), '');

// --- Đọc phản hồi AI (parseAiJson) ---
assert.strictEqual(parseAiJson('{"action":"add_task","title":"Họp","assignee":null,"due_text":"mai 9h","task_ref":null,"reply":null}').action, 'add_task');
assert.strictEqual(parseAiJson('```json\n{"action":"list"}\n```').action, 'list'); // chịu được bọc markdown
assert.strictEqual(parseAiJson('{"action":"bay_luon"}'), null);                      // action lạ → bỏ
assert.strictEqual(parseAiJson('không phải json'), null);
assert.strictEqual(parseAiJson(''), null);

assert.strictEqual(parseCommand('bot, việc', NOW).type, 'list');
assert.deepStrictEqual(parseCommand('bot, xong 2', NOW), { type: 'done', n: 2 });
assert.strictEqual(parseCommand('bot, trợ giúp', NOW).type, 'help');
c = parseCommand('bot, sửa hạn 1 thứ 4', NOW);
assert.strictEqual(c.type, 'redue'); eq(c.due, 2026, 10, 18, 17, 0);

// --- Giờ hành chính ---
assert.strictEqual(isOffice(new Date(2026, 10, 16, 10, 0)), true);   // Thứ 2 10:00
assert.strictEqual(isOffice(new Date(2026, 10, 16, 12, 0)), false);  // nghỉ trưa
assert.strictEqual(isOffice(new Date(2026, 10, 21, 10, 0)), false);  // Thứ 7
assert.strictEqual(isOffice(new Date(2026, 10, 16, 16, 0)), true);   // chiều
eq(prevOfficeTime(new Date(2026, 10, 22, 10, 0)), 2026, 10, 20, 17, 30); // Chủ nhật → Thứ 6 17:30
eq(prevOfficeTime(new Date(2026, 10, 16, 12, 15)), 2026, 10, 16, 11, 30); // giờ trưa → 11:30
eq(nextOfficeTime(new Date(2026, 10, 21, 10, 0)), 2026, 10, 23, 7, 30);   // Thứ 7 → Thứ 2 07:30
eq(nextOfficeTime(new Date(2026, 10, 16, 12, 15)), 2026, 10, 16, 13, 30); // trưa → 13:30

// --- Lập mốc nhắc: hạn Thứ 2 tuần sau 09:00 (ngoài buổi sáng sớm) ---
const due = new Date(2026, 10, 23, 9, 0);
const rems = planReminders(due, NOW);
assert.ok(rems.length >= 2, 'có ít nhất 2 mốc nhắc');
for (const r of rems) {
  assert.ok(isOffice(r), 'mốc nhắc phải trong giờ hành chính: ' + r);
  assert.ok(+r < +due, 'mốc nhắc phải trước hạn');
  assert.ok(+r > +NOW, 'mốc nhắc phải ở tương lai');
}
// Hạn rơi vào Chủ nhật → mọi mốc nhắc phải lùi về ngày làm việc
const dueSun = new Date(2026, 10, 22, 17, 0);
for (const r of planReminders(dueSun, NOW)) assert.ok(isOffice(r) && +r < +dueSun, 'nhắc cho hạn Chủ nhật: ' + r);

// --- Bản tin sáng v3.3: "bot, việc hôm nay" / "bot, bản tin sáng" ---
assert.strictEqual(parseCommand('bot, việc hôm nay', NOW).type, 'briefing');
assert.strictEqual(parseCommand('bot, bản tin sáng', NOW).type, 'briefing');
assert.strictEqual(parseCommand('@Bot Mặt trận Lạng Sơn việc hôm nay', NOW).type, 'briefing');
// "Bây giờ" NOW = Thứ 2 16/11/2026 09:00: 1 quá hạn + 1 hôm nay + 1 ngày mai + 1 xa (không hiện) + 1 đã xong (không hiện)
store.chats['test-chat'] = [
  { title: 'Nộp báo cáo TTND', assignee: 'anh Tùng', due: new Date(2026, 10, 15, 17, 0).toISOString(), done: false },
  { title: 'Họp giao ban', assignee: 'Việt Ls', due: new Date(2026, 10, 16, 17, 0).toISOString(), done: false },
  { title: 'Chuẩn bị tài liệu', assignee: null, due: new Date(2026, 10, 17, 9, 0).toISOString(), done: false },
  { title: 'Việc xa', assignee: null, due: new Date(2026, 10, 20, 9, 0).toISOString(), done: false },
  { title: 'Đã xong', assignee: null, due: new Date(2026, 10, 16, 9, 0).toISOString(), done: true },
];
const bt = briefingText('test-chat', NOW);
assert.ok(bt.includes('Quá hạn (1)') && bt.includes('Nộp báo cáo TTND'), 'mục quá hạn: ' + bt);
assert.ok(bt.includes('Đến hạn hôm nay (1)') && bt.includes('Họp giao ban'), 'mục hôm nay: ' + bt);
assert.ok(bt.includes('Đến hạn ngày mai (1)') && bt.includes('Chuẩn bị tài liệu'), 'mục ngày mai: ' + bt);
assert.ok(!bt.includes('Việc xa') && !bt.includes('Đã xong'), 'không hiện việc xa/đã xong: ' + bt);
assert.strictEqual(briefingText('chat-trong', NOW), null); // không có việc mở → im lặng
store.chats['chi-xa'] = [{ title: 'Việc xa', assignee: null, due: new Date(2026, 10, 20, 9, 0).toISOString(), done: false }];
assert.strictEqual(briefingText('chi-xa', NOW), null); // chỉ có việc xa → im lặng
// morningBriefingTick: sai giờ thì không làm gì; đã gửi hôm nay rồi thì không gửi lại (không chạm mạng)
delete store.briefingLast;
morningBriefingTick(new Date(2026, 10, 16, 9, 0)).then(() => {
  assert.strictEqual(store.briefingLast, undefined, '09:00 không phải giờ bản tin');
  store.briefingLast = new Date(2026, 10, 16, 7, 45).toDateString();
  return morningBriefingTick(new Date(2026, 10, 16, 7, 45));
}).then(async () => {
  assert.strictEqual(store.briefingLast, new Date(2026, 10, 16, 7, 45).toDateString(), 'đã gửi hôm nay thì không gửi lại');

  // --- Việc lặp định kỳ (v3.5) ---
  assert.deepStrictEqual(detectRecur(foldVN('họp hằng tuần')), { type: 'weekly', label: 'hằng tuần' });
  assert.deepStrictEqual(detectRecur(foldVN('báo cáo mỗi tháng')), { type: 'monthly', label: 'hằng tháng' });
  assert.deepStrictEqual(detectRecur(foldVN('kiểm tra hằng ngày')), { type: 'daily', label: 'hằng ngày' });
  assert.strictEqual(detectRecur(foldVN('báo cáo tuần này')), null);   // "tuần" trơ không phải chu kỳ
  assert.strictEqual(detectRecur(foldVN('nộp báo cáo')), null);
  c = parseCommand('bot, ghi việc lặp: Họp giao ban, thứ 6 hằng tuần 17h', NOW);
  assert.strictEqual(c.type, 'add'); assert.strictEqual(c.title, 'Họp giao ban');
  assert.deepStrictEqual(c.recur, { type: 'weekly', label: 'hằng tuần' });
  eq(c.due, 2026, 10, 20, 17, 0);
  c = parseCommand('bot, ghi việc lặp: Nộp báo cáo tháng, ngày 25 hằng tháng 17h', NOW);
  assert.strictEqual(c.title, 'Nộp báo cáo tháng');
  assert.deepStrictEqual(c.recur, { type: 'monthly', label: 'hằng tháng' });
  eq(c.due, 2026, 10, 25, 17, 0);   // "ngày 25" đứng một mình phải ra 25/11, không phải hôm nay
  // v3.6.1 QA (1): chữ "hạn" đứng trước "ngày 25" cũng phải bị cắt khỏi tiêu đề (trước đây còn dính "hạn").
  c = parseCommand('bot, ghi việc lặp: Nộp báo cáo, hạn ngày 25 hằng tháng 17h', NOW);
  assert.strictEqual(c.title, 'Nộp báo cáo');
  assert.deepStrictEqual(c.recur, { type: 'monthly', label: 'hằng tháng' });
  eq(c.due, 2026, 10, 25, 17, 0);
  c = parseCommand('bot, ghi việc: Kiểm tra hộp thư, mỗi ngày 9h', NOW);
  assert.strictEqual(c.title, 'Kiểm tra hộp thư');
  assert.deepStrictEqual(c.recur, { type: 'daily', label: 'hằng ngày' });
  eq(advanceDue(new Date(2026, 10, 20, 17, 0), { type: 'weekly' }), 2026, 10, 27, 17, 0);
  eq(advanceDue(new Date(2026, 0, 31, 17, 0), { type: 'monthly' }), 2026, 1, 28, 17, 0); // 31/1 → 28/2 (2026 không nhuận)
  eq(advanceDue(new Date(2026, 10, 25, 17, 0), { type: 'monthly' }), 2026, 11, 25, 17, 0);
  eq(advanceDue(new Date(2026, 10, 16, 9, 0), { type: 'daily' }), 2026, 10, 17, 9, 0);

  // --- Trực ban Chrome (v3.5): hàm quyết định thuần ---
  const T0 = 1_000_000_000_000, WD = watchdogDecision;
  assert.strictEqual(WD({ nowMs: T0, jobAtMs: 0, lastPollAt: 0, lastLaunchAt: 0, chromeRunning: false, warned: false }), 'none');          // không có lệnh chờ
  assert.strictEqual(WD({ nowMs: T0, jobAtMs: T0 - 60e3, lastPollAt: 0, lastLaunchAt: 0, chromeRunning: false, warned: false }), 'none');    // lệnh mới 1 phút
  assert.strictEqual(WD({ nowMs: T0, jobAtMs: T0 - 5 * 60e3, lastPollAt: T0 - 60e3, lastLaunchAt: 0, chromeRunning: false, warned: false }), 'none'); // extension vừa ghé 1 phút trước
  assert.strictEqual(WD({ nowMs: T0, jobAtMs: T0 - 5 * 60e3, lastPollAt: 0, lastLaunchAt: 0, chromeRunning: false, warned: false }), 'launch');       // Chrome tắt + lệnh chờ 5 phút → tự mở
  assert.strictEqual(WD({ nowMs: T0, jobAtMs: T0 - 5 * 60e3, lastPollAt: 0, lastLaunchAt: T0 - 60e3, chromeRunning: false, warned: false }), 'none'); // vừa mở 1 phút trước → chờ thêm
  assert.strictEqual(WD({ nowMs: T0, jobAtMs: T0 - 15 * 60e3, lastPollAt: 0, lastLaunchAt: 0, chromeRunning: true, warned: false }), 'warn');         // Chrome mở mà 15 phút không ai nhận → cảnh báo
  assert.strictEqual(WD({ nowMs: T0, jobAtMs: T0 - 15 * 60e3, lastPollAt: 0, lastLaunchAt: 0, chromeRunning: true, warned: true }), 'none');          // đã cảnh báo rồi → thôi

  // --- Tự cập nhật (v3.6) ---
  assert.strictEqual(BOT_VERSION, '3.8.0');
  assert.strictEqual(cmpVersion('3.6.0', '3.7.0'), -1);
  assert.strictEqual(cmpVersion('3.7.0', '3.6.0'), 1);
  assert.strictEqual(cmpVersion('3.6.0', '3.6.0'), 0);
  assert.strictEqual(cmpVersion('3.10.0', '3.9.0'), 1);   // so theo số, không theo chữ
  assert.strictEqual(cmpVersion('3.6', '3.6.0'), 0);
  assert.strictEqual(sha256hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const H64 = 'a'.repeat(64);
  assert.strictEqual(validManifest({ version: '3.7.0', files: { 'bot.js': { sha256: H64 } } }), true);
  assert.strictEqual(validManifest({ version: '3.7', files: { 'bot.js': { sha256: H64 } } }), false);        // phiên bản sai dạng
  assert.strictEqual(validManifest({ version: '3.7.0', files: {} }), false);                                // không có file nào
  assert.strictEqual(validManifest({ version: '3.7.0', files: { 'bot.js': { sha256: 'xyz' } } }), false);   // mã băm sai dạng
  assert.strictEqual(validManifest({ version: '3.7.0', files: { '../evil.js': { sha256: H64 } } }), false); // tên file chui ra ngoài thư mục
  assert.strictEqual(validManifest({ version: '3.7.0', files: { 'updater.js': { sha256: H64 } } }), false); // updater không bao giờ tự cập nhật
  assert.strictEqual(validManifest(null), false);
  c = parseCommand('bot, phiên bản', NOW); assert.strictEqual(c.type, 'version');
  c = parseCommand('bot, kiểm tra cập nhật', NOW); assert.strictEqual(c.type, 'update');
  c = parseCommand('bot, cập nhật đi', NOW); assert.strictEqual(c.type, 'update');
  assert.notStrictEqual(parseCommand('bot, cập nhật tình hình công việc', NOW).type, 'update'); // câu thường không được hiểu nhầm thành lệnh cập nhật
  assert.strictEqual(isFailedVersion({ version: '3.8.0' }, '3.8.0'), true);   // bản đã lỗi → chặn thử lại (chống vòng lặp quay lui)
  assert.strictEqual(isFailedVersion({ version: '3.8.0' }, '3.8.1'), false);  // bản cao hơn vẫn được lên
  assert.strictEqual(isFailedVersion(null, '3.8.0'), false);

  // --- Vá v3.6.1 (QA) (2): đường AI thiếu hạn — cờ lặp phải vào pending để khi bổ sung
  // hạn xong việc vẫn lặp (trước đây việc lặp vô tình thành việc một lần).
  // Gemini + Zalo đều được giả lập bằng fetch stub; data/tasks.json được khôi phục sau test.
  {
    const aiJson = JSON.stringify({ action: 'add_task', title: 'Nộp báo cáo', assignee: null, due_text: null, task_ref: null, reply: 'Đã nhận việc, hạn lúc nào?' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('bot-api.zaloplatforms.com')) return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: aiJson }] } }] }) };
    };
    const tasksFileTest = path.join(__dirname, 'data', 'tasks.json');
    const beforeTasks = fs.existsSync(tasksFileTest) ? fs.readFileSync(tasksFileTest, 'utf8') : null;
    try {
      const aiOk = await handleViaAI('ghi việc lặp: nộp báo cáo hằng tháng ngày 25', 'chat-test', 'Việt', 'u-test', 'chat-test|u-test', NOW);
      assert.strictEqual(aiOk, true);
      assert.deepStrictEqual(store.pending['chat-test|u-test']?.recur, { type: 'monthly', label: 'hằng tháng' });
    } finally {
      globalThis.fetch = realFetch;
      delete store.pending['chat-test|u-test'];
      if (beforeTasks === null) { try { fs.rmSync(tasksFileTest); } catch {} } else fs.writeFileSync(tasksFileTest, beforeTasks);
    }
  }

  // --- Tra cứu trực tiếp (v3.7) ---
  const fxFx = parseFxXml('<ExrateList><DateTime>11/23/2026 6:11:55 PM</DateTime><Exrate CurrencyCode="USD" CurrencyName="US DOLLAR" Buy="25,010.00" Transfer="25,110.00" Sell="25,460.00" /><Exrate CurrencyCode="EUR" CurrencyName="EURO" Buy="27,653.30" Transfer="27,932.63" Sell="29,112.05" /><Exrate CurrencyCode="DKK" CurrencyName="DANISH KRONE" Buy="-" Transfer="3,727.38" Sell="3,870.02" /></ExrateList>');
  assert.strictEqual(fxFx.datetime, '23/11/2026 18:11'); // giờ Mỹ 6:11 PM → 18:11, ngày/tháng đảo đúng
  assert.strictEqual(fxFx.rates.length, 3);
  assert.strictEqual(fxFx.rates[0].code, 'USD');
  assert.ok(fxText(fxFx, null).includes('USD: mua 25,010.00'));
  assert.ok(fxText(fxFx, 'EUR').includes('EUR: mua 27,653.30'));
  assert.strictEqual(fxText(fxFx, 'XXX'), null);
  assert.strictEqual(parseFxXml('<ExrateList></ExrateList>'), null);
  assert.strictEqual(fxCodeOf('ty gia do'), 'USD');
  assert.strictEqual(fxCodeOf('ty gia euro'), 'EUR');
  assert.strictEqual(fxCodeOf('ty gia nhan dan te'), 'CNY');
  assert.strictEqual(fxCodeOf('ty gia'), null);
  c = parseCommand('bot, tỷ giá', NOW); assert.strictEqual(c.type, 'fx'); assert.strictEqual(c.code, null);
  c = parseCommand('bot, tỷ giá USD', NOW); assert.strictEqual(c.type, 'fx'); assert.strictEqual(c.code, 'USD');
  c = parseCommand('bot, thời tiết', NOW); assert.strictEqual(c.type, 'weather'); assert.strictEqual(c.place, '');
  c = parseCommand('bot, thời tiết Hà Nội', NOW); assert.strictEqual(c.type, 'weather'); assert.strictEqual(c.place, 'Hà Nội');
  c = parseCommand('bot, tin tức', NOW); assert.strictEqual(c.type, 'news');
  c = parseCommand('bot, tin mới', NOW); assert.strictEqual(c.type, 'news');
  assert.strictEqual(wmoText(0), 'trời quang');
  assert.strictEqual(wmoText(61), 'mưa');
  assert.strictEqual(wmoText(3), 'nhiều mây');
  const wTxt = weatherText({ current: { temperature_2m: 22.0, weather_code: 3, wind_speed_10m: 10.1 }, daily: { time: ['2026-11-23', '2026-11-24'], temperature_2m_max: [24.9, 18.9], temperature_2m_min: [17.4, 12.1], precipitation_probability_max: [20, 80], weather_code: [3, 61] } }, 'Lạng Sơn');
  assert.ok(wTxt.includes('22°C') && wTxt.includes('nhiều mây') && wTxt.includes('17–25°C') && wTxt.includes('khả năng mưa 20%') && wTxt.includes('Ngày mai'));
  const newsItems = parseNewsItems('<rss><channel><item><title>Bàn giao nhà tình nghĩa tại Lạng Sơn - Báo Lạng Sơn</title><link>https://example.com/1</link><pubDate>Sun, 23 Nov 2026 02:30:00 GMT</pubDate><source url="https://baolangson.vn">Báo Lạng Sơn</source></item><item><title>Tin thứ hai không nguồn</title><link>https://example.com/2</link><pubDate>Sat, 22 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>', 5);
  assert.strictEqual(newsItems.length, 2);
  assert.strictEqual(newsItems[0].title, 'Bàn giao nhà tình nghĩa tại Lạng Sơn'); // hậu tố " - Báo" bị cắt vì đã có thẻ source
  assert.strictEqual(newsItems[0].source, 'Báo Lạng Sơn');
  assert.strictEqual(newsItems[1].source, '');
  const nTxt = newsText([{ label: 'Mặt trận & Lạng Sơn', items: newsItems }], NOW);
  assert.ok(nTxt.includes('📰 Tin mới nhất') && nTxt.includes('Bàn giao nhà tình nghĩa'));
  assert.strictEqual(isLookupQuestion(foldVN('tỷ giá đô la hôm nay bao nhiêu')), true);
  assert.strictEqual(isLookupQuestion(foldVN('giá vàng hôm nay')), true);
  assert.strictEqual(isLookupQuestion(foldVN('tin tức hôm nay có gì')), true);
  assert.strictEqual(isLookupQuestion(foldVN('soạn giúp tôi công văn này')), false);
  // v3.7.1: MỌI lệnh có case xử lý đều phải là lệnh cứng chạy ngay — thiếu là AI chen vào
  // trả lời thay (đã gặp thật: "bot, phiên bản" bị thư ký AI đáp văn hoa, không ra số bản).
  for (const t of ['help', 'list', 'briefing', 'done', 'delete', 'redue', 'remind', 'version', 'update', 'fx', 'weather', 'news']) {
    assert.strictEqual(isRuleStrong({ type: t }), true, `lệnh ${t} phải là lệnh cứng`);
  }
  assert.strictEqual(isRuleStrong({ type: 'add', due: new Date() }), true);
  assert.strictEqual(isRuleStrong({ type: 'add', due: null }), false); // ghi việc thiếu hạn vẫn cho AI hiểu câu tự nhiên trước
  assert.strictEqual(isRuleStrong({ type: 'unknown' }), false);

  // --- Tăng tốc (v3.8) ---
  // (a) Hàng đợi theo chat: cùng chat đúng thứ tự, khác chat chạy song song.
  {
    const order = [];
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const p1 = enqueueChatWork('chat-q1', async () => { await gateA; order.push('A1'); });
    const p2 = enqueueChatWork('chat-q1', async () => { order.push('A2'); });
    const p3 = enqueueChatWork('chat-q2', async () => { order.push('B1'); });
    await p3; // chat khác không phải chờ A1 đang bị giữ
    assert.deepStrictEqual(order, ['B1']);
    releaseA();
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, ['B1', 'A1', 'A2']); // trong cùng chat: A1 xong mới tới A2
  }
  // (b) Thư ký gộp quyết định tìm web vào cuộc gọi hiểu ý: một câu thư ký không tra cứu
  // chỉ tốn đúng 2 cuộc gọi Gemini (hiểu ý + soạn trả lời) — bản cũ tốn 3 (thêm cuộc
  // gọi riêng để quyết định tìm web). Đếm số lần gọi generateContent qua fetch stub.
  {
    let geminiCalls = 0;
    let zaloCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('bot-api.zaloplatforms.com')) { zaloCalls++; return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; }
      geminiCalls++;
      const text = geminiCalls === 1
        ? JSON.stringify({ action: 'secretary', title: null, assignee: null, due_text: null, task_ref: null, reply: null, search: false, query: null })
        : 'Đoạn mở đầu mẫu cho báo cáo.';
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
    };
    const tasksFileTest2 = path.join(__dirname, 'data', 'tasks.json');
    const beforeTasks2 = fs.existsSync(tasksFileTest2) ? fs.readFileSync(tasksFileTest2, 'utf8') : null;
    try {
      const secOk = await handleViaAI('soạn giúp tôi đoạn mở đầu báo cáo', 'chat-sec', 'Việt', 'u-sec', 'chat-sec|u-sec', NOW);
      assert.strictEqual(secOk, true);
      assert.strictEqual(geminiCalls, 2); // hiểu ý + soạn trả lời, KHÔNG còn cuộc gọi quyết định tìm web riêng
      assert.ok(zaloCalls >= 1);
    } finally {
      globalThis.fetch = realFetch;
      delete store.history['chat-sec'];
      if (beforeTasks2 === null) { try { fs.rmSync(tasksFileTest2); } catch {} } else fs.writeFileSync(tasksFileTest2, beforeTasks2);
    }
  }

  console.log('✅ Tất cả kiểm thử đạt.');
}).catch((e) => { console.error(e); process.exit(1); });

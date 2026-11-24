# bot-ghi-viec — kho cập nhật của Bot Mặt trận Lạng Sơn

Kho này là **nguồn phát hành** cho con bot Zalo ghi việc/nhắc việc/đăng bài chạy trên máy
của chủ bot. Từ bản v3.6, bot tự kiểm tra `version.json` ở đây mỗi lần khởi động và mỗi
6 giờ: có bản mới thì tự tải `bot.js` về, đối chiếu mã băm SHA-256 trong `version.json`,
sao lưu bản cũ rồi thay file và khởi động lại (qua `updater.js`). Bản mới lỗi lúc khởi
động sẽ bị tự quay lui và đưa vào "sổ đen" — bot không thử lại chính phiên bản đó nữa.

Mã nguồn ở đây **không chứa** token bot, khóa AI hay dữ liệu công việc — những thứ đó nằm
ở các file riêng trên máy chạy bot và không bao giờ được đưa lên kho.

## Kỷ luật phát hành

- Mỗi bản phát hành mang một số phiên bản **duy nhất** trong `bot.js` (`BOT_VERSION`) và
  `version.json`. **Không bao giờ phát hành lại cùng một số phiên bản** — bản lỗi thì sửa
  và phát hành bằng số **cao hơn** (vì bot đã đưa bản lỗi vào sổ đen).
- `version.json` và `bot.js` phải được đẩy lên trong **cùng một commit** để mã băm khớp.
- `updater.js` không nằm trong danh sách tự cập nhật; thay đổi ở nó phải cài tay bằng zip.

## Sổ hạn công việc (từ v3.12)

Hạn chót cấp cơ quan được lưu **trên nền tảng Mặt trận số** (`mttqlangson.pages.dev`),
không lưu ở máy chạy bot — bot chỉ là một khách hàng của API `/api/bot/so-han` của nền
tảng. Mọi thời gian tính theo **giờ Việt Nam**.

### Lệnh mới

- Ghi hạn: `bot, hạn: Nộp báo cáo — 24/11 17:00` — dấu phân cách `—` hoặc `-`; cũng
  nhận `bot, thêm hạn …`. Các dạng thời hạn bóc được ngay (không cần AI): `24/11/2026`,
  `24/11` (ngày đã qua thì hiểu là sang năm sau), `23:59 ngày 24/11`, `24/11 17:00`,
  `17h30 24/11`, `hôm nay`, `mai` / `ngày mai`, `thứ hai` … `thứ bảy`, `chủ nhật`.
  Không ghi giờ → hạn lúc **23:59** ngày đó. Câu nào bộ bóc hạn không bóc được thì bot
  nhờ AI hiểu rồi **hỏi lại để xác nhận** — trả lời `đồng ý` mới lưu, `hủy` thì bỏ.
- Xem sổ: `bot, sổ hạn` (hoặc `bot, hạn`) — hạn đang mở xếp theo gần nhất, kèm nhãn
  "còn X ngày / hôm nay / QUÁ HẠN X ngày".
- Đóng việc: `xong <từ khóa>` (có hoặc không có `bot,` ở trước) — khớp từ khóa với
  tiêu đề (không phân biệt hoa thường/dấu). Khớp nhiều hạn thì bot liệt kê đánh số để
  chọn; khớp không có thì báo không tìm thấy.
- Dời hạn: `dời hạn <từ khóa> sang <ngày/giờ mới>` — nhiều kết quả cũng chọn bằng số.

### Cấu hình (làm 1 lần trên máy chạy bot)

Tạo file `so-han-config.txt` **cạnh `bot.js`** trên máy Windows, 2 dòng dạng
`KEY=value` (xem file mẫu `so-han-config.example.txt` trong kho này):

```
URL=https://mttqlangson.pages.dev
TOKEN=<token do quản trị nền tảng cấp>
```

Token do **quản trị nền tảng Mặt trận số cấp** (phía máy chủ chỉ lưu bản băm của token).
File này chứa bí mật nên **không bao giờ được đưa lên kho** — giống `token.txt` /
`ai-key.txt`. Chưa có file (hoặc nền tảng không tới được) thì các lệnh Sổ hạn trả lời rõ
là chưa cấu hình/không kết nối được, bot **không** ghi hạn "ảo" ở local; các lệnh khác
vẫn chạy bình thường. Triển khai: chỉ cần đặt file cạnh `bot.js` rồi chờ bot tự cập nhật
lên bản có tính năng (hoặc bot đang chạy bản mới sẵn thì dùng được ngay).

### Cơ chế nhắc

- **Nhắc sáng** theo mốc ngày (giờ VN): còn đúng 3 ngày (T-3), còn 1 ngày (T-1), hết
  hạn hôm nay, và đã quá hạn thì nhắc **mỗi ngày**. Sáng ngày làm việc, lượt nhắc này
  hợp nhất với **bản tin 07:45**: bản tin có thêm mục "⏰ Hạn hôm nay / sắp tới" (quá
  hạn / hết hạn hôm nay / trong 3 ngày tới; không có thì ghi "Không có hạn nào sắp
  tới.") và chính lượt gửi bản tin ghi mốc nhắc — không có hai tin sáng trùng nhau.
  Ngày không làm việc, bot gửi tin nhắc sáng riêng trong khung 07:30–08:30.
- **Nhắc trước hạn ~3 giờ**: ở mọi nhịp kiểm tra (vòng lặp của bot chạy mỗi phút, dữ
  liệu làm mới tối đa 5 phút/lần), hạn nào còn ≤3 giờ là bot nhắc riêng một lượt.
- Chống nhắc trùng: mỗi mốc có một khóa (vd `T3@2026-11-19`, `OD@2026-11-15:2026-11-16`,
  `SOON@2026-11-16`); bot chỉ gửi mốc chưa có khóa trong `cac_moc_da_nhac` phía máy
  chủ và chỉ ghi khóa **sau khi gửi thành công** — bot khởi động lại cũng không nhắc
  lại. Tin nhắc gửi vào đúng các chat mà bản tin sáng vẫn gửi.
- Kiểm thử Sổ hạn: `node test-sohan.js` (không gọi mạng thật — lớp API được giả lập).

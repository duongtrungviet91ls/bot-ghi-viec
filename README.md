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

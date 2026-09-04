# Tank3D Arena

Game bắn tank 3D nhiều người chơi online, chạy thẳng trên trình duyệt.

- **Client**: Three.js (vendored cục bộ, không phụ thuộc CDN ngoài) — dựng cảnh 3D, tank, đạn, camera góc thứ ba.
- **Server**: Node.js + Express + Socket.IO — mô phỏng vật lý authoritative ở 20 tick/giây, đồng bộ trạng thái tới mọi client.

## Chạy thử

```bash
npm install
npm start
```

Mở `http://localhost:3000` trên nhiều tab/máy khác nhau (cùng mạng, hoặc deploy lên server) để chơi cùng nhau.

## Cách chơi

- **W / S**: tiến / lùi theo hướng thân xe tăng
- **A / D**: xoay thân xe tăng
- **Chuột** (click vào màn hình để khoá con trỏ): xoay tháp pháo + camera
- **Click chuột trái / Space**: bắn (có thời gian hồi chiêu)
- **Esc**: thoát khoá con trỏ chuột

Hạ gục người chơi khác để ghi điểm; bạn sẽ hồi sinh sau 3 giây ở một điểm spawn ngẫu nhiên. Bảng xếp hạng (góc trên trái) và kill-feed (góc trên phải) cập nhật theo thời gian thực.

## Deploy để chơi thử online (Render)

Game này cần một server Node.js chạy **liên tục** (vòng lặp game 20 tick/giây + kết nối WebSocket giữ trạng thái người chơi trong bộ nhớ), nên **không deploy được lên Vercel** — Vercel chỉ chạy hàm serverless ngắn hạn, không giữ được state hay giữ kết nối WebSocket lâu dài. Repo này đã có sẵn `render.yaml` để deploy lên [Render](https://render.com) (có free tier, hỗ trợ WebSocket tốt):

1. Đăng nhập [dashboard.render.com](https://dashboard.render.com) bằng tài khoản GitHub của bạn.
2. Chọn **New** → **Blueprint**, kết nối repo `game-tank3D` này. Render sẽ tự đọc `render.yaml` và tạo sẵn Web Service `tank3d-arena` (plan free).
3. Bấm **Apply** để build & deploy (mất khoảng 1–2 phút).
4. Sau khi deploy xong, Render cấp một URL dạng `https://tank3d-arena.onrender.com` — mở URL đó và chơi (gửi link cho bạn bè để chơi cùng).

Lưu ý plan free của Render sẽ "ngủ" sau ~15 phút không có traffic, lần truy cập đầu sau đó sẽ mất khoảng 30–60 giây để server khởi động lại.

*(Nếu vẫn muốn dùng Vercel: chỉ có thể host phần `public/` như site tĩnh và phải chạy phần server Socket.IO ở nơi khác như Render/Railway/Fly.io rồi trỏ client sang đó — phức tạp hơn không cần thiết so với deploy thẳng lên Render.)*

## Cấu trúc dự án

```
server/
  index.js       Express + Socket.IO wiring, game loop (20 Hz)
  Game.js        Logic mô phỏng: di chuyển, va chạm, đạn, sát thương, hồi sinh
  constants.js   Thông số cân bằng game + bản đồ (dùng chung server/client)
public/
  index.html     Khung trang + màn hình đăng nhập
  client.js      Render Three.js, input, dự đoán chuyển động phía client, HUD
  style.css      Giao diện HUD
  vendor/        Bản build Three.js được vendor sẵn (không cần tải từ CDN)
```

## Kiến trúc mạng

Server giữ trạng thái gốc (vị trí, máu, đạn...) và phát broadcast 20 lần/giây qua Socket.IO. Client tự dự đoán chuyển động của xe tăng của mình để cảm giác mượt, đồng thời liên tục hiệu chỉnh nhẹ theo dữ liệu server để tránh lệch trạng thái; xe tăng của người chơi khác được nội suy (interpolate) mượt giữa các gói tin.

## Vì sao không dùng GDevelop?

GDevelop là engine kéo-thả chạy trong GUI riêng (desktop app / gd.games) — không thể chỉnh sửa, chạy hay kiểm thử trực tiếp trong môi trường dòng lệnh này, và tính năng multiplayer của nó phụ thuộc dịch vụ lobby của chính GDevelop. Bản Three.js + Node.js này là mã nguồn mở 100%, tự host được, chạy và test được ngay trong phiên làm việc này, và dễ mở rộng bằng code.

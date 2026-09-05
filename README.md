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

**Máy tính (bàn phím + chuột):**

- **Chuột** (click vào màn hình để khoá con trỏ): xoay xe + tháp pháo + camera **theo chiều ngang (trái/phải)** — thân xe và nòng súng luôn cùng hướng, súng bắn đúng hướng xe đang lái nên không cần căn chỉnh hai trục riêng biệt. Góc nhìn lên/xuống bị khoá cố định (không tự do nhìn dọc) để tránh camera loạn hướng khó điều khiển.
- **W / S**: tiến / lùi theo hướng đang ngắm
- **A / D**: né/di chuyển ngang trái phải (giữ nguyên hướng ngắm)
- **Click chuột trái / Space**: bắn (có thời gian hồi chiêu)
- **Tab**: khoá mục tiêu gần nhất (hỗ trợ ngắm) — tháp pháo + camera sẽ tự bám theo mục tiêu đang khoá (giới hạn tốc độ xoay, không phải auto-aim tuyệt đối); nhấn Tab lần nữa để mở khoá.
- **Esc**: thoát khoá con trỏ chuột (cần thiết trước khi bấm nút "☰ Menu" — khi con trỏ đang khoá, mọi thao tác chuột đều đổ vào canvas theo đúng chuẩn Pointer Lock nên nút Menu tự ẩn đi trong lúc ngắm).

**Điện thoại / máy tính bảng (cảm ứng):** giao diện tự nhận diện thiết bị cảm ứng và hiện bộ điều khiển ảo — không cần bàn phím/chuột:

- **Cần điều khiển ảo** (góc dưới trái): kéo để di chuyển, độ nghiêng càng lớn xe càng chạy nhanh (analog, không chỉ 8 hướng).
- **Vuốt ở nửa phải màn hình**: xoay xe + tháp pháo + camera **theo chiều ngang (trái/phải)** — giống kéo chuột, dùng ngón tay còn lại trong khi ngón kia vẫn giữ cần điều khiển bên trái. Vuốt lên/xuống không có tác dụng (khoá góc nhìn dọc) để tránh camera loạn khó điều khiển. Nửa trái màn hình chỉ dành cho di chuyển (không nhận thao tác ngắm), để tránh việc tay cầm máy chạm nhầm làm súng tự xoay khi đang lái.
- **Nút 🔥** (góc dưới phải): giữ để bắn liên tục.
- **Nút 🎯** (cạnh nút bắn): khoá/mở khoá mục tiêu gần nhất — rất hữu ích trên di động vì vừa lái vừa ngắm chính xác bằng ngón tay khó hơn chuột.

Hạ gục người chơi khác để ghi điểm; bạn sẽ hồi sinh sau 3 giây ở một điểm spawn ngẫu nhiên. Bảng xếp hạng (góc trên trái) và kill-feed (góc trên phải) cập nhật theo thời gian thực. Khi trúng đạn hoặc gây sát thương, số máu bị trừ hiện lên ngay trên xe dạng số bay lên (đỏ khi bạn bị trừ máu, vàng khi bạn gây sát thương cho đối thủ, xanh lá khi hồi máu, tím khi bị chặn nhờ bất tử) để dễ theo dõi giao tranh.

## Vật phẩm rơi trên bản đồ

Tối đa 4 vật phẩm xuất hiện ngẫu nhiên cùng lúc tại các điểm cố định rải khắp bản đồ (mỗi ~12 giây có thêm một cái nếu chưa đủ 4), lái xe tăng cán qua là nhặt được ngay — áp dụng ở cả Đấu trường lẫn Chiến dịch, và cả xe địch AI cũng nhặt được nếu đi ngang qua. Có 9 loại vật phẩm:

- **🛡️ Giáp**: giảm 35% sát thương phải nhận trong 30–60 giây (ngẫu nhiên mỗi lần nhặt). Có hiệu ứng khiên xanh mờ quanh xe khi đang kích hoạt, và đồng hồ đếm ngược cạnh thanh máu.
- **➕ Hồi máu**: hồi ngay 40 máu (không vượt quá máu tối đa).
- **💨 Tăng tốc**: tăng 50% tốc độ di chuyển trong 20 giây.
- **🔃 Bắn nhanh**: giảm thời gian hồi chiêu (bắn nhanh hơn) trong 20 giây.
- **⭐ Bất tử tạm thời**: miễn nhiễm hoàn toàn mọi sát thương trong 4 giây, có hiệu ứng khiên tím phát sáng nhấp nháy quanh xe.
- **⚡ Tia laser**: đạn nhanh, bắn liên thanh cực nhanh, sát thương mỗi viên thấp hơn.
- **🔭 Đạn tỉa**: một phát sát thương rất cao, tốc độ đạn cực nhanh, nhưng hồi chiêu chậm.
- **🎇 Đạn tỏa 3 viên**: mỗi lần bắn ra 3 viên theo hình quạt, mỗi viên sát thương thấp hơn.
- **💣 Đạn nổ**: bay chậm hơn, nổ văng mảnh gây sát thương cho mọi xe (địch) trong bán kính nổ khi chạm mục tiêu/vật cản/hết tầm — không tự gây sát thương cho người bắn.

Vũ khí đặc biệt có tác dụng trong 25 giây rồi tự quay lại pháo thường; các buff/vũ khí đang có hiệu lực hiển thị thành huy hiệu ở góc dưới trái màn hình. Chết thì mất hết buff đang có khi hồi sinh.

## Âm thanh & Minimap

- **Âm thanh**: toàn bộ hiệu ứng âm thanh (tiếng bắn theo từng loại vũ khí, trúng đạn, nổ/tử vong, nhặt vật phẩm, tiếng động cơ khi di chuyển, cảnh báo khi máu thấp, tiếng click nút bấm, thắng/thua ải) được **tổng hợp trực tiếp bằng Web Audio API** ngay trong trình duyệt — không cần tải file âm thanh nào, load trang là có ngay. Âm lượng giảm dần theo khoảng cách tới xe của bạn để tạo cảm giác không gian. Bấm nút 🔊 ở góc trên phải để tắt/bật âm thanh (lưu lựa chọn vào trình duyệt cho lần chơi sau); trình duyệt yêu cầu một thao tác chạm/click đầu tiên mới cho phép phát âm thanh, việc này diễn ra tự động ngay khi bạn bấm nút bất kỳ để vào trận.
- **Minimap**: bản đồ thu nhỏ ở góc dưới phải màn hình, hiển thị toàn cảnh bản đồ nhìn từ trên xuống — vị trí và hướng xe của bạn (mũi tên vàng), vị trí đối thủ/xe địch AI (chấm trắng/đỏ), vật cản (hình chữ nhật xám) và vật phẩm đang xuất hiện (chấm màu theo loại), cập nhật liên tục theo thời gian thực.

## Chế độ chơi

- **⚔️ Đấu trường (PvP)**: nhiều người chơi đấu tự do trong cùng một phòng, hạ gục nhau để tính điểm, hồi sinh sau khi chết. Không có kẻ địch AI, không kiếm được Xu ở chế độ này.
- **🚩 Tổ đội (Team Deathmatch)**: người chơi được tự động chia đều vào **🔴 Đội Đỏ** hoặc **🔵 Đội Xanh** (hệ thống luôn xếp bạn vào đội đang ít người hơn để cân bằng quân số), mỗi đội hồi sinh ở một đầu bản đồ riêng và toàn bộ xe tăng cùng đội đều chung một màu để dễ nhận diện. Đạn/kỹ năng của bạn **không gây sát thương cho đồng đội** (bao gồm cả đạn nổ văng mảnh, tia sét dây chuyền, vũ khí hỗ trợ tự động...). Bảng xếp hạng chia theo đội, mỗi đội hiển thị tổng điểm (tổng số hạ gục) và danh sách thành viên riêng.
- **🎯 Chiến dịch (Vượt ải, PvE)**: chơi một mình, đấu với xe tăng điều khiển bởi AI theo từng ải (8 ải, độ khó tăng dần). Hạ hết địch trong ải để **nhận thưởng Xu** và mở khoá ải tiếp theo; nếu xe của bạn bị hạ, ải thất bại và có thể chơi lại. AI địch sẽ đuổi theo, né chướng ngại vật cơ bản, và ngắm bắn với độ chính xác tuỳ độ khó (Dễ/Vừa/Khó).
- **🔧 Gara nâng cấp**: dùng Xu kiếm được từ Chiến dịch để nâng cấp 4 chỉ số của xe tăng (mỗi chỉ số 5 cấp): **Sức mạnh** (sát thương đạn), **Phòng thủ** (máu tối đa), **Nhanh nhẹn** (tốc độ di chuyển), **Tốc độ bắn** (giảm thời gian hồi chiêu). Trang bị đã nâng cấp áp dụng ở cả ba chế độ.

Tiến trình (tên, Xu, cấp trang bị, ải đã mở khoá) được lưu trong `localStorage` của trình duyệt — không cần đăng nhập, nhưng cũng không đồng bộ giữa các thiết bị/trình duyệt khác nhau, và không có xác thực server nên đây chỉ là kinh tế trong game mang tính giải trí (không phải tiền thật, không chống gian lận tuyệt đối cho PvP).

## Bản đồ

Đấu trường rộng 150×150 (tăng 25% so với trước), với địa hình đa dạng hơn và **đối xứng gương hai trục** để công bằng cho cả Đấu trường lẫn Tổ đội:

- **📦 Thùng hàng** (crate): cụm 4 góc bản đồ + 2 thùng dọc trục giữa — cao vừa, che khuất một phần thân xe.
- **🏚️ Boong-ke** (bunker): cặp công sự trung tâm tạo một lối đi hẹp — điểm giao tranh trọng yếu giữa bản đồ.
- **🧱 Tường dài** (wall): 4 bức tường dài ở rìa bản đồ, chắn tầm nhìn xa giữa các khu vực.
- **🗼 Tháp canh** (tower): 8 cột tháp mảnh rải quanh khu vực giữa sân, phá tầm ngắm thẳng của các loại đạn tầm xa (đạn tỉa, laser) mà không chặn hẳn một hướng nào.

Mỗi loại vật cản có hình dáng/màu sắc riêng để dễ phân biệt từ xa; toàn bộ vẫn dùng chung một bản đồ nền cho mọi chế độ (không có bản đồ riêng theo ải/chương, chỉ đổi tông màu bầu trời — xem code comment trong `server/constants.js`).

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
  index.js        Express + Socket.IO wiring, route join/input/leaveRoom, game loop (20 Hz)
  RoomManager.js   Quản lý phòng đấu trường (1 phòng chung) + phòng chiến dịch (1 phòng riêng/người chơi)
  Game.js          Logic mô phỏng: di chuyển, va chạm, đạn, sát thương, hồi sinh, AI bot, thắng/thua ải
  constants.js     Thông số cân bằng game, bản đồ, bảng nâng cấp, chỉ số bot, danh sách ải
public/
  index.html       Khung trang: màn hình tên/menu/chọn ải/gara + HUD trong trận
  client.js        Render Three.js, input, dự đoán chuyển động, khoá mục tiêu, quản lý tiến trình (localStorage)
  style.css        Giao diện menu + HUD
  vendor/          Bản build Three.js được vendor sẵn (không cần tải từ CDN)
```

## Kiến trúc mạng

Server giữ trạng thái gốc (vị trí, máu, đạn...) và phát broadcast 20 lần/giây qua Socket.IO, theo từng "phòng" (Socket.IO room): một phòng Đấu trường dùng chung cho mọi người chơi PvP, và mỗi lượt chơi Chiến dịch tạo một phòng riêng (chỉ người chơi đó + các bot). Client tự dự đoán chuyển động của xe tăng của mình để cảm giác mượt, đồng thời liên tục hiệu chỉnh nhẹ theo dữ liệu server để tránh lệch trạng thái; xe tăng của người chơi/bot khác được nội suy (interpolate) mượt giữa các gói tin.

Chỉ số trang bị (sát thương, máu, tốc độ, tốc độ bắn) được server tính toán từ cấp nâng cấp (0-5) do client gửi lên khi vào trận — server luôn giới hạn (clamp) cấp trong khoảng hợp lệ, nên client có gian lận cũng chỉ đạt tối đa bằng một người chơi nâng cấp hết mức hợp lệ, không thể vượt trần.

## Vì sao không dùng GDevelop?

GDevelop là engine kéo-thả chạy trong GUI riêng (desktop app / gd.games) — không thể chỉnh sửa, chạy hay kiểm thử trực tiếp trong môi trường dòng lệnh này, và tính năng multiplayer của nó phụ thuộc dịch vụ lobby của chính GDevelop. Bản Three.js + Node.js này là mã nguồn mở 100%, tự host được, chạy và test được ngay trong phiên làm việc này, và dễ mở rộng bằng code.

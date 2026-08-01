# Ghép Panorama Kính Hiển Vi

App React (Vite) để **kéo tiêu bản liên tục** dưới kính hiển vi 3 mắt (qua camera
gắn kính, chia sẻ màn hình cửa sổ phần mềm camera) và **tự động tích luỹ + ghép**
thành 1 ảnh scan lame hoàn chỉnh theo thời gian thực, dùng ORB feature matching +
RANSAC similarity transform (OpenCV.js) — giống cách máy quét panorama cầm tay
hoạt động.

## Cách dùng

1. Bấm **"Chọn cửa sổ / màn hình…"**, chọn đúng cửa sổ phần mềm camera kính hiển vi.
2. (Tuỳ chọn) **Kéo chuột trực tiếp trên khung xem trước** để khoanh vùng cần quét —
   không cần dùng cả cửa sổ được chia sẻ. Bấm "Xoá vùng chọn" để quay lại dùng toàn khung.
3. (Tuỳ chọn) Bấm **"Mở cửa sổ nổi"** để theo dõi ảnh ghép trong 1 cửa sổ nổi trên
   mọi cửa sổ khác, phòng khi cửa sổ chính của app bị che bởi phần mềm camera.
4. Bấm **"Bắt đầu ghép tự động"** (hoặc phím `Space`).
5. Kéo tiêu bản liên tục — kể cả theo kiểu **zigzag** (trái→phải, xuống hàng,
   phải→trái, ...). App chạy hoàn toàn tự động, **không dừng lại để hỏi xác nhận**:
   - Khớp tốt → ghép thẳng.
   - Vùng ít chi tiết, khớp thất bại → **tự ước lượng vị trí** theo hướng di chuyển
     gần nhất (ngoại suy từ 2 ô trước) rồi tiếp tục, đánh dấu ô đó là "ước lượng"
     trong manifest xuất ra để biết chỗ nào nên xem lại.
   - Quay lại gần 1 vùng đã quét trước đó (điển hình khi zigzag) → tự nhận diện và
     chỉnh lại theo điểm tham chiếu cũ, giảm trôi tích luỹ.
6. Xong thì bấm **"Xuất ảnh ghép (PNG)"** để lấy ảnh toàn cảnh, và/hoặc
   **"Xuất toàn bộ ảnh gốc + manifest (ZIP)"** để lấy lại từng ảnh gốc (dùng để
   đếm/phân loại AFB-WBC) kèm file `manifest.csv` ghi vị trí (toạ độ x,y trong
   ảnh ghép), thứ tự chụp, cờ "ước lượng hay không", và thời điểm chụp của từng ảnh.


## Chạy thử (dev)

```bash
npm install
npm run dev
```

M�� địa chỉ được in ra (mặc định `http://localhost:5173`).

## Build bản triển khai

```bash
npm run build
npm run preview   # xem thử bản build, chạy tại localhost
```

Thư mục `dist/` sau khi build có thể triển khai lên bất kỳ static host nào
(Netlify, GitHub Pages, Nginx nội bộ, v.v.).

## Lưu ý quan trọng

- **Cần chạy qua HTTP(S)/localhost**, không mở trực tiếp file `index.html` từ
  ổ đĩa (`file://`) — API chia sẻ màn hình (`getDisplayMedia`) của trình duyệt
  yêu cầu "secure context". `npm run dev`/`npm run preview` đã tự lo việc này.
- **OpenCV.js được tự lưu trữ tại `public/opencv.js`** (cùng gốc/same-origin
  với app), thay vì tải từ CDN `docs.opencv.org`. Lý do: khi deploy lên
  Netlify/Vercel..., tải script từ một origin khác có thể bị trình duyệt chặn
  với lỗi `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` nếu server CDN đó gửi header
  `Cross-Origin-Resource-Policy`. Để cùng gốc thì không gặp vấn đề này, và app
  cũng không phụ thuộc CDN ngoài khi chạy production.
- **Triển khai lên Netlify:** đã có sẵn file `netlify.toml` với
  `command = "npm run build"` và `publish = "dist"`. Trên dashboard Netlify,
  vào **Site settings → Build & deploy → Build settings** và đảm bảo 2 giá trị
  này khớp (nếu bạn tạo site từ trước khi có `netlify.toml`, có thể cần sửa
  tay). Nếu Netlify serve thẳng file nguồn (`src/main.jsx`) thay vì bản build
  trong `dist/`, trình duyệt sẽ báo lỗi
  `Failed to load module script... MIME type of "application/octet-stream"`
  — đây là dấu hiệu build/publish directory bị cấu hình sai.
- Việc ghép ảnh là **ghép liên tiếp (frame-to-frame)**, có thêm 1 lớp **tự chỉnh
  trôi (loop-closure đơn giản)**: mỗi khi 1 ô mới trùng vùng không gian với 1 ô đã
  đặt từ khá lâu trước đó (ví dụ hàng dưới của kiểu quét zigzag chạm lại hàng
  trên), app thử khớp lại trực tiếp với ô cũ đó và ưu tiên dùng kết quả này để kéo
  sai số tích luỹ về đúng vị trí. Đây **không phải** bundle adjustment toàn cục
  (không tối ưu đồng thời mọi ràng buộc), nên với chuỗi rất dài (hàng trăm ô) vẫn
  có thể còn lệch nhẹ ở một số chỗ — quét với độ chồng lấn rộng rãi (~25–35%),
  đặc biệt ở chỗ chuyển hàng, sẽ giúp cơ chế này hoạt động tốt hơn.
- **Cửa sổ nổi (Picture-in-Picture)** dùng API chuẩn của trình duyệt
  (`captureStream` + `requestPictureInPicture`), được Chrome/Edge desktop hỗ trợ
  tốt nhất. Nếu trình duyệt không hỗ trợ, nút này sẽ tự ẩn/báo không khả dụng,
  không ảnh hưởng đến chức năng ghép ảnh chính.
- **Không còn bước xác nhận thủ công nào** — mọi ô đều được đặt tự động. Khi
  không đủ điểm khớp tin cậy (vùng ít chi tiết), app dùng phương án dự phòng:
  **ngoại suy vị trí theo vector di chuyển giữa 2 ô liền trước** thay vì dừng lại.
  Đây là đánh đổi có chủ đích theo yêu cầu — ưu tiên luồng quét liên tục, không bị
  ngắt quãng — nhưng có nghĩa là **một vài ô ở vùng khó có thể bị đặt sai vị trí**
  mà không có cảnh báo chặn luồng. Các ô này được đánh dấu `estimated=1` trong
  `manifest.csv` khi xuất zip, để biết chỗ nào nên kiểm tra lại thủ công nếu cần.
  Cơ chế tự chỉnh trôi theo điểm tham chiếu (mục trên) vẫn hoạt động song song và
  thường sửa lại được phần lớn sai lệch này khi quét quay lại gần đó.
- Ảnh ghép ra chỉ nên dùng để minh hoạ/toàn cảnh; việc đếm/phân loại vẫn nên làm
  trên từng ảnh gốc. Mỗi ảnh gốc được giữ nguyên trong bộ nhớ trình duyệt suốt
  phiên làm việc (dạng `Blob` nhị phân — nhẹ hơn base64 khoảng 25%) để phục vụ
  "Hoàn tác ô cuối" và xuất zip.
  **Lưu ý cho lame ~300 ô (chuẩn WHO):** tuỳ độ phân giải camera, tổng dung
  lượng ảnh gốc giữ trong RAM có thể lên tới vài trăm MB — vẫn ổn với hầu hết
  máy tính, nhưng nếu thấy trình duyệt chậm/giật giữa chừng, hãy xuất zip theo
  từng đợt (ví dụ mỗi ~100 ô: xuất zip → "Đặt lại" → quét tiếp) thay vì cố giữ
  toàn bộ 1 lame trong 1 phiên.
- **Xuất toàn bộ ảnh gốc**: nút "Xuất toàn bộ ảnh gốc + manifest (ZIP)" đóng gói
  từng `tile_XXXX.png` (đúng thứ tự chụp) cùng `manifest.csv` (toạ độ x,y trong
  ảnh ghép, kích thước, thời điểm chụp) — mở trực tiếp bằng Excel để đối chiếu
  vị trí từng ảnh khi cần truy vết một kết quả đếm về đúng chỗ trên lame.
- Trình duyệt khuyến nghị: Chrome/Edge desktop (hỗ trợ `getDisplayMedia` tốt
  nhất). Khi bấm "Chọn cửa sổ / màn hình…", chọn đúng cửa sổ của phần mềm
  camera kính hiển vi trong hộp thoại chia sẻ màn hình của trình duyệt.

## Cấu trúc mã nguồn

- `src/App.jsx` — component chính: quản lý luồng chụp/ghép, canvas mở rộng dần,
  bàn phím tắt (Space/Enter/Esc/mũi tên).
- `src/matrix.js` — các phép toán ma trận 3x3 thuần JS (nhân ma trận, dịch
  chuyển, biến đổi điểm) dùng để tính vị trí ghép.
- `src/cvMatch.js` — bọc các lời gọi OpenCV.js (ORB detect, BFMatcher,
  `findHomography` với RANSAC) để tìm phép biến đổi giữa 2 ô liên tiếp.
- `src/App.css` — giao diện.

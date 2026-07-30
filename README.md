# Ghép Panorama Kính Hiển Vi

App React (Vite) để chụp từng trường nhìn khi kéo tiêu bản dưới kính hiển vi 3 mắt
(qua camera gắn kính, chia sẻ màn hình cửa sổ phần mềm camera) và tự động ghép
thành 1 ảnh scan lame hoàn chỉnh, dùng ORB feature matching + RANSAC homography
(OpenCV.js).

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
- Việc ghép ảnh là **ghép liên tiếp (frame-to-frame)**: mỗi ô chỉ so khớp với
  ô ngay trước, nên chuỗi rất dài có thể trôi (sai số tích luỹ). Ảnh ghép ra
  chỉ nên dùng để minh hoạ/toàn cảnh; việc đếm/phân loại vẫn nên làm trên
  từng ảnh gốc (đã tách riêng và lưu lại từng ô: `dataURL` của từng tile
  trong `App.jsx`).
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

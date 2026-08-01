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

- **Lưu tạm chống mất dữ liệu (IndexedDB).** Mỗi ảnh gốc + vị trí được ghi vào
  IndexedDB của trình duyệt ngay khi chụp (không chỉ giữ trong biến JS) — nên
  nếu tab bị đóng nhầm, crash, hoặc mất điện, mở lại trang sẽ thấy banner
  "Tìm thấy phiên quét dở" và có thể tiếp tục đúng chỗ đang dừng thay vì mất
  sạch. IndexedDB là bộ nhớ trên đĩa của trình duyệt, không phải RAM của tab,
  nên sống sót qua việc đóng/crash tab (chỉ mất khi người dùng chủ động xoá
  dữ liệu trình duyệt, hoặc bấm "Đặt lại" trong app).
- **Kiểm tra độ nét (Laplacian variance).** Mỗi ô chụp được so với đường nền
  (median) độ nét của ~30 ô gần nhất; ô nào nét kém hơn 40% mức nền sẽ bị đánh
  dấu "có thể mờ" — hiện số lượng ở khối Trạng thái, và liệt kê chi tiết trong
  panel "Ô đã chụp". Đây là ngưỡng tương đối, tự thích nghi theo từng phiên
  quét, không phải một con số cố định.
- **Định vị thủ công (khi tiếp tục phiên).** Sau khi "Tiếp tục phiên cũ" hoặc
  "Nhập lại từ ZIP", app **không** tự động dò khớp toàn bộ tile set nữa (bản
  cũ làm vậy — quá nhạy, hễ thấy vân/kết cấu giống là quét lại từ đầu, rất tốn
  thời gian). Thay vào đó: bấm **"Định vị thủ công"**, **bấm vào đúng điểm**
  trên ảnh ghép cần tiếp tục (vùng thiếu, hoặc chỗ cần chụp bù) — hiện 1 dấu
  khoanh tại đó — rồi tìm và ướm đúng vị trí đó dưới kính hiển vi, cuối cùng
  bấm **"Xác nhận vị trí"**. App khi đó chỉ so khớp với **8 ô gần điểm bạn vừa
  chọn nhất** (không phải toàn bộ) — nhanh và chính xác hơn nhiều vì đã có gợi
  ý vị trí từ chính bạn. Nếu không dùng tính năng này, app vẫn hoạt động bình
  thường theo mặc định: tiếp tục nối từ ô cuối cùng, dùng cơ chế ước lượng +
  điểm neo sẵn có như lúc quét ban đầu.
- **Cache đặc trưng vĩnh viễn theo từng ô (tăng tốc).** Trước đây, mỗi khi cần
  so khớp với 1 ô cũ (điểm neo zigzag, xác định lại vị trí, chụp lại 1 ô), app
  giải mã lại ảnh PNG + tính lại đặc trưng ORB **từ đầu mỗi lần**, dù ô đó có
  thể đã được kiểm tra trước đó. Giờ mỗi ô tự giữ lại đặc trưng của chính nó
  sau lần tính đầu tiên (gắn thẳng vào đối tượng ô trong bộ nhớ, không lưu vào
  IndexedDB) — các lần so khớp lặp lại với cùng 1 ô sau đó gần như tức thời.
  Đây là nguyên nhân chính của hiện tượng "trật nhịp, chuyển trục quét tiếp bị
  khựng lại khá lâu" mà bạn gặp phải.
- **Chụp lại 1 ô giữa chuỗi.** Trong panel "Ô đã chụp", bấm "Chụp lại" ở ô cần
  sửa (đưa kính hiển vi về đúng vị trí đó trước) — ảnh mới được so khớp với cả
  ô liền trước lẫn liền sau (nếu có) để xác định lại đúng vị trí, rồi thay thế
  tại chỗ. Các ô khác trong chuỗi không bị ảnh hưởng, không cần "Hoàn tác" lùi
  lại từ cuối.
- **Nhập lại từ file ZIP đã xuất.** File zip xuất ra (`manifest.csv` + ảnh gốc)
  giờ lưu đủ thông tin (kể cả ma trận vị trí) để **nạp lại y nguyên thành 1
  phiên làm việc** — dùng khi đã xuất ảnh, xem lại sau đó (có thể vài ngày sau,
  máy khác) mới phát hiện 1 ô bị lỗi. Nút "Nhập lại từ file ZIP đã xuất…" trong
  khối Công cụ nạp lại toàn bộ ô, sau đó chọn cửa sổ nguồn và dùng "Chụp lại"
  như bình thường để quét bù đúng vị trí đó.
  **Giới hạn:** manifest không lưu số điểm nội (độ tin cậy) của từng phép khớp
  gốc, nên khi nhập lại, các cạnh trong đồ thị vị trí được dựng lại thành chuỗi
  tuần tự với độ tin cậy mặc định — không mất độ chính xác vị trí (vẫn dùng
  đúng ma trận đã lưu), chỉ là các cạnh "điểm neo" đặc biệt trước đó sẽ cần
  hình thành lại tự nhiên nếu quét tiếp qua vùng cũ.
- **Quét nhiều lớp Z (chọn lọc theo từng ô).** Trong panel "Ô đã chụp", nút
  "Quét Z" cho 1 ô cụ thể: chỉnh tiêu cự rồi bấm "Chụp thêm lớp" nhiều lần
  (không di chuyển tiêu bản theo x,y giữa các lần, chỉ vặn ốc lấy nét) — mỗi
  ô có thể có nhiều lớp ở các độ cao tiêu điểm khác nhau. Bấm "Xong" để lưu cả
  chồng ảnh: **lớp nét nhất** (theo cùng chỉ số Laplacian variance đã dùng để
  phát hiện mờ) được dùng để ghép vào ảnh toàn cảnh, còn **toàn bộ chồng ảnh**
  được lưu kèm để xem lại bằng thanh trượt (nhấp nháy qua từng lớp) ngay trong
  panel — không tự động ghép nhiều lớp thành 1 ảnh (không làm EDF/extended-
  depth-of-field), mục đích là để mắt người xác nhận trực quan, phù hợp hơn
  cho việc đếm AFB cần xác nhận thủ công.
  **Giới hạn:** hoàn toàn thủ công (app không điều khiển được motor lấy nét),
  và hiện tại **"Xuất toàn bộ ảnh gốc + manifest (ZIP)" / "Nhập lại từ ZIP"
  chưa mang theo chồng ảnh Z** — chỉ ảnh đại diện (lớp nét nhất) được xuất/nhập;
  chồng ảnh Z chỉ tồn tại trong phiên làm việc hiện tại (có lưu vào IndexedDB
  nên vẫn sống sót qua "Tiếp tục phiên cũ", chỉ không đi qua đường xuất/nhập
  ZIP).
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
- **Tối ưu hoá toàn cục liên tục (điểm khác biệt so với Fiji/Hugin).** Thay vì chỉ
  tin 1 phép khớp cho mỗi ô (chuỗi tuần tự, hoặc để điểm neo ghi đè), mọi phép khớp
  thành công — cả khớp chuỗi lẫn khớp điểm neo khi phát hiện trùng vùng cũ — đều
  được ghi lại thành 1 "cạnh" trong 1 đồ thị vị trí (`src/graph.js`). Mỗi vài khung
  hình, app chạy 1 vòng lặp Gauss-Seidel nhẹ để điều hoà vị trí (x,y) của **toàn bộ**
  các ô sao cho tổng sai lệch trên mọi cạnh là nhỏ nhất — giống nguyên lý bundle
  adjustment/pose-graph optimization dùng trong SLAM, nhưng đơn giản hoá thành bài
  toán tuyến tính vì chỉ tối ưu tịnh tiến (xoay/tỷ lệ giữ nguyên từ phép khớp cục bộ,
  vì tiêu bản dịch chuyển dưới kính hiển vi không tạo biến dạng phối cảnh).
  - Đây là điểm Fiji/Hugin **không có**: các công cụ đó chỉ tối ưu toàn cục theo lô,
    sau khi đã có sẵn toàn bộ ảnh — không tương tác thời gian thực. App này điều hoà
    liên tục ngay trong lúc quét.
  - **Thành thật về giới hạn:** "liên tục" ở đây nghĩa là *vị trí* được điều hoà mỗi
    tick (rất rẻ, chỉ vài phép cộng trừ), nhưng việc **vẽ lại ảnh ghép hiển thị** thì
    làm theo đợt (khi phát hiện lệch đủ lớn, hoặc tối đa mỗi ~25 ô/8 giây) — vẽ lại
    toàn bộ hàng trăm ô mỗi khung hình sẽ không kịp thời gian thực. Có thể thấy ảnh
    ghép "khựng" nhẹ vài giây mỗi khi tự vẽ lại — đó là lúc nó đang áp dụng kết quả
    tối ưu, không phải lỗi.
  - Dùng nút **"Tối ưu & vẽ lại ngay"** để ép chạy hội tụ đầy đủ + vẽ lại ngay lập
    tức — nên bấm trước khi xuất ảnh/zip để đảm bảo kết quả cuối cùng đã ổn định.
  - Đây vẫn là bản đơn giản hoá (chỉ tối ưu tịnh tiến, quan hệ hàng xóm thưa — chủ
    yếu chuỗi + một vài cạnh điểm neo) chứ chưa phải bundle adjustment đầy đủ như
    Fiji (tối ưu mọi cặp chồng lấn, cả xoay lẫn tỷ lệ). Với chuỗi cực dài và nhiều
    vùng khó, kết quả có thể vẫn kém hơn Fiji chạy offline — nhưng bù lại có phản
    hồi trực quan ngay trong lúc quét, điều Fiji không làm được.
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

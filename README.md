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

## Bản sửa lỗi (changelog)

Bản này sửa một loạt lỗi khiến app không dùng được ở quy mô thật (một lame ~300 ô
theo chuẩn WHO). Chạy `npm run test` để kiểm tra các module logic thuần, và
`npm run build` để verify.

### Lỗi làm app chết giữa phiên quét

- **Rò rỉ bộ nhớ WASM (`src/App.jsx`).** Ba nhánh — mất khớp, "di chuyển chưa đủ",
  và `confirmTarget` khi không khớp — giải phóng `kp`/`desc` nhưng **quên `small`**
  (ảnh grayscale thu nhỏ ~90KB trong WASM heap, không được GC). Đây là hai đường
  chạy thường xuyên nhất của vòng lặp, nên chỉ sau vài chục phút quét là heap cạn
  và cả trang bị abort. Nay dùng `freeFeatures()` (mới, trong `cvMatch.js`) để
  không thể giải phóng thiếu.
- **`composite()` warp vào buffer bằng cả khung mosaic.** `cv.warpPerspective`
  nhận `Size(c.w, c.h)` rồi mới `.roi()` xuống vùng nhỏ — tức mỗi ô cấp phát một
  Mat tạm bằng kích thước toàn bộ ảnh ghép (~675MB ở 300 ô), cộng thêm mosaic
  chính. Nay gấp phép dịch `(-rx, -ry)` vào transform và warp trực tiếp vào
  bounding box của ô: chi phí tỉ lệ với kích thước 1 ô, không phụ thuộc độ lớn
  vùng đã quét.
- **Vẽ lại toàn khung mosaic mỗi ô.** `cv.imshow` chuyển đổi từng pixel của Mat
  được truyền vào, nên repaint toàn bộ ở mỗi lần chụp làm chi phí mỗi ô tăng theo
  tổng diện tích — quadratic. Nay ảnh ghép được cập nhật **tăng dần**: chỉ blit
  đúng hình chữ nhật vừa thay đổi (`paintRegion`), full repaint chỉ khi thực sự cần.
- **Giới hạn canvas của trình duyệt.** Quá ~16384px/chiều (và giới hạn diện tích
  thấp hơn nhiều), canvas không báo lỗi mà **im lặng trả về trắng**. Nay khung xem
  tự thu nhỏ khi vượt ngưỡng (`DISPLAY_MAX_DIM/AREA`) và hiển thị % thu nhỏ; pixel
  gốc vẫn nằm nguyên trong Mat, và `exportPNG` render lại từ Mat (không đọc lại
  canvas đã thu nhỏ) nên ảnh xuất ra vẫn đủ độ phân giải.
- **Cache đặc trưng không có giới hạn.** Nay có LRU: giữ tối đa
  `MAX_CACHED_FEATURES` ô, pin 12 ô mới nhất + ô tham chiếu đang dùng. Ô bị loại
  chỉ đơn giản là được tính lại từ blob khi cần.

### Lỗi làm hỏng dữ liệu / hỏng phiên

- **`removeEdgesForTile()` chỉ unlink một đầu (`src/graph.js`).** Nó xoá edge khỏi
  danh sách `edges` và clear `adjacency[idx]`, nhưng **adjacency của ô láng giềng
  vẫn giữ nguyên chính các edge object đó**. Hai hậu quả: (a) sau "Hoàn tác ô
  cuối", `relax()` deref một index không còn tồn tại và **throw ở mọi tick sau
  đó** — tức một lần undo là kết thúc phiên quét; (b) sau mỗi "Chụp lại"/"Quét Z",
  edge cũ vẫn sống và kéo ô về vị trí cũ, mỗi lần chụp lại thêm một lớp rác.
  Có test cho cả hai (`test-graph.mjs`).
- **`activeRefIndex` treo sau undo.** Nó được set bằng index của ô mới ở mỗi lần
  chụp, nên sau khi pop ô cuối nó trỏ ra ngoài mảng → `tiles[undefined]`.
- **`manifest.csv` / `TileConfiguration.txt` xuất toạ độ TRƯỚC tối ưu.**
  `tile.bbox` chỉ được tính lúc ô được đặt và **không bao giờ cập nhật sau
  `relax()`**, nhưng export lại đọc chính bbox đó. Nghĩa là file toạ độ — thứ duy
  nhất nối một kết quả đếm về đúng chỗ trên lame — mô tả một layout khác với ảnh
  ghép xuất kèm, và "Tối ưu & vẽ lại ngay" không sửa được. Nay có
  `refreshBBoxes()` chạy sau mọi lần relax. Việc này cũng khôi phục độ chính xác
  của tìm anchor/candidate theo độ chồng lấn, vốn đang kém dần đúng lúc sai số
  tích luỹ lớn nhất.
- **Vị trí đã tối ưu không được lưu.** Record của từng ô chỉ ghi một lần lúc chụp,
  với transform *trước* relax. Nay `persistMeta()` snapshot transform hiện tại
  (9 số/ô, không đáng kể so với blob) và "Tiếp tục phiên cũ" khôi phục đúng vị trí
  đã hội tụ thay vì lùi về chuỗi thô.
- **IndexedDB trộn hai phiên.** Nếu bỏ qua banner "Tìm thấy phiên quét dở" rồi quét
  mới, record cũ ở index cao vẫn nằm đó trong khi ô mới ghi đè index thấp — crash
  lần sau sẽ khôi phục ra một phiên lắp ghép từ hai lame. Nay DB được xoá tự động
  khi ô đầu tiên của phiên mới được đặt.
- **Edge trỏ vào ô không tồn tại khi load.** Thêm `rebuildAdjacency()` lọc và dựng
  lại index, dùng cho cả "Tiếp tục phiên cũ" và "Nhập lại từ ZIP".

### Lỗi làm tính năng không chạy

- **"Quét Z" chết hoàn toàn (`ReferenceError`).** `finishZCapture` truyền
  `tileW: w, tileH: h` nhưng **không có `w`/`h` nào trong scope đó** (các hàm khác
  destructure chúng từ `grabVideoFrame()`, hàm này thì không). Try/catch bắt lại
  và chỉ hiện "Quét lớp Z thất bại: w is not defined". Nay dùng `best.w`/`best.h`.
- **`quickOverlapCheck` chưa từng hoạt động.** Nó thu nhỏ frame live về max
  **220px** rồi `matchTemplate` với bản cache `_small` ở max **300px** — tức so
  khớp hai độ phóng đại khác nhau của cùng cảnh, điểm gần như luôn dưới ngưỡng
  0.25 → luôn trả `null` → không bao giờ skip tick nào. Nay dùng đúng
  `CROSSCHECK_MAX_DIM`.
- **`expectedDX/DY` sai hệ toạ độ** trong "Chụp lại" và "Quét Z": truyền delta
  world-space vào chỗ `matchTiles` mong đợi offset trong frame riêng của ô láng
  giềng. Nay đi qua `applyInverseLinear` như đường quét chính.
- **Ngoại suy khi `prevIndex === 0`.** Guard cũ là `tiles.length >= 2`, chưa đủ:
  ô tham chiếu có thể chính là ô 0, vốn không có ô trước để lấy vector di chuyển
  → `undefined.transform`.

### Lỗi im lặng

- **`autoTick` không có `catch`** (chỉ `try/finally`). Mọi exception thành
  unhandled rejection: timer vẫn chạy, khối Trạng thái vẫn hiện thông báo thành
  công cũ, và app **lặng lẽ ngừng ghi ô**. Với công việc đọc lame thì đây là kiểu
  lỗi tệ nhất. Nay dừng hẳn và báo rõ, dữ liệu đã chụp vẫn giữ.
- **Poll `opencv.js` vô hạn.** Nếu script 404 (đúng tình huống cấu hình sai
  build/publish mà README đã cảnh báo), trang treo mãi ở "Đang tải bộ xử lý
  ảnh…". Nay timeout 25s kèm hướng dẫn kiểm tra cụ thể.
- `maxRenderedDrift()` chỉ so tịnh tiến, nên chỉnh sửa **thuần xoay** không
  trigger vẽ lại — ảnh ghép hiện lệch mà app tưởng không có gì thay đổi. Nay quy
  đổi sai lệch góc thành dịch chuyển góc ảnh xấu nhất.
- `relax()` giờ bỏ qua edge treo thay vì throw (phòng vệ, không thay thế các fix trên).

### Còn cần làm (chưa sửa trong bản này)

- **Đưa ORB/matching sang Web Worker.** Toàn bộ OpenCV vẫn chạy trên main thread;
  ORB(1500) + BFMatcher crossCheck cho mỗi cặp là khá nặng và có thể vượt
  `AUTO_INTERVAL_MS = 350`, khiến tick bị bỏ và UI đứng khi rebuild.
- **Ngưỡng axis-lock cần hiệu chỉnh trên máy thật.** `AXIS_THRESH_PX = 5`, cấm
  hoàn toàn xoay, cần ≥15 inliers *và* ratio ≥0.25, và reject thẳng nếu cả hai
  trục fail. Hợp lý với stage cơ khí 2 núm x/y; nếu kéo tiêu bản bằng tay thì lệch
  chéo >5px là chuyện thường và sẽ mất khớp liên tục. Đây là quyết định thiết kế có
  chủ đích của bản gốc nên không bị thay đổi ở đây — nhưng nếu thực tế mất khớp
  nhiều, đây là chỗ cần nới trước tiên.
- **Nguồn ảnh.** `getDisplayMedia` là màn hình đã qua nén/resample của phần mềm
  camera, không phải luồng gốc. Nếu camera là UVC thì `getUserMedia` sẽ cho ảnh
  gốc và không cần dò vignette bằng heuristic.
- **Chưa có calibration µm/pixel**, nên manifest chỉ có toạ độ pixel, không map
  được về vernier của stage.
- Không multi-band blending (chỉ feather 8px), không EDF, `App.jsx` vẫn là một file
  lớn, và chỉ có test cho phần logic thuần (phần OpenCV chưa có test).

### Lưu ý về thẩm định

Nếu app được dùng để hỗ trợ đọc AFB thật, cần một bước thẩm định song song (đọc
thủ công so với đọc qua app trên cùng bộ lame) trước khi tin vào kết quả, và giữ
nguyên nguyên tắc đã ghi ở trên: **đếm trên từng ảnh gốc, ảnh ghép chỉ để định
vị**. Lỗi toạ độ manifest ở trên đặc biệt quan trọng vì nó phá đúng sợi dây truy
vết đó.

# Ghép Panorama Kính Hiển Vi — bản đơn giản

Kéo tiêu bản dưới kính hiển vi, app tự đo xem ảnh đã dịch bao nhiêu **pixel theo
trục x và y**, rồi dán khung ảnh vào đúng vị trí đó. Một cơ chế duy nhất, không
có bước xác nhận nào.

## Cách hoạt động

Tiêu bản trượt dưới ống kính cố định thì ảnh chỉ **tịnh tiến**. Nên toàn bộ bài
toán định vị chỉ là: *"so với khung trước, ảnh đã dịch bao nhiêu pixel theo x và
y?"* — và câu đó được trả lời trực tiếp bằng tương quan chéo chuẩn hoá
(`TM_CCOEFF_NORMED`) giữa một mảng nhỏ ở giữa khung trước và khung hiện tại.

Mỗi 200ms:

1. Lấy 1 khung từ vùng quét.
2. Lấy **khung dò** — một mảng nhỏ ở giữa khung vừa được nhận trước đó — và tìm
   nó trong khung mới.
3. Nội suy parabol qua đỉnh tương quan để có độ chính xác dưới 1 pixel.
4. Nếu điểm khớp đủ cao và ảnh đã dịch đủ xa, dán khung mới vào vị trí tích luỹ.

Không keypoint, không RANSAC, không giả thuyết theo từng trục, không bỏ phiếu
đồng thuận giữa hai bộ ước lượng, không ngoại suy bù khi trượt. Khung nào không
đo được thì **bỏ qua**, thử lại khung sau 200ms.

Việc dán là **block copy tại toạ độ nguyên** — không warp, không nội suy. Nghĩa là
mọi pixel trong ảnh ghép đúng là pixel ra từ camera, nguyên vẹn, tại đúng (x, y)
mà bộ đo đặt nó vào.

## Vì sao khung dò phải nhỏ và ở giữa

Khung ảnh camera hiển vi chứa hai loại nội dung:

- **Tiêu bản** — di chuyển khi bạn kéo lame.
- **Vật cố định của đường quang** — vòng vignette/halo thị kính, bụi trên sensor,
  overlay do phần mềm camera vẽ. Những thứ này **không bao giờ di chuyển**; chúng
  cố định trong toạ độ camera.

V� chúng cũng thường là các đường biên tương phản mạnh nhất trong khung. Nếu chúng
nằm trong vùng được tương quan, thì phép khớp tốt nhất là phép khớp giữ chúng ở
nguyên chỗ, và bộ đo sẽ **tự tin báo dịch chuyển bằng 0** dù bạn đã kéo lame đi
bao xa. Ảnh ghép khi đó không bao giờ nhích lên — và không có gì trên màn hình
giải thích tại sao.

Đây là lý do duy nhất và đủ để giữ khung dò nhỏ. App hỗ trợ việc này ba cách:

- Tự dò vùng sáng khi bắt đầu và **lùi vào trong 14%** mỗi phía (viền halo là một
  dải gradient mềm rộng nhiều pixel, nên một hình chữ nhật chỉ *chạm* biên danh
  nghĩa vẫn còn chứa đủ vòng halo để ghim tương quan về 0).
- Vẽ khung dò (vàng) trực tiếp trên khung xem trước, để bạn thấy ngay nó có nằm
  hẳn trong vùng sáng không.
- Kiểm tra độ tối của dải viền vùng quét và cảnh báo thẳng nếu nghi ngờ.

## Chọn kích thước khung dò

Khung dò lấy từ giữa, nên tầm với tối đa mỗi bước là nửa phần còn lại:

| Kích thước | Tầm với/bước | Đánh đổi |
|---|---|---|
| Nhỏ 22% | ±39% khung | An toàn nhất với halo, tầm xa nhất. Cần vùng có chi tiết. |
| Vừa 30% | ±35% khung | Cân bằng — mặc định. |
| Lớn 42% | ±29% khung | Điểm khớp chắc nhất trên vùng thưa chi tiết, nhưng dễ chạm viền. |

Nếu nhật ký báo *"đã kéo quá xa"* thì hoặc kéo chậm lại, hoặc chọn khung dò nhỏ
hơn. Nếu báo *"điểm khớp thấp"* thì thường là vùng thiếu chi tiết hoặc ảnh mờ.

## Nhật ký

Mỗi tick đều ghi lại nó quyết định gì và vì sao, nên "app không chạy" luôn có câu
trả lời cụ thể:

```
10:42:19  ô #7 tại (2104, 0) · dịch +351,+2 · điểm 0.91
10:42:18  mới dịch 31px (cần ≥ 52px), điểm 0.94
10:42:17  đã kéo quá xa (≥182px) — kéo chậm lại hoặc chọn khung dò nhỏ hơn
10:42:15  điểm khớp 0.19 < 0.35 — không định vị được
```

## Chạy thử

```bash
npm install
npm run dev
```

Cần chạy qua HTTP(S)/localhost — API chia sẻ màn hình yêu cầu "secure context",
không mở trực tiếp `index.html` từ ổ đĩa. `npm run build` xuất ra `dist/`, triển
khai lên host tĩnh nào cũng được (đã có `netlify.toml`).

## Khác

- **Chống mất dữ liệu.** Mỗi ô (ảnh + toạ độ nguyên) được ghi vào IndexedDB ngay
  khi chụp, nên tab đóng/crash/mất điện chỉ mất khung cuối. Mở lại sẽ thấy banner
  "Tìm thấy phiên quét dở". Khi tiếp tục, hãy đưa tiêu bản về đúng vị trí ô cuối
  trước khi bấm Bắt đầu — khung đầu tiên sau đó được coi là nối tiếp từ ô cuối.
- **Cảnh báo mờ.** Laplacian variance so với trung vị của ~30 ô gần nhất; ô nào
  dưới 40% mức nền bị đánh dấu. Đây là ngưỡng tương đối, tự thích nghi theo phiên.
- **Xuất.** PNG toàn cảnh (tự thu nhỏ nếu vượt giới hạn canvas của trình duyệt),
  và ZIP gồm từng ảnh gốc + `manifest.csv` (toạ độ x, y nguyên) +
  `TileConfiguration.txt` nếu muốn ghép lại bằng Fiji cho chất lượng cao hơn.
- Vùng chồng lấn: **ô mới ghi đè ô cũ**. Với định vị thuần tịnh tiến, hai bản của
  vùng chồng lấn là cùng những pixel đó (trong giới hạn sai số của bộ đo), nên
  trộn chúng không được gì mà còn mất — trộn hai bản lệch nhau chút ít của cùng
  cấu trúc chính là thứ tạo ra vệt nhoè/nhân đôi ở biên ô.

## Giới hạn đã biết

- **Không có hiệu chỉnh trôi tích luỹ.** Mỗi bước được đo so với bước trước, nên
  sai số cộng dồn theo chiều dài đường quét. Không có loop closure, không có tối
  ưu toàn cục — đó là cái giá của việc bỏ pose graph. Với đường quét dài, hãy
  dùng bản xuất ZIP + Fiji (`Grid/Collection stitching` → `Positions from file` →
  `Defined by TileConfiguration`) để tinh chỉnh lại toàn cục.
- **Không xử lý xoay.** Nếu lame bị xoay giữa hai khung thì tương quan sẽ tụt
  điểm và khung đó bị bỏ qua.
- **Nguồn ảnh là màn hình**, đã qua nén/resample của phần mềm camera. Nếu camera
  là UVC thì `getUserMedia` sẽ cho ảnh gốc — đáng làm nếu chất lượng ảnh quan
  trọng cho việc đếm.
- **Chưa có calibration µm/pixel**, nên toạ độ trong manifest là pixel, không map
  được về vernier của stage.
- Toàn bộ OpenCV chạy trên main thread. Ở đây nhẹ hơn bản cũ nhiều (một lần
  `matchTemplate` mỗi tick thay vì ORB + BFMatcher trên nhiều ứng viên), nhưng
  vẫn chưa dùng Web Worker.

## Lưu ý

Ảnh ghép nên dùng để **định vị và xem toàn cảnh**. Việc đếm/phân loại vẫn nên làm
trên từng ảnh gốc trong bản xuất ZIP. Nếu dùng để hỗ trợ đọc AFB thật, cần một
bước thẩm định song song (đọc thủ công so với đọc qua app trên cùng bộ lame)
trước khi tin vào kết quả.

## So với bản trước

Bản trước có ORB + RANSAC, khoá trục theo từng bước, tương quan pixel làm ý kiến
thứ hai, pose graph + relax Gauss-Seidel, phát hiện loop closure, ngoại suy bù khi
mất khớp, định vị thủ công, quét lớp Z. Bản này bỏ toàn bộ những thứ đó: ~1.240
dòng thay vì ~2.400, một đường đi duy nhất cho mỗi khung, và không có tầng nào có
thể âm thầm từ chối một phép khớp đúng.

Đổi lại, mất hiệu chỉnh trôi tích luỹ và loop closure (xem Giới hạn ở trên). Nếu
cần lại, Fiji làm việc đó tốt hơn ở chế độ offline, và bản xuất ZIP đã có sẵn
toạ độ khởi đầu cho nó.

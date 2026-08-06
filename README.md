# Ghép Panorama Kính Hiển Vi — bản đơn giản

Kéo tiêu bản dưới kính hiển vi, app tự đo xem ảnh đã dịch bao nhiêu **pixel theo
trục x và y**, rồi dán khung ảnh vào đúng vị trí đó. Một cơ chế duy nhất, không có
bước xác nhận nhiều tầng.

## Cách hoạt động

Tiêu bản trượt dưới ống kính cố định thì ảnh chỉ **tịnh tiến**. Nên toàn bộ bài
toán định vị chỉ là: *"so với khung trước, ảnh đã dịch bao nhiêu pixel theo x và
y?"* — và câu đó được trả lời trực tiếp bằng tương quan chéo chuẩn hoá
(`TM_CCOEFF_NORMED`), không cần keypoint, RANSAC, hay pose graph.

Mỗi 200ms:

1. Lấy 1 khung từ vùng quét.
2. Lấy **5 khung dò nhỏ** từ khung tham chiếu, tìm từng khung trong khung mới.
3. Nội suy parabol qua đỉnh tương quan để có độ chính xác dưới 1 pixel.
4. Giữ nhóm khung dò lớn nhất mà tất cả đo ra cùng một dịch chuyển (lệch < 6px).
   Cần ít nhất 2 khung.
5. Nếu ảnh đã dịch đủ xa so với ô cuối, dán khung mới vào vị trí đó.

Khung nào không đo được thì **bỏ qua**, thử lại khung sau 200ms. Không ngoại suy
bù, không đoán vị trí.

Việc dán là **block copy tại toạ độ nguyên** — không warp, không nội suy. Mọi pixel
trong ảnh ghép đúng là pixel ra từ camera, nguyên vẹn, tại đúng (x, y) mà bộ đo
đặt nó vào.

## Hai mốc tham chiếu

Khung dò được lấy từ **hai** mốc, không phải một:

- **Ô cuối cùng đã đặt** — mốc chính xác, vì đo so với nó không tích luỹ sai số.
- **Khung ngay trước đó** — dùng khi khung hiện tại đã ra ngoài tầm với của ô cuối.

Vì sao cần cả hai: mỗi khung dò xuất phát từ một vị trí cố định, nên nó chỉ tìm ra
được dịch chuyển trong một tầm giới hạn. Nếu ảnh dịch quá tầm đó, mọi khung dò đều
báo đỉnh tương quan nằm sát biên vùng tìm, khung bị bỏ — và nếu mốc chỉ cập nhật
khi một ô được *nhận*, thì **mốc không bao giờ nhích**. App sẽ đứng im không phải
tới khung sau, mà tới khi bạn kéo tiêu bản trở lại chỗ trùng với một ô đã đặt từ
lúc nào đó. Một cú giật vượt tầm với là kết thúc phiên quét — và đảo chiều trục
(độ rơ cơ khí, tay chạm vào stage khi đổi núm) đúng là chỗ cú giật đó xảy ra.

Mốc "khung ngay trước đó" luôn chỉ cũ 200ms, nên mất dấu chỉ tốn **1 khung** thay
vì phần còn lại của phiên. Nhật ký ghi `nối qua khung trước` khi điều đó xảy ra.

Nếu vẫn mất dấu 4 khung liên tiếp, app hiện rõ trạng thái **Mất dấu** kèm hướng
dẫn: kéo trở lại vùng đã quét, app tự bắt lại, không cần bấm gì. Nó dừng ghép chứ
không đoán — đoán sai một ô là sai cả phần sau.

## Vì sao khung dò phải nhỏ

Khung ảnh camera hiển vi chứa hai loại nội dung:

- **Tiêu bản** — di chuyển khi bạn kéo lame.
- **Vật cố định của đường quang** — vòng vignette/halo thị kính, bụi trên sensor,
  overlay do phần mềm camera vẽ. Những thứ này **không bao giờ di chuyển**; chúng
  cố định trong toạ độ camera.

Và chúng cũng thường là các đường biên tương phản mạnh nhất trong khung. Nếu chúng
nằm trong vùng được tương quan, thì phép khớp tốt nhất là phép khớp giữ chúng ở
nguyên chỗ, và bộ đo sẽ **tự tin báo dịch chuyển bằng 0** dù bạn đã kéo lame đi
bao xa. Ảnh ghép khi đó không bao giờ nhích lên, và không có gì trên màn hình giải
thích tại sao.

## Kích thước khung dò

Mặc định **8%** của vùng quét, điều chỉnh từ 4% đến 18% bằng thanh trượt. Cố ý
nhỏ: khung dò càng nhỏ thì càng ít khả năng chứa vật cố định, **và** tầm với mỗi
bước càng xa (vì nó xuất phát từ một vị trí cố định, khoảng cách nó còn có thể tìm
ra là khoảng cách từ đó tới bờ xa của khung).

Cái giá của khung dò nhỏ là mỗi khung riêng lẻ dễ khớp sai hơn — ít nội dung nghĩa
là nhiều chỗ trong ảnh tương quan tốt gần bằng nhau. Nên app dùng **5 khung dò
nhỏ** đặt rải trong vùng quét, mỗi khung đo độc lập, và chỉ nhận kết quả mà **ít
nhất 2 khung đồng ý** với nhau.

Cách này giải quyết luôn vấn đề vật cố định: một khung dò vô tình nằm trên bụi,
viền halo hay overlay sẽ báo *"không dịch chuyển"* trong khi các khung khác báo
dịch chuyển thật — nó lệch khỏi nhóm và bị loại. Một khung xấu **không** kéo được
kết quả đi, và không cần phát hiện hay cấu hình gì để điều đó xảy ra.

Đây không phải phép lấy trung vị: trung vị của 5 giá trị trong đó 2 giá trị đến từ
khung dò nằm trên vật cố định vẫn rơi vào khoảng giữa hai câu trả lời. Yêu cầu
đồng thuận nghĩa là một câu trả lời sai phải được **một khung dò độc lập lặp lại**
mới được tin — và hai khung ngẫu nhiên rơi vào cùng một offset sai thì ít xảy ra
hơn nhiều so với một khung.

Chỉ tăng kích thước lên khi nhật ký báo *"không khung dò nào định vị được"* — dấu
hiệu vùng quét thiếu chi tiết, chứ không phải thiếu đồng thuận.

### Khi các khung dò không đồng ý

Nhật ký nói thẳng: *"3/5 khung dò đo được nhưng không khớp nhau — có thể một khung
dò đang nằm trên vật cố định"*. Xử lý theo thứ tự:

1. Bấm **Thu nhỏ vùng quét 10%** một vài lần. Khung dò được tính theo tỉ lệ của
   vùng quét nên nó nhỏ theo, và cả hai lùi xa khỏi viền halo.
2. Kéo chuột chọn lại một vùng nằm hẳn giữa vùng sáng.
3. Nếu ảnh ghép **hoàn toàn không nhích** và mọi khung dò đều đồng ý ở mức 0px:
   toàn bộ vùng quét đang nằm trên vật cố định. Đồng thuận không bắt được trường
   hợp này (chúng đồng ý thật), nên app dựa vào ngưỡng dịch chuyển tối thiểu để
   đứng im *có thông báo* thay vì xếp mọi khung vào cùng một chỗ.

App còn hỗ trợ ba cách nữa:

- Tự dò vùng sáng khi bắt đầu và **lùi vào trong 20%** mỗi phía (viền halo là dải
  gradient mềm rộng nhiều pixel, nên hình chữ nhật chỉ *chạm* biên danh nghĩa vẫn
  còn chứa đủ halo để ghim tương quan về 0).
- Vẽ cả 5 khung dò (vàng) đúng kích thước và vị trí thật trên khung xem trước, để
  bạn thấy ngay có khung nào chạm vào halo/bụi/overlay không.
- Kiểm tra độ tối dải viền vùng quét và cảnh báo thẳng nếu nghi ngờ.

## Nhật ký

Mỗi tick đều ghi lại nó quyết định gì và vì sao, nên "app không chạy" luôn có câu
trả lời cụ thể:

```
10:42:19  ô #7 tại (2104, 512) · dịch +12,+498 · 4/5 khung dò đồng ý (điểm 0.88) · nối qua khung trước
10:42:18  mới dịch 31px (cần ≥ 52px), 4/5 khung dò đồng ý
10:42:17  kéo quá xa (3/5 khung dò mất dấu) — kéo chậm lại
10:42:16  3/5 khung dò không khớp nhau · đo được: 0,0 312,4 0,1 311,3 313,2
10:42:15  không khung dò nào định vị được (điểm cao nhất 0.19 < 0.32)
```

Dòng lúc 10:42:16 là ví dụ đáng chú ý: có hai khung dò báo `0,0` trong khi ba khung
khác báo `~312,3`. Hai khung đó đang nằm trên vật cố định. Nhật ký in ra số đo của
từng khung dò đúng vì lý do này — bạn thấy ngay bao nhiêu khung bị ghim và bị ghim ở
đâu.

## Chạy thử

```bash
npm install
npm run dev
npm run test   # kiểm tra quy tắc đồng thuận giữa các khung dò
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
  dưới 40% mức nền bị đánh dấu. Ngưỡng tương đối, tự thích nghi theo phiên.
- **Xuất.** PNG toàn cảnh (tự thu nhỏ nếu vượt giới hạn canvas của trình duyệt),
  và ZIP gồm từng ảnh gốc + `manifest.csv` (toạ độ x, y nguyên) +
  `TileConfiguration.txt` nếu muốn ghép lại bằng Fiji cho chất lượng cao hơn.
- Vùng chồng lấn: **ô mới ghi đè ô cũ**. Với định vị thuần tịnh tiến, hai bản của
  vùng chồng lấn là cùng những pixel đó (trong giới hạn sai số của bộ đo), nên
  trộn chúng không được gì mà còn mất — trộn hai bản lệch nhau chút ít của cùng
  cấu trúc chính là thứ tạo ra vệt nhoè/nhân đôi ở biên ô.
- Phím **Space** bật/tắt chạy.

## Giới hạn đã biết

- **Không có hiệu chỉnh trôi tích luỹ.** Mỗi bước được đo so với bước trước, nên
  sai số cộng dồn theo chiều dài đường quét. Không loop closure, không tối ưu toàn
  cục — đó là cái giá của việc bỏ pose graph. Với đường quét dài, dùng bản xuất ZIP
  + Fiji (`Grid/Collection stitching` → `Positions from file` → `Defined by
  TileConfiguration`) để tinh chỉnh lại toàn cục.
- **Không xử lý xoay.** Nếu lame bị xoay giữa hai khung thì tương quan tụt điểm và
  khung đó bị bỏ qua.
- **Nguồn ảnh là màn hình**, đã qua nén/resample của phần mềm camera. Nếu camera là
  UVC thì `getUserMedia` sẽ cho ảnh gốc — đáng làm nếu chất lượng ảnh quan trọng
  cho việc đếm.
- **Chưa có calibration µm/pixel**, nên toạ độ trong manifest là pixel, không map
  được về vernier của stage.
- Toàn bộ OpenCV chạy trên main thread. Nhẹ hơn bản cũ nhiều (5 lần
  `matchTemplate` trên mảng nhỏ mỗi tick, thay vì ORB + BFMatcher trên nhiều ứng
  viên), nhưng vẫn chưa dùng Web Worker.

## Lưu ý

Ảnh ghép nên dùng để **định vị và xem toàn cảnh**. Việc đếm/phân loại vẫn nên làm
trên từng ảnh gốc trong bản xuất ZIP. Nếu dùng để hỗ trợ đọc AFB thật, cần một
bước thẩm định song song (đọc thủ công so với đọc qua app trên cùng bộ lame) trước
khi tin vào kết quả.

## So với bản trước

Bản trước có ORB + RANSAC, khoá trục theo từng bước, tương quan pixel làm ý kiến
thứ hai có quyền phủ quyết, pose graph + relax Gauss-Seidel, phát hiện loop
closure, ngoại suy bù khi mất khớp, định vị thủ công, quét lớp Z. Bản này bỏ toàn
bộ: ~1.300 dòng thay vì ~2.400, một đường đi duy nhất cho mỗi khung, không tầng nào
có thể âm thầm từ chối một phép khớp đúng.

Đổi lại, mất hiệu chỉnh trôi tích luỹ và loop closure (xem Giới hạn). Nếu cần lại,
Fiji làm việc đó tốt hơn ở chế độ offline, và bản xuất ZIP đã có sẵn toạ độ khởi
đầu cho nó.

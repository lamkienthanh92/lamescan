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

## Chống trôi: neo vào ảnh ghép

Nếu mỗi ô được đặt **so với ô liền trước**, thì vị trí của ô thứ N là tổng của N
phép đo. Sai số ngẫu nhiên trong các phép đo đó lớn dần theo kiểu bước ngẫu nhiên,
nhưng sai số **có hệ thống** — lệch đều một phía dưới 1 pixel do peak-locking trong
nội suy dưới pixel, do stage hơi xoay, do pixel không vuông — thì lớn dần **tuyến
tính**. Trên một cột dài, nó hiện ra thành cả dải ảnh nghiêng dần: từng hàng vẫn
khớp với hàng bên cạnh, nhưng cả cột đi dạt sang một bên.

Cách sửa là thôi đo so với ô trước, mà đo **so với ảnh ghép đã dựng**. Ảnh ghép là
hệ quy chiếu cố định chứa mọi ô đã đặt, nên vị trí đo từ nó không mang sai số cộng
dồn. Và khi quét zigzag đi ngược lại cạnh một cột cũ, phần chồng lấn với cột đó
chính là thứ vị trí được đo từ — nên vòng quét **tự khép lại**, không cần cơ chế
loop closure riêng.

Cách làm: trích một vùng của ảnh ghép quanh vị trí dự đoán, làm xám và thu về đúng
độ phân giải xử lý, rồi tìm 5 khung dò của khung hiện tại trong đó. Phần ảnh ghép
chưa được vẽ (alpha = 0) được làm phẳng về giá trị trung bình của phần đã vẽ — để
nguyên màu đen thì nó là một vùng tương phản cực mạnh mà tương quan sẽ bám vào.
Cần ít nhất 25% diện tích ô đã có sẵn trong ảnh ghép, và kết quả bị bỏ nếu nó lệch
khỏi dự đoán quá bán kính tìm (không phải tinh chỉnh nữa mà là khớp sai).

Nhật ký ghi `neo vào ảnh ghép (chỉnh Npx)`. **N tăng dần theo đường quét chính là
lượng trôi mà bước này đang bù** — đó là con số để bạn biết hiện tượng trôi lớn tới
đâu.

Tắt được (chỉ để chẩn đoán, xem chuỗi đo thô).

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

### Tự tìm lại vị trí khi mất dấu

Khi mất dấu, vị trí là **chưa biết chứ không phải không thể biết**: ảnh ghép đã chứa
toàn bộ những gì đã quét, nên khung hiện tại có thể được dò tìm trong *tất cả* nó.
Đòi người đọc phải chỉnh kính cho khớp lại với ô cuối là bắt họ làm bằng mắt cái việc
mà máy làm chính xác được — và nó khó thật, vì mép đang để ngỏ của ảnh ghép không có
mốc nào để nhắm quang trường vào.

Nên app tự làm, hai tầng:

- **Thô:** thu nhỏ cả ảnh ghép và khung hiện tại theo cùng một tỉ lệ rồi tương quan.
  Tìm được vị trí gần đúng ở *bất kỳ đâu* trong vùng đã quét, với giá của một phép
  `matchTemplate` trên ảnh nhỏ. Tỉ lệ thu nhỏ được chọn sao cho khung vẫn còn đủ lớn
  (cạnh ngắn ≥ 56px) — thu theo kích thước ảnh ghép không thôi thì với scan lớn khung
  sẽ còn vài pixel và vô dụng.
- **Tinh:** đưa ứng viên đó cho chính bước neo vào ảnh ghép, đo lại ở độ phân giải xử
  lý với đồng thuận 5 khung dò như mọi chỗ khác.

Tầng tinh là thứ làm một đỉnh tương quan thô sai trở nên vô hại — một vị trí sai
không thể qua được yêu cầu 5 khung dò độc lập cùng đồng ý tại đó. Nhờ vậy tầng thô
được phép dễ tính.

**Với bạn nghĩa là:** kéo tiêu bản về **bất kỳ vùng nào đã quét** là xong. Bất kỳ
chỗ nào, không cần đúng mép đang để ngỏ, không cần khớp tâm quang trường với tâm ô
nào cả, không phải bấm gì. App tự nhận ra và tiếp tục. Nhật ký ghi
`đã tự tìm lại vị trí: (x, y) — không cần khớp tay`.

Ảnh ghép cũng vẽ khung viền quanh **ô mới nhất** (nhấp nháy đỏ khi đang mất dấu), để
bạn luôn biết mép nào đang để ngỏ.

Nếu vẫn mất dấu 4 khung liên tiếp, app hiện rõ trạng thái **Mất dấu** kèm hướng
dẫn, và bắt đầu tự dò tìm (xem dưới). Nó dừng ghép chứ không đoán — đoán sai một ô
là sai cả phần sau.

## Chất lượng ảnh: nơi nó bị mất

Toàn bộ đường đi sau lúc chụp là **không mất dữ liệu**: ô lưu dạng PNG, dán bằng block
copy tại toạ độ nguyên (không warp, không nội suy), xuất trực tiếp từ ảnh ghép. Nghĩa
là không bước nào sau đó cứu lại được chi tiết đã không được chụp — chất lượng được
quyết định **ngay tại lúc chụp**.

### Camera trực tiếp so với ghi màn hình

**Ghi màn hình** là lựa chọn tiện và là lựa chọn mất mát. Nó ghi lại *cửa sổ* của phần
mềm camera: nếu cảm biến 2592×1944 đang được xem trong khung 900×700 thì **87% pixel
đã mất** trước khi app nhìn thấy gì, rồi phần còn lại còn bị nén qua đường capture.

**Camera trực tiếp** (`getUserMedia`) đọc thẳng từ thiết bị, và app xin
`width/height: {ideal: 4096}` cùng `resizeMode: 'none'` để trình duyệt thương lượng ra
độ phân giải tối đa của cảm biến thay vì một mặc định 640×480. Cần đóng phần mềm camera
trước, vì nó đang giữ thiết bị.

App hiện độ phân giải **thực tế đã thương lượng** ngay dưới nút — `Nguồn camera:
2592×1944 @ 10fps` — và cảnh báo nếu dưới 1280px. Đây là con số cần xem đầu tiên khi
thấy ảnh kém; nếu nó nhỏ thì mọi thứ khác không quan trọng.

### Khoá phơi sáng và cân bằng trắng

Vệt sáng/tối giữa các ô là do camera **tự quyết định lại** mức sáng và màu giữa các
khung. Nút *Khoá phơi sáng / WB* gọi `applyConstraints` để chốt
`exposureMode`/`whiteBalanceMode`/`focusMode` ở giá trị hiện tại nếu thiết bị cho phép,
và báo lại cái nào khoá được. Đây là xử lý **nguyên nhân**, khác với việc trộn ảnh cho
mờ đường ranh đi.

Không phải camera nào cũng cho điều khiển qua web; khi đó phải tắt chế độ tự động trong
phần mềm camera.

### Bước xuất

PNG là không mất dữ liệu. Chỗ duy nhất có thể giảm độ phân giải là khi ảnh ghép vượt
giới hạn canvas của trình duyệt (~16000px mỗi chiều, ~200 MP) — lúc đó PNG bị thu nhỏ.
App nói trước con số này **ngay cạnh nút xuất**, chứ không để bạn phát hiện sau. Khi đó
dùng bản xuất ZIP: từng ảnh gốc vẫn là PNG nguyên vẹn kèm toạ độ.

Khung xem trên màn hình cũng bị thu nhỏ khi ảnh ghép lớn (hiện `xem ở N%`) — nếu bạn
đang đánh giá chất lượng bằng cách nhìn khung đó thì nó không phản ánh ảnh xuất ra.

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

## Tối ưu vị trí toàn cục

Đây là thứ duy nhất trước đây phải nhờ Fiji, và giờ đã có trong app.

Trong lúc quét, vị trí một ô được quyết định ngay khi đặt và không đổi nữa. Kể cả
khi đo so với cả ảnh ghép, quyết định vẫn là chung cuộc: ô nào đã lệch 3px thì lệch
luôn, và mọi ô đo sau đó thừa hưởng chỗ lệch ấy.

Fiji làm ngược lại. Nó đo dịch chuyển giữa **mọi cặp ô chồng lấn**, coi mỗi phép đo
là một ràng buộc mềm kèm độ tin cậy, rồi **giải ra tập vị trí thoả mãn tất cả tốt
nhất cùng một lúc**. Không phép đo nào là tối hậu, nên một phép đo tồi bị các ô lân
cận áp đảo thay vì lan ra — và đường quét vòng lại buộc phải khớp với chính nó.

Đó là bài toán bình phương tối thiểu có trọng số, và nó **nhỏ**: vài trăm ô, vài
trăm ràng buộc. Không có lý do gì phải cần server.

Cách làm:

1. Tìm mọi cặp ô có độ chồng lấn ≥ 12% — kể cả cặp không liền nhau theo thứ tự
   chụp: ô ở hàng trên, cột mà đường quét đang đi ngược lại cạnh nó. Chính những
   ràng buộc "thêm" này mới cho phép phát hiện và sửa trôi.
2. Với từng cặp: tương quan chuẩn hoá trên vùng chồng lấn, nội suy dưới pixel, lấy
   điểm tương quan làm độ tin cậy.
3. Giải Gauss-Seidel cho `min Σ w·‖(pⱼ − pᵢ) − dᵢⱼ‖²`, giữ ô đầu tiên làm mốc.
4. Lặp lại có gia trọng bền vững (IRLS): cặp nào lệch quá xa nghiệm hiện tại sẽ bị
   giảm trọng số rồi giải lại — nên một cặp đo sai bị chiết khấu thay vì kéo cả
   vùng lân cận theo.

App báo lại con số cụ thể: `sai lệch trung bình giữa các cặp: 8.4px → 0.6px`. Đó là
thước đo trực tiếp cho việc tối ưu đã làm được gì.

`test-optimize.mjs` dựng một đường quét zigzag 6×5 với truth đã biết, làm hỏng vị
trí đúng theo kiểu trôi tích luỹ (0.4px mỗi bước, sai tối đa >10px), rồi kiểm tra
solver khôi phục lại dưới 0.05px. Có một test riêng làm sai lệch một cặp 60px và
kiểm tra không ô nào bị dịch quá 3px.

## Hậu kiểm trước khi xuất

Trong lúc quét, mỗi khung được dán đè lên chỗ cũ — nhanh, đủ để định vị. Nhưng ở
một vị trí thường có vài ô chồng lấn, và chúng **không tốt như nhau tại vị trí
đó**: pixel gần **tâm** khung nằm ở vùng phẳng, đều sáng; cùng chi tiết đó nếu lấy
từ **mép** khung thì dính vignette, gradient halo và quang sai nặng nhất. Dán đè là
chọn bừa giữa chúng.

Nên trước khi xuất, ảnh ghép được dựng lại từ toàn bộ ô cùng lúc, quyết định theo
từng pixel là tin ô nào. Đây chính là *fusion method* của Fiji, và cùng một đánh
đổi: giữ nguyên một pixel gốc thì bảo toàn chi tiết chính xác nhưng còn thấy đường
ranh; trộn nhiều pixel thì mượt ranh nhưng nhoè đúng những chỗ định vị hơi lệch.

| Phương pháp | Làm gì | Dùng khi |
|---|---|---|
| **Chọn pixel tốt nhất** *(mặc định)* | Mỗi pixel lấy từ ô có điểm chất lượng cao nhất — ưu tiên gần tâm khung và ô nét. Không trộn. | Mặc định cho việc đếm: pixel giữ nguyên gốc, không nhoè. |
| **Trộn có trọng số** | Trung bình có trọng số, giảm dần về 0 ở biên khung. | Khi cần ảnh nhìn liền mạch, chấp nhận nhoè nhẹ. |
| **Trộn loại nhiễu** | 2 lượt: lượt đầu tính trung bình, lượt sau bỏ ô lệch quá xa rồi tính lại. | Xoá con trỏ chuột, bụi, mép halo, ô mờ đơn lẻ. Cần ≥3 ô chồng lấn. |
| **Ô mới nhất** | Không hậu kiểm — như lúc quét. | Chỉ để so sánh. |

Trọng số chất lượng là cửa sổ Hann theo cả hai chiều (đạt 1 ở tâm, về 0 ở biên) nhân
với điểm nét của ô. Ô mờ bị **giảm trọng số chứ không bỏ**, để nó vẫn lấp được chỗ
mà không ô nét nào phủ tới, thay vì để lỗ trống.

### Loại ô bằng tay

Danh sách ô có checkbox. Bỏ tích ô nào dính halo, nhoè hay lệch; chỗ trống sẽ được
các ô chồng lấn còn lại lấp vào. Có nút **Bỏ tất cả ô mờ** cho các ô app đã tự đánh
dấu.

Ô bị bỏ **vẫn nằm trong bản xuất ZIP**, đánh dấu `excluded=1` trong `manifest.csv`
và không đưa vào `TileConfiguration.txt`. Nhận định của người đọc được *ghi lại*
chứ không âm thầm áp dụng — để sau này có thể xem lại quyết định đó.

Quy trình: quét → mở danh sách ô, bỏ ô xấu → chọn phương pháp → **Dựng lại & xem
trước** → kiểm tra trên màn hình → xuất. Bất cứ khi nào có ô mới được thêm, bản
dựng bị đánh dấu hết hiệu lực và cần dựng lại.

Xử lý theo từng dải ngang nên bộ nhớ đỉnh không phụ thuộc kích thước phiên quét.

Thứ tự đầy đủ trước khi xuất: **Tối ưu vị trí toàn cục** → bỏ ô xấu → chọn phương
pháp gộp pixel → **Dựng lại & xem trước** → xuất.

## Bản đồ vùng đã quét (cửa sổ nổi)

Trong lúc quét bạn đang nhìn cửa sổ phần mềm camera, không nhìn app — nên ảnh ghép
nằm sau ba cửa sổ khác thì vô dụng. Bản đồ này nhỏ và **nổi lên trên**.

Nền bản đồ là **ảnh thật đã quét**, thu nhỏ — không phải sơ đồ. Bên trên nó là một
lớp tô mỏng (alpha ~26%) chỉ để gợi ý về độ phủ; tắt được bằng checkbox nếu muốn xem
ảnh sạch.

Vì ngoài "chỗ nào đã có pixel", câu hỏi thật là chỗ nào còn phải làm, và có **hai**
câu trả lời khác nhau:

- **Trong suốt** — chưa quét. Thấy ngay.
- **Vàng** — đã quét, nhưng **chỉ 1 lần**, chưa có ô thứ hai chồng lấn. Chỗ đó đã có
  ảnh, nhưng không có ô nào để đối chiếu hay để chọn pixel tốt hơn ở khâu hậu kiểm,
  nên nó xuất ra đúng như khung đã chụp — kể cả phần mép dính halo. Trên một phiên
  quét xong, chỉ viền ngoài cùng nên còn vàng.

Trường hợp thứ hai là thứ **không thấy được trên ảnh ghép** và cũng là thứ âm thầm
làm giảm chất lượng kết quả, nên nó được tô. App còn báo con số:
`23% diện tích đã quét hiện chỉ có 1 ô phủ`.

Ô viền xanh = ô mới nhất, để biết mép nào đang để ngỏ.

Cửa sổ nổi dùng Document Picture-in-Picture (Chrome 116+): DOM thật trong một cửa sổ
luôn nằm trên. Trình duyệt không hỗ trợ thì dùng canvas capture stream qua video PiP —
vẫn luôn nằm trên, chỉ là ảnh không kèm chú giải.

Cửa sổ nổi có **canvas riêng**, tạo bằng DOM thuần, và bản đồ được vẽ vào cả hai
canvas. Đây không phải chi tiết thẩm mỹ: cách làm hiển nhiên hơn — chuyển canvas ở
thanh bên sang cửa sổ kia — **làm chết cả app**. React vẫn ghi nhận node đó là con của
phần tử cha ban đầu, nên lần render sau nó gọi `insertBefore` với một node không còn ở
đó nữa (`The node before which the new node is to be inserted is not a child of this
node`), toàn bộ cây React sập, UI đóng băng và việc ghép ảnh dừng luôn. Một node do
React render **không được** đem ra khỏi tay React; vẽ cùng một hình vào canvas thứ hai
không tốn gì và giữ quyền sở hữu rạch ròi.

Bản đồ vẽ bằng cách thu nhỏ chính canvas hiển thị (đã được scale sẵn), nên nó là một
phép blit GPU chứ không phải thêm một lượt quét qua ảnh ghép.

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

## Kiểm tra tự động

```bash
npm run test
```

Ngoài các test về thuật toán, có `check-hook-order.mjs` — nó chặn đúng lớp lỗi đã làm
crash một bản trước:

```js
useEffect(() => { refreshMinimap(); }, [excluded, refreshMinimap]);
...
const refreshMinimap = useCallback(...);   // khai báo ở dưới
```

Mảng dependency là một biểu thức thường, được đánh giá đúng tại chỗ nó được viết, nên
gọi tên một `const` khai báo phía dưới sẽ throw *"Cannot access '...' before
initialization"* — ngay lúc render, trước khi có gì trên màn hình, với tên đã bị
minify trong stack trace và không gợi ý gì về hook nào gây ra. Linter mặc định không
bắt cái này.

Check được xác nhận theo cả hai chiều: cây code sạch thì pass, và khi cố tình cắm lại
đúng dòng gây lỗi thì nó báo `FAIL App.jsx:109 — hook dependency 'refreshMinimap' is
declared later, at line 146`.

`npm run test` cũng chạy `oxlint` với **`no-undef` bật**, và lint fail là fail cả test.
Cấu hình oxlint mặc định không bật rule này, nên một biến chưa khai báo lọt qua được
cả lint lẫn build (Vite không type-check) và chỉ nổ lúc render — đúng như
`ReferenceError: miniBoxRef is not defined` ở một bản trước, khi bốn dòng `useRef`
không được thêm vào nhưng chỗ dùng thì có. `env`/`globals` được khai báo cho `browser`,
`cv` và `documentPictureInPicture` để rule này không báo sai.

Rule cũng được kiểm chứng bằng cách xoá lại đúng dòng khai báo đã thiếu:
`x eslint(no-undef): 'miniBoxRef' is not defined` — 4 lỗi, exit code 1. Và nó đã bắt
được một lần lặp lại y hệt ngay trong lượt sửa sau đó (`'readbackCanvas' is not
defined` trong `fuse.js`, thiếu import) — trước khi đóng gói, không phải sau.

`readbackCanvas()` trong `src/canvasutil.js`: mọi canvas bị đọc lại pixel — bởi
`cv.imread`, vốn gọi `getImageData` bên trong, hoặc bởi `getImageData` trực tiếp — phải
được tạo với `willReadFrequently`. Thiếu nó thì trình duyệt giữ canvas trên GPU và mỗi
lần đọc lại là một lần dừng đồng bộ để kéo pixel về, đúng cái console cảnh báo. Thuộc
tính này chốt cứng khi context 2D được tạo lần đầu và không đổi được sau đó, nên phải
yêu cầu trước khi bất cứ thứ gì chạm vào canvas — kể cả trước khi đưa cho `cv.imread`,
vì nếu không chính nó sẽ tạo context với thiết lập mặc định.

## Chạy thử

```bash
npm install
npm run dev
npm run test   # đồng thuận khung dò + chuyển hệ toạ độ khi neo + quy tắc hậu kiểm
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
- **Xuất.** PNG toàn cảnh (nhớ chạy hậu kiểm trước) (tự thu nhỏ nếu vượt giới hạn canvas của trình duyệt),
  và ZIP gồm từng ảnh gốc + `manifest.csv` (toạ độ x, y nguyên) +
  `TileConfiguration.txt` nếu muốn ghép lại bằng Fiji cho chất lượng cao hơn.
- Vùng chồng lấn lúc đang quét: **ô mới ghi đè ô cũ** (nhanh). Việc chọn pixel tốt
  nhất diễn ra ở khâu hậu kiểm trước khi xuất — xem mục trên.
- Phím **Space** bật/tắt chạy.
- Bản đồ vùng đã quét mở được thành cửa sổ nổi luôn nằm trên cửa sổ camera.

## Giới hạn đã biết

- **Chỉ mô hình tịnh tiến.** Cả bước tối ưu toàn cục cũng chỉ giải ra vị trí x, y —
  không xoay, không tỉ lệ, không biến dạng phi tuyến. Nếu stage của bạn có xoay
  đáng kể, hoặc ống kính có méo hình rõ, thì đây là giới hạn thật và Fiji (hoặc
  ASHLAR) sẽ tốt hơn.
- **Vùng chồng lấn thiếu chi tiết** thì phép đo cặp thất bại và ràng buộc đó không
  tồn tại. Vùng nền trắng của tiêu bản là chỗ hay gặp. App báo số cặp đo được trên
  tổng số cặp; nếu tỉ lệ đó thấp thì kết quả tối ưu yếu.
- **Con trỏ chuột bị dán vào ảnh.** Trình duyệt thường bỏ qua `cursor: 'never'`.
  Đưa con trỏ ra ngoài vùng quét trước khi bắt đầu — ngoài việc làm bẩn ảnh, một
  con trỏ đứng yên là vật cố định trong khung và sẽ làm lệch phép đo.
- **Ghép nối thấy được vệt sáng/tối giữa các ô** nếu camera đang tự động điều chỉnh
  phơi sáng hoặc cân bằng trắng. Chưa có bù gain. Cách xử lý hiện tại: tắt
  auto-exposure và auto-white-balance trong phần mềm camera trước khi quét.
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

## So với Fiji

| | App này | Fiji Grid/Collection |
|---|---|---|
| Đo cặp ô | Tương quan chuẩn hoá + nội suy dưới pixel | Phase correlation (FFT) |
| Tối ưu toàn cục | Có — bình phương tối thiểu có trọng số + IRLS | Có |
| Gộp pixel | 4 phương pháp (tốt nhất / trộn / loại nhiễu / mới nhất) | Tương tự |
| Xoay, tỉ lệ, méo hình | **Không** | Không (bản Grid/Collection cũng chỉ tịnh tiến) |
| Chống vật cố định (halo, bụi, con trỏ) | **Có** — khung dò nhỏ + đồng thuận + trộn loại nhiễu | Không có khái niệm này |
| Chạy trực tiếp lúc quét | Có | Không (chỉ xử lý offline) |
| Loại ô bằng tay, ghi lại quyết định | Có | Không |

Chỗ Fiji còn hơn: phase correlation trên toàn vùng chồng lấn thường bền hơn tương
quan trên mảng nhỏ khi ảnh có nhiễu; và nếu cần mô hình biến đổi phức tạp hơn tịnh
tiến thì phải dùng Fiji hoặc ASHLAR. Ngược lại, Fiji không biết gì về vòng halo —
nó sẽ vui vẻ bám vào đó y như bản đầu của app này.

## So với bản trước

Bản trước có ORB + RANSAC, khoá trục theo từng bước, tương quan pixel làm ý kiến
thứ hai có quyền phủ quyết, pose graph + relax Gauss-Seidel, phát hiện loop
closure, ngoại suy bù khi mất khớp, định vị thủ công, quét lớp Z. Bản này bỏ toàn
bộ: ~1.300 dòng thay vì ~2.400, một đường đi duy nhất cho mỗi khung, không tầng nào
có thể âm thầm từ chối một phép khớp đúng.

Đổi lại, mất hiệu chỉnh trôi tích luỹ và loop closure (xem Giới hạn). Nếu cần lại,
Fiji làm việc đó tốt hơn ở chế độ offline, và bản xuất ZIP đã có sẵn toạ độ khởi
đầu cho nó.

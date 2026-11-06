# Nhật ký thay đổi
Mỗi lần sửa (mỗi Pull Request): tăng VERSION (sửa lỗi → số cuối, tính năng → số giữa) và thêm đúng một mục mới ở đầu
danh sách, theo mẫu bên dưới. Hàng chờ gộp tự đổi sang số kế tiếp khi hai nhánh cùng lấy một số.
## 1.30.0 · 06/11/2026
### Tính năng
- Tiện ích Chrome đăng 3 bài cùng lúc (tiện ích 1.17.0)
  - Trước đây một Chrome chỉ chạy tối đa 2 bài song song; nay 3 bài, mỗi bài một tab trên một trang khác nhau. Chạy
    chiến dịch nhiều social trên VPS Windows nhanh hơn khoảng một phần ba.
  - Giữ nguyên quy tắc an toàn: không bao giờ chạy 2 bài trên cùng một trang (bài sau có thể ghi đè bản nháp của bài
    trước). Tab chờ bạn xử lý (CAPTCHA, chưa đăng nhập, bài lỗi để xem) vẫn không chiếm chỗ. Kiểm tra đăng nhập (Test)
    vẫn chạy từng cái một.
  - Chỉ cần nạp lại tiện ích 1.17.0; máy chủ không đổi.

## 1.29.1 · 06/11/2026
### Sửa lỗi
- Tiện ích 1.16.0 báo "Lỗi kết nối: supportedEngines must contain no more than 30 elements" và không nhận bài nào
  - Mỗi lần xin bài, tiện ích gửi danh sách luồng nó đăng được. Bản 1.16.0 có 33 luồng (thêm Invision, Flarum, Zendesk)
    nhưng máy chủ chỉ nhận tối đa 30, nên từ chối mọi lần xin bài. Bấm Test đăng nhập vẫn chạy vì đi đường khác.
  - Nay giới hạn bằng đúng số luồng máy chủ biết, nên thêm luồng mới không gây lại lỗi này. Không cần sửa tiện ích:
    triển khai backend xong, bấm "Kiểm tra ngay" trên tiện ích.

## 1.29.0 · 06/11/2026
### Tính năng
- Thêm luồng đăng bằng tiện ích Chrome cho Unraid Forums, aaPanel Forum, cPanel Community (tiện ích 1.16.0)
  - Rà lại cả danh mục: 14 nền tảng chưa có luồng đăng. Làm được 3 nền tảng, mỗi nền tảng một kiểu diễn đàn mới dùng
    lại được cho diễn đàn cùng phần mềm:
    - **Unraid Forums** (Invision Community): mặc định box General Support; tiện ích điền tiêu đề, nội dung có định dạng,
      bấm Submit Topic. Invision cho khách đăng bằng email, nên form có ô email nghĩa là Chrome chưa đăng nhập: tiện ích
      dừng, không bao giờ đăng dưới danh nghĩa khách.
    - **aaPanel Forum** (Flarum): mặc định tag General; đổi tag bằng trang `…/forum/t/<tag>` (support, tutorial). Tiêu đề
      tối đa 80 ký tự, nội dung Markdown. Nếu Flarum hỏi tag thì tiện ích chọn theo ô Chuyên mục rồi xác nhận.
    - **cPanel Community** (cộng đồng Zendesk): ghi tên topic ở ô Chuyên mục (hoặc URL chọn sẵn topic); chưa có topic thì
      dừng trước khi điền.
  - Tiện ích nhận ra tài khoản đang đăng nhập trên 3 trang này: Flarum đọc username trong dữ liệu khởi động của trang,
    Zendesk hỏi `users/me`, Invision đọc menu người dùng hoặc trang hồ sơ.
  - Nhận ra bài đang chờ quản trị viên duyệt trên 3 trang này (trước đây chỉ khớp chữ "post / article / question").
  - Không làm luồng, vì không đăng bài viết được hoặc không nên: KubeBy (tên miền không còn), In Plain English
    (publication trên Medium, phải được nhận làm writer), Hub (chưa rõ nền tảng, đang tắt), Flipboard và Scoop.it (chỉ
    lưu lại link bài có sẵn), Eventbrite (tạo sự kiện thật), Gumroad (tạo sản phẩm bán), Dailymotion và TikTok (chỉ
    video), Redis Community Forum (đã đóng), Warrior Forum (điều khoản cấm tự động).
  - Cấu trúc form dựng từ mã công khai của Invision, Flarum, Zendesk và dữ liệu công khai của aaPanel (danh sách tag);
    chưa thử đăng thật vì chưa có tài khoản. Sau khi cập nhật backend chạy `scripts/sync-extension-flows.cjs --apply`,
    nạp lại tiện ích 1.16.0, thêm tài khoản rồi bấm Test.

## 1.28.3 · 06/11/2026
### Sửa lỗi
- Lượt đăng không còn kẹt ở bước xác nhận tài khoản: Linux Foundation Forum, MeWe (tiện ích 1.15.1)
  - **Mở trang hồ sơ khi đăng bài, như khi bấm Test.** Trang của một số nền tảng (Linux Foundation Forum, MeWe…) không
    cho biết tài khoản đang đăng nhập; chỉ trang hồ sơ (có nút Edit Profile của chủ hồ sơ) mới chứng minh được. Bấm
    Test thì tiện ích có mở trang hồ sơ nên đạt, còn lượt đăng thì không: tiện ích nhảy về trang chủ diễn đàn rồi
    chờ hết 3 phút và báo "Chưa xác nhận được đúng tài khoản sau đăng nhập", trông như "mở lên để đấy".
    Nay lượt đăng cũng mở trang hồ sơ đã cấu hình; xác nhận xong thì vào thẳng trang soạn bài và điền.
  - **MeWe:** tiện ích còn hỏi chính MeWe tài khoản đang đăng nhập là ai (bằng phiên sẵn có trên Chrome) và chỉ chấp
    nhận khi trùng username / URL hồ sơ đã cấu hình (ví dụ `vpsttt_group`). Dự phòng: link hồ sơ của chính mình ở đầu
    trang hoặc thẻ hồ sơ trên /myworld; link trong bài đăng, story hay chat của người khác không được tính.
  - Cần nạp lại tiện ích 1.15.1 trên máy Windows rồi bấm "Giao lại cho tiện ích" ở các bài đang chờ.

## 1.28.2 · 06/11/2026
### Sửa lỗi
- Báo rõ khi tiện ích Chrome là bản cũ và bỏ qua bài, thay vì để bài "Chờ tiện ích" mãi
  - Tiện ích chỉ nhận bài của nền tảng mà nó có luồng đăng. Bản cũ (trước 1.15.0) không có luồng Hugging Face, Linux
    Foundation Forum, Ubiquiti, Blogger. Bài của các nền tảng này nằm "Chờ tiện ích Chrome" mãi dù Chrome đang mở và
    rảnh, trong khi các nền tảng khác vẫn đăng bình thường.
  - Mỗi lần Chrome xin bài, máy chủ ghi chú vào bài đang chờ mà bản tiện ích đó không đăng được: Chrome nào, thiếu luồng
    nào. Ghi chú làm mới tối đa 5 phút một lần, không đổi trạng thái bài. Trang Publishing (frontend 1.33.1) hiện
    **"Tiện ích cần cập nhật"** kèm hướng dẫn. Chạy được cả với tiện ích bản cũ đang cài, không cần sửa tiện ích.

## 1.28.1 · 06/11/2026
### Sửa lỗi
- Bài AI viết không còn câu "Mình làm ở VPSTTT…" lạc chỗ; bài mạng xã hội ngắn có bố cục gọn
  - **Câu tự giới thiệu chỉ khi cần.** Chỉ bài trên diễn đàn, cộng đồng, trang lập trình viên (và Product Hunt) có câu
    nói mình làm ở công ty, và chỉ khi bài thật sự nhắc hoặc gợi ý sản phẩm. Câu đó nằm ngay trong câu nhắc sản phẩm,
    không đứng riêng, không ghép với mẹo khác. Bài trên mạng xã hội, blog, kênh ảnh / video đăng bằng tài khoản của
    công ty nên không có câu này.
  - **Bỏ câu mẫu cố định.** AI không còn được đưa sẵn câu "Mình làm ở VPSTTT, bên cung cấp VPS và proxy…" nên bài không
    lặp nguyên văn câu đó.
  - **Bố cục bài mạng xã hội ngắn** (Bluesky, Mastodon, Threads, X, LinkedIn…): một câu mở đầu, phần thân là một đoạn
    ngắn hoặc 2–4 gạch đầu dòng (lưu ý của ý nào nằm trong ý đó), rồi đúng một câu kết hoặc một câu hỏi.
  - **AI chấm và AI duyệt cuối bắt lỗi này.** Câu tự giới thiệu thừa (tài khoản công ty, bài không nhắc sản phẩm),
    đứng riêng hoặc ghép với ý khác bị trừ điểm / bị từ chối kèm lý do; bài ngắn có nhiều câu kết rời rạc bị trừ điểm.
  - Có hiệu lực ngay sau khi triển khai, không cần đồng bộ lời dặn trong cơ sở dữ liệu.

## 1.28.0 · 06/11/2026
### Tính năng
- Viết lại bằng AI do Claude Opus làm, chỉ sửa chỗ bị nhắc và giữ phần đã ổn
  - **AI sửa bài mới `AI_REVISER`**, mặc định `vpsttt:claude:opus`. "Viết lại bằng AI" và "Sửa theo khuyến nghị" do Opus
    sửa, không còn do AI viết của chiến dịch (GPT). Key VPSTTT AI chưa cấu hình thì dùng AI viết như cũ. `GET /ai/roles`
    trả thêm `reviser`.
  - **Chỉ sửa chỗ bị nhắc.** AI được dặn chỉ sửa đúng câu mà khuyến nghị / hướng dẫn chỉ ra, giữ nguyên tiêu đề, bố cục,
    hashtag và các câu khác. Trước đây, nếu bài sửa chưa đạt, các lượt sửa tiếp theo **viết lại từ đầu theo brief** và bỏ
    mất bài cũ, nên điểm hay tụt. Giờ mỗi lượt sửa tiếp theo sửa trên bản tốt nhất với nhận xét mới.
  - **Không lưu bản tệ hơn.** Bản sửa vẫn chưa đạt mà điểm thấp hơn bản hiện tại thì giữ nguyên bản hiện tại và báo "Bản
    AI sửa chỉ được X/10, thấp hơn bản hiện tại (Y/10)…".
  - **Khuyến nghị không còn bị cắt giữa câu.** Lý do từ chối của AI duyệt cuối ghi vào ghi chú bài chỉ gồm các lý do
    trọn vẹn (danh sách đủ vẫn ở `aiApproval.reasons`). Trước đây ghi chú bị cắt ở 450 ký tự, sinh ra khuyến nghị cụt như
    "Câu discl".

## 1.27.0 · 06/11/2026
### Tính năng
- Claude Opus vừa chấm vừa duyệt cuối; AI viết không còn chép brief vào bài
  - **Gộp chấm và duyệt cuối.** `AI_REVIEWER` mặc định là `vpsttt:claude:opus` như `AI_APPROVER`:
    - Lần chấm cuối của Opus trên đúng bản lưu là kết quả duyệt (`aiApproval`), không gọi thêm lượt duyệt riêng.
    - Nhận xét của Opus được gửi lại cho AI viết sửa ngay trong lượt viết lại. Trước đây Sonnet chấm đạt rồi Opus từ
      chối, AI viết không bao giờ thấy lý do.
    - Opus chỉ đọc lại thêm một lần khi bản lưu khác bản đã chấm (bài được rút gọn, có ảnh mới thiết kế, lượt chấm lỗi).
    - Sửa tay rồi duyệt lại vẫn là một lượt Opus như cũ.
  - **Viết đúng ngay từ đầu.** Lý do chính bài bị từ chối là AI viết chép chỉ dẫn của brief vào bài ("nội dung gắn với
    thương hiệu…", "chưa xác nhận hỗ trợ IPv6", ghi chú "trước khi đăng hãy thêm…"). Giờ AI viết được dặn:
    - brief là chỉ dẫn, không chép vào bài;
    - điều chưa xác nhận thì bỏ hẳn;
    - công khai bằng một câu tự nhiên ngôi thứ nhất ("Mình làm ở VPSTTT, bên cung cấp VPS và proxy.");
    - nơi đăng không hợp thì báo không nên đăng, không ghi chú vào bài.
  - AI chấm và AI duyệt cùng bắt lỗi lộ chữ nội bộ hoặc câu công khai cứng (chấm tối đa 6/10), và coi câu công khai tự
    nhiên là đúng.
  - Máy chủ đã đặt `AI_REVIEWER=vpsttt:claude:sonnet` trong `.env` thì xoá dòng đó (hoặc đổi sang `vpsttt:claude:opus`)
    để dùng cách mới.

## 1.26.0 · 06/11/2026
### Tính năng
- AI chấm điểm các gợi ý chiến dịch để chọn gợi ý phù hợp nhất
  - Sau khi AI đưa 4 gợi ý, một lượt AI riêng (không phải AI vừa viết gợi ý) chấm từng gợi ý từ 1 đến 10 theo: hợp mọi
    nền tảng đã chọn, giá trị cho người đọc, gắn sản phẩm tự nhiên (không bịa thông tin), khả năng tương tác (dựa trên
    kết quả các chiến dịch trước); điểm tổng là kết quả dự kiến, các gợi ý được so với nhau để không trùng điểm. Kèm
    điểm yếu chính của từng gợi ý.
  - API trả gợi ý xếp điểm cao trước, gợi ý đầu có `recommended: true`, mỗi gợi ý có `review`; `scored: false` khi lượt
    chấm lỗi (vẫn trả gợi ý, chưa có điểm). Một lần gợi ý giờ gồm 2 lượt AI.

## 1.25.0 · 06/11/2026
### Tính năng
- Xoá một lượt nội dung AI khỏi Content đợi duyệt
  `DELETE /campaigns/:id` (ADMIN, EDITOR) xoá lượt AI cùng các bài chưa đăng, job đăng và nội dung brief tạo riêng cho
  lượt đó. Nội dung lấy từ thư viện thì giữ lại.
  - **Không cho xoá**, kèm lý do tiếng Việt:
    - khi AI đang viết bài cho lượt;
    - khi đang có bài được đăng hoặc tiện ích Chrome đang làm;
    - khi lượt đã có bài lên social (giữ lịch sử đăng).
  - Dòng của lượt được khoá trong lúc xoá để worker không nhận chạy giữa chừng. Mỗi lần xoá được ghi nhật ký
    (`CAMPAIGN_AUTOMATION_DELETED`).

## 1.24.0 · 06/11/2026
### Tính năng
- Quy trình 3 vai AI: AI viết, AI chấm (bắt seeding và rủi ro cho công ty), AI duyệt cuối chặn đăng
  Cần migration mới `20261106120000_content_variant_ai_approval`, chỉ thêm cột `content_variants.aiApproval` và tự chạy khi
  backend khởi động. Hướng dẫn đầy đủ trong `README.md`, mục "Quy trình 3 vai AI".
  - **Ba vai độc lập, đều chọn được trong các model của key VPSTTT AI:**
    - **AI viết** là AI chọn ở hộp tạo bài. Muốn GPT viết qua key IDE thì đặt `VPSTTT_AI_MODEL=gpt:`.
    - **AI chấm:** `AI_REVIEWER`, mặc định `vpsttt:claude:sonnet`.
    - **AI duyệt cuối:** `AI_APPROVER`, mặc định `vpsttt:claude:opus`.
    - Mỗi lượt gọi dùng đúng model của vai đó. `GET /ai/roles` trả 3 vai cho giao diện.
  - **AI chấm đánh trượt bài dù điểm cao khi:**
    - có **seeding vụng**: giả làm khách hàng, khen quá, nhắc sản phẩm gượng ép, nhiều link, giọng quảng cáo, hạ thấp đối
      thủ, quảng bá không công khai;
    - hoặc **rủi ro cho công ty** từ mức trung bình trở lên: nói quá hoặc sai về sản phẩm, hứa hẹn không căn cứ, hướng dẫn
      lách luật hay vi phạm điều khoản, nội dung nhạy cảm.
    Nhận xét được gửi lại cho AI viết để sửa. AI chấm lỗi thì bài không còn được coi là đạt.
  - **AI duyệt cuối** đọc đúng bản sẽ đăng, mô tả ảnh và nhận xét của AI chấm, rồi quyết định cho đăng hay không. Kết quả lưu
    kèm dấu nội dung.
  - **Cổng chặn** (`AI_APPROVAL_ENABLED=true`): mọi lối duyệt và đăng chỉ cho qua bài được duyệt cuối đúng nội dung hiện tại:
    từng bài, cả lượt, nội dung có sẵn, Studio, MCP, và worker đăng.
    - Bài bị từ chối thì không ai duyệt được.
    - Sửa tay hoặc viết lại bằng AI thì máy chủ tự duyệt lại; `POST /content-variants/:id/ai-approval` để chạy lại.
    - "Duyệt tất cả" giữ bài chưa đạt lại và trả `unapprovedVariants`.
    - Bài đã duyệt trước bản này vẫn đăng như cũ.
  - **Giới hạn:** AI chat của VPSTTT chỉ nhận chữ, nên AI chấm / duyệt đọc mô tả ảnh, không xem ảnh. Mỗi nền tảng tốn thêm
    1 lượt AI duyệt cuối.

## 1.23.2 · 06/11/2026
### Sửa lỗi
- Tạo bài hàng loạt bằng VPSTTT AI không còn dừng giữa chừng vì "đạt hạn mức"
  - AI API của IDE giới hạn chung mỗi người dùng (mặc định 2 lượt chạy cùng lúc, 10 lượt mỗi phút) cho cả viết bài lẫn
    tạo ảnh. Backend lại điều tốc viết bài và tạo ảnh riêng nên cộng lại vượt hạn mức: IDE trả "Đã đạt hạn mức API",
    backend chỉ thử lại một lần sau 2 giây rồi dừng cả lượt (chiến dịch 21 kênh chỉ tạo được 4).
  - Nay viết bài và tạo ảnh dùng chung một bộ điều tốc theo hạn mức của key, chừa 1 lượt mỗi phút cho độ trễ mạng.
  - Gặp giới hạn lượt (429) hoặc AI bận (503) thì chờ 15, 30 rồi 60 giây và thử lại, thay vì một lần sau 2 giây.
  - Bấm **Thử lại** ở chiến dịch lỗi: chỉ các kênh chưa tạo được mới được viết lại.
- Chiến dịch AI lỗi ghi rõ nguyên nhân để dễ xử lý (migration `20261106090000_campaign_automation_error_detail`)
  - Trước đây mọi lỗi đều ghi chung `AI_GENERATION_FAILED`. Nay chiến dịch lưu mã lỗi thật (ví dụ
    `PLATFORM_RATE_LIMITED`), thông điệp, kênh đang viết khi lỗi và nhà cung cấp AI vào cột mới `automationErrorDetail`;
    API trả trường này cùng chiến dịch. Lỗi lạ của máy chủ chỉ ghi tên lỗi, nội dung đầy đủ nằm trong log API kèm mã
    chiến dịch. Log API ghi kênh, mã và thông điệp thay vì chỉ tên lỗi.
- Gợi ý chiến dịch phù hợp với **tất cả** các social đã chọn
  - Mỗi gợi ý phải dùng được cho mọi nền tảng đã chọn cùng lúc (một mô tả bài chung, AI viết lại theo từng nền tảng),
    theo luật chặt nhất trong số đó; không còn gợi ý chỉ hợp một vài nền tảng.
  - Trường `bestFor` (nền tảng hợp nhất) thay bằng `platformFit`: cách dùng gợi ý cho từng nhóm nền tảng đã chọn.

## 1.23.1 · 06/11/2026
### Sửa lỗi
- Xoá được tài khoản có bài treo từ lâu ở "tiện ích không xác nhận được kết quả"
  Khi tiện ích bấm đăng mà không xác nhận được kết quả, bài vẫn được ghi là tiện ích đang giữ để kết quả đến muộn vẫn
  nhận được. Lệnh xoá tài khoản coi các bài này là đang đăng mãi mãi, nên báo "Đang có bài chờ đăng hoặc đang đăng"
  dù bài đã treo cả ngày. Nay chỉ bài tiện ích nhận trong 10 phút gần nhất (thời hạn tiện ích giữ một bài) mới chặn
  xoá. Bài trên trang social không bị đụng tới; lịch sử bài của tài khoản bị xoá cùng tài khoản như trước.

## 1.23.0 · 06/11/2026
### Tính năng
- Gợi ý chiến dịch và mô tả bài đăng bằng AI (`POST /api/v1/ai/campaign-suggestions`, quyền ADMIN / EDITOR)
  - Gửi các nền tảng đã chọn, hướng muốn nhắm (tuỳ chọn) và nhà cung cấp AI; nhận 4 gợi ý, mỗi gợi ý gồm tên chiến
    dịch, mô tả bài đăng (dùng thẳng làm brief cho AI viết), dạng bài, lý do hiệu quả và các nền tảng hợp nhất.
  - AI dựa vào hồ sơ thương hiệu (chưa có thì dựa vào mô tả các chiến dịch trước), luật viết của từng nền tảng đã chọn
    (diễn đàn: chia sẻ kiến thức / câu hỏi, không quảng cáo; mạng xã hội ngắn: một ý, mở bài mạnh; giới hạn ký tự), và
    kết quả 12 chiến dịch gần nhất: điểm AI trung bình, số bài đã đăng, điểm theo từng nền tảng. Gợi ý không lặp chủ đề
    cũ, nghiêng về kiểu bài điểm cao, nhắc thương hiệu tối đa một lần và không bịa giá, ưu đãi, số liệu.
  - Một lượt gọi AI, không lưu gì.

## 1.22.0 · 06/11/2026
### Tính năng
- Xoá nhiều tài khoản social một lượt
  Lệnh mới `POST /platform-accounts/bulk-delete` (chỉ quản trị) xoá các tài khoản đã chọn, tối đa 200 tài khoản mỗi lần,
  để dọn tài khoản bị trùng hoặc không dùng nữa. Mỗi tài khoản bị xoá cùng thông tin đăng nhập, phiên Chrome / 2FA, lịch
  sử kiểm tra đăng nhập và lịch sử đăng (bài đã lên mạng xã hội vẫn giữ nguyên). Tài khoản đang có bài chờ đăng, đang
  đăng hoặc đang được tiện ích Chrome đăng sẽ được giữ lại và trả về kèm lý do, để không xoá mất bài đang chạy.

## 1.21.0 · 06/11/2026
### Tính năng
- Danh sách tài khoản trả số bài đã đăng của từng tài khoản
  `GET /platform-accounts` có thêm `publishedCount` cho mỗi tài khoản: số bài đã đăng bằng tài khoản đó mà vẫn còn trên
  nền tảng (bài đã xoá hoặc không rõ trạng thái không tính). Giao diện hiện số này ở góc phải mỗi thẻ khi chọn tài khoản
  để đăng hàng loạt, giúp chia bài cho các kênh còn ít bài.

## 1.20.0 · 05/11/2026
### Tính năng
- Thêm luồng đăng bài bằng tiện ích Chrome cho 4 kênh trước đây "chưa có luồng" (tiện ích 1.15.0)
  - **Linux Foundation Forum**: kiểu diễn đàn mới **Vanilla** (dùng được cho diễn đàn Vanilla khác). Mặc định đăng vào
    chuyên mục System Management (`/post/discussion/system-management`), đổi bằng URL `/post/discussion/<mã>`. Nội dung
    Markdown; chờ nút Post Discussion hết khoá khi diễn đàn tự lưu nháp; không bấm Save Draft hay Preview; nhận ra bài
    đang chờ duyệt.
  - **Ubiquiti Community**: đăng một Post ở `community.ui.com/questions/create`, tự chọn chủ đề (ô Chuyên mục của tài
    khoản, mặc định General), nội dung có định dạng, bấm Publish và xác nhận trang câu hỏi mới.
  - **Blogger**: trên blog chính của tài khoản Google (`/blog/posts/_`, hoặc `/blog/posts/<blogId>`): bấm Bài đăng
    mới, điền tiêu đề và nội dung có định dạng vào trình soạn (khung iframe), bấm Đăng rồi Xác nhận, lấy link bài trên
    `<blog>.blogspot.com` từ danh sách bài. Backend nhận link blogspot cho riêng luồng này.
  - **Hugging Face Posts** (bài ngắn tối đa 1.999 ký tự, không phải Blog Article cần PRO): hỏi Hugging Face
    (`/api/posts/can-post`) tài khoản có được đăng không; chưa được thì báo lý do và không điền. AI viết bài ngắn
    cho người làm ML thay cho mô tả model.
  - Vẫn không có luồng: Dailymotion (chỉ nhận video), Redis Community Forum (đã đóng), Warrior Forum (điều khoản cấm
    tự động).
  - Sau khi cập nhật backend cần chạy `scripts/sync-extension-flows.cjs --apply` và `scripts/sync-ai-prompts.cjs
    --apply`, nạp lại tiện ích 1.15.0, rồi bấm Test ở các tài khoản này để tự kết nối.

## 1.19.0 · 05/11/2026
### Tính năng
- Tự đăng bài lên Discuss Disqus và MeWe bằng tiện ích Chrome (tiện ích 1.14.0)
  - **Discuss Disqus**: tiện ích chọn chuyên mục (mặc định Community Growth, đổi được ở ô Chuyên mục của tài khoản),
    điền tiêu đề kèm tiền tố chuyên mục như form của Disqus, topic từ tag cố định rồi tag AI của bài (tối đa 5), nội
    dung chữ thuần, rồi bấm Create Discussion một lần và xác nhận trang discussion mới. Tài khoản chưa xác minh email,
    chuyên mục sai hoặc form có bản nháp khác thì dừng trước khi điền.
  - AI viết cho Disqus dạng chia sẻ kinh nghiệm hoặc câu hỏi về phát triển cộng đồng website, hợp kênh Discuss Disqus
    (Disqus đã đóng các Channel khác), nhắc thương hiệu tối đa một lần.
  - **MeWe**: tiện ích mở ô "How is your day going?" trên /myworld, điền bài, gắn ảnh nếu có (ảnh WebP được đổi sang
    PNG vì MeWe coi WebP là tài liệu), chờ tải ảnh xong rồi bấm Post. Bài mới được nhận ra bằng mã bài trên đầu feed và
    ghi link mewe.com/post/show/…; bài cũ trùng nội dung không bị nhận nhầm. Bản nháp khác trong hộp không bị ghi đè.
  - Hai kênh không còn báo "Chưa đăng tự động được". Tài khoản đã đăng nhập tự kết nối khi bấm Test (trang đăng mặc
    định của luồng). Sau khi cập nhật backend cần chạy `scripts/sync-extension-flows.cjs --apply` và
    `scripts/sync-ai-prompts.cjs --apply`, rồi nạp lại tiện ích 1.14.0.

## 1.18.3 · 05/11/2026
### Sửa lỗi
- Kiểm tra đăng nhập Discuit, Blogger, Warrior Forum không còn báo sai (tiện ích 1.13.2)
  - **Discuit**: đã đăng nhập mà vẫn báo "Thông tin đăng nhập bị từ chối". Cửa sổ Chrome hẹp làm ẩn tên tài khoản trên
    thanh menu nên tiện ích không nhận ra phiên, rồi đọc thấy chữ "wrong password" trong một bài trên feed. Nay tiện ích
    hỏi tài khoản đang đăng nhập qua `/api/_initial` của Discuit. Câu "mật khẩu sai / từ chối" chỉ còn được đọc khi trang
    đang hiện form đăng nhập hoặc thông báo lỗi, không đọc từ nội dung bài viết. Áp dụng cho mọi nền tảng.
  - **Blogger** (đăng nhập bằng Google): tiện ích bấm đúng link "Đăng nhập" (`/go/signin`) ở góc phải trang
    blogger.com/about. Sau khi vào trang quản trị, tiện ích xác nhận đúng tài khoản qua email trên nút tài khoản Google;
    email khác thì báo "tài khoản khác".
  - **Warrior Forum**: điều khoản cấm bot và script, nên tiện ích không bấm form đăng nhập hay nút Continue with Google.
    Thông báo cũ "không có nút đăng nhập bằng Google" là sai. Nay tiện ích nói rõ cần đăng nhập tay một lần rồi bấm
    "Tôi đã đăng nhập · Kiểm tra"; khi đã đăng nhập thì tiện ích đi tiếp bước xác nhận bằng trang hồ sơ.

## 1.18.2 · 05/11/2026
### Sửa lỗi
- Quora tự đăng nhập được bằng email và mật khẩu (tiện ích 1.13.1)
  Trang đăng nhập Quora giữ nút **Login** ở trạng thái khoá tới khi điền đủ email và mật khẩu, và không nằm trong
  `<form>`. Tiện ích chỉ tìm nút đang bật nên báo "Không nhận diện được nút xác nhận đăng nhập duy nhất" và dừng. Nay
  tiện ích nhận nút Login của Quora, và với các trang tương tự thì lấy nút "Login / Đăng nhập…" gần ô vừa điền nhất kể
  cả khi nút đang khoá; điền xong chờ nút bật rồi mới bấm, nút không bật thì báo rõ, không bấm.

## 1.18.1 · 05/11/2026
### Sửa lỗi
- Sửa theo khuyến nghị thì điểm AI chấm tăng, không ra một danh sách góp ý mới trái với lần trước
  - Lần chấm bài viết lại biết điểm cũ ("AI chấm X/10") và các mục người duyệt đã chọn sửa. AI chấm kiểm các mục đó
    trước; sửa xong mà không hỏng chỗ khác thì điểm phải cao hơn điểm cũ. Không còn đòi làm ngược lại mục vừa sửa (ví dụ
    vừa bảo bớt quảng cáo, lần sau lại chê câu về thương hiệu "hơi cụt").
  - "Thông tin chưa có căn cứ" chỉ còn là thông tin về thương hiệu mà mô tả và hồ sơ thương hiệu không có. Trước đây AI
    chấm liệt kê cả điều mô tả đã nêu (như "vpsttt có cả VPS và proxy"), làm bài 7/10 vẫn bị giữ lại không duyệt tự động.
  - Thang điểm có mốc rõ (8: đăng được, chỉ còn trau chuốt tuỳ ý; 7: còn một điểm yếu rõ). Chỗ trau chuốt tuỳ ý không trừ
    điểm, bài 9–10 không kèm góp ý, các góp ý không được mâu thuẫn nhau.
  - Nền tảng giới hạn ký tự (Pixelfed, Bluesky, X…): AI chấm được báo còn trống bao nhiêu ký tự, nên không đòi thêm chi
    tiết không vừa; góp ý thêm chữ phải nói bớt chỗ nào.


## 1.18.0 · 05/11/2026
### Tính năng
- Đăng thread lên forum Product Hunt bằng tiện ích Chrome, tự chọn forum / product
  Cần nạp lại tiện ích 1.13.0. Đây là luồng **Start new thread** (`https://www.producthunt.com/p/new`), không phải Launch
  sản phẩm.
  - **Chọn forum trước khi điền bài:**
    - Tiện ích chọn trong ô "Search for a product" đúng tên ghi ở ô **Chuyên mục** của tài khoản: General, Vibecoding,
      Introduce yourself, Self-Promotion, hoặc tên một product (tiện ích gõ để tìm).
    - Để trống thì đăng vào **Self-Promotion**.
    - Không thấy tên đó thì dừng, chưa điền gì.
  - **Điền bài:** tiêu đề, nội dung dán dạng định dạng (Markdown → HTML), rồi bấm **Submit của form**. Nút "Submit" trên
    thanh đầu trang (đăng sản phẩm) không bao giờ được bấm.
  - **Ghi nhận bài:** thread mới ở `/p/<forum>/<slug>`.
  - **AI viết theo kiểu thread forum:** tiêu đề cụ thể, nội dung trò chuyện, nhắc sản phẩm một lần kèm công khai, câu hỏi
    mời trả lời; không tagline kiểu Launch.
  - Product Hunt không còn bị liệt kê "chưa có luồng".
  - **Sau khi triển khai:** bấm **Test** ở tài khoản Product Hunt để gắn trang đăng mặc định. Muốn cập nhật lời nhắc AI và
    trang mặc định của nền tảng trong database thì chạy seed như trong `DEPLOYMENT.md`.

## 1.17.2 · 05/11/2026
### Sửa lỗi
- Sửa được Phiên Chrome / 2FA của tài khoản đang dùng chung hồ sơ Chrome với tài khoản khác cùng nền tảng
  - **Lỗi cũ:** lần nhập file 03/11 đặt hai tài khoản MeWe (và hai tài khoản Differ), với hai tài khoản Google khác nhau,
    vào cùng hồ sơ "Chrome VPS". Từ đó lưu bất kỳ thay đổi nào ở form **Phiên Chrome / 2FA** của chúng đều báo lỗi tiếng Anh
    "This Chrome profile already belongs to another account on this platform".
  - **Nay:**
    - Tài khoản vốn đã ở hồ sơ đó sửa và lưu được. `PUT /extension/accounts/:id/session` trả thêm `sharedWith` (tên tài
      khoản cùng nền tảng trên hồ sơ đó) để giao diện cảnh báo.
    - Chỉ còn chặn việc **chuyển** một tài khoản sang hồ sơ đang giữ tài khoản khác của cùng nền tảng, vì cookie chỉ giữ
      một lần đăng nhập mỗi website. Câu báo bằng tiếng Việt nêu tên tài khoản đó và cách xử lý.

## 1.17.1 · 05/11/2026
### Sửa lỗi
- Differ đăng được: chọn Keyword (topic), gắn ảnh bìa nếu có, rồi bấm Publish trong hộp xuất bản
  Cần nạp lại tiện ích 1.12.1.
  - **Lỗi cũ:** nút Publish trên thanh trên cùng của Differ (`#post-submit-button`) chỉ mở hộp xuất bản. Tiện ích bấm nút
    đó rồi chờ bài xuất hiện, nên bài không bao giờ được đăng. Hộp còn để trống Keyword.
  - **Bây giờ tiện ích:**
    1. Mở hộp xuất bản.
    2. Gắn ảnh bìa nếu bài có ảnh. Differ chỉ nhận JPG/PNG/GIF tối đa 5 MB; ảnh không hợp thì bỏ qua, bài vẫn đăng và có
       ghi chú.
    3. Chọn **một** Keyword trong danh sách topic của Differ, theo thứ tự:
       - tag cấu hình của tài khoản;
       - tag AI viết cho bài (Differ nay nhận tối đa 3 tag gợi ý, AI được dặn viết topic rộng như "programming",
         "devops", "linux");
       - topic chung ("technology", "programming"…).
       Không topic nào hợp thì nhờ AI điền form chọn trong danh sách. AI không chắc thì để hộp mở chờ bạn chọn.
    4. Bấm Publish trong hộp.
  - Bài Differ nay được AI tạo ảnh bìa như các kênh nhận được ảnh.

## 1.17.0 · 04/11/2026
### Tính năng
- Tiện ích Chrome 1.12.0: hàng đợi không kẹt, AI điền mục còn thiếu rồi tự Đăng, bài không vượt giới hạn ký tự
  Cần nạp lại tiện ích 1.12.0. Hướng dẫn đầy đủ ở đầu `BROWSER_EXTENSION_CHROME.md`.
  - **Một bài lỗi không chặn bài khác.**
    - Trước đây tiện ích giữ mãi các tab lỗi / chờ và ngừng nhận việc khi đủ 3 tab, nên mọi bài đứng "Chờ tiện ích".
    - Nay tiện ích đăng 2 bài cùng lúc ở 2 trang khác nhau. Tab chờ không chiếm chỗ và tự đóng sau 10 phút.
    - Máy chủ cho việc treo hết hạn theo lịch mỗi phút. Bài đã được nhận mà im lặng quá 10 phút thì giao lại được.
  - **Báo đăng nhập thất bại không còn bị trả 400.** Kết quả có `detectedUsername` / `googleBlocked` được nhận, nên job
    không đứng mãi. Trang đăng ký (`/signup`, `/register`…) không bao giờ nhận mật khẩu và không bị điền.
  - **AI điền mục còn thiếu** (`EXTENSION_AI_FORM_FILL_ENABLED`, mặc định bật).
    - Nút Đăng còn tắt hoặc form báo thiếu mục thì tiện ích gửi cấu trúc form (không mật khẩu, không chữ đang nhập).
    - AI chọn ngôn ngữ, community, chuyên mục, tag… trong danh sách lựa chọn. Máy chủ kiểm từng thao tác.
    - Tiện ích điền, kiểm lại rồi tự bấm Đăng; AI không chắc thì dừng chờ bạn.
    - Lệnh mới `POST /extension/agent/tasks/:id/form-fill`.
    - Lemmy chọn ngôn ngữ theo bài. Chưa cấu hình community thì AI chọn community trong danh sách trang đưa ra.
  - **Bài không vượt giới hạn ký tự.**
    - Một hàm đếm chung dùng cho mọi bước: AI viết, duyệt, sửa, giao cho tiện ích, connector API. Mastodon tính link
      23 ký tự; X tính cả tên miền trần.
    - AI được báo đúng ngân sách đã trừ dòng "Nguồn". Viết lại 2 lần vẫn dài thì AI rút gọn thêm 1 lần, cuối cùng máy cắt
      ở cuối câu; bài bị máy cắt luôn chờ duyệt.
    - Bản quá dài luôn xếp dưới bản vừa.
    - Duyệt, sửa hay tạo tay bài quá dài thì trả 400. "Duyệt tất cả" giữ bài quá dài ở chờ duyệt (`overLimitVariants`),
      các bài khác vẫn đăng.
    - Tiện ích không bao giờ nhận bài quá dài (`EXTENSION_CONTENT_TOO_LONG`) và kiểm trước khi gõ. Tiêu đề Lemmy tối đa 200.
  - **Trình soạn thảo có định dạng giữ đúng bài.**
    - Differ, Medium, Substack, daily.dev, Quora, Tumblr, DZone, AWS Builder nhận bài đã định dạng: Markdown chuyển sang
      HTML an toàn, tự viết, không thêm thư viện.
    - Các trang khác giữ xuống dòng.
    - Kiểm chữ so dãy từ thay vì đòi giống hệt. Lệch thì báo `CONTENT_MISMATCH`, không còn gọi nhầm là
      `EDITOR_NOT_FOUND`.
  - **Bản xem trước khớp bài thật.** `POST /content-variants/:id/preview` trả thêm:
    - `appearance` (`markdown` | `plain` | `rich`);
    - tag thật sự gửi;
    - `destination` (community / chuyên mục / ngôn ngữ);
    - độ dài theo cách đếm mới.
    Quora không còn lặp dòng đầu; dòng "Nguồn" không lặp khi bài đã có link đó.

## 1.16.0 · 04/11/2026
### Tính năng
- Sửa bài theo khuyến nghị của AI, chọn được từng mục
  `POST /content-variants/{id}/rewrite` nhận thêm `notes`: danh sách khuyến nghị người duyệt đã chọn từ ghi chú chấm
  điểm. Khi có `notes`, AI chỉ sửa theo đúng các mục đó, thay cho toàn bộ ghi chú lần chấm trước. Ví dụ bỏ chọn mục
  "Thông tin chưa có căn cứ" thì AI không bị yêu cầu xoá câu giới thiệu thương hiệu. Các mục đã chọn vẫn được nhắc lại
  ở những lượt AI tự viết lại khi bài chưa đạt. Tối đa 20 mục, mỗi mục tối đa 1.000 ký tự; không chọn mục nào và không
  có hướng dẫn thì báo lỗi. `aiRevision.notes` lưu các mục đã chọn để giao diện hiện "theo N khuyến nghị đã chọn".

## 1.15.0 · 04/11/2026
### Tính năng
- Thêm social vào luồng đăng bằng tiện ích mà không đăng nhập lại cả loạt
  - Nhập lại file: tài khoản đã có mà không đổi gì được bỏ qua (`skipped`). Trước đây mọi dòng đều bị tắt và đăng nhập
    lại.
  - Đổi mật khẩu, 2FA hay trang đăng thì cập nhật mà giữ trạng thái bật. Chỉ social mới, hoặc đổi tài khoản đăng nhập /
    Chrome, mới được đăng nhập thử.
  - API mới `POST /extension/accounts/import/one` thêm từng social, cùng quy tắc với một dòng file.
- Tự kết nối social đã đăng nhập nhưng chưa từng bật đăng
  - Lần kiểm tra đăng nhập thành công của tài khoản nhập từ file tự gắn trang đăng mặc định của luồng và bật Đã kết nối,
    ví dụ daily.dev. Kênh chưa có luồng thì lưu đúng lý do.
  - Trang đăng mặc định theo lựa chọn của bạn: DirectAdmin (General Technical Discussion & Troubleshooting), CloudPanel
    (Install & Config), Tinhte (AI, App, Dịch vụ).
- Thêm tài khoản cho nền tảng đang tắt (nhập file, nhập file API, tạo tài khoản) thì nền tảng được bật, thay cho trang
  Nền tảng sẽ bỏ ở giao diện 1.16.0.

## 1.14.0 · 04/11/2026
### Tính năng
- Proxy cho Chrome trong tiện ích (tiện ích 1.11.0)
  - Trang Cài đặt có mục bật proxy HTTP (dán `host:port:user:mật khẩu`). Mọi trang đi qua proxy, trừ API của hệ thống.
  - Tiện ích tự trả lời hộp đăng nhập của đúng proxy đó, kể cả sau khi Chrome khởi động lại. Dùng proxy dân cư để các
    nền tảng bớt hiện CAPTCHA với IP máy chủ.
  - Thông tin proxy chỉ lưu trong Chrome đó, không gửi về hệ thống.

## 1.13.0 · 04/11/2026
### Tính năng
- Viết lại từng bài bằng AI theo hướng dẫn của bạn
  - API mới `POST /content-variants/{id}/rewrite`, nhận `instruction` và `aiProvider` (tuỳ chọn).
  - AI viết lại bài từ bản cũ, theo hướng dẫn và ghi chú lần chấm trước, rồi chấm lại. Chưa đạt thì AI tự viết lại thêm.
  - Bài mới thay bài cũ tại chỗ nên vẫn nằm trong lượt duyệt. Bài đã duyệt nhưng chưa vào chiến dịch thì quay về chờ
    duyệt.
  - Việc chạy nền 1–3 phút, trạng thái ở trường mới `aiRevision` (migration
    `20261104160000_content_variant_ai_revision`, chỉ thêm cột).
  - Bạn sửa tay trong lúc AI đang viết thì giữ bản bạn sửa. Bài đã vào chiến dịch hoặc bị từ chối thì không viết lại.
  - Bài đang được AI viết lại không duyệt được, kể cả bằng nút duyệt chung (bỏ qua bài đó), để không đăng nhầm bản cũ.
- Tạo ảnh AI cho bài chưa có ảnh
  Lệnh tạo lại ảnh (`POST /content-variants/{id}/image`) không còn đòi mô tả. Bài chưa có mô tả ảnh thì AI tự thiết kế
  mô tả từ nội dung bài, giống bài mới tạo, rồi tạo ảnh. Không phải tải ảnh từ máy lên.
- Bài AI tạo hàng loạt nhắm điểm cao hơn
  - Người viết được dặn đúng thang chấm của biên tập: mở bài, chi tiết cụ thể, hợp nơi đăng, tự nhiên. Kèm danh sách câu
    sáo cần tránh, và quy tắc câu hỏi thật cho Stack Exchange.
  - Bài chưa đạt được viết lại tối đa 2 lần (trước là 1) và **giữ bản có điểm cao nhất**.
  - Phản hồi gửi người viết có điểm từng tiêu chí để sửa đúng chỗ yếu.
  - Mỗi bài cần 2–6 lượt gọi AI thay vì 2–4.

## 1.12.3 · 04/11/2026
### Sửa lỗi
- Sửa được phiên Google trên hồ sơ Chrome đang có nhiều email Google; kiểm tra đăng nhập nhận đúng Tumblr, Voz (tiện ích 1.10.2)
  - Sau khi chuyển tài khoản sang Chrome VPS, một hồ sơ Chrome mang nhiều email Google. Quy tắc "một email Google mỗi
    hồ sơ" khi đó chặn mọi lần lưu Phiên Chrome / 2FA bằng Google ("Use the same Google identity…"). Nay chỉ chặn email
    Google mới mà hồ sơ chưa dùng, thông báo tiếng Việt liệt kê các email hồ sơ đang dùng.
  - Tiện ích không còn nhầm ô tìm kiếm của trang đã đăng nhập là ô tên đăng nhập. Tumblr đã đăng nhập vẫn báo "Không
    nhận diện được nút xác nhận đăng nhập duy nhất" là vì lỗi này.
  - Diễn đàn XenForo báo tài khoản bị cấm thì kiểm tra nói rõ tài khoản bị khoá. Tài khoản chờ xác nhận email thì được
    nhắc mở email xác nhận.

## 1.12.2 · 04/11/2026
### Sửa lỗi
- Bài AI mang tag sang các trang có ô tag: không còn lỗi "Câu hỏi cần ít nhất một tag" (tiện ích Chrome 1.10.1)
  Việc giao cho tiện ích trước đây chỉ có tag cấu hình trong tài khoản, bỏ mất tag AI viết kèm bài. Nay máy chủ gửi
  thêm tag AI gợi ý (`suggestedTags`), đã chuẩn hoá theo luật từng trang. Tiện ích dùng tag cố định trước rồi thêm tag
  AI mà trang đã có, không bao giờ tạo tag mới:
  - Stack Overflow, Server Fault, Unix & Linux: tối đa 5 tag;
  - diễn đàn Discourse: chỉ tag chuyên mục cho phép;
  - DEV, SlideShare: khi tài khoản chưa cấu hình tag.
  Tài khoản Stack Exchange không còn bắt buộc cấu hình tag. Kết nối DEV qua API chuẩn hoá tag (chữ thường và số, tối đa
  4), vì DEV từ chối cả bài khi có tag kiểu "self-hosting". AI được dặn viết tag đúng kiểu từng trang (Stack Exchange:
  tag tiếng Anh đã có trên trang). `VERSION` trở lại một dòng.

## 1.12.0 · 04/11/2026
### Tính năng
- Khôi phục nội dung đã từ chối
  Thêm lệnh khôi phục cả lượt AI hoặc từng bài bị từ chối về chờ duyệt, hỗ trợ cả lượt từ chối cũ. Giữ nguyên nội dung, không tạo lại AI hay tạo việc đăng. Chỉ chủ sở hữu có quyền biên tập được khôi phục bài chưa gắn với việc đăng.
## 1.12.1 · 04/11/2026
### Sửa lỗi
- Test đăng nhập hàng loạt bỏ qua tài khoản đã đăng nhập thành công
  "Test đăng nhập hàng loạt" và "Kiểm tra tất cả" chỉ chạy cho tài khoản chưa đăng nhập (cần thao tác, chưa kiểm tra,
  lỗi…), bỏ qua tài khoản mà lần kiểm tra gần nhất đã đăng nhập thành công, nên không đăng nhập lại vô ích và ít gặp
  CAPTCHA, khoá tài khoản. Kết quả cho biết số tài khoản được bỏ qua. Nút "Test" ở một dòng vẫn kiểm lại tài khoản đó.
- Sửa lần gộp làm backend không build được
  Gộp "duyệt từng bài" với "chỉ dùng tài khoản sẵn sàng" để lại mã ghép dở trong phần duyệt bài và tệp VERSION có hai
  số; nay ghép lại đúng ý cả hai và VERSION còn một số.
## 1.12.0 · 04/11/2026
### Tính năng
- Duyệt một lần là bài tự đăng, rút gọn quy trình
  Kênh nào AI viết xong (kèm ảnh, nếu kênh đó có ảnh) là duyệt được ngay, không chờ các kênh còn lại; duyệt xong bài vào
  hàng đợi đăng và tự lên social. "Duyệt tất cả" lúc AI còn viết sẽ duyệt các bài đã sẵn sàng. Bài có ảnh đang tạo chưa
  duyệt được (để không đăng thiếu ảnh). Các bài duyệt giữa chừng được giữ nguyên khi lượt chạy xong hoặc chạy lại sau
  khi máy chủ khởi động lại; lượt tự chuyển "Đã duyệt" khi mọi bài đã được quyết.
- Tuỳ chọn tự đăng bài AI chấm đạt, không cần duyệt
  Khi tạo nội dung gửi `autoPublish: true`: bài AI tự chấm đạt được duyệt và đăng ngay khi viết xong (kèm ảnh); bài
  chưa đạt, hoặc tài khoản bị ngắt kết nối giữa chừng, vẫn chờ bạn duyệt. Mặc định tắt.
- Blogger và dev.to đăng thật bài đã duyệt
  Trước đây chỉ lưu nháp rồi phải vào Publishing bấm "Đã đăng". Migration `20261104090000_publish_blogger_devto_live`
  chuyển các tài khoản đang lưu nháp sang đăng thật; vẫn chọn lưu nháp được ở từng tài khoản.
## 1.11.1 · 04/11/2026
### Sửa lỗi
- Duyệt bài không còn hỏng chỉ vì một tài khoản trong chiến dịch chưa sẵn sàng
  Trước đây chỉ cần một tài khoản bị tắt, "Cần thao tác" (chưa đăng nhập lại), chưa bật "Tự bấm Đăng" hay mất phiên trình
  duyệt là mọi lần duyệt đều báo `Every selected account must belong to you and be enabled, connected, and ready`. Nay
  duyệt một bài chỉ xét tài khoản của đúng nền tảng đó: bài được đăng lên các tài khoản sẵn sàng, các tài khoản còn lại được
  bỏ qua và liệt kê trong kết quả (`skippedAccounts`, có tên và lý do). Nền tảng không còn tài khoản nào sẵn sàng thì báo
  rõ bằng tiếng Việt từng tài khoản và lý do, không tạo việc đăng nào. "Duyệt hết" đăng các nền tảng đã có tài khoản sẵn
  sàng, để các bài còn lại tiếp tục chờ duyệt (`waitingVariantIds`) cho tới khi bạn kết nối lại tài khoản hoặc từ chối
  bài. Tài khoản bị bỏ qua sẽ không tự nhận bài này khi kết nối lại sau.

## 1.11.0 · 04/11/2026
### Tính năng
- Duyệt hoặc từ chối từng bài theo nền tảng
  Lệnh mới `POST /campaigns/{id}/variants/{variantId}/approve` (đăng ngay hoặc `publishMode=SCHEDULED` với giờ hẹn) và
  `.../reject`. Duyệt một bài chỉ tạo việc đăng cho các tài khoản của đúng nền tảng đó; các nền tảng khác vẫn chờ duyệt.
  Bài bị từ chối không bao giờ được đăng. Lượt chuyển "Đã duyệt" khi mọi bài đã được quyết (hoặc "Đã từ chối" nếu từ chối
  hết). Duyệt tất cả và Từ chối của cả lượt nay chỉ áp dụng cho các bài còn chờ. Chiến dịch đã đăng xong các bài trước được
  mở lại để đăng bài vừa duyệt.

## 1.10.0 · 03/11/2026
### Tính năng
- Xem trước bài như khi đăng lên từng mạng xã hội
  Lệnh mới `POST /content-variants/{id}/preview` trả tiêu đề, nội dung, tag và số ký tự đúng như kênh sẽ nhận (bỏ
  Markdown với trình soạn chữ thường, đặt hashtag, cắt tiêu đề theo giới hạn, dòng Nguồn), theo đường đăng của tài khoản
  đã chọn. Nhận cả nội dung đang sửa chưa lưu; chỉ đọc, không đổi gì.
- Ảnh AI đúng sản phẩm và mang phong cách công nghệ
  Lời dặn AI viết mô tả ảnh nay bắt vẽ đúng sản phẩm, dịch vụ và ý kỹ thuật của bài (máy chủ, hạ tầng cloud, proxy, luồng
  mạng…), nhìn kiểu công nghệ hiện đại (nền xanh đậm, ánh sáng xanh / tím, 3D hoặc isometric), mô tả 60–150 từ như brief
  cho designer; không dùng cảnh đời thường (cốc cà phê, cây cảnh) hay phong cảnh. Mọi ảnh, kể cả khi tạo lại với mô tả
  sửa tay, được thêm phần dặn chất lượng (bố cục, ánh sáng, chi tiết, không chữ, không logo).
- Bước "giám đốc mỹ thuật" thiết kế ảnh từ bài đã viết xong
  Với kênh có ảnh, sau khi bài viết xong và được chấm, AI làm thêm một lượt riêng để thiết kế ảnh theo khung chuẩn: chủ
  thể cụ thể của bài, bối cảnh, bố cục hợp khổ ảnh của kênh (chủ thể ở giữa, chừa lề vì feed cắt mép), ánh sáng, bảng màu,
  phong cách (3D cao cấp, isometric 3D hoặc ảnh sản phẩm điện ảnh), không khí, 3–6 chi tiết gắn với nội dung bài và danh
  sách cần tránh (chữ, logo, người thật, hình sáo mòn như hacker trùm đầu, mưa mã nhị phân, tên lửa). Mô tả ảnh lưu lại là
  bản ghép đầy đủ đó (sửa được trước khi Tạo lại ảnh). Lượt thiết kế lỗi thì giữ mô tả do AI viết bài đưa ra, bài không bị
  lỗi theo.
- Tạo ảnh bằng GPT Image của OpenAI (tuỳ chọn)
  `AI_IMAGE_PROVIDER=openai` tạo ảnh thẳng bằng OpenAI với `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL` (mặc định `gpt-image-1`)
  và `OPENAI_IMAGE_QUALITY` (mặc định `high`); tính phí theo tài khoản OpenAI. Mặc định vẫn là VPSTTT AI (Codex).

## 1.9.0 · 03/11/2026
### Tính năng
- Nội dung AI của từng kênh được lưu ngay khi viết xong, để review trong lúc AI viết tiếp
  Lượt tạo nội dung chạy nền (Content đợi duyệt) lưu biến thể của mỗi kênh ngay khi xong và thêm vào danh sách của lượt,
  thay vì chờ đủ mọi kênh. AI vẫn viết tối đa 4 kênh cùng lúc, nhưng kênh nào xong thì kênh kế tiếp bắt đầu luôn. Lượt
  bị gián đoạn hoặc lỗi khi chạy lại chỉ tạo các kênh còn thiếu, giữ các kênh đã xong và chỉnh sửa của bạn (trước đây
  bỏ hết và tạo lại từ đầu). Duyệt đăng vẫn chỉ mở khi đủ mọi kênh. Content Studio giữ cách cũ: chỉ lưu khi mọi kênh đều
  tạo được.

## 1.8.0 · 03/11/2026
### Tính năng
- Tự đăng bài lên daily.dev bằng tiện ích Chrome (tiện ích 1.10.0)
  daily.dev có luồng đăng bài viết: tiện ích mở khung Create post, điền tiêu đề và nội dung đã duyệt, bấm Post một lần
  rồi xác nhận trang bài mới. Bài đăng lên hồ sơ cá nhân; chưa hỗ trợ đăng vào Squad (daily.dev lặng lẽ đổi sang hồ sơ
  khi tài khoản không có quyền đăng vào Squad). Bản nháp khác trong khung soạn không bị ghi đè. Tài khoản daily.dev đã đăng nhập chuyển từ "chưa có luồng
  đăng tự động" sang cần cấu hình nơi đăng; nhập lại file tài khoản để tự cấu hình. Sau khi cập nhật backend cần chạy
  `scripts/sync-extension-flows.cjs --apply` để database có luồng mới. Hugging Face vẫn chưa có luồng vì Blog Article
  chỉ dành cho tài khoản PRO hoặc tổ chức gói Team/Enterprise.

## 1.7.1 · 03/11/2026
### Sửa lỗi
- Kiểm tra đăng nhập trên Chrome mới (VPS) tự bấm được nút Google và chờ Cloudflare (tiện ích 1.9.1)
  Tiện ích đưa tab lên trước khi bấm Đăng nhập bằng Google / Log in, vì nhiều trang không mở đăng nhập Google từ tab
  ẩn và trước đây tab đứng yên rồi báo "Bước đăng nhập chưa được chấp nhận". Trang "Just a moment…" của Cloudflare được
  chờ tự qua tới 20 giây thay vì báo CAPTCHA ngay. Cần frontend 1.6.1 để nút Test / Kiểm tra tất cả cũng tự đăng nhập.
- Lưu "Phiên Chrome / 2FA" không còn làm mất trang đăng nhập phụ của tài khoản
  Trước đây sửa mật khẩu trong form làm mất tên miền đăng nhập phụ đã có từ lúc nhập file, nên kiểm tra đăng nhập
  social.vivaldi.net báo "Trang đăng nhập chuyển sang https://login.vivaldi.net; tên miền này chưa được cấu hình".
  Nay form giữ các tên miền này và cách nhận tài khoản theo email khi tài khoản vẫn ở cùng trang. Mọi tài khoản
  social.vivaldi.net, kể cả tài khoản đã bị mất trước đây, tự nhận login.vivaldi.net, không cần nhập lại. MongoDB
  Community cũng vậy với trang đăng nhập `https://account.mongodb.com` (trước đây báo "tên miền này chưa được cấu
  hình"). Sau khi cập nhật, mở Cài đặt tiện ích và cấp quyền cho hai tên miền này nếu được hỏi.

## 1.7.0 · 03/11/2026
### Tính năng
- AI tạo ảnh riêng cho từng kênh cần ảnh khi tạo nội dung (VPSTTT AI, tiện ích 1.9.0)
  Khi tạo nội dung bằng AI, mỗi kênh mà đường đăng gửi được ảnh có thêm một ảnh do VPSTTT AI tạo (model `vpsttt-image`,
  cùng key, cần quyền "image"). Kênh có ảnh: Pixelfed, Bluesky, Mastodon / Vivaldi, Tumblr, LinkedIn qua tiện ích Chrome;
  X, Discord, dev.to, Threads, Instagram qua API. AI viết bài biết trước kênh nào có ảnh: viết thêm mô tả ảnh theo khổ và
  phong cách của kênh, còn bài cho diễn đàn và kênh chỉ có chữ thì không nhắc tới ảnh. Ảnh lỗi không làm mất bài; riêng
  Pixelfed (bắt buộc ảnh) thì bài chờ duyệt tay. Ảnh bạn tự tải lên được dùng thay ảnh AI.
- Xem, tạo lại, bỏ hoặc thay ảnh của từng kênh khi duyệt
  Lệnh mới `POST /content-variants/{id}/image` (tạo lại ở chế độ nền, có thể sửa mô tả ảnh) và
  `DELETE /content-variants/{id}/image/{mediaId}`; `GET /ai/image-status` cho biết máy chủ đã bật tạo ảnh chưa.
- Tiện ích Chrome gắn ảnh vào khung soạn Bluesky, Mastodon, Tumblr, LinkedIn
  Chỉ bấm Đăng khi khung soạn đã hiện ảnh; không gắn được thì dừng và báo, không đăng thiếu ảnh.
- X đăng kèm ảnh qua API chính thức
  Tải ảnh qua `/2/media/upload` rồi đăng kèm; token X cần scope `media.write`. Ảnh quá 5 MB thì đăng chữ và ghi chú lại.
## 1.6.3 · 03/11/2026
### Sửa lỗi
- Nhập file không còn lấy nhầm tên màn hình của trang làm username
  Ô URL Profile điền link như `voz.vn/register/complete`, `dev.to/onboarding`, `medium.com/get-started/topics`,
  `discord.com/channels/@me` từng bị đọc thành username "register", "onboarding"… nên kiểm tra đăng nhập luôn báo sai
  tài khoản và tài khoản nằm mãi ở "Cần thao tác". Nay các link đó không được dùng: lần kiểm tra đầu nhận tài khoản đang
  đăng nhập trong Chrome và lưu lại. Đọc đúng thêm link Tumblr `/blog/ten` và `/author/ten`. Nhập lại file để sửa các
  tài khoản đã nhập trước đây.
- Warrior Forum báo rõ là chỉ đăng thủ công
  Điều khoản Warrior Forum cấm bot, script hay hệ thống tự động truy cập trang, nên luồng đăng ghi "Chỉ đăng thủ công"
  kèm link điều khoản thay vì "chưa có luồng đăng" như đang chờ làm thêm.
## 1.6.2 · 03/11/2026
### Sửa lỗi
- Nhập file tài khoản từ giao diện web cũ báo lỗi dễ hiểu thay vì "Too many fields"
  Khi backend đã lên 1.6.1 mà giao diện web chưa cập nhật, hộp Nhập file còn ô "Google dùng chung" và lần nhập bị từ chối
  với chữ "Too many fields". Nay nếu các ô đó còn điền, hệ thống báo rõ ô Google dùng chung đã bỏ, cần xoá trống ba ô
  hoặc tải lại trang sau khi cập nhật giao diện 1.4.1; để trống thì nhập bình thường bằng tài khoản của từng dòng.
- Kiểm tra đăng nhập nhận ra tài khoản đã đăng nhập trên daily.dev, Tumblr, Hugging Face (tiện ích 1.8.2)
  daily.dev đã chuyển từ app.daily.dev sang daily.dev nên trước đây bị báo "tên miền chưa được cấu hình"; nay tài khoản
  đã nhập tự dùng tên miền mới, không cần nhập lại. Với trang chưa có cách nhận diện riêng, tiện ích nhận tài khoản khi
  thấy link tới đúng URL hồ sơ đã khai trong thanh điều hướng, hoặc tự mở URL hồ sơ đó một lần và thấy nút chỉ chủ tài
  khoản mới có (Edit profile, Modifier l'apparence…). Hugging Face đọc tên tài khoản đang đăng nhập từ chính trang.
  Bluesky đọc handle và email của phiên đang đăng nhập: email trùng email đăng nhập đã khai thì nhận đúng tài khoản và
  tự cập nhật handle mới. Khi Chrome đăng nhập tài khoản khác, lời báo ghi rõ @handle đang đăng nhập và @handle đã cấu
  hình để sửa đúng chỗ.
## 1.6.1 · 03/11/2026
### Sửa lỗi
- Kiểm tra đăng nhập hàng loạt đóng tab, nhận đúng tài khoản và không đứng im (tiện ích 1.8.1)
  Kiểm tra xong (thành công hay cần thao tác) là đóng tab và popup Google. Tài khoản đã đăng nhập không còn bị báo "Cần
  thao tác" chỉ vì tên hiển thị khác chữ hoa, dấu hay ký tự so với handle trong URL hồ sơ. Trang chỉ hỏi email như
  Substack: tài khoản mật khẩu được tự bấm "Sign in with password"; tài khoản Google mà trang không có nút Google được
  báo rõ ngay thay vì để trống tới hết giờ.
- Bỏ "Google dùng chung" khi nhập file tài khoản
  Mỗi dòng giờ đăng nhập bằng đúng email, mật khẩu và mã 2FA của chính dòng đó, vì các social trong một file thường dùng
  nhiều tài khoản Google khác nhau. API nhập file chỉ còn nhận file và Chrome đã chọn.
## 1.6.0 · 03/11/2026
### Tính năng
- Tiện ích Chrome nhờ AI tìm ô / nút khi giao diện mạng xã hội đổi (bản 1.8.0)
  Khi không thấy ô tiêu đề, ô nội dung, nút mở khung soạn hoặc nút Đăng, tiện ích gửi danh sách phần tử đang hiện (đã che
  dữ liệu, không có nội dung đã nhập hay mật khẩu) để AI chọn, rồi điền lại đúng một lần. Gợi ý chưa duyệt chỉ điền sẵn để
  bạn kiểm tra và bấm Đăng; gợi ý đã được ADMIN duyệt thì tự đăng và được dùng cho các lần sau. Chỉ thiếu nút Đăng thì
  chỉ ghi gợi ý. Cần backend bật EXTENSION_UI_RECOVERY_ENABLED; nạp lại extension để dùng bản mới.
## 1.5.0 · 03/11/2026
### Tính năng
- AI gợi ý ô và nút khi giao diện mạng xã hội thay đổi (phía máy chủ)
  Khi tiện ích Chrome không tìm thấy ô tiêu đề, ô nội dung, nút mở khung soạn hoặc nút Đăng, nó có thể gửi danh sách
  phần tử đang hiện (đã che email, số, chuỗi dài; không có giá trị ô nhập hay mật khẩu) để AI chọn đúng phần tử. Máy
  chủ kiểm lại từng lựa chọn (đúng loại ô, nút Đăng không phải nút Huỷ / Xoá / Nháp, đủ độ tin cậy) và lưu thành gợi ý
  chờ duyệt. Gợi ý chưa duyệt chỉ được dùng để điền sẵn, bạn tự bấm Đăng; ADMIN duyệt trên API hoặc qua Codex (MCP) thì
  lần sau tiện ích tự đăng bằng selector đó. Tắt sẵn (EXTENSION_UI_RECOVERY_ENABLED); cần chạy migration mới. Phần tiện
  ích dùng tính năng này ra ở bản tiện ích tiếp theo.
## 1.4.0 · 03/11/2026
### Tính năng
- Codex xem và điều phối hệ thống qua MCP
  Backend có cổng MCP tại /mcp để Codex (hoặc agent khác) làm việc bằng chat: xem tài khoản, tiện ích Chrome đã ghép
  nối, kết quả kiểm tra đăng nhập, việc đăng bài và chiến dịch; xếp kiểm tra đăng nhập, chạy lại việc lỗi, giao lại
  việc cho tiện ích, và nhờ AI viết bản nháp chiến dịch (dừng ở chờ duyệt). Cổng tắt sẵn (MCP_ENABLED); token tạo bằng
  lệnh pnpm mcp:token, chỉ lưu mã băm, có thể chỉ cho xem, đặt hạn và thu hồi. Quyền giống web của chủ token, không trả
  mật khẩu hay cookie, mọi lệnh ghi được ghi nhật ký. Duyệt và đăng thật qua Codex chỉ có khi bật MCP_ALLOW_PUBLISH.
  Cần chạy migration mới (mcp_tokens).
## 1.3.0 · 03/11/2026
### Tính năng
- Viết bài bằng AI API của IDE công ty (VPSTTT AI)
  Thêm nhà cung cấp AI thứ tư "VPSTTT AI" dùng mục AI API của IDE (tài khoản Claude/Codex công ty cấp), không cần mua
  key OpenAI hay Gemini. Đặt AI_DEFAULT_PROVIDER=vpsttt cùng VPSTTT_AI_BASE_URL (https) và VPSTTT_AI_API_KEY; Studio và
  Tạo tự động chọn được VPSTTT AI cho từng lần. Backend chỉ gửi đúng các tham số API này nhận, giữ mỗi lượt dưới 100.000
  ký tự, giới hạn số lượt cùng lúc và số lượt mỗi phút theo hạn mức của key, và báo rõ khi key sai hoặc IP chưa được
  cho phép. Gemini, OpenAI, DeepSeek giữ nguyên để dùng song song hoặc dự phòng.
## 1.2.1 · 03/11/2026
### Cải tiến
- Tiện ích Chrome nhận bài kế tiếp ngay sau bài trước (bản 1.7.6)
  Đăng xong một bài, hoặc bài chuyển sang chờ bạn xử lý (bản nháp chờ bấm Đăng, CAPTCHA, đăng nhập), tiện ích hỏi bài
  tiếp theo sau khoảng 1 giây thay vì chờ chu kỳ 30 giây, nên hàng đợi nhiều bài chạy nhanh hơn. Vẫn chỉ một lượt đăng
  tại một thời điểm, tối đa ba tab; tiện ích đang tạm dừng thì không nhận bài. Tệp VERSION được sửa lại còn đúng một
  dòng. Nạp lại extension trong chrome://extensions để dùng bản mới.
## 1.2.0 · 02/11/2026
### Tính năng
- Mật khẩu và khoá TOTP Google dùng chung khi nhập file tài khoản
  Hộp "Nhập file tài khoản" có thêm hai ô Mật khẩu Google và Khoá TOTP Google cạnh email Google dùng chung. Nhập một
  lần, hệ thống lưu mã hoá và áp cho mọi dòng đăng nhập bằng Google đó, nên tiện ích tự đăng nhập Google và tự điền mã
  2 bước khi phiên hết hạn. Khoá TOTP là khoá thiết lập hoặc chuỗi otpauth:// (xuất được từ extension Authenticator),
  không phải mã 6 số; khoá sai bị báo ngay trước khi nhập.
## 1.2.0 · 31/10/2026
### Tính năng
- Nhập file cấu hình API, hệ thống tự kết nối
  ADMIN tải lên một file Excel/CSV, mỗi dòng một tài khoản dev.to, Mastodon, Bluesky, Discord, Discourse hoặc
  WordPress kèm khoá. Hệ thống tạo hoặc cập nhật tài khoản, lưu khoá đã mã hoá, tự kiểm tra kết nối và báo kết quả
  từng dòng (đã kết nối, khoá sai, thiếu cột, trùng dòng…). Nhập lại cùng file chỉ cập nhật, không tạo trùng. Tài
  khoản đang đăng qua tiện ích Chrome cùng username được gắn khoá và chuyển sang đăng bằng API khi kiểm tra đạt.
  Instagram, Threads, Blogger, LinkedIn, Tumblr vẫn cần bấm Kết nối một lần; file báo rõ các dòng này.
## 1.1.2 · 02/11/2026
### Sửa lỗi
- Một nền tảng lỗi không còn làm kẹt cả hàng đợi đăng bài
  Trước đây khi 5 tab chờ bạn xử lý (Tinhte, DZone, Quora…) thì tiện ích ngừng nhận bài mới tới 30 phút, các social
  phía sau nằm chờ mãi. Nay tab chờ cũ nhất được nhả ra để bài mới chạy tiếp; bài đó vẫn ở Cần thao tác trên web.
- Bài đã đăng mà bị báo "không thấy bài mới" giảm hẳn
  Tiện ích chờ xác nhận tới 3 phút, kiểm mỗi 5 giây, nhận bài bị rút gọn trên feed, link theo tiêu đề và tự xem trang
  cá nhân của tài khoản (nếu đã khai URL hồ sơ) trước khi nhờ bạn kiểm tra. Không bao giờ bấm Đăng lại.
- Thông báo "Đang tạo bài viết đợi xíu nhé" của Tinhte (và các thông báo đang xử lý khác) không còn bị coi là lỗi.
- Minds đăng được từ khung soạn mới trên newsfeed; Stack Overflow / Server Fault nhận đúng tag đã chọn.
- Tài khoản bị nền tảng đình chỉ (vd. Discuit "is suspended") được báo đúng lý do thay vì như sai mật khẩu.
- Bài AI bị lỗi hiện nguyên chuỗi "\n" (ví dụ trên diễn đàn TrueNAS) được sửa thành xuống dòng thật, cả với bài đã tạo.
### Vận hành
- Cần nạp lại tiện ích Chrome bản 1.7.4.
## 1.2.0 · 31/10/2026
### Tính năng
- Bài AI viết hay hơn, đúng ngôn ngữ và đúng quy cách từng nơi đăng
  AI biết bài sẽ đăng ở đâu nên viết đúng ngôn ngữ người đọc: diễn đàn quốc tế dùng tiếng Anh, Tinhte và Voz dùng
  tiếng Việt. Bài cũng đúng giới hạn ký tự (Bluesky 300, Threads 500, X…) và đúng định dạng của nơi đăng. Prompt mới
  (phiên bản 3) yêu cầu câu mở đầu gây chú ý, chi tiết cụ thể và giọng người thật trong cộng đồng; với diễn đàn thì
  chia sẻ giá trị trước, nhắc thương hiệu nhẹ và có câu tự giới thiệu. Tên chiến dịch không còn bị dùng làm tiêu đề bài.
- Hồ sơ thương hiệu cho AI
  ADMIN lưu một lần ở cài đặt `ai.brand-profile`: sản phẩm, số liệu thật, link, giọng văn, câu tự giới thiệu, điều
  cấm nói. AI chỉ được nói về thương hiệu bằng các thông tin này hoặc thông tin trong mô tả bài.
- AI tự chấm bài trước khi đăng
  Mỗi bài được máy kiểm tra (độ dài, ngôn ngữ, tiêu đề, câu sáo) và AI chấm điểm từ 1 đến 10. Bài dưới 7 điểm được
  viết lại một lần. Vẫn chưa đạt thì bài không tự đăng mà nằm ở "Cần thao tác" kèm nhận xét. Người vận hành duyệt
  (có thể sửa) qua API `approve-content` thì bài được xếp lịch đăng lại. Mỗi nền tảng tốn thêm 1 đến 3 lượt gọi AI.
### Sửa lỗi
- Bài đăng qua tiện ích không còn vượt giới hạn ký tự vì bị nối thêm hashtag; diễn đàn không còn bị gắn dòng
  hashtag ở cuối bài; nơi chỉ nhận văn bản thường không còn hiện ký hiệu Markdown như `**` hay `##`.
- Một nền tảng gặp lỗi tạm thời của AI (giới hạn tốc độ, máy chủ AI bận, JSON sai) được thử lại một lần thay vì làm
  hỏng cả chiến dịch.
### Vận hành
- Database đang chạy cần chạy `scripts/sync-ai-prompts.cjs` (xem trước, rồi `--apply`) để dùng prompt mới; có
  `--rollback 2` để quay lại prompt cũ.
## 1.1.1 · 01/11/2026
### Sửa lỗi
- Tiện ích Chrome 1.7.3 chọn ô nhập và nút đăng trong hộp soạn đang mở, hỗ trợ cả Shadow DOM; không chọn nút ngoài hộp khi nút đăng chưa sẵn sàng.
- Chờ đủ tiêu đề và nội dung cho phép nhập trước khi điền, chuyển sang tab Text của Reddit khi cần và giữ bản nháp khác đang có trong các luồng social.
- Bổ sung kiểm thử trình duyệt cho khung soạn tải chậm, nhiều editor, nút trùng và bản nháp. Kiểm thử dùng trang giả lập, chưa xác nhận đăng trên tài khoản thật.
## 1.1.0 · 21/10/2026
### Tính năng
- Kết nối Instagram và Threads bằng một lần đăng nhập, token tự gia hạn
  Bấm "Kết nối" trên trang Tài khoản, đăng nhập Meta và cấp quyền là xong; không cần dán token tay nữa. Hệ thống
  đổi sang token 60 ngày và tự gia hạn mỗi giờ khi còn dưới 15 ngày, nên không phải đăng nhập lại trừ khi Meta thu
  hồi quyền. Cần đặt INSTAGRAM_APP_ID/SECRET, THREADS_APP_ID/SECRET trong cấu hình backend.
- Tự kiểm tra tài khoản và báo khi cần xử lý
  Mỗi ngày 03:15 hệ thống tự kiểm tra kết nối mọi tài khoản; API GET /account-health trả danh sách tài khoản cần
  kết nối lại, token sắp hết hạn và bài đăng bị kẹt. Nếu đặt ALERT_WEBHOOK_URL (Slack, Google Chat, Discord), cảnh
  báo được gửi về kênh chat.
- Đăng Instagram/Threads ổn định hơn
  Chờ Meta xử lý xong ảnh rồi mới đăng; dùng địa chỉ API mới graph.threads.com.
- Khi đăng nhập OAuth lỗi hoặc bị huỷ, người dùng được đưa về trang Tài khoản kèm lý do thay vì trang lỗi JSON.
- Kết nối Tumblr bằng nút "Kết nối"
  Mỗi blog của tài khoản thành một điểm đến; token tự làm mới, đăng bài chữ có tiêu đề và tag. Cần TUMBLR_CLIENT_ID/SECRET.
- Bluesky dùng App Password thay cho token 2 giờ, không còn phải nhập lại.
- Blogger, Tumblr có lựa chọn Đăng ngay hoặc Lưu nháp cho từng tài khoản.
- Đăng diễn đàn bằng tiện ích Chrome
  Cài tiện ích VPSTTT Social Publisher vào Chrome đã đăng nhập diễn đàn, ghép nối bằng mã ở trang Tài khoản. Tiện ích
  tự nhận bài, mở trang tạo chủ đề, điền và bấm Đăng rồi báo link bài về hệ thống. Hỗ trợ XenForo (Voz, cPanel,
  DirectAdmin…), Discourse (NGINX, Caddy, TrueNAS…) và phpBB. Gặp CAPTCHA thì điền sẵn và chờ bạn bấm; không lưu mật
  khẩu hay cookie trên máy chủ.
- Chế độ demo một tiến trình (INLINE_PUBLISH_WORKER, chỉ môi trường dev): chạy thử toàn bộ luồng chỉ với PostgreSQL.
### Sửa lỗi
- Không đăng trùng khi Instagram/Threads/Tumblr không trả lời ở bước đăng: job dừng ở Cần thao tác để người vận hành
  đối soát, thay vì tự gửi lại.
- Lỗi mạng khi làm mới token Google/Tumblr không còn đánh dấu tài khoản "Cần kết nối lại".
### Vận hành
- Thêm TESTING.md (hướng dẫn test từng bước) và lệnh `pnpm smoke:stack` kiểm tra nhanh hệ thống sau khi dựng.

## 1.0.0 · 21/10/2026
### Bảo trì
- Bắt đầu đánh số phiên bản
  Từ bản này mỗi lần gộp có một số phiên bản và ghi thay đổi ở đây.

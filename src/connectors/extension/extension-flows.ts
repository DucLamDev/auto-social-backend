import { BadRequestException } from '@nestjs/common';
import { ExtensionDeliverySettings, ExtensionEngine } from './extension-delivery';
import { SOCIAL_EXTENSION_ENGINES } from './social-recipes';

export interface ExtensionFlow {
  id: string;
  name: string;
  engine: ExtensionEngine;
  forumUrl: string;
  targetUrl: string;
  revision: number;
  setupHint: string;
  targetScope?: 'substack-publication' | 'quora-post' | 'wordpress-admin';
}

const definitions: Array<[string, string, ExtensionEngine, string]> = [
  ['nginx-community', 'NGINX Community', 'discourse', 'https://community.nginx.org'],
  ['caddy-community', 'Caddy Community', 'discourse', 'https://caddy.community'],
  ['almalinux-forum', 'AlmaLinux Forum', 'discourse', 'https://forums.almalinux.org'],
  ['truenas-community', 'TrueNAS Community', 'discourse', 'https://forums.truenas.com'],
  ['level1techs-forum', 'Level1Techs Forum', 'discourse', 'https://forum.level1techs.com'],
  ['linux-containers-forum', 'Linux Containers Forum', 'discourse', 'https://discuss.linuxcontainers.org'],
  ['hestiacp-forum', 'HestiaCP Forum', 'discourse', 'https://forum.hestiacp.com'],
  ['mikrotik-community', 'MikroTik Community', 'discourse', 'https://forum.mikrotik.com'],
  ['opennebula-community', 'OpenNebula Community', 'discourse', 'https://forum.opennebula.io'],
  ['replit-community', 'Replit Community', 'discourse', 'https://replit.discourse.group'],
  ['mongodb-community', 'MongoDB Community', 'discourse', 'https://www.mongodb.com/community/forums'],
  ['voz-forums', 'Voz Forums', 'xenforo', 'https://voz.vn'],
  ['directadmin-forums', 'DirectAdmin Forums', 'xenforo', 'https://forum.directadmin.com'],
  ['cloudpanel-forum', 'CloudPanel Forum', 'xenforo', 'https://www.cloudpanelforum.org'],
  ['linux-foundation-forum', 'Linux Foundation Forum', 'vanilla', 'https://forum.linuxfoundation.org'],
];

// Boxes the owner chose (04/11/2026) for forums whose new-thread page belongs to
// one box: the general technical discussion of each site. An account can still
// set its own box in "Tiện ích"; other XenForo forums have no default.
// Vanilla: the new discussion page of one category (System Management fits server topics).
const VANILLA_DEFAULT_CATEGORIES: Record<string, string> = {
  'linux-foundation-forum': 'https://forum.linuxfoundation.org/post/discussion/system-management',
};

const XENFORO_DEFAULT_BOXES: Record<string, string> = {
  'directadmin-forums': 'https://forum.directadmin.com/forums/general-technical-discussion-troubleshooting.32/post-thread',
  'cloudpanel-forum': 'https://www.cloudpanelforum.org/forums/install-config/post-thread',
};

// These profiles identify the site and editor, not the user's posting rights.
// Category, tags and login belong to each account.
const forumFlows: ExtensionFlow[] = definitions.map(([id, name, engine, forumUrl]) => ({
  id, name, engine, forumUrl, revision: 1,
  targetUrl: engine === 'discourse' ? `${forumUrl}/new-topic` : engine === 'vanilla' ? VANILLA_DEFAULT_CATEGORIES[id] ?? '' : XENFORO_DEFAULT_BOXES[id] ?? '',
  setupHint: engine === 'vanilla'
    ? `Mặc định đăng vào chuyên mục ${VANILLA_DEFAULT_CATEGORIES[id] ?? ''}. Muốn chuyên mục khác thì dán ${forumUrl}/post/discussion/<mã-chuyên-mục> (ví dụ applications, linux-security, ubuntu) vào Trang tạo chủ đề. Nội dung là Markdown; tiện ích điền tiêu đề, nội dung rồi bấm Post Discussion, không bấm Save Draft hay Preview.`
    : engine === 'discourse'
    ? 'Đăng nhập diễn đàn trong Chrome, chọn chuyên mục được phép đăng và tag có sẵn của chuyên mục. Cấu hình này chỉ áp dụng cho diễn đàn này.'
    : XENFORO_DEFAULT_BOXES[id]
      ? `Mặc định đăng vào box ${XENFORO_DEFAULT_BOXES[id].replace(/\/post-thread$/, '')}. Muốn box khác thì vào box đó, bấm tạo chủ đề và dán URL kết thúc bằng /post-thread vào Trang tạo chủ đề.`
      : 'Đăng nhập diễn đàn trong Chrome, vào đúng box rồi bấm tạo chủ đề. Sao chép URL kết thúc bằng /post-thread vào Trang tạo chủ đề.',
}));

export const EXTENSION_FLOWS: readonly ExtensionFlow[] = [...forumFlows,
  { id: 'differ', name: 'Differ', engine: 'differ', forumUrl: 'https://differ.blog', targetUrl: 'https://differ.blog/new-story', revision: 1, setupHint: 'Tạo story, điền tiêu đề/nội dung, chọn Keyword từ tags và Publish. Không ghi đè bản nháp khác.' },
  { id: 'product-hunt', name: 'Product Hunt · Forums', engine: 'producthunt', forumUrl: 'https://www.producthunt.com', targetUrl: 'https://www.producthunt.com/p/new', revision: 1,
    setupHint: 'Start new thread trên forum Product Hunt. Ghi forum / product ở ô Chuyên mục, đúng tên trong ô "Search for a product" (General, Vibecoding, Introduce yourself, Self-Promotion hoặc tên product). Để trống thì đăng vào Self-Promotion. Chưa hỗ trợ Launch sản phẩm.' },
  { id: 'dzone', name: 'DZone', engine: 'dzone', forumUrl: 'https://dzone.com', targetUrl: 'https://dzone.com/content/article/post.html', revision: 1, setupHint: 'Điền bài, tl;dr và metadata rồi gửi biên tập duyệt. DZone có thể yêu cầu thêm chủ đề, ảnh và các trường của tác giả; kết quả chờ duyệt không phải đã xuất bản.' },
  ...([['stack-overflow', 'Stack Overflow', 'https://stackoverflow.com'], ['server-fault', 'Server Fault', 'https://serverfault.com'], ['unix-linux-stackexchange', 'Unix & Linux', 'https://unix.stackexchange.com']] as const).map(([id, name, forumUrl]): ExtensionFlow => ({
    id, name, forumUrl, engine: 'stackexchange', targetUrl: `${forumUrl}/questions/ask`, revision: 1,
    setupHint: 'Câu hỏi kỹ thuật: tiêu đề, nội dung và ít nhất một tag có thật. Tiện ích dùng tag cố định trong cấu hình (nếu có) rồi thêm tag AI của bài mà trang đã có, tối đa 5. Luồng đi qua Review your question rồi Post your question. Nếu Stack Overflow yêu cầu Staging Ground, bài được ghi là chờ duyệt.',
  })),
  { id: 'lemmy-world', name: 'Lemmy.world', engine: 'lemmy', forumUrl: 'https://lemmy.world', targetUrl: 'https://lemmy.world/create_post', revision: 1, setupHint: 'Chọn tên community trong ô Chuyên mục trên web. Tiện ích chọn đúng community, điền tiêu đề/nội dung và bấm Create.' },
  { id: 'discuit', name: 'Discuit', engine: 'discuit', forumUrl: 'https://discuit.org', targetUrl: 'https://discuit.org/new', revision: 1, setupHint: 'Chọn community trong ô Chuyên mục trên web. Luồng tạo Text post và bấm Post sau khi xác nhận community.' },
  { id: 'linkedin', name: 'LinkedIn', engine: 'linkedin', forumUrl: 'https://www.linkedin.com', targetUrl: 'https://www.linkedin.com/feed/', revision: 1, setupHint: 'Start a post → điền nội dung → Post trên hồ sơ cá nhân đã xác minh. Tối đa 3.000 ký tự.' },
  { id: 'minds', name: 'Minds', engine: 'minds', forumUrl: 'https://www.minds.com', targetUrl: 'https://www.minds.com/newsfeed/subscriptions', revision: 1, setupHint: 'Create → Compose → My Channel → Post. Đăng nội dung lên kênh đang xác minh; không bật Boost hoặc đăng vào nhóm khác.' },
  { id: 'mastodon', name: 'Mastodon.social', engine: 'mastodon', forumUrl: 'https://mastodon.social', targetUrl: 'https://mastodon.social/publish', revision: 1, setupHint: 'Đăng nội dung lên hồ sơ Mastodon trong Chrome.' },
  // The catalogue lists mastodon.social twice (Mastodon, Mastodon.social): the same Chrome flow.
  { id: 'mastodon-social', name: 'Mastodon.social', engine: 'mastodon', forumUrl: 'https://mastodon.social', targetUrl: 'https://mastodon.social/publish', revision: 1, setupHint: 'Đăng nội dung lên hồ sơ Mastodon trong Chrome.' },
  { id: 'wordpress', name: 'WordPress', engine: 'wordpress', forumUrl: 'https://wordpress.org', targetUrl: '', revision: 1, targetScope: 'wordpress-admin',
    setupHint: 'Nhập trang viết bài mới của blog: https://TEN-BLOG/wp-admin/post-new.php (blog tự cài, hoặc blog WordPress.com đã chọn giao diện quản trị Classic). Đăng nhập WordPress trong Chrome bằng tài khoản có quyền đăng bài; tài khoản Contributor thì bài được gửi duyệt. Tiện ích điền tiêu đề, nội dung có định dạng, ảnh (ảnh đại diện) rồi bấm Publish.' },
  { id: 'vivaldi-social', name: 'Vivaldi Social', engine: 'mastodon', forumUrl: 'https://social.vivaldi.net', targetUrl: 'https://social.vivaldi.net/publish', revision: 1, setupHint: 'Đăng nội dung lên hồ sơ Vivaldi Social trong Chrome.' },
  { id: 'bluesky', name: 'Bluesky', engine: 'bluesky', forumUrl: 'https://bsky.app', targetUrl: 'https://bsky.app/intent/compose', revision: 1, setupHint: 'Viết bài ngắn trên hồ sơ Bluesky đang đăng nhập.' },
  { id: 'tumblr', name: 'Tumblr', engine: 'tumblr', forumUrl: 'https://www.tumblr.com', targetUrl: 'https://www.tumblr.com/new/text', revision: 1, setupHint: 'Đăng Text post trên blog Tumblr đang chọn trong Chrome.' },
  { id: 'devto', name: 'DEV Community', engine: 'devto', forumUrl: 'https://dev.to', targetUrl: 'https://dev.to/new', revision: 1, setupHint: 'Điền tiêu đề, nội dung Markdown và xuất bản lên DEV.' },
  { id: 'medium', name: 'Medium', engine: 'medium', forumUrl: 'https://medium.com', targetUrl: 'https://medium.com/new-story', revision: 1,
    setupHint: 'Đăng bài trên hồ sơ Medium đang đăng nhập. Tiện ích điền bài và thực hiện cả bước Publish, Publish now; không gửi email cho subscriber.' },
  { id: 'substack', name: 'Substack', engine: 'substack', forumUrl: 'https://substack.com', targetUrl: '', revision: 1, targetScope: 'substack-publication',
    setupHint: 'Nhập https://TEN-PUBLICATION.substack.com/publish/post. Chỉ đăng lên web của publication; tiện ích tắt gửi email và app inbox trước khi Publish.' },
  { id: 'quora', name: 'Quora', engine: 'quora', forumUrl: 'https://www.quora.com', targetUrl: 'https://www.quora.com/', revision: 2, targetScope: 'quora-post',
    setupHint: 'Dùng https://www.quora.com/ để đăng bài cá nhân: Add question → Create Post → Everyone → Post. Hoặc nhập https://TEN-SPACE.quora.com/ để đăng trong Space có quyền tạo bài. Tiêu đề được đặt ở đầu nội dung.' },
  { id: 'reddit', name: 'Reddit', engine: 'reddit', forumUrl: 'https://www.reddit.com', targetUrl: '', revision: 1,
    setupHint: 'Nhập https://www.reddit.com/r/TEN-SUBREDDIT/submit. Nếu cộng đồng yêu cầu flair, cấu hình đúng tên flair có sẵn. Luồng tạo bài dạng Text.' },
  { id: 'slideshare', name: 'SlideShare', engine: 'slideshare', forumUrl: 'https://www.slideshare.net', targetUrl: 'https://www.slideshare.net/upload', revision: 1,
    setupHint: 'Đính kèm một file PDF tối đa 20 MiB cho nội dung trên web trước khi tạo chiến dịch, rồi chọn category. SlideShare thông báo tạm ngừng upload ngày 06/10/2026; luồng chỉ gửi khi màn hình upload hoạt động.' },
  { id: 'aws-community', name: 'AWS Builder Center', engine: 'aws-builder', forumUrl: 'https://builder.aws.com', targetUrl: 'https://builder.aws.com/create/content', revision: 1,
    setupHint: 'AWS Community dùng AWS Builder Center. Đăng nhập bằng Builder ID, hoàn tất hồ sơ; bài được gửi qua editor và có thể chờ nền tảng kiểm duyệt.' },
  { id: 'tinhte', name: 'Tinhte.vn', engine: 'tinhte', forumUrl: 'https://tinhte.vn', targetUrl: 'https://tinhte.vn/editorv2/create/795/', revision: 1,
    setupHint: 'Mặc định đăng vào chuyên mục AI, App, Dịch vụ (795). Muốn chuyên mục khác thì vào chuyên mục đó, bấm viết bài rồi dán URL dạng https://tinhte.vn/editorv2/create/ID-CHUYEN-MUC/. Tiện ích dùng chuyên mục trong URL và editor CKEditor của Tinhte.' },
  { id: 'daily-dev', name: 'daily.dev', engine: 'dailydev', forumUrl: 'https://daily.dev', targetUrl: 'https://daily.dev/squads/create', revision: 1,
    setupHint: 'Đăng bài viết (tiêu đề + nội dung) lên hồ sơ daily.dev đang đăng nhập, qua trang https://daily.dev/squads/create. Chưa hỗ trợ đăng vào Squad.' },
  { id: 'pixelfed-social', name: 'pixelfed.social', engine: 'pixelfed', forumUrl: 'https://pixelfed.social', targetUrl: 'https://pixelfed.social/i/web', revision: 1,
    setupHint: 'Đính kèm một ảnh JPEG/PNG/WebP tối đa 20 MiB cho nội dung trước khi tạo chiến dịch. Tiện ích tải ảnh, điền caption và bấm đăng.' },
  // Disqus closed its other public Channels; Discuss Disqus is the one left, for
  // site owners talking about their communities (Community Growth by default).
  { id: 'disqus', name: 'Discuss Disqus', engine: 'disqus', forumUrl: 'https://disqus.com', targetUrl: 'https://disqus.com/home/discuss/channel-discussdisqus/', revision: 1,
    setupHint: 'Tạo discussion trong kênh Discuss Disqus (kênh của Disqus cho chủ website), mặc định chuyên mục Community Growth: chia sẻ hoặc hỏi về phát triển cộng đồng, bình luận trên website. Đổi chuyên mục bằng ô Chuyên mục (Community Growth, Reveal, Installation, Admin, Plans and Pricing, API, Bug Reports & Feedback, Embed). Tiện ích điền tiêu đề, topic từ tag của bài, nội dung rồi bấm Create Discussion.' },
  { id: 'ubiquiti-community', name: 'Ubiquiti Community', engine: 'ubiquiti', forumUrl: 'https://community.ui.com', targetUrl: 'https://community.ui.com/questions/create', revision: 1,
    setupHint: 'Đăng một Post (câu hỏi / thảo luận) lên community.ui.com. Chủ đề lấy ở ô Chuyên mục của tài khoản (mặc định General; ví dụ Network, Protect, UISP, Site Manager). Tiêu đề 10–200 ký tự, nội dung ít nhất 25 ký tự. Tiện ích điền tiêu đề, nội dung, chọn chủ đề rồi bấm Publish.' },
  { id: 'hugging-face', name: 'Hugging Face Posts', engine: 'huggingface', forumUrl: 'https://huggingface.co', targetUrl: 'https://huggingface.co/posts?post=true', revision: 1,
    setupHint: 'Đăng bài ngắn (Posts, tối đa 1.999 ký tự) lên hồ sơ Hugging Face. Hugging Face chỉ cho một số tài khoản đăng Posts (tài khoản PRO và một số tài khoản được mở quyền): tiện ích hỏi quyền trước khi điền và báo lý do nếu chưa được phép. Blog Article cần PRO nên không dùng.' },
  { id: 'blogger', name: 'Blogger', engine: 'blogger', forumUrl: 'https://www.blogger.com', targetUrl: 'https://www.blogger.com/blog/posts/_', revision: 1,
    setupHint: 'Đăng bài lên blog Blogger của tài khoản Google đang đăng nhập. Mặc định là blog chính (/blog/posts/_); có nhiều blog thì dán https://www.blogger.com/blog/posts/<blogId> của blog cần đăng. Tiện ích bấm Bài đăng mới (Blogger tạo một bản nháp), điền tiêu đề và nội dung, bấm Đăng rồi Xác nhận.' },
  { id: 'mewe', name: 'MeWe', engine: 'mewe', forumUrl: 'https://mewe.com', targetUrl: 'https://mewe.com/myworld', revision: 1,
    setupHint: 'Đăng lên dòng thời gian MeWe của tài khoản đang đăng nhập: tiện ích mở ô "How is your day going?", điền nội dung, gắn ảnh nếu bài có ảnh rồi bấm Post. Ai xem được bài theo mặc định của tài khoản MeWe.' },
  { id: 'unraid-forums', name: 'Unraid Forums', engine: 'invision', forumUrl: 'https://forums.unraid.net', targetUrl: 'https://forums.unraid.net/forum/55-general-support/?do=add', revision: 1,
    setupHint: 'Tạo chủ đề trên diễn đàn Unraid (Invision Community), mặc định box General Support. Muốn box khác thì vào box đó, bấm Start new topic rồi dán URL dạng https://forums.unraid.net/forum/<id>-<tên>/?do=add vào Trang tạo chủ đề. Tiện ích điền tiêu đề, nội dung rồi bấm Submit Topic; trang chỉ cho khách điền (kèm ô email) nghĩa là Chrome chưa đăng nhập, tiện ích dừng chứ không đăng dưới danh nghĩa khách.' },
  { id: 'aapanel-forum', name: 'aaPanel Forum', engine: 'flarum', forumUrl: 'https://www.aapanel.com/forum', targetUrl: 'https://www.aapanel.com/forum/t/general', revision: 1,
    setupHint: 'Tạo discussion trên diễn đàn aaPanel (Flarum), mặc định tag General (thuộc Discussion). Muốn tag khác thì dán https://www.aapanel.com/forum/t/<tag> (ví dụ support, tutorial) vào Trang tạo chủ đề: mở discussion từ trang tag thì tag được chọn sẵn. Tiện ích bấm Start a Discussion, điền tiêu đề (tối đa 80 ký tự), nội dung Markdown rồi bấm Post Discussion.' },
  { id: 'cpanel-community', name: 'cPanel Community', engine: 'zendesk', forumUrl: 'https://support.cpanel.net', targetUrl: 'https://support.cpanel.net/hc/en-us/community/posts/new', revision: 1,
    setupHint: 'Tạo bài trong cộng đồng cPanel (Zendesk). Ghi tên topic cần đăng vào ô Chuyên mục của tài khoản (đúng tên trong ô Topic của form), hoặc dán URL new post có ?community_post[topic_id]=<id> để chọn sẵn. Tiện ích điền tiêu đề, nội dung, chọn topic rồi bấm Submit.' },
];

export function extensionFlowForPlatform(slug: string): ExtensionFlow | undefined {
  return EXTENSION_FLOWS.find((flow) => flow.id === slug);
}

export function extensionFlowDefaults(slug: string): Record<string, string | number> {
  const flow = extensionFlowForPlatform(slug);
  return flow ? {
    extensionFlowId: flow.id,
    extensionFlowRevision: flow.revision,
    extensionEngine: flow.engine,
    extensionForumUrl: flow.forumUrl,
    extensionTargetUrl: flow.targetUrl,
    extensionSetupHint: flow.setupHint,
    extensionTargetScope: flow.targetScope ?? 'origin',
    extensionWorkflow: ['discourse', 'xenforo', 'phpbb', 'vanilla'].includes(flow.engine) ? 'forum' : 'social',
  } : {};
}

export function validateExtensionFlow(slug: string, settings: ExtensionDeliverySettings): ExtensionFlow | undefined {
  const flow = extensionFlowForPlatform(slug);
  if (!flow) {
    if ((SOCIAL_EXTENSION_ENGINES as readonly string[]).includes(settings.engine)) throw new BadRequestException('This social workflow requires its matching platform');
    return undefined;
  }
  const target = new URL(settings.targetUrl);
  const forum = new URL(flow.forumUrl);
  // WordPress: the new-post page of the account's own blog, on any HTTPS domain (sub-folder installs too).
  if (flow.targetScope === 'wordpress-admin') {
    if (settings.engine !== flow.engine || target.protocol !== 'https:' || target.username || target.password || target.port || target.hash
      || !/^(?:\/[\w.-]+)*\/wp-admin\/post-new\.php$/.test(target.pathname) || (target.search && target.search !== '?post_type=post')) {
      throw new BadRequestException(flow.setupHint);
    }
    return flow;
  }
  if (flow.targetScope) {
    const hostPattern = flow.targetScope === 'substack-publication' ? /^[a-z0-9-]+\.substack\.com$/ : /^[a-z0-9-]+\.quora\.com$/;
    if (settings.engine !== flow.engine || target.protocol !== 'https:' || !hostPattern.test(target.hostname)
      || (flow.targetScope === 'substack-publication' && target.hostname === 'www.substack.com')
      || target.username || target.password || target.search || target.hash
      || target.port || (flow.targetScope === 'substack-publication' && !/^\/publish\/post\/?$/.test(target.pathname))
      || (flow.targetScope === 'quora-post' && target.pathname !== '/')) {
      throw new BadRequestException(flow.setupHint);
    }
    return flow;
  }
  if (settings.engine !== flow.engine || target.origin !== forum.origin
    || (forum.pathname !== '/' && target.pathname !== forum.pathname && !target.pathname.startsWith(`${forum.pathname}/`))) {
    throw new BadRequestException(`Flow ${flow.name} requires ${flow.engine} at ${flow.forumUrl}`);
  }
  if (flow.engine === 'reddit' && !/^\/(r|user)\/[A-Za-z0-9_-]+\/submit\/?$/.test(target.pathname)) {
    throw new BadRequestException('Reddit requires the submit page of a specific subreddit or profile');
  }
  const createPaths: Partial<Record<ExtensionEngine, string[]>> = {
    differ: ['/new-story'], dzone: ['/content/article/post.html'], producthunt: ['/p/new'],
    stackexchange: ['/questions/ask'], lemmy: ['/create_post'], discuit: ['/new'], linkedin: ['/feed'],
    minds: ['/newsfeed/subscriptions'],
    medium: ['/new-story'], slideshare: ['/upload'], 'aws-builder': ['/create/content'], pixelfed: ['/i/web', '/i/web/compose'], mewe: ['/myworld'], ubiquiti: ['/questions/create'], huggingface: ['/posts'],
    mastodon: ['/publish'], bluesky: ['/intent/compose'], tumblr: ['/new/text'], devto: ['/new'], dailydev: ['/squads/create'],
  };
  if (createPaths[flow.engine] && !createPaths[flow.engine]!.includes(target.pathname.replace(/\/$/, ''))) {
    throw new BadRequestException(`Use the new-post page for ${flow.name}: ${flow.targetUrl}`);
  }
  // daily.dev silently falls back to the user's profile when ?sid= names a Squad the
  // account cannot post in, so only the plain composer page (own profile) is accepted.
  if (flow.engine === 'dailydev' && (target.search || target.hash)) throw new BadRequestException(flow.setupHint);
  if (flow.engine === 'tinhte' && !/^\/editorv2\/create\/\d+\/?$/.test(target.pathname)) throw new BadRequestException(flow.setupHint);
  if (flow.engine === 'blogger' && !/^\/blog\/posts\/(?:_|\d+)\/?$/.test(target.pathname)) throw new BadRequestException(flow.setupHint);
  if (flow.engine === 'huggingface' && target.search && target.search !== '?post=true') throw new BadRequestException(flow.setupHint);
  if (flow.engine === 'disqus' && (!/^\/home\/discuss\/channel-[a-z0-9-]+\/?$/.test(target.pathname) || target.search || target.hash)) throw new BadRequestException(flow.setupHint);
  // Invision: the new-topic form of one forum. Flarum: the forum home or one tag page (the tag is preset).
  // Zendesk: the community new-post page, optionally preselecting a topic.
  if (flow.engine === 'invision' && (!/^\/forum\/\d+-[a-z0-9-]+\/?$/.test(target.pathname) || target.search !== '?do=add' || target.hash)) throw new BadRequestException(flow.setupHint);
  if (flow.engine === 'flarum' && (!/^\/forum(?:\/t\/[a-z0-9-]+)?\/?$/.test(target.pathname) || target.search || target.hash)) throw new BadRequestException(flow.setupHint);
  if (flow.engine === 'zendesk' && (!/^\/hc\/[a-z]{2}(?:-[a-z]{2})?\/community\/posts\/new\/?$/.test(target.pathname) || target.hash
    || [...target.searchParams.keys()].some((key) => key !== 'community_post[topic_id]') || !/^\d*$/.test(target.searchParams.get('community_post[topic_id]') ?? ''))) throw new BadRequestException(flow.setupHint);
  return flow;
}

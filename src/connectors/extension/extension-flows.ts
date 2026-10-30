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
  targetScope?: 'substack-publication' | 'quora-post';
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
];

// These profiles identify the site and editor, not the user's posting rights.
// Category, tags and login belong to each account; no category is guessed.
const forumFlows: ExtensionFlow[] = definitions.map(([id, name, engine, forumUrl]) => ({
  id, name, engine, forumUrl, revision: 1,
  targetUrl: engine === 'discourse' ? `${forumUrl}/new-topic` : '',
  setupHint: engine === 'discourse'
    ? 'Đăng nhập diễn đàn trong Chrome, chọn chuyên mục được phép đăng và tag có sẵn của chuyên mục. Cấu hình này chỉ áp dụng cho diễn đàn này.'
    : 'Đăng nhập diễn đàn trong Chrome, vào đúng box rồi bấm tạo chủ đề. Sao chép URL kết thúc bằng /post-thread vào Trang tạo chủ đề.',
}));

export const EXTENSION_FLOWS: readonly ExtensionFlow[] = [...forumFlows,
  { id: 'mastodon', name: 'Mastodon.social', engine: 'mastodon', forumUrl: 'https://mastodon.social', targetUrl: 'https://mastodon.social/publish', revision: 1, setupHint: 'Đăng nội dung lên hồ sơ Mastodon trong Chrome.' },
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
  { id: 'tinhte', name: 'Tinhte.vn', engine: 'tinhte', forumUrl: 'https://tinhte.vn', targetUrl: '', revision: 1,
    setupHint: 'Vào chuyên mục Tinhte muốn đăng, bấm viết bài rồi sao chép URL dạng https://tinhte.vn/editorv2/create/ID-CHUYEN-MUC/. Tiện ích dùng chuyên mục trong URL và editor CKEditor của Tinhte.' },
  { id: 'pixelfed-social', name: 'pixelfed.social', engine: 'pixelfed', forumUrl: 'https://pixelfed.social', targetUrl: 'https://pixelfed.social/i/web', revision: 1,
    setupHint: 'Đính kèm một ảnh JPEG/PNG/WebP tối đa 20 MiB cho nội dung trước khi tạo chiến dịch. Tiện ích tải ảnh, điền caption và bấm đăng.' },
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
    extensionWorkflow: ['discourse', 'xenforo', 'phpbb'].includes(flow.engine) ? 'forum' : 'social',
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
    medium: ['/new-story'], slideshare: ['/upload'], 'aws-builder': ['/create/content'], pixelfed: ['/i/web', '/i/web/compose'],
    mastodon: ['/publish'], bluesky: ['/intent/compose'], tumblr: ['/new/text'], devto: ['/new'],
  };
  if (createPaths[flow.engine] && !createPaths[flow.engine]!.includes(target.pathname.replace(/\/$/, ''))) {
    throw new BadRequestException(`Use the new-post page for ${flow.name}: ${flow.targetUrl}`);
  }
  if (flow.engine === 'tinhte' && !/^\/editorv2\/create\/\d+\/?$/.test(target.pathname)) throw new BadRequestException(flow.setupHint);
  return flow;
}

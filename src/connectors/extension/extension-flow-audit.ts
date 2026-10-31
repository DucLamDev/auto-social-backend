import { extensionFlowForPlatform, validateExtensionFlow } from './extension-flows';
import { parseExtensionDeliverySettings } from './extension-delivery';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
// Explicit gaps stay visible. A login alone never certifies a publishing flow.
const gaps: Record<string, { message: string; url?: string }> = {
  'product-hunt': { message: 'Chưa hoàn thiện luồng Launch. Cần launch tags và xác nhận các trường của sản phẩm; không thể dùng bài văn bản thay cho launch.' },
  dailymotion: { message: 'Chưa có luồng upload video. Cần file video, ngôn ngữ và thiết lập nội dung dành cho trẻ em; Chrome cần quyền studio.dailymotion.com.', url: 'https://faq.dailymotion.com/hc/en-us/articles/115009030368-Upload-videos-from-your-Dailymotion-Studio' },
  blogger: { message: 'Cần hoàn tất hồ sơ Google/Blogger và có blog đích. Chưa xác minh được editor của blog để triển khai xuất bản.' },
  'hugging-face': { message: 'Cần xác minh email và quyền tạo Blog Article của tài khoản. Chưa kiểm thử được màn hình xuất bản.', url: 'https://huggingface.co/docs/hub/en/blog-articles' },
  mewe: { message: 'Chưa xác minh được đúng hồ sơ và form đăng MeWe. Chưa có luồng xuất bản đã kiểm thử.' },
  'daily-dev': { message: 'Trang app.daily.dev chuyển sang daily.dev. Cần xác định tài khoản và Squad đích; chưa có luồng đăng đã kiểm thử.', url: 'https://docs.daily.dev/content-guidelines/' },
  'ubiquiti-community': { message: 'New Post còn mở hộp Sign In. Cần hoàn tất đăng nhập Ubiquiti và chọn chủ đề đích trước khi kiểm thử luồng đăng.' },
  'warrior-forum': { message: 'Chưa xác nhận đúng hồ sơ và box có quyền tạo thread. Cần URL tạo thread trong box muốn đăng.' },
  'linux-foundation-forum': { message: 'Chưa nhận diện được phiên và form tạo thảo luận. Cần xác định chuyên mục đích sau đăng nhập.' },
  disqus: { message: 'Disqus đã dừng Channels thông thường; chỉ còn Discuss Disqus cho hỗ trợ sản phẩm. Không có luồng đăng bài lên hồ sơ như mạng xã hội.', url: 'https://help.disqus.com/en/articles/1717095-channel-help' },
};
export function extensionFlowAudit(slug: string, value: unknown) {
  const settings = record(value), setup = record(settings.extensionSetup);
  const flow = extensionFlowForPlatform(slug);
  if (setup.status === 'ACCESS_RESTRICTED') return { status: 'ACCESS_RESTRICTED', message: String(setup.message || 'Nền tảng hạn chế quyền đăng; đăng nhập lại không khôi phục quyền.'), implemented: Boolean(flow) };
  if (slug === 'redis-community-forum') return { status: 'DESTINATION_UNAVAILABLE', implemented: Boolean(flow), message: 'Forum đang chuyển về redis.io, không còn form Discourse tại URL đã cấu hình. Chưa thể đăng ở đích này.' };
  if (!flow) return { status: slug === 'disqus' ? 'UNAVAILABLE' : 'FLOW_REQUIRED', implemented: false, ...(gaps[slug] || { message: 'Chưa có luồng đăng đã kiểm thử cho nền tảng này.' }) };
  const required: string[] = [];
  if (flow.engine === 'stackexchange' && !Array.isArray(settings.extensionTags)) required.push('ít nhất một tag');
  else if (flow.engine === 'stackexchange' && !(settings.extensionTags as unknown[]).length) required.push('ít nhất một tag');
  if (['lemmy', 'discuit'].includes(flow.engine) && !settings.extensionCategory) required.push('community đích');
  if (!settings.extensionTargetUrl && !flow.targetUrl) required.push('trang tạo bài đích');
  if (required.length) return { status: 'DESTINATION_REQUIRED', implemented: true, engine: flow.engine, message: `Đã có luồng; cần cấu hình ${required.join(', ')}. ${flow.setupHint}` };
  if (settings.delivery !== 'extension') return { status: 'CONFIGURATION_REQUIRED', implemented: true, engine: flow.engine, message: `Đã có luồng, chưa bật cấu hình đăng cho tài khoản. ${flow.setupHint}` };
  try { validateExtensionFlow(slug, parseExtensionDeliverySettings(settings)); }
  catch { return { status: 'DESTINATION_REQUIRED', implemented: true, engine: flow.engine, message: `Cấu hình đích chưa hợp lệ. ${flow.setupHint}` }; }
  return { status: 'CONFIGURED', implemented: true, engine: flow.engine, message: flow.setupHint };
}

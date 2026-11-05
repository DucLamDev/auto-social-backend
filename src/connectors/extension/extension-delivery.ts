import { BadRequestException } from '@nestjs/common';
import { SOCIAL_EXTENSION_ENGINES, SOCIAL_EXTENSION_RECIPES } from './social-recipes';

/**
 * "Extension delivery" lets an account publish through the operator's own
 * Chrome: the VPSTTT Chrome extension claims the job, fills the forum's
 * new-thread form in a tab that is already signed in, submits it and reports
 * the thread URL. Cookies stay in Chrome; optional owner-supplied login secrets
 * are held separately in the encrypted credential store.
 */
export const EXTENSION_CONNECTOR_KEY = 'extension';

export const EXTENSION_ENGINES = ['xenforo', 'discourse', 'phpbb', 'vanilla', ...SOCIAL_EXTENSION_ENGINES] as const;
export type ExtensionEngine = (typeof EXTENSION_ENGINES)[number];

export const EXTENSION_SETTING_KEYS = ['delivery', 'extensionEngine', 'extensionTargetUrl', 'extensionAutoSubmit', 'extensionTags', 'extensionCategory', 'extensionFlair'] as const;

export interface ExtensionDeliverySettings {
  engine: ExtensionEngine;
  targetUrl: string;
  autoSubmit: boolean;
  tags?: string[];
  category?: string;
  flair?: string;
}

/**
 * Declarative form recipe sent to the extension. MV3 forbids remote code, so
 * recipes are data only: CSS selectors and URL patterns the bundled runner
 * interprets. A forum redesign is fixed here without reinstalling the extension.
 */
export interface ExtensionRecipe {
  engine: ExtensionEngine;
  workflow?: 'social';
  requiredMedia?: 'image' | 'document';
  /** The composer can take one image when the post has one; text-only posts skip this step. */
  optionalMedia?: 'image';
  /** File input that receives the image (inside the composer). */
  mediaInputSelectors?: string[];
  /** Exact labels of the control that reveals the file input or media dialog. */
  mediaOpenerLabels?: string[];
  /** Visible once the composer holds the image (thumbnail, preview, remove button). */
  mediaPreviewSelectors?: string[];
  /** Field for the image description, when the composer offers one. */
  mediaAltSelectors?: string[];
  /** Visible while the composer is still uploading the image. */
  mediaBusySelectors?: string[];
  /** Exact labels of the step that confirms the chosen image (LinkedIn "Next"). */
  mediaConfirmLabels?: string[];
  /** How long the composer may take to show the image preview (default 45 s). */
  mediaWaitMs?: number;
  publishedTitleSelectors?: string[];
  publishedBodySelectors?: string[];
  publishedLinkSelectors?: string[];
  /** Page must show one of these before the runner touches anything. */
  readySelectors: string[];
  /** Clicked once when no editor is shown yet ("How is your day going?"); never a submit or a form control. */
  openerSelectors?: string[];
  titleSelectors: string[];
  /**
   * Tried in order. How the body goes in follows `inputMode`; without it the
   * runner picks by element: a textarea gets its value set, a social-network
   * contenteditable gets the plain text typed (`insertText`; Slate and CKEditor
   * a text/plain paste), and a forum contenteditable gets escaped `<p>` paragraphs.
   */
  bodySelectors: string[];
  submitSelectors: string[];
  /** Regex source matched against the tab URL once the post exists. */
  successUrlPattern: string;
  /** Visible means "signed out": stop before filling anything. */
  loginSelectors: string[];
  /** Visible after submit means the forum rejected the post. */
  errorSelectors: string[];
  captchaSelectors: string[];
  /** How the body is written: markdown/BBCode-free plain paragraphs for every engine. */
  bodyFormat: 'paragraphs';
  /**
   * How the extension puts the body into the editor: `value` sets a textarea,
   * `insertText` types plain text keeping line breaks, `pasteHtml` pastes
   * `post.bodyHtml` (with `post.body` as text/plain) so rich editors keep
   * headings, lists and code blocks. Absent: the runner picks by element type.
   */
  inputMode?: 'value' | 'insertText' | 'pasteHtml';
  /** `<select>` (or combobox) of the post language; the runner picks the option matching `post.language`. */
  languageSelectors?: string[];
}

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '.cf-turnstile',
  '.g-recaptcha',
  '.h-captcha',
];

export const EXTENSION_RECIPES: Record<ExtensionEngine, ExtensionRecipe> = {
  ...SOCIAL_EXTENSION_RECIPES,
  // XenForo 2 (voz.vn, forums.cpanel.net, forum.directadmin.com…): /forums/x.1/post-thread or /f/x.1/post-thread.
  xenforo: {
    engine: 'xenforo',
    readySelectors: ['form[action$="/post-thread"]'],
    titleSelectors: ['form[action$="/post-thread"] input[name="title"]', 'form[action$="/post-thread"] textarea[name="title"]'],
    bodySelectors: [
      'form[action$="/post-thread"] .fr-element[contenteditable="true"]',
      'form[action$="/post-thread"] textarea[name="message"]',
    ],
    submitSelectors: ['form[action$="/post-thread"] button[type="submit"].button--primary', 'form[action$="/post-thread"] button[type="submit"]'],
    successUrlPattern: '/(threads|t)/[^/?#]+\\.\\d+/?(?:[?#].*)?$',
    loginSelectors: ['form[action$="/login/login"]', '.p-navgroup--guest .p-navgroup-link--logIn'],
    errorSelectors: ['.blockMessage--error', '.overlay-container .blockMessage--error', '.js-overlayContainer .blockMessage--error'],
    captchaSelectors: CAPTCHA_SELECTORS,
    bodyFormat: 'paragraphs',
  },
  // Discourse: target is the forum base URL (optionally /new-topic?category=slug); the composer opens in-page.
  discourse: {
    engine: 'discourse',
    readySelectors: ['#reply-control #reply-title', '#reply-control .d-editor-input'],
    titleSelectors: ['#reply-control #reply-title'],
    bodySelectors: ['#reply-control textarea.d-editor-input', '#reply-control .ProseMirror[contenteditable="true"]'],
    submitSelectors: ['#reply-control button.create', '#reply-control .save-or-cancel button.btn-primary'],
    successUrlPattern: '/t/[^/?#]+/\\d+/?(?:\\d+/?)?(?:[?#].*)?$',
    loginSelectors: ['header .login-button'],
    errorSelectors: ['.dialog-container .dialog-body', '#reply-control .popup-tip.bad:not(.hide)', '.bootbox.modal .modal-body'],
    captchaSelectors: CAPTCHA_SELECTORS,
    bodyFormat: 'paragraphs',
  },
  // Vanilla Forums, classic form (forum.linuxfoundation.org): target is /post/discussion/<category
  // code>, so the category is preset. Body is a Markdown textarea; Post Discussion is briefly
  // disabled while the draft autosaves. Save Draft / Preview are never pressed.
  vanilla: {
    engine: 'vanilla',
    readySelectors: ['#DiscussionForm form', 'form#DiscussionForm'],
    titleSelectors: ['#DiscussionForm input#Form_Name[name="Name"]', '#DiscussionForm input[name="Name"]'],
    bodySelectors: ['#DiscussionForm textarea#Form_Body[name="Body"]', '#DiscussionForm textarea[name="Body"]'],
    submitSelectors: ['#DiscussionForm input#Form_PostDiscussion[type="submit"]', '#DiscussionForm input[type="submit"][name="Post Discussion"]'],
    successUrlPattern: '/discussion/\\d+/[^/?#]+(?:/p\\d+)?/?(?:[?#].*)?$',
    loginSelectors: ['form#Form_User_SignIn', '#Form_User_SignIn'],
    errorSelectors: ['#DiscussionForm .Messages.Errors li', '.Popup .Content', '.InformMessages .InformWrapper'],
    captchaSelectors: CAPTCHA_SELECTORS,
    bodyFormat: 'paragraphs',
  },
  // phpBB 3 (forum.mikrotik.com…): target is posting.php?mode=post&f=<forum id>.
  phpbb: {
    engine: 'phpbb',
    readySelectors: ['form#postform'],
    titleSelectors: ['form#postform input[name="subject"]'],
    bodySelectors: ['form#postform textarea[name="message"]'],
    submitSelectors: ['form#postform input[name="post"]', 'form#postform button[name="post"]'],
    successUrlPattern: 'viewtopic\\.php\\?(?:.*&)?(t|p)=\\d+',
    loginSelectors: ['form#login input[name="username"]'],
    errorSelectors: ['form#postform .error', '#message .error'],
    captchaSelectors: CAPTCHA_SELECTORS,
    bodyFormat: 'paragraphs',
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isExtensionDelivery(settings: unknown): boolean {
  return asRecord(settings).delivery === EXTENSION_CONNECTOR_KEY;
}

/** The connector that actually publishes for this account. */
export function effectiveConnectorKey(platformConnectorKey: string, settings: unknown): string {
  return isExtensionDelivery(settings) ? EXTENSION_CONNECTOR_KEY : platformConnectorKey;
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * Validates operator input. HTTPS is required except for localhost, which the
 * end-to-end fixture and local demos use.
 */
export function parseExtensionDeliverySettings(input: unknown): ExtensionDeliverySettings {
  const settings = asRecord(input);
  const engine = settings.extensionEngine;
  if (typeof engine !== 'string' || !(EXTENSION_ENGINES as readonly string[]).includes(engine)) {
    throw new BadRequestException(`extensionEngine must be one of: ${EXTENSION_ENGINES.join(', ')}`);
  }
  const raw = settings.extensionTargetUrl;
  let url: URL;
  try {
    url = new URL(typeof raw === 'string' ? raw.trim() : '');
  } catch {
    throw new BadRequestException('extensionTargetUrl must be an absolute URL');
  }
  if (url.username || url.password) throw new BadRequestException('extensionTargetUrl must not contain credentials');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new BadRequestException('extensionTargetUrl must use https');
  }
  if (engine === 'xenforo' && !/\/post-thread\/?$/.test(url.pathname)) {
    throw new BadRequestException('XenForo target must be the forum "post-thread" page, e.g. https://voz.vn/f/chuyen-tro-linh-tinh.17/post-thread');
  }
  if (engine === 'phpbb' && !(url.pathname.endsWith('/posting.php') && url.searchParams.get('mode') === 'post' && /^\d+$/.test(url.searchParams.get('f') ?? ''))) {
    throw new BadRequestException('phpBB target must be posting.php?mode=post&f=<forum id>');
  }
  if (engine === 'vanilla' && !/\/post\/discussion(?:\/[A-Za-z0-9_-]+)?\/?$/.test(url.pathname)) {
    throw new BadRequestException('Vanilla target must be the new discussion page of a category, e.g. https://forum.linuxfoundation.org/post/discussion/system-management');
  }
  // Subfolder installs (https://example.com/forum) are allowed; a topic URL is not.
  if (engine === 'discourse' && /\/t\//.test(url.pathname)) {
    throw new BadRequestException('Discourse target must be the forum home page or /new-topic?category=<slug>');
  }
  if (typeof settings.extensionAutoSubmit !== 'boolean') {
    throw new BadRequestException('extensionAutoSubmit must be true or false');
  }
  const tags = settings.extensionTags ?? [];
  if (!Array.isArray(tags) || tags.length > 10 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 80)) {
    throw new BadRequestException('extensionTags must contain at most 10 tag names (80 characters each)');
  }
  const category = settings.extensionCategory ?? '';
  const flair = settings.extensionFlair ?? '';
  if (typeof category !== 'string' || category.length > 160 || typeof flair !== 'string' || flair.length > 160) {
    throw new BadRequestException('Category and flair must be text of at most 160 characters');
  }
  return { engine: engine as ExtensionEngine, targetUrl: url.toString(), autoSubmit: settings.extensionAutoSubmit,
    tags: [...new Set((tags as string[]).map(tag => tag.trim()))], category: category.trim(), flair: flair.trim() };
}

/** URL the extension opens; Discourse always goes to /new-topic so the composer opens. */
export function extensionOpenUrl(settings: ExtensionDeliverySettings): string {
  if (settings.engine !== 'discourse') return settings.targetUrl;
  const url = new URL(settings.targetUrl);
  if (!url.pathname.endsWith('/new-topic')) url.pathname = `${url.pathname.replace(/\/$/, '')}/new-topic`;
  return url.toString();
}

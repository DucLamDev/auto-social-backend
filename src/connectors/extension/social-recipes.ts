import type { ExtensionRecipe } from './extension-delivery';

export const SOCIAL_EXTENSION_ENGINES = ['medium', 'substack', 'quora', 'reddit', 'slideshare', 'aws-builder', 'tinhte', 'pixelfed', 'mastodon', 'bluesky', 'tumblr', 'devto', 'minds', 'stackexchange', 'lemmy', 'discuit', 'linkedin', 'differ', 'dzone'] as const;
export type SocialExtensionEngine = (typeof SOCIAL_EXTENSION_ENGINES)[number];

function recipe(engine: SocialExtensionEngine, fields: Partial<ExtensionRecipe>): ExtensionRecipe {
  return {
    engine, workflow: 'social', readySelectors: [], titleSelectors: [], bodySelectors: [], submitSelectors: [],
    successUrlPattern: '(?!)', loginSelectors: ['input[type="password"]'],
    errorSelectors: ['[role="alert"]', '.alert-danger', '.error-message'],
    captchaSelectors: ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '.cf-turnstile', '.g-recaptcha', '.h-captcha', '#challenge-running'],
    bodyFormat: 'paragraphs', ...fields,
  };
}

// Selectors are declarative data. All executable workflow steps ship in the
// extension, and require a visible, unambiguous composer before any write.
export const SOCIAL_EXTENSION_RECIPES: Record<SocialExtensionEngine, ExtensionRecipe> = {
  differ: recipe('differ', {
    readySelectors: ['textarea[name="title"]'], titleSelectors: ['textarea[name="title"]'], bodySelectors: ['[contenteditable][aria-label="editable markdown"]'],
    submitSelectors: ['button#post-submit-button'], successUrlPattern: '/p/[^/?#]+(?:[?#].*)?$', publishedTitleSelectors: ['h1'], publishedBodySelectors: ['article', '.prose'],
  }),
  dzone: recipe('dzone', {
    readySelectors: ['textarea.article-title[name="title"]'], titleSelectors: ['textarea.article-title[name="title"]'], bodySelectors: ['.fr-element.fr-view[contenteditable]'],
    submitSelectors: ['.dropdown-menu li[ng-click="s.save(true, false, false, true)"]'], successUrlPattern: '/articles/[^/?#]+(?:[?#].*)?$', publishedTitleSelectors: ['h1'], publishedBodySelectors: ['.article-content', '.content-body', 'article'],
  }),
  stackexchange: recipe('stackexchange', {
    readySelectors: ['#title', '#post-title-input'], titleSelectors: ['#title', '#post-title-input'],
    bodySelectors: ['textarea#wmd-input', '.js-editor.ProseMirror[contenteditable]'],
    submitSelectors: ['#submit-button', 'button.js-submit-button'],
    successUrlPattern: '/questions/\\d+/[^/?#]+(?:[?#].*)?$', publishedTitleSelectors: ['#question-header h1 a'], publishedBodySelectors: ['#question .s-prose'],
  }),
  lemmy: recipe('lemmy', {
    readySelectors: ['textarea#post-title'], titleSelectors: ['textarea#post-title'], bodySelectors: ['textarea[id^="markdown-textarea-"]'],
    submitSelectors: ['form button[type="submit"]'], successUrlPattern: '/post/\\d+(?:[?#].*)?$',
    publishedTitleSelectors: ['.post-title'], publishedBodySelectors: ['.post-listing .md-div', '.post-listing .md'],
  }),
  discuit: recipe('discuit', {
    readySelectors: ['textarea.page-new-post-title'], titleSelectors: ['textarea.page-new-post-title'], bodySelectors: ['textarea.page-new-post-body', '.page-new-post-body textarea'],
    submitSelectors: ['.page-new-form button[type="submit"]'], successUrlPattern: '/[^/]+/post/[a-zA-Z0-9_-]+(?:[?#].*)?$',
    publishedTitleSelectors: ['.post-title', '.post-page-title'], publishedBodySelectors: ['.post-body', '.post-page-body'],
  }),
  linkedin: recipe('linkedin', {
    readySelectors: ['.tiptap.ProseMirror[contenteditable]', '[role="dialog"] .ql-editor[contenteditable="true"]'], bodySelectors: ['.tiptap.ProseMirror[contenteditable]', '[role="dialog"] .ql-editor[contenteditable="true"]'],
    submitSelectors: ['[role="dialog"] button.share-actions__primary-action'], successUrlPattern: '/(?:feed/update/urn:li:activity:\\d+/?|posts/[^/?#]+)(?:[?#].*)?$',
    publishedBodySelectors: ['.feed-shared-update-v2__description'], publishedLinkSelectors: ['a[href*="/feed/update/"]', 'a[href*="/posts/"]'],
  }),
  minds: recipe('minds', {
    readySelectors: ['m-composer__textarea textarea'], bodySelectors: ['m-composer__textarea textarea.m-composerTextarea__message'],
    submitSelectors: ['m-composer__modal m-composer__postbutton button'],
    successUrlPattern: '/newsfeed/\\d+(?:[?#].*)?$',
    publishedBodySelectors: ['m-activity__content', '.m-activityContent__message'], publishedLinkSelectors: ['a[href*="/newsfeed/"]'],
  }),
  mastodon: recipe('mastodon', {
    readySelectors: ['textarea#composer-text', '.compose-form textarea'], bodySelectors: ['textarea#composer-text', '.compose-form textarea.autosuggest-textarea__textarea', '.compose-form textarea'],
    submitSelectors: ['.compose-form__publish-button-wrapper button', '.compose-form__publish button'],
    successUrlPattern: '/@[^/]+/\\d+(?:[?#].*)?$', publishedBodySelectors: ['.status__content', '.status__content__text'], publishedLinkSelectors: ['a.status__relative-time', 'a[href*="/@"]'],
  }),
  bluesky: recipe('bluesky', {
    readySelectors: ['[data-testid="composerTextInput"]', '[contenteditable="true"][role="textbox"]'],
    bodySelectors: ['[data-testid="composerTextInput"][contenteditable="true"]', '[data-testid="composerTextInput"] [contenteditable="true"]', '.tiptap[contenteditable="true"]', '[contenteditable="true"][role="textbox"]'],
    submitSelectors: ['[data-testid="composerPublishBtn"]'], successUrlPattern: '/profile/[^/]+/post/[a-z0-9]+(?:[?#].*)?$',
    publishedBodySelectors: ['[data-testid="postText"]'], publishedLinkSelectors: ['a[href*="/post/"]'],
  }),
  tumblr: recipe('tumblr', {
    readySelectors: ['[contenteditable="true"][role="textbox"]', '[contenteditable="true"][data-placeholder]'],
    titleSelectors: ['[contenteditable="true"][data-placeholder="Title"]', 'input[placeholder="Title"]'],
    bodySelectors: ['[contenteditable="true"][data-placeholder="Your text here"]', '[contenteditable="true"][aria-label="Post body"]', '[contenteditable="true"][role="textbox"]'],
    submitSelectors: ['button[aria-label="Post"]'], successUrlPattern: '/(?:blog/view/)?[^/]+/\\d+(?:/[^?#]*)?(?:[?#].*)?$',
    publishedTitleSelectors: ['article h1', 'article h2'], publishedBodySelectors: ['article [data-npf]', 'article .post-content', 'article'], publishedLinkSelectors: ['a[href*="/post/"]', 'a[aria-label*="Permalink"]'],
  }),
  devto: recipe('devto', {
    readySelectors: ['#article-form'], titleSelectors: ['#article-form-title', 'textarea[name="article[title]"]'],
    bodySelectors: ['#article_body_markdown', 'textarea[name="article[body_markdown]"]'],
    submitSelectors: ['button[data-testid="publish-button"]', '#article-form button[type="submit"]'],
    successUrlPattern: '/[^/]+/[^/?#]+-[a-z0-9]+(?:[?#].*)?$', publishedTitleSelectors: ['#main-title', 'h1'], publishedBodySelectors: ['#article-body'],
  }),
  medium: recipe('medium', {
    readySelectors: ['.postArticle-content [contenteditable="true"]', 'article [contenteditable="true"]'],
    titleSelectors: ['h3[data-placeholder="Title"]', 'h1[data-placeholder="Title"]', '[data-testid="editor-title"]'],
    bodySelectors: ['.section-inner[contenteditable="true"]', '[data-testid="editor-content"][contenteditable="true"]'],
    submitSelectors: ['button[data-action="publish"]'],
    successUrlPattern: '/(?:@[^/]+|[^/]+)/[^/?#]+-[a-f0-9]{12}(?:[?#].*)?$',
    publishedTitleSelectors: ['article h1'], publishedBodySelectors: ['article .section-inner', 'article'],
  }),
  substack: recipe('substack', {
    readySelectors: ['.tiptap[contenteditable="true"]', '.ProseMirror[contenteditable="true"]'],
    titleSelectors: ['textarea[placeholder="Title"]', 'input[placeholder="Title"]', '[data-placeholder="Title"][contenteditable="true"]'],
    bodySelectors: ['.tiptap[contenteditable="true"]', '.ProseMirror[contenteditable="true"]'],
    successUrlPattern: '/p/[^/?#]+(?:[?#].*)?$',
    publishedTitleSelectors: ['h1.post-title', 'article h1'], publishedBodySelectors: ['.available-content .body', '.body.markup', 'article'],
  }),
  quora: recipe('quora', {
    readySelectors: ['[role="dialog"] .doc[contenteditable="true"]', '[role="dialog"] .ql-editor[contenteditable="true"]', '.q-box .ql-editor[contenteditable="true"]'],
    bodySelectors: ['[role="dialog"] .doc[contenteditable="true"]', '[role="dialog"] .ql-editor[contenteditable="true"]', '.q-box .ql-editor[contenteditable="true"]'],
    submitSelectors: ['[role="dialog"] button.puppeteer_test_modal_submit'],
    successUrlPattern: '^https://[^/]+\\.quora\\.com/(?:profile/[^/?#]+/(?!(?:posts|answers|questions|followers|following|about)(?:[/?#]|$))[^/?#]+|(?!profile|about|followers|following)[^/?#]+)(?:[?#].*)?$',
    publishedBodySelectors: ['.q-box .q-text.qu-display--block', '.q-text'], publishedLinkSelectors: ['a[href*="/posts/"]', 'a[href*="/profile/"]', 'a.q-box[href]'],
  }),
  reddit: recipe('reddit', {
    readySelectors: ['textarea[name="title"]', 'textarea[placeholder="Title"]', 'input[name="title"]'],
    titleSelectors: ['textarea[name="title"]', 'textarea[placeholder="Title"]', 'input[name="title"]'],
    bodySelectors: ['[contenteditable="true"][role="textbox"]', '.tiptap[contenteditable="true"]', 'textarea[name="text"]'],
    submitSelectors: ['button[type="submit"]', 'button#post-submit-button'],
    successUrlPattern: '/(?:r|user)/[^/]+/comments/[a-z0-9]+(?:/[^?#]*)?(?:[?#].*)?$',
    publishedTitleSelectors: ['shreddit-post h1', 'h1', '.title a.title'],
    publishedBodySelectors: ['shreddit-post [slot="text-body"]', '.usertext-body .md'],
  }),
  slideshare: recipe('slideshare', {
    readySelectors: ['input[type="file"]'], requiredMedia: 'document',
    titleSelectors: ['input[name="title"]', 'input#title'],
    bodySelectors: ['textarea[name="description"]', 'textarea#description'],
    successUrlPattern: '/(?:slideshow/[^/?#]+/\\d+|[^/?#]+/[^/?#]+)(?:[?#].*)?$',
    publishedTitleSelectors: ['h1'], publishedBodySelectors: ['[data-testid="slideshow-description"]', '.slideshow-description', '#description'],
  }),
  'aws-builder': recipe('aws-builder', {
    readySelectors: ['input[placeholder*="title" i]', 'textarea[placeholder*="title" i]', '[data-slate-editor="true"][contenteditable="true"]'],
    titleSelectors: ['input[placeholder*="title" i]', 'textarea[placeholder*="title" i]', 'input[name="title"]', 'input[aria-label="Title"]'],
    bodySelectors: ['[data-slate-editor="true"][contenteditable="true"]', '.tiptap[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', 'textarea[aria-label*="content" i]', 'textarea[name="content"]'],
    successUrlPattern: '/content/[a-zA-Z0-9]+/[^/?#]+(?:[?#].*)?$',
    publishedTitleSelectors: ['h1'], publishedBodySelectors: ['article', '[data-testid="article-content"]', '.prose'],
  }),
  tinhte: recipe('tinhte', {
    readySelectors: ['input[name="title"]', 'textarea[name="title"]', '.fr-element[contenteditable="true"]', '[contenteditable="true"][role="textbox"]'],
    titleSelectors: ['textarea.title-input', 'input[name="title"]', 'textarea[name="title"]', 'input[placeholder*="tiêu đề" i]', 'textarea[placeholder*="tiêu đề" i]'],
    bodySelectors: ['.ck-editor__editable[contenteditable="true"]', '.fr-element[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', '.public-DraftEditor-content[contenteditable="true"]', '[contenteditable="true"][role="textbox"]', 'textarea[name="message"]'],
    successUrlPattern: '/thread/[^/?#]+\\.\\d+/?(?:[?#].*)?$',
    publishedTitleSelectors: ['h1'], publishedBodySelectors: ['.message-body .bbWrapper', '.bbWrapper', '.thread-content', '[itemprop="articleBody"]'],
  }),
  pixelfed: recipe('pixelfed', {
    readySelectors: ['.compose-modal-component', '#composeModal', 'input#pf-dz'], requiredMedia: 'image',
    bodySelectors: ['textarea[placeholder="Write a caption..."]', '.compose-modal-component textarea', 'textarea[placeholder*="caption" i]'],
    successUrlPattern: '/p/[^/]+/\\d+(?:[?#].*)?$',
    publishedBodySelectors: ['.post-caption', '.status-content', '.caption', '[data-testid="post-caption"]'],
    publishedLinkSelectors: ['a[href*="/p/"]'],
  }),
};

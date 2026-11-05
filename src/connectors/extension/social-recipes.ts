import type { ExtensionRecipe } from './extension-delivery';

export const SOCIAL_EXTENSION_ENGINES = ['medium', 'substack', 'quora', 'reddit', 'slideshare', 'aws-builder', 'tinhte', 'pixelfed', 'mastodon', 'bluesky', 'tumblr', 'devto', 'minds', 'stackexchange', 'lemmy', 'discuit', 'linkedin', 'differ', 'dzone', 'dailydev', 'producthunt', 'disqus', 'mewe', 'ubiquiti', 'huggingface', 'blogger'] as const;
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
// inputMode: rich editors that render formatting get `pasteHtml` (post.bodyHtml,
// post.body as text/plain); Markdown textareas get `value`. Plain-text composers
// (Mastodon, Bluesky, Minds, LinkedIn feed…) and mixed lists of editors (Reddit,
// Stack Exchange, Tinhte) keep the runner's choice by element type.
export const SOCIAL_EXTENSION_RECIPES: Record<SocialExtensionEngine, ExtensionRecipe> = {
  // Hugging Face Posts (huggingface.co/posts?post=true opens the "New Post" dialog): one
  // textarea of at most 1999 characters, Post submits the form and opens /posts/<user>/<id>.
  // Who may post is decided by Hugging Face (/api/posts/can-post), checked before writing.
  huggingface: recipe('huggingface', {
    readySelectors: ['dialog textarea[name="content"]', 'form[action="/posts"] textarea[name="content"]'],
    bodySelectors: ['dialog textarea[name="content"]', 'form[action="/posts"] textarea[name="content"]'], inputMode: 'value',
    submitSelectors: ['form[action="/posts"] button[type="submit"]'],
    successUrlPattern: '/posts/[^/?#]+/\\d{6,}/?(?:[?#].*)?$',
    errorSelectors: ['dialog .alert-warning', '.alert-warning'],
    publishedBodySelectors: ['div[data-target="SocialPost"]', 'main div.break-words', 'main'],
  }),
  // Blogger (new UI): "New Post" ([jsname=UOx8F]) creates a draft and opens
  // /blog/post/edit/<blogId>/<postId>; the body is a same-origin designMode iframe.
  // Publish ([jsname=vdQQuc], "Đăng") asks to confirm; the post list then links the
  // published post on <blog>.blogspot.com. The whole run is in social-actions.js.
  blogger: recipe('blogger', {
    readySelectors: ['[jsname="UOx8F"]', '[jsname="r4nke"] input'],
    titleSelectors: ['[jsname="r4nke"] input'], bodySelectors: ['iframe.editable'], inputMode: 'pasteHtml',
    submitSelectors: ['[jsname="vdQQuc"]'],
    successUrlPattern: '^https://[a-z0-9-]+\\.blogspot\\.com/\\d{4}/\\d{2}/[^/?#]+\\.html',
    errorSelectors: ['[role="alert"]'],
  }),
  // Ubiquiti Community (community.ui.com/questions/create): a "Post" is a question with a
  // title (10-200), a TipTap body (25-30000) and one required topic chosen from buttons.
  // Publish goes to /questions/<slug>/<uuid>; nothing is held for review.
  ubiquiti: recipe('ubiquiti', {
    readySelectors: ['input[data-uic-component="TextInput.Field"][placeholder="Start with a descriptive title"]'],
    titleSelectors: ['input[data-uic-component="TextInput.Field"][placeholder="Start with a descriptive title"]'],
    bodySelectors: ['.tiptap-text-block .ProseMirror[contenteditable="true"]'], inputMode: 'pasteHtml',
    submitSelectors: [], successUrlPattern: '/questions/[^/?#]+/[0-9a-f-]{36}(?:[?#].*)?$',
    errorSelectors: ['[data-uic-component="Label.HelpText"][data-invalid]', '.Toastify__toast'],
    // The question page has no stable body selector: its main area, on the new question's URL.
    publishedBodySelectors: ['main', '#root'],
  }),
  // Discuss Disqus (disqus.com/home/discuss/channel-…/): the form reads the title and
  // the plain-text editor (contenteditable="plaintext-only") on focusout; a category
  // radio prefixes the title with "<Category>: ". A new discussion opens
  // /channel/<name>/discussion/channel-<name>/<slug>/ (pushState, no reload).
  disqus: recipe('disqus', {
    readySelectors: ['input[name="title"]'], titleSelectors: ['input[name="title"]'],
    bodySelectors: ['[data-role="postbox"] [data-role="editable"]'],
    submitSelectors: ['#submit-button'], successUrlPattern: '/channel/[a-z0-9_-]+/discussion/channel-[a-z0-9_-]+/[^/?#]+/?(?:[?#].*)?$',
    errorSelectors: ['.form-attribute-input.is-error [data-role="attribute-error"]', '.modal [data-role="content"] .modal-body'],
    // The shown title may drop the category prefix: the body and the URL confirm the post.
    publishedBodySelectors: ['.reading-block[data-role="message"]'],
  }),
  // MeWe (Ember + Quill 2): "How is your day going?" on /myworld opens #c-postbox-dialog
  // posting to the signed-in user's own feed with the account's default audience. The
  // dialog closes on success and the post is added on top of the feed without a link;
  // its permalink is built from the post header's data-postid (see social-actions.js).
  mewe: recipe('mewe', {
    readySelectors: ['[data-testid="post-placeholder"]', '.c-mw-postbox .ql-editor[contenteditable="true"]'],
    openerSelectors: ['[data-testid="post-placeholder"]', '.c-mw-postbox-placeholder .postbox-placeholder_text'],
    bodySelectors: ['#c-postbox-dialog .c-mw-postbox .ql-editor[contenteditable="true"]', '.c-mw-postbox .ql-editor[contenteditable="true"]'],
    submitSelectors: ['#c-postbox-dialog button[data-testid="share-btn"]', '.c-mw-postbox button[data-testid="share-btn"]'],
    // PNG / JPEG / GIF only: WebP is taken as a document, so the extension converts it to PNG.
    optionalMedia: 'image', mediaInputSelectors: ['input#fake-upload-photo[type="file"]', 'input[data-testid="postbox-upload-photo"]'],
    mediaPreviewSelectors: ['.c-mw-postbox .postbox_media .c-mw-postbox-photo', '.c-mw-postbox img.postbox-photo_img'],
    mediaBusySelectors: ['.c-mw-postbox .postbox_media_photo_wrapper--loading', '.c-mw-postbox .m-progress'],
    successUrlPattern: '/post/show/[A-Za-z0-9_-]+(?:[?#].*)?$',
    errorSelectors: ['.c-mw-toast-box'],
    publishedBodySelectors: ['.c-mw-post .post_text[data-testid="post-text"]'],
  }),
  // daily.dev /squads/create opens its composer dialog (form#smart_composer) with the
  // signed-in user's own profile as audience; a new post opens /posts/<slug>.
  dailydev: recipe('dailydev', {
    readySelectors: ['form#smart_composer'], titleSelectors: ['form#smart_composer textarea[name="title"]'],
    bodySelectors: ['form#smart_composer .ProseMirror[contenteditable="true"]'], inputMode: 'pasteHtml',
    submitSelectors: ['button[type="submit"][form="smart_composer"]'], successUrlPattern: '/posts/[^/?#]+(?:[?#].*)?$',
    publishedTitleSelectors: ['h1'], publishedBodySelectors: ['[class*="markdown"]'],
  }),
  // The toolbar Publish (#post-submit-button) opens <dialog id="modal-submit">: optional featured
  // image (JPG/PNG/GIF ≤ 5 MB), one Keyword from Differ's topic list, then the dialog's own Publish.
  differ: recipe('differ', {
    readySelectors: ['textarea[name="title"]'], titleSelectors: ['textarea[name="title"]'], bodySelectors: ['[contenteditable][aria-label="editable markdown"]'], inputMode: 'pasteHtml',
    optionalMedia: 'image', mediaInputSelectors: ['dialog#modal-submit input[type="file"]'], mediaPreviewSelectors: ['dialog#modal-submit img[alt="preview"]'],
    submitSelectors: ['button#post-submit-button'], successUrlPattern: '/p/[^/?#]+(?:[?#].*)?$', publishedTitleSelectors: ['h1'], publishedBodySelectors: ['article', '.prose'],
  }),
  // Product Hunt forums, "Start new thread" (/p/new): a product / forum picker ("Search for a
  // product": General, Self-Promotion, a product's own forum…), Title, a rich Body editor and
  // the form's Submit. The header also has a "Submit" (launch a product): never that one.
  // The new thread opens at /p/<forum>/<slug>.
  producthunt: recipe('producthunt', {
    readySelectors: ['input[placeholder*="Search for a product" i]', 'input[placeholder="Title" i]', 'input[name="title"]'],
    titleSelectors: ['input[placeholder="Title" i]', 'input[name="title"]', 'textarea[placeholder="Title" i]', 'textarea[name="title"]'],
    bodySelectors: ['.ProseMirror[contenteditable="true"]', '[contenteditable="true"][data-placeholder="Body" i]', '[contenteditable="true"][aria-placeholder="Body" i]', 'main [contenteditable="true"]'],
    inputMode: 'pasteHtml', submitSelectors: [], successUrlPattern: '/p/(?!new(?:[/?#]|$))[^/?#]+/[^/?#]+(?:[?#].*)?$',
    publishedTitleSelectors: ['h1'], publishedBodySelectors: ['main'],
  }),
  dzone: recipe('dzone', {
    readySelectors: ['textarea.article-title[name="title"]'], titleSelectors: ['textarea.article-title[name="title"]'], bodySelectors: ['.fr-element.fr-view[contenteditable]'], inputMode: 'pasteHtml',
    submitSelectors: ['.dropdown-menu li[ng-click="s.save(true, false, false, true)"]'], successUrlPattern: '/articles/[^/?#]+(?:[?#].*)?$', publishedTitleSelectors: ['h1'], publishedBodySelectors: ['.article-content', '.content-body', 'article'],
  }),
  stackexchange: recipe('stackexchange', {
    readySelectors: ['#title', '#post-title-input'], titleSelectors: ['#title', '#post-title-input'],
    bodySelectors: ['textarea#wmd-input', '.js-editor.ProseMirror[contenteditable]'],
    submitSelectors: ['#submit-button', 'button.js-submit-button'],
    successUrlPattern: '/questions/\\d+/[^/?#]+(?:[?#].*)?$', publishedTitleSelectors: ['#question-header h1 a'], publishedBodySelectors: ['#question .s-prose'],
  }),
  lemmy: recipe('lemmy', {
    readySelectors: ['textarea#post-title'], titleSelectors: ['textarea#post-title'], bodySelectors: ['textarea[id^="markdown-textarea-"]'], inputMode: 'value',
    // lemmy-ui post form: one language <select> (ids differ between versions).
    languageSelectors: ['#post-language', 'select[id^="post-language"]', 'form select[id^="language-select-"]'],
    submitSelectors: ['form button[type="submit"]'], successUrlPattern: '/post/\\d+(?:[?#].*)?$',
    publishedTitleSelectors: ['.post-title'], publishedBodySelectors: ['.post-listing .md-div', '.post-listing .md'],
  }),
  discuit: recipe('discuit', {
    readySelectors: ['textarea.page-new-post-title'], titleSelectors: ['textarea.page-new-post-title'], bodySelectors: ['textarea.page-new-post-body', '.page-new-post-body textarea'], inputMode: 'value',
    submitSelectors: ['.page-new-form button[type="submit"]'], successUrlPattern: '/[^/]+/post/[a-zA-Z0-9_-]+(?:[?#].*)?$',
    publishedTitleSelectors: ['.post-title', '.post-page-title'], publishedBodySelectors: ['.post-body', '.post-page-body'],
  }),
  linkedin: recipe('linkedin', {
    readySelectors: ['.tiptap.ProseMirror[contenteditable]', '[role="dialog"] .ql-editor[contenteditable="true"]'], bodySelectors: ['.tiptap.ProseMirror[contenteditable]', '[role="dialog"] .ql-editor[contenteditable="true"]'],
    submitSelectors: ['[role="dialog"] button.share-actions__primary-action'],
    // "Add media" opens a file picker, then an editor step confirmed with Next.
    optionalMedia: 'image', mediaOpenerLabels: ['Add media', 'Add a photo', 'Thêm phương tiện', 'Thêm ảnh'],
    mediaInputSelectors: ['input[type="file"][accept*="image"]', 'input[type="file"]'], mediaConfirmLabels: ['Next', 'Done', 'Tiếp', 'Tiếp theo', 'Xong'],
    mediaPreviewSelectors: ['[role="dialog"] .share-creation-state__media img', '[role="dialog"] img[src^="blob:"]', '[role="dialog"] img[src*="media.licdn.com"]', '[role="dialog"] [class*="share-media"] img'],
    mediaAltSelectors: ['[role="dialog"] textarea[name="alt-text"]', '[role="dialog"] textarea[id*="alt-text"]'],
    successUrlPattern: '/(?:feed/update/urn:li:activity:\\d+/?|posts/[^/?#]+)(?:[?#].*)?$',
    publishedBodySelectors: ['.feed-shared-update-v2__description'], publishedLinkSelectors: ['a[href*="/feed/update/"]', 'a[href*="/posts/"]'],
  }),
  minds: recipe('minds', {
    // Newsfeed shows an inline "Speak your mind…" composer; older layouts open a modal.
    readySelectors: ['m-composer__textarea textarea', 'textarea[placeholder*="Speak your mind" i]'],
    bodySelectors: ['m-composer__textarea textarea.m-composerTextarea__message', 'm-composer__textarea textarea', 'textarea[placeholder*="Speak your mind" i]'],
    submitSelectors: ['m-composer__modal m-composer__postbutton button'],
    successUrlPattern: '/newsfeed/\\d+(?:[?#].*)?$',
    publishedBodySelectors: ['m-activity__content', '.m-activityContent__message'], publishedLinkSelectors: ['a[href*="/newsfeed/"]'],
  }),
  mastodon: recipe('mastodon', {
    readySelectors: ['textarea#composer-text', '.compose-form textarea'], bodySelectors: ['textarea#composer-text', '.compose-form textarea.autosuggest-textarea__textarea', '.compose-form textarea'],
    submitSelectors: ['.compose-form__publish-button-wrapper button', '.compose-form__publish button'],
    // The upload button keeps a hidden file input in the compose form.
    optionalMedia: 'image', mediaInputSelectors: ['.compose-form input[type="file"]', 'form input[type="file"][accept*="image"]'],
    mediaPreviewSelectors: ['.compose-form__upload', '.compose-form__upload-thumbnail', '.compose-form__uploads .media-gallery'],
    mediaBusySelectors: ['.compose-form .upload-progress', '.compose-form__upload-progress'],
    successUrlPattern: '/@[^/]+/\\d+(?:[?#].*)?$', publishedBodySelectors: ['.status__content', '.status__content__text'], publishedLinkSelectors: ['a.status__relative-time', 'a[href*="/@"]'],
  }),
  bluesky: recipe('bluesky', {
    readySelectors: ['[data-testid="composerTextInput"]', '[contenteditable="true"][role="textbox"]'],
    bodySelectors: ['[data-testid="composerTextInput"][contenteditable="true"]', '[data-testid="composerTextInput"] [contenteditable="true"]', '.tiptap[contenteditable="true"]', '[contenteditable="true"][role="textbox"]'],
    submitSelectors: ['[data-testid="composerPublishBtn"]'], successUrlPattern: '/profile/[^/]+/post/[a-z0-9]+(?:[?#].*)?$',
    // The web composer opens its picker on demand, so the image is pasted into the editor;
    // Bluesky itself resizes it under the 1 MB limit.
    optionalMedia: 'image', mediaInputSelectors: ['[role="dialog"] input[type="file"]'],
    mediaPreviewSelectors: ['[data-testid="composerImageGallery"] img', '[role="dialog"] img[src^="blob:"]', '[role="dialog"] img[src^="data:image"]', '[role="dialog"] img[src^="file:"]'],
    publishedBodySelectors: ['[data-testid="postText"]'], publishedLinkSelectors: ['a[href*="/post/"]'],
  }),
  tumblr: recipe('tumblr', {
    readySelectors: ['[contenteditable="true"][role="textbox"]', '[contenteditable="true"][data-placeholder]'],
    titleSelectors: ['[contenteditable="true"][data-placeholder="Title"]', 'input[placeholder="Title"]'],
    bodySelectors: ['[contenteditable="true"][data-placeholder="Your text here"]', '[contenteditable="true"][aria-label="Post body"]', '[contenteditable="true"][role="textbox"]'], inputMode: 'pasteHtml',
    submitSelectors: ['button[aria-label="Post"]'], successUrlPattern: '/(?:blog/view/)?[^/]+/\\d+(?:/[^?#]*)?(?:[?#].*)?$',
    // The text editor accepts a pasted image or a file from its photo block.
    optionalMedia: 'image', mediaInputSelectors: ['input[type="file"][accept*="image"]'], mediaOpenerLabels: ['Photo', 'Add photo', 'Add an image', 'Ảnh'],
    mediaPreviewSelectors: ['figure img[src^="blob:"]', '[contenteditable="true"] img', 'img[src^="blob:"]', 'img[src*="media.tumblr.com"]'],
    mediaBusySelectors: ['[aria-label*="Uploading" i]', '[role="progressbar"]'],
    publishedTitleSelectors: ['article h1', 'article h2'], publishedBodySelectors: ['article [data-npf]', 'article .post-content', 'article'], publishedLinkSelectors: ['a[href*="/post/"]', 'a[aria-label*="Permalink"]'],
  }),
  devto: recipe('devto', {
    readySelectors: ['#article-form'], titleSelectors: ['#article-form-title', 'textarea[name="article[title]"]'],
    bodySelectors: ['#article_body_markdown', 'textarea[name="article[body_markdown]"]'], inputMode: 'value',
    submitSelectors: ['button[data-testid="publish-button"]', '#article-form button[type="submit"]'],
    successUrlPattern: '/[^/]+/[^/?#]+-[a-z0-9]+(?:[?#].*)?$', publishedTitleSelectors: ['#main-title', 'h1'], publishedBodySelectors: ['#article-body'],
  }),
  medium: recipe('medium', {
    readySelectors: ['.postArticle-content [contenteditable="true"]', 'article [contenteditable="true"]'],
    titleSelectors: ['h3[data-placeholder="Title"]', 'h1[data-placeholder="Title"]', '[data-testid="editor-title"]'],
    bodySelectors: ['.section-inner[contenteditable="true"]', '[data-testid="editor-content"][contenteditable="true"]'], inputMode: 'pasteHtml',
    submitSelectors: ['button[data-action="publish"]'],
    successUrlPattern: '/(?:@[^/]+|[^/]+)/[^/?#]+-[a-f0-9]{12}(?:[?#].*)?$',
    publishedTitleSelectors: ['article h1'], publishedBodySelectors: ['article .section-inner', 'article'],
  }),
  substack: recipe('substack', {
    readySelectors: ['.tiptap[contenteditable="true"]', '.ProseMirror[contenteditable="true"]'],
    titleSelectors: ['textarea[placeholder="Title"]', 'input[placeholder="Title"]', '[data-placeholder="Title"][contenteditable="true"]'],
    bodySelectors: ['.tiptap[contenteditable="true"]', '.ProseMirror[contenteditable="true"]'], inputMode: 'pasteHtml',
    successUrlPattern: '/p/[^/?#]+(?:[?#].*)?$',
    publishedTitleSelectors: ['h1.post-title', 'article h1'], publishedBodySelectors: ['.available-content .body', '.body.markup', 'article'],
  }),
  quora: recipe('quora', {
    readySelectors: ['[role="dialog"] .doc[contenteditable="true"]', '[role="dialog"] .ql-editor[contenteditable="true"]', '.q-box .ql-editor[contenteditable="true"]'],
    bodySelectors: ['[role="dialog"] .doc[contenteditable="true"]', '[role="dialog"] .ql-editor[contenteditable="true"]', '.q-box .ql-editor[contenteditable="true"]'], inputMode: 'pasteHtml',
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
    inputMode: 'pasteHtml',
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

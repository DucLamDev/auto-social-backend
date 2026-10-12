import { Injectable } from '@nestjs/common';
import type { Locator, Page } from 'playwright';
import type { ConnectorAccount } from '../../core/connector.types';
import {
  BrowserPublishRecipe,
  BrowserRecipeContext,
  BrowserRecipePublishResult,
} from '../browser-automation.types';

interface XenForoSiteProfile {
  readonly key: string;
  readonly origin: string;
  readonly forumPathPattern: RegExp;
  readonly threadPathPattern: RegExp;
}

interface LocatedEditor {
  readonly form: Locator;
  readonly title: Locator;
  readonly body: Locator;
  readonly bodyKind: 'contenteditable' | 'textarea';
}

export const XENFORO_EDITOR_SELECTORS = {
  form: 'form[action$="/post-thread"][method="post"]',
  title: ['input[name="title"]', 'textarea[name="title"]'],
  body: [
    '.fr-wrapper .fr-element[contenteditable="true"]',
    '.js-editor .fr-element[contenteditable="true"]',
    'textarea[name="message"]',
  ],
  prefix: 'select[name="prefix_id"]',
  hiddenPrefix: 'input[name="prefix_id"]',
  prefixMenu: '.menuPrefix[data-prefix-id]',
  submit: 'button[type="submit"].button--icon--write.button--primary',
  publishedTitle: 'h1.p-title-value',
} as const;

const VOZ_PROFILE: XenForoSiteProfile = {
  key: 'voz-xenforo',
  origin: 'https://voz.vn',
  forumPathPattern: /^\/f\/[a-z0-9][a-z0-9-]*\.\d+\/?$/,
  threadPathPattern: /^\/t\/[a-z0-9][a-z0-9-]*\.\d+\/?$/,
};

/**
 * Conservative XenForo 2 thread composer support. Site routes and selectors
 * are compiled into this adapter; account data can only choose a forum path
 * on the fixed site origin and can never inject selectors or JavaScript.
 */
abstract class XenForoBrowserRecipe implements BrowserPublishRecipe {
  readonly allowedHosts: readonly string[];
  readonly finalSubmitPolicy = 'AUTOMATED' as const;
  readonly requiresAutomationPermissionAttestation = true;
  readonly key: string;

  protected constructor(private readonly profile: XenForoSiteProfile) {
    this.key = profile.key;
    this.allowedHosts = [new URL(profile.origin).hostname];
  }

  startUrl(account: ConnectorAccount): string {
    const forumPath = this.forumPath(account);
    return `${this.profile.origin}${forumPath.replace(/\/$/, '')}/post-thread`;
  }

  async isEditorReady(page: Page): Promise<boolean> {
    if (!this.isEditorUrl(page.url())) return false;
    return Boolean(await this.locateEditor(page));
  }

  async prepare(context: BrowserRecipeContext): Promise<void> {
    const editor = await this.locateEditor(context.page);
    if (!editor) throw new Error('The reviewed XenForo editor fields were not found');
    const title = context.post.title?.trim();
    const body = context.post.body.trim();
    if (!title) throw new Error('A thread title is required');
    if (!body) throw new Error('A thread body is required');

    await this.preparePrefix(editor.form, context.account);
    await editor.title.fill(title);
    await editor.body.fill(body);

    const preparedTitle = (await editor.title.inputValue()).trim();
    const preparedBody = editor.bodyKind === 'textarea'
      ? (await editor.body.inputValue()).trim()
      : (await editor.body.innerText()).trim();
    if (preparedTitle !== title || preparedBody !== body) {
      throw new Error('The XenForo editor did not retain the prepared title and body');
    }
  }

  async submit(context: BrowserRecipeContext): Promise<BrowserRecipePublishResult> {
    const editor = await this.locateEditor(context.page);
    if (!editor) throw new Error('The reviewed XenForo editor fields were not found');
    const expectedTitle = context.post.title?.trim();
    if (!expectedTitle) throw new Error('A thread title is required');
    await this.assertPrefixReady(editor.form, context.account);

    const submit = editor.form.locator(XENFORO_EDITOR_SELECTORS.submit);
    if (await submit.count() !== 1 || !await submit.isVisible() || !await submit.isEnabled()) {
      throw new Error('The reviewed XenForo submit control was not uniquely available');
    }

    await Promise.all([
      context.page.waitForURL(
        (url) => this.isPublishedThreadUrl(url),
        { waitUntil: 'domcontentloaded' },
      ),
      submit.click(),
    ]);

    const canonical = this.canonicalThreadUrl(context.page.url());
    const heading = context.page.locator(XENFORO_EDITOR_SELECTORS.publishedTitle);
    if (await heading.count() !== 1 || !await heading.isVisible()) {
      throw new Error('The published XenForo thread heading could not be verified');
    }
    const actualTitle = this.normalize(await heading.innerText());
    if (!actualTitle.includes(this.normalize(expectedTitle))) {
      throw new Error('The published XenForo thread title did not match the prepared title');
    }
    const externalId = this.threadId(canonical);
    if (!externalId) throw new Error('The published XenForo thread id could not be verified');
    return {
      externalId,
      url: canonical,
      metadata: { verifiedBy: 'xenforo-thread-url-and-heading' },
    };
  }

  private async locateEditor(page: Page): Promise<LocatedEditor | undefined> {
    const forms = page.locator(XENFORO_EDITOR_SELECTORS.form);
    if (await forms.count() !== 1) return undefined;
    const form = forms.first();
    if (!await form.isVisible()) return undefined;
    const title = await this.firstUniqueVisible(form, XENFORO_EDITOR_SELECTORS.title);
    const contenteditable = await this.firstUniqueVisible(form, XENFORO_EDITOR_SELECTORS.body.slice(0, 2));
    const textarea = contenteditable
      ? undefined
      : await this.firstUniqueVisible(form, XENFORO_EDITOR_SELECTORS.body.slice(2));
    if (!title || (!contenteditable && !textarea)) return undefined;
    return {
      form,
      title,
      body: contenteditable ?? textarea!,
      bodyKind: contenteditable ? 'contenteditable' : 'textarea',
    };
  }

  private async firstUniqueVisible(scope: Locator, selectors: readonly string[]): Promise<Locator | undefined> {
    for (const selector of selectors) {
      const candidates = scope.locator(selector);
      if (await candidates.count() !== 1) continue;
      const candidate = candidates.first();
      if (await candidate.isVisible()) return candidate;
    }
    return undefined;
  }

  private async preparePrefix(form: Locator, account: ConnectorAccount): Promise<void> {
    const configured = this.setting(account, 'threadPrefixId');
    if (configured && !/^[1-9]\d*$/.test(configured)) {
      throw new Error('threadPrefixId must be a positive numeric ID');
    }
    const select = form.locator(XENFORO_EDITOR_SELECTORS.prefix);
    if (await select.count() === 1 && await select.isVisible()) {
      if (configured) {
        await select.selectOption(configured);
      }
      const value = await select.inputValue();
      if (configured && value !== configured) {
        throw new Error('The configured threadPrefixId was not retained by the XenForo editor');
      }
      if (await this.isExplicitlyRequired(select) && !this.hasSelectedPrefix(value)) {
        throw new Error('This forum requires an explicit threadPrefixId before posting');
      }
      return;
    }

    const hidden = form.locator(XENFORO_EDITOR_SELECTORS.hiddenPrefix);
    if (await hidden.count() === 1) {
      const current = await hidden.inputValue();
      if (configured && current !== configured) {
        throw new Error('This customized prefix picker is not supported safely by the adapter');
      }
      if (await this.isExplicitlyRequired(hidden) && !this.hasSelectedPrefix(current)) {
        throw new Error('This forum requires an explicit threadPrefixId before posting');
      }
      return;
    }

    const menu = form.locator(XENFORO_EDITOR_SELECTORS.prefixMenu);
    if (await menu.count() === 1 && await menu.isVisible()) {
      const current = await menu.getAttribute('data-prefix-id');
      if (configured && current !== configured) {
        throw new Error('This customized prefix picker is not supported safely by the adapter');
      }
      if (await this.isExplicitlyRequired(menu) && !this.hasSelectedPrefix(current)) {
        throw new Error('This forum requires an explicit threadPrefixId before posting');
      }
    }
  }

  private async assertPrefixReady(form: Locator, account: ConnectorAccount): Promise<void> {
    const configured = this.setting(account, 'threadPrefixId');
    for (const selector of [XENFORO_EDITOR_SELECTORS.prefix, XENFORO_EDITOR_SELECTORS.hiddenPrefix]) {
      const prefix = form.locator(selector);
      if (await prefix.count() !== 1) continue;
      const value = await prefix.inputValue();
      if (configured && value !== configured) {
        throw new Error('The configured XenForo thread prefix is no longer selected');
      }
      if (await this.isExplicitlyRequired(prefix) && !this.hasSelectedPrefix(value)) {
        throw new Error('A required XenForo thread prefix is not selected');
      }
    }
    const menu = form.locator(XENFORO_EDITOR_SELECTORS.prefixMenu);
    if (await menu.count() === 1 && await menu.isVisible()) {
      const value = await menu.getAttribute('data-prefix-id');
      if (configured && value !== configured) {
        throw new Error('The configured XenForo thread prefix is no longer selected');
      }
      if (await this.isExplicitlyRequired(menu) && !this.hasSelectedPrefix(value)) {
        throw new Error('A required XenForo thread prefix is not selected');
      }
    }
  }

  private hasSelectedPrefix(value: string | null): boolean {
    return Boolean(value && value !== '0');
  }

  private async isExplicitlyRequired(locator: Locator): Promise<boolean> {
    const required = await locator.getAttribute('required');
    const ariaRequired = await locator.getAttribute('aria-required');
    return required !== null || ariaRequired?.toLowerCase() === 'true';
  }

  private forumPath(account: ConnectorAccount): string {
    const path = this.setting(account, 'forumPath');
    if (!path || !this.profile.forumPathPattern.test(path)) {
      throw new Error(`forumPath is not a supported ${this.key} forum route`);
    }
    return path;
  }

  private setting(account: ConnectorAccount, key: string): string | undefined {
    const value = account.settings[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private isEditorUrl(value: string): boolean {
    try {
      const url = new URL(value);
      const suffix = '/post-thread';
      return url.protocol === 'https:'
        && url.origin === this.profile.origin
        && url.pathname.endsWith(suffix)
        && this.profile.forumPathPattern.test(url.pathname.slice(0, -suffix.length));
    } catch {
      return false;
    }
  }

  private isPublishedThreadUrl(url: URL): boolean {
    return url.protocol === 'https:'
      && url.origin === this.profile.origin
      && this.profile.threadPathPattern.test(url.pathname);
  }

  private canonicalThreadUrl(value: string): string {
    const url = new URL(value);
    if (!this.isPublishedThreadUrl(url)) throw new Error('The browser did not reach a verified thread URL');
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  private threadId(value: string): string | undefined {
    const match = new URL(value).pathname.match(/\.(\d+)\/?$/);
    return match?.[1];
  }

  private normalize(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  }
}

@Injectable()
export class VozXenForoBrowserRecipe extends XenForoBrowserRecipe {
  constructor() {
    super(VOZ_PROFILE);
  }
}

import { load } from 'cheerio';
import type { Locator, Page } from 'playwright';
import type { BrowserRecipeContext } from '../browser-automation.types';
import {
  VozXenForoBrowserRecipe,
  XENFORO_EDITOR_SELECTORS,
} from './xenforo-browser.recipe';

const XENFORO_EDITOR_FIXTURES = [
  `
    <form action="/f/chuyen-tro-linh-tinh.17/post-thread" method="post">
      <textarea name="title"></textarea>
      <div class="fr-wrapper"><div class="fr-element fr-view" contenteditable="true"></div></div>
      <button type="submit" class="button button--icon--write button--primary">Đăng chủ đề</button>
    </form>
  `,
] as const;

describe('reviewed XenForo browser recipes', () => {
  it('keeps the deterministic selectors compatible with the reviewed XenForo 2 fixtures', () => {
    for (const fixture of XENFORO_EDITOR_FIXTURES) {
      const $ = load(fixture);
      const form = $(XENFORO_EDITOR_SELECTORS.form);
      expect(form).toHaveLength(1);
      expect(XENFORO_EDITOR_SELECTORS.title.some((selector) => form.find(selector).length === 1)).toBe(true);
      expect(XENFORO_EDITOR_SELECTORS.body.some((selector) => form.find(selector).length === 1)).toBe(true);
      expect(form.find(XENFORO_EDITOR_SELECTORS.submit)).toHaveLength(1);
    }
  });

  it('builds only fixed-host editor URLs from strict forum paths', () => {
    const voz = new VozXenForoBrowserRecipe();

    expect(voz.startUrl(account({ forumPath: '/f/chuyen-tro-linh-tinh.17' })))
      .toBe('https://voz.vn/f/chuyen-tro-linh-tinh.17/post-thread');
    expect(() => voz.startUrl(account({ forumPath: 'https://evil.example/post-thread' }))).toThrow('forumPath');
    expect(() => voz.startUrl(account({ forumPath: '/../login' }))).toThrow('forumPath');
  });

  it('fills title and body without accepting account-provided selectors or JavaScript', async () => {
    const title = valueLocator('');
    const body = valueLocator('', { contenteditable: true });
    const { page } = editorPage({
      url: 'https://voz.vn/f/chuyen-tro-linh-tinh.17/post-thread',
      title,
      body,
    });
    const recipe = new VozXenForoBrowserRecipe();

    await expect(recipe.prepare(context(page, {
      title: 'Cần tư vấn cấu hình',
      body: 'Mình đã thử cấu hình và có log như sau.',
    }))).resolves.toBeUndefined();

    expect(title.fill).toHaveBeenCalledWith('Cần tư vấn cấu hình');
    expect(body.fill).toHaveBeenCalledWith('Mình đã thử cấu hình và có log như sau.');
  });

  it('selects an explicit numeric prefix and rejects a visibly required prefix that was not configured', async () => {
    const configuredPrefix = valueLocator('');
    const configured = editorPage({
      url: 'https://voz.vn/f/chuyen-tro-linh-tinh.17/post-thread',
      title: valueLocator(''),
      body: valueLocator('', { contenteditable: true }),
      prefix: configuredPrefix,
    });
    const recipe = new VozXenForoBrowserRecipe();
    await expect(recipe.prepare({
      ...context(configured.page, { title: 'Tiêu đề', body: 'Nội dung' }),
      account: account({
        forumPath: '/f/chuyen-tro-linh-tinh.17',
        threadPrefixId: '2',
      }),
    })).resolves.toBeUndefined();
    expect(configuredPrefix.selectOption).toHaveBeenCalledWith('2');

    const missing = editorPage({
      url: 'https://voz.vn/f/chuyen-tro-linh-tinh.17/post-thread',
      title: valueLocator(''),
      body: valueLocator('', { contenteditable: true }),
      prefix: valueLocator('0', { attributes: { required: '' } }),
    });
    await expect(recipe.prepare(context(missing.page, { title: 'Tiêu đề', body: 'Nội dung' })))
      .rejects.toThrow('threadPrefixId');
  });

  it('allows the reviewed XenForo no-prefix value when the editor does not mark it required', async () => {
    const optional = editorPage({
      url: 'https://voz.vn/f/chuyen-tro-linh-tinh.17/post-thread',
      title: valueLocator(''),
      body: valueLocator('', { contenteditable: true }),
      prefix: valueLocator('0'),
    });

    await expect(new VozXenForoBrowserRecipe().prepare(context(optional.page, {
      title: 'Tiêu đề không cần prefix',
      body: 'Nội dung',
    }))).resolves.toBeUndefined();
  });

  it('reports published only after the fixed-host thread URL and heading both verify', async () => {
    const threadUrl = 'https://voz.vn/t/can-tu-van-cau-hinh.76543/';
    let currentUrl = 'https://voz.vn/f/chuyen-tro-linh-tinh.17/post-thread';
    let finishNavigation: (() => void) | undefined;
    const submit = staticLocator({
      click: jest.fn(() => {
        currentUrl = threadUrl;
        finishNavigation?.();
        return Promise.resolve();
      }),
    });
    const heading = staticLocator({ text: 'Cần tư vấn cấu hình' });
    const fixture = editorPage({
      url: currentUrl,
      title: valueLocator('Cần tư vấn cấu hình'),
      body: valueLocator('Chi tiết lỗi', { contenteditable: true }),
      prefix: valueLocator('0'),
      submit,
      heading,
    });
    fixture.url.mockImplementation(() => currentUrl);
    fixture.waitForURL.mockImplementation((predicate: (url: URL) => boolean) => new Promise<void>((resolve, reject) => {
      finishNavigation = () => predicate(new URL(currentUrl))
        ? resolve()
        : reject(new Error('unexpected navigation'));
    }));

    const recipe = new VozXenForoBrowserRecipe();
    await expect(recipe.submit(context(fixture.page, {
      title: 'Cần tư vấn cấu hình',
      body: 'Chi tiết lỗi',
    }))).resolves.toEqual({
      externalId: '76543',
      url: threadUrl,
      metadata: { verifiedBy: 'xenforo-thread-url-and-heading' },
    });
    expect(submit.click).toHaveBeenCalledTimes(1);
  });

  it('does not claim unverified DirectAdmin or customized Tinhte composers are supported', () => {
    expect(new VozXenForoBrowserRecipe().key).toBe('voz-xenforo');
  });
});

interface TestLocator extends Locator {
  fill: jest.Mock;
  selectOption: jest.Mock;
  click: jest.Mock;
}

function valueLocator(initial: string, options: {
  contenteditable?: boolean;
  attributes?: Record<string, string | null>;
} = {}): TestLocator {
  let value = initial;
  const fill = jest.fn((next: string) => {
    value = next;
    return Promise.resolve();
  });
  const selectOption = jest.fn((next: string) => {
    value = next;
    return Promise.resolve([]);
  });
  return staticLocator({
    value: () => value,
    text: () => options.contenteditable ? value : '',
    fill,
    selectOption,
    attributes: options.attributes,
  });
}

function staticLocator(options: {
  value?: string | (() => string);
  text?: string | (() => string);
  count?: number;
  visible?: boolean;
  enabled?: boolean;
  fill?: jest.Mock;
  selectOption?: jest.Mock;
  click?: jest.Mock;
  locate?: (selector: string) => Locator;
  attribute?: string | null;
  attributes?: Record<string, string | null>;
} = {}): TestLocator {
  const value = () => typeof options.value === 'function' ? options.value() : options.value ?? '';
  const text = () => typeof options.text === 'function' ? options.text() : options.text ?? '';
  const locator = {
    count: jest.fn().mockResolvedValue(options.count ?? 1),
    first: jest.fn().mockImplementation(() => locator),
    isVisible: jest.fn().mockResolvedValue(options.visible ?? true),
    isEnabled: jest.fn().mockResolvedValue(options.enabled ?? true),
    fill: options.fill ?? jest.fn().mockResolvedValue(undefined),
    inputValue: jest.fn().mockImplementation(() => Promise.resolve(value())),
    innerText: jest.fn().mockImplementation(() => Promise.resolve(text())),
    selectOption: options.selectOption ?? jest.fn().mockResolvedValue([]),
    click: options.click ?? jest.fn().mockResolvedValue(undefined),
    getAttribute: jest.fn((name: string) => Promise.resolve(
      options.attributes && Object.prototype.hasOwnProperty.call(options.attributes, name)
        ? options.attributes[name]
        : options.attribute ?? null,
    )),
    locator: jest.fn((selector: string) => options.locate?.(selector) ?? absentLocator()),
  };
  return locator as unknown as TestLocator;
}

function absentLocator(): Locator {
  return staticLocator({ count: 0, visible: false });
}

function editorPage(options: {
  url: string;
  title: Locator;
  body: Locator;
  prefix?: Locator;
  submit?: Locator;
  heading?: Locator;
}): {
  page: Page;
  url: jest.Mock;
  waitForURL: jest.Mock;
} {
  const form = staticLocator({
    locate: (selector) => {
      if (selector === XENFORO_EDITOR_SELECTORS.title[0]) return options.title;
      if (selector === XENFORO_EDITOR_SELECTORS.body[0]) return options.body;
      if (selector === XENFORO_EDITOR_SELECTORS.prefix) return options.prefix ?? absentLocator();
      if (selector === XENFORO_EDITOR_SELECTORS.hiddenPrefix) return absentLocator();
      if (selector === XENFORO_EDITOR_SELECTORS.prefixMenu) return absentLocator();
      if (selector === XENFORO_EDITOR_SELECTORS.submit) return options.submit ?? absentLocator();
      return absentLocator();
    },
  });
  const formSet = staticLocator({ locate: () => absentLocator() });
  formSet.first = jest.fn().mockReturnValue(form);
  const url = jest.fn().mockReturnValue(options.url);
  const waitForURL = jest.fn();
  const page = {
    url,
    waitForURL,
    locator: jest.fn((selector: string) => {
      if (selector === XENFORO_EDITOR_SELECTORS.form) return formSet;
      if (selector === XENFORO_EDITOR_SELECTORS.publishedTitle) return options.heading ?? absentLocator();
      return absentLocator();
    }),
  } as unknown as Page;
  return { page, url, waitForURL };
}

function account(settings: Record<string, unknown>) {
  return { id: 'account-1', settings, credentials: {} };
}

function context(page: Page, post: { title: string; body: string }): BrowserRecipeContext {
  return {
    account: account({ forumPath: new URL(page.url()).pathname.replace(/\/post-thread$/, '') }),
    page,
    post: { ...post, idempotencyKey: 'job-1' },
    mediaFiles: [],
  };
}

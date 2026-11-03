import { UiCandidateDto } from './ui-hint.dto';
import { fitsField, redact, sanitizeCandidates, UiCandidate, validateHint } from './ui-hint.rules';
import { mergeApprovedSelectors } from './selector-merge';
import { EXTENSION_RECIPES } from '../../connectors/extension/extension-delivery';

const base = { inDialog: true, inForm: true, disabled: false };
const candidates: UiCandidate[] = [
  { index: 0, kind: 'input', tag: 'input', type: 'text', placeholder: 'Tiêu đề', selector: '#title', ...base },
  { index: 1, kind: 'contenteditable', tag: 'div', label: 'Nội dung bài viết', selector: 'div.editor', ...base },
  { index: 2, kind: 'button', tag: 'button', text: 'Huỷ', selector: 'button.cancel', ...base },
  { index: 3, kind: 'button', tag: 'button', text: 'Đăng bài', selector: 'button.publish', ...base, disabled: true },
  { index: 4, kind: 'link', tag: 'a', text: 'Viết bài mới', selector: 'a.new', ...base },
  { index: 5, kind: 'input', tag: 'input', type: 'search', placeholder: 'Search', selector: '#q', ...base, inDialog: false, inForm: false },
];
const answer = (overrides: Partial<{ title: number | null; body: number | null; submit: number | null; opener: number | null; confidence: number }>) => ({
  title: null, body: null, submit: null, opener: null, confidence: 0.9, reason: 'ok', ...overrides,
});

describe('UI hint rules', () => {
  it('masks emails, long tokens and long digit runs from page text', () => {
    expect(redact('Xin chào an.nguyen@example.com, mã 0987654321 token abcdefghijklmnopqrstuvwxyz0123456789')).toBe('Xin chào [email], mã [số] token […]');
    expect(redact('   ')).toBeUndefined();
  });

  it('requires candidate indexes to match their position and strips control characters', () => {
    const dto = { index: 0, kind: 'button', tag: 'BUTTON', text: 'Post\nnow', inDialog: false, inForm: false, disabled: false, selector: 'button.x' } as UiCandidateDto;
    expect(sanitizeCandidates([dto])[0]).toMatchObject({ tag: 'button', text: 'Post now' });
    expect(() => sanitizeCandidates([{ ...dto, index: 3 }])).toThrow('position');
  });

  it('keeps only requested fields with an element of the right kind', () => {
    const picks = validateHint(answer({ title: 0, body: 1, submit: 3, opener: 4 }), ['title', 'body', 'submit'], candidates, EXTENSION_RECIPES.discourse, 0.6);
    expect(picks.map((pick) => [pick.field, pick.candidate.selector])).toEqual([['title', '#title'], ['body', 'div.editor'], ['submit', 'button.publish']]);
  });

  it('never accepts a cancel button as submit, a link as body, a search box as title, or a reused index', () => {
    expect(validateHint(answer({ submit: 2 }), ['submit'], candidates, EXTENSION_RECIPES.discourse, 0.6)).toEqual([]);
    expect(validateHint(answer({ body: 4 }), ['body'], candidates, EXTENSION_RECIPES.discourse, 0.6)).toEqual([]);
    expect(validateHint(answer({ title: 1, body: 1 }), ['title', 'body'], candidates, EXTENSION_RECIPES.discourse, 0.6).map((pick) => pick.field)).toEqual(['title']);
    expect(fitsField('title', candidates[5]!)).toBe(true);
    expect(validateHint(answer({ body: 99 }), ['body'], candidates, EXTENSION_RECIPES.discourse, 0.6)).toEqual([]);
  });

  it('drops a low-confidence answer and a title for engines without a title field', () => {
    expect(validateHint(answer({ body: 1, confidence: 0.3 }), ['body'], candidates, EXTENSION_RECIPES.discourse, 0.6)).toEqual([]);
    expect(validateHint(answer({ title: 0 }), ['title'], candidates, { titleSelectors: [] }, 0.6)).toEqual([]);
  });
});

describe('mergeApprovedSelectors', () => {
  it('puts approved selectors first without changing the shared recipe', () => {
    const before = JSON.stringify(EXTENSION_RECIPES.discourse);
    const merged = mergeApprovedSelectors(EXTENSION_RECIPES.discourse, [
      { field: 'title', selector: '#new-title' }, { field: 'body', selector: 'div.new' }, { field: 'submit', selector: 'button.go' }, { field: 'opener', selector: 'a.compose' },
    ]);
    expect(merged.titleSelectors[0]).toBe('#new-title');
    expect(merged.bodySelectors[0]).toBe('div.new');
    expect(merged.submitSelectors[0]).toBe('button.go');
    expect(merged.readySelectors.slice(0, 2)).toEqual(['#new-title', 'div.new']);
    expect(merged.openerSelectors).toEqual(['a.compose']);
    expect(JSON.stringify(EXTENSION_RECIPES.discourse)).toBe(before);
  });

  it('adds no title selector to an engine that has none and returns the same recipe when nothing is approved', () => {
    const mastodon = EXTENSION_RECIPES.mastodon;
    expect(mergeApprovedSelectors(mastodon, [{ field: 'title', selector: '#t' }]).titleSelectors).toEqual(mastodon.titleSelectors);
    expect(mergeApprovedSelectors(mastodon, [])).toBe(mastodon);
  });
});

import { validateAuthHint } from './auth-hint.rules';
import type { UiCandidate } from './ui-hint.rules';

const base = { tag: 'a', inDialog: false, inForm: false, disabled: false, selector: 'x' };
const candidates: UiCandidate[] = [
  { ...base, index: 0, kind: 'image', tag: 'img', label: 'VPSTTT Group', region: 'header', selector: 'header img' },
  { ...base, index: 1, kind: 'button', tag: 'button', label: 'Account menu', region: 'header', selector: 'header button' },
  { ...base, index: 2, kind: 'link', text: 'VPSTTT Group', region: 'main', inArticle: true, selector: 'article a' },
  { ...base, index: 3, kind: 'link', text: 'Sign in', region: 'header', selector: 'header a.login' },
  { ...base, index: 4, kind: 'submit', tag: 'button', text: 'Log in', region: 'main', inForm: true, selector: 'form button' },
  { ...base, index: 5, kind: 'link', text: 'Sign up', region: 'header', selector: 'header a.join' },
];
const answer = (fields: Partial<Record<'account' | 'accountMenu' | 'login', number | null>>, signedIn: 'yes' | 'no' | 'unknown' = 'yes', confidence = 0.9) =>
  ({ signedIn, account: null, accountMenu: null, login: null, confidence, reason: 'r', ...fields });

describe('validateAuthHint', () => {
  it('keeps the account and menu of a signed-in page, never a sign-in button on it', () => {
    const { picks } = validateAuthHint(answer({ account: 0, accountMenu: 1, login: 3 }), candidates, 0.6);
    expect(Object.fromEntries(Object.entries(picks).map(([field, candidate]) => [field, candidate.selector]))).toEqual({ account: 'header img', accountMenu: 'header button' });
  });

  it('refuses a post author, a form submit, a sign-up link and low confidence', () => {
    expect(validateAuthHint(answer({ account: 2 }), candidates, 0.6).picks).toEqual({});
    expect(validateAuthHint(answer({ login: 4 }, 'no'), candidates, 0.6).picks).toEqual({});
    expect(validateAuthHint(answer({ login: 5 }, 'no'), candidates, 0.6).picks).toEqual({});
    expect(validateAuthHint(answer({ login: 3 }, 'no'), candidates, 0.6).picks.login?.selector).toBe('header a.login');
    expect(validateAuthHint(answer({ account: 0 }, 'yes', 0.4), candidates, 0.6).picks).toEqual({});
  });
});

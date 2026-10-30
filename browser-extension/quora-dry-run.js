// Operator-only composer check. Does not submit. Leaves existing drafts intact.
import { fillSocialAndSubmit } from './social-actions.js';

export async function checkQuoraComposer(tabId) {
  const [{ result: blank }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const editors = [...document.querySelectorAll('[role="dialog"] .doc[contenteditable="true"]')].filter(n => n.getClientRects().length);
    return location.origin === 'https://www.quora.com' && location.pathname === '/' && editors.length === 1 && !editors[0].innerText.trim();
  } });
  if (!blank) return { skipped: 'Requires one empty personal post composer; existing content was not touched.' };
  const post = { title: 'VPSTTT composer check', body: 'Temporary local editor check. This text is not submitted.' };
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: fillSocialAndSubmit, args: [{
    jobId: 'local-quora-composer-check', targetOrigin: 'https://www.quora.com', openUrl: 'https://www.quora.com/',
    autoSubmit: false, post, options: { tags: [] },
    recipe: { engine: 'quora', bodySelectors: ['[role="dialog"] .doc[contenteditable="true"]'], titleSelectors: [], submitSelectors: ['[role="dialog"] button.puppeteer_test_modal_submit'], loginSelectors: ['input[type="password"]'], captchaSelectors: [] },
  }] });
  const [{ result: editor }] = await chrome.scripting.executeScript({ target: { tabId }, args: [`${post.title}\n\n${post.body}`], func: async expected => {
    const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
    const node = document.querySelector('[role="dialog"] .doc[contenteditable="true"]');
    const button = document.querySelector('[role="dialog"] button.puppeteer_test_modal_submit');
    const bodyMatches = norm(node?.innerText) === norm(expected);
    const submitEnabled = Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    if (bodyMatches) {
      node.focus(); const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand('delete', false);
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    return { bodyMatches, submitEnabled, temporaryTextCleared: !norm(node?.innerText), submitClicked: false };
  } });
  return { status: result.status, message: result.message, ...editor };
}

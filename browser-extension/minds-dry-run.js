import { fillSocialAndSubmit } from './social-actions.js';
export async function checkMindsComposer(tabId) {
  const [{ result: blank }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const nodes = [...document.querySelectorAll('m-composer__textarea textarea')].filter(n => n.getClientRects().length);
    return location.origin === 'https://www.minds.com' && nodes.length === 1 && !nodes[0].value;
  } });
  if (!blank) return { skipped: 'Requires one empty Minds composer; existing content was not touched.' };
  const body = 'Temporary local composer check. This text is not submitted.';
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: fillSocialAndSubmit, args: [{
    targetOrigin: 'https://www.minds.com', openUrl: 'https://www.minds.com/newsfeed/subscriptions', autoSubmit: false,
    post: { title: '', body }, options: {}, recipe: { engine: 'minds', titleSelectors: [], bodySelectors: ['m-composer__textarea textarea'], submitSelectors: [], loginSelectors: [], captchaSelectors: [] },
  }] });
  const [{ result: editor }] = await chrome.scripting.executeScript({ target: { tabId }, args: [body], func: async expected => {
    const node = document.querySelector('m-composer__textarea textarea');
    const bodyMatches = node?.value === expected;
    const candidates = [...document.querySelectorAll('button')].filter(n => n.getClientRects().length && n.innerText.trim() === 'Post');
    const submitEnabled = candidates.length === 1 && !candidates[0].disabled;
    const ancestors = []; for (let parent = node?.parentElement; parent && ancestors.length < 8; parent = parent.parentElement) ancestors.push(parent.tagName.toLowerCase());
    if (bodyMatches) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, '');
      node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return { bodyMatches, submitEnabled, temporaryTextCleared: node?.value === '', submitClicked: false, ancestors };
  } });
  return { ...result, beforeUrls: undefined, ...editor };
}

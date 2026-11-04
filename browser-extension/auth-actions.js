// Executed by value in the isolated world. Secrets exist only in the payload of
// one authenticated step; never return them, put them in a URL, or persist them.
export async function accountAuthStep({ job, action, payload, expectedPageUrl }) {
  const auth = job.auth;
  const google = location.origin === 'https://accounts.google.com';
  if (location.origin !== job.targetOrigin && !(auth.allowedOrigins ?? []).includes(location.origin) && !(auth.provider === 'google' && google)) return { state: 'challenge', message: 'Trang đăng nhập chuyển sang tên miền chưa được cấu hình.' };
  if (expectedPageUrl && location.href !== expectedPageUrl) return { state: 'changed' };
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
  const all = selector => roots.flatMap(root => [...root.querySelectorAll(selector)]);
  const visible = node => node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const enabled = node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const one = selectors => { for (const selector of selectors) { const found = all(selector).filter(visible); if (found.length === 1) return found[0]; } return null; };
  const norm = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
  // Handles are shown as "VPSTTT", "@vpsttt", "vpsttt_group" or "vpsttt.3403320" in
  // profile URLs: compare letters and digits only, without accents or case.
  const loose = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]/g, '');
  const GENERIC_SEGMENTS = new Set(['u', 'user', 'users', 'profile', 'profiles', 'members', 'member', 'in', 'by', 'blog', 'channels', 'me', 'posts', 'summary', 'preferences', 'account', 'activity', 'hc', 'enus', 'about', 'dashboard', 'community', 'forums']);
  const handlesOf = url => {
    try {
      return new URL(url).pathname.split('/').map(part => { try { return decodeURIComponent(part); } catch { return part; } })
        .map(part => part.replace(/^@/, '').replace(/(?:\.\d+|\.html)$/i, '')).map(loose).filter(part => part.length >= 3 && !GENERIC_SEGMENTS.has(part) && !/^\d+$/.test(part));
    } catch { return []; }
  };
  const expectedHandles = () => [...new Set([loose(auth.expectedUsername), ...(auth.profileUrl ? handlesOf(auth.profileUrl) : []),
    ...(auth.loginUsername && !auth.loginUsername.includes('@') ? [loose(auth.loginUsername)] : [])].filter(handle => handle.length >= 3))];
  /** The signed-in identity (text or own-profile link) is the configured account. */
  const sameIdentity = (identity, href) => {
    const expected = expectedHandles();
    if (norm(identity) && norm(identity) === norm(auth.expectedUsername)) return true;
    return [loose(identity), ...(href ? handlesOf(href) : [])].some(found => found.length >= 3 && expected.includes(found));
  };
  const samePage = (a, b) => {
    try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname.replace(/\/$/, '').toLowerCase() === y.pathname.replace(/\/$/, '').toLowerCase(); } catch { return false; }
  };
  const exact = (labels, eligible = () => true) => {
    const matches = all('button, [role="button"], a, input[type="submit"]').filter(enabled).filter(eligible).filter(node => labels.includes(norm(node.innerText || node.value || node.getAttribute('aria-label'))));
    return matches.length === 1 ? matches[0] : null;
  };
  let verifiedGoogleIdentity = false;
  const response = state => ({ state, url: location.href, ...(verifiedGoogleIdentity ? { verifiedGoogleIdentity: true } : {}) });
  const challenge = (message, googleBlocked = false) => ({ state: 'challenge', message, url: location.href, googleBlocked });
  // Cloudflare's full-page check ("Just a moment…") passes by itself; the worker waits for
  // it. A CAPTCHA inside the page (reCAPTCHA, hCaptcha, Turnstile) needs a person.
  if (/^(?:just a moment|un instant|einen moment|chờ một chút)/i.test(document.title.trim()) || all('#challenge-running, #challenge-stage, #challenge-form, #challenge-success-text').length) {
    return { state: 'cloudflare', url: location.href, message: 'Trang đang chạy bước kiểm tra trình duyệt của Cloudflare và chưa tự qua sau 20 giây. Mở tab, hoàn tất kiểm tra rồi chạy lại.' };
  }
  if (all('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .cf-turnstile').some(visible)) return challenge('Cần xử lý CAPTCHA trên trang đăng nhập.', google);
  const text = document.body?.innerText ?? '';
  if (location.hostname === 'www.blogger.com' && /\/onboarding\/?$/.test(location.pathname)) return challenge('Google đã đăng nhập, nhưng Blogger còn ở bước tạo hồ sơ/blog. Cần có blog đích trước khi đăng bài.');
  if (location.hostname === 'huggingface.co' && location.pathname === '/email_confirmation') return challenge('Hugging Face yêu cầu xác minh email trước khi tạo bài. Mở email xác minh và kiểm tra quyền tạo blog của tài khoản.');
  if (/^error$/i.test(document.title.trim()) && !all('input,button,[role="button"]').some(visible)) return challenge('Nền tảng trả về trang Error, không có form đăng nhập. Chưa gửi thông tin đăng nhập.');
  // A suspended or banned account is not a wrong password: stop and say so ("@vpsttt is suspended." on Discuit).
  const notices = all('[role="alert"], .alert, .error, .form-error, [class*="error" i], form').filter(visible).map(node => node.innerText).join(' ');
  // XenForo shows its ban as the page error itself: "You have been banned for the following reason: Spam."
  if (!google && (/@\S+\s+is\s+(?:suspended|banned)|account\s+(?:has\s+been\s+|is\s+)?(?:suspended|banned|disabled|deactivated)|tài\s+khoản\s+(?:của\s+bạn\s+)?(?:đã\s+)?bị\s+(?:khoá|khóa|đình\s+chỉ|cấm)/i.test(notices)
    || /you have been banned for the following reason|bạn đã bị cấm vì lý do sau/i.test(text))) {
    return challenge('Nền tảng báo tài khoản đã bị đình chỉ hoặc khoá (không phải sai mật khẩu). Cần giải quyết với nền tảng hoặc dùng tài khoản khác; đã dừng, không thử đăng nhập lại.');
  }
  // XenForo: signed in, but new threads wait until the emailed confirmation link is opened.
  if (!google && /your account is currently awaiting confirmation|tài khoản của bạn đang chờ xác nhận/i.test(text)) {
    return challenge('Diễn đàn báo tài khoản đang chờ xác nhận email nên chưa đăng bài được. Mở email xác nhận của diễn đàn (hoặc bấm gửi lại trên trang) rồi kiểm tra lại.');
  }
  if (job.recipe.engine === 'discourse') {
    const notice = all('#login-alert, .login-modal .alert-error, .login-page .alert-error, [role="alert"]').filter(visible).map(n => n.innerText).join(' ');
    if (/incorrect username,? email or password|incorrect username or password|password is incorrect|không đúng tài khoản,? email hoặc mật khẩu/i.test(notice)) return challenge('Diễn đàn từ chối email/username hoặc mật khẩu đã lưu. Cần cập nhật thông tin đăng nhập; chưa thử lại.');
    if (/activation email|activate your account|not activated/i.test(notice)) return challenge('Diễn đàn yêu cầu kích hoạt tài khoản bằng email trước khi đăng nhập.');
    if (/hasn.t been approved|not yet approved|not approved/i.test(notice)) return challenge('Tài khoản đang chờ quản trị viên diễn đàn phê duyệt.');
    if (/too many|rate limit|try again.*(?:minute|hour)/i.test(notice)) return challenge('Diễn đàn đang giới hạn lượt đăng nhập. Đã dừng để tránh thử lặp.');
  }
  // Choose an offered authenticator method before handing a phone prompt back
  // to the operator. This does not bypass any challenge or invent a method.
  if (google && auth.autoTotp && !one(['#totpPin', 'input[name="totpPin"]'])) {
    const candidates = all('button, [role="button"], a, [role="link"], li').filter(enabled).filter(node =>
      /(?:get|enter|use).*(?:code|verification).*(?:authenticator|authentication app)|(?:nhận|lấy|nhập|sử dụng).*mã.*(?:authenticator|ứng dụng xác thực)/i.test(node.innerText || node.getAttribute('aria-label') || ''));
    const leaf = candidates.filter(node => !candidates.some(other => other !== node && node.contains(other)));
    if (leaf.length === 1) {
      if (action === 'totpChoice') { leaf[0].click(); return response('submitted'); }
      return response('totpChoice');
    }
    const alternate = exact(['try another way', 'try another method', 'thử cách khác', 'thử một cách khác', 'sử dụng phương thức khác']);
    if (alternate && /check your phone|tap yes|verify it.s you|2.step verification|choose how|xác minh|điện thoại|xác nhận/i.test(text)) {
      if (action === 'alternate') { alternate.click(); return response('submitted'); }
      return response('alternate');
    }
  }
  if (/check your phone|tap yes|check your email|email.*verification link|security key|insert your key|passkey|mã.*(?:sms|tin nhắn)|code.*text message/i.test(text)
    && !one(['input[name="totpPin"]', '#totpPin', 'input[name="second_factor_token"]', 'input[type="password"]', '#identifierId'])) return challenge('Nền tảng yêu cầu email, điện thoại, passkey hoặc xác nhận thiết bị; đây không phải mã TOTP.', google);

  if (!google) {
    let identity;
    let ownEmail;
    if (job.recipe.engine === 'devto' && location.hostname === 'dev.to') {
      try {
        const current = JSON.parse(document.body.getAttribute('data-user') || 'null');
        if (typeof current?.username === 'string') identity = current.username;
      } catch { /* Own account menu remains the fallback. */ }
    }
    if (job.recipe.engine === 'pixelfed') {
      try {
        const r = await fetch('/api/pixelfed/v1/accounts/verify_credentials', { credentials: 'same-origin', signal: AbortSignal.timeout(4000) });
        const own = r.ok ? await r.json() : null;
        if (own?.id && typeof own.username === 'string') identity = own.username;
      } catch { /* The authenticated own-profile menu is the fallback. */ }
    }
    if (job.recipe.engine === 'discourse') {
      try {
        const base = new URL(job.openUrl); base.pathname = base.pathname.replace(/\/(?:new-topic|categories|latest)\/?$/, '').replace(/\/$/, '') + '/session/current.json'; base.search = '';
        const r = await fetch(base, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const user = (await r.json()).current_user;
          identity = user?.username; ownEmail = user?.email;
          if (identity && auth.allowIdentityByEmail && norm(identity) !== norm(auth.expectedUsername) && !ownEmail) {
            const own = new URL(base); own.pathname = base.pathname.replace(/session\/current\.json$/, `u/${encodeURIComponent(identity)}/emails.json`);
            const details = await fetch(own, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(2500) });
            if (details.ok) ownEmail = (await details.json()).email;
          }
        }
      } catch { /* Other identity markers may still be available. */ }
    } else if (job.recipe.engine === 'reddit') {
      try { const r = await fetch('/api/v1/me', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) }); if (r.ok) identity = (await r.json()).name; } catch { /* DOM fallback */ }
    } else if (location.hostname === 'bsky.app') {
      // The Bluesky web app keeps the signed-in account in localStorage
      // (BSKY_STORAGE.session). Read only its handle and email, never its tokens.
      try {
        const stored = JSON.parse(localStorage.getItem('BSKY_STORAGE') || 'null');
        const current = stored?.session?.currentAccount;
        const saved = current ? (stored.session.accounts ?? []).find(account => account?.did === current.did) : null;
        const handle = current?.handle || saved?.handle;
        const email = current?.email || saved?.email;
        if (typeof handle === 'string' && handle) identity = handle;
        if (typeof email === 'string' && email) ownEmail = email;
      } catch { /* DOM fallback */ }
    } else if (location.hostname === 'huggingface.co') {
      // The hub's own session endpoint names the signed-in user (the avatar menu is closed).
      try { const r = await fetch('/api/whoami-v2', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) }); if (r.ok) { const me = await r.json(); if (typeof me?.name === 'string') identity = me.name; } } catch { /* DOM fallback */ }
    }
    if (location.hostname === 'differ.blog') {
      try {
        const r = await fetch('/me', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const own = new DOMParser().parseFromString(await r.text(), 'text/html');
          const canonical = own.querySelector('link[rel="canonical"]')?.getAttribute('href');
          const ownAvatars = [...own.querySelectorAll('a.shrink-0.rounded-full.ring-2[href^="/@"]')];
          const ownHeading = own.querySelector('a.text-base.font-bold.tracking-tight[href^="/@"]');
          const ownPath = ownAvatars.length === 1 && ownHeading?.getAttribute('href') === ownAvatars[0].getAttribute('href') ? ownHeading.getAttribute('href') : null;
          const url = canonical && /^\/@/.test(new URL(canonical, location.origin).pathname) ? new URL(canonical, location.origin) : ownPath ? new URL(ownPath, location.origin) : null;
          if (url?.origin === location.origin && /^\/@[^/]+\/?$/.test(url.pathname)) identity = decodeURIComponent(url.pathname.replace(/^\/@|\/$/g, ''));
        }
      } catch { /* Own account menu remains the fallback. */ }
    }
    const genericSelectors = ['a[data-testid="AppTabBar_Profile_Link"]', '.p-navgroup-link--user .p-navgroup-linkText', '#username_logged_in .username', '.s-topbar a.s-user-card[href*="/users/"]', 'a[aria-label="My profile"]', 'nav a[href*="/@"]', 'header a[href*="/@"]', 'nav a[href*="/profile/"]', '[data-testid="profile-link"]', 'a[data-testid="profile-link"]', '.profile-dropdown a[href*="/users/"]',
      ...(location.hostname === 'differ.blog' ? ['.dropdown:has(> .avatar) .dropdown-content a[href^="/@"]'] : []),
      ...(location.hostname === 'dzone.com' ? ['header button.user-avatar', '.header button.user-avatar', 'button.user-avatar'] : []),
      ...(location.hostname === 'lemmy.world' ? ['nav a[href^="/u/"]', '.navbar a[href^="/u/"]'] : []),
      ...(location.hostname === 'discuit.org' ? ['.navbar-profile .navbar-name'] : []),
      ...(location.hostname === 'www.minds.com' ? ['.m-sidebarNavigation__list a[href]:has(img)'] : [])];
    // Bookmarks and settings also link under /@username on Discuit. They are
    // navigation items, not evidence of the identity currently signed in.
    const selectors = auth.identitySelector ? [auth.identitySelector] : location.hostname === 'discuit.org'
      ? ['.navbar-profile .navbar-name'] : job.recipe.engine === 'mastodon'
        ? ['nav footer a[class*="accountLink"][href^="/@"]', '.navigation-bar .account__display-name', '.navigation-bar__profile', '.compose-panel .account__display-name'] : [...({
      discourse: ['#current-user a[data-user-card]', '#current-user img[title]'],
      xenforo: ['.p-navgroup-link--user .p-navgroup-linkText', '.p-navgroup-link--user'],
      phpbb: ['#username_logged_in .username', '#username_logged_in .username-coloured'],
      medium: ['nav a[href^="/@"]', 'header a[href^="/@"]'],
      quora: ['[role="menu"] a[href*="/profile/"]', '.puppeteer_popper_content a[href*="/profile/"]', '[role="navigation"] a[href*="/profile/"]'],
      reddit: ['[data-testid="user-drawer"] [data-testid="profile-link"]'],
      substack: ['nav a[href*="/@"]', '[data-testid="profile-link"]'],
      tinhte: ['header button.profile-button img[alt]', 'button.profile-button img[alt]', 'header a.username', '.current-user a.username'],
      pixelfed: ['nav .dropdown-menu a[href][title="Profile"]', 'nav a[href^="/@"]', 'a[aria-label="Profile"]'],
      'aws-builder': ['nav a[href*="/profile/"]', 'header a[href*="/profile/"]'],
      slideshare: ['header a[aria-label="My profile"]'],
      mastodon: ['.navigation-bar__profile', '.navigation-panel a[href^="/@"]'],
      bluesky: ['a[data-testid="bottomBarProfileBtn"]', 'nav a[href^="/profile/"]', '[data-testid="homeScreen"] a[aria-label="Profile"]'],
      devto: ['#crayons-header__menu__profile__link', '#crayons-header__menu a[href][data-testid="profile-link"]'],
      tumblr: ['[role="navigation"] a[href^="/blog/"]'],
    }[job.recipe.engine] ?? []), ...genericSelectors];
    let marker;
    let markerHref = '';
    try { marker = one(selectors); } catch { return challenge('CSS nhận diện tài khoản không hợp lệ.'); }
    if (!identity && !marker && job.recipe.engine === 'pixelfed') {
      const profileLinks = all('nav .dropdown-menu a[href]').filter(visible).filter(node => ['profile', 'my profile', 'hồ sơ'].includes(norm(node.innerText)));
      if (profileLinks.length === 1) marker = profileLinks[0];
    }
    if (marker) {
      const href = marker.href || marker.closest('a')?.href;
      markerHref = href || '';
      if (job.recipe.engine === 'mastodon' && href && /^\/@[^/]+\/?$/.test(new URL(href).pathname)) identity = decodeURIComponent(new URL(href).pathname.replace(/^\/@|\/$/g, ''));
      if (auth.profileUrl && href && samePage(href, auth.profileUrl)) return response('authenticated');
      if (marker.matches('.s-topbar a.s-user-card') && href) {
        const current = new URL(href), expected = auth.profileUrl ? new URL(auth.profileUrl) : null;
        const currentId = /^\/users\/(\d+)(?:\/|$)/.exec(current.pathname)?.[1];
        const expectedId = expected && /^\/users\/(\d+)(?:\/|$)/.exec(expected.pathname)?.[1];
        // Stack Exchange display names are not unique; require the saved user ID.
        if (!currentId || !expectedId) return challenge('Cần URL hồ sơ Stack Exchange có ID tài khoản để xác nhận đúng người dùng.');
        return { ...response(current.origin === expected.origin && currentId === expectedId ? 'authenticated' : 'mismatch'),
          detectedUsername: decodeURIComponent(current.pathname.split('/')[3] || currentId) };
      }
      identity ??= marker.getAttribute('data-user-card') || marker.getAttribute('title') || (job.recipe.engine === 'tinhte' ? marker.getAttribute('alt') : '') || marker.innerText;
      if (location.hostname === 'www.minds.com' && marker.matches('.m-sidebarNavigation__list a[href]') && href) identity = new URL(href).pathname.replace(/^\/|\/$/g, '');
      if (location.hostname === 'lemmy.world' && marker.closest('#dropdownUser') && href) identity = decodeURIComponent(new URL(href).pathname.replace(/^\/u\/|\/$/g, ''));
      if (job.recipe.engine === 'devto' && marker.matches('#crayons-header__menu__profile__link') && href) identity = new URL(href).pathname.replace(/^\/|\/$/g, '');
      if (job.recipe.engine === 'quora' && href) {
        const handle = /\/profile\/([^/]+)/.exec(new URL(href).pathname)?.[1];
        if (handle) identity = decodeURIComponent(handle);
      }
      if (job.recipe.engine === 'pixelfed' && href) {
        const ownId = /^\/i\/web\/profile\/(\d+)\/?$/.exec(new URL(href).pathname)?.[1];
        if (ownId) {
          try {
            const r = await fetch(`/api/v1/accounts/${ownId}`, { credentials: 'same-origin', signal: AbortSignal.timeout(3500) });
            const own = r.ok ? await r.json() : null;
            if (String(own?.id) === ownId && typeof own.username === 'string') identity = own.username;
            else return challenge('Đã mở hồ sơ Pixelfed, nhưng chưa đối chiếu được ID với username.');
          } catch { return challenge('Chưa đọc được username của hồ sơ Pixelfed đang đăng nhập.'); }
        }
      }
      if ((!identity?.trim() || /^(my )?profile$|^hồ sơ$/i.test(identity.trim())) && href) {
        const pathname = new URL(href).pathname;
        const match = /\/(?:@|profile\/|u\/|users\/)([^/]+)\/?$/.exec(pathname);
        if (match) identity = decodeURIComponent(match[1]);
        else if (job.recipe.engine === 'pixelfed' && /^\/[A-Za-z0-9_.-]+\/?$/.test(pathname)) identity = pathname.replace(/^\/|\/$/g, '');
        else if (marker.matches('[data-testid="AppTabBar_Profile_Link"]')) identity = pathname.replace(/^\//, '');
      }
    }
    if (identity && !/^(my )?profile$|^hồ sơ$/i.test(identity.trim())) {
      if (auth.allowIdentityByEmail && ((ownEmail && norm(ownEmail) === norm(auth.loginUsername))
        || (auth.provider === 'google' && job.authIdentityVerified))) {
        return { ...response('authenticated'), detectedUsername: identity.trim().slice(0, 200) };
      }
      if (auth.discoverIdentity && auth.provider === 'google' && !job.authIdentityVerified) return challenge('Social đang có phiên đăng nhập nhưng chưa xác nhận phiên đó thuộc Google đã cấu hình. Chưa gán account cũ cho Google mới.');
      if (auth.discoverIdentity && job.kind === 'LOGIN_CHECK') return { ...response('authenticated'), detectedUsername: identity.trim().slice(0, 200) };
      return { ...response(sameIdentity(identity, markerHref) ? 'authenticated' : 'mismatch'), detectedUsername: identity.trim().slice(0, 200) };
    }
    if (location.hostname === 'lemmy.world') {
      const menu = one(['#dropdownUser > button.dropdown-toggle']);
      if (menu && !one(['#dropdownUser a[href^="/u/"]'])) {
        if (action === 'accountMenu') { menu.click(); return response('submitted'); }
        return response('accountMenu');
      }
    }
    if (location.hostname === 'differ.blog') {
      const avatar = one(['.dropdown > .avatar[role="button"]']);
      if (avatar && !visible(avatar.parentElement.querySelector('.dropdown-content'))) {
        if (action === 'accountMenu') {
          avatar.focus();
          if (!visible(avatar.parentElement.querySelector('.dropdown-content'))) avatar.click();
          return response('submitted');
        }
        return response('accountMenu');
      }
    }
    if (job.recipe.engine === 'devto') {
      const menu = one(['header button[aria-label="Navigation menu"]']);
      if (menu && menu.getAttribute('aria-expanded') !== 'true') {
        if (action === 'accountMenu') { menu.click(); return response('submitted'); }
        return response('accountMenu');
      }
    }
    if (job.recipe.engine === 'pixelfed') {
      const menu = one(['nav .nav-item.dropdown .nav-link.dropdown-toggle[role="button"]']);
      if (menu && menu.getAttribute('aria-expanded') !== 'true') {
        if (action === 'accountMenu') { menu.click(); return response('submitted'); }
        return response('accountMenu');
      }
    }
    if (job.recipe.engine === 'quora') {
      const menu = one(['[aria-label="Account menu"]', '[aria-label="Menu du compte"]', '[aria-label="Menu Tài khoản"]', '[aria-label="Menu tài khoản"]',
        '[aria-haspopup="menu"]:has(img[alt*="profile" i])', '[aria-haspopup="menu"]:has(img[alt*="profil" i])', '[aria-haspopup="menu"]:has(img[alt*="hồ sơ" i])']);
      const toggle = menu?.closest('[aria-haspopup="menu"]') || menu;
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
        if (action === 'accountMenu') {
          const control = menu || toggle;
          // A single click avoids the hover-open/click-close race in Quora's
          // delayed popper, including when this login tab is in the background.
          control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
          control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          control.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
          control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          control.click();
          return response('submitted');
        }
        return response('accountMenu');
      }
    }
    // Sites without a known account marker: the signed-in user's own profile
    // link in the site navigation, or owner-only controls on the configured
    // profile page itself, prove which account this browser is using.
    if (auth.profileUrl) {
      const ownLink = all('header a[href], nav a[href], aside a[href], [role="navigation"] a[href], [role="banner"] a[href], [class*="sidebar" i] a[href]')
        .filter(visible).some(node => samePage(node.href, auth.profileUrl));
      const ownerOnly = samePage(location.href, auth.profileUrl) && all('button, [role="button"], a').filter(visible).some(node =>
        /^(?:edit profile|edit your profile|edit appearance|customize|customise|account settings|profile settings|modifier le profil|modifier l.apparence|personnaliser|chỉnh sửa hồ sơ|chỉnh sửa trang cá nhân|sửa hồ sơ)$/i
          .test(norm(node.innerText || node.getAttribute('aria-label') || '')));
      if (ownLink || ownerOnly) return { ...response('authenticated'), ...(auth.expectedUsername ? { detectedUsername: auth.expectedUsername } : {}) };
    }
  } else {
    const displayed = one(['#profileIdentifier', '[data-email]']);
    const email = displayed?.getAttribute('data-email') || displayed?.innerText;
    if (email?.includes('@') && norm(email) !== norm(auth.loginUsername)) return response('mismatch');
    verifiedGoogleIdentity = Boolean(email?.includes('@') && norm(email) === norm(auth.loginUsername));
    const choices = all('[data-identifier]').filter(visible);
    if (choices.length) {
      const matching = choices.filter(node => norm(node.getAttribute('data-identifier')) === norm(auth.loginUsername));
      const option = matching.length === 1 ? matching[0] : exact(['use another account', 'sử dụng một tài khoản khác']);
      if (!option) return challenge('Không tìm thấy tài khoản Google đã cấu hình trong danh sách.');
      verifiedGoogleIdentity = action === 'choose' && matching.length === 1;
      if (action === 'choose') { option.click(); return response('submitted'); }
      return response('chooser');
    }
  }

  const otp = one(['#totpPin', 'input[name="totpPin"]', 'input[name="second_factor_token"]', 'input[autocomplete="one-time-code"]', 'form[action*="two-step"] input[name="code"]']);
  if (/incorrect password|wrong password|username and password do not match|invalid (?:email or password|password|credentials|code)|incorrect code|mật khẩu không đúng|mã không đúng|sai mã|mã không hợp lệ|code incorrect|mot de passe incorrect/i.test(text)) {
    return challenge(otp ? 'Google hoặc nền tảng đã từ chối mã TOTP. Kiểm tra khóa 2FA trong cấu hình; chưa gửi lại mã.' : 'Thông tin đăng nhập bị từ chối; không tự thử lại.', google);
  }
  if (otp) {
    if (!auth.autoTotp) return challenge('Chưa cấu hình TOTP cho tài khoản này.');
    if (!otp.matches('#totpPin, [name="totpPin"], [name="second_factor_token"]') && !/authenticator|authentication app|two.step|two.factor|ứng dụng xác thực|mã xác thực hai/i.test(text)) return challenge('Không xác định được đây là mã TOTP; chưa điền mã.');
    if (action !== 'totp') return response('totp');
    if (!payload?.code || Date.now() >= payload.expiresAt) return challenge('Mã TOTP đã hết hạn trước khi điền.');
  }
  const password = one(['#ctrl_pageLogin_password', 'input[type="password"]']);
  // A signed-in page's search box ("Chercher sur Tumblr") is not a login field.
  const searchBox = node => node.type === 'search' || Boolean(node.closest('[role="search"], form[action*="search" i]'))
    || /^(?:q|query|search|s|keywords?)$/i.test(node.name || '')
    || /search|chercher|recherche|suche|buscar|tìm kiếm/i.test(`${node.placeholder || ''} ${node.getAttribute('aria-label') || ''}`);
  const loginField = selectors => { for (const selector of selectors) { const found = all(selector).filter(visible).filter(node => !searchBox(node)); if (found.length === 1) return found[0]; } return null; };
  const identifier = google ? one(['#identifierId']) : loginField(['#ctrl_pageLogin_login', 'input[data-testid="loginUsernameInput"]', 'input[autocomplete="username"]', 'input[name="login"]', 'input[name="username"]', 'input[name="email"]', 'input[type="email"]', '#login-account-name', 'input[name="text"]', 'form input[type="text"]']);
  // Pages such as Substack ask only for an email (magic link) until "Sign in
  // with password" is clicked. Use it for accounts that sign in with a password.
  if (!google && !otp && !password && identifier && auth.provider !== 'google') {
    const usePassword = exact(['sign in with password', 'log in with password', 'login with password', 'use password', 'use a password', 'use your password', 'continue with password', 'đăng nhập bằng mật khẩu', 'dùng mật khẩu']);
    if (usePassword) { if (action === 'usePassword') { usePassword.click(); return response('submitted'); } return response('usePassword'); }
  }
  let stage = otp ? 'totp' : password ? 'password' : identifier ? 'identifier' : null;
  const siteLoginForm = Boolean(stage) && !google;
  if (stage) {
    if (auth.provider === 'google' && !google) {
      // A Google password must never be filled into the destination site's form.
      stage = null;
    } else {
      if (action !== stage) return response(stage);
      const field = otp || password || identifier;
      const form = field.closest('form');
      const submit = google ? one([stage === 'password' ? '#passwordNext button' : stage === 'identifier' ? '#identifierNext button' : '#totpNext button'])
        : one(['#login-button', 'button#login-submit', 'button[type="submit"][name="login"]'])
          || (form ? [...form.querySelectorAll('button[type="submit"], input[type="submit"]')].filter(visible).length === 1 ? [...form.querySelectorAll('button[type="submit"], input[type="submit"]')].filter(visible)[0] : null : null)
          || exact(stage === 'totp' ? ['verify', 'verify code', 'xác minh', 'confirm', 'continue'] : ['log in', 'login', 'sign in', 'continue', 'next', 'đăng nhập', 'tiếp theo']);
      if (!submit || !enabled(field)) return challenge('Không nhận diện được nút xác nhận đăng nhập duy nhất.');
      const write = (node, value) => { if (!node || typeof value !== 'string') return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
        node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return node.value === value; };
      if (stage === 'password' && identifier && !write(identifier, payload.username)) return challenge('Không điền được tên đăng nhập.');
      if (!write(field, stage === 'totp' ? payload.code : stage === 'password' ? payload.password : payload.username)) return challenge('Không điền được thông tin xác thực.');
      for (let attempt = 0; attempt < 15 && !enabled(submit); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
      if (!enabled(submit)) return challenge('Nút xác nhận đăng nhập chưa được bật sau khi điền thông tin.');
      submit.click(); return response('submitted');
    }
  }
  if (!google && auth.provider === 'google') {
    const open = exact(['google', 'with google', 'continue with google', 'sign in with google', 'log in with google', 'đăng nhập bằng google', 'đăng nhập với google', 'tiếp tục với google', 'connexion avec google', 'continuer avec google', 'se connecter avec google']);
    if (open) { if (action === 'google') { open.click(); return response('submitted'); } return response('google'); }
    // The site shows its own email/password form and no Google button. A Google
    // password is never typed there, so say so instead of waiting for the deadline.
    if (siteLoginForm) return { ...response('noGoogle'), message: 'Trang đăng nhập của nền tảng chỉ có form email / mật khẩu riêng, không có nút đăng nhập bằng Google. Tài khoản này dùng Google nên tiện ích không điền mật khẩu Google vào form của nền tảng. Đăng nhập tay một lần trong Chrome rồi bấm Kiểm tra, hoặc đổi dòng này sang phương thức Email kèm mật khẩu riêng của nền tảng.' };
  }
  if (!google) {
    if (location.hostname === 'social.vivaldi.net' && location.pathname === '/auth/sign_in') {
      const sso = all('a[href]').filter(enabled).filter(node => norm(node.innerText) === 'vivaldi.net');
      if (sso.length === 1) {
        if (action === 'sso') { sso[0].click(); return response('submitted'); }
        return response('sso');
      }
    }
    const openLogin = exact(['log in', 'login', 'sign in', 'đăng nhập'], node => {
      if (node.tagName !== 'A') return true;
      // An <a> without href (common in SPAs) must not abort the whole step.
      let path;
      try { path = new URL(node.href, location.href).pathname; } catch { return false; }
      if (/\/(?:questions|tags|tagged|topics|posts|t)\//.test(path)) return false;
      return Boolean(node.closest('header, nav, [role="navigation"], form, [role="dialog"], .s-topbar'))
        || /\/(?:login|log-in|sign-in|signin|sign_in)(?:\/|$)/i.test(path);
    });
    if (openLogin) { if (action === 'openLogin') { openLogin.click(); return response('submitted'); } return response('openLogin'); }
  }
  if (/incorrect password|wrong password|invalid code|incorrect code|mật khẩu không đúng|mã không đúng/i.test(text)) return challenge('Thông tin đăng nhập hoặc mã TOTP bị từ chối; không tự thử lại.');
  return response('unknown');
}

/**
 * solidlogin.js — Solid-OIDC login widget for solidweb.app
 *
 * Flow
 * ────
 * Click #btn-login → showModal() → user picks a provider
 *   solidweb.app button → doSolidLogin() → OIDC redirect
 *   other providers     → plain <a href> link to that provider's site
 * Page reloads with ?code= → handleRedirect() exchanges code → webId known
 *   → store webId in localStorage → navigate to https://<username>.solidweb.app/
 * Next visit (no ?code=) → if localStorage has webId → show #loggedIn banner
 *   → clear localStorage entry (one-shot display, mirrors SolidLogic pattern)
 *
 * Why redirectUrl cannot be https://<username>.solidweb.app
 * ──────────────────────────────────────────────────────────
 * The OIDC redirect_uri must be known before login; the username only exists
 * inside the ID token after the code exchange. The pod subdomain is a different
 * origin and would be rejected by the IDP as an unregistered redirect_uri.
 * We use solidweb.app/ as redirect_uri, read webId from the token, then
 * navigate the browser to the pod home.
 *
 * Credits:
 *   Based on xlogin.js by Melvin Carvalho <https://github.com/melvincarvalho/xlogin>
 *   Licensed AGPL-3.0-or-later — this file is a modified version under the same licence.
 *
 * Modified: 2026-05-21
 *
 * Security:
 *   • IDP URLs validated: HTTPS-only, hostname ≥ 3 chars. Applied twice
 *     (input validation + doSolidLogin entry point) for defence-in-depth.
 *   • redirectUrl = window.location.origin + '/' — never user-supplied.
 *   • Pod-home URL built from URL.origin of the server-issued webId — not
 *     from user-typed text.
 *   • localStorage webId validated as a URL before use; link href and text
 *     set via DOM API — no innerHTML on untrusted strings.
 *   • Error messages never echo user input or expose stack traces.
 *   • No eval(), no innerHTML on untrusted data anywhere.
 *   • OIDC params (code, state, iss) scrubbed from address bar after exchange.
 *   • One-shot load guard prevents double-execution.
 *   • Escape key and backdrop-click close the modal.
 *   • ARIA roles on modal for screen-reader accessibility.
 *
 * @license AGPL-3.0-or-later
 */
(function () {
  'use strict';

  /* ── one-shot guard ── */
  if (window.__solidloginLoaded) return;
  window.__solidloginLoaded = true;

  /* ── localStorage key — namespaced to avoid collisions ── */
  var LS_KEY = 'solidlogin:webId';

  /*
   * Provider list.
   * solidweb.app — renders as an OIDC login button (triggers doSolidLogin).
   * All others   — render as plain <a href> links to that provider's site.
   */
  var PROVIDERS = [
    { name: 'solidweb.app  (this server)', url: 'https://solidweb.app',      oidc: true  },
    { name: 'solidcommunity.net',          url: 'https://solidcommunity.net', oidc: false },
    { name: 'solidweb.me',                 url: 'https://solidweb.me',        oidc: false },
    { name: 'solidweb.org',                url: 'https://solidweb.org',        oidc: false },
    { name: 'solid.social',                url: 'https://solid.social',        oidc: false },
    { name: 'solid.live',                  url: 'https://solid.live',          oidc: false }
  ];

  /* The OIDC redirect_uri — always this page; never user-supplied. */
  var REDIRECT_URL = window.location.origin + '/';

  /* ── solid-oidc: prefer canonical JSS upstream; fall back to npm ── */
  var _SolidSession = null;
  var _solidReady = import('https://esm.sh/gh/JavaScriptSolidServer/solid-oidc/solid-oidc.js')
    .then(function (mod) { _SolidSession = mod.Session || mod.default; })
    .catch(function () {
      return import('https://esm.sh/solid-oidc@0.0.9')
        .then(function (mod) { _SolidSession = mod.Session || mod.default; });
    });

  /* ── mutable state ── */
  var _session  = null;   /* active Session object */
  var _webId    = null;   /* authenticated WebID URI */
  var _loginBtn = null;   /* #btn-login element */

  /* ── modal DOM refs (built once) ── */
  var _overlay  = null;
  var _errorEl  = null;
  var _idpInput = null;

  /* ── IDP URL validation: HTTPS only, hostname ≥ 3 chars ── */
  function isValidIdpUrl(url) {
    try {
      var u = new URL(url);
      return u.protocol === 'https:' && u.hostname.length >= 3;
    } catch (_) { return false; }
  }

  /*
   * Short display name from WebID for the button label.
   * Priority: subdomain username → first meaningful path segment → hostname.
   */
  function usernameFromWebId(uri) {
    try {
      var u     = new URL(uri);
      var parts = u.hostname.split('.');
      /* case 1: alice.solidweb.app → "alice" */
      if (parts.length > 2 && parts[0] !== 'www' && parts[0].length > 0) {
        return parts[0];
      }
      /* case 2: solidcommunity.net/profile/alice → "alice" */
      var skip = { profile: true, card: true, people: true, users: true };
      var segs = u.pathname.split('/').filter(function (s) { return s.length > 0; });
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i].replace(/#.*$/, '');
        if (!skip[seg]) return seg;
      }
      /* case 3: full hostname */
      return u.hostname;
    } catch (_) {
      return uri.length > 20 ? uri.slice(0, 10) + '\u2026' : uri;
    }
  }

  /* ── pod home from server-issued webId ── */
  function podHomeFromWebId(webId) {
    try { return new URL(webId).origin + '/'; } catch (_) { return null; }
  }

  /* ── error display — textContent only ── */
  function setError(msg) {
    if (_errorEl) _errorEl.textContent = msg || '';
  }

  /* ── modal CSS, namespaced sl- prefix ── */
  var MODAL_CSS =
    '#sl-overlay{display:none;position:fixed;inset:0;z-index:1000000;' +
    'background:rgba(0,0,0,.55);align-items:center;justify-content:center}' +
    '#sl-overlay.active{display:flex}' +
    '#sl-modal{background:#1a1a2e;color:#e0e0e0;border-radius:12px;padding:24px;' +
    'width:380px;max-width:92vw;font:14px/1.5 system-ui,sans-serif;' +
    'box-shadow:0 8px 32px rgba(0,0,0,.45)}' +
    '#sl-modal h2{margin:0 0 4px;font-size:18px;color:#fff}' +
    '#sl-modal .sl-sub{margin:0 0 16px;font-size:12px;color:#888}' +
    /* OIDC provider button (solidweb.app only) */
    '.sl-provider{width:100%;box-sizing:border-box;padding:10px 16px;' +
    'border:1px solid #7C4DFF;border-radius:8px;background:transparent;' +
    'color:#b39ddb;font-size:14px;cursor:pointer;text-align:left;' +
    'margin-bottom:8px;transition:background .2s}' +
    '.sl-provider:hover,.sl-provider:focus{background:rgba(124,77,255,.12);outline:none}' +
    /* external provider link (all others) */
    '.sl-provider-link{display:block;width:100%;box-sizing:border-box;padding:10px 16px;' +
    'border:1px solid #444;border-radius:8px;color:#9e9e9e;font-size:14px;' +
    'text-decoration:none;text-align:left;margin-bottom:8px;transition:background .2s}' +
    '.sl-provider-link:hover,.sl-provider-link:focus{background:rgba(255,255,255,.05);' +
    'color:#ccc;outline:none}' +
    '.sl-sep{text-align:center;color:#666;font-size:12px;margin:12px 0}' +
    '#sl-idp-input{width:100%;box-sizing:border-box;padding:10px 12px;' +
    'border:1px solid #333;border-radius:8px;background:#0d0d1a;color:#e0e0e0;' +
    'font:13px system-ui,sans-serif;margin-bottom:8px}' +
    '#sl-idp-input:focus{outline:none;border-color:#7C4DFF}' +
    '#sl-error{color:#ef4444;font-size:12px;margin-bottom:8px;min-height:16px}' +
    '.sl-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}' +
    '.sl-actions button{padding:8px 16px;border-radius:8px;border:none;' +
    'cursor:pointer;font-size:14px}' +
    '#sl-cancel{background:#333;color:#aaa}' +
    '#sl-cancel:hover{background:#444}' +
    '#sl-submit{background:#7C4DFF;color:#fff}' +
    '#sl-submit:hover{background:#6a35ff}' +
    '.sl-signup{text-align:center;font-size:12px;color:#666;margin-top:14px}' +
    '.sl-signup a{color:#7C4DFF;text-decoration:none}' +
    '.sl-signup a:hover{text-decoration:underline}';

  /* ── build modal DOM — all text via textContent, no innerHTML on untrusted data ── */
  function buildModal() {
    if (!document.getElementById('solidlogin-css')) {
      var style = document.createElement('style');
      style.id  = 'solidlogin-css';
      style.textContent = MODAL_CSS;
      document.head.appendChild(style);
    }

    var overlay = document.createElement('div');
    overlay.id  = 'sl-overlay';
    overlay.setAttribute('role',       'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Sign in with Solid');

    var modal = document.createElement('div');
    modal.id  = 'sl-modal';

    var h2 = document.createElement('h2');
    h2.textContent = 'Sign in with Solid';
    modal.appendChild(h2);

    var sub = document.createElement('p');
    sub.className   = 'sl-sub';
    sub.textContent = 'Choose your pod provider or enter its URL.';
    modal.appendChild(sub);

    /*
     * Provider rows:
     * oidc:true  → <button class="sl-provider"> triggers doSolidLogin()
     * oidc:false → <a class="sl-provider-link"> navigates to provider site
     * URLs are pre-validated constants — no user data involved.
     */
    PROVIDERS.forEach(function (p) {
      if (p.oidc) {
        var btn = document.createElement('button');
        btn.className   = 'sl-provider';
        btn.type        = 'button';
        btn.textContent = p.name;
        btn.addEventListener('click', function () { doSolidLogin(p.url); });
        modal.appendChild(btn);
      } else {
        var a = document.createElement('a');
        a.className   = 'sl-provider-link';
        a.href        = p.url;         /* pre-validated HTTPS constant */
        a.textContent = p.name;
        a.rel         = 'noopener noreferrer';
        modal.appendChild(a);
      }
    });

    var sep = document.createElement('div');
    sep.className   = 'sl-sep';
    sep.textContent = 'or enter your identity provider URL';
    modal.appendChild(sep);

    /* custom URL input — type="url" for browser hint */
    var input = document.createElement('input');
    input.type         = 'url';
    input.id           = 'sl-idp-input';
    input.placeholder  = 'https://your-pod-provider.example';
    input.spellcheck   = false;
    input.autocomplete = 'off';
    input.value        = 'https://solidweb.app';
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitCustom();
    });
    modal.appendChild(input);
    _idpInput = input;

    /* error region — aria-live for screen readers */
    var errorEl = document.createElement('div');
    errorEl.id  = 'sl-error';
    errorEl.setAttribute('role',      'alert');
    errorEl.setAttribute('aria-live', 'polite');
    modal.appendChild(errorEl);
    _errorEl = errorEl;

    /* action row */
    var actions = document.createElement('div');
    actions.className = 'sl-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.id          = 'sl-cancel';
    cancelBtn.type        = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', hideModal);
    actions.appendChild(cancelBtn);

    var submitBtn = document.createElement('button');
    submitBtn.id          = 'sl-submit';
    submitBtn.type        = 'button';
    submitBtn.textContent = 'Login';
    submitBtn.addEventListener('click', submitCustom);
    actions.appendChild(submitBtn);

    modal.appendChild(actions);

    /* signup hint — literal path, not user data */
    var signup = document.createElement('div');
    signup.className = 'sl-signup';
    signup.appendChild(document.createTextNode('No pod yet? '));
    var signupLink = document.createElement('a');
    signupLink.href        = '/idp/register';
    signupLink.textContent = 'Sign up here';
    signup.appendChild(signupLink);
    modal.appendChild(signup);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    /* close on backdrop click or Escape */
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) hideModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('active')) hideModal();
    });

    return overlay;
  }

  function getOverlay() {
    if (!_overlay) _overlay = buildModal();
    return _overlay;
  }

  function showModal() {
    getOverlay().classList.add('active');
    if (_idpInput) _idpInput.focus();
  }

  function hideModal() {
    getOverlay().classList.remove('active');
    setError('');
  }

  /* ── validate and submit custom URL field ── */
  function submitCustom() {
    var raw = _idpInput ? _idpInput.value.trim() : '';
    if (raw && !/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    if (!raw) { setError('Please enter an identity provider URL.'); return; }
    if (!isValidIdpUrl(raw)) { setError('Only HTTPS provider URLs are accepted.'); return; }
    doSolidLogin(raw);
  }

  /* ── Solid OIDC login — redirect_uri always this page's origin root ── */
  async function doSolidLogin(idp) {
    if (!isValidIdpUrl(idp)) { setError('Invalid identity provider URL.'); return; }
    setError('');
    try {
      await _solidReady;
      _session = new _SolidSession();
      _session.addEventListener('sessionStateChange', function (e) {
        if (e.detail && e.detail.isActive) onSessionActive(e.detail.webId);
      });
      hideModal();
      await _session.login(idp, REDIRECT_URL);
    } catch (err) {
      console.error('[solidlogin] login error:', err);
      setError('Login failed — please check the provider URL and try again.');
      showModal();
    }
  }

  /*
   * onSessionActive — session is live.
   * Updates button label (username only), stores webId, navigates to pod home
   * (only after fresh OIDC redirect, not on restore).
   */
  function onSessionActive(webId) {
    _webId = webId;

    window.solid         = window.solid || {};
    window.solid.session = _session;
    window.solid.webId   = webId;

    /* button label = username only; full webId on hover */
    if (_loginBtn) {
      _loginBtn.textContent = usernameFromWebId(webId);
      _loginBtn.title       = webId;
    }

    /* persist for #loggedIn banner on next visit */
    try { localStorage.setItem(LS_KEY, webId); } catch (_) {}

    document.dispatchEvent(new CustomEvent('solidlogin', { detail: { webId: webId } }));

    /* navigate to pod home only after fresh OIDC redirect */
    if (window.__solidloginFromRedirect) {
      var home = podHomeFromWebId(webId);
      if (home && home !== window.location.href) {
        window.location.href = home;
      }
    }
  }

  /*
   * showLoggedInBanner — one-shot.
   * If localStorage has a webId (set after last OIDC exchange), shows #loggedIn
   * with a clickable link, then clears the entry.
   * All DOM writes via textContent/href — no innerHTML on stored data.
   */
  function showLoggedInBanner() {
    var el = document.getElementById('loggedIn');
    if (!el) return;

    var stored;
    try { stored = localStorage.getItem(LS_KEY); } catch (_) { return; }
    if (!stored) return;

    /* validate before touching DOM */
    if (!isValidIdpUrl(stored)) {
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      return;
    }

    /* one-shot: clear immediately */
    try { localStorage.removeItem(LS_KEY); } catch (_) {}

    el.textContent = '';

    var p1 = document.createElement('p');
    p1.appendChild(document.createTextNode('Your WebID is: '));
    var link = document.createElement('a');
    link.href        = stored;   /* validated HTTPS URL */
    link.textContent = stored;
    p1.appendChild(link);
    p1.appendChild(document.createTextNode('.'));
    el.appendChild(p1);

    var p2 = document.createElement('p');
    p2.textContent = 'Visit your profile to log into your Pod.';
    el.appendChild(p2);

    el.style.display = 'block';
  }

  /* ── handle OIDC redirect-back (?code= in URL) ── */
  async function handleRedirect() {
    if (!new URLSearchParams(window.location.search).get('code')) return false;
    window.__solidloginFromRedirect = true;
    try {
      await _solidReady;
      _session = new _SolidSession();
      _session.addEventListener('sessionStateChange', function (e) {
        if (e.detail && e.detail.isActive) onSessionActive(e.detail.webId);
      });
      await _session.handleRedirectFromLogin();
      /* scrub OIDC params from address bar */
      var clean = new URL(window.location.href);
      ['code', 'state', 'iss'].forEach(function (k) { clean.searchParams.delete(k); });
      history.replaceState(null, '', clean.href);
      return true;
    } catch (err) {
      console.error('[solidlogin] redirect handling error:', err);
      window.__solidloginFromRedirect = false;
      return false;
    }
  }

  /* ── restore saved session from IndexedDB (no pod-home navigation) ── */
  async function tryRestore() {
    try {
      await _solidReady;
      _session = new _SolidSession();
      _session.addEventListener('sessionStateChange', function (e) {
        if (e.detail && e.detail.isActive) onSessionActive(e.detail.webId);
      });
      await _session.restore();
    } catch (_) {}
  }

  /* ── logout: clear everything, reset button ── */
  function doLogout() {
    if (_session) { try { _session.logout(); } catch (_) {} }
    _session = null;
    _webId   = null;
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    window.solid         = window.solid || {};
    window.solid.session = null;
    window.solid.webId   = null;
    if (_loginBtn) { _loginBtn.textContent = 'Log in'; _loginBtn.title = ''; }
    var el = document.getElementById('loggedIn');
    if (el) el.style.display = 'none';
    document.dispatchEvent(new CustomEvent('solidlogout'));
  }

  /*
   * wireButtons — #btn-login
   * logged out → showModal() (user picks provider from list)
   * logged in  → doLogout()
   */
  function wireButtons() {
    var btn = document.getElementById('btn-login');
    if (!btn) return;
    _loginBtn = btn;
    btn.addEventListener('click', function () {
      if (_webId) doLogout();
      else showModal();
    });
  }

  /* ── public API ── */
  window.solidlogin = {
    login:   showModal,
    logout:  doLogout,
    get webId()   { return _webId; },
    get session() { return _session; }
  };

  /* ── bootstrap ── */
  async function init() {
    wireButtons();
    getOverlay();   /* pre-build modal + inject CSS synchronously */
    var wasRedirect = await handleRedirect();
    if (!wasRedirect) {
      showLoggedInBanner();
      await tryRestore();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

/**
 * solidlogin.js — Solid-OIDC login widget for solidweb.app
 *
 * Hooks the existing #btn-login button in the page header.
 * Opens a provider-picker dialog; authenticates via Solid-OIDC (PKCE + DPoP).
 * No Nostr, no floating button, no Shadow DOM.
 *
 * Credits:
 *   Based on xlogin.js by Melvin Carvalho <https://github.com/melvincarvalho/xlogin>
 *   Licensed AGPL-3.0-or-later — this file is a modified version under the same licence.
 *
 * Modified: 2026-05-18
 *
 * Security hardening:
 *   • IDP URLs validated: HTTPS-only, real hostname, no data:/javascript: schemes.
 *   • redirectUrl always derived from window.location.origin — never from user input.
 *   • Error messages never expose internal stack traces or user-supplied strings.
 *   • No eval(), no innerHTML on untrusted data; user input is set via textContent only.
 *   • One-shot load guard prevents double-execution.
 *   • Escape key and outside-click close the modal.
 *   • ARIA roles on modal for screen-reader accessibility.
 *   • OIDC ?code/?state/?iss params scrubbed from the URL bar after exchange.
 *
 * Redirect flow:
 *   session.login(idp, redirectUrl)
 *     → IDP OIDC authorisation + user consent
 *     → redirect back to redirectUrl?code=…
 *     → handleRedirectFromLogin() exchanges code, stores tokens in IndexedDB
 *     → JSS sends authenticated user to https://<username>.solidweb.app
 *
 * NOTE on /idp/interaction/:
 *   That path is keyed by a server-side UID — it cannot be used as a stable
 *   redirectUrl. The redirect target must be a page that calls
 *   handleRedirectFromLogin(). We use window.location.origin + '/' here.
 *
 * @license AGPL-3.0-or-later
 */
(function () {
  'use strict';

  /* ── one-shot guard ── */
  if (window.__solidloginLoaded) return;
  window.__solidloginLoaded = true;

  /* ── pre-validated provider list (all HTTPS, no user-supplied data) ── */
  var PROVIDERS = [
    { name: 'solidweb.app  (this server)', url: 'https://solidweb.app' },
    { name: 'solidcommunity.net',          url: 'https://solidcommunity.net' },
    { name: 'solidweb.me',                 url: 'https://solidweb.me' },
    { name: 'solidweb.org',                url: 'https://solidweb.org' },
    { name: 'solid.social',                url: 'https://solid.social' },
    { name: 'solid.live',                  url: 'https://solid.live' }
  ];

  /*
   * Redirect callback URL after OIDC consent.
   * Must be a page that runs handleRedirectFromLogin() — i.e. this page itself.
   * Derived from origin only; never from user input.
   */
  var REDIRECT_URL = window.location.origin + '/';

  /* ── import solid-oidc; fall back to npm package if GitHub CDN is slow ── */
  var _SolidSession = null;
  var _solidReady = import('https://esm.sh/gh/JavaScriptSolidServer/solid-oidc/solid-oidc.js')
    .then(function (mod) { _SolidSession = mod.Session || mod.default; })
    .catch(function () {
      return import('https://esm.sh/solid-oidc@0.0.8')
        .then(function (mod) { _SolidSession = mod.Session || mod.default; });
    });

  /* ── mutable state ── */
  var _session  = null;   // active Session object
  var _webId    = null;   // authenticated WebID URI
  var _loginBtn = null;   // #btn-login element

  /* ── DOM refs built once in buildModal() ── */
  var _overlay  = null;
  var _errorEl  = null;
  var _idpInput = null;

  /* ────────────────────────────────────────────────────────────────────────
   * Security: IDP URL validation
   * Accept only https:// with a hostname of ≥ 3 chars.
   * Rejects data:, javascript:, file:, http:.
   * ────────────────────────────────────────────────────────────────────── */
  function isValidIdpUrl(url) {
    try {
      var u = new URL(url);
      return u.protocol === 'https:' && u.hostname.length >= 3;
    } catch (_) { return false; }
  }

  /* ── shorten WebID for button label; never exposes path beyond hostname ── */
  function shortWebId(uri) {
    try {
      var u    = new URL(uri);
      var path = u.pathname;
      if (path === '/' || /^\/profile\/card(#.*)?$/.test(path)) return u.hostname;
      if (path.length > 20) return u.hostname + path.slice(0, 17) + '\u2026';
      return u.hostname + path;
    } catch (_) {
      return uri.length > 24 ? uri.slice(0, 10) + '\u2026' + uri.slice(-10) : uri;
    }
  }

  /* ── error display — textContent only, never innerHTML ── */
  function setError(msg) {
    if (_errorEl) _errorEl.textContent = msg || '';
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Modal CSS — injected once into <head>.
   * Uses a namespaced id prefix (sl-) to avoid collisions.
   * ───────────────────────────────────────────────────────────────────────── */
  var MODAL_CSS =
    '#sl-overlay{display:none;position:fixed;inset:0;z-index:1000000;' +
    'background:rgba(0,0,0,.55);align-items:center;justify-content:center}' +
    '#sl-overlay.active{display:flex}' +
    '#sl-modal{background:#1a1a2e;color:#e0e0e0;border-radius:12px;padding:24px;' +
    'width:380px;max-width:92vw;font:14px/1.5 system-ui,sans-serif;' +
    'box-shadow:0 8px 32px rgba(0,0,0,.45)}' +
    '#sl-modal h2{margin:0 0 4px;font-size:18px;color:#fff}' +
    '#sl-modal .sl-sub{margin:0 0 16px;font-size:12px;color:#888}' +
    '.sl-provider{width:100%;box-sizing:border-box;padding:10px 16px;' +
    'border:1px solid #7C4DFF;border-radius:8px;background:transparent;' +
    'color:#b39ddb;font-size:14px;cursor:pointer;text-align:left;' +
    'margin-bottom:8px;transition:background .2s}' +
    '.sl-provider:hover,.sl-provider:focus{background:rgba(124,77,255,.12);outline:none}' +
    '.sl-sep{text-align:center;color:#666;font-size:12px;margin:12px 0}' +
    '#sl-idp-input{width:100%;box-sizing:border-box;padding:10px 12px;' +
    'border:1px solid #333;border-radius:8px;background:#0d0d1a;color:#e0e0e0;' +
    'font:13px system-ui,sans-serif;margin-bottom:8px}' +
    '#sl-idp-input:focus{outline:none;border-color:#7C4DFF}' +
    '#sl-error{color:#ef4444;font-size:12px;margin-bottom:8px;min-height:16px}' +
    '.sl-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}' +
    '.sl-actions button{padding:8px 16px;border-radius:8px;border:none;cursor:pointer;font-size:14px}' +
    '#sl-cancel{background:#333;color:#aaa}' +
    '#sl-cancel:hover{background:#444}' +
    '#sl-submit{background:#7C4DFF;color:#fff}' +
    '#sl-submit:hover{background:#6a35ff}' +
    '.sl-signup{text-align:center;font-size:12px;color:#666;margin-top:14px}' +
    '.sl-signup a{color:#7C4DFF;text-decoration:none}' +
    '.sl-signup a:hover{text-decoration:underline}';

  /* ── build modal DOM — all text via textContent, no innerHTML on user data ── */
  function buildModal() {
    /* inject CSS once */
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

    /* heading */
    var h2 = document.createElement('h2');
    h2.textContent = 'Sign in with Solid';
    modal.appendChild(h2);

    var sub = document.createElement('p');
    sub.className   = 'sl-sub';
    sub.textContent = 'Choose your pod provider or enter its URL.';
    modal.appendChild(sub);

    /* provider buttons — text via textContent (safe); URL pre-validated */
    PROVIDERS.forEach(function (p) {
      var btn = document.createElement('button');
      btn.className   = 'sl-provider';
      btn.textContent = p.name;           /* textContent — no XSS risk */
      btn.type        = 'button';
      btn.addEventListener('click', function () { doSolidLogin(p.url); });
      modal.appendChild(btn);
    });

    /* divider */
    var sep = document.createElement('div');
    sep.className   = 'sl-sep';
    sep.textContent = 'or enter your identity provider URL';
    modal.appendChild(sep);

    /* custom URL input — type="url" hints browser validation */
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

    /* error region — aria-live so screen readers announce it */
    var errorEl = document.createElement('div');
    errorEl.id  = 'sl-error';
    errorEl.setAttribute('role',      'alert');
    errorEl.setAttribute('aria-live', 'polite');
    modal.appendChild(errorEl);
    _errorEl = errorEl;

    /* action buttons */
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

    /* signup hint */
    var signup = document.createElement('div');
    signup.className = 'sl-signup';
    var signupText = document.createTextNode('No pod yet? ');
    signup.appendChild(signupText);
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
    if (_idpInput) _idpInput.focus();   /* keyboard accessibility */
  }

  function hideModal() {
    getOverlay().classList.remove('active');
    setError('');
  }

  /* ── validate then submit the custom URL field ── */
  function submitCustom() {
    var raw = _idpInput ? _idpInput.value.trim() : '';
    /* prepend https:// if user typed a bare domain */
    if (raw && !/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    if (!raw) { setError('Please enter an identity provider URL.'); return; }
    /* validate before any network call; do NOT echo raw value in error message */
    if (!isValidIdpUrl(raw)) {
      setError('Only HTTPS provider URLs are accepted.');
      return;
    }
    doSolidLogin(raw);
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Solid OIDC login
   * Validation applied again here even for pre-set provider URLs (defence in depth).
   * ───────────────────────────────────────────────────────────────────────── */
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
      /* redirectUrl is always our own origin root — never user-supplied */
      await _session.login(idp, REDIRECT_URL);
    } catch (err) {
      /* log detail internally; show generic message to user */
      console.error('[solidlogin] login error:', err);
      setError('Login failed — please check the provider URL and try again.');
      showModal();
    }
  }

  /* ── update UI and global state after a session becomes active ── */
  function onSessionActive(webId) {
    _webId = webId;
    /* expose on window.solid for interop */
    window.solid         = window.solid || {};
    window.solid.session = _session;
    window.solid.webId   = webId;
    /* update header button */
    if (_loginBtn) {
      _loginBtn.textContent = shortWebId(webId);
      _loginBtn.title       = webId;
    }
    document.dispatchEvent(new CustomEvent('solidlogin', { detail: { webId: webId } }));
  }

  /* ── handle OIDC redirect-back (?code=… present in URL) ── */
  async function handleRedirect() {
    if (!new URLSearchParams(window.location.search).get('code')) return false;
    try {
      await _solidReady;
      _session = new _SolidSession();
      _session.addEventListener('sessionStateChange', function (e) {
        if (e.detail && e.detail.isActive) onSessionActive(e.detail.webId);
      });
      await _session.handleRedirectFromLogin();
      /* scrub OIDC params from address bar; preserves unrelated query params */
      var clean = new URL(window.location.href);
      ['code', 'state', 'iss'].forEach(function (k) { clean.searchParams.delete(k); });
      history.replaceState(null, '', clean.href);
      return true;
    } catch (err) {
      console.error('[solidlogin] redirect handling error:', err);
      return false;
    }
  }

  /* ── try restoring a saved session from IndexedDB ── */
  async function tryRestore() {
    try {
      await _solidReady;
      _session = new _SolidSession();
      _session.addEventListener('sessionStateChange', function (e) {
        if (e.detail && e.detail.isActive) onSessionActive(e.detail.webId);
      });
      await _session.restore();
    } catch (_) { /* no saved session — silent */ }
  }

  /* ── logout: clear session, reset button label ── */
  function doLogout() {
    if (_session) { try { _session.logout(); } catch (_) {} }
    _session = null;
    _webId   = null;
    window.solid         = window.solid || {};
    window.solid.session = null;
    window.solid.webId   = null;
    if (_loginBtn) { _loginBtn.textContent = 'Log in'; _loginBtn.title = ''; }
    document.dispatchEvent(new CustomEvent('solidlogout'));
  }

  /* ── wire the header #btn-login button ── */
  function wireHeaderButton() {
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

  /* ── bootstrap: run after DOM is ready ── */
  async function init() {
    wireHeaderButton();    /* hook #btn-login before any async work */
    getOverlay();          /* pre-build modal + inject CSS synchronously */
    var wasRedirect = await handleRedirect();
    if (!wasRedirect) await tryRestore();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

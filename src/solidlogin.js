/**
 * solidlogin.js — Solid-OIDC login widget for solidweb.app
 *
 * Flow
 * ────
 * Click #btn-login → doSolidLogin('https://solidweb.app') → OIDC redirect
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
 *   • localStorage webId validated as a safe URL before use; link href and
 *     displayed text set via DOM API (no innerHTML on untrusted strings).
 *   • #loggedIn banner uses createElement + textContent/href — no template
 *     literals injected into innerHTML.
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
 
  /* ── pre-validated provider list (all HTTPS, no user data) ── */
  var PROVIDERS = [
    { name: 'solidweb.app  (this server)', url: 'https://solidweb.app' },
    { name: 'solidcommunity.net',          url: 'https://solidcommunity.net' },
    { name: 'solidweb.me',                 url: 'https://solidweb.me' },
    { name: 'solidweb.org',                url: 'https://solidweb.org' },
    { name: 'solid.social',                url: 'https://solid.social' },
    { name: 'solid.live',                  url: 'https://solid.live' }
  ];
 
  /* The OIDC redirect_uri — always this page; never user-supplied. */
  var REDIRECT_URL = window.location.origin + '/';
 
  /* ── solid-oidc: prefer canonical JSS upstream; fall back to npm ── */
  var _SolidSession = null;
  var _solidReady = import('https://esm.sh/gh/JavaScriptSolidServer/solid-oidc/solid-oidc.js')
    .then(function (mod) { _SolidSession = mod.Session || mod.default; })
    .catch(function () {
      return import('https://esm.sh/solid-oidc@0.0.8')
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
 
  /* ─────────────────────────────────────────────────────────────────────────
   * IDP URL validation — HTTPS only, real hostname (≥ 3 chars).
   * Rejects data:, javascript:, file:, http:.
   * ───────────────────────────────────────────────────────────────────────── */
  function isValidIdpUrl(url) {
    try {
      var u = new URL(url);
      return u.protocol === 'https:' && u.hostname.length >= 3;
    } catch (_) { return false; }
  }
 
  /* ─────────────────────────────────────────────────────────────────────────
   * Extract a short display name (username only) from a WebID URI.
   *
   * Priority:
   *   1. Subdomain username — hostname has > 2 segments and the first is not
   *      'www', e.g. alice.solidweb.app → "alice"
   *   2. First non-empty path segment, e.g. solidcommunity.net/profile/alice/
   *      → "alice"
   *   3. Full hostname as fallback.
   * ───────────────────────────────────────────────────────────────────────── */
  function usernameFromWebId(uri) {
    try {
      var u       = new URL(uri);
      var parts   = u.hostname.split('.');
      /* case 1: subdomain-based pod (alice.solidweb.app) */
      if (parts.length > 2 && parts[0] !== 'www' && parts[0].length > 0) {
        return parts[0];
      }
      /* case 2: path-based pod (solidcommunity.net/profile/alice) */
      var segments = u.pathname.split('/').filter(function (s) { return s.length > 0; });
      /* skip common non-username path segments */
      var skip = { profile: true, card: true, '#me': true, people: true, users: true };
      for (var i = 0; i < segments.length; i++) {
        var seg = segments[i].replace(/#.*$/, '');   /* strip fragment */
        if (!skip[seg]) return seg;
      }
      /* case 3: fall back to full hostname */
      return u.hostname;
    } catch (_) {
      /* last resort: truncate raw string */
      return uri.length > 20 ? uri.slice(0, 10) + '\u2026' : uri;
    }
  }
 
  /* ── pod-home origin from webId (server-issued value) ── */
  /* e.g. https://alice.solidweb.app/profile/card#me → https://alice.solidweb.app/ */
  function podHomeFromWebId(webId) {
    try {
      return new URL(webId).origin + '/';
    } catch (_) { return null; }
  }
 
  /* ── error display — textContent only, never innerHTML ── */
  function setError(msg) {
    if (_errorEl) _errorEl.textContent = msg || '';
  }
 
  /* ─────────────────────────────────────────────────────────────────────────
   * Modal CSS — namespaced sl- prefix throughout.
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
    '.sl-actions button{padding:8px 16px;border-radius:8px;border:none;' +
    'cursor:pointer;font-size:14px}' +
    '#sl-cancel{background:#333;color:#aaa}' +
    '#sl-cancel:hover{background:#444}' +
    '#sl-submit{background:#7C4DFF;color:#fff}' +
    '#sl-submit:hover{background:#6a35ff}' +
    '.sl-signup{text-align:center;font-size:12px;color:#666;margin-top:14px}' +
    '.sl-signup a{color:#7C4DFF;text-decoration:none}' +
    '.sl-signup a:hover{text-decoration:underline}';
 
  /* ── build modal DOM — all text via textContent, zero innerHTML on untrusted data ── */
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
 
    var h2 = document.createElement('h2');
    h2.textContent = 'Sign in with Solid';
    modal.appendChild(h2);
 
    var sub = document.createElement('p');
    sub.className   = 'sl-sub';
    sub.textContent = 'Choose your pod provider or enter its URL.';
    modal.appendChild(sub);
 
    /* provider quick-pick — textContent safe; URLs are pre-validated constants */
    PROVIDERS.forEach(function (p) {
      var btn = document.createElement('button');
      btn.className   = 'sl-provider';
      btn.type        = 'button';
      btn.textContent = p.name;
      btn.addEventListener('click', function () { doSolidLogin(p.url); });
      modal.appendChild(btn);
    });
 
    var sep = document.createElement('div');
    sep.className   = 'sl-sep';
    sep.textContent = 'or enter your identity provider URL';
    modal.appendChild(sep);
 
    /* custom URL input */
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
 
    /* signup hint — link href is a literal path, not user data */
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
    if (_idpInput) _idpInput.focus();   /* keyboard accessibility */
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
    /* generic message — do not echo raw value */
    if (!isValidIdpUrl(raw)) { setError('Only HTTPS provider URLs are accepted.'); return; }
    doSolidLogin(raw);
  }
 
  /* ─────────────────────────────────────────────────────────────────────────
   * Core Solid OIDC login.
   * idp   — validated HTTPS IDP origin (pre-set constant or validated input)
   * redirectUrl — always REDIRECT_URL (this page's origin root)
   * ───────────────────────────────────────────────────────────────────────── */
  async function doSolidLogin(idp) {
    /* defence-in-depth: validate again even for pre-set provider URLs */
    if (!isValidIdpUrl(idp)) { setError('Invalid identity provider URL.'); return; }
    setError('');
    try {
      await _solidReady;
      _session = new _SolidSession();
      _session.addEventListener('sessionStateChange', function (e) {
        if (e.detail && e.detail.isActive) onSessionActive(e.detail.webId);
      });
      hideModal();
      /* redirect_uri is always our own origin root — never user-supplied */
      await _session.login(idp, REDIRECT_URL);
    } catch (err) {
      console.error('[solidlogin] login error:', err);
      setError('Login failed — please check the provider URL and try again.');
      showModal();
    }
  }
 
  /* ─────────────────────────────────────────────────────────────────────────
   * onSessionActive — called when a session becomes active.
   *
   * Updates the #btn-login label with the username (not the full hostname).
   * Stores webId in localStorage (mirrors the SolidLogic pattern in the
   * reference code) so subsequent page visits can show #loggedIn without
   * needing a live session on solidweb.app's root page.
   *
   * Pod-home navigation only fires after the OIDC redirect-back
   * (__solidloginFromRedirect flag), not on session restore — which would
   * redirect the user on every page load.
   * ───────────────────────────────────────────────────────────────────────── */
  function onSessionActive(webId) {
    _webId = webId;
 
    /* expose on window.solid for interop with other Solid scripts */
    window.solid         = window.solid || {};
    window.solid.session = _session;
    window.solid.webId   = webId;
 
    /* button label = username only (no domain) */
    if (_loginBtn) {
      _loginBtn.textContent = usernameFromWebId(webId);
      _loginBtn.title       = webId;   /* full webId on hover */
    }
 
    /* persist webId so the next visit (after redirect to pod) can show banner */
    try { localStorage.setItem(LS_KEY, webId); } catch (_) { /* storage blocked */ }
 
    document.dispatchEvent(new CustomEvent('solidlogin', { detail: { webId: webId } }));
 
    /* navigate to pod home only after fresh OIDC redirect, not on restore */
    if (window.__solidloginFromRedirect) {
      var home = podHomeFromWebId(webId);
      if (home && home !== window.location.href) {
        window.location.href = home;
      }
    }
  }
 
  /* ─────────────────────────────────────────────────────────────────────────
   * showLoggedInBanner — mirrors the SolidLogic reference code pattern.
   *
   * If localStorage holds a webId from a previous OIDC session (the user
   * completed login, was redirected to their pod, and has now returned to
   * solidweb.app), show #loggedIn with a link to the webId, then clear the
   * localStorage entry (one-shot display).
   *
   * Security: webId from localStorage is validated as a URL before use.
   * The link href and display text are set via DOM API — no innerHTML on the
   * stored value, no template literals injected into the document.
   * ───────────────────────────────────────────────────────────────────────── */
  function showLoggedInBanner() {
    var el = document.getElementById('loggedIn');
    if (!el) return;
 
    var stored;
    try { stored = localStorage.getItem(LS_KEY); } catch (_) { return; }
    if (!stored) return;
 
    /* validate the stored value before touching the DOM */
    if (!isValidIdpUrl(stored)) {
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      return;
    }
 
    /* clear entry — one-shot, mirrors SolidLogic pattern */
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
 
    /* build banner content entirely via DOM API — no innerHTML on stored data */
    el.textContent = '';   /* clear any static placeholder */
 
    var p1 = document.createElement('p');
    p1.appendChild(document.createTextNode('Your WebID is: '));
    var link = document.createElement('a');
    link.href        = stored;    /* validated HTTPS URL */
    link.textContent = stored;   /* plain text display */
    p1.appendChild(link);
    p1.appendChild(document.createTextNode('.'));
    el.appendChild(p1);
 
    var p2 = document.createElement('p');
    p2.textContent = 'Visit your profile to log into your Pod.';
    el.appendChild(p2);
 
    el.style.display = 'block';
  }
 
  /* ─────────────────────────────────────────────────────────────────────────
   * Handle OIDC redirect-back: ?code= present in URL.
   * Sets __solidloginFromRedirect so onSessionActive navigates to pod home.
   * ───────────────────────────────────────────────────────────────────────── */
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
    } catch (_) { /* no saved session — silent */ }
  }
 
  /* ── logout: clear session, localStorage entry, reset button ── */
  function doLogout() {
    if (_session) { try { _session.logout(); } catch (_) {} }
    _session = null;
    _webId   = null;
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    window.solid         = window.solid || {};
    window.solid.session = null;
    window.solid.webId   = null;
    if (_loginBtn) { _loginBtn.textContent = 'Log in'; _loginBtn.title = ''; }
    /* hide banner if visible */
    var el = document.getElementById('loggedIn');
    if (el) el.style.display = 'none';
    document.dispatchEvent(new CustomEvent('solidlogout'));
  }
 
  /* ─────────────────────────────────────────────────────────────────────────
   * Wire #btn-login:
   *   logged out → doSolidLogin('https://solidweb.app') — direct, no modal
   *   logged in  → doLogout()
   * ───────────────────────────────────────────────────────────────────────── */
  function wireButtons() {
    var btn = document.getElementById('btn-login');
    if (!btn) return;
    _loginBtn = btn;
    btn.addEventListener('click', function () {
      if (_webId) doLogout();
      else doSolidLogin('https://solidweb.app');
    });
  }
 
  /* ── public API ── */
  window.solidlogin = {
    login:      function () { doSolidLogin('https://solidweb.app'); },
    loginModal: showModal,    /* available if a modal trigger is added later */
    logout:     doLogout,
    get webId()   { return _webId; },
    get session() { return _session; }
  };
 
  /* ── bootstrap ── */
  async function init() {
    wireButtons();
    getOverlay();   /* pre-build modal + inject CSS — synchronous, no network */
 
    var wasRedirect = await handleRedirect();
    if (!wasRedirect) {
      /*
       * No ?code= present: check localStorage for a prior webId.
       * This is the "returned from pod home" case — show banner, then restore.
       */
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

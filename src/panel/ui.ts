/**
 * The control panel's browser UI.
 *
 * Deliberately no build step, no framework, no dependency: this whole panel is
 * one HTML page and one script file, generated as strings. Anyone cloning this
 * bot to self-host it should be able to read the entire client in one file.
 *
 * The page and script are served as two routes rather than one inline
 * `<script>` block so the server can set `script-src 'self'` with no
 * `'unsafe-inline'` — the strongest CSP available without a nonce, and it
 * removes an entire class of XSS lever even though this page renders mostly
 * operator-supplied data.
 *
 * Wallet interaction reuses the same `window.klever` / `window.kleverWeb`
 * provider surface the main web client uses (see `web/src/lib/klever.ts`), so
 * an operator logs in with the extension they already have installed.
 */

import { MAX_AVATAR_BYTES } from '../identity.js';
import { LOCALES, TRANSLATIONS } from './i18n.js';

/** Data the initial page needs before any JS runs. */
export interface PageContext {
  botAddress: string;
  network: string;
}

export function renderPage(ctx: PageContext): string {
  // Values come from the bot's own config/signer, not from any request input,
  // but are still escaped — defence in depth costs nothing here.
  const bot = escapeHtml(ctx.botAddress);
  const network = escapeHtml(ctx.network);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>ogmara-bot panel</title>
<style>
  /*
   * Colour lives entirely in custom properties; spacing/font/radius stay
   * static regardless of theme (see feedback_css_tokens in project memory).
   * Dark is this panel's native look and the bare :root default, so a light
   * preference only ever ADDS an override — an operator who never touches the
   * new theme control sees no change at all.
   */
  :root {
    color-scheme: dark;
    --bg: #12141a; --surface: #1c1f27; --surface-sunken: #12141a; --border: #2a2e38;
    --fg: #e6e6e6; --fg-secondary: #c8ccd2; --muted: #9aa0a8; --label: #b8bcc4;
    --accent: #3a6ff7; --accent-fg: #ffffff;
    --danger: #d64545; --error: #ff8a8a; --success: #7fd88f;
    --banner-bg: #3a2a12; --banner-border: #a86a1e; --banner-fg: #ffd9a0;
    --chip-bg: #12141a;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      color-scheme: light;
      --bg: #f5f6f8; --surface: #ffffff; --surface-sunken: #eef0f4; --border: #dde1e8;
      --fg: #1b1e24; --fg-secondary: #3a4150; --muted: #6b7280; --label: #4a5160;
      --accent: #3a6ff7; --accent-fg: #ffffff;
      --danger: #c0392b; --error: #c0392b; --success: #1e8449;
      --banner-bg: #fff4e0; --banner-border: #e0a13a; --banner-fg: #6b4a10;
      --chip-bg: #eef0f4;
    }
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #f5f6f8; --surface: #ffffff; --surface-sunken: #eef0f4; --border: #dde1e8;
    --fg: #1b1e24; --fg-secondary: #3a4150; --muted: #6b7280; --label: #4a5160;
    --accent: #3a6ff7; --accent-fg: #ffffff;
    --danger: #c0392b; --error: #c0392b; --success: #1e8449;
    --banner-bg: #fff4e0; --banner-border: #e0a13a; --banner-fg: #6b4a10;
    --chip-bg: #eef0f4;
  }
  :root[data-theme="dark"] { color-scheme: dark; }

  body { font-family: system-ui, sans-serif; width: 80%; max-width: 1600px; min-width: 320px;
         margin: 2rem auto; padding: 0 1rem; background: var(--bg); color: var(--fg); box-sizing: border-box; }
  h1 { font-size: 1.2rem; }
  .muted { color: var(--muted); font-size: 0.85rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .banner { background: var(--banner-bg); border: 1px solid var(--banner-border); border-radius: 8px; padding: 1rem;
            margin: 0 0 1rem; color: var(--banner-fg); }
  button { background: var(--accent); color: var(--accent-fg); border: none; border-radius: 6px; padding: 0.5rem 1rem;
           cursor: pointer; font-size: 0.95rem; font-family: inherit; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.danger { background: var(--danger); }
  input, select, textarea { background: var(--surface-sunken); color: var(--fg); border: 1px solid var(--border);
          border-radius: 6px; padding: 0.4rem; width: 100%; box-sizing: border-box; font-family: inherit; font-size: 0.95rem; }
  label { display: block; margin: 0.6rem 0 0.2rem; font-size: 0.85rem; color: var(--label); }
  #error { white-space: pre-wrap; }
  .error { color: var(--error); }
  .success { color: var(--success); }
  #status dt { color: var(--muted); font-size: 0.85rem; }
  #status dd { margin: 0 0 0.5rem; font-size: 1rem; }
  code { background: var(--surface-sunken); padding: 0.1rem 0.3rem; border-radius: 4px; }

  .header-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
  .header-controls { display: flex; gap: 0.6rem; align-items: center; }
  .header-controls select { width: auto; padding: 0.3rem 0.5rem; font-size: 0.85rem; }

  .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .tabs { display: flex; gap: 0.5rem; border-bottom: 1px solid var(--border); margin-bottom: 1rem; flex-wrap: wrap; }
  .tab-btn { background: none; color: var(--muted); border: none; border-bottom: 2px solid transparent;
             border-radius: 0; padding: 0.5rem 0.25rem; margin-bottom: -1px; }
  .tab-btn.active { color: var(--fg); border-bottom-color: var(--accent); }
  .tab-btn:hover:not(.active) { color: var(--fg-secondary); }

  .quick-stats { display: flex; gap: 1.5rem; flex-wrap: wrap; margin: 0 0 1.2rem; }
  .quick-stats div { min-width: 6rem; }
  .quick-stats dt { color: var(--muted); font-size: 0.8rem; }
  .quick-stats dd { margin: 0; font-size: 1.3rem; }

  .post-row { border-bottom: 1px solid var(--border); padding: 0.6rem 0; }
  .post-row:last-child { border-bottom: none; }
  .post-title { font-size: 0.95rem; }
  .post-title a { color: inherit; text-decoration: none; }
  .post-title a:hover { text-decoration: underline; }
  .post-meta { color: var(--muted); font-size: 0.8rem; margin-top: 0.2rem; }
  .post-meta span { margin-right: 1rem; }

  .hashtag-list { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 0; margin: 0; list-style: none; }
  .hashtag-list li { background: var(--chip-bg); border: 1px solid var(--border); border-radius: 999px;
                      padding: 0.2rem 0.7rem; font-size: 0.85rem; }

  .chart-card { margin: 0 0 1.2rem; }
  .chart-metrics { display: flex; gap: 0.5rem; border-bottom: 1px solid var(--border); margin-bottom: 0.5rem; }
  .chart-metric-btn { background: none; color: var(--muted); border: none; border-bottom: 2px solid transparent;
                       padding: 0.4rem 0.25rem; margin-bottom: -1px; cursor: pointer; font-size: 0.9rem;
                       font-family: inherit; }
  .chart-metric-btn.active { color: var(--fg); border-bottom-color: var(--accent); }
  .chart-metric-btn:hover:not(.active) { color: var(--fg-secondary); }
  .chart-range { display: flex; gap: 0.4rem; margin: 0.5rem 0; }
  .range-btn { background: var(--surface); color: var(--muted); border: 1px solid var(--border); border-radius: 999px;
               padding: 0.2rem 0.8rem; font-size: 0.8rem; cursor: pointer; font-family: inherit; }
  .range-btn.active { color: var(--fg); border-color: var(--accent); }
  #chart-svg { width: 100%; height: 200px; background: var(--surface-sunken); border: 1px solid var(--border);
               border-radius: 8px; display: block; }

  .dashboard-toolbar { display: flex; justify-content: flex-end; margin-bottom: 0.6rem; }
  .secondary-btn { background: var(--surface); color: var(--fg-secondary); border: 1px solid var(--border); border-radius: 6px;
                    padding: 0.35rem 0.9rem; font-size: 0.85rem; cursor: pointer; font-family: inherit;
                    display: inline-block; }
  .secondary-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--fg); }
  .secondary-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .avatar-row { display: flex; align-items: center; gap: 1rem; margin: 0.6rem 0; }
  .avatar-preview { width: 64px; height: 64px; border-radius: 50%; object-fit: cover;
                     background: var(--surface-sunken); border: 1px solid var(--border); }
  .avatar-picker { display: flex; gap: 0.5rem; align-items: center; }

  /* ── Configuration tab ── */
  .config-section { margin: 1.2rem 0; }
  .config-section > h3 { margin-bottom: 0.2rem; }
  .config-field { border-bottom: 1px solid var(--border); padding: 0.7rem 0; }
  .config-field:last-child { border-bottom: none; }
  .config-field-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
  .config-field-actions { display: flex; gap: 0.4rem; align-items: center; }
  .field-help { color: var(--muted); font-size: 0.8rem; margin: 0.15rem 0 0.4rem; }
  .chip { display: inline-block; background: var(--chip-bg); border: 1px solid var(--border); color: var(--muted);
          border-radius: 999px; padding: 0.05rem 0.55rem; font-size: 0.72rem; white-space: nowrap; }
  .chip.chip-ui { color: var(--accent); border-color: var(--accent); }
  .chip.chip-restart { color: var(--banner-fg); border-color: var(--banner-border); }
  .reset-btn { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 6px;
               padding: 0.15rem 0.5rem; font-size: 0.75rem; cursor: pointer; font-family: inherit; }
  .reset-btn:hover:not(:disabled) { color: var(--fg); border-color: var(--accent); }
  .reset-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .config-array-list { display: flex; flex-direction: column; gap: 0.35rem; margin: 0.3rem 0; }
  .config-array-row { display: flex; gap: 0.4rem; align-items: center; }
  .config-array-row input { flex: 1; }
  .config-command-row { border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem; margin-bottom: 0.5rem; }
  .config-toolbar { display: flex; gap: 0.6rem; align-items: center; margin: 1rem 0; position: sticky; bottom: 0;
                    background: var(--bg); padding: 0.6rem 0; border-top: 1px solid var(--border); }
  .config-toolbar .muted { flex: 1; }

  /* ── Audit log tab ── */
  .audit-filters { display: flex; gap: 0.7rem; flex-wrap: wrap; align-items: flex-end; margin-bottom: 1rem; }
  .audit-filters > div { min-width: 8rem; }
  .audit-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .audit-table th { text-align: left; color: var(--muted); font-weight: normal; font-size: 0.78rem;
                     border-bottom: 1px solid var(--border); padding: 0.3rem 0.5rem; }
  .audit-table td { border-bottom: 1px solid var(--border); padding: 0.35rem 0.5rem; vertical-align: top; }
  .audit-table tr:last-child td { border-bottom: none; }
</style>
</head>
<body>
  <div class="header-row">
    <div>
      <h1>ogmara-bot</h1>
      <p class="muted" id="brand-tagline" data-bot="${bot}" data-network="${network}"></p>
    </div>
    <div class="header-controls">
      <label for="theme-select" class="muted" data-i18n="theme.label" style="margin:0;display:inline">Theme</label>
      <select id="theme-select">
        <option value="system" data-i18n="theme.system">System</option>
        <option value="light" data-i18n="theme.light">Light</option>
        <option value="dark" data-i18n="theme.dark">Dark</option>
      </select>
      <label for="locale-select" class="muted" data-i18n="language.label" style="margin:0;display:inline">Language</label>
      <select id="locale-select">
        <option value="en">English</option>
        <option value="de">Deutsch</option>
        <option value="es">Español</option>
        <option value="pt">Português</option>
        <option value="ru">Русский</option>
        <option value="ja">日本語</option>
        <option value="zh">中文</option>
      </select>
    </div>
  </div>

  <p id="error"></p>

  <div id="login-card" class="card">
    <p data-i18n="login.prompt">Sign in with the wallet authorised to operate this bot.</p>
    <button id="login-btn" data-i18n="login.connect">Connect wallet</button>
  </div>

  <div id="backup-banner" class="banner" hidden>
    <strong data-i18n="backup.title">Back up your wallet key now.</strong>
    <span data-i18n="backup.body">
      This bot's wallet key was generated automatically, and its only copy is
      the .env file on this machine — it cannot be recovered if lost, and
      anyone who obtains it can post as this bot. Copy it somewhere safe now.
    </span>
    <p><button id="backup-ack-btn" data-i18n="backup.ack">I've backed it up</button></p>
  </div>

  <div id="restart-banner" class="banner" hidden>
    <strong id="restart-banner-title"></strong>
    <p class="muted" data-i18n="config.restart.banner.body">These settings are saved but will not take effect until the bot process restarts:</p>
    <ul id="restart-banner-list"></ul>
    <button id="restart-banner-dismiss" class="secondary-btn" data-i18n="config.restart.banner.dismiss">Dismiss</button>
  </div>

  <div id="panel" class="card" hidden>
    <div class="panel-header">
      <p class="muted" id="whoami-line"><span id="whoami-prefix" data-i18n="header.signedInAsPrefix">Signed in as</span> <code id="whoami"></code></p>
      <button id="logout-btn" data-i18n="header.logout">Log out</button>
    </div>

    <nav class="tabs">
      <button class="tab-btn active" id="tab-btn-dashboard" data-tab="dashboard" data-i18n="nav.dashboard">Dashboard</button>
      <button class="tab-btn" id="tab-btn-settings" data-tab="settings" data-i18n="nav.account">Account</button>
      <button class="tab-btn" id="tab-btn-config" data-tab="config" data-i18n="nav.config">Configuration</button>
      <button class="tab-btn" id="tab-btn-audit" data-tab="audit" data-i18n="nav.audit">Audit log</button>
    </nav>

    <div id="tab-dashboard" class="tab-content">
      <div class="dashboard-toolbar">
        <button id="refresh-dashboard-btn" class="secondary-btn" data-i18n="dashboard.refresh">Refresh</button>
      </div>

      <div class="chart-card">
        <nav class="chart-metrics">
          <button class="chart-metric-btn active" id="chart-metric-reactions" data-metric="reactions" data-i18n="chart.metric.reactions">Reactions</button>
          <button class="chart-metric-btn" id="chart-metric-reposts" data-metric="reposts" data-i18n="chart.metric.reposts">Reposts</button>
          <button class="chart-metric-btn" id="chart-metric-comments" data-metric="comments" data-i18n="chart.metric.comments">Comments</button>
        </nav>
        <div class="chart-range">
          <button class="range-btn active" id="chart-range-month" data-range="month" data-i18n="chart.range.month">Monthly</button>
          <button class="range-btn" id="chart-range-year" data-range="year" data-i18n="chart.range.year">Yearly</button>
          <button class="range-btn" id="chart-range-all" data-range="all" data-i18n="chart.range.all">Overall</button>
        </div>
        <p class="muted error" id="chart-error" hidden></p>
        <p class="muted" id="chart-empty" hidden data-i18n="chart.empty">Not enough history yet — check back after a few snapshots.</p>
        <svg id="chart-svg" viewBox="0 0 600 200" preserveAspectRatio="none"></svg>
      </div>

      <p id="dashboard-error" class="error"></p>
      <dl class="quick-stats" id="quick-stats"></dl>

      <h2 data-i18n="posts.heading">Recent posts</h2>
      <p class="muted" id="posts-empty" hidden data-i18n="posts.empty">No posts yet.</p>
      <div id="posts-list"></div>

      <h2 data-i18n="hashtags.heading">Hashtags</h2>
      <p class="muted" id="hashtags-empty" hidden data-i18n="hashtags.empty">No hashtags yet.</p>
      <p class="muted" id="hashtags-note" data-i18n="hashtags.note">Counted across the posts shown above, not your full history.</p>
      <ul class="hashtag-list" id="hashtag-list"></ul>
    </div>

    <div id="tab-settings" class="tab-content" hidden>
      <dl id="status"></dl>

      <hr>
      <h2 data-i18n="account.commands.heading">Slash commands</h2>
      <div id="bot-identity"></div>

      <hr>
      <h2 data-i18n="account.displayName.heading">Display name</h2>
      <label for="display-name" data-i18n="account.displayName.label">Display name</label>
      <input id="display-name" maxlength="64">
      <p><button id="profile-btn" data-i18n="account.displayName.save">Update profile</button></p>

      <h3 data-i18n="account.avatar.heading">Profile picture</h3>
      <div class="avatar-row">
        <img id="avatar-preview" class="avatar-preview" hidden alt="Profile picture">
        <div class="avatar-picker">
          <label for="avatar-file-input" class="secondary-btn" data-i18n="account.avatar.choose">Choose image</label>
          <input type="file" id="avatar-file-input" accept="image/jpeg,image/png,image/gif,image/webp" hidden>
          <button id="avatar-upload-btn" class="secondary-btn" disabled data-i18n="account.avatar.upload">Upload avatar</button>
        </div>
      </div>
      <p class="muted" data-i18n="account.avatar.hint">JPEG, PNG, GIF or WebP, up to 5 MB.</p>

      <hr>
      <h2 data-i18n="account.registration.heading">Wallet registration</h2>
      <p class="muted" data-i18n="account.registration.body">Registering on-chain raises the daily posting ceiling. Costs real KLV, non-refundable.</p>
      <button id="register-btn" class="danger">Register wallet</button>
    </div>

    <div id="tab-config" class="tab-content" hidden>
      <p class="muted" data-i18n="config.intro">
        Every field below is read from config.yaml, and a change here is saved
        to data/settings.json as an override — config.yaml is never modified.
        "Reset" removes the override and goes back to following the file.
      </p>
      <p id="config-error" class="error"></p>
      <div id="config-secrets" class="card"></div>
      <div id="config-sections"></div>
      <div class="config-toolbar">
        <span class="muted" id="config-unsaved-note"></span>
        <button id="config-discard-btn" class="secondary-btn" hidden data-i18n="config.discard">Discard changes</button>
        <button id="config-save-btn" disabled data-i18n="config.save">Save changes</button>
      </div>
    </div>

    <div id="tab-audit" class="tab-content" hidden>
      <p class="muted" data-i18n="audit.intro">Every settings change, applied or refused. Never shows a secret value.</p>
      <p id="audit-error" class="error"></p>
      <div class="audit-filters">
        <div>
          <label for="audit-filter-actor" data-i18n="audit.filter.actor">Actor</label>
          <input id="audit-filter-actor">
        </div>
        <div>
          <label for="audit-filter-path" data-i18n="audit.filter.path">Path</label>
          <input id="audit-filter-path">
        </div>
        <div>
          <label for="audit-filter-outcome" data-i18n="audit.filter.outcome">Outcome</label>
          <select id="audit-filter-outcome">
            <option value="" data-i18n="audit.filter.outcomeAll">All</option>
            <option value="applied" data-i18n="audit.outcome.applied">Applied</option>
            <option value="restart-pending" data-i18n="audit.outcome.restartPending">Restart pending</option>
            <option value="rejected" data-i18n="audit.outcome.rejected">Rejected</option>
          </select>
        </div>
        <button id="audit-filter-clear" class="secondary-btn" data-i18n="audit.filter.clear">Clear filters</button>
      </div>
      <p class="muted" id="audit-empty" hidden data-i18n="audit.empty">No settings changes recorded yet.</p>
      <div style="overflow-x:auto">
        <table class="audit-table" id="audit-table" hidden>
          <thead>
            <tr>
              <th data-i18n="audit.col.time">Time</th>
              <th data-i18n="audit.col.actor">Actor</th>
              <th data-i18n="audit.col.path">Path</th>
              <th data-i18n="audit.col.outcome">Outcome</th>
              <th data-i18n="audit.col.change">Change</th>
            </tr>
          </thead>
          <tbody id="audit-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script src="/app.js"></script>
</body>
</html>`;
}

/**
 * The panel's client-side script.
 *
 * All dynamic content is set via `textContent`/`value`, never `innerHTML` —
 * the status endpoint reflects the bot's own address and node-reported
 * numbers, not arbitrary remote text, but the discipline is cheap and the
 * alternative is a rule that erodes the first time someone adds a field.
 */
export function renderScript(): string {
  // Embedded as JSON, not as a fetched file: this whole panel is one script
  // with no build step and no dependency (see the module comment), and a
  // second network request just to fetch strings would be a second thing that
  // can fail before the operator ever sees a login screen.
  const i18nData = JSON.stringify(TRANSLATIONS);
  const localesData = JSON.stringify(LOCALES);
  return `'use strict';

const I18N = ${i18nData};
const LOCALES = ${localesData};

/**
 * Resolve the active locale: an explicit choice in localStorage, else the
 * browser's own language if it is one of the seven this panel ships, else
 * English. Never trusts a stored value blindly — a locale list saved by a
 * NEWER build of this panel and then rolled back must not crash an older one.
 */
function detectLocale() {
  let stored;
  try {
    stored = localStorage.getItem('ogmara_bot_locale');
  } catch {
    stored = null;
  }
  if (stored && LOCALES.includes(stored)) return stored;
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return LOCALES.includes(nav) ? nav : 'en';
}

let locale = detectLocale();

/**
 * Translate one key, with simple {placeholder} substitution.
 *
 * Falls back to English, then to the key itself — the key itself is a visibly
 * broken string an operator can report, which is better than a blank control.
 */
function t(key, vars) {
  const table = I18N[locale] || I18N.en;
  let str = table[key];
  if (str === undefined) str = I18N.en[key];
  if (str === undefined) return key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      str = str.split('{' + k + '}').join(String(vars[k]));
    }
  }
  return str;
}

/**
 * Apply the active locale to every element carrying a data-i18n* attribute.
 *
 * Only ever sets textContent/placeholder/title — no markup-assignment API
 * anywhere — so a translated string can never become markup, the same
 * discipline the rest of this script holds everywhere else. (The panel test
 * greps this whole file for that API by name — keep it out of comments too.)
 */
function applyStaticI18n() {
  document.documentElement.lang = locale;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.getAttribute('data-i18n-title'));
  }
  const tagline = document.getElementById('brand-tagline');
  if (tagline) {
    tagline.textContent = '';
    tagline.appendChild(document.createTextNode(t('brand.walletPrefix') + ' '));
    const code = document.createElement('code');
    code.textContent = tagline.dataset.bot;
    tagline.appendChild(code);
    tagline.appendChild(document.createTextNode(' — ' + tagline.dataset.network));
  }
}

const localeSelect = document.getElementById('locale-select');
localeSelect.value = locale;
localeSelect.addEventListener('change', () => {
  locale = localeSelect.value;
  try {
    localStorage.setItem('ogmara_bot_locale', locale);
  } catch {
    /* private browsing, storage disabled — the choice just won't persist */
  }
  applyStaticI18n();
  // Re-render whatever the active tab already fetched, so text generated at
  // fetch time (status labels, the bot-identity panel, the config form)
  // switches language immediately rather than on the next refresh.
  refreshLocalizedViews();
});

/**
 * Theme: 'system' (the default) follows prefers-color-scheme via the CSS
 * media query and sets no attribute at all; an explicit 'light' or 'dark'
 * sets data-theme, which the stylesheet's attribute selectors override the
 * media query with.
 */
function detectTheme() {
  try {
    const stored = localStorage.getItem('ogmara_bot_theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* ignore */
  }
  return 'system';
}

function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

const themeSelect = document.getElementById('theme-select');
const initialTheme = detectTheme();
themeSelect.value = initialTheme;
applyTheme(initialTheme);
themeSelect.addEventListener('change', () => {
  const theme = themeSelect.value;
  applyTheme(theme);
  try {
    localStorage.setItem('ogmara_bot_theme', theme);
  } catch {
    /* private browsing, storage disabled — the choice just won't persist */
  }
});

// Applied immediately, before login even resolves, so the login screen itself
// (and everything static) is never shown in English by mistake for a
// returning operator with a saved language preference.
applyStaticI18n();

const errorEl = document.getElementById('error');
const loginCard = document.getElementById('login-card');
const panel = document.getElementById('panel');
const backupBanner = document.getElementById('backup-banner');
const restartBanner = document.getElementById('restart-banner');
const dashboardErrorEl = document.getElementById('dashboard-error');

function showError(message) {
  errorEl.textContent = message;
  errorEl.className = message ? 'error' : '';
}

function showSuccess(message) {
  errorEl.textContent = message;
  errorEl.className = 'success';
}

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // status AND body carried on the error: refresh() needs the status code
    // to tell "not logged in" (401) apart from every other failure, and the
    // body itself because /api/status still includes walletBackupPending on
    // a 502 (chain unreachable) precisely so a node outage can't make the
    // backup reminder disappear along with everything else in the response.
    const err = new Error(body.error || ('request failed: ' + res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function getProvider() {
  if (window.klever && window.klever.signMessage) return window.klever;
  if (window.kleverWeb && window.kleverWeb.signMessage) return window.kleverWeb;
  return null;
}

async function login() {
  showError('');
  const provider = getProvider();
  if (!provider) {
    showError(t('login.noExtension'));
    return;
  }
  try {
    if (provider.initialize) await provider.initialize();
    const address = await provider.getWalletAddress();
    const challenge = await api('/api/auth/challenge', { method: 'GET' });
    const signature = await provider.signMessage(challenge.message);
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ address, nonce: challenge.nonce, signature }),
    });
  } catch (err) {
    showError(err.message || String(err));
    return;
  }
  // Login itself succeeded at this point. status and posts are refreshed
  // independently from here rather than chained — /api/posts has no
  // dependency on whatever /api/status might fail on (most likely the chain
  // being unreachable), so one failing must not silently prevent the other
  // from ever being tried.
  await refresh().catch((err) => {
    // A 401 HERE is not the harmless "not logged in yet" case the page-load
    // path suppresses — the login just succeeded and set a cookie, so the
    // session is not coming back and the user must be told. Staying silent is
    // how a broken session looked like nothing happening at all: the button
    // did nothing, the console showed 401s, and the UI showed no error.
    if (err && err.status === 401) {
      showError(t('login.sessionRejected'));
      return;
    }
    showError(err.message || String(err));
  });
  await refreshPosts();
  await refreshChart();
  renderRestartBanner();
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  loginCard.hidden = false;
  panel.hidden = true;
  backupBanner.hidden = true;
  restartBanner.hidden = true;
  showError('');
}

function setField(dl, label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

/**
 * Render the slash-command identity this bot advertises.
 *
 * Read-only: this reflects the "bot:" block in config.yaml, which is the first
 * thing to check when a command is missing from a client's "/" picker. Built as
 * DOM nodes with textContent throughout, so a command description can
 * never become markup in the operator's own dashboard. (The panel test asserts
 * this script contains no markup-assignment API at all — keep it that way.)
 */
let lastBotIdentity = null;

function renderBotIdentity(bot) {
  // Cached so a language switch can re-render this without a network round
  // trip — the data does not change just because the operator changed locale.
  lastBotIdentity = bot;
  const host = document.getElementById('bot-identity');
  host.textContent = '';
  if (!bot || !bot.enabled) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('account.commands.disabled');
    host.appendChild(p);
    return;
  }

  const dl = document.createElement('dl');
  setField(dl, t('account.commands.handle'), bot.handle ? '@' + bot.handle : t('account.commands.handleNone'));
  setField(
    dl,
    t('account.commands.channels'),
    bot.channels.length ? bot.channels.join(', ') : t('account.commands.channelsNone'),
  );
  host.appendChild(dl);

  if (!bot.commands.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    // A bot with no commands is valid — it still gets the Bot badge — so this
    // is stated rather than treated as an error.
    p.textContent = t('account.commands.none');
    host.appendChild(p);
    return;
  }

  const ul = document.createElement('ul');
  for (const cmd of bot.commands) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = '/' + cmd.name + (cmd.argsHint ? ' ' + cmd.argsHint : '');
    li.appendChild(code);
    li.appendChild(document.createTextNode(' — ' + cmd.description));
    ul.appendChild(li);
  }
  host.appendChild(ul);

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = t('account.commands.note');
  host.appendChild(note);
}

function switchTab(name) {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  for (const content of document.querySelectorAll('.tab-content')) {
    content.hidden = content.id !== 'tab-' + name;
  }
  // Otherwise the dashboard only ever reflects whatever was true at page
  // load — "Queued" in particular is the one genuinely live number here
  // (the retry queue actually drains over time), so leaving it frozen is
  // exactly the "looks like nothing is happening" failure mode this panel
  // already had once this session.
  if (name === 'dashboard') {
    refreshPosts();
    refreshChart();
  }
  if (name === 'settings') refreshProfile();
  if (name === 'config') refreshConfig();
  if (name === 'audit') refreshAudit();
}

/**
 * "3 minutes ago" / "5 hours ago" / "2 days ago", falling back to a plain
 * date once it's old enough that a relative count stops being useful at a
 * glance. This is the actual point of the stat: noticing at a glance that
 * the bot has gone quiet, not precise timekeeping.
 */
function formatRelativeTime(ms) {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' minute' + (minutes === 1 ? '' : 's') + ' ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  return new Date(ms).toLocaleDateString();
}

function setQuickStat(dl, label, value) {
  const wrap = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  wrap.appendChild(dt);
  wrap.appendChild(dd);
  dl.appendChild(wrap);
}

/** 64 lowercase-or-uppercase hex chars — same shape the web client's own
 *  \`sanitizeMsgId\` (web/src/lib/share.ts) requires before it will build a
 *  link, reproduced here since a node-supplied msgId is untrusted input and
 *  must be validated before it becomes part of an href. */
const MSG_ID_RE = /^[0-9a-fA-F]{64}$/;

function newsPostUrl(msgId) {
  return MSG_ID_RE.test(msgId) ? 'https://ogmara.org/app/#/news/' + msgId.toLowerCase() : null;
}

function renderPost(post) {
  const row = document.createElement('div');
  row.className = 'post-row';

  const title = document.createElement('div');
  title.className = 'post-title';
  const url = newsPostUrl(post.msgId);
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = post.title;
    title.appendChild(link);
  } else {
    title.textContent = post.title;
  }
  row.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'post-meta';
  const parts = [
    formatRelativeTime(post.timestamp),
    'reactions: ' + post.reactionCount,
    'reposts: ' + post.repostCount,
    'comments: ' + post.commentCount,
  ];
  for (const part of parts) {
    const span = document.createElement('span');
    span.textContent = part;
    meta.appendChild(span);
  }
  row.appendChild(meta);

  return row;
}

async function refreshPosts() {
  dashboardErrorEl.textContent = '';
  try {
    const stats = await api('/api/posts', { method: 'GET' });

    const quickStats = document.getElementById('quick-stats');
    quickStats.textContent = '';
    setQuickStat(quickStats, t('stats.published'), String(stats.totalPublished));
    setQuickStat(quickStats, t('stats.queued'), String(stats.queuedCount));
    setQuickStat(
      quickStats,
      t('stats.lastPost'),
      stats.lastPostedAt ? formatRelativeTime(stats.lastPostedAt) : t('posts.never'),
    );

    const postsList = document.getElementById('posts-list');
    postsList.textContent = '';
    document.getElementById('posts-empty').hidden = stats.posts.length > 0;
    for (const post of stats.posts) {
      postsList.appendChild(renderPost(post));
    }

    const hashtagList = document.getElementById('hashtag-list');
    hashtagList.textContent = '';
    const tags = Object.entries(stats.hashtagCounts).sort((a, b) => b[1] - a[1]);
    document.getElementById('hashtags-empty').hidden = tags.length > 0;
    document.getElementById('hashtags-note').hidden = tags.length === 0;
    for (const [tag, count] of tags) {
      const li = document.createElement('li');
      li.textContent = '#' + tag + ' (' + count + ')';
      hashtagList.appendChild(li);
    }
  } catch (err) {
    dashboardErrorEl.textContent = err.message || String(err);
  }
}

let chartHistory = null;
let chartMetric = 'reactions';
let chartRange = 'month';

const CHART_METRIC_FIELD = { reactions: 'totalReactions', reposts: 'totalReposts', comments: 'totalComments' };
// One entry per range: how far back the window reaches, and what it plots.
// Previously two parallel maps (ms + granularity) that had to be kept in
// sync by hand — a range added to only one silently took a wrong,
// plausible-looking path instead of erroring. Snapshots store a CUMULATIVE
// lifetime total (see statsHistory.ts) — plotting that raw for "Monthly"
// looked like a flat line that occasionally jumps, which read as "reactions
// are summarizing" rather than showing what happened on any given day.
// 'day'/'month' granularity buckets the cumulative series into per-period
// NEW activity (the delta between consecutive snapshots); 'raw' plots the
// cumulative total directly, which is the right shape for "Overall" — a
// growth curve over the bot's whole history. (User feedback, 0.15.0.)
const CHART_RANGES = {
  month: { windowMs: 30 * 86400000, granularity: 'day' },
  year: { windowMs: 365 * 86400000, granularity: 'month' },
  all: { windowMs: Infinity, granularity: 'raw' },
};

/** Smallest and largest value in a plain array of finite numbers, without
 *  \`Math.min(...arr)\`/\`Math.max(...arr)\` — spreading into either blows the
 *  call stack once the array is large enough, and history length is bounded
 *  by retention, not by anything this function controls. */
function minMax(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/** Calendar-bucket key for a timestamp — same day (or month) always maps to the same key, regardless of time of day. */
function bucketKey(ms, granularity) {
  const d = new Date(ms);
  return granularity === 'month'
    ? d.getFullYear() + '-' + d.getMonth()
    : d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

/**
 * Start of the calendar day/month containing \`ms\`, in local time.
 *
 * Used to align a window's start to a bucket boundary before bucketing —
 * without this, the window's raw \`now - windowMs\` cutoff fell in the
 * MIDDLE of whatever day/month it landed on, so the leftmost bucket was
 * always a partial period counted as if it were a whole one (verified: up
 * to ~15x understated for a monthly bucket cut a few hours into the day).
 * Snapping the start down means that first bucket is complete, and the
 * existing baseline lookup in \`bucketDeltaSeries\` correctly finds the last
 * snapshot before it. (Code audit, 0.15.0.)
 */
function bucketStart(ms, granularity) {
  const d = new Date(ms);
  return granularity === 'month'
    ? new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function formatChartDate(ms, granularity) {
  const d = new Date(ms);
  if (granularity === 'month') {
    return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  return (d.getMonth() + 1) + '/' + d.getDate();
}

/**
 * Turn a cumulative snapshot series into per-period NEW activity: one point
 * per calendar day/month bucket that has AT LEAST ONE snapshot within the
 * window, valued as the increase over the previous such bucket. A bucket
 * with no snapshot at all (e.g. the bot was offline that day) produces no
 * point — its activity is absorbed into whichever bucket resumes first,
 * not spread out or zero-filled.
 *
 * The very first bucket is measured against the last snapshot STRICTLY
 * BEFORE \`windowStart\` (found by scanning the FULL history, not just the
 * windowed slice, and independent of \`history\`'s own sort order — a full
 * scan tracking the latest qualifying timestamp, not a break on the first
 * non-qualifying one) — falling back to 0 only when there's truly no
 * earlier snapshot at all (the bot's very first ever), in which case that
 * first bucket's "new" activity is simply everything accumulated by then.
 * \`windowStart\` itself is expected to already be bucket-aligned (see
 * \`bucketStart\`) — this function doesn't re-align it.
 */
function bucketDeltaSeries(history, windowStart, granularity, field) {
  let baseline = 0;
  let baselineTimestamp = -Infinity;
  for (const s of history) {
    if (s.timestamp < windowStart && s.timestamp >= baselineTimestamp) {
      baseline = s[field];
      baselineTimestamp = s.timestamp;
    }
  }

  const lastInBucket = new Map();
  for (const s of history) {
    if (s.timestamp < windowStart) continue;
    const key = bucketKey(s.timestamp, granularity);
    const existing = lastInBucket.get(key);
    if (!existing || s.timestamp >= existing.timestamp) {
      lastInBucket.set(key, { timestamp: s.timestamp, total: s[field] });
    }
  }

  const buckets = [...lastInBucket.values()].sort((a, b) => a.timestamp - b.timestamp);
  const points = [];
  let previousTotal = baseline;
  for (const bucket of buckets) {
    points.push({ timestamp: bucket.timestamp, y: bucket.total - previousTotal });
    previousTotal = bucket.total;
  }
  return points;
}

function selectChartMetric(metric) {
  chartMetric = metric;
  for (const btn of document.querySelectorAll('.chart-metric-btn')) {
    btn.classList.toggle('active', btn.dataset.metric === metric);
  }
  renderChart();
}

function selectChartRange(range) {
  chartRange = range;
  for (const btn of document.querySelectorAll('.range-btn')) {
    btn.classList.toggle('active', btn.dataset.range === range);
  }
  renderChart();
}

function renderChart() {
  const svg = document.getElementById('chart-svg');
  const emptyEl = document.getElementById('chart-empty');
  svg.replaceChildren();

  if (!chartHistory || chartHistory.length === 0) {
    emptyEl.hidden = false;
    return;
  }

  const now = Date.now();
  const { windowMs, granularity } = CHART_RANGES[chartRange];
  const field = CHART_METRIC_FIELD[chartMetric];

  // Tracks whether \`points\` ended up holding per-period DELTAS (true) or
  // cumulative TOTALS (false) — the two need different y-axis floor and
  // latest-value-label treatment below, and which one \`points\` actually
  // holds depends on the fallback just below, not just on \`granularity\`.
  let usingDeltas = false;
  let points;
  if (granularity === 'raw') {
    points = chartHistory.map((s) => ({ timestamp: s.timestamp, y: s[field] }));
  } else {
    const windowStart = bucketStart(now - windowMs, granularity);
    const bucketed = bucketDeltaSeries(chartHistory, windowStart, granularity, field);
    // A brand-new bot (or a long snapshot gap) may not yet span 2 calendar
    // buckets — e.g. several same-day snapshots under "Monthly" all collapse
    // into ONE bucket, which can't draw a line. Falling back to the raw
    // within-window snapshots shows the real data that exists instead of a
    // misleading "not enough history" screen — nothing to compare against
    // yet, so there's no "which day did this happen on" confusion to have.
    if (bucketed.length >= 2) {
      points = bucketed;
      usingDeltas = true;
    } else {
      points = chartHistory
        .filter((s) => s.timestamp >= windowStart)
        .map((s) => ({ timestamp: s.timestamp, y: s[field] }));
    }
  }

  if (points.length < 2) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  // Match the viewBox to the SVG's actual rendered width so 1 viewBox unit
  // is exactly 1 CSS pixel on both axes — a fixed "viewBox 0 0 600 200"
  // against a full-width (often 1000px+) card stretched the x-axis relative
  // to y, visibly distorting the polyline's stroke width and smearing the
  // text labels. clientWidth is 0 before first layout (falls back to 600).
  const width = svg.clientWidth || 600;
  const height = 200;
  const pad = 28;
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  const xs = points.map((p) => p.timestamp);
  const ys = points.map((p) => p.y);
  const [minX, maxX] = minMax(xs);
  let [minY, maxY] = minMax(ys);
  // Deltas can legitimately go negative (net un-reactions/un-reposts within
  // a period) — unlike a cumulative total (always >= 0, whether that's the
  // true raw path or the sparse-data fallback above), this floor must not
  // force 0 to always be the bottom of the range, or a genuinely negative
  // period would be invisible, clipped below an axis that can't go that low.
  if (!usingDeltas) minY = Math.min(0, minY);
  if (maxY === minY) maxY = minY + 1;

  const scaleX = (x) => pad + ((x - minX) / (maxX - minX || 1)) * (width - 2 * pad);
  const scaleY = (y) => height - pad - ((y - minY) / (maxY - minY)) * (height - 2 * pad);

  const ns = 'http://www.w3.org/2000/svg';
  const coords = points.map((p) => scaleX(p.timestamp) + ',' + scaleY(p.y)).join(' ');
  const polyline = document.createElementNS(ns, 'polyline');
  polyline.setAttribute('points', coords);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', '#3a6ff7');
  polyline.setAttribute('stroke-width', '2');
  svg.appendChild(polyline);

  const startLabel = document.createElementNS(ns, 'text');
  startLabel.setAttribute('x', String(pad));
  startLabel.setAttribute('y', String(height - 8));
  startLabel.setAttribute('fill', '#9aa0a8');
  startLabel.setAttribute('font-size', '10');
  startLabel.textContent = formatChartDate(minX, granularity);
  svg.appendChild(startLabel);

  const endLabel = document.createElementNS(ns, 'text');
  endLabel.setAttribute('x', String(width - pad));
  endLabel.setAttribute('y', String(height - 8));
  endLabel.setAttribute('fill', '#9aa0a8');
  endLabel.setAttribute('font-size', '10');
  endLabel.setAttribute('text-anchor', 'end');
  endLabel.textContent = formatChartDate(maxX, granularity);
  svg.appendChild(endLabel);

  const latestLabel = document.createElementNS(ns, 'text');
  latestLabel.setAttribute('x', String(width - pad));
  latestLabel.setAttribute('y', String(pad - 10));
  latestLabel.setAttribute('fill', '#e6e6e6');
  latestLabel.setAttribute('font-size', '12');
  latestLabel.setAttribute('text-anchor', 'end');
  // The last bucket in a delta series is always the CURRENT, still-in-
  // progress period (today, or this month) — labelling it identically to a
  // cumulative total would silently change what the same bare number means
  // depending on which range tab is active, with nothing on screen saying
  // so. (Code audit, 0.15.0.)
  latestLabel.textContent = usingDeltas ? ys[ys.length - 1] + ' so far' : String(ys[ys.length - 1]);
  svg.appendChild(latestLabel);
}

/**
 * @param force When true, asks the bot to take a brand-new snapshot right
 *   now (a live full-history aggregation against the node) rather than just
 *   re-reading whatever the last scheduled snapshot happened to record —
 *   this is what the "Refresh" button asks for. Plain loads (login, tab
 *   switch, initial page load) never force this: it's a genuinely heavier
 *   call, and firing it on every routine load would put needless extra load
 *   on the node for data that only changes meaningfully every few hours.
 */
async function refreshChart(force) {
  const errorEl = document.getElementById('chart-error');
  errorEl.hidden = true;
  errorEl.textContent = '';
  try {
    const result = force
      ? await api('/api/stats-history/refresh', { method: 'POST', body: '{}' })
      : await api('/api/stats-history', { method: 'GET' });
    chartHistory = Array.isArray(result.snapshots) ? result.snapshots : [];
    renderChart();
  } catch (err) {
    chartHistory = null;
    // Clear any previously rendered chart and make sure the "not enough
    // history" empty-state text is hidden — showing that alongside the
    // error below would tell the operator two contradictory things at once
    // (nothing wrong vs. something failed).
    document.getElementById('chart-svg').replaceChildren();
    document.getElementById('chart-empty').hidden = true;
    errorEl.textContent = err.message || String(err);
    errorEl.hidden = false;
  }
}

/** Reload every dashboard value in place — no full page reload needed. */
async function refreshDashboard() {
  const btn = document.getElementById('refresh-dashboard-btn');
  btn.disabled = true;
  try {
    // Both already catch and display their own errors internally, so
    // Promise.all here never rejects on a fetch failure — it only ever
    // rejects on a genuine bug, which should surface rather than be masked.
    // refreshChart(true): an explicit click is exactly the case that should
    // force a brand-new snapshot rather than settle for re-reading the last
    // scheduled one — see refreshChart's doc comment.
    await Promise.all([refreshPosts(), refreshChart(true)]);
  } finally {
    btn.disabled = false;
  }
}

async function refresh() {
  let status;
  try {
    status = await api('/api/status', { method: 'GET' });
  } catch (err) {
    if (err.status === 401) {
      loginCard.hidden = false;
      panel.hidden = true;
      backupBanner.hidden = true;
      throw err;
    }
    // Authenticated, but something else failed (most likely the chain being
    // unreachable) — still worth showing the panel shell and the backup
    // reminder rather than leaving the operator looking at the login screen
    // as if they were never signed in. /api/status includes
    // walletBackupPending even on its error responses for exactly this.
    loginCard.hidden = true;
    panel.hidden = false;
    backupBanner.hidden = !(err.body && err.body.walletBackupPending);
    throw err;
  }
  loginCard.hidden = true;
  panel.hidden = false;
  backupBanner.hidden = !status.walletBackupPending;
  document.getElementById('whoami').textContent = status.authenticatedAs;

  const dl = document.getElementById('status');
  dl.textContent = '';
  setField(
    dl,
    t('account.field.mode'),
    status.dryRun ? t('account.field.modeDryRun') : t('account.field.modeLive'),
  );
  setField(dl, t('account.field.registered'), status.registered ? t('account.field.yes') : t('account.field.no'));
  setField(dl, t('account.field.dailyLimit'), String(status.dailyLimit));
  setField(dl, t('account.field.burstLimit'), String(status.burstLimit));
  setField(dl, t('account.field.balance'), status.balanceKlv.toFixed(4) + ' KLV');
  if (!status.registered) {
    // Broken out because the total is a contract fee PLUS a transaction cost,
    // and the contract fee is governance-controlled — an operator seeing only
    // one number cannot tell why it changed.
    setField(
      dl,
      t('account.field.registrationCost'),
      t('account.field.registrationCostDetail', {
        total: status.registrationCostKlv,
        fee: status.registrationFeeKlv,
      }),
    );
  }

  renderBotIdentity(status.bot);

  const registerBtn = document.getElementById('register-btn');
  if (status.registered) {
    registerBtn.disabled = true;
    registerBtn.textContent = t('account.registration.alreadyRegistered');
  } else if (status.registrationPending) {
    // Broadcast, but not in a committed block yet, so the chain still reads as
    // unregistered. Re-enabling here is what let a second click spend a second
    // bandwidth fee on a call the contract was going to reject.
    registerBtn.disabled = true;
    registerBtn.textContent = t('account.registration.confirmingButton');
  } else {
    registerBtn.disabled = !status.canAffordRegistration;
    registerBtn.textContent = status.canAffordRegistration
      ? t('account.registration.button', { cost: status.registrationCostKlv })
      : t('account.registration.insufficientButton');
  }
}

async function updateProfile() {
  showError('');
  try {
    const displayName = document.getElementById('display-name').value.trim();
    if (!displayName) {
      showError(t('account.displayName.required'));
      return;
    }
    const result = await api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    });
    showSuccess(
      result.status === 'updated' ? t('account.displayName.updated') : t('account.displayName.nothingToUpdate'),
    );
    // The field now shows what was JUST published, so it's no longer an
    // unsaved edit — the next refreshProfile() (e.g. after switching tabs
    // and back) should feel free to re-sync it from the server again.
    displayNameDirty = false;
  } catch (err) {
    showError(err.message || String(err));
  }
}

// Exactly the four types media.ts's server-side allowlist accepts — kept in
// sync so a rejection here doesn't send a misleading impression of what's
// allowed. Interpolated from identity.ts's own MAX_AVATAR_BYTES, the actual
// source of truth, rather than a second hardcoded 5 MB literal drifting out
// of sync with it. (Code audit, 0.14.0.)
const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_AVATAR_BYTES = ${MAX_AVATAR_BYTES};
let selectedAvatarFile = null;
let displayNameDirty = false;
// The local blob: URL currently shown in the preview, if any — tracked so it
// can be revoked before being replaced. blob: URLs pin their backing File in
// memory until explicitly revoked; without this, picking several candidate
// avatars before settling on one leaked every rejected one for the life of
// the page. (Code audit, 0.14.0.)
let avatarPreviewBlobUrl = null;

function setAvatarPreviewBlobUrl(url) {
  if (avatarPreviewBlobUrl) URL.revokeObjectURL(avatarPreviewBlobUrl);
  avatarPreviewBlobUrl = url;
}

/** Load the bot's current profile and show it — the display name input was
 *  previously always blank regardless of what was actually set, which read
 *  as "no name configured" even when one genuinely was. */
async function refreshProfile() {
  try {
    const profile = await api('/api/profile', { method: 'GET' });
    const nameInput = document.getElementById('display-name');
    // Only prefill while the operator hasn't touched the field this session
    // (tracked explicitly via displayNameDirty, not just "is it empty" —
    // typing a name and then deleting it back to empty must not make this
    // re-fill from the server on the next tab switch). Cleared again after
    // a successful save, so the field then correctly reflects "this is what
    // was just published," not "this is what I once typed."
    if (!displayNameDirty) nameInput.value = profile.displayName || '';

    // Never clobber a locally staged, not-yet-uploaded file with the OLD
    // server avatar — switching tabs and back used to silently swap the
    // preview back to the previous image while the new file stayed armed,
    // so clicking Upload published something different from what was on
    // screen. (Code audit, 0.14.0.)
    if (selectedAvatarFile === null) {
      const preview = document.getElementById('avatar-preview');
      if (profile.avatarCid) {
        setAvatarPreviewBlobUrl(null);
        preview.src = profile.nodeUrl + '/api/v1/media/' + encodeURIComponent(profile.avatarCid);
        preview.hidden = false;
      } else {
        preview.hidden = true;
      }
    }
  } catch (err) {
    showError(err.message || String(err));
  }
}

function onAvatarFileChange(event) {
  const file = event.target.files[0];
  const uploadBtn = document.getElementById('avatar-upload-btn');
  const preview = document.getElementById('avatar-preview');
  selectedAvatarFile = null;
  uploadBtn.disabled = true;
  if (!file) return;
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    showError(t('account.avatar.badType'));
    preview.hidden = true;
    return;
  }
  if (file.size === 0) {
    showError(t('account.avatar.empty'));
    preview.hidden = true;
    return;
  }
  if (file.size > MAX_AVATAR_BYTES) {
    showError(t('account.avatar.tooLarge'));
    preview.hidden = true;
    return;
  }
  showError('');
  selectedAvatarFile = file;
  uploadBtn.disabled = false;
  // A local preview via a blob: URL, shown immediately — before the upload
  // even starts — so the operator sees what they picked without waiting on
  // a round trip. Replaced by the real node-hosted image once
  // refreshProfile() runs again after a successful upload.
  setAvatarPreviewBlobUrl(URL.createObjectURL(file));
  preview.src = avatarPreviewBlobUrl;
  preview.hidden = false;
}

async function uploadSelectedAvatar() {
  if (!selectedAvatarFile) return;
  showError('');
  const btn = document.getElementById('avatar-upload-btn');
  btn.disabled = true;
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('could not read file'));
      reader.readAsDataURL(selectedAvatarFile);
    });
    const imageBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    await api('/api/profile/avatar', {
      method: 'POST',
      body: JSON.stringify({
        imageBase64,
        mimeType: selectedAvatarFile.type,
        filename: selectedAvatarFile.name,
      }),
    });
    showSuccess(t('account.avatar.uploaded'));
    selectedAvatarFile = null;
    document.getElementById('avatar-file-input').value = '';
    await refreshProfile();
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    btn.disabled = selectedAvatarFile === null;
  }
}

async function register() {
  showError('');
  if (!window.confirm(t('account.registration.confirm'))) {
    return;
  }
  // The server also guards against an overlapping second request (registering
  // is check-then-act against the chain, wide enough for a double-click to
  // race), but disabling the button here means a double-click never even
  // reaches the network for the common case.
  const btn = document.getElementById('register-btn');
  btn.disabled = true;
  try {
    const result = await api('/api/register', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    if (result.status === 'registered') {
      showSuccess(t('account.registration.success', { txHash: result.txHash }));
      await refresh();
      // The transaction is broadcast but not yet in a committed block, so the
      // chain still reports the wallet as unregistered for a few seconds. Poll
      // until it agrees, so the button becomes "Already registered" on its own
      // rather than only after a manual page reload.
      await awaitRegistrationConfirmed();
      return;
    }
    if (result.status === 'pending') {
      showSuccess(t('account.registration.pending'));
      await refresh();
      await awaitRegistrationConfirmed();
      return;
    }
    if (result.status === 'already-registered') {
      showSuccess(t('account.registration.alreadyDone'));
    } else if (result.status === 'insufficient-funds') {
      showError(t('account.registration.insufficientFunds', { required: result.requiredKlv, balance: result.balanceKlv }));
    }
    await refresh();
  } catch (err) {
    showError(err.message || String(err));
    btn.disabled = false;
  }
}

/**
 * Poll /api/status until the chain confirms the registration.
 *
 * Bounded, and it never re-enables the button: if confirmation has not arrived
 * by the time this gives up, the server's own pending latch still holds the
 * button disabled, and the next refresh picks up the truth either way. A
 * transaction that genuinely failed is recoverable once that latch expires.
 */
async function awaitRegistrationConfirmed() {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const status = await api('/api/status', { method: 'GET' });
      if (status.registered) {
        // refresh() re-renders everything from a fresh read, so the button, the
        // limits and the cost row all move together.
        await refresh();
        showSuccess(t('account.registration.confirmed'));
        return;
      }
    } catch {
      // A transient failure mid-poll is not worth surfacing — the registration
      // itself already succeeded, and the next refresh reconciles.
    }
  }
}

/* ───────────────────────── Configuration tab ───────────────────────── */

/**
 * Client-side path helpers, mirroring \`settings.ts\`'s server-side ones just
 * closely enough to build one nested \`changes\` object from a flat map of
 * edits — never to duplicate any of the security-relevant logic (file-only
 * enforcement, prototype-key stripping, depth caps) that stays server-side and
 * is re-checked there regardless of what this code sends.
 */
function setNestedValue(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let cur = obj;
  for (const part of parts) {
    if (typeof cur[part] !== 'object' || cur[part] === null || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[last] = value;
}

/** "maxPostsPerHour" -> "Max Posts Per Hour", for a path no module labelled. */
function humanizeFieldLabel(path) {
  const last = path.split('.').pop();
  const spaced = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldLabel(field) {
  return field.labelKey ? t(field.labelKey) : humanizeFieldLabel(field.path);
}

// One-time layout: which top-level sections to show, and in what order.
// Anything present in a live response but not listed here still renders,
// appended at the end — this is a preferred ORDER, not an allowlist, so a
// future module's section is never silently dropped from the page.
const CONFIG_SECTION_ORDER = [
  'node', 'posting', 'sources', 'bot', 'ai', 'profile',
  'queue', 'storage', 'stats', 'panel', 'settings',
];

let configFields = [];
let configSecrets = {};
// path -> new value, for every field the operator has actually touched this
// session. Cleared on a successful save or an explicit discard.
let configPending = {};
// The restart-pending paths from the most recent save, persisted so the
// banner survives a reload — the client has no way to know a restart
// actually happened, only that one was asked for.
const RESTART_BANNER_KEY = 'ogmara_bot_restart_pending';

function loadPersistedRestartPending() {
  try {
    const raw = localStorage.getItem(RESTART_BANNER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Never trust a stored value blindly — the same discipline this file
    // applies to the locale and theme keys. A non-array here (a future
    // build's differently-shaped value, a shared machine, a stray extension)
    // must not throw: an uncaught exception here is reached from inside
    // saveConfig()'s try block right after a SUCCESSFUL save, which would
    // report config.saveError and tell the operator their save failed when it
    // had already gone through.
    return Array.isArray(parsed) && parsed.every((p) => typeof p === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function savePersistedRestartPending(paths) {
  try {
    if (paths.length === 0) localStorage.removeItem(RESTART_BANNER_KEY);
    else localStorage.setItem(RESTART_BANNER_KEY, JSON.stringify(paths));
  } catch {
    /* private browsing, storage disabled — the banner just won't survive a reload */
  }
}

function renderRestartBanner() {
  const paths = loadPersistedRestartPending();
  const banner = document.getElementById('restart-banner');
  if (paths.length === 0) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  document.getElementById('restart-banner-title').textContent = t('config.restart.banner.title', { count: paths.length });
  const list = document.getElementById('restart-banner-list');
  list.textContent = '';
  for (const path of paths) {
    const li = document.createElement('li');
    const field = configFields.find((f) => f.path === path);
    li.textContent = field ? fieldLabel(field) : path;
    list.appendChild(li);
  }
}

function addRestartPending(paths) {
  if (paths.length === 0) return;
  const existing = new Set(loadPersistedRestartPending());
  for (const p of paths) existing.add(p);
  savePersistedRestartPending([...existing]);
  renderRestartBanner();
}

/** One field's current, possibly-pending value. */
function fieldCurrentValue(field) {
  return Object.prototype.hasOwnProperty.call(configPending, field.path) ? configPending[field.path] : field.value;
}

function fieldIsDirty(field) {
  if (!Object.prototype.hasOwnProperty.call(configPending, field.path)) return false;
  return JSON.stringify(configPending[field.path]) !== JSON.stringify(field.value);
}

function updateConfigToolbar() {
  const dirtyCount = configFields.filter(fieldIsDirty).length;
  document.getElementById('config-save-btn').disabled = dirtyCount === 0;
  document.getElementById('config-discard-btn').hidden = dirtyCount === 0;
  const note = document.getElementById('config-unsaved-note');
  note.textContent = dirtyCount === 0 ? '' : t('config.unsavedCount', { count: dirtyCount });
}

/** Build the editor widget for one field's value; returns the element and a getter for its current value. */
function buildFieldInput(field) {
  const value = fieldCurrentValue(field);
  const onChange = (v) => {
    configPending[field.path] = v;
    updateConfigToolbar();
    renderResetButtonState(field.path);
  };

  if (field.fileOnly) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = '—';
    return span;
  }

  if (field.type.kind === 'boolean') {
    const wrap = document.createElement('label');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '0.4rem';
    wrap.style.margin = '0';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.style.width = 'auto';
    input.checked = Boolean(value);
    input.addEventListener('change', () => onChange(input.checked));
    wrap.appendChild(input);
    return wrap;
  }

  if (field.type.kind === 'enum') {
    const select = document.createElement('select');
    for (const opt of field.type.enumValues || []) {
      const optionEl = document.createElement('option');
      optionEl.value = opt;
      optionEl.textContent = opt;
      select.appendChild(optionEl);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  if (field.type.kind === 'number') {
    const input = document.createElement('input');
    input.type = 'number';
    if (typeof field.type.min === 'number') input.min = String(field.type.min);
    if (typeof field.type.max === 'number') input.max = String(field.type.max);
    if (typeof field.type.step === 'number') input.step = String(field.type.step);
    input.value = value === null || value === undefined ? '' : String(value);
    input.addEventListener('change', () => {
      const n = Number(input.value);
      onChange(Number.isFinite(n) ? n : value);
    });
    return input;
  }

  if (field.type.kind === 'array') {
    return buildArrayEditor(field, value, onChange);
  }

  // 'string' and 'unknown' both fall through to a plain text input; for
  // 'unknown' the raw value is shown/edited as JSON, which is honest about
  // this UI's ignorance of the real shape rather than silently mistyping it.
  const input = document.createElement('input');
  input.type = 'text';
  input.value = field.type.kind === 'unknown' ? JSON.stringify(value) : value === null || value === undefined ? '' : String(value);
  input.addEventListener('change', () => {
    if (field.type.kind === 'unknown') {
      try {
        onChange(JSON.parse(input.value));
      } catch {
        // Left as a pending string edit even though it will fail server-side
        // validation on save — surfacing that failure is more honest than
        // silently discarding a keystroke this UI cannot fully understand.
        onChange(input.value);
      }
      return;
    }
    // A blank input always maps to undefined, regardless of what the field
    // held before. This was previously conditional on the field having
    // already been unset — which meant blanking a field that DID hold a value
    // sent '' instead, and every optional string field in this schema either
    // requires a non-empty string (\`.min(1)\`) or has stricter formatting
    // (\`node.url\`), so '' just failed validation with a confusing message
    // instead of clearing the field. There is no field here where an empty
    // string is itself the intended value.
    onChange(input.value === '' ? undefined : input.value);
  });
  return input;
}

/**
 * \`bot.commands\` is an array of \`{name, description, argsHint}\` objects — the
 * one field in this whole config that is not a flat list of scalars — so it
 * gets its own editor rather than stretching the generic array editor to
 * cover a shape it was never meant for.
 */
function buildCommandsEditor(field, value, onChange) {
  const container = document.createElement('div');
  const rows = Array.isArray(value) ? value.map((v) => ({ ...v })) : [];

  const redraw = () => {
    container.textContent = '';
    rows.forEach((row, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'config-command-row';

      const nameInput = document.createElement('input');
      nameInput.placeholder = t('config.commands.name');
      nameInput.value = row.name || '';
      nameInput.addEventListener('change', () => {
        row.name = nameInput.value;
        onChange(rows.map((r) => ({ ...r })));
      });

      const descInput = document.createElement('input');
      descInput.placeholder = t('config.commands.description');
      descInput.value = row.description || '';
      descInput.style.marginTop = '0.35rem';
      descInput.addEventListener('change', () => {
        row.description = descInput.value;
        onChange(rows.map((r) => ({ ...r })));
      });

      const argsInput = document.createElement('input');
      argsInput.placeholder = t('config.commands.argsHint');
      argsInput.value = row.argsHint || '';
      argsInput.style.marginTop = '0.35rem';
      argsInput.addEventListener('change', () => {
        row.argsHint = argsInput.value || undefined;
        onChange(rows.map((r) => ({ ...r })));
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary-btn';
      removeBtn.style.marginTop = '0.35rem';
      removeBtn.textContent = t('config.array.removeItem');
      removeBtn.addEventListener('click', () => {
        rows.splice(i, 1);
        onChange(rows.map((r) => ({ ...r })));
        redraw();
      });

      rowEl.appendChild(nameInput);
      rowEl.appendChild(descInput);
      rowEl.appendChild(argsInput);
      rowEl.appendChild(removeBtn);
      container.appendChild(rowEl);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'secondary-btn';
    addBtn.textContent = t('config.array.addItem');
    addBtn.addEventListener('click', () => {
      rows.push({ name: '', description: '', argsHint: undefined });
      onChange(rows.map((r) => ({ ...r })));
      redraw();
    });
    container.appendChild(addBtn);
  };

  redraw();
  return container;
}

/** A repeatable list of single-value rows — every array field except \`bot.commands\`. */
function buildArrayEditor(field, value, onChange) {
  if (field.path === 'bot.commands') return buildCommandsEditor(field, value, onChange);

  const isNumeric = field.path === 'bot.channels';
  const container = document.createElement('div');
  const items = Array.isArray(value) ? [...value] : [];

  const list = document.createElement('div');
  list.className = 'config-array-list';

  const redraw = () => {
    list.textContent = '';
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = t('config.array.empty');
      list.appendChild(empty);
    }
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'config-array-row';
      const input = document.createElement('input');
      input.type = isNumeric ? 'number' : 'text';
      input.value = String(item);
      input.addEventListener('change', () => {
        items[i] = isNumeric ? Number(input.value) : input.value;
        onChange([...items]);
      });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary-btn';
      removeBtn.textContent = t('config.array.removeItem');
      removeBtn.addEventListener('click', () => {
        items.splice(i, 1);
        onChange([...items]);
        redraw();
      });
      row.appendChild(input);
      row.appendChild(removeBtn);
      list.appendChild(row);
    });
  };
  redraw();

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'secondary-btn';
  addBtn.textContent = t('config.array.addItem');
  addBtn.addEventListener('click', () => {
    items.push(isNumeric ? 0 : '');
    onChange([...items]);
    redraw();
  });

  container.appendChild(list);
  container.appendChild(addBtn);
  return container;
}

function renderResetButtonState(path) {
  // Matched by comparing the dataset property directly, not by building a CSS
  // attribute-selector string — config paths are schema-derived identifiers
  // today and never contain a quote, but a selector built by concatenation is
  // one property rename away from being a real injection point, for no
  // benefit over just comparing values.
  for (const btn of document.querySelectorAll('button.reset-btn')) {
    if (btn.dataset.path !== path) continue;
    const field = configFields.find((f) => f.path === path);
    btn.disabled = !field || (field.source !== 'ui' && !Object.prototype.hasOwnProperty.call(configPending, path));
  }
}

async function resetConfigField(field) {
  if (!window.confirm(t('config.resetConfirm', { field: fieldLabel(field) }))) return;
  try {
    // A confirm dialog always runs here (unlike saveConfig's, which is
    // conditional on the field being confirm-flagged), so confirm:true is
    // always sent — the server requires it only for a confirm-flagged path,
    // and sending it unconditionally is honest either way: the operator did
    // just click through a dialog.
    await api('/api/settings/reset', {
      method: 'POST',
      body: JSON.stringify({ path: field.path, confirm: true }),
    });
    delete configPending[field.path];
    showSuccess(t('config.resetDone'));
    await refreshConfig();
  } catch (err) {
    showError(t('config.resetError', { error: err.message || String(err) }));
  }
}

function buildFieldRow(field) {
  const row = document.createElement('div');
  row.className = 'config-field';

  const head = document.createElement('div');
  head.className = 'config-field-head';

  const labelWrap = document.createElement('div');
  const label = document.createElement('label');
  label.textContent = fieldLabel(field);
  labelWrap.appendChild(label);
  head.appendChild(labelWrap);

  const actions = document.createElement('div');
  actions.className = 'config-field-actions';

  const sourceChip = document.createElement('span');
  sourceChip.className = 'chip' + (field.source === 'ui' ? ' chip-ui' : '');
  sourceChip.textContent = t('config.source.' + field.source);
  actions.appendChild(sourceChip);

  if (field.fileOnly) {
    const fileOnlyChip = document.createElement('span');
    fileOnlyChip.className = 'chip';
    fileOnlyChip.textContent = t('config.fileOnly.badge');
    actions.appendChild(fileOnlyChip);
  } else if (field.restart) {
    const restartChip = document.createElement('span');
    restartChip.className = 'chip chip-restart';
    restartChip.textContent = t('config.restart.badge');
    actions.appendChild(restartChip);
  }

  if (!field.fileOnly) {
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'reset-btn';
    resetBtn.dataset.path = field.path;
    resetBtn.textContent = t('config.reset');
    resetBtn.disabled = field.source !== 'ui';
    resetBtn.addEventListener('click', () => resetConfigField(field));
    actions.appendChild(resetBtn);
  }

  head.appendChild(actions);
  row.appendChild(head);

  if (field.helpKey) {
    const help = document.createElement('p');
    help.className = 'field-help';
    help.textContent = t(field.helpKey);
    row.appendChild(help);
  }

  if (field.fileOnly) {
    const note = document.createElement('p');
    note.className = 'field-help';
    note.textContent = t('config.fileOnly.note');
    row.appendChild(note);
  }

  row.appendChild(buildFieldInput(field));
  return row;
}

function renderConfigSecrets() {
  const host = document.getElementById('config-secrets');
  host.textContent = '';
  const keys = Object.keys(configSecrets);
  if (keys.length === 0) return;

  const title = document.createElement('h3');
  title.textContent = t('config.secret.title');
  host.appendChild(title);
  const intro = document.createElement('p');
  intro.className = 'muted';
  intro.textContent = t('config.secret.intro');
  host.appendChild(intro);

  const dl = document.createElement('dl');
  for (const key of keys) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    const chip = document.createElement('span');
    chip.className = 'chip' + (configSecrets[key] ? ' chip-ui' : '');
    chip.textContent = configSecrets[key] ? t('config.secret.set') : t('config.secret.notSet');
    dd.appendChild(chip);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  host.appendChild(dl);
}

function renderConfigSections() {
  const host = document.getElementById('config-sections');
  host.textContent = '';

  const bySection = new Map();
  for (const field of configFields) {
    const section = field.path.split('.')[0];
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(field);
  }

  const order = [...CONFIG_SECTION_ORDER, ...[...bySection.keys()].filter((s) => !CONFIG_SECTION_ORDER.includes(s))];
  for (const section of order) {
    const fields = bySection.get(section);
    if (!fields || fields.length === 0) continue;
    const sectionEl = document.createElement('div');
    sectionEl.className = 'config-section';
    const heading = document.createElement('h3');
    heading.textContent = t('config.section.' + section) === 'config.section.' + section
      ? humanizeFieldLabel(section)
      : t('config.section.' + section);
    sectionEl.appendChild(heading);
    for (const field of fields) sectionEl.appendChild(buildFieldRow(field));
    host.appendChild(sectionEl);
  }
}

async function refreshConfig() {
  document.getElementById('config-error').textContent = '';
  // Shown only until the fetch settles — a real settings read crosses this
  // process's config layers and, on the FIRST load, walks the whole schema,
  // so a blank tab for a moment is worth explaining rather than leaving silent.
  const sections = document.getElementById('config-sections');
  if (configFields.length === 0) {
    sections.textContent = '';
    const loading = document.createElement('p');
    loading.className = 'muted';
    loading.textContent = t('config.loading');
    sections.appendChild(loading);
  }
  try {
    const data = await api('/api/settings', { method: 'GET' });
    configFields = data.fields;
    configSecrets = data.secrets || {};
    renderConfigSecrets();
    renderConfigSections();
    updateConfigToolbar();
    renderRestartBanner();
  } catch (err) {
    sections.textContent = '';
    document.getElementById('config-error').textContent =
      t('config.loadError') + ' ' + (err.message || String(err));
  }
}

/**
 * A confirmation prompt for one field change, using a specific message for the
 * handful of fields where a generic one would not convey the real stakes.
 */
function confirmMessageFor(field, from, to) {
  if (field.path === 'posting.dryRun') {
    return to === false ? t('config.confirm.dryRunOff') : t('config.confirm.dryRunOn');
  }
  if (field.path === 'node.network') return t('config.confirm.network');
  return t('config.confirm.generic', { field: fieldLabel(field), from: String(from), to: String(to) });
}

async function saveConfig() {
  const dirty = configFields.filter(fieldIsDirty);
  if (dirty.length === 0) return;

  let confirmed = false;
  for (const field of dirty) {
    if (!field.confirm) continue;
    const proceed = window.confirm(confirmMessageFor(field, field.value, configPending[field.path]));
    if (!proceed) return;
    confirmed = true;
  }

  // A field cleared back to \`undefined\` (see \`buildFieldInput\`) cannot travel in
  // the bulk PUT at all: JSON has no way to encode "this key is present with
  // value undefined", so JSON.stringify silently DROPS such a property —
  // {"profile":{bio:undefined}} becomes the wire payload {"profile":{}}, which
  // the server then sees as the leaf path "profile" (an empty object is a leaf
  // named after its parent) rather than "profile.bio", and rejects as an
  // unrecognised setting. Worse when it shares a save with a sibling edit: the
  // sibling's change goes through, the clear silently does not, and "Saved."
  // is shown for an edit that did not fully happen.
  //
  // The reset endpoint already does exactly "make this path stop being
  // overridden" — which is what clearing an override-sourced field to unset
  // actually means — so a cleared field is routed there instead of into the
  // bulk changes object. Harmless for a field with no existing override:
  // resetting a path nothing overrides is a documented no-op.
  const toReset = dirty.filter((f) => configPending[f.path] === undefined);
  const toSave = dirty.filter((f) => configPending[f.path] !== undefined);

  const changes = {};
  for (const field of toSave) setNestedValue(changes, field.path, configPending[field.path]);

  const btn = document.getElementById('config-save-btn');
  btn.disabled = true;
  btn.textContent = t('config.saving');
  try {
    const restartPending = [];
    for (const field of toReset) {
      const result = await api('/api/settings/reset', {
        method: 'POST',
        body: JSON.stringify({ path: field.path }),
      });
      restartPending.push(...(result.restartPending || []));
    }
    if (toSave.length > 0) {
      // Sent only when a dialog actually ran — the server requires it exactly
      // when it would have, so this never claims a confirmation that did not
      // happen.
      const body = confirmed ? { changes, confirm: true } : { changes };
      const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
      restartPending.push(...(result.restartPending || []));
    }
    configPending = {};
    showSuccess(t('config.saved'));
    addRestartPending(restartPending);
    await refreshConfig();
  } catch (err) {
    showError(t('config.saveError', { error: err.message || String(err) }));
    // Whatever succeeded before the failing step is already committed
    // server-side — a full re-fetch shows the real state rather than leaving
    // the form claiming edits that partially landed.
    await refreshConfig();
  } finally {
    btn.textContent = t('config.save');
  }
}


function discardConfigChanges() {
  configPending = {};
  renderConfigSections();
  updateConfigToolbar();
}

/* ─────────────────────────── Audit log tab ─────────────────────────── */

let auditEvents = null; // null = never fetched, [] = fetched and genuinely empty

function auditOutcomeLabel(outcome) {
  if (outcome === 'applied') return t('audit.outcome.applied');
  if (outcome === 'restart-pending') return t('audit.outcome.restartPending');
  if (outcome === 'rejected') return t('audit.outcome.rejected');
  return outcome;
}

function auditChangeSummary(event) {
  if (event.reason) return event.reason;
  if (event.action) return event.action;
  if (Object.prototype.hasOwnProperty.call(event, 'from') || Object.prototype.hasOwnProperty.call(event, 'to')) {
    return JSON.stringify(event.from) + ' → ' + JSON.stringify(event.to);
  }
  return '';
}

function renderAuditTable() {
  // Not yet fetched — nothing to render, and rendering an empty state here
  // would be indistinguishable from "fetched and genuinely empty", which is
  // exactly the ambiguity this null sentinel exists to remove.
  if (auditEvents === null) return;

  const actorFilter = document.getElementById('audit-filter-actor').value.trim().toLowerCase();
  const pathFilter = document.getElementById('audit-filter-path').value.trim().toLowerCase();
  const outcomeFilter = document.getElementById('audit-filter-outcome').value;

  const filtered = auditEvents.filter((e) => {
    if (actorFilter && !(String(e.actor || '').toLowerCase().includes(actorFilter))) return false;
    if (pathFilter && !(String(e.path || '').toLowerCase().includes(pathFilter))) return false;
    if (outcomeFilter && e.outcome !== outcomeFilter) return false;
    return true;
  });

  const table = document.getElementById('audit-table');
  const tbody = document.getElementById('audit-tbody');
  const empty = document.getElementById('audit-empty');
  tbody.textContent = '';

  if (filtered.length === 0) {
    table.hidden = true;
    empty.hidden = false;
    empty.textContent = (auditEvents || []).length === 0 ? t('audit.empty') : t('audit.noMatch');
    return;
  }
  table.hidden = false;
  empty.hidden = true;

  for (const event of filtered) {
    const tr = document.createElement('tr');
    const cells = [
      event.ts ? new Date(event.ts).toLocaleString(locale) : '',
      event.actor || '',
      event.path || '',
      auditOutcomeLabel(event.outcome),
      auditChangeSummary(event),
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

async function refreshAudit() {
  document.getElementById('audit-error').textContent = '';
  if (auditEvents === null) {
    const empty = document.getElementById('audit-empty');
    empty.hidden = false;
    empty.textContent = t('audit.loading');
  }
  try {
    const data = await api('/api/audit', { method: 'GET' });
    auditEvents = data.events || [];
    renderAuditTable();
  } catch (err) {
    // Clear the "Loading…" placeholder before showing the error, or a
    // transient failure leaves BOTH the real error banner and a permanently
    // stuck loading message on screen — mirroring what refreshConfig already
    // does in its own catch block.
    document.getElementById('audit-empty').hidden = true;
    document.getElementById('audit-error').textContent =
      t('audit.loadError') + ' ' + (err.message || String(err));
  }
}

/**
 * Re-render whatever the currently active tab already has in memory, in the
 * new language — called on a locale switch so text does not wait for the next
 * network refresh to change.
 */
function refreshLocalizedViews() {
  applyStaticI18n();
  // null specifically means "never fetched" — re-rendering it would show a
  // wrong "not enabled" state on an Account tab nobody has opened yet.
  if (lastBotIdentity !== null) renderBotIdentity(lastBotIdentity);
  if (configFields.length > 0) {
    renderConfigSecrets();
    renderConfigSections();
    updateConfigToolbar();
    renderRestartBanner();
  }
  if (auditEvents !== null) renderAuditTable();
}

async function ackBackup() {
  const btn = document.getElementById('backup-ack-btn');
  btn.disabled = true;
  try {
    await api('/api/wallet/ack-backup', { method: 'POST', body: '{}' });
    backupBanner.hidden = true;
  } catch (err) {
    showError(err.message || String(err));
    btn.disabled = false;
  }
}

document.getElementById('login-btn').addEventListener('click', login);
document.getElementById('logout-btn').addEventListener('click', logout);
document.getElementById('profile-btn').addEventListener('click', updateProfile);
document.getElementById('avatar-file-input').addEventListener('change', onAvatarFileChange);
document.getElementById('avatar-upload-btn').addEventListener('click', uploadSelectedAvatar);
document.getElementById('display-name').addEventListener('input', () => {
  displayNameDirty = true;
});
document.getElementById('register-btn').addEventListener('click', register);
document.getElementById('backup-ack-btn').addEventListener('click', ackBackup);
document.getElementById('refresh-dashboard-btn').addEventListener('click', refreshDashboard);
document.getElementById('config-save-btn').addEventListener('click', saveConfig);
document.getElementById('config-discard-btn').addEventListener('click', discardConfigChanges);
document.getElementById('restart-banner-dismiss').addEventListener('click', () => {
  savePersistedRestartPending([]);
  renderRestartBanner();
});
document.getElementById('audit-filter-actor').addEventListener('input', renderAuditTable);
document.getElementById('audit-filter-path').addEventListener('input', renderAuditTable);
document.getElementById('audit-filter-outcome').addEventListener('change', renderAuditTable);
document.getElementById('audit-filter-clear').addEventListener('click', () => {
  document.getElementById('audit-filter-actor').value = '';
  document.getElementById('audit-filter-path').value = '';
  document.getElementById('audit-filter-outcome').value = '';
  renderAuditTable();
});
for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}
for (const btn of document.querySelectorAll('.chart-metric-btn')) {
  btn.addEventListener('click', () => selectChartMetric(btn.dataset.metric));
}
for (const btn of document.querySelectorAll('.range-btn')) {
  btn.addEventListener('click', () => selectChartRange(btn.dataset.range));
}

// Ask whether we have a session BEFORE loading anything that needs one.
//
// /api/auth/state always answers 200, so the common "not logged in yet" case
// costs no console errors. Probing with /api/status instead meant three
// guaranteed 401s on every page load — status, posts and chart — which is
// indistinguishable from a real fault when an operator opens the console to
// investigate something else.
api('/api/auth/state', { method: 'GET' })
  .then((state) => {
    if (!state.authenticated) {
      // Login screen stays up; nothing else is worth requesting yet.
      loginCard.hidden = false;
      panel.hidden = true;
      return;
    }
    // Run independently rather than chained: /api/posts has no dependency on
    // whatever /api/status might fail on, so a status failure (most likely the
    // chain being unreachable) must not silently prevent the post list from
    // ever loading.
    refresh().catch((err) => {
      if (err && err.status !== 401) showError(err.message || String(err));
    });
    refreshPosts();
    refreshChart();
    renderRestartBanner();
  })
  .catch((err) => {
    // The probe itself failing is a real fault — the server is unreachable or
    // broken — and unlike a 401 it is worth saying so.
    showError(err.message || String(err));
  });
`;
}

/** Escape the handful of characters that matter inside HTML text content. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderPage, renderScript } from './ui.js';

/**
 * Regression coverage for the panel's browser UI.
 *
 * This whole layer had ZERO tests before the bug this file guards against
 * shipped: `<p id="error">` was nested inside `#login-card`, which gets
 * `hidden = true` the moment login succeeds. Every `showError()` call after
 * that point — including a genuine "Profile updated." success message —
 * wrote into an element the browser was no longer rendering at all. From the
 * operator's side, clicking "Update profile" looked like it silently did
 * nothing, even on requests that fully succeeded server-side.
 *
 * `renderPage`/`renderScript` return plain strings (no framework, no build
 * step, by design — see the module comment in ui.ts), so these are
 * string/structural checks rather than a real DOM, matching that same
 * dependency-free philosophy for the tests.
 */

const page = renderPage({ botAddress: 'klv1test', network: 'testnet' });
const script = renderScript();

/** The page's top-level `<div id="...">...</div>` blocks, by id, non-nested. */
function topLevelDivs(html: string): Map<string, string> {
  const divs = new Map<string, string>();
  const re = /<div id="([a-z-]+)"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const id = match[1]!;
    const start = match.index;
    // Balanced scan for the matching close tag, so nested <div>s (there are
    // none inside these specific blocks today, but the scan doesn't assume
    // that) don't terminate early on the first </div>.
    let depth = 1;
    let i = start + match[0].length;
    const tagRe = /<div\b[^>]*>|<\/div>/g;
    tagRe.lastIndex = i;
    let t: RegExpExecArray | null;
    while (depth > 0 && (t = tagRe.exec(html)) !== null) {
      depth += t[0].startsWith('</') ? -1 : 1;
      i = tagRe.lastIndex;
    }
    divs.set(id, html.slice(start, i));
  }
  return divs;
}

describe('renderPage structure', () => {
  it('places the status/error message element OUTSIDE both the login and panel containers', () => {
    // The regression itself: an element inside a container that later gets
    // `hidden = true` is unreachable from that point on, no matter what JS
    // later writes into it.
    const divs = topLevelDivs(page);
    expect(divs.get('login-card')).toBeDefined();
    expect(divs.get('panel')).toBeDefined();
    expect(divs.get('login-card')).not.toContain('id="error"');
    expect(divs.get('panel')).not.toContain('id="error"');
  });

  it('has exactly one #error element, so there is only one place messages can go missing', () => {
    const matches = page.match(/id="error"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('places the backup banner outside the panel container too, for the same reason', () => {
    // walletBackupPending can legitimately be true while `#panel` is what's
    // showing (see server.ts's /api/status) — the banner must not be nested
    // inside something that could independently hide it.
    const divs = topLevelDivs(page);
    expect(divs.get('panel')).not.toContain('id="backup-banner"');
  });

  it('every element id the script looks up actually exists in the rendered page', () => {
    // A generic guard against the whole bug class: a getElementById() call
    // aimed at an id that doesn't exist (a typo, a removed element) returns
    // null and silently no-ops or throws deep in an event handler — exactly
    // the "nothing happens" failure mode, just from a different cause.
    const ids = [...script.matchAll(/getElementById\('([a-z-]+)'\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(page).toContain(`id="${id}"`);
    }
  });
});

describe('renderScript success/error feedback', () => {
  it('is syntactically valid JavaScript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'newsbot-ui-script-'));
    try {
      const file = join(dir, 'app.js');
      writeFileSync(file, script);
      expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defines a distinct success path, not just showError, for a genuinely successful action', () => {
    expect(script).toContain('function showSuccess');
  });

  it('calls showSuccess on a successful profile update', () => {
    const fn = extractFunction(script, 'updateProfile');
    expect(fn).toMatch(/showSuccess\(/);
    // The specific regression: it must not silently succeed with no call to
    // either message function at all.
    expect(fn).toMatch(/showSuccess|showError/);
  });

  it('calls showSuccess (not showError) for a successful registration', () => {
    const fn = extractFunction(script, 'register');
    expect(fn).toMatch(/showSuccess\(t\('account\.registration\.success'/);
  });

  it('reports both other register outcomes (already-registered, insufficient-funds), not just the happy path', () => {
    const fn = extractFunction(script, 'register');
    expect(fn).toContain('already-registered');
    expect(fn).toContain('insufficient-funds');
  });

  it('refuses to submit an empty display name rather than silently no-op-ing', () => {
    const fn = extractFunction(script, 'updateProfile');
    expect(fn).toMatch(/if \(!displayName\)/);
  });

  it('clears the message on logout, so a stale success/error doesn\'t linger past a state change', () => {
    const fn = extractFunction(script, 'logout');
    expect(fn).toMatch(/showError\(''\)/);
  });
});

describe('dashboard tab', () => {
  it('is the default visible tab, with Settings starting hidden', () => {
    // Direct check of the actual requirement: "below topics as default
    // dashboard, while the settings are an extra tab/page".
    const dashboardDiv = /<div id="tab-dashboard"[^>]*>/.exec(page)![0];
    const settingsDiv = /<div id="tab-settings"[^>]*>/.exec(page)![0];
    expect(dashboardDiv).not.toContain('hidden');
    expect(settingsDiv).toContain('hidden');
  });

  it('has exactly one rail button per tab-content div, matching data-tab to id', () => {
    const buttons = [...page.matchAll(/class="rail-item[^"]*" id="tab-btn-([a-z]+)"/g)].map((m) => m[1]);
    const contents = [...page.matchAll(/<div id="tab-([a-z]+)" class="tab-content"/g)].map((m) => m[1]);
    expect(buttons.sort()).toEqual(contents.sort());
  });

  it('the dashboard rail button starts active, matching the visible content', () => {
    expect(page).toMatch(/class="rail-item active" id="tab-btn-dashboard"/);
  });

  it('switchTab toggles both the active class and the hidden state together', () => {
    const fn = extractFunction(script, 'switchTab');
    expect(fn).toContain("classList.toggle('active'");
    expect(fn).toMatch(/\.hidden\s*=/);
  });

  it('fetches /api/posts and never uses innerHTML to render remote-derived post content', () => {
    const fn = extractFunction(script, 'refreshPosts');
    expect(fn).toContain("api('/api/posts'");
    expect(script).not.toContain('innerHTML');
  });

  it('sorts hashtags by descending count, not insertion order', () => {
    const fn = extractFunction(script, 'refreshPosts');
    expect(fn).toMatch(/sort\(\(a, b\) => b\[1\] - a\[1\]\)/);
  });

  it('refreshes both status and posts after a successful login', () => {
    const fn = extractFunction(script, 'login');
    expect(fn).toMatch(/await refresh\(\)/);
    expect(fn).toMatch(/await refreshPosts\(\);/);
  });

  it('refreshes posts even when the status refresh fails for a reason other than 401', () => {
    // The two must run independently, not chained — a status/chain failure
    // has no bearing on whether /api/posts would succeed, and must not
    // silently prevent it from ever being tried.
    const fn = extractFunction(script, 'login');
    expect(fn).not.toMatch(/await refresh\(\);\s*await refreshPosts\(\);/);
    expect(fn).toMatch(/refresh\(\)\.catch/);
  });

  it('switching to the dashboard tab refreshes its data', () => {
    const fn = extractFunction(script, 'switchTab');
    expect(fn).toMatch(/refreshPosts\(\)/);
  });

  it('the initial page-load sequence also runs refresh and refreshPosts independently, not chained', () => {
    // Same reasoning as login(): a top-level `refresh().then(refreshPosts)`
    // would mean a chain-unreachable /api/status failure on first load
    // prevents the post list from ever appearing, even though /api/posts
    // doesn't depend on it at all.
    expect(script).not.toMatch(/refresh\(\)\s*\.then\(refreshPosts\)/);
  });

  it('shows a translated fallback rather than a broken date/NaN when there are no posts yet', () => {
    const fn = extractFunction(script, 'refreshPosts');
    expect(fn).toContain("t('posts.never')");
  });

  it('uses roughly 80% of the screen width rather than a fixed narrow column', () => {
    expect(page).toMatch(/width:\s*80%/);
  });

  it('links a post title to its ogmara.org detail page, using a validated msgId', () => {
    const constDecl = /const MSG_ID_RE = [^;]+;/.exec(script)![0];
    const fn = extractFunction(script, 'newsPostUrl');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const newsPostUrl = new Function(`${constDecl}\nreturn (${fn});`)();
    const validId = 'a'.repeat(64);
    expect(newsPostUrl(validId)).toBe('https://ogmara.org/app/#/news/' + validId);
    // A node-supplied msgId is untrusted input — anything not exactly 64 hex
    // chars must not become a link at all (renderPost falls back to plain
    // text), the same defensive posture web/src/lib/share.ts's own
    // sanitizeMsgId takes.
    expect(newsPostUrl('not-hex')).toBeNull();
    expect(newsPostUrl('a'.repeat(63))).toBeNull();
    expect(newsPostUrl('a'.repeat(65))).toBeNull();
    expect(newsPostUrl('')).toBeNull();
  });

  it('renderPost opens the link in a new tab without granting it window.opener', () => {
    const fn = extractFunction(script, 'renderPost');
    expect(fn).toContain("target = '_blank'");
    expect(fn).toMatch(/rel = ['"]noopener noreferrer['"]/);
  });

  it('formatRelativeTime never divides by zero or returns NaN-shaped output for "now"', () => {
    // Executed for real, not just pattern-matched — this one is pure and
    // side-effect-free, so there's no reason to settle for a string check.
    const fn = extractFunction(script, 'formatRelativeTime');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const formatRelativeTime = new Function(`return (${fn});`)();
    expect(formatRelativeTime(Date.now())).toBe('just now');
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('5 minutes ago');
    expect(formatRelativeTime(Date.now() - 60_000)).toBe('1 minute ago');
    expect(formatRelativeTime(Date.now() - 3 * 3_600_000)).toBe('3 hours ago');
    expect(formatRelativeTime(Date.now() - 2 * 86_400_000)).toBe('2 days ago');
  });
});

describe('engagement history chart', () => {
  it('is the first content section inside the dashboard tab, right after the toolbar', () => {
    const dashboardDiv = /<div id="tab-dashboard"[^>]*>([\s\S]*?)<div id="tab-settings"/.exec(page);
    expect(dashboardDiv).not.toBeNull();
    const dashboardStart = dashboardDiv![1]!.trimStart();
    expect(dashboardStart.startsWith('<div class="dashboard-toolbar">')).toBe(true);
    // The chart itself is the first thing after the toolbar — still "first
    // part of the dashboard" in the sense that matters (before quick-stats,
    // posts, hashtags), just not literally byte zero of the tab.
    const afterToolbar = dashboardStart.slice(dashboardStart.indexOf('</div>') + '</div>'.length).trimStart();
    expect(afterToolbar.startsWith('<div class="chart-card">')).toBe(true);
  });

  it('has one metric button per reactions/reposts/comments, and one range button per monthly/yearly/overall', () => {
    for (const metric of ['reactions', 'reposts', 'comments']) {
      expect(page).toContain(`data-metric="${metric}"`);
    }
    for (const range of ['month', 'year', 'all']) {
      expect(page).toContain(`data-range="${range}"`);
    }
  });

  it("the chart's own metric/range buttons don't collide with the dashboard/settings tab switcher", () => {
    // A shared `.rail-item` class here would mean the generic
    // `document.querySelectorAll('.rail-item')` click handler (wired to
    // switchTab) also fires for these buttons, calling switchTab(undefined)
    // since they carry data-metric/data-range, not data-tab — which would
    // hide every tab-content pane. Distinct classes are load-bearing, not
    // cosmetic.
    const metricButtons = /<button class="([^"]*)"[^>]*data-metric=/.exec(page);
    const rangeButtons = /<button class="([^"]*)"[^>]*data-range=/.exec(page);
    expect(metricButtons![1]).not.toMatch(/\brail-item\b/);
    expect(rangeButtons![1]).not.toMatch(/\brail-item\b/);
  });

  it('minMax never uses Math.min(...arr)/Math.max(...arr), which blows the call stack on a large array', () => {
    const fn = extractFunction(script, 'minMax');
    expect(fn).not.toMatch(/Math\.(min|max)\(\.\.\./);
  });

  it('renderChart clears the SVG via replaceChildren, never innerHTML', () => {
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toContain('replaceChildren()');
  });

  it('shows the empty state when there are fewer than two points in the selected range', () => {
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toMatch(/points\.length < 2/);
  });

  it('refreshChart fetches /api/stats-history and never uses innerHTML', () => {
    const fn = extractFunction(script, 'refreshChart');
    expect(fn).toContain("api('/api/stats-history'");
    expect(script).not.toContain('innerHTML');
  });

  it('refreshChart clears any stale chart and hides the empty-state text on a fetch failure, rather than showing both messages at once', () => {
    const fn = extractFunction(script, 'refreshChart');
    expect(fn).toMatch(/catch[\s\S]*replaceChildren\(\)/);
    expect(fn).toMatch(/catch[\s\S]*chart-empty['"]\)\.hidden = true/);
  });

  it('renderChart matches the SVG viewBox to its actual rendered width, so the polyline and labels are never stretched non-uniformly', () => {
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toContain('svg.clientWidth');
    expect(fn).toMatch(/setAttribute\('viewBox'/);
  });

  it('refreshChart is called alongside refreshPosts on login, tab switch, and initial load', () => {
    expect(extractFunction(script, 'login')).toMatch(/await refreshChart\(\);/);
    expect(extractFunction(script, 'switchTab')).toMatch(/refreshChart\(\)/);
    // Initial load: both run independently at the bottom of the script, not
    // just inside a function — same "must not be chained" reasoning as
    // refreshPosts already carries for this exact spot.
    const tail = script.slice(script.lastIndexOf('refresh().catch'));
    expect(tail).toContain('refreshPosts();');
    expect(tail).toContain('refreshChart();');
  });

  it('wires click listeners for both the metric and range buttons', () => {
    expect(script).toContain("querySelectorAll('.chart-metric-btn')");
    expect(script).toContain("querySelectorAll('.range-btn')");
  });
});

describe('chart per-period deltas (Monthly/Yearly bucketing)', () => {
  // Snapshots store a CUMULATIVE lifetime total (statsHistory.ts). Plotting
  // that raw under "Monthly" — a day-labeled view — looked like a flat line
  // that jumps once, which read as "reactions are summarizing" rather than
  // showing per-day activity. bucketDeltaSeries converts the cumulative
  // series into per-period NEW activity; these tests execute the real
  // function against synthetic snapshot data rather than just pattern-
  // matching the source, since the bucketing math is exactly the part that
  // was wrong. (User feedback, 0.15.0.)
  function loadBucketDeltaSeries() {
    const bucketKeyFn = extractFunction(script, 'bucketKey');
    const bucketDeltaSeriesFn = extractFunction(script, 'bucketDeltaSeries');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`${bucketKeyFn}\n${bucketDeltaSeriesFn}\nreturn bucketDeltaSeries;`)();
  }

  function loadFormatChartDate() {
    const fn = extractFunction(script, 'formatChartDate');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`return (${fn});`)();
  }

  const DAY = 86_400_000;

  it('computes per-day new activity as the delta between the last snapshot of each day, not the raw cumulative total', () => {
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime(); // arbitrary local-time anchor, matching bucketKey's local getters
    const history = [
      { timestamp: day0 + 1000, totalReactions: 10 },
      { timestamp: day0 + 2000, totalReactions: 12 }, // still day 0 — only the LAST value of the day should count
      { timestamp: day0 + DAY + 1000, totalReactions: 15 }, // day 1
      { timestamp: day0 + 2 * DAY + 1000, totalReactions: 15 }, // day 2, no new reactions at all
    ];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points.map((p: any) => p.y)).toEqual([12, 3, 0]);
  });

  it('nets the first bucket in the window against the last snapshot BEFORE the window, not against zero', () => {
    // Without this, the very first visible day would show its entire
    // lifetime-to-date total as "new today" every time the window slides —
    // e.g. a 30-day-old bot would show day -30's cumulative total as a
    // single-day spike once it first entered the Monthly window.
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime();
    const history = [
      { timestamp: day0 - 5 * DAY, totalReactions: 5 }, // before the window — the real baseline
      { timestamp: day0 + 1000, totalReactions: 12 }, // first day inside the window
      { timestamp: day0 + DAY + 1000, totalReactions: 20 },
    ];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points.map((p: any) => p.y)).toEqual([7, 8]); // 12-5, then 20-12 — never 12-0
  });

  it('treats the very first snapshot ever as its own baseline (0), not an error', () => {
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime();
    const history = [{ timestamp: day0 + 1000, totalReactions: 9 }];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points).toEqual([{ timestamp: day0 + 1000, y: 9 }]);
  });

  it('allows a negative delta (net un-reactions within a period) rather than clamping it away', () => {
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime();
    const history = [
      { timestamp: day0 + 1000, totalReactions: 20 },
      { timestamp: day0 + DAY + 1000, totalReactions: 15 }, // net decrease
    ];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points[1].y).toBe(-5);
  });

  it('finds the correct baseline even when history is not sorted ascending', () => {
    // bucketDeltaSeries must not silently depend on statsHistory.ts's own
    // sort-on-append guarantee — a hand-edited or externally rewritten
    // stats-history.json could arrive out of order. (Code audit, 0.15.0.)
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime();
    const history = [
      { timestamp: day0 + 1000, totalReactions: 50 }, // in-window, but listed FIRST despite being later
      { timestamp: day0 - 5 * DAY, totalReactions: 5 }, // the real pre-window baseline, listed SECOND
    ];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points).toEqual([{ timestamp: day0 + 1000, y: 45 }]); // 50 - 5, never 50 - 0
  });

  it('picks the later snapshot within a bucket even when two share the exact same millisecond', () => {
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime();
    const history = [
      { timestamp: day0 + 1000, totalReactions: 5 },
      { timestamp: day0 + 1000, totalReactions: 9 }, // identical timestamp, listed second — should win
    ];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points).toEqual([{ timestamp: day0 + 1000, y: 9 }]);
  });

  it('buckets by calendar month for the Yearly granularity, not by day', () => {
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const monthStart = new Date(2026, 0, 1).getTime(); // Jan 2026, local time
    const history = [
      { timestamp: new Date(2026, 0, 5).getTime(), totalReactions: 10 },
      { timestamp: new Date(2026, 0, 25).getTime(), totalReactions: 18 }, // same month as above
      { timestamp: new Date(2026, 1, 3).getTime(), totalReactions: 30 }, // February
    ];
    const points = bucketDeltaSeries(history, monthStart - DAY, 'month', 'totalReactions');
    expect(points.map((p: any) => p.y)).toEqual([18, 12]); // Jan: 18-0, Feb: 30-18
  });

  it("renderChart only applies the raw-cumulative path (no bucketing) for the 'all' range", () => {
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toMatch(/if \(granularity === 'raw'\) \{\s*\n\s*points = chartHistory\.map/);
  });

  it('only forces the y-axis floor to 0 when NOT plotting deltas — a bucketed delta must be able to show negative', () => {
    // Tracked via the usingDeltas flag, not "granularity === raw" directly —
    // the sparse-data fallback (see below) also produces a cumulative
    // series even under a bucketed range, and that path needs the same
    // floor-at-0 treatment a true raw/Overall series gets.
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toMatch(/if \(!usingDeltas\) minY = Math\.min\(0, minY\);/);
  });

  it('falls back to raw within-window snapshots when bucketing yields fewer than 2 periods, instead of a blank chart', () => {
    // Regression coverage: a brand-new bot (or several same-day snapshots)
    // used to show "Not enough history yet" on Monthly/Yearly even with
    // real data on screen for every OTHER tab, because bucketing by
    // calendar day/month collapsed same-day data into a single point.
    // (Code audit, 0.15.0.)
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toMatch(/if \(bucketed\.length >= 2\)/);
    expect(fn).toContain('usingDeltas = true;');
    expect(fn).toMatch(/points = chartHistory\s*\n\s*\.filter\(\(s\) => s\.timestamp >= windowStart\)/);
  });

  it('snaps the window start to a bucket boundary before bucketing, so the first period is never partial', () => {
    // Regression coverage: without this, the leftmost bucket only covered
    // whatever fraction of the day/month happened to fall after
    // `now - windowMs`, undercounting it — reproduced at ~15x low for a
    // monthly bucket a few hours into the day. (Code audit, 0.15.0.)
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toContain('const windowStart = bucketStart(now - windowMs, granularity);');
  });

  it('labels the latest value as "so far" only when it is a still-in-progress bucketed period, not a cumulative total', () => {
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toMatch(/usingDeltas \? ys\[ys\.length - 1\] \+ ' so far' : String\(ys\[ys\.length - 1\]\)/);
  });

  it('formats a day bucket (and the raw/Overall path) as M/D', () => {
    const formatChartDate = loadFormatChartDate();
    const ms = new Date(2026, 7, 5, 12).getTime(); // Aug 5 2026, noon local time
    expect(formatChartDate(ms, 'day')).toBe('8/5');
    // 'raw' isn't a real branch in the function — it falls through to the
    // same numeric path as 'day', which is what the Overall range relies on.
    expect(formatChartDate(ms, 'raw')).toBe('8/5');
  });

  it('formats a month bucket using the environment\'s own locale formatting, not a hardcoded assumption', () => {
    // Comparing against the SAME toLocaleDateString call the production code
    // makes (rather than a hardcoded English-locale regex like /Aug.*2026/)
    // means this test passes under any runtime locale instead of failing
    // outside en-*/de-* environments while the real code is doing exactly
    // the right, locale-aware thing. (Code audit, 0.15.0.)
    const formatChartDate = loadFormatChartDate();
    const ms = new Date(2026, 7, 5, 12).getTime();
    const expected = new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    expect(formatChartDate(ms, 'month')).toBe(expected);
  });

  it('bucketStart snaps to the start of the calendar day or month, in local time', () => {
    const fn = extractFunction(script, 'bucketStart');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const bucketStart = new Function(`return (${fn});`)();
    const midDay = new Date(2026, 7, 15, 14, 30, 0).getTime(); // Aug 15 2026, 14:30 local
    expect(bucketStart(midDay, 'day')).toBe(new Date(2026, 7, 15, 0, 0, 0, 0).getTime());
    expect(bucketStart(midDay, 'month')).toBe(new Date(2026, 7, 1, 0, 0, 0, 0).getTime());
  });
});

describe('dashboard refresh button', () => {
  it('exists and is wired to a click listener', () => {
    expect(page).toContain('id="refresh-dashboard-btn"');
    expect(script).toContain("getElementById('refresh-dashboard-btn').addEventListener('click', refreshDashboard)");
  });

  it('reloads both posts and the chart, without a full page reload', () => {
    const fn = extractFunction(script, 'refreshDashboard');
    expect(fn).toContain('refreshPosts()');
    expect(fn).toContain('refreshChart(true)');
    expect(script).not.toContain('location.reload');
  });

  it('forces a brand-new snapshot rather than just re-reading the last one — the whole point of this button', () => {
    // Prior behavior: clicking Refresh re-fetched /api/stats-history, which
    // only reflects whatever the periodic (default 6h) scheduled snapshot
    // last recorded — the chart looked unchanged even right after a click.
    const fn = extractFunction(script, 'refreshDashboard');
    expect(fn).toContain('refreshChart(true)');
  });

  it('disables itself while the refresh is in flight, and re-enables afterward even on failure', () => {
    const fn = extractFunction(script, 'refreshDashboard');
    expect(fn).toMatch(/\.disabled = true/);
    expect(fn).toMatch(/finally[\s\S]*\.disabled = false/);
  });
});

describe('refreshChart force parameter', () => {
  it('POSTs /api/stats-history/refresh (forcing a new snapshot) only when force is true', () => {
    const fn = extractFunction(script, 'refreshChart');
    expect(fn).toContain("api('/api/stats-history/refresh', { method: 'POST'");
    expect(fn).toContain("api('/api/stats-history', { method: 'GET' }");
  });

  it('plain loads (login, tab switch, initial page load) never force a new snapshot', () => {
    // Only the button's own handler should ever call refreshChart(true) —
    // every routine load stays a cheap local read, since forcing a fresh
    // node aggregation on every tab switch would be needless extra load.
    expect(extractFunction(script, 'login')).toMatch(/refreshChart\(\);/);
    expect(extractFunction(script, 'switchTab')).toMatch(/refreshChart\(\);/);
    const tail = script.slice(script.lastIndexOf('refresh().catch'));
    expect(tail).toMatch(/refreshChart\(\);/);
  });
});

describe('profile: current display name and avatar', () => {
  it('switching to the Settings tab loads the current profile', () => {
    const fn = extractFunction(script, 'switchTab');
    expect(fn).toContain('refreshProfile()');
  });

  it('refreshProfile fetches /api/profile and never uses innerHTML', () => {
    const fn = extractFunction(script, 'refreshProfile');
    expect(fn).toContain("api('/api/profile'");
    expect(script).not.toContain('innerHTML');
  });

  it('only prefills the display-name input while it has not been edited this session (tracked via a dirty flag, not just emptiness)', () => {
    // A bare "is the input empty" check would re-clobber a value the
    // operator typed and then deleted back to empty. An explicit dirty flag
    // — set on the input's own 'input' event, cleared after a successful
    // save — is what actually distinguishes "never touched" from "touched
    // and then cleared." (Code audit, 0.14.0.)
    const fn = extractFunction(script, 'refreshProfile');
    expect(fn).toMatch(/if \(!displayNameDirty\)/);
    expect(script).toContain(
      "getElementById('display-name').addEventListener('input', () => {\n  displayNameDirty = true;\n});",
    );
    expect(extractFunction(script, 'updateProfile')).toContain('displayNameDirty = false;');
  });

  it('refreshes the sidebar header (silently) after a successful display-name save', () => {
    // REGRESSION GUARD (code audit): renderRailHeader() is only ever called
    // from inside refreshProfile() — without this, the sidebar kept showing
    // the OLD name until the operator happened to leave and re-enter the
    // Account tab, even though the save itself had already succeeded.
    // Silent, not a plain refreshProfile() call: a re-fetch failing here
    // must not stomp the success toast just shown for a save that, in
    // fact, already went through.
    const fn = extractFunction(script, 'updateProfile');
    expect(fn).toMatch(/refreshProfile\(\{\s*silent:\s*true\s*\}\)/);
    // Ordering: after the success toast and the dirty-flag clear, not before.
    expect(fn.indexOf('showSuccess(')).toBeLessThan(fn.indexOf('refreshProfile('));
  });

  it('builds the avatar preview URL from nodeUrl + the media endpoint, and hides it when there is no avatar', () => {
    const fn = extractFunction(script, 'refreshProfile');
    expect(fn).toContain("'/api/v1/media/'");
    expect(fn).toMatch(/preview\.hidden = true/);
  });

  it('never overwrites a locally staged, not-yet-uploaded avatar with the old server-confirmed one', () => {
    // Regression coverage: switching tabs away and back used to re-run
    // refreshProfile(), which unconditionally reset the preview to the OLD
    // avatar even while a newly picked file was still staged and the
    // Upload button still enabled — so what was on screen and what Upload
    // would actually publish could silently diverge. (Code audit, 0.14.0.)
    const fn = extractFunction(script, 'refreshProfile');
    expect(fn).toMatch(/if \(selectedAvatarFile === null\) \{/);
  });

  it('has a file input restricted to the four accepted image types', () => {
    expect(page).toMatch(
      /accept="image\/jpeg,image\/png,image\/gif,image\/webp"/,
    );
  });

  it('validates the chosen file client-side against the exact same four types the server allows, plus size', () => {
    // Previously `file.type.startsWith('image/')` — broader than the
    // server's allowlist, so an SVG (or anything else "image/*") would
    // preview locally before being rejected server-side with a confusing
    // error. (Code audit, 0.14.0.)
    expect(script).toContain(
      "const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];",
    );
    const fn = extractFunction(script, 'onAvatarFileChange');
    expect(fn).toContain('ALLOWED_AVATAR_TYPES.includes(file.type)');
    expect(fn).toMatch(/file\.size === 0/);
    expect(fn).toMatch(/file\.size > MAX_AVATAR_BYTES/);
    expect(fn).toContain('uploadBtn.disabled = true');
  });

  it('resets the preview when a chosen file is rejected, rather than leaving a stale image showing', () => {
    const fn = extractFunction(script, 'onAvatarFileChange');
    const rejectionBranches = fn.split('return;').slice(0, -1);
    for (const branch of rejectionBranches) {
      if (branch.includes('showError(')) expect(branch).toMatch(/preview\.hidden = true/);
    }
  });

  it('shows an immediate local preview via a blob: URL on file selection, revoking any previous one first', () => {
    const fn = extractFunction(script, 'onAvatarFileChange');
    expect(fn).toContain('setAvatarPreviewBlobUrl(URL.createObjectURL(file))');
    const revokeFn = extractFunction(script, 'setAvatarPreviewBlobUrl');
    expect(revokeFn).toContain('URL.revokeObjectURL(avatarPreviewBlobUrl)');
  });

  it('uploadSelectedAvatar reads the file as base64 and posts it to /api/profile/avatar', () => {
    const fn = extractFunction(script, 'uploadSelectedAvatar');
    expect(fn).toContain("api('/api/profile/avatar'");
    expect(fn).toContain('readAsDataURL');
    // Strips the "data:image/png;base64," prefix rather than sending the
    // whole data URL — the server expects raw base64.
    expect(fn).toMatch(/dataUrl\.slice\(dataUrl\.indexOf\(','\) \+ 1\)/);
  });

  it('re-fetches the confirmed profile after a successful upload, rather than trusting the local preview alone', () => {
    const fn = extractFunction(script, 'uploadSelectedAvatar');
    expect(fn).toMatch(/showSuccess\(/);
    expect(fn).toContain('refreshProfile()');
  });

  it('disables the upload button again after a successful upload, but leaves it enabled to retry after a failure', () => {
    const fn = extractFunction(script, 'uploadSelectedAvatar');
    expect(fn).toMatch(/finally[\s\S]*btn\.disabled = selectedAvatarFile === null/);
  });

  it('wires both the file-input change and the upload-button click', () => {
    expect(script).toContain(
      "getElementById('avatar-file-input').addEventListener('change', onAvatarFileChange)",
    );
    expect(script).toContain(
      "getElementById('avatar-upload-btn').addEventListener('click', uploadSelectedAvatar)",
    );
  });
});

/** Pull one `[async] function name() { ... }` body out of the generated script, braces balanced. */
function extractFunction(source: string, name: string): string {
  const start =
    source.indexOf(`async function ${name}(`) !== -1
      ? source.indexOf(`async function ${name}(`)
      : source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const bodyStart = source.indexOf('{', start);
  let depth = 1;
  let i = bodyStart + 1;
  while (depth > 0 && i < source.length) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start, i);
}

/**
 * Regression coverage for the settings-panel additions (Configuration and
 * Audit-log tabs, i18n runtime, theme switching). Uses the same
 * extract-and-execute pattern as the chart/date-math tests above: these are
 * plain functions with no framework dependency, so pulling the real source out
 * of the generated script and running it directly catches an actual behavior
 * regression, not just a change in wording.
 */
describe('restart banner: visible regardless of the active tab', () => {
  it('sits OUTSIDE every tab-content div, like the backup banner', () => {
    // Exactly the shape backup-banner's own regression test guards against:
    // an element nested inside a tab-content div is invisible the moment a
    // different tab is active — and this banner exists specifically so an
    // operator sees it no matter which tab they are looking at.
    const divs = topLevelDivs(page);
    for (const [id, html] of divs) {
      if (id.startsWith('tab-')) {
        expect(html, `#${id} must not contain the restart banner`).not.toContain('id="restart-banner"');
      }
    }
    expect(page).toContain('id="restart-banner"');
  });

  it('is a sibling of backup-banner, not nested inside #panel', () => {
    const bannerIdx = page.indexOf('id="restart-banner"');
    const panelIdx = page.indexOf('id="panel"');
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeLessThan(panelIdx);
  });
});

describe('setNestedValue', () => {
  function load(): (obj: unknown, path: string, value: unknown) => void {
    const fn = extractFunction(script, 'setNestedValue');
    return new Function(`${fn}\nreturn setNestedValue;`)();
  }

  it('writes a top-level path', () => {
    const setNestedValue = load();
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'dryRun', true);
    expect(obj).toEqual({ dryRun: true });
  });

  it('creates intermediate objects for a nested path', () => {
    const setNestedValue = load();
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'bot.rateLimit.perWalletPerMinute', 5);
    expect(obj).toEqual({ bot: { rateLimit: { perWalletPerMinute: 5 } } });
  });

  it('merges a second path under the same parent without clobbering the first', () => {
    const setNestedValue = load();
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'bot.enabled', true);
    setNestedValue(obj, 'bot.handle', 'x');
    expect(obj).toEqual({ bot: { enabled: true, handle: 'x' } });
  });

  it('overwrites a non-object intermediate rather than throwing', () => {
    // Defensive: this builds a fresh `changes` object each save from scratch,
    // so a stale non-object at an intermediate key should never occur in
    // practice — but a throw here would abort an otherwise-valid save.
    const setNestedValue = load();
    const obj: Record<string, unknown> = { bot: 'not an object yet' };
    setNestedValue(obj, 'bot.enabled', true);
    expect(obj).toEqual({ bot: { enabled: true } });
  });
});

describe('fieldIsDirty / fieldCurrentValue', () => {
  function load(): {
    fieldIsDirty: (f: { path: string; value: unknown }) => boolean;
    fieldCurrentValue: (f: { path: string; value: unknown }) => unknown;
  } {
    const currentFn = extractFunction(script, 'fieldCurrentValue');
    const dirtyFn = extractFunction(script, 'fieldIsDirty');
    return new Function(
      'configPending',
      `${currentFn}\n${dirtyFn}\nreturn { fieldIsDirty, fieldCurrentValue };`,
    )({});
  }

  it('is not dirty when nothing has been edited', () => {
    const { fieldIsDirty } = load();
    expect(fieldIsDirty({ path: 'posting.dryRun', value: true })).toBe(false);
  });

  it('is dirty once a DIFFERENT value is pending', () => {
    const currentFn = extractFunction(script, 'fieldCurrentValue');
    const dirtyFn = extractFunction(script, 'fieldIsDirty');
    const pending = { 'posting.dryRun': false };
    const { fieldIsDirty, fieldCurrentValue } = new Function(
      'configPending',
      `${currentFn}\n${dirtyFn}\nreturn { fieldIsDirty, fieldCurrentValue };`,
    )(pending);
    const field = { path: 'posting.dryRun', value: true };
    expect(fieldCurrentValue(field)).toBe(false); // shows the PENDING edit
    expect(fieldIsDirty(field)).toBe(true);
  });

  it('is NOT dirty when the pending edit matches the original — editing back counts as clean', () => {
    const currentFn = extractFunction(script, 'fieldCurrentValue');
    const dirtyFn = extractFunction(script, 'fieldIsDirty');
    const pending = { 'posting.maxPostsPerHour': 3 };
    const { fieldIsDirty } = new Function(
      'configPending',
      `${currentFn}\n${dirtyFn}\nreturn { fieldIsDirty, fieldCurrentValue };`,
    )(pending);
    expect(fieldIsDirty({ path: 'posting.maxPostsPerHour', value: 3 })).toBe(false);
  });

  it('compares by VALUE (JSON), not by reference — an array edited back to an equal one is clean', () => {
    const currentFn = extractFunction(script, 'fieldCurrentValue');
    const dirtyFn = extractFunction(script, 'fieldIsDirty');
    const pending = { 'bot.channels': [7, 8] };
    const { fieldIsDirty } = new Function(
      'configPending',
      `${currentFn}\n${dirtyFn}\nreturn { fieldIsDirty, fieldCurrentValue };`,
    )(pending);
    expect(fieldIsDirty({ path: 'bot.channels', value: [7, 8] })).toBe(false);
  });
});

describe('humanizeFieldLabel', () => {
  function load(): (path: string) => string {
    const fn = extractFunction(script, 'humanizeFieldLabel');
    return new Function(`${fn}\nreturn humanizeFieldLabel;`)();
  }

  it('splits camelCase and capitalises the first letter, for a path no module labelled', () => {
    const humanizeFieldLabel = load();
    expect(humanizeFieldLabel('posting.maxPostsPerHour')).toBe('Max Posts Per Hour');
  });

  it('leaves an already-lowercase single word alone but capitalised', () => {
    const humanizeFieldLabel = load();
    expect(humanizeFieldLabel('node.url')).toBe('Url');
  });
});

describe('i18n runtime: t()', () => {
  function load(locale: string, table: Record<string, Record<string, string>>): (key: string, vars?: Record<string, unknown>) => string {
    const fn = extractFunction(script, 't');
    return new Function('I18N', 'locale', `${fn}\nreturn t;`)(table, locale);
  }

  it('substitutes a {placeholder}', () => {
    const t = load('en', { en: { greet: 'Hello {name}' } });
    expect(t('greet', { name: 'Bob' })).toBe('Hello Bob');
  });

  it('substitutes the SAME placeholder appearing more than once', () => {
    const t = load('en', { en: { echo: '{x} and {x}' } });
    expect(t('echo', { x: 'A' })).toBe('A and A');
  });

  it('falls back to English when the active locale is missing the key', () => {
    const t = load('de', { en: { 'only.english': 'only in English' }, de: {} });
    expect(t('only.english')).toBe('only in English');
  });

  it('falls back to the raw key when NO locale has it — a visibly broken string beats a blank control', () => {
    const t = load('en', { en: {} });
    expect(t('totally.missing.key')).toBe('totally.missing.key');
  });

  it('does not crash on a key with no vars object', () => {
    const t = load('en', { en: { plain: 'no placeholders here' } });
    expect(t('plain')).toBe('no placeholders here');
  });
});

describe('detectLocale / detectTheme: reading persisted preferences', () => {
  function loadLocale(stored: string | null, navLang: string): () => string {
    const fn = extractFunction(script, 'detectLocale');
    const storage = {
      getItem: (k: string) => (k === 'ogmara_bot_locale' ? stored : null),
    };
    return new Function(
      'localStorage',
      'navigator',
      'LOCALES',
      `${fn}\nreturn detectLocale;`,
    )(storage, { language: navLang }, ['en', 'de', 'es', 'pt', 'ru', 'ja', 'zh']);
  }

  it('uses the stored locale when it is one this panel ships', () => {
    expect(loadLocale('de', 'en-US')()).toBe('de');
  });

  it('falls back to the browser language when nothing is stored', () => {
    expect(loadLocale(null, 'ja-JP')()).toBe('ja');
  });

  it('falls back to English when the browser language is not one of the seven', () => {
    expect(loadLocale(null, 'ko-KR')()).toBe('en');
  });

  it('IGNORES a stored value that is not a real locale — never trusts storage blindly', () => {
    // A locale list saved by a newer build and then rolled back to an older
    // one must not crash the older build reading it.
    expect(loadLocale('klingon', 'en-US')()).toBe('en');
  });

  function loadTheme(stored: string | null): () => string {
    const fn = extractFunction(script, 'detectTheme');
    const storage = {
      getItem: (k: string) => (k === 'ogmara_bot_theme' ? stored : null),
    };
    return new Function('localStorage', `${fn}\nreturn detectTheme;`)(storage);
  }

  it('uses a stored "light" or "dark" verbatim', () => {
    expect(loadTheme('light')()).toBe('light');
    expect(loadTheme('dark')()).toBe('dark');
  });

  it('falls back to "system" for anything else, including garbage', () => {
    expect(loadTheme(null)()).toBe('system');
    expect(loadTheme('purple')()).toBe('system');
  });
});

describe('confirmMessageFor: the right warning for the right field', () => {
  function load(): (field: { path: string }, from: unknown, to: unknown) => string {
    const fieldLabelStub = 'function fieldLabel(f) { return f.path; }';
    const tStub = `function t(key, vars) {
      const table = {
        'config.confirm.dryRunOff': 'TURN OFF',
        'config.confirm.dryRunOn': 'TURN ON',
        'config.confirm.network': 'NETWORK CHANGE',
        'config.confirm.generic': 'generic ' + (vars ? vars.field : ''),
      };
      return table[key] || key;
    }`;
    const fn = extractFunction(script, 'confirmMessageFor');
    return new Function(`${tStub}\n${fieldLabelStub}\n${fn}\nreturn confirmMessageFor;`)();
  }

  it('uses the dry-run-OFF message when dryRun is being set to false', () => {
    const confirmMessageFor = load();
    expect(confirmMessageFor({ path: 'posting.dryRun' }, true, false)).toBe('TURN OFF');
  });

  it('uses the dry-run-ON message when dryRun is being set to true', () => {
    const confirmMessageFor = load();
    expect(confirmMessageFor({ path: 'posting.dryRun' }, false, true)).toBe('TURN ON');
  });

  it('uses the network-specific message for node.network, not the generic one', () => {
    const confirmMessageFor = load();
    expect(confirmMessageFor({ path: 'node.network' }, 'testnet', 'mainnet')).toBe('NETWORK CHANGE');
  });

  it('falls back to the generic message for any other confirm-flagged field', () => {
    const confirmMessageFor = load();
    expect(confirmMessageFor({ path: 'ai.provider' }, 'anthropic', 'openai')).toContain('ai.provider');
  });
});

describe('saveConfig: REAL execution, not just source-text checks', () => {
  // A source-text grep is exactly what missed the bug this suite exists to
  // catch: `onChange` correctly computed `undefined` for a cleared field, and
  // `saveConfig`'s own source correctly read `confirmed ? {...} : {...}` — but
  // `JSON.stringify({profile:{bio: undefined}})` silently drops the `bio` key
  // entirely (JSON has no way to encode an "own property with value
  // undefined"), so the wire payload for a lone cleared field was
  // `{"changes":{"profile":{}}}` — an EMPTY object, which the server reads as
  // the leaf path "profile" and rejects as an unrecognised setting. Bundled
  // alongside a sibling edit, the clear vanished with no error at all and
  // "Saved." was shown for an edit that had not fully happened. No amount of
  // grepping the source text for the right-looking code would ever catch
  // this — only actually running it and inspecting what left the function.
  //
  // No DOM is available in this test environment, so `document`/`window` are
  // minimal stand-ins — this exercises `saveConfig`'s own control flow (which
  // endpoint(s) it calls, with what bodies, in what order), not real widget
  // interaction (covered separately, and by the live end-to-end check this
  // session ran against a real running instance).
  function loadSaveConfig(): {
    run: () => Promise<void>;
    calls: Array<{ path: string; options: { method: string; body: string } }>;
    configPendingRef: Record<string, unknown>;
  } {
    const fieldIsDirtyFn = extractFunction(script, 'fieldIsDirty');
    const fieldCurrentValueFn = extractFunction(script, 'fieldCurrentValue');
    const setNestedValueFn = extractFunction(script, 'setNestedValue');
    const confirmMessageForFn = extractFunction(script, 'confirmMessageFor');
    const saveConfigFn = extractFunction(script, 'saveConfig');

    const calls: Array<{ path: string; options: { method: string; body: string } }> = [];
    const elements: Record<string, { disabled: boolean; textContent: string }> = {
      'config-save-btn': { disabled: false, textContent: '' },
    };

    const sandbox = new Function(
      'configFields',
      'configPending',
      'document',
      'window',
      'api',
      't',
      'showSuccess',
      'showError',
      'addRestartPending',
      'refreshConfig',
      `
      ${fieldCurrentValueFn}
      ${fieldIsDirtyFn}
      ${setNestedValueFn}
      function fieldLabel(f) { return f.path; }
      ${confirmMessageForFn}
      ${saveConfigFn}
      return saveConfig;
      `,
    );

    const configPending: Record<string, unknown> = {};
    const configFields = [
      { path: 'profile.bio', value: 'old bio', confirm: false },
      { path: 'profile.displayName', value: 'Old Name', confirm: false },
    ];

    const api = async (path: string, options: { method: string; body: string }) => {
      calls.push({ path, options });
      return { status: 'saved', restartPending: [] };
    };

    const run = (): Promise<void> =>
      sandbox(
        configFields,
        configPending,
        { getElementById: (id: string) => elements[id] },
        { confirm: () => true },
        api,
        (key: string) => key,
        () => {},
        () => {},
        () => {},
        async () => {},
      )();

    return { run, calls, configPendingRef: configPending };
  }

  it('routes a CLEARED field through reset, never through the bulk PUT', async () => {
    const { run, calls, configPendingRef } = loadSaveConfig();
    configPendingRef['profile.bio'] = undefined;
    await run();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/settings/reset');
    expect(JSON.parse(calls[0]!.options.body)).toEqual({ path: 'profile.bio' });
  });

  it('does NOT silently drop a sibling edit when a sibling field is cleared in the same save', async () => {
    // THE regression, reproduced end to end: before the fix, both edits went
    // into one bulk PUT, JSON.stringify dropped the cleared key, and the
    // sibling edit's own field never got a value written for the one that was
    // supposed to be cleared.
    const { run, calls, configPendingRef } = loadSaveConfig();
    configPendingRef['profile.bio'] = undefined;
    configPendingRef['profile.displayName'] = 'New Name';
    await run();

    const resetCall = calls.find((c) => c.path === '/api/settings/reset');
    const putCall = calls.find((c) => c.path === '/api/settings');
    expect(resetCall, 'the cleared field must reach the server via reset').toBeDefined();
    expect(JSON.parse(resetCall!.options.body)).toEqual({ path: 'profile.bio' });
    expect(putCall, 'the sibling edit must still be saved').toBeDefined();
    const putBody = JSON.parse(putCall!.options.body);
    expect(putBody.changes).toEqual({ profile: { displayName: 'New Name' } });
    // And the cleared field must NOT appear anywhere in the PUT body — it was
    // already handled by the reset call above.
    expect(JSON.stringify(putBody)).not.toContain('bio');
  });

  it('sends an ordinary edit through the bulk PUT, unchanged from before', async () => {
    const { run, calls, configPendingRef } = loadSaveConfig();
    configPendingRef['profile.displayName'] = 'New Name';
    await run();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/settings');
    expect(JSON.parse(calls[0]!.options.body)).toEqual({
      changes: { profile: { displayName: 'New Name' } },
    });
  });

  it('includes confirm:true in the PUT body when any dirty field is confirm-flagged', async () => {
    const fieldIsDirtyFn = extractFunction(script, 'fieldIsDirty');
    const fieldCurrentValueFn = extractFunction(script, 'fieldCurrentValue');
    const setNestedValueFn = extractFunction(script, 'setNestedValue');
    const confirmMessageForFn = extractFunction(script, 'confirmMessageFor');
    const saveConfigFn = extractFunction(script, 'saveConfig');
    const calls: Array<{ path: string; options: { method: string; body: string } }> = [];
    const elements: Record<string, { disabled: boolean; textContent: string }> = {
      'config-save-btn': { disabled: false, textContent: '' },
    };
    const sandbox = new Function(
      'configFields',
      'configPending',
      'document',
      'window',
      'api',
      't',
      'showSuccess',
      'showError',
      'addRestartPending',
      'refreshConfig',
      `
      ${fieldCurrentValueFn}
      ${fieldIsDirtyFn}
      ${setNestedValueFn}
      function fieldLabel(f) { return f.path; }
      ${confirmMessageForFn}
      ${saveConfigFn}
      return saveConfig;
      `,
    );
    const configPending: Record<string, unknown> = { 'posting.dryRun': false };
    const configFields = [{ path: 'posting.dryRun', value: true, confirm: true }];
    const api = async (path: string, options: { method: string; body: string }) => {
      calls.push({ path, options });
      return { status: 'saved', restartPending: [] };
    };
    await sandbox(
      configFields,
      configPending,
      { getElementById: (id: string) => elements[id] },
      { confirm: () => true },
      api,
      (key: string) => key,
      () => {},
      () => {},
      () => {},
      async () => {},
    )();

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.options.body).confirm).toBe(true);
  });
});

describe('refreshAudit: a failed fetch clears the loading placeholder', () => {
  it('does not leave "Loading..." on screen alongside the error banner', async () => {
    // REGRESSION GUARD. refreshConfig already clears its own loading state in
    // its catch block; refreshAudit's catch only touched audit-error, so a
    // transient failure while opening the tab left BOTH the real error and a
    // permanently stuck loading message underneath it.
    const fn = extractFunction(script, 'refreshAudit');
    const emptyEl = { hidden: false, textContent: '' };
    const errorEl = { textContent: '' };
    const elements: Record<string, unknown> = { 'audit-empty': emptyEl, 'audit-error': errorEl };
    const sandbox = new Function(
      'document',
      'api',
      't',
      'auditEvents',
      'renderAuditTable',
      `
      let auditEvents_ = auditEvents;
      ${fn.replace('async function refreshAudit()', 'async function refreshAudit()').replace(/\bauditEvents\b/g, 'auditEvents_')}
      return refreshAudit;
      `,
    );
    const run = sandbox(
      { getElementById: (id: string) => elements[id] },
      async () => {
        throw new Error('node unreachable');
      },
      (key: string) => key,
      null,
      () => {},
    );
    await run();
    expect(emptyEl.hidden).toBe(true);
    expect(errorEl.textContent).toContain('node unreachable');
  });
});

describe('audit tab: null sentinel distinguishes "never fetched" from "genuinely empty"', () => {
  it('renderAuditTable does not run before the first fetch', () => {
    const fn = extractFunction(script, 'renderAuditTable');
    expect(fn).toContain('if (auditEvents === null) return;');
  });

  it('refreshLocalizedViews only re-renders the audit table once it has been fetched', () => {
    const fn = extractFunction(script, 'refreshLocalizedViews');
    expect(fn).toContain("if (auditEvents !== null) renderAuditTable();");
  });

  it('auditEvents starts as the null sentinel, not an empty array', () => {
    expect(script).toContain('let auditEvents = null;');
  });
});

describe('optional string fields can be cleared back to unset', () => {
  it('a blanked text input always sends undefined, regardless of the field\'s previous value', () => {
    // REGRESSION GUARD. This used to be conditional on the field having
    // already been unset, so blanking a field that DID hold a value sent ''
    // instead — which fails validation for every optional string field in
    // this schema (each is either `.min(1)` or format-validated), leaving no
    // way to clear one through the panel except by hand-editing a file.
    const fn = extractFunction(script, 'buildFieldInput');
    expect(fn).toContain("onChange(input.value === '' ? undefined : input.value);");
  });
});

describe('selectConfigTopic: a rail sub-item is a full destination, not a filter that only works from inside Configuration', () => {
  it("navigates to the config tab when it isn't already the active one", () => {
    // REGRESSION GUARD (live, user-reported): clicking a Configuration
    // sub-item from Dashboard/Account/Audit log — or before Configuration
    // had ever been opened at all — silently did nothing, because
    // selectConfigTopic only ever re-filtered ALREADY-rendered sections. It
    // never switched the visible tab, so on a page where #tab-config was
    // still hidden there was nothing on screen to filter.
    const fn = extractFunction(script, 'selectConfigTopic');
    expect(fn).toMatch(/if\s*\(\s*document\.getElementById\('tab-config'\)\.hidden\s*\)\s*\{\s*switchTab\('config'\)/);
  });

  it('does NOT re-navigate (and re-fetch) when already on Configuration — just re-filters client-side', () => {
    // The opposite failure mode: switching topics while already inside
    // Configuration must stay instant, not trigger a fresh /api/settings
    // fetch on every click.
    const fn = extractFunction(script, 'selectConfigTopic');
    const elseIdx = fn.indexOf('} else {');
    expect(elseIdx).toBeGreaterThan(-1);
    expect(fn.slice(elseIdx)).toContain('applyConfigTopicFilter();');
  });

  it('sets currentConfigTopic and updates rail-subitem active state BEFORE navigating', () => {
    // switchTab('config') triggers refreshConfig(), which re-renders every
    // section and re-filters using currentConfigTopic — so the topic must
    // already be set by the time that fires, or the newly-loaded page would
    // show the WRONG (previously selected, or default) topic for one beat.
    const fn = extractFunction(script, 'selectConfigTopic');
    const setIdx = fn.indexOf('currentConfigTopic = topicId');
    const switchIdx = fn.indexOf("switchTab('config')");
    expect(setIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(switchIdx);
  });
});

describe('applyConfigTopicFilter: the Secrets card is topic-scoped too', () => {
  it('is not shown on every topic — only Panel & Security', () => {
    // REGRESSION GUARD (live, user-reported): #config-secrets lived outside
    // #config-sections entirely, so it was never touched by the per-topic
    // hide/show sweep and stayed visible under every single rail sub-item —
    // "sticky", with no topic it actually belonged to.
    const fn = extractFunction(script, 'applyConfigTopicFilter');
    expect(fn).toMatch(/getElementById\('config-secrets'\)/);
    expect(fn).toMatch(/\.hidden\s*=\s*currentConfigTopic\s*!==\s*'panel'/);
  });

  it('the #config-secrets element itself is tagged for the panel topic in the markup', () => {
    expect(page).toMatch(/<div id="config-secrets" class="card" data-topic="panel">/);
  });
});

describe('shortenAddress: REAL execution', () => {
  function loadShortenAddress(): (address: unknown) => unknown {
    const fn = extractFunction(script, 'shortenAddress');
    return new Function(`${fn}\nreturn shortenAddress;`)() as (address: unknown) => unknown;
  }

  it('truncates a full klv1… address to first6…last4', () => {
    const shortenAddress = loadShortenAddress();
    expect(shortenAddress('klv1vh32t20qcz3u23q7y8v32fce44mkjk4lx6ehn0te76w0ruqvwd0s8sgva0')).toBe('klv1vh…gva0');
  });

  it('leaves a short string untouched rather than mangling it', () => {
    const shortenAddress = loadShortenAddress();
    expect(shortenAddress('short')).toBe('short');
  });

  it('passes through a non-string value unchanged, rather than throwing', () => {
    const shortenAddress = loadShortenAddress();
    expect(shortenAddress(undefined)).toBeUndefined();
    expect(shortenAddress('')).toBe('');
  });
});

describe('updateConfigToolbar: REAL execution — the summary line matches what actually happens', () => {
  function loadUpdateConfigToolbar(
    fields: Array<{ path: string; restart: boolean; value: unknown; pending: unknown }>,
  ): {
    noteText: string;
    saveDisabled: boolean;
    discardHidden: boolean;
  } {
    const fieldIsDirtyFn = extractFunction(script, 'fieldIsDirty');
    const fieldCurrentValueFn = extractFunction(script, 'fieldCurrentValue');
    const updateConfigToolbarFn = extractFunction(script, 'updateConfigToolbar');

    const elements: Record<string, { disabled: boolean; hidden: boolean; textContent: string }> = {
      'config-save-btn': { disabled: false, hidden: false, textContent: '' },
      'config-discard-btn': { disabled: false, hidden: false, textContent: '' },
      'config-unsaved-note': { disabled: false, hidden: false, textContent: '' },
    };
    const document = {
      getElementById: (id: string) => elements[id],
    };
    // `pending` is set to a DIFFERENT value than `value` for every field
    // passed in below, which is what actually makes fieldIsDirty() true —
    // the translations themselves are exercised elsewhere (i18n.test.ts);
    // this only needs the RIGHT KEY and the RIGHT COUNTS to reach t(), so a
    // passthrough stand-in is enough to see which branch actually fired.
    const t = (key: string, vars?: Record<string, unknown>): string =>
      vars ? `${key}:${JSON.stringify(vars)}` : key;

    const sandbox = new Function(
      'configFields',
      'configPending',
      'document',
      't',
      `
      ${fieldCurrentValueFn}
      ${fieldIsDirtyFn}
      ${updateConfigToolbarFn}
      updateConfigToolbar();
      `,
    );
    const configPending: Record<string, unknown> = {};
    for (const f of fields) configPending[f.path] = f.pending;
    sandbox(fields, configPending, document, t);

    return {
      noteText: elements['config-unsaved-note']!.textContent,
      saveDisabled: elements['config-save-btn']!.disabled,
      discardHidden: elements['config-discard-btn']!.hidden,
    };
  }

  it('clears the note and disables Save when nothing is dirty', () => {
    const result = loadUpdateConfigToolbar([]);
    expect(result.noteText).toBe('');
    expect(result.saveDisabled).toBe(true);
  });

  it('uses the all-live phrasing when every dirty field is restart: false', () => {
    const result = loadUpdateConfigToolbar([
      { path: 'posting.dryRun', restart: false, value: false, pending: true },
      { path: 'posting.maxPostsPerHour', restart: false, value: 1, pending: 9 },
    ]);
    expect(result.noteText).toContain('config.toolbar.allLive');
    expect(result.noteText).toContain('"count":2');
    expect(result.saveDisabled).toBe(false);
  });

  it('uses the all-restart phrasing when every dirty field needs a restart', () => {
    const result = loadUpdateConfigToolbar([
      { path: 'node.url', restart: true, value: 'https://old.example', pending: 'https://new.example' },
    ]);
    expect(result.noteText).toContain('config.toolbar.allRestart');
    expect(result.noteText).toContain('"count":1');
  });

  it('uses the mixed phrasing, with correct live/restart sub-counts, when both are present', () => {
    const result = loadUpdateConfigToolbar([
      { path: 'posting.dryRun', restart: false, value: false, pending: true },
      { path: 'node.url', restart: true, value: 'https://old.example', pending: 'https://new.example' },
      { path: 'node.network', restart: true, value: 'testnet', pending: 'mainnet' },
    ]);
    expect(result.noteText).toContain('config.toolbar.mixed');
    expect(result.noteText).toContain('"count":3');
    expect(result.noteText).toContain('"live":1');
    expect(result.noteText).toContain('"restart":2');
  });
});

describe('renderConfigSubnav: per-topic field-count badges', () => {
  it('computes each badge from the number of loaded fields belonging to that topic', () => {
    const fn = extractFunction(script, 'renderConfigSubnav');
    expect(fn).toMatch(/configFields\.filter\(\(f\) => topicForSection\(f\.path\.split\('\.'\)\[0\]\) === group\.id\)\.length/);
  });

  it('only renders a badge when the count is greater than zero', () => {
    const fn = extractFunction(script, 'renderConfigSubnav');
    expect(fn).toMatch(/if\s*\(count > 0\)/);
  });
});

describe('sidebar identity header (avatar + name + handle)', () => {
  it('the markup exists inside the rail, above the primary nav items', () => {
    expect(page).toContain('<div class="rail-header">');
    expect(page).toContain('id="rail-identity-avatar"');
    expect(page).toContain('id="rail-identity-name"');
    expect(page).toContain('id="rail-identity-handle"');
  });

  it('falls back to a generic name and an initial-letter avatar when no profile is available', () => {
    const fn = extractFunction(script, 'renderRailHeader');
    expect(fn).toMatch(/\|\|\s*'ogmara-bot'/);
    expect(fn).toContain('fallback.textContent');
  });

  it('is populated once at login (refresh()), not only when the Account tab is opened', () => {
    // REGRESSION GUARD: the header is visible on every destination, so it
    // must not depend on the operator having visited Account first.
    const fn = extractFunction(script, 'refresh');
    expect(fn).toMatch(/refreshProfile\(\{\s*silent:\s*true\s*\}\)/);
  });

  it('a login-time profile-fetch failure does not surface an error banner', () => {
    const fn = extractFunction(script, 'refreshProfile');
    expect(fn).toMatch(/if\s*\(!silent\)\s*showError/);
  });
});

describe('exact visual match to the approved concept — badges, toggle switches, rail footer', () => {
  it('the live/restart field badges use the soft-pill "badge" class, not the outlined "chip" class', () => {
    // The concept uses two distinct visual languages: outlined chips for
    // source/file-only info, soft-filled pills for the one pair the
    // operator scans for at a glance (live vs. restart). Mixing them back
    // together would erase that distinction.
    const fn = extractFunction(script, 'buildFieldRow');
    expect(fn).toContain("restartChip.className = 'badge badge-restart';");
    expect(fn).toContain("liveChip.className = 'badge badge-live';");
    expect(fn).not.toContain("'chip chip-restart'");
    expect(fn).not.toContain("'chip chip-live'");
  });

  it('the source/file-only badges keep the original outlined "chip" class unchanged', () => {
    const fn = extractFunction(script, 'buildFieldRow');
    expect(fn).toMatch(/sourceChip\.className = 'chip'/);
  });

  it('a boolean field renders as a toggle switch — a real checkbox plus track/thumb spans, not a bare checkbox', () => {
    const fn = extractFunction(script, 'buildFieldInput');
    expect(fn).toContain("wrap.className = 'switch';");
    expect(fn).toContain("input.type = 'checkbox';");
    expect(fn).toContain("track.className = 'track';");
    expect(fn).toContain("thumb.className = 'thumb';");
  });

  it('the toggle switch keeps the real checkbox\'s checked/change wiring untouched', () => {
    // The visual swap must not touch the actual state — saveConfig() and
    // fieldCurrentValue() both read straight off the checkbox element
    // itself, regardless of what sits visually on top of it.
    const fn = extractFunction(script, 'buildFieldInput');
    expect(fn).toMatch(/input\.checked = Boolean\(value\)/);
    expect(fn).toMatch(/input\.addEventListener\('change', \(\) => onChange\(input\.checked\)\)/);
  });

  it('the rail-footer restart button exists in the markup, hidden by default', () => {
    expect(page).toContain('<div class="rail-footer" id="rail-footer" hidden>');
    expect(page).toContain('id="rail-restart-btn"');
  });

  it('renderRestartBanner keeps the rail-footer button in sync with the same persisted data — no second counter', () => {
    const fn = extractFunction(script, 'renderRestartBanner');
    expect(fn).toContain("getElementById('rail-footer')");
    expect(fn).toContain('railFooter.hidden = false');
    expect(fn).toContain('railFooter.hidden = true');
    // Same `title` string reused for both the top banner and the rail
    // footer — not a second, possibly-drifting translation lookup.
    expect(fn).toMatch(/getElementById\('rail-restart-btn'\)\.textContent = '↻ ' \+ title/);
  });

  it('clicking the rail-footer button scrolls to the existing top-of-page banner, rather than duplicating its content', () => {
    expect(script).toMatch(
      /getElementById\('rail-restart-btn'\)\.addEventListener\('click', \(\) => \{\s*document\.getElementById\('restart-banner'\)\.scrollIntoView/,
    );
  });

  it('the rail gets its own surface background and border, not the bare page background', () => {
    // REGRESSION GUARD: the shipped 0.30.0/0.31.0 rail had no background of
    // its own and sat flush on the page background — reported as reading
    // "thin" compared to the approved concept, where the rail is a
    // distinct bordered panel.
    expect(page).toMatch(/\.rail\s*\{[^}]*background:\s*var\(--surface\)/);
    expect(page).toMatch(/\.rail\s*\{[^}]*border:\s*1px solid var\(--border\)/);
  });

  it('defines the new live/restart/accent-soft design tokens in every theme block', () => {
    for (const token of ['--live', '--live-soft', '--restart', '--restart-soft', '--accent-soft']) {
      // 3 theme blocks: the dark-default :root, the light prefers-color-scheme
      // override, and the explicit :root[data-theme="light"] block.
      const count = page.split(token + ':').length - 1;
      expect(count).toBeGreaterThanOrEqual(3);
    }
  });

  it('the light-theme --live/--restart text colors are dark enough for WCAG AA at badge text size', () => {
    // REGRESSION GUARD (code audit): the ORIGINAL light-theme values
    // (#1f9d63 / #b7791f, mirrored straight from the design concept)
    // measured under 3.2:1 contrast against the badges' own lightly-tinted
    // background — below the 4.5:1 WCAG AA floor for small (0.68rem) text.
    // #167048 / #855716 measure ~5.3:1. This test pins the darker values
    // rather than re-deriving contrast math in a unit test — an accidental
    // revert to the lighter originals (e.g. a future "restore the exact
    // concept colors" pass) should fail loudly here, not silently ship an
    // accessibility regression.
    const lightBlocks = [...page.matchAll(/--live: (#[0-9a-f]{6}); --live-soft:/g)].map((m) => m[1]);
    const restartBlocks = [...page.matchAll(/--restart: (#[0-9a-f]{6}); --restart-soft:/g)].map((m) => m[1]);
    // Index 0 is the dark-default :root block (fine as-is, checked separately
    // by the audit); indices 1 and 2 are the two light-theme blocks.
    expect(lightBlocks.slice(1)).toEqual(['#167048', '#167048']);
    expect(restartBlocks.slice(1)).toEqual(['#855716', '#855716']);
  });
});

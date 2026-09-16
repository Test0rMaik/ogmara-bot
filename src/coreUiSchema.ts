/**
 * Presentation metadata for config sections no module owns.
 *
 * `node`, `posting`, `ai`, `profile`, `queue`, `storage`, `stats`, `panel` and
 * `settings` are all declared directly in `configSchema` rather than inside a
 * module's own `schemas` map (see `modules/types.ts`) — there is no module to
 * ask for labels, restart/confirm semantics, or help text. This is that
 * information, curated once here rather than left for `describeFields` to
 * fall back to a humanised path for every one of them.
 *
 * `panel.*` and `settings.*` get entries too even though they are file-only
 * and never editable through this API (see `FILE_ONLY_SECTIONS`) — the
 * settings page still DISPLAYS them, read-only, and a humanised
 * `trustedProxies` reads worse than a real label.
 */

import type { UiField } from './modules/types.js';

export const CORE_UI_SCHEMA: Readonly<Record<string, UiField>> = {
  'node.url': { label: 'field.node.url.label', help: 'field.node.url.help', restart: true },
  'node.network': {
    label: 'field.node.network.label',
    help: 'field.node.network.help',
    restart: true,
    confirm: true,
  },
  'node.timeoutMs': { label: 'field.node.timeoutMs.label', restart: true },

  'posting.dryRun': {
    label: 'field.posting.dryRun.label',
    help: 'field.posting.dryRun.help',
    // Read fresh from `ctx.config` on every publish attempt (ogmara.ts,
    // modules/commands/index.ts, pipeline.ts) — genuinely live once the
    // config-object disconnect is fixed (see `applyConfigInPlace`), no
    // setter needed. Still `confirm: true` regardless of restart status:
    // turning it off points a live wallet at a live network under the
    // operator's identity, and turning it on is how someone stops a bot
    // that is posting — exactly when a wrong answer about whether it took
    // effect does the most damage, restart or not.
    restart: false,
    confirm: true,
  },
  'posting.contentRating': {
    label: 'field.posting.contentRating.label',
    restart: false, // read live: ogmara.ts's publish() call
  },
  'posting.maxPostsPerHour': {
    label: 'field.posting.maxPostsPerHour.label',
    help: 'field.posting.maxPostsPerHour.help',
    restart: false,
  },
  'posting.nodeBurstUnverified': { label: 'field.posting.nodeBurstUnverified.label', restart: false },
  'posting.nodeBurstRegistered': { label: 'field.posting.nodeBurstRegistered.label', restart: false },
  'posting.nodeDailyUnverified': { label: 'field.posting.nodeDailyUnverified.label', restart: false },
  'posting.nodeDailyRegistered': { label: 'field.posting.nodeDailyRegistered.label', restart: false },
  'posting.disclosureTag': {
    label: 'field.posting.disclosureTag.label',
    restart: false, // read live: pipeline.ts's requiredTags()
  },
  'posting.alwaysTags': {
    label: 'field.posting.alwaysTags.label',
    restart: false, // read live: pipeline.ts's requiredTags()
  },
  'posting.includeSourceLink': {
    label: 'field.posting.includeSourceLink.label',
    restart: false, // read live: pipeline.ts's withAttribution()
  },

  'ai.provider': {
    label: 'field.ai.provider.label',
    help: 'field.ai.provider.help',
    restart: true,
    confirm: true,
  },
  'ai.model': { label: 'field.ai.model.label', help: 'field.ai.model.help', restart: true },
  'ai.baseUrl': { label: 'field.ai.baseUrl.label', help: 'field.ai.baseUrl.help', restart: true },
  'ai.effort': { label: 'field.ai.effort.label', restart: true },
  'ai.maxTokens': { label: 'field.ai.maxTokens.label', restart: true },
  'ai.promptPath': { label: 'field.ai.promptPath.label', restart: true },
  // The four below are read live, fresh per pipeline run, straight from
  // `config.ai.*` inside pipeline.ts — unlike `model`/`provider`/`baseUrl`
  // above, nothing bakes them into the AI client at construction.
  'ai.targetContentChars': { label: 'field.ai.targetContentChars.label', restart: false },
  'ai.maxTags': { label: 'field.ai.maxTags.label', restart: false },
  'ai.maxSourceTitleChars': { label: 'field.ai.maxSourceTitleChars.label', restart: false },
  'ai.maxSourceSummaryChars': { label: 'field.ai.maxSourceSummaryChars.label', restart: false },

  'profile.displayName': {
    label: 'field.profile.displayName.label',
    help: 'field.profile.displayName.help',
    restart: true,
  },
  'profile.bio': { label: 'field.profile.bio.label', restart: true },
  'profile.avatarCid': { label: 'field.profile.avatarCid.label', restart: true },

  // queue.path stays restart: true (falls to the default) — changing the
  // backing file at runtime means abandoning or migrating in-memory queue
  // state, a different and harder problem than a live setter can solve.
  'queue.maxAttempts': { label: 'field.queue.maxAttempts.label', restart: false },
  'queue.maxAgeHours': { label: 'field.queue.maxAgeHours.label', restart: false },

  'storage.retentionDays': { label: 'field.storage.retentionDays.label', restart: false },

  'stats.enabled': { label: 'field.stats.enabled.label', restart: true },
  'stats.schedule': { label: 'field.stats.schedule.label', restart: false }, // live: index.ts reschedules the cron job
  'stats.retentionDays': { label: 'field.stats.retentionDays.label', restart: false },

  // File-only — labels for DISPLAY only; the API refuses any write here
  // regardless of what `restart`/`confirm` say.
  'panel.enabled': { label: 'field.panel.enabled.label', restart: true },
  'panel.bind': { label: 'field.panel.bind.label', restart: true },
  'panel.port': { label: 'field.panel.port.label', restart: true },
  'panel.adminWallets': { label: 'field.panel.adminWallets.label', restart: true },
  'panel.requireLogin': { label: 'field.panel.requireLogin.label', restart: true },
  'panel.sessionTtlHours': { label: 'field.panel.sessionTtlHours.label', restart: true },
  'panel.allowedHosts': { label: 'field.panel.allowedHosts.label', restart: true },
  'panel.trustedProxies': { label: 'field.panel.trustedProxies.label', restart: true },

  'settings.path': { label: 'field.settings.path.label', restart: true },
  'settings.auditPath': { label: 'field.settings.auditPath.label', restart: true },
  'settings.auditMaxBytes': { label: 'field.settings.auditMaxBytes.label', restart: true },
  'settings.auditKeep': { label: 'field.settings.auditKeep.label', restart: true },
};

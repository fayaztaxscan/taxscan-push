import { env, type AudienceEnv } from '../../lib/env';

/**
 * CMS audience sync boot line (docs/CMS_AUDIENCE_SYNC_DESIGN.md §10.1, task 1).
 *
 * `[audience] disabled (set AUDIENCE_SYNC_ENABLED=true to start)` is the MARKER for a
 * backend-only deploy: it proves the build with this code is running while every audience
 * flag is off. Nothing is started yet — ingest, pulls and the writer arrive in tasks 3–6.
 *
 * Never throws (a bad audience config must not take push down) and never prints a value:
 * problems name variables only — and they are printed while the sync is OFF too, so a bad
 * variable is seen before the flag is switched on. An empty CMS_FEED_ALLOWED_IPS is warned about, because it
 * rejects every webhook by design.
 */
export type AudienceBootState = 'disabled' | 'config_invalid' | 'enabled';

export function startAudienceSync(cfg: AudienceEnv = env.audience): AudienceBootState {
  /* eslint-disable no-console */
  if (!cfg.enabled) {
    console.log('[audience] disabled (set AUDIENCE_SYNC_ENABLED=true to start)');
    // Shown while off too, so a bad variable is fixed BEFORE the flag goes on (names only).
    if (cfg.problems.length > 0) console.warn(`[audience] config problems (sync is off): ${cfg.problems.join('; ')}`);
    return 'disabled';
  }
  const problems = [...cfg.problems];
  if (!cfg.cms.inboundSecret) problems.push('CMS_FEED_INBOUND_SECRET is unset');
  if (problems.length > 0) {
    console.error(`[audience] config_invalid — not started: ${problems.join('; ')}`);
    return 'config_invalid';
  }
  if (cfg.cms.allowedIps.length === 0) {
    console.warn('[audience] CMS_FEED_ALLOWED_IPS is empty — every CMS webhook will be rejected (fail closed)');
  }
  // Ingest is not built yet (tasks 3–5); the flag being on starts nothing in this release.
  console.log('[audience] enabled — ingest not built in this release; nothing started');
  return 'enabled';
  /* eslint-enable no-console */
}

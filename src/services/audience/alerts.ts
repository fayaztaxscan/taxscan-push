import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type DigestEnv } from '../../lib/env';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../../lib/email';
import { buildAlertEmail, digestAlertRecipients, safeDetail, type AlertMarker } from '../digest/alerts';
import { istDayKey } from './breaker';

/**
 * Audience sync alerts (docs/CMS_AUDIENCE_SYNC_DESIGN.md §10.2) — through the DIGEST alert path: the
 * same plain-words copy (`alertCopy` in digest/alerts.ts has a case per kind below), the same
 * `buildAlertEmail`, the same recipients (active ADMIN users) and the same ElasticEmail channel. The
 * digest stores its markers on a `DigestRun`; the audience sync runs whether or not a digest run
 * exists, so its markers live on `AudienceSyncState.alerts` instead:
 *
 *   { <kind>: { raisedAt, day, emailedAt, emailAttempts, emailRetryAfter?, …counts } }
 *
 * Once per kind per IST day: raising a kind already raised today only refreshes its counts; a new day
 * starts a fresh marker (and a fresh email). An email that fails is retried after 10 min, at most 3
 * times. Markers carry counts and reason codes only — never an address, an id or a provider message.
 * Never throws.
 */

export type AudienceAlertKind =
  | 'audience_full_incomplete'
  | 'audience_breaker_open'
  | 'seq_conflict'
  | 'unknown_status'
  | 'audience_writer_fatal'
  | 'audience_writer_failing'
  | 'audience_drift'
  | 'cms_views_failed';

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 10 * 60_000;

type Detail = Record<string, string | number | boolean | null>;

function asMap(v: unknown): Record<string, AlertMarker> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, AlertMarker>) : {};
}

/** Record a marker. True when it is NEW today (an email will go out for it). */
export async function raiseAudienceAlert(portal: string, kind: AudienceAlertKind, detail: Detail, now: Date): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "AudienceSyncState" (portal, "updatedAt")
        VALUES (${portal}, (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
        ON CONFLICT (portal) DO NOTHING`;
      const rows = await tx.$queryRaw<{ alerts: unknown }[]>`SELECT alerts FROM "AudienceSyncState" WHERE portal = ${portal} FOR UPDATE`;
      const alerts = asMap(rows[0]?.alerts);
      const day = istDayKey(now);
      const cur = alerts[kind];
      const fresh = !cur || cur.day !== day;
      alerts[kind] = fresh
        ? { raisedAt: now.toISOString(), day, emailedAt: null, emailAttempts: 0, ...detail }
        : { ...cur, ...detail, lastRaisedAt: now.toISOString() };
      await tx.audienceSyncState.update({ where: { portal }, data: { alerts: alerts as Prisma.InputJsonValue } });
      return fresh;
    });
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[audience] could not record alert ${kind}`);
    return false;
  }
}

export type AudienceAlertDeps = {
  emailSender?: EmailSender;
  isConfigured?: () => boolean;
  recipients?: () => Promise<string[]>;
  now?: Date;
  cfg?: DigestEnv;
};

/** Email every marker not emailed yet (≤ 3 attempts, 10 min apart). Returns the kinds emailed. Never throws. */
export async function sendAudienceAlerts(portal: string, deps: AudienceAlertDeps = {}): Promise<string[]> {
  const emailed: string[] = [];
  try {
    if (!(deps.isConfigured ?? isEmailConfigured)()) return emailed; // the Audience card is the backstop
    const now = deps.now ?? new Date();
    const cfg = deps.cfg ?? env.digest;
    const st = await prisma.audienceSyncState.findUnique({ where: { portal }, select: { alerts: true } });
    const due = Object.entries(asMap(st?.alerts)).filter(
      ([, m]) =>
        !m.emailedAt &&
        (m.emailAttempts ?? 0) < MAX_ATTEMPTS &&
        (!m.emailRetryAfter || Date.parse(String(m.emailRetryAfter)) <= now.getTime()),
    );
    if (due.length === 0) return emailed;
    const recipients = await (deps.recipients ?? (() => digestAlertRecipients()))();
    if (recipients.length === 0) return emailed;
    const sender = deps.emailSender ?? defaultEmailSender;
    for (const [kind, m] of due) {
      // Claim: count the attempt before sending, so a crash after the send cannot repeat it forever.
      const claimed = await patchMarker(portal, kind, (cur) =>
        !cur || cur.emailedAt || (cur.emailAttempts ?? 0) >= MAX_ATTEMPTS ? null : { ...cur, emailAttempts: (cur.emailAttempts ?? 0) + 1, emailRetryAfter: new Date(now.getTime() + RETRY_AFTER_MS).toISOString() },
      );
      if (!claimed) continue;
      const msg = buildAlertEmail(kind, m, now, cfg);
      let ok = 0;
      for (const to of recipients) {
        try {
          if ((await sender({ to, ...msg })).ok) ok++;
        } catch {
          /* counted as a failure */
        }
      }
      if (ok > 0) {
        await patchMarker(portal, kind, (cur) => (cur ? { ...cur, emailedAt: new Date().toISOString(), emailedTo: ok } : null));
        emailed.push(kind);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[audience] alert pass failed: ${safeDetail(err instanceof Error ? err.message : 'error')}`);
  }
  return emailed;
}

async function patchMarker(portal: string, kind: string, fn: (cur: AlertMarker | undefined) => AlertMarker | null): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ alerts: unknown }[]>`SELECT alerts FROM "AudienceSyncState" WHERE portal = ${portal} FOR UPDATE`;
    const alerts = asMap(rows[0]?.alerts);
    const next = fn(alerts[kind]);
    if (!next) return false;
    alerts[kind] = next;
    await tx.audienceSyncState.update({ where: { portal }, data: { alerts: alerts as Prisma.InputJsonValue } });
    return true;
  });
}

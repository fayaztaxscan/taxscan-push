import type { AudienceMember } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type AudienceEnv, type DigestEnv } from '../../lib/env';
import { safeErrorLog } from '../../lib/httpErrors';
import { redactText } from '../../lib/redact';
import { breakerState, checkRemovalBreaker } from './breaker';
import { isPullRunning } from './pull';
import { raiseAudienceAlert, sendAudienceAlerts, type AudienceAlertDeps } from './alerts';
import { ContactError, RESUBSCRIBE_CONSENT_SOURCE, createContactClient, type McContact, type McContactClient } from './mcContacts';

/**
 * The ONE writer of Mailercloud contacts (docs/CMS_AUDIENCE_SYNC_DESIGN.md §3.2, §6, §11 task 6).
 * Desired state, not an outbox: each `AudienceMember` says what it should carry
 * (`desiredRole` / `noMarketing` → our three tags); `appliedTags` is what Mailercloud acknowledged.
 * `flushPending()` takes the due members (`nextAttemptAt` ≤ now, ≤ 200 a tick), computes the diff and
 * writes it; repeating it is harmless, and a reader who flaps collapses into one write.
 *
 * Never re-subscribe anyone (§6.2), except through the §6.3 lift path:
 *  - the ONLY re-subscribe is `client.resubscribe()` (POST /v1/contacts/resubscribe), only with
 *    AUDIENCE_RESUBSCRIBE_WRITES, only for a member whose suppression ingest lifted on the account's
 *    CURRENT address (QA M2: `resubscribePending` is set on that hash only, and a live account
 *    holding it must still say consent=true), never while suppressed. It carries the reader's consent
 *    as the latest `consentAt` of those live accounts, which must not be in the future or older than
 *    90 days (Mailercloud's rule): otherwise NO call, counted `resubscribeConsentTooOld`, the lift handled;
 *  - a contact is created only after our own GET answered 404, by single create into our own list
 *    (AUDIENCE_MC_LIST_ID, which the Free digest does not target) — never upsert, never batch; an
 *    "already exists" answer (M-1 race) switches to the existing-contact path;
 *  - an existing contact gets tags only: PUT with `tags` = the union of what it already carries and
 *    what we add (M-3: safe whether PUT appends or replaces), so a hand-added tag is never dropped;
 *  - no add for a suppressed member (by address, hash or any linked account — `suppressed`), except
 *    the No-marketing tag, an exclusion; removals are always allowed;
 *  - NO delete calls at all (owner 24 Oct: the CMS deletes on erasure).
 *
 * FREE members (brief 2026-11-08-free-cms-readers, AUDIENCE_FREE_READERS): the Free-reader tag only.
 * A FREE member we have never written (no `admittedAt`, none of our tags) WAITS until the IST day has room
 * under AUDIENCE_FREE_ADMIT_PER_DAY (0 = none admitted, no Mailercloud call for any). Each tick:
 *  1. every other due member first (PREMIUM, FORMER, NONE removals) — never held by FREE admissions;
 *  2. due FREE members already admitted (or already carrying one of our tags: a role swap, never capped);
 *  3. only with room today: waiting members not looked up yet get our GET (no write), then the
 *     waiting ones Mailercloud already holds are admitted first, in email-hash order; the rest (absent in
 *     Mailercloud) only once no waiting member is still unlooked-up, also in email-hash order. Admitting =
 *     stamping `admittedAt` and writing it in the same tick. Suppressed waiting members are never admitted.
 * Removals are never capped: a FREE member that turns NONE / unsubscribed / deleted loses the Free tag at
 * once (a suppressed FREE member no longer wants the Free tag). With AUDIENCE_MC_TAG_FREE unset, FREE
 * members are skipped entirely and every other write goes on (boot warns).
 *
 * Gates, in order: the pull running (wait), the 07:10–08:00 IST send window (DIGEST_SEND_AT − 20 /
 * + 30 min: the audience the guard approved is the audience Mailercloud resolves), no complete full
 * load yet, the breaker open, then AUDIENCE_SYNC_WRITE_MAILERCLOUD: off = DRY RUN (counts only, rows
 * untouched). Paced at AUDIENCE_WRITE_RPS (5) requests a second through one bucket. Errors: RETRYABLE
 * → +1, +5, +15 min, then hourly, forever; FATAL → that member stops + `audience_writer_fatal`;
 * retrying for > 6 h → `audience_writer_failing`. `lastErrorKind` stores a kind, never a message.
 * Never logs an address.
 */

export const WRITER_BATCH = 200;
/** Mailercloud takes a re-subscribe consent only if it is within the last 90 days (and not in the future). */
export const RESUBSCRIBE_CONSENT_MAX_AGE_MS = 90 * 24 * 3_600_000;
export const SEND_WINDOW_BEFORE_MIN = 20;
export const SEND_WINDOW_AFTER_MIN = 30;
/** Retry delays after the 1st, 2nd, 3rd failure; hourly after that (design §6.4). */
export const RETRY_DELAYS_MIN = [1, 5, 15] as const;
export const RETRY_HOURLY_MIN = 60;
/** 1 + 5 + 15 min, then hourly: the 9th failure is ~6 h 21 min after the first. */
export const FAILING_ATTEMPTS = 9;
export const DRIFT_SAMPLE = 50;
/** Premium count tolerance for the drift alert (the send guard's numbers, design §7.2). */
export const DRIFT_MIN_ABS = 25;

export type TagRole = 'premium' | 'former' | 'free' | 'noMarketing';
/** Our tag ids by role; `free` may be absent (= unset: AUDIENCE_FREE_READERS off or AUDIENCE_MC_TAG_FREE empty). */
export type TagIds = Record<Exclude<TagRole, 'free'>, string> & { free?: string };

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** True inside [sendAt − 20 min, sendAt + 30 min) IST — no contact writes then. */
export function inSendWindow(now: Date, sendAt: string = env.digest.sendAt): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(sendAt.trim());
  if (!m) return false;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const send = Number(m[1]) * 60 + Number(m[2]);
  return minute >= send - SEND_WINDOW_BEFORE_MIN && minute < send + SEND_WINDOW_AFTER_MIN;
}

export function retryDelayMin(attempts: number): number {
  return RETRY_DELAYS_MIN[attempts - 1] ?? RETRY_HOURLY_MIN;
}

/** Our tag ids (empty when unset). `free` is empty unless AUDIENCE_FREE_READERS is on. */
export function ourTagIds(cfg: AudienceEnv): TagIds {
  return {
    premium: cfg.mailercloud.tagPremium,
    former: cfg.mailercloud.tagFormer,
    free: cfg.freeReaders ? cfg.mailercloud.tagFree : '',
    noMarketing: cfg.mailercloud.tagNoMarketing,
  };
}

/** The configured ids among ours (an unset Free tag is no tag at all). */
function configuredIds(tags: TagIds): string[] {
  return Object.values(tags).filter((t): t is string => typeof t === 'string' && t !== '');
}

/** FREE writes can run: the flag on and the Free tag configured. */
export function freeWritesReady(cfg: AudienceEnv): boolean {
  return cfg.freeReaders && cfg.mailercloud.tagFree !== '';
}

/** The tags a member should carry (ids), from `desiredRole` + `noMarketing` — memberRole decided both. */
export function desiredTags(m: Pick<AudienceMember, 'desiredRole' | 'noMarketing'> & { suppressed?: boolean }, tags: TagIds): string[] {
  const out: string[] = [];
  if (m.desiredRole === 'PREMIUM') out.push(tags.premium);
  if (m.desiredRole === 'FORMER') out.push(tags.former);
  // An unsubscribed / suppressed FREE member loses the Free tag (brief test 7); never pushes an unset id.
  if (m.desiredRole === 'FREE' && tags.free && !m.suppressed) out.push(tags.free);
  if (m.noMarketing) out.push(tags.noMarketing);
  return out;
}

/**
 * The write diff. Adds skip a suppressed member, except the No-marketing tag (an exclusion: it can
 * only reduce mail). Removals only ever touch OUR tags and are always allowed.
 */
export function diffMember(
  m: Pick<AudienceMember, 'desiredRole' | 'noMarketing' | 'suppressed' | 'appliedTags'>,
  tags: TagIds,
): { adds: string[]; removes: string[] } {
  const ours = new Set(configuredIds(tags));
  const want = new Set(desiredTags(m, tags));
  const have = new Set(m.appliedTags);
  const adds = [...want].filter((t) => !have.has(t) && (!m.suppressed || t === tags.noMarketing));
  const removes = [...have].filter((t) => ours.has(t) && !want.has(t));
  return { adds, removes };
}

/** One token bucket: at most `rps` requests a second. */
export class Pacer {
  private next = 0;
  constructor(
    private readonly rps: number,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  async take(): Promise<void> {
    const gap = 1000 / Math.max(1, this.rps);
    const t = this.clock();
    const at = Math.max(t, this.next);
    this.next = at + gap;
    if (at > t) await this.sleep(at - t);
  }
}

export type WriterDeps = {
  client?: McContactClient;
  cfg?: AudienceEnv;
  digestCfg?: Pick<DigestEnv, 'sendAt'>;
  portal?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  batch?: number;
  sendAlerts?: boolean;
  alertDeps?: AudienceAlertDeps;
  /** TESTS ONLY: restrict the due set / the drift sample to these member hashes. */
  onlyHashes?: readonly string[];
};

export type FlushReport = {
  skipped?: 'busy' | 'pull_running' | 'send_window' | 'no_full_load' | 'breaker_open' | 'not_configured';
  dryRun: boolean;
  members: number;
  wouldAdd: number;
  wouldRemove: number;
  created: number;
  tagged: number;
  removed: number;
  /** Lifts (§6.3): re-subscribed (200 changed) / already subscribed (200) / awaiting the reader's double opt-in e-mail (202) / refused for good (404, 409, 422). */
  resubscribed: number;
  resubscribeAlready: number;
  resubscribePending: number;
  resubscribeRefused: number;
  /** Lifts handled WITHOUT a call (flag off, suppressed, no live consent, no such contact, or the consent is too old: `resubscribeConsentTooOld` is that last part). */
  resubscribeSkipped: number;
  resubscribeConsentTooOld: number;
  /** FREE: waiting members looked up in Mailercloud (GET only) / admitted under today's cap. */
  looked: number;
  admitted: number;
  done: number;
  deleted: number;
  retry: number;
  fatal: number;
  requests: number;
};

function emptyFlush(dryRun: boolean): FlushReport {
  return { dryRun, members: 0, wouldAdd: 0, wouldRemove: 0, created: 0, tagged: 0, removed: 0, resubscribed: 0, resubscribeAlready: 0, resubscribePending: 0, resubscribeRefused: 0, resubscribeSkipped: 0, resubscribeConsentTooOld: 0, looked: 0, admitted: 0, done: 0, deleted: 0, retry: 0, fatal: 0, requests: 0 };
}

/** What a write needs configured (names only). */
export function writerConfigProblems(cfg: AudienceEnv): string[] {
  const p: string[] = [];
  if (!cfg.mailercloud.syncApiKey) p.push('MAILERCLOUD_SYNC_API_KEY');
  if (!cfg.mailercloud.listId) p.push('AUDIENCE_MC_LIST_ID');
  if (!cfg.mailercloud.tagPremium) p.push('AUDIENCE_MC_TAG_PREMIUM');
  if (!cfg.mailercloud.tagFormer) p.push('AUDIENCE_MC_TAG_FORMER');
  if (!cfg.mailercloud.tagNoMarketing) p.push('AUDIENCE_MC_TAG_NO_MARKETING');
  return p;
}

let writing = false;
let lastDryLog = { key: '', at: 0 };

/** For tests. */
export function resetWriterForTests(): void {
  writing = false;
  lastDryLog = { key: '', at: 0 };
}

/** One writer tick. Single-flight. Never throws. */
export async function flushPending(deps: WriterDeps = {}): Promise<FlushReport> {
  const cfg = deps.cfg ?? env.audience;
  const dry = !cfg.writeMailercloud;
  if (writing) return { ...emptyFlush(dry), skipped: 'busy' };
  writing = true;
  try {
    return await flushOnce(deps, cfg, dry);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audience] writer tick failed', safeErrorLog(err));
    return emptyFlush(dry);
  } finally {
    writing = false;
  }
}

async function gate(deps: WriterDeps, now: Date, portal: string): Promise<FlushReport['skipped'] | null> {
  if (isPullRunning()) return 'pull_running';
  if (inSendWindow(now, (deps.digestCfg ?? env.digest).sendAt)) return 'send_window';
  const st = await prisma.audienceSyncState.findUnique({ where: { portal }, select: { lastFullOkAt: true } });
  if (!st?.lastFullOkAt) return 'no_full_load';
  // Webhook-driven mass removals are checked here too, before anything is written.
  await checkRemovalBreaker(portal, now);
  if ((await breakerState(prisma, portal)).open) return 'breaker_open';
  return null;
}

async function flushOnce(deps: WriterDeps, cfg: AudienceEnv, dry: boolean): Promise<FlushReport> {
  const now = (deps.now ?? (() => new Date()))();
  const portal = deps.portal ?? 'taxscan';
  const report = emptyFlush(dry);
  const skipped = await gate(deps, now, portal);
  if (skipped) return { ...report, skipped };

  const tags = ourTagIds(cfg);
  const batch = deps.batch ?? WRITER_BATCH;
  const only = deps.onlyHashes ? { emailHash: { in: [...deps.onlyHashes] } } : {};
  const dueWhere = { nextAttemptAt: { lte: now }, email: { not: null }, ...only };
  // 1. Everything but FREE first: PREMIUM / FORMER / removals are never held by FREE admissions.
  const first = await prisma.audienceMember.findMany({
    where: { ...dueWhere, desiredRole: { not: 'FREE' } },
    orderBy: { nextAttemptAt: 'asc' },
    take: batch,
  });
  // 2. FREE members already admitted, or already carrying one of our tags (a role swap is never capped).
  const admittedFree =
    first.length < batch
      ? await prisma.audienceMember.findMany({
          where: { ...dueWhere, desiredRole: 'FREE', OR: [{ admittedAt: { not: null } }, { appliedTags: { isEmpty: false } }] },
          orderBy: { nextAttemptAt: 'asc' },
          take: batch - first.length,
        })
      : [];
  const due = [...first, ...admittedFree];
  report.members = due.length;

  if (dry) {
    for (const m of due) {
      const d = diffMember(m, { premium: tags.premium || 'premium', former: tags.former || 'former', free: cfg.freeReaders ? tags.free || 'free' : '', noMarketing: tags.noMarketing || 'no_marketing' });
      report.wouldAdd += d.adds.length;
      report.wouldRemove += d.removes.length;
    }
    const key = `${report.members}/${report.wouldAdd}/${report.wouldRemove}`;
    if (report.members > 0 && (key !== lastDryLog.key || now.getTime() - lastDryLog.at > 3_600_000)) {
      lastDryLog = { key, at: now.getTime() };
      // eslint-disable-next-line no-console
      console.log(`[audience] writer dry-run members=${report.members} would_add=${report.wouldAdd} would_remove=${report.wouldRemove}`);
    }
    return report;
  }

  const problems = writerConfigProblems(cfg);
  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[audience] writer not configured — nothing written: ${problems.join(', ')} unset`);
    return { ...report, skipped: 'not_configured' };
  }
  const admitBudget = freeWritesReady(cfg) && cfg.freeAdmitPerDay > 0 ? batch - due.length : 0;
  if (due.length === 0 && admitBudget <= 0) return report;

  const client = deps.client ?? createContactClient(cfg);
  const pacer = new Pacer(cfg.thresholds.writeRps, deps.clock, deps.sleep);
  const ctx: WriteCtx = { client, pacer, cfg, tags, report, names: null, now, refused: new Map() };
  try {
    ctx.names = await resolveTagNames(ctx);
  } catch (err) {
    const kind = err instanceof ContactError ? err.kind : 'RETRYABLE';
    if (kind === 'FATAL') await raiseAudienceAlert(portal, 'audience_writer_fatal', { count: 1, reason: err instanceof ContactError && err.http ? `tags_${err.http}` : 'tag_ids' }, now);
    report.retry = due.length;
    return report;
  }

  let fatalReason: string | null = null;
  for (const m of due) {
    // Re-read inside the tick: the time between the select and the write is minutes at most.
    const fresh = await prisma.audienceMember.findUnique({ where: { emailHash: m.emailHash } });
    if (!fresh || !fresh.email || !fresh.nextAttemptAt || fresh.nextAttemptAt > now) continue;
    const r = await writeOne(fresh, ctx);
    if (r === 'fatal') fatalReason ??= 'contact_write';
  }
  // 3. Admit waiting FREE members, only with room under today's cap.
  if (admitBudget > 0) {
    const r = await admitFree(ctx, admitBudget, deps.onlyHashes);
    if (r === 'fatal') fatalReason ??= 'contact_write';
  }

  logRefusals(ctx.refused);
  if (fatalReason) await raiseAudienceAlert(portal, 'audience_writer_fatal', { count: report.fatal, reason: fatalReason }, now);
  // A retrying member always has nextAttemptAt set (FATAL ones have none): the filter lets the nextAttemptAt index serve this every-minute count.
  const failing = await prisma.audienceMember.count({ where: { nextAttemptAt: { not: null }, lastErrorKind: 'RETRYABLE', attempts: { gte: FAILING_ATTEMPTS } } });
  if (failing > 0) await raiseAudienceAlert(portal, 'audience_writer_failing', { count: failing }, now);
  if (deps.sendAlerts !== false && (fatalReason || failing > 0)) await sendAudienceAlerts(portal, { ...(deps.alertDeps ?? {}), now });

  // eslint-disable-next-line no-console
  console.log(
    `[audience] writer members=${report.members} created=${report.created} tagged=${report.tagged} removed=${report.removed}` +
      ` resubscribed=${report.resubscribed} already=${report.resubscribeAlready} pending=${report.resubscribePending} resubRefused=${report.resubscribeRefused} resubSkipped=${report.resubscribeSkipped} consentTooOld=${report.resubscribeConsentTooOld} looked=${report.looked} admitted=${report.admitted} done=${report.done} deleted=${report.deleted} retry=${report.retry} fatal=${report.fatal} requests=${report.requests}`,
  );
  return report;
}

type WriteCtx = {
  client: McContactClient;
  pacer: Pacer;
  cfg: AudienceEnv;
  tags: TagIds;
  report: FlushReport;
  /** Tag id → name for our three tags (PUT / create send names — UNVERIFIED M-9). */
  names: Map<string, string> | null;
  now: Date;
  /** FATAL reasons seen this tick: `op|http|text` → members refused (logged once per distinct reason). */
  refused: Map<string, number>;
};

export const REFUSED_REASON_MAX = 120;

/** `[audience] writer refused op=… http=… count=N reason="…"` — the provider's text only, redacted, never an address. */
function noteRefusal(ctx: WriteCtx, err: unknown): void {
  const e = err instanceof ContactError ? err : null;
  const raw = e ? e.message.replace(/^mailercloud contacts [A-Za-z]+: /, '') : 'unknown';
  const reason = redactText(raw).replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, REFUSED_REASON_MAX);
  const key = `${e?.op ?? 'unknown'}|${e?.http ?? 'none'}|${reason}`;
  ctx.refused.set(key, (ctx.refused.get(key) ?? 0) + 1);
}

function logRefusals(refused: Map<string, number>): void {
  for (const [key, count] of refused) {
    const [op, http, ...rest] = key.split('|');
    // eslint-disable-next-line no-console
    console.log(`[audience] writer refused op=${op} http=${http} count=${count} reason="${rest.join('|')}"`);
  }
}

async function resolveTagNames(ctx: WriteCtx): Promise<Map<string, string>> {
  await ctx.pacer.take();
  ctx.report.requests += 1;
  const catalogue = await ctx.client.listTags();
  const names = new Map<string, string>();
  for (const id of configuredIds(ctx.tags)) {
    const t = catalogue.find((c) => c.id === id);
    if (!t) throw new ContactError('FATAL', 'mailercloud contacts listTags: a configured tag id does not exist');
    names.set(id, t.name);
  }
  return names;
}

/** Read-back tokens (names or ids) → our tag ids present on the contact. */
function oursIn(contact: McContact, ctx: WriteCtx): string[] {
  const out: string[] = [];
  for (const [id, name] of ctx.names!) if (contact.tags.includes(id) || contact.tags.includes(name)) out.push(id);
  return out;
}

async function call<T>(ctx: WriteCtx, fn: () => Promise<T>): Promise<T> {
  await ctx.pacer.take();
  ctx.report.requests += 1;
  return fn();
}

/**
 * Mailercloud already refuses mail to this address (an unsubscribe, hard bounce or spam report ON THIS
 * ADDRESS, copied to our suppression list by its webhook). Then even the exclusion tag is skipped: it
 * cannot reduce mail further, and until M-2 proves PUT leaves an unsubscribed contact unsubscribed a
 * PUT is the one write that could re-activate it. Our own suppressions (ACCOUNT_DELETED, MANUAL, or an
 * opt-out that only follows the account from an old address) still get the exclusion tag.
 */
async function mailercloudBlocksAddress(emailHash: string): Promise<boolean> {
  const n = await prisma.emailSuppression.count({ where: { emailHash, reason: { in: ['UNSUBSCRIBE', 'HARD_BOUNCE', 'SPAM'] } } });
  return n > 0;
}

/** 00:00 IST of `now`'s IST day. */
function istDayStartOf(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

/** FREE members admitted in `now`'s IST day (the cap reads `admittedAt`). */
export async function freeAdmittedToday(now: Date): Promise<number> {
  const start = istDayStartOf(now);
  return prisma.audienceMember.count({ where: { admittedAt: { gte: start, lt: new Date(start.getTime() + 24 * 3_600_000) } } });
}

/** A FREE member never written by us: no admission, none of our tags. Suppressed ones are never admitted. */
const waitingWhere = (only?: readonly string[]) => ({
  desiredRole: 'FREE',
  admittedAt: null,
  appliedTags: { isEmpty: true },
  email: { not: null },
  suppressed: false,
  ...(only ? { emailHash: { in: [...only] } } : {}),
});

/**
 * Step 3 of a tick (see the header). `budget` = members this tick may still touch (lookups + admissions).
 * Lookups are a GET only: they record `mcState` so the ones Mailercloud already holds go first. A RETRYABLE
 * lookup error stops the lookups for this tick; a FATAL one marks the member ABSENT (its create then
 * surfaces the refusal the usual way), so one bad address never blocks the rest.
 */
async function admitFree(ctx: WriteCtx, budget: number, only?: readonly string[]): Promise<'ok' | 'fatal'> {
  const room = ctx.cfg.freeAdmitPerDay - (await freeAdmittedToday(ctx.now));
  if (room <= 0) return 'ok';
  let left = budget;

  const unknown = await prisma.audienceMember.findMany({
    where: { ...waitingWhere(only), mcState: 'UNKNOWN' },
    orderBy: { emailHash: 'asc' },
    take: left,
  });
  for (const m of unknown) {
    let state: 'PRESENT' | 'ABSENT';
    try {
      state = (await call(ctx, () => ctx.client.getContact(m.email!))) ? 'PRESENT' : 'ABSENT';
    } catch (err) {
      if (!(err instanceof ContactError) || err.kind !== 'FATAL') break;
      state = 'ABSENT';
    }
    left -= 1;
    ctx.report.looked += 1;
    await prisma.audienceMember.updateMany({ where: { emailHash: m.emailHash, updatedAt: m.updatedAt }, data: { mcState: state } });
  }

  const take = Math.min(room, left);
  if (take <= 0) return 'ok';
  const picks = await prisma.audienceMember.findMany({ where: { ...waitingWhere(only), mcState: 'PRESENT' }, orderBy: { emailHash: 'asc' }, take });
  if (picks.length < take && (await prisma.audienceMember.count({ where: { ...waitingWhere(only), mcState: 'UNKNOWN' } })) === 0) {
    picks.push(
      ...(await prisma.audienceMember.findMany({ where: { ...waitingWhere(only), mcState: 'ABSENT' }, orderBy: { emailHash: 'asc' }, take: take - picks.length })),
    );
  }
  let result: 'ok' | 'fatal' = 'ok';
  for (const p of picks) {
    const stamped = await prisma.audienceMember.updateMany({
      where: { emailHash: p.emailHash, desiredRole: 'FREE', admittedAt: null, suppressed: false },
      data: { admittedAt: ctx.now },
    });
    if (stamped.count !== 1) continue;
    const fresh = await prisma.audienceMember.findUnique({ where: { emailHash: p.emailHash } });
    if (!fresh?.email) continue;
    ctx.report.admitted += 1;
    if ((await writeOne(fresh, ctx)) === 'fatal') result = 'fatal';
  }
  return result;
}

/** The member's CURRENT, live, consent-true CMS accounts (the rows a lift needs): how many, and the latest `consentAt` among them (null when none has one). */
async function liveConsent(emailHash: string): Promise<{ accounts: number; latest: Date | null }> {
  const rows = await prisma.cmsAccount.findMany({ where: { emailHash, deletedAt: null, outOfScopeAt: null, consentValue: true }, select: { consentAt: true } });
  const times = rows.map((r) => r.consentAt).filter((d): d is Date => d !== null);
  return { accounts: rows.length, latest: times.length > 0 ? new Date(Math.max(...times.map((d) => d.getTime()))) : null };
}

async function writeOne(m: AudienceMember, ctx: WriteCtx): Promise<'done' | 'retry' | 'fatal'> {
  const email = m.email!;
  const { client, report } = ctx;
  const diff = diffMember(m, ctx.tags);
  const removes = diff.removes;
  const adds = m.suppressed && diff.adds.length > 0 && (await mailercloudBlocksAddress(m.emailHash)) ? [] : diff.adds;
  const applied = new Set(m.appliedTags);
  let mcState = m.mcState;
  const resubDue = m.resubscribePending;
  let resubDone = false;
  try {
    let contact: McContact | null | undefined;
    if (adds.length > 0 || resubDue) contact = await call(ctx, () => client.getContact(email));
    if (contact !== undefined) mcState = contact ? 'PRESENT' : 'ABSENT';

    if (adds.length > 0) {
      if (contact === null) {
        try {
          await call(ctx, () => client.createContact(email, ctx.cfg.mailercloud.listId, adds.map((id) => ctx.names!.get(id)!)));
          for (const t of adds) applied.add(t);
          mcState = 'PRESENT';
          report.created += 1;
        } catch (err) {
          if (!(err instanceof ContactError) || err.kind !== 'ALREADY_EXISTS') throw err;
          // M-1: someone created it between our GET and our create — never retried as an upsert.
          contact = await call(ctx, () => client.getContact(email));
          if (!contact) throw new ContactError('RETRYABLE', 'mailercloud contacts createContact: exists but not readable');
        }
      }
      if (contact) {
        for (const t of oursIn(contact, ctx)) applied.add(t);
        const union = [...new Set([...contact.tags.map((t) => ctx.names!.get(t) ?? t), ...adds.map((id) => ctx.names!.get(id)!)])];
        await call(ctx, () => client.putTags(email, union));
        for (const t of adds) applied.add(t);
        mcState = 'PRESENT';
        report.tagged += 1;
      }
    }

    if (removes.length > 0) {
      if (mcState === 'ABSENT') {
        for (const t of removes) applied.delete(t); // nothing there to remove
      } else {
        try {
          await call(ctx, () => client.removeTags(email, removes));
          report.removed += 1;
        } catch (err) {
          if (!(err instanceof ContactError) || err.kind !== 'ABSENT') throw err;
          mcState = 'ABSENT';
        }
        for (const t of removes) applied.delete(t);
      }
    }

    if (resubDue) {
      const consent = await liveConsent(m.emailHash);
      if (ctx.cfg.resubscribeWrites && !m.suppressed && consent.accounts > 0 && contact) {
        const age = consent.latest ? ctx.now.getTime() - consent.latest.getTime() : null;
        if (consent.latest === null || age === null || age < 0 || age > RESUBSCRIBE_CONSENT_MAX_AGE_MS) {
          // No usable consent time (missing, in the future, or older than 90 days): Mailercloud would refuse it, so nothing is sent.
          report.resubscribeSkipped += 1;
          report.resubscribeConsentTooOld += 1;
        } else {
          const at = consent.latest;
          try {
            const outcome = await call(ctx, () => client.resubscribe(email, { source: RESUBSCRIBE_CONSENT_SOURCE, at }));
            if (outcome === 'subscribed') report.resubscribed += 1;
            else if (outcome === 'already') report.resubscribeAlready += 1;
            else report.resubscribePending += 1;
          } catch (err) {
            // Not found / bounced / spam / suppressed / consent refused: final. The lift is handled and counted, never retried, no alert.
            if (!(err instanceof ContactError) || err.kind !== 'NOT_RESUBSCRIBABLE') throw err;
            report.resubscribeRefused += 1;
          }
        }
      } else {
        report.resubscribeSkipped += 1;
      }
      resubDone = true;
    }

    await finish(m, { applied: [...applied], mcState, resubDone, ok: true }, ctx);
    report.done += 1;
    return 'done';
  } catch (err) {
    const kind = err instanceof ContactError && err.kind === 'FATAL' ? 'FATAL' : 'RETRYABLE';
    if (!(err instanceof ContactError)) {
      // eslint-disable-next-line no-console
      console.error('[audience] writer member failed', safeErrorLog(err));
    }
    await finish(m, { applied: [...applied], mcState, resubDone, ok: false, kind }, ctx);
    if (kind === 'FATAL') {
      report.fatal += 1;
      noteRefusal(ctx, err);
    } else report.retry += 1;
    return kind === 'FATAL' ? 'fatal' : 'retry';
  }
}

/**
 * Persist what Mailercloud acknowledged (`appliedTags` is the truth, even after a partial failure).
 * If ingest changed the member meanwhile (its `updatedAt` moved), it stays due; a member with no
 * role, no exclusion, nothing applied and nothing pending is deleted (no address kept, design §4).
 */
async function finish(
  seen: AudienceMember,
  r: { applied: string[]; mcState: string; resubDone: boolean; ok: boolean; kind?: 'FATAL' | 'RETRYABLE' },
  ctx: WriteCtx,
): Promise<void> {
  const now = ctx.now;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "AudienceMember" WHERE "emailHash" = ${seen.emailHash} FOR UPDATE`;
    const cur = await tx.audienceMember.findUnique({ where: { emailHash: seen.emailHash } });
    if (!cur) return;
    const untouched = cur.updatedAt.getTime() === seen.updatedAt.getTime();
    const resubscribePending = r.resubDone && untouched ? false : cur.resubscribePending;
    if (r.ok) {
      if (untouched && cur.desiredRole === 'NONE' && !cur.noMarketing && r.applied.length === 0 && !resubscribePending) {
        await tx.audienceMember.delete({ where: { emailHash: seen.emailHash } });
        ctx.report.deleted += 1;
        return;
      }
      await tx.audienceMember.update({
        where: { emailHash: seen.emailHash },
        data: { appliedTags: r.applied, mcState: r.mcState, attempts: 0, lastErrorKind: null, syncedAt: now, resubscribePending, nextAttemptAt: untouched ? null : now },
      });
      return;
    }
    const attempts = cur.attempts + 1;
    await tx.audienceMember.update({
      where: { emailHash: seen.emailHash },
      data: {
        appliedTags: r.applied,
        mcState: r.mcState,
        attempts,
        lastErrorKind: r.kind ?? 'RETRYABLE',
        // FATAL stops this member (a config/quota fix + a new snapshot makes it due again).
        nextAttemptAt: r.kind === 'FATAL' ? null : new Date(now.getTime() + retryDelayMin(attempts) * 60_000),
      },
    });
  });
}

// ─── drift check (nightly, after the full pull) ──────────────────────────────

export type DriftReport = {
  skipped?: string;
  sampled: number;
  mismatched: number;
  premiumOurs: number;
  premiumMailercloud: number | null;
};

/**
 * (a) Our applied Premium count against Mailercloud's (M-5: a segment's `active_count` when
 * AUDIENCE_MC_PREMIUM_SEGMENT_ID is set, else a count on the tag if tags/search gives one, else
 * unknown); (b) 50 random members read back with GET and compared tag by tag — a mismatch takes
 * Mailercloud's truth into `appliedTags` and makes the member due, so the next tick repairs it.
 * Stored on `AudienceSyncState.drift`; `audience_drift` when anything is off. Writes on only.
 */
export async function driftCheck(deps: WriterDeps = {}): Promise<DriftReport> {
  const cfg = deps.cfg ?? env.audience;
  const now = (deps.now ?? (() => new Date()))();
  const portal = deps.portal ?? 'taxscan';
  const out: DriftReport = { sampled: 0, mismatched: 0, premiumOurs: 0, premiumMailercloud: null };
  if (!cfg.writeMailercloud || writerConfigProblems(cfg).length > 0) return { ...out, skipped: 'writes_off' };
  if (inSendWindow(now, (deps.digestCfg ?? env.digest).sendAt)) return { ...out, skipped: 'send_window' };
  if (writing || isPullRunning()) return { ...out, skipped: 'busy' };
  writing = true;
  try {
    const client = deps.client ?? createContactClient(cfg);
    const tags = ourTagIds(cfg);
    const ctx: WriteCtx = { client, pacer: new Pacer(cfg.thresholds.writeRps, deps.clock, deps.sleep), cfg, tags, report: emptyFlush(false), names: null, now, refused: new Map() };
    ctx.names = await resolveTagNames(ctx);
    out.premiumOurs = await prisma.audienceMember.count({ where: { appliedTags: { has: tags.premium } } });
    out.premiumMailercloud = cfg.mailercloud.premiumSegmentId
      ? await call(ctx, () => client.segmentCount(cfg.mailercloud.premiumSegmentId))
      : await call(ctx, () => client.tagCount(tags.premium));
    const only = deps.onlyHashes ? [...deps.onlyHashes] : null;
    const sample = only
      ? await prisma.$queryRaw<{ emailHash: string }[]>`
          SELECT "emailHash" FROM "AudienceMember"
           WHERE email IS NOT NULL AND (cardinality("appliedTags") > 0 OR "desiredRole" <> 'NONE' OR "noMarketing")
             AND NOT ("desiredRole" = 'FREE' AND "admittedAt" IS NULL AND cardinality("appliedTags") = 0)
             AND "emailHash" = ANY(${only}::text[])
           ORDER BY random() LIMIT ${DRIFT_SAMPLE}`
      : await prisma.$queryRaw<{ emailHash: string }[]>`
          SELECT "emailHash" FROM "AudienceMember"
           WHERE email IS NOT NULL AND (cardinality("appliedTags") > 0 OR "desiredRole" <> 'NONE' OR "noMarketing")
             AND NOT ("desiredRole" = 'FREE' AND "admittedAt" IS NULL AND cardinality("appliedTags") = 0)
           ORDER BY random() LIMIT ${DRIFT_SAMPLE}`;
    for (const { emailHash } of sample) {
      const m = await prisma.audienceMember.findUnique({ where: { emailHash } });
      if (!m?.email) continue;
      const contact = await call(ctx, () => client.getContact(m.email!));
      out.sampled += 1;
      const observed = contact ? oursIn(contact, ctx).sort() : [];
      const applied = m.appliedTags.filter((t) => configuredIds(tags).includes(t)).sort();
      if (observed.join(',') !== applied.join(',')) {
        out.mismatched += 1;
        await prisma.audienceMember.updateMany({
          where: { emailHash, updatedAt: m.updatedAt },
          data: { appliedTags: observed, mcState: contact ? 'PRESENT' : 'ABSENT', nextAttemptAt: now },
        });
      }
    }
    await prisma.audienceSyncState.upsert({
      where: { portal },
      create: { portal, drift: { at: now.toISOString(), ...out } },
      update: { drift: { at: now.toISOString(), ...out } },
    });
    const countOff =
      out.premiumMailercloud !== null &&
      Math.abs(out.premiumMailercloud - out.premiumOurs) > Math.max(Math.ceil((out.premiumOurs * cfg.thresholds.premiumDeviationPct) / 100), DRIFT_MIN_ABS);
    if (out.mismatched > 0 || countOff) {
      await raiseAudienceAlert(
        portal,
        'audience_drift',
        { sampled: out.sampled, mismatched: out.mismatched, premiumOurs: out.premiumOurs, premiumMailercloud: out.premiumMailercloud },
        now,
      );
      if (deps.sendAlerts !== false) await sendAudienceAlerts(portal, { ...(deps.alertDeps ?? {}), now });
    }
    // eslint-disable-next-line no-console
    console.log(
      `[audience] drift sampled=${out.sampled} mismatched=${out.mismatched} premium_ours=${out.premiumOurs} premium_mailercloud=${out.premiumMailercloud ?? 'unknown'}`,
    );
    return out;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[audience] drift check failed (${err instanceof ContactError ? err.kind : 'error'})`);
    return { ...out, skipped: 'failed' };
  } finally {
    writing = false;
  }
}

/**
 * ADMIN "Retry refused": makes every FATAL member with an address due again (`nextAttemptAt` = now, attempts and
 * error kind cleared). The writer's gates still apply on the next tick. Audited with counts only — no address.
 * Erased members (`email` null) are left alone. `onlyHashes` is for tests only (the route never passes it). Returns the counts.
 */
export async function retryRefused(actorUserId: string | null, now: Date = new Date(), onlyHashes?: readonly string[]): Promise<{ premium: number; former: number; other: number; total: number }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.audienceMember.findMany({ where: { lastErrorKind: 'FATAL', email: { not: null }, ...(onlyHashes ? { emailHash: { in: [...onlyHashes] } } : {}) }, select: { emailHash: true, desiredRole: true } });
    const counts = { premium: 0, former: 0, other: 0, total: rows.length };
    for (const r of rows) {
      if (r.desiredRole === 'PREMIUM') counts.premium += 1;
      else if (r.desiredRole === 'FORMER') counts.former += 1;
      else counts.other += 1;
    }
    if (rows.length === 0) return counts;
    await tx.audienceMember.updateMany({
      where: { emailHash: { in: rows.map((r) => r.emailHash) }, lastErrorKind: 'FATAL', email: { not: null } },
      data: { nextAttemptAt: now, attempts: 0, lastErrorKind: null },
    });
    await tx.auditLog.create({
      data: {
        action: 'AUDIENCE_REFUSED_RETRIED',
        resourceType: 'audience_sync',
        ...(actorUserId ? { userId: actorUserId } : {}),
        metadata: { ...counts, at: now.toISOString() },
      },
    });
    return counts;
  });
}

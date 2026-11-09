import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { recordAudit } from '../../lib/audit';
import { emailHash, escalateReason, normaliseEmail, rankSql } from '../digest/webhook';
import { afterSuppressionWrite } from '../suppression';

/**
 * The one-time import of Mailercloud's own status export (brief 2026-11-09-digest-notice-list). Mailercloud's API shows no
 * per-contact status, so the paid readers it already refuses (unsubscribed, hard-bounced) are invisible to us until an ADMIN uploads the
 * contacts export from Mailercloud's screen. After that the webhooks keep `EmailSuppression` current; there is no recurring sync.
 *
 * What is read: a CSV with an email column and a status column. Accepted header names (case-insensitive, spaces / `_` / `-` / `.`
 * ignored): EMAIL: `email`, `email address`, `email id`, `e-mail`, `mail`, `contact email`; STATUS: `status`, `contact status`,
 * `subscription status`, `subscriber status`, `state`. Status values (same normalising): `Unsubscribed` → UNSUBSCRIBE;
 * `Hard bounce` / `Hard bounced` / `Bounced` / `Bounce` → HARD_BOUNCE; `Spam` / `Complained` / `Complaint` / `Spam complaint` → SPAM;
 * EVERY OTHER status is ignored (active, subscribed, soft bounce, ...). Comma, semicolon or tab separated; a BOM and quoted fields are fine.
 *
 * What is written: only for an address a CMS account holds (`CmsAccount.emailHash`); every other address is counted and left alone
 * (the export is Mailercloud's whole contact book). An `EmailSuppression` upsert on `emailHash`, `source = 'mailercloud_export'`, with
 * the EXISTING escalation rule (`SUPPRESSION_RANK` in digest/webhook.ts: SPAM > HARD_BOUNCE > UNSUBSCRIBE, MANUAL above all, never downgraded), written
 * ONLY when the incoming reason strictly outranks the row's, so a re-import of the same file changes nothing (not even `lastSeenAt`).
 * A new or escalated row goes through `afterSuppressionWrite`, exactly like a Mailercloud webhook opt-out (stamp the account id, mark the
 * audience member suppressed and due). `firstSeenAt` / `lastSeenAt` are the import time: a later CMS opt-in must be dated after it to
 * lift an imported opt-out (the existing consent lift).
 *
 * Addresses are normalised and hashed here and never logged, audited or returned: the reply is counts only.
 */

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const WRITE_CHUNK = 1000;
const LOOKUP_CHUNK = 5000;
const TXN_TIMEOUT_MS = 30_000;

export type ImportReason = 'UNSUBSCRIBE' | 'HARD_BOUNCE' | 'SPAM';
export type ImportCounts = {
  /** Data rows in the file (the header excluded). */
  read: number;
  /** Rows whose address is not a readable email. */
  invalid: number;
  /** Rows whose status is none of the three (active, soft bounce, ...). */
  ignored: number;
  /** Distinct addresses with a mapped status that no CMS account holds (left alone). */
  notInCms: number;
  /** Distinct CMS-held addresses, by their final reason in the file. */
  matched: Record<ImportReason, number>;
  /** Of the matched: a new suppression row / an existing row escalated / already at that reason or stronger (nothing written). */
  created: number;
  upgraded: number;
  unchanged: number;
};

export class ImportRejected extends Error {
  constructor(
    public readonly code: 'empty' | 'too_big' | 'not_csv' | 'no_email_column' | 'no_status_column',
    message: string,
  ) {
    super(message);
  }
}

/* ---------------------------- the CSV ---------------------------- */

/** The separator of a header line: the most frequent of `,` `;` tab (a comma when none appears). */
function delimiterOf(firstLine: string): string {
  let best = ',';
  let bestN = 0;
  for (const d of [',', ';', '\t']) {
    const n = firstLine.split(d).length - 1;
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/** RFC 4180 reading: quoted fields (with `""` inside), CRLF / LF / CR line ends, a quote only at the start of a field. */
export function parseCsv(text: string): string[][] {
  const delim = delimiterOf(text.slice(0, Math.max(0, text.search(/[\r\n]/)) || text.length));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const norm = (s: string): string => s.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_.-]+/g, ' ');
const EMAIL_HEADERS = new Set(['email', 'email address', 'email id', 'e mail', 'mail', 'contact email', 'emailaddress']);
const STATUS_HEADERS = new Set(['status', 'contact status', 'subscription status', 'subscriber status', 'state']);

/** Mailercloud's status words → the three reasons we keep; anything else is null (ignored). */
export function classifyStatus(raw: string): ImportReason | null {
  switch (norm(raw)) {
    case 'unsubscribed':
    case 'unsubscribe':
      return 'UNSUBSCRIBE';
    case 'hard bounce':
    case 'hard bounced':
    case 'hardbounce':
    case 'hardbounced':
    case 'bounced':
    case 'bounce':
      return 'HARD_BOUNCE';
    case 'spam':
    case 'spam complaint':
    case 'spam complaints':
    case 'complained':
    case 'complaint':
      return 'SPAM';
    default:
      return null;
  }
}

type Parsed = { read: number; invalid: number; ignored: number; byHash: Map<string, { email: string; reason: ImportReason }> };

/** Reads the file into one entry per distinct address (the strongest reason wins inside the file). Throws `ImportRejected`. */
export function parseStatusFile(buf: Buffer): Parsed {
  if (buf.length === 0) throw new ImportRejected('empty', 'The file is empty.');
  if (buf.length > IMPORT_MAX_BYTES) throw new ImportRejected('too_big', 'The file is over 5 MB. Export only the paid readers, or split it.');
  const text = buf.toString('utf8');
  if (text.includes('\u0000')) throw new ImportRejected('not_csv', 'That does not look like a CSV file.');
  const rows = parseCsv(text);
  if (rows.length === 0) throw new ImportRejected('empty', 'The file has no rows.');
  const header = rows[0].map(norm);
  const emailCol = header.findIndex((h) => EMAIL_HEADERS.has(h));
  const statusCol = header.findIndex((h) => STATUS_HEADERS.has(h));
  if (emailCol === -1) throw new ImportRejected('no_email_column', 'The file has no email column (looked for: Email, Email Address, Contact Email).');
  if (statusCol === -1) throw new ImportRejected('no_status_column', 'The file has no status column (looked for: Status, Contact Status, Subscription Status).');
  const out: Parsed = { read: 0, invalid: 0, ignored: 0, byHash: new Map() };
  for (const r of rows.slice(1)) {
    out.read += 1;
    const email = normaliseEmail(r[emailCol] ?? '');
    if (!email) {
      out.invalid += 1;
      continue;
    }
    const reason = classifyStatus(r[statusCol] ?? '');
    if (!reason) {
      out.ignored += 1;
      continue;
    }
    const h = emailHash(email);
    const cur = out.byHash.get(h);
    out.byHash.set(h, { email, reason: cur ? (escalateReason(cur.reason, reason) as ImportReason) : reason });
  }
  return out;
}

/* ---------------------------- the import ---------------------------- */

const byHashAsc = (a: [string, unknown], b: [string, unknown]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

export async function importMailercloudStatuses(buf: Buffer, ctx: { userId: string | null; now: Date; ip?: string | null }): Promise<ImportCounts> {
  const parsed = parseStatusFile(buf);
  const counts: ImportCounts = {
    read: parsed.read,
    invalid: parsed.invalid,
    ignored: parsed.ignored,
    notInCms: 0,
    matched: { UNSUBSCRIBE: 0, HARD_BOUNCE: 0, SPAM: 0 },
    created: 0,
    upgraded: 0,
    unchanged: 0,
  };

  // Which of these addresses does a CMS account hold? (The export is Mailercloud's whole contact book.)
  const all = [...parsed.byHash].sort(byHashAsc);
  const held = new Set<string>();
  for (let i = 0; i < all.length; i += LOOKUP_CHUNK) {
    const part = all.slice(i, i + LOOKUP_CHUNK).map(([h]) => h);
    for (const r of await prisma.cmsAccount.findMany({ where: { emailHash: { in: part } }, distinct: ['emailHash'], select: { emailHash: true } })) {
      if (r.emailHash) held.add(r.emailHash);
    }
  }
  const matched = all.filter(([h]) => held.has(h));
  counts.notInCms = all.length - matched.length;
  for (const [, v] of matched) counts.matched[v.reason] += 1;

  // One transaction per chunk, in hash order (the same lock order as the webhook). A failed chunk leaves earlier ones committed; the
  // import is idempotent, so running it again finishes the job.
  for (let i = 0; i < matched.length; i += WRITE_CHUNK) {
    const part = matched.slice(i, i + WRITE_CHUNK);
    const ids = part.map(() => randomUUID());
    const hashes = part.map(([h]) => h);
    const emails = part.map(([, v]) => v.email);
    const reasons = part.map(([, v]) => v.reason);
    const stamp = ctx.now.toISOString();
    const changed = await prisma.$transaction(
      async (tx) => {
        // Written only when the incoming reason strictly outranks the row's: equal, weaker and MANUAL rows are left exactly as they are.
        const rows = await tx.$queryRaw<{ emailHash: string; inserted: boolean }[]>`
          INSERT INTO "EmailSuppression" AS s (id, email, "emailHash", reason, source, "firstSeenAt", "lastSeenAt")
          SELECT id, email, hash, reason, 'mailercloud_export',
                 (${stamp}::timestamptz AT TIME ZONE 'UTC'),
                 (${stamp}::timestamptz AT TIME ZONE 'UTC')
          FROM unnest(${ids}::text[], ${emails}::text[], ${hashes}::text[], ${reasons}::text[]) AS u(id, email, hash, reason)
          ORDER BY hash
          ON CONFLICT ("emailHash") DO UPDATE SET
            reason = EXCLUDED.reason,
            source = EXCLUDED.source,
            "lastSeenAt" = GREATEST(s."lastSeenAt", EXCLUDED."lastSeenAt")
          WHERE ${rankSql('EXCLUDED.reason')} > ${rankSql('s.reason')}
          RETURNING "emailHash", (xmax = 0) AS inserted`;
        if (rows.length > 0) await afterSuppressionWrite(tx, rows.map((r) => r.emailHash), ctx.now);
        return rows;
      },
      { timeout: TXN_TIMEOUT_MS },
    );
    for (const r of changed) {
      if (r.inserted) counts.created += 1;
      else counts.upgraded += 1;
    }
    counts.unchanged += part.length - changed.length;
  }

  await recordAudit({
    userId: ctx.userId,
    action: 'AUDIENCE_STATUSES_IMPORTED',
    resourceType: 'audience',
    metadata: { ...counts, matched: { ...counts.matched } } as unknown as Prisma.InputJsonObject,
    ipAddress: ctx.ip ?? null,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[audience] statuses imported read=${counts.read} matched=${matched.length} created=${counts.created} upgraded=${counts.upgraded} unchanged=${counts.unchanged} ignored=${counts.ignored} invalid=${counts.invalid} notInCms=${counts.notInCms}`,
  );
  return counts;
}

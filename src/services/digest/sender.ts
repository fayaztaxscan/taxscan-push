import type { DigestAudience, SenderErrorKind } from '@prisma/client';
import { redactText } from '../../lib/redact';
import { env } from '../../lib/env';

/**
 * Provider-neutral email sender for the daily digest
 * (docs/EMAIL_DIGEST_DESIGN.md §4, §12 "Provider: to be confirmed").
 *
 * The runner (`runner.ts → advanceRun`) talks ONLY to this interface, so the
 * provider can be chosen later by writing one implementation of it (task 2).
 * This file deliberately contains no HTTP code and reads no API key.
 *
 * Contract every implementation must keep:
 *  - `createDraft` creates a campaign that CANNOT send on its own (Mailercloud:
 *    `is_publish: "0"`). Only `schedule()` makes it go out.
 *  - `schedule(id, 'now')` acts on an existing campaign id; it never creates one.
 *  - Every failure is thrown as a `SenderError` with a kind:
 *      RETRYABLE — 429 / 5xx / failure before the request was sent (set
 *                  `notSent: true` only when the request provably never left);
 *      FATAL     — 401 bad key, 400 validation, quota or funds (e.g. 9002);
 *      AMBIGUOUS — a timeout AFTER the request was sent on create/schedule:
 *                  the provider may or may not have acted.
 *  - The API key and recipient addresses never appear in an error message.
 */

/** What a draft is created from. `html` is the FROZEN copy stored on DigestSend. */
export type DraftInput = {
  /**
   * Unique, deterministic per portal + IST date + audience:
   * TS-DIGEST-<yyyy-mm-dd>-<AUDIENCE> (`digestProviderCampaignName` in runner.ts).
   * Older rows carry TS-DIGEST-<yyyy-mm-dd>-<AUDIENCE>-<runId>.
   */
  name: string;
  audience: DigestAudience;
  subject: string;
  preheader: string;
  html: string;
  text: string | null;
  /** Provider list/segment/tag ids, from config (fail-closed checked by the runner). */
  target: AudienceTarget;
};

/** Who a variant goes to, as provider ids. Free must carry a premium exclude. */
export type AudienceTarget = {
  listIds: string[];
  segmentIds: string[];
  tagIds: string[];
  excludeListIds: string[];
  excludeTagIds: string[];
};

/** The provider's view of a campaign, normalised. */
export type ProviderCampaignState =
  | 'DRAFT' // created, not scheduled
  | 'SCHEDULED' // accepted for sending, not started
  | 'SENDING'
  | 'SENT'
  | 'PARTIALLY_SENT'
  | 'FAILED'; // provider gave up; reached may still be > 0

export type CampaignStatus = {
  state: ProviderCampaignState;
  targeted: number | null;
  reached: number | null;
};

export type CampaignReport = { opens: number | null; clicks: number | null };

export interface DigestSender {
  /** Credential + reachability check. Resolves on success, throws SenderError otherwise. */
  health(): Promise<void>;
  /** Creates a draft that cannot send by itself. Returns the provider's campaign id. */
  createDraft(input: DraftInput): Promise<{ campaignId: string }>;
  /**
   * Replaces the subject of an existing DRAFT, and nothing else (Mailercloud: `PUT /campaign/{id}` with `{ subject }` only —
   * never lists, sender, schedule or html). Errors as for the other calls; the subject never appears in an error message.
   */
  updateSubject(campaignId: string, subject: string): Promise<void>;
  /** Sends an existing draft now. Never creates a campaign. */
  schedule(campaignId: string, when: 'now'): Promise<void>;
  status(campaignId: string): Promise<CampaignStatus>;
  report(campaignId: string): Promise<CampaignReport>;
  /** Test send to internal addresses only (testSend.ts checks the list; task 7). */
  testSend(campaignId: string, emails: string[]): Promise<void>;
  /**
   * OPTIONAL: find a campaign by its exact unique name. Resolves an AMBIGUOUS
   * create without risking a second campaign: found → reuse that id; null →
   * none exists, a create is safe. A provider without a lookup leaves the
   * ambiguity to a human ("Retry now" after checking the provider's UI).
   */
  findCampaignByName?(name: string): Promise<{ campaignId: string } | null>;
  /**
   * OPTIONAL (task 13): whether the provider-side webhook with this id is
   * switched on. Read-only. Throws a SenderError when the answer cannot be read
   * — an unreadable answer is never "inactive".
   */
  webhookStatus?(webhookId: string): Promise<{ active: boolean }>;
}

/**
 * `SenderError.code` of a name lookup that found MORE than one campaign with the
 * exact name (one copied by hand in Mailercloud, say). RETRYABLE so the variant
 * carries on by itself once a person deletes the extra one, but it is shown as
 * its own problem ("two campaigns named … exist"), never as "not answering".
 */
export const DUPLICATE_NAME_CODE = 'duplicate_name';

/** True for a lookup refused because two campaigns share the exact name. */
export function isDuplicateNameError(err: unknown): boolean {
  return err instanceof SenderError && err.code === DUPLICATE_NAME_CODE;
}

/** Typed provider failure. `code` is the provider's own error code when it has one (e.g. "9002"). */
export class SenderError extends Error {
  readonly kind: SenderErrorKind;
  readonly code: string | null;
  readonly http: number | null;
  /**
   * True ONLY when the sender knows the request never left this process
   * (connection refused, DNS failure, refused before writing the body). A
   * timeout or socket reset after the body was sent must leave this false —
   * the provider may have acted. Never inferred from `http === null`.
   */
  readonly notSent: boolean;

  constructor(
    kind: SenderErrorKind,
    message: string,
    opts: { code?: string | null; http?: number | null; notSent?: boolean } = {},
  ) {
    super(message);
    this.name = 'SenderError';
    this.kind = kind;
    this.code = opts.code ?? null;
    this.http = opts.http ?? null;
    this.notSent = opts.notSent ?? false;
  }
}

/**
 * Classifies anything a sender threw. A non-SenderError (a bug, a network
 * exception that escaped the client) is RETRYABLE: the policy bounds it by the
 * cut-off, and retrying a create is only reached after the claim and the
 * "persist id first" rule, so it cannot produce a second sent campaign.
 */
export function errorKind(err: unknown): SenderErrorKind {
  return err instanceof SenderError ? err.kind : 'RETRYABLE';
}

/**
 * The text stored in `DigestSend.lastError` and alerts: email-shaped
 * substrings (plain or %40-encoded) masked, key-like parameters and any
 * configured secret value masked, truncated to 300 chars, provider code/HTTP
 * status kept. `secrets` defaults to the configured provider API key.
 */
export function redactError(err: unknown, secrets: string[] = [env.digest.mailercloud.apiKey]): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (err instanceof SenderError) {
    const tags = [err.http !== null ? `http=${err.http}` : '', err.code ? `code=${err.code}` : ''].filter(Boolean);
    if (tags.length) msg = `${msg} (${tags.join(' ')})`;
  }
  msg = redactText(msg, secrets);
  return msg.length > 300 ? `${msg.slice(0, 297)}...` : msg;
}

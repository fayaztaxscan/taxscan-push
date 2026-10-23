import type { SenderErrorKind } from '@prisma/client';
import {
  SenderError,
  type CampaignReport,
  type CampaignStatus,
  type DigestSender,
  type DraftInput,
  type ProviderCampaignState,
} from '../services/digest/sender';

/**
 * Scriptable in-memory DigestSender for the digest runner tests
 * (docs/EMAIL_DIGEST_DESIGN.md §10). No network, no key, no addresses.
 *
 *   const s = new FakeSender();
 *   s.fail('createDraft', 'RETRYABLE', 2);          // next two creates throw RETRYABLE
 *   s.fail('createDraft', 'AMBIGUOUS', 1, { applied: true });
 *   s.setStatus({ state: 'SENT', targeted: 100, reached: 60 });   // partial
 *   s.count('createDraft')                           // calls made
 *
 * `withLookup: true` gives it the optional `findCampaignByName`.
 */

type Method = 'health' | 'createDraft' | 'schedule' | 'status' | 'report' | 'testSend' | 'findCampaignByName' | 'webhookStatus';

/** `applied`: the provider DID act, then the reply was lost (the call still throws). */
type Failure = { kind: SenderErrorKind; code?: string; http?: number; applied?: boolean; notSent?: boolean };

type FakeCampaign = { id: string; name: string; state: ProviderCampaignState; input: DraftInput };

let seq = 0;

export class FakeSender implements DigestSender {
  readonly calls: { method: Method; args: unknown[] }[] = [];
  readonly campaigns = new Map<string, FakeCampaign>();
  // Per-call script: a Failure, or null = this call succeeds. Empty queue = success.
  private readonly failures: Partial<Record<Method, (Failure | null)[]>> = {};
  private readonly delayQueue: Partial<Record<Method, number[]>> = {};
  private statusOverride: CampaignStatus | null = null;
  /** Artificial latency per method, to hold a step claim open in concurrency tests. */
  delayMs: Partial<Record<Method, number>> = {};
  /** What `webhookStatus()` reports (task 13); script a failure with `fail('webhookStatus', …)`. */
  webhookActive = true;
  findCampaignByName?: (name: string) => Promise<{ campaignId: string } | null>;

  constructor(opts: { withLookup?: boolean } = {}) {
    if (opts.withLookup) {
      this.findCampaignByName = async (name: string) => {
        await this.enter('findCampaignByName', [name]);
        const c = [...this.campaigns.values()].find((x) => x.name === name);
        return c ? { campaignId: c.id } : null;
      };
    }
  }

  /** The next `times` calls of `method` throw a SenderError of `kind`. */
  fail(method: Method, kind: SenderErrorKind, times = 1, extra: Omit<Failure, 'kind'> = {}): this {
    const q = (this.failures[method] ??= []);
    for (let i = 0; i < times; i++) q.push({ kind, ...extra });
    return this;
  }

  /** The next `times` calls of `method` succeed (to script "first call ok, second fails"). */
  pass(method: Method, times = 1): this {
    const q = (this.failures[method] ??= []);
    for (let i = 0; i < times; i++) q.push(null);
    return this;
  }

  /** Per-call latency for the next calls of `method`, in order (then `delayMs`). */
  delays(method: Method, ms: number[]): this {
    (this.delayQueue[method] ??= []).push(...ms);
    return this;
  }

  /** Overrides what status() reports for every campaign (null = the tracked state). */
  setStatus(s: CampaignStatus | null): this {
    this.statusOverride = s;
    return this;
  }

  count(method: Method): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  /** The DraftInput of every createDraft call, in order. */
  draftInputs(): DraftInput[] {
    return this.calls.filter((c) => c.method === 'createDraft').map((c) => c.args[0] as DraftInput);
  }

  private async enter(method: Method, args: unknown[]): Promise<Failure | null> {
    this.calls.push({ method, args });
    // The scripted outcome belongs to the call in the order calls START, not finish.
    const f = this.failures[method]?.shift() ?? null;
    const d = this.delayQueue[method]?.shift() ?? this.delayMs[method];
    if (d) await new Promise((r) => setTimeout(r, d));
    if (f && !f.applied) throw this.toError(method, f);
    return f;
  }

  private toError(method: Method, f: Failure): SenderError {
    return new SenderError(f.kind, `fake ${method} ${f.kind.toLowerCase()} for ops@example.com`, {
      code: f.code ?? null,
      http: f.http ?? null,
      notSent: f.notSent ?? false,
    });
  }

  async health(): Promise<void> {
    await this.enter('health', []);
  }

  async createDraft(input: DraftInput): Promise<{ campaignId: string }> {
    const f = await this.enter('createDraft', [input]);
    const id = `fake-${Date.now()}-${++seq}-${Math.floor(Math.random() * 1e9)}`;
    this.campaigns.set(id, { id, name: input.name, state: 'DRAFT', input });
    // AMBIGUOUS-after-the-fact: the provider made the campaign, the reply was lost.
    if (f?.applied) throw this.toError('createDraft', f);
    return { campaignId: id };
  }

  async schedule(campaignId: string, when: 'now'): Promise<void> {
    const f = await this.enter('schedule', [campaignId, when]);
    const c = this.campaigns.get(campaignId);
    if (!c) throw new SenderError('FATAL', 'fake schedule: unknown campaign', { http: 404 });
    c.state = 'SCHEDULED';
    if (f?.applied) throw this.toError('schedule', f);
  }

  async status(campaignId: string): Promise<CampaignStatus> {
    await this.enter('status', [campaignId]);
    if (this.statusOverride) return { ...this.statusOverride };
    const c = this.campaigns.get(campaignId);
    return { state: c?.state ?? 'DRAFT', targeted: null, reached: null };
  }

  async report(campaignId: string): Promise<CampaignReport> {
    await this.enter('report', [campaignId]);
    return { opens: null, clicks: null };
  }

  async testSend(campaignId: string, emails: string[]): Promise<void> {
    await this.enter('testSend', [campaignId, emails.length]);
  }

  async webhookStatus(webhookId: string): Promise<{ active: boolean }> {
    await this.enter('webhookStatus', [webhookId]);
    return { active: this.webhookActive };
  }
}

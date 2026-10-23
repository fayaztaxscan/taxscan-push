import type { DigestAudience } from '@prisma/client';
import { env, type DigestEnv } from '../../lib/env';
import { createMailercloudSender, type MailercloudOptions, type MailercloudSender } from './mailercloud';
import { redactError } from './sender';
import { digestProviderCampaignName } from './runner';

/**
 * Read-only Mailercloud lookup of a day's digest campaigns (task 13; the pilot
 * runbook's check 2.2 and the after-restore step). Behind `npm run digest:lookup`
 * (`scripts/digest-lookup.ts`).
 *
 * Calls only read endpoints: the campaign-list search (`findCampaignsByName`,
 * every exact-name match, drafts and finished alike as far as Mailercloud's
 * search returns them) and `GET /v1/campaign/{id}` (`status`). Prints name, id,
 * status and reach — never the API key, never an address.
 *
 * It refuses to run unless the client is in read-only mode (`readOnly: true`,
 * which makes `call()` refuse every write before a request is made), so no
 * write is possible from here even by mistake.
 */

export type LookupRow = {
  name: string;
  audience: DigestAudience;
  /** Every campaign Mailercloud has with exactly this name (2+ = duplicates: delete the extra one). */
  found: {
    campaignId: string;
    /** Mailercloud's own status word from the list (e.g. "Draft", "Finished"). */
    listStatus: string | null;
    /** Our normalised state from GET /campaign/{id}, or the read error. */
    state: string | null;
    targeted: number | null;
    reached: number | null;
    error?: string;
  }[];
  error?: string;
};

export class NotReadOnlyError extends Error {
  constructor() {
    super('refused: the Mailercloud client is not in read-only mode, so a write would be possible');
    this.name = 'NotReadOnlyError';
  }
}

/** The only client the lookup accepts: the Mailercloud client with every write refused. */
export function createReadOnlyLookupSender(cfg: DigestEnv = env.digest, overrides: Partial<MailercloudOptions> = {}): MailercloudSender {
  return createMailercloudSender(cfg, { ...overrides, readOnly: true });
}

/** Parses "2026-10-24" into a runDate (00:00 UTC of that IST date), or null. */
export function parseLookupDate(raw: string | undefined): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? null : d;
}

export async function lookupDigestCampaigns(
  sender: MailercloudSender,
  opts: { runDate: Date; portal: string; audiences: DigestAudience[]; cfg?: DigestEnv },
): Promise<LookupRow[]> {
  if (sender.isReadOnly() !== true) throw new NotReadOnlyError();
  const secrets = [(opts.cfg ?? env.digest).mailercloud.apiKey];
  const rows: LookupRow[] = [];
  for (const audience of opts.audiences) {
    const name = digestProviderCampaignName(opts.portal, opts.runDate, audience);
    const row: LookupRow = { name, audience, found: [] };
    try {
      for (const hit of await sender.findCampaignsByName(name)) {
        const f: LookupRow['found'][number] = { campaignId: hit.campaignId, listStatus: hit.status, state: null, targeted: null, reached: null };
        try {
          const st = await sender.status(hit.campaignId);
          f.state = st.state;
          f.targeted = st.targeted;
          f.reached = st.reached;
        } catch (err) {
          f.error = redactError(err, secrets);
        }
        row.found.push(f);
      }
    } catch (err) {
      row.error = redactError(err, secrets);
    }
    rows.push(row);
  }
  return rows;
}

/** Plain lines for the terminal: names, ids, states and counts only. */
export function formatLookup(rows: LookupRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.error) {
      out.push(`${r.name}: lookup failed — ${r.error}`);
      continue;
    }
    if (r.found.length === 0) {
      out.push(`${r.name}: not found in Mailercloud`);
      continue;
    }
    if (r.found.length > 1) out.push(`${r.name}: DUPLICATE — ${r.found.length} campaigns have this exact name; delete the extra one`);
    for (const f of r.found) {
      const reach = f.targeted !== null || f.reached !== null ? ` reach=${f.reached ?? '?'}/${f.targeted ?? '?'}` : '';
      const state = f.error ? `status read failed — ${f.error}` : `state=${f.state}`;
      out.push(`${r.name}: id=${f.campaignId} list-status=${f.listStatus ?? '?'} ${state}${reach}`);
    }
  }
  return out;
}

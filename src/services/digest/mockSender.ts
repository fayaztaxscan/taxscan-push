import { randomBytes } from 'crypto';
import type { CampaignReport, CampaignStatus, DigestSender, DraftInput } from './sender';

/**
 * LOCAL-ONLY in-memory DigestSender. Wired by `src/index.ts` only when
 * `E2E_MOCK_SENDER=true` (the same switch that replaces web-push with a fake
 * for local and end-to-end runs), and by `scripts/seed-digest-sample.ts`.
 * It makes no network call and contacts nobody: drafts get a fake id,
 * "schedule" marks it accepted, status reports SENT with the counts below.
 * Never set E2E_MOCK_SENDER in production.
 */
export function createMockDigestSender(): DigestSender {
  const campaigns = new Map<string, { scheduled: boolean }>();
  return {
    async health() {},
    async createDraft(_input: DraftInput) {
      const campaignId = `mock-${randomBytes(6).toString('hex')}`;
      campaigns.set(campaignId, { scheduled: false });
      return { campaignId };
    },
    async updateSubject() {},
    async schedule(campaignId: string) {
      campaigns.set(campaignId, { scheduled: true });
    },
    async status(campaignId: string): Promise<CampaignStatus> {
      const c = campaigns.get(campaignId);
      return c?.scheduled ? { state: 'SENT', targeted: 120, reached: 118 } : { state: 'DRAFT', targeted: null, reached: null };
    },
    async report(): Promise<CampaignReport> {
      return { opens: null, clicks: null };
    },
    async testSend() {},
    async findCampaignByName() {
      return null;
    },
  };
}

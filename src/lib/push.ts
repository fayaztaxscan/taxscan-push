import webpush, { type PushSubscription, type SendResult, type WebPushError } from 'web-push';
import type { Subscriber } from '@prisma/client';
import { env } from './env';
import { prisma } from './prisma';

let configured = false;

function configure(): void {
  if (configured) return;
  const { publicKey, privateKey, subject } = env.vapid;
  if (!publicKey || !privateKey || !subject) {
    throw new Error(
      'VAPID env vars missing — set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (run `npm run gen:vapid`)',
    );
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  campaignId?: string;
  [key: string]: unknown;
};

export type SendOutcome =
  | { ok: true; statusCode: number }
  | { ok: false; expired: true; statusCode: number; error?: string }
  | { ok: false; expired: false; failed: true; statusCode?: number; error?: string };

function toSubscription(s: Subscriber): PushSubscription {
  return {
    endpoint: s.endpoint,
    keys: { p256dh: s.p256dh, auth: s.auth },
  };
}

function isWebPushError(err: unknown): err is WebPushError {
  return typeof err === 'object' && err !== null && 'statusCode' in err && 'endpoint' in err;
}

export async function sendToSubscriber(
  subscriber: Subscriber,
  payload: PushPayload,
): Promise<SendOutcome> {
  try {
    configure();
    const result: SendResult = await webpush.sendNotification(
      toSubscription(subscriber),
      JSON.stringify(payload),
    );
    return { ok: true, statusCode: result.statusCode };
  } catch (err: unknown) {
    if (isWebPushError(err)) {
      const expired = err.statusCode === 404 || err.statusCode === 410;
      if (expired) {
        await prisma.subscriber
          .update({
            where: { id: subscriber.id },
            data: { status: 'EXPIRED' },
          })
          .catch(() => undefined);
        return {
          ok: false,
          expired: true,
          statusCode: err.statusCode,
          error: err.body || err.message,
        };
      }
      return {
        ok: false,
        expired: false,
        failed: true,
        statusCode: err.statusCode,
        error: err.body || err.message,
      };
    }
    // web-push validates the subscription synchronously inside generateRequestDetails
    // and throws plain Errors for malformed keys. Swallow ALL throws so one bad row
    // can't abort a dispatch batch.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, expired: false, failed: true, error: message };
  }
}

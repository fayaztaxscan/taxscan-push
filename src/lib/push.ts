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
  | { ok: false; statusCode: number; expired: boolean; error: string };

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
  configure();
  try {
    const result: SendResult = await webpush.sendNotification(
      toSubscription(subscriber),
      JSON.stringify(payload),
    );
    return { ok: true, statusCode: result.statusCode };
  } catch (err: unknown) {
    if (isWebPushError(err)) {
      const expired = err.statusCode === 404 || err.statusCode === 410;
      if (expired) {
        await prisma.subscriber.update({
          where: { id: subscriber.id },
          data: { status: 'EXPIRED' },
        });
      }
      return { ok: false, statusCode: err.statusCode, expired, error: err.body || err.message };
    }
    throw err;
  }
}

import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

// eslint-disable-next-line no-console
console.log(
  [
    '# Generated VAPID key pair — copy into .env',
    `VAPID_PUBLIC_KEY=${publicKey}`,
    `VAPID_PRIVATE_KEY=${privateKey}`,
    'VAPID_SUBJECT=mailto:admin@taxscan.in',
  ].join('\n'),
);

import { prisma } from '../src/lib/prisma';

function base64urlByteLength(s: string): number {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const std = padded.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(std, 'base64').length;
  } catch {
    return -1;
  }
}

(async () => {
  const subs = await prisma.subscriber.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  const bad = subs.filter(
    (s) => base64urlByteLength(s.p256dh) !== 65 || base64urlByteLength(s.auth) !== 16,
  );

  // eslint-disable-next-line no-console
  console.log(
    `[cleanup] scanned ${subs.length} ACTIVE subscribers; ${bad.length} have invalid keys`,
  );
  for (const s of bad) {
    // eslint-disable-next-line no-console
    console.log(
      `[cleanup]   expiring ${s.id} endpoint=${s.endpoint.slice(-40)} ` +
        `p256dh=${base64urlByteLength(s.p256dh)}B auth=${base64urlByteLength(s.auth)}B`,
    );
  }

  if (bad.length) {
    const result = await prisma.subscriber.updateMany({
      where: { id: { in: bad.map((s) => s.id) } },
      data: { status: 'EXPIRED' },
    });
    // eslint-disable-next-line no-console
    console.log(`[cleanup] flipped ${result.count} subscribers to EXPIRED`);
  }

  await prisma.$disconnect();
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

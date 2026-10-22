/**
 * E2E_MOCK_SENDER replaces web-push AND the digest's Mailercloud client with
 * in-memory fakes (local and end-to-end runs only). In production that would
 * silently stop every push and digest while reporting success, so it is
 * refused there: `src/index.ts` logs the error and exits before listening.
 */
export class MockSenderInProductionError extends Error {
  constructor() {
    super('E2E_MOCK_SENDER=true is not allowed with NODE_ENV=production (it would fake every push and digest send). Unset it.');
    this.name = 'MockSenderInProductionError';
  }
}

/** Whether the mock senders are on. Throws in production when the flag is set. */
export function mockSendersEnabled(src: NodeJS.ProcessEnv): boolean {
  const on = src.E2E_MOCK_SENDER === 'true';
  if (on && src.NODE_ENV === 'production') throw new MockSenderInProductionError();
  return on;
}

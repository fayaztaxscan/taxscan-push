/**
 * Unit tests for the cutover logic in public/taxscan-push.js.
 *
 * The SDK is a browser IIFE that doesn't export anything, so we load it in a
 * Node `vm` sandbox with stubbed browser globals. The IIFE early-returns and
 * exposes its internals on `window.__taxscanPushTest__` when the
 * `__TAXSCAN_PUSH_TESTS_ENABLE__` sentinel is set on the sandbox window,
 * letting us drive `maybeUnregisterForeignWorkers` and `isIzootoWorker`
 * against fake registrations directly — without running the auto-init path.
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const SDK_PATH = path.join(__dirname, '..', '..', 'public', 'taxscan-push.js');
const SDK_SOURCE = fs.readFileSync(SDK_PATH, 'utf8');

type FakeReg = {
  active: { scriptURL: string } | null;
  installing: { scriptURL: string } | null;
  waiting: { scriptURL: string } | null;
  unregister: jest.Mock;
};

type SdkInternals = {
  isIzootoWorker: (url: string | undefined | null) => boolean;
  maybeUnregisterForeignWorkers: () => Promise<void>;
  cfg: { cutoverMode: boolean; swPath: string; apiBase: string };
};

function makeReg(scriptURL: string | null, otherStates: Partial<FakeReg> = {}): FakeReg {
  return {
    active: scriptURL ? { scriptURL } : null,
    installing: null,
    waiting: null,
    unregister: jest.fn().mockResolvedValue(true),
    ...otherStates,
  };
}

function loadSdkInSandbox(opts: {
  cutoverMode: boolean;
  registrations: FakeReg[];
}): { sandbox: { window: { __taxscanPushTest__: SdkInternals } }; internals: SdkInternals } {
  const sandbox: Record<string, unknown> = {
    // Standard JS built-ins / globals the SDK touches.
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    JSON,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Symbol,

    // Sentinel — tells the IIFE to expose internals and skip auto-init.
    __TAXSCAN_PUSH_TESTS_ENABLE__: true,

    // Site config used by the SDK.
    TAXSCAN_PUSH_CONFIG: {
      cutoverMode: opts.cutoverMode,
      apiBase: 'http://localhost:3000',
      swPath: '/sw.js',
    },

    // Browser feature-detection — the IIFE bails out at the top if any of
    // serviceWorker / PushManager / Notification are missing, so all three
    // must be present (truthy) on the sandbox.
    PushManager: function () {
      /* stub constructor */
    },
    Notification: {
      permission: 'default',
      requestPermission: () => Promise.resolve('default'),
    },
    navigator: {
      serviceWorker: {
        getRegistrations: () => Promise.resolve(opts.registrations.slice()),
        register: () => Promise.resolve(opts.registrations[0] || makeReg(null)),
        ready: Promise.resolve(opts.registrations[0] || makeReg(null)),
      },
      userAgent: 'jest-sandbox',
    },

    // Stubbed DOM-ish bits the SDK might touch even when auto-init is skipped.
    document: {
      scripts: [],
      readyState: 'complete',
      addEventListener: () => undefined,
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { appendChild: () => undefined },
      createElement: () => ({
        setAttribute: () => undefined,
        addEventListener: () => undefined,
        style: {},
        classList: { add: () => undefined, remove: () => undefined },
        appendChild: () => undefined,
      }),
    },
    location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/', host: 'localhost:3000' },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    fetch: () => Promise.reject(new Error('no fetch in sandbox')),
    addEventListener: () => undefined,
  };
  // Self-references so the IIFE can read `window.X` and `globalThis.X`.
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SDK_SOURCE, sandbox);

  const internals = (sandbox.window as { __taxscanPushTest__: SdkInternals }).__taxscanPushTest__;
  if (!internals) {
    throw new Error('SDK did not expose __taxscanPushTest__ — test hook not picked up');
  }
  return { sandbox: sandbox as { window: { __taxscanPushTest__: SdkInternals } }, internals };
}

describe('taxscan-push cutoverMode', () => {
  it('unregisters ONLY the iZooto worker; spares the site PWA and our own worker', async () => {
    const ourReg = makeReg('http://localhost:3000/sw.js?api=http%3A%2F%2Flocalhost%3A3000');
    const sitePwaReg = makeReg('https://www.taxscan.in/service-worker.js');
    const izootoReg = makeReg('https://cdn.izooto.com/scripts/7c4116fe67b7040de57d9981f16164fa57cb9125.js?v=5');

    const { internals } = loadSdkInSandbox({
      cutoverMode: true,
      registrations: [ourReg, sitePwaReg, izootoReg],
    });

    await internals.maybeUnregisterForeignWorkers();

    expect(ourReg.unregister).not.toHaveBeenCalled();
    expect(sitePwaReg.unregister).not.toHaveBeenCalled();
    expect(izootoReg.unregister).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when cutoverMode is false', async () => {
    const ourReg = makeReg('http://localhost:3000/sw.js');
    const sitePwaReg = makeReg('https://www.taxscan.in/service-worker.js');
    const izootoReg = makeReg('https://cdn.izooto.com/sw/abc.js');

    const { internals } = loadSdkInSandbox({
      cutoverMode: false,
      registrations: [ourReg, sitePwaReg, izootoReg],
    });

    await internals.maybeUnregisterForeignWorkers();

    expect(ourReg.unregister).not.toHaveBeenCalled();
    expect(sitePwaReg.unregister).not.toHaveBeenCalled();
    expect(izootoReg.unregister).not.toHaveBeenCalled();
  });

  it('matches iZooto when the URL is on installing or waiting (not just active)', async () => {
    const izootoOnInstalling: FakeReg = {
      active: null,
      installing: { scriptURL: 'https://cdn.izooto.com/scripts/sdk/izooto.js' },
      waiting: null,
      unregister: jest.fn().mockResolvedValue(true),
    };
    const izootoOnWaiting: FakeReg = {
      active: null,
      installing: null,
      waiting: { scriptURL: 'https://cdn.izooto.com/scripts/sdk/izextf.js' },
      unregister: jest.fn().mockResolvedValue(true),
    };
    const ourReg = makeReg('http://localhost:3000/sw.js');

    const { internals } = loadSdkInSandbox({
      cutoverMode: true,
      registrations: [ourReg, izootoOnInstalling, izootoOnWaiting],
    });

    await internals.maybeUnregisterForeignWorkers();

    expect(ourReg.unregister).not.toHaveBeenCalled();
    expect(izootoOnInstalling.unregister).toHaveBeenCalledTimes(1);
    expect(izootoOnWaiting.unregister).toHaveBeenCalledTimes(1);
  });

  it('does not unregister a registration that has no worker states at all', async () => {
    const emptyReg: FakeReg = {
      active: null,
      installing: null,
      waiting: null,
      unregister: jest.fn().mockResolvedValue(true),
    };
    const { internals } = loadSdkInSandbox({
      cutoverMode: true,
      registrations: [emptyReg],
    });
    await internals.maybeUnregisterForeignWorkers();
    expect(emptyReg.unregister).not.toHaveBeenCalled();
  });
});

describe('isIzootoWorker predicate', () => {
  let isIz: SdkInternals['isIzootoWorker'];
  beforeAll(() => {
    const { internals } = loadSdkInSandbox({ cutoverMode: false, registrations: [] });
    isIz = internals.isIzootoWorker;
  });

  it('matches cdn.izooto.com and any *.izooto.com host', () => {
    expect(isIz('https://cdn.izooto.com/scripts/sdk.js')).toBe(true);
    expect(isIz('https://cdn.izooto.com/scripts/7c4116fe.js?v=5')).toBe(true);
    expect(isIz('https://nh.izooto.com/foo/latest.json')).toBe(true);
    expect(isIz('https://nhwimp.izooto.com/nhwimp')).toBe(true);
    expect(isIz('http://izooto.com/sw.js')).toBe(true);
  });

  it('matches by substring even when URL parsing fails or host is unusual', () => {
    expect(isIz('/izooto-sw.js')).toBe(true); // relative URL
    expect(isIz('https://example.com/izooto/loader.js')).toBe(true); // path mentions izooto
  });

  it('does NOT match the site PWA worker or our own worker', () => {
    expect(isIz('https://www.taxscan.in/service-worker.js')).toBe(false);
    expect(isIz('http://localhost:3000/sw.js')).toBe(false);
    expect(isIz('http://localhost:3000/sw.js?api=http%3A%2F%2Flocalhost%3A3000')).toBe(false);
    expect(isIz('https://push.taxscan.in/sw.js?api=https%3A%2F%2Fpush.taxscan.in')).toBe(false);
  });

  it('safely handles null / empty / non-string input', () => {
    expect(isIz(null)).toBe(false);
    expect(isIz(undefined)).toBe(false);
    expect(isIz('')).toBe(false);
    // Cast through unknown to exercise the runtime guard against non-strings.
    expect(isIz(123 as unknown as string)).toBe(false);
  });
});

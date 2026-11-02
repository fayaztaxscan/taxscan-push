import { useAuth, AuthError } from '../../admin/src/composables/useAuth';

/**
 * Brief 2026-11-02-login-loads-features: right after a login the admin reads GET /api/auth/me once, so the menu's SOCIAL group
 * and the /whatsapp + /linkedin route guards see the server's feature switches without a reload. POST /api/auth/login answers
 * { id, email, role } only. No browser or database: the composable is driven with a fake `fetch`.
 */
type Reply = { status?: number; json?: unknown } | Error;
let replies: Record<string, Reply>;
let calls: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  replies = {};
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    const r = replies[url];
    if (!r) throw new Error(`no fake reply for ${url}`);
    if (r instanceof Error) throw r;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json ?? {} } as unknown as Response;
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const LOGIN_USER = { id: 'u1', email: 'p@team.test', role: 'PUBLISHER' };
const ME = { ...LOGIN_USER, lastLoginAt: null, passwordResetRequired: false, features: { whatsappQueue: true, linkedinPosting: true } };

describe('login() loads the feature switches', () => {
  it('1: after a login, /api/auth/me is read once and the user carries features (SOCIAL shows with no reload)', async () => {
    const auth = useAuth();
    replies = { '/api/auth/login': { json: { user: LOGIN_USER } }, '/api/auth/me': { json: ME } };
    await auth.login('p@team.test', 'pw');
    expect(calls).toEqual(['/api/auth/login', '/api/auth/me']);
    expect(auth.user.value).toMatchObject({ role: 'PUBLISHER', features: { whatsappQueue: true, linkedinPosting: true } });
    expect(auth.isAuthed.value).toBe(true);
    expect(auth.ready.value).toBe(true);
  });

  it('1: the same for an ADMIN, and switches that are off stay off', async () => {
    const auth = useAuth();
    replies = { '/api/auth/login': { json: { user: { ...LOGIN_USER, role: 'ADMIN' } } }, '/api/auth/me': { json: { ...ME, role: 'ADMIN', features: { whatsappQueue: true, linkedinPosting: false } } } };
    await auth.login('a@team.test', 'pw');
    expect(auth.user.value).toMatchObject({ role: 'ADMIN', features: { whatsappQueue: true, linkedinPosting: false } });
  });

  it.each([
    ['a 500', { status: 500 }],
    ['a 401', { status: 401 }],
    ['a network error', new Error('socket hang up')],
    ['a body that is not JSON', { status: 200, json: undefined }],
  ] as [string, Reply][])('2: /api/auth/me failing after a login (%s) → the login still succeeds, nothing is thrown, the user stays the login\'s', async (_name, meReply) => {
    const auth = useAuth();
    replies = { '/api/auth/login': { json: { user: LOGIN_USER } }, '/api/auth/me': meReply };
    if (!(meReply instanceof Error) && meReply.json === undefined && meReply.status === 200) {
      globalThis.fetch = (async (url: string) => {
        calls.push(url);
        if (url === '/api/auth/me') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({ user: LOGIN_USER }) } as unknown as Response;
      }) as typeof fetch;
    }
    await expect(auth.login('p@team.test', 'pw')).resolves.toBeUndefined();
    expect(auth.user.value).toMatchObject(LOGIN_USER);
    expect(auth.user.value?.features).toBeUndefined(); // as before: the menu just lacks SOCIAL until a reload
    expect(auth.isAuthed.value).toBe(true);
  });

  it('a wrong password still throws the same errors and reads nothing else', async () => {
    const auth = useAuth();
    replies = { '/api/auth/login': { status: 401 } };
    await expect(auth.login('x@team.test', 'bad')).rejects.toMatchObject({ status: 401, message: 'Incorrect email or password' });
    await expect(auth.login('x@team.test', 'bad')).rejects.toBeInstanceOf(AuthError);
    expect(calls).toEqual(['/api/auth/login', '/api/auth/login']);
  });
});

describe('the other places that set the user already read /me', () => {
  it('checkSession (page load) sets the user from /me, with features; signed out when /me fails', async () => {
    const auth = useAuth();
    replies = { '/api/auth/me': { json: ME } };
    await auth.checkSession();
    expect(auth.user.value?.features).toEqual({ whatsappQueue: true, linkedinPosting: true });
    replies = { '/api/auth/me': { status: 401 } };
    await auth.checkSession();
    expect(auth.user.value).toBeNull();
  });
  it('acceptInvite hydrates the user from /me (so it carries features too)', async () => {
    const auth = useAuth();
    replies = { '/api/auth/accept-invite': { json: {} }, '/api/auth/me': { json: ME } };
    await auth.acceptInvite('tok', 'new-password-1');
    expect(auth.user.value?.features).toEqual({ whatsappQueue: true, linkedinPosting: true });
  });
  it('a forced password change keeps the features the user already has (it only clears the flag)', async () => {
    const auth = useAuth();
    replies = { '/api/auth/me': { json: { ...ME, passwordResetRequired: true } }, '/api/auth/change-password': { json: {} } };
    await auth.checkSession();
    await auth.changePassword('old', 'new-password-1');
    expect(auth.user.value).toMatchObject({ passwordResetRequired: false, features: { whatsappQueue: true, linkedinPosting: true } });
  });
});

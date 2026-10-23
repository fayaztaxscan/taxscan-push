import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_TABLES } from '../services/backup';

/**
 * QA of 0032030 (digest task 14): staff devices must never reach a reader door.
 *
 * `staffPush.test.ts` pins that only two files name the `StaffPushSubscription`
 * table. That scan misses three other ways in, pinned here:
 *  1. the Prisma relation on User is `pushDevices`, so `include: { pushDevices: true }`
 *     on any user query reads the table without naming it;
 *  2. importing the staff-push service (`activeStaffDevices`, `pushToActiveStaff`, …)
 *     reaches the rows without naming the table either;
 *  3. `deliverPush` is the bare VAPID sender — fine for staff, but a reader door must
 *     keep using `sendToSubscriber` (which prunes the Subscriber row on 404/410);
 * and `scripts/` (backup / restore / maintenance) is outside `src/`, so it was not scanned.
 */

const repo = path.resolve(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (f.name !== '__tests__' && f.name !== 'node_modules') out.push(...sources(p));
    } else if (/\.(ts|js|mjs|cjs)$/.test(f.name)) {
      out.push(p);
    }
  }
  return out;
}

const files = [...sources(path.join(repo, 'src')), ...sources(path.join(repo, 'scripts'))];
const rel = (p: string) => path.relative(repo, p);
const matching = (re: RegExp) => files.filter((p) => re.test(fs.readFileSync(p, 'utf8'))).map(rel).sort();

describe('staff devices stay out of every reader door (QA of 0032030)', () => {
  it('nothing outside the staff-push files names the table, in src/ or scripts/', () => {
    // backup.ts / lib/push.ts: comments only; digest/alerts.ts: the row TYPE for its injectable device list.
    expect(matching(/staffPushSubscription|StaffPushSubscription/)).toEqual(
      ['src/lib/push.ts', 'src/routes/staffPush.ts', 'src/services/backup.ts', 'src/services/digest/alerts.ts', 'src/services/staffPush.ts'].sort(),
    );
    // Of those, only the staff-push service and routes query it.
    expect(matching(/prisma\.staffPushSubscription|"StaffPushSubscription"/)).toEqual(['src/routes/staffPush.ts', 'src/services/staffPush.ts'].sort());
    // backup.ts names it only in its exclusion comment — never in the exported table list.
    expect((BACKUP_TABLES as readonly string[]).includes('StaffPushSubscription')).toBe(false);
  });

  it('no query reads the User → pushDevices relation (include / select / _count)', () => {
    expect(matching(/pushDevices\s*:\s*(true|\{)/)).toEqual([]);
  });

  it('only the digest alert pass, the staff routes, Users and the mock switch import the staff-push service', () => {
    expect(matching(/from\s+['"][./]*(?:services\/)?staffPush['"]/)).toEqual(
      ['src/index.ts', 'src/routes/staffPush.ts', 'src/routes/users.ts', 'src/services/digest/alerts.ts'].sort(),
    );
  });

  it('only the staff-push service uses the bare deliverPush (reader sends keep sendToSubscriber)', () => {
    expect(matching(/\bdeliverPush\b/)).toEqual(['src/lib/push.ts', 'src/services/staffPush.ts'].sort());
  });
});

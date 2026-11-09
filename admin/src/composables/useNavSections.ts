import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuth, type UserSummary } from './useAuth';

/**
 * The menu's three tabbed sections (Push, Social, Email) and the "open the screen you used last" memory.
 *
 * Dashboard and Reports are single screens and Admin/Account live in dropdowns, so none of them is a section here.
 * Routes are untouched: a tab is just a route path. A tab shows only while its server switch is on (`feature`, from
 * /api/auth/me → features) and for the roles it names (`roles`); a section with no tab left disappears (that is how
 * Social vanishes while every channel is off).
 */

type FeatureKey = keyof NonNullable<UserSummary['features']>;

export type NavTabDef = {
  to: string;
  label: string;
  /** Hidden unless /api/auth/me says this switch is on. */
  feature?: FeatureKey;
  /** Hidden unless the signed-in role is one of these. */
  roles?: Array<UserSummary['role']>;
};

export type NavSectionKey = 'push' | 'social' | 'email';

export type NavSectionDef = { key: NavSectionKey; label: string; tabs: NavTabDef[] };

export const NAV_SECTION_DEFS: NavSectionDef[] = [
  {
    key: 'push',
    label: 'Push',
    tabs: [
      { to: '/compose', label: 'Compose' },
      { to: '/review', label: 'Review' },
      { to: '/queue', label: 'Queue' },
      { to: '/campaigns', label: 'Campaigns' },
    ],
  },
  {
    key: 'social',
    label: 'Social',
    tabs: [
      { to: '/whatsapp', label: 'WhatsApp', feature: 'whatsappQueue' },
      { to: '/linkedin', label: 'LinkedIn', feature: 'linkedinPosting' },
      { to: '/facebook', label: 'Facebook', feature: 'facebookPosting' },
      { to: '/telegram', label: 'Telegram', feature: 'telegramPosting' },
    ],
  },
  {
    key: 'email',
    label: 'Email',
    tabs: [
      { to: '/digests', label: 'Digests' },
      { to: '/ads', label: 'Ads' },
      { to: '/templates', label: 'Templates' },
    ],
  },
];

/** One localStorage key per section, e.g. `tsp.nav.last.push` = `/queue`. */
const STORAGE_PREFIX = 'tsp.nav.last.';

// Every storage access goes through these two: a browser with storage blocked (private modes, strict settings, a sandboxed
// iframe) throws on the `window.localStorage` getter itself, and the menu must work exactly as before without it.
export function readLastScreen(section: NavSectionKey): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + section);
  } catch {
    return null;
  }
}
export function writeLastScreen(section: NavSectionKey, path: string): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + section, path);
  } catch {
    // Not remembered: the section link falls back to its first screen.
  }
}

function isOn(path: string, to: string): boolean {
  return path === to || path.startsWith(to + '/');
}

export type NavSection = {
  key: NavSectionKey;
  label: string;
  /** The screens this user can open in the section right now. Never empty. */
  tabs: NavTabDef[];
  /** Where the section link goes: the screen used last if it is still available, else the first one. */
  target: string;
  /** The current route is one of this section's screens. */
  active: boolean;
};

export function useNavSections() {
  const route = useRoute();
  const { user } = useAuth();

  const allowed = (t: NavTabDef): boolean => {
    if (t.feature && user.value?.features?.[t.feature] !== true) return false;
    if (t.roles && (!user.value || !t.roles.includes(user.value.role))) return false;
    return true;
  };

  // The memory lives in storage, not in a ref: with storage blocked nothing is remembered and every section opens on its
  // first screen. `stamp` makes the targets re-read it each time a screen is remembered.
  const stamp = ref(0);

  // Remember the screen on every route change (and once at start, so a reload or a deep link counts too).
  watch(
    () => route.path,
    (path) => {
      const section = NAV_SECTION_DEFS.find((s) => s.tabs.some((t) => isOn(path, t.to)));
      const tab = section?.tabs.find((t) => isOn(path, t.to));
      if (section && tab) writeLastScreen(section.key, tab.to);
      stamp.value++;
    },
    { immediate: true },
  );

  const sections = computed<NavSection[]>(() => {
    void stamp.value;
    const path = route.path;
    const out: NavSection[] = [];
    for (const def of NAV_SECTION_DEFS) {
      const tabs = def.tabs.filter(allowed);
      if (tabs.length === 0) continue;
      const last = readLastScreen(def.key);
      const target = tabs.find((t) => t.to === last)?.to ?? tabs[0].to;
      out.push({ key: def.key, label: def.label, tabs, target, active: tabs.some((t) => isOn(path, t.to)) });
    }
    return out;
  });

  const activeSection = computed<NavSection | null>(() => sections.value.find((s) => s.active) ?? null);

  return { sections, activeSection };
}

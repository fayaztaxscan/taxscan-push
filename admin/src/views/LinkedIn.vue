<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ConfirmPush from '../components/ConfirmPush.vue';
import PagePauseControl from '../components/PagePauseControl.vue';
import PageStatusBanner from '../components/PageStatusBanner.vue';
import { useRoute } from 'vue-router';
import { useAuth } from '../composables/useAuth';
import { apiErrorMessage, PUSH_REQUEST, useApi, type ApiError } from '../composables/useApi';
import { PAGE_PAUSED, PAGE_PAUSED_TEXT, type PageStatus } from '../composables/socialPages';

type Status = 'WAITING' | 'RETRYING' | 'POSTED' | 'FAILED' | 'SKIPPED' | 'NOT_POSTED';
type Row = {
  id: string | null;
  campaignId: string;
  pushedAt: string;
  pushedTime: string;
  headline: string;
  status: Status;
  error: string | null;
  attempts: number;
  nextAttemptTime: string | null;
  postedAt: string | null;
  postUrl: string | null;
  unknownOutcome: boolean;
  /**
   * Present ONLY on a SKIPPED row the system skipped, never a person: 'quota_headroom' (the daily quota guard held it),
   * 'org_daily_limit' (LinkedIn refused this page's posts for the day: "Organization post creation limit reached"),
   * 'compose_skip' (the sender unticked this page on Compose for this push) or 'page_paused' (an administrator paused this page).
   * Never shown as a code.
   */
  skipReason?: string;
};
type Counts = { waiting: number; posted: number; failed: number; skipped: number; notPosted: number; all: number };
type ListResponse = {
  date: string;
  /** The page these rows belong to, and the ACTIVE pages (Taxscan first). A server without them gets no switch. */
  page?: string;
  pages?: string[];
  rows: Row[];
  counts: Counts;
  login: { since: string; status: number | null } | null;
  token?: TokenInfo;
  /** Present (true) only while two or more pages post with one token; missing = false. */
  tokenShared?: boolean;
  /**
   * Present (an ISO time) ONLY while this page posts EVERY push (articles, courses, shop products; a repeat is its own row), from
   * that time. Missing = the old rule: one post per article. Pushes before the time keep the old rule.
   */
  everyPushFrom?: string;
  /** ok | paused | stopped | held | failing for the page shown, with the banner's sentence in `message`. A server without it shows no banner. */
  pageStatus?: PageStatus;
};
type TokenInfo = {
  validUntil: string | null;
  validUntilSource: 'linkedin' | 'renewal' | 'estimate' | null;
  refreshUntil: string | null;
  autoRenew: boolean;
  renewalFailed: boolean;
  renewedAt: string | null;
  status: 'ok' | 'amber' | 'red';
};
type Filter = 'all' | 'waiting' | 'posted' | 'failed' | 'skipped';

const api = useApi();
const { user: meUser } = useAuth();
const isAdmin = computed(() => meUser.value?.role === 'ADMIN');

// Dates are IST days (the server's day boundary). Today in IST = UTC + 5:30.
const IST_MS = 5.5 * 3600 * 1000;
function istDay(offsetDays: number): string {
  return new Date(Date.now() + IST_MS + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
const maxDate = istDay(0);
const minDate = istDay(-14);

// ?date=YYYY-MM-DD (the Campaigns Channels marks link here); anything outside the 14-day window falls back to today.
const qDate = String(useRoute().query.date ?? '');
const date = ref<string>(/^\d{4}-\d{2}-\d{2}$/.test(qDate) && qDate >= minDate && qDate <= maxDate ? qDate : maxDate);
const filter = ref<Filter>('all');
const EMPTY_COUNTS: Counts = { waiting: 0, posted: 0, failed: 0, skipped: 0, notPosted: 0, all: 0 };
const rows = ref<Row[]>([]);
const counts = ref<Counts>({ ...EMPTY_COUNTS });
const login = ref<ListResponse['login']>(null);
const token = ref<TokenInfo | null>(null);
// The shown page's status (paused / held / failing draw a banner; the Pause button flips on it). Belongs to ONE page, like the rows.
const pageStatus = ref<PageStatus | null>(null);
// Which LinkedIn page is on screen. null = not chosen yet: the first request leaves `page` out and adopts the server's
// answer (its first page, Taxscan). `pages` = the ACTIVE pages (Taxscan, then Academy, then Shopscan); the switch shows only when there are two or more.
const page = ref<string | null>(null);
const pages = ref<string[]>([]);
const tokenShared = ref(false);
// When the page being shown started posting EVERY push (the server's `everyPushFrom`); null = it still posts one per article.
const everyPushFrom = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const busyId = ref<string | null>(null);
const retrying = ref<Row | null>(null);

const isToday = computed(() => date.value === maxDate);
const isYesterday = computed(() => date.value === istDay(-1));

// A page's name as the editors say it. Any other key is shown capitalised (a page added later needs no change here).
const PAGE_LABEL: Record<string, string> = { taxscan: 'Taxscan', academy: 'Academy', shopscan: 'Shopscan' };
const labelOf = (key: string): string => PAGE_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
const multi = computed(() => pages.value.length > 1);
// The page being shown ("Taxscan" until the first answer, which is also what a one-page server always shows).
const pageLabel = computed(() => labelOf(page.value ?? pages.value[0] ?? 'taxscan'));
function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
// The pages that post with one shared token, as a sentence opener: "Both pages" for two (the wording since the Academy page),
// the listed pages by name for three ("The Taxscan, Academy and Shopscan pages").
const sharedPagesPhrase = computed(() =>
  pages.value.length === 2 ? 'Both pages' : `The ${joinNames(pages.value.map(labelOf))} pages`,
);

const CHIPS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'posted', label: 'Posted' },
  { key: 'failed', label: 'Failed' },
  { key: 'skipped', label: 'Skipped' },
];

const shown = computed(() => {
  switch (filter.value) {
    case 'waiting':
      return rows.value.filter((r) => r.status === 'WAITING' || r.status === 'RETRYING');
    case 'posted':
      return rows.value.filter((r) => r.status === 'POSTED');
    case 'failed':
      return rows.value.filter((r) => r.status === 'FAILED');
    case 'skipped':
      return rows.value.filter((r) => r.status === 'SKIPPED');
    default:
      return rows.value;
  }
});

const dayWord = computed(() => (isToday.value ? 'today' : isYesterday.value ? 'yesterday' : `on ${date.value}`));
const emptyText = computed(() => {
  if (counts.value.all === 0) {
    return isToday.value ? 'Nothing pushed yet today.' : `Nothing was pushed ${dayWord.value}.`;
  }
  const word: Record<Exclude<Filter, 'all'>, string> = {
    waiting: 'waiting to be posted',
    posted: 'posted',
    failed: 'failed',
    skipped: 'skipped',
  };
  return `Nothing ${word[filter.value as Exclude<Filter, 'all'>]} ${dayWord.value}.`;
});

// A page that posts with ANOTHER page's token (Academy, Shopscan): it has no token variable of its own, so its banner never sends
// anyone to Railway for it.
const borrowsToken = computed(() => tokenShared.value && !!page.value && page.value !== pages.value[0]);
const loginText = computed(() => {
  const l = login.value;
  if (!l) return '';
  const when = new Date(l.since).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const st = l.status ? ` (${l.status})` : '';
  const lead = `LinkedIn rejected the access token${st} since ${when}.`;
  // One page in use: the original wording, word for word.
  if (!multi.value) return `${lead} Posting is stopped until a new token is set in Railway or the app restarts.`;
  // Two or three pages: a stop belongs to one page, so the banner names it.
  const name = pageLabel.value;
  if (borrowsToken.value) {
    const stopped = `Posting to the ${name} page is stopped. ${sharedPagesPhrase.value} post with one shared token`;
    // A 403 on this page alone, while the other keeps posting, is almost always a missing admin role on THIS page.
    return l.status === 403
      ? `${lead} ${stopped}, so this usually means the LinkedIn member who made that token has no admin role on the ${name} page. Tell the owner.`
      : `${lead} ${stopped}. Tell the owner.`;
  }
  return `${lead} Posting to the ${name} page is stopped until a new token is set in Railway or the app restarts. Tell the owner.`;
});

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
// "4 Nov 2026, 15:56 IST": the date as the token line writes it, plus the time in IST like the "Pushed (IST)" column, so the
// moment can be compared with the rows below. Empty when the server's time is unreadable (the line is then left out).
const sinceText = computed(() => {
  const d = everyPushFrom.value ? new Date(everyPushFrom.value) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const when = d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Kolkata',
  });
  return `${when} IST`;
});
// Two or three pages posting with one token (Academy and Shopscan borrow the Taxscan page's): say so plainly, on every page. The
// server reports `tokenShared` for the pages in `pages`, so the names come from there.
const sharedNote = computed(() => (tokenShared.value && multi.value ? `one token, shared by the ${joinNames(pages.value.map(labelOf))} pages` : ''));
const tokenText = computed(() => {
  const t = token.value;
  if (!t) {
    // Renewal is off (no token dates), but the pages still share one token: a short line, never invented dates.
    if (!sharedNote.value) return '';
    const owner = labelOf(pages.value[0] as string);
    if (pages.value.length === 2) return `Both pages post with the ${owner} page's token.`;
    return `The ${joinNames(pages.value.slice(1).map(labelOf))} pages post with the ${owner} page's token.`;
  }
  const parts = [t.validUntil ? `Token valid until ${t.validUntilSource === 'estimate' ? 'about ' : ''}${longDate(t.validUntil)}` : 'Token expiry not read yet'];
  parts.push(t.autoRenew ? 'renews automatically' : 'renewal is not fully set up');
  if (t.refreshUntil) parts.push(`yearly sign-in due by ${longDate(t.refreshUntil)}`);
  if (t.renewalFailed) parts.push('last renewal failed');
  if (sharedNote.value) parts.push(sharedNote.value);
  return parts.join(' · ');
});

// Each answer is for one page and one day. If a newer request has started (another page or day tapped meanwhile), an older
// answer is dropped, so one page's rows can never appear under the other page's name.
let loadSeq = 0;
function fetchList(withPage = true): Promise<ListResponse> {
  const pageQ = withPage && page.value ? `&page=${encodeURIComponent(page.value)}` : '';
  return api.get<ListResponse>(`/api/linkedin/posts?date=${encodeURIComponent(date.value)}${pageQ}`);
}
async function load(keepError = false): Promise<void> {
  const mine = ++loadSeq;
  loading.value = true;
  if (!keepError) error.value = null;
  try {
    let data: ListResponse;
    try {
      data = await fetchList();
    } catch (e) {
      const err = e as ApiError;
      const invalidPage = err.status === 400 && (err.body as { error?: string } | undefined)?.error === 'invalid_page';
      if (!page.value || !invalidPage) throw e;
      // The remembered page is no longer active (the Academy page was switched off meanwhile): quietly ask for the first
      // page instead. Nothing on screen changes until that answer arrives, so if it fails too the screen stays consistent.
      data = await fetchList(false);
    }
    if (mine !== loadSeq) return;
    rows.value = data.rows;
    counts.value = data.counts;
    login.value = data.login;
    token.value = data.token ?? null;
    pages.value = data.pages ?? [];
    page.value = data.page ?? data.pages?.[0] ?? null;
    tokenShared.value = data.tokenShared === true;
    everyPushFrom.value = data.everyPushFrom ?? null;
    pageStatus.value = data.pageStatus ?? null;
  } catch (e) {
    if (mine === loadSeq) error.value = apiErrorMessage(e);
  } finally {
    if (mine === loadSeq) loading.value = false;
  }
}

function selectPage(p: string): void {
  if (p === page.value) return;
  page.value = p;
  // Rows, counts and the banner belong to the page just left: clear them so none of its Retry / Skip buttons stay on
  // screen under the new name while the answer is on its way. (The token line is the one shared token: it stays.) The same goes
  // for "every push is posted from …": each page has its own time, so the page just left must not lend it to the new one.
  rows.value = [];
  counts.value = { ...EMPTY_COUNTS };
  login.value = null;
  pageStatus.value = null;
  everyPushFrom.value = null;
  error.value = null;
  note.value = null;
  retrying.value = null;
  void load();
}

function setDate(d: string): void {
  if (!d || d < minDate || d > maxDate) return;
  date.value = d;
  void load();
}
function onPick(e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  if (!v || v < minDate || v > maxDate) {
    (e.target as HTMLInputElement).value = date.value; // snap back to what is on screen
    return;
  }
  setDate(v);
}

const retryDetail = computed(() =>
  retrying.value?.unknownOutcome
    ? multi.value
      ? `Check the ${pageLabel.value} LinkedIn page first — it may already be posted.`
      : 'Check the LinkedIn page first — it may already be posted.'
    : `It goes to the ${pageLabel.value} LinkedIn page straight away.`,
);

async function confirmRetry(): Promise<void> {
  const r = retrying.value;
  if (!r?.id) return;
  busyId.value = r.id;
  error.value = null;
  note.value = null;
  try {
    const res = await api.post<{ ok: boolean; status: 'POSTED' | 'FAILED' | 'PENDING' }>(
      `/api/linkedin/posts/${encodeURIComponent(r.id)}/retry`,
      {},
      {
        ...PUSH_REQUEST,
        unknownMessage: 'No reply from the server — it may still be posting. Check the list in a minute.',
      },
    );
    if (res.status === 'FAILED') note.value = 'LinkedIn did not accept it — see the reason on the row.';
    else if (res.status === 'PENDING') note.value = 'LinkedIn is busy — it will be tried again shortly.';
    retrying.value = null;
    await load();
  } catch (e) {
    retrying.value = null;
    const status = (e as { status?: number })?.status;
    if (status === 409) {
      error.value = 'This post changed in the meantime — the list has been refreshed.';
      await load(true);
    } else {
      error.value = apiErrorMessage(e);
    }
  } finally {
    busyId.value = null;
  }
}

async function skip(r: Row): Promise<void> {
  if (!r.id) return;
  busyId.value = r.id;
  error.value = null;
  note.value = null;
  try {
    await api.post(`/api/linkedin/posts/${encodeURIComponent(r.id)}/skip`, {});
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
    await load(true);
  } finally {
    busyId.value = null;
  }
}

const STATUS_LABEL: Record<Status, string> = {
  WAITING: 'Waiting',
  RETRYING: 'Waiting',
  POSTED: 'Posted',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  NOT_POSTED: 'Not posted',
};
// The one reason code the server sends on a SKIPPED row, said in words (the code itself is never shown). The same words on every
// page. A held row has no Retry and no Skip: those two buttons belong to FAILED / RETRYING rows only.
const QUOTA_HELD = 'quota_headroom';
const QUOTA_HELD_TEXT = 'Skipped — daily LinkedIn limit kept for Taxscan';
// LinkedIn refused this page's posts for the rest of the UTC day ("Organization post creation limit reached"): the system skipped the push.
// Like a held row it counts under Skipped and has no buttons.
const ORG_DAILY_LIMIT = 'org_daily_limit';
const ORG_DAILY_LIMIT_TEXT = "Skipped — LinkedIn's daily limit for this page";
// A push whose sender unticked this page on Compose. Like a held row it is SKIPPED, counts under Skipped, and has no buttons.
const COMPOSE_SKIP = 'compose_skip';
const COMPOSE_SKIP_TEXT = 'Skipped in Compose';
function statusText(r: Row): string {
  // An administrator paused this page: the push was skipped with no post, and is never posted later. Counts under Skipped, no buttons.
  if (r.status === 'SKIPPED' && r.skipReason === PAGE_PAUSED) return PAGE_PAUSED_TEXT;
  if (r.status === 'SKIPPED' && r.skipReason === QUOTA_HELD) return QUOTA_HELD_TEXT;
  if (r.status === 'SKIPPED' && r.skipReason === ORG_DAILY_LIMIT) return ORG_DAILY_LIMIT_TEXT;
  if (r.status === 'SKIPPED' && r.skipReason === COMPOSE_SKIP) return COMPOSE_SKIP_TEXT;
  if (r.status === 'RETRYING') return r.nextAttemptTime ? `Waiting — retry ${r.nextAttemptTime}` : 'Waiting — retry';
  return STATUS_LABEL[r.status];
}

// After Pause / Resume (or a 409: a colleague pressed first) the list is read again, so the banner and every row show the truth.
async function onPauseDone(outcome: 'paused' | 'resumed' | 'refreshed'): Promise<void> {
  error.value = null;
  note.value = outcome === 'resumed' ? 'Posting resumed. Posts start again from the next push; nothing that was skipped is posted.' : null;
  await load(true);
}

onMounted(() => load());
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">LinkedIn page</h1>
      <div class="li-tools">
        <button class="btn" :disabled="loading" @click="load()">{{ loading ? 'Loading…' : 'Refresh' }}</button>
        <!-- One page: Pause sits with Refresh. With a page switch it moves onto the switch's row, so it reads as belonging to the page chosen. -->
        <PagePauseControl v-if="isAdmin && !multi" channel="linkedin" :page="page" :status="pageStatus" @done="onPauseDone" />
      </div>
    </div>
    <!-- Which page's list this is. Only while a second page (Academy, Shopscan) is on; it sits above everything it changes. -->
    <div v-if="multi" class="li-scope">
      <div class="li-switch" role="group" aria-label="LinkedIn page" data-testid="li-switch">
        <button
          v-for="p in pages"
          :key="p"
          type="button"
          :class="{ on: p === page }"
          :aria-pressed="p === page"
          @click="selectPage(p)"
        >
          {{ labelOf(p) }}
        </button>
      </div>
      <PagePauseControl v-if="isAdmin" channel="linkedin" :page="page" :status="pageStatus" @done="onPauseDone" />
    </div>

    <!-- Paused / held / failing, for the page shown: first thing under the page switch, so a phone sees it before the explanation. -->
    <PageStatusBanner :status="pageStatus" :is-admin="isAdmin" />

    <p class="muted" :class="{ 'li-every': everyPushFrom }" style="font-size: 13px; margin: 4px 0 12px" data-testid="li-intro">
      <!-- This page posts EVERY push from a set time (the server sent `everyPushFrom`): say so, and from when. -->
      <template v-if="everyPushFrom">
        Every push we send is posted to the {{ pageLabel }} LinkedIn page automatically, a few minutes later: articles, courses
        and shop products. A push that is sent again is posted again and gets its own row. Nothing to do unless a post fails.
        <span v-if="sinceText" class="li-since" data-testid="li-since"
          >From {{ sinceText }} every push is posted. Earlier pushes keep the old rule: one post per article.</span
        >
      </template>
      <template v-else>
        Every article we push is posted to the {{ pageLabel }} LinkedIn page automatically, a few minutes later. Nothing to do
        unless a post fails.
      </template>
    </p>

    <p v-if="tokenText" class="li-token" :class="token ? 't-' + token.status : ''" data-testid="li-token">{{ tokenText }}</p>

    <div v-if="login" class="banner warn" role="alert">{{ loginText }}</div>

    <div class="li-controls">
      <div class="li-days">
        <button type="button" class="btn" :class="{ 'li-on': isToday }" @click="setDate(maxDate)">Today</button>
        <button type="button" class="btn" :class="{ 'li-on': isYesterday }" @click="setDate(istDay(-1))">Yesterday</button>
        <label class="li-date">
          <span class="sr-only">Pick a date</span>
          <input type="date" :value="date" :min="minDate" :max="maxDate" aria-label="Pick a date" @change="onPick" />
        </label>
      </div>
      <div class="li-chips" role="group" aria-label="Filter by status">
        <button
          v-for="c in CHIPS"
          :key="c.key"
          type="button"
          class="li-chip"
          :class="{ 'li-on': filter === c.key, 'li-alert': c.key === 'failed' && counts.failed > 0 }"
          :aria-pressed="filter === c.key"
          @click="filter = c.key"
        >
          {{ c.label }} <span class="li-count">{{ c.key === 'all' ? counts.all : counts[c.key] }}</span>
        </button>
      </div>
    </div>

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="note" class="banner warn">{{ note }}</div>

    <div class="card">
      <table class="stack">
        <thead>
          <tr>
            <th>Pushed (IST)</th>
            <th>Headline</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in shown" :key="r.campaignId" :class="{ 'li-quiet': r.status === 'NOT_POSTED' }">
            <td data-label="Pushed" style="white-space: nowrap">
              <strong>{{ r.pushedTime }}</strong>
            </td>
            <td class="cell-lead">{{ r.headline }}</td>
            <td class="cell-wide" data-label="Status">
              <span class="li-status" :class="'s-' + r.status">{{ statusText(r) }}</span>
              <a
                v-if="r.status === 'POSTED' && r.postUrl"
                class="li-view"
                :href="r.postUrl"
                target="_blank"
                rel="noopener"
                >View on LinkedIn</a
              >
              <div v-if="r.status === 'FAILED' && r.error" class="li-reason">{{ r.error }}</div>
              <div v-else-if="r.status === 'RETRYING' && r.error" class="li-reason muted">{{ r.error }}</div>
            </td>
            <td class="cell-actions li-actions">
              <template v-if="r.id && (r.status === 'FAILED' || r.status === 'RETRYING')">
                <button
                  v-if="r.status === 'FAILED'"
                  type="button"
                  class="btn btn-primary"
                  :disabled="busyId === r.id"
                  @click="retrying = r"
                >
                  Retry
                </button>
                <button type="button" class="btn" :disabled="busyId === r.id" @click="skip(r)">Skip</button>
              </template>
            </td>
          </tr>
          <tr v-if="shown.length === 0 && !loading && !error">
            <td colspan="4" class="muted" style="text-align: center; padding: 24px; font-size: 14px">{{ emptyText }}</td>
          </tr>
          <tr v-if="loading && rows.length === 0">
            <td colspan="4" class="muted" style="text-align: center; padding: 24px">Loading…</td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmPush
      v-if="retrying"
      :title="retrying.headline"
      :busy="busyId === retrying.id"
      heading="Post to LinkedIn now?"
      :detail="retryDetail"
      confirm-label="Post now"
      busy-label="Posting…"
      @confirm="confirmRetry"
      @cancel="retrying = null"
    />
  </main>
</template>

<style scoped>
/* The page switch: a scope control (which page's list is this), so it is ONE joined box, unlike the loose day buttons and the
   status pills below it. Same tokens as the joined .seg control on Reports and Digests. No overflow:hidden (it would clip the
   keyboard focus ring), so the outer corners are rounded on the buttons themselves. */
.li-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* The page switch and the Pause button for the page it shows: one row, the switch left, the action right. */
.li-scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  margin: 0 0 8px;
}
.li-switch {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
.li-switch button {
  min-width: 104px;
  min-height: 38px;
  padding: 8px 20px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
}
.li-switch button:first-child {
  border-radius: 7px 0 0 7px;
}
.li-switch button:last-child {
  border-radius: 0 7px 7px 0;
}
.li-switch button:hover:not(.on) {
  background: #f1f5f9;
}
.li-switch button.on {
  background: var(--primary);
  color: #fff;
  font-weight: 600;
}
.li-switch button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
/* The longer explanation (the page posts every push): no one-word last line on a phone. Only this state, so the old text lays out as before. */
.li-every {
  text-wrap: pretty;
}
/* The second line of the explanation: from when every push is posted. Same muted 13px as the paragraph, on its own line. */
.li-since {
  display: block;
  margin-top: 4px;
}
.li-token {
  font-size: 13px;
  margin: 0 0 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.li-token.t-amber {
  color: var(--warn);
  font-weight: 600;
}
.li-token.t-red {
  color: var(--danger);
  font-weight: 600;
}
.li-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-bottom: 12px;
}
.li-days {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.li-date input {
  width: auto;
}
.li-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.li-chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}
.li-chip.li-alert:not(.li-on) {
  border-color: #dc2626;
  color: #b91c1c;
  font-weight: 600;
}
.li-chip.li-on,
.btn.li-on {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.li-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
  margin-left: 2px;
}
.li-status {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.li-status.s-POSTED {
  color: #16a34a;
}
.li-status.s-FAILED {
  color: #dc2626;
}
.li-status.s-SKIPPED,
.li-status.s-RETRYING {
  color: var(--warn);
}
.li-view {
  margin-left: 10px;
  font-size: 13px;
}
.li-reason {
  font-size: 12px;
  margin-top: 2px;
  overflow-wrap: anywhere;
}
.li-status + .li-reason {
  color: #b91c1c;
}
tr.li-quiet td {
  opacity: 0.6;
}
.li-actions {
  white-space: nowrap;
}
.li-actions .btn {
  margin-right: 6px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@media (max-width: 720px) {
  /* The switch spans the phone's width, one equal 44px-tall tap target per page. */
  .li-switch {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    width: 100%;
  }
  /* The Pause button sits under the switch, at the right, button-sized: a rare action, not a full-width bar a thumb lands on. */
  .li-scope {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  /* (the button belongs to PagePauseControl, so it is reached with :deep) */
  .li-scope :deep(.btn) {
    align-self: flex-end;
  }
  .li-switch button {
    min-width: 0;
    min-height: 44px;
  }
  .toolbar .btn,
  .li-days .btn,
  .li-chip,
  .li-date input,
  .li-view {
    min-height: 44px;
  }
  .li-view {
    display: inline-flex;
    align-items: center;
  }
  .li-chips {
    width: 100%;
  }
  .li-chip {
    flex: 1 1 auto;
  }
  .li-actions .btn {
    margin-right: 0;
    min-height: 44px;
  }
}
</style>

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
  /** Present ONLY on a SKIPPED row the system or a sender skipped: 'compose_skip' (unticked on Compose) or 'page_paused' (an administrator paused the page). Never shown as a code. */
  skipReason?: string;
};
type Counts = { waiting: number; posted: number; failed: number; skipped: number; notPosted: number; all: number };
type ListResponse = {
  date: string;
  rows: Row[];
  counts: Counts;
  /** The page these rows belong to, and the ACTIVE pages (Taxscan first). `pages` comes ONLY with two or more: a server without it gets no switch. */
  page?: string;
  pages?: string[];
  login: { since: string; status: number | null } | null;
  policy: { since: string; code: number | null; subcode: number | null; message: string | null } | null;
  /**
   * Present (an ISO time) ONLY while the page posts EVERY push (articles, courses, shop products; a repeat is its own row), from
   * that time. Missing = the old rule: one post per article. Pushes before the time keep the old rule.
   */
  everyPushFrom?: string;
  /** ok | paused | stopped | held | failing, with the banner's sentence in `message`. A server without it shows no banner. */
  pageStatus?: PageStatus;
};
type CheckResult = { ok: true; name: string; message: string } | { ok: false; kind: string; status?: number | null; code?: number | null; message: string };
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
const policy = ref<ListResponse['policy']>(null);
// Which Facebook page is on screen. null = not chosen yet: the first request leaves `page` out and adopts the server's answer (its
// first page, Taxscan). `pages` = the ACTIVE pages (Taxscan, then Shopscan); the switch shows only when there are two or more.
const page = ref<string | null>(null);
const pages = ref<string[]>([]);
// When the page started posting EVERY push (the server's `everyPushFrom`); null = it still posts one per article.
const everyPushFrom = ref<string | null>(null);
const pageStatus = ref<PageStatus | null>(null);
const check = ref<CheckResult | null>(null);
const checking = ref(false);
const resuming = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const busyId = ref<string | null>(null);
const retrying = ref<Row | null>(null);

const isToday = computed(() => date.value === maxDate);
const isYesterday = computed(() => date.value === istDay(-1));

// A page's name as the editors say it. Any other key is shown capitalised (a page added later needs no change here).
const PAGE_LABEL: Record<string, string> = { taxscan: 'Taxscan', shopscan: 'Shopscan' };
const labelOf = (key: string): string => PAGE_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
const multi = computed(() => pages.value.length > 1);
// The page being shown ("Taxscan" until the first answer, which is also what a one-page server always shows).
const pageLabel = computed(() => labelOf(page.value ?? pages.value[0] ?? 'taxscan'));
// A page after the first (Shopscan): it starts posting at its own go-live, so nothing before then is ever posted to it.
const laterPage = computed(() => multi.value && !!page.value && page.value !== pages.value[0]);
const bothPages = computed(() => (pages.value.length === 2 ? 'Both pages' : 'All pages'));

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

const loginText = computed(() => {
  if (!login.value) return '';
  const when = new Date(login.value.since).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const st = login.value.status ? ` (${login.value.status})` : '';
  const lead = `Facebook rejected the access token${st} since ${when}.`;
  // One page in use: the original wording, word for word.
  if (!multi.value) return `${lead} Posting is stopped until a new token is set in Railway or the app restarts.`;
  // Two pages: a stop belongs to one page, so the banner names it.
  return `${lead} Posting to the ${pageLabel.value} page is stopped until a new token is set in Railway or the app restarts. Tell the owner.`;
});

function whenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
// "4 Nov 2026, 15:56 IST": the time in IST like the "Pushed (IST)" column, so the moment can be compared with the rows below.
// Empty when the server's time is unreadable (the line is then left out).
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
const policyText = computed(() => {
  const p = policy.value;
  if (!p) return '';
  const code = p.code ? ` (code ${p.code}${p.subcode ? '/' + p.subcode : ''})` : '';
  const said = p.message ? ` Facebook said: “${p.message.replace(/[.\s]+$/, '')}”.` : '';
  return `Since ${whenText(p.since)}${code}.${said} Nothing is posted${multi.value ? ' to this page' : ''} until an administrator presses Resume.`;
});

// Each answer is for one page and one day. If a newer request has started (another page or day tapped meanwhile), an older
// answer is dropped, so one page's rows can never appear under the other page's name.
let loadSeq = 0;
function fetchList(withPage = true): Promise<ListResponse> {
  const pageQ = withPage && page.value ? `&page=${encodeURIComponent(page.value)}` : '';
  return api.get<ListResponse>(`/api/facebook/posts?date=${encodeURIComponent(date.value)}${pageQ}`);
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
      // The remembered page is no longer active (the Shopscan page was switched off meanwhile): quietly ask for the first
      // page instead. Nothing on screen changes until that answer arrives, so if it fails too the screen stays consistent.
      data = await fetchList(false);
    }
    if (mine !== loadSeq) return;
    rows.value = data.rows;
    counts.value = data.counts;
    login.value = data.login;
    policy.value = data.policy ?? null;
    pages.value = data.pages ?? [];
    page.value = data.page ?? data.pages?.[0] ?? null;
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
  // Rows, counts and every banner belong to the page just left: clear them so none of its Retry / Skip / Resume buttons stay on
  // screen under the new name while the answer is on its way. The same goes for "every push is posted from …" (each page has its
  // own time) and for a Check connection answer, which was about the other page's token (one still on its way is dropped).
  rows.value = [];
  counts.value = { ...EMPTY_COUNTS };
  login.value = null;
  policy.value = null;
  pageStatus.value = null;
  everyPushFrom.value = null;
  check.value = null;
  checkSeq++;
  checking.value = false;
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
      ? `Check the ${pageLabel.value} Facebook page first — it may already be posted.`
      : 'Check the Facebook page first — it may already be posted.'
    : `It goes to the ${pageLabel.value} Facebook page straight away. Check the page first if you are unsure.`,
);

async function confirmRetry(): Promise<void> {
  const r = retrying.value;
  if (!r?.id) return;
  busyId.value = r.id;
  error.value = null;
  note.value = null;
  try {
    const res = await api.post<{ ok: boolean; status: 'POSTED' | 'FAILED' | 'PENDING' }>(
      `/api/facebook/posts/${encodeURIComponent(r.id)}/retry`,
      {},
      {
        ...PUSH_REQUEST,
        unknownMessage: 'No reply from the server — it may still be posting. Check the list in a minute.',
      },
    );
    if (res.status === 'FAILED') note.value = 'Facebook did not accept it — see the reason on the row.';
    else if (res.status === 'PENDING') note.value = 'Facebook is busy — it will be tried again shortly.';
    retrying.value = null;
    await load();
  } catch (e) {
    retrying.value = null;
    const status = (e as { status?: number })?.status;
    const reason = (e as { body?: { error?: string } })?.body?.error;
    if (status === 409) {
      error.value =
        reason === 'policy_stop'
          ? `Posting${multi.value ? ` to the ${pageLabel.value} page` : ''} is stopped because Facebook blocked a post. An administrator has to resume it first.`
          : reason === 'not_configured'
            ? `The ${multi.value ? `${pageLabel.value} ` : ''}Facebook page is not set up yet (page id / token in Railway).`
            : 'This post changed in the meantime — the list has been refreshed.';
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
    await api.post(`/api/facebook/posts/${encodeURIComponent(r.id)}/skip`, {});
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
    await load(true);
  } finally {
    busyId.value = null;
  }
}

const KIND_TEXT: Record<string, string> = {
  transient: 'Could not reach Facebook',
  auth: 'Facebook rejected the access token',
  policy: 'Facebook blocked the request',
  rate: 'Facebook is rate limiting us',
  not_configured: 'The page is not set up',
  failed: 'Facebook refused the request',
  error: 'Connection failed',
};

// A Check connection answer is for the page it was asked about: if another page is picked meanwhile (`checkSeq` moved), it is dropped.
let checkSeq = 0;
async function checkConnection(): Promise<void> {
  const mine = ++checkSeq;
  checking.value = true;
  check.value = null;
  try {
    const result = await api.post<CheckResult>(
      '/api/facebook/check',
      page.value ? { page: page.value } : {},
      { ...PUSH_REQUEST, unknownMessage: 'No reply from the server — try Check connection again.' },
    );
    if (mine === checkSeq) check.value = result;
  } catch (e) {
    if (mine === checkSeq) check.value = { ok: false, kind: 'error', message: apiErrorMessage(e) };
  } finally {
    if (mine === checkSeq) checking.value = false;
  }
}

async function resume(): Promise<void> {
  resuming.value = true;
  error.value = null;
  note.value = null;
  try {
    await api.post('/api/facebook/resume', page.value ? { page: page.value } : {});
    note.value = `Posting${multi.value ? ` to the ${pageLabel.value} page` : ''} resumed. The next waiting article goes out within a few minutes.`;
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (status === 409) note.value = `Posting${multi.value ? ` to the ${pageLabel.value} page` : ''} was already resumed.`;
    else error.value = apiErrorMessage(e);
  } finally {
    resuming.value = false;
    await load(true);
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
// A push whose sender unticked this page on Compose: SKIPPED, counted under Skipped, and (like every SKIPPED row) no buttons.
const COMPOSE_SKIP = 'compose_skip';
const COMPOSE_SKIP_TEXT = 'Skipped in Compose';
function statusText(r: Row): string {
  if (r.status === 'SKIPPED' && r.skipReason === COMPOSE_SKIP) return COMPOSE_SKIP_TEXT;
  // An administrator paused the page: skipped with no post, never posted later. Counts under Skipped, no buttons.
  if (r.status === 'SKIPPED' && r.skipReason === PAGE_PAUSED) return PAGE_PAUSED_TEXT;
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
      <h1 class="section-title" style="margin: 0">Facebook page</h1>
      <div class="fb-tools">
        <!-- One page: Check connection and Pause sit with Refresh. With a page switch both are about the page chosen, so they move onto the switch's row. -->
        <button v-if="isAdmin && !multi" class="btn" :disabled="checking" data-testid="fb-check" @click="checkConnection">
          {{ checking ? 'Checking…' : 'Check connection' }}
        </button>
        <button class="btn" :disabled="loading" @click="load()">{{ loading ? 'Loading…' : 'Refresh' }}</button>
        <!-- Last: a rarely used action, so on a phone the two familiar buttons keep their row and this one wraps under them. -->
        <PagePauseControl v-if="isAdmin && !multi" channel="facebook" :page="page" :status="pageStatus" @done="onPauseDone" />
      </div>
    </div>
    <!-- Which page's list this is. Only while a second page (Shopscan) is on; it sits above everything it changes. -->
    <div v-if="multi" class="fb-scope">
      <div class="fb-switch" role="group" aria-label="Facebook page" data-testid="fb-switch">
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
      <div v-if="isAdmin" class="fb-scope-tools">
        <button class="btn" :disabled="checking" data-testid="fb-check" @click="checkConnection">
          {{ checking ? 'Checking…' : 'Check connection' }}
        </button>
        <PagePauseControl channel="facebook" :page="page" :status="pageStatus" @done="onPauseDone" />
      </div>
    </div>
    <!-- Paused / held / failing, for the page shown: first thing under the title (and the page switch), so a phone sees it before the explanation. -->
    <PageStatusBanner :status="pageStatus" :is-admin="isAdmin" />
    <p class="muted" :class="{ 'fb-every': everyPushFrom }" style="font-size: 13px; margin: 4px 0 8px" data-testid="fb-intro">
      <!-- The page posts EVERY push from a set time (the server sent `everyPushFrom`): say so, and from when. -->
      <template v-if="everyPushFrom">
        Every push we send is posted to the {{ pageLabel }} Facebook page automatically, a few minutes later: articles, courses and shop
        products. A push that is sent again is posted again and gets its own row. Nothing to do unless a post fails.
        <template v-if="multi">{{ bothPages }} get every push, each with its own pace and its own stops.</template>
        <span v-if="sinceText && !laterPage" class="fb-since" data-testid="fb-since"
          >From {{ sinceText }} every push is posted. Earlier pushes keep the old rule: one post per article.</span
        >
        <!-- A page after the first starts at its own go-live: pushes before it are never posted there. -->
        <span v-else-if="sinceText" class="fb-since" data-testid="fb-since"
          >From {{ sinceText }} every push is posted. Pushes before then are not posted to this page.</span
        >
      </template>
      <template v-else>
        Every article we push is posted to the {{ pageLabel }} Facebook page automatically, a few minutes later. Nothing to do
        unless a post fails.
        <template v-if="multi">Each page has its own pace and its own stops.</template>
      </template>
    </p>
    <ul class="fb-rules muted" data-testid="fb-rules">
      <li>One post at a time, at least 10 minutes apart, and no more than 30 a day. Busy days spill over, so a post can be late.</li>
      <li v-if="multi" data-testid="fb-rule-stop">
        If Facebook blocks a post to the {{ pageLabel }} page, posting to it stops completely until an administrator presses Resume. The
        other page keeps posting.
      </li>
      <li v-else>If Facebook blocks a post, posting stops completely until an administrator presses Resume.</li>
      <li v-if="everyPushFrom" data-testid="fb-rule-repeat">
        If Facebook refuses an identical repeat, the row says “Facebook says this was already posted”. Nothing to fix: press Skip.
      </li>
    </ul>

    <div v-if="check" class="banner" :class="check.ok ? 'ok' : 'err'" role="status" data-testid="fb-check-result">
      <!-- The answer belongs to the page shown: with a switch it names that page, and Facebook's own name for it (a wrong token shows here). -->
      <template v-if="check.ok && multi">{{ pageLabel }} page: connected to <strong>{{ check.name }}</strong></template>
      <template v-else-if="check.ok">Connected to page: <strong>{{ check.name }}</strong></template>
      <template v-else>
        <strong>{{ multi ? pageLabel + ' page: ' : '' }}{{ KIND_TEXT[check.kind] ?? 'Connection failed' }}.</strong>
        {{ check.message }}{{ check.status ? ' (HTTP ' + check.status + (check.code ? ', code ' + check.code : '') + ')' : '' }}
      </template>
    </div>

    <div v-if="policy" class="banner err fb-policy" role="alert" data-testid="fb-policy">
      <div>
        <strong>Facebook blocked a post{{ multi ? ' to the ' + pageLabel + ' page' : '' }} — check the page before resuming.</strong>
        <div>{{ policyText }}</div>
        <div v-if="!isAdmin" style="margin-top: 4px">Ask an administrator to resume posting once the page is fine.</div>
      </div>
      <button v-if="isAdmin" type="button" class="btn btn-primary" :disabled="resuming" @click="resume">
        {{ resuming ? 'Resuming…' : 'Resume posting' }}
      </button>
    </div>
    <div v-if="login" class="banner warn" role="alert">{{ loginText }}</div>

    <div class="fb-controls">
      <div class="fb-days">
        <button type="button" class="btn" :class="{ 'fb-on': isToday }" @click="setDate(maxDate)">Today</button>
        <button type="button" class="btn" :class="{ 'fb-on': isYesterday }" @click="setDate(istDay(-1))">Yesterday</button>
        <label class="fb-date">
          <span class="sr-only">Pick a date</span>
          <input type="date" :value="date" :min="minDate" :max="maxDate" aria-label="Pick a date" @change="onPick" />
        </label>
      </div>
      <div class="fb-chips" role="group" aria-label="Filter by status">
        <button
          v-for="c in CHIPS"
          :key="c.key"
          type="button"
          class="fb-chip"
          :class="{ 'fb-on': filter === c.key, 'fb-alert': c.key === 'failed' && counts.failed > 0 }"
          :aria-pressed="filter === c.key"
          @click="filter = c.key"
        >
          {{ c.label }} <span class="fb-count">{{ c.key === 'all' ? counts.all : counts[c.key] }}</span>
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
          <tr v-for="r in shown" :key="r.campaignId" :class="{ 'fb-quiet': r.status === 'NOT_POSTED' }">
            <td data-label="Pushed" style="white-space: nowrap">
              <strong>{{ r.pushedTime }}</strong>
            </td>
            <td class="cell-lead">{{ r.headline }}</td>
            <td class="cell-wide" data-label="Status">
              <span class="fb-status" :class="'s-' + r.status">{{ statusText(r) }}</span>
              <a
                v-if="r.status === 'POSTED' && r.postUrl"
                class="fb-view"
                :href="r.postUrl"
                target="_blank"
                rel="noopener"
                >View on Facebook</a
              >
              <div v-if="r.status === 'FAILED' && r.error" class="fb-reason">{{ r.error }}</div>
              <div v-else-if="r.status === 'RETRYING' && r.error" class="fb-reason muted">{{ r.error }}</div>
            </td>
            <td class="cell-actions fb-actions">
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
      heading="Post to Facebook now?"
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
   status pills below it. The same box as the LinkedIn screen's, and the joined .seg control on Reports and Digests. No
   overflow:hidden (it would clip the keyboard focus ring), so the outer corners are rounded on the buttons themselves. */
.fb-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* The page switch and the actions for the page it shows (Check connection, Pause): one row, the switch left, the actions right. */
.fb-scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  margin: 0 0 8px;
}
.fb-scope-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-switch {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
.fb-switch button {
  min-width: 104px;
  min-height: 38px;
  padding: 8px 20px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
}
.fb-switch button:first-child {
  border-radius: 7px 0 0 7px;
}
.fb-switch button:last-child {
  border-radius: 0 7px 7px 0;
}
.fb-switch button:hover:not(.on) {
  background: #f1f5f9;
}
.fb-switch button.on {
  background: var(--primary);
  color: #fff;
  font-weight: 600;
}
.fb-switch button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.fb-rules {
  font-size: 13px;
  margin: 0 0 12px;
  padding-left: 18px;
}
/* The longer explanation (the page posts every push): no one-word last line on a phone. Only this state, so the old text lays out as before. */
.fb-every {
  text-wrap: pretty;
}
/* The second line of the explanation: from when every push is posted. Same muted 13px as the paragraph, on its own line. */
.fb-since {
  display: block;
  margin-top: 4px;
}
.fb-policy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  overflow-wrap: anywhere;
}
.fb-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-bottom: 12px;
}
.fb-days {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.fb-date input {
  width: auto;
}
.fb-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}
.fb-chip.fb-alert:not(.fb-on) {
  border-color: #dc2626;
  color: #b91c1c;
  font-weight: 600;
}
.fb-chip.fb-on,
.btn.fb-on {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.fb-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
  margin-left: 2px;
}
.fb-status {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.fb-status.s-POSTED {
  color: #16a34a;
}
.fb-status.s-FAILED {
  color: #dc2626;
}
.fb-status.s-SKIPPED,
.fb-status.s-RETRYING {
  color: var(--warn);
}
.fb-view {
  margin-left: 10px;
  font-size: 13px;
}
.fb-reason {
  font-size: 12px;
  margin-top: 2px;
  overflow-wrap: anywhere;
}
.fb-status + .fb-reason {
  color: #b91c1c;
}
tr.fb-quiet td {
  opacity: 0.6;
}
.fb-actions {
  white-space: nowrap;
}
.fb-actions .btn {
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
  .fb-policy .btn {
    width: 100%;
  }
  /* The switch spans the phone's width, one equal 44px-tall tap target per page. */
  .fb-switch {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    width: 100%;
  }
  /* The page's actions sit under the switch, at the right, button-sized: rare actions, not full-width bars a thumb lands on. */
  .fb-scope {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .fb-scope-tools {
    justify-content: flex-end;
  }
  .fb-switch button {
    min-width: 0;
    min-height: 44px;
  }
  .toolbar .btn,
  .fb-scope .btn,
  .fb-days .btn,
  .fb-chip,
  .fb-date input,
  .fb-view {
    min-height: 44px;
  }
  .fb-view {
    display: inline-flex;
    align-items: center;
  }
  .fb-chips {
    width: 100%;
  }
  .fb-chip {
    flex: 1 1 auto;
  }
  .fb-actions .btn {
    margin-right: 0;
    min-height: 44px;
  }
}
</style>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { apiErrorMessage, useApi, type ApiError } from '../composables/useApi';
import ConfirmPush from '../components/ConfirmPush.vue';
import { AUDIENCES, AUDIENCE_LABEL, type Audience } from '../composables/digestView';

/**
 * Ads (docs/EMAIL_DIGEST_DESIGN.md §7): the house ads the morning digest
 * places in its three slots. Any signed-in user. The server decides eligibility and
 * coverage (`pickAds`, the build's own rule); this screen shows its answer.
 *
 * The one new element is the coverage check: each audience's email drawn as a
 * skeleton with the three slots where the reader meets them, each filled with
 * the ad the next build would place, or marked empty — an empty slot stops
 * the build, so it is shown here rather than discovered at 06:30.
 */

type Kind = 'HOUSE' | 'SUBSCRIPTION' | 'RENEWAL';
type AdAudience = 'ALL' | 'FREE_ONLY' | 'PREMIUM_ONLY';
type Ad = {
  id: string;
  name: string;
  kind: Kind;
  headline: string;
  altText: string;
  body: string | null;
  ctaText: string;
  linkUrl: string;
  imageId: string | null;
  image: { url: string; width: number; height: number; size: number } | null;
  audience: AdAudience;
  topic: string | null;
  slots: number[];
  priority: number;
  isSlotDefault: boolean;
  startsAt: string | null;
  endsAt: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  window: 'live' | 'scheduled' | 'ended';
  lastPlacedAt: string | null;
  utmExample: string | null;
};
type SlotCoverage = {
  slot: number;
  ok: boolean;
  eligible: number;
  defaults: number;
  pick: { adId: string; name: string; viaDefault: boolean } | null;
  problem: string | null;
};
type Coverage = {
  ok: boolean;
  checkedFor: string;
  audiences: Record<Audience, { ok: boolean; slots: SlotCoverage[] }>;
  problems: string[];
};
type ListPayload = { ads: Ad[]; coverage: Coverage; slots: number[]; topics: string[]; id?: string };
type Uploaded = { id: string; url: string; width: number; height: number; size: number; deduped: boolean };

const KIND_LABEL: Record<Kind, string> = { HOUSE: 'House', SUBSCRIPTION: 'Subscription', RENEWAL: 'Renewal' };
const AUDIENCE_OPTS: { value: AdAudience; label: string }[] = [
  { value: 'ALL', label: 'Free and Premium' },
  { value: 'FREE_ONLY', label: 'Free only' },
  { value: 'PREMIUM_ONLY', label: 'Premium only' },
];
/** Where each slot sits in the email (renderer AD_SLOTS). */
const SLOT_WHERE: Record<number, string> = { 1: 'after story 4', 2: 'after story 9', 3: 'above the footer' };
const SLOT_NOTE: Record<number, string> = { 2: 'Shown only when the digest has 9 or more stories.' };

const api = useApi();
const data = ref<ListPayload | null>(null);
const showArchived = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const saving = ref(false);
const uploading = ref(false);
const archiving = ref<Ad | null>(null);
const archiveBusy = ref(false);

const editingId = ref<string | null>(null);
const formOpen = ref(false);
const fieldErrors = ref<Record<string, string>>({});
const form = reactive({
  name: '',
  kind: 'HOUSE' as Kind,
  headline: '',
  altText: '',
  body: '',
  ctaText: '',
  linkUrl: '',
  imageId: null as string | null,
  imagePreview: null as string | null,
  imageInfo: '' as string,
  audience: 'ALL' as AdAudience,
  topic: '',
  slots: [] as number[],
  priority: 0,
  isSlotDefault: false,
  startsAt: '',
  endsAt: '',
  status: 'ACTIVE' as 'ACTIVE' | 'PAUSED',
});

const ads = computed(() => data.value?.ads ?? []);
const slotNumbers = computed(() => data.value?.slots ?? [1, 2, 3]);
const coverage = computed(() => data.value?.coverage ?? null);
const buildLabel = computed(() => {
  const at = coverage.value?.checkedFor;
  if (!at) return '';
  return new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
});
const brokenCount = computed(() => coverage.value?.problems.length ?? 0);
/** The audiences whose email cannot be filled (each one is held back on its own; the other still goes out). */
const brokenAudiences = computed(() => AUDIENCES.filter((a) => coverage.value && !coverage.value.audiences[a].ok));

/** Same-origin path for an image the server reports at its public host (works locally too). */
function localSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    data.value = await api.get<ListPayload>(`/api/digest/ads${showArchived.value ? '?archived=1' : ''}`);
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  // datetime-local in IST (the newsroom's clock), independent of the device's zone.
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  return d.toISOString().slice(0, 16);
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  return new Date(`${v}:00+05:30`).toISOString();
}

function resetForm() {
  Object.assign(form, {
    name: '',
    kind: 'HOUSE',
    headline: '',
    altText: '',
    body: '',
    ctaText: '',
    linkUrl: '',
    imageId: null,
    imagePreview: null,
    imageInfo: '',
    audience: 'ALL',
    topic: '',
    slots: [],
    priority: 0,
    isSlotDefault: false,
    startsAt: '',
    endsAt: '',
    status: 'ACTIVE',
  });
  fieldErrors.value = {};
}

function startNew() {
  resetForm();
  editingId.value = null;
  formOpen.value = true;
  notice.value = null;
}

function startEdit(a: Ad) {
  resetForm();
  Object.assign(form, {
    name: a.name,
    kind: a.kind,
    headline: a.headline,
    altText: a.altText,
    body: a.body ?? '',
    ctaText: a.ctaText,
    linkUrl: a.linkUrl,
    imageId: a.imageId,
    imagePreview: localSrc(a.image?.url),
    imageInfo: a.image ? `${a.image.width} × ${a.image.height} px, ${Math.ceil(a.image.size / 1024)} KB` : '',
    audience: a.audience,
    topic: a.topic ?? '',
    slots: [...a.slots],
    priority: a.priority,
    isSlotDefault: a.isSlotDefault,
    startsAt: toLocalInput(a.startsAt),
    endsAt: toLocalInput(a.endsAt),
    status: a.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
  });
  editingId.value = a.id;
  formOpen.value = true;
  notice.value = null;
  requestAnimationFrame(() => document.getElementById('ad-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function closeForm() {
  formOpen.value = false;
  editingId.value = null;
}

async function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  uploading.value = true;
  fieldErrors.value = { ...fieldErrors.value, imageId: '' };
  try {
    const r = await api.upload<Uploaded>('/api/digest/ad-images', file);
    form.imageId = r.id;
    form.imagePreview = localSrc(r.url);
    form.imageInfo = `${r.width} × ${r.height} px, ${Math.ceil(r.size / 1024)} KB${r.deduped ? ' (already uploaded)' : ''}`;
  } catch (e) {
    fieldErrors.value = { ...fieldErrors.value, imageId: apiErrorMessage(e) };
  } finally {
    uploading.value = false;
  }
}

function removeImage() {
  form.imageId = null;
  form.imagePreview = null;
  form.imageInfo = '';
}

function toggleSlot(n: number) {
  form.slots = form.slots.includes(n) ? form.slots.filter((x) => x !== n) : [...form.slots, n].sort();
}

const subscriptionToPremium = computed(() => form.kind === 'SUBSCRIPTION' && form.audience !== 'FREE_ONLY');

async function save() {
  saving.value = true;
  error.value = null;
  fieldErrors.value = {};
  const body = {
    name: form.name,
    kind: form.kind,
    headline: form.headline,
    altText: form.altText,
    body: form.body || null,
    ctaText: form.ctaText,
    linkUrl: form.linkUrl.trim(),
    imageId: form.imageId,
    audience: form.audience,
    topic: form.topic || null,
    slots: form.slots,
    priority: Number(form.priority) || 0,
    isSlotDefault: form.isSlotDefault,
    startsAt: fromLocalInput(form.startsAt),
    endsAt: fromLocalInput(form.endsAt),
    status: form.status,
  };
  try {
    const res = editingId.value
      ? await api.put<ListPayload>(`/api/digest/ads/${editingId.value}`, body)
      : await api.post<ListPayload>('/api/digest/ads', body);
    data.value = res;
    if (showArchived.value) await load();
    notice.value = editingId.value ? `Saved “${form.name}”.` : `Added “${form.name}”.`;
    closeForm();
  } catch (e) {
    const issues = ((e as ApiError).body as { issues?: { message: string; path?: string[] }[] } | undefined)?.issues;
    if (issues?.length) {
      const map: Record<string, string> = {};
      for (const i of issues) map[i.path?.[0] ?? '_'] = map[i.path?.[0] ?? '_'] ?? i.message;
      fieldErrors.value = map;
      error.value = 'Check the highlighted fields.';
    } else {
      error.value = apiErrorMessage(e);
    }
  } finally {
    saving.value = false;
  }
}

async function confirmArchive() {
  const a = archiving.value;
  if (!a) return;
  archiveBusy.value = true;
  error.value = null;
  try {
    data.value = await api.post<ListPayload>(`/api/digest/ads/${a.id}/archive`, { confirm: true });
    if (showArchived.value) await load();
    notice.value = `Archived “${a.name}”. It will not be placed again.`;
    if (editingId.value === a.id) closeForm();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    archiveBusy.value = false;
    archiving.value = null;
  }
}

function dateIst(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
}
function windowText(a: Ad): string {
  if (!a.startsAt && !a.endsAt) return 'No end date';
  const from = a.startsAt ? dateIst(a.startsAt) : 'now';
  const to = a.endsAt ? dateIst(a.endsAt) : 'no end';
  return `${from} – ${to}`;
}
function statusBadge(a: Ad): { text: string; cls: string } {
  if (a.status === 'ARCHIVED') return { text: 'Archived', cls: 'DRAFT' };
  if (a.status === 'PAUSED') return { text: 'Paused', cls: 'DRAFT' };
  if (a.window === 'ended') return { text: 'Ended', cls: 'DRAFT' };
  if (a.window === 'scheduled') return { text: 'Starts later', cls: 'SCHEDULED' };
  return { text: 'Running', cls: 'SENT' };
}
const audienceText = (v: AdAudience) => AUDIENCE_OPTS.find((o) => o.value === v)?.label ?? v;
/** The server's "Slot 3 — Premium: no eligible ad…" without the slot/audience the card already shows. */
function problemText(p: string | null): string {
  const t = (p ?? '').replace(/^Slot \d+ — \w+: /, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
/** A subscription ad meant for everyone still never reaches Premium: say what actually happens. */
function audienceShown(a: Ad): string {
  if (a.kind === 'SUBSCRIPTION' && a.audience === 'ALL') return 'Free only (never Premium)';
  return audienceText(a.audience);
}
const slotsText = (s: number[]) => (s.length === 0 ? 'Any' : s.join(', '));

/** Story bars drawn above each slot in the skeleton (4 before slot 1, 5 before slot 2, 3 before slot 3). */
const BARS_BEFORE: Record<number, number> = { 1: 4, 2: 5, 3: 3 };

onMounted(load);
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Digest ads</h1>
      <div class="toolbar-group">
        <button class="btn btn-primary" :disabled="formOpen && !editingId" @click="startNew">New ad</button>
        <button class="btn" :disabled="loading" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
      </div>
    </div>

    <div v-if="error" class="banner err" role="alert">{{ error }}</div>
    <div v-if="notice" class="banner ok" role="status">{{ notice }}</div>

    <!-- Coverage: every slot of both emails, as the reader meets them -->
    <section v-if="coverage" class="card">
      <div class="cov-head" :class="coverage.ok ? 'is-ok' : 'is-bad'">
        <p class="cov-verdict">
          <template v-if="coverage.ok">Every slot is filled for the next build.</template>
          <template v-else>
            {{ brokenCount === 1 ? 'One slot' : `${brokenCount} slots` }} can’t be filled —
            <template v-if="brokenAudiences.length === 1">
              the {{ AUDIENCE_LABEL[brokenAudiences[0]] }} digest will not go out until it is fixed (the
              {{ AUDIENCE_LABEL[brokenAudiences[0] === 'FREE' ? 'PREMIUM' : 'FREE'] }} digest still does).
            </template>
            <template v-else>the next build will stop and no digest goes out until it is fixed.</template>
          </template>
        </p>
        <p class="muted cov-when">Checked for the build on {{ buildLabel }} IST, with the ads as they are now.</p>
      </div>

      <div class="cov-grid">
        <div v-for="a in AUDIENCES" :key="a" class="cov-email" :aria-label="`${AUDIENCE_LABEL[a]} digest`">
          <p class="cov-title">
            {{ AUDIENCE_LABEL[a] }} digest
            <span v-if="a === 'PREMIUM'" class="muted cov-title-note">never shows a subscription ad</span>
          </p>
          <div class="cov-mail">
            <div class="cov-mast" aria-hidden="true" />
            <template v-for="s in coverage.audiences[a].slots" :key="s.slot">
              <div class="cov-bars" aria-hidden="true">
                <span v-for="i in BARS_BEFORE[s.slot] ?? 3" :key="i" class="cov-bar" />
              </div>
              <div class="cov-slot" :class="s.ok ? 'filled' : 'empty'">
                <div class="cov-slot-head">
                  <span class="cov-slot-name">Slot {{ s.slot }}</span>
                  <span class="muted">{{ SLOT_WHERE[s.slot] }}</span>
                </div>
                <template v-if="s.pick">
                  <p class="cov-ad">{{ s.pick.name }}</p>
                  <p class="muted cov-meta">
                    {{ s.pick.viaDefault ? 'The slot’s default ad' : `${s.eligible} eligible` }}<span
                      v-if="!s.pick.viaDefault && s.defaults"
                      >, {{ s.defaults }} default</span
                    >
                  </p>
                </template>
                <p v-else class="cov-problem">
                  <span aria-hidden="true">✗ </span>{{ problemText(s.problem) }}
                </p>
                <p v-if="SLOT_NOTE[s.slot]" class="muted cov-meta">{{ SLOT_NOTE[s.slot] }}</p>
              </div>
            </template>
            <div class="cov-foot" aria-hidden="true" />
          </div>
        </div>
      </div>
    </section>

    <!-- Editor -->
    <section v-if="formOpen" id="ad-form" class="card">
      <div class="toolbar">
        <h2 style="margin: 0">{{ editingId ? 'Edit ad' : 'New ad' }}</h2>
        <button class="btn btn-mini" @click="closeForm">Cancel</button>
      </div>
      <form class="ad-form" @submit.prevent="save">
        <div class="f f-wide">
          <label for="ad-name">Name (only you see this)</label>
          <input id="ad-name" v-model="form.name" maxlength="80" :aria-invalid="!!fieldErrors.name" />
          <p v-if="fieldErrors.name" class="f-err">{{ fieldErrors.name }}</p>
        </div>

        <div class="f f-wide image-field">
          <label for="ad-image">Image (optional)</label>
          <div class="image-row">
            <div class="image-box" :class="{ has: form.imagePreview }">
              <img v-if="form.imagePreview" :src="form.imagePreview" :alt="form.altText || 'Ad image'" />
              <span v-else class="muted">No image</span>
            </div>
            <div class="image-side">
              <input id="ad-image" type="file" accept="image/jpeg,image/png" :disabled="uploading" @change="onFile" />
              <p class="muted">JPEG or PNG, up to 1200 px wide and 150 KB. Put the offer in the headline below, not only in the picture.</p>
              <p class="muted">Best size: 1200 × 628 (wide rectangle).</p>
              <p v-if="form.imageInfo" class="muted">{{ form.imageInfo }}</p>
              <p v-if="uploading" class="muted">Uploading…</p>
              <button v-if="form.imageId" type="button" class="btn btn-mini" @click="removeImage">Remove image</button>
              <p v-if="fieldErrors.imageId" class="f-err">{{ fieldErrors.imageId }}</p>
            </div>
          </div>
        </div>

        <div class="f f-wide">
          <label for="ad-headline">Headline</label>
          <input id="ad-headline" v-model="form.headline" maxlength="120" :aria-invalid="!!fieldErrors.headline" />
          <p v-if="fieldErrors.headline" class="f-err">{{ fieldErrors.headline }}</p>
        </div>
        <div class="f f-wide">
          <label for="ad-body">Body (optional)</label>
          <textarea id="ad-body" v-model="form.body" maxlength="300" rows="2" />
          <p v-if="fieldErrors.body" class="f-err">{{ fieldErrors.body }}</p>
        </div>
        <div class="f">
          <label for="ad-cta">Button text</label>
          <input id="ad-cta" v-model="form.ctaText" maxlength="30" placeholder="Enrol now" :aria-invalid="!!fieldErrors.ctaText" />
          <p v-if="fieldErrors.ctaText" class="f-err">{{ fieldErrors.ctaText }}</p>
        </div>
        <div class="f">
          <label for="ad-alt">Image description (alt text)</label>
          <input id="ad-alt" v-model="form.altText" maxlength="150" :aria-invalid="!!fieldErrors.altText" />
          <p v-if="fieldErrors.altText" class="f-err">{{ fieldErrors.altText }}</p>
        </div>
        <div class="f f-wide">
          <label for="ad-link">Link</label>
          <input id="ad-link" v-model="form.linkUrl" inputmode="url" placeholder="https://academy.taxscan.in/…" :aria-invalid="!!fieldErrors.linkUrl" />
          <p v-if="fieldErrors.linkUrl" class="f-err">{{ fieldErrors.linkUrl }}</p>
          <p v-else class="muted">
            taxscan.in, academy.taxscan.in or shop.taxscan.in. Tracking (utm_…) is added in each email, ending
            <code>utm_content=ad-…-slot1</code>.
          </p>
        </div>

        <div class="f">
          <label for="ad-kind">Kind</label>
          <select id="ad-kind" v-model="form.kind">
            <option v-for="(label, k) in KIND_LABEL" :key="k" :value="k">{{ label }}</option>
          </select>
        </div>
        <div class="f">
          <label for="ad-aud">Who sees it</label>
          <select id="ad-aud" v-model="form.audience" :aria-invalid="!!fieldErrors.audience">
            <option v-for="o in AUDIENCE_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <p v-if="fieldErrors.audience" class="f-err">{{ fieldErrors.audience }}</p>
          <p v-else-if="subscriptionToPremium" class="muted">Premium readers never get a subscription ad; their slot is filled from the other ads.</p>
        </div>

        <fieldset class="f slots-field">
          <legend>Slots</legend>
          <div class="slot-picks">
            <label v-for="s in slotNumbers" :key="s" class="slot-pick">
              <input type="checkbox" :checked="form.slots.includes(s)" @change="toggleSlot(s)" />
              {{ s }} <span class="muted">{{ SLOT_WHERE[s] }}</span>
            </label>
          </div>
          <p class="muted">None ticked = any slot.</p>
          <p v-if="fieldErrors.slots" class="f-err">{{ fieldErrors.slots }}</p>
        </fieldset>
        <div class="f">
          <label for="ad-priority">Priority (0–100)</label>
          <input id="ad-priority" v-model.number="form.priority" type="number" min="0" max="100" step="1" />
          <p class="muted">Higher goes first; equal ones take turns.</p>
          <p v-if="fieldErrors.priority" class="f-err">{{ fieldErrors.priority }}</p>
        </div>

        <div class="f">
          <label for="ad-topic">Topic (optional)</label>
          <input id="ad-topic" v-model="form.topic" list="ad-topics" maxlength="60" placeholder="GST" />
          <datalist id="ad-topics">
            <option v-for="t in data?.topics ?? []" :key="t" :value="t" />
          </datalist>
          <p class="muted">Goes first when the top stories are on this topic.</p>
        </div>
        <div class="f">
          <label for="ad-status">Status</label>
          <select id="ad-status" v-model="form.status">
            <option value="ACTIVE">Running</option>
            <option value="PAUSED">Paused</option>
          </select>
        </div>
        <div class="f">
          <label for="ad-start">Starts (IST, optional)</label>
          <input id="ad-start" v-model="form.startsAt" type="datetime-local" />
        </div>
        <div class="f">
          <label for="ad-end">Ends (IST, optional)</label>
          <input id="ad-end" v-model="form.endsAt" type="datetime-local" :aria-invalid="!!fieldErrors.endsAt" />
          <p v-if="fieldErrors.endsAt" class="f-err">{{ fieldErrors.endsAt }}</p>
          <p v-else class="muted">Set one for any offer, so it stops on time.</p>
        </div>

        <div class="f f-wide checkbox-row">
          <!-- The input sits INSIDE the label, so the whole pill is the checkbox (app.css .checkbox-row). -->
          <label for="ad-default">
            <input id="ad-default" v-model="form.isSlotDefault" type="checkbox" />
            Default for its slots — used only when no other ad can go there
          </label>
        </div>

        <div class="f f-wide form-actions">
          <button type="button" class="btn" @click="closeForm">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="saving || uploading">
            {{ saving ? 'Saving…' : editingId ? 'Save ad' : 'Add ad' }}
          </button>
        </div>
      </form>
    </section>

    <!-- List -->
    <section class="card">
      <div class="toolbar">
        <h2 style="margin: 0">Ads ({{ ads.length }})</h2>
        <label class="archived-toggle">
          <input v-model="showArchived" type="checkbox" @change="load" /> Show archived
        </label>
      </div>
      <table class="stack">
        <thead>
          <tr>
            <th>Ad</th>
            <th>Status</th>
            <th>Dates</th>
            <th>Who sees it</th>
            <th>Slots</th>
            <th class="num">Priority</th>
            <th>Default</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in ads" :key="a.id">
            <td class="cell-lead">
              <div class="ad-cell">
                <img v-if="a.image" class="ad-thumb" :src="localSrc(a.image.url) ?? ''" :alt="a.altText" />
                <div>
                  <div>{{ a.name }}</div>
                  <div class="muted">
                    {{ KIND_LABEL[a.kind] }} · {{ a.headline }}<span v-if="a.topic"> · topic {{ a.topic }}</span>
                  </div>
                </div>
              </div>
            </td>
            <td data-label="Status">
              <span class="badge" :class="statusBadge(a).cls">{{ statusBadge(a).text }}</span>
            </td>
            <td data-label="Dates">{{ windowText(a) }}</td>
            <td data-label="Who sees it">
              {{ audienceShown(a) }}
            </td>
            <td data-label="Slots">{{ slotsText(a.slots) }}</td>
            <td class="num" data-label="Priority">{{ a.priority }}</td>
            <td data-label="Default">{{ a.isSlotDefault ? 'Yes' : '—' }}</td>
            <td class="cell-actions">
              <div class="row-actions">
                <button v-if="a.status !== 'ARCHIVED'" class="btn btn-mini" @click="startEdit(a)">Edit</button>
                <button v-if="a.status !== 'ARCHIVED'" class="btn btn-mini btn-danger" @click="archiving = a">Archive</button>
              </div>
            </td>
          </tr>
          <tr v-if="ads.length === 0 && !loading">
            <td colspan="8" class="muted" style="text-align: center; padding: 24px">
              No ads yet. Each audience needs at least three different ads (or defaults), one per slot — the same
              ad never appears twice in one email — before the digest is switched on.
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <ConfirmPush
      v-if="archiving"
      heading="Archive this ad?"
      :title="archiving.name"
      detail="It stops appearing in digests from the next build and can’t be edited again. Digests already sent keep it."
      confirm-label="Archive"
      :busy="archiveBusy"
      @confirm="confirmArchive"
      @cancel="archiving = null"
    />
  </main>
</template>

<style scoped>
/* Coverage */
.cov-head {
  padding: 2px 0 12px 12px;
  border-left: 3px solid var(--ok);
  margin-bottom: 14px;
}
.cov-head.is-bad {
  border-left-color: var(--danger);
}
.cov-verdict {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.is-bad .cov-verdict {
  color: var(--danger);
}
.cov-when {
  margin: 2px 0 0;
  font-size: 13px;
}
.cov-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.cov-title {
  margin: 0 0 8px;
  font-weight: 600;
}
.cov-title-note {
  font-weight: 400;
  font-size: 12px;
  margin-left: 6px;
}
/* The email in miniature: masthead, story lines, the slots where they fall, footer. */
.cov-mail {
  max-width: 420px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #f6f8fb;
  padding: 0 0 10px;
  overflow: hidden;
}
.cov-mast {
  height: 14px;
  background: #9b1c1c;
  margin-bottom: 8px;
}
.cov-bars {
  display: grid;
  gap: 4px;
  padding: 4px 14px 8px;
}
.cov-bar {
  display: block;
  height: 5px;
  border-radius: 3px;
  background: #dfe5ee;
}
.cov-bar:nth-child(2n) {
  width: 78%;
}
.cov-slot {
  margin: 0 10px 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 4px solid var(--ok);
  font-size: 13px;
}
.cov-slot.empty {
  border: 1px dashed var(--danger);
  border-left: 4px solid var(--danger);
  background: #fef2f2;
}
.cov-slot-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.cov-slot-name {
  font-weight: 700;
}
.cov-ad {
  margin: 2px 0 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.cov-meta {
  margin: 2px 0 0;
  font-size: 12px;
}
.cov-problem {
  margin: 2px 0 0;
  color: var(--danger);
  font-weight: 600;
}
.cov-foot {
  height: 8px;
  margin: 6px 14px 0;
  border-radius: 3px;
  background: #e8ecf2;
}

/* Form */
.ad-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 18px;
}
.f {
  min-width: 0;
}
.f-wide {
  grid-column: 1 / -1;
}
.f .muted,
.f-err {
  margin: 4px 0 0;
  font-size: 12px;
}
.f-err {
  color: var(--danger);
  font-weight: 600;
}
input[aria-invalid='true'],
select[aria-invalid='true'] {
  border-color: var(--danger);
}
.slots-field {
  border: 0;
  padding: 0;
  margin: 0;
}
.slots-field legend {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
  padding: 0;
}
.slot-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
.slot-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-transform: none;
  letter-spacing: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
  min-height: 32px;
}
.slot-pick input,
.checkbox-row input,
.archived-toggle input {
  width: auto;
}
.slot-pick .muted {
  font-weight: 400;
  font-size: 12px;
}
.checkbox-row label {
  font-size: 14px;
  font-weight: 500;
  min-height: 44px;
  box-sizing: border-box;
}
.image-row {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.image-box {
  flex: 0 0 200px;
  height: 110px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f8fafc;
  overflow: hidden;
}
.image-box.has {
  border-style: solid;
  background: #fff;
}
.image-box img {
  max-width: 100%;
  max-height: 100%;
  display: block;
}
.image-side {
  min-width: 0;
  flex: 1;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
code {
  font-size: 12px;
  overflow-wrap: anywhere;
}

/* List */
.archived-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  text-transform: none;
  letter-spacing: 0;
  font-size: 13px;
  font-weight: 500;
}
.ad-cell {
  display: flex;
  gap: 10px;
  align-items: center;
}
.ad-thumb {
  width: 64px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid var(--border);
  flex: 0 0 auto;
}
.num {
  font-variant-numeric: tabular-nums;
}
th.num,
td.num {
  text-align: right;
}

@media (max-width: 720px) {
  .cov-grid {
    grid-template-columns: 1fr;
  }
  .cov-mail {
    max-width: none;
  }
  .ad-form {
    grid-template-columns: 1fr;
  }
  .image-row {
    flex-direction: column;
  }
  .image-box {
    flex-basis: auto;
    width: 100%;
    height: 140px;
  }
  .form-actions .btn {
    flex: 1;
  }
  table.stack td.num {
    text-align: left !important;
  }
}
</style>

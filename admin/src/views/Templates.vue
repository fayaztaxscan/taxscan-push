<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { apiErrorMessage, useApi, type ApiError } from '../composables/useApi';
import ConfirmPush from '../components/ConfirmPush.vue';
import EmailPreviewFrame from '../components/EmailPreviewFrame.vue';
import { AUDIENCES, AUDIENCE_LABEL, PREVIEW_WIDTHS, type Audience, type PreviewWidth } from '../composables/digestView';

/**
 * Templates (docs/EMAIL_DIGEST_DESIGN.md §7): the layout of each audience's
 * digest email. ADMIN only. Every decision is the server's — which template is
 * in use (`resolveTemplate`), whether one may be activated (the checklist) —
 * and this screen shows its answer.
 *
 * The one new element is the checklist beside the source: each rule with its
 * verdict and the exact problems, and the Activate button that stays shut
 * until every rule passes. The preview is the shared sandboxed frame.
 */

type Status = 'DRAFT' | 'ACTIVE' | 'SCHEDULED' | 'ARCHIVED';
type Check = { id: string; label: string; ok: boolean; problems: string[]; note?: string };
type Validation = { ok: boolean; checkedAt: string; checks: Check[]; budgetBytes: number | null; maxBytes: number; warnBytes: number };
type Summary = {
  id: string;
  name: string;
  audience: Audience;
  status: Status;
  format: 'HTML' | 'MJML';
  startsAt: string | null;
  endsAt: string | null;
  window: 'live' | 'upcoming' | 'ended' | null;
  replacesId: string | null;
  activatedAt: string | null;
  updatedAt: string;
  validationOk: boolean;
  failed: string[];
  budgetBytes: number | null;
  compileError: string | null;
};
type Full = Summary & { source: string; validation: Validation | Record<string, never> };
type ListPayload = {
  templates: Summary[];
  inUse: Record<Audience, { id: string | null; name: string; source: 'builtin' | 'active' | 'override'; endsAt: string | null }>;
  revertTo: Record<Audience, { available: boolean; name: string | null }>;
  placeholders: { key: string; help: string; required: boolean }[];
  builtin: { name: string; source: string };
};

const STATUS_LABEL: Record<Status, string> = { DRAFT: 'Draft', ACTIVE: 'Active', SCHEDULED: 'Scheduled', ARCHIVED: 'Archived' };
const STATUS_BADGE: Record<Status, string> = { DRAFT: 'DRAFT', ACTIVE: 'SENT', SCHEDULED: 'SCHEDULED', ARCHIVED: 'DRAFT' };

const api = useApi();
const data = ref<ListPayload | null>(null);
const showArchived = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref<string | null>(null);

const current = ref<Full | null>(null);
const creating = ref(false);
const form = reactive({ name: '', audience: 'FREE' as Audience, source: '' });
const fieldErrors = ref<Record<string, string>>({});
const schedule = reactive({ startsAt: '', endsAt: '' });
const confirming = ref<null | { kind: 'activate' | 'archive' | 'revert'; audience?: Audience }>(null);

const previewData = ref<'recent' | 'worst'>('recent');
const width = ref<PreviewWidth>(PREVIEW_WIDTHS[0]);

const templates = computed(() => (data.value?.templates ?? []).filter((t) => showArchived.value || t.status !== 'ARCHIVED'));
const editorOpen = computed(() => creating.value || current.value !== null);
const editable = computed(() => creating.value || current.value?.status === 'DRAFT');
const dirty = computed(() => (current.value ? form.source !== current.value.source || form.name !== current.value.name : creating.value));
const validation = computed<Validation | null>(() => {
  const v = current.value?.validation as Validation | undefined;
  return v && Array.isArray(v.checks) ? v : null;
});
const failing = computed(() => validation.value?.checks.filter((c) => !c.ok) ?? []);
const activateBlock = computed(() => {
  if (!current.value) return 'Save the draft first.';
  if (current.value.status !== 'DRAFT') return null;
  if (dirty.value) return 'Save your changes first; the checks run on the saved version.';
  if (!validation.value?.ok) return `${failing.value.length === 1 ? 'One check is' : `${failing.value.length} checks are`} failing.`;
  return null;
});
const previewSrc = computed(() =>
  current.value?.id ? `/api/digest/templates/${current.value.id}/preview?data=${previewData.value}&v=${encodeURIComponent(current.value.updatedAt)}` : null,
);
/** Fill of the size meter, as a share of the limit. */
const sizeShare = computed(() => {
  const v = validation.value;
  if (!v || v.budgetBytes === null) return null;
  return { used: Math.min(1, v.budgetBytes / v.maxBytes), warn: v.warnBytes / v.maxBytes, over: v.budgetBytes > v.maxBytes, near: v.budgetBytes >= v.warnBytes };
});

const dateIst = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
function inUseText(a: Audience): string {
  const u = data.value?.inUse[a];
  if (!u) return '—';
  if (u.source === 'builtin') return 'Built-in template';
  if (u.source === 'override') return `${u.name} (scheduled, until ${dateIst(u.endsAt)})`;
  return u.name;
}
function windowText(t: Summary): string {
  if (t.status !== 'SCHEDULED') return '—';
  const w = t.window === 'ended' ? ' · ended' : t.window === 'live' ? ' · in use now' : '';
  return `${dateIst(t.startsAt)} – ${dateIst(t.endsAt)}${w}`;
}
function checksText(t: Summary): string {
  if (t.validationOk) return 'All pass';
  return t.failed.length === 1 ? '1 failing' : `${t.failed.length} failing`;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    data.value = await api.get<ListPayload>('/api/digest/templates');
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

function startNew(audience: Audience = 'FREE') {
  current.value = null;
  creating.value = true;
  notice.value = null;
  fieldErrors.value = {};
  Object.assign(form, { name: '', audience, source: data.value?.builtin.source ?? '' });
  scrollToEditor();
}

async function open(id: string) {
  error.value = null;
  notice.value = null;
  try {
    const t = await api.get<Full>(`/api/digest/templates/${id}`);
    current.value = t;
    creating.value = false;
    fieldErrors.value = {};
    Object.assign(form, { name: t.name, audience: t.audience, source: t.source });
    scrollToEditor();
  } catch (e) {
    error.value = apiErrorMessage(e);
  }
}

function closeEditor() {
  current.value = null;
  creating.value = false;
}

function scrollToEditor() {
  requestAnimationFrame(() => document.getElementById('tpl-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function issuesToFields(e: unknown) {
  const issues = ((e as ApiError).body as { issues?: unknown } | undefined)?.issues as { message: string; path: string[] }[] | undefined;
  if (!issues) return false;
  fieldErrors.value = Object.fromEntries(issues.map((i) => [i.path[0] ?? 'form', i.message]));
  return true;
}

async function save() {
  busy.value = 'save';
  error.value = null;
  notice.value = null;
  fieldErrors.value = {};
  try {
    const t = creating.value
      ? await api.post<Full>('/api/digest/templates', { name: form.name, audience: form.audience, source: form.source })
      : await api.put<Full>(`/api/digest/templates/${current.value!.id}`, { name: form.name, source: form.source });
    current.value = t;
    creating.value = false;
    notice.value = t.validationOk ? 'Saved. Every check passes.' : 'Saved as a draft. Fix the failing checks before activating.';
    await load();
  } catch (e) {
    if (!issuesToFields(e)) error.value = apiErrorMessage(e);
  } finally {
    busy.value = null;
  }
}

async function copy(t: Summary | Full) {
  busy.value = 'copy';
  error.value = null;
  try {
    const c = await api.post<Full>('/api/digest/templates', { name: `${t.name} (copy)`.slice(0, 80), audience: t.audience, copyFrom: t.id });
    await load();
    await open(c.id);
    notice.value = 'Copied to a new draft.';
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = null;
  }
}

/** Shows a refusal; when it carries a fresh checklist, the panel shows that too. */
function refusal(e: unknown) {
  const body = (e as ApiError).body as { validation?: Validation } | undefined;
  if (body?.validation && current.value) current.value = { ...current.value, validation: body.validation };
  error.value = apiErrorMessage(e);
}

async function recheck() {
  if (!current.value) return;
  busy.value = 'check';
  try {
    const r = await api.post<{ validation: Validation }>(`/api/digest/templates/${current.value.id}/validate`, {});
    current.value = { ...current.value, validation: r.validation };
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = null;
  }
}

async function confirmAction() {
  const c = confirming.value;
  if (!c) return;
  busy.value = c.kind;
  error.value = null;
  notice.value = null;
  try {
    if (c.kind === 'activate' && current.value) {
      await api.post(`/api/digest/templates/${current.value.id}/activate`, { confirm: true });
      const msg = `“${current.value.name}” is now the ${AUDIENCE_LABEL[current.value.audience]} template. The next digest uses it.`;
      await open(current.value.id);
      notice.value = msg;
    } else if (c.kind === 'archive' && current.value) {
      await api.post(`/api/digest/templates/${current.value.id}/archive`, { confirm: true });
      notice.value = `“${current.value.name}” is archived.`;
      closeEditor();
    } else if (c.kind === 'revert' && c.audience) {
      await api.post(`/api/digest/templates/revert/${c.audience.toLowerCase()}`, { confirm: true });
      const msg = `The ${AUDIENCE_LABEL[c.audience]} digest is back on ${data.value?.revertTo[c.audience].name ?? 'the previous template'}.`;
      if (current.value) await open(current.value.id);
      notice.value = msg;
    }
    await load();
  } catch (e) {
    refusal(e);
  } finally {
    busy.value = null;
    confirming.value = null;
  }
}

async function scheduleIt() {
  if (!current.value) return;
  busy.value = 'schedule';
  error.value = null;
  notice.value = null;
  fieldErrors.value = {};
  try {
    await api.post(`/api/digest/templates/${current.value.id}/schedule`, {
      startsAt: schedule.startsAt ? new Date(`${schedule.startsAt}:00+05:30`).toISOString() : '',
      endsAt: schedule.endsAt ? new Date(`${schedule.endsAt}:00+05:30`).toISOString() : '',
    });
    const msg = `Scheduled. It replaces the ${AUDIENCE_LABEL[current.value.audience]} template from ${schedule.startsAt.replace('T', ' ')} to ${schedule.endsAt.replace('T', ' ')} IST, then the active one returns.`;
    await open(current.value.id);
    notice.value = msg;
    await load();
  } catch (e) {
    if (!issuesToFields(e)) refusal(e);
  } finally {
    busy.value = null;
  }
}

const confirmCopy = computed(() => {
  const c = confirming.value;
  if (!c) return null;
  if (c.kind === 'activate' && current.value) {
    const a = current.value.audience;
    return {
      heading: `Use this template for the ${AUDIENCE_LABEL[a]} digest?`,
      title: current.value.name,
      detail: `The next ${AUDIENCE_LABEL[a]} digest is built with it. It replaces ${inUseText(a)}, which you can bring back with Revert to previous.`,
      label: 'Activate',
    };
  }
  if (c.kind === 'archive' && current.value) {
    return { heading: 'Archive this template?', title: current.value.name, detail: 'It can’t be edited or activated again. Copy it first if you may want it back.', label: 'Archive' };
  }
  if (c.kind === 'revert' && c.audience) {
    const to = data.value?.revertTo[c.audience].name ?? 'the previous template';
    return {
      heading: `Revert the ${AUDIENCE_LABEL[c.audience]} digest?`,
      title: `Back to ${to}`,
      detail: `${inUseText(c.audience)} goes back to a draft, and the next ${AUDIENCE_LABEL[c.audience]} digest uses ${to}.`,
      label: 'Revert',
    };
  }
  return null;
});

onMounted(load);
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Digest templates</h1>
      <div class="toolbar-group">
        <button class="btn btn-primary" :disabled="creating" @click="startNew()">New template</button>
        <button class="btn" :disabled="loading" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
      </div>
    </div>

    <div v-if="error" class="banner err" role="alert">{{ error }}</div>
    <div v-if="notice" class="banner ok" role="status">{{ notice }}</div>

    <!-- What each audience's next digest uses -->
    <section v-if="data" class="card">
      <h2 class="card-h">In use now</h2>
      <div class="in-use">
        <div v-for="a in AUDIENCES" :key="a" class="in-use-row">
          <div class="in-use-who">{{ AUDIENCE_LABEL[a] }} digest</div>
          <div class="in-use-what">
            {{ inUseText(a) }}
            <span v-if="data.inUse[a].source === 'builtin'" class="muted"> — no template is active</span>
          </div>
          <button
            v-if="data.revertTo[a].available"
            class="btn btn-mini"
            :disabled="!!busy"
            @click="confirming = { kind: 'revert', audience: a }"
          >
            Revert to {{ data.revertTo[a].name }}
          </button>
        </div>
      </div>
    </section>

    <!-- List -->
    <section class="card">
      <div class="toolbar">
        <h2 style="margin: 0">Templates ({{ templates.length }})</h2>
        <label class="archived-toggle"><input v-model="showArchived" type="checkbox" /> Show archived</label>
      </div>
      <table class="stack">
        <thead>
          <tr>
            <th>Template</th>
            <th>Audience</th>
            <th>Status</th>
            <th>Scheduled for</th>
            <th>Checks</th>
            <th>Saved</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in templates" :key="t.id" :class="{ picked: current?.id === t.id }">
            <td class="cell-lead">
              {{ t.name }}<span v-if="t.format === 'MJML'" class="muted"> · MJML</span>
            </td>
            <td data-label="Audience">{{ AUDIENCE_LABEL[t.audience] }}</td>
            <td data-label="Status"><span class="badge" :class="STATUS_BADGE[t.status]">{{ STATUS_LABEL[t.status] }}</span></td>
            <td data-label="Scheduled for">{{ windowText(t) }}</td>
            <td data-label="Checks">
              <span :class="t.validationOk ? 'chk-ok' : 'chk-bad'">{{ t.validationOk ? '✓' : '✗' }} {{ checksText(t) }}</span>
            </td>
            <td data-label="Saved">{{ dateIst(t.updatedAt) }}</td>
            <td class="cell-actions">
              <div class="row-actions">
                <button class="btn btn-mini" @click="open(t.id)">{{ t.status === 'DRAFT' ? 'Edit' : 'Open' }}</button>
                <button class="btn btn-mini" :disabled="!!busy" @click="copy(t)">Copy</button>
              </div>
            </td>
          </tr>
          <tr v-if="templates.length === 0 && !loading">
            <td colspan="7" class="muted empty-row">
              No templates yet. Both digests use the built-in template until you activate one. Start with New template — it opens a copy of the
              built-in layout.
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Editor: source on the left, the checklist that gates activation on the right -->
    <section v-if="editorOpen" id="tpl-editor" class="card">
      <div class="toolbar">
        <h2 style="margin: 0">
          {{ creating ? 'New template' : current?.name }}
          <span v-if="current" class="badge" :class="STATUS_BADGE[current.status]">{{ STATUS_LABEL[current.status] }}</span>
        </h2>
        <button class="btn" @click="closeEditor">Close</button>
      </div>

      <div class="editor">
        <form class="editor-main" @submit.prevent="save">
          <div class="meta-row">
            <div class="f">
              <label for="tpl-name">Name</label>
              <input id="tpl-name" v-model="form.name" maxlength="80" :disabled="!editable" :aria-invalid="!!fieldErrors.name" placeholder="Budget week" />
              <p v-if="fieldErrors.name" class="f-err">{{ fieldErrors.name }}</p>
            </div>
            <div class="f">
              <label for="tpl-aud">Audience</label>
              <select id="tpl-aud" v-model="form.audience" :disabled="!creating">
                <option v-for="a in AUDIENCES" :key="a" :value="a">{{ AUDIENCE_LABEL[a] }}</option>
              </select>
            </div>
          </div>
          <div class="f">
            <label for="tpl-src">HTML</label>
            <textarea
              id="tpl-src"
              v-model="form.source"
              class="src"
              spellcheck="false"
              autocapitalize="off"
              autocomplete="off"
              :readonly="!editable"
              :aria-invalid="!!fieldErrors.source"
              rows="22"
            />
            <p v-if="fieldErrors.source" class="f-err">{{ fieldErrors.source }}</p>
            <p v-else-if="!editable" class="muted">Only a draft can be edited. Copy this template to change it.</p>
            <p v-else class="muted">Saving compiles the template and runs every check against the biggest possible digest.</p>
          </div>
          <details class="placeholders">
            <summary>Placeholders the digest fills</summary>
            <dl>
              <template v-for="p in data?.placeholders ?? []" :key="p.key">
                <dt><code v-text="`{{${p.key}}}`" /><span v-if="p.required" class="req">required</span></dt>
                <dd>{{ p.help }}</dd>
              </template>
            </dl>
          </details>
          <div v-if="editable" class="form-actions">
            <button type="submit" class="btn btn-primary" :disabled="busy === 'save' || !dirty">
              {{ busy === 'save' ? 'Saving…' : creating ? 'Save draft' : 'Save changes' }}
            </button>
            <span v-if="!creating && dirty" class="muted">Unsaved changes — the checks below are for the saved version.</span>
          </div>
        </form>

        <!-- THE checklist: what stands between this draft and the readers' inbox -->
        <aside class="checklist" :class="{ 'is-ok': validation?.ok, 'is-bad': validation && !validation.ok }" aria-label="Checks before activation">
          <template v-if="validation">
            <p class="verdict">
              <template v-if="validation.ok">{{ current?.status === 'DRAFT' || creating ? 'Ready to activate' : 'Every check passes' }}</template>
              <template v-else-if="current?.status !== 'DRAFT'">{{ failing.length === 1 ? 'One check fails' : `${failing.length} checks fail` }} now</template>
              <template v-else>Activation is blocked — {{ failing.length === 1 ? 'one check fails' : `${failing.length} checks fail` }}</template>
            </p>
            <ol class="checks">
              <li v-for="c in validation.checks" :key="c.id" :class="c.ok ? 'pass' : 'fail'">
                <span class="mark" aria-hidden="true">{{ c.ok ? '✓' : '✗' }}</span>
                <div class="check-body">
                  <span class="check-label">{{ c.label }}<span class="sr-only">: {{ c.ok ? 'passes' : 'fails' }}</span></span>
                  <div v-if="c.id === 'size' && sizeShare" class="meter" :class="{ near: sizeShare.near, over: sizeShare.over }" aria-hidden="true">
                    <span class="meter-fill" :style="{ width: `${Math.round(sizeShare.used * 100)}%` }" />
                    <span class="meter-warn" :style="{ left: `${Math.round(sizeShare.warn * 100)}%` }" />
                  </div>
                  <ul v-if="c.problems.length" class="problems">
                    <li v-for="(p, i) in c.problems" :key="i">{{ p }}</li>
                  </ul>
                  <p v-else-if="c.note" class="check-note">{{ c.note }}</p>
                </div>
              </li>
            </ol>
            <p class="muted checked-at">
              Checked {{ dateIst(validation.checkedAt) }} IST.
              <button v-if="current" type="button" class="link-btn" :disabled="!!busy" @click="recheck">Check again</button>
            </p>
          </template>
          <p v-else class="muted">Save the draft to run the checks.</p>

          <div v-if="current?.status === 'DRAFT'" class="gate">
            <button class="btn btn-primary btn-gate" :disabled="!!activateBlock || !!busy" @click="confirming = { kind: 'activate' }">
              Activate for {{ AUDIENCE_LABEL[current.audience] }}
            </button>
            <p v-if="activateBlock" class="muted">{{ activateBlock }}</p>

            <fieldset class="sched">
              <legend>Or use it for a few days only</legend>
              <div class="sched-row">
                <div class="f">
                  <label for="tpl-from">From (IST)</label>
                  <input id="tpl-from" v-model="schedule.startsAt" type="datetime-local" />
                </div>
                <div class="f">
                  <label for="tpl-to">Until (IST)</label>
                  <input id="tpl-to" v-model="schedule.endsAt" type="datetime-local" />
                </div>
              </div>
              <button class="btn" :disabled="!!activateBlock || !!busy || !schedule.startsAt || !schedule.endsAt" @click="scheduleIt">
                {{ busy === 'schedule' ? 'Scheduling…' : 'Schedule' }}
              </button>
            </fieldset>
          </div>
          <div v-if="current && (current.status === 'DRAFT' || current.status === 'SCHEDULED')" class="archive-row">
            <button class="btn btn-danger btn-mini" :disabled="!!busy" @click="confirming = { kind: 'archive' }">Archive</button>
          </div>
        </aside>
      </div>
    </section>

    <!-- Preview: the saved template filled with real stories, in a sandboxed frame -->
    <section v-if="current" class="card">
      <div class="toolbar preview-bar">
        <h2 style="margin: 0">Preview</h2>
        <div class="seg" role="group" aria-label="Stories">
          <button :class="{ on: previewData === 'recent' }" :aria-pressed="previewData === 'recent'" @click="previewData = 'recent'">Recent stories</button>
          <button :class="{ on: previewData === 'worst' }" :aria-pressed="previewData === 'worst'" @click="previewData = 'worst'">Biggest case</button>
        </div>
        <div class="seg" role="group" aria-label="Screen width">
          <button v-for="w in PREVIEW_WIDTHS" :key="w.key" :class="{ on: width.key === w.key }" :aria-pressed="width.key === w.key" @click="width = w">
            {{ w.label }} <span class="seg-px">{{ w.px }}</span>
          </button>
        </div>
      </div>
      <p class="muted size-line">
        The saved version, {{ AUDIENCE_LABEL[current.audience] }} digest, at {{ width.px }} px. Ads are today’s picks, or samples when a slot has none.
      </p>
      <EmailPreviewFrame :src="previewSrc" :width-px="width.px" :title="`${current.name} preview`" />
    </section>

    <ConfirmPush
      v-if="confirming && confirmCopy"
      :heading="confirmCopy.heading"
      :title="confirmCopy.title"
      :detail="confirmCopy.detail"
      :confirm-label="confirmCopy.label"
      :busy="!!busy"
      @confirm="confirmAction"
      @cancel="confirming = null"
    />
  </main>
</template>

<style scoped>
h2 .badge {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  vertical-align: middle;
  letter-spacing: 0.02em;
}
.card-h {
  margin: 0 0 10px;
}
.in-use {
  display: grid;
  gap: 8px;
}
.in-use-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  font-size: 14px;
}
.in-use-who {
  flex: 0 0 130px;
  font-weight: 600;
}
.in-use-what {
  flex: 1 1 auto;
  min-width: 0;
}
.archived-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-transform: none;
  letter-spacing: 0;
  font-size: 13px;
  margin: 0;
}
.archived-toggle input {
  width: auto;
}
.chk-ok {
  color: var(--ok);
  font-weight: 600;
}
.chk-bad {
  color: var(--danger);
  font-weight: 600;
}
tr.picked td {
  background: #f1f5f9;
}
.empty-row {
  text-align: center;
  padding: 24px !important;
}

/* Editor */
.editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 20px;
  align-items: start;
}
.editor-main {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.meta-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 14px;
}
.f {
  min-width: 0;
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
/* The source is code: a fixed-width face here only, at the 16 px field size (no iOS zoom). */
.src {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 16px;
  line-height: 1.45;
  min-height: 320px;
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
  tab-size: 2;
}
.placeholders summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
}
.placeholders dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 10px 0 0;
  font-size: 13px;
}
.placeholders dt {
  white-space: nowrap;
}
.placeholders dd {
  margin: 0;
  color: var(--muted);
}
.req {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--warn);
}
.form-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

/* The checklist — the gate in front of Activate */
.checklist {
  border: 1px solid var(--border);
  border-top: 4px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  background: #fbfcfe;
}
.checklist.is-ok {
  border-top-color: var(--ok);
}
.checklist.is-bad {
  border-top-color: var(--danger);
}
.verdict {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 700;
}
.is-ok .verdict {
  color: var(--ok);
}
.is-bad .verdict {
  color: var(--danger);
}
.checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.checks > li {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 6px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
}
.checks > li:last-child {
  border-bottom: 0;
}
.mark {
  font-weight: 700;
  text-align: center;
}
.pass .mark {
  color: var(--ok);
}
.fail .mark {
  color: var(--danger);
}
.fail .check-label {
  font-weight: 600;
}
.problems {
  margin: 4px 0 0;
  padding-left: 16px;
  color: var(--danger);
  font-size: 13px;
}
.problems li + li {
  margin-top: 2px;
}
.check-note {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
}
/* Size against the budget: the tick marks the warning threshold, the end is the limit. */
.meter {
  position: relative;
  height: 6px;
  margin: 6px 0 2px;
  border-radius: 3px;
  background: #e2e8f0;
  overflow: visible;
}
.meter-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
  background: var(--ok);
}
.meter.near .meter-fill {
  background: var(--warn);
}
.meter.over .meter-fill {
  background: var(--danger);
}
.meter-warn {
  position: absolute;
  top: -3px;
  width: 2px;
  height: 12px;
  background: var(--muted);
}
.checked-at {
  margin: 10px 0 0;
}
.link-btn {
  border: 0;
  background: none;
  padding: 0;
  color: var(--primary);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.gate {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  display: grid;
  gap: 8px;
}
.btn-gate {
  width: 100%;
  min-height: 44px;
}
.gate > .muted {
  margin: 0;
}
.sched {
  border: 0;
  padding: 0;
  margin: 8px 0 0;
  display: grid;
  gap: 8px;
}
.sched legend {
  font-size: 13px;
  font-weight: 600;
  padding: 0;
  margin-bottom: 4px;
}
.sched-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.archive-row {
  margin-top: 12px;
  text-align: right;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* Preview (the same controls as Digests) */
.preview-bar {
  justify-content: flex-start;
}
.preview-bar h2 {
  margin-right: auto !important;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.seg button {
  border: 0;
  background: var(--surface);
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.seg button.on {
  background: var(--primary);
  color: #fff;
  font-weight: 600;
}
.seg-px {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}
.size-line {
  margin: 6px 0 10px;
}

@media (max-width: 1024px) {
  .editor {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 720px) {
  .meta-row,
  .sched-row {
    grid-template-columns: 1fr;
  }
  .in-use-who {
    flex-basis: 100%;
  }
  .preview-bar .seg {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    width: 100%;
  }
  .seg button {
    padding: 10px 4px;
    min-height: 40px;
  }
  .form-actions .btn {
    flex: 1;
  }
}
</style>

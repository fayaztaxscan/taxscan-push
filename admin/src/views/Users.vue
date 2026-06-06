<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi } from '../composables/useApi';
import { useAuth } from '../composables/useAuth';
import type { ApiError } from '../composables/useApi';

type UserRow = {
  id: string;
  email: string;
  role: 'ADMIN' | 'PUBLISHER';
  isActive: boolean;
  passwordResetRequired: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

const api = useApi();
const { user: meUser } = useAuth();

// List state
const items = ref<UserRow[]>([]);
const total = ref(0);
const limit = ref(20);
const offset = ref(0);
const includeInactive = ref(false);
const loading = ref(false);
const listError = ref<string | null>(null);

// Generic copy-to-clipboard with a brief "Copied!" indicator.
const copyFlash = ref<Record<string, boolean>>({});
async function copyText(key: string, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copyFlash.value[key] = true;
    setTimeout(() => {
      copyFlash.value[key] = false;
    }, 1500);
  } catch {
    // Clipboard API requires a secure context; in dev over plain HTTP
    // the admin can still read the value off the page manually.
  }
}

function apiErrorMessage(e: unknown): string {
  const err = e as ApiError | undefined;
  const body = err?.body as { message?: string; error?: string } | undefined;
  return body?.message ?? body?.error ?? err?.message ?? 'Request failed';
}

function fmtDate(s: string | null): string {
  return s ? new Date(s).toLocaleString() : '—';
}

async function load(): Promise<void> {
  loading.value = true;
  listError.value = null;
  try {
    const qs = new URLSearchParams({
      limit: String(limit.value),
      offset: String(offset.value),
      includeInactive: String(includeInactive.value),
    });
    const data = await api.get<{ items: UserRow[]; total: number }>(
      `/api/users?${qs.toString()}`,
    );
    items.value = data.items;
    total.value = data.total;
  } catch (e) {
    listError.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

const pageStart = computed(() => (total.value === 0 ? 0 : offset.value + 1));
const pageEnd = computed(() => Math.min(offset.value + limit.value, total.value));
const canPrev = computed(() => offset.value > 0);
const canNext = computed(() => offset.value + limit.value < total.value);

function nextPage(): void {
  offset.value += limit.value;
  load();
}
function prevPage(): void {
  offset.value = Math.max(0, offset.value - limit.value);
  load();
}
function onIncludeInactiveChange(): void {
  offset.value = 0;
  load();
}

// ---- Create user modal ----
const createOpen = ref(false);
const createForm = ref({ email: '', role: 'PUBLISHER' as 'ADMIN' | 'PUBLISHER' });
const createSubmitting = ref(false);
const createError = ref<string | null>(null);
const createResult = ref<{ user: UserRow; temporaryPassword?: string } | null>(null);

function openCreate(): void {
  createForm.value = { email: '', role: 'PUBLISHER' };
  createResult.value = null;
  createError.value = null;
  createOpen.value = true;
}

async function submitCreate(): Promise<void> {
  createError.value = null;
  createSubmitting.value = true;
  try {
    const res = await api.post<{ user: UserRow; temporaryPassword?: string }>(
      '/api/users',
      { email: createForm.value.email.trim().toLowerCase(), role: createForm.value.role },
    );
    createResult.value = res;
  } catch (e) {
    createError.value = apiErrorMessage(e);
  } finally {
    createSubmitting.value = false;
  }
}

function closeCreate(): void {
  const wasSuccessful = !!createResult.value;
  createOpen.value = false;
  if (wasSuccessful) load();
}

// ---- Reset password modal ----
const resetOpen = ref(false);
const resetTarget = ref<UserRow | null>(null);
const resetSubmitting = ref(false);
const resetError = ref<string | null>(null);
const resetResult = ref<{ temporaryPassword: string } | null>(null);

function openReset(u: UserRow): void {
  resetTarget.value = u;
  resetResult.value = null;
  resetError.value = null;
  resetOpen.value = true;
}

async function submitReset(): Promise<void> {
  if (!resetTarget.value) return;
  resetError.value = null;
  resetSubmitting.value = true;
  try {
    const res = await api.post<{ temporaryPassword: string }>(
      `/api/users/${resetTarget.value.id}/reset-password`,
      {},
    );
    resetResult.value = res;
  } catch (e) {
    resetError.value = apiErrorMessage(e);
  } finally {
    resetSubmitting.value = false;
  }
}

function closeReset(): void {
  resetOpen.value = false;
  resetTarget.value = null;
  resetResult.value = null;
  load();
}

// ---- Confirm modal (toggle isActive + change role) ----
type ConfirmAction =
  | { kind: 'deactivate'; user: UserRow }
  | { kind: 'activate'; user: UserRow }
  | { kind: 'role'; user: UserRow; newRole: 'ADMIN' | 'PUBLISHER' };

const confirm = ref<ConfirmAction | null>(null);
const confirmSubmitting = ref(false);
const confirmError = ref<string | null>(null);

function askDeactivate(u: UserRow): void {
  confirm.value = { kind: 'deactivate', user: u };
  confirmError.value = null;
}
function askActivate(u: UserRow): void {
  confirm.value = { kind: 'activate', user: u };
  confirmError.value = null;
}
function askChangeRole(u: UserRow): void {
  confirm.value = { kind: 'role', user: u, newRole: u.role === 'ADMIN' ? 'PUBLISHER' : 'ADMIN' };
  confirmError.value = null;
}

const confirmTitle = computed(() => {
  if (!confirm.value) return '';
  if (confirm.value.kind === 'deactivate') return `Deactivate ${confirm.value.user.email}?`;
  if (confirm.value.kind === 'activate') return `Reactivate ${confirm.value.user.email}?`;
  return `Change ${confirm.value.user.email} to ${confirm.value.newRole}?`;
});
const confirmDescription = computed(() => {
  if (!confirm.value) return '';
  if (confirm.value.kind === 'deactivate') {
    return 'Their active sessions will be revoked immediately. They will not be able to sign in until reactivated.';
  }
  if (confirm.value.kind === 'activate') {
    return 'They will be able to sign in again.';
  }
  return confirm.value.newRole === 'ADMIN'
    ? 'They will gain full admin permissions.'
    : 'They will lose admin permissions and become a regular publisher.';
});

async function submitConfirm(): Promise<void> {
  if (!confirm.value) return;
  confirmError.value = null;
  confirmSubmitting.value = true;
  try {
    const body: Record<string, unknown> = {};
    if (confirm.value.kind === 'deactivate') body.isActive = false;
    if (confirm.value.kind === 'activate') body.isActive = true;
    if (confirm.value.kind === 'role') body.role = confirm.value.newRole;
    await api.patch(`/api/users/${confirm.value.user.id}`, body);
    confirm.value = null;
    load();
  } catch (e) {
    confirmError.value = apiErrorMessage(e);
  } finally {
    confirmSubmitting.value = false;
  }
}

function cancelConfirm(): void {
  confirm.value = null;
}

onMounted(load);
</script>

<template>
  <main class="page">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Users</h1>
      <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 13px">
        <input
          v-model="includeInactive"
          type="checkbox"
          style="width: auto"
          @change="onIncludeInactiveChange"
        />
        Show deactivated
      </label>
      <button class="btn" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
      <button class="btn btn-primary" @click="openCreate">Create user</button>
    </div>

    <div v-if="listError" class="banner err">{{ listError }}</div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Last login</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in items" :key="u.id">
            <td>
              {{ u.email }}
              <span v-if="u.id === meUser?.id" class="muted" style="font-size: 11px"
                >· you</span
              >
            </td>
            <td>
              <span class="role-badge" :class="u.role.toLowerCase()">{{ u.role }}</span>
            </td>
            <td>
              <span v-if="u.isActive" class="status-pill active">Active</span>
              <span v-else class="status-pill inactive">Deactivated</span>
              <span
                v-if="u.passwordResetRequired"
                class="muted"
                style="font-size: 11px; margin-left: 6px"
                >· must change pw</span
              >
            </td>
            <td class="muted">{{ fmtDate(u.lastLoginAt) }}</td>
            <td class="muted">{{ fmtDate(u.createdAt) }}</td>
            <td class="row-actions">
              <button class="btn btn-mini" @click="openReset(u)">Reset password</button>
              <button class="btn btn-mini" @click="askChangeRole(u)">
                Make {{ u.role === 'ADMIN' ? 'PUBLISHER' : 'ADMIN' }}
              </button>
              <button
                v-if="u.isActive"
                class="btn btn-mini btn-danger"
                @click="askDeactivate(u)"
              >
                Deactivate
              </button>
              <button v-else class="btn btn-mini" @click="askActivate(u)">Reactivate</button>
            </td>
          </tr>
          <tr v-if="items.length === 0 && !loading">
            <td colspan="6" class="muted" style="text-align: center; padding: 24px">
              No users to show.
            </td>
          </tr>
        </tbody>
      </table>

      <div class="pagination">
        <span class="muted" style="font-size: 12px"
          >Showing {{ pageStart }}–{{ pageEnd }} of {{ total }}</span
        >
        <span class="spacer" />
        <button class="btn btn-mini" :disabled="!canPrev" @click="prevPage">Prev</button>
        <button class="btn btn-mini" :disabled="!canNext" @click="nextPage">Next</button>
      </div>
    </div>

    <!-- Create user modal -->
    <Teleport to="body">
      <div v-if="createOpen" class="modal-overlay" @click.self="closeCreate">
        <div class="modal-card" role="dialog" aria-labelledby="create-title">
          <h2 id="create-title">Create user</h2>

          <template v-if="!createResult">
            <p class="muted">
              The server will generate a temporary password. The new user will be asked to
              change it on first login.
            </p>
            <div class="form-row">
              <label for="cu-email">Email</label>
              <input
                id="cu-email"
                v-model="createForm.email"
                type="email"
                autocomplete="off"
                required
                autofocus
              />
            </div>
            <div class="form-row">
              <label>Role</label>
              <div class="radio-row">
                <label
                  ><input v-model="createForm.role" type="radio" value="PUBLISHER" />
                  Publisher</label
                >
                <label
                  ><input v-model="createForm.role" type="radio" value="ADMIN" /> Admin</label
                >
              </div>
            </div>
            <div v-if="createError" class="banner err">{{ createError }}</div>
            <div class="modal-actions">
              <button type="button" class="btn" @click="closeCreate">Cancel</button>
              <button
                type="button"
                class="btn btn-primary"
                :disabled="createSubmitting || !createForm.email"
                @click="submitCreate"
              >
                {{ createSubmitting ? 'Creating…' : 'Create' }}
              </button>
            </div>
          </template>

          <template v-else>
            <div class="banner ok">
              Account created.
              <strong>Share this temporary password with {{ createResult.user.email }}</strong>
              through your usual channel — they'll be asked to change it on first login.
            </div>
            <div class="temp-pw" data-testid="temp-password">
              <code>{{ createResult.temporaryPassword }}</code>
              <button
                type="button"
                class="btn btn-mini"
                @click="copyText('create', createResult.temporaryPassword ?? '')"
              >
                {{ copyFlash['create'] ? 'Copied!' : 'Copy' }}
              </button>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn btn-primary" @click="closeCreate">Done</button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>

    <!-- Reset password modal -->
    <Teleport to="body">
      <div v-if="resetOpen" class="modal-overlay" @click.self="closeReset">
        <div class="modal-card" role="dialog" aria-labelledby="reset-title">
          <h2 id="reset-title">Reset password</h2>

          <template v-if="!resetResult">
            <p>
              Reset the password for <strong>{{ resetTarget?.email }}</strong>?
            </p>
            <p class="muted" style="font-size: 12px">
              All of their active sessions will be revoked immediately. They will need to sign in
              with the new temporary password and change it on first login.
            </p>
            <div v-if="resetError" class="banner err">{{ resetError }}</div>
            <div class="modal-actions">
              <button type="button" class="btn" @click="closeReset">Cancel</button>
              <button
                type="button"
                class="btn btn-primary"
                :disabled="resetSubmitting"
                @click="submitReset"
              >
                {{ resetSubmitting ? 'Resetting…' : 'Reset password' }}
              </button>
            </div>
          </template>

          <template v-else>
            <div class="banner ok">
              Password reset.
              <strong>Share this temporary password with {{ resetTarget?.email }}</strong>
              through your usual channel.
            </div>
            <div class="temp-pw" data-testid="temp-password">
              <code>{{ resetResult.temporaryPassword }}</code>
              <button
                type="button"
                class="btn btn-mini"
                @click="copyText('reset', resetResult.temporaryPassword)"
              >
                {{ copyFlash['reset'] ? 'Copied!' : 'Copy' }}
              </button>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn btn-primary" @click="closeReset">Done</button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>

    <!-- Confirm (deactivate / activate / change role) modal -->
    <Teleport to="body">
      <div v-if="confirm" class="modal-overlay" @click.self="cancelConfirm">
        <div class="modal-card" role="dialog" aria-labelledby="confirm-title">
          <h2 id="confirm-title">{{ confirmTitle }}</h2>
          <p class="muted">{{ confirmDescription }}</p>
          <div v-if="confirmError" class="banner err">{{ confirmError }}</div>
          <div class="modal-actions">
            <button type="button" class="btn" @click="cancelConfirm">Cancel</button>
            <button
              type="button"
              class="btn"
              :class="
                confirm?.kind === 'deactivate' || confirm?.kind === 'role'
                  ? 'btn-primary'
                  : 'btn-primary'
              "
              :disabled="confirmSubmitting"
              @click="submitConfirm"
            >
              {{
                confirmSubmitting
                  ? 'Working…'
                  : confirm?.kind === 'deactivate'
                  ? 'Deactivate'
                  : confirm?.kind === 'activate'
                  ? 'Reactivate'
                  : 'Change role'
              }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </main>
</template>

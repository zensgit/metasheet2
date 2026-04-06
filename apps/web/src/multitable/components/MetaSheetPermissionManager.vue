<template>
  <div v-if="visible" class="meta-sheet-perm__overlay" @click.self="requestClose">
    <div class="meta-sheet-perm">
      <div class="meta-sheet-perm__header">
        <div>
          <h4 class="meta-sheet-perm__title">Manage Access</h4>
          <p class="meta-sheet-perm__subtitle">Grant sheet-level read, write, or write-own access.</p>
        </div>
        <button class="meta-sheet-perm__close" type="button" @click="requestClose">&times;</button>
      </div>

      <div class="meta-sheet-perm__body">
        <div v-if="error" class="meta-sheet-perm__error" role="alert">{{ error }}</div>
        <div v-else-if="status" class="meta-sheet-perm__status" role="status">{{ status }}</div>

        <section class="meta-sheet-perm__section">
          <div class="meta-sheet-perm__section-header">
            <strong>Current access</strong>
          </div>
          <div v-if="loading" class="meta-sheet-perm__empty">Loading access list…</div>
          <div v-else-if="!entries.length" class="meta-sheet-perm__empty">No sheet-specific access grants yet.</div>
          <div
            v-for="entry in entries"
            :key="entry.userId"
            class="meta-sheet-perm__row"
            :data-sheet-permission-entry="entry.userId"
          >
            <div class="meta-sheet-perm__identity">
              <strong>{{ entry.name || entry.email || entry.userId }}</strong>
              <span>{{ entry.email || entry.userId }}</span>
            </div>
            <span class="meta-sheet-perm__badge" :data-access-level="entry.accessLevel">{{ accessLevelLabel(entry.accessLevel) }}</span>
            <select
              :value="entryDrafts[entry.userId] ?? entry.accessLevel"
              class="meta-sheet-perm__select"
              :disabled="busyUserId === entry.userId"
              @change="setEntryDraft(entry.userId, $event)"
            >
              <option v-for="option in ACCESS_LEVEL_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <button
              class="meta-sheet-perm__action"
              type="button"
              :disabled="busyUserId === entry.userId || (entryDrafts[entry.userId] ?? entry.accessLevel) === entry.accessLevel"
              @click="applyEntry(entry.userId)"
            >
              Save
            </button>
            <button
              class="meta-sheet-perm__action meta-sheet-perm__action--danger"
              type="button"
              :disabled="busyUserId === entry.userId"
              @click="removeEntry(entry.userId)"
            >
              Remove
            </button>
          </div>
        </section>

        <section class="meta-sheet-perm__section">
          <div class="meta-sheet-perm__section-header">
            <strong>Add people</strong>
          </div>
          <input
            v-model="search"
            class="meta-sheet-perm__search"
            type="search"
            placeholder="Search users by name or email"
            data-sheet-permission-search="true"
          />
          <div v-if="candidatesLoading" class="meta-sheet-perm__empty">Searching users…</div>
          <div v-else-if="!availableCandidates.length" class="meta-sheet-perm__empty">No matching users.</div>
          <div
            v-for="candidate in availableCandidates"
            :key="candidate.id"
            class="meta-sheet-perm__row"
            :data-sheet-permission-candidate="candidate.id"
          >
            <div class="meta-sheet-perm__identity">
              <strong>{{ candidate.label }}</strong>
              <span>{{ candidate.subtitle || candidate.id }}</span>
            </div>
            <select
              :value="candidateDrafts[candidate.id] ?? candidate.accessLevel ?? 'read'"
              class="meta-sheet-perm__select"
              :disabled="busyUserId === candidate.id"
              @change="setCandidateDraft(candidate.id, $event)"
            >
              <option v-for="option in ACCESS_LEVEL_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <button
              class="meta-sheet-perm__action meta-sheet-perm__action--primary"
              type="button"
              :disabled="busyUserId === candidate.id"
              @click="grantCandidate(candidate.id)"
            >
              Grant
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { MultitableApiClient } from '../api/client'
import type {
  MetaSheetPermissionAccessLevel,
  MetaSheetPermissionCandidate,
  MetaSheetPermissionEntry,
} from '../types'

const ACCESS_LEVEL_OPTIONS: Array<{ value: MetaSheetPermissionAccessLevel; label: string }> = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Write' },
  { value: 'write-own', label: 'Write own' },
]

const props = defineProps<{
  visible: boolean
  sheetId: string
  client: MultitableApiClient
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updated'): void
}>()

const entries = ref<MetaSheetPermissionEntry[]>([])
const candidates = ref<MetaSheetPermissionCandidate[]>([])
const loading = ref(false)
const candidatesLoading = ref(false)
const busyUserId = ref<string | null>(null)
const status = ref('')
const error = ref('')
const search = ref('')
const entryDrafts = ref<Record<string, MetaSheetPermissionAccessLevel>>({})
const candidateDrafts = ref<Record<string, MetaSheetPermissionAccessLevel>>({})
let searchTimer: number | null = null

const availableCandidates = computed(() => {
  const activeUserIds = new Set(entries.value.map((entry) => entry.userId))
  return candidates.value.filter((candidate) => !activeUserIds.has(candidate.id))
})

function accessLevelLabel(accessLevel: MetaSheetPermissionAccessLevel) {
  return ACCESS_LEVEL_OPTIONS.find((option) => option.value === accessLevel)?.label ?? accessLevel
}

function requestClose() {
  emit('close')
}

function clearMessages() {
  status.value = ''
  error.value = ''
}

function syncEntryDrafts(nextEntries: MetaSheetPermissionEntry[]) {
  entryDrafts.value = Object.fromEntries(nextEntries.map((entry) => [entry.userId, entry.accessLevel]))
}

function syncCandidateDrafts(nextCandidates: MetaSheetPermissionCandidate[]) {
  const nextDrafts: Record<string, MetaSheetPermissionAccessLevel> = { ...candidateDrafts.value }
  for (const candidate of nextCandidates) {
    nextDrafts[candidate.id] = candidate.accessLevel ?? nextDrafts[candidate.id] ?? 'read'
  }
  candidateDrafts.value = nextDrafts
}

async function loadEntries() {
  if (!props.sheetId) {
    entries.value = []
    syncEntryDrafts([])
    return
  }
  loading.value = true
  try {
    const response = await props.client.listSheetPermissions(props.sheetId)
    entries.value = response.items
    syncEntryDrafts(response.items)
  } catch (cause: any) {
    error.value = cause?.message ?? 'Failed to load sheet access'
  } finally {
    loading.value = false
  }
}

async function loadCandidates(query?: string) {
  if (!props.sheetId) {
    candidates.value = []
    syncCandidateDrafts([])
    return
  }
  candidatesLoading.value = true
  try {
    const response = await props.client.listSheetPermissionCandidates(props.sheetId, {
      q: query?.trim() || undefined,
      limit: 12,
    })
    candidates.value = response.items
    syncCandidateDrafts(response.items)
  } catch (cause: any) {
    error.value = cause?.message ?? 'Failed to load permission candidates'
  } finally {
    candidatesLoading.value = false
  }
}

async function refreshAll(query?: string) {
  clearMessages()
  await Promise.all([
    loadEntries(),
    loadCandidates(query ?? search.value),
  ])
}

function scheduleCandidateRefresh() {
  if (searchTimer != null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    void loadCandidates(search.value)
  }, 180)
}

function setEntryDraft(userId: string, event: Event) {
  entryDrafts.value = {
    ...entryDrafts.value,
    [userId]: (event.target as HTMLSelectElement).value as MetaSheetPermissionAccessLevel,
  }
}

function setCandidateDraft(userId: string, event: Event) {
  candidateDrafts.value = {
    ...candidateDrafts.value,
    [userId]: (event.target as HTMLSelectElement).value as MetaSheetPermissionAccessLevel,
  }
}

async function updateUserAccess(userId: string, accessLevel: MetaSheetPermissionAccessLevel | 'none', successMessage: string) {
  busyUserId.value = userId
  clearMessages()
  try {
    await props.client.updateSheetPermission(props.sheetId, userId, accessLevel)
    await refreshAll()
    status.value = successMessage
    emit('updated')
  } catch (cause: any) {
    error.value = cause?.message ?? 'Failed to update sheet access'
  } finally {
    busyUserId.value = null
  }
}

async function applyEntry(userId: string) {
  const nextAccessLevel = entryDrafts.value[userId]
  if (!nextAccessLevel) return
  await updateUserAccess(userId, nextAccessLevel, 'Sheet access updated')
}

async function removeEntry(userId: string) {
  await updateUserAccess(userId, 'none', 'Sheet access removed')
}

async function grantCandidate(userId: string) {
  await updateUserAccess(userId, candidateDrafts.value[userId] ?? 'read', 'Sheet access granted')
}

watch(
  () => [props.visible, props.sheetId] as const,
  ([visible, sheetId]) => {
    if (!visible || !sheetId) return
    void refreshAll()
  },
  { immediate: true },
)

watch(search, () => {
  if (!props.visible) return
  scheduleCandidateRefresh()
})

onBeforeUnmount(() => {
  if (searchTimer != null) {
    window.clearTimeout(searchTimer)
    searchTimer = null
  }
})
</script>

<style scoped>
.meta-sheet-perm__overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.26);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  z-index: 50;
  padding: 48px 16px;
}

.meta-sheet-perm {
  width: min(760px, 100%);
  max-height: calc(100vh - 96px);
  overflow: auto;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.18);
  border: 1px solid #dbe4f0;
}

.meta-sheet-perm__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid #eef2f7;
}

.meta-sheet-perm__title {
  margin: 0;
  font-size: 18px;
  color: #0f172a;
}

.meta-sheet-perm__subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: #64748b;
}

.meta-sheet-perm__close {
  border: 0;
  background: transparent;
  font-size: 24px;
  line-height: 1;
  color: #64748b;
  cursor: pointer;
}

.meta-sheet-perm__body {
  padding: 18px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.meta-sheet-perm__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.meta-sheet-perm__section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #0f172a;
}

.meta-sheet-perm__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 100px 120px auto auto;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
}

.meta-sheet-perm__identity {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.meta-sheet-perm__identity strong {
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta-sheet-perm__identity span {
  color: #64748b;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta-sheet-perm__badge {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  padding: 4px 8px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #334155;
  font-size: 12px;
  font-weight: 600;
}

.meta-sheet-perm__badge[data-access-level='write'] {
  background: #dcfce7;
  color: #166534;
}

.meta-sheet-perm__badge[data-access-level='write-own'] {
  background: #fef3c7;
  color: #92400e;
}

.meta-sheet-perm__select,
.meta-sheet-perm__search {
  width: 100%;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
}

.meta-sheet-perm__search {
  margin-bottom: 2px;
}

.meta-sheet-perm__action {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 12px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}

.meta-sheet-perm__action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.meta-sheet-perm__action--primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}

.meta-sheet-perm__action--danger {
  border-color: #ef4444;
  color: #b91c1c;
}

.meta-sheet-perm__status,
.meta-sheet-perm__error,
.meta-sheet-perm__empty {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
}

.meta-sheet-perm__status {
  background: #ecfdf5;
  color: #166534;
}

.meta-sheet-perm__error {
  background: #fef2f2;
  color: #b91c1c;
}

.meta-sheet-perm__empty {
  background: #f8fafc;
  color: #64748b;
}

@media (max-width: 720px) {
  .meta-sheet-perm__row {
    grid-template-columns: 1fr;
  }
}
</style>

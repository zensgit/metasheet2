<template>
  <div v-if="visible" class="meta-sheet-perm__overlay" @click.self="requestClose">
    <div class="meta-sheet-perm">
      <div class="meta-sheet-perm__header">
        <div>
          <h4 class="meta-sheet-perm__title">Manage Access</h4>
          <p class="meta-sheet-perm__subtitle">Override sheet-level access for eligible people or roles. Write-own remains user-only.</p>
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
            :key="subjectKey(entry.subjectType, entry.subjectId)"
            class="meta-sheet-perm__row"
            :data-sheet-permission-entry="subjectKey(entry.subjectType, entry.subjectId)"
          >
            <div class="meta-sheet-perm__identity">
              <strong>{{ entry.label }}</strong>
              <span>{{ entry.subtitle || entry.subjectId }}</span>
            </div>
            <span class="meta-sheet-perm__subject" :data-subject-type="entry.subjectType">{{ entry.subjectType === 'role' ? 'Role' : 'Person' }}</span>
            <span class="meta-sheet-perm__badge" :data-access-level="entry.accessLevel">{{ accessLevelLabel(entry.accessLevel) }}</span>
            <select
              :value="entryDrafts[subjectKey(entry.subjectType, entry.subjectId)] ?? entry.accessLevel"
              class="meta-sheet-perm__select"
              :disabled="busySubjectKey === subjectKey(entry.subjectType, entry.subjectId)"
              @change="setEntryDraft(entry.subjectType, entry.subjectId, $event)"
            >
              <option
                v-for="option in accessLevelOptionsFor(entry.subjectType)"
                :key="`${entry.subjectType}:${option.value}`"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <button
              class="meta-sheet-perm__action"
              type="button"
              :disabled="busySubjectKey === subjectKey(entry.subjectType, entry.subjectId) || (entryDrafts[subjectKey(entry.subjectType, entry.subjectId)] ?? entry.accessLevel) === entry.accessLevel"
              @click="applyEntry(entry.subjectType, entry.subjectId)"
            >
              Save
            </button>
            <button
              class="meta-sheet-perm__action meta-sheet-perm__action--danger"
              type="button"
              :disabled="busySubjectKey === subjectKey(entry.subjectType, entry.subjectId)"
              @click="removeEntry(entry.subjectType, entry.subjectId)"
            >
              Remove
            </button>
          </div>
        </section>

        <section class="meta-sheet-perm__section">
          <div class="meta-sheet-perm__section-header">
            <strong>Eligible people or roles</strong>
          </div>
          <input
            v-model="search"
            class="meta-sheet-perm__search"
            type="search"
            placeholder="Search people or roles"
            data-sheet-permission-search="true"
          />
          <div v-if="candidatesLoading" class="meta-sheet-perm__empty">Searching eligible people and roles…</div>
          <div v-else-if="!availableCandidates.length" class="meta-sheet-perm__empty">No matching eligible people or roles.</div>
          <template v-else>
            <div class="meta-sheet-perm__section-header">
              <strong>People</strong>
            </div>
            <div v-if="!peopleCandidates.length" class="meta-sheet-perm__empty">No matching people.</div>
            <div
              v-for="candidate in peopleCandidates"
              :key="subjectKey(candidate.subjectType, candidate.subjectId)"
              class="meta-sheet-perm__row"
              :data-sheet-permission-candidate="subjectKey(candidate.subjectType, candidate.subjectId)"
            >
              <div class="meta-sheet-perm__identity">
                <strong>{{ candidate.label }}</strong>
                <span>{{ candidate.subtitle || candidate.subjectId }}</span>
              </div>
              <span class="meta-sheet-perm__subject" data-subject-type="user">Person</span>
              <select
                :value="candidateDrafts[subjectKey(candidate.subjectType, candidate.subjectId)] ?? candidate.accessLevel ?? 'read'"
                class="meta-sheet-perm__select"
                :disabled="busySubjectKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @change="setCandidateDraft(candidate.subjectType, candidate.subjectId, $event)"
              >
                <option
                  v-for="option in accessLevelOptionsFor(candidate.subjectType)"
                  :key="`${candidate.subjectType}:${option.value}`"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <button
                class="meta-sheet-perm__action meta-sheet-perm__action--primary"
                type="button"
                :disabled="busySubjectKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @click="grantCandidate(candidate.subjectType, candidate.subjectId)"
              >
                Apply
              </button>
            </div>

            <div class="meta-sheet-perm__section-header">
              <strong>Roles</strong>
            </div>
            <div v-if="!roleCandidates.length" class="meta-sheet-perm__empty">No matching roles.</div>
            <div
              v-for="candidate in roleCandidates"
              :key="subjectKey(candidate.subjectType, candidate.subjectId)"
              class="meta-sheet-perm__row"
              :data-sheet-permission-candidate="subjectKey(candidate.subjectType, candidate.subjectId)"
            >
              <div class="meta-sheet-perm__identity">
                <strong>{{ candidate.label }}</strong>
                <span>{{ candidate.subtitle || candidate.subjectId }}</span>
              </div>
              <span class="meta-sheet-perm__subject" data-subject-type="role">Role</span>
              <select
                :value="candidateDrafts[subjectKey(candidate.subjectType, candidate.subjectId)] ?? candidate.accessLevel ?? 'read'"
                class="meta-sheet-perm__select"
                :disabled="busySubjectKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @change="setCandidateDraft(candidate.subjectType, candidate.subjectId, $event)"
              >
                <option
                  v-for="option in accessLevelOptionsFor(candidate.subjectType)"
                  :key="`${candidate.subjectType}:${option.value}`"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <button
                class="meta-sheet-perm__action meta-sheet-perm__action--primary"
                type="button"
                :disabled="busySubjectKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @click="grantCandidate(candidate.subjectType, candidate.subjectId)"
              >
                Apply
              </button>
            </div>
          </template>
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
  MetaSheetPermissionSubjectType,
} from '../types'

const ACCESS_LEVEL_OPTIONS: Array<{ value: MetaSheetPermissionAccessLevel; label: string }> = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Write' },
  { value: 'write-own', label: 'Write own' },
]
const ROLE_ACCESS_LEVEL_OPTIONS = ACCESS_LEVEL_OPTIONS.filter((option) => option.value !== 'write-own')

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
const busySubjectKey = ref<string | null>(null)
const status = ref('')
const error = ref('')
const search = ref('')
const entryDrafts = ref<Record<string, MetaSheetPermissionAccessLevel>>({})
const candidateDrafts = ref<Record<string, MetaSheetPermissionAccessLevel>>({})
let searchTimer: number | null = null

function subjectKey(subjectType: MetaSheetPermissionSubjectType, subjectId: string) {
  return `${subjectType}:${subjectId}`
}

const availableCandidates = computed(() => {
  const activeSubjectKeys = new Set(entries.value.map((entry) => subjectKey(entry.subjectType, entry.subjectId)))
  return candidates.value.filter((candidate) => !activeSubjectKeys.has(subjectKey(candidate.subjectType, candidate.subjectId)))
})

const peopleCandidates = computed(() => availableCandidates.value.filter((candidate) => candidate.subjectType === 'user'))
const roleCandidates = computed(() => availableCandidates.value.filter((candidate) => candidate.subjectType === 'role'))

function accessLevelLabel(accessLevel: MetaSheetPermissionAccessLevel) {
  return ACCESS_LEVEL_OPTIONS.find((option) => option.value === accessLevel)?.label ?? accessLevel
}

function accessLevelOptionsFor(subjectType: MetaSheetPermissionSubjectType) {
  return subjectType === 'role' ? ROLE_ACCESS_LEVEL_OPTIONS : ACCESS_LEVEL_OPTIONS
}

function requestClose() {
  emit('close')
}

function clearMessages() {
  status.value = ''
  error.value = ''
}

function syncEntryDrafts(nextEntries: MetaSheetPermissionEntry[]) {
  entryDrafts.value = Object.fromEntries(nextEntries.map((entry) => [subjectKey(entry.subjectType, entry.subjectId), entry.accessLevel]))
}

function syncCandidateDrafts(nextCandidates: MetaSheetPermissionCandidate[]) {
  const nextDrafts: Record<string, MetaSheetPermissionAccessLevel> = { ...candidateDrafts.value }
  for (const candidate of nextCandidates) {
    const key = subjectKey(candidate.subjectType, candidate.subjectId)
    const fallback = candidate.subjectType === 'role' ? 'read' : 'read'
    nextDrafts[key] = candidate.accessLevel ?? nextDrafts[key] ?? fallback
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

function setEntryDraft(subjectType: MetaSheetPermissionSubjectType, subjectId: string, event: Event) {
  entryDrafts.value = {
    ...entryDrafts.value,
    [subjectKey(subjectType, subjectId)]: (event.target as HTMLSelectElement).value as MetaSheetPermissionAccessLevel,
  }
}

function setCandidateDraft(subjectType: MetaSheetPermissionSubjectType, subjectId: string, event: Event) {
  candidateDrafts.value = {
    ...candidateDrafts.value,
    [subjectKey(subjectType, subjectId)]: (event.target as HTMLSelectElement).value as MetaSheetPermissionAccessLevel,
  }
}

async function updateSubjectAccess(
  subjectType: MetaSheetPermissionSubjectType,
  subjectId: string,
  accessLevel: MetaSheetPermissionAccessLevel | 'none',
  successMessage: string,
) {
  const key = subjectKey(subjectType, subjectId)
  busySubjectKey.value = key
  clearMessages()
  try {
    await props.client.updateSheetPermission(props.sheetId, subjectType, subjectId, accessLevel)
    await refreshAll()
    status.value = successMessage
    emit('updated')
  } catch (cause: any) {
    error.value = cause?.message ?? 'Failed to update sheet access'
  } finally {
    busySubjectKey.value = null
  }
}

async function applyEntry(subjectType: MetaSheetPermissionSubjectType, subjectId: string) {
  const nextAccessLevel = entryDrafts.value[subjectKey(subjectType, subjectId)]
  if (!nextAccessLevel) return
  await updateSubjectAccess(subjectType, subjectId, nextAccessLevel, 'Sheet access override updated')
}

async function removeEntry(subjectType: MetaSheetPermissionSubjectType, subjectId: string) {
  await updateSubjectAccess(subjectType, subjectId, 'none', 'Sheet access override removed')
}

async function grantCandidate(subjectType: MetaSheetPermissionSubjectType, subjectId: string) {
  const key = subjectKey(subjectType, subjectId)
  await updateSubjectAccess(subjectType, subjectId, candidateDrafts.value[key] ?? 'read', 'Sheet access override saved')
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
  grid-template-columns: minmax(0, 1fr) 88px 100px 120px auto auto;
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

.meta-sheet-perm__subject {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  padding: 4px 8px;
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 600;
}

.meta-sheet-perm__subject[data-subject-type='role'] {
  background: #ede9fe;
  color: #6d28d9;
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

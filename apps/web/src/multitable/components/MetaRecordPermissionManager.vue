<template>
  <div v-if="visible" class="meta-record-perm__overlay" @click.self="requestClose">
    <div class="meta-record-perm">
      <div class="meta-record-perm__header">
        <div>
          <h4 class="meta-record-perm__title">Record Permissions</h4>
          <p class="meta-record-perm__subtitle">Manage who can access this record and at what level.</p>
        </div>
        <button class="meta-record-perm__close" type="button" @click="requestClose">&times;</button>
      </div>

      <div class="meta-record-perm__body">
        <div v-if="error" class="meta-record-perm__error" role="alert">{{ error }}</div>
        <div v-if="status" class="meta-record-perm__status" role="status">{{ status }}</div>

        <!-- Current permissions -->
        <section class="meta-record-perm__section">
          <div class="meta-record-perm__section-header">
            <strong>Current access</strong>
          </div>
          <div v-if="loading" class="meta-record-perm__empty">Loading permissions&#x2026;</div>
        <div v-else-if="!entries.length" class="meta-record-perm__empty">No record-specific permissions yet.</div>
          <template v-else>
          <div
            v-for="entry in entries"
            :key="entry.id"
            class="meta-record-perm__row"
            :data-record-permission-entry="entry.id"
            >
              <div class="meta-record-perm__identity">
                <strong>{{ entry.label }}</strong>
                <span>{{ entry.subtitle || entry.subjectId }}</span>
                <span
                  v-if="subjectIsInactive(entry.subjectType, entry.isActive)"
                  class="meta-record-perm__lifecycle"
                  data-lifecycle="inactive"
                >
                  Inactive user
                </span>
                <span
                  v-if="subjectMutationBlocked(entry.subjectType, entry.isActive)"
                  class="meta-record-perm__hint"
                >
                  Cleanup only
                </span>
              </div>
            <span class="meta-record-perm__subject" :data-subject-type="entry.subjectType">{{ subjectTypeLabel(entry.subjectType) }}</span>
            <span class="meta-record-perm__badge" :data-access-level="entryDrafts[entry.id] ?? entry.accessLevel">
              {{ accessLevelLabel(entryDrafts[entry.id] ?? entry.accessLevel) }}
            </span>
            <select
              :value="entryDrafts[entry.id] ?? entry.accessLevel"
              class="meta-record-perm__select"
              :disabled="busyKey === entry.id || subjectMutationBlocked(entry.subjectType, entry.isActive)"
              @change="setEntryDraft(entry.id, $event)"
            >
              <option value="read">Read</option>
              <option value="write">Write</option>
              <option value="admin">Admin</option>
            </select>
            <button
              class="meta-record-perm__action"
              type="button"
              :disabled="busyKey === entry.id || subjectMutationBlocked(entry.subjectType, entry.isActive) || (entryDrafts[entry.id] ?? entry.accessLevel) === entry.accessLevel"
              @click="saveEntry(entry)"
            >
              Save
            </button>
            <button
              class="meta-record-perm__action meta-record-perm__action--danger"
              type="button"
              :disabled="busyKey === entry.id"
              @click="removeEntry(entry)"
            >
              Remove
            </button>
          </div>
          </template>
        </section>

        <!-- Add permission -->
        <section class="meta-record-perm__section">
          <div class="meta-record-perm__section-header">
            <strong>Grant to people, member groups, or roles</strong>
          </div>
          <input
            v-model="candidateSearch"
            class="meta-record-perm__search"
            type="search"
            placeholder="Search people, member groups, or roles"
            data-record-permission-search="true"
          />
          <div v-if="candidatesLoading" class="meta-record-perm__empty">Loading eligible people, member groups, and roles&#x2026;</div>
          <div v-else-if="!availableCandidates.length" class="meta-record-perm__empty">No matching eligible people, member groups, or roles.</div>
          <template v-else>
            <div class="meta-record-perm__section-header">
              <strong>People</strong>
            </div>
            <div v-if="!peopleCandidates.length" class="meta-record-perm__empty">No matching people.</div>
            <div
              v-for="candidate in peopleCandidates"
              :key="`people-${subjectKey(candidate.subjectType, candidate.subjectId)}`"
              class="meta-record-perm__row"
              :data-record-permission-candidate="subjectKey(candidate.subjectType, candidate.subjectId)"
            >
              <div class="meta-record-perm__identity">
                <strong>{{ candidate.label }}</strong>
                <span>{{ candidate.subtitle || candidate.subjectId }}</span>
                <span
                  v-if="subjectIsInactive(candidate.subjectType, candidate.isActive)"
                  class="meta-record-perm__lifecycle"
                  data-lifecycle="inactive"
                >
                  Inactive user
                </span>
              </div>
              <span class="meta-record-perm__subject" data-subject-type="user">User</span>
              <select
                :value="candidateDrafts[subjectKey(candidate.subjectType, candidate.subjectId)] ?? candidate.accessLevel ?? 'read'"
                class="meta-record-perm__select"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId) || candidateGrantBlocked(candidate)"
                @change="setCandidateDraft(candidate.subjectType, candidate.subjectId, $event)"
              >
                <option value="read">Read</option>
                <option value="write">Write</option>
                <option value="admin">Admin</option>
              </select>
              <button
                class="meta-record-perm__action meta-record-perm__action--primary"
                type="button"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId) || candidateGrantBlocked(candidate)"
                @click="grantCandidate(candidate.subjectType, candidate.subjectId)"
              >
                Grant
              </button>
            </div>

            <div class="meta-record-perm__section-header">
              <strong>Member groups</strong>
            </div>
            <div v-if="!memberGroupCandidates.length" class="meta-record-perm__empty">No matching member groups.</div>
            <div
              v-for="candidate in memberGroupCandidates"
              :key="`member-group-${subjectKey(candidate.subjectType, candidate.subjectId)}`"
              class="meta-record-perm__row"
              :data-record-permission-candidate="subjectKey(candidate.subjectType, candidate.subjectId)"
            >
              <div class="meta-record-perm__identity">
                <strong>{{ candidate.label }}</strong>
                <span>{{ candidate.subtitle || candidate.subjectId }}</span>
              </div>
              <span class="meta-record-perm__subject" data-subject-type="member-group">Member group</span>
              <select
                :value="candidateDrafts[subjectKey(candidate.subjectType, candidate.subjectId)] ?? candidate.accessLevel ?? 'read'"
                class="meta-record-perm__select"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @change="setCandidateDraft(candidate.subjectType, candidate.subjectId, $event)"
              >
                <option value="read">Read</option>
                <option value="write">Write</option>
                <option value="admin">Admin</option>
              </select>
              <button
                class="meta-record-perm__action meta-record-perm__action--primary"
                type="button"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @click="grantCandidate(candidate.subjectType, candidate.subjectId)"
              >
                Grant
              </button>
            </div>

            <div class="meta-record-perm__section-header">
              <strong>Roles</strong>
            </div>
            <div v-if="!roleCandidates.length" class="meta-record-perm__empty">No matching roles.</div>
            <div
              v-for="candidate in roleCandidates"
              :key="`role-${subjectKey(candidate.subjectType, candidate.subjectId)}`"
              class="meta-record-perm__row"
              :data-record-permission-candidate="subjectKey(candidate.subjectType, candidate.subjectId)"
            >
              <div class="meta-record-perm__identity">
                <strong>{{ candidate.label }}</strong>
                <span>{{ candidate.subtitle || candidate.subjectId }}</span>
              </div>
              <span class="meta-record-perm__subject" data-subject-type="role">Role</span>
              <select
                :value="candidateDrafts[subjectKey(candidate.subjectType, candidate.subjectId)] ?? candidate.accessLevel ?? 'read'"
                class="meta-record-perm__select"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @change="setCandidateDraft(candidate.subjectType, candidate.subjectId, $event)"
              >
                <option value="read">Read</option>
                <option value="write">Write</option>
                <option value="admin">Admin</option>
              </select>
              <button
                class="meta-record-perm__action meta-record-perm__action--primary"
                type="button"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @click="grantCandidate(candidate.subjectType, candidate.subjectId)"
              >
                Grant
              </button>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MultitableApiClient } from '../api/client'
import type { MetaSheetPermissionCandidate, MetaSheetPermissionEntry, RecordPermissionAccessLevel, RecordPermissionEntry } from '../types'

const props = defineProps<{
  visible: boolean
  sheetId: string
  recordId: string
  client: MultitableApiClient
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updated'): void
}>()

const entries = ref<RecordPermissionEntry[]>([])
const loading = ref(false)
const error = ref('')
const busyKey = ref<string | null>(null)
const status = ref('')
const entryDrafts = ref<Record<string, RecordPermissionAccessLevel>>({})
const candidateSearch = ref('')
const candidatesLoading = ref(false)
const subjectCandidates = ref<MetaSheetPermissionCandidate[]>([])
const candidateDrafts = ref<Record<string, RecordPermissionAccessLevel>>({})
let candidateLoadVersion = 0

function accessLevelLabel(level: string): string {
  if (level === 'read') return 'Read'
  if (level === 'write') return 'Write'
  if (level === 'admin') return 'Admin'
  return level
}

function subjectTypeLabel(subjectType: string): string {
  if (subjectType === 'role') return 'Role'
  if (subjectType === 'member-group') return 'Member group'
  return 'User'
}

function subjectIsInactive(subjectType: string, isActive: boolean) {
  return subjectType === 'user' && isActive === false
}

function subjectMutationBlocked(subjectType: string, isActive: boolean) {
  return subjectIsInactive(subjectType, isActive)
}

function candidateGrantBlocked(candidate: MetaSheetPermissionCandidate) {
  return subjectMutationBlocked(candidate.subjectType, candidate.isActive)
}

function requestClose() {
  emit('close')
}

function subjectKey(subjectType: string, subjectId: string) {
  return `${subjectType}:${subjectId}`
}

function clearMessages() {
  status.value = ''
  error.value = ''
}

function setEntryDraft(entryId: string, event: Event) {
  entryDrafts.value = {
    ...entryDrafts.value,
    [entryId]: (event.target as HTMLSelectElement).value as RecordPermissionAccessLevel,
  }
}

function syncEntryDrafts() {
  entryDrafts.value = Object.fromEntries(
    entries.value.map((entry) => [entry.id, entry.accessLevel]),
  )
}

function matchesCandidateSearch(candidate: MetaSheetPermissionCandidate, query: string): boolean {
  if (!query) return true
  const haystack = `${candidate.label} ${candidate.subtitle ?? ''} ${candidate.subjectId}`.toLowerCase()
  return haystack.includes(query)
}

function normalizeSheetEntryCandidate(entry: MetaSheetPermissionEntry): MetaSheetPermissionCandidate {
  return {
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    label: entry.label,
    subtitle: entry.subtitle ?? null,
    isActive: entry.isActive,
    accessLevel: entry.accessLevel,
  }
}

const availableCandidates = computed(() => {
  const activeSubjects = new Set(entries.value.map((entry) => subjectKey(entry.subjectType, entry.subjectId)))
  return subjectCandidates.value.filter((candidate) => !activeSubjects.has(subjectKey(candidate.subjectType, candidate.subjectId)))
})

const peopleCandidates = computed(() => availableCandidates.value.filter((candidate) => candidate.subjectType === 'user'))
const memberGroupCandidates = computed(() => availableCandidates.value.filter((candidate) => candidate.subjectType === 'member-group'))
const roleCandidates = computed(() => availableCandidates.value.filter((candidate) => candidate.subjectType === 'role'))

function syncCandidateDrafts() {
  const next: Record<string, RecordPermissionAccessLevel> = {}
  for (const candidate of availableCandidates.value) {
    const key = subjectKey(candidate.subjectType, candidate.subjectId)
    next[key] = candidateDrafts.value[key] ?? candidate.accessLevel ?? 'read'
  }
  candidateDrafts.value = next
}

async function loadPermissions() {
  if (!props.sheetId || !props.recordId) {
    entries.value = []
    return
  }
  loading.value = true
  clearMessages()
  try {
    entries.value = await props.client.listRecordPermissions(props.sheetId, props.recordId)
    syncEntryDrafts()
  } catch (cause: any) {
    error.value = cause?.message ?? 'Failed to load record permissions'
  } finally {
    loading.value = false
  }
}

async function loadCandidates() {
  if (!props.sheetId) {
    subjectCandidates.value = []
    return
  }
  const currentVersion = ++candidateLoadVersion
  candidatesLoading.value = true
  try {
    const query = candidateSearch.value.trim().toLowerCase()
    const [sheetEntries, candidatePage] = await Promise.all([
      props.client.listSheetPermissions(props.sheetId),
      props.client.listSheetPermissionCandidates(props.sheetId, { q: candidateSearch.value.trim() || undefined, limit: 20 }),
    ])
    if (currentVersion !== candidateLoadVersion) return

    const combined = new Map<string, MetaSheetPermissionCandidate>()
    for (const entry of sheetEntries.items.map((item) => normalizeSheetEntryCandidate(item))) {
      if (!matchesCandidateSearch(entry, query)) continue
      combined.set(subjectKey(entry.subjectType, entry.subjectId), entry)
    }
    for (const candidate of candidatePage.items) {
      const key = subjectKey(candidate.subjectType, candidate.subjectId)
      if (!matchesCandidateSearch(candidate, query) || combined.has(key)) continue
      combined.set(key, candidate)
    }
    subjectCandidates.value = Array.from(combined.values())
    syncCandidateDrafts()
  } catch (cause: any) {
    if (currentVersion !== candidateLoadVersion) return
    error.value = cause?.message ?? 'Failed to load permission candidates'
  } finally {
    if (currentVersion === candidateLoadVersion) {
      candidatesLoading.value = false
    }
  }
}

async function saveEntry(entry: RecordPermissionEntry) {
  const nextLevel = entryDrafts.value[entry.id] ?? entry.accessLevel
  busyKey.value = entry.id
  clearMessages()
  try {
    await props.client.updateRecordPermission(props.sheetId, props.recordId, entry.subjectType, entry.subjectId, nextLevel)
    await loadPermissions()
    status.value = 'Permission updated'
    emit('updated')
  } catch (cause: any) {
    error.value = cause?.message ?? 'Failed to update permission'
  } finally {
    busyKey.value = null
  }
}

async function removeEntry(entry: RecordPermissionEntry) {
  busyKey.value = entry.id
  clearMessages()
  try {
    await props.client.deleteRecordPermission(props.sheetId, props.recordId, entry.id)
    entries.value = entries.value.filter((e) => e.id !== entry.id)
    status.value = 'Permission removed'
    emit('updated')
  } catch (cause: any) {
    error.value = cause?.message ?? 'Failed to remove permission'
  } finally {
    busyKey.value = null
  }
}

function setCandidateDraft(subjectType: string, subjectId: string, event: Event) {
  const key = subjectKey(subjectType, subjectId)
  candidateDrafts.value = {
    ...candidateDrafts.value,
    [key]: (event.target as HTMLSelectElement).value as RecordPermissionAccessLevel,
  }
}

async function grantCandidate(subjectType: RecordPermissionEntry['subjectType'], subjectId: string) {
  const key = subjectKey(subjectType, subjectId)
  busyKey.value = key
  clearMessages()
  try {
    await props.client.updateRecordPermission(
      props.sheetId,
      props.recordId,
      subjectType,
      subjectId,
      candidateDrafts.value[key] ?? 'read',
    )
    await Promise.all([loadPermissions(), loadCandidates()])
    status.value = 'Permission granted'
    emit('updated')
  } catch (cause: any) {
    error.value = cause?.message ?? 'Failed to grant permission'
  } finally {
    busyKey.value = null
  }
}

watch(
  () => [props.visible, props.sheetId, props.recordId] as const,
  ([visible, sheetId, recordId]) => {
    if (!visible || !sheetId || !recordId) return
    void loadPermissions()
    void loadCandidates()
  },
  { immediate: true },
)

watch(
  () => candidateSearch.value,
  () => {
    if (!props.visible || !props.sheetId) return
    void loadCandidates()
  },
)
</script>

<style scoped>
.meta-record-perm__overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.26);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  z-index: 50;
  padding: 48px 16px;
}

.meta-record-perm {
  width: min(640px, 100%);
  max-height: calc(100vh - 96px);
  overflow: auto;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.18);
  border: 1px solid #dbe4f0;
}

.meta-record-perm__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid #eef2f7;
}

.meta-record-perm__title {
  margin: 0;
  font-size: 18px;
  color: #0f172a;
}

.meta-record-perm__subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: #64748b;
}

.meta-record-perm__close {
  border: 0;
  background: transparent;
  font-size: 24px;
  line-height: 1;
  color: #64748b;
  cursor: pointer;
}

.meta-record-perm__body {
  padding: 18px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.meta-record-perm__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.meta-record-perm__section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #0f172a;
  gap: 12px;
}

.meta-record-perm__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 80px 120px auto auto;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
}

.meta-record-perm__identity {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.meta-record-perm__identity strong {
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta-record-perm__identity span {
  color: #64748b;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta-record-perm__lifecycle {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 11px;
  font-weight: 600;
}

.meta-record-perm__hint {
  color: #64748b;
  font-size: 12px;
  font-weight: 500;
}

.meta-record-perm__subject {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  padding: 4px 8px;
  border-radius: 999px;
  background: #eef2ff;
  color: #3730a3;
  font-size: 12px;
  font-weight: 600;
}

.meta-record-perm__subject[data-subject-type='member-group'] {
  background: #ecfeff;
  color: #155e75;
}

.meta-record-perm__subject[data-subject-type='role'] {
  background: #f5f3ff;
  color: #6d28d9;
}

.meta-record-perm__badge {
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

.meta-record-perm__badge[data-access-level='write'] {
  background: #dcfce7;
  color: #166534;
}

.meta-record-perm__badge[data-access-level='admin'] {
  background: #dbeafe;
  color: #1d4ed8;
}

.meta-record-perm__badge[data-access-level='read'] {
  background: #e2e8f0;
  color: #334155;
}

.meta-record-perm__select,
.meta-record-perm__search {
  width: 100%;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
}

.meta-record-perm__action {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 12px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}

.meta-record-perm__action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.meta-record-perm__action--primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}

.meta-record-perm__action--danger {
  border-color: #ef4444;
  color: #b91c1c;
}

.meta-record-perm__status,
.meta-record-perm__error,
.meta-record-perm__empty {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
}

.meta-record-perm__status {
  background: #ecfdf5;
  color: #166534;
}

.meta-record-perm__error {
  background: #fef2f2;
  color: #b91c1c;
}

.meta-record-perm__empty {
  background: #f8fafc;
  color: #64748b;
}

@media (max-width: 640px) {
  .meta-record-perm__row {
    grid-template-columns: 1fr;
  }
}
</style>

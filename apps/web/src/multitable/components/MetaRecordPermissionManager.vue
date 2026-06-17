<template>
  <div v-if="visible" class="meta-record-perm__overlay" @click.self="requestClose">
    <div class="meta-record-perm">
      <div class="meta-record-perm__header">
        <div>
          <h4 class="meta-record-perm__title">{{ p('record.title') }}</h4>
          <p class="meta-record-perm__subtitle">{{ p('record.subtitle') }}</p>
          <p class="meta-record-perm__hint">{{ p('rowDeny.noneHint') }}</p>
        </div>
        <button class="meta-record-perm__close" type="button" @click="requestClose">&times;</button>
      </div>

      <div class="meta-record-perm__body">
        <div v-if="error" class="meta-record-perm__error" role="alert">{{ error }}</div>
        <div v-if="status" class="meta-record-perm__status" role="status">{{ status }}</div>

        <!-- Current permissions -->
        <section class="meta-record-perm__section">
          <div class="meta-record-perm__section-header">
            <strong>{{ p('record.currentAccess') }}</strong>
          </div>
          <div v-if="loading" class="meta-record-perm__empty">{{ p('record.loadingPermissions') }}</div>
        <div v-else-if="!entries.length" class="meta-record-perm__empty">{{ p('record.empty') }}</div>
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
                  {{ p('subject.inactiveUser') }}
                </span>
                <span
                  v-if="subjectMutationBlocked(entry.subjectType, entry.isActive)"
                  class="meta-record-perm__hint"
                >
                  {{ p('subject.cleanupOnly') }}
                </span>
              </div>
            <span class="meta-record-perm__subject" :data-subject-type="entry.subjectType">{{ recordSubjectLabel(entry.subjectType) }}</span>
            <span class="meta-record-perm__badge" :data-access-level="entryDrafts[entry.id] ?? entry.accessLevel">
              {{ recordAccessLabel(entryDrafts[entry.id] ?? entry.accessLevel) }}
            </span>
            <select
              :value="entryDrafts[entry.id] ?? entry.accessLevel"
              class="meta-record-perm__select"
              :disabled="busyKey === entry.id || subjectMutationBlocked(entry.subjectType, entry.isActive)"
              @change="setEntryDraft(entry.id, $event)"
            >
              <option
                v-for="option in recordAccessOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <button
              class="meta-record-perm__action"
              type="button"
              :disabled="busyKey === entry.id || subjectMutationBlocked(entry.subjectType, entry.isActive) || (entryDrafts[entry.id] ?? entry.accessLevel) === entry.accessLevel"
              @click="saveEntry(entry)"
            >
              {{ m('action.save') }}
            </button>
            <button
              class="meta-record-perm__action meta-record-perm__action--danger"
              type="button"
              :disabled="busyKey === entry.id"
              @click="removeEntry(entry)"
            >
              {{ m('action.remove') }}
            </button>
          </div>
          </template>
        </section>

        <!-- Add permission -->
        <section class="meta-record-perm__section">
          <div class="meta-record-perm__section-header">
            <strong>{{ p('record.grantSection') }}</strong>
          </div>
          <input
            v-model="candidateSearch"
            class="meta-record-perm__search"
            type="search"
            :placeholder="p('record.searchPlaceholder')"
            data-record-permission-search="true"
          />
          <div v-if="candidatesLoading" class="meta-record-perm__empty">{{ p('record.loadingCandidates') }}</div>
          <div v-else-if="!availableCandidates.length" class="meta-record-perm__empty">{{ p('record.noCandidates') }}</div>
          <template v-else>
            <div class="meta-record-perm__section-header">
              <strong>{{ p('subject.people') }}</strong>
            </div>
            <div v-if="!peopleCandidates.length" class="meta-record-perm__empty">{{ p('subject.noPeople') }}</div>
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
                  {{ p('subject.inactiveUser') }}
                </span>
                <span
                  v-if="candidateGrantBlocked(candidate)"
                  class="meta-record-perm__hint"
                >
                  {{ p('subject.grantBlocked') }}
                </span>
              </div>
              <span class="meta-record-perm__subject" data-subject-type="user">{{ p('subject.user') }}</span>
              <select
                :value="candidateDrafts[subjectKey(candidate.subjectType, candidate.subjectId)] ?? candidate.accessLevel ?? 'read'"
                class="meta-record-perm__select"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId) || candidateGrantBlocked(candidate)"
                @change="setCandidateDraft(candidate.subjectType, candidate.subjectId, $event)"
              >
                <option
                  v-for="option in recordAccessOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <button
                class="meta-record-perm__action meta-record-perm__action--primary"
                type="button"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId) || candidateGrantBlocked(candidate)"
                @click="grantCandidate(candidate.subjectType, candidate.subjectId)"
              >
                {{ p('action.grant') }}
              </button>
            </div>

            <div class="meta-record-perm__section-header">
              <strong>{{ p('subject.memberGroups') }}</strong>
            </div>
            <div v-if="!memberGroupCandidates.length" class="meta-record-perm__empty">{{ p('subject.noMemberGroups') }}</div>
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
              <span class="meta-record-perm__subject" data-subject-type="member-group">{{ p('subject.memberGroup') }}</span>
              <select
                :value="candidateDrafts[subjectKey(candidate.subjectType, candidate.subjectId)] ?? candidate.accessLevel ?? 'read'"
                class="meta-record-perm__select"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @change="setCandidateDraft(candidate.subjectType, candidate.subjectId, $event)"
              >
                <option
                  v-for="option in recordAccessOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <button
                class="meta-record-perm__action meta-record-perm__action--primary"
                type="button"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @click="grantCandidate(candidate.subjectType, candidate.subjectId)"
              >
                {{ p('action.grant') }}
              </button>
            </div>

            <div class="meta-record-perm__section-header">
              <strong>{{ p('subject.roles') }}</strong>
            </div>
            <div v-if="!roleCandidates.length" class="meta-record-perm__empty">{{ p('subject.noRoles') }}</div>
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
              <span class="meta-record-perm__subject" data-subject-type="role">{{ p('subject.role') }}</span>
              <select
                :value="candidateDrafts[subjectKey(candidate.subjectType, candidate.subjectId)] ?? candidate.accessLevel ?? 'read'"
                class="meta-record-perm__select"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @change="setCandidateDraft(candidate.subjectType, candidate.subjectId, $event)"
              >
                <option
                  v-for="option in recordAccessOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <button
                class="meta-record-perm__action meta-record-perm__action--primary"
                type="button"
                :disabled="busyKey === subjectKey(candidate.subjectType, candidate.subjectId)"
                @click="grantCandidate(candidate.subjectType, candidate.subjectId)"
              >
                {{ p('action.grant') }}
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
import { useLocale } from '../../composables/useLocale'
import type { MultitableApiClient } from '../api/client'
import type { MetaSheetPermissionCandidate, MetaSheetPermissionEntry, RecordPermissionAccessLevel, RecordPermissionEntry } from '../types'
import { managerLabel, type MetaManagerLabelKey } from '../utils/meta-manager-labels'
import { permissionLabel, recordAccessText, subjectText, type MetaPermissionLabelKey } from '../utils/meta-permission-labels'

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

const { isZh } = useLocale()
const recordAccessLevels: RecordPermissionAccessLevel[] = ['read', 'write', 'admin', 'none']
const recordAccessOptions = computed(() =>
  recordAccessLevels.map((value) => ({
    value,
    label: recordAccessText(value, isZh.value),
  })),
)

function p(key: MetaPermissionLabelKey): string {
  return permissionLabel(key, isZh.value)
}

function m(key: MetaManagerLabelKey): string {
  return managerLabel(key, isZh.value)
}

function recordAccessLabel(level: string): string {
  return recordAccessText(level, isZh.value)
}

function recordSubjectLabel(subjectType: string): string {
  return subjectText(subjectType, isZh.value)
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
    error.value = cause?.message ?? p('record.error.loadPermissions')
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
    error.value = cause?.message ?? p('record.error.loadCandidates')
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
    status.value = p('record.status.updated')
    emit('updated')
  } catch (cause: any) {
    error.value = cause?.message ?? p('record.error.update')
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
    status.value = p('record.status.removed')
    emit('updated')
  } catch (cause: any) {
    error.value = cause?.message ?? p('record.error.remove')
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
    status.value = p('record.status.granted')
    emit('updated')
  } catch (cause: any) {
    error.value = cause?.message ?? p('record.error.grant')
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

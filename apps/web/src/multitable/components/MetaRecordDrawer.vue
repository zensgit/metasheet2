<template>
  <div v-if="visible" class="meta-record-drawer">
    <div class="meta-record-drawer__header">
      <h3 class="meta-record-drawer__title">{{ l('record.title') }}</h3>
      <div class="meta-record-drawer__nav" v-if="recordIds.length > 1">
        <button class="meta-record-drawer__nav-btn" :disabled="currentRecordIndex <= 0" :aria-label="l('record.previous')" @click="navigatePrev">&lsaquo;</button>
        <span class="meta-record-drawer__nav-pos">{{ currentRecordIndex + 1 }} / {{ recordIds.length }}</span>
        <button class="meta-record-drawer__nav-btn" :disabled="currentRecordIndex >= recordIds.length - 1" :aria-label="l('record.next')" @click="navigateNext">&rsaquo;</button>
      </div>
      <div class="meta-record-drawer__actions">
        <MtButton
          v-if="record && canLoadSubscription"
          class="meta-record-drawer__btn meta-record-drawer__btn--watch"
          :class="{ 'meta-record-drawer__btn--watching': recordSubscribed }"
          :disabled="subscriptionLoading"
          :title="l(recordSubscribed ? 'record.unwatchTitle' : 'record.watchTitle')"
          :aria-pressed="recordSubscribed"
          @click="toggleRecordSubscription"
        >
          {{ l(recordSubscribed ? 'record.watching' : 'record.watch') }}
        </MtButton>
        <button
          v-if="resolvedCanComment"
          class="meta-record-drawer__btn meta-record-drawer__btn--comment"
          :class="drawerCommentButtonClass"
          :title="l('record.comments')"
          type="button"
          @click="emit('toggle-comments')"
        >
          <MetaCommentActionChip :label="l('record.comments')" :state="drawerCommentAffordance" />
        </button>
        <MtButton v-if="canManageAutomation" class="meta-record-drawer__btn" :title="l('record.workflowTitle')" @click="emit('open-automation')">&#x2699; {{ l('record.workflow') }}</MtButton>
        <MtButton v-if="canManageRecordPermissions" class="meta-record-drawer__btn" :title="l('record.permissionsTitle')" @click="showRecordPermissions = true">&#x1F512; {{ l('record.permissions') }}</MtButton>
        <MtButton v-if="record && canCreate" class="meta-record-drawer__btn meta-record-drawer__btn--duplicate" :title="l('record.duplicateTitle')" @click="emit('duplicate')">{{ l('record.duplicate') }}</MtButton>
        <!-- gate P2: the retained `meta-record-drawer__btn` base rule (background:#fff, later-injected,
             specificity tie) beat `.mt-button--danger`'s red background while danger's white text stayed
             → white-on-white "Delete". The danger variant must own the cascade, so the base class is
             dropped HERE ONLY; `--danger` stays as a stable spec/test anchor (its bespoke rule is gone). -->
        <MtButton v-if="resolvedCanDelete" variant="danger" class="meta-record-drawer__btn--danger" @click="emit('delete')">{{ l('record.delete') }}</MtButton>
        <button class="meta-record-drawer__close" :aria-label="l('record.close')" @click="emit('close')">&times;</button>
      </div>
    </div>
    <div v-if="record" class="meta-record-drawer__body">
      <div class="meta-record-drawer__tabs" role="tablist" :aria-label="l('record.tabsAria')">
        <button
          class="meta-record-drawer__tab"
          :class="{ 'meta-record-drawer__tab--active': activeTab === 'details' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'details'"
          @click="activeTab = 'details'"
        >{{ l('record.details') }}</button>
        <button
          class="meta-record-drawer__tab"
          :class="{ 'meta-record-drawer__tab--active': activeTab === 'history' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'history'"
          @click="activeTab = 'history'"
        >{{ l('record.history') }}</button>
      </div>
      <div v-if="subscriptionError" class="meta-record-drawer__watch-error">{{ subscriptionError }}</div>
      <div v-if="record?.locked" class="meta-record-drawer__lock-banner" data-test="record-lock-banner">
        <span class="meta-record-drawer__lock-icon" aria-hidden="true">&#x1F512;</span>
        <span class="meta-record-drawer__lock-status">{{ l('record.locked') }}</span>
        <span v-if="record.lockedBy" class="meta-record-drawer__lock-meta">{{ l('record.lockedBy') }}: {{ record.lockedBy }}</span>
        <span v-if="record.lockedAt" class="meta-record-drawer__lock-meta">{{ l('record.lockedAt') }}: {{ record.lockedAt }}</span>
        <MtButton
          v-if="record.canUnlock"
          class="meta-record-drawer__btn meta-record-drawer__lock-unlock"
          data-test="record-unlock-action"
          @click="emit('toggle-lock', { recordId: record.id, locked: false })"
        >{{ l('record.unlock') }}</MtButton>
      </div>
      <MetaRecordFieldsPanel
        v-if="activeTab === 'details'"
        :record="record"
        :fields="fields"
        :can-edit="canEdit"
        :can-comment="canComment"
        :field-permissions="fieldPermissions"
        :row-actions="rowActions"
        :comment-presence="commentPresence"
        :link-summaries-by-field="linkSummariesByField"
        :person-summaries-by-field="personSummariesByField"
        :attachment-summaries-by-field="attachmentSummariesByField"
        :upload-fn="uploadFn"
        :delete-attachment-fn="deleteAttachmentFn"
        :ai-shortcut="aiShortcut"
        :button-run-pending="buttonRunPending"
        :mention-suggestions="mentionSuggestions"
        @patch="(fieldId, value) => emit('patch', fieldId, value)"
        @ai-preview="(field) => emit('ai-preview', field)"
        @ai-run="(field) => emit('ai-run', field)"
        @comment-field="(field) => emit('comment-field', field)"
        @open-link-picker="(field) => emit('open-link-picker', field)"
        @open-person-picker="(field) => emit('open-person-picker', field)"
        @run-button="(payload) => emit('run-button', payload)"
      />
      <div v-else class="meta-record-drawer__history">
        <div v-if="historyLoading" class="meta-record-drawer__history-state">{{ l('record.historyLoading') }}</div>
        <div v-else-if="historyError" class="meta-record-drawer__history-state meta-record-drawer__history-state--error">{{ historyError }}</div>
        <div v-else-if="!canLoadHistory" class="meta-record-drawer__history-state">{{ l('record.historyUnavailable') }}</div>
        <div v-else-if="historyItems.length === 0" class="meta-record-drawer__history-state">{{ l('record.historyEmpty') }}</div>
        <ol v-else class="meta-record-drawer__history-list">
          <li v-for="(item, idx) in historyItems" :key="item.id" class="meta-record-drawer__history-item">
            <div class="meta-record-drawer__history-main">
              <span class="meta-record-drawer__history-action">{{ historyActionLabel(item.action) }}</span>
              <span class="meta-record-drawer__history-version">v{{ item.version }}</span>
            </div>
            <div class="meta-record-drawer__history-meta">
              <span>{{ formatHistoryTime(item.createdAt) }}</span>
              <span v-if="item.actorId">{{ historyActor(item.actorName || item.actorId, isZh) }}</span>
              <span>{{ item.source }}</span>
            </div>
            <div v-if="item.changedFieldIds.length" class="meta-record-drawer__history-fields">
              <div
                v-for="d in historyFieldDiffs(item, idx)"
                :key="d.fieldId"
                class="meta-record-drawer__history-diff"
                data-test="history-field-diff"
              >
                <input
                  v-if="canRestoreTo(item)"
                  type="checkbox"
                  class="meta-record-drawer__history-diff-select"
                  data-test="history-field-select"
                  :checked="isRestoreFieldSelected(item, d.fieldId)"
                  :aria-label="d.label"
                  @change="toggleRestoreField(item, d.fieldId)"
                />
                <span class="meta-record-drawer__history-diff-label">{{ d.label }}</span>
                <span class="meta-record-drawer__history-diff-values">
                  <span
                    v-if="d.hasBefore"
                    class="meta-record-drawer__history-diff-before"
                    :title="d.before"
                  >{{ d.before || '—' }}</span>
                  <span v-if="d.hasBefore" class="meta-record-drawer__history-diff-arrow" aria-hidden="true">→</span>
                  <span class="meta-record-drawer__history-diff-after" :title="d.after">{{ d.after || '—' }}</span>
                </span>
              </div>
            </div>
            <button
              v-if="canRestoreTo(item)"
              type="button"
              class="meta-record-drawer__history-restore"
              data-test="record-history-restore"
              :title="l('record.restoreTitle')"
              :disabled="selectedRestoreFields(item).length === 0"
              @click="requestRestore(item)"
            >{{ l('record.restore') }}</button>
          </li>
        </ol>
      </div>
    </div>
    <div v-else class="meta-record-drawer__empty">{{ l('record.noRecord') }}</div>
    <MetaRecordPermissionManager
      v-if="canManageRecordPermissions && record && sheetId && apiClient"
      :visible="showRecordPermissions"
      :sheet-id="sheetId"
      :record-id="record.id"
      :client="apiClient"
      @close="showRecordPermissions = false"
      @updated="emit('navigate', record!.id)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  LinkedRecordSummary,
  PersonSummary,
  MetaAttachment,
  MetaAttachmentDeleteFn,
  MetaAttachmentUploadFn,
  MetaCommentMentionSuggestion,
  MultitableCommentPresenceSummary,
  MetaFieldPermission,
  MetaField,
  MetaRecord,
  MetaRecordRevision,
  MetaRecordSubscriptionStatus,
  MetaRowActions,
} from '../types'
import type { MultitableApiClient } from '../api/client'
import { MtButton } from '../ui'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import MetaRecordPermissionManager from './MetaRecordPermissionManager.vue'
import MetaRecordFieldsPanel from './MetaRecordFieldsPanel.vue'
import {
  resolveCommentAffordanceStateClass,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'
import { useLocale } from '../../composables/useLocale'
import {
  recordLabel,
  historyActor,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'
import type { AiShortcutState } from '../composables/useAiShortcut'
import { formatFieldDisplay } from '../utils/field-display'

const props = withDefaults(defineProps<{
  visible: boolean
  record?: MetaRecord | null
  fields: MetaField[]
  canEdit: boolean
  canComment: boolean
  canDelete: boolean
  // Duplicate / clone record (design 2026-06-16): sheet-level canCreateRecord (a duplicate is a create).
  // Gates the drawer's Duplicate button; the server re-enforces it (no FE permission mirror).
  canCreate?: boolean
  canManageAutomation?: boolean
  fieldPermissions?: Record<string, MetaFieldPermission> | null
  rowActions?: MetaRowActions | null
  commentPresence?: MultitableCommentPresenceSummary | null
  linkSummariesByField?: Record<string, LinkedRecordSummary[]>
  personSummariesByField?: Record<string, PersonSummary[]>
  attachmentSummariesByField?: Record<string, MetaAttachment[]>
  recordIds?: string[]
  uploadFn?: MetaAttachmentUploadFn
  deleteAttachmentFn?: MetaAttachmentDeleteFn
  canManageRecordPermissions?: boolean
  sheetId?: string
  apiClient?: MultitableApiClient
  /** A3: shared AI shortcut UI state from the workbench useAiShortcut instance. */
  aiShortcut?: AiShortcutState | null
  /** B1-e: in-flight button runs keyed `${recordId}:${fieldId}` — the SAME ref
   *  the grid (MetaGridTable) receives, so a run from either surface disables
   *  the button on both. Matches the workbench `onRunButton` pending-key format. */
  buttonRunPending?: string[]
  /** B5: people-mention candidates for rich-`longText` field editing in the drawer.
   *  Fed by the workbench's already-loaded commentMentionSuggestions (no re-fetch). */
  mentionSuggestions?: MetaCommentMentionSuggestion[]
}>(), {
  recordIds: () => [],
  buttonRunPending: () => [],
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'delete'): void
  (e: 'duplicate'): void
  (e: 'patch', fieldId: string, value: unknown): void
  (e: 'toggle-lock', payload: { recordId: string; locked: boolean }): void
  (e: 'toggle-comments'): void
  (e: 'comment-field', field: MetaField): void
  (e: 'open-automation'): void
  (e: 'open-link-picker', field: MetaField): void
  (e: 'open-person-picker', field: MetaField): void
  (e: 'navigate', recordId: string): void
  /** Slice 3: request restore of this record to a prior revision. The parent (workbench) owns
   * the apiClient.restoreRecordVersion call + confirm + record refresh — consistent with how the
   * drawer emits 'patch' / 'delete' / 'toggle-lock' rather than mutating directly. */
  (e: 'restore', payload: { recordId: string; targetVersion: number; expectedVersion: number; fieldIds?: string[] }): void
  /** A3: AI shortcut triggers (workbench resolves them through useAiShortcut). */
  (e: 'ai-preview', field: MetaField): void
  (e: 'ai-run', field: MetaField): void
  /** B1-e: run a button field's configured action. Same shape the grid emits
   * (`run-button { recordId, field }`) so the workbench's existing onRunButton
   * handler — which owns the runButton call + result.status branching + the
   * shared buttonRunPending key — handles both surfaces with no extra logic. */
  (e: 'run-button', payload: { recordId: string; field: MetaField }): void
}>()

const { isZh } = useLocale()
const l = (key: MetaRecordLabelKey) => recordLabel(key, isZh.value)

const showRecordPermissions = ref(false)
const activeTab = ref<'details' | 'history'>('details')
const historyItems = ref<MetaRecordRevision[]>([])
const historyLoading = ref(false)
const historyError = ref('')
let historyRequestId = 0
const recordSubscribed = ref(false)
const subscriptionLoading = ref(false)
const subscriptionError = ref('')
let subscriptionRequestId = 0

watch(() => props.record, () => {
  historyItems.value = []
  historyError.value = ''
  recordSubscribed.value = false
  subscriptionError.value = ''
})

watch(
  [() => props.visible, () => props.record?.id, () => props.sheetId, () => props.apiClient],
  () => {
    if (props.visible) void loadRecordSubscription()
  },
  { immediate: true },
)

watch(
  // `record.version` is in the deps so a restore (which bumps the version via the workbench's
  // refreshSelectedRecordContext) reloads the timeline while the user is still on the History tab —
  // otherwise the new restore revision wouldn't appear and the list could read stale/empty.
  [() => activeTab.value, () => props.visible, () => props.record?.id, () => props.record?.version, () => props.sheetId, () => props.apiClient],
  () => {
    if (activeTab.value === 'history') void loadRecordHistory()
  },
  { immediate: false },
)

const currentRecordIndex = computed(() => {
  if (!props.record || !props.recordIds.length) return -1
  return props.recordIds.indexOf(props.record.id)
})

const fieldLabelById = computed(() => new Map(props.fields.map((field) => [field.id, field.name])))
const canLoadHistory = computed(() => !!props.apiClient && !!props.sheetId && !!props.record?.id)
const canLoadSubscription = computed(() => !!props.apiClient && !!props.sheetId && !!props.record?.id)
const resolvedCanComment = computed(() => props.rowActions?.canComment ?? props.canComment)
const resolvedCanDelete = computed(() => props.rowActions?.canDelete ?? props.canDelete)
const drawerCommentAffordance = computed(() => resolveRecordCommentAffordance(props.commentPresence))
const drawerCommentButtonClass = computed(() =>
  resolveCommentAffordanceStateClass('meta-record-drawer__btn--comment', drawerCommentAffordance.value),
)

function navigatePrev() {
  const idx = currentRecordIndex.value
  if (idx > 0) emit('navigate', props.recordIds[idx - 1])
}

function navigateNext() {
  const idx = currentRecordIndex.value
  if (idx >= 0 && idx < props.recordIds.length - 1) emit('navigate', props.recordIds[idx + 1])
}

async function loadRecordHistory() {
  const apiClient = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  if (!apiClient || !sheetId || !recordId) {
    historyItems.value = []
    historyLoading.value = false
    historyError.value = ''
    return
  }
  const requestId = ++historyRequestId
  historyLoading.value = true
  historyError.value = ''
  try {
    const items = await apiClient.listRecordHistory(sheetId, recordId, { limit: 50 })
    if (requestId !== historyRequestId) return
    historyItems.value = items
  } catch (error: any) {
    if (requestId !== historyRequestId) return
    historyItems.value = []
    historyError.value = error?.message ?? l('record.errorHistoryLoad')
  } finally {
    if (requestId === historyRequestId) historyLoading.value = false
  }
}

function applySubscriptionStatus(status: MetaRecordSubscriptionStatus) {
  recordSubscribed.value = status.subscribed
}

async function loadRecordSubscription() {
  const apiClient = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  if (!apiClient || !sheetId || !recordId) {
    recordSubscribed.value = false
    subscriptionLoading.value = false
    subscriptionError.value = ''
    return
  }
  const requestId = ++subscriptionRequestId
  subscriptionLoading.value = true
  subscriptionError.value = ''
  try {
    const status = await apiClient.getRecordSubscriptionStatus(sheetId, recordId)
    if (requestId !== subscriptionRequestId) return
    applySubscriptionStatus(status)
  } catch (error: any) {
    if (requestId !== subscriptionRequestId) return
    recordSubscribed.value = false
    subscriptionError.value = error?.message ?? l('record.errorWatchLoad')
  } finally {
    if (requestId === subscriptionRequestId) subscriptionLoading.value = false
  }
}

async function toggleRecordSubscription() {
  const apiClient = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  if (!apiClient || !sheetId || !recordId || subscriptionLoading.value) return
  const requestId = ++subscriptionRequestId
  subscriptionLoading.value = true
  subscriptionError.value = ''
  try {
    const status = recordSubscribed.value
      ? await apiClient.unsubscribeRecord(sheetId, recordId)
      : await apiClient.subscribeRecord(sheetId, recordId)
    if (requestId !== subscriptionRequestId) return
    applySubscriptionStatus(status)
  } catch (error: any) {
    if (requestId !== subscriptionRequestId) return
    subscriptionError.value = error?.message ?? l('record.errorWatchUpdate')
  } finally {
    if (requestId === subscriptionRequestId) subscriptionLoading.value = false
  }
}

function historyActionLabel(action: MetaRecordRevision['action']): string {
  if (action === 'create') return l('record.historyActionCreated')
  if (action === 'delete') return l('record.historyActionDeleted')
  return l('record.historyActionUpdated')
}

// Slice 3: a prior NON-delete revision is restorable when the user can edit the record. The current
// version (== record.version) shows no button (restoring to it is a no-op). Delete revisions are not
// restorable here (undelete is Slice 2b → the endpoint returns RESTORE_UNSUPPORTED).
function canRestoreTo(item: MetaRecordRevision): boolean {
  return (
    props.canEdit
    && props.rowActions?.canEdit !== false
    && !!props.record
    && item.action !== 'delete'
    && item.version !== props.record.version
  )
}

// Per-field restore selection, keyed by revision id. Default (no entry) = ALL changed fields selected
// (full restore, the prior behavior). Unchecking narrows to a subset → emits fieldIds; re-checking all
// → omits fieldIds (canonical full restore). Only the actor-visible changedFieldIds are selectable
// (they are already permission-masked server-side), so a hidden field can never be targeted.
const restoreFieldSelection = ref<Record<string, Set<string>>>({})
function isRestoreFieldSelected(item: MetaRecordRevision, fieldId: string): boolean {
  const sel = restoreFieldSelection.value[item.id]
  return sel ? sel.has(fieldId) : true
}
function toggleRestoreField(item: MetaRecordRevision, fieldId: string): void {
  const next = new Set(restoreFieldSelection.value[item.id] ?? item.changedFieldIds)
  if (next.has(fieldId)) next.delete(fieldId)
  else next.add(fieldId)
  restoreFieldSelection.value = { ...restoreFieldSelection.value, [item.id]: next }
}
function selectedRestoreFields(item: MetaRecordRevision): string[] {
  return item.changedFieldIds.filter((fieldId) => isRestoreFieldSelected(item, fieldId))
}

function requestRestore(item: MetaRecordRevision): void {
  const record = props.record
  if (!record || !canRestoreTo(item)) return
  const selected = selectedRestoreFields(item)
  if (selected.length === 0) return // nothing selected → no-op (button is also disabled)
  // All changed fields selected → full restore (omit fieldIds); a proper subset → per-field restore.
  const fieldIds = selected.length === item.changedFieldIds.length ? undefined : selected
  emit('restore', { recordId: record.id, targetVersion: item.version, expectedVersion: record.version, ...(fieldIds ? { fieldIds } : {}) })
}

// Per-field before→after diff for a revision. LEAK-SAFE BY CONSTRUCTION: the backend
// (redactRecordRevisionEntry / maskStoredRecordFieldIds) already strips fields this actor can't see
// from changedFieldIds AND patch AND snapshot before they reach the wire, so iterating changedFieldIds
// and reading only patch/snapshot cannot surface a masked field. `after` = the value at this revision
// (snapshot preferred, patch fallback when snapshot is unavailable); `before` = the value at the
// next-older visible revision's snapshot (absent when there's no prior snapshot — e.g. the create row,
// a pruned gap, or an unavailable snapshot → show after only).
interface HistoryFieldDiff { fieldId: string; label: string; before: string; after: string; hasBefore: boolean }
function historyFieldDiffs(item: MetaRecordRevision, index: number): HistoryFieldDiff[] {
  const olderSnap = historyItems.value[index + 1]?.snapshot ?? null
  const has = (obj: Record<string, unknown> | null | undefined, key: string): boolean =>
    !!obj && Object.prototype.hasOwnProperty.call(obj, key)
  return item.changedFieldIds.map((fieldId) => {
    const field = props.fields.find((f) => f.id === fieldId) ?? null
    const fmt = (v: unknown): string => (field ? formatValue(field, v) : textControlValue(v))
    const afterRaw = has(item.snapshot, fieldId)
      ? item.snapshot![fieldId]
      : has(item.patch, fieldId) ? item.patch[fieldId] : undefined
    const hasBefore = has(olderSnap, fieldId)
    return {
      fieldId,
      label: fieldLabelById.value.get(fieldId) ?? fieldId,
      before: hasBefore ? fmt(olderSnap![fieldId]) : '',
      after: fmt(afterRaw),
      hasBefore,
    }
  })
}

function formatHistoryTime(value: string): string {
  if (!value) return ''
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  return new Date(timestamp).toLocaleString()
}

function formatValue(field: MetaField, v: unknown): string {
  return formatFieldDisplay({
    field,
    value: v,
    linkSummaries: props.linkSummariesByField?.[field.id],
    personSummaries: props.personSummariesByField?.[field.id],
    attachmentSummaries: props.attachmentSummariesByField?.[field.id],
    isZh: isZh.value,
  })
}

function textControlValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

</script>

<style scoped>
.meta-record-drawer { width: 360px; border-left: 1px solid #e5e7eb; background: #fff; display: flex; flex-direction: column; overflow-y: auto; }
.meta-record-drawer__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-record-drawer__title { font-size: 15px; font-weight: 600; margin: 0; }
.meta-record-drawer__actions { display: flex; gap: 8px; align-items: center; }
.meta-record-drawer__btn { padding: 4px 10px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-record-drawer__btn--comment { border-radius: 999px; padding: 3px 8px; }
.meta-record-drawer__btn--comment.meta-record-drawer__btn--comment--active { border-color: var(--ms-color-comment-active-border); background: var(--ms-color-comment-active-bg); color: var(--ms-color-comment-active-text); }
.meta-record-drawer__btn--comment.meta-record-drawer__btn--comment--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
/* UI-P2-1c T5-safe (owner-ratified 2026-07-13): watch/workflow/permissions/duplicate/delete/unlock
   are now <MtButton> — token-styled, no longer needs bespoke hardcoded-hex. --danger's sole sharer
   (delete) now uses MtButton's own `variant="danger"`; --watch's sole sharer (watch, non-active
   state) now uses MtButton's default ghost styling — both bespoke rules removed (orphaned, no other
   sharer). --watching stays: it is the watch toggle's ACTIVE-state visual (OD-T5a option A) — MtButton
   has no built-in pressed/active variant (adding one is a primitive-contract change, out of scope),
   so the toggle's active affordance still comes from this class, now paired with `aria-pressed`. The
   base .meta-record-drawer__btn rule above and the three --comment* rules stay untouched: the comment
   button (OD-T5b) is deliberately NOT migrated this round — it remains bespoke, styled by these rules. */
.meta-record-drawer__btn--watching { border-color: #0f766e; color: #0f766e; background: #ecfdf5; }
.meta-record-drawer__btn:disabled { opacity: 0.55; cursor: not-allowed; }
.meta-record-drawer__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-record-drawer__nav { display: flex; align-items: center; gap: 4px; margin-right: auto; margin-left: 8px; }
.meta-record-drawer__nav-btn { width: 24px; height: 24px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; }
.meta-record-drawer__nav-btn:hover:not(:disabled) { background: #f5f5f5; }
.meta-record-drawer__nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.meta-record-drawer__nav-pos { font-size: 11px; color: #999; min-width: 36px; text-align: center; }
.meta-record-drawer__body { padding: 12px 16px; flex: 1; }
.meta-record-drawer__tabs { display: inline-flex; gap: 4px; padding: 3px; margin-bottom: 14px; border: 1px solid #e5e7eb; border-radius: 999px; background: #f8fafc; }
.meta-record-drawer__tab { min-width: 76px; padding: 5px 12px; border: none; border-radius: 999px; background: transparent; color: #64748b; cursor: pointer; font-size: 12px; font-weight: 600; }
.meta-record-drawer__tab--active { background: #111827; color: #fff; box-shadow: 0 2px 8px rgba(15, 23, 42, 0.16); }
.meta-record-drawer__watch-error { margin: -4px 0 12px; color: #b91c1c; font-size: 12px; }
.meta-record-drawer__empty { padding: 32px; text-align: center; color: #999; }
.meta-record-drawer__history-state { padding: 18px 12px; border: 1px dashed #d8e1ee; border-radius: 8px; color: #64748b; font-size: 13px; text-align: center; }
.meta-record-drawer__history-state--error { border-color: #fecaca; color: #b91c1c; background: #fef2f2; }
.meta-record-drawer__history-list { display: flex; flex-direction: column; gap: 10px; padding: 0; margin: 0; list-style: none; }
.meta-record-drawer__history-item { padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; }
.meta-record-drawer__history-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
.meta-record-drawer__history-action { font-size: 13px; font-weight: 700; color: #111827; }
.meta-record-drawer__history-version { font-size: 11px; font-weight: 700; color: #2563eb; background: #eff6ff; border-radius: 999px; padding: 2px 7px; }
.meta-record-drawer__history-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #64748b; }
.meta-record-drawer__history-fields { margin-top: 8px; font-size: 12px; color: #374151; word-break: break-word; }
.meta-record-drawer__history-diff { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; }
.meta-record-drawer__history-diff + .meta-record-drawer__history-diff { border-top: 1px dashed #f1f5f9; }
.meta-record-drawer__history-diff-label { flex: 0 0 auto; max-width: 38%; font-weight: 600; color: #475569; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-record-drawer__history-diff-values { flex: 1 1 auto; display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.meta-record-drawer__history-diff-before { color: #94a3b8; text-decoration: line-through; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
.meta-record-drawer__history-diff-arrow { flex: 0 0 auto; color: #cbd5e1; }
.meta-record-drawer__history-diff-after { color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.meta-record-drawer__history-diff-select { flex: 0 0 auto; margin: 0 2px 0 0; cursor: pointer; }
.meta-record-drawer__history-restore:disabled { opacity: 0.45; cursor: not-allowed; }
</style>

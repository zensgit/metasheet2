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
      <MetaRecordHistoryPanel
        v-else
        :record="record"
        :fields="fields"
        :can-edit="canEdit"
        :row-actions="rowActions"
        :link-summaries-by-field="linkSummariesByField"
        :person-summaries-by-field="personSummariesByField"
        :attachment-summaries-by-field="attachmentSummariesByField"
        :sheet-id="sheetId"
        :api-client="apiClient"
        @restore="(payload) => emit('restore', payload)"
      />
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
  MetaRecordSubscriptionStatus,
  MetaRowActions,
} from '../types'
import type { MultitableApiClient } from '../api/client'
import { MtButton } from '../ui'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import MetaRecordPermissionManager from './MetaRecordPermissionManager.vue'
import MetaRecordFieldsPanel from './MetaRecordFieldsPanel.vue'
import MetaRecordHistoryPanel from './MetaRecordHistoryPanel.vue'
import {
  resolveCommentAffordanceStateClass,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'
import { useLocale } from '../../composables/useLocale'
import {
  recordLabel,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'
import type { AiShortcutState } from '../composables/useAiShortcut'
import { resolveCanComment } from '../utils/recordDisplay'

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
const recordSubscribed = ref(false)
const subscriptionLoading = ref(false)
const subscriptionError = ref('')
let subscriptionRequestId = 0

watch(() => props.record, () => {
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

const currentRecordIndex = computed(() => {
  if (!props.record || !props.recordIds.length) return -1
  return props.recordIds.indexOf(props.record.id)
})

const canLoadSubscription = computed(() => !!props.apiClient && !!props.sheetId && !!props.record?.id)
const resolvedCanComment = computed(() => resolveCanComment(props.rowActions, props.canComment))
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
</style>

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
        <button
          v-if="record && canLoadSubscription"
          class="meta-record-drawer__btn meta-record-drawer__btn--watch"
          :class="{ 'meta-record-drawer__btn--watching': recordSubscribed }"
          type="button"
          :disabled="subscriptionLoading"
          :title="l(recordSubscribed ? 'record.unwatchTitle' : 'record.watchTitle')"
          @click="toggleRecordSubscription"
        >
          {{ l(recordSubscribed ? 'record.watching' : 'record.watch') }}
        </button>
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
        <button v-if="canManageAutomation" class="meta-record-drawer__btn" :title="l('record.workflowTitle')" @click="emit('open-automation')">&#x2699; {{ l('record.workflow') }}</button>
        <button v-if="canManageRecordPermissions" class="meta-record-drawer__btn" :title="l('record.permissionsTitle')" @click="showRecordPermissions = true">&#x1F512; {{ l('record.permissions') }}</button>
        <button v-if="record && canCreate" class="meta-record-drawer__btn meta-record-drawer__btn--duplicate" :title="l('record.duplicateTitle')" type="button" @click="emit('duplicate')">{{ l('record.duplicate') }}</button>
        <button v-if="resolvedCanDelete" class="meta-record-drawer__btn meta-record-drawer__btn--danger" @click="emit('delete')">{{ l('record.delete') }}</button>
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
        <button
          v-if="record.canUnlock"
          type="button"
          class="meta-record-drawer__btn meta-record-drawer__lock-unlock"
          data-test="record-unlock-action"
          @click="emit('toggle-lock', { recordId: record.id, locked: false })"
        >{{ l('record.unlock') }}</button>
      </div>
      <div v-if="activeTab === 'details'" class="meta-record-drawer__fields">
      <div v-for="field in visibleFields" :key="field.id" class="meta-record-drawer__field">
        <div class="meta-record-drawer__field-header">
          <label class="meta-record-drawer__label" :for="`drawer_field_${field.id}`">{{ field.name }}</label>
          <!--
            A3-T3 AI shortcut actions: a field rendered here IS readable
            (visibleFields filters visible===false), so preview mirrors the
            backend's record-read gate; run additionally requires
            canEditField — the same layer the backend's run pre-check
            enforces (#2106 F3).
          -->
          <div v-if="fieldHasAiShortcut(field)" class="meta-record-drawer__ai-actions">
            <button
              type="button"
              class="meta-record-drawer__ai-btn"
              :disabled="aiBusy"
              :title="l('record.aiPreviewTitle')"
              :data-ai-preview="field.id"
              @click="emit('ai-preview', field)"
            >{{ l('record.aiPreview') }}</button>
            <button
              v-if="canEditField(field.id)"
              type="button"
              class="meta-record-drawer__ai-btn meta-record-drawer__ai-btn--run"
              :disabled="aiBusy"
              :title="l('record.aiRunTitle')"
              :data-ai-run="field.id"
              @click="emit('ai-run', field)"
            >{{ l('record.aiRun') }}</button>
          </div>
          <button
            v-if="resolvedCanComment"
            type="button"
            class="meta-record-drawer__comment-anchor"
            :class="recordFieldAnchorClass(field.id)"
            :data-comment-field="field.id"
            :aria-label="commentOnField(field.name, isZh)"
            :title="commentOnField(field.name, isZh)"
            @click="emit('comment-field', field)"
          >
            <MetaCommentAffordance :state="recordFieldAffordance(field.id)" />
          </button>
        </div>
        <div class="meta-record-drawer__value">
          <input
            v-if="canEditField(field.id) && field.type === 'string'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="text"
            :value="textControlValue(record.data[field.id])"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value)"
          />
          <!-- rich longText: minimal rich editor (server re-sanitizes on write).
               Patch on `change` (blur) only — mirrors the plain textarea's @change so
               the drawer issues ONE server PATCH per edit, never one per keystroke. -->
          <MetaRichLongTextEditor
            v-else-if="canEditField(field.id) && field.type === 'longText' && isRichLongTextField(field)"
            :model-value="record.data[field.id]"
            :is-zh="isZh"
            :mention-suggestions="mentionSuggestions"
            @change="emit('patch', field.id, $event)"
          />
          <!-- plain longText: unchanged textarea -->
          <textarea
            v-else-if="canEditField(field.id) && field.type === 'longText'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__textarea"
            :value="textControlValue(record.data[field.id])"
            rows="5"
            @change="emit('patch', field.id, ($event.target as HTMLTextAreaElement).value)"
          />
          <input
            v-else-if="canEditField(field.id) && field.type === 'barcode'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="text"
            inputmode="text"
            :placeholder="lc('cell.barcodePlaceholder')"
            :value="textControlValue(record.data[field.id])"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value)"
          />
          <input
            v-else-if="canEditField(field.id) && field.type === 'qrcode'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="text"
            inputmode="text"
            :placeholder="lc('cell.qrcodePlaceholder')"
            :value="textControlValue(record.data[field.id])"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value)"
          />
          <input
            v-else-if="canEditField(field.id) && field.type === 'location'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="text"
            :placeholder="lc('cell.locationPlaceholder')"
            :value="locationAddressValue(record.data[field.id])"
            @change="emit('patch', field.id, locationValueFromAddress(($event.target as HTMLInputElement).value))"
          />
          <input
            v-else-if="canEditField(field.id) && field.type === 'number'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="number"
            :value="record.data[field.id] ?? ''"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value))"
          />
          <input
            v-else-if="canEditField(field.id) && field.type === 'date'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="date"
            :value="record.data[field.id] ?? ''"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value)"
          />
          <input
            v-else-if="canEditField(field.id) && field.type === 'dateTime'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="datetime-local"
            :value="dateTimeInputValue(record.data[field.id])"
            @change="emit('patch', field.id, dateTimeValueFromLocalInput(($event.target as HTMLInputElement).value))"
          />
          <label v-else-if="canEditField(field.id) && field.type === 'boolean'" class="meta-record-drawer__check">
            <input type="checkbox" :checked="!!record.data[field.id]" @change="emit('patch', field.id, ($event.target as HTMLInputElement).checked)" />
          </label>
          <select
            v-else-if="canEditField(field.id) && field.type === 'select'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            :value="record.data[field.id] ?? ''"
            @change="emit('patch', field.id, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">—</option>
            <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">{{ opt.value }}</option>
          </select>
          <select
            v-else-if="canEditField(field.id) && field.type === 'multiSelect'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input meta-record-drawer__input--multi"
            multiple
            :value="multiSelectValue(field.id)"
            @change="emit('patch', field.id, multiSelectEventValue($event))"
          >
            <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">{{ opt.value }}</option>
          </select>
          <button
            v-else-if="canEditField(field.id) && field.type === 'link'"
            class="meta-record-drawer__link-btn"
            @click="emit('open-link-picker', field)"
          >{{ linkButtonLabel(field.id) }}</button>
          <button
            v-else-if="canEditField(field.id) && field.type === 'person'"
            class="meta-record-drawer__link-btn"
            data-test="drawer-person-picker-open"
            @click="emit('open-person-picker', field)"
          >{{ linkButtonLabel(field.id) }}</button>
          <div v-else-if="field.type === 'attachment'" class="meta-record-drawer__attachments">
            <MetaAttachmentList
              :attachments="attachmentItems(field.id)"
              :removable="canEditField(field.id)"
              empty-label="—"
              @remove="onRemoveAttachment(field.id, $event)"
            />
            <div v-if="canEditField(field.id)" class="meta-record-drawer__attachment-add">
              <input
                type="file"
                :multiple="attachmentAllowsMultiple(field)"
                :accept="attachmentAccept(field)"
                class="meta-record-drawer__file-input"
                :disabled="!!attachmentActivity[field.id]"
                @change="onDrawerFileSelect(field.id, $event)"
              />
              <span class="meta-record-drawer__attachment-hint">{{ attachmentActionHint(field.id) }}</span>
              <button
                v-if="attachmentList(field.id).length"
                type="button"
                class="meta-record-drawer__attachment-clear"
                :disabled="!!attachmentActivity[field.id]"
                @click="onClearAttachments(field.id)"
              >{{ lc('cell.clearAll') }}</button>
              <span v-if="attachmentActivity[field.id]" class="meta-record-drawer__uploading">
                {{ attachmentActivityLabel(attachmentActivity[field.id] || 'uploading', isZh) }}
              </span>
            </div>
            <div v-if="attachmentErrors[field.id]" class="meta-record-drawer__error">{{ attachmentErrors[field.id] }}</div>
          </div>
          <!-- read-only rich longText: formatted render via the single sanitized
               component (§7 drawer shows the formatted render). -->
          <MetaRichLongTextRender
            v-else-if="field.type === 'longText' && isRichLongTextField(field)"
            :html="record.data[field.id]"
          />
          <!-- button (B1-e): clickable action in the record-detail drawer, mirroring
               the B1-b grid cell. It is an ACTION, not an editable value, so it is
               NOT gated on canEditField — it renders whenever the field is visible
               (the server gates execution). The run intent surfaces up to the
               workbench (run-button), which owns the EXISTING onRunButton/runButton
               path + status branching; the drawer never duplicates the run logic.
               @click.stop so a parent click handler doesn't also fire. -->
          <button
            v-else-if="field.type === 'button'"
            type="button"
            class="meta-record-drawer__button"
            :class="`meta-record-drawer__button--${buttonVariant(field)}`"
            :disabled="buttonPendingFor(field.id)"
            :aria-label="buttonLabel(field)"
            :title="buttonLabel(field)"
            data-test="drawer-button"
            @click.stop="emit('run-button', { recordId: record.id, field })"
          >{{ buttonLabel(field) }}</button>
          <span v-else class="meta-record-drawer__text">{{ formatValue(field, record.data[field.id]) }}</span>
          <div
            v-if="field.type === 'qrcode' && drawerQrSvg(record.data[field.id])"
            class="meta-record-drawer__qrcode"
            v-html="drawerQrSvg(record.data[field.id])"
          />
          <!-- A3 follow-up (#2708): this drawer link summary stays read-only
               text for now. Making it a clickable foreign-record popover is the
               record-drawer slice of A3, tracked separately so this slice ships
               grid-only. -->
          <div v-if="field.type === 'link' && linkPreview(field.id)" class="meta-record-drawer__link-summary">{{ linkPreview(field.id) }}</div>
        </div>
        <!-- A3 §2.3/§2.4: per-field AI state — pending / error copy (by code) / per-run tokens. -->
        <div
          v-if="aiStatusTextFor(field.id)"
          class="meta-record-drawer__ai-status"
          :class="{ 'meta-record-drawer__ai-status--error': aiStatusIsError(field.id) }"
          :data-ai-status="field.id"
        >{{ aiStatusTextFor(field.id) }}</div>
        <div
          v-if="aiPreviewOutputFor(field.id)"
          class="meta-record-drawer__ai-output"
          :data-ai-output="field.id"
        >{{ aiPreviewOutputFor(field.id) }}</div>
      </div>
      </div>
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
              <span v-if="item.actorId">{{ historyActor(item.actorId, isZh) }}</span>
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
import MetaAttachmentList from './MetaAttachmentList.vue'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import MetaRecordPermissionManager from './MetaRecordPermissionManager.vue'
import MetaRichLongTextRender from './cells/MetaRichLongTextRender.vue'
import MetaRichLongTextEditor from './cells/MetaRichLongTextEditor.vue'
import { isRichLongTextField } from '../utils/rich-longtext'
import {
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'
import { attachmentAcceptAttr, resolveAttachmentFieldProperty, resolveButtonFieldProperty, shouldReplaceAttachmentSelection, validateAttachmentSelection } from '../utils/field-config'
import { linkActionLabel } from '../utils/link-fields'
import { useLocale } from '../../composables/useLocale'
import {
  recordLabel,
  commentOnField,
  historyActor,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'
import {
  metaCoreLabel,
  aiTokensConsumed,
  attachmentActionHint as attachmentActionHintFn,
  attachmentActivityLabel,
  type MetaCoreLabelKey,
} from '../utils/meta-core-labels'
import { aiRetryCountdown, aiShortcutErrorMessage } from '../utils/meta-api-error-labels'
import type { AiShortcutState } from '../composables/useAiShortcut'
import {
  dateTimeInputValue,
  dateTimeValueFromLocalInput,
  formatFieldDisplay,
  locationAddressValue,
  locationValueFromAddress,
} from '../utils/field-display'
import { isSystemField } from '../utils/system-fields'
import { qrSvgFromText } from '../utils/qr-code'

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
const lc = (key: MetaCoreLabelKey) => metaCoreLabel(key, isZh.value)

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

const attachmentActivity = ref<Record<string, 'uploading' | 'removing' | 'clearing'>>({})
const attachmentErrors = ref<Record<string, string>>({})
const localAttachmentSummaries = ref<Record<string, Record<string, MetaAttachment>>>({})

watch(() => props.record, () => {
  attachmentActivity.value = {}
  attachmentErrors.value = {}
  localAttachmentSummaries.value = {}
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

const visibleFields = computed(() => props.fields.filter((field) => props.fieldPermissions?.[field.id]?.visible !== false))
const fieldLabelById = computed(() => new Map(props.fields.map((field) => [field.id, field.name])))
const canLoadHistory = computed(() => !!props.apiClient && !!props.sheetId && !!props.record?.id)
const canLoadSubscription = computed(() => !!props.apiClient && !!props.sheetId && !!props.record?.id)
const resolvedCanComment = computed(() => props.rowActions?.canComment ?? props.canComment)
const resolvedCanDelete = computed(() => props.rowActions?.canDelete ?? props.canDelete)
const drawerCommentAffordance = computed(() => resolveRecordCommentAffordance(props.commentPresence))
const drawerCommentButtonClass = computed(() =>
  resolveCommentAffordanceStateClass('meta-record-drawer__btn--comment', drawerCommentAffordance.value),
)

function canEditField(fieldId: string): boolean {
  const field = props.fields.find((item) => item.id === fieldId) ?? null
  return props.canEdit
    && props.rowActions?.canEdit !== false
    && props.fieldPermissions?.[fieldId]?.readOnly !== true
    && !isSystemField(field)
}

// --- A3 AI shortcut (drawer = primary trigger surface) ---

function fieldHasAiShortcut(field: MetaField): boolean {
  if (field.type !== 'string' && field.type !== 'longText') return false
  const raw = (field.property ?? {}).aiShortcut
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
}

// Unified in-flight + rate-limit countdown disable across ALL fields (§2.2).
const aiBusy = computed(() =>
  Boolean(props.aiShortcut?.pending) || (props.aiShortcut?.retryRemainingMs ?? 0) > 0,
)

function aiStateTargets(fieldId: string): {
  pending: boolean
  error: AiShortcutState['error']
  result: AiShortcutState['result']
} {
  const ai = props.aiShortcut
  const recordId = props.record?.id
  if (!ai || !recordId) return { pending: false, error: null, result: null }
  return {
    pending: Boolean(ai.pending && ai.pending.recordId === recordId && ai.pending.fieldId === fieldId),
    error: ai.error && ai.error.recordId === recordId && ai.error.fieldId === fieldId ? ai.error : null,
    result: ai.result && ai.result.recordId === recordId && ai.result.fieldId === fieldId ? ai.result : null,
  }
}

function aiStatusIsError(fieldId: string): boolean {
  const { error, result } = aiStateTargets(fieldId)
  return Boolean(error) || Boolean(result?.refreshHint)
}

/** §2.3 state copy by error.code; per-run tokens; drift shares the 409 refresh copy. */
function aiStatusTextFor(fieldId: string): string {
  const { pending, error, result } = aiStateTargets(fieldId)
  if (pending) return l('record.aiPending')
  if (error) {
    const mapped = aiShortcutErrorMessage(error.code, isZh.value) ?? error.message
    const remaining = props.aiShortcut?.retryRemainingMs
    if (error.code === 'RATE_LIMITED' && typeof remaining === 'number' && remaining > 0) {
      return `${mapped} ${aiRetryCountdown(Math.ceil(remaining / 1000), isZh.value)}`
    }
    return mapped
  }
  if (result) {
    const tokens = aiTokensConsumed(result.totalTokens, isZh.value)
    if (result.refreshHint) {
      // Drift-skipped merge: SAME recovery copy as 409 (LOCKED §2.2).
      return `${aiShortcutErrorMessage('VERSION_CONFLICT', isZh.value)} · ${tokens}`
    }
    return tokens
  }
  return ''
}

/** Preview output is shown inline (a preview never writes the record). */
function aiPreviewOutputFor(fieldId: string): string {
  const { result } = aiStateTargets(fieldId)
  return result && result.kind === 'preview' ? result.output : ''
}

function recordFieldAffordance(fieldId: string) {
  return resolveFieldCommentAffordance(props.commentPresence, fieldId)
}

function recordFieldAnchorClass(fieldId: string): string {
  return resolveCommentAffordanceStateClass('meta-record-drawer__comment-anchor', recordFieldAffordance(fieldId))
}

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

// Render-only QR preview for qrcode fields: encode the stored string value.
// Returns null for empty / unencodable values so no image is shown.
function drawerQrSvg(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  try {
    return qrSvgFromText(String(value), { size: 132, border: 3 })
  } catch {
    return null
  }
}

function multiSelectValue(fieldId: string): string[] {
  const value = props.record?.data[fieldId]
  return Array.isArray(value) ? value.map(String) : []
}

function multiSelectEventValue(event: Event): string[] {
  const select = event.target as HTMLSelectElement
  return Array.from(select.selectedOptions).map((option) => option.value)
}

// B1-e button field: label + variant from the field property. The empty-label
// fallback is the field name (user data, never a hardcoded literal — strict-zero
// i18n, identical to the B1-b grid cell) so the accessible name is always
// non-empty.
function buttonLabel(field: MetaField): string {
  return resolveButtonFieldProperty(field.property).label || field.name
}

function buttonVariant(field: MetaField): string {
  return resolveButtonFieldProperty(field.property).variant
}

function buttonPendingFor(fieldId: string): boolean {
  const recordId = props.record?.id
  if (!recordId) return false
  return props.buttonRunPending.includes(`${recordId}:${fieldId}`)
}

function linkButtonLabel(fieldId: string): string {
  const count = linkSummaryCount(fieldId)
  const field = props.fields.find((item) => item.id === fieldId) ?? null
  return linkActionLabel(field, count, isZh.value)
}

function linkPreview(fieldId: string): string {
  const summaries = props.linkSummariesByField?.[fieldId] ?? []
  if (summaries.length) return summaries.map((item) => item.display || item.id).join(', ')
  const raw = props.record?.data[fieldId]
  const ids = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
  return ids.join(', ')
}

function attachmentList(fieldId: string): string[] {
  const raw = props.record?.data[fieldId]
  if (Array.isArray(raw)) return raw.map(String)
  if (raw) return [String(raw)]
  return []
}

function attachmentItems(fieldId: string): MetaAttachment[] {
  const summaryMap = new Map((props.attachmentSummariesByField?.[fieldId] ?? []).map((attachment) => [attachment.id, attachment]))
  for (const attachment of Object.values(localAttachmentSummaries.value[fieldId] ?? {})) {
    summaryMap.set(attachment.id, attachment)
  }
  return attachmentList(fieldId).map((id) => summaryMap.get(id) ?? ({
    id,
    filename: id,
    mimeType: 'application/octet-stream',
    size: 0,
    url: '',
    thumbnailUrl: null,
    uploadedAt: '',
  }))
}

function linkSummaryCount(fieldId: string): number {
  const summaries = props.linkSummariesByField?.[fieldId] ?? []
  if (summaries.length) return summaries.length
  const raw = props.record?.data[fieldId]
  return Array.isArray(raw) ? raw.length : raw ? 1 : 0
}

function attachmentActionHint(fieldId: string): string {
  // T3B1 (F-T3B-B): reuse the T3A2 meta-core-labels helper with mode='add'
  // so this surface does not re-implement the ternary chain. Non-attachment
  // fields fall back to the multi-file add copy (matches the old behavior of
  // the inline string before the refactor).
  const field = props.fields.find((item) => item.id === fieldId)
  if (!field || field.type !== 'attachment') {
    return attachmentActionHintFn(true, false, isZh.value, 'add')
  }
  return attachmentActionHintFn(
    attachmentAllowsMultiple(field),
    attachmentList(fieldId).length > 0,
    isZh.value,
    'add',
  )
}

async function onDrawerFileSelect(fieldId: string, e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files?.length) return
  clearAttachmentError(fieldId)
  const field = props.fields.find((item) => item.id === fieldId)
  if (field) {
    const validationError = validateAttachmentSelection(field, files, attachmentList(fieldId).length, isZh.value)
    if (validationError) {
      setAttachmentError(fieldId, validationError)
      input.value = ''
      return
    }
  }
  if (!props.uploadFn) {
    const existing = attachmentList(fieldId)
    const replaceExisting = field ? shouldReplaceAttachmentSelection(field, files, existing.length) : false
    const uploadedNames = Array.from(files).map((file) => file.name)
    emit('patch', fieldId, replaceExisting ? uploadedNames : [...existing, ...uploadedNames])
    input.value = ''
    return
  }
  setAttachmentActivity(fieldId, 'uploading')
  try {
    const existing = attachmentList(fieldId)
    const replaceExisting = field ? shouldReplaceAttachmentSelection(field, files, existing.length) : false
    const newIds: string[] = []
    for (const file of Array.from(files)) {
      const attachment = await props.uploadFn(file, {
        recordId: props.record?.id,
        fieldId,
      })
      rememberLocalAttachment(fieldId, attachment)
      newIds.push(attachment.id)
    }
    emit('patch', fieldId, replaceExisting ? newIds : [...existing, ...newIds])
  } catch (error: any) {
    setAttachmentError(fieldId, error?.message ?? lc('cell.uploadFailed'))
  } finally {
    setAttachmentActivity(fieldId)
    input.value = ''
  }
}

async function onRemoveAttachment(fieldId: string, attachmentId: string) {
  clearAttachmentError(fieldId)
  if (props.deleteAttachmentFn) {
    setAttachmentActivity(fieldId, 'removing')
    try {
      await props.deleteAttachmentFn(attachmentId, {
        recordId: props.record?.id,
        fieldId,
      })
    } catch (error: any) {
      setAttachmentError(fieldId, error?.message ?? lc('cell.removeFailed'))
      setAttachmentActivity(fieldId)
      return
    }
    setAttachmentActivity(fieldId)
  }
  const existing = attachmentList(fieldId)
  emit('patch', fieldId, existing.filter((id) => id !== attachmentId))
  forgetLocalAttachment(fieldId, attachmentId)
}

async function onClearAttachments(fieldId: string) {
  const existing = attachmentList(fieldId)
  if (!existing.length) return
  clearAttachmentError(fieldId)
  if (props.deleteAttachmentFn) {
    setAttachmentActivity(fieldId, 'clearing')
    try {
      for (const attachmentId of existing) {
        await props.deleteAttachmentFn(attachmentId, {
          recordId: props.record?.id,
          fieldId,
        })
        forgetLocalAttachment(fieldId, attachmentId)
      }
    } catch (error: any) {
      setAttachmentError(fieldId, error?.message ?? lc('cell.clearFailed'))
      setAttachmentActivity(fieldId)
      return
    }
    setAttachmentActivity(fieldId)
  }
  emit('patch', fieldId, [])
}

function setAttachmentActivity(fieldId: string, activity?: 'uploading' | 'removing' | 'clearing') {
  const next = { ...attachmentActivity.value }
  if (activity) next[fieldId] = activity
  else delete next[fieldId]
  attachmentActivity.value = next
}

function setAttachmentError(fieldId: string, message: string) {
  attachmentErrors.value = {
    ...attachmentErrors.value,
    [fieldId]: message,
  }
}

function clearAttachmentError(fieldId: string) {
  if (!attachmentErrors.value[fieldId]) return
  const next = { ...attachmentErrors.value }
  delete next[fieldId]
  attachmentErrors.value = next
}

function rememberLocalAttachment(fieldId: string, attachment: MetaAttachment) {
  localAttachmentSummaries.value = {
    ...localAttachmentSummaries.value,
    [fieldId]: {
      ...(localAttachmentSummaries.value[fieldId] ?? {}),
      [attachment.id]: attachment,
    },
  }
}

function forgetLocalAttachment(fieldId: string, attachmentId: string) {
  const current = localAttachmentSummaries.value[fieldId]
  if (!current?.[attachmentId]) return
  const nextFieldMap = { ...current }
  delete nextFieldMap[attachmentId]
  localAttachmentSummaries.value = {
    ...localAttachmentSummaries.value,
    [fieldId]: nextFieldMap,
  }
}

function attachmentAccept(field: MetaField): string | undefined {
  return attachmentAcceptAttr(field)
}

function attachmentAllowsMultiple(field: MetaField): boolean {
  return resolveAttachmentFieldProperty(field.property).maxFiles !== 1
}
</script>

<style scoped>
.meta-record-drawer { width: 360px; border-left: 1px solid #e5e7eb; background: #fff; display: flex; flex-direction: column; overflow-y: auto; }
.meta-record-drawer__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-record-drawer__title { font-size: 15px; font-weight: 600; margin: 0; }
.meta-record-drawer__actions { display: flex; gap: 8px; align-items: center; }
.meta-record-drawer__btn { padding: 4px 10px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-record-drawer__btn--comment { border-radius: 999px; padding: 3px 8px; }
.meta-record-drawer__btn--comment.meta-record-drawer__btn--comment--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-record-drawer__btn--comment.meta-record-drawer__btn--comment--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-record-drawer__btn--danger { color: #f56c6c; border-color: #f56c6c; }
.meta-record-drawer__btn--watch { border-color: #bfdbfe; color: #1d4ed8; background: #eff6ff; }
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
.meta-record-drawer__field { margin-bottom: 14px; }
.meta-record-drawer__field-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.meta-record-drawer__label { display: block; font-size: 12px; color: #999; }
.meta-record-drawer__ai-actions { display: inline-flex; gap: 4px; margin-left: auto; }
.meta-record-drawer__ai-btn { padding: 1px 8px; border: 1px solid #c7d2fe; border-radius: 999px; background: #eef2ff; color: #4338ca; cursor: pointer; font-size: 11px; }
.meta-record-drawer__ai-btn--run { border-color: #a7f3d0; background: #ecfdf5; color: #047857; }
.meta-record-drawer__ai-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-record-drawer__ai-status { margin-top: 4px; font-size: 11px; color: #4338ca; }
.meta-record-drawer__ai-status--error { color: #b91c1c; }
.meta-record-drawer__ai-output { margin-top: 4px; padding: 6px 8px; border: 1px dashed #c7d2fe; border-radius: 6px; background: #f8faff; font-size: 12px; color: #334155; white-space: pre-wrap; word-break: break-word; }
.meta-record-drawer__comment-anchor { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 24px; padding: 0 6px; border: 1px solid #d8e1ee; border-radius: 999px; background: #fff; cursor: pointer; color: #64748b; }
.meta-record-drawer__comment-anchor:hover { border-color: #93c5fd; background: #eff6ff; color: #2563eb; }
.meta-record-drawer__comment-anchor--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-record-drawer__comment-anchor--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-record-drawer__input { width: 100%; padding: 4px 8px; border: 1px solid #ddd; border-radius: 3px; font-size: 13px; }
.meta-record-drawer__input--multi { min-height: 96px; }
.meta-record-drawer__textarea {
  width: 100%; min-height: 104px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 3px;
  font-size: 13px; line-height: 1.45; resize: vertical; white-space: pre-wrap;
}
.meta-record-drawer__check { cursor: pointer; }
.meta-record-drawer__link-btn { padding: 4px 10px; border: 1px solid #409eff; border-radius: 3px; background: #ecf5ff; color: #409eff; cursor: pointer; font-size: 12px; }
/* B1-e button field (record drawer); mirrors the B1-b grid cell variants. */
.meta-record-drawer__button { display: inline-flex; align-items: center; max-width: 100%; padding: 4px 12px; font-size: 13px; line-height: 18px; border: 1px solid transparent; border-radius: 4px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-record-drawer__button:disabled { opacity: 0.6; cursor: default; }
.meta-record-drawer__button--primary { background: #2563eb; color: #fff; }
.meta-record-drawer__button--secondary { background: #f1f5f9; color: #1f2937; border-color: #cbd5e1; }
.meta-record-drawer__button--danger { background: #ef4444; color: #fff; }
.meta-record-drawer__link-summary { margin-top: 6px; font-size: 12px; color: #606266; }
.meta-record-drawer__attachments { display: flex; flex-direction: column; gap: 6px; }
.meta-record-drawer__attachment-add { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.meta-record-drawer__file-input { font-size: 12px; }
.meta-record-drawer__attachment-hint { font-size: 12px; color: #606266; }
.meta-record-drawer__attachment-clear { border: none; background: none; color: #e67e22; cursor: pointer; font-size: 12px; }
.meta-record-drawer__attachment-clear:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-record-drawer__uploading { font-size: 12px; color: #409eff; }
.meta-record-drawer__error { color: #f56c6c; font-size: 12px; }
.meta-record-drawer__text { font-size: 13px; color: #333; white-space: pre-wrap; word-break: break-word; }
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

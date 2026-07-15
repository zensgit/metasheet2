<!--
  W2 S1 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
  §2 组件表, §7 S1): behavior-equivalent extraction of MetaRecordDrawer.vue's `details` tab body
  (pre-extraction file: L75-312 — visibleFields loop + all field editors + per-field AI shortcut +
  per-field comment anchor). This component receives the SAME props the details branch consumed
  in the drawer and re-emits patch/ai-preview/ai-run/comment-field/open-link-picker/
  open-person-picker/run-button UPWARD UNCHANGED (identical event names + payload shapes) — the
  drawer relays them 1:1 to its own parent, so the workbench's existing listeners need no changes.

  HI-1 (zero new data paths): this panel makes NO fetches — every value it renders comes from props
  already passed into the pre-extraction drawer (record/fields/fieldPermissions/
  attachmentSummariesByField/etc.). `visibleFields` (the field-mask filter) and `canEditField` are
  moved VERBATIM from the drawer — masking is load-bearing (history-field-mask class of bugs) and is
  not touched here.

  `formatValue` / `textControlValue` / `resolvedCanComment` were intentionally DUPLICATED (not moved)
  from MetaRecordDrawer.vue at S1 time. W2 S2 (design-lock §7 S2, helper-dedup note) hoisted all three
  into `../utils/recordDisplay.ts` -- this panel now delegates to that shared module (same local
  wrapper names, template below untouched) instead of owning its own copy. Byte-identical logic, no
  behavior change; the drawer's own copies (only used by its now-extracted history tab) are removed.
-->
<template>
  <div v-if="record" class="meta-record-drawer__fields">
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
  MetaRowActions,
} from '../types'
import MetaAttachmentList from './MetaAttachmentList.vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import MetaRichLongTextRender from './cells/MetaRichLongTextRender.vue'
import MetaRichLongTextEditor from './cells/MetaRichLongTextEditor.vue'
import { isRichLongTextField } from '../utils/rich-longtext'
import {
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
} from '../utils/comment-affordance'
import { attachmentAcceptAttr, resolveAttachmentFieldProperty, resolveButtonFieldProperty, shouldReplaceAttachmentSelection, validateAttachmentSelection } from '../utils/field-config'
import { linkActionLabel } from '../utils/link-fields'
import { useLocale } from '../../composables/useLocale'
import {
  recordLabel,
  commentOnField,
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
  locationAddressValue,
  locationValueFromAddress,
} from '../utils/field-display'
import { isSystemField } from '../utils/system-fields'
import { qrSvgFromText } from '../utils/qr-code'
import {
  formatRecordFieldValue,
  resolveCanComment,
  textControlValue as textControlValueShared,
} from '../utils/recordDisplay'

const props = withDefaults(defineProps<{
  record?: MetaRecord | null
  fields: MetaField[]
  canEdit: boolean
  canComment: boolean
  fieldPermissions?: Record<string, MetaFieldPermission> | null
  rowActions?: MetaRowActions | null
  commentPresence?: MultitableCommentPresenceSummary | null
  linkSummariesByField?: Record<string, LinkedRecordSummary[]>
  personSummariesByField?: Record<string, PersonSummary[]>
  attachmentSummariesByField?: Record<string, MetaAttachment[]>
  uploadFn?: MetaAttachmentUploadFn
  deleteAttachmentFn?: MetaAttachmentDeleteFn
  /** A3: shared AI shortcut UI state from the workbench useAiShortcut instance. */
  aiShortcut?: AiShortcutState | null
  /** B1-e: in-flight button runs keyed `${recordId}:${fieldId}` — the SAME ref
   *  the grid (MetaGridTable) and the drawer receive, so a run from any surface
   *  disables the button on all of them. Matches the workbench `onRunButton`
   *  pending-key format. */
  buttonRunPending?: string[]
  /** B5: people-mention candidates for rich-`longText` field editing.
   *  Fed by the workbench's already-loaded commentMentionSuggestions (no re-fetch). */
  mentionSuggestions?: MetaCommentMentionSuggestion[]
}>(), {
  buttonRunPending: () => [],
})

const emit = defineEmits<{
  (e: 'patch', fieldId: string, value: unknown): void
  (e: 'comment-field', field: MetaField): void
  (e: 'open-link-picker', field: MetaField): void
  (e: 'open-person-picker', field: MetaField): void
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

const attachmentActivity = ref<Record<string, 'uploading' | 'removing' | 'clearing'>>({})
const attachmentErrors = ref<Record<string, string>>({})
const localAttachmentSummaries = ref<Record<string, Record<string, MetaAttachment>>>({})

watch(() => props.record, () => {
  attachmentActivity.value = {}
  attachmentErrors.value = {}
  localAttachmentSummaries.value = {}
})

const visibleFields = computed(() => props.fields.filter((field) => props.fieldPermissions?.[field.id]?.visible !== false))
const resolvedCanComment = computed(() => resolveCanComment(props.rowActions, props.canComment))

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

function formatValue(field: MetaField, v: unknown): string {
  return formatRecordFieldValue(field, v, {
    linkSummariesByField: props.linkSummariesByField,
    personSummariesByField: props.personSummariesByField,
    attachmentSummariesByField: props.attachmentSummariesByField,
    isZh: isZh.value,
  })
}

function textControlValue(value: unknown): string {
  return textControlValueShared(value)
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
.meta-record-drawer__comment-anchor--active { border-color: var(--ms-color-comment-active-border); background: var(--ms-color-comment-active-bg); color: var(--ms-color-comment-active-text); }
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
</style>

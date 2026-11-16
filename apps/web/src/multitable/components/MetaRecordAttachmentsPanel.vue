<!--
  W2 S5 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
  §2 组件表 "附件面板" row, §5, §7 S5, §8): the NEW 4th inspector tab. Unlike S1/S2/S4 (behavior-
  equivalent EXTRACTIONS of pre-existing drawer/second-drawer bodies), this panel has no origin
  component — today attachments only render inline, per-field, inside MetaRecordFieldsPanel.vue's
  `details` tab (lock §2: "唯一真·新建"). This component AGGREGATES every visible attachment field's
  attachments into one view, reusing MetaAttachmentList for rendering and the SAME `uploadFn`/
  `deleteAttachmentFn` the fields panel already receives (HI-1: zero new fetch, see below).

  THE MASK CONTRACT (owner Medium-3, lock §2 附件面板 row + §8.3 negative goldens — this is the
  security-critical part of this slice):
    iteration source = `visibleAttachmentFields` = fields that are visible at BOTH
      - layer-2 (property-hidden: `field.property.hidden`/`property.visible===false`, via the shared
        `filterPropertyVisibleFields` helper — the SAME one MultitableWorkbench.vue's own
        `twoLayerVisibleFields` computed uses for History Center / TrashModal's identical two-layer
        concern, see that file's comment at scopedAllFields/twoLayerVisibleFields), AND
      - layer-3 (RBAC field-mask: `fieldPermissions[field.id].visible !== false`, the same per-field
        permission map every other panel in this inspector already mirrors — MetaRecordFieldsPanel.vue's
        own `visibleFields`, MetaLinkedRecordPopover.vue, MetaFormView.vue all filter this exact way).
  This panel does INTENTIONALLY MORE than MetaRecordFieldsPanel.vue's `visibleFields` (which only
  applies layer-3, a pre-existing, out-of-scope-for-this-slice gap in that already-frozen S1
  extraction) — the design lock names BOTH layers explicitly for the attachments panel because it is
  new-build, not verbatim extraction, so this is a deliberate, lock-mandated asymmetry, not a
  regression to match.
  It MUST NOT (owner Medium-3, refuted by construction below):
    - iterate `props.fields` unfiltered, NOR
    - enumerate `Object.keys(props.attachmentSummariesByField)` directly — those keys are populated by
      the record fetch independent of the field mask and CAN include a field this actor cannot see,
      which would render that field's attachments = a mask bypass.
  Two mandatory negative goldens (lock §8.3, pinned in multitable-record-attachments-panel.spec.ts):
    (N1) a property-hidden (layer-2) attachment field's attachments do NOT render.
    (N2) an RBAC-denied (layer-3) attachment field's attachments do NOT render.
  Plus a positive control: the same field made visible on both layers DOES render (proves N1/N2 are
  not vacuous — the panel can render attachments at all).

  HI-1 (zero new data paths): this panel makes NO fetches of its own. It reads ONLY
  `props.attachmentSummariesByField` — the SAME prop already threaded into the inspector/drawer today
  (populated by the existing gated record fetch, lock §5 "复用 attachmentSummariesByField...零新
  fetch") — and calls ONLY the existing `uploadFn`/`deleteAttachmentFn` (same functions
  MetaRecordFieldsPanel.vue already receives and calls; MultitableWorkbench.vue's
  `uploadAttachmentFn`/`deleteAttachmentFn` are unchanged, only a second consumer). Download URLs are
  whatever `MetaAttachment.url`/`thumbnailUrl` the existing F2 gated signing already put on each
  summary — this panel does not construct or resolve any URL itself. Mutating intents (upload/remove)
  are `emit('patch', fieldId, value, recordId)` — the SAME emit name/payload shape MetaRecordFieldsPanel.vue
  already uses for an attachment write, which the inspector shell forwards 1:1 to the workbench's existing `onDrawerPatch`
  (same `patchCell` path as every other field edit) — no new mutation surface either.

  Local `attachmentActivity`/`attachmentErrors`/`localAttachmentSummaries` state below mirrors
  MetaRecordFieldsPanel.vue's per-field attachment bookkeeping (upload-in-flight indicator, per-field
  error text, an optimistic overlay so a just-uploaded attachment appears before the next
  attachmentSummariesByField refresh) — same shape, independently held per panel instance (this is
  UI-only local state, not a data path).
-->
<template>
  <div class="meta-record-attachments-panel">
    <div
      v-if="!visibleAttachmentFields.length"
      class="meta-record-attachments-panel__empty"
      data-test="attachments-panel-empty"
    >{{ lc('cell.noAttachments') }}</div>
    <div v-else class="meta-record-attachments-panel__groups">
      <div
        v-for="field in visibleAttachmentFields"
        :key="field.id"
        class="meta-record-attachments-panel__group"
        data-test="attachments-panel-group"
        :data-field-id="field.id"
      >
        <div class="meta-record-attachments-panel__group-header">{{ field.name }}</div>
        <MetaAttachmentList
          :attachments="attachmentItems(field.id)"
          :removable="canEditField(field.id)"
          :empty-label="lc('cell.noAttachments')"
          @remove="onRemoveAttachment(field.id, $event)"
        />
        <div v-if="canEditField(field.id)" class="meta-record-attachments-panel__add">
          <input
            type="file"
            :multiple="attachmentAllowsMultiple(field)"
            :accept="attachmentAccept(field)"
            class="meta-record-attachments-panel__file-input"
            :disabled="!!attachmentActivity[field.id]"
            @change="onFileSelect(field.id, $event)"
          />
          <span v-if="attachmentActivity[field.id]" class="meta-record-attachments-panel__uploading">
            {{ attachmentActivityLabel(attachmentActivity[field.id] || 'uploading', isZh) }}
          </span>
        </div>
        <div v-if="attachmentErrors[field.id]" class="meta-record-attachments-panel__error">{{ attachmentErrors[field.id] }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  MetaAttachment,
  MetaAttachmentDeleteFn,
  MetaAttachmentUploadFn,
  MetaField,
  MetaFieldPermission,
  MetaRecord,
  MetaRowActions,
} from '../types'
import MetaAttachmentList from './MetaAttachmentList.vue'
import {
  attachmentAcceptAttr,
  resolveAttachmentFieldProperty,
  shouldReplaceAttachmentSelection,
  validateAttachmentSelection,
} from '../utils/field-config'
import { filterPropertyVisibleFields, isFieldAlwaysReadOnly } from '../utils/field-permissions'
import { isSystemField } from '../utils/system-fields'
import { useLocale } from '../../composables/useLocale'
import { attachmentActivityLabel, metaCoreLabel, type MetaCoreLabelKey } from '../utils/meta-core-labels'

const props = defineProps<{
  record?: MetaRecord | null
  fields: MetaField[]
  canEdit: boolean
  fieldPermissions?: Record<string, MetaFieldPermission> | null
  rowActions?: MetaRowActions | null
  attachmentSummariesByField?: Record<string, MetaAttachment[]>
  uploadFn?: MetaAttachmentUploadFn
  deleteAttachmentFn?: MetaAttachmentDeleteFn
}>()

const emit = defineEmits<{
  /** `recordId`, `removed` and `added`: the record the write was made on, the ids a remove that ended after the
   *  drawer moved on took out, and the ids an upload added (as in MetaRecordFieldsPanel.vue). */
  (e: 'patch', fieldId: string, value: unknown, recordId?: string, removed?: string[], added?: string[]): void
}>()

const { isZh } = useLocale()
const lc = (key: MetaCoreLabelKey) => metaCoreLabel(key, isZh.value)

const attachmentActivity = ref<Record<string, 'uploading' | 'removing'>>({})
const attachmentErrors = ref<Record<string, string>>({})
const localAttachmentSummaries = ref<Record<string, Record<string, MetaAttachment>>>({})

watch(() => props.record, () => {
  attachmentActivity.value = {}
  attachmentErrors.value = {}
  localAttachmentSummaries.value = {}
})

// THE MASK CONTRACT — see file-header comment. filterPropertyVisibleFields (layer-2) intersected with
// fieldPermissions[id].visible !== false (layer-3), filtered to attachment-type fields. This is the
// iteration source for the whole panel; nothing else in this file reads `props.fields` unfiltered or
// enumerates attachmentSummariesByField keys.
const visibleAttachmentFields = computed(() =>
  filterPropertyVisibleFields(props.fields).filter(
    (field) => field.type === 'attachment' && props.fieldPermissions?.[field.id]?.visible !== false,
  ),
)

// B4 (W2 S5 re-port, refs #4267 continuation): `!isFieldAlwaysReadOnly(field)` is ADDITIVE to
// `fieldPermissions?.[fieldId]?.readOnly !== true` — same defense-in-depth rationale as
// MetaRecordFieldsPanel.vue's canEditField (this panel's copy of the same helper, S5 new-build per
// the file header, aggregating attachment fields into a 4th tab). Kept in parity with the fields
// panel's gate so an attachment field flagged readonly/mirrorOf cannot be edited from this surface
// either, even before/without a fresh server round trip.
function canEditField(fieldId: string): boolean {
  const field = props.fields.find((item) => item.id === fieldId) ?? null
  return props.canEdit
    && props.rowActions?.canEdit !== false
    && props.fieldPermissions?.[fieldId]?.readOnly !== true
    && !isSystemField(field)
    && !isFieldAlwaysReadOnly(field)
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

function attachmentAccept(field: MetaField): string | undefined {
  return attachmentAcceptAttr(field)
}

function attachmentAllowsMultiple(field: MetaField): boolean {
  return resolveAttachmentFieldProperty(field.property).maxFiles !== 1
}

function setAttachmentActivity(fieldId: string, activity?: 'uploading' | 'removing') {
  const next = { ...attachmentActivity.value }
  if (activity) next[fieldId] = activity
  else delete next[fieldId]
  attachmentActivity.value = next
}

function setAttachmentError(fieldId: string, message: string) {
  attachmentErrors.value = { ...attachmentErrors.value, [fieldId]: message }
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

async function onFileSelect(fieldId: string, e: Event) {
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
  // The drawer can move to another record while the upload runs: every file and the patch go to the record it
  // started on, and this panel's state (the shown record's) is touched only while that record is still shown.
  const recordId = props.record?.id
  const shown = () => props.record?.id === recordId
  setAttachmentActivity(fieldId, 'uploading')
  try {
    const existing = attachmentList(fieldId)
    const replaceExisting = field ? shouldReplaceAttachmentSelection(field, files, existing.length) : false
    const newIds: string[] = []
    for (const file of Array.from(files)) {
      const attachment = await props.uploadFn(file, {
        recordId,
        fieldId,
      })
      if (shown()) rememberLocalAttachment(fieldId, attachment)
      newIds.push(attachment.id)
    }
    // An upload that adds to the list names the ids it added: the list may have changed while it ran (an attachment
    // added from elsewhere), and the listener adds them to the list as it is now. One that replaces the list is the
    // new list as it is.
    if (replaceExisting) emit('patch', fieldId, newIds, recordId)
    else emit('patch', fieldId, [...existing, ...newIds], recordId, undefined, newIds)
  } catch (error: any) {
    if (shown()) setAttachmentError(fieldId, error?.message ?? lc('cell.uploadFailed'))
  } finally {
    if (shown()) setAttachmentActivity(fieldId)
    input.value = ''
  }
}

async function onRemoveAttachment(fieldId: string, attachmentId: string) {
  clearAttachmentError(fieldId)
  // As for an upload: the delete and the patch belong to the record it started on.
  const recordId = props.record?.id
  const shown = () => props.record?.id === recordId
  const started = attachmentList(fieldId)
  if (props.deleteAttachmentFn) {
    setAttachmentActivity(fieldId, 'removing')
    try {
      await props.deleteAttachmentFn(attachmentId, {
        recordId,
        fieldId,
      })
    } catch (error: any) {
      if (shown()) {
        setAttachmentError(fieldId, error?.message ?? lc('cell.removeFailed'))
        setAttachmentActivity(fieldId)
      }
      return
    }
    if (shown()) setAttachmentActivity(fieldId)
  }
  // Still shown: its list as it is now (the reload after the delete may have refreshed it). Otherwise this panel's
  // record is another one by now: the list it started from, and the removed id with it (`removed` above).
  if (shown()) {
    emit('patch', fieldId, attachmentList(fieldId).filter((id) => id !== attachmentId), recordId)
    forgetLocalAttachment(fieldId, attachmentId)
  } else {
    emit('patch', fieldId, started.filter((id) => id !== attachmentId), recordId, [attachmentId])
  }
}
</script>

<style scoped>
.meta-record-attachments-panel__empty { padding: 8px 0; color: #999; font-size: 12px; }
.meta-record-attachments-panel__groups { display: flex; flex-direction: column; gap: 18px; }
.meta-record-attachments-panel__group { display: flex; flex-direction: column; gap: 6px; }
.meta-record-attachments-panel__group-header { font-size: 12px; font-weight: 600; color: #475569; }
.meta-record-attachments-panel__add { display: flex; align-items: center; gap: 8px; }
.meta-record-attachments-panel__file-input { font-size: 12px; max-width: 100%; }
.meta-record-attachments-panel__uploading { font-size: 11px; color: #64748b; }
.meta-record-attachments-panel__error { font-size: 11px; color: #b91c1c; }
</style>

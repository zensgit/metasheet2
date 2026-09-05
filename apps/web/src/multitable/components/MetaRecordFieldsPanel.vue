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

  Record inspector v3 (design 2026-09-05, docs/development/multitable-record-inspector-v3-design-20260905.md
  §1.3 body, PR-B1) — additive, all prop-gated or FP-local:
  - SECTIONS: when the optional `inspectorFieldLayout` prop is present the field list renders as two
    `MetaRecordFieldSection`s — §1 `ordered` (view order ∩ layer-2 ∩ layer-3, expanded, headerless
    when §2 is empty) and §2 `hiddenInView` (collapsed by default, `recordHiddenFieldsHeading(n)`).
    Both lists are re-filtered here through BOTH visibility layers (`filterPropertyVisibleFields` ∩
    `fieldPermissions[id].visible !== false`) — the same mask contract MetaRecordAttachmentsPanel.vue
    applies, negative golden N3: a property-hidden field present in `fields` never renders on this
    path. Applying layer-2 to the details tab is a DECLARED behaviour change (design §4 item 4).
    Prop ABSENT → today's flat `visibleFields` path (layer-3 only), byte-for-byte: the deprecated
    MetaRecordDrawer shell and every router-less spec keep rendering exactly what they did.
  - HIDE EMPTY (`hideEmpty` prop, state owned by the inspector, session-only): predicate = the ONE
    exported `isEmptyValue` (conditional-formatting.ts) that field-display.ts's empty glyph also
    calls, so "renders '—'" and "hidden by the toggle" are the same set by construction. The empty
    set is SNAPSHOTTED on record-id / toggle change (`emptySnapshot`), never recomputed live, so a
    value being cleared mid-edit cannot vanish under the cursor. Five exemptions are evaluated live
    (see `isHideEmptyExempt`, each names its exact predicate): primary field, focused field, field
    with AI status/output, field with comment presence, field with a pending server error.
  - LINK CHIPS: the read-only comma-joined link summary is now `MetaCellRenderer` (the grid's own
    chip host) with `fetchRecord` threaded WB → INS → here; chips are clickable and open the existing
    `MetaLinkedRecordPopover` iff the host supplied `fetchRecord` (HI-1: same `getRecord` read the
    grid already makes, second host, NO new fetch path in this file — this panel still calls nothing).
    The `open-link-picker` button stays beside the chips (`record.editLinks` copy once chips show).
  - ATTACHMENTS: CSS-only 3-up gallery at ≥480px CONTAINER width (see the `@container` rule in the
    style block; MetaAttachmentList itself is untouched).
  - KEYBOARD (FP-local, delegated from this root — never the inspector's root dispatcher, never the
    grid): plain `<textarea>` mod+Enter → `blur()` (native `change` → exactly one `patch`, the same
    commit path as MetaRichLongTextEditor's mod+Enter); Enter on a single-line scalar `<input>`
    commits (focus moves → native `change`) and advances to the next editable control, Shift+Enter to
    the previous; `<textarea>` bare Enter (newline) and `<select>` are untouched.
-->
<template>
  <div
    v-if="record"
    ref="fieldsRootRef"
    class="meta-record-drawer__fields"
    @focusin="onFieldsFocusIn"
    @focusout="onFieldsFocusOut"
    @keydown="onFieldsKeydown"
  >
    <MetaRecordFieldSection
      v-for="group in fieldGroups"
      :key="group.key"
      :section-key="group.key"
      :heading="group.heading"
      :default-expanded="group.defaultExpanded"
    >
      <div v-for="field in group.fields" :key="field.id" class="meta-record-drawer__field" :data-field-id="field.id">
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
          <!-- plain longText: same textarea, same @change-only commit (record inspector resizable-panel
               slice, 2026-09-05) -- `rows="6"` (was 5) is a comfort bump now that the panel itself can be
               widened/lengthened; `resize: vertical` (unchanged, see the style rule below) still lets a
               viewer grow it further by hand. -->
          <textarea
            v-else-if="canEditField(field.id) && field.type === 'longText'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__textarea"
            :value="textControlValue(record.data[field.id])"
            rows="6"
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
          <!-- Record inspector v3 (PR-B1 §1.3 link chips): a link field WITH linked records renders
               chips (the MetaCellRenderer block below) instead of this joined text; an EMPTY link
               field still falls through here and shows the shared empty glyph. -->
          <span v-else-if="field.type !== 'link' || linkSummaryCount(field.id) === 0" class="meta-record-drawer__text">{{ formatValue(field, record.data[field.id]) }}</span>
          <div
            v-if="field.type === 'qrcode' && drawerQrSvg(record.data[field.id])"
            class="meta-record-drawer__qrcode"
            v-html="drawerQrSvg(record.data[field.id])"
          />
          <!-- A3 follow-up (#2708) CLOSED by record inspector v3 (PR-B1 §1.3 "Link chips"): the
               former read-only comma-joined summary is now the grid's own chip host, MetaCellRenderer.
               `fetchRecord` (WB `fetchLinkedRecordFn` → INS → this prop) makes a real linked-record
               chip clickable and opens the existing MetaLinkedRecordPopover (nesting cap 1 is
               structural in that component — it never threads fetchRecord inward). Host did not pass
               `fetchRecord` (deprecated MetaRecordDrawer shell, router-less specs) → plain text chips,
               no click affordance, zero fetches (HI-1: this panel itself still fetches nothing). -->
          <div v-if="field.type === 'link' && linkSummaryCount(field.id) > 0" class="meta-record-drawer__link-summary" :data-link-chips="field.id">
            <MetaCellRenderer
              :field="field"
              :value="record.data[field.id]"
              :link-summaries="linkSummariesByField?.[field.id]"
              :person-summaries="personSummariesByField?.[field.id]"
              :attachment-summaries="attachmentSummariesByField?.[field.id]"
              :fetch-record="fetchRecord"
            />
          </div>
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
    </MetaRecordFieldSection>
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
  MetaRecordContext,
  MetaRowActions,
} from '../types'
import MetaAttachmentList from './MetaAttachmentList.vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import MetaRecordFieldSection from './MetaRecordFieldSection.vue'
import MetaCellRenderer from './cells/MetaCellRenderer.vue'
import MetaRichLongTextRender from './cells/MetaRichLongTextRender.vue'
import MetaRichLongTextEditor from './cells/MetaRichLongTextEditor.vue'
import { isRichLongTextField } from '../utils/rich-longtext'
import {
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
} from '../utils/comment-affordance'
import { attachmentAcceptAttr, resolveAttachmentFieldProperty, resolveButtonFieldProperty, shouldReplaceAttachmentSelection, validateAttachmentSelection } from '../utils/field-config'
import { isPersonField, linkActionLabel } from '../utils/link-fields'
import { useLocale } from '../../composables/useLocale'
import {
  recordLabel,
  recordHiddenFieldsHeading,
  commentOnField,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'
import { isEmptyValue } from '../utils/conditional-formatting'
import { filterPropertyVisibleFields } from '../utils/field-permissions'
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
import { qrSvgFromText } from '../utils/qr-code'
import {
  canEditField as canEditFieldShared,
  formatRecordFieldValue,
  resolveCanComment,
  resolvePrimaryField,
  textControlValue as textControlValueShared,
  type MetaRecordInspectorFieldLayout,
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
  /** Record inspector v3 (PR-B1 §1.3 sections): workbench-computed `{ ordered, hiddenInView }`. ABSENT →
   *  the legacy flat `fields` path (deprecated MetaRecordDrawer consumers, router-less specs). */
  inspectorFieldLayout?: MetaRecordInspectorFieldLayout | null
  /** Record inspector v3 (PR-B1 §1.3 hide-empty): the inspector's session-only toggle state. */
  hideEmpty?: boolean
  /** Record inspector v3 (PR-B1 §1.3 link chips, HI-1): the workbench's existing `fetchLinkedRecordFn`
   *  (`client.getRecord`, the SAME function MetaGridTable already receives) passed through INS. Only
   *  ever handed to MetaCellRenderer — this panel never calls it. Absent → chips are not clickable. */
  fetchRecord?: (recordId: string) => Promise<MetaRecordContext>
}>(), {
  buttonRunPending: () => [],
  inspectorFieldLayout: null,
  hideEmpty: false,
  fetchRecord: undefined,
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

// Legacy flat path (prop `inspectorFieldLayout` absent): layer-3 only, VERBATIM from W2 S1 — the
// load-bearing field mask the deprecated MetaRecordDrawer shell and router-less specs depend on.
const visibleFields = computed(() => props.fields.filter((field) => props.fieldPermissions?.[field.id]?.visible !== false))
const resolvedCanComment = computed(() => resolveCanComment(props.rowActions, props.canComment))

// --- Record inspector v3 (PR-B1 §1.3 sections) -----------------------------------------------------
// Mask contract for the SECTIONS path (mirrors MetaRecordAttachmentsPanel.vue's iteration source):
// each workbench-supplied list is re-filtered through layer-2 (`filterPropertyVisibleFields`) AND
// layer-3 (`fieldPermissions[id].visible !== false`) before anything reads it. Negative golden N3
// (multitable-record-fields-sections.spec.ts): a property-hidden field present in `fields` AND in
// `ordered` does not render. `hiddenInView` additionally drops anything already in `ordered`
// (fail-soft on a producer that hands the same id to both lists — never a double render).
function isLayer3Visible(field: MetaField): boolean {
  return props.fieldPermissions?.[field.id]?.visible !== false
}
const sectionOrderedFields = computed(() =>
  filterPropertyVisibleFields(props.inspectorFieldLayout?.ordered ?? []).filter(isLayer3Visible),
)
const sectionHiddenInViewFields = computed(() => {
  const orderedIds = new Set(sectionOrderedFields.value.map((field) => field.id))
  return filterPropertyVisibleFields(props.inspectorFieldLayout?.hiddenInView ?? [])
    .filter((field) => isLayer3Visible(field) && !orderedIds.has(field.id))
})

interface FieldGroup {
  key: 'flat' | 'ordered' | 'hidden-in-view'
  heading: string | null
  defaultExpanded: boolean
  fields: MetaField[]
}
// The template's ONE `v-for` source: a list of sections, each carrying the fields it renders (after
// the hide-empty filter). Legacy path = a single headerless group over `visibleFields`. Sections path
// = §1 `ordered` (headerless while §2 is empty, headed + collapsible otherwise) and, only when
// non-empty, §2 `hidden-in-view` (collapsed by default; the heading count is the number of fields
// the section will show when expanded).
const fieldGroups = computed<FieldGroup[]>(() => {
  if (!props.inspectorFieldLayout) {
    return [{ key: 'flat', heading: null, defaultExpanded: true, fields: applyHideEmpty(visibleFields.value) }]
  }
  const ordered = applyHideEmpty(sectionOrderedFields.value)
  const hidden = applyHideEmpty(sectionHiddenInViewFields.value)
  const groups: FieldGroup[] = [{
    key: 'ordered',
    heading: hidden.length > 0 ? l('record.fieldsInView') : null,
    defaultExpanded: true,
    fields: ordered,
  }]
  if (hidden.length > 0) {
    groups.push({
      key: 'hidden-in-view',
      heading: recordHiddenFieldsHeading(hidden.length, isZh.value),
      defaultExpanded: false,
      fields: hidden,
    })
  }
  return groups
})

// --- Record inspector v3 (PR-B1 §1.3 hide-empty) ---------------------------------------------------
// SNAPSHOT, not live: the set of field ids whose value satisfied `isEmptyValue` at the moment the
// record id or the toggle last changed. A value cleared while the toggle is on is NOT in the snapshot,
// so the field stays rendered mid-edit; the next record (or a toggle off→on) re-snapshots.
// `watch` takes an ARRAY OF SOURCES (compared element-wise), deliberately not a single getter
// returning a tuple — that form would re-fire on every same-id record object replacement and turn
// the snapshot back into a live filter.
const emptySnapshot = ref<ReadonlySet<string>>(new Set())
function snapshotEmptyFields() {
  const next = new Set<string>()
  if (props.hideEmpty && props.record) {
    for (const field of props.fields) {
      if (isEmptyValue(props.record.data[field.id])) next.add(field.id)
    }
  }
  emptySnapshot.value = next
}
watch([() => props.record?.id, () => props.hideEmpty], snapshotEmptyFields, { immediate: true })

// Exemptions are evaluated LIVE (a field the snapshot marked empty reappears the moment it becomes
// exempt and hides again when it stops being exempt). Each clause names the exact predicate it
// reuses — none of them is a second definition of anything this file already computes.
function isHideEmptyExempt(field: MetaField): boolean {
  // (1) primary field: `resolvePrimaryField(props.fields)?.id === field.id` — the SAME hoisted helper
  //     MetaRecordInspector.vue titles the record by (utils/recordDisplay.ts), over the same array.
  if (resolvePrimaryField(props.fields)?.id === field.id) return true
  // (2) focused field: `focusedFieldId.value === field.id` — tracked from focusin/focusout on this
  //     panel's root via the row's `data-field-id` (see `onFieldsFocusIn` / `onFieldsFocusOut`).
  if (focusedFieldId.value === field.id) return true
  // (3) AI status/error: `aiStatusTextFor(id) !== '' || aiPreviewOutputFor(id) !== ''` — the exact
  //     two predicates the template uses to render the `__ai-status` / `__ai-output` rows.
  if (aiStatusTextFor(field.id) !== '' || aiPreviewOutputFor(field.id) !== '') return true
  // (4) comment presence: `resolveFieldCommentAffordance(commentPresence, id).isActive` — the exact
  //     predicate that paints the per-field comment anchor `--active` (unresolved or mention count > 0).
  if (recordFieldAffordance(field.id).isActive) return true
  // (5) pending server error: `Boolean(attachmentErrors[id])` — the per-field server-rejection state
  //     this panel holds (an `uploadFn`/`deleteAttachmentFn` rejection, cleared on the next attempt
  //     or on record change). PR-B2's field-anchored PATCH errors (`fieldErrors` prop) join this
  //     clause when they land — same shape, same exemption.
  if (attachmentErrors.value[field.id]) return true
  return false
}
function applyHideEmpty(fields: MetaField[]): MetaField[] {
  if (!props.hideEmpty) return fields
  return fields.filter((field) => !emptySnapshot.value.has(field.id) || isHideEmptyExempt(field))
}

// Focused-field tracking (exemption 2). `focusout` only clears when focus leaves to somewhere that is
// NOT another row of this panel — the following `focusin` on the new row overwrites it anyway.
const fieldsRootRef = ref<HTMLElement | null>(null)
const focusedFieldId = ref<string | null>(null)
function fieldIdFromEventTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>('[data-field-id]')?.dataset.fieldId ?? null
}
function onFieldsFocusIn(event: FocusEvent) {
  focusedFieldId.value = fieldIdFromEventTarget(event.target)
}
function onFieldsFocusOut(event: FocusEvent) {
  if (fieldIdFromEventTarget(event.relatedTarget) === null) focusedFieldId.value = null
}

// --- Record inspector v3 (PR-B1 §1.5 FP-local keyboard) --------------------------------------------
// Delegated from this panel's root. Deliberately NOT on the inspector's root dispatcher
// (`onInspectorKeydown`, which inspects no Enter at all) and structurally unreachable from
// MetaGridTable.onKeydown (a sibling subtree). Only two targets are inspected, both matched by the
// classes this template gives them — every other control (checkbox, file input, `<select>`, the rich
// editor's contenteditable, MetaCellRenderer chips) falls through untouched.
const SINGLE_LINE_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'date', 'datetime-local'])
function onFieldsKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.isComposing || event.altKey) return
  const target = event.target
  const mod = event.metaKey || event.ctrlKey
  if (target instanceof HTMLTextAreaElement && target.classList.contains('meta-record-drawer__textarea')) {
    // Plain textarea: mod+Enter commits by blurring — the native `change` that follows IS the single
    // `patch` (the template's `@change`), mirroring MetaRichLongTextEditor's mod+Enter confirm and
    // MetaRecordInspector's title-input Enter. No `emit` here: emitting AND blurring would patch twice.
    // Bare / Shift+Enter = newline, untouched.
    if (!mod) return
    event.preventDefault()
    target.blur()
    return
  }
  if (
    !mod
    && target instanceof HTMLInputElement
    && target.classList.contains('meta-record-drawer__input')
    && SINGLE_LINE_INPUT_TYPES.has(target.type)
  ) {
    // Single-line scalar control: Enter commits and advances to the next editable control in this
    // panel (Shift+Enter: previous). Moving focus blurs the current input, so its native `change`
    // fires exactly once — again no `emit` here. No neighbour → just blur (commit, stay put).
    event.preventDefault()
    const controls = editableControls()
    const index = controls.indexOf(target)
    const next = index === -1 ? undefined : controls[index + (event.shiftKey ? -1 : 1)]
    if (next) next.focus()
    else target.blur()
  }
}
function editableControls(): HTMLElement[] {
  const root = fieldsRootRef.value
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(
    '.meta-record-drawer__value input:not([disabled]):not([type="file"]), '
    + '.meta-record-drawer__value textarea:not([disabled]), '
    + '.meta-record-drawer__value select:not([disabled]), '
    + '.meta-record-drawer__value [contenteditable="true"]',
  ))
}

// B4 (W2 re-port, refs #4267 continuation): `!isFieldAlwaysReadOnly(field)` is ADDITIVE to
// `fieldPermissions?.[fieldId]?.readOnly !== true` (the server-supplied flag already carrying
// mirror/system/formula/lookup/rollup readOnly) — see the matching comment in
// MetaGridTable.isEditable / apps/web/src/multitable/utils/field-permissions.ts for the
// defense-in-depth rationale. Originally wired in the pre-W2-refactor MetaRecordDrawer.vue
// (canEditField); this function moved VERBATIM here at W2 S1 (see file header). Record inspector v3
// (PR-B1, design §3 file list): the four-clause body is now HOISTED to utils/recordDisplay.ts
// (`canEditField`) so MetaRecordInspector.vue's title-input editability reads the identical rule;
// this local wrapper keeps the by-id signature every template call site already uses.
function canEditField(fieldId: string): boolean {
  const field = props.fields.find((item) => item.id === fieldId) ?? null
  return canEditFieldShared(field, {
    canEdit: props.canEdit,
    rowActions: props.rowActions,
    fieldPermissions: props.fieldPermissions,
  })
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
  // Record inspector v3 (PR-B1 §1.3 link chips): once the chips render the linked records themselves
  // (non-person link, count > 0), the button beside them is the plain `record.editLinks` affordance —
  // the count-bearing `linkActionLabel` copy stays for the empty state ("Choose …", nothing to show
  // as a chip yet) and for person pickers (a different picker, no chips in this slice).
  if (field && field.type === 'link' && !isPersonField(field) && count > 0) return l('record.editLinks')
  return linkActionLabel(field, count, isZh.value)
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
/* min-height bumped 104px -> 132px (record inspector resizable-panel slice, 2026-09-05) to roughly
   match the template's `rows="6"` (was 5) at this font-size/line-height -- `resize: vertical`
   (unchanged) still lets a viewer grow it further by hand; long-text editing is the field type users
   most often complained the old 5-row box felt cramped for. */
.meta-record-drawer__textarea {
  width: 100%; min-height: 132px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 3px;
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
/* Record inspector v3 (PR-B1 §1.3 attachments): this wrapper is the `container-type: inline-size`
   ancestor for the 3-up gallery query below — INS establishes containers only on its toolbar and
   tabs bar, neither of which wraps the fields body. NOT real-browser-verified in this slice's spec
   (jsdom has no container-query layout); multitable-record-fields-sections.spec.ts pins the rule's
   PRESENCE as a source-text provision only, and the design's §3 B1 real-browser line owns the
   layout check ("thumbnails 3-up at ≥480"). */
.meta-record-drawer__attachments { display: flex; flex-direction: column; gap: 6px; container-type: inline-size; }
/* CSS-only 3-up gallery at >=480px CONTAINER width (design §1.3 "Attachments"): MetaAttachmentList is
   used AS IS (its own `.meta-attachment-list__items` stays `flex-wrap` below the threshold — the
   360px mock's "wrap <480"); `:deep()` is required because those classes live inside the child
   component's template, not on its root. */
@container (min-width: 480px) {
  .meta-record-drawer__attachments :deep(.meta-attachment-list__items) {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .meta-record-drawer__attachments :deep(.meta-attachment-list__item) { display: flex; min-width: 0; }
  .meta-record-drawer__attachments :deep(.meta-attachment-list__card) { flex: 1 1 auto; min-width: 0; max-width: none; }
}
.meta-record-drawer__attachment-add { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.meta-record-drawer__file-input { font-size: 12px; }
.meta-record-drawer__attachment-hint { font-size: 12px; color: #606266; }
.meta-record-drawer__attachment-clear { border: none; background: none; color: #e67e22; cursor: pointer; font-size: 12px; }
.meta-record-drawer__attachment-clear:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-record-drawer__uploading { font-size: 12px; color: #409eff; }
.meta-record-drawer__error { color: #f56c6c; font-size: 12px; }
.meta-record-drawer__text { font-size: 13px; color: #333; white-space: pre-wrap; word-break: break-word; }
</style>

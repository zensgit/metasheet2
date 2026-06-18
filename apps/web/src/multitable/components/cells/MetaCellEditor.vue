<template>
  <div class="meta-cell-editor">
    <!-- date field type -->
    <input
      v-if="field.type === 'date'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="date"
      :value="textControlValue(scalarActive ? scalarValue : modelValue)"
      @input="commitScalar(($event.target as HTMLInputElement).value)"
      @keydown.enter="scalarConfirm()"
      @keydown.escape="emit('cancel')"
    />
    <!-- datetime field type -->
    <input
      v-else-if="field.type === 'dateTime'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="datetime-local"
      :value="dateTimeInputValue(scalarActive ? scalarValue : modelValue)"
      @input="commitScalar(dateTimeValueFromLocalInput(($event.target as HTMLInputElement).value))"
      @keydown.enter="scalarConfirm()"
      @keydown.escape="emit('cancel')"
    />
    <!-- string: date-like -->
    <input
      v-else-if="field.type === 'string' && isDateLike"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="date"
      :value="textControlValue(modelValue)"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />
    <!-- string: normal -->
    <div v-else-if="field.type === 'string'" class="meta-cell-editor__text-wrap">
      <input
        ref="inputRef"
        class="meta-cell-editor__input"
        type="text"
        :value="yjsActive ? yjsText : (modelValue ?? '')"
        @input="onTextInput"
        @keydown.enter="onTextConfirm"
        @keydown.escape="emit('cancel')"
      />
      <MetaYjsPresenceChip
        v-if="yjsActive && yjsCollaborators.length > 0"
        class="meta-cell-editor__presence"
        :label="l('cell.editing')"
        :users="yjsCollaborators"
      />
    </div>

    <!-- rich longText: minimal rich editor (server re-sanitizes on write). Forward
         confirm/cancel so the grid host commits (Cmd/Ctrl+Enter) and cancels (Esc),
         matching the plain textarea's commit contract. -->
    <MetaRichLongTextEditor
      v-else-if="field.type === 'longText' && isRichLongTextField(field)"
      :model-value="modelValue"
      :is-zh="isZh"
      :mention-suggestions="mentionSuggestions"
      @update:model-value="emit('update:modelValue', $event)"
      @confirm="emit('confirm')"
      @cancel="emit('cancel')"
    />
    <!-- plain longText: unchanged multiline REST editor -->
    <textarea
      v-else-if="field.type === 'longText'"
      ref="inputRef"
      class="meta-cell-editor__textarea"
      rows="4"
      :value="textControlValue(modelValue)"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @keydown.meta.enter.prevent="emit('confirm')"
      @keydown.ctrl.enter.prevent="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- barcode: text-backed field; scanner/image generation is out of scope. -->
    <input
      v-else-if="field.type === 'barcode'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="text"
      inputmode="text"
      :placeholder="l('cell.barcodePlaceholder')"
      :value="textControlValue(modelValue)"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- qrcode: text-backed source string; the QR image renders read-only in the cell/drawer. -->
    <input
      v-else-if="field.type === 'qrcode'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="text"
      inputmode="text"
      :placeholder="l('cell.qrcodePlaceholder')"
      :value="textControlValue(modelValue)"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- location: address-only editor; coordinates can still be supplied through API. -->
    <input
      v-else-if="field.type === 'location'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="text"
      :placeholder="l('cell.locationPlaceholder')"
      :value="locationAddressValue(modelValue)"
      @input="emit('update:modelValue', locationValueFromAddress(($event.target as HTMLInputElement).value))"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- number -->
    <input
      v-else-if="field.type === 'number'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="number"
      :step="numericStep"
      :value="scalarActive ? (scalarValue ?? '') : (modelValue ?? '')"
      @input="onNumberInput"
      @keydown.enter="scalarConfirm()"
      @keydown.escape="emit('cancel')"
    />

    <!-- boolean -->
    <label v-else-if="field.type === 'boolean'" class="meta-cell-editor__check">
      <input
        type="checkbox"
        :checked="scalarActive ? !!scalarValue : !!modelValue"
        @change="onBooleanChange($event)"
      />
      <span>{{ (scalarActive ? scalarValue : modelValue) ? l('cell.yes') : l('cell.no') }}</span>
    </label>

    <!-- select -->
    <select
      v-else-if="field.type === 'select'"
      ref="inputRef"
      class="meta-cell-editor__select"
      :value="(scalarActive ? scalarValue : modelValue) ?? ''"
      @change="commitScalar(($event.target as HTMLSelectElement).value); scalarConfirm()"
      @keydown.escape="emit('cancel')"
    >
      <option value="">—</option>
      <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">
        {{ opt.value }}
      </option>
    </select>

    <!-- multiSelect -->
    <select
      v-else-if="field.type === 'multiSelect'"
      ref="inputRef"
      class="meta-cell-editor__select meta-cell-editor__select--multi"
      multiple
      :value="multiSelectValue"
      @change="onMultiSelectChange"
      @keydown.meta.enter.prevent="scalarConfirm()"
      @keydown.ctrl.enter.prevent="scalarConfirm()"
      @keydown.escape="emit('cancel')"
    >
      <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">
        {{ opt.value }}
      </option>
    </select>

    <!-- link -->
    <button
      v-else-if="field.type === 'link'"
      class="meta-cell-editor__link-btn"
      @click="emit('open-link-picker')"
    >{{ linkButtonLabel }}</button>

    <!-- native person (人员): member-scoped picker (userId[]) — distinct from the link picker -->
    <button
      v-else-if="field.type === 'person'"
      class="meta-cell-editor__link-btn"
      data-test="person-picker-open"
      @click="emit('open-person-picker')"
    >{{ personButtonLabel }}</button>

    <!-- currency / percent: numeric input with field-specific step -->
    <input
      v-else-if="field.type === 'currency' || field.type === 'percent'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="number"
      :step="numericStep"
      :value="scalarActive ? (scalarValue ?? '') : (modelValue ?? '')"
      @input="onNumberInput"
      @keydown.enter="scalarConfirm()"
      @keydown.escape="emit('cancel')"
    />

    <!-- duration: format-aware text (h:mm / mm:ss) parsed to seconds. A LOCAL
         buffer (durationText), seeded once from modelValue, drives the input so
         the displayed value is never reformatted under the cursor while typing.
         @input parses the buffer → emits seconds; the buffer itself is the
         source of the visible text. -->
    <input
      v-else-if="field.type === 'duration'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="text"
      inputmode="numeric"
      :placeholder="durationFormat"
      :value="durationText"
      @input="onDurationInput"
      @keydown.enter="durationConfirm()"
      @keydown.escape="emit('cancel')"
    />

    <!-- rating: click-to-set stars -->
    <div v-else-if="field.type === 'rating'" class="meta-cell-editor__rating">
      <button
        v-for="n in ratingMax"
        :key="n"
        type="button"
        class="meta-cell-editor__rating-star"
        :class="{ 'meta-cell-editor__rating-star--filled': n <= ratingValue }"
        @click="onRatingPick(n)"
      >★</button>
      <button
        v-if="ratingValue > 0"
        type="button"
        class="meta-cell-editor__rating-clear"
        @click="onRatingPick(0)"
      >{{ l('cell.clear') }}</button>
    </div>

    <!-- url / email / phone: validated text input -->
    <input
      v-else-if="field.type === 'url'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="url"
      placeholder="https://example.com"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />
    <input
      v-else-if="field.type === 'email'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="email"
      placeholder="name@example.com"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />
    <input
      v-else-if="field.type === 'phone'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="tel"
      placeholder="+86 138 0000 0000"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- attachment -->
    <div v-else-if="field.type === 'attachment'" class="meta-cell-editor__attachment">
      <MetaAttachmentList
        :attachments="attachmentItems"
        removable
        :empty-label="l('cell.noAttachments')"
        @remove="onRemoveAttachment"
      />
      <div class="meta-cell-editor__attachment-actions">
        <label class="meta-cell-editor__file-trigger">
          <input
            ref="inputRef"
            type="file"
            :multiple="attachmentAllowsMultiple"
            :accept="attachmentAcceptAttrValue"
            class="meta-cell-editor__file-input"
            :disabled="!!attachmentActivity || uploading"
            @change="onFileSelect"
            @keydown.escape="emit('cancel')"
          />
          <span
            class="meta-cell-editor__file-trigger-label"
            @dragover.prevent
            @drop.prevent="onFileDrop"
          >{{ attachmentActionHint }}</span>
        </label>
        <button
          type="button"
          class="meta-cell-editor__clear-btn"
          :disabled="!attachmentIds.length || !!attachmentActivity || uploading"
          @click="clearAttachments"
        >
          {{ l('cell.clearAll') }}
        </button>
      </div>
      <div v-if="attachmentActivity" class="meta-cell-editor__uploading">
        {{ attachmentActivity ? attachmentActivityLabel(attachmentActivity, isZh) : '' }}
      </div>
      <div v-if="attachmentError" class="meta-cell-editor__error">{{ attachmentError }}</div>
    </div>

    <!-- readonly fallback -->
    <span v-else class="meta-cell-editor__readonly">{{ readonlyDisplayValue }}</span>

    <!--
      A3-T6: edit-mode AI run trigger (link-btn precedent).
      RBAC INVARIANT (LOCKED A3 §2.2): this button's safety relies on the
      upstream invariant that the cell editor only opens for cells the actor
      can edit — MetaCellEditor has NO fieldPermissions of its own. Any
      follow-up that moves this button OUTSIDE the edit mode MUST wire
      explicit fieldPermissions gating. Hosts opt in via `aiRunState`
      (only MetaGridTable does; MetaBulkEditDialog stays untouched).
    -->
    <button
      v-if="aiRunVisible"
      type="button"
      class="meta-cell-editor__link-btn meta-cell-editor__ai-run"
      :disabled="aiRunState?.pending || aiRunState?.busy"
      data-test="cell-ai-run"
      @click="emit('ai-run')"
    >{{ aiRunState?.pending ? l('cell.aiRunning') : l('cell.aiRun') }}</button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, toRef } from 'vue'
import type { MetaAttachment, MetaAttachmentDeleteFn, MetaAttachmentUploadContext, MetaAttachmentUploadFn, MetaCommentMentionSuggestion, MetaField } from '../../types'
import MetaAttachmentList from '../MetaAttachmentList.vue'
import MetaYjsPresenceChip from '../MetaYjsPresenceChip.vue'
import MetaRichLongTextEditor from './MetaRichLongTextEditor.vue'
import { isRichLongTextField } from '../../utils/rich-longtext'
import {
  attachmentAcceptAttr,
  durationSecondsFromInput,
  formatDurationValue,
  resolveAttachmentFieldProperty,
  resolveCurrencyFieldProperty,
  resolveDurationFieldProperty,
  resolveNumberFieldProperty,
  resolvePercentFieldProperty,
  resolveRatingFieldProperty,
  shouldReplaceAttachmentSelection,
  validateAttachmentSelection,
} from '../../utils/field-config'
import { linkActionLabel as formatLinkActionLabel } from '../../utils/link-fields'
import {
  dateTimeInputValue,
  dateTimeValueFromLocalInput,
  formatFieldDisplay,
  locationAddressValue,
  locationValueFromAddress,
} from '../../utils/field-display'
import { useYjsCellBinding, type YjsCellBinding } from '../../composables/useYjsCellBinding'
import { useYjsScalarCell, type YjsScalarCellBinding } from '../../composables/useYjsScalarCell'
import { useLocale } from '../../../composables/useLocale'
import {
  metaCoreLabel,
  attachmentActionHint as attachmentActionHintFn,
  attachmentActivityLabel,
  type MetaCoreLabelKey,
} from '../../utils/meta-core-labels'

const props = defineProps<{
  field: MetaField
  modelValue: unknown
  uploadFn?: MetaAttachmentUploadFn
  deleteAttachmentFn?: MetaAttachmentDeleteFn
  uploadContext?: MetaAttachmentUploadContext
  attachmentSummaries?: MetaAttachment[]
  /**
   * Record id of the cell being edited — required for Yjs binding. When
   * absent, the Yjs opt-in cannot engage; the editor falls back to the
   * existing REST path regardless of the build-time flag.
   */
  recordId?: string | null
  /**
   * A3 AI shortcut run opt-in. Present (non-null) only when the HOST wires
   * an `ai-run` listener (MetaGridTable). `pending` is the unified in-flight
   * state (drives the "running" label); `busy` (review F3) additionally
   * covers the RATE_LIMITED countdown — the button disables on either, same
   * as the drawer's aiBusy. See the RBAC invariant note in the template.
   */
  aiRunState?: { pending: boolean; busy: boolean } | null
  /**
   * B5 people-mention candidates for a rich-`longText` cell. Forwarded straight to
   * MetaRichLongTextEditor; the workbench feeds its already-loaded
   * `commentMentionSuggestions` (no fresh fetch). Absent on the anonymous form path.
   */
  mentionSuggestions?: MetaCommentMentionSuggestion[]
}>()

const DATE_RE = /^\d{4}-\d{2}-\d{2}/
const DATE_FIELD_NAMES = /date|time|deadline|due|start|end|created|updated|birthday/i
const isDateLike = computed(() => {
  if (props.field.type !== 'string') return false
  if (DATE_FIELD_NAMES.test(props.field.name)) return true
  if (typeof props.modelValue === 'string' && DATE_RE.test(props.modelValue)) return true
  return false
})

const emit = defineEmits<{
  (e: 'update:modelValue', val: unknown): void
  (e: 'confirm'): void
  (e: 'cancel'): void
  (e: 'open-link-picker'): void
  /** Native person (人员): open the member-scoped person picker (emits userId[]). */
  (e: 'open-person-picker'): void
  /**
   * Emitted *before* `confirm` when the user's edit was carried by the
   * Yjs opt-in path. Parents listening for this should suppress the
   * normal REST patch — the server-side Yjs bridge will persist the
   * change via `meta_records`. Pass-through REST is safe but redundant.
   */
  (e: 'yjs-commit'): void
  /** A3: AI shortcut run requested for this cell (host resolves record/field). */
  (e: 'ai-run'): void
}>()

const { isZh } = useLocale()
const l = (key: MetaCoreLabelKey) => metaCoreLabel(key, isZh.value)

// A3-T6: host opt-in (aiRunState) ∧ text target type ∧ persisted aiShortcut config.
const aiRunVisible = computed(() => {
  if (!props.aiRunState) return false
  if (props.field.type !== 'string' && props.field.type !== 'longText') return false
  const raw = (props.field.property ?? {}).aiShortcut
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
})

const readonlyDisplayValue = computed(() =>
  formatFieldDisplay({
    field: props.field,
    value: props.modelValue,
    attachmentSummaries: props.attachmentSummaries,
    isZh: isZh.value,
  }),
)

function textControlValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

// --- Yjs opt-in binding (text cells only; inert when flag off) ---
// See useYjsCellBinding for flag gating + timeout + fallback. The editor
// always renders; `yjsActive` flips true only when a live Y.Doc is
// attached, at which point the `<input>` is driven by Y.Text instead of
// `modelValue`. On any failure (flag off, timeout, server error, mid-edit
// disconnect) `yjsActive` stays/returns to false and the input falls
// back to the REST path untouched.
const recordIdRef = toRef(props, 'recordId') as unknown as import('vue').Ref<string | null | undefined>
const fieldIdRef = computed<string | null>(() => {
  if (props.field?.type !== 'string') return null
  if (isDateLike.value) return null
  if (!props.recordId) return null
  return props.field.id
})
const inertYjsBinding: YjsCellBinding = {
  active: ref(false),
  text: ref(''),
  setText: () => { /* inactive: non-text editors keep using REST */ },
  collaborators: ref([]),
  release: () => { /* nothing to release */ },
}
const yjsEligibleAtSetup = props.field?.type === 'string' && !isDateLike.value && !!props.recordId
const yjsBinding = yjsEligibleAtSetup
  ? useYjsCellBinding({
      recordId: computed<string | null>(() => recordIdRef.value ?? null),
      fieldId: fieldIdRef,
      onFallback: (reason) => {
        if (reason === 'disabled') return // expected, no noise
        // Soft warning only — the REST path remains fully usable.
        // eslint-disable-next-line no-console
        console.warn(`[multitable] Yjs cell binding fell back to REST (${reason})`)
      },
    })
  : inertYjsBinding
const yjsActive = computed(() => yjsBinding.active.value)
const yjsText = computed(() => yjsBinding.text.value)
const yjsCollaborators = computed(() => yjsBinding.collaborators.value)

// --- Yjs opt-in binding for ATOMIC (non-text) scalar cells (LWW via the
// `fields` Y.Map). Same gating/fallback discipline as the text binding:
// `scalarActive` flips true only once a live Y.Doc is attached AND the field
// key exists in the Y.Map (the backend seeds atomic fields as plain LWW values).
// Wired for the atomic types that read directly from modelValue (no local edit
// buffer): numeric/boolean + rating (number) + multiSelect (string[]), and (2a-1)
// the string-stored atomics select + date via the dual-reader (coerceText: a
// persisted Y.Text reads as a string, an edit writes a plain string → lazy
// convergence, no seed flip / migration needed; the value written is the exact
// stored shape — select option value, date raw string — verified no-corruption
// on real PG).
// `dateTime` (2a-DT-S2) and `duration` (2a-2) were once deferred but now bind: dateTime via
// the string-stored-atomic path writing the CANONICAL UTC ISO value (see the
// STRING_STORED_ATOMIC_YJS_TYPES note below), duration via commit-on-confirm
// (DURATION_COMMIT_ON_CONFIRM_YJS_TYPES). No multitable scalar field type remains deferred.
// Inactive → byte-identical REST path (setValue is a no-op; nothing changes).
const SCALAR_YJS_TYPES = ['number', 'currency', 'percent', 'boolean', 'rating', 'multiSelect']
// 2a-1: string-stored ATOMIC types. Values are strings but atomic (LWW, not
// char-merge), so they bind via useYjsScalarCell like the other scalars. They
// may exist in a persisted doc as Y.Text (the historical seed shape), so the
// binding is constructed with coerceText (read Y.Text-or-plain) and writes a
// plain string on edit — lazy convergence, no seed flip / migration needed.
// 2a-DT-S2 (design-lock multitable-2a-datetime-live-crdt-designlock-20260618): dateTime
// joins here. It is a string-stored atomic with the SAME Y.Text history (coerceText reads
// old docs), but its editor handler writes the CANONICAL UTC ISO form — the dateTime
// `@input` calls commitScalar(dateTimeValueFromLocalInput(localInput)), never the raw local
// input — so cross-TZ collaborators converge on the canonical stored value and the flush
// preserves the byte-identical REST shape. Display stays local via dateTimeInputValue.
const STRING_STORED_ATOMIC_YJS_TYPES = ['select', 'date', 'dateTime']
// 2a-2: duration is a plain number (seconds-backed) but commits ON CONFIRM, not per
// keystroke — its editor's local h:mm buffer (durationText) owns the input while typing
// (live re-derivation would reformat under the cursor). The binding is constructed so a
// confirmed edit syncs LWW, but the read defers to the local buffer (the editor is only
// mounted while editing, so it never drives off the remote value) and the Y.Map write
// happens only in durationConfirm() — never on @input.
const DURATION_COMMIT_ON_CONFIRM_YJS_TYPES = ['duration']
const isScalarYjsType = (t: string | undefined): boolean =>
  !!t &&
  (SCALAR_YJS_TYPES.includes(t) ||
    STRING_STORED_ATOMIC_YJS_TYPES.includes(t) ||
    DURATION_COMMIT_ON_CONFIRM_YJS_TYPES.includes(t))
const scalarFieldIdRef = computed<string | null>(() => {
  if (!props.field || !isScalarYjsType(props.field.type)) return null
  if (!props.recordId) return null
  return props.field.id
})
const inertScalarBinding: YjsScalarCellBinding = {
  active: ref(false),
  value: ref(undefined),
  setValue: () => { /* inactive: caller keeps using REST */ },
  release: () => { /* nothing to release */ },
}
const scalarEligibleAtSetup = !!props.field && isScalarYjsType(props.field.type) && !!props.recordId
const scalarBinding = scalarEligibleAtSetup
  ? useYjsScalarCell({
      recordId: computed<string | null>(() => recordIdRef.value ?? null),
      fieldId: scalarFieldIdRef,
      // Dual-reader for string-stored atomics so a persisted Y.Text reads as a string.
      coerceText: !!props.field && STRING_STORED_ATOMIC_YJS_TYPES.includes(props.field.type),
      onFallback: (reason) => {
        if (reason === 'disabled') return
        // eslint-disable-next-line no-console
        console.warn(`[multitable] Yjs scalar cell binding fell back to REST (${reason})`)
      },
    })
  : inertScalarBinding
const scalarActive = computed(() => scalarBinding.active.value)
const scalarValue = computed(() => scalarBinding.value.value)

// Mirror onTextInput: when the scalar Yjs path is live, drive the Y.Map (LWW)
// AND emit update:modelValue so the parent's edit buffer/preview stays in sync.
// Inactive → only the emit fires (REST path, byte-identical to before).
function commitScalar(next: unknown) {
  if (scalarActive.value) scalarBinding.setValue(next)
  emit('update:modelValue', next)
}
// Mirror onTextConfirm: signal yjs-commit so the host skips the redundant REST
// patch (the server bridge persists the Y.Map change), then confirm.
function scalarConfirm() {
  if (scalarActive.value) emit('yjs-commit')
  emit('confirm')
}
// 2a-2 duration: commit-on-confirm LWW. onDurationInput only updates the local buffer +
// REST emit (never the Y.Map), so the remote value never reformats the field mid-type
// (defer-remote-while-dirty). Only on confirm do we write the parsed seconds (a plain
// number) to the Y.Map when live, then signal yjs-commit so the host skips the redundant
// REST patch; inactive → just emit('confirm'), byte-identical to before.
function durationConfirm() {
  if (scalarActive.value) {
    scalarBinding.setValue(durationSecondsFromInput(durationText.value, durationFormat.value))
    emit('yjs-commit')
  }
  emit('confirm')
}
function onBooleanChange(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  commitScalar(checked)
  scalarConfirm()
}

function onTextInput(event: Event) {
  const next = (event.target as HTMLInputElement).value
  if (yjsActive.value) {
    // Drive Y.Text; mirror via update:modelValue so parent state
    // (undo buffers, derived cell previews) stays in sync.
    yjsBinding.setText(next)
  }
  emit('update:modelValue', next)
}

function onTextConfirm() {
  if (yjsActive.value) emit('yjs-commit')
  emit('confirm')
}

const inputRef = ref<HTMLElement | null>(null)
const multiSelectValue = computed(() => {
  // Read the synced Y.Map value (a plain string[]) when the scalar binding is
  // live; otherwise the REST modelValue. Both normalize to string[] for <select>.
  const raw = scalarActive.value ? scalarValue.value : props.modelValue
  if (!Array.isArray(raw)) return []
  return raw.map(String)
})

function onMultiSelectChange(event: Event) {
  const select = event.target as HTMLSelectElement
  // multiSelect is a plain string[] scalar (LWW via the fields Y.Map). commitScalar
  // drives the Y.Map when live (Y.Map.set stores a plain array — NOT a Y.Array — so
  // the bridge flushes it verbatim through patchRecords) and always mirrors via
  // update:modelValue. Inactive → byte-identical REST emit.
  commitScalar(Array.from(select.selectedOptions).map((option) => option.value))
}

const linkButtonLabel = computed(() => {
  // T3A2 unreachable-fallback note: the surrounding `<button v-else-if="field.type === 'link'">`
  // only renders when field.type === 'link', which makes this `!== 'link'` branch
  // unreachable in the current render flow. We intentionally do NOT localize this
  // static English string in T3A2 (would be a dead key per the merged dev MD §7.6).
  // If a future refactor exposes this branch to the DOM, localize it together with
  // a real render assertion; the reachable link branch below now receives locale.
  if (props.field.type !== 'link') return 'Choose linked records...'
  const count = Array.isArray(props.modelValue) ? props.modelValue.length : props.modelValue ? 1 : 0
  return formatLinkActionLabel(props.field, count, isZh.value)
})

// Native person button copy reuses linkActionLabel (it returns the people copy via isPersonField).
const personButtonLabel = computed(() => {
  if (props.field.type !== 'person') return ''
  const count = Array.isArray(props.modelValue) ? props.modelValue.length : props.modelValue ? 1 : 0
  return formatLinkActionLabel(props.field, count, isZh.value)
})

const uploading = ref(false)
const attachmentActivity = ref<'uploading' | 'removing' | 'clearing' | null>(null)
const attachmentError = ref('')

const attachmentIds = computed(() => {
  const v = props.modelValue
  if (Array.isArray(v)) return v.map(String)
  if (v) return [String(v)]
  return []
})
const attachmentAcceptAttrValue = computed(() => attachmentAcceptAttr(props.field))
const attachmentAllowsMultiple = computed(() => {
  if (props.field.type !== 'attachment') return true
  return resolveAttachmentFieldProperty(props.field.property).maxFiles !== 1
})
const attachmentActionHint = computed(() =>
  attachmentActionHintFn(
    attachmentAllowsMultiple.value,
    attachmentIds.value.length > 0,
    isZh.value,
  ),
)

const attachmentItems = computed<MetaAttachment[]>(() => {
  const summaryById = new Map((props.attachmentSummaries ?? []).map((attachment) => [attachment.id, attachment]))
  return attachmentIds.value.map((id) => summaryById.get(id) ?? {
    id,
    filename: id,
    mimeType: 'application/octet-stream',
    size: 0,
    url: '',
    thumbnailUrl: null,
    uploadedAt: '',
  })
})

function attachmentContext(): MetaAttachmentUploadContext {
  return {
    ...props.uploadContext,
    fieldId: props.field.id,
  }
}

async function deleteAttachment(attachmentId: string) {
  if (!props.deleteAttachmentFn) return
  await props.deleteAttachmentFn(attachmentId, attachmentContext())
}

function setAttachmentValue(nextIds: string[], confirm = true) {
  emit('update:modelValue', nextIds)
  if (confirm) emit('confirm')
}

async function uploadFiles(files: FileList) {
  attachmentError.value = ''
  const validationError = validateAttachmentSelection(props.field, files, attachmentIds.value.length, isZh.value)
  if (validationError) {
    attachmentError.value = validationError
    return
  }
  if (!props.uploadFn) {
    emit('update:modelValue', Array.from(files).map((f) => f.name))
    emit('confirm')
    return
  }
  attachmentActivity.value = 'uploading'
  uploading.value = true
  try {
    const existingIds = [...attachmentIds.value]
    const replaceExisting = shouldReplaceAttachmentSelection(props.field, files, existingIds.length)
    const newIds: string[] = []
    for (const file of Array.from(files)) {
      const attachment = await props.uploadFn(file, attachmentContext())
      newIds.push(attachment.id)
    }
    setAttachmentValue(replaceExisting ? newIds : [...existingIds, ...newIds])
  } catch (error: any) {
    attachmentError.value = error?.message ?? l('cell.uploadFailed')
  } finally {
    uploading.value = false
    attachmentActivity.value = null
  }
}

function onFileSelect(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (files?.length) void uploadFiles(files)
}

function onFileDrop(e: DragEvent) {
  const files = e.dataTransfer?.files
  if (files?.length) void uploadFiles(files)
}

function onNumberInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  commitScalar(v === '' ? null : Number(v))
}

const numericStep = computed(() => {
  if (props.field.type === 'number') {
    const { decimals } = resolveNumberFieldProperty(props.field.property)
    return decimals && decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : 'any'
  }
  if (props.field.type === 'currency') {
    const { decimals } = resolveCurrencyFieldProperty(props.field.property)
    return decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : '1'
  }
  if (props.field.type === 'percent') {
    const { decimals } = resolvePercentFieldProperty(props.field.property)
    return decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : '1'
  }
  return 'any'
})

// --- duration (seconds-backed, format-aware) ---
const durationFormat = computed(() => resolveDurationFieldProperty(props.field.property).durationFormat)
// LOCAL buffer seeded ONCE at setup from modelValue. Bound to the input and
// updated only by the user's keystrokes — never re-derived from modelValue —
// so reformatting can't fight the typist (advisor B). The parsed seconds are
// emitted via update:modelValue; the buffer stays the literal typed text.
const durationText = ref(
  props.field.type === 'duration' && props.modelValue !== null && props.modelValue !== undefined && props.modelValue !== ''
    && Number.isFinite(Number(props.modelValue))
    ? formatDurationValue(Number(props.modelValue), resolveDurationFieldProperty(props.field.property).durationFormat)
    : '',
)
function onDurationInput(event: Event) {
  const text = (event.target as HTMLInputElement).value
  durationText.value = text
  emit('update:modelValue', durationSecondsFromInput(text, durationFormat.value))
}

const ratingMax = computed(() => {
  if (props.field.type !== 'rating') return 5
  return resolveRatingFieldProperty(props.field.property).max
})

const ratingValue = computed(() => {
  const v = scalarActive.value ? scalarValue.value : props.modelValue
  const num = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.min(ratingMax.value, Math.round(num)))
})

function onRatingPick(value: number) {
  // Rating is a plain-number scalar (seeded LWW in the fields Y.Map). When the
  // scalar binding is live, commitScalar drives the Y.Map AND mirrors via
  // update:modelValue; scalarConfirm signals yjs-commit so the host skips the
  // redundant REST patch. Inactive → byte-identical to the old REST emit
  // (commitScalar emits update:modelValue, scalarConfirm emits confirm).
  commitScalar(value === 0 ? null : value)
  scalarConfirm()
}

async function onRemoveAttachment(attachmentId: string) {
  attachmentError.value = ''
  attachmentActivity.value = 'removing'
  try {
    if (props.deleteAttachmentFn) {
      await deleteAttachment(attachmentId)
      setAttachmentValue(attachmentIds.value.filter((id) => id !== attachmentId), false)
      return
    }
    setAttachmentValue(attachmentIds.value.filter((id) => id !== attachmentId))
  } catch (error: any) {
    attachmentError.value = error?.message ?? l('cell.removeFailed')
  } finally {
    attachmentActivity.value = null
  }
}

async function clearAttachments() {
  if (!attachmentIds.value.length) return
  attachmentError.value = ''
  attachmentActivity.value = 'clearing'
  try {
    if (props.deleteAttachmentFn) {
      for (const attachmentId of attachmentIds.value) {
        await deleteAttachment(attachmentId)
      }
      setAttachmentValue([], false)
      return
    }
    setAttachmentValue([])
  } catch (error: any) {
    attachmentError.value = error?.message ?? l('cell.clearFailed')
  } finally {
    attachmentActivity.value = null
  }
}

onMounted(() => {
  if (inputRef.value && 'focus' in inputRef.value) {
    ;(inputRef.value as HTMLInputElement).focus()
  }
})
</script>

<style scoped>
.meta-cell-editor { display: flex; align-items: center; }
.meta-cell-editor__text-wrap {
  display: flex; align-items: center; gap: 6px; width: 100%;
}
.meta-cell-editor__input {
  width: 100%; padding: 2px 6px; border: 1px solid #409eff; border-radius: 3px;
  font-size: 13px; outline: none;
}
.meta-cell-editor__textarea {
  width: 100%; min-height: 88px; padding: 6px 8px; border: 1px solid #409eff; border-radius: 4px;
  font-size: 13px; line-height: 1.45; outline: none; resize: vertical; white-space: pre-wrap;
}
.meta-cell-editor__presence {
  flex-shrink: 0;
}
.meta-cell-editor__select {
  width: 100%; padding: 2px 4px; border: 1px solid #409eff; border-radius: 3px;
  font-size: 13px; outline: none;
}
.meta-cell-editor__select--multi { min-height: 96px; padding: 4px 6px; }
.meta-cell-editor__check { display: flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }
.meta-cell-editor__link-btn {
  padding: 2px 8px; border: 1px solid #409eff; border-radius: 3px;
  background: #ecf5ff; color: #409eff; cursor: pointer; font-size: 12px;
}
.meta-cell-editor__attachment { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.meta-cell-editor__attachment-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.meta-cell-editor__file-trigger { position: relative; display: inline-flex; }
.meta-cell-editor__file-input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.meta-cell-editor__file-trigger-label {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 160px; padding: 8px 12px; border: 2px dashed #c0d8f0; border-radius: 6px;
  text-align: center; font-size: 11px; color: #999; cursor: pointer; background: #fafcff;
}
.meta-cell-editor__file-trigger-label:hover { border-color: #409eff; color: #409eff; }
.meta-cell-editor__clear-btn {
  padding: 6px 10px; border: 1px solid #dbe4f0; border-radius: 6px; background: #fff; cursor: pointer;
  font-size: 12px; color: #355070;
}
.meta-cell-editor__clear-btn:disabled { opacity: 0.5; cursor: default; }
.meta-cell-editor__uploading { padding: 4px 0; font-size: 11px; color: #409eff; }
.meta-cell-editor__error { font-size: 11px; color: #d14343; }
.meta-cell-editor__readonly { color: #999; font-size: 13px; }
.meta-cell-editor__rating { display: flex; align-items: center; gap: 2px; }
.meta-cell-editor__rating-star {
  border: none; background: none; padding: 0 1px; cursor: pointer;
  font-size: 18px; color: #d6d6d6; line-height: 1;
}
.meta-cell-editor__rating-star--filled { color: #f5a623; }
.meta-cell-editor__rating-star:hover { color: #f5a623; }
.meta-cell-editor__rating-clear {
  margin-left: 6px; padding: 1px 6px; border: 1px solid #ddd; border-radius: 3px;
  background: #fff; cursor: pointer; font-size: 11px; color: #666;
}
</style>

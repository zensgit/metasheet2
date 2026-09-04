<template>
  <div class="meta-cell-editor" ref="editorRoot">
    <!-- date field type -->
    <input
      v-if="field.type === 'date'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="date"
      :value="textControlValue(scalarActive ? scalarValue : modelValue)"
      @input="commitScalar(($event.target as HTMLInputElement).value)"
      @keydown.enter="onEnterScalarConfirm"
      @keydown.escape="onEscapeCancel"
      @keydown.tab="onScalarTab"
      @blur="onScalarBlur"
    />
    <!-- datetime field type -->
    <input
      v-else-if="field.type === 'dateTime'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="datetime-local"
      :value="dateTimeInputValue(scalarActive ? scalarValue : modelValue)"
      @input="commitScalar(dateTimeValueFromLocalInput(($event.target as HTMLInputElement).value))"
      @keydown.enter="onEnterScalarConfirm"
      @keydown.escape="onEscapeCancel"
    />
    <!-- string: date-like -->
    <input
      v-else-if="field.type === 'string' && isDateLike"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="date"
      :value="textControlValue(modelValue)"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="onEnterConfirm"
      @keydown.escape="onEscapeCancel"
      @keydown.tab="onPlainTab"
      @blur="onPlainBlur"
    />
    <!-- string: normal -->
    <div v-else-if="field.type === 'string'" class="meta-cell-editor__text-wrap">
      <input
        ref="inputRef"
        class="meta-cell-editor__input"
        type="text"
        :value="yjsActive ? yjsText : (modelValue ?? '')"
        @input="onTextInput"
        @keydown.enter="onEnterTextConfirm"
        @keydown.escape="onEscapeCancel"
        @keydown.tab="onTextTab"
        @blur="onTextBlur"
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
      @keydown.meta.enter.prevent="onEnterConfirm"
      @keydown.ctrl.enter.prevent="onEnterConfirm"
      @keydown.escape="onEscapeCancel"
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
      @keydown.enter="onEnterConfirm"
      @keydown.escape="onEscapeCancel"
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
      @keydown.enter="onEnterConfirm"
      @keydown.escape="onEscapeCancel"
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
      @keydown.enter="onEnterConfirm"
      @keydown.escape="onEscapeCancel"
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
      @keydown.enter="onEnterScalarConfirm"
      @keydown.escape="onEscapeCancel"
      @keydown.tab="onScalarTab"
      @blur="onScalarBlur"
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
      @keydown.escape="onEscapeCancel"
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
      @keydown.meta.enter.prevent="onEnterScalarConfirm"
      @keydown.ctrl.enter.prevent="onEnterScalarConfirm"
      @keydown.escape="onEscapeCancel"
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
      @keydown.enter="onEnterScalarConfirm"
      @keydown.escape="onEscapeCancel"
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
      @keydown.enter="onEnterDurationConfirm"
      @keydown.escape="onEscapeCancel"
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
      @keydown.enter="onEnterConfirm"
      @keydown.escape="onEscapeCancel"
    />
    <input
      v-else-if="field.type === 'email'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="email"
      placeholder="name@example.com"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="onEnterConfirm"
      @keydown.escape="onEscapeCancel"
    />
    <input
      v-else-if="field.type === 'phone'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="tel"
      placeholder="+86 138 0000 0000"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="onEnterConfirm"
      @keydown.escape="onEscapeCancel"
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
            @keydown.escape="onEscapeCancel"
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
      :disabled="aiRunDisabled"
      data-test="cell-ai-run"
      @click="emit('ai-run')"
      @keydown.tab="onAiRunTab"
      @blur="onAiRunBlur"
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
import { isDateLikeStringField, isYjsTextEligible } from '../../utils/yjs-text-eligibility'
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
  /**
   * D2/P2-1 (grid-commit-reliability): the SOLE host opt-in switch for every
   * commit/discard-on-blur AND commit-on-Tab behaviour this editor can emit
   * (`blur-commit`, `cancel`-on-invalid-blur, `tab-commit`). MUST be
   * requested by the host — MetaCellEditor cannot infer it:
   *   - `'grid'`: MetaGridTable passes this and listens for `blur-commit` /
   *     `tab-commit` (commits the draft, moves focus to the adjacent cell on
   *     Tab). Native Tab, in a grid `<td>` that isn't itself in tab order,
   *     would otherwise jump focus to whatever the next DOM tabindex happens
   *     to be — preventDefault here is what fixes that.
   *   - `'none'` / undefined (the default): plain native blur/Tab,
   *     byte-identical to pre-D2. MetaBulkEditDialog relies on this — its
   *     value input sits in an ordinary tab sequence with a "Set value"/
   *     Cancel footer after it, and only listens for `@cancel` (Escape/close
   *     button). P2-1: an EARLIER version of this gate covered Tab only;
   *     blur was wired unconditionally, so `onScalarBlur`'s P3-C
   *     invalid-numeric-draft path emitted `cancel` regardless of host —
   *     which MetaBulkEditDialog's `@cancel="onCancel"` reads as "dismiss
   *     the whole dialog". Blurring a number input mid-typing '-7' (a
   *     WHATWG-sanitized-to-empty in-progress value, see
   *     `numberInvalidRawDraft` below) silently closed the bulk-edit dialog.
   *     Every blur handler now checks this policy FIRST, before anything
   *     else (including before touching `numberInvalidRawDraft`), so a
   *     `'none'`-policy host is a true no-op — see each handler below.
   */
  hostCommitPolicy?: 'none' | 'grid'
}>()

// isDateLikeStringField / isYjsTextEligible live in ../../utils/yjs-text-eligibility so
// MetaGridTable's D1 type-to-edit can apply the IDENTICAL eligibility rule (see P3-1
// below) without duplicating these regexes and risking drift.
const isDateLike = computed(() => isDateLikeStringField(props.field, props.modelValue))

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
  /**
   * D2 (grid-commit-reliability): the editor's input lost focus to something
   * OUTSIDE this editor (click-away / focus moved elsewhere in the page).
   * Emitted ONLY by the plain scalar/text/number/date branches (see the
   * per-branch `on*Blur` handlers below) — select/multiSelect/attachment/link
   * are excluded because their native pickers legitimately steal focus
   * mid-edit (a blur there is a false positive, not a click-away). The host
   * commits the draft (same "only if changed" rule as `confirm`) and closes.
   */
  (e: 'blur-commit'): void
  /**
   * D2: Tab / Shift+Tab pressed while this editor is open. Emitted by the
   * SAME four branches as `blur-commit` (see the enumeration above) — Tab is
   * intentionally NOT wired as a delegated wrapper-level listener because
   * that would also swallow Tab used for in-editor keyboard nav.
   *
   * P3-A (round 2): concretely, the string branch's own per-input handler
   * (`onTextTab`) now honours that in-editor nav case rather than just
   * describing it — when the AI-run button is rendered as a focusable
   * sibling (`aiRunVisible`), a forward Tab is left un-intercepted so native
   * focus movement reaches the button instead of the button becoming
   * keyboard-unreachable; Tab FROM the button (`onAiRunTab`) still emits
   * `tab-commit` like every other exit point. Shift+Tab out of the input is
   * unaffected (there is nothing focusable BEFORE it to reach).
   *
   * Payload is `event.shiftKey` (true = move backward).
   */
  (e: 'tab-commit', shiftKey: boolean): void
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
// P2-2: the single source of truth for the button's own `:disabled` AND for
// onTextTab's Tab-yield decision (see that handler's doc comment) — kept as
// ONE computed so the two can never independently drift out of sync.
const aiRunDisabled = computed(() => Boolean(props.aiRunState?.pending || props.aiRunState?.busy))
// Rendered AND not disabled: a disabled <button> is never a native Tab stop,
// so `aiRunVisible` alone over-promises reachability.
const aiRunFocusable = computed(() => aiRunVisible.value && !aiRunDisabled.value)

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
// P3-1 (grid-commit-reliability, round 3): eligibility is the SAME predicate
// MetaGridTable's D1 type-to-edit now checks (isYjsTextEligible, imported
// above) BEFORE it ever seeds a keystroke — see that call site's doc comment
// for the full story. Because D1 no longer seeds `modelValue` for a cell
// this composable might bind, there is no local pre-activation draft left to
// lose, so the previous "forward the pending draft into Y.Text the instant
// the binding activates" watcher (keyed on `yjsText.value === ''`) has been
// REMOVED rather than fixed: that heuristic could not tell "nobody has
// synced anything yet" apart from "a collaborator just synced an empty
// string", and resolving that ambiguity from the client is unsafe — see the
// removed watcher in git history (P3-B, round 2) for the superseded attempt.
const yjsEligibleAtSetup = isYjsTextEligible(props.field, props.recordId, props.modelValue)
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

// --- D3/D4 (grid-commit-reliability): Enter/Escape hardening ---------------
// isComposing (Chrome/Firefox) or keyCode 229 (older Safari/IME shims) means
// this keydown is part of an IME composition (confirming a candidate), not a
// real Enter/Escape from the user — every confirm/cancel wrapper below bails
// out on it so an IME confirm can never prematurely commit or close the cell.
function isComposingEvent(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229
}
// D3: stopPropagation is the chosen mechanism for "Enter must not re-open the
// editor" — MetaGridTable.confirmEdit() clears editCell.value synchronously,
// and without this the SAME keydown would keep bubbling to the grid root's
// `@keydown="onKeydown"`, where (editCell.value is now falsy) the Enter case
// would immediately call startEdit() again on the just-committed cell. See
// MetaGridTable.vue onKeydown for the matching grid-root-side guard.
function onEnterConfirm(e: KeyboardEvent) {
  if (isComposingEvent(e)) return
  e.stopPropagation()
  emit('confirm')
}
function onEnterScalarConfirm(e: KeyboardEvent) {
  if (isComposingEvent(e)) return
  e.stopPropagation()
  // P3-C (round 2): Enter's behaviour is UNCHANGED by the P3-C fix below —
  // an unresolved invalid numeric draft ('-'/'.', trailing '.') still
  // commits `null` here, exactly like every OTHER keystroke's `onNumberInput`
  // used to (byte-identical to pre-fix). Only blur/Tab (onScalarBlur /
  // onScalarTab) now diverge and discard instead of persisting that null —
  // see `numberInvalidRawDraft`'s doc comment on `onNumberInput` for why.
  if (numberInvalidRawDraft.value) {
    numberInvalidRawDraft.value = false
    commitScalar(null)
  }
  scalarConfirm()
}
function onEnterTextConfirm(e: KeyboardEvent) {
  if (isComposingEvent(e)) return
  e.stopPropagation()
  onTextConfirm()
}
function onEnterDurationConfirm(e: KeyboardEvent) {
  if (isComposingEvent(e)) return
  e.stopPropagation()
  durationConfirm()
}
// Escape does NOT stopPropagation: that bubble-to-grid-root behavior
// (resetting focusRow/focusCol) predates this PR and is out of scope here —
// only the isComposing guard is new.
function onEscapeCancel(e: KeyboardEvent) {
  if (isComposingEvent(e)) return
  emit('cancel')
}

// --- D2 (grid-commit-reliability): commit-on-blur / commit-on-Tab ----------
// Wired ONLY on the plain scalar/text/number/date branches (date, the
// date-like string, the normal string, and number) — see the `blur-commit` /
// `tab-commit` emit doc comments above for why select/multiSelect/attachment/
// link are excluded.
const editorRoot = ref<HTMLElement | null>(null)
// A blur whose relatedTarget is still WITHIN this editor (e.g. focus moving
// from the text input to the sibling AI-run button) is an in-editor focus
// move, not a click-away — ignore it. `e.relatedTarget` is unset in some
// jsdom/browser file-picker paths too, which is exactly the sort of
// ambiguity that keeps blur-commit off the attachment/link branches.
function shouldIgnoreBlur(e: FocusEvent): boolean {
  const related = e.relatedTarget as Node | null
  return !!(related && editorRoot.value && editorRoot.value.contains(related))
}
// P2-1: `hostCommitPolicy !== 'grid'` is the FIRST statement in every blur
// handler below — before `shouldIgnoreBlur`, before `numberInvalidRawDraft`.
// A host that never opts in (MetaBulkEditDialog) must see these blur
// handlers as a true no-op: no `blur-commit`, no `cancel`, and no mutation
// of `numberInvalidRawDraft` as a side effect (clearing that flag on a
// policy-'none' blur would still be observable — the NEXT event to read it,
// e.g. a later Tab, would see a false "resolved" state that was never
// actually resolved by anything the host asked for).
function onScalarBlur(e: FocusEvent) {
  if (props.hostCommitPolicy !== 'grid') return
  if (shouldIgnoreBlur(e)) return
  // P3-C/NIT: a blur while an invalid numeric draft is pending (see
  // `numberInvalidRawDraft`). If NO valid draft was ever reached this edit
  // session (e.g. a lone '-' as the very first keystroke), discard via
  // `cancel` — the existing no-patch/close path (same one Escape already
  // uses) — so this can never persist that keystroke's would-be `null`
  // commit. If a valid draft WAS reached earlier ('7' before a trailing
  // '.'), `numberHasValidDraft` is true and editCell's staged value already
  // holds that last-valid number (onNumberInput never overwrote it with the
  // invalid keystroke) — fall through and commit it normally instead of
  // discarding the whole session (the number-prefix-loss NIT).
  if (numberInvalidRawDraft.value) {
    numberInvalidRawDraft.value = false
    if (!numberHasValidDraft.value) {
      emit('cancel')
      return
    }
  }
  if (scalarActive.value) emit('yjs-commit')
  emit('blur-commit')
}
function onTextBlur(e: FocusEvent) {
  if (props.hostCommitPolicy !== 'grid') return
  if (shouldIgnoreBlur(e)) return
  if (yjsActive.value) emit('yjs-commit')
  emit('blur-commit')
}
function onPlainBlur(e: FocusEvent) {
  if (props.hostCommitPolicy !== 'grid') return
  if (shouldIgnoreBlur(e)) return
  emit('blur-commit')
}
// preventDefault stops the browser's native Tab focus-jump (which would land
// on whatever the next DOM tabindex happens to be, not the next grid cell) —
// the host moves focus itself in response to `tab-commit`. stopPropagation
// for the same reason as onEnterConfirm above. Gated on `props.hostCommitPolicy`
// FIRST, before preventDefault/stopPropagation/any emit — without the gate,
// a host that never opts in (MetaBulkEditDialog) would still have Tab
// silently swallowed (preventDefault with no listener consuming the emit),
// trapping keyboard focus inside the value input. See the prop doc comment
// above for why this can't be inferred instead of asked for.
function onScalarTab(e: KeyboardEvent) {
  if (props.hostCommitPolicy !== 'grid') return
  if (isComposingEvent(e)) return
  // P3-C/NIT: an invalid numeric draft pending with NO earlier valid draft
  // this session → do NOT intercept. Returning before preventDefault lets
  // the native Tab move focus out of the input as normal, which fires a
  // genuine `blur` — `onScalarBlur` sees the same flags and discards there.
  // One discard path (no new event, no dangling `document.body` focus from
  // a preventDefault'd Tab that goes nowhere). When a valid draft WAS
  // reached earlier, fall through to the normal intercept below so focus
  // still moves to the adjacent cell (byte-identical to a resolved draft).
  if (numberInvalidRawDraft.value && !numberHasValidDraft.value) return
  e.preventDefault()
  e.stopPropagation()
  numberInvalidRawDraft.value = false
  if (scalarActive.value) emit('yjs-commit')
  emit('tab-commit', e.shiftKey)
}
function onTextTab(e: KeyboardEvent) {
  if (props.hostCommitPolicy !== 'grid') return
  if (isComposingEvent(e)) return
  // P3-A (round 2) / P2-2 (round 3): when the AI-run button renders as a
  // focusable sibling (`aiRunFocusable`), a FORWARD Tab must reach it via
  // native focus movement instead of being intercepted here — otherwise the
  // button is keyboard-unreachable (Tab always commits+moves before focus
  // can land on it). P2-2: `aiRunVisible` alone is not enough — the button
  // can be RENDERED but `disabled` (pending/busy), and a disabled button is
  // never a native Tab stop, so yielding to it in that state would just
  // exit the grid's tab sequence entirely (native Tab moves past it to
  // whatever the next document-order tabindex is) instead of committing.
  // `aiRunFocusable` folds in the disabled check so this only yields when
  // the button can actually receive focus. Tab FROM the button
  // (`onAiRunTab` below) still commits+moves like this handler always has.
  // Shift+Tab is unaffected: there is nothing focusable BEFORE the input in
  // this branch, so shift+Tab has nowhere to land.
  if (aiRunFocusable.value && !e.shiftKey) return
  e.preventDefault()
  e.stopPropagation()
  if (yjsActive.value) emit('yjs-commit')
  emit('tab-commit', e.shiftKey)
}
function onPlainTab(e: KeyboardEvent) {
  if (props.hostCommitPolicy !== 'grid') return
  if (isComposingEvent(e)) return
  e.preventDefault()
  e.stopPropagation()
  emit('tab-commit', e.shiftKey)
}
// P3-A: Tab pressed FROM the AI-run button (reached via the native focus
// movement `onTextTab` now leaves alone) commits+moves exactly like Tab
// from the input itself — the button is a valid exit point, not a dead
// end. Shift+Tab is left alone (native default returns focus to the input,
// which is the CORRECT "back" target — nothing to commit yet).
// P3-2: mirrors onTextTab/onTextBlur's `yjs-commit` emit when the Yjs text
// binding is live — this Tab exits the SAME text editor session those
// handlers do (the button is a sibling of the same `<input>`), so omitting
// it here left the host without the signal it needs to skip the redundant
// REST patch once Yjs already carried the edit.
function onAiRunTab(e: KeyboardEvent) {
  if (props.hostCommitPolicy !== 'grid') return
  if (isComposingEvent(e)) return
  if (e.shiftKey) return
  e.preventDefault()
  e.stopPropagation()
  if (yjsActive.value) emit('yjs-commit')
  emit('tab-commit', false)
}
// P3-1 (round 4): the AI-run button is a valid Tab STOP (onAiRunTab above,
// reached via onTextTab's `aiRunFocusable` yield) but had no blur handler at
// all — clicking away FROM the button (as opposed to Tab-ing out of it) hit
// no listener, so the editor was left dangling: neither committed nor
// cancelled, exactly the D2 "click-away must commit" defect this whole
// grid-commit-reliability line exists to close, just reachable through one
// more focus target. Mirrors onTextBlur exactly: same `hostCommitPolicy`
// opt-in gate, same `shouldIgnoreBlur` exclusion for focus moving back INTO
// the editor (e.g. Shift+Tab from the button returns to the input — an
// in-editor focus move, not a click-away), same yjs-commit-before-
// blur-commit order as every other blur handler here.
function onAiRunBlur(e: FocusEvent) {
  if (props.hostCommitPolicy !== 'grid') return
  if (shouldIgnoreBlur(e)) return
  if (yjsActive.value) emit('yjs-commit')
  emit('blur-commit')
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

// P3-C (grid-commit-reliability, round 2): a number `<input>`'s `.value`
// getter sanitizes an in-progress-but-invalid floating-point string (a lone
// '-'/'.', a trailing '.') to '' — IDENTICAL to a genuinely emptied field
// (WHATWG "value sanitization algorithm" for type=number; jsdom reproduces
// it too). `onNumberInput` alone can't tell "the user cleared this field"
// from "the user is mid-typing a negative/decimal number".
//
// The signal that survives the sanitization is the native InputEvent's own
// `inputType`: an `insert*` type (insertText, insertFromPaste, ...) means
// the empty `.value` is a REJECTED, still-in-progress edit; a `delete*` /
// `historyUndo` type means the user actually cleared the field. (Deliberately
// NOT keyed on `event.data`: a paste or the number input's spinner can carry
// truthy `data` while genuinely representing a clear/replace, so `inputType`
// is the narrower, correct discriminator.)
//
// On that "still typing" keystroke, do NOT commit — `numberInvalidRawDraft`
// is the ONLY state that reflects it; `editCell.value.value` (the draft
// MetaGridTable would patch) is left exactly as it was before this
// keystroke. This matters beyond blur/Tab: startEdit's/onCellClick's
// commit-previous guards and any other confirmEdit() caller that might fire
// mid-typing read that same draft — leaving it untouched means NONE of them
// can ever persist a `null` the user never asked to commit. `onScalarBlur`/
// `onScalarTab` below discard explicitly (and quickly, via the flag) rather
// than relying on that alone, but the flag is what makes "no commit
// happened" true in the first place. `onEnterScalarConfirm` re-derives the
// null commit explicitly so Enter's own behaviour stays exactly what it was
// before this fix (see its doc comment) — Enter is the ONE path that still
// intentionally commits null here.
//
// NIT (round 3, number-prefix loss): the ORIGINAL P3-C fix above stopped the
// invalid-draft's OWN keystroke from committing `null`, but blur/Tab then
// discarded the WHOLE session unconditionally on any pending invalid draft —
// so typing '7' (a resolved, committed draft) then '.' (sanitizes to '',
// invalid) and blurring lost the 7, not just the '.'. `numberHasValidDraft`
// tracks whether a resolved value was EVER reached this session; it is set
// ONLY in the resolved branch below — never pre-seeded from the initial
// `modelValue` on mount — so a session whose very FIRST keystroke is invalid
// ('-' alone, nothing resolved yet) still discards on blur/Tab exactly as
// before. `onScalarBlur`/`onScalarTab` read this flag alongside
// `numberInvalidRawDraft` to decide discard vs. commit-the-last-resolved-
// value; `onEnterScalarConfirm` is UNCHANGED by this — Enter keeps
// committing `null` on an unresolved invalid draft regardless.
const numberInvalidRawDraft = ref(false)
const numberHasValidDraft = ref(false)
// P2 (round 4): this in-progress-draft tracking is opt-in state for the SAME
// `hostCommitPolicy === 'grid'` host (MetaGridTable) that opts into
// blur/Tab-commit above — it exists to feed onScalarBlur/onScalarTab's
// discard-vs-commit-last-valid decision, which are themselves already gated
// on `hostCommitPolicy`. A host that never opts in (MetaBulkEditDialog,
// `hostCommitPolicy` left unset → 'none') has no blur/Tab-commit reading
// these flags at all, so leaving this logic ungated here was a silent
// behavioural DIVERGENCE from main, not a no-op: on 'none', a resolved
// draft ('7') followed by an in-progress invalid keystroke ('.', which the
// WHATWG number-input value-sanitization algorithm reports as '' from
// `.value` while still mid-edit) used to skip the `commitScalar(null)` call
// main always made on every keystroke — so `value.value` stayed at the
// stale last-valid 7 (and, since MetaBulkEditDialog reads that same
// `value` ref for "Set value"'s disabled state, the button stayed ENABLED)
// instead of committing `null` and disabling it, exactly like main. Gating
// this block on `hostCommitPolicy === 'grid'` FIRST — before touching either
// flag — restores byte-identical main behaviour for 'none': every keystroke
// commits `v === '' ? null : Number(v)` unconditionally, regardless of
// `inputType`.
function onNumberInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  if (props.hostCommitPolicy !== 'grid') {
    commitScalar(v === '' ? null : Number(v))
    return
  }
  const inputType = (e as InputEvent).inputType ?? ''
  if (v === '' && inputType.startsWith('insert')) {
    numberInvalidRawDraft.value = true
    return
  }
  numberInvalidRawDraft.value = false
  numberHasValidDraft.value = true
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

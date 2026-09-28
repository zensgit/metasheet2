<!--
  「复制数据表（含数据）」S1 dialog (ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md
  §3 user-visible behaviour; entries ① rail and ② 存为模板 hand-off open it — entry ③ template center is S4).

  Flow: on open, a zero-write `POST …/copy/dry-run` with data (the server runs the full-table-read +
  Base-writable gates BEFORE counting, so a refusal is a count-free 403) → the dialog shows 「包含数据（共 N
  行）」 and the disclosure lines. If that probe is refused only because rows are included (the row cap as
  an older backend's 413, or an auto-number row rule), ONE structure-only probe (withData:false) follows so
  a structure-only copy is never submitted without its disclosures. Submit needs a successful probe covering
  the chosen mode, then sends `POST …/copy` with `{ name, withData, permissionMode: 'inherit' }` (the body is
  built by the api client, never here) → `copied` hands the new sheet to the workbench, which refreshes the
  sheet list and selects it.

  Fixed in S1 (shown, disabled): target Base = the source sheet's Base (S2 unlocks), permission mode =
  「与源表相同」 (the only S1 mode). Values-free: every error line is chosen by CODE in
  meta-copy-sheet-labels.ts; the server's message never reaches the DOM.
-->
<template>
  <Teleport to="body">
    <div v-if="visible" class="meta-copy-sheet-overlay" @click.self="onCancel">
      <div
        class="meta-copy-sheet"
        role="dialog"
        aria-modal="true"
        :aria-label="l('copySheet.title')"
        :aria-busy="busy"
        data-testid="copy-sheet-dialog"
      >
        <div class="meta-copy-sheet__header">
          <strong>{{ l('copySheet.title') }}</strong>
          <MtIconButton
            class="meta-copy-sheet__close"
            data-testid="copy-sheet-close"
            :aria-label="l('copySheet.close')"
            :disabled="submitting"
            @click="onCancel"
          >&times;</MtIconButton>
        </div>

        <div class="meta-copy-sheet__body">
          <div class="meta-copy-sheet__row">
            <span class="meta-copy-sheet__label">{{ l('copySheet.sourceLabel') }}</span>
            <input class="meta-copy-sheet__input" type="text" :value="sheetName" readonly data-testid="copy-sheet-source" />
          </div>

          <label class="meta-copy-sheet__row">
            <span class="meta-copy-sheet__label">{{ l('copySheet.nameLabel') }}</span>
            <input
              v-model="name"
              class="meta-copy-sheet__input"
              type="text"
              maxlength="255"
              :disabled="submitting"
              data-testid="copy-sheet-name"
            />
          </label>

          <div class="meta-copy-sheet__row">
            <span class="meta-copy-sheet__label">{{ l('copySheet.targetBaseLabel') }}</span>
            <select class="meta-copy-sheet__input" disabled data-testid="copy-sheet-target-base">
              <option>{{ baseName || l('copySheet.targetBaseCurrent') }}</option>
            </select>
            <span class="meta-copy-sheet__hint">{{ l('copySheet.targetBaseNote') }}</span>
          </div>

          <label class="meta-copy-sheet__check">
            <input v-model="withData" type="checkbox" :disabled="submitting" data-testid="copy-sheet-with-data" />
            <span data-testid="copy-sheet-with-data-label">{{ withDataLabel }}</span>
          </label>

          <div class="meta-copy-sheet__row">
            <span class="meta-copy-sheet__label">{{ l('copySheet.permissionLabel') }}</span>
            <select class="meta-copy-sheet__input" disabled data-testid="copy-sheet-permission-mode">
              <option value="inherit">{{ l('copySheet.permissionInherit') }}</option>
            </select>
            <span class="meta-copy-sheet__hint">{{ l('copySheet.permissionNote') }}</span>
          </div>

          <p v-if="dryRunLoading" class="meta-copy-sheet__hint" data-testid="copy-sheet-dry-run-loading">{{ l('copySheet.dryRunLoading') }}</p>

          <div v-if="disclosureLines.length" class="meta-copy-sheet__row">
            <span class="meta-copy-sheet__label">{{ l('copySheet.disclosuresTitle') }}</span>
            <ul class="meta-copy-sheet__disclosures" data-testid="copy-sheet-disclosures">
              <li
                v-for="line in disclosureLines"
                :key="line.key"
                :data-disclosure="line.kind"
              >{{ line.text }}</li>
            </ul>
          </div>
          <p class="meta-copy-sheet__hint" data-testid="copy-sheet-not-copied">{{ l('copySheet.notCopied') }}</p>

          <p v-if="errorText" class="meta-copy-sheet__error" role="alert" data-testid="copy-sheet-error">{{ errorText }}</p>
        </div>

        <div class="meta-copy-sheet__actions">
          <MtButton data-testid="copy-sheet-cancel" :disabled="submitting" @click="onCancel">{{ l('copySheet.cancel') }}</MtButton>
          <MtButton
            variant="primary"
            data-testid="copy-sheet-submit"
            :disabled="!canSubmit"
            @click="onSubmit"
          >{{ submitting ? l('copySheet.submitting') : l('copySheet.submit') }}</MtButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { MtButton, MtIconButton } from '../ui'
import { isCopySheetError, type MultitableApiClient } from '../api/client'
import type { CopySheetDryRunResult, CopySheetResult } from '../types'
import {
  copySheetAutoNumberText,
  copySheetDefaultName,
  copySheetDisclosureText,
  copySheetErrorMessage,
  copySheetLabel,
  copySheetOverLimitText,
  copySheetViewFilterDropText,
  copySheetWithDataLabel,
  type MetaCopySheetLabelKey,
} from '../utils/meta-copy-sheet-labels'

const props = defineProps<{
  visible: boolean
  /** The sheet being copied (the workbench's active sheet). */
  sheetId: string
  sheetName: string
  /** Display name of the source sheet's Base — S1's fixed target. Empty falls back to 「当前工作区」. */
  baseName?: string
  /** Schema names (id → name) used to name disclosed columns and a failing row's column. */
  fields: Array<{ id: string; name: string }>
  views: Array<{ id: string; name: string }>
  /** The workbench's live client — never the module singleton. */
  client: Pick<MultitableApiClient, 'dryRunCopySheet' | 'copySheet'>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'copied', result: CopySheetResult): void
}>()

const { isZh } = useLocale()
const l = (key: MetaCopySheetLabelKey) => copySheetLabel(key, isZh.value)

const name = ref('')
const withData = ref(true)
// The WITH-data probe (always run) and its refusal.
const dryRun = ref<CopySheetDryRunResult | null>(null)
const dryRunError = ref<unknown>(null)
// The structure-only probe (withData:false), run ONCE and only when the with-data probe was refused for a
// reason that exists only because rows are included (see DATA_ONLY_REFUSALS). It is what puts the
// structural disclosures on screen before a structure-only copy may be submitted.
const structureRun = ref<CopySheetDryRunResult | null>(null)
const structureRunError = ref<unknown>(null)
const dryRunLoading = ref(false)
const submitting = ref(false)
const submitError = ref<unknown>(null)
const localError = ref<MetaCopySheetLabelKey | null>(null)

// Stale-response guard: a dry-run / copy that settles after the dialog closed or re-opened (for the
// same or another sheet) must not write state.
let generation = 0

watch(
  () => [props.visible, props.sheetId] as const,
  ([open]) => {
    generation += 1
    if (!open) return
    name.value = copySheetDefaultName(props.sheetName, isZh.value)
    withData.value = true
    dryRun.value = null
    dryRunError.value = null
    structureRun.value = null
    structureRunError.value = null
    submitError.value = null
    localError.value = null
    submitting.value = false
    void runDryRun(generation)
  },
  { immediate: true },
)

// Refusals that exist only BECAUSE rows are included: the row cap (an older backend answers the with-data
// dry-run with 413 instead of `summary.overLimit`) and a row-visibility rule on an auto-number column that
// renumbering would change (raised only when rows are copied). Their copy tells the user to untick
// 「包含数据」, so a structure-only copy must stay possible — but only after a structure-only probe has
// shown its disclosures.
const DATA_ONLY_REFUSALS: ReadonlySet<string> = new Set(['COPY_TOO_LARGE', 'COPY_SOURCE_RULE_ON_RENUMBERED_FIELD'])
function isDataOnlyRefusal(error: unknown): boolean {
  return isCopySheetError(error) && typeof error.code === 'string' && DATA_ONLY_REFUSALS.has(error.code)
}

async function runDryRun(gen: number): Promise<void> {
  dryRunLoading.value = true
  try {
    // Probed WITH data first: N (the row count) and the value-level disclosures are what the checkbox and
    // the list render. Zero-write on the server. Probed WITHOUT a name: the plan does not depend on it, and
    // the route refuses (400 NAME_INVALID_CHARACTERS) any name it is given that carries a mangled code
    // point — which the default 「<源表名> 副本」 would for a source whose own name is mangled, and the whole
    // probe (count + disclosures) would be lost to a problem only the copy's name has.
    try {
      const result = await props.client.dryRunCopySheet(props.sheetId, { withData: true, permissionMode: 'inherit' })
      if (gen !== generation) return
      dryRun.value = result
      return
    } catch (error) {
      if (gen !== generation) return
      dryRunError.value = error
      if (!isDataOnlyRefusal(error)) return
    }
    try {
      const result = await props.client.dryRunCopySheet(props.sheetId, { withData: false, permissionMode: 'inherit' })
      if (gen !== generation) return
      structureRun.value = result
    } catch (error) {
      if (gen !== generation) return
      structureRunError.value = error
    }
  } finally {
    if (gen === generation) dryRunLoading.value = false
  }
}

const fieldNameById = computed(() => new Map(props.fields.map((f) => [f.id, f.name])))
const viewNameById = computed(() => new Map(props.views.map((v) => [v.id, v.name])))
const fieldName = (fieldId: string): string | null => fieldNameById.value.get(fieldId) ?? null
const viewName = (viewId: string): string | null => viewNameById.value.get(viewId) ?? null

// The legacy row-cap refusal (413 COPY_TOO_LARGE on the with-data probe), when that is what came back.
const legacyRowCap = computed(() => {
  const error = dryRunError.value
  return isCopySheetError(error) && error.code === 'COPY_TOO_LARGE' ? error : null
})

// Over the row cap, from either backend shape: `summary.overLimit` (the #6112 fix) or the legacy 413.
const overLimit = computed<{ limit: number | null } | null>(() => {
  if (dryRun.value) return dryRun.value.overLimit ? { limit: dryRun.value.rowLimit } : null
  return legacyRowCap.value ? { limit: legacyRowCap.value.limit ?? null } : null
})

// The count only exists once the gate passed (a with-data probe answered, or its post-gate row-cap
// refusal carried it). A gate refusal shows no N at all; the structure-only probe never supplies N.
const withDataLabel = computed(() => copySheetWithDataLabel(
  dryRun.value?.rowCount ?? legacyRowCap.value?.rowCount ?? null,
  isZh.value,
))

// The plan whose disclosures are shown: the with-data probe when it answered, else the structure-only one.
const shownPlan = computed(() => dryRun.value ?? structureRun.value)

type DisclosureLine = { key: string; kind: string; text: string }

const disclosureLines = computed<DisclosureLine[]>(() => {
  const lines: DisclosureLine[] = []
  if (withData.value && overLimit.value) {
    lines.push({ key: 'over-limit', kind: 'OVER_LIMIT', text: copySheetOverLimitText(overLimit.value.limit, isZh.value) })
  }
  const result = shownPlan.value
  if (!result) return lines
  // Group columns by reason, keeping the server's first-seen order of reasons and columns.
  const byReason = new Map<string, string[]>()
  for (const item of result.fieldDisclosures) {
    const names = byReason.get(item.reason) ?? []
    names.push(fieldName(item.fieldId) ?? l('copySheet.unlistedField'))
    byReason.set(item.reason, names)
  }
  for (const [reason, names] of byReason) {
    lines.push({ key: `field:${reason}`, kind: reason, text: copySheetDisclosureText(reason, names, isZh.value) })
  }
  // Value-level (the structure-only probe reads no rows, so it always reports 0 here).
  if (withData.value && result.autoNumberRenumberedRows > 0) {
    lines.push({
      key: 'auto-number',
      kind: 'AUTO_NUMBER_RENUMBERED',
      text: copySheetAutoNumberText(result.autoNumberRenumberedRows, isZh.value),
    })
  }
  for (const drop of result.viewFilterLeavesDropped) {
    const viewName = viewNameById.value.get(drop.viewId) ?? l('copySheet.unlistedView')
    lines.push({
      key: `view:${drop.viewId}`,
      kind: 'VIEW_FILTER_LEAF_DROPPED',
      text: copySheetViewFilterDropText(viewName, drop.count, isZh.value),
    })
  }
  return lines
})

// Submit needs a SUCCESSFUL probe that covers the chosen mode, so the disclosures are never skipped:
//   - with data: the with-data probe answered and is not over the row cap;
//   - structure only: the with-data probe answered (its structural disclosures are the same), or the
//     structure-only re-probe did (after a data-only refusal).
// Everything else blocks: a gate / structural refusal (the copy would repeat it verbatim), and — since
// nothing could be disclosed — a probe that failed in transport or with a 5xx.
const probeCoversMode = computed(() => (withData.value
  ? dryRun.value !== null && !dryRun.value.overLimit
  : dryRun.value !== null || structureRun.value !== null))

const busy = computed(() => dryRunLoading.value || submitting.value)
// An empty name is NOT folded in here: onSubmit reports it (errorNoName) instead of a silently dead button.
const canSubmit = computed(() => !busy.value && probeCoversMode.value)

// Editing the name answers a name refusal (local empty-name, or the server's 400 NAME_INVALID_CHARACTERS),
// so both stop showing; any other refusal stays until the next submit replaces it.
watch(name, () => {
  localError.value = null
  if (isCopySheetError(submitError.value) && submitError.value.code === 'NAME_INVALID_CHARACTERS') submitError.value = null
})

// A probe that did not answer at all (transport / 5xx) is not a refusal of the copy: say the pre-check
// failed, not 「复制失败」. Coded 4xx refusals get their own sentence.
function probeErrorMessage(error: unknown): string {
  if (isCopySheetError(error) && error.status < 500) return copySheetErrorMessage(error, isZh.value, { fieldName, viewName })
  return l('copySheet.error.probeFailed')
}

const errorText = computed(() => {
  if (localError.value) return l(localError.value)
  if (submitError.value) return copySheetErrorMessage(submitError.value, isZh.value, { fieldName, viewName })
  if (structureRunError.value) return probeErrorMessage(structureRunError.value)
  const error = dryRunError.value
  if (!error) return ''
  // The legacy row cap is shown as the OVER_LIMIT disclosure line (same as the #6112 fix's overLimit), and
  // a data-only refusal says nothing about a structure-only copy once 「包含数据」 is unticked.
  if (legacyRowCap.value) return ''
  if (isDataOnlyRefusal(error) && !withData.value) return ''
  return probeErrorMessage(error)
})

// The ONLY path here is the submit button, whose `:disabled="!canSubmit"` already covers busy /
// blocking-refusal states — so no duplicate in-handler checks. A copy that succeeds is always reported
// (`copied`): the new sheet exists server-side, and the workbench must learn about it.
async function onSubmit(): Promise<void> {
  const trimmed = name.value.trim()
  if (!trimmed) {
    localError.value = 'copySheet.errorNoName'
    return
  }
  localError.value = null
  submitError.value = null
  submitting.value = true
  try {
    const result = await props.client.copySheet(props.sheetId, {
      name: trimmed,
      withData: withData.value,
      permissionMode: 'inherit',
    })
    emit('copied', result)
  } catch (error) {
    submitError.value = error
  } finally {
    submitting.value = false
  }
}

// Reachable while submitting through the overlay click (the buttons are disabled then): closing
// mid-copy would hide the in-flight state, and a re-open would reset the form while that copy runs.
function onCancel(): void {
  if (submitting.value) return
  emit('close')
}
</script>

<style scoped>
.meta-copy-sheet-overlay { position: fixed; inset: 0; z-index: 110; background: rgba(0, 0, 0, 0.3); display: flex; align-items: center; justify-content: center; }
.meta-copy-sheet { background: var(--ms-bg-card); border-radius: var(--ms-radius-md); width: min(520px, calc(100vw - 32px)); max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.18); }
.meta-copy-sheet__header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--ms-border-light); }
.meta-copy-sheet__body { padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.meta-copy-sheet__row { display: flex; flex-direction: column; gap: 4px; }
.meta-copy-sheet__label { font-size: 12px; color: var(--ms-text-2); font-weight: 600; }
.meta-copy-sheet__input { min-height: var(--ms-control-height); padding: 0 var(--ms-space-2); border: 1px solid var(--ms-border); border-radius: var(--ms-radius-sm); background: var(--ms-bg-card); color: var(--ms-text-1); font-size: 13px; }
.meta-copy-sheet__input:disabled,
.meta-copy-sheet__input[readonly] { background: var(--ms-bg-page); color: var(--ms-text-2); }
.meta-copy-sheet__check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ms-text-1); cursor: pointer; }
.meta-copy-sheet__hint { margin: 0; font-size: 12px; color: var(--ms-text-3); }
.meta-copy-sheet__disclosures { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ms-text-2); }
.meta-copy-sheet__error { margin: 0; font-size: 12px; color: var(--ms-color-danger); }
.meta-copy-sheet__actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--ms-border-light); }
</style>

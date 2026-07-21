<template>
  <!-- Entry: rendered ONLY when the mode's flag-derived capability is on AND a valid exact anchor is selected.
       Reset remains destructive; Revert keeps post-anchor-created records and never offers typed Reset confirm. -->
  <button v-if="entryEnabled && anchor" :class="entryClass" :data-test="entryTestId" @click="openDialog">{{ ' ' }}{{ confirmEntryLabel }}{{ ' ' }}</button>

  <teleport to="body">
    <div v-if="open" class="reset-confirm-overlay" :data-test="dialogTestId" @click.self="onCancel">
      <!-- Body copy below reads `openedLabel`/`openedAnchor` — a SNAPSHOT taken at openDialog(), never the
           live `asOf`/`anchor` props. If the caller's selection changes while this modal is open (picker
           re-render, re-fetch, etc.), the visible target and the preview/execute wire both stay pinned to
           what was open when preview ran — they can never diverge (the TOCTOU this dialog must not allow). -->
      <div class="reset-confirm-modal" :class="{ 'reset-confirm-modal--destructive': mode === 'reset' }" role="dialog" :aria-label="dialogAria">
        <div class="reset-confirm__header">
          <h3 class="reset-confirm__title">{{ confirmTitle }}</h3>
          <button class="reset-confirm__close" :aria-label="l('record.resetConfirmCancelAria')" :disabled="submitting" @click="onCancel">&times;</button>
        </div>
        <div class="reset-confirm__body">
          <p v-if="loading" class="reset-confirm__hint" data-test="reset-confirm-loading">{{ l('record.resetConfirmLoading') }}</p>

          <p v-else-if="submitting" class="reset-confirm__hint" data-test="reset-confirm-submitting">{{ l('record.resetConfirmSubmitting') }}</p>

          <p v-else-if="result" class="reset-confirm__hint" data-test="reset-confirm-result">
            {{ resetConfirmResultSummary(deletedCount, result.revertedCount ?? 0, openedLabel, isZh) }}
            <a v-if="deletedCount > 0" href="#trash" class="reset-confirm__trash-link" data-test="reset-confirm-trash-link">{{ l('record.resetConfirmViewInTrash') }}</a>
          </p>

          <div v-else-if="error" class="reset-confirm__error">
            <p class="reset-confirm__hint reset-confirm__hint--warn" role="alert" data-test="reset-confirm-error">{{ errorCopy }}</p>
            <MtButton data-test="reset-confirm-retry" :disabled="loading || submitting" @click="retryPreview">
              {{ l('record.resetConfirmRetryPreview') }}
            </MtButton>
          </div>

          <template v-else-if="preview">
            <!-- Defense in depth: the backend withholds tokens for both refusal classes. The client also
                 refuses a malformed/incompatible response that combines either class with an identity. -->
            <p v-if="resurrectBlocked" class="reset-confirm__hint reset-confirm__hint--warn" role="alert" data-test="reset-confirm-blocked">
              {{ blockedResurrectMessage }}
            </p>
            <p v-else-if="driftBlocked" class="reset-confirm__hint reset-confirm__hint--warn" role="alert" data-test="reset-confirm-drift-blocked">
              {{ l('record.resetConfirmErrorSchemaDrift') }}
            </p>
            <p v-else-if="invalidRevertPreview" class="reset-confirm__hint reset-confirm__hint--warn" role="alert" data-test="revert-confirm-invalid-preview">
              {{ l('record.revertConfirmInvalidPreview') }}
            </p>
            <p v-else-if="noChanges" class="reset-confirm__hint" data-test="reset-confirm-no-changes">
              {{ l('record.resetConfirmNoChanges') }}
            </p>
            <!-- Revert is always non-destructive; Reset is equivalent only when its delete set is empty. -->
            <template v-else-if="mode === 'revert' || deleteCount === 0">
              <p class="reset-confirm__hint" data-test="reset-confirm-revert-equiv">{{ ' ' }}{{ confirmRevertIntro }} <strong>{{ l('record.resetConfirmRevertWord') }}</strong>.{{ ' ' }}</p>
              <MtButton class="reset-confirm__btn" data-test="reset-confirm-btn" :disabled="!hasIdentity || submitting" @click="onConfirm">{{ ' ' }}{{ resetConfirmRevertButtonLabel(openedLabel, isZh) }}</MtButton>
            </template>

            <!-- Destructive path: typed two-step confirm (type `reset` AND acknowledge the deleted-count). -->
            <template v-else>
              <p class="reset-confirm__warn" role="alert" data-test="reset-confirm-warn"><strong>{{ l('record.resetConfirmWarnResetWord') }}</strong> {{ resetConfirmWarnRevertsAt(openedLabel, isZh) }} <strong>{{ resetConfirmWarnDeleteClause(deleteCount, openedLabel, isZh) }}</strong> {{ l('record.resetConfirmWarnBeforeNot') }} <strong>{{ l('record.resetConfirmWarnNotWord') }}</strong> {{ resetConfirmWarnAfterNot(openedLabel, isZh) }} <strong>{{ l('record.resetConfirmRevertWord') }}</strong> {{ l('record.resetConfirmWarnInstead') }}{{ ' ' }}</p>
              <label class="reset-confirm__ack" data-test="reset-confirm-ack">
                <input type="checkbox" v-model="ackCount" :disabled="submitting" />
                {{ resetConfirmAckLabel(deleteCount, isZh) }}{{ ' ' }}
              </label>
              <label class="reset-confirm__type">{{ ' ' }}{{ l('record.resetConfirmTypePrefix') }} <code>reset</code> {{ l('record.resetConfirmTypeSuffix') }}
                <input data-test="reset-confirm-type" v-model="typed" :aria-label="l('record.resetConfirmTypeAria')" :disabled="submitting" />
              </label>
              <MtButton
                class="reset-confirm__btn reset-confirm__btn--destructive" variant="danger" data-test="reset-confirm-btn"
                :disabled="!canConfirm || submitting" @click="onConfirm"
              >{{ ' ' }}{{ resetConfirmDestructiveButtonLabel(deleteCount, isZh) }}{{ ' ' }}</MtButton>
            </template>
          </template>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ExactAnchorRequest, ResetPreview, ResetResult } from '../api/client'
import { useLocale } from '../../composables/useLocale'
import { MtButton } from '../ui'
import {
  recordLabel, resetConfirmEntryLabel, resetConfirmTitle, resetConfirmResultSummary,
  resetConfirmRevertEquivIntro, resetConfirmRevertButtonLabel, resetConfirmDestructiveButtonLabel,
  resetConfirmAckLabel, resetConfirmWarnRevertsAt, resetConfirmWarnDeleteClause, resetConfirmWarnAfterNot,
  resetConfirmBlockedResurrectMessage, revertConfirmEntryLabel, revertConfirmTitle,
  revertConfirmIntro, revertConfirmBlockedResurrectMessage,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'

const props = defineProps<{
  /** Recovery strategy. Omitted preserves the historical Reset behavior. */
  mode?: 'revert' | 'reset'
  /** flag-derived capability (MULTITABLE_ENABLE_PIT_RESET on AND canManageSheetAccess). Off/absent ⇒ entry hidden. */
  pitResetEnabled?: boolean
  /** flag-derived capability (MULTITABLE_ENABLE_SHEET_REVERT on AND canManageSheetAccess). */
  sheetRevertEnabled?: boolean
  /** DISPLAY TEXT ONLY for the currently selected anchor (e.g. the history batch's createdAt) — never sent
   *  over the wire; the destructive authority is `anchor` below. */
  asOf: string
  /** the EXACT anchor currently selected upstream (historyBatchId XOR anchorOperationId). null ⇒ nothing
   *  selected yet, entry hidden. This prop is LIVE (reactive); the dialog snapshots it at open time so a
   *  later change here cannot retarget an in-flight preview/execute (see openDialog). */
  anchor: ExactAnchorRequest | null
  /** Mode-bound callbacks (bind to the client + sheetId upstream) so the wire is testable end-to-end. Execute
   *  is TOKEN-ONLY; only the Reset client adds `confirm:'reset'`. No anchor/asOf is ever re-sent here. */
  resetPreview: (anchor: ExactAnchorRequest) => Promise<ResetPreview>
  resetExecute: (previewIdentity: string) => Promise<ResetResult>
  onDone?: () => void | Promise<void>
}>()

const { isZh } = useLocale()
const l = (key: MetaRecordLabelKey): string => recordLabel(key, isZh.value)
const mode = computed<'revert' | 'reset'>(() => props.mode === 'revert' ? 'revert' : 'reset')
const entryEnabled = computed(() => mode.value === 'revert'
  ? props.sheetRevertEnabled === true
  : props.pitResetEnabled === true)
const entryTestId = computed(() => mode.value === 'revert' ? 'revert-entry' : 'reset-entry')
const dialogTestId = computed(() => mode.value === 'revert' ? 'revert-confirm' : 'reset-confirm')
const entryClass = computed(() => mode.value === 'revert' ? ['reset-entry', 'revert-entry'] : ['reset-entry'])
const dialogAria = computed(() => l(mode.value === 'revert' ? 'record.revertConfirmDialogAria' : 'record.resetConfirmDialogAria'))
const confirmEntryLabel = computed(() => mode.value === 'revert'
  ? revertConfirmEntryLabel(props.asOf, isZh.value)
  : resetConfirmEntryLabel(props.asOf, isZh.value))
const confirmTitle = computed(() => mode.value === 'revert'
  ? revertConfirmTitle(openedLabel.value, isZh.value)
  : resetConfirmTitle(openedLabel.value, isZh.value))

const open = ref(false)
const loading = ref(false)
const submitting = ref(false)
const preview = ref<ResetPreview | null>(null)
const result = ref<ResetResult | null>(null)
const error = ref<{ status?: number; code?: string } | null>(null)
const typed = ref('')
const ackCount = ref(false)

// The open-time snapshot (TOCTOU guard): frozen the instant the dialog opens, read by every render/wire
// call below instead of the live props. `openedAnchor` starts null only before the first open.
const openedAnchor = ref<ExactAnchorRequest | null>(null)
const openedLabel = ref('')

const deleteCount = computed(() => preview.value?.summary.deleteCount ?? 0)
const revertCount = computed(() => preview.value?.summary.visibleRevertCount ?? 0)
const resurrectCount = computed(() => preview.value?.summary.resurrectCount ?? 0)
const driftCount = computed(() => preview.value?.summary.driftCount ?? 0)
const resurrectBlocked = computed(() => resurrectCount.value > 0)
const driftBlocked = computed(() => driftCount.value > 0)
const invalidRevertPreview = computed(() => mode.value === 'revert' && deleteCount.value > 0)
const blocked = computed(() => resurrectBlocked.value || driftBlocked.value || invalidRevertPreview.value)
const blockedResurrectMessage = computed(() => mode.value === 'revert'
  ? revertConfirmBlockedResurrectMessage(resurrectCount.value, isZh.value)
  : resetConfirmBlockedResurrectMessage(resurrectCount.value, isZh.value))
const confirmRevertIntro = computed(() => mode.value === 'revert'
  ? revertConfirmIntro(openedLabel.value, revertCount.value, isZh.value)
  : resetConfirmRevertEquivIntro(openedLabel.value, revertCount.value, isZh.value))
const noChanges = computed(() =>
  preview.value !== null &&
  preview.value.summary.effectiveWriteCount === 0 &&
  !blocked.value,
)
const deletedCount = computed(() => result.value?.deletedCount ?? result.value?.deletedRecordIds?.length ?? 0)
const hasIdentity = computed(() => Boolean(preview.value?.previewIdentity) && !blocked.value)
// Destructive path requires BOTH gates; non-destructive (deleteCount===0) only needs an executable identity.
const canConfirm = computed(() => hasIdentity.value && typed.value.trim() === 'reset' && ackCount.value)

// Invalidates every preview/execute continuation from an earlier open. This covers close+reopen races,
// not just mutation of the live parent props while one modal instance remains open.
let dialogEpoch = 0

const errorCopy = computed(() => {
  const s = error.value?.status, c = error.value?.code
  switch (c) {
    case 'REVERT_DISABLED': return l('record.revertConfirmErrorDisabled')
    case 'RESET_DISABLED': return l('record.resetConfirmErrorDisabled')
    case 'RESET_BLOCKED':
    case 'RECORD_LOCKED':
    case 'RECOVERY_IN_PROGRESS': return l('record.resetConfirmErrorBlocked')
    case 'EXACT_ANCHOR_REQUIRED':
    case 'AMBIGUOUS_ANCHOR':
    case 'INVALID_ANCHOR':
    case 'UNKNOWN_ANCHOR': return l('record.resetConfirmErrorAnchorInvalid')
    case 'NO_COVERING_CHECKPOINT':
    case 'CHECKPOINT_CHANGED': return l('record.resetConfirmErrorCheckpoint')
    case 'RECOVERY_TRUST_REQUIRED':
    case 'HISTORY_INCOMPLETE': return l(mode.value === 'revert' ? 'record.revertConfirmErrorTrustRequired' : 'record.resetConfirmErrorTrustRequired')
    case 'SCHEMA_DRIFT': return l('record.resetConfirmErrorSchemaDrift')
    case 'LINK_INTEGRITY': return l('record.resetConfirmErrorLinkIntegrity')
    case 'VALUE_INVALID': return l('record.resetConfirmErrorValueInvalid')
    case 'INBOUND_UNPROVABLE': return l('record.resetConfirmErrorInboundUnprovable')
    case 'RESET_RETENTION_CONFLICT': return l('record.resetConfirmErrorRetentionConflict')
    case 'TOKEN_REPLAYED':
    case 'IDENTITY_INVALID':
    case 'PREVIEW_IDENTITY_INVALID': return l('record.resetConfirmErrorStale')
    case 'SHEET_TOO_LARGE': return l(mode.value === 'revert' ? 'record.revertConfirmErrorTooLarge' : 'record.resetConfirmErrorTooLarge')
    case 'RESET_CONFIRM_REQUIRED': return l('record.resetConfirmErrorTypeMismatch')
    default: break
  }
  if (s === 403) return l(mode.value === 'revert' ? 'record.revertConfirmErrorForbidden' : 'record.resetConfirmErrorForbidden')
  if (s === 409) return l('record.resetConfirmErrorStale')
  if (s === 413) return l(mode.value === 'revert' ? 'record.revertConfirmErrorTooLarge' : 'record.resetConfirmErrorTooLarge')
  return l(mode.value === 'revert' ? 'record.revertConfirmErrorGeneric' : 'record.resetConfirmErrorGeneric')
})

const asErr = (e: unknown): { status?: number; code?: string } => ({
  status: (e as { status?: number })?.status,
  code: (e as { code?: string })?.code,
})

function openDialog(): void {
  if (!props.anchor) return // no valid exact anchor selected — never open on nothing
  const epoch = ++dialogEpoch
  openedAnchor.value = { ...props.anchor } as ExactAnchorRequest
  openedLabel.value = props.asOf
  open.value = true
  void loadPreview(epoch)
}

async function loadPreview(epoch: number): Promise<void> {
  const anchor = openedAnchor.value
  if (!anchor) return
  loading.value = true; error.value = null; result.value = null; preview.value = null; typed.value = ''; ackCount.value = false
  try {
    const nextPreview = await props.resetPreview({ ...anchor } as ExactAnchorRequest)
    if (open.value && epoch === dialogEpoch) preview.value = nextPreview
  } catch (e) {
    if (open.value && epoch === dialogEpoch) error.value = asErr(e)
  } finally {
    if (epoch === dialogEpoch) loading.value = false
  }
}

function retryPreview(): void {
  if (!open.value || loading.value || submitting.value || !openedAnchor.value) return
  void loadPreview(++dialogEpoch)
}

async function onConfirm(): Promise<void> {
  if (submitting.value) return
  const id = preview.value?.previewIdentity
  if (!id || blocked.value) return // no token, or a fail-closed preview class → no executable action
  if (mode.value === 'reset' && deleteCount.value > 0 && !canConfirm.value) return // destructive double-gate not satisfied
  const epoch = dialogEpoch
  submitting.value = true
  error.value = null
  try {
    const nextResult = await props.resetExecute(id)
    if (open.value && epoch === dialogEpoch) result.value = nextResult
  } catch (e) {
    if (open.value && epoch === dialogEpoch) error.value = asErr(e)
    return
  } finally {
    if (epoch === dialogEpoch) submitting.value = false
  }

  // Execute has committed at this point. A refresh failure must never rewrite that outcome as a
  // recovery failure; the visible result remains authoritative and the next normal refresh can converge.
  try {
    await props.onDone?.()
  } catch {
    // Deliberately isolated post-commit best effort.
  }
}

function onCancel(): void {
  if (submitting.value) return
  ++dialogEpoch
  open.value = false
  loading.value = false
}
</script>

<style scoped>
.reset-entry { padding: 6px 12px; border-radius: 6px; border: 1px solid #d92d20; color: #d92d20; background: #fff; cursor: pointer; }
.revert-entry { border-color: #1570ef; color: #175cd3; }
.reset-confirm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.reset-confirm-modal { background: #fff; border-radius: 8px; max-width: 480px; width: 90%; }
.reset-confirm-modal--destructive { border-top: 4px solid #d92d20; }
.reset-confirm__header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #eee; }
.reset-confirm__title { margin: 0; font-size: 16px; }
.reset-confirm__close { background: none; border: none; font-size: 22px; cursor: pointer; }
.reset-confirm__body { padding: 20px; }
.reset-confirm__error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.reset-confirm__error .reset-confirm__hint { margin: 0; }
.reset-confirm__warn { background: #fef3f2; border: 1px solid #fda29b; color: #912018; border-radius: 6px; padding: 12px; }
.reset-confirm__ack { display: block; margin: 12px 0; }
.reset-confirm__type { display: block; margin: 8px 0 16px; }
/* .reset-confirm__btn / .reset-confirm__btn--destructive: both the non-destructive (Revert-equivalent) and
   destructive (typed-confirm Reset) footer buttons are now <MtButton> — ghost (default variant, was a plain
   #ccc-bordered neutral action) and danger (variant="danger", was solid #d92d20 fill) respectively. Their
   bespoke CSS (incl. the shared :disabled rule) was removed; both classes — including `--destructive`, kept
   as an additional identity class rather than a styling hook — remain on the elements for selector
   stability. */
.reset-confirm__hint--warn { color: #b42318; }
</style>

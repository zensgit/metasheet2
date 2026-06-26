<template>
  <!-- Entry: rendered ONLY when the flag-derived capability is on (true flag-off hidden — the FE half of
       "inert until enabled"; pitResetEnabled already encodes canManageSheetAccess). Destructive styling, distinct
       from any Revert affordance. -->
  <button v-if="pitResetEnabled" class="reset-entry" data-test="reset-entry" @click="openDialog">
    Reset to {{ asOf }}…
  </button>

  <teleport to="body">
    <div v-if="open" class="reset-confirm-overlay" data-test="reset-confirm" @click.self="onCancel">
      <div class="reset-confirm-modal reset-confirm-modal--destructive" role="dialog" aria-label="Reset sheet to a point in time">
        <div class="reset-confirm__header">
          <h3 class="reset-confirm__title">Reset sheet to {{ asOf }}</h3>
          <button class="reset-confirm__close" aria-label="Cancel" @click="onCancel">&times;</button>
        </div>
        <div class="reset-confirm__body">
          <p v-if="loading" class="reset-confirm__hint" data-test="reset-confirm-loading">Loading preview…</p>

          <p v-else-if="result" class="reset-confirm__hint" data-test="reset-confirm-result">
            {{ deletedCount }} record(s) moved to the recycle bin · {{ result.revertedCount ?? 0 }} reverted to {{ asOf }}.
            <a href="#trash" class="reset-confirm__trash-link" data-test="reset-confirm-trash-link">View in Trash</a>
          </p>

          <p v-else-if="error" class="reset-confirm__hint reset-confirm__hint--warn" role="alert" data-test="reset-confirm-error">{{ errorCopy }}</p>

          <template v-else-if="preview">
            <!-- Non-destructive path: nothing created after T → plain Revert-equivalent, no typed confirm. -->
            <template v-if="deleteCount === 0">
              <p class="reset-confirm__hint" data-test="reset-confirm-revert-equiv">
                Nothing was created after {{ asOf }}. This reverts {{ revertCount }} record(s) to their state at
                {{ asOf }} — non-destructive, the same as <strong>Revert</strong>.
              </p>
              <button class="reset-confirm__btn" data-test="reset-confirm-btn" :disabled="!hasIdentity" @click="onConfirm">
                Revert to {{ asOf }}
              </button>
            </template>

            <!-- Destructive path: typed two-step confirm (type `reset` AND acknowledge the deleted-count). -->
            <template v-else>
              <p class="reset-confirm__warn" role="alert" data-test="reset-confirm-warn">
                <strong>Reset</strong> reverts every record to its state at {{ asOf }}
                <strong>and moves the {{ deleteCount }} record(s) created after {{ asOf }} to the recycle bin</strong>
                — recoverable from Trash, but this is <strong>not</strong> a normal restore.
                Need to keep records created after {{ asOf }}? Use <strong>Revert</strong> instead — it changes nothing destructively.
              </p>
              <label class="reset-confirm__ack" data-test="reset-confirm-ack">
                <input type="checkbox" v-model="ackCount" />
                I understand {{ deleteCount }} record(s) will be moved to the recycle bin.
              </label>
              <label class="reset-confirm__type">
                Type <code>reset</code> to confirm:
                <input data-test="reset-confirm-type" v-model="typed" aria-label="type reset to confirm" />
              </label>
              <button class="reset-confirm__btn reset-confirm__btn--destructive" data-test="reset-confirm-btn"
                      :disabled="!canConfirm" @click="onConfirm">
                Reset — move {{ deleteCount }} to recycle bin
              </button>
            </template>
          </template>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ResetPreview, ResetResult } from '../api/client'

const props = defineProps<{
  /** flag-derived capability (MULTITABLE_ENABLE_PIT_RESET on AND canManageSheetAccess). Off/absent ⇒ entry hidden. */
  pitResetEnabled?: boolean
  /** the point-in-time T to reset to (display + API asOf). */
  asOf: string
  /** smart callbacks (bind to the client + sheetId in the workbench) so the wire is testable end-to-end. */
  resetPreview: (asOf: string) => Promise<ResetPreview>
  resetExecute: (asOf: string, previewIdentity: string) => Promise<ResetResult>
  onDone?: () => void
}>()

const open = ref(false)
const loading = ref(false)
const preview = ref<ResetPreview | null>(null)
const result = ref<ResetResult | null>(null)
const error = ref<{ status?: number; code?: string } | null>(null)
const typed = ref('')
const ackCount = ref(false)

const deleteCount = computed(() => preview.value?.summary.deleteCount ?? 0)
const revertCount = computed(() => preview.value?.summary.visibleRevertCount ?? 0)
const deletedCount = computed(() => result.value?.deletedRecordIds?.length ?? 0)
const hasIdentity = computed(() => Boolean(preview.value?.previewIdentity))
// Destructive path requires BOTH gates; non-destructive (deleteCount===0) only needs an executable identity.
const canConfirm = computed(() => hasIdentity.value && typed.value.trim() === 'reset' && ackCount.value)

const errorCopy = computed(() => {
  const s = error.value?.status, c = error.value?.code
  if (s === 403) return c === 'RESET_DISABLED' ? 'Reset is not enabled here.' : 'You do not have permission to reset this sheet.'
  if (s === 409) return c === 'RESET_BLOCKED'
    ? 'A target record is locked or denied — nothing was changed.'
    : 'The sheet changed since the preview — please re-preview and try again.'
  if (s === 413) return 'This sheet has too many records for a one-shot reset.'
  if (s === 400) return 'Type "reset" to confirm.'
  return 'Reset could not be completed. Please re-preview and try again.'
})

const asErr = (e: unknown): { status?: number; code?: string } => ({
  status: (e as { status?: number })?.status,
  code: (e as { code?: string })?.code,
})

function openDialog(): void {
  open.value = true
  void loadPreview()
}

async function loadPreview(): Promise<void> {
  loading.value = true; error.value = null; result.value = null; preview.value = null; typed.value = ''; ackCount.value = false
  try { preview.value = await props.resetPreview(props.asOf) } catch (e) { error.value = asErr(e) } finally { loading.value = false }
}

async function onConfirm(): Promise<void> {
  const id = preview.value?.previewIdentity
  if (!id) return // empty revert+delete set → no executable token
  if (deleteCount.value > 0 && !canConfirm.value) return // destructive double-gate not satisfied
  try { result.value = await props.resetExecute(props.asOf, id); props.onDone?.() } catch (e) { error.value = asErr(e) }
}

function onCancel(): void { open.value = false }
</script>

<style scoped>
.reset-entry { padding: 6px 12px; border-radius: 6px; border: 1px solid #d92d20; color: #d92d20; background: #fff; cursor: pointer; }
.reset-confirm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.reset-confirm-modal { background: #fff; border-radius: 8px; max-width: 480px; width: 90%; }
.reset-confirm-modal--destructive { border-top: 4px solid #d92d20; }
.reset-confirm__header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #eee; }
.reset-confirm__title { margin: 0; font-size: 16px; }
.reset-confirm__close { background: none; border: none; font-size: 22px; cursor: pointer; }
.reset-confirm__body { padding: 20px; }
.reset-confirm__warn { background: #fef3f2; border: 1px solid #fda29b; color: #912018; border-radius: 6px; padding: 12px; }
.reset-confirm__ack { display: block; margin: 12px 0; }
.reset-confirm__type { display: block; margin: 8px 0 16px; }
.reset-confirm__btn { padding: 8px 14px; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; }
.reset-confirm__btn--destructive { background: #d92d20; color: #fff; border-color: #d92d20; }
.reset-confirm__btn:disabled { opacity: 0.5; cursor: not-allowed; }
.reset-confirm__hint--warn { color: #b42318; }
</style>

<!--
  T8-2 Reset UI — T-source picker (the product entry the #3250 dialog was missing; #3250/#3251 flagged
  "entry-wiring needs a T-source"). Lets a sheet-admin pick a point-in-time T and hands it to the existing
  ResetConfirmDialog as `asOf`. The dialog owns preview → typed two-step confirm → execute; this only sources T.

  T-source = a free datetime-local picker (minimal "只差产品入口"). Alternative (deferred): present recent
  HistoryCenterModal batch timestamps as selectable options — richer, still read-only consumption of history.
  The `asOf` derivation is the single swappable seam (`localToIso` / the `asOf` computed) so that change is local.

  Timezone: datetime-local is browser-local; `asOf` is the corresponding UTC ISO for the API. The human-facing
  "Target" line is derived FROM `asOf` (not the raw input), so what the user sees can never diverge from what the
  destructive op uses. Gated on `pitResetEnabled` ALONE (it already encodes flag ∧ canManageSheetAccess); the
  dialog is mounted only once T is valid & past, so the dialog's own "Reset to {asOf}…" button never fires empty.
-->
<template>
  <div v-if="pitResetEnabled" class="reset-picker" data-test="reset-picker">
    <label class="reset-picker__label">
      <span>Reset this sheet to a point in time</span>
      <input
        type="datetime-local"
        class="reset-picker__input"
        data-test="reset-picker-input"
        v-model="localValue"
        :max="nowLocalValue"
      />
    </label>

    <!-- datetime-local coerces invalid text to '' so a non-empty-unparseable value can't occur; if `asOf` is somehow
         null it simply renders nothing below (fail-safe: no dialog), so no separate invalid branch is needed. -->
    <p v-if="asOf && isFuture" class="reset-picker__hint reset-picker__hint--warn" data-test="reset-picker-future">
      Pick a time in the past — you can only reset to an earlier state.
    </p>

    <template v-else-if="asOf">
      <p class="reset-picker__target" data-test="reset-picker-target">
        Target: <strong>{{ targetDisplay }}</strong> (your local time)
      </p>
      <ResetConfirmDialog
        :pit-reset-enabled="true"
        :as-of="asOf"
        :reset-preview="boundPreview"
        :reset-execute="boundExecute"
        :on-done="onDone"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import ResetConfirmDialog from './ResetConfirmDialog.vue'
import type { ResetPreview, ResetResult } from '../api/client'

const props = defineProps<{
  /** flag-derived capability (MULTITABLE_ENABLE_PIT_RESET ∧ canManageSheetAccess); off/absent ⇒ whole entry hidden. */
  pitResetEnabled?: boolean
  /** bound here (not in the dialog) so the (sheetId, asOf) wiring is covered by THIS component's unit test. */
  sheetId: string
  resetPreview: (sheetId: string, asOf: string) => Promise<ResetPreview>
  resetExecute: (sheetId: string, asOf: string, previewIdentity: string) => Promise<ResetResult>
  onDone?: () => void
}>()

const localValue = ref('')

/** The single T-source seam: a browser-local datetime-local string → UTC ISO instant, or null if unparseable. */
function localToIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local) // datetime-local has no offset → interpreted in the browser's local tz
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const asOf = computed<string | null>(() => localToIso(localValue.value))
// Derived FROM asOf (never from the raw input) so the displayed target and the API asOf cannot diverge.
const targetDisplay = computed(() => (asOf.value ? new Date(asOf.value).toLocaleString() : ''))
const isFuture = computed(() => (asOf.value ? new Date(asOf.value).getTime() > Date.now() : false))

// `:max` on the input (local wall-clock now) so the picker discourages future selection before the isFuture guard.
const nowLocalValue = computed(() => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
})

const boundPreview = (a: string): Promise<ResetPreview> => props.resetPreview(props.sheetId, a)
const boundExecute = (a: string, identity: string): Promise<ResetResult> => props.resetExecute(props.sheetId, a, identity)
</script>

<style scoped>
.reset-picker { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid #fda29b; border-radius: 8px; background: #fffbfa; }
.reset-picker__label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #912018; }
.reset-picker__input { padding: 6px 8px; border: 1px solid #d0d5dd; border-radius: 6px; max-width: 240px; }
.reset-picker__hint { font-size: 12px; margin: 0; }
.reset-picker__hint--warn { color: #b42318; }
.reset-picker__target { font-size: 13px; margin: 0; }
</style>

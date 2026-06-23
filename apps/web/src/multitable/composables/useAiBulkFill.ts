/**
 * useAiBulkFill — B-3 review-before-write state machine for AI bulk/whole-column
 * fill. Drives MetaAiBulkFillDialog.vue. Design lock:
 * docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md
 * (§5 B-3).
 *
 * THE CENTRAL REQUIREMENT (owner's flagged risk): TRUTHFUL STATUS. The user
 * must never be misled about what was or wasn't written. Every preview state and
 * commit outcome is kept DISTINCT end-to-end:
 *  - confirmable rows (have a real `proposed`) vs masked (confirmable but "may be
 *    incomplete") vs skipped[] (UNCHARGED, not writable) vs failures[] (CHARGED
 *    but non-confirmable — no value to write).
 *  - commit: written / stale_reprev (re-preview) / write_conflict / not_in_cache
 *    / skipped_no_perm — reconciled per confirmed row + an aggregate count.
 *  - cost honesty: preview already CHARGED (`settledCost`) is surfaced; abandon
 *    does not refund.
 *
 * Error handling reuses the per-record A3 discipline (mapAiShortcutError): branch
 * STRICTLY on error.code. The burst-limiter RATE_LIMITED (429 + Retry-After)
 * starts a countdown that gates new sends on BOTH preview and commit;
 * AI_BULK_QUOTA_INSUFFICIENT (429, NO Retry-After) is a whole-run refusal with
 * NO countdown.
 */
import { computed, getCurrentScope, onScopeDispose, reactive, ref } from 'vue'
import type {
  AiBulkCommitData,
  AiBulkPreviewData,
  AiBulkPreviewInput,
} from '../api/client'
import { mapAiShortcutError, type AiShortcutUiError } from './useAiShortcut'

export type AiBulkFillPhase = 'idle' | 'previewing' | 'review' | 'committing' | 'done'

interface AiBulkClientLike {
  aiBulkPreview(sheetId: string, input: AiBulkPreviewInput): Promise<AiBulkPreviewData>
  aiBulkCommit(sheetId: string, input: { runId: string; recordIds: string[] }): Promise<AiBulkCommitData>
}

export interface UseAiBulkFillOptions {
  client: AiBulkClientLike
  sheetId: () => string
}

export interface AiBulkFillState {
  phase: AiBulkFillPhase
  /** Last preview result (kept through the review + commit phases for the diff table). */
  preview: AiBulkPreviewData | null
  /** Last commit result (set in the `done` phase). */
  commit: AiBulkCommitData | null
  error: AiShortcutUiError | null
  /** RATE_LIMITED countdown (ms); null when no countdown is active. */
  retryRemainingMs: number | null
}

export function useAiBulkFill(opts: UseAiBulkFillOptions) {
  const state = reactive<AiBulkFillState>({
    phase: 'idle',
    preview: null,
    commit: null,
    error: null,
    retryRemainingMs: null,
  })

  // The set of recordIds the user has chosen to write. Only confirmable
  // (rows[]) recordIds are ever admitted here — skipped/failures rows can never
  // become selectable (they have no value to write). Default after a preview:
  // ALL confirmable rows (including masked — masked rows ARE writable).
  const selected = ref<Set<string>>(new Set())

  let countdownTimer: ReturnType<typeof setInterval> | null = null

  function clearCountdown(): void {
    if (countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
    state.retryRemainingMs = null
  }

  function startCountdown(ms: number): void {
    clearCountdown()
    state.retryRemainingMs = ms
    const startedAt = Date.now()
    countdownTimer = setInterval(() => {
      const left = ms - (Date.now() - startedAt)
      if (left <= 0) clearCountdown()
      else state.retryRemainingMs = left
    }, 1000)
  }

  /** Branch on code, exactly as useAiShortcut.fail: only RATE_LIMITED gets a countdown. */
  function fail(err: unknown): AiShortcutUiError {
    const mapped = mapAiShortcutError(err)
    state.error = mapped
    if (mapped.code === 'RATE_LIMITED' && typeof mapped.retryAfterMs === 'number' && mapped.retryAfterMs > 0) {
      startCountdown(mapped.retryAfterMs)
    }
    return mapped
  }

  /** true exactly when a new send would be refused (in-flight OR active countdown). */
  const busy = computed(
    () => state.phase === 'previewing' || state.phase === 'committing' || state.retryRemainingMs !== null,
  )

  // --- Derived, distinct preview buckets (never collapse them) ---
  const rows = computed(() => state.preview?.rows ?? [])
  const skipped = computed(() => state.preview?.skipped ?? [])
  const failures = computed(() => state.preview?.failures ?? [])
  /** Whether the preview broke early (partial). NOT the over-cap path (that's a 400). */
  const partial = computed(() => state.preview?.capped === true)
  const settledCost = computed(() => state.preview?.settledCost ?? 0)

  const confirmableCount = computed(() => rows.value.length)
  const selectedCount = computed(() => selected.value.size)
  const allConfirmableSelected = computed(
    () => confirmableCount.value > 0 && selectedCount.value === confirmableCount.value,
  )

  /** Toggle one confirmable row. A non-confirmable recordId is silently ignored. */
  function toggleRow(recordId: string): void {
    if (!rows.value.some((r) => r.recordId === recordId)) return
    const next = new Set(selected.value)
    if (next.has(recordId)) next.delete(recordId)
    else next.add(recordId)
    selected.value = next
  }

  function selectAllConfirmable(): void {
    selected.value = new Set(rows.value.map((r) => r.recordId))
  }

  function clearSelection(): void {
    selected.value = new Set()
  }

  /**
   * Phase 1 — generate the preview (CHARGES the provider per row). Resolves the
   * server-side scope; the response separates confirmable/skipped/failures.
   * Returns the preview data, or null on a guarded no-op / error (state.error set).
   */
  async function preview(input: AiBulkPreviewInput): Promise<AiBulkPreviewData | null> {
    if (busy.value) return null
    state.phase = 'previewing'
    state.preview = null
    state.commit = null
    state.error = null
    try {
      const data = await opts.client.aiBulkPreview(opts.sheetId(), input)
      state.preview = data
      // Default selection: ALL confirmable rows (masked included — masked is a
      // flag on a writable row, never an exclusion). skipped/failures excluded.
      selected.value = new Set(data.rows.map((r) => r.recordId))
      state.phase = 'review'
      return data
    } catch (err) {
      fail(err)
      state.phase = 'idle'
      return null
    }
  }

  /**
   * Phase 2 — commit the SELECTED confirmable rows (writes the CACHED outputs;
   * no new provider call / charge). Returns the per-row outcomes, or null on a
   * guarded no-op / error. A row may come back stale/conflict/no-perm/not-in-cache
   * even though it was confirmable at preview (commit re-gates the live record).
   */
  async function commit(): Promise<AiBulkCommitData | null> {
    if (busy.value) return null
    if (!state.preview) return null
    const recordIds = [...selected.value]
    if (recordIds.length === 0) return null
    state.phase = 'committing'
    state.error = null
    try {
      const data = await opts.client.aiBulkCommit(opts.sheetId(), { runId: state.preview.runId, recordIds })
      state.commit = data
      state.phase = 'done'
      return data
    } catch (err) {
      fail(err)
      // Stay in review so the user can retry the same selection.
      state.phase = 'review'
      return null
    }
  }

  /** Reset to idle (e.g. dialog closed) — clears preview, selection, commit, error, countdown. */
  function reset(): void {
    clearCountdown()
    state.phase = 'idle'
    state.preview = null
    state.commit = null
    state.error = null
    selected.value = new Set()
  }

  /** Dismiss only the error (keep the current phase/preview). */
  function clearError(): void {
    state.error = null
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (countdownTimer) clearInterval(countdownTimer)
    })
  }

  return {
    state,
    busy,
    selected,
    // derived buckets
    rows,
    skipped,
    failures,
    partial,
    settledCost,
    confirmableCount,
    selectedCount,
    allConfirmableSelected,
    // actions
    preview,
    commit,
    toggleRow,
    selectAllConfirmable,
    clearSelection,
    reset,
    clearError,
  }
}

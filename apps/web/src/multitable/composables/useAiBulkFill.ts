/**
 * useAiBulkFill — review-before-write state machine for AI bulk/whole-column
 * fill. Drives MetaAiBulkFillDialog.vue. Design lock:
 * docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md
 * (§5 B-3) + the B-4 async-job extension (over-cap → job).
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
 * B-4 ASYNC JOB MODE: an over-cap start returns `{ jobId }` instead of an inline
 * preview. The composable then DRIVES the job: poll progress (~2s, queued/
 * running) → on a committable status (suspended / errored / rejected) fetch ALL
 * review rows by following nextCursor → commit the user-selected `generated`
 * subset ONCE (the backend chunks). Cancel stops the worker → `rejected`, whose
 * already-generated rows stay committable (we transition INTO review, not close).
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
  AiBulkJobCommitData,
  AiBulkJobPoll,
  AiBulkJobRow,
  AiBulkPreviewData,
  AiBulkPreviewInput,
  AiBulkPreviewStart,
} from '../api/client'
import { isAiBulkJobStart } from '../api/client'
import { mapAiShortcutError, type AiShortcutUiError } from './useAiShortcut'

export type AiBulkFillPhase =
  // Inline (≤ cap, B-3) phases — UNCHANGED.
  | 'idle'
  | 'previewing'
  | 'review'
  | 'committing'
  | 'done'
  // Async job (over cap, B-4) phases.
  | 'polling' // job created; worker generating (queued/running) — polling progress
  | 'jobReview' // committable terminal (suspended/errored/rejected) — rows fetched
  | 'jobLoadError' // review rows failed to load COMPLETELY — fail-closed, NOT confirmable
  | 'jobCommitting'
  | 'jobDone'

/** Statuses on which the worker is done mutating the job → it's committable. */
const COMMITTABLE_STATUSES = new Set<AiBulkJobPoll['state']>(['suspended', 'errored', 'rejected'])
/** Statuses on which polling must STOP (terminal-for-this-session). */
const POLL_STOP_STATUSES = new Set<AiBulkJobPoll['state']>(['suspended', 'resolved', 'rejected', 'errored'])
/** Hard cap on row pages we will follow (defence against a non-advancing cursor). */
const MAX_ROW_PAGES = 1000

interface AiBulkClientLike {
  aiBulkPreview(sheetId: string, input: AiBulkPreviewInput): Promise<AiBulkPreviewStart>
  aiBulkCommit(sheetId: string, input: { runId: string; recordIds: string[] }): Promise<AiBulkCommitData>
  getBulkJob(sheetId: string, jobId: string): Promise<AiBulkJobPoll>
  getBulkJobRows(sheetId: string, jobId: string, cursor?: number | null): Promise<{ rows: AiBulkJobRow[]; nextCursor: number | null }>
  commitBulkJob(sheetId: string, jobId: string, recordIds: string[]): Promise<AiBulkJobCommitData>
  cancelBulkJob(sheetId: string, jobId: string): Promise<{ jobId: string; cancelled: boolean; state: AiBulkJobPoll['state'] }>
}

export interface UseAiBulkFillOptions {
  client: AiBulkClientLike
  sheetId: () => string
  /** Poll interval (ms) for an async job. Default 2000; tests override it. */
  pollIntervalMs?: number
}

export interface AiBulkFillState {
  phase: AiBulkFillPhase
  /** Last INLINE preview result (kept through the review + commit phases for the diff table). */
  preview: AiBulkPreviewData | null
  /** Last INLINE commit result (set in the `done` phase). */
  commit: AiBulkCommitData | null
  // --- B-4 async job (distinct from the inline preview/commit above) ---
  /** Async job id once an over-cap start created one. */
  jobId: string | null
  /** Latest poll header (progress + counts) — drives the progress bar + terminal banners. */
  job: AiBulkJobPoll | null
  /** ALL review rows for the job (accumulated across nextCursor pages). */
  jobRows: AiBulkJobRow[]
  /** Async job commit result (set in `jobDone`). */
  jobCommit: AiBulkJobCommitData | null
  error: AiShortcutUiError | null
  /** RATE_LIMITED countdown (ms); null when no countdown is active. */
  retryRemainingMs: number | null
}

export function useAiBulkFill(opts: UseAiBulkFillOptions) {
  const pollIntervalMs = opts.pollIntervalMs ?? 2000
  const state = reactive<AiBulkFillState>({
    phase: 'idle',
    preview: null,
    commit: null,
    jobId: null,
    job: null,
    jobRows: [],
    jobCommit: null,
    error: null,
    retryRemainingMs: null,
  })

  // The set of recordIds the user has chosen to write. Only SELECTABLE recordIds
  // (inline confirmable rows[] OR job `generated` rows) are ever admitted here —
  // skipped/failures/pending rows can never become selectable (no value to write).
  const selected = ref<Set<string>>(new Set())

  let countdownTimer: ReturnType<typeof setInterval> | null = null
  // Async-job poll: a self-rescheduling setTimeout, NOT setInterval, so a slow
  // poll never overlaps the next. `pollToken` defeats the zombie-continuation
  // bug: clearPoll()/reset() bump it; every async continuation captures it at
  // entry and bails after each await once it no longer matches (so a fetch that
  // resolves AFTER the dialog closed can't resurrect the loop).
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollToken = 0

  function clearCountdown(): void {
    if (countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
    state.retryRemainingMs = null
  }

  function clearPoll(): void {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    // Invalidate any in-flight poll/rows/cancel continuation.
    pollToken += 1
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

  /** true exactly when a new send (generate) would be refused (in-flight OR active countdown). */
  const busy = computed(
    () =>
      state.phase === 'previewing' ||
      state.phase === 'committing' ||
      state.phase === 'polling' ||
      state.phase === 'jobCommitting' ||
      state.retryRemainingMs !== null,
  )

  /** true when the current flow is an async job (vs the inline preview path). */
  const isJob = computed(() => state.jobId !== null)

  // --- Derived, distinct INLINE preview buckets (never collapse them) ---
  const rows = computed(() => state.preview?.rows ?? [])
  const skipped = computed(() => state.preview?.skipped ?? [])
  const failures = computed(() => state.preview?.failures ?? [])
  /** Whether the INLINE preview broke early (partial). NOT the over-cap path (that's a job). */
  const partial = computed(() => state.preview?.capped === true)
  /** Already-charged cost — inline preview's settledCost, or the job's running settledCost. */
  const settledCost = computed(() => (isJob.value ? state.job?.settledCost ?? 0 : state.preview?.settledCost ?? 0))

  // --- B-4 job-row buckets (distinct review states) ---
  /** Confirmable job rows = state 'generated' ONLY. */
  const jobGeneratedRows = computed(() => state.jobRows.filter((r) => r.state === 'generated'))
  /** Already-committed job rows (terminal). */
  const jobCommittedRows = computed(() => state.jobRows.filter((r) => r.state === 'committed'))
  /** Skipped (UNCHARGED) job rows. */
  const jobSkippedRows = computed(() => state.jobRows.filter((r) => r.state === 'skipped'))
  /** Failure (CHARGED, non-confirmable) job rows. */
  const jobFailureRows = computed(() => state.jobRows.filter((r) => r.state === 'failure'))
  /** Never-generated (cancelled before reach — UNCHARGED) job rows. */
  const jobPendingNotGeneratedRows = computed(() => state.jobRows.filter((r) => r.state === 'pending_not_generated'))
  const quotaPaused = computed(() => state.job?.quotaPaused === true)

  // --- Unified selection (the ONE source of "what is selectable") ---
  // Inline mode: confirmable rows[] (masked included). Job mode: `generated` rows
  // ONLY. Deriving everything from this makes "only generated rows selectable"
  // structural, not a second hand-written guard.
  const selectableIds = computed<string[]>(() =>
    isJob.value ? jobGeneratedRows.value.map((r) => r.recordId) : rows.value.map((r) => r.recordId),
  )
  const confirmableCount = computed(() => selectableIds.value.length)
  const selectedCount = computed(() => selected.value.size)
  const allConfirmableSelected = computed(
    () => confirmableCount.value > 0 && selectedCount.value === confirmableCount.value,
  )

  /** Toggle one selectable row. A non-selectable recordId is silently ignored. */
  function toggleRow(recordId: string): void {
    if (!selectableIds.value.includes(recordId)) return
    const next = new Set(selected.value)
    if (next.has(recordId)) next.delete(recordId)
    else next.add(recordId)
    selected.value = next
  }

  function selectAllConfirmable(): void {
    selected.value = new Set(selectableIds.value)
  }

  function clearSelection(): void {
    selected.value = new Set()
  }

  /**
   * Phase 1 — start the bulk fill. ≤ cap → an INLINE preview (CHARGES the
   * provider per row; the response separates confirmable/skipped/failures, B-3).
   * OVER cap → the backend returns `{ jobId }` and we switch to the async job
   * flow (poll → review → commit). Returns the preview data (inline), null
   * (job mode entered — caller reads job state), or null on a guarded no-op /
   * error (state.error set).
   */
  async function preview(input: AiBulkPreviewInput): Promise<AiBulkPreviewData | null> {
    if (busy.value) return null
    // Cancel any stale poll loop from a prior run (bumps pollToken) BEFORE we
    // capture the token this run will use.
    clearPoll()
    state.phase = 'previewing'
    state.preview = null
    state.commit = null
    state.jobId = null
    state.job = null
    state.jobRows = []
    state.jobCommit = null
    state.error = null
    selected.value = new Set()
    try {
      const start = await opts.client.aiBulkPreview(opts.sheetId(), input)
      if (isAiBulkJobStart(start)) {
        // Over cap → async job. Begin polling (first poll fires immediately).
        state.jobId = start.jobId
        state.phase = 'polling'
        const token = pollToken // the token this poll run owns
        await pollStep(token)
        return null
      }
      // Inline path — UNCHANGED from B-3.
      state.preview = start
      // Default selection: ALL confirmable rows (masked included — masked is a
      // flag on a writable row, never an exclusion). skipped/failures excluded.
      selected.value = new Set(start.rows.map((r) => r.recordId))
      state.phase = 'review'
      return start
    } catch (err) {
      fail(err)
      state.phase = 'idle'
      return null
    }
  }

  /**
   * One poll tick for the async job: read the header, render progress, and either
   * reschedule (still queued/running) or transition to the committable review /
   * done. Captures `token` at entry and bails after each await if it no longer
   * matches (the dialog was closed / a new run started) — never resurrects.
   */
  async function pollStep(token: number): Promise<void> {
    const jobId = state.jobId
    if (!jobId) return
    let header: AiBulkJobPoll
    try {
      header = await opts.client.getBulkJob(opts.sheetId(), jobId)
    } catch (err) {
      if (token !== pollToken) return
      // A thrown poll STOPS (no reschedule — never an infinite error loop).
      clearPoll()
      fail(err)
      state.phase = 'idle'
      return
    }
    if (token !== pollToken) return
    state.job = header

    if (!POLL_STOP_STATUSES.has(header.state)) {
      // Still generating → reschedule the next tick.
      pollTimer = setTimeout(() => {
        void pollStep(token)
      }, pollIntervalMs)
      return
    }

    // Terminal-for-this-session. No timer is pending for this tick (we only
    // schedule when rescheduling), so there is nothing to clearPoll here — and
    // bumping the token would invalidate THIS owning continuation. Resolve into
    // review/done directly. (A later loadAllJobRows await is still token-safe
    // because reset()/a new run bump the token, and we re-check below.)
    if (header.state === 'resolved') {
      // Defensive: a job that resolved without our commit (effectively
      // unreachable in one dialog session) → straight to done with its counts.
      state.phase = 'jobDone'
      return
    }
    if (COMMITTABLE_STATUSES.has(header.state)) {
      await loadAllJobRows(jobId, token)
      return
    }
  }

  /**
   * Fetch ALL review rows by following nextCursor, accumulating, then default-
   * select every `generated` row and enter jobReview.
   *
   * FAIL-CLOSED on incomplete pagination (BJ-9 — review-before-write MUST show the
   * COMPLETE job-rows diff; otherwise the user could confirm what they think is the
   * whole batch but is only the loaded prefix). The ONLY path into `jobReview` is a
   * genuine completion (`nextCursor == null`). A page-load error (even after partial
   * pages), a non-advancing cursor, or MAX_ROW_PAGES exhaustion all land in
   * `jobLoadError` with NO selection and NO rows — never a confirmable review.
   * cancelJob() reuses this loader, so it inherits the same guarantee. Token-aware:
   * a dialog close mid-fetch (reset bumps the token) aborts before any state write.
   */
  async function loadAllJobRows(jobId: string, token: number): Promise<void> {
    const all: AiBulkJobRow[] = []
    let cursor: number | null = null
    let completed = false
    // Fail-closed: clear any prior rows/selection up front so no incomplete-load
    // path can leave a confirmable selection or a stale diff behind.
    state.jobRows = []
    selected.value = new Set()
    try {
      for (let page = 0; page < MAX_ROW_PAGES; page += 1) {
        const res = await opts.client.getBulkJobRows(opts.sheetId(), jobId, cursor)
        if (token !== pollToken) return
        all.push(...res.rows)
        if (res.nextCursor == null) {
          completed = true
          break
        }
        if (res.nextCursor === cursor) break // non-advancing cursor → INCOMPLETE
        cursor = res.nextCursor
      }
    } catch (err) {
      if (token !== pollToken) return
      // A page failed mid-pagination — NEVER review on a partial load. Surface the
      // error and stop in the fail-closed state.
      fail(err)
      state.phase = 'jobLoadError'
      return
    }
    if (token !== pollToken) return
    if (!completed) {
      // Non-advancing cursor or MAX_ROW_PAGES exhausted → the diff is truncated.
      // Fail-closed rather than letting the user confirm an incomplete batch.
      state.phase = 'jobLoadError'
      return
    }
    // Pagination genuinely completed (nextCursor == null) → safe to review.
    state.jobRows = all
    // Default selection = ALL `generated` rows (the only confirmable ones).
    selected.value = new Set(all.filter((r) => r.state === 'generated').map((r) => r.recordId))
    state.phase = 'jobReview'
  }

  /**
   * Retry a failed review load (from `jobLoadError`). Re-runs the fail-closed loader
   * for the current job; on success it enters jobReview, on a repeat failure it
   * stays in jobLoadError. Token-safe (a closed/reset dialog won't reload).
   */
  async function retryJobLoad(): Promise<void> {
    const jobId = state.jobId
    if (!jobId || state.phase !== 'jobLoadError') return
    clearError()
    state.phase = 'polling' // loading indicator while we re-fetch the rows
    await loadAllJobRows(jobId, pollToken)
  }

  /**
   * Phase 2 (INLINE) — commit the SELECTED confirmable rows (writes the CACHED
   * outputs; no new provider call / charge). Returns the per-row outcomes, or
   * null on a guarded no-op / error. A row may come back stale/conflict/no-perm/
   * not-in-cache even though it was confirmable at preview (commit re-gates).
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

  /**
   * Phase 2 (JOB) — commit the SELECTED `generated` rows. The FE sends the
   * confirmed recordIds ONCE; the BACKEND chunks internally (never loop here).
   * Returns the commit result (counts + state:'resolved'), or null on a guarded
   * no-op / error. A 409 (not committable / already committing) surfaces and
   * stays in jobReview.
   */
  async function commitJob(): Promise<AiBulkJobCommitData | null> {
    if (busy.value) return null
    const jobId = state.jobId
    if (!jobId) return null
    const recordIds = [...selected.value]
    if (recordIds.length === 0) return null
    state.phase = 'jobCommitting'
    state.error = null
    try {
      const data = await opts.client.commitBulkJob(opts.sheetId(), jobId, recordIds)
      state.jobCommit = data
      state.phase = 'jobDone'
      return data
    } catch (err) {
      fail(err)
      // Stay in review so the user can retry the same selection.
      state.phase = 'jobReview'
      return null
    }
  }

  /**
   * Cancel an async job (BJ-4). Stops the worker at the next row; already-
   * generated rows stay charged + committable, so on success we transition INTO
   * the committable review (fetch rows + still offer commit), NOT close. Returns
   * true on a successful cancel. Stops polling first.
   */
  async function cancelJob(): Promise<boolean> {
    const jobId = state.jobId
    if (!jobId) return false
    clearPoll()
    const token = pollToken
    try {
      await opts.client.cancelBulkJob(opts.sheetId(), jobId)
    } catch (err) {
      if (token !== pollToken) return false
      fail(err)
      // Resilience: the cancel did not land, so the worker may still be running. We
      // cleared polling above — resume it so the UI shows LIVE progress instead of
      // freezing on stale numbers until the user retries cancel. pollStep stops cleanly
      // on its own if the backend is genuinely down; a later cancel re-clears via clearPoll().
      if (state.phase === 'polling') {
        await pollStep(token)
      }
      return false
    }
    if (token !== pollToken) return false
    // Read the post-cancel header for truthful counts, then load the committable
    // (already-generated) rows into review.
    try {
      state.job = await opts.client.getBulkJob(opts.sheetId(), jobId)
    } catch {
      // Non-fatal — the rows fetch still drives review.
    }
    if (token !== pollToken) return false
    await loadAllJobRows(jobId, token)
    return true
  }

  /** Reset to idle (e.g. dialog closed) — clears everything + stops polling/countdown. */
  function reset(): void {
    clearCountdown()
    clearPoll()
    state.phase = 'idle'
    state.preview = null
    state.commit = null
    state.jobId = null
    state.job = null
    state.jobRows = []
    state.jobCommit = null
    state.error = null
    selected.value = new Set()
  }

  /** Dismiss only the error (keep the current phase/preview/job). */
  function clearError(): void {
    state.error = null
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (countdownTimer) clearInterval(countdownTimer)
      if (pollTimer) clearTimeout(pollTimer)
      pollToken += 1
    })
  }

  return {
    state,
    busy,
    isJob,
    selected,
    // inline derived buckets
    rows,
    skipped,
    failures,
    partial,
    settledCost,
    confirmableCount,
    selectedCount,
    allConfirmableSelected,
    // job derived buckets
    jobGeneratedRows,
    jobCommittedRows,
    jobSkippedRows,
    jobFailureRows,
    jobPendingNotGeneratedRows,
    quotaPaused,
    // actions
    preview,
    commit,
    commitJob,
    cancelJob,
    retryJobLoad,
    toggleRow,
    selectAllConfirmable,
    clearSelection,
    reset,
    clearError,
  }
}

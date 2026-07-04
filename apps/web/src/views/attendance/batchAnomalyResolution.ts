// #3530 batch anomaly resolution — pure, testable orchestration.
//
// The AE-1 single-row correction route (`POST /api/attendance/anomaly-result-edits`)
// stays the sole write path. This module holds ONLY the pure pieces the design-lock
// gates care about — the row-cap rule, the per-row snapshot shape, and the sequential
// runner — so they can be unit-tested in isolation (inject a fake `submitOne`) without
// mounting the 28k-line SFC. It performs no network, no Vue reactivity, no policy
// decision: the backend remains the authority for every row.
//
// Design lock: docs/development/attendance-anomaly-batch-resolution-design-lock-20260703.md

export const BATCH_ANOMALY_MAX_ROWS = 50

export interface BatchAnomalyRowSnapshot {
  recordId: string
  workDate: string
  /** The committed anomaly-list query target — NOT a per-row employee identity. */
  targetUserId: string
  sourceStatus: string
  request: unknown | null
  warnings: string[]
  idempotencyKey: string
}

export type BatchAnomalyRowState = 'submitting' | 'ok' | 'error'

export interface BatchAnomalyRowResult {
  recordId: string
  state: BatchAnomalyRowState
  editId?: string
  beforeStatus?: string
  afterStatus?: string
  notificationDeliveryId?: string | null
  notificationSkippedReason?: string | null
  alreadyApplied?: boolean
  errorMessage?: string
}

export type BatchAnomalyOutcome = 'idle' | 'running' | 'completed' | 'completed_with_errors'

/** 1..50 selected rows may be submitted. Over the cap disables submit (design §4.3). */
export function canRunBatchAnomalyResolution(selectedCount: number): boolean {
  return selectedCount >= 1 && selectedCount <= BATCH_ANOMALY_MAX_ROWS
}

/**
 * Aggregate per-row results into the batch outcome. A batch is only `completed`
 * when EVERY row is ok/alreadyApplied; a single failure yields
 * `completed_with_errors` (design §4.5 — never claim full success on any failure).
 */
export function summarizeBatchAnomalyOutcome(results: BatchAnomalyRowResult[]): BatchAnomalyOutcome {
  if (results.length === 0) return 'idle'
  if (results.some(r => r.state === 'submitting')) return 'running'
  if (results.some(r => r.state === 'error')) return 'completed_with_errors'
  return 'completed'
}

export type BatchSubmitOutcome =
  | { ok: true; result: Omit<BatchAnomalyRowResult, 'recordId' | 'state'> }
  | { ok: false; errorMessage: string }

/**
 * Submit each row sequentially through the injected `submitOne`. Rows already marked
 * `ok` in `current` are NOT re-submitted (retry from the same modal only re-runs
 * non-succeeded rows — design §4.3). A row failure does not stop the others; the final
 * map carries every row's outcome. `onProgress` fires after each state transition so the
 * UI can render per-row results live. Returns the accumulated result map (a fresh copy).
 */
export async function runBatchAnomalyResolution(
  rows: BatchAnomalyRowSnapshot[],
  current: Map<string, BatchAnomalyRowResult>,
  submitOne: (row: BatchAnomalyRowSnapshot) => Promise<BatchSubmitOutcome>,
  onProgress?: (recordId: string, result: BatchAnomalyRowResult) => void,
): Promise<Map<string, BatchAnomalyRowResult>> {
  const results = new Map(current)
  for (const row of rows) {
    const existing = results.get(row.recordId)
    if (existing && existing.state === 'ok') continue
    const submitting: BatchAnomalyRowResult = { recordId: row.recordId, state: 'submitting' }
    results.set(row.recordId, submitting)
    onProgress?.(row.recordId, submitting)
    const outcome = await submitOne(row)
    const next: BatchAnomalyRowResult = outcome.ok
      ? { recordId: row.recordId, state: 'ok', ...outcome.result }
      : { recordId: row.recordId, state: 'error', errorMessage: outcome.errorMessage }
    results.set(row.recordId, next)
    onProgress?.(row.recordId, next)
  }
  return results
}

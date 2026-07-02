import type { ApprovalActionRequest } from '../types/approval'

/**
 * Batch approval-action orchestration (approval-center 操作台). The backend exposes only single-instance
 * `POST /api/approvals/:id/actions`; "batch approve/reject" is therefore a FRONTEND fan-out over the same
 * authoritative per-instance endpoint (every row still runs the full server-side guard/transition). This
 * module is the pure, Element-Plus-free orchestration core so the concurrency + partial-failure manifest is
 * unit-testable independently of the view.
 *
 * Semantics:
 * - Bounded concurrency (default 4) so a large selection can't open hundreds of simultaneous requests.
 * - Per-row isolation: one row's rejection/throw NEVER aborts the batch; it lands in `failed` with its
 *   message and the rest continue (mirrors the server's per-instance transaction boundary).
 * - Order-independent; the manifest is keyed by id so the caller can map results back to rows.
 */
export interface ApprovalBatchActionResult {
  succeeded: string[]
  failed: Array<{ id: string; message: string }>
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return 'Unknown error'
}

export async function runApprovalBatchAction(
  ids: readonly string[],
  makeRequest: (id: string) => ApprovalActionRequest,
  dispatch: (id: string, req: ApprovalActionRequest) => Promise<unknown>,
  options: { concurrency?: number } = {},
): Promise<ApprovalBatchActionResult> {
  const result: ApprovalBatchActionResult = { succeeded: [], failed: [] }
  const uniqueIds = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
  if (uniqueIds.length === 0) return result

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, uniqueIds.length))
  let cursor = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= uniqueIds.length) return
      const id = uniqueIds[index]
      try {
        await dispatch(id, makeRequest(id))
        result.succeeded.push(id)
      } catch (err) {
        result.failed.push({ id, message: errorMessage(err) })
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return result
}

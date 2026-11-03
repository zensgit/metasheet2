import { reactive } from 'vue'
import { getApproval } from './api'
import {
  approvalStatusTagProps,
  needsCancelRoundCloseReason,
  type ApprovalStatusTagSource,
  type CancelRoundCloseReasonState,
} from './cancelRound'

/**
 * P-2 on the LIST surfaces (ApprovalCenterTable / ApprovalMobileList).
 *
 * A list DTO does not carry `cancelRoundCloseReason` — only the detail read (`getApproval`) projects
 * it — and a cancel-round instance whose engine status is `rejected` may be an approver's rejection
 * (V3) or a system closure (V5 / V6). The list must not guess: for exactly those rows (cancel round
 * AND `rejected` AND no reason on the row) this reads the detail once, renders 「读取中」 while it is in
 * flight and 「暂时无法读取」 if it fails (never V3, never the approvalInstance 「已驳回」), and keeps
 * the answer — a rejected instance is terminal, so its close reason cannot change.
 *
 * The detail read sits behind the same approval read guard as the list the row came from, and the
 * per-instance read fence is on the cancel-round instance the viewer already sees in that list.
 * A list-DTO projection of the reason would make this read unnecessary; that is a backend change and
 * is recorded as a residual in the phase-B design MD.
 */
type Row = ApprovalStatusTagSource & { id: string }

const states = reactive(new Map<string, CancelRoundCloseReasonState>())
const inFlight = new Set<string>()

/** Test hook. */
export function resetCancelRoundCloseReasonCache(): void {
  states.clear()
  inFlight.clear()
}

function resolveOne(id: string): void {
  if (inFlight.has(id)) return
  inFlight.add(id)
  states.set(id, { kind: 'resolving' })
  getApproval(id)
    .then((dto) => {
      const reason = (dto as { cancelRoundCloseReason?: unknown } | null)?.cancelRoundCloseReason
      states.set(id, { kind: 'resolved', closeReason: typeof reason === 'string' ? reason : null })
    })
    .catch(() => {
      states.set(id, { kind: 'unavailable' })
    })
    .finally(() => {
      inFlight.delete(id)
    })
}

export function useCancelRoundCloseReasons() {
  /** Start (or retry after a failure) the detail read for every row that needs it. */
  function ensure(rows: readonly Row[] | null | undefined): void {
    for (const row of rows ?? []) {
      if (!needsCancelRoundCloseReason(row)) continue
      const current = states.get(row.id)
      if (current && current.kind !== 'unavailable') continue
      resolveOne(row.id)
    }
  }

  function stateFor(row: Row): CancelRoundCloseReasonState | undefined {
    if (!needsCancelRoundCloseReason(row)) return undefined
    return states.get(row.id) ?? { kind: 'resolving' }
  }

  /** `{ domain, status }` for the row's StatusTag. */
  function tagProps(row: Row) {
    return approvalStatusTagProps(row, stateFor(row))
  }

  return { ensure, stateFor, tagProps }
}

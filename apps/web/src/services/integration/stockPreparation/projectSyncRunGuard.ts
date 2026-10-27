// 备料 project sync panel — WHICH BOARD A FINISHED 同步 MAY RENDER ON (#6591 review, follow-up O2).
//
// A 同步 run reads PLM and writes the project's sheet; it can take minutes. Meanwhile the board that hosts the
// panel may open another project, the integration scope may move, or another principal may take the browser
// session. The run's server-side writes are complete and correct for the project it was started on — what must
// not happen is the panel rendering that project's verdict (「已导入」…) on the board of the project now open, or
// telling the board `synced(report)` so the board's 「下一步」 bar reads another project's report.
//
// This guard is the panel's half of that rule, deliberately self-contained (no dependency on the 「核对」 lane's
// own generation) so the one fix applies wherever the panel's run path is the same:
//   * `invalidate()` bumps a generation; the panel calls it when the project / scope it is about changes, and the
//     guard calls it itself when the browser session actually switches (`onAuthSessionSwitch`, not the raw reset
//     funnel, because invalidating also CLEARS what the panel shows).
//   * `ticket()` is taken before a run's first await; `isCurrent(ticket)` is asked when the run lands. The session
//     is compared BY VALUE at landing as well, because another tab replacing the token notifies nobody.
//   * `dispose()` on unmount: nothing lands into a torn-down panel.
//
// NOTHING HERE IS AN AUTHORIZATION VALUE: the signature is only ever compared for equality, every gate is server-side.

import { onAuthSessionSwitch, readAuthSessionSignature } from '../../../composables/authPrincipal'

export interface StockPrepProjectSyncRunTicket {
  readonly generation: number
  readonly session: string
}

export interface StockPrepProjectSyncRunGuard {
  /** The project / scope / session this panel is about changed: every run in flight lands nowhere. */
  invalidate(): void
  /** Taken before a run's first await. */
  ticket(): StockPrepProjectSyncRunTicket
  /** Whether a run that took `ticket` may still render its outcome and tell the board about it. */
  isCurrent(ticket: StockPrepProjectSyncRunTicket): boolean
  /** Unmount: nothing lands any more, and the session subscription is released. */
  dispose(): void
}

/**
 * The session the panel is acting for, as one comparable string: the principal + token (authPrincipal.ts), plus
 * the access snapshot — a focus refresh can replace the snapshot without rotating the token. Unreadable session
 * metadata collapses to `'invalid'`, which never counts as current.
 */
export function readStockPrepProjectSyncRunSession(): string {
  try {
    const session = readAuthSessionSignature()
    if (session === 'invalid') return 'invalid'
    return JSON.stringify([session, localStorage.getItem('user_permissions'), localStorage.getItem('user_roles')])
  } catch {
    return 'invalid'
  }
}

export function createStockPrepProjectSyncRunGuard(onInvalidate: () => void): StockPrepProjectSyncRunGuard {
  let generation = 0
  let mounted = true
  function invalidate(): void {
    generation += 1
    if (mounted) onInvalidate()
  }
  const stopSessionSwitch = onAuthSessionSwitch(invalidate)
  return {
    invalidate,
    ticket: () => ({ generation, session: readStockPrepProjectSyncRunSession() }),
    isCurrent(ticket: StockPrepProjectSyncRunTicket): boolean {
      if (!mounted || ticket.generation !== generation || ticket.session === 'invalid') return false
      return ticket.session === readStockPrepProjectSyncRunSession()
    },
    dispose(): void {
      mounted = false
      generation += 1
      stopSessionSwitch()
    },
  }
}

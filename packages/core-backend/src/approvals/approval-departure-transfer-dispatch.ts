import { Logger } from '../core/logger'
import { query } from '../db/pg'
import {
  resolveApprovalDepartureManagerFromContext,
  type ApprovalDepartureManagerContext,
} from '../services/ApprovalDirectoryOrg'
import { ApprovalProductService } from '../services/ApprovalProductService'

type QueryFn = <Row>(text: string, params?: unknown[]) => Promise<{ rows: Row[] }>

type ApprovalDepartureSignalRow = {
  directory_account_id: string
  local_user_id: string
}

export interface ApprovalDepartureDispatchResult {
  signalCount: number
  dispatchedCount: number
  failedCount: number
  unresolvedContextCount: number
}

type ApprovalDepartureDispatchDeps = {
  query?: QueryFn
  approvals?: Pick<ApprovalProductService, 'applyApprovalDepartureTransfer'>
  resolveManager?: typeof resolveApprovalDepartureManagerFromContext
}

const logger = new Logger('ApprovalDepartureTransferDispatch')

/**
 * Consume only the durable `user_changed` effects committed by this exact sync run. Directory sync
 * calls this after its transaction commits, so approval writes cannot survive a rolled-back
 * deprovision. Per-user failures are isolated: one bad approval must not suppress another user's
 * departure handling or retroactively falsify the already-completed directory run.
 */
export async function dispatchApprovalDepartureTransfersForRun(
  input: {
    runId: string
    integrationId: string
    managerContexts: ReadonlyMap<string, ApprovalDepartureManagerContext>
  },
  deps: ApprovalDepartureDispatchDeps = {},
): Promise<ApprovalDepartureDispatchResult> {
  const queryFn = deps.query ?? (query as QueryFn)
  const approvals = deps.approvals ?? new ApprovalProductService()
  const resolveManager = deps.resolveManager ?? resolveApprovalDepartureManagerFromContext

  const signalRows = await queryFn<ApprovalDepartureSignalRow>(
    `SELECT DISTINCT event.directory_account_id::text AS directory_account_id,
            event.local_user_id AS local_user_id
       FROM directory_deprovision_events event
       JOIN directory_deprovision_effects effect
         ON effect.event_id = event.id
        AND effect.local_user_id = event.local_user_id
      WHERE event.run_id = $1::uuid
        AND event.integration_id = $2::uuid
        AND event.event_origin = 'sync'
        AND event.status = 'applied'
        AND effect.effect_type = 'user_changed'
        AND effect.status = 'applied'
      ORDER BY local_user_id ASC, directory_account_id ASC`,
    [input.runId, input.integrationId],
  )

  const result: ApprovalDepartureDispatchResult = {
    signalCount: signalRows.rows.length,
    dispatchedCount: 0,
    failedCount: 0,
    unresolvedContextCount: 0,
  }

  for (const signal of signalRows.rows) {
    let resolvedManagerId: string | null = null
    const context = input.managerContexts.get(signal.directory_account_id)
    if (!context || context.integrationId !== input.integrationId) {
      result.unresolvedContextCount += 1
    } else {
      try {
        resolvedManagerId = (await resolveManager(context, queryFn)) ?? null
        if (!resolvedManagerId) result.unresolvedContextCount += 1
      } catch (_error) {
        result.unresolvedContextCount += 1
        logger.warn(
          'Approval departure manager resolution failed; applying fail-closed no-manager outcome',
          { reason: 'manager_resolution_failed' },
        )
      }
    }

    try {
      const transferResult = await approvals.applyApprovalDepartureTransfer(signal.local_user_id, {
        resolvedManagerId,
      })
      if (transferResult.skipped.some((entry) => entry.reason === 'error')) {
        result.failedCount += 1
        logger.warn(
          'Approval departure transfer completed with an instance error; manual recovery required',
          { reason: 'departure_transfer_instance_failed' },
        )
      } else {
        result.dispatchedCount += 1
      }
    } catch (_error) {
      result.failedCount += 1
      logger.warn(
        'Approval departure transfer failed after a committed directory signal; manual recovery required',
        { reason: 'departure_transfer_failed' },
      )
    }
  }

  return result
}

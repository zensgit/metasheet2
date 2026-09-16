import type { QueryFn } from './permission-service'
import type { RecoveryArchiveWorkerApplyCallbacks, RecoveryArchiveWorkerIdentity } from './recovery-archive-async-restore'
import { resolveDatabaseRecoverySheetAuthority, type RecoverySheetAuthority } from './recovery-authorization-stability'
import { createRecoveryAuthorizationStabilizer, createRecoveryPlanAuthorization } from './recovery-plan-authorization'

export type RecoveryArchiveWorkerAuthorization = {
  recheckAuthority: (query: QueryFn, identity: RecoveryArchiveWorkerIdentity) => Promise<boolean>
  apply: Omit<RecoveryArchiveWorkerApplyCallbacks, 'onMutationApplied'>
}

/** Bind the canonical full-read evaluator, never a cached request or startup actor. */
export function bindRecoveryArchiveWorkerAuthorization(
  fullRead: (query: QueryFn, sheetId: string, authority: RecoverySheetAuthority) => Promise<boolean>,
): RecoveryArchiveWorkerAuthorization {
  const stabilize = createRecoveryAuthorizationStabilizer()
  const matchesScope = async (query: QueryFn, identity: RecoveryArchiveWorkerIdentity): Promise<boolean> => {
    if ([identity.jobId, identity.workspaceId, identity.baseId, identity.sheetId, identity.actorId]
      .some((value) => typeof value !== 'string' || !value || value !== value.trim())) return false
    const result = await query(
      `SELECT sheet_row.base_id, base_row.workspace_id
         FROM public.meta_sheets sheet_row
         JOIN public.meta_bases base_row ON base_row.id = sheet_row.base_id
        WHERE sheet_row.id = $1 AND sheet_row.deleted_at IS NULL AND base_row.deleted_at IS NULL`,
      [identity.sheetId],
    )
    const row = result.rows[0] as { base_id?: unknown; workspace_id?: unknown } | undefined
    return result.rows.length === 1 && row?.base_id === identity.baseId && row?.workspace_id === identity.workspaceId
  }
  const recheckAuthority = async (query: QueryFn, identity: RecoveryArchiveWorkerIdentity): Promise<boolean> => {
    if (!(await matchesScope(query, identity))) return false
    const authority = await resolveDatabaseRecoverySheetAuthority(query, identity.sheetId, identity.actorId)
    if (authority.access.userId !== identity.actorId || !authority.capabilities.canManageSheetAccess) return false
    return fullRead(query, identity.sheetId, authority)
  }
  return {
    recheckAuthority,
    apply: {
      preliminaryFullRead: recheckAuthority,
      finalLockedFullRead: async (query, scope, identity) => (
        scope.authoritySheetIds.includes(identity.sheetId) && recheckAuthority(query, identity)
      ),
      stabilizeAuthorization: async (query, context, identity) => {
        if (context.actorId !== identity.actorId || context.sheetId !== identity.sheetId ||
          !(await matchesScope(query, identity))) return 'unavailable'
        return stabilize(query, context)
      },
      evaluatePlanAuthorization: async (query, context, identity) => {
        if (context.actorId !== identity.actorId || context.sheetId !== identity.sheetId ||
          !(await matchesScope(query, identity))) return false
        return createRecoveryPlanAuthorization(
          identity.sheetId,
          (transactionQuery, sheetId) => resolveDatabaseRecoverySheetAuthority(transactionQuery, sheetId, identity.actorId),
          fullRead,
        )(query, context)
      },
    },
  }
}

import type { QueryFn } from './permission-service'
import type { RecoveryArchiveWorkerApplyCallbacks, RecoveryArchiveWorkerIdentity } from './recovery-archive-async-restore'
import { resolveDatabaseRecoverySheetAuthority, type RecoverySheetAuthority } from './recovery-authorization-stability'
import { createRecoveryAuthorizationStabilizer, createRecoveryPlanAuthorization } from './recovery-plan-authorization'

export type RecoveryArchiveWorkerAuthorization = {
  recheckAuthority: (query: QueryFn, identity: RecoveryArchiveWorkerIdentity) => Promise<boolean>
  apply: Omit<RecoveryArchiveWorkerApplyCallbacks, 'onMutationApplied'>
}

export type RecoveryArchiveScopeIdentity = Pick<RecoveryArchiveWorkerIdentity, 'workspaceId' | 'baseId' | 'sheetId' | 'actorId'>

export async function matchesRecoveryArchiveLiveScope(query: QueryFn, identity: RecoveryArchiveScopeIdentity): Promise<boolean> {
  if ([identity.workspaceId, identity.baseId, identity.sheetId, identity.actorId]
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

/** Shared fresh evaluator for restore workers and manual capture; never grants cached actor authority. */
export function bindRecoveryArchiveScopeAuthorization(
  fullRead: (query: QueryFn, sheetId: string, authority: RecoverySheetAuthority) => Promise<boolean>,
) {
  return async (query: QueryFn, identity: RecoveryArchiveScopeIdentity): Promise<boolean> => {
    if (!(await matchesRecoveryArchiveLiveScope(query, identity))) return false
    const authority = await resolveDatabaseRecoverySheetAuthority(query, identity.sheetId, identity.actorId)
    if (authority.access.userId !== identity.actorId || !authority.capabilities.canManageSheetAccess) return false
    return fullRead(query, identity.sheetId, authority)
  }
}

/** Bind the canonical full-read evaluator, never a cached request or startup actor. */
export function bindRecoveryArchiveWorkerAuthorization(
  fullRead: (query: QueryFn, sheetId: string, authority: RecoverySheetAuthority) => Promise<boolean>,
): RecoveryArchiveWorkerAuthorization {
  const stabilize = createRecoveryAuthorizationStabilizer()
  const scopeAuthority = bindRecoveryArchiveScopeAuthorization(fullRead)
  const matchesScope = async (query: QueryFn, identity: RecoveryArchiveWorkerIdentity): Promise<boolean> => {
    if (typeof identity.jobId !== 'string' || !identity.jobId || identity.jobId !== identity.jobId.trim()) return false
    return matchesRecoveryArchiveLiveScope(query, identity)
  }
  const recheckAuthority = async (query: QueryFn, identity: RecoveryArchiveWorkerIdentity): Promise<boolean> => {
    if (typeof identity.jobId !== 'string' || !identity.jobId || identity.jobId !== identity.jobId.trim()) return false
    return scopeAuthority(query, identity)
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

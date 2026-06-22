import type {
  ApprovalAssigneeResolutionMetadata,
  ApprovalAssigneeSource,
  ApprovalNodeConfig,
  FormSchema,
} from '../types/approval-product'
import { ServiceError } from './ApprovalBridgeService'

export type ResolvedApprovalAssignment = {
  assignmentType: 'user' | 'role'
  assigneeId: string
  nodeKey: string
  sourceStep: number
  metadata?: ApprovalAssigneeResolutionMetadata
}

export interface ResolveApprovalAssigneesOptions {
  nodeKey: string
  sourceStep: number
  config: ApprovalNodeConfig
  formSchema?: FormSchema
  formSnapshot: Record<string, unknown>
  requesterSnapshot: Record<string, unknown> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function metadataFor(source: ApprovalAssigneeSource, sourceIndex: number): ApprovalAssigneeResolutionMetadata {
  return {
    resolvedFrom: {
      kind: source.kind,
      sourceIndex,
      ...(source.kind === 'form_field_user' ? { fieldId: source.fieldId } : {}),
    },
  }
}

function resolveFormUserValue(value: unknown): string | null {
  const stringId = normalizeId(value)
  if (stringId) return stringId
  if (isRecord(value)) {
    return normalizeId(value.id)
  }
  return null
}

// Source-of-truth for `form_field_user` field-type validation is publish-time
// (`validateApprovalAssigneeSourcesAgainstFormSchema` in ApprovalProductService).
// Runtime callers that operate against a frozen runtime graph + instance snapshots
// (dispatch / adminJump / return) intentionally do NOT pass `formSchema` here,
// because they must rely only on the published, frozen graph and never re-read
// active template tables. This belt-and-suspenders check only activates when a
// `formSchema` is available (i.e. createApproval path) and must not be turned
// into an active-template lookup.
function assertFormUserSource(
  source: Extract<ApprovalAssigneeSource, { kind: 'form_field_user' }>,
  formSchema: FormSchema | undefined,
  nodeKey: string,
): void {
  if (!formSchema) return
  const field = formSchema.fields.find((entry) => entry.id === source.fieldId)
  if (!field || field.type !== 'user') {
    throw new ServiceError(
      `Approval node ${nodeKey} references a non-user assignee field`,
      400,
      'APPROVAL_ASSIGNEE_INVALID_SOURCE',
      { nodeKey, fieldId: source.fieldId },
    )
  }
}

// Delegation map (delegator localUserId -> delegatee localUserId), read from the
// frozen instance snapshot. Both ids normalized; malformed entries dropped.
function extractDelegationMap(snapshot: Record<string, unknown> | null): Record<string, string> {
  const raw = snapshot?.delegations
  if (!isRecord(raw)) return {}
  const map: Record<string, string> = {}
  for (const [delegator, delegatee] of Object.entries(raw)) {
    const d = normalizeId(delegator)
    const t = normalizeId(delegatee)
    if (d && t) map[d] = t
  }
  return map
}

export function resolveApprovalAssignees(
  options: ResolveApprovalAssigneesOptions,
): ResolvedApprovalAssignment[] {
  const sources = options.config.assigneeSources
  if (!sources) {
    return (options.config.assigneeIds ?? []).map((assigneeId) => ({
      assignmentType: options.config.assigneeType === 'role' ? 'role' : 'user',
      assigneeId,
      nodeKey: options.nodeKey,
      sourceStep: options.sourceStep,
    }))
  }

  const resolved: ResolvedApprovalAssignment[] = []
  const seen = new Set<string>()
  // Delegation substitution map (delegator -> delegatee), frozen in the instance
  // snapshot at create. Applied inside pushResolved BEFORE the dedup key.
  const delegations = extractDelegationMap(options.requesterSnapshot)

  const pushResolved = (
    assignmentType: 'user' | 'role',
    assigneeId: string,
    source: ApprovalAssigneeSource,
    sourceIndex: number,
  ): void => {
    // Delegation (委托): a resolved USER assignee who is an active delegator routes to
    // the delegatee. Substituted HERE — before the dedup key — so `seen` dedups on the
    // delegatee: a delegatee already resolved by another source collapses to one. One
    // hop only (the delegatee's own delegation is not re-resolved); user-only.
    let finalId = assigneeId
    let delegatedFrom: string | undefined
    if (assignmentType === 'user') {
      const delegatee = delegations[assigneeId]
      if (delegatee && delegatee !== assigneeId) {
        delegatedFrom = assigneeId
        finalId = delegatee
      }
    }
    const key = `${assignmentType}:${finalId}`
    if (seen.has(key)) return
    seen.add(key)
    const metadata = metadataFor(source, sourceIndex)
    resolved.push({
      assignmentType,
      assigneeId: finalId,
      nodeKey: options.nodeKey,
      sourceStep: options.sourceStep,
      metadata: delegatedFrom ? { ...metadata, delegatedFrom } : metadata,
    })
  }

  sources.forEach((source, sourceIndex) => {
    switch (source.kind) {
      case 'static_user':
        source.userIds.forEach((userId) => pushResolved('user', userId, source, sourceIndex))
        break
      case 'static_role':
        source.roleIds.forEach((roleId) => pushResolved('role', roleId, source, sourceIndex))
        break
      case 'requester': {
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        if (requesterId) pushResolved('user', requesterId, source, sourceIndex)
        break
      }
      case 'direct_manager': {
        // Resolve to the requester's direct manager, frozen in the requester snapshot at
        // approval start (no live directory re-query during dispatch/admin-jump/return).
        // Self-exclusion: a manager that resolves to the requester is not a valid manager,
        // so we return empty here and let the node's emptyAssigneePolicy decide.
        const managerId = normalizeId(options.requesterSnapshot?.managerId)
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        if (managerId && managerId !== requesterId) {
          pushResolved('user', managerId, source, sourceIndex)
        }
        break
      }
      case 'dept_head': {
        // Resolve to the requester's department head, frozen in the requester snapshot at
        // approval start (no live directory re-query). Self-exclusion: a dept head that
        // resolves to the requester is not a valid approver, so we return empty and let the
        // node's emptyAssigneePolicy decide.
        const deptHeadId = normalizeId(options.requesterSnapshot?.deptHeadId)
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        if (deptHeadId && deptHeadId !== requesterId) {
          pushResolved('user', deptHeadId, source, sourceIndex)
        }
        break
      }
      case 'continuous_managers': {
        // Resolve to the requester's management chain (levels 1..source.levels),
        // frozen in the snapshot at start (no live directory re-query). pushResolved's
        // seen-set dedups a person appearing at two levels; self-exclusion drops a hop
        // that resolves to the requester. An empty result falls through to the node's
        // emptyAssigneePolicy; the node's approvalMode (会签 all / 或签 any) then governs
        // how the resolved chain must act.
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        const rawChain = options.requesterSnapshot?.managerChainIds
        const chain = Array.isArray(rawChain) ? rawChain : []
        chain.slice(0, source.levels).forEach((entry) => {
          const managerId = normalizeId(entry)
          if (managerId && managerId !== requesterId) {
            pushResolved('user', managerId, source, sourceIndex)
          }
        })
        break
      }
      case 'manager_at_level': {
        // Resolve to a SINGLE level of the requester's management chain (the
        // `source.level`-th manager, level 1 = direct manager), frozen in the
        // snapshot. Self-exclusion drops a hop resolving to the requester; an empty
        // result (chain shorter than `level`) falls through to emptyAssigneePolicy.
        // Authoring N nodes at levels 1..N composes sequential 逐级 approval (B1).
        // managerChainIds is DENSE — resolveManagerChain (ApprovalDirectoryOrg) walks
        // THROUGH unlinked/self rungs at snapshot-build (pushes only linked, non-self
        // ids), so chain[level-1] is the level-th *linked* manager. The design's
        // "positional pick" and "skip-unlinked walk" reconcile here: the walk already
        // happened at build. A null rung (defensive, never produced by the builder)
        // resolves that level to empty via normalizeId — positional, no compaction.
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        const rawChain = options.requesterSnapshot?.managerChainIds
        const chain = Array.isArray(rawChain) ? rawChain : []
        const managerId = normalizeId(chain[source.level - 1])
        if (managerId && managerId !== requesterId) {
          pushResolved('user', managerId, source, sourceIndex)
        }
        break
      }
      case 'form_field_user': {
        assertFormUserSource(source, options.formSchema, options.nodeKey)
        const assigneeId = resolveFormUserValue(options.formSnapshot[source.fieldId])
        if (assigneeId) pushResolved('user', assigneeId, source, sourceIndex)
        break
      }
      default:
        throw new ServiceError(
          `Approval node ${options.nodeKey} has an unsupported assignee source`,
          400,
          'APPROVAL_ASSIGNEE_INVALID_SOURCE',
          { nodeKey: options.nodeKey },
        )
    }
  })

  return resolved
}

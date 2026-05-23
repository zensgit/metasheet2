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

  const pushResolved = (
    assignmentType: 'user' | 'role',
    assigneeId: string,
    source: ApprovalAssigneeSource,
    sourceIndex: number,
  ): void => {
    const key = `${assignmentType}:${assigneeId}`
    if (seen.has(key)) return
    seen.add(key)
    resolved.push({
      assignmentType,
      assigneeId,
      nodeKey: options.nodeKey,
      sourceStep: options.sourceStep,
      metadata: metadataFor(source, sourceIndex),
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

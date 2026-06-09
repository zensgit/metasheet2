import { Logger } from '../core/logger'
import { eventBus } from '../integration/events/event-bus'

const logger = new Logger('ApprovalCompletionEvent')

export type ApprovalCompletionOutcome = 'approved' | 'rejected' | 'revoked' | 'cancelled'
export type ApprovalCompletionEventType =
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.revoked'
  | 'approval.cancelled'

export type ApprovalCompletionTransitionAction =
  | 'approve'
  | 'reject'
  | 'revoke'
  | 'jump'
  | 'auto_approve'

export interface ApprovalCompletionInstanceSnapshot {
  id: string
  request_no?: string | null
  template_id?: string | null
  template_version_id?: string | null
  published_definition_id?: string | null
  business_key?: string | null
  workflow_key?: string | null
  requester_snapshot?: unknown
}

export interface ApprovalCompletionActorSnapshot {
  id: string
  name?: string | null
}

export interface ApprovalCompletionTransitionSnapshot {
  action: ApprovalCompletionTransitionAction
  fromStatus: string | null
  toStatus: ApprovalCompletionOutcome
  fromVersion: number | null
  toVersion: number
  nodeKey: string | null
}

export interface ApprovalCompletionEventV1 {
  version: 1
  eventId: string
  eventType: ApprovalCompletionEventType
  occurredAt: string
  source: 'approval-product'
  approval: {
    instanceId: string
    requestNo: string | null
    templateId: string | null
    templateVersionId: string | null
    publishedDefinitionId: string | null
    businessKey: string | null
    workflowKey: string | null
  }
  transition: ApprovalCompletionTransitionSnapshot
  actor: {
    id: string
    name: string | null
  } | null
  requester: {
    id: string | null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export function approvalCompletionEventTypeForOutcome(
  outcome: ApprovalCompletionOutcome,
): ApprovalCompletionEventType {
  return `approval.${outcome}` as ApprovalCompletionEventType
}

export function buildApprovalCompletionEvent(input: {
  instance: ApprovalCompletionInstanceSnapshot
  transition: ApprovalCompletionTransitionSnapshot
  actor?: ApprovalCompletionActorSnapshot | null
  occurredAt?: Date
}): ApprovalCompletionEventV1 {
  const eventType = approvalCompletionEventTypeForOutcome(input.transition.toStatus)
  const requesterSnapshot = isRecord(input.instance.requester_snapshot)
    ? input.instance.requester_snapshot
    : {}

  return {
    version: 1,
    eventId: `approval:${input.instance.id}:${input.transition.toVersion}:${eventType}`,
    eventType,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    source: 'approval-product',
    approval: {
      instanceId: input.instance.id,
      requestNo: nullableString(input.instance.request_no),
      templateId: nullableString(input.instance.template_id),
      templateVersionId: nullableString(input.instance.template_version_id),
      publishedDefinitionId: nullableString(input.instance.published_definition_id),
      businessKey: nullableString(input.instance.business_key),
      workflowKey: nullableString(input.instance.workflow_key),
    },
    transition: input.transition,
    actor: input.actor
      ? {
          id: input.actor.id,
          name: nullableString(input.actor.name),
        }
      : null,
    requester: {
      id: nullableString(requesterSnapshot['id']),
    },
  }
}

export function emitApprovalCompletionEvent(event: ApprovalCompletionEventV1): void {
  try {
    eventBus.emit(event.eventType, event)
  } catch (error) {
    logger.warn(
      `approval completion event ${event.eventId} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

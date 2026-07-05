import { Logger } from '../core/logger'
import { eventBus } from '../integration/events/event-bus'

const logger = new Logger('ApprovalTaskCreatedEvent')

/**
 * A-2a (one-tap design-lock #3594, implementation decision ratified 2026-07-05): a NEW actionable
 * pending item for ONE recipient. Emitted post-commit for every user-typed assignment row
 * `insertAssignments` creates — node activations AND same-round mutations (transfer/add-sign/
 * reassign) alike, so a handover recipient gets a fresh task event too.
 *
 * Event granularity is "one assignment / one recipient". The eventId embeds
 * instanceId + nodeKey + entryEpoch + assigneeUserId so a return/jump that re-activates a node
 * (new epoch, nodeEntryEpoch design-lock) re-fires cleanly, while duplicate deliveries of the SAME
 * round dedupe via the T2-6 automation event-fire ledger (`approval.task_created:${eventId}`).
 * A legacy NULL epoch serializes as the literal 'null' segment — stable, documented, dedupe-safe.
 *
 * Payload is metadata-only (ids, request_no, node/epoch, requester id) — NO form values ride on
 * the event; consumers that need display content re-read server-side at execution time.
 */
export type ApprovalTaskCreatedEventType = 'approval.task_created'
export const APPROVAL_TASK_CREATED_EVENT_TYPE: ApprovalTaskCreatedEventType = 'approval.task_created'

export interface ApprovalTaskCreatedInstanceSnapshot {
  id: string
  request_no?: string | null
  template_id?: string | null
  template_version_id?: string | null
  published_definition_id?: string | null
  business_key?: string | null
  workflow_key?: string | null
  requester_snapshot?: unknown
}

/** One user-typed assignment row `insertAssignments` created (role-typed rows do not fire v1 events). */
export interface ApprovalTaskCreatedTaskSnapshot {
  nodeKey: string
  entryEpoch: number | null
  assigneeUserId: string
  sourceStep: number
}

export interface ApprovalTaskCreatedEventV1 {
  version: 1
  eventId: string
  eventType: ApprovalTaskCreatedEventType
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
  task: ApprovalTaskCreatedTaskSnapshot
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

export function buildApprovalTaskCreatedEvent(input: {
  instance: ApprovalTaskCreatedInstanceSnapshot
  task: ApprovalTaskCreatedTaskSnapshot
  occurredAt?: Date
}): ApprovalTaskCreatedEventV1 {
  const requesterSnapshot = isRecord(input.instance.requester_snapshot)
    ? input.instance.requester_snapshot
    : {}
  return {
    version: 1,
    eventId: `approval-task:${input.instance.id}:${input.task.nodeKey}:${String(input.task.entryEpoch)}:${input.task.assigneeUserId}`,
    eventType: APPROVAL_TASK_CREATED_EVENT_TYPE,
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
    task: input.task,
    requester: {
      id: nullableString(requesterSnapshot['id']),
    },
  }
}

export function emitApprovalTaskCreatedEvent(event: ApprovalTaskCreatedEventV1): void {
  try {
    eventBus.emit(event.eventType, event)
  } catch (error) {
    logger.warn(
      `approval task_created event ${event.eventId} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

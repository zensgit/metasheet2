import { Logger } from '../core/logger'
import { eventBus } from '../integration/events/event-bus'
import { isDurableDeliveryEnabled } from '../multitable/automation-durable-delivery'

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
  // P1#2e producer family 1 — REPLACE guard (the load-bearing suppression). When durable delivery is ON, the
  // SAME-transaction outbox enqueue at the END of every source txn (ApprovalProductService task_created sites
  // ×9, via the shared collector + `enqueueApprovalEventIfDurable`) is the delivery path. The only caller of
  // this legacy emit is `emitApprovalTaskCreatedEventsPostCommit`, and its full set of build sites all enqueue
  // in-txn, so a flag-ON legacy emit would DOUBLE-deliver (non-idempotent webhook sink). Flag OFF ⇒ legacy emit.
  if (isDurableDeliveryEnabled()) return
  try {
    eventBus.emit(event.eventType, event)
  } catch (error) {
    logger.warn(
      `approval task_created event ${event.eventId} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * P1#2e producer family 1 — the SHARED task_created recheck+dedup+instance-read+build core, parameterized on
 * the query fn so BOTH delivery legs run IDENTICAL filtering (semantics cannot drift):
 *   - flag-OFF post-commit leg (`emitApprovalTaskCreatedEventsPostCommit`) passes `pool.query` and emits each
 *     returned event — byte-identical to the pre-P1#2e inline logic;
 *   - flag-ON in-txn leg (`enqueueApprovalTaskCreatedEventsInTxn`) passes the SOURCE-TXN query fn and enqueues
 *     each returned event same-txn — so a same-transaction cascade deactivation (a row created THEN deactivated
 *     before COMMIT) is already reflected in `is_active`, exactly as the post-commit read sees committed state.
 *
 * Filtering (unchanged from the original recheck): keep only tasks whose `(nodeKey:entryEpoch:assigneeUserId)`
 * is BOTH still `is_active` (durable/txn state) AND not a duplicate within this batch (`seen`), then re-read the
 * instance snapshot ONCE and build a per-recipient event whose `eventId` is byte-identical to the legacy quad
 * (`approval-task:instanceId:nodeKey:entryEpoch:assigneeUserId`) so the T2-6 dedup ledger keys line up.
 */
export type ApprovalTaskCreatedQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>

export async function collectLiveApprovalTaskCreatedEvents(
  query: ApprovalTaskCreatedQueryFn,
  instanceId: string,
  tasks: ApprovalTaskCreatedTaskSnapshot[],
): Promise<ApprovalTaskCreatedEventV1[]> {
  if (tasks.length === 0) return []
  // Same-transaction cascades (auto-approve at entry, immediate handover) can deactivate a row BEFORE commit —
  // only still-active assignments are real pending items, so re-check against the query's view and drop the
  // rest (values-free: key fields only).
  const activeResult = await query(
    `SELECT node_key, assignee_id, entry_epoch FROM approval_assignments
      WHERE instance_id = $1 AND is_active = TRUE AND assignment_type = 'user'`,
    [instanceId],
  )
  const activeKeys = new Set(
    (activeResult.rows as Array<{ node_key: string; assignee_id: string; entry_epoch: number | string | null }>).map(
      (row) => `${row.node_key}:${row.entry_epoch === null ? 'null' : String(Number(row.entry_epoch))}:${row.assignee_id}`,
    ),
  )
  const seen = new Set<string>()
  const liveTasks = tasks.filter((task) => {
    const key = `${task.nodeKey}:${task.entryEpoch === null ? 'null' : String(task.entryEpoch)}:${task.assigneeUserId}`
    if (seen.has(key) || !activeKeys.has(key)) return false
    seen.add(key)
    return true
  })
  if (liveTasks.length === 0) return []
  const result = await query(
    `SELECT id, request_no, template_id, template_version_id, published_definition_id,
            business_key, workflow_key, requester_snapshot
       FROM approval_instances WHERE id = $1`,
    [instanceId],
  )
  const instance = result.rows[0] as unknown as ApprovalTaskCreatedInstanceSnapshot | undefined
  if (!instance) return []
  return liveTasks.map((task) => buildApprovalTaskCreatedEvent({ instance, task }))
}

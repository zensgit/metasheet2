import type { ApprovalAssigneeResolutionMetadata, ApprovalMode } from '../types/approval-product'

export type ApprovalSequentialQueueMetadata = NonNullable<ApprovalAssigneeResolutionMetadata['sequentialQueue']>

type SequentialAssignment = {
  metadata?: ApprovalAssigneeResolutionMetadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Stamp the executor's deterministic resolver order onto every sequential seat. */
export function applySequentialQueueMetadata<T extends SequentialAssignment>(
  assignments: readonly T[],
  approvalMode: ApprovalMode,
): T[] {
  if (approvalMode !== 'sequential') return [...assignments]
  const length = assignments.length
  return assignments.map((assignment, index) => ({
    ...assignment,
    metadata: {
      ...(assignment.metadata ?? {}),
      sequentialQueue: {
        position: index + 1,
        length,
        state: index === 0 ? 'active' : 'queued',
      },
    },
  }))
}

/** Parse persisted queue metadata without coercion. Malformed queue rows fail closed. */
export function readSequentialQueueMetadata(value: unknown): ApprovalSequentialQueueMetadata | null {
  if (!isRecord(value)) return null
  const queue = value.sequentialQueue
  if (!isRecord(queue)) return null
  const { position, length, state } = queue
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length)) return null
  if ((position as number) < 1 || (length as number) < 1 || (position as number) > (length as number)) return null
  if (state !== 'active' && state !== 'queued' && state !== 'completed') return null
  return { position: position as number, length: length as number, state }
}

export function isSequentialQueueActive(value: unknown): boolean {
  return readSequentialQueueMetadata(value)?.state === 'active'
}

/** Promote the next queued in-memory seat after an auto-approved head is removed. */
export function promoteNextSequentialQueueAssignment<T extends SequentialAssignment>(
  assignments: readonly T[],
): T[] | null {
  if (assignments.length === 0) return []
  const parsed = assignments.map((assignment) => readSequentialQueueMetadata(assignment.metadata))
  if (parsed.some((entry) => entry === null)) return null
  const queues = parsed as ApprovalSequentialQueueMetadata[]
  if (queues.some((entry) => entry.state !== 'queued')) return null
  const length = queues[0].length
  if (queues.some((entry) => entry.length !== length)) return null
  const ordered = queues
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.position - right.entry.position)
  const expectedStart = length - ordered.length + 1
  if (expectedStart < 1) return null
  if (ordered.some(({ entry }, index) => entry.position !== expectedStart + index)) return null
  const nextIndex = ordered[0].index
  return assignments.map((assignment, index) => index === nextIndex
    ? {
        ...assignment,
        metadata: {
          ...(assignment.metadata ?? {}),
          sequentialQueue: { ...queues[index], state: 'active' },
        },
      }
    : assignment)
}

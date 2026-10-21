/**
 * Idempotency for a new leave reversal. The existing `reverseLeaveBalanceDeduction`
 * short-circuits on `source_id = requestId`, so a later revision can never reverse
 * again. New paths key on document + revision + operation and must not call that
 * function.
 */

export interface LeaveRevisionReversalIdentityV1 {
  readonly documentId: string
  readonly revisionId: string
  readonly operationId: string
}

function requirePart(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes(':')) {
    throw new Error(`ATTENDANCE_LEAVE_REVERSAL_KEY_INVALID:${label}`)
  }
  return value
}

export function leaveRevisionReversalSourceIdV1(input: LeaveRevisionReversalIdentityV1): string {
  return [
    'leave-revision',
    requirePart(input.documentId, 'documentId'),
    requirePart(input.revisionId, 'revisionId'),
    requirePart(input.operationId, 'operationId'),
  ].join(':')
}

export interface LeaveBalanceEventProbeV1 {
  readonly sourceId: string
  readonly eventType: string
}

/** The old per-request short-circuit. A prior reverse for the request id stops every later call. */
export function legacyRequestReversalShortCircuitsV1(
  events: readonly LeaveBalanceEventProbeV1[],
  requestId: string,
): boolean {
  return events.some((event) => event.eventType === 'reverse' && event.sourceId === requestId)
}

/** A different revision or operation is a different source id, so the old reverse does not match. */
export function revisionReversalShortCircuitsV1(
  events: readonly LeaveBalanceEventProbeV1[],
  sourceId: string,
): boolean {
  return events.some((event) => event.eventType === 'reverse' && event.sourceId === sourceId)
}

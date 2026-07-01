import { randomUUID } from 'crypto'

export const EVENT_DEDUP_RETENTION_DAYS = 7
export const EVENT_DEDUP_LEDGER_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

export function newAutomationEventId(): string {
  return randomUUID()
}

export function withAutomationEventId<T extends Record<string, unknown>>(payload: T): T & { _eventId: string } {
  return {
    ...payload,
    _eventId: newAutomationEventId(),
  }
}

export function buildAutomationEventDedupKey(
  eventType: string,
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const eventId = typeof record._eventId === 'string' ? record._eventId.trim() : ''
  if (!eventId) return null
  return `${eventType}:${eventId}`
}

export function eventDedupRetentionCutoffIso(nowMs = Date.now()): string {
  return new Date(nowMs - EVENT_DEDUP_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

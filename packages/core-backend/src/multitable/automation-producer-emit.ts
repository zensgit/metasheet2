/**
 * P2 durable-delivery P1 #2 — the producer REPLACE seam (shared by every commit-then-emit site).
 *
 * Ratified semantics — FWB0 design lock (`approval-form-writeback-fwb0-designlock-20260712.md`) §Layer-1
 * lines 318-324: when the durable path is active the old `eventemitter3` path is "降级为非承重"; the design
 * "替换掉生产侧全部「提交后 emit」调用点 …… 切换后旧总线对这些事件族静音", and "稳态下双跑（两条都投）……
 * 都不允许存活". So flag ON ⇒ the durable outbox path REPLACES the legacy post-commit `eventBus.emit`. This is
 * REPLACE, not keep-both: keep-both is only the transitional cutover window, safe "仅仅因为 sink 是幂等的" —
 * and the webhook sink is NOT idempotent across paths (`WebhookService.deliverEvent` → `createDeliveryRecord`
 * persists a fresh delivery row per call with no event-id dedup), so keep-both would DOUBLE-deliver webhooks.
 *
 * Each producer site has TWO phases, because the emit is architecturally decoupled from the source
 * transaction (it fires POST-commit, after the `withTransaction`/service txn closes):
 *   1. `enqueueRecordEventIfDurable(trx, ...)` — INSIDE the source txn, on the SUCCESS path: flag ON ⇒ a
 *      same-transaction outbox enqueue (atomic with the source write; the xid probe rejects a non-txn handle);
 *      flag OFF ⇒ no-op.
 *   2. `emitRecordEventIfLegacy(bus, ...)` — AFTER commit: flag OFF ⇒ the legacy emit (byte-identical);
 *      flag ON ⇒ SUPPRESSED (the same-txn enqueue in phase 1 is the delivery path — emitting too would
 *      double-deliver).
 * The caller builds the payload ONCE (via `withAutomationEventId`, which stamps a stable `_eventId`) so both
 * phases carry the same event identity (the dedup + outbound-idempotency seed).
 */
import { produceAutomationEvent } from './automation-durable-activation'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'
import type { TransactionalQueryable } from './pg-transaction-guard'

/** A record-event payload as built by `withAutomationEventId` — carries `_eventId` (+ optional depth). */
export interface RecordEventLike {
  _eventId?: unknown
  _automationDepth?: unknown
  [k: string]: unknown
}

interface EventBusLike {
  emit(eventType: string, payload: unknown): void
}

/**
 * Flag ON: enqueue `eventType`/`payload` on the SAME transaction as the source write (REPLACE — the legacy
 * emit is then suppressed). Flag OFF: no-op (the caller emits legacy post-commit). Returns true iff enqueued.
 * `trx` MUST be the source-write transaction handle — `produceAutomationEvent`'s xid probe rejects a pool /
 * autocommit client, so a half-committed enqueue is unrepresentable.
 */
export async function enqueueRecordEventIfDurable(
  trx: TransactionalQueryable,
  eventType: string,
  payload: RecordEventLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!isDurableDeliveryEnabled(env)) return false
  const eventId = typeof payload._eventId === 'string' ? payload._eventId : ''
  const automationDepth = typeof payload._automationDepth === 'number' ? payload._automationDepth : 0
  const res = await produceAutomationEvent(trx, { eventType, eventId, payload, automationDepth }, env)
  return res !== null
}

/**
 * Flag OFF: emit the legacy post-commit event (byte-identical to before P1#2). Flag ON: SUPPRESSED — the
 * same-transaction enqueue is the delivery path; emitting here too would double-deliver (the durable
 * consumers call the SAME handlers, and the webhook sink is not cross-path idempotent). Returns true iff
 * it emitted. This suppression is the load-bearing REPLACE guard.
 */
export function emitRecordEventIfLegacy(
  bus: EventBusLike,
  eventType: string,
  payload: RecordEventLike,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isDurableDeliveryEnabled(env)) return false
  bus.emit(eventType, payload)
  return true
}

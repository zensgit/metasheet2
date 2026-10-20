import { enqueueOutboxEvent } from '../multitable/automation-outbox-enqueue'
import { assertInTransaction, type TransactionalQueryable } from '../multitable/pg-transaction-guard'
import { ROUTING_MANIFEST_V4, type RoutingManifest } from '../multitable/automation-routing-manifest'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

export const YIDA_AUTOMATION_EVENT = 'integration.yida.authorized.requested'
export const YIDA_AUTOMATION_CONSUMER = 'integration-yida-authorized-send'

// Staged, host-private candidate. Do NOT change CURRENT_ROUTING_MANIFEST or
// register a live producer before the matching private consumer is installed.
// Existing v1-v4 fan-outs and global defaults remain unchanged.
export const YIDA_AUTOMATION_ROUTING_CANDIDATE: RoutingManifest = Object.freeze({
  version: 5,
  routes: Object.freeze({ ...ROUTING_MANIFEST_V4.routes,
    [YIDA_AUTOMATION_EVENT]: Object.freeze([YIDA_AUTOMATION_CONSUMER]) }),
})

type Reservation = Readonly<{ requestId: string; rowOrdinal: number; reused: boolean }>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
function denied(): never { throw new Error('YIDA_AUTOMATION_OUTBOX_DENIED') }

/** Actual shared enqueue, in the SAME transaction as row reservation. This is
 * not a worker permit, not a sender and not an HTTP handler. Old unlinked
 * reservations cannot be upgraded on replay into fresh delivery authority. */
export async function enqueueYidaAutomationRequestInTransaction(
  trx: Queryable, grantId: string, reservation: Reservation,
) {
  if (!UUID.test(grantId) || !UUID.test(reservation.requestId)
    || !Number.isSafeInteger(reservation.rowOrdinal) || reservation.rowOrdinal < 0 || reservation.rowOrdinal > 9
    || typeof reservation.reused !== 'boolean') denied()
  await assertInTransaction(trx, 'YiDa automatic request enqueue')
  // Serialize first enqueue and concurrent replay on the actual source row.
  const request = await trx.query(`SELECT row_ordinal FROM integration_yida_auto_requests
    WHERE grant_id=$1 AND id=$2 FOR UPDATE`, [grantId, reservation.requestId])
  if (request.rows.length !== 1 || request.rows[0].row_ordinal !== reservation.rowOrdinal) denied()
  const previous = await trx.query(`SELECT o.event_type,o.event_id,o.payload,o.automation_depth,o.manifest_version,l.consumer_key
    FROM integration_yida_auto_outbox_links l
    JOIN meta_automation_outbox o ON o.id=l.outbox_id
    JOIN meta_automation_outbox_consumer c ON c.outbox_id=l.outbox_id AND c.consumer_key=l.consumer_key
    WHERE l.grant_id=$1 AND l.request_id=$2`, [grantId, reservation.requestId])
  const eventId = 'yida-automation:' + reservation.requestId
  if (previous.rows.length) {
    const row = previous.rows[0]
    if (!reservation.reused || previous.rows.length !== 1 || row.event_type !== YIDA_AUTOMATION_EVENT
      || row.event_id !== eventId || row.automation_depth !== 0 || row.manifest_version !== 5
      || row.consumer_key !== YIDA_AUTOMATION_CONSUMER
      || JSON.stringify(row.payload) !== JSON.stringify({ requestId: reservation.requestId })) denied()
  } else {
    if (reservation.reused) denied()
    const outbox = await enqueueOutboxEvent(trx as TransactionalQueryable, {
      eventType: YIDA_AUTOMATION_EVENT, eventId, payload: { requestId: reservation.requestId }, automationDepth: 0,
    }, YIDA_AUTOMATION_ROUTING_CANDIDATE)
    await trx.query(`INSERT INTO integration_yida_auto_outbox_links(grant_id,request_id,outbox_id,consumer_key)
      VALUES ($1,$2,$3,$4)`, [grantId, reservation.requestId, outbox.outboxId, YIDA_AUTOMATION_CONSUMER])
  }
  return Object.freeze({ ...reservation, deliveryQueued: true, canSend: false, externalWriteAttempted: false })
}

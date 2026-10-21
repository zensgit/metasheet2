import { types } from 'node:util'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { createYidaAutomationAuthorizationStore } from './yida-automation-authorization-store'
import { YIDA_AUTOMATION_CONSUMER, YIDA_AUTOMATION_EVENT } from './yida-automation-outbox'

type Scope = Readonly<{ tenantId: string; workspaceId: null; ownerId: string }>
type Dependencies = { scope: Scope; activationId: string; workerId: string; monotonicNow?: () => number }
type Row = Record<string, unknown>
type Claim = Readonly<{ outboxId: string; consumerKey: string; fence: string; attempts: number;
  eventType: string; eventId: string; payload: Readonly<{ requestId: string }>; automationDepth: number; manifestVersion: number }>
type Proof = Readonly<Record<string, never>>
type Admission = Readonly<{ grantId: string; requestId: string; admissionId: string; ledgerId: string }>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
function denied(): never { throw new Error('YIDA_AUTOMATION_DISPATCH_CLAIM_DENIED') }
function data(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) denied()
  const proto = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if (proto !== Object.prototype && proto !== null || Reflect.ownKeys(descriptors).length !== keys.length) denied()
  return Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denied()
    return [key, descriptor.value]
  }))
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) denied()
  return value
}
function integer(value: unknown): number {
  const parsed = typeof value === 'string' && /^[0-9]{1,16}$/u.test(value) ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) denied()
  return parsed
}
export function captureInternalYidaAutomationClaim(value: unknown): Claim {
  const row = data(value, ['outboxId', 'consumerKey', 'fence', 'attempts', 'eventType', 'eventId',
    'payload', 'automationDepth', 'manifestVersion'])
  const payload = data(row.payload, ['requestId']), requestId = id(payload.requestId)
  if (!UUID.test(requestId) || typeof row.outboxId !== 'string' || !/^obx_[0-9a-f-]{36}$/u.test(row.outboxId)
    || row.consumerKey !== YIDA_AUTOMATION_CONSUMER || row.eventType !== YIDA_AUTOMATION_EVENT
    || row.eventId !== 'yida-automation:' + requestId || row.automationDepth !== 0 || row.manifestVersion !== 5
    || typeof row.fence !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(row.fence)
    || BigInt(row.fence) > 9223372036854775807n || typeof row.attempts !== 'number'
    || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || row.attempts > 10000) denied()
  return Object.freeze({ ...row, payload: Object.freeze({ requestId }) }) as Claim
}

/** Host-private delivery prerequisite, NOT send authority. Scope/worker identity
 * come from trusted host registration, never a body/claim payload. Caller locks
 * live actor/rule/material BEFORE this grant -> request -> consumer lock order.
 * The actual shared dispatcher claim is data until re-proven against PG here.
 * No token, sender, execution handle or global consumer is registered. */
export function createYidaAutomationDispatchClaimAuthority(dependencies: Dependencies) {
  const raw = data(dependencies.scope, ['tenantId', 'workspaceId', 'ownerId'])
  if (raw.workspaceId !== null) denied()
  const scope = Object.freeze({ tenantId: id(raw.tenantId), workspaceId: null, ownerId: id(raw.ownerId) })
  const workerId = id(dependencies.workerId), activationId = id(dependencies.activationId)
  if (workerId === scope.ownerId || !UUID.test(activationId)) denied()
  const store = createYidaAutomationAuthorizationStore({ scope, activationId, monotonicNow: dependencies.monotonicNow })
  let closed = false
  type Facts = Readonly<{ grantId: string; requestId: string; rowOrdinal: number; tenantId: string;
    workspaceId: null; ownerId: string; workerId: string; workerFence: string; outboxId: string;
    leaseExpiresAt: number; canSend: false; externalWriteAttempted: false }>
  let proofs = new WeakMap<object, { trx: Queryable; xid: string; claim: Claim; facts: Facts; admission?: Admission }>()
  function active() { if (closed) denied() }
  async function checked<T>(work: () => Promise<T>): Promise<T> {
    active(); const result = await work(); active(); return result
  }
  async function xid(trx: Queryable) {
    const result = await checked(() => trx.query('SELECT pg_current_xact_id()::text AS xid'))
    const value = result.rows[0]?.xid
    if (result.rows.length !== 1 || typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) denied()
    return value
  }
  async function validate(trx: Queryable, claim: Claim, expectedGrantId?: string, admission?: Admission): Promise<Facts> {
    await checked(() => assertInTransaction(trx, 'YiDa dispatch claim'))
    const hint = await checked(() => trx.query(`SELECT grant_id FROM integration_yida_auto_outbox_links
      WHERE outbox_id=$1 AND consumer_key=$2 AND request_id=$3`, [claim.outboxId, claim.consumerKey, claim.payload.requestId]))
    const grantId = hint.rows[0]?.grant_id
    if (hint.rows.length !== 1 || typeof grantId !== 'string' || !UUID.test(grantId)
      || expectedGrantId !== undefined && grantId !== expectedGrantId) denied()
    // Actual repository scope/activation/revocation/dual clocks, not a payload
    // attestation. This holds the grant before either request or consumer lock.
    await checked(() => store.assertCurrentInTransaction(trx, grantId))
    const selected = await checked(() => trx.query(`SELECT r.id AS request_id,r.row_ordinal,r.status AS request_status,
      c.status AS delivery_status,c.fence::text AS fence,c.attempts,
      floor(extract(epoch FROM c.lease_expires_at)*1000)::bigint::text AS lease_ms,
      o.event_type,o.event_id,o.payload,o.automation_depth,o.manifest_version
      FROM integration_yida_auto_outbox_links l
      JOIN integration_yida_auto_requests r ON r.id=l.request_id AND r.grant_id=l.grant_id
      JOIN meta_automation_outbox o ON o.id=l.outbox_id
      JOIN meta_automation_outbox_consumer c ON c.outbox_id=l.outbox_id AND c.consumer_key=l.consumer_key
      WHERE l.grant_id=$1 AND l.request_id=$2 AND l.outbox_id=$3 AND l.consumer_key=$4
      FOR UPDATE OF r,c`, [grantId, claim.payload.requestId, claim.outboxId, claim.consumerKey]))
    if (selected.rows.length !== 1) denied()
    const row = selected.rows[0]
    if (row.request_status !== (admission ? 'admitted' : 'queued') || row.delivery_status !== 'in_progress') denied()
    if (row.fence !== claim.fence) denied()
    if (row.attempts !== claim.attempts || row.event_type !== claim.eventType || row.event_id !== claim.eventId
      || row.automation_depth !== claim.automationDepth || row.manifest_version !== claim.manifestVersion
      || JSON.stringify(row.payload) !== JSON.stringify(claim.payload)) denied()
    if (admission) {
      const found = await checked(() => trx.query(`SELECT id FROM integration_yida_auto_admissions
        WHERE id=$1 AND grant_id=$2 AND request_id=$3 AND ledger_id=$4 AND worker_id=$5 AND worker_fence=$6::bigint`,
      [admission.admissionId, grantId, claim.payload.requestId, admission.ledgerId, workerId, claim.fence]))
      if (admission.grantId !== grantId || admission.requestId !== claim.payload.requestId || found.rows.length !== 1) denied()
    }
    const lease = integer(row.lease_ms)
    await checked(() => store.assertCurrentInTransaction(trx, grantId))
    // Evaluate DB time AFTER the locks; a lease checked before a wait is stale.
    const clock = await checked(() => trx.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS now_ms'))
    if (clock.rows.length !== 1 || lease <= integer(clock.rows[0].now_ms)) denied()
    return Object.freeze({ grantId, requestId: claim.payload.requestId, rowOrdinal: integer(row.row_ordinal),
      ...scope, workerId, workerFence: claim.fence, outboxId: claim.outboxId, leaseExpiresAt: lease,
      canSend: false, externalWriteAttempted: false })
  }
  async function lock(trx: Queryable, input: unknown, admission?: Admission): Promise<Proof> {
    try {
      active()
      const claim = captureInternalYidaAutomationClaim(input)
      const facts = await validate(trx, claim, admission?.grantId, admission), transactionId = await xid(trx)
      active()
      const proof: Proof = Object.freeze({})
      proofs.set(proof, { trx, xid: transactionId, claim, facts, admission })
      return proof
    } catch { return denied() }
  }
  async function takeInTransaction(trx: Queryable, proof: unknown): Promise<Facts> {
    const found = proofs.get(proof as object)
    if (!found || found.trx !== trx || closed) denied()
    proofs.delete(proof as object)
    try {
      if (await xid(trx) !== found.xid) denied()
      // Recheck after every asynchronous gap, not only when the proof was made.
      return await validate(trx, found.claim, found.facts.grantId, found.admission)
    } catch { return denied() }
  }
  return Object.freeze({ lockInTransaction: (trx: Queryable, input: unknown) => lock(trx, input),
    lockAdmittedInTransaction(trx: Queryable, input: unknown, anchor: unknown) {
      try {
        const row = data(anchor, ['grantId', 'requestId', 'admissionId', 'ledgerId'])
        for (const key of ['grantId', 'requestId', 'admissionId']) if (!UUID.test(id(row[key]))) denied()
        const admission = Object.freeze({ grantId: id(row.grantId), requestId: id(row.requestId),
          admissionId: id(row.admissionId), ledgerId: id(row.ledgerId) })
        return lock(trx, input, admission)
      } catch { return Promise.reject(new Error('YIDA_AUTOMATION_DISPATCH_CLAIM_DENIED')) }
    }, takeInTransaction,
    close() { closed = true; proofs = new WeakMap() } })
}

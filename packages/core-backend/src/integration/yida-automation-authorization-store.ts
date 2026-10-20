import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { types } from 'node:util'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { checkedYidaAutomationAuthorization, captureYidaAutomationOccurrence,
  type YidaAutomationAuthorizationInput } from './yida-automation-authorization-contracts'

// Host-private persistence ONLY. These results are not permits. A core live
// authority must still prove owner/ACL/material and prepare the actual YiDa row
// in the SAME transaction as admitInTransaction, then await a known COMMIT.
type Row = Record<string, unknown>
type Scope = Readonly<{ tenantId: string; workspaceId: null; ownerId: string }>
type Dependencies = { scope: Scope; activationId: string; monotonicNow?: () => number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const DIGEST = /^[0-9a-f]{64}$/u
type Code = 'INPUT' | 'NOT_FOUND' | 'EXPIRED' | 'REVOKED' | 'CONFLICT' | 'BUSY' | 'STALE' | 'UNAVAILABLE'
const ownErrors = new WeakMap<object, Code>()
export class YidaAutomationStoreError extends Error {
  constructor(code: Code) {
    super('YIDA_AUTOMATION_STORE_' + code)
    this.name = 'YidaAutomationStoreError'
    ownErrors.set(this, code)
  }
}
function fail(code: Code): never { throw new YidaAutomationStoreError(code) }
function object(input: unknown, keys: string[]): Row {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) fail('INPUT')
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) fail('INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(descriptors).length !== keys.length) fail('INPUT')
  return Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INPUT')
    return [key, descriptor.value]
  }))
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function uuid(value: unknown): string {
  const result = id(value)
  if (!UUID.test(result)) fail('INPUT')
  return result
}
function integer(value: unknown): number {
  const number = typeof value === 'string' && /^[0-9]{1,16}$/u.test(value) ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) fail('UNAVAILABLE')
  return number
}
function contract(row: Row): YidaAutomationAuthorizationInput {
  const captured = object(row.contract, ['confirmationId', 'ruleId', 'expectedRuleRevision', 'actionId', 'projectNo',
    'operationId', 'rowKeys', 'allowedTriggers', 'maxExecutions', 'maxTotalRows', 'ttlMs'])
  const { maxTotalRows, ...input } = captured
  const result = checkedYidaAutomationAuthorization(input)
  if (result.maxTotalRows !== maxTotalRows || result.maxExecutions !== row.max_executions
    || result.maxTotalRows !== row.row_count || result.ttlMs !== row.ttl_ms) fail('UNAVAILABLE')
  return result
}
async function boundary<T>(trx: Queryable, work: () => Promise<T>): Promise<T> {
  try {
    await assertInTransaction(trx, 'YiDa automatic authorization store')
    const isolation = await trx.query('SHOW transaction_isolation')
    if (isolation.rows[0]?.transaction_isolation !== 'read committed') fail('UNAVAILABLE')
    return await work()
  } catch (error) { fail(ownErrors.get(error as object) ?? 'UNAVAILABLE') }
}
export function createYidaAutomationAuthorizationStore(dependencies: Dependencies) {
  const supplied = object(dependencies.scope, ['tenantId', 'workspaceId', 'ownerId'])
  if (supplied.workspaceId !== null) fail('INPUT')
  const scope = Object.freeze({ tenantId: id(supplied.tenantId), workspaceId: null, ownerId: id(supplied.ownerId) })
  const activationId = uuid(dependencies.activationId)
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now())
  function monotonic() {
    const value = monotonicNow()
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('UNAVAILABLE')
    return integer(Math.floor(value))
  }
  const where = [scope.tenantId, scope.ownerId]
  async function dbNow(trx: Queryable) {
    const result = await trx.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS now_ms')
    if (result.rows.length !== 1) fail('UNAVAILABLE')
    return integer(result.rows[0].now_ms)
  }
  async function lock(trx: Queryable, grantId: string): Promise<Row> {
    const found = await trx.query(`SELECT * FROM integration_yida_auto_grants
      WHERE tenant_id=$1 AND owner_id=$2 AND workspace_id IS NULL AND id=$3 FOR UPDATE`, [...where, grantId])
    if (found.rows.length !== 1) fail('NOT_FOUND')
    contract(found.rows[0])
    return found.rows[0]
  }
  async function current(trx: Queryable, row: Row) {
    if (row.activation_id !== activationId) fail('STALE')
    const revoked = await trx.query('SELECT grant_id FROM integration_yida_auto_revocations WHERE grant_id=$1', [row.id])
    if (revoked.rows.length) fail('REVOKED')
    const now = await dbNow(trx), mono = monotonic()
    if (now < integer(row.last_db_ms) || mono < integer(row.last_monotonic_ms)) fail('STALE')
    if (now >= integer(row.expires_at_ms) || mono - integer(row.approved_monotonic_ms) >= integer(row.ttl_ms)) fail('EXPIRED')
    await trx.query('UPDATE integration_yida_auto_grants SET last_db_ms=$2,last_monotonic_ms=$3 WHERE id=$1', [row.id, now, mono])
    return now
  }
  function view(row: Row) {
    return Object.freeze({ grantId: String(row.id), usedExecutions: integer(row.used_executions),
      maxExecutions: integer(row.max_executions), expiresAt: integer(row.expires_at_ms),
      activeRequestId: row.active_request_id === null ? null : String(row.active_request_id) })
  }
  async function stored(trx: Queryable, row: Row) {
    const consent = contract(row)
    if (typeof row.material_revision !== 'string' || !DIGEST.test(row.material_revision)) fail('UNAVAILABLE')
    const revoked = (await trx.query('SELECT grant_id FROM integration_yida_auto_revocations WHERE grant_id=$1', [row.id])).rows.length > 0
    const now = await dbNow(trx), mono = monotonic()
    const status = revoked ? 'revoked' : row.activation_id !== activationId ? 'stale'
      : now < integer(row.last_db_ms) || mono < integer(row.last_monotonic_ms) ? 'clock_untrusted'
        : now >= integer(row.expires_at_ms) || mono - integer(row.approved_monotonic_ms) >= integer(row.ttl_ms)
          ? 'expired' : 'recorded'
    return Object.freeze({ consent, materialRevision: row.material_revision, activationId: uuid(row.activation_id),
      summary: Object.freeze({ ...view(row), status, revoked, canSend: false, externalWriteAttempted: false,
        liveEligibilityChecked: false }) })
  }
  async function readInTransaction(trx: Queryable, grantId: string) {
    uuid(grantId)
    return boundary(trx, async () => {
      // Immutable consent is read without locking before the core locks its
      // actor/rule/material. Mutating store methods re-lock and revalidate it.
      const result = await trx.query(`SELECT * FROM integration_yida_auto_grants
        WHERE tenant_id=$1 AND owner_id=$2 AND workspace_id IS NULL AND id=$3`, [...where, grantId])
      if (result.rows.length !== 1) fail('NOT_FOUND')
      return stored(trx, result.rows[0])
    })
  }
  async function inspectInTransaction(trx: Queryable, grantId: string) {
    uuid(grantId)
    return boundary(trx, async () => {
      // Observation does not require a live grant/activation or enabled sender.
      // The caller still proves live actor ACL. Hold the scoped grant lock so
      // admission/ACK retirement cannot tear the budget and request projection.
      const grant = await lock(trx, grantId), consent = contract(grant)
      const found = await trx.query(`SELECT r.id,r.row_ordinal,r.status AS request_status,
        a.id AS admission_id,a.ledger_id,l.status AS ledger_status
        FROM integration_yida_auto_requests r
        LEFT JOIN integration_yida_auto_admissions a ON a.request_id=r.id AND a.grant_id=r.grant_id
        LEFT JOIN integration_yida_delivery_ledger l ON l.id=a.ledger_id
          AND l.tenant_id=$2 AND l.owner_id=$3 AND l.workspace_id IS NULL
        WHERE r.grant_id=$1 ORDER BY r.row_ordinal LIMIT 11`, [grantId, ...where])
      if (found.rows.length > consent.maxTotalRows) fail('UNAVAILABLE')
      const requests = Object.freeze(found.rows.map((row, index) => {
        const rowOrdinal = integer(row.row_ordinal), status = row.request_status, ledgerStatus = row.ledger_status
        if (rowOrdinal !== index || typeof status !== 'string'
          || !['queued', 'admitted', 'closed_observed', 'closed_unknown', 'closed_not_sent'].includes(status)) fail('UNAVAILABLE')
        if (status === 'queued') {
          if (row.admission_id !== null || row.ledger_id !== null || ledgerStatus !== null) fail('UNAVAILABLE')
        } else {
          uuid(row.admission_id); id(row.ledger_id)
          if (typeof ledgerStatus !== 'string'
            || !['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent'].includes(ledgerStatus)
            || status === 'closed_observed' && ledgerStatus !== 'acknowledged'
            || status === 'closed_unknown' && ledgerStatus !== 'outcome_unknown'
            || status === 'closed_not_sent' && ledgerStatus !== 'not_sent') fail('UNAVAILABLE')
        }
        return Object.freeze({ requestId: uuid(row.id), rowOrdinal, status,
          admissionId: row.admission_id === null ? null : uuid(row.admission_id),
          // This describes a historical request, not the current observation.
          // In particular, unknown MUST NOT be labelled "never attempted".
          ledgerStatus: ledgerStatus as string | null, durable: true, canSend: false })
      }))
      if (requests.filter(request => request.admissionId !== null).length !== integer(grant.used_executions)) fail('UNAVAILABLE')
      const unresolved = requests.filter(request => ['admitted', 'closed_unknown'].includes(request.status))
      if (grant.active_request_id === null ? unresolved.length !== 0
        : unresolved.length !== 1 || unresolved[0].requestId !== grant.active_request_id) fail('UNAVAILABLE')
      return Object.freeze({ ...(await stored(trx, grant)).summary, requests,
        serialBlocked: grant.active_request_id !== null })
    })
  }
  async function findConfirmationInTransaction(trx: Queryable, confirmationId: string) {
    id(confirmationId)
    return boundary(trx, async () => {
      await trx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['yida-auto-confirmation', ...where, confirmationId])])
      const result = await trx.query(`SELECT * FROM integration_yida_auto_grants
        WHERE tenant_id=$1 AND owner_id=$2 AND confirmation_id=$3`, [...where, confirmationId])
      return result.rows.length === 0 ? null : stored(trx, result.rows[0])
    })
  }
  async function findReservationInTransaction(trx: Queryable, grantId: string, input: unknown) {
    uuid(grantId)
    const occurrence = captureYidaAutomationOccurrence(input)
    return boundary(trx, async () => {
      const existing = await readInTransaction(trx, grantId)
      if (occurrence.grantId !== grantId || occurrence.activationId !== existing.activationId
        || occurrence.ruleId !== existing.consent.ruleId || occurrence.ruleRevision !== existing.consent.expectedRuleRevision
        || occurrence.actionId !== existing.consent.actionId || !existing.consent.allowedTriggers.includes(occurrence.triggerType)) fail('CONFLICT')
      const result = await trx.query('SELECT id,row_ordinal FROM integration_yida_auto_requests WHERE grant_id=$1 AND occurrence_key=$2',
        [grantId, occurrence.occurrenceKey])
      return result.rows.length === 0 ? null : Object.freeze({ requestId: String(result.rows[0].id),
        rowOrdinal: integer(result.rows[0].row_ordinal), reused: true })
    })
  }
  async function createInTransaction(trx: Queryable, input: unknown, materialRevision: string) {
    const consent = checkedYidaAutomationAuthorization(input)
    if (typeof materialRevision !== 'string' || !DIGEST.test(materialRevision)) fail('INPUT')
    const started = monotonic()
    return boundary(trx, async () => {
      // Serializes even the first confirmation, when there is no row to lock.
      await trx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['yida-auto-confirmation', ...where, consent.confirmationId])])
      const previous = await trx.query(`SELECT * FROM integration_yida_auto_grants
        WHERE tenant_id=$1 AND owner_id=$2 AND confirmation_id=$3 FOR UPDATE`, [...where, consent.confirmationId])
      if (previous.rows.length) {
        const row = previous.rows[0]
        if (JSON.stringify(contract(row)) !== JSON.stringify(consent) || row.material_revision !== materialRevision) fail('CONFLICT')
        return Object.freeze({ ...view(row), reused: true }) // History, never a renewed authorization.
      }
      const now = await dbNow(trx), grantId = randomUUID()
      if (monotonic() - started >= consent.ttlMs) fail('EXPIRED')
      const inserted = await trx.query(`INSERT INTO integration_yida_auto_grants
        (id,tenant_id,workspace_id,owner_id,activation_id,confirmation_id,contract,material_revision,
         max_executions,row_count,ttl_ms,approved_at_ms,expires_at_ms,approved_monotonic_ms,last_db_ms,last_monotonic_ms)
        VALUES ($1,$2,NULL,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$11,$13) RETURNING *`,
      [grantId, ...where, activationId, consent.confirmationId, JSON.stringify(consent), materialRevision,
        consent.maxExecutions, consent.maxTotalRows, consent.ttlMs, now, now + consent.ttlMs, started])
      return Object.freeze({ ...view(inserted.rows[0]), reused: false })
    })
  }
  async function revokeInTransaction(trx: Queryable, grantId: string) {
    uuid(grantId)
    return boundary(trx, async () => {
      const row = await lock(trx, grantId)
      await trx.query('INSERT INTO integration_yida_auto_revocations(grant_id) VALUES ($1) ON CONFLICT DO NOTHING', [grantId])
      return view(row) // Revocation remains available for stale/expired grants.
    })
  }
  async function reserveInTransaction(trx: Queryable, grantId: string, input: unknown) {
    uuid(grantId)
    const occurrence = captureYidaAutomationOccurrence(input)
    return boundary(trx, async () => {
      const row = await lock(trx, grantId), consent = contract(row)
      if (occurrence.grantId !== grantId || occurrence.activationId !== row.activation_id
        || occurrence.ruleId !== consent.ruleId || occurrence.ruleRevision !== consent.expectedRuleRevision
        || occurrence.actionId !== consent.actionId || !consent.allowedTriggers.includes(occurrence.triggerType)) fail('CONFLICT')
      const previous = await trx.query('SELECT * FROM integration_yida_auto_requests WHERE grant_id=$1 AND occurrence_key=$2',
        [grantId, occurrence.occurrenceKey])
      if (previous.rows.length) return Object.freeze({ requestId: String(previous.rows[0].id),
        rowOrdinal: integer(previous.rows[0].row_ordinal), reused: true }) // Observation only.
      await current(trx, row)
      const used = await trx.query('SELECT count(*)::text AS n FROM integration_yida_auto_requests WHERE grant_id=$1', [grantId])
      const ordinal = integer(used.rows[0]?.n)
      if (ordinal >= consent.maxTotalRows) fail('CONFLICT')
      const requestId = randomUUID()
      await trx.query(`INSERT INTO integration_yida_auto_requests(id,grant_id,occurrence_key,row_ordinal,status)
        VALUES ($1,$2,$3,$4,'queued')`, [requestId, grantId, occurrence.occurrenceKey, ordinal])
      return Object.freeze({ requestId, rowOrdinal: ordinal, reused: false })
    })
  }
  async function admitInTransaction(trx: Queryable, grantId: string, input: unknown) {
    uuid(grantId)
    const args = object(input, ['requestId', 'ledgerId', 'workerId', 'workerFence'])
    const requestId = uuid(args.requestId), ledgerId = id(args.ledgerId), workerId = id(args.workerId)
    const fence = id(args.workerFence)
    if (!/^[1-9][0-9]{0,18}$/u.test(fence) || BigInt(fence) > 9223372036854775807n) fail('INPUT')
    return boundary(trx, async () => {
      const row = await lock(trx, grantId), consent = contract(row)
      const requests = await trx.query('SELECT * FROM integration_yida_auto_requests WHERE grant_id=$1 AND id=$2 FOR UPDATE', [grantId, requestId])
      const request = requests.rows[0]
      if (!request) fail('NOT_FOUND')
      const existing = await trx.query('SELECT id,ledger_id FROM integration_yida_auto_admissions WHERE request_id=$1', [requestId])
      if (existing.rows.length) return Object.freeze({ admissionId: String(existing.rows[0].id),
        ledgerId: String(existing.rows[0].ledger_id), reused: true }) // No second execution handle.
      const now = await current(trx, row)
      if (row.active_request_id !== null) fail('BUSY')
      if (request.status !== 'queued' || integer(row.used_executions) >= consent.maxExecutions) fail('CONFLICT')
      const ledger = await trx.query(`SELECT * FROM integration_yida_delivery_ledger
        WHERE id=$1 AND tenant_id=$2 AND owner_id=$3 AND workspace_id IS NULL FOR UPDATE`, [ledgerId, ...where])
      const delivery = ledger.rows[0]
      if (!delivery || delivery.status !== 'prepared' || delivery.intent !== 'create'
        || delivery.operation_id !== consent.operationId || delivery.row_key !== consent.rowKeys[integer(request.row_ordinal)]) fail('CONFLICT')
      const admissionId = randomUUID()
      await trx.query(`INSERT INTO integration_yida_auto_admissions
        (id,grant_id,request_id,ledger_id,worker_id,worker_fence,admitted_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [admissionId, grantId, requestId, ledgerId, workerId, fence, now])
      await trx.query("UPDATE integration_yida_auto_requests SET status='admitted' WHERE id=$1", [requestId])
      await trx.query('UPDATE integration_yida_auto_grants SET used_executions=used_executions+1,active_request_id=$2 WHERE id=$1', [grantId, requestId])
      // Lock waits and persistence cannot silently carry an admission past TTL.
      await current(trx, { ...row, active_request_id: requestId })
      return Object.freeze({ admissionId, ledgerId, reused: false })
    })
  }
  async function assertCurrentInTransaction(trx: Queryable, grantId: string): Promise<void> {
    uuid(grantId)
    await boundary(trx, async () => { await current(trx, await lock(trx, grantId)) })
  }
  return Object.freeze({ createInTransaction, revokeInTransaction, reserveInTransaction, admitInTransaction, assertCurrentInTransaction,
    readInTransaction, inspectInTransaction, findConfirmationInTransaction, findReservationInTransaction })
}

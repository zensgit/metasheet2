import { createHash, randomUUID } from 'node:crypto'
import { AutomationActorAuthorityError, assertAutomationIntegrationActor, type AutomationIntegrationActor } from './automation-live-authority'
import { enqueueOutboxEvent } from '../multitable/automation-outbox-enqueue'
import { assertInTransaction, type TransactionalQueryable } from '../multitable/pg-transaction-guard'
import { recordAutomationReadExecution } from './automation-read-execution-audit'
import { deriveAutomationReadOperationPolicy, type AutomationReadOperationPolicyInput } from './automation-read-operation-policy'
import {
  assertReadRecordLease, assertReadRecordSignal, readRecordEventType, readRecordTriggerType,
  captureReadRecordData, captureReadRecordDelivery, findAutomationReadRecordCandidates, lockReadRecordDelivery,
} from './automation-read-record-activation'
import {
  captureReadScheduleOccurrence, checkedReadScheduleDefinition, findAutomationReadScheduleCandidates, readSchedulePlanMatches,
} from './automation-read-schedule-activation'
import { checkedReadDateFieldConfirmation, createAutomationReadDateSchedule } from './automation-read-date-schedule'
import {
  AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT, AutomationReadLedgerError,
  canonicalReadId, checkedReadBudget, checkedReadPreview, checkedReadSelector, checkedReadSourceReference, checkedReadTriggers,
  checkedReadRecordCondition, readInput,
  type AutomationReadLedgerDependencies, type ReadGrantInput, type ReadPreview,
  type ReadRequestStatus, type ReadTrigger, type ReadSourceReference, type ReadBudget, type ReadSelector,
  type ReadGrantDetail, type ReadRequestSummary, type ReadPageInput, type ReadRequestPageInput, type ReadPage,
  type ReadRecordActivationInput, type ReadRecordActivationRef, type ReadRecordDelivery, type ReadRecordCondition,
  type ReadScheduleActivationInput, type ReadScheduleActivationRef, type ReadScheduleOccurrence,
  type ReadDateFieldConfirmation, type ReadDateScheduleOrigin,
  type ReadRetryInput, type ReadRetryRef, type ReadRetryContext,
} from './automation-read-contracts'

type Row = Record<string, unknown>
type RequestRef = { requestId: string; status: ReadRequestStatus }
/** Worker-private IO checkpoint. Never serialize this context into public DTOs. */
export type ReadCheckpoint = Readonly<{
  actor: Readonly<AutomationIntegrationActor>
  selector: Readonly<ReadSelector>
  projectNo: string
  budget: Readonly<ReadBudget>
  sourceReference: ReadSourceReference
  authorityKey: string
  authorityMode: 'execution' | 'record'
  remainingMs: number
}>
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const terminal = new Set(['succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown'])
function uuid(value: unknown): string {
  readInput(typeof value === 'string' && uuidPattern.test(value))
  return value.toLowerCase()
}
function denied(): never { throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED') }
/** Provider results are data, not serializers: read each own descriptor once. */
function capturedData(value: unknown, keys: string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length) denied()
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return denied()
    return [key, descriptor.value]
  }))
}
function capturedSourceReference(value: unknown): ReadSourceReference {
  try { return checkedReadSourceReference(value) } catch { return denied() }
}
function capturedTriggers(value: unknown): readonly ReadTrigger[] {
  try { return checkedReadTriggers(value) } catch { return denied() }
}
function sameSourceReference(left: ReadSourceReference, right: ReadSourceReference): boolean {
  return left.connectionId === right.connectionId && left.connectionIncarnation === right.connectionIncarnation
}
function capturedProviderActor(value: Row): AutomationIntegrationActor {
  const { actorId, tenantId, workspaceId } = value
  if (!canonicalReadId(actorId) || !canonicalReadId(tenantId) || workspaceId !== null) denied()
  return Object.freeze({ actorId, tenantId, workspaceId: null })
}
function capturedExecution(value: unknown) {
  const material = capturedData(value, ['actorId', 'tenantId', 'workspaceId', 'key', 'budget', 'sourceReference', 'allowedTriggers'])
  const actor = capturedProviderActor(material)
  const { key } = material
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) denied()
  const sourceReference = capturedSourceReference(material.sourceReference)
  const allowedTriggers = capturedTriggers(material.allowedTriggers)
  // checkedReadBudget receives our detached data-only object, never provider
  // getters. Keep provider validation failures in this values-free vocabulary.
  let budget: Readonly<ReadBudget>
  try { budget = Object.freeze(checkedReadBudget(capturedData(material.budget, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs']))) }
  catch { return denied() }
  return Object.freeze({ ...actor, key, budget, sourceReference, allowedTriggers })
}
function capturedObservation(value: unknown) {
  const material = capturedData(value, ['actorId', 'tenantId', 'workspaceId', 'sourceReference'])
  return Object.freeze({ ...capturedProviderActor(material), sourceReference: capturedSourceReference(material.sourceReference) })
}
function actorCopy(input: AutomationIntegrationActor): AutomationIntegrationActor {
  readInput(input && canonicalReadId(input.actorId) && canonicalReadId(input.tenantId) && input.workspaceId === null)
  return Object.freeze({ actorId: input.actorId, tenantId: input.tenantId, workspaceId: null })
}
function ref(row: Row): RequestRef {
  return { requestId: String(row.id), status: row.status as ReadRequestStatus }
}
function sameActor(actor: AutomationIntegrationActor, value: AutomationIntegrationActor): boolean {
  return value?.actorId === actor.actorId && value?.tenantId === actor.tenantId && value?.workspaceId === null
}
function time(value: unknown): number { return new Date(value as string).getTime() }
function grantPurpose(row: Row): 'standalone' | 'automatic' | 'retry' {
  if (row.purpose !== 'standalone' && row.purpose !== 'automatic' && row.purpose !== 'retry') denied()
  return row.purpose
}
function executionMode(row: Row): 'execution' | 'record' {
  return grantPurpose(row) === 'automatic' && capturedTriggers(row.triggers).length === 1
    && capturedTriggers(row.triggers)[0] === 'record' ? 'record' : 'execution'
}
function capturedCondition(value: unknown): ReadRecordCondition {
  try { return checkedReadRecordCondition(value) } catch { return denied() }
}
function sameCondition(left: ReadRecordCondition, right: ReadRecordCondition): boolean {
  return left.mode === right.mode && (left.mode === 'unconditional'
    || (right.mode === 'saved_conditions' && left.schemaRevision === right.schemaRevision
      && left.businessTimeZone === right.businessTimeZone))
}
function capturedDateField(value: unknown): ReadDateFieldConfirmation {
  try { return checkedReadDateFieldConfirmation(value) } catch { return denied() }
}
function sameDateField(left: ReadDateFieldConfirmation, right: ReadDateFieldConfirmation): boolean {
  return left.fieldId === right.fieldId && left.fieldType === right.fieldType && left.schemaRevision === right.schemaRevision
}
function dateInvocationId(activationId: string, recordId: string, occurrenceAt: string): string {
  return `date-schedule-read:${createHash('sha256').update(JSON.stringify([activationId, recordId, occurrenceAt])).digest('hex')}`
}
function immutableGrant(row: Row): string {
  return JSON.stringify([row.id, row.tenant_id, row.workspace_id, row.owner_id, row.selector,
    row.authority_key, capturedSourceReference(row.source_reference), row.projects, row.triggers,
    row.budget, time(row.expires_at), row.max_executions, grantPurpose(row)])
}
function pageInput(value: unknown, requests: boolean): Required<Pick<ReadPageInput, 'limit'>> & ReadRequestPageInput {
  readInput(!!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
  const allowed = requests ? ['limit', 'after', 'grantId'] : ['limit', 'after']
  const data: Row = {}
  for (const key of Reflect.ownKeys(value)) {
    readInput(typeof key === 'string' && allowed.includes(key))
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    readInput(descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value'))
    data[key] = descriptor.value
  }
  const limit = Object.hasOwn(data, 'limit') ? data.limit : 20
  readInput(Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= 50)
  for (const key of ['after', 'grantId']) if (Object.hasOwn(data, key)) {
    readInput(typeof data[key] === 'string' && uuidPattern.test(data[key]) && data[key] === data[key].toLowerCase())
  }
  return { limit: Number(limit), ...(data.after ? { after: String(data.after) } : {}),
    ...(data.grantId ? { grantId: String(data.grantId) } : {}) }
}
function timestamp(value: unknown): string {
  const millis = time(value)
  if (!Number.isFinite(millis)) denied()
  return new Date(millis).toISOString()
}
function grantDetail(row: Row): ReadGrantDetail {
  if (row.status !== 'active' && row.status !== 'revoked') denied()
  const purpose = grantPurpose(row), triggers = checkedReadTriggers(row.triggers)
  const maximum = Number(row.max_executions), used = Number(row.used_executions)
  if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(used) || used < 0 || used > maximum
    || !Array.isArray(row.projects) || row.projects.length < 1 || row.projects.length > 256
    || !row.projects.every(canonicalReadId) || new Set(row.projects).size !== row.projects.length) denied()
  if (purpose === 'automatic' && (row.projects.length !== 1 || triggers.length !== 1
    || (triggers[0] !== 'record' && triggers[0] !== 'schedule'))) denied()
  if (purpose === 'retry' && (row.projects.length !== 1 || triggers.length !== 1
    || !['manual', 'schedule'].includes(triggers[0]) || maximum !== 1)) denied()
  return { grantId: String(row.id), purpose, status: row.status, selector: checkedReadSelector(row.selector),
    projects: [...row.projects] as string[], triggers: [...triggers], budget: checkedReadBudget(row.budget),
    expiresAt: timestamp(row.expires_at), maxExecutions: maximum, usedExecutions: used,
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }
}
function requestSummary(row: Row): ReadRequestSummary {
  if (!['queued', 'running', ...terminal].includes(String(row.status)) || !canonicalReadId(row.project_no)
    || !['manual', 'schedule', 'record'].includes(String(row.trigger_type))) denied()
  return { requestId: String(row.id), grantId: String(row.grant_id), status: row.status as ReadRequestStatus,
    projectNo: row.project_no, trigger: row.trigger_type as ReadTrigger, createdAt: timestamp(row.created_at),
    startedAt: row.started_at === null ? null : timestamp(row.started_at),
    finishedAt: row.finished_at === null ? null : timestamp(row.finished_at) }
}
// Candidate filtering is NOT the authorization proof: every candidate (including
// limit+1) is rechecked under the real observation locks before any page escapes.
// Both actual Connection metadata and its mirror must still agree. No credential
// or mutable external-system pointer is selected/resolved here.
const readableSourceJoin = `JOIN integration_data_source_validation_revisions m
  ON m.data_source_id = g.source_reference->>'connectionId'
  AND m.connection_incarnation::text = g.source_reference->>'connectionIncarnation'
  JOIN data_sources d ON d.id = m.data_source_id
  AND ROW(d.connection_incarnation,d.validation_revision,d.tenant_id,d.owner_id,d.workspace_id,d.scope_kind,d.type,d.is_active,d.deleted_at)
    IS NOT DISTINCT FROM ROW(m.connection_incarnation,m.validation_revision,m.tenant_id,m.owner_id,m.workspace_id,m.scope_kind,m.type,m.is_active,m.deleted_at)`
const readableSourceWhere = `m.owner_id = $1 AND m.tenant_id = $2 AND m.workspace_id IS NULL
  AND m.scope_kind = 'private' AND m.is_active = true AND m.deleted_at IS NULL`

/**
 * HOST-PRIVATE persistence primitive. It is not an IntegrationRunPort,
 * public route, source reader, dispatcher consumer or grant issuer by itself.
 * Controlled host runtime/consumer and owner-management callers supply the
 * actual authority port; this storage primitive cannot authorize itself. A
 * synthetic execution authority in tests proves this ledger, not PLM authority.
 *
 * Each operation owns one caller-provided transaction; actual PG RC/xid probes
 * run before queries, and the real actor gate runs on the SAME handle. Lock
 * order after actor/authority is grant -> request. Authority implementers must
 * coordinate upstream lock order (or NOWAIT), not acquire ledger locks first.
 * Never retry the callback after an ambiguous COMMIT. invocation_id recovers
 * submit; a running claim has no automatic re-claim and becomes unknown.
 * No source IO occurs here and no locks are claimed to survive commit.
 */
export function createAutomationReadLedger(deps: AutomationReadLedgerDependencies) {
  readInput(deps && typeof deps.transaction === 'function'
    && typeof deps.authority?.lockExecution === 'function' && typeof deps.authority?.lockObservation === 'function')
  type ExecutionProof = Awaited<ReturnType<AutomationReadLedgerDependencies['authority']['lockExecution']>>
  // Only the exact row returned by this call's locked authorization can retrieve
  // its original proof. The condition authority separately binds that proof to
  // the same transaction. A sanitized provider clone is never an execution token.
  const recordProofs = new WeakMap<Row, ExecutionProof>()
  const dateSchedules = createAutomationReadDateSchedule()
  type DateContext = Awaited<ReturnType<typeof dateSchedules.lock>>
  const scheduleActivations = new WeakMap<Row, Row>()
  const dateContexts = new WeakMap<Row, DateContext>()
  const retryLinks = new WeakMap<Row, Row>()
  const retryDateOrigins = new WeakMap<Row, ReadDateScheduleOrigin>()
  async function lockExecution(trx: TransactionalQueryable, actor: AutomationIntegrationActor,
    selector: ReadSelector, mode: 'execution' | 'record') {
    if (mode === 'record' && (typeof deps.authority.lockRecordExecution !== 'function'
      || typeof deps.authority.recordConditionFor !== 'function'
      || typeof deps.authority.evaluateRecordConditions !== 'function')) denied()
    const proof = mode === 'record' ? await deps.authority.lockRecordExecution!(trx, actor, selector)
      : await deps.authority.lockExecution(trx, actor, selector)
    const authority = capturedExecution(proof)
    const condition = mode === 'record' ? capturedCondition(deps.authority.recordConditionFor!(proof)) : null
    return { proof, authority, condition }
  }

  async function transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>, live?: () => void): Promise<T> {
    try {
      live?.()
      const result = await deps.transaction(async supplied => {
        // Retry cancellation gates every actual SQL receipt. Retain one handle
        // throughout authority and writes; never detach an in-flight PG promise.
        const trx: TransactionalQueryable = live ? { isTransaction: true, async query(statement, params) {
          live()
          const result = await supplied.query(statement, params)
          live()
          return result
        } } : supplied
        try {
          const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
          if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') throw new Error('Isolation')
          await assertInTransaction(trx, 'Automation read ledger')
        } catch { live?.(); throw new AutomationReadLedgerError('AUTOMATION_READ_TRANSACTION_REQUIRED') }
        const result = await work(trx)
        live?.() // Last callback boundary before the caller hands off COMMIT.
        return result
      })
      live?.() // A lost/cancelled COMMIT receipt is recovered only by the same key.
      return result
    } catch (error) {
      live?.()
      if (error instanceof AutomationReadLedgerError || error instanceof AutomationActorAuthorityError) throw error
      // No raw SQL, private parameters, capability error details or causes may
      // leave this private storage boundary for later routes/loggers to expose.
      throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
    }
  }
  async function now(trx: TransactionalQueryable): Promise<number> {
    const result = await trx.query('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now_ms')
    const value = Number(result.rows[0]?.now_ms)
    if (!Number.isFinite(value)) denied()
    return value
  }
  async function grantRow(trx: TransactionalQueryable, id: string, lock = false, nonblocking = false): Promise<Row> {
    const result = await trx.query(`SELECT * FROM integration_automation_read_grants WHERE id = $1${lock ? ' FOR UPDATE' + (nonblocking ? ' NOWAIT' : '') : ''}`, [id])
    if (result.rows.length !== 1) denied()
    return result.rows[0]
  }
  async function requestRow(trx: TransactionalQueryable, id: string, lock = false, nonblocking = false): Promise<Row> {
    const result = await trx.query(`SELECT * FROM integration_automation_read_requests WHERE id = $1${lock ? ' FOR UPDATE' + (nonblocking ? ' NOWAIT' : '') : ''}`, [id])
    if (result.rows.length !== 1) denied()
    return result.rows[0]
  }
  async function authorize(trx: TransactionalQueryable, hint: Row, mode: 'execution' | 'observation', supplied?: AutomationIntegrationActor, nonblocking = false) {
    const actor = supplied ?? actorCopy({ actorId: String(hint.owner_id), tenantId: String(hint.tenant_id), workspaceId: null })
    if (hint.owner_id !== actor.actorId || hint.tenant_id !== actor.tenantId || hint.workspace_id !== null) denied()
    const sourceReference = capturedSourceReference(hint.source_reference)
    const immutableHint = immutableGrant(hint)
    await assertAutomationIntegrationActor(trx, actor)
    let record: Awaited<ReturnType<typeof lockExecution>> | undefined
    if (mode === 'execution') {
      const selector = Object.freeze(checkedReadSelector(hint.selector))
      const prepared = await lockExecution(trx, actor, selector, executionMode(hint))
      const { authority } = prepared
      if (executionMode(hint) === 'record') record = prepared
      if (!sameActor(actor, authority) || authority.key !== hint.authority_key
        || !sameSourceReference(authority.sourceReference, sourceReference)) {
        throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
      }
      const budget = checkedReadBudget(hint.budget)
      const approved = checkedReadBudget(authority.budget)
      if (Object.keys(budget).some(key => budget[key as keyof typeof budget] > approved[key as keyof typeof budget])) denied()
      if (capturedTriggers(hint.triggers).some(trigger => !authority.allowedTriggers.includes(trigger))) denied()
    } else {
      // No selector/current-system resolution: history belongs to the original
      // Connection incarnation even after the action's system is redirected.
      const authority = capturedObservation(await deps.authority.lockObservation(trx, actor, sourceReference))
      if (!sameActor(actor, authority) || !sameSourceReference(authority.sourceReference, sourceReference)) denied()
    }
    const locked = await grantRow(trx, String(hint.id), true, nonblocking)
    if (immutableGrant(locked) !== immutableHint) throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
    if (grantPurpose(locked) === 'automatic') {
      const triggers = capturedTriggers(locked.triggers)
      if (triggers.length !== 1) denied()
      if (triggers[0] === 'record') {
        await verifyRecordActivation(trx, locked, mode === 'execution', record?.condition ?? undefined)
        if (record) recordProofs.set(locked, record.proof)
      }
      else if (triggers[0] === 'schedule') await verifyScheduleActivation(trx, locked, mode === 'execution')
      else denied()
    }
    if (grantPurpose(locked) === 'retry') await verifyRetryGrant(trx, locked, mode === 'execution')
    return locked
  }
  function validGrant(row: Row, at: number): boolean {
    return row.status === 'active' && time(row.expires_at) > at
  }
  async function change(trx: TransactionalQueryable, row: Row, status: ReadRequestStatus, result: ReadPreview | null = null): Promise<RequestRef> {
    await trx.query(`UPDATE integration_automation_read_requests SET status = $2,
      result = $3::jsonb, finished_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
    [row.id, status, result === null ? null : JSON.stringify(result)])
    return { requestId: String(row.id), status }
  }
  async function lockRequest(trx: TransactionalQueryable, hint: Row, grant: Row, nonblocking = false): Promise<Row> {
    const locked = await requestRow(trx, String(hint.id), true, nonblocking)
    if (locked.grant_id !== grant.id || locked.tenant_id !== grant.tenant_id || locked.owner_id !== grant.owner_id
      || locked.workspace_id !== null || locked.project_no !== hint.project_no
      || locked.trigger_type !== hint.trigger_type || locked.invocation_id !== hint.invocation_id) denied()
    if (grantPurpose(grant) === 'automatic' && capturedTriggers(grant.triggers)[0] === 'schedule') {
      const activation = scheduleActivations.get(grant) ?? await verifyScheduleActivation(trx, grant, false)
      if (activation.trigger_type === 'schedule.date_field') {
        await verifyDateReceipt(trx, locked, grant, activation)
      }
    }
    if (grantPurpose(grant) === 'retry' && capturedTriggers(grant.triggers)[0] === 'schedule') {
      const link = retryLinks.get(grant) ?? await verifyRetryGrant(trx, grant)
      // A second request under the same grant cannot borrow the linked attempt.
      // Observation/abandon must not acquire current execution authority here.
      if (locked.id !== link.request_id) denied()
    }
    return locked
  }

  async function verifyDateReceipt(trx: TransactionalQueryable, request: Row, grant: Row, activation: Row): Promise<Row> {
    const receipts = (await trx.query(`SELECT * FROM integration_automation_read_date_occurrences
      WHERE request_id=$1 FOR SHARE NOWAIT`, [request.id])).rows
    const receipt = receipts[0]
    if (receipts.length !== 1 || !receipt || receipt.request_id !== request.id || receipt.activation_id !== activation.id
      || receipt.grant_id !== grant.id || receipt.owner_id !== grant.owner_id || receipt.tenant_id !== grant.tenant_id
      || request.grant_id !== grant.id || request.owner_id !== grant.owner_id || request.tenant_id !== grant.tenant_id
      || request.workspace_id !== null || request.project_no !== activation.project_no
      || request.trigger_type !== 'schedule' || !canonicalReadId(receipt.record_id)
      || typeof receipt.occurrence_at_utc !== 'string' || timestamp(receipt.occurrence_at) !== receipt.occurrence_at_utc
      || receipt.invocation_id !== request.invocation_id
      || request.invocation_id !== dateInvocationId(String(activation.id), receipt.record_id, receipt.occurrence_at_utc)) denied()
    return receipt
  }

  function dateScheduleOrigin(activation: Row): ReadDateScheduleOrigin {
    const definition = checkedReadScheduleDefinition(activation.trigger_type, activation.cron_config,
      activation.interval_anchor_ms, capturedDateField(activation.date_field_confirmation))
    if (definition.triggerType !== 'schedule.date_field' || typeof activation.rule_revision !== 'string'
      || !uuidPattern.test(activation.rule_revision)) denied()
    return Object.freeze({ definition, ruleRevision: activation.rule_revision })
  }

  async function verifyRetryGrant(trx: TransactionalQueryable, grant: Row, execution = false): Promise<Row> {
    const triggers = capturedTriggers(grant.triggers)
    if (!Array.isArray(grant.projects) || grant.projects.length !== 1 || triggers.length !== 1
      || !['manual', 'schedule'].includes(triggers[0]) || Number(grant.max_executions) !== 1) denied()
    const rows = (await trx.query(`SELECT l.* FROM integration_automation_read_retries l
      JOIN integration_automation_read_requests c ON c.id=l.request_id AND c.grant_id=l.grant_id
      JOIN integration_automation_read_requests p ON p.id=l.parent_request_id
      WHERE l.grant_id=$1 AND l.owner_id=$2 AND l.tenant_id=$3
        AND c.owner_id=l.owner_id AND c.tenant_id=l.tenant_id AND c.workspace_id IS NULL
        AND p.owner_id=l.owner_id AND p.tenant_id=l.tenant_id AND p.workspace_id IS NULL
        AND c.project_no=p.project_no AND c.project_no=$4 AND c.trigger_type=$5 AND p.trigger_type=$5
      FOR SHARE OF l NOWAIT`, [grant.id, grant.owner_id, grant.tenant_id,
      grant.projects[0], triggers[0]])).rows
    const link = rows[0]
    if (rows.length !== 1 || link?.acknowledge_new_read !== true) denied()
    if (triggers[0] === 'manual') {
      // Undefined is only the old pre-144000 manual table shape, not a date fallback.
      if (link.date_parent_request_id !== null && link.date_parent_request_id !== undefined) denied()
    } else {
      if (typeof link.date_parent_request_id !== 'string' || link.date_parent_request_id !== link.parent_request_id) denied()
      // Ancestor identities are immutable in SQL. Never take ancestor grant or
      // request UPDATE locks from a worker that already owns its child grant.
      const parent = await requestRow(trx, String(link.parent_request_id))
      const originGrant = await grantRow(trx, String(parent.grant_id))
      if (grantPurpose(originGrant) !== 'automatic' || originGrant.owner_id !== grant.owner_id
        || originGrant.tenant_id !== grant.tenant_id || originGrant.workspace_id !== null
        || JSON.stringify(checkedReadSelector(originGrant.selector)) !== JSON.stringify(checkedReadSelector(grant.selector))
        || originGrant.authority_key !== grant.authority_key
        || !sameSourceReference(capturedSourceReference(originGrant.source_reference), capturedSourceReference(grant.source_reference))
        || parent.id !== link.date_parent_request_id || parent.project_no !== grant.projects[0]
        || !['blocked', 'failed', 'cancelled', 'outcome_unknown'].includes(String(parent.status))) denied()
      const activation = await verifyScheduleActivation(trx, originGrant, false)
      if (activation.trigger_type !== 'schedule.date_field') denied()
      await verifyDateReceipt(trx, parent, originGrant, activation)
      const origin = dateScheduleOrigin(activation)
      if (execution) {
        const rule = await scheduleRule(trx, String(grant.owner_id), checkedReadSelector(grant.selector).ruleId)
        if (rule.revision !== origin.ruleRevision || JSON.stringify(rule.definition) !== JSON.stringify(origin.definition)) {
          throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
        }
      }
      retryDateOrigins.set(grant, origin)
    }
    retryLinks.set(grant, link)
    return link
  }

  async function retryRef(trx: TransactionalQueryable, actor: AutomationIntegrationActor, link: Row,
    input: { retryKey: string; budget: ReadBudget; expiresAt: string }): Promise<ReadRetryRef> {
    // Observation of the immutable CHILD preserves the originally captured
    // Connection lifetime, even after the old rule/profile/grant expires.
    const grant = await authorize(trx, await grantRow(trx, String(link.grant_id)), 'observation', actor, true)
    const verified = await verifyRetryGrant(trx, grant)
    const hint = await requestRow(trx, String(link.request_id))
    const row = await lockRequest(trx, hint, grant, true)
    if (grantPurpose(grant) !== 'retry' || verified.request_id !== link.request_id
      || verified.parent_request_id !== link.parent_request_id || verified.retry_key !== input.retryKey
      || JSON.stringify(checkedReadBudget(grant.budget)) !== JSON.stringify(input.budget)
      || timestamp(grant.expires_at) !== input.expiresAt) {
      throw new AutomationReadLedgerError('AUTOMATION_READ_IDEMPOTENCY_CONFLICT')
    }
    return { parentRequestId: String(link.parent_request_id), grantId: String(grant.id), ...ref(row) }
  }

  async function recordRule(trx: TransactionalQueryable, ownerId: string, ruleId: string) {
    const rules = (await trx.query(`SELECT id,sheet_id,created_by,enabled,trigger_type,trigger_config,conditions,
        action_type,action_config,actions,execution_mode,integration_authority_revision::text AS rule_revision
      FROM automation_rules WHERE id=$1 FOR SHARE NOWAIT`, [ruleId])).rows
    const row = rules[0]
    const triggerType = readRecordTriggerType(row?.trigger_type)
    if (rules.length !== 1 || row?.id !== ruleId || row.created_by !== ownerId || row.enabled !== true
      || triggerType === null
      || !canonicalReadId(row.sheet_id) || typeof row.rule_revision !== 'string'
      || !uuidPattern.test(row.rule_revision)) denied()
    if (row.trigger_config !== null) capturedData(row.trigger_config, [])
    const policy = deriveAutomationReadOperationPolicy({ actionType: row.action_type as string,
      actionConfig: row.action_config as AutomationReadOperationPolicyInput['actionConfig'],
      actions: row.actions as AutomationReadOperationPolicyInput['actions'],
      executionMode: row.execution_mode as string | null, triggerType })
    if (!policy.allowedTriggers.includes('record')) denied()
    return Object.freeze({ ruleId, sheetId: row.sheet_id, revision: row.rule_revision, triggerType,
      hasConditions: row.conditions !== null })
  }

  async function activationById(trx: TransactionalQueryable, id: string, lock = false): Promise<Row | null> {
    const rows = (await trx.query(`SELECT * FROM integration_automation_read_record_activations
      WHERE id=$1${lock ? ' FOR SHARE NOWAIT' : ''}`, [id])).rows
    if (rows.length > 1) denied()
    return rows[0] ?? null
  }

  async function verifyRecordActivation(trx: TransactionalQueryable, grant: Row, execution: boolean,
    currentCondition?: ReadRecordCondition): Promise<Row> {
    const rows = (await trx.query(`SELECT * FROM integration_automation_read_record_activations
      WHERE grant_id=$1 FOR SHARE NOWAIT`, [grant.id])).rows
    const activation = rows[0]
    const selector = checkedReadSelector(grant.selector)
    if (rows.length !== 1 || !activation || activation.grant_id !== grant.id
      || activation.tenant_id !== grant.tenant_id || activation.owner_id !== grant.owner_id
      || activation.rule_id !== selector.ruleId || !canonicalReadId(activation.sheet_id)
      || typeof activation.id !== 'string' || !uuidPattern.test(activation.id)
      || typeof activation.activation_key !== 'string' || !uuidPattern.test(activation.activation_key)
      || typeof activation.rule_revision !== 'string' || !uuidPattern.test(activation.rule_revision)
      || !Number.isFinite(time(activation.activated_at))
      || !Array.isArray(grant.projects) || grant.projects.length !== 1 || grant.projects[0] !== activation.project_no
      || !canonicalReadId(activation.project_no) || !Array.isArray(grant.triggers)
      || grant.triggers.length !== 1 || grant.triggers[0] !== 'record') denied()
    const savedCondition = capturedCondition(activation.condition_confirmation)
    if (execution) {
      const rule = await recordRule(trx, String(grant.owner_id), selector.ruleId)
      if (rule.revision !== activation.rule_revision || rule.sheetId !== activation.sheet_id
        || !currentCondition || !sameCondition(savedCondition, currentCondition)
        || rule.hasConditions !== (currentCondition.mode === 'saved_conditions')) {
        throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
      }
    }
    return activation
  }

  async function scheduleRule(trx: TransactionalQueryable, ownerId: string, ruleId: string) {
    const rows = (await trx.query(`SELECT r.id,r.sheet_id,r.created_by,r.enabled,r.trigger_type,r.trigger_config,r.conditions,
        r.action_type,r.action_config,r.actions,r.execution_mode,r.integration_authority_revision::text AS rule_revision,
        CASE WHEN r.trigger_type='schedule.interval' AND pg_catalog.isfinite(r.created_at)
          THEN floor(extract(epoch FROM r.created_at)*1000)::text ELSE NULL END AS interval_anchor_ms
      FROM automation_rules r WHERE r.id=$1 FOR SHARE NOWAIT`, [ruleId])).rows
    const row = rows[0]
    if (rows.length !== 1 || row?.id !== ruleId || row.created_by !== ownerId || row.enabled !== true
      || !['schedule.cron', 'schedule.interval', 'schedule.date_field'].includes(String(row.trigger_type)) || row.conditions !== null
      || typeof row.rule_revision !== 'string' || !uuidPattern.test(row.rule_revision)) denied()
    let dateContext: DateContext | undefined
    if (row.trigger_type === 'schedule.date_field') {
      if (!canonicalReadId(row.sheet_id)) denied()
      const sheets = (await trx.query(`SELECT id,base_id FROM meta_sheets
        WHERE id=$1 AND deleted_at IS NULL FOR SHARE NOWAIT`, [row.sheet_id])).rows
      if (sheets.length !== 1 || sheets[0]?.id !== row.sheet_id || !canonicalReadId(sheets[0]?.base_id)) denied()
      dateContext = await dateSchedules.lock(trx, { actorId: ownerId, ruleId, sheetId: row.sheet_id, baseId: sheets[0].base_id })
      if (dateContext.ruleRevision !== row.rule_revision) throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
    }
    let definition
    try { definition = checkedReadScheduleDefinition(row.trigger_type, row.trigger_config, row.interval_anchor_ms, dateContext?.dateField) } catch { return denied() }
    const policy = deriveAutomationReadOperationPolicy({ actionType: row.action_type as string,
      actionConfig: row.action_config as AutomationReadOperationPolicyInput['actionConfig'],
      actions: row.actions as AutomationReadOperationPolicyInput['actions'],
      executionMode: row.execution_mode as string | null, triggerType: definition.triggerType })
    if (!policy.allowedTriggers.includes('schedule')) denied()
    return Object.freeze({ ruleId, revision: row.rule_revision, definition, dateContext })
  }

  async function scheduleActivationById(trx: TransactionalQueryable, id: string, lock = false): Promise<Row | null> {
    const rows = (await trx.query(`SELECT * FROM integration_automation_read_schedule_activations
      WHERE id=$1${lock ? ' FOR SHARE NOWAIT' : ''}`, [id])).rows
    if (rows.length > 1) denied()
    return rows[0] ?? null
  }

  async function verifyScheduleActivation(trx: TransactionalQueryable, grant: Row, execution: boolean): Promise<Row> {
    const rows = (await trx.query(`SELECT * FROM integration_automation_read_schedule_activations
      WHERE grant_id=$1 FOR SHARE NOWAIT`, [grant.id])).rows
    const activation = rows[0], selector = checkedReadSelector(grant.selector)
    if (rows.length !== 1 || !activation || activation.grant_id !== grant.id
      || activation.tenant_id !== grant.tenant_id || activation.owner_id !== grant.owner_id
      || activation.rule_id !== selector.ruleId || typeof activation.id !== 'string' || !uuidPattern.test(activation.id)
      || typeof activation.activation_key !== 'string' || !uuidPattern.test(activation.activation_key)
      || typeof activation.rule_revision !== 'string' || !uuidPattern.test(activation.rule_revision)
      || !Number.isFinite(time(activation.activated_at)) || !canonicalReadId(activation.project_no)
      || !Array.isArray(grant.projects) || grant.projects.length !== 1 || grant.projects[0] !== activation.project_no
      || !Array.isArray(grant.triggers) || grant.triggers.length !== 1 || grant.triggers[0] !== 'schedule') denied()
    let definition
    const dateField = activation.trigger_type === 'schedule.date_field' ? capturedDateField(activation.date_field_confirmation) : undefined
    if (!dateField && activation.date_field_confirmation !== undefined && activation.date_field_confirmation !== null) denied()
    try { definition = checkedReadScheduleDefinition(activation.trigger_type, activation.cron_config, activation.interval_anchor_ms, dateField) } catch { return denied() }
    if (execution) {
      const rule = await scheduleRule(trx, String(grant.owner_id), selector.ruleId)
      if (rule.revision !== activation.rule_revision || JSON.stringify(rule.definition) !== JSON.stringify(definition)) {
        throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
      }
      if (rule.dateContext) dateContexts.set(grant, rule.dateContext)
    }
    scheduleActivations.set(grant, activation)
    return activation
  }

  async function approveGrant(trx: TransactionalQueryable, actor: AutomationIntegrationActor,
    selector: ReadSelector, budget: ReadBudget, triggers: readonly ReadTrigger[], expectedCondition?: ReadRecordCondition) {
    await assertAutomationIntegrationActor(trx, actor)
    const { authority, condition } = await lockExecution(trx, actor, selector, expectedCondition ? 'record' : 'execution')
    if (expectedCondition && (!condition || !sameCondition(condition, expectedCondition))) {
      throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
    }
    if (!sameActor(actor, authority)) denied()
    if (triggers.some(trigger => !authority.allowedTriggers.includes(trigger))) denied()
    const approved = checkedReadBudget(authority.budget)
    if (Object.keys(budget).some(key => budget[key as keyof typeof budget] > approved[key as keyof typeof budget])) denied()
    return authority
  }

  async function insertGrant(trx: TransactionalQueryable, actor: AutomationIntegrationActor, input: ReadGrantInput,
    authority: ReturnType<typeof capturedExecution>, purpose: 'standalone' | 'automatic' | 'retry'): Promise<string> {
    if (time(input.expiresAt) <= await now(trx)) denied()
    const id = randomUUID()
    await trx.query(`INSERT INTO integration_automation_read_grants
      (id,tenant_id,workspace_id,owner_id,selector,authority_key,projects,triggers,budget,expires_at,max_executions,source_reference,purpose)
      VALUES ($1,$2,NULL,$3,$4::jsonb,$5,$6::text[],$7::text[],$8::jsonb,$9,$10,$11::jsonb,$12)`,
    [id, actor.tenantId, actor.actorId, JSON.stringify(input.selector), authority.key, input.projects, input.triggers,
      JSON.stringify(input.budget), input.expiresAt, input.maxExecutions, JSON.stringify(authority.sourceReference), purpose])
    return id
  }

  /** Shared admission body: callers already authorized the exact grant on this handle. */
  async function admitRequest(trx: TransactionalQueryable, actor: AutomationIntegrationActor, grant: Row,
    input: { invocationId: string; projectNo: string; trigger: ReadTrigger }, live: () => void = () => {},
    freshAdmission?: () => Promise<boolean>) {
    const { invocationId, projectNo, trigger } = input, grantId = String(grant.id)
    live()
    if (!validGrant(grant, await now(trx))) denied()
    if (!(grant.projects as string[]).includes(projectNo) || !(grant.triggers as string[]).includes(trigger)) denied()
    const duplicate = (await trx.query(`SELECT * FROM integration_automation_read_requests
      WHERE grant_id = $1 AND invocation_id = $2 FOR UPDATE${grantPurpose(grant) === 'automatic' ? ' NOWAIT' : ''}`,
    [grantId, invocationId])).rows[0]
    live()
    if (duplicate) {
      if (duplicate.project_no !== projectNo || duplicate.trigger_type !== trigger
        || duplicate.owner_id !== actor.actorId || duplicate.tenant_id !== actor.tenantId || duplicate.workspace_id !== null) {
        throw new AutomationReadLedgerError('AUTOMATION_READ_IDEMPOTENCY_CONFLICT')
      }
      return ref(duplicate)
    }
    // An admitted invocation has already consumed its immutable event decision.
    // Replays still pass current authorization/cutover/lease checks above, but
    // must not depend on a retained snapshot or create a second budget request.
    if (freshAdmission && !await freshAdmission()) { live(); return null }
    live()
    const queued = Number((await trx.query(`SELECT count(*)::int AS count FROM integration_automation_read_requests
      WHERE grant_id = $1 AND status = 'queued'`, [grantId])).rows[0]?.count)
    live()
    if (!Number.isInteger(queued) || Number(grant.used_executions) + queued >= Number(grant.max_executions)) {
      throw new AutomationReadLedgerError('AUTOMATION_READ_BUDGET_EXHAUSTED')
    }
    const keys = deps.manifest?.routes[AUTOMATION_READ_EVENT]
    if (!Number.isInteger(deps.manifest?.version) || deps.manifest.version <= 0
      || !keys || keys.length !== 1 || keys[0] !== AUTOMATION_READ_CONSUMER) {
      throw new AutomationReadLedgerError('AUTOMATION_READ_ROUTING_UNAVAILABLE')
    }
    const requestId = randomUUID()
    await trx.query(`INSERT INTO integration_automation_read_requests
      (id,grant_id,tenant_id,workspace_id,owner_id,invocation_id,project_no,trigger_type)
      VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)`, [requestId, grantId, actor.tenantId, actor.actorId, invocationId, projectNo, trigger])
    live()
    await recordAutomationReadExecution(trx, { requestId, ruleId: checkedReadSelector(grant.selector).ruleId,
      actorId: actor.actorId, tenantId: actor.tenantId })
    live()
    const outbox = await enqueueOutboxEvent(trx, {
      eventType: AUTOMATION_READ_EVENT, eventId: `integration-read:${requestId}`, payload: { requestId },
    }, deps.manifest)
    live()
    await trx.query('UPDATE integration_automation_read_requests SET outbox_id = $2 WHERE id = $1', [requestId, outbox.outboxId])
    live()
    return { requestId, status: 'queued' as const }
  }

  return {
    async retryContext(supplied: AutomationIntegrationActor, id: string): Promise<ReadRetryContext> {
      const actor = actorCopy(supplied), parentId = uuid(id)
      return transaction(async trx => {
        const hint = await requestRow(trx, parentId)
        const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'observation', actor, true)
        const row = await lockRequest(trx, hint, grant, true)
        // No expiry reconciliation, source IO, child state or eligibility claim.
        const links = (await trx.query(`SELECT l.request_id,l.grant_id FROM integration_automation_read_retries l
          JOIN integration_automation_read_requests c ON c.id=l.request_id AND c.grant_id=l.grant_id
          WHERE l.parent_request_id=$1 AND l.owner_id=$2 AND l.tenant_id=$3
            AND c.owner_id=l.owner_id AND c.tenant_id=l.tenant_id AND c.workspace_id IS NULL`,
        [parentId, actor.actorId, actor.tenantId])).rows
        if (links.length > 1) denied()
        let dateOrigin = retryDateOrigins.get(grant)
        if (grantPurpose(grant) === 'automatic' && row.trigger_type === 'schedule') {
          const activation = scheduleActivations.get(grant)
          if (activation?.trigger_type === 'schedule.date_field') dateOrigin = dateScheduleOrigin(activation)
        }
        return { request: requestSummary(row), grant: grantDetail(grant), nextAttempt: links.length
          ? { requestId: uuid(links[0].request_id), grantId: uuid(links[0].grant_id) } : null,
        ...(dateOrigin ? { dateScheduleOrigin: dateOrigin } : {}) }
      })
    },

    async retry(supplied: AutomationIntegrationActor, id: string, input: ReadRetryInput,
      signal: AbortSignal): Promise<ReadRetryRef> {
      const live = () => assertReadRecordSignal(signal)
      live()
      const actor = actorCopy(supplied), parentId = uuid(id)
      const data = captureReadRecordData(input, ['retryKey', 'budget', 'expiresAt', 'acknowledgeNewRead'])
      const retryKey = uuid(data.retryKey)
      readInput(data.retryKey === retryKey && data.acknowledgeNewRead === true)
      const budget = Object.freeze(checkedReadBudget(captureReadRecordData(data.budget,
        ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs'])))
      readInput(typeof data.expiresAt === 'string' && Number.isFinite(time(data.expiresAt))
        && new Date(data.expiresAt).toISOString() === data.expiresAt)
      const expiresAt = data.expiresAt
      return transaction(async trx => {
        await assertAutomationIntegrationActor(trx, actor)
        const mutex = await trx.query('SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1,0)) AS locked',
          [JSON.stringify(['automation-read-retry', actor.tenantId, actor.actorId, retryKey])])
        if (mutex.rows[0]?.locked !== true) throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
        const existing = (await trx.query(`SELECT * FROM integration_automation_read_retries
          WHERE tenant_id=$1 AND owner_id=$2 AND retry_key=$3`, [actor.tenantId, actor.actorId, retryKey])).rows[0]
        if (existing) {
          if (existing.parent_request_id !== parentId) throw new AutomationReadLedgerError('AUTOMATION_READ_IDEMPOTENCY_CONFLICT')
          return retryRef(trx, actor, existing, { retryKey, budget, expiresAt })
        }
        const hint = await requestRow(trx, parentId)
        const grantHint = await grantRow(trx, String(hint.grant_id))
        const dateRetry = hint.trigger_type === 'schedule' && grantPurpose(grantHint) === 'automatic'
        if ((!dateRetry && (hint.trigger_type !== 'manual' || !['standalone', 'retry'].includes(grantPurpose(grantHint))))
          || grantHint.owner_id !== actor.actorId || grantHint.tenant_id !== actor.tenantId || grantHint.workspace_id !== null) denied()
        const trigger = dateRetry ? 'schedule' : 'manual'
        const selector = Object.freeze(checkedReadSelector(grantHint.selector))
        // BOTH metadata proofs precede the parent request lock. The fresh cap may
        // exceed the old requested budget, never the current authority ceiling.
        const approved = await approveGrant(trx, actor, selector, budget, [trigger])
        if (dateRetry) {
          // Current date metadata precedes the parent request lock. Only frozen
          // provenance comes from the old grant; new budget/expiry are independent.
          const activation = await verifyScheduleActivation(trx, grantHint, true)
          if (activation.trigger_type !== 'schedule.date_field') denied()
        }
        const parentGrant = await authorize(trx, grantHint, dateRetry ? 'observation' : 'execution', actor, true)
        if (approved.key !== parentGrant.authority_key
          || !sameSourceReference(approved.sourceReference, capturedSourceReference(parentGrant.source_reference))) {
          throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
        }
        const parent = await lockRequest(trx, hint, parentGrant, true)
        if (parent.grant_id !== parentGrant.id || parent.owner_id !== actor.actorId || parent.tenant_id !== actor.tenantId
          || parent.workspace_id !== null || parent.project_no !== hint.project_no || parent.invocation_id !== hint.invocation_id
          || parent.trigger_type !== trigger || !['blocked', 'failed', 'cancelled', 'outcome_unknown'].includes(String(parent.status))) denied()
        const child = (await trx.query('SELECT request_id FROM integration_automation_read_retries WHERE parent_request_id=$1', [parentId])).rows
        if (child.length) throw new AutomationReadLedgerError('AUTOMATION_READ_IDEMPOTENCY_CONFLICT')
        const projectNo = String(parent.project_no)
        if (!canonicalReadId(projectNo) || !(parentGrant.projects as string[]).includes(projectNo)) denied()
        const grantId = await insertGrant(trx, actor, { selector, budget, projects: [projectNo], triggers: [trigger],
          expiresAt, maxExecutions: 1 }, approved, 'retry')
        const childGrant = await grantRow(trx, grantId, true)
        const invocationId = `retry-read:${createHash('sha256').update(JSON.stringify([actor.tenantId, actor.actorId, retryKey])).digest('hex')}`
        const request = await admitRequest(trx, actor, childGrant, { invocationId, projectNo, trigger }, live)
        if (!request) denied()
        if (dateRetry) await trx.query(`INSERT INTO integration_automation_read_retries
          (request_id,grant_id,parent_request_id,tenant_id,owner_id,retry_key,acknowledge_new_read,date_parent_request_id)
          VALUES ($1,$2,$3,$4,$5,$6,true,$3)`, [request.requestId, grantId, parentId, actor.tenantId, actor.actorId, retryKey])
        else await trx.query(`INSERT INTO integration_automation_read_retries
          (request_id,grant_id,parent_request_id,tenant_id,owner_id,retry_key,acknowledge_new_read)
          VALUES ($1,$2,$3,$4,$5,$6,true)`, [request.requestId, grantId, parentId, actor.tenantId, actor.actorId, retryKey])
        return { parentRequestId: parentId, grantId, ...request }
      }, live)
    },

    async grantDetail(supplied: AutomationIntegrationActor, id: string): Promise<ReadGrantDetail> {
      const actor = actorCopy(supplied), grantId = uuid(id)
      return transaction(async trx => grantDetail(await authorize(trx, await grantRow(trx, grantId), 'observation', actor)))
    },

    async listGrants(supplied: AutomationIntegrationActor, input: ReadPageInput = {}): Promise<ReadPage<ReadGrantDetail>> {
      const actor = actorCopy(supplied), page = pageInput(input, false)
      return transaction(async trx => {
        await assertAutomationIntegrationActor(trx, actor)
        if (page.after) await authorize(trx, await grantRow(trx, page.after), 'observation', actor, true)
        const candidates = (await trx.query(`SELECT g.id FROM integration_automation_read_grants g
          ${readableSourceJoin}
          WHERE g.owner_id=$1 AND g.tenant_id=$2 AND g.workspace_id IS NULL AND ${readableSourceWhere}
          AND ($3::uuid IS NULL OR (g.created_at,g.id) < (SELECT created_at,id
            FROM integration_automation_read_grants WHERE id=$3 AND owner_id=$1 AND tenant_id=$2 AND workspace_id IS NULL))
          ORDER BY g.created_at DESC,g.id DESC LIMIT $4`, [actor.actorId, actor.tenantId, page.after ?? null, page.limit + 1])).rows
        const verified: ReadGrantDetail[] = []
        for (const candidate of candidates) {
          verified.push(grantDetail(await authorize(trx, await grantRow(trx, String(candidate.id)), 'observation', actor, true)))
        }
        const items = verified.slice(0, page.limit)
        return { items, nextCursor: verified.length > page.limit ? items[items.length - 1].grantId : null }
      })
    },

    async listRequests(supplied: AutomationIntegrationActor, input: ReadRequestPageInput = {}): Promise<ReadPage<ReadRequestSummary>> {
      const actor = actorCopy(supplied), page = pageInput(input, true)
      return transaction(async trx => {
        await assertAutomationIntegrationActor(trx, actor)
        if (page.grantId) await authorize(trx, await grantRow(trx, page.grantId), 'observation', actor, true)
        if (page.after) {
          const hint = await requestRow(trx, page.after)
          if (page.grantId && hint.grant_id !== page.grantId) denied()
          const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'observation', actor, true)
          await lockRequest(trx, hint, grant)
        }
        const candidates = (await trx.query(`SELECT r.id FROM integration_automation_read_requests r
          JOIN integration_automation_read_grants g ON g.id=r.grant_id
            AND g.owner_id=r.owner_id AND g.tenant_id=r.tenant_id AND g.workspace_id IS NULL
          ${readableSourceJoin}
          WHERE r.owner_id=$1 AND r.tenant_id=$2 AND r.workspace_id IS NULL AND ${readableSourceWhere}
          AND ($3::uuid IS NULL OR (r.created_at,r.id) < (SELECT created_at,id
            FROM integration_automation_read_requests WHERE id=$3 AND owner_id=$1 AND tenant_id=$2 AND workspace_id IS NULL))
          AND ($4::uuid IS NULL OR r.grant_id=$4)
          ORDER BY r.created_at DESC,r.id DESC LIMIT $5`,
        [actor.actorId, actor.tenantId, page.after ?? null, page.grantId ?? null, page.limit + 1])).rows
        const verified: ReadRequestSummary[] = []
        for (const candidate of candidates) {
          const hint = await requestRow(trx, String(candidate.id))
          const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'observation', actor, true)
          const row = await lockRequest(trx, hint, grant)
          // Lists intentionally do not reconcile expiry or project results.
          // The existing owner detail operation owns expiry -> unknown handling.
          verified.push(requestSummary(row))
        }
        const items = verified.slice(0, page.limit)
        return { items, nextCursor: verified.length > page.limit ? items[items.length - 1].requestId : null }
      })
    },

    async grant(supplied: AutomationIntegrationActor, input: ReadGrantInput): Promise<{ grantId: string }> {
      const actor = actorCopy(supplied)
      const selector = Object.freeze(checkedReadSelector(input?.selector))
      const budget = checkedReadBudget(input?.budget)
      const triggers = checkedReadTriggers(input?.triggers)
      readInput(Array.isArray(input.projects) && input.projects.length > 0 && input.projects.length <= 256
        && input.projects.every(canonicalReadId) && new Set(input.projects).size === input.projects.length)
      readInput(Number.isInteger(input.maxExecutions) && input.maxExecutions > 0 && input.maxExecutions <= 2147483647)
      readInput(typeof input.expiresAt === 'string' && Number.isFinite(time(input.expiresAt))
        && new Date(input.expiresAt).toISOString() === input.expiresAt)
      const projects = [...input.projects]
      const expiresAt = input.expiresAt, maximum = input.maxExecutions
      return transaction(async trx => {
        const authority = await approveGrant(trx, actor, selector, budget, triggers)
        const grantId = await insertGrant(trx, actor,
          { selector, budget, projects, triggers: [...triggers], expiresAt, maxExecutions: maximum }, authority, 'standalone')
        return { grantId }
      })
    },

    async activateRecord(supplied: AutomationIntegrationActor, input: ReadRecordActivationInput): Promise<ReadRecordActivationRef> {
      const actor = actorCopy(supplied)
      const data = captureReadRecordData(input, ['activationKey', 'expectedRuleRevision', 'expectedRecordCondition', 'selector', 'projectNo', 'budget', 'expiresAt', 'maxExecutions'])
      const activationKey = uuid(data.activationKey)
      const expectedRuleRevision = uuid(data.expectedRuleRevision)
      const expectedCondition = checkedReadRecordCondition(data.expectedRecordCondition)
      const selector = Object.freeze(checkedReadSelector(captureReadRecordData(data.selector, ['ruleId', 'actionId', 'systemId', 'targetId'])))
      const budget = Object.freeze(checkedReadBudget(captureReadRecordData(data.budget, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs'])))
      readInput(canonicalReadId(data.projectNo) && Number.isInteger(data.maxExecutions)
        && Number(data.maxExecutions) > 0 && Number(data.maxExecutions) <= 2147483647)
      readInput(typeof data.expiresAt === 'string' && Number.isFinite(time(data.expiresAt))
        && new Date(data.expiresAt).toISOString() === data.expiresAt)
      const projectNo = data.projectNo, expiresAt = data.expiresAt, maximum = Number(data.maxExecutions)
      return transaction(async trx => {
        await assertAutomationIntegrationActor(trx, actor)
        // A non-waiting owner/key mutex closes the absent-row race without
        // retries or a second transaction. It is not an authorization proof.
        const keyLock = await trx.query('SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1,0)) AS locked',
          [JSON.stringify(['automation-read-record', actor.tenantId, actor.actorId, activationKey])])
        if (keyLock.rows[0]?.locked !== true) throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
        const existing = (await trx.query(`SELECT * FROM integration_automation_read_record_activations
          WHERE tenant_id=$1 AND owner_id=$2 AND activation_key=$3`, [actor.tenantId, actor.actorId, activationKey])).rows[0]
        if (existing) {
          const grant = await authorize(trx, await grantRow(trx, String(existing.grant_id)), 'observation', actor, true)
          const locked = await activationById(trx, String(existing.id), true)
          if (!locked || grantPurpose(grant) !== 'automatic' || locked.grant_id !== grant.id
            || locked.activation_key !== activationKey || locked.rule_revision !== expectedRuleRevision
            || !sameCondition(capturedCondition(locked.condition_confirmation), expectedCondition)
            || locked.owner_id !== actor.actorId || locked.tenant_id !== actor.tenantId
            || JSON.stringify(checkedReadSelector(grant.selector)) !== JSON.stringify(selector)
            || JSON.stringify(checkedReadBudget(grant.budget)) !== JSON.stringify(budget)
            || locked.project_no !== projectNo || timestamp(grant.expires_at) !== expiresAt
            || Number(grant.max_executions) !== maximum) {
            throw new AutomationReadLedgerError('AUTOMATION_READ_IDEMPOTENCY_CONFLICT')
          }
          // No UPDATE, reactivation, quota expansion or replacement grant.
          return { activationId: String(locked.id), grantId: String(grant.id) }
        }
        const authority = await approveGrant(trx, actor, selector, budget, ['record'], expectedCondition)
        const rule = await recordRule(trx, actor.actorId, selector.ruleId)
        if (rule.revision !== expectedRuleRevision || rule.hasConditions !== (expectedCondition.mode === 'saved_conditions')) {
          throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
        }
        const grantId = await insertGrant(trx, actor, { selector, budget, projects: [projectNo],
          triggers: ['record'], expiresAt, maxExecutions: maximum }, authority, 'automatic')
        const activationId = randomUUID()
        await trx.query(`INSERT INTO integration_automation_read_record_activations
          (id,activation_key,grant_id,tenant_id,owner_id,rule_id,rule_revision,sheet_id,project_no,condition_confirmation,activated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,pg_catalog.clock_timestamp())`,
        [activationId, activationKey, grantId, actor.tenantId, actor.actorId, selector.ruleId, rule.revision, rule.sheetId, projectNo,
          JSON.stringify(expectedCondition)])
        return { activationId, grantId }
      })
    },

    async activateSchedule(supplied: AutomationIntegrationActor, input: ReadScheduleActivationInput,
      signal: AbortSignal): Promise<ReadScheduleActivationRef> {
      const live = () => assertReadRecordSignal(signal)
      live()
      const actor = actorCopy(supplied)
      const hasDateField = !!input && typeof input === 'object' && Object.hasOwn(input, 'expectedDateField')
      const data = captureReadRecordData(input, ['activationKey', 'expectedRuleRevision', 'selector', 'projectNo', 'budget', 'expiresAt', 'maxExecutions',
        ...(hasDateField ? ['expectedDateField'] : [])])
      const expectedDateField = hasDateField ? capturedDateField(data.expectedDateField) : undefined
      const activationKey = uuid(data.activationKey)
      const expectedRuleRevision = uuid(data.expectedRuleRevision)
      const selector = Object.freeze(checkedReadSelector(captureReadRecordData(data.selector, ['ruleId', 'actionId', 'systemId', 'targetId'])))
      const budget = Object.freeze(checkedReadBudget(captureReadRecordData(data.budget, ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs'])))
      readInput(canonicalReadId(data.projectNo) && Number.isInteger(data.maxExecutions)
        && Number(data.maxExecutions) > 0 && Number(data.maxExecutions) <= 2147483647)
      readInput(typeof data.expiresAt === 'string' && Number.isFinite(time(data.expiresAt))
        && new Date(data.expiresAt).toISOString() === data.expiresAt)
      const projectNo = data.projectNo, expiresAt = data.expiresAt, maximum = Number(data.maxExecutions)
      return transaction(async trx => {
        live()
        await assertAutomationIntegrationActor(trx, actor)
        const keyLock = await trx.query('SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1,0)) AS locked',
          [JSON.stringify(['automation-read-schedule', actor.tenantId, actor.actorId, activationKey])])
        live()
        if (keyLock.rows[0]?.locked !== true) throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
        const existing = (await trx.query(`SELECT * FROM integration_automation_read_schedule_activations
          WHERE tenant_id=$1 AND owner_id=$2 AND activation_key=$3`, [actor.tenantId, actor.actorId, activationKey])).rows[0]
        if (existing) {
          const grant = await authorize(trx, await grantRow(trx, String(existing.grant_id)), 'observation', actor, true)
          const locked = await scheduleActivationById(trx, String(existing.id), true)
          live()
          if (!locked || grantPurpose(grant) !== 'automatic' || locked.grant_id !== grant.id
            || locked.activation_key !== activationKey || locked.rule_revision !== expectedRuleRevision
            || locked.owner_id !== actor.actorId || locked.tenant_id !== actor.tenantId
            || JSON.stringify(checkedReadSelector(grant.selector)) !== JSON.stringify(selector)
            || JSON.stringify(checkedReadBudget(grant.budget)) !== JSON.stringify(budget)
            || locked.project_no !== projectNo || timestamp(grant.expires_at) !== expiresAt
            || Number(grant.max_executions) !== maximum
            || (locked.trigger_type === 'schedule.date_field'
              ? !expectedDateField || !sameDateField(capturedDateField(locked.date_field_confirmation), expectedDateField)
              : expectedDateField !== undefined)) {
            throw new AutomationReadLedgerError('AUTOMATION_READ_IDEMPOTENCY_CONFLICT')
          }
          return { activationId: String(locked.id), grantId: String(grant.id) }
        }
        const authority = await approveGrant(trx, actor, selector, budget, ['schedule'])
        const rule = await scheduleRule(trx, actor.actorId, selector.ruleId)
        if (rule.revision !== expectedRuleRevision) throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
        readInput((rule.definition.triggerType === 'schedule.date_field') === hasDateField)
        if (rule.definition.triggerType === 'schedule.date_field'
          && (!expectedDateField || !sameDateField(rule.definition.dateField, expectedDateField))) {
          throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
        }
        live()
        const grantId = await insertGrant(trx, actor, { selector, budget, projects: [projectNo],
          triggers: ['schedule'], expiresAt, maxExecutions: maximum }, authority, 'automatic')
        const activationId = randomUUID()
        live()
        await trx.query(`INSERT INTO integration_automation_read_schedule_activations
          (id,activation_key,grant_id,tenant_id,owner_id,rule_id,rule_revision,project_no,cron_config,trigger_type,interval_anchor_ms,date_field_confirmation,activated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::bigint,$12::jsonb,pg_catalog.clock_timestamp())`,
        [activationId, activationKey, grantId, actor.tenantId, actor.actorId, selector.ruleId, rule.revision,
          projectNo, JSON.stringify(rule.definition.triggerType === 'schedule.interval'
            ? { intervalMs: rule.definition.intervalMs } : rule.definition.config), rule.definition.triggerType,
          rule.definition.triggerType === 'schedule.interval' ? rule.definition.anchorMs : null,
          rule.definition.triggerType === 'schedule.date_field' ? JSON.stringify(rule.definition.dateField) : null])
        live()
        return { activationId, grantId }
      })
    },

    scheduleActivationCandidates(input: ReadScheduleOccurrence, signal: AbortSignal): Promise<readonly string[]> {
      return findAutomationReadScheduleCandidates(deps.transaction, input, signal)
    },

    async submitSchedule(id: string, input: ReadScheduleOccurrence, signal: AbortSignal): Promise<RequestRef | null> {
      const activationId = uuid(id), occurrence = captureReadScheduleOccurrence(input)
      readInput(occurrence.triggerType !== 'schedule.date_field')
      const live = () => assertReadRecordSignal(signal)
      live()
      return transaction(async trx => {
        live()
        const hint = await scheduleActivationById(trx, activationId)
        if (!hint || hint.rule_id !== occurrence.ruleId) return null
        const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'execution', undefined, true)
        const activation = await scheduleActivationById(trx, activationId, true)
        live()
        if (!activation || grantPurpose(grant) !== 'automatic' || activation.grant_id !== grant.id) denied()
        const at = await now(trx)
        if (!validGrant(grant, at) || occurrence.scheduledAtMs > at) return null
        const applicable = await trx.query(`SELECT pg_catalog.to_timestamp($2::double precision/1000)>activated_at AS applicable
          FROM integration_automation_read_schedule_activations WHERE id=$1`, [activationId, occurrence.scheduledAtMs])
        live()
        if (applicable.rows.length !== 1 || applicable.rows[0]?.applicable !== true
          || !readSchedulePlanMatches(checkedReadScheduleDefinition(
            activation.trigger_type, activation.cron_config, activation.interval_anchor_ms), occurrence)) return null
        const actor = actorCopy({ actorId: String(grant.owner_id), tenantId: String(grant.tenant_id), workspaceId: null })
        const invocationId = `schedule-read:${createHash('sha256').update(JSON.stringify([
          activationId, activation.trigger_type, new Date(occurrence.scheduledAtMs).toISOString(),
        ])).digest('hex')}`
        const result = await admitRequest(trx, actor, grant, { invocationId,
          projectNo: String(activation.project_no), trigger: 'schedule' }, live)
        if (!validGrant(grant, await now(trx))) denied()
        live()
        return result
      })
    },

    /** Host wake is not an occurrence. Each bounded page obtains fresh complete
     * grant authority before any date projection, then admits private due proofs
     * on that SAME handle. Already committed pages are never retried here. */
    async submitDateSchedulePage(id: string, input: ReadScheduleOccurrence,
      page: { afterId?: string; limit?: number }, signal: AbortSignal): Promise<{ nextCursor: string | null; scanned: number; budgetExhausted: boolean }> {
      const activationId = uuid(id), wake = captureReadScheduleOccurrence(input)
      readInput(wake.triggerType === 'schedule.date_field')
      const keys = page && typeof page === 'object' ? Reflect.ownKeys(page) : []
      const capturedPage = captureReadRecordData(page, keys as string[])
      readInput(keys.every(key => key === 'afterId' || key === 'limit'))
      const limit = Object.hasOwn(capturedPage, 'limit') ? capturedPage.limit : 100
      readInput(Number.isInteger(limit) && Number(limit) > 0 && Number(limit) <= 100)
      if (Object.hasOwn(capturedPage, 'afterId')) readInput(canonicalReadId(capturedPage.afterId))
      const live = () => assertReadRecordSignal(signal)
      live()
      return transaction(async trx => {
        live()
        const hint = await scheduleActivationById(trx, activationId)
        if (!hint || hint.rule_id !== wake.ruleId || hint.trigger_type !== 'schedule.date_field') denied()
        const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'execution', undefined, true)
        const activation = scheduleActivations.get(grant), context = dateContexts.get(grant)
        if (!activation || activation.id !== activationId || !context || grantPurpose(grant) !== 'automatic') denied()
        const currentNowMs = Math.floor(await now(trx))
        if (!validGrant(grant, currentNowMs)) denied()
        if (wake.scheduledAtMs > currentNowMs) throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
        const due = await dateSchedules.page(trx, context, { limit: Number(limit), scanAtMs: wake.scheduledAtMs,
          activatedAt: timestamp(activation.activated_at), signal,
          ...(capturedPage.afterId ? { afterId: String(capturedPage.afterId) } : {}) })
        const actor = actorCopy({ actorId: String(grant.owner_id), tenantId: String(grant.tenant_id), workspaceId: null })
        let budgetExhausted = false
        for (const proof of due.items) {
          live()
          const facts = await dateSchedules.facts(trx, context, proof)
          const occurrenceAt = timestamp(facts.occurrenceAt)
          const applicable = await trx.query(`SELECT pg_catalog.to_timestamp($2::double precision/1000)>activated_at
              AND pg_catalog.to_timestamp($2::double precision/1000)<=pg_catalog.clock_timestamp() AS applicable
            FROM integration_automation_read_schedule_activations WHERE id=$1`, [activationId, time(occurrenceAt)])
          if (applicable.rows.length !== 1 || applicable.rows[0]?.applicable !== true) continue
          const invocationId = dateInvocationId(activationId, facts.recordId, occurrenceAt)
          let request: RequestRef | null
          try {
            request = await admitRequest(trx, actor, grant, { invocationId,
              projectNo: String(activation.project_no), trigger: 'schedule' }, live)
          } catch (error) {
            // Only the pre-write, typed quota refusal stops enumeration. Preserve
            // earlier legal occurrences; SQL/storage/authority errors still abort
            // the whole page. Never disguise quota exhaustion as end-of-data.
            if (!(error instanceof AutomationReadLedgerError) || error.code !== 'AUTOMATION_READ_BUDGET_EXHAUSTED') throw error
            live()
            budgetExhausted = true
            break
          }
          if (!request) denied()
          await trx.query(`INSERT INTO integration_automation_read_date_occurrences
            (request_id,activation_id,grant_id,tenant_id,owner_id,record_id,occurrence_at,occurrence_at_utc,invocation_id)
            SELECT $1,$2,$3,$4,$5,$6,$7::text::timestamptz,$7::text,$8
            WHERE NOT EXISTS(SELECT 1 FROM integration_automation_read_date_occurrences WHERE request_id=$1)`,
          [request.requestId, activationId, grant.id, actor.tenantId, actor.actorId, facts.recordId, occurrenceAt, invocationId])
          // An idempotent request must retain the exact earlier receipt, not
          // acquire a new interpretation of its mutable record date.
          await lockRequest(trx, await requestRow(trx, request.requestId), grant, true)
        }
        if (!validGrant(grant, await now(trx))) denied()
        live()
        return { nextCursor: due.nextCursor, scanned: due.scanned, budgetExhausted }
      }, live)
    },

    recordActivationCandidates(delivery: ReadRecordDelivery, signal: AbortSignal): Promise<readonly string[]> {
      return findAutomationReadRecordCandidates(deps.transaction, delivery, signal)
    },

    async submitRecord(id: string, input: ReadRecordDelivery, signal: AbortSignal): Promise<RequestRef | null> {
      const activationId = uuid(id), delivery = captureReadRecordDelivery(input)
      const live = () => assertReadRecordSignal(signal)
      live()
      return transaction(async trx => {
        live()
        const hint = await activationById(trx, activationId)
        if (!hint) return null
        const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'execution', undefined, true)
        live()
        if (grantPurpose(grant) !== 'automatic') denied()
        const activation = await activationById(trx, activationId, true)
        if (!activation || activation.grant_id !== grant.id) denied()
        if (!validGrant(grant, await now(trx))) return null
        const event = await lockReadRecordDelivery(trx, delivery, signal)
        if (!event || event.sheetId !== activation.sheet_id) return null
        // authorize already holds the current rule lock and verifies its immutable
        // activation revision. Re-read that same locked row, never trust a caller
        // event family or candidate result to bind created versus updated.
        const rule = await recordRule(trx, String(grant.owner_id), String(activation.rule_id))
        if (rule.revision !== activation.rule_revision || rule.sheetId !== activation.sheet_id) {
          throw new AutomationReadLedgerError('AUTOMATION_READ_SCOPE_CHANGED')
        }
        if (readRecordEventType(rule.triggerType) !== event.eventType) return null
        // Compare the DB's original microsecond timestamps, not driver Date
        // truncation or a caller's createdAt/event payload timestamp.
        // Same-identity retained history visible to THIS statement also vetoes
        // the cutover. This is not a permanent first-event/retention tombstone.
        const applicable = await trx.query(`SELECT o.created_at>a.activated_at
          AND NOT EXISTS (SELECT 1 FROM meta_automation_outbox history
            WHERE history.event_type=o.event_type AND history.event_id=o.event_id
              AND history.created_at<=a.activated_at) AS applicable
          FROM meta_automation_outbox o JOIN integration_automation_read_record_activations a ON a.id=$2
          WHERE o.id=$1`, [delivery.outboxId, activationId])
        live()
        if (applicable.rows.length !== 1 || applicable.rows[0]?.applicable !== true) return null
        const actor = actorCopy({ actorId: String(grant.owner_id), tenantId: String(grant.tenant_id), workspaceId: null })
        const invocationId = `record-read:${createHash('sha256').update(JSON.stringify([
          activationId, event.eventType, delivery.eventId,
        ])).digest('hex')}`
        const result = await admitRequest(trx, actor, grant, { invocationId,
          projectNo: String(activation.project_no), trigger: 'record' }, live, async () => {
          const proof = recordProofs.get(grant)
          if (!proof || typeof deps.authority.evaluateRecordConditions !== 'function') denied()
          const result = await deps.authority.evaluateRecordConditions(trx, proof,
            { outboxId: event.outboxId, eventId: event.eventId, eventType: event.eventType })
          live()
          if (result.kind !== 'match' && result.kind !== 'no_match' && result.kind !== 'unreadable') denied()
          return result.kind === 'match'
        })
        await assertReadRecordLease(trx, event, signal)
        if (!validGrant(grant, await now(trx))) denied()
        live()
        return result
      })
    },

    async submit(supplied: AutomationIntegrationActor, input: { grantId: string; invocationId: string; projectNo: string; trigger: ReadTrigger }): Promise<RequestRef> {
      const actor = actorCopy(supplied), grantId = uuid(input?.grantId)
      readInput(canonicalReadId(input.invocationId) && canonicalReadId(input.projectNo)
        && ['manual', 'schedule', 'record'].includes(input.trigger))
      const { invocationId, projectNo, trigger } = input
      return transaction(async trx => {
        const grant = await authorize(trx, await grantRow(trx, grantId), 'execution', actor)
        if (grantPurpose(grant) !== 'standalone') denied()
        const result = await admitRequest(trx, actor, grant, { invocationId, projectNo, trigger })
        if (!result) denied()
        return result
      })
    },

    async claim(id: string) {
      const requestId = uuid(id)
      return transaction(async trx => {
        const hint = await requestRow(trx, requestId)
        const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'execution')
        const row = await lockRequest(trx, hint, grant)
        if (terminal.has(String(row.status))) return ref(row)
        const at = await now(trx)
        if (row.status === 'running') {
          return time(row.lease_expires_at) <= at ? change(trx, row, 'outcome_unknown') : ref(row)
        }
        if (!validGrant(grant, at)) return change(trx, row, 'blocked')
        if (!(grant.projects as string[]).includes(String(row.project_no))
          || !(grant.triggers as string[]).includes(String(row.trigger_type))) return change(trx, row, 'blocked')
        if (Number(grant.used_executions) >= Number(grant.max_executions)) return change(trx, row, 'blocked')
        const budget = checkedReadBudget(grant.budget)
        const fence = randomUUID()
        // No refund, automatic re-claim or reusable outbox lease. This sink fence
        // and quota reservation commit before the worker may perform source IO.
        await trx.query(`UPDATE integration_automation_read_grants SET used_executions = used_executions + 1,
          updated_at = clock_timestamp() WHERE id = $1`, [grant.id])
        await trx.query(`UPDATE integration_automation_read_requests SET status = 'running', fence = $2,
          started_at = clock_timestamp(), updated_at = clock_timestamp(), lease_expires_at = $3 WHERE id = $1`,
        [row.id, fence, new Date(Math.min(at + budget.timeoutMs, time(grant.expires_at))).toISOString()])
        return { requestId, status: 'running' as const, fence, selector: checkedReadSelector(grant.selector), projectNo: String(row.project_no), budget }
      })
    },

    /**
     * Worker-only: reauthorize before each source/target IO and publication.
     * This short transaction does not hold authority across subsequent IO or
     * cancel already in-flight work. The worker must enforce remainingMs and
     * AbortSignal itself, and checkpoint again before the next boundary.
     * Refusal never reclaims a fence, renews a lease or initiates a reread.
     */
    async checkpoint(input: { requestId: string; fence: string }): Promise<ReadCheckpoint> {
      const requestId = uuid(input?.requestId), fence = uuid(input?.fence)
      return transaction(async trx => {
        const hint = await requestRow(trx, requestId)
        const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'execution')
        const row = await lockRequest(trx, hint, grant)
        if (row.status !== 'running' || row.fence !== fence) throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST')
        if (!(grant.projects as string[]).includes(String(row.project_no))
          || !(grant.triggers as string[]).includes(String(row.trigger_type))) denied()
        const actor = actorCopy({ actorId: String(grant.owner_id), tenantId: String(grant.tenant_id), workspaceId: null })
        const selector = Object.freeze(checkedReadSelector(grant.selector))
        const budget = Object.freeze(checkedReadBudget(grant.budget))
        const sourceReference = capturedSourceReference(grant.source_reference)
        // Read the database clock only after authority, locks and context
        // capture: lock waits and slow authority work must consume this lease.
        const at = await now(trx)
        const remainingMs = Math.floor(Math.min(time(grant.expires_at), time(row.lease_expires_at)) - at)
        if (!validGrant(grant, at) || !Number.isSafeInteger(remainingMs) || remainingMs <= 0) denied()
        return Object.freeze({ actor, selector, projectNo: String(row.project_no), budget,
          sourceReference, authorityKey: String(grant.authority_key), authorityMode: executionMode(grant), remainingMs })
      })
    },

    async complete(input: { requestId: string; fence: string; result: ReadPreview; signal?: AbortSignal }): Promise<RequestRef> {
      const requestId = uuid(input?.requestId), fence = uuid(input?.fence)
      const result = checkedReadPreview(input.result)
      const signal = input.signal
      if (signal !== undefined && !(signal instanceof AbortSignal)) readInput(false)
      const live = () => { if (signal?.aborted) throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST') }
      live()
      return transaction(async trx => {
        const hint = await requestRow(trx, requestId)
        const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'execution')
        const row = await lockRequest(trx, hint, grant)
        if (row.status !== 'running' || row.fence !== fence) throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST')
        const at = await now(trx)
        if (!validGrant(grant, at) || time(row.lease_expires_at) <= at) return change(trx, row, 'outcome_unknown')
        live()
        const complete = await change(trx, row, 'succeeded', result)
        // A cooperative cancellation observed during UPDATE rolls back instead
        // of publishing late counts. An already-committed success stays final.
        live()
        return complete
      })
    },

    // Worker-only safe failure sink: no publication and no automatic retry. A
    // later consumer may distinguish proven failures; uncertainty never does.
    async abandon(input: { requestId: string; fence: string }): Promise<RequestRef> {
      const requestId = uuid(input?.requestId), fence = uuid(input?.fence)
      return transaction(async trx => {
        const hint = await requestRow(trx, requestId)
        const grant = await grantRow(trx, String(hint.grant_id), true)
        const row = await lockRequest(trx, hint, grant)
        if (row.fence !== fence) throw new AutomationReadLedgerError('AUTOMATION_READ_FENCE_LOST')
        return row.status === 'running' ? change(trx, row, 'outcome_unknown') : ref(row)
      })
    },

    async observe(supplied: AutomationIntegrationActor, id: string): Promise<RequestRef & { result: ReadPreview | null }> {
      const actor = actorCopy(supplied), requestId = uuid(id)
      return transaction(async trx => {
        const hint = await requestRow(trx, requestId)
        const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'observation', actor)
        const row = await lockRequest(trx, hint, grant)
        if (row.status === 'running' && time(row.lease_expires_at) <= await now(trx)) {
          return { ...await change(trx, row, 'outcome_unknown'), result: null }
        }
        return { ...ref(row), result: row.result === null ? null : checkedReadPreview(row.result) }
      })
    },

    async cancel(supplied: AutomationIntegrationActor, id: string): Promise<RequestRef> {
      const actor = actorCopy(supplied), requestId = uuid(id)
      return transaction(async trx => {
        const hint = await requestRow(trx, requestId)
        const grant = await authorize(trx, await grantRow(trx, String(hint.grant_id)), 'observation', actor)
        const row = await lockRequest(trx, hint, grant)
        return row.status === 'queued' ? change(trx, row, 'cancelled')
          : row.status === 'running' ? change(trx, row, 'outcome_unknown') : ref(row)
      })
    },

    async revoke(supplied: AutomationIntegrationActor, id: string): Promise<{ grantId: string; status: 'revoked' }> {
      const actor = actorCopy(supplied), grantId = uuid(id)
      return transaction(async trx => {
        await authorize(trx, await grantRow(trx, grantId), 'observation', actor)
        await trx.query(`UPDATE integration_automation_read_grants SET status = 'revoked', updated_at = clock_timestamp() WHERE id = $1`, [grantId])
        await trx.query(`UPDATE integration_automation_read_requests
          SET status = CASE WHEN status = 'queued' THEN 'blocked' ELSE 'outcome_unknown' END,
          result = NULL, finished_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE grant_id = $1 AND status IN ('queued', 'running')`, [grantId])
        return { grantId, status: 'revoked' }
      })
    },
  }
}

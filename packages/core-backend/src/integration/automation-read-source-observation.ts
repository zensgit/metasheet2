import type { AutomationIntegrationActor } from './automation-live-authority'
import {
  AutomationReadLedgerError,
  canonicalReadId,
  checkedReadSourceReference,
  type ReadSourceReference,
} from './automation-read-contracts'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'

export type LockedAutomationReadSourceObservation = Readonly<AutomationIntegrationActor & {
  sourceReference: Readonly<ReadSourceReference>
}>

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const identityColumns = ['connection_id', 'connection_incarnation', 'validation_revision',
  'tenant_id', 'owner_id', 'workspace_id', 'scope_kind', 'type', 'is_active', 'deleted_at'] as const

/** Only primitive own data properties are expected; do not invoke caller/driver hooks. */
function captureRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null
  const captured: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    captured[key] = descriptor.value
  }
  return Object.freeze(captured)
}

function denied(): never {
  throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
}

function unavailable(): never {
  throw new AutomationReadLedgerError('AUTOMATION_READ_UNAVAILABLE')
}

/**
 * HOST-PRIVATE history/observation prerequisite, NOT execution authorization.
 * The ledger must already have checked the trusted live actor, tenant membership
 * and integration administrator permission in this SAME transaction. This helper
 * proves only current ownership of the ORIGINAL captured private Connection
 * lifetime. It does not prove target read permissions, the active version/receipt,
 * execution budgets, or any permission to perform source IO. It never resolves a
 * current external-system pointer to replace the original persisted reference.
 *
 * Lock only the original mirror row, then plain-read the actual data_sources row
 * and compare ALL selected metadata. Source writers take DS -> mirror through
 * the trigger, so a mirror -> DS locking read would introduce a lock-order cycle.
 * The plain READ COMMITTED read either sees the committed version held by our
 * mirror lock, or rejects an absent/inconsistent actual entity. A writer that has
 * changed DS but is blocked on the mirror cannot commit until our lock releases.
 * Never treat a stale live mirror or a deletion tombstone alone as an authority.
 *
 * Ordinary config/credential rotations keep connection_incarnation and permit
 * history under the still-current owner; validation_revision is compared only
 * between the two CURRENT rows, never against the historical execution revision.
 * Delete/recreate or soft-delete/revive starts a new lifetime and rejects history
 * keyed to the old one. No transaction, source IO, writes, or host registration
 * are created here; the caller owns rollback/commit and locks end there.
 */
export async function lockAutomationReadSourceObservation(
  trx: Queryable,
  actor: AutomationIntegrationActor,
  sourceReference: ReadSourceReference,
): Promise<LockedAutomationReadSourceObservation> {
  let capturedActor: Readonly<AutomationIntegrationActor>
  let capturedReference: Readonly<ReadSourceReference>
  try {
    const scope = captureRecord(actor, ['actorId', 'tenantId', 'workspaceId'])
    if (!scope || !canonicalReadId(scope.actorId) || !canonicalReadId(scope.tenantId)
      || scope.workspaceId !== null) throw new Error('Invalid actor')
    capturedActor = Object.freeze({ actorId: scope.actorId, tenantId: scope.tenantId, workspaceId: null })
    capturedReference = checkedReadSourceReference(sourceReference)
  } catch {
    throw new AutomationReadLedgerError('AUTOMATION_READ_INPUT_INVALID')
  }

  try {
    if (!trx || typeof trx.query !== 'function') throw new Error('Missing transaction')
    const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
    if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') {
      throw new Error('Wrong isolation')
    }
    await assertInTransaction(trx, 'Automation source observation')
  } catch {
    throw new AutomationReadLedgerError('AUTOMATION_READ_TRANSACTION_REQUIRED')
  }

  try {
    const mirrorRows = (await trx.query(
      `SELECT data_source_id AS connection_id, connection_incarnation, validation_revision,
         tenant_id, owner_id, workspace_id, scope_kind, type, is_active, deleted_at
       FROM integration_data_source_validation_revisions
       WHERE data_source_id = $1 FOR SHARE NOWAIT`, [capturedReference.connectionId],
    )).rows
    if (mirrorRows.length !== 1) denied()
    const mirror = captureRecord(mirrorRows[0], identityColumns)
    if (!mirror || typeof mirror.validation_revision !== 'string' || mirror.validation_revision.length !== 36 || !uuidPattern.test(mirror.validation_revision)
      || typeof mirror.connection_incarnation !== 'string' || mirror.connection_incarnation.length !== 36 || !uuidPattern.test(mirror.connection_incarnation)
      || !canonicalReadId(mirror.type)) unavailable()
    if (mirror.connection_id !== capturedReference.connectionId
      || mirror.connection_incarnation !== capturedReference.connectionIncarnation
      || mirror.tenant_id !== capturedActor.tenantId || mirror.owner_id !== capturedActor.actorId
      || mirror.workspace_id !== null || mirror.scope_kind !== 'private'
      || mirror.is_active !== true || mirror.deleted_at !== null) denied()

    // Deliberately no FOR SHARE/UPDATE: writers must acquire DS before mirror.
    // Explicit metadata projection makes a missing incarnation migration fail
    // closed and cannot accidentally fetch config/credentials through to_jsonb.
    const sourceRows = (await trx.query(
      `SELECT id AS connection_id, connection_incarnation, validation_revision,
         tenant_id, owner_id, workspace_id, scope_kind, type, is_active, deleted_at
       FROM data_sources WHERE id = $1`, [capturedReference.connectionId],
    )).rows
    if (sourceRows.length !== 1) denied()
    const source = captureRecord(sourceRows[0], identityColumns)
    if (!source) unavailable()
    if (!identityColumns.every(key => source[key] === mirror[key])) denied()

    return Object.freeze({ ...capturedActor, sourceReference: capturedReference })
  } catch (error) {
    if (error instanceof AutomationReadLedgerError) throw error
    // NOWAIT conflicts, missing schema and raw driver error details never escape.
    return unavailable()
  }
}

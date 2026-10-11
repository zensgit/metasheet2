import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'

export type YidaInitializationCode = 'INPUT' | 'DENIED' | 'CONFLICT' | 'INACTIVE' | 'CANCELLED' | 'UNAVAILABLE'
const codes = new Set<unknown>(['INPUT', 'DENIED', 'CONFLICT', 'INACTIVE', 'CANCELLED', 'UNAVAILABLE'])
const ownErrors = new WeakMap<object, YidaInitializationCode>()
export class YidaInitializationError extends Error {
  readonly code: string
  constructor(code: unknown) {
    const fixed = (codes.has(code) ? code : 'UNAVAILABLE') as YidaInitializationCode
    super(`YIDA_INITIALIZATION_${fixed}`)
    this.name = 'YidaInitializationError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
// Neither decoder nor the public error boundary reads a foreign rejection.
export function yidaInitializationErrorCode(error: unknown): string | undefined {
  const code = ownErrors.get(error as object)
  return code === undefined ? undefined : `YIDA_INITIALIZATION_${code}`
}
export function closeYidaInitializationError(error: unknown): never {
  throw new YidaInitializationError(ownErrors.get(error as object) ?? 'UNAVAILABLE')
}
export type YidaInitializationDatabase = {
  transaction<T>(work: (trx: Queryable) => Promise<T>): Promise<T>
}
export type YidaInitializationAnchor = Readonly<{
  commandId: string; ownerId: string; tenantId: string; workspaceId: null
}>

// Fixed two-int transaction advisory key: ASCII YIDA (0x59494441), permanent slot 1.
// Provision/status/initialize all use this SAME barrier. It survives the callback
// until the actual host COMMIT/ROLLBACK, without granting UPDATE on the anchor.
export async function lockYidaInitializationSlot(trx: Queryable): Promise<void> {
  await trx.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [0x59494441, 1])
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new YidaInitializationError('INPUT')
  return value
}
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new YidaInitializationError('INPUT')
  }
  return value
}
function input(value: unknown) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new YidaInitializationError('INPUT')
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !['ownerId', 'tenantId', 'commandId'].includes(key))
    || !fields.ownerId || !fields.tenantId || Object.values(fields).some(field => !field.enumerable || !Object.hasOwn(field, 'value'))) {
    throw new YidaInitializationError('INPUT')
  }
  return { ownerId: id(fields.ownerId.value), tenantId: id(fields.tenantId.value),
    commandId: fields.commandId ? uuid(fields.commandId.value) : undefined }
}

/** Operator-only composition. NEVER inject/register this method in an HTTP or plugin API.
 * Server-owned deployment material supplies the identity; this creates no role,
 * membership, grant, target, token or external IO. Database table-owner/hostile
 * same-process authority is not constrained by this code-path separation.
 */
export async function provisionYidaInitializationAnchor(
  { database }: { database: YidaInitializationDatabase },
  supplied: Readonly<{ ownerId: string; tenantId: string; commandId?: string }>,
): Promise<YidaInitializationAnchor> {
  const fixed = input(supplied)
  try {
    return await database.transaction(async trx => {
      const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
      if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') throw new YidaInitializationError('UNAVAILABLE')
      await assertInTransaction(trx, 'Yida initialization bootstrap')
      await lockYidaInitializationSlot(trx)
      const existing = await trx.query('SELECT slot,command_id,owner_id,tenant_id,workspace_id FROM integration_yida_initialization_anchor WHERE slot=1')
      if (existing.rows.length > 1) throw new YidaInitializationError('UNAVAILABLE')
      const row = existing.rows[0]
      if (row) {
        if (row.slot !== 1 || row.workspace_id !== null) throw new YidaInitializationError('UNAVAILABLE')
        if (row.owner_id !== fixed.ownerId || row.tenant_id !== fixed.tenantId
          || (fixed.commandId !== undefined && row.command_id !== fixed.commandId)) throw new YidaInitializationError('CONFLICT')
        return Object.freeze({ commandId: uuid(row.command_id), ownerId: fixed.ownerId, tenantId: fixed.tenantId, workspaceId: null })
      }
      const commandId = fixed.commandId ?? randomUUID()
      const inserted = await trx.query(`INSERT INTO integration_yida_initialization_anchor
        (slot,command_id,owner_id,tenant_id,workspace_id) VALUES (1,$1,$2,$3,NULL)
        RETURNING slot,command_id,owner_id,tenant_id,workspace_id`, [commandId, fixed.ownerId, fixed.tenantId])
      const result = inserted.rows[0]
      if (inserted.rows.length !== 1 || inserted.rowCount !== 1 || result.slot !== 1 || result.command_id !== commandId
        || result.owner_id !== fixed.ownerId || result.tenant_id !== fixed.tenantId || result.workspace_id !== null) throw new YidaInitializationError('UNAVAILABLE')
      return Object.freeze({ commandId, ownerId: fixed.ownerId, tenantId: fixed.tenantId, workspaceId: null })
    })
  } catch (error) {
    // A failed COMMIT acknowledgement does not establish rollback or absence.
    // No independent retry and no new command/material allocation follows.
    closeYidaInitializationError(error)
  }
}

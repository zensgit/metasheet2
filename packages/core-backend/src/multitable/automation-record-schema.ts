import type { Queryable } from './automation-durable-dispatcher'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'
import { assertInTransaction } from './pg-transaction-guard'

declare const schemaTokenBrand: unique symbol
/** Host-private pre-DML evidence. Its contents are held only in this module's WeakMap. */
export type AutomationRecordSchemaToken = Readonly<{ [schemaTokenBrand]: true }>
export type AutomationRecordSchemaErrorCode = 'AUTOMATION_RECORD_SCHEMA_INPUT_INVALID'
  | 'AUTOMATION_RECORD_SCHEMA_TRANSACTION_REQUIRED' | 'AUTOMATION_RECORD_SCHEMA_UNAVAILABLE'
  | 'AUTOMATION_RECORD_SCHEMA_TOKEN_INVALID'
export class AutomationRecordSchemaError extends Error {
  constructor(readonly code: AutomationRecordSchemaErrorCode) {
    super(code)
    this.name = 'AutomationRecordSchemaError'
  }
}

type Capture = Readonly<{ trx: Queryable; sheetId: string; xid: string; revision: string | null }>
const captures = new WeakMap<object, Capture>()
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const relations = ['meta_sheets', 'meta_fields', 'plugin_multitable_object_registry',
  'automation_read_material_epochs']
const fail = (code: AutomationRecordSchemaErrorCode): never => { throw new AutomationRecordSchemaError(code) }
const unavailable = (): never => fail('AUTOMATION_RECORD_SCHEMA_UNAVAILABLE')

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim()
    && Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
}

function data(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length) return unavailable()
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return unavailable()
    return [key, descriptor.value]
  }))
}

async function currentXid(trx: Queryable): Promise<string> {
  const result = await trx.query('SELECT pg_current_xact_id()::text AS xid')
  if (result.rows.length !== 1) return unavailable()
  const xid = data(result.rows[0], ['xid']).xid
  return typeof xid === 'string' && /^[0-9]+$/u.test(xid) ? xid : unavailable()
}

function token(capture: Capture): AutomationRecordSchemaToken {
  const opaque = Object.freeze({}) as AutomationRecordSchemaToken
  captures.set(opaque, Object.freeze(capture))
  return opaque
}

async function readRevision(trx: Queryable, sheetId: string, lock: boolean): Promise<string | null> {
  const sheets = await trx.query('SELECT id, deleted_at FROM meta_sheets WHERE id = $1', [sheetId])
  if (sheets.rows.length === 0) return null
  if (sheets.rows.length !== 1) return unavailable()
  const sheet = data(sheets.rows[0], ['id', 'deleted_at'])
  if (sheet.id !== sheetId) return unavailable()
  if (sheet.deleted_at !== null) return null
  const epochs = await trx.query(`SELECT revision FROM automation_read_material_epochs
    WHERE kind = 'sheet' AND scope = $1::jsonb${lock ? ' FOR SHARE NOWAIT' : ''}`, [JSON.stringify({ id: sheetId })])
  if (epochs.rows.length === 0) return null
  if (epochs.rows.length !== 1) return unavailable()
  const revision = data(epochs.rows[0], ['revision']).revision
  return typeof revision === 'string' && uuid.test(revision) ? revision : unavailable()
}

/** Call after the existing writer/link fences but BEFORE source record DML. The caller must reuse
 * this exact transaction object through persistence. A successful capture keeps all source fences
 * until the outer commit; it does not authorize conditions, hydrate fields, or grant read access.
 * Only a NOWAIT conflict is optional: rollback the savepoint (including partially acquired locks)
 * before continuing an ordinary write with unavailable schema evidence. Do not retry/capture later.
 */
export async function captureAutomationRecordSchema(
  trx: Queryable, sheetId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<AutomationRecordSchemaToken | undefined> {
  if (!isDurableDeliveryEnabled(env)) return undefined
  if (!validId(sheetId)) return fail('AUTOMATION_RECORD_SCHEMA_INPUT_INVALID')
  let xid: string
  try {
    const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
    if (isolation.rows.length !== 1 || data(isolation.rows[0], ['isolation']).isolation !== 'read committed') {
      return fail('AUTOMATION_RECORD_SCHEMA_TRANSACTION_REQUIRED')
    }
    await assertInTransaction(trx, 'Automation record schema')
    xid = await currentXid(trx)
  } catch { return fail('AUTOMATION_RECORD_SCHEMA_TRANSACTION_REQUIRED') }
  try {
    await trx.query('SAVEPOINT automation_record_schema_capture')
    try {
      // Same order as the material-epoch reader and its direct-write DB guard. Never wait here:
      // existing link fences may already own row locks needed by a concurrent schema writer.
      await trx.query(`LOCK TABLE meta_sheets, meta_fields,
        plugin_multitable_object_registry IN SHARE MODE NOWAIT`)
      const schemas = await trx.query(`SELECT (count(c.oid) = 4 AND count(DISTINCT c.relnamespace) = 1
        AND bool_and(c.relkind = 'r' AND NOT c.relrowsecurity)) AS consistent
        FROM unnest($1::text[]) AS expected(name)
        LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(expected.name)`, [relations])
      if (schemas.rows.length !== 1 || data(schemas.rows[0], ['consistent']).consistent !== true) unavailable()
      const revision = await readRevision(trx, sheetId, true)
      await trx.query('RELEASE SAVEPOINT automation_record_schema_capture')
      return token({ trx, sheetId, xid, revision })
    } catch (error) {
      const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
      if (code !== '55P03') throw error
      await trx.query('ROLLBACK TO SAVEPOINT automation_record_schema_capture')
      await trx.query('RELEASE SAVEPOINT automation_record_schema_capture')
      return token({ trx, sheetId, xid, revision: null })
    }
  } catch { return unavailable() }
}

/** Resolve only the earlier capture, never acquire a replacement nonce after the source DML.
 * Recheck xid even for unavailable tokens so a reused query function cannot carry evidence across
 * transactions. Same-transaction schema changes invalidate the capture instead of recapturing it.
 */
export async function resolveAutomationRecordSchemaRevision(
  trx: Queryable, sheetId: string, captured: AutomationRecordSchemaToken | undefined,
): Promise<string | null> {
  if (captured === undefined) return null
  const state = captured && typeof captured === 'object' ? captures.get(captured) : undefined
  if (!state || state.trx !== trx || state.sheetId !== sheetId) return fail('AUTOMATION_RECORD_SCHEMA_TOKEN_INVALID')
  let xid: string
  try { xid = await currentXid(trx) } catch { return unavailable() }
  if (xid !== state.xid) return fail('AUTOMATION_RECORD_SCHEMA_TOKEN_INVALID')
  if (state.revision === null) return null
  try {
    // ROLLBACK TO an earlier caller savepoint can release the successful capture's locks without
    // changing xid or nonce. Observe existing fences only; never repair a lost pre-DML capture.
    const fences = await trx.query(`SELECT (count(c.oid) = 3 AND count(DISTINCT c.relnamespace) = 1
      AND bool_and(EXISTS(SELECT 1 FROM pg_catalog.pg_locks l
        WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'relation' AND l.relation = c.oid
          AND l.granted AND l.mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')))) AS held
      FROM unnest($1::text[]) AS expected(name)
      LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(expected.name)`, [relations.slice(0, 3)])
    if (fences.rows.length !== 1) return unavailable()
    const held = data(fences.rows[0], ['held']).held
    if (held === false) return null
    if (held !== true) return unavailable()
    return await readRevision(trx, sheetId, false) === state.revision ? state.revision : null
  } catch { return unavailable() }
}

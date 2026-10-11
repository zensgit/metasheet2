import { canonicalReadId } from './automation-read-contracts'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'

export type AutomationReadMaterialEpochInput = {
  tenantId: string
  workspaceId: null
  projectId: string
  objectId: string
  sheetId: string
}
export type LockedAutomationReadMaterialEpochs = Readonly<{
  baseId: string
  revisions: Readonly<{ sheet: string; base: string; pack: string | null }>
}>
export type AutomationReadMaterialEpochErrorCode = 'AUTOMATION_MATERIAL_INPUT_INVALID'
  | 'AUTOMATION_MATERIAL_TRANSACTION_REQUIRED' | 'AUTOMATION_MATERIAL_UNAVAILABLE' | 'AUTOMATION_MATERIAL_DENIED'
export class AutomationReadMaterialEpochError extends Error {
  constructor(readonly code: AutomationReadMaterialEpochErrorCode) {
    super(code)
    this.name = 'AutomationReadMaterialEpochError'
  }
}
type Row = Record<string, unknown>
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const relations = ['meta_bases', 'meta_sheets', 'meta_fields', 'plugin_multitable_object_registry',
  'integration_stock_prep_pack_installs', 'automation_read_material_epochs']
function fail(code: AutomationReadMaterialEpochErrorCode): never { throw new AutomationReadMaterialEpochError(code) }
function denied(): never { return fail('AUTOMATION_MATERIAL_DENIED') }
function unavailable(): never { return fail('AUTOMATION_MATERIAL_UNAVAILABLE') }
function data(value: unknown, keys: string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length) return unavailable()
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return unavailable()
    return [key, descriptor.value]
  }))
}

/**
 * HOST-PRIVATE material epoch capture. This is NOT tenant ownership, permission,
 * installation lifecycle, profile authenticity or source authorization proof.
 * The composing provider supplies trusted scope and independently proves them.
 * Caller owns one short real READ COMMITTED transaction; no records/source IO.
 *
 * Acquire the five source-table SHARE/NOWAIT locks BEFORE epoch rows. They cover
 * negative pack lookup and all source mutations; direct epoch DML crosses the
 * same source write fence in the DB trigger. Current liveness/base association
 * is read while locked, never inferred from projectId or a retained tombstone.
 * Every conflict/missing schema requires rollback; these locks grant no ongoing
 * authority beyond this transaction. No read-time epoch INSERT/default exists.
 */
export async function lockAutomationReadMaterialEpochs(
  trx: Queryable,
  input: AutomationReadMaterialEpochInput,
): Promise<LockedAutomationReadMaterialEpochs> {
  let captured: Readonly<AutomationReadMaterialEpochInput>
  try {
    const row = data(input, ['tenantId', 'workspaceId', 'projectId', 'objectId', 'sheetId'])
    if (row.workspaceId !== null || !canonicalReadId(row.tenantId) || !canonicalReadId(row.projectId)
      || !canonicalReadId(row.objectId) || !canonicalReadId(row.sheetId)) denied()
    captured = Object.freeze({ tenantId: row.tenantId, workspaceId: null, projectId: row.projectId,
      objectId: row.objectId, sheetId: row.sheetId })
  } catch { return fail('AUTOMATION_MATERIAL_INPUT_INVALID') }
  try {
    const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
    if (isolation.rows.length !== 1 || data(isolation.rows[0], ['isolation']).isolation !== 'read committed') unavailable()
    await assertInTransaction(trx, 'Automation material epochs')
  } catch { return fail('AUTOMATION_MATERIAL_TRANSACTION_REQUIRED') }
  try {
    await trx.query(`LOCK TABLE meta_bases, meta_sheets, meta_fields,
      plugin_multitable_object_registry, integration_stock_prep_pack_installs IN SHARE MODE NOWAIT`)
    const schemas = (await trx.query(`SELECT (count(c.oid) = 6 AND count(DISTINCT c.relnamespace) = 1
      AND bool_and(c.relkind = 'r' AND NOT c.relrowsecurity)) AS consistent
      FROM unnest($1::text[]) AS expected(name)
      LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(expected.name)`, [relations])).rows
    if (schemas.length !== 1 || data(schemas[0], ['consistent']).consistent !== true) unavailable()
    const sheets = (await trx.query('SELECT id, base_id, deleted_at FROM meta_sheets WHERE id = $1', [captured.sheetId])).rows
    if (sheets.length !== 1) denied()
    const sheet = data(sheets[0], ['id', 'base_id', 'deleted_at'])
    if (sheet.id !== captured.sheetId || sheet.deleted_at !== null || !canonicalReadId(sheet.base_id)) denied()
    const baseId = sheet.base_id
    const bases = (await trx.query('SELECT id, deleted_at FROM meta_bases WHERE id = $1', [baseId])).rows
    if (bases.length !== 1) denied()
    const base = data(bases[0], ['id', 'deleted_at'])
    if (base.id !== baseId || base.deleted_at !== null) denied()
    const scopes = Object.freeze({ sheet: Object.freeze({ id: captured.sheetId }), base: Object.freeze({ id: baseId }),
      pack: Object.freeze({ tenantId: captured.tenantId, projectId: captured.projectId, objectId: captured.objectId }) })
    const rows = (await trx.query(`SELECT kind, scope, revision FROM automation_read_material_epochs
      WHERE (kind = 'sheet' AND scope = $1::jsonb) OR (kind = 'base' AND scope = $2::jsonb)
        OR (kind = 'pack' AND scope = $3::jsonb) ORDER BY kind, scope FOR SHARE NOWAIT`,
    [JSON.stringify(scopes.sheet), JSON.stringify(scopes.base), JSON.stringify(scopes.pack)])).rows
    const revisions: { sheet: string | null; base: string | null; pack: string | null } = { sheet: null, base: null, pack: null }
    const seen = new Set<string>()
    for (const raw of rows) {
      const row = data(raw, ['kind', 'scope', 'revision'])
      if (row.kind !== 'sheet' && row.kind !== 'base' && row.kind !== 'pack') denied()
      const kind = row.kind
      if (seen.has(kind)) denied()
      seen.add(kind)
      const expected: Row = scopes[kind]
      const actual = data(row.scope, Object.keys(expected))
      if (!Object.keys(expected).every(key => actual[key] === expected[key])) denied()
      if (typeof row.revision !== 'string' || !uuid.test(row.revision)) unavailable()
      revisions[kind] = row.revision
    }
    if (revisions.sheet === null || revisions.base === null) denied()
    return Object.freeze({ baseId, revisions: Object.freeze({ sheet: revisions.sheet, base: revisions.base, pack: revisions.pack }) })
  } catch (error) {
    if (error instanceof AutomationReadMaterialEpochError) throw error
    return unavailable()
  }
}

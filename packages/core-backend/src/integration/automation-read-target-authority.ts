import { createHash } from 'node:crypto'
import { canonicalReadId, exactObject } from './automation-read-contracts'
import { canonicalizeConfig } from '../multitable/automation-action-idempotency'
import { isStrictAutomationConditionFieldType } from '../multitable/automation-conditions'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import { loadDatabaseFreshRecoveryAccess } from '../multitable/recovery-authorization-stability'
import { loadFieldPermissionScopeMap, resolveSheetCapabilitiesForAccess } from '../multitable/permission-service'
import { deriveFieldPermissions } from '../multitable/permission-derivation'
import { isApprovalProjectionBaseId } from '../multitable/approval-projection-constants'
import { isElearningProjectionBaseIdCandidate, isElearningProjectionSheetIdCandidate } from '../multitable/elearning-projection-constants'

export type AutomationReadTargetInput = {
  actorId: string
  baseId: string
  sheetId: string
  fieldIds: string[]
}

/** Private, transaction-local proof of complete rows for a CLOSED stored-field projection. */
export type LockedAutomationReadTarget = Readonly<{
  actorId: string
  baseId: string
  sheetId: string
  fieldIds: readonly string[]
  // Content snapshot only, NOT an incarnation/revision or an enduring authorization.
  fingerprint: string
}>

/** Host-private stored metadata for condition compilation; never field values or relation hydration. */
export type LockedAutomationReadConditionFields = Readonly<LockedAutomationReadTarget & {
  fields: readonly Readonly<{ id: string; type: string; propertyJson: string }>[]
}>

export class AutomationTargetAuthorityError extends Error {
  constructor(readonly code: 'AUTOMATION_TARGET_INPUT_INVALID' | 'AUTOMATION_TARGET_TRANSACTION_REQUIRED'
    | 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' | 'AUTOMATION_TARGET_AUTHORITY_DENIED') {
    super(code)
    this.name = 'AutomationTargetAuthorityError'
  }
}

// Explicit finite stored types. Do not use mapFieldType: it turns unknown types
// into string. Computed/foreign/plugin-defined types need a separate taint proof.
const storedTypes = new Set([
  'string', 'text', 'number', 'boolean', 'checkbox', 'date', 'dateTime', 'datetime',
  'select', 'multiSelect', 'longText', 'currency', 'percent', 'rating', 'duration',
  'url', 'email', 'phone', 'barcode', 'qrcode', 'location', 'autoNumber',
  'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy',
])

function deny(): never { throw new AutomationTargetAuthorityError('AUTOMATION_TARGET_AUTHORITY_DENIED') }
function unavailable(): never { throw new AutomationTargetAuthorityError('AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE') }

/**
 * HOST-PRIVATE prerequisite, currently unwired. The caller must first lock the
 * trusted live integration actor in this transaction, and separately prove the
 * canonical Connection owner, source/receipt, rule and canonical deployment's
 * target/mapping incarnation. fieldIds MUST come from that trusted finite action
 * contract, not a client-selected permission subset.
 *
 * This does NOT authorize the existing plugin raw records adapter: it returns
 * every data key. A future host-sealed records facade MUST project only these
 * fields (plus required non-field identity metadata), including the whole-sheet
 * active/projectNo scan, without filtering hidden rows and pretending completeness.
 * No records or external source are read here. No writes, transaction control,
 * grant minting, production registration or long-lived permission token.
 *
 * SHARE table locks deliberately cover newly INSERTed ACLs/memberships; existing
 * row locks alone cannot. All are NOWAIT and held only in a short caller-owned RC
 * transaction; any conflict requires rollback, not a permissive fallback. Row
 * locks freeze base/sheet flags and required field metadata. There is no lock held
 * across source IO; consumers must revalidate before IO and result publication.
 */
export async function lockAutomationReadTarget(
  trx: Queryable,
  input: AutomationReadTargetInput,
): Promise<LockedAutomationReadTarget> {
  return (await lockAutomationReadFields(trx, input, 'target')).proof
}

/** Same fresh full-read ACL gate as the target path, with an independent CLOSED condition-type
 * policy. Only raw stored IDs are permitted for person/user/link; this grants no foreign-row read.
 * The caller supplies the complete trusted AST dependency set and independently proves snapshot
 * identity/schema revision. This metadata neither authorizes conditions nor reads record values.
 */
export async function lockAutomationReadConditionFields(
  trx: Queryable,
  input: AutomationReadTargetInput,
): Promise<LockedAutomationReadConditionFields> {
  const locked = await lockAutomationReadFields(trx, input, 'condition')
  return Object.freeze({ ...locked.proof, fields: locked.conditionFields })
}

async function lockAutomationReadFields(
  trx: Queryable,
  input: AutomationReadTargetInput,
  purpose: 'target' | 'condition',
): Promise<Readonly<{ proof: LockedAutomationReadTarget; conditionFields: LockedAutomationReadConditionFields['fields'] }>> {
  if (!exactObject(input, ['actorId', 'baseId', 'sheetId', 'fieldIds'])) {
    throw new AutomationTargetAuthorityError('AUTOMATION_TARGET_INPUT_INVALID')
  }
  const { actorId, baseId, sheetId, fieldIds: rawFieldIds } = input
  const fieldIds = Array.isArray(rawFieldIds) ? [...rawFieldIds] : []
  if (![actorId, baseId, sheetId].every(canonicalReadId) || fieldIds.length < 1 || fieldIds.length > 256
    || !fieldIds.every(canonicalReadId) || new Set(fieldIds).size !== fieldIds.length) {
    throw new AutomationTargetAuthorityError('AUTOMATION_TARGET_INPUT_INVALID')
  }
  fieldIds.sort()
  try {
    const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
    if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') throw new Error('Isolation')
    await assertInTransaction(trx, 'Automation target authority')
  } catch {
    throw new AutomationTargetAuthorityError('AUTOMATION_TARGET_TRANSACTION_REQUIRED')
  }
  try {
    // LOCK also requires every authority table to exist before the shared legacy
    // loaders can take their missing-table compatibility paths. No user SQL names.
    await trx.query(`LOCK TABLE users, user_roles, user_permissions, role_permissions,
      platform_member_group_members, spreadsheet_permissions, field_permissions,
      record_permissions IN SHARE MODE NOWAIT`)
    const bases = (await trx.query('SELECT id, deleted_at FROM meta_bases WHERE id = $1 FOR SHARE NOWAIT', [baseId])).rows
    if (bases.length !== 1 || bases[0]?.id !== baseId || bases[0]?.deleted_at !== null) deny()
    const sheets = (await trx.query(`SELECT id, base_id, deleted_at, row_level_read_permissions_enabled
      FROM meta_sheets WHERE id = $1 FOR SHARE NOWAIT`, [sheetId])).rows
    const sheet = sheets[0]
    if (sheets.length !== 1 || sheet?.id !== sheetId || sheet?.base_id !== baseId || sheet?.deleted_at !== null) deny()
    if (typeof sheet.row_level_read_permissions_enabled !== 'boolean') unavailable()
    // Only ordinary stock-preparation targets. Special projection policies and
    // transitive sources are NOT implicitly covered by the finite lock set here.
    if (isApprovalProjectionBaseId(baseId) || isElearningProjectionBaseIdCandidate(baseId)
      || isElearningProjectionSheetIdCandidate(sheetId)) deny()

    // The target SQL/decoded-property contract stays unchanged. The condition path transfers only
    // bounded raw PG text, preserving exact numeric option metadata for its later strict compiler.
    const fieldSql = purpose === 'target'
      ? `SELECT id, sheet_id, type, property FROM meta_fields
      WHERE sheet_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR SHARE NOWAIT`
      : `SELECT id, sheet_id, type,
        CASE WHEN octet_length(COALESCE(NULLIF(property,'null'::jsonb),'{}'::jsonb)::text)<=65536
          THEN COALESCE(NULLIF(property,'null'::jsonb),'{}'::jsonb)::text ELSE NULL END AS property_json,
        octet_length(COALESCE(NULLIF(property,'null'::jsonb),'{}'::jsonb)::text)>65536 AS property_oversized
      FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR SHARE NOWAIT`
    const rows = (await trx.query(fieldSql, [sheetId, fieldIds])).rows
    if (rows.length !== fieldIds.length || new Set(rows.map(row => row.id)).size !== fieldIds.length) deny()
    const conditionProperties = new Map<string, string>()
    const fields = rows.map(row => {
      if (typeof row.id !== 'string' || !fieldIds.includes(row.id) || row.sheet_id !== sheetId
        || typeof row.type !== 'string'
        || !(purpose === 'target' ? storedTypes.has(row.type) : isStrictAutomationConditionFieldType(row.type))) deny()
      let property: unknown = row.property
      if (purpose === 'condition') {
        if (row.property_oversized === true) deny()
        if (row.property_oversized !== false || typeof row.property_json !== 'string') unavailable()
        if (Buffer.byteLength(row.property_json, 'utf8') > 65536) deny()
        property = JSON.parse(row.property_json) as unknown
        conditionProperties.set(row.id as string, row.property_json)
      }
      if (property !== null && (!property || typeof property !== 'object' || Array.isArray(property)
        || Object.getPrototypeOf(property) !== Object.prototype)) unavailable()
      if (property && typeof property === 'object' && Object.hasOwn(property, 'mirrorOf')) deny()
      return { id: row.id as string, type: row.type as string, property: (property ?? {}) as Record<string, unknown> }
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

    // Sticky failure prevents a compatibility catch in a shared permission helper
    // from ever turning a SQL/schema failure into a successful strict proof.
    let queryFailed = false
    const query = async (sql: string, params?: unknown[]) => {
      try { return await trx.query(sql, params) } catch (error) { queryFailed = true; throw error }
    }
    const access = await loadDatabaseFreshRecoveryAccess(query, actorId)
    if (queryFailed) unavailable()
    if (access.userId !== actorId) deny()
    const resolved = await resolveSheetCapabilitiesForAccess(query, sheetId, access)
    if (queryFailed) unavailable()
    if (resolved.sheetLiveness !== 'live' || resolved.capabilities.canRead !== true) deny()
    // Match existing full-read policy, not a denied-IDs-empty data oracle. This
    // covers conditional as well as explicit record deny, without reading values.
    if (!access.isAdminRole && sheet.row_level_read_permissions_enabled !== false) deny()
    const fieldScopeMap = await loadFieldPermissionScopeMap(query, sheetId, actorId)
    if (queryFailed) unavailable()
    const permissions = deriveFieldPermissions(fields, resolved.capabilities, { fieldScopeMap })
    // Admin is NOT a field-hidden bypass. Required hidden fields cannot be dropped
    // from both sides of a set comparison and then mistaken for complete access.
    if (fields.some(field => permissions[field.id]?.visible !== true)) deny()
    const conditionFields = Object.freeze(purpose === 'condition' ? fields.map(field => {
      const propertyJson = conditionProperties.get(field.id)
      if (propertyJson === undefined) return unavailable()
      return Object.freeze({ id: field.id, type: field.type, propertyJson })
    }) : [])
    const fingerprint = createHash('sha256').update(canonicalizeConfig({
      baseId, sheetId, rowLevelReadPermissionsEnabled: sheet.row_level_read_permissions_enabled,
      fields: purpose === 'target' ? fields : conditionFields,
    })).digest('hex')
    const proof = Object.freeze({ actorId, baseId, sheetId, fieldIds: Object.freeze(fieldIds), fingerprint })
    return Object.freeze({ proof, conditionFields })
  } catch (error) {
    if (error instanceof AutomationTargetAuthorityError) throw error
    return unavailable()
  }
}

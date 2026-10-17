import { createHash } from 'node:crypto'
import { canonicalReadId } from './automation-read-contracts'
import { canonicalizeConfig } from '../multitable/automation-action-idempotency'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import { AutomationReadMaterialEpochError, lockAutomationReadMaterialEpochs } from './automation-read-material-epochs'

export type AutomationReadInstalledMaterialInput = {
  tenantId: string
  workspaceId: null
  projectId: string
  objectId: string
  sheetId: string
  fieldIdMap: Record<string, string>
}
export type FrozenInstalledJson = null | boolean | number | string | readonly FrozenInstalledJson[]
  | { readonly [key: string]: FrozenInstalledJson }
type FrozenObject = { readonly [key: string]: FrozenInstalledJson }
export type AutomationReadInstalledMaterial = Readonly<{
  installedFieldProperties: readonly Readonly<{ fieldId: string; property: FrozenObject }>[]
  baseId: string
  revisions: Readonly<{ sheet: string; base: string; pack: string | null }>
  // Complete captured content only, not an incarnation, ABA nonce or authority.
  fingerprint: string
}>
export type AutomationInstalledMaterialErrorCode = 'AUTOMATION_INSTALLED_INPUT_INVALID'
  | 'AUTOMATION_INSTALLED_TRANSACTION_REQUIRED' | 'AUTOMATION_INSTALLED_UNAVAILABLE' | 'AUTOMATION_INSTALLED_DENIED'
export class AutomationInstalledMaterialError extends Error {
  constructor(readonly code: AutomationInstalledMaterialErrorCode) {
    super(code)
    this.name = 'AutomationInstalledMaterialError'
  }
}

const unsafeNames = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'])
const logicalIdPattern = /^[A-Za-z0-9_:.@|-]{1,120}$/u
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u
const registryKeys = ['sheet_id', 'project_id', 'object_id', 'plugin_name', 'created_at', 'updated_at']
const ledgerKeys = ['id', 'tenant_id', 'workspace_id', 'project_id', 'object_id', 'pack_id', 'pack_version',
  'mode', 'status', 'installed_fields_json', 'summary_json', 'warnings_json', 'last_install_at', 'created_at']
const fieldKeys = ['id', 'sheet_id', 'name', 'type', 'property', 'order', 'created_at', 'updated_at']
function fail(code: AutomationInstalledMaterialErrorCode): never { throw new AutomationInstalledMaterialError(code) }
function unavailable(): never { return fail('AUTOMATION_INSTALLED_UNAVAILABLE') }
function denied(): never { return fail('AUTOMATION_INSTALLED_DENIED') }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
  })
}
function id(value: unknown): value is string { return canonicalReadId(value) && !unsafeNames.has(value) }
function logicalId(value: unknown): value is string { return id(value) && logicalIdPattern.test(value) }
function timestamp(value: unknown): boolean { return typeof value === 'string' && timestampPattern.test(value) }

/** Copy descriptors, not serialization hooks; reject material JSON cannot represent. */
function frozenJson(value: unknown, seen = new Set<object>(), depth = 0): FrozenInstalledJson {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null || seen.has(value) || depth > 100) return unavailable()
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) unavailable()
      return Object.freeze(Array.from({ length: value.length }, (_item, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return unavailable()
        return frozenJson(descriptor.value, seen, depth + 1)
      }))
    }
    if (!object(value)) return unavailable()
    return Object.freeze(Object.fromEntries(Reflect.ownKeys(value).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return unavailable()
      return [key, frozenJson(descriptor.value, seen, depth + 1)]
    })))
  } finally { seen.delete(value) }
}
function rawRow(row: unknown, alias: string, required: string[]): FrozenObject {
  if (!exact(row, [alias])) return unavailable()
  const raw = frozenJson(row[alias])
  if (!object(raw) || !required.every(key => Object.hasOwn(raw, key))) return unavailable()
  return raw as FrozenObject
}

/**
 * HOST-PRIVATE metadata prerequisite, currently unwired. All scope and map inputs
 * must come from trusted complete live deployment proof. The registry is a positive
 * plugin/project/object/sheet binding only: neither it nor the tenant-filtered pack
 * ledger proves tenant ownership, actor permissions or deployment
 * authenticity. A future provider must independently establish those facts. Never
 * equate projectId with baseId or invent a deterministic physical-field mapping.
 *
 * Caller owns one short READ COMMITTED transaction. The real material-epoch helper
 * locks all five metadata source tables SHARE/NOWAIT, checks live sheet -> base,
 * then captures DB-minted revisions; a positive ledger needs a pack revision too.
 * These revisions detect committed metadata ABA, not completed installation.
 * Table locks cover insert/update/delete phantoms; the positive registry row stays
 * SHARE-locked too. Conflicts or old/missing schemas fail closed; caller rolls back.
 * Ledger fields nominate candidates, never supply live ownership. All live field
 * metadata is captured to detect orphan extension stamps (including crash-before-
 * ledger state). Option-source/pack provenance alone is NOT an extension marker.
 * Marker-negative scans cannot prove installation is quiescent: an installer may
 * adopt a previously stamped field without adding an extension marker. This is a
 * complete locked ledger-candidate capture, NOT complete installer-lifecycle or
 * logical-to-physical binding authenticity proof; the provider must prove those too.
 * No records/source IO, transactions opened, grants or production registration.
 */
export async function loadAutomationReadInstalledMaterial(
  trx: Queryable,
  input: AutomationReadInstalledMaterialInput,
): Promise<AutomationReadInstalledMaterial> {
  let scope: AutomationReadInstalledMaterialInput
  try {
    if (!exact(input, ['tenantId', 'workspaceId', 'projectId', 'objectId', 'sheetId', 'fieldIdMap'])
      || input.workspaceId !== null || ![input.tenantId, input.projectId, input.objectId, input.sheetId].every(id)
      || !object(input.fieldIdMap)) fail('AUTOMATION_INSTALLED_INPUT_INVALID')
    const map = frozenJson(input.fieldIdMap)
    if (!object(map) || Object.keys(map).length > 2048) fail('AUTOMATION_INSTALLED_INPUT_INVALID')
    const physical = new Set<string>()
    for (const [logical, value] of Object.entries(map)) {
      // The complete action map also contains non-pack template fields. Keep
      // its existing identifier contract; the ledger's narrower 120-char ASCII
      // grammar applies only to its own candidate/pack handles below.
      if (!id(logical) || !id(value) || physical.has(value)) fail('AUTOMATION_INSTALLED_INPUT_INVALID')
      physical.add(value)
    }
    // Capture every primitive and a detached map BEFORE the first await.
    scope = Object.freeze({ tenantId: input.tenantId, workspaceId: null, projectId: input.projectId,
      objectId: input.objectId, sheetId: input.sheetId, fieldIdMap: map as Record<string, string> })
  } catch {
    return fail('AUTOMATION_INSTALLED_INPUT_INVALID')
  }
  try {
    const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
    if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') throw new Error('Isolation')
    await assertInTransaction(trx, 'Automation installed material')
  } catch {
    return fail('AUTOMATION_INSTALLED_TRANSACTION_REQUIRED')
  }
  try {
    const epochs = await lockAutomationReadMaterialEpochs(trx, { tenantId: scope.tenantId, workspaceId: null,
      projectId: scope.projectId, objectId: scope.objectId, sheetId: scope.sheetId })
    const registryRows = (await trx.query(`SELECT (pg_catalog.to_jsonb(r) || pg_catalog.jsonb_build_object(
      'created_at', pg_catalog.to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'updated_at', pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      )) AS raw_registry FROM plugin_multitable_object_registry r
      WHERE r.sheet_id = $1 AND r.project_id = $2 AND r.object_id = $3
        AND r.plugin_name = 'plugin-integration-core' FOR SHARE NOWAIT`, [scope.sheetId, scope.projectId, scope.objectId])).rows
    if (registryRows.length !== 1) denied()
    const registry = rawRow(registryRows[0], 'raw_registry', registryKeys)
    if (registry.sheet_id !== scope.sheetId || registry.project_id !== scope.projectId
      || registry.object_id !== scope.objectId || registry.plugin_name !== 'plugin-integration-core') denied()
    if (!timestamp(registry.created_at) || !timestamp(registry.updated_at)) unavailable()

    // Deliberately do NOT filter workspace or status: unsupported/failed entries
    // must refuse, not disappear and masquerade as a complete empty installation.
    const ledgerRows = (await trx.query(`SELECT (pg_catalog.to_jsonb(i) || pg_catalog.jsonb_build_object(
      'last_install_at', pg_catalog.to_char(i.last_install_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'created_at', pg_catalog.to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      )) AS raw_install FROM integration_stock_prep_pack_installs i
      WHERE i.tenant_id = $1 AND i.project_id = $2 AND i.object_id = $3
      ORDER BY i.id LIMIT 201`, [scope.tenantId, scope.projectId, scope.objectId])).rows
    if (ledgerRows.length > 200) denied()
    const ledger = ledgerRows.map(row => rawRow(row, 'raw_install', ledgerKeys))
    if (ledger.length > 0 && epochs.revisions.pack === null) denied()
    const candidateIds = new Set<string>()
    const ledgerIds = new Set<string>()
    for (const row of ledger) {
      if (row.tenant_id !== scope.tenantId || row.project_id !== scope.projectId || row.object_id !== scope.objectId
        || row.workspace_id !== null || (row.status !== 'installed' && row.status !== 'partial')) denied()
      if (!id(row.id) || ledgerIds.has(row.id) || !logicalId(row.pack_id) || !logicalId(row.pack_version)
        || (row.mode !== 'install' && row.mode !== 'reinstall') || !timestamp(row.last_install_at)
        || !timestamp(row.created_at) || !Array.isArray(row.installed_fields_json)) unavailable()
      ledgerIds.add(row.id)
      const rowFields = new Set<string>()
      for (const entry of row.installed_fields_json) {
        if (!exact(entry, ['fieldId', 'ownership', 'preserveOnRefresh', 'extension']) || !logicalId(entry.fieldId)
          || (entry.ownership !== 'plm_system' && entry.ownership !== 'human_preserved')
          || typeof entry.preserveOnRefresh !== 'boolean' || typeof entry.extension !== 'boolean'
          || rowFields.has(entry.fieldId)) unavailable()
        rowFields.add(entry.fieldId)
        candidateIds.add(entry.fieldId)
      }
    }

    const fieldRows = (await trx.query(`SELECT (pg_catalog.to_jsonb(f) || pg_catalog.jsonb_build_object(
      'created_at', pg_catalog.to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'updated_at', pg_catalog.to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      )) AS raw_field FROM meta_fields f WHERE f.sheet_id = $1 ORDER BY f.id LIMIT 2049`, [scope.sheetId])).rows
    if (fieldRows.length > 2048) denied()
    const fields = fieldRows.map(row => rawRow(row, 'raw_field', fieldKeys))
    const fieldsById = new Map<string, FrozenObject>()
    for (const field of fields) {
      if (field.sheet_id !== scope.sheetId) denied()
      if (!id(field.id) || fieldsById.has(field.id) || typeof field.name !== 'string'
        || typeof field.type !== 'string' || field.type.length === 0 || !Number.isSafeInteger(field.order)
        || !object(field.property) || (field.created_at !== null && !timestamp(field.created_at))
        || (field.updated_at !== null && !timestamp(field.updated_at))) unavailable()
      fieldsById.set(field.id, field)
    }
    const identity = Object.keys(scope.fieldIdMap).length === 0
    const candidatePhysicalIds = new Set<string>()
    const installedFieldProperties = [...candidateIds].sort().map(fieldId => {
      if (!identity && !Object.hasOwn(scope.fieldIdMap, fieldId)) denied()
      const physicalId = identity ? fieldId : scope.fieldIdMap[fieldId]
      const field = fieldsById.get(physicalId)
      if (!field) return denied()
      candidatePhysicalIds.add(physicalId)
      return Object.freeze({ fieldId, property: field.property as FrozenObject })
    })
    for (const field of fields) {
      const property = field.property as FrozenObject
      if (object(property.stockPreparation) && property.stockPreparation.extension === true
        && !candidatePhysicalIds.has(field.id as string)) denied()
    }
    for (const [logical, physical] of Object.entries(scope.fieldIdMap)) {
      if (logical.startsWith('ext_') && fieldsById.has(physical) && !candidatePhysicalIds.has(physical)) denied()
    }
    const fingerprint = createHash('sha256').update(canonicalizeConfig({ scope, registry, ledger, fields })).digest('hex')
    return Object.freeze({ installedFieldProperties: Object.freeze(installedFieldProperties), fingerprint,
      baseId: epochs.baseId, revisions: epochs.revisions })
  } catch (error) {
    if (error instanceof AutomationInstalledMaterialError) throw error
    if (error instanceof AutomationReadMaterialEpochError && error.code === 'AUTOMATION_MATERIAL_DENIED') denied()
    return unavailable()
  }
}

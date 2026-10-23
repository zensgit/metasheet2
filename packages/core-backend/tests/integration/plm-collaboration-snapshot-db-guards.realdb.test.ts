import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Kysely, Migrator, PostgresDialect, sql, type MigrationProvider } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { describe, test } from 'vitest'
import { EventBus } from '../../src/integration/events/event-bus'
import { up, down } from '../../src/db/migrations/zzzz20261024010000_create_plm_collaboration_snapshots'
import { normalizeJson } from '../../src/multitable/field-codecs'
import { __resetRecoveryWriterStateColumnProbe, fenceWriterEntry } from '../../src/multitable/canonical-sheet-fence'
import { __resetOperationLedgerColumnProbe, mintOperation, sealOperation } from '../../src/multitable/operation-ledger'
import {
  ECO_COLLABORATION_ECO_FIELDS,
  ECO_COLLABORATION_LOCAL_FIELDS,
} from '../../src/multitable/plm-collaboration-snapshot-wire'
import { recordRecordRevision, recordVersionMarker } from '../../src/multitable/record-history-service'
import {
  RecordWriteService,
  type ConnectionPool,
  type RecordWriteHelpers,
} from '../../src/multitable/record-write-service'
import { bootstrapPlmCollaborationSnapshotTestDb } from '../plm-collaboration-snapshot/bootstrap'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for plm collaboration snapshot realdb tests')
}

const DATABASE_URL = process.env.DATABASE_URL
const FAMILY = 'plm_collaboration_source_protected'
const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const CAPTURED_AT = '2026-10-24T03:04:05.000000Z'
const NATIVE_AT = '2026-10-24T00:00:00.000000Z'
const FUNCTIONS = [
  'meta_plm_collaboration_accepted_sync',
  'meta_plm_collaboration_binding_guard',
  'meta_plm_collaboration_commit_guard',
  'meta_plm_collaboration_container_guard',
  'meta_plm_collaboration_eco_row_key',
  'meta_plm_collaboration_field_guard',
  'meta_plm_collaboration_native_timestamp',
  'meta_plm_collaboration_preview_guard',
  'meta_plm_collaboration_record_guard',
  'meta_plm_collaboration_refuse',
  'meta_plm_collaboration_row_guard',
  'meta_plm_collaboration_source_value_ok',
  'meta_plm_collaboration_sync_guard',
  'meta_plm_collaboration_truncate_guard',
]
const TRIGGERS = [
  'meta_plm_collaboration_preview_guard',
  'meta_plm_collaboration_binding_guard',
  'meta_plm_collaboration_sync_guard',
  'meta_plm_collaboration_row_guard',
  'meta_plm_collaboration_record_guard',
  'meta_plm_collaboration_field_guard',
  'meta_plm_collaboration_sheets_guard',
  'meta_plm_collaboration_bases_guard',
  'meta_plm_collaboration_views_guard',
  'meta_plm_collaboration_commit_guard',
  'meta_plm_collaboration_records_truncate',
  'meta_plm_collaboration_fields_truncate',
  'meta_plm_collaboration_sheets_truncate',
  'meta_plm_collaboration_bases_truncate',
  'meta_plm_collaboration_views_truncate',
  'meta_plm_collaboration_previews_truncate',
  'meta_plm_collaboration_bindings_truncate',
  'meta_plm_collaboration_rows_truncate',
  'meta_plm_collaboration_syncs_truncate',
]
const CHECKS = [
  'meta_plm_collaboration_bindings_kind_check',
  'meta_plm_collaboration_bindings_version_check',
  'meta_plm_collaboration_bindings_status_check',
  'meta_plm_collaboration_bindings_creator_check',
  'meta_plm_collaboration_bindings_datasource_check',
  'meta_plm_collaboration_bindings_tenant_check',
  'meta_plm_collaboration_bindings_org_check',
  'meta_plm_collaboration_bindings_item_check',
  'meta_plm_collaboration_bindings_current_version_check',
  'meta_plm_collaboration_bindings_name_check',
  'meta_plm_collaboration_bindings_fingerprint_check',
  'meta_plm_collaboration_bindings_maps_check',
  'meta_plm_collaboration_previews_kind_check',
  'meta_plm_collaboration_previews_actor_check',
  'meta_plm_collaboration_previews_datasource_check',
  'meta_plm_collaboration_previews_tenant_check',
  'meta_plm_collaboration_previews_org_check',
  'meta_plm_collaboration_previews_item_check',
  'meta_plm_collaboration_previews_current_version_check',
  'meta_plm_collaboration_previews_name_check',
  'meta_plm_collaboration_previews_fingerprint_check',
  'meta_plm_collaboration_previews_hash_check',
  'meta_plm_collaboration_previews_row_key_check',
  'meta_plm_collaboration_previews_expiry_check',
  'meta_plm_collaboration_previews_receipt_check',
  'meta_plm_collaboration_rows_hash_check',
  'meta_plm_collaboration_rows_key_check',
  'meta_plm_collaboration_syncs_actor_check',
  'meta_plm_collaboration_syncs_version_check',
  'meta_plm_collaboration_syncs_patches_check',
]

interface Admission {
  actorId: string
  localActorId: string
  baseId: string
  sheetId: string
  viewId: string
  bindingId: string
  syncId: string
  recordId: string
  dataSourceId: string
  tenantId: string
  orgId: string
  itemId: string
  versionId: string | null
  ecoId: string
  fingerprint: string
  businessHash: string
  capturedAt: string
  nativeUpdatedAt: string
  sourceIds: Record<string, string>
  localIds: Record<string, string>
}

interface SqlState {
  code: string
  constraint?: string
  message: string
}

interface Fixture {
  schema: string
  pool: Pool
  admin: Pool
  db: Kysely<unknown>
}

function assertSchema(name: string): void {
  if (!/^plm_w23_[0-9a-f]{16}$/.test(name)) throw new Error(`refusing schema name ${name}`)
}

function requireSql(error: unknown): SqlState {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') {
      const constraint = (current as { constraint?: unknown }).constraint
      const message = current instanceof Error
        ? current.message
        : String((current as { message?: unknown }).message ?? '')
      return { code, constraint: typeof constraint === 'string' ? constraint : undefined, message }
    }
    current = (current as { cause?: unknown }).cause
  }
  if (error instanceof Error) throw error
  throw new Error(String(error))
}

function assertPg(error: unknown, expected: { code: string; constraint?: string; message?: string }): void {
  const actual = requireSql(error)
  if (actual.code === '40P01' || actual.code === '57014') {
    throw new Error(`deadlock or timeout ${actual.code} is not a successful serialization proof: ${actual.message}`)
  }
  if (actual.code !== expected.code) {
    throw new Error(`expected SQLSTATE ${expected.code} got ${actual.code}: ${actual.message}`)
  }
  if (expected.constraint !== undefined && actual.constraint !== expected.constraint) {
    throw new Error(`expected constraint ${expected.constraint} got ${actual.constraint ?? '(none)'}: ${actual.message}`)
  }
  if (expected.message !== undefined && !actual.message.includes(expected.message)) {
    throw new Error(`expected message ${expected.message} in ${actual.message}`)
  }
}

function dbFor(pool: Pool): Kysely<unknown> {
  return new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
}

async function withFixture<T>(
  run: (ctx: Fixture) => Promise<T>,
  options?: { includeBom?: boolean; migrate?: boolean },
): Promise<T> {
  const schema = `plm_w23_${randomBytes(8).toString('hex')}`
  assertSchema(schema)
  const admin = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: `${schema}_admin` })
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 4,
    application_name: schema,
    options: `-c search_path=${schema}`,
  })
  const db = dbFor(pool)
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    await bootstrapPlmCollaborationSnapshotTestDb(pool, { includeBom: options?.includeBom !== false })
    if (options?.migrate !== false) await up(db)
    return await run({ schema, pool, admin, db })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}

async function withRawSchema(
  admin: Pool,
  run: (pool: Pool, schema: string, db: Kysely<unknown>) => Promise<void>,
  options?: { includeBom?: boolean },
): Promise<void> {
  const schema = `plm_w23_${randomBytes(8).toString('hex')}`
  assertSchema(schema)
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 2,
    application_name: schema,
    options: `-c search_path=${schema}`,
  })
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    await bootstrapPlmCollaborationSnapshotTestDb(pool, { includeBom: options?.includeBom !== false })
    await run(pool, schema, dbFor(pool))
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  }
}

async function relationCount(admin: Pool, schema: string, like: string): Promise<number> {
  const found = await admin.query(
    `SELECT count(*)::int AS n
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND relation.relkind = 'r' AND relation.relname LIKE $2`,
    [schema, like],
  )
  return Number((found.rows[0] as { n: number }).n)
}

async function expectAbort(
  pool: Pool,
  run: (client: PoolClient) => Promise<void>,
  expected: { code: string; constraint?: string; message?: string },
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let failed: unknown
    try {
      await run(client)
    } catch (error) {
      failed = error
    }
    if (!failed) {
      await client.query('ROLLBACK')
      throw new Error(`expected ${expected.code} ${expected.constraint ?? ''} ${expected.message ?? ''}`)
    }
    assertPg(failed, expected)
    let follow: unknown
    try {
      await client.query('SELECT 1')
    } catch (error) {
      follow = error
    }
    if (!follow) {
      await client.query('ROLLBACK')
      throw new Error('guard error did not abort the caller transaction')
    }
    assertPg(follow, { code: '25P02' })
    await client.query('ROLLBACK')
  } finally {
    client.release()
  }
}

async function expectCommitFailure(
  pool: Pool,
  run: (client: PoolClient) => Promise<void>,
  expected: { code: string; constraint?: string; message?: string },
  absentSql: string,
  absentParams: unknown[] = [],
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await run(client)
    let failed: unknown
    try {
      await client.query('COMMIT')
    } catch (error) {
      failed = error
    }
    if (!failed) throw new Error(`COMMIT succeeded; expected ${expected.code}`)
    assertPg(failed, expected)
    const left = await client.query(absentSql, absentParams)
    if (Number((left.rows[0] as { n: number }).n) !== 0) {
      throw new Error('failed COMMIT left rows behind')
    }
  } finally {
    try { await client.query('ROLLBACK') } catch { /* the failed COMMIT already ended the transaction */ }
    client.release()
  }
}

async function waitForPidLock(admin: Pool, pid: number): Promise<void> {
  const started = Date.now()
  for (;;) {
    const found = await admin.query(
      'SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1',
      [pid],
    )
    const row = found.rows[0] as { wait_event_type: string | null; wait_event: string | null } | undefined
    if (row?.wait_event_type === 'Lock') return
    if (Date.now() - started > 8000) {
      throw new Error(`pid ${pid} lock wait was not observed (${row?.wait_event_type ?? 'missing'}/${row?.wait_event ?? ''})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function waitForQueryLock(admin: Pool, queryLike: string): Promise<number> {
  const started = Date.now()
  for (;;) {
    const found = await admin.query(
      `SELECT pid FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE $1 AND datname = current_database()`,
      [queryLike],
    )
    const pid = (found.rows[0] as { pid?: number } | undefined)?.pid
    if (typeof pid === 'number') return pid
    if (Date.now() - started > 8000) throw new Error(`lock wait was not observed for ${queryLike}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function backendPid(client: PoolClient): number {
  const pid = (client as PoolClient & { processID?: number }).processID
  if (typeof pid !== 'number') throw new Error('postgres backend pid is unavailable')
  return pid
}

function idsFor(prefix: string): { sourceIds: Record<string, string>; localIds: Record<string, string> } {
  const sourceIds: Record<string, string> = {}
  for (const key of ECO_COLLABORATION_ECO_FIELDS) sourceIds[key] = `${prefix}_s_${key}`
  const localIds: Record<string, string> = {}
  for (const field of ECO_COLLABORATION_LOCAL_FIELDS) localIds[field.key] = `${prefix}_l_${field.key}`
  return { sourceIds, localIds }
}

function rowKey(admission: Pick<Admission, 'dataSourceId' | 'tenantId' | 'orgId' | 'ecoId'>, ecoId = admission.ecoId): string[] {
  return [admission.dataSourceId, admission.tenantId, admission.orgId, ecoId]
}

function sourcePayload(
  admission: Admission,
  options?: { overrides?: Record<string, unknown>; omit?: string[] },
): Record<string, unknown> {
  const logical: Record<string, unknown> = {
    id: admission.ecoId,
    name: 'Pump housing',
    eco_type: 'design',
    product_id: admission.itemId,
    source_version_id: null,
    target_version_id: null,
    stage_id: null,
    state: null,
    kanban_state: null,
    priority: null,
    updated_at: admission.nativeUpdatedAt,
    ...options?.overrides,
  }
  const data: Record<string, unknown> = {}
  for (const key of ECO_COLLABORATION_ECO_FIELDS) {
    if (options?.omit?.includes(key)) continue
    data[admission.sourceIds[key]] = logical[key]
  }
  return data
}

function syncBody(
  admission: Admission,
  data: Record<string, unknown>,
  patch?: { hash?: string; capturedAt?: string; ecoId?: string; recordId?: string },
): Record<string, unknown> {
  const recordId = patch?.recordId ?? admission.recordId
  return {
    [recordId]: {
      row_key: rowKey(admission, patch?.ecoId ?? admission.ecoId),
      data,
      business_hash: patch?.hash ?? admission.businessHash,
      captured_at: patch?.capturedAt ?? admission.capturedAt,
    },
  }
}

async function insertFields(
  client: PoolClient,
  sheetId: string,
  sourceIds: Record<string, string>,
  localIds: Record<string, string>,
): Promise<void> {
  let order = 1
  for (const key of ECO_COLLABORATION_ECO_FIELDS) {
    await client.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, $3, 'string', $4::jsonb, $5)`,
      [sourceIds[key], sheetId, key, JSON.stringify({
        readOnly: true,
        plmCollaborationSnapshot: { source: true, key },
      }), order],
    )
    order += 1
  }
  for (const field of ECO_COLLABORATION_LOCAL_FIELDS) {
    await client.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
      [localIds[field.key], sheetId, field.key, field.type, order],
    )
    order += 1
  }
}

async function insertBinding(client: PoolClient, admission: Admission, sheet?: { sheetId?: string; viewId?: string; baseId?: string }): Promise<void> {
  await client.query(
    `INSERT INTO meta_plm_collaboration_bindings (
       id, creator_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
       current_version_id, source_fingerprint, base_id, sheet_id, view_id, name,
       source_fields, local_fields, version, status
     ) VALUES (
       $1, $2, $3, 'eco', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, 1, 'active'
     )`,
    [
      admission.bindingId,
      admission.actorId,
      admission.dataSourceId,
      admission.tenantId,
      admission.orgId,
      admission.itemId,
      admission.versionId,
      admission.fingerprint,
      sheet?.baseId ?? admission.baseId,
      sheet?.sheetId ?? admission.sheetId,
      sheet?.viewId ?? admission.viewId,
      'ECO collaboration',
      JSON.stringify(admission.sourceIds),
      JSON.stringify(admission.localIds),
    ],
  )
}

async function insertSync(
  client: PoolClient,
  admission: Admission,
  patches: Record<string, unknown>,
  syncId = admission.syncId,
  bindingVersion = 1,
): Promise<void> {
  await client.query(
    `INSERT INTO meta_plm_collaboration_syncs (id, binding_id, actor_id, binding_version, patches)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [syncId, admission.bindingId, admission.actorId, bindingVersion, JSON.stringify(patches)],
  )
}

async function setCollaborationGuc(client: PoolClient, syncId: string): Promise<void> {
  await client.query(`SELECT set_config('metasheet.plm_collaboration_sync', $1, true)`, [syncId])
}

async function insertMappedRecord(
  client: PoolClient,
  admission: Admission,
  data: Record<string, unknown>,
  options?: { omitRecord?: boolean },
): Promise<void> {
  await setCollaborationGuc(client, admission.syncId)
  await client.query(
    `INSERT INTO meta_plm_collaboration_rows (binding_id, row_key, record_id, business_hash, captured_at)
     VALUES ($1, $2::jsonb, $3, $4, $5::timestamptz)`,
    [admission.bindingId, JSON.stringify(rowKey(admission)), admission.recordId, admission.businessHash, admission.capturedAt],
  )
  if (options?.omitRecord) return
  await client.query(
    `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, locked, locked_by)
     VALUES ($1, $2, $3::jsonb, 1, $4, $4, false, null)`,
    [admission.recordId, admission.sheetId, JSON.stringify(data), admission.actorId],
  )
}

async function insertAdmission(client: PoolClient, options?: { omitRecord?: boolean; name?: string }): Promise<Admission> {
  const prefix = randomBytes(4).toString('hex')
  const { sourceIds, localIds } = idsFor(prefix)
  const admission: Admission = {
    actorId: `user_${prefix}`,
    localActorId: `local_${prefix}`,
    baseId: `base_${prefix}`,
    sheetId: `sheet_${prefix}`,
    viewId: `view_${prefix}`,
    bindingId: randomUUID(),
    syncId: randomUUID(),
    recordId: `rec_${prefix}`,
    dataSourceId: `ds_${prefix}`,
    tenantId: `tenant_${prefix}`,
    orgId: `org_${prefix}`,
    itemId: `item_${prefix}`,
    versionId: `ver_${prefix}`,
    ecoId: `eco_${prefix}`,
    fingerprint: HEX_A,
    businessHash: HEX_A,
    capturedAt: CAPTURED_AT,
    nativeUpdatedAt: NATIVE_AT,
    sourceIds,
    localIds,
  }
  await client.query('INSERT INTO users (id, is_active) VALUES ($1, true), ($2, true)', [admission.actorId, admission.localActorId])
  await client.query(
    'INSERT INTO meta_bases (id, owner_id, name, workspace_id) VALUES ($1, $2, $3, $4)',
    [admission.baseId, admission.actorId, 'ECO base', `ws_${prefix}`],
  )
  await client.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [admission.sheetId, admission.baseId, 'ECO sheet'])
  await insertFields(client, admission.sheetId, sourceIds, localIds)
  await client.query(
    'INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)',
    [admission.viewId, admission.sheetId, 'Grid', 'grid'],
  )
  await insertBinding(client, admission)
  const data = sourcePayload(admission, options?.name === undefined ? undefined : { overrides: { name: options.name } })
  await insertSync(client, admission, syncBody(admission, data))
  await insertMappedRecord(client, admission, data, { omitRecord: options?.omitRecord === true })
  return admission
}

async function admit(pool: Pool, options?: { name?: string }): Promise<Admission> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const admission = await insertAdmission(client, options)
    await client.query('COMMIT')
    return admission
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* already aborted */ }
    throw error
  } finally {
    client.release()
  }
}

async function insertPreview(
  client: PoolClient,
  admission: Admission,
  previewId: string,
  window: { createdAt: string; expiresAt: string },
): Promise<void> {
  await client.query(
    `INSERT INTO meta_plm_collaboration_previews (
       id, actor_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
       current_version_id, base_id, name, row_key, source_fingerprint, business_hash,
       captured_at, created_at, expires_at
     ) VALUES (
       $1, $2, $3, 'eco', $4, $5, $6, $7, $8, 'preview', $9::jsonb, $10, $11, $12::timestamptz, $13::timestamptz, $14::timestamptz
     )`,
    [
      previewId, admission.actorId, admission.dataSourceId, admission.tenantId, admission.orgId, admission.itemId,
      admission.versionId, admission.baseId, JSON.stringify(rowKey(admission)), admission.fingerprint,
      admission.businessHash, admission.capturedAt, window.createdAt, window.expiresAt,
    ],
  )
}

function serviceHelpers(memberId: string): RecordWriteHelpers {
  const unexpected = (name: string) => () => {
    throw new Error(`unexpected record-write helper ${name}`)
  }
  return {
    normalizeLinkIds: unexpected('normalizeLinkIds'),
    normalizeAttachmentIds: unexpected('normalizeAttachmentIds'),
    normalizeJson,
    parseLinkFieldConfig: () => null,
    buildId: unexpected('buildId'),
    ensureRecordWriteAllowed: () => true,
    filterRecordDataByFieldIds: (data, allowed) => {
      const source = normalizeJson(data)
      const filtered: Record<string, unknown> = {}
      for (const key of allowed) if (key in source) filtered[key] = source[key]
      return filtered
    },
    extractLookupRollupData: () => ({}),
    mergeComputedRecords: (base) => base,
    filterRecordFieldSummaryMap: unexpected('filterRecordFieldSummaryMap'),
    serializeLinkSummaryMap: unexpected('serializeLinkSummaryMap'),
    serializeAttachmentSummaryMap: unexpected('serializeAttachmentSummaryMap'),
    applyLookupRollup: unexpected('applyLookupRollup'),
    computeDependentLookupRollupRecords: async () => [],
    recalculateFormulaFields: async () => [],
    loadLinkValuesByRecord: unexpected('loadLinkValuesByRecord'),
    buildLinkSummaries: unexpected('buildLinkSummaries'),
    buildAttachmentSummaries: unexpected('buildAttachmentSummaries'),
    ensureAttachmentIdsExist: unexpected('ensureAttachmentIdsExist'),
    loadSheetMemberUserIds: async () => new Set([memberId]),
  }
}

function asServicePool(pool: Pool): ConnectionPool {
  return {
    query: (text, params) => pool.query(text, params),
    transaction: async (handler) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await handler({ query: (text, params) => client.query(text, params) })
        await client.query('COMMIT')
        return result
      } catch (error) {
        try { await client.query('ROLLBACK') } catch { /* aborted */ }
        throw error
      } finally {
        client.release()
      }
    },
  }
}

async function withWriterFence(run: () => Promise<void>): Promise<void> {
  const previous = process.env.MULTITABLE_ENABLE_WRITER_FENCE
  process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
  __resetOperationLedgerColumnProbe()
  __resetRecoveryWriterStateColumnProbe()
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    else process.env.MULTITABLE_ENABLE_WRITER_FENCE = previous
    __resetOperationLedgerColumnProbe()
    __resetRecoveryWriterStateColumnProbe()
  }
}

async function writeLocalNote(
  pool: Pool,
  admitted: Admission,
  version: number,
  op: 'set' | 'unset',
): Promise<void> {
  const fields = ECO_COLLABORATION_LOCAL_FIELDS.map((field) => ({
    id: admitted.localIds[field.key],
    name: field.key,
    type: field.type,
    property: {},
  }))
  const service = new RecordWriteService(asServicePool(pool), new EventBus(), serviceHelpers(admitted.localActorId))
  const written = await service.patchRecords({
    sheetId: admitted.sheetId,
    changesByRecord: new Map([[admitted.recordId, [{
      fieldId: admitted.localIds.review_note,
      value: 'canonical local note',
      expectedVersion: version,
      op,
    }]]]),
    actorId: admitted.localActorId,
    fields,
    visiblePropertyFields: fields,
    visiblePropertyFieldIds: new Set(fields.map((field) => field.id)),
    attachmentFields: [],
    fieldById: new Map(fields.map((field) => [field.id, { type: field.type, readOnly: false, hidden: false, property: {} }])),
    capabilities: {
      canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
      canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: true, canExport: true,
    },
    access: { userId: admitted.localActorId, permissions: [], isAdminRole: true },
    source: 'rest',
  })
  if (written.updated.length !== 1 || written.updated[0]?.version !== version + 1) {
    throw new Error('canonical local write did not bump exactly once')
  }
}

async function functionHashes(admin: Pool, schema: string): Promise<string> {
  const found = await admin.query(
    `SELECT proc.proname, pg_catalog.pg_get_functiondef(proc.oid) AS definition
       FROM pg_catalog.pg_proc proc
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
      WHERE namespace.nspname = $1 AND proc.proname LIKE 'meta_plm_collaboration_%'
      ORDER BY proc.proname, pg_catalog.pg_get_function_identity_arguments(proc.oid)`,
    [schema],
  )
  const names = (found.rows as Array<{ proname: string }>).map((row) => row.proname)
  if (names.join(',') !== [...FUNCTIONS].sort().join(',')) {
    throw new Error(`function set ${names.join(',')} differs from the required family`)
  }
  return (found.rows as Array<{ definition: string }>)
    .map((row) => createHash('sha256').update(row.definition).digest('hex'))
    .join(',')
}

async function assertCatalog(admin: Pool, schema: string): Promise<string> {
  const hashes = await functionHashes(admin, schema)
  const security = await admin.query(
    `SELECT proc.prosecdef, proc.proconfig
       FROM pg_catalog.pg_proc proc
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
      WHERE namespace.nspname = $1 AND proc.proname LIKE 'meta_plm_collaboration_%'`,
    [schema],
  )
  for (const row of security.rows as Array<{ prosecdef: boolean; proconfig: string[] | null }>) {
    if (row.prosecdef) throw new Error('collaboration function is SECURITY DEFINER')
    if (!row.proconfig || row.proconfig.join(',') !== 'search_path=pg_catalog') {
      throw new Error(`function search_path is ${row.proconfig?.join(',') ?? 'unset'}`)
    }
  }
  const triggers = await admin.query(
    `SELECT trigger.tgname, trigger.tgenabled
       FROM pg_catalog.pg_trigger trigger
       JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND NOT trigger.tgisinternal
        AND trigger.tgname LIKE 'meta_plm_collaboration_%'
      ORDER BY trigger.tgname`,
    [schema],
  )
  const triggerNames = (triggers.rows as Array<{ tgname: string; tgenabled: string }>).map((row) => {
    if (row.tgenabled !== 'O') throw new Error(`${row.tgname} tgenabled=${row.tgenabled}`)
    return row.tgname
  })
  if (triggerNames.join(',') !== [...TRIGGERS].sort().join(',')) {
    throw new Error(`trigger set ${triggerNames.join(',')}`)
  }
  const checks = await admin.query(
    `SELECT constraint_name.conname
       FROM pg_catalog.pg_constraint constraint_name
       JOIN pg_catalog.pg_class relation ON relation.oid = constraint_name.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND constraint_name.contype = 'c'
        AND relation.relname LIKE 'meta_plm_collaboration_%'`,
    [schema],
  )
  const checkNames = (checks.rows as Array<{ conname: string }>).map((row) => row.conname).sort()
  if (checkNames.join(',') !== [...CHECKS].sort().join(',')) {
    throw new Error(`check set ${checkNames.join(',')}`)
  }
  const foreignKeys = await admin.query(
    `SELECT constraint_name.conname, constraint_name.condeferrable, constraint_name.condeferred, constraint_name.confdeltype
       FROM pg_catalog.pg_constraint constraint_name
       JOIN pg_catalog.pg_class relation ON relation.oid = constraint_name.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND constraint_name.contype = 'f'
        AND relation.relname LIKE 'meta_plm_collaboration_%'`,
    [schema],
  )
  const expectedFk: Record<string, { deferred: boolean; del: string }> = {
    meta_plm_collaboration_bindings_base_id_fkey: { deferred: false, del: 'r' },
    meta_plm_collaboration_bindings_sheet_id_fkey: { deferred: false, del: 'r' },
    meta_plm_collaboration_bindings_view_id_fkey: { deferred: false, del: 'r' },
    meta_plm_collaboration_previews_binding_id_fkey: { deferred: true, del: 'a' },
    meta_plm_collaboration_rows_binding_id_fkey: { deferred: false, del: 'r' },
    meta_plm_collaboration_rows_record_id_fkey: { deferred: true, del: 'a' },
    meta_plm_collaboration_syncs_binding_id_fkey: { deferred: false, del: 'r' },
  }
  const seen = new Set<string>()
  for (const row of foreignKeys.rows as Array<{ conname: string; condeferrable: boolean; condeferred: boolean; confdeltype: string }>) {
    const expected = expectedFk[row.conname]
    if (!expected) throw new Error(`unexpected foreign key ${row.conname}`)
    if (row.condeferrable !== expected.deferred || row.condeferred !== expected.deferred || row.confdeltype !== expected.del) {
      throw new Error(`${row.conname} deferrable=${row.condeferrable} deferred=${row.condeferred} ondelete=${row.confdeltype}`)
    }
    seen.add(row.conname)
  }
  for (const name of Object.keys(expectedFk)) if (!seen.has(name)) throw new Error(`missing foreign key ${name}`)
  const uniqueNames = await admin.query(
    `SELECT constraint_name.conname
       FROM pg_catalog.pg_constraint constraint_name
       JOIN pg_catalog.pg_class relation ON relation.oid = constraint_name.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND constraint_name.contype IN ('u', 'p')
        AND relation.relname LIKE 'meta_plm_collaboration_%'`,
    [schema],
  )
  const uniques = new Set((uniqueNames.rows as Array<{ conname: string }>).map((row) => row.conname))
  for (const name of [
    'meta_plm_collaboration_bindings_pkey',
    'meta_plm_collaboration_bindings_sheet_id_key',
    'meta_plm_collaboration_bindings_collection_key',
    'meta_plm_collaboration_previews_pkey',
    'meta_plm_collaboration_previews_request_id_key',
    'meta_plm_collaboration_rows_pkey',
    'meta_plm_collaboration_rows_record_id_key',
    'meta_plm_collaboration_syncs_pkey',
  ]) {
    if (!uniques.has(name)) throw new Error(`missing unique or primary key ${name}`)
  }
  const columns = await admin.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name LIKE 'meta_plm_collaboration_%'`,
    [schema],
  )
  const byTable = new Map<string, Map<string, { data_type: string; is_nullable: string; column_default: string | null }>>()
  for (const row of columns.rows as Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>) {
    const table = byTable.get(row.table_name) ?? new Map()
    table.set(row.column_name, row)
    byTable.set(row.table_name, table)
  }
  const counts: Record<string, number> = {
    meta_plm_collaboration_bindings: 21,
    meta_plm_collaboration_previews: 19,
    meta_plm_collaboration_rows: 6,
    meta_plm_collaboration_syncs: 7,
  }
  for (const [table, count] of Object.entries(counts)) {
    if (byTable.get(table)?.size !== count) throw new Error(`${table} column count ${byTable.get(table)?.size ?? 0}`)
  }
  const nullable = (table: string, column: string) => byTable.get(table)?.get(column)
  const expectColumn = (table: string, column: string, type: string, isNullable: string) => {
    const columnInfo = nullable(table, column)
    if (!columnInfo || columnInfo.data_type !== type || columnInfo.is_nullable !== isNullable) {
      throw new Error(`${table}.${column} is ${columnInfo?.data_type}/${columnInfo?.is_nullable}`)
    }
  }
  expectColumn('meta_plm_collaboration_bindings', 'current_version_id', 'text', 'YES')
  expectColumn('meta_plm_collaboration_bindings', 'item_id', 'text', 'NO')
  expectColumn('meta_plm_collaboration_bindings', 'source_fields', 'jsonb', 'NO')
  expectColumn('meta_plm_collaboration_bindings', 'version', 'bigint', 'NO')
  expectColumn('meta_plm_collaboration_previews', 'request_id', 'uuid', 'YES')
  expectColumn('meta_plm_collaboration_rows', 'row_key', 'jsonb', 'NO')
  expectColumn('meta_plm_collaboration_syncs', 'patches', 'jsonb', 'NO')
  expectColumn('meta_plm_collaboration_syncs', 'accepted_txid', 'text', 'NO')
  const txDefault = nullable('meta_plm_collaboration_syncs', 'accepted_txid')?.column_default ?? ''
  if (!txDefault.includes('pg_current_xact_id')) throw new Error(`accepted_txid default is ${txDefault}`)
  const index = await admin.query(
    `SELECT 1 FROM pg_catalog.pg_indexes
      WHERE schemaname = $1 AND indexname = 'meta_plm_collaboration_syncs_binding_created_idx'`,
    [schema],
  )
  if (index.rowCount !== 1) throw new Error('sync binding/created index is absent')
  if (await relationCount(admin, schema, 'meta_plm_collaboration_%') !== 4) {
    throw new Error('collaboration relation count is not 4')
  }
  return hashes
}

async function assertBomRemains(pool: Pool): Promise<void> {
  const found = await pool.query(
    `SELECT to_regclass('meta_plm_bom_review_bindings') AS binding, to_regclass('meta_records') AS records`,
  )
  const row = found.rows[0] as { binding: string | null; records: string | null }
  if (!row.binding || !row.records) throw new Error('empty collaboration down removed BOM or record storage')
}

async function assertUnboundAndBom(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const prefix = randomBytes(4).toString('hex')
    const actor = `user_${prefix}`
    const base = `base_${prefix}`
    const plainSheet = `plain_${prefix}`
    const bomSheet = `bom_${prefix}`
    const bomField = `bom_field_${prefix}`
    const recordId = `rec_${prefix}`
    const bomRecord = `bomrec_${prefix}`
    const bomBinding = randomUUID()
    const bomSync = randomUUID()
    await client.query('INSERT INTO users (id, is_active) VALUES ($1, true)', [actor])
    await client.query(
      'INSERT INTO meta_bases (id, owner_id, name, workspace_id) VALUES ($1, $2, $3, $4)',
      [base, actor, 'plain', `ws_${prefix}`],
    )
    await client.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3), ($4, $2, $5)', [
      plainSheet, base, 'plain', bomSheet, 'bom',
    ])
    await client.query(
      'INSERT INTO meta_records (id, sheet_id, data, created_by, modified_by) VALUES ($1, $2, $3::jsonb, $4, $4)',
      [recordId, plainSheet, JSON.stringify({ note: 'open' }), actor],
    )
    await client.query(
      `UPDATE meta_records SET data = data || '{"note":"edited"}'::jsonb, version = version + 1, modified_by = $2 WHERE id = $1`,
      [recordId, actor],
    )
    await client.query('DELETE FROM meta_records WHERE id = $1', [recordId])
    await client.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property) VALUES ($1, $2, 'line', 'string', '{}'::jsonb)`,
      [bomField, bomSheet],
    )
    await client.query(
      `INSERT INTO meta_plm_bom_review_bindings (
         id, data_source_id, part_id, creator_id, source_fingerprint, source, base_id, sheet_id, view_id,
         name, fields, version, status, snapshot_hash, last_synced_at, line_count, occurrence_count
       ) VALUES (
         $1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, $8, 'BOM', $9::jsonb, 1, 'active', $5, now(), 1, 1
       )`,
      [bomBinding, `ds_${prefix}`, `part_${prefix}`, actor, HEX_B, base, bomSheet, `view_${prefix}`, JSON.stringify({ line: bomField })],
    )
    await client.query(
      `INSERT INTO meta_plm_bom_review_syncs (id, binding_id, patches, actor_id) VALUES ($1, $2, $3::jsonb, $4)`,
      [bomSync, bomBinding, JSON.stringify({ [bomRecord]: { [bomField]: 'L1' } }), actor],
    )
    await client.query(
      'INSERT INTO meta_plm_bom_review_rows (binding_id, bom_line_id, record_id) VALUES ($1, $2, $3)',
      [bomBinding, 'line-1', bomRecord],
    )
    await client.query(`SELECT set_config('metasheet.bom_review_sync', $1, true)`, [bomSync])
    await client.query(
      `INSERT INTO meta_records (id, sheet_id, data, created_by, modified_by) VALUES ($1, $2, $3::jsonb, $4, $4)`,
      [bomRecord, bomSheet, JSON.stringify({ [bomField]: 'L1' }), actor],
    )
    await client.query(
      `UPDATE meta_records SET data = data || '{"note":"bom-local"}'::jsonb, version = version + 1, modified_by = $2 WHERE id = $1`,
      [bomRecord, actor],
    )
    await client.query('COMMIT')
    await expectAbort(pool, async (guard) => {
      await guard.query(`SELECT set_config('metasheet.plm_collaboration_sync', $1, true)`, [randomUUID()])
      await guard.query(
        `UPDATE meta_records SET data = jsonb_set(data, $2, '"changed"'::jsonb), version = version + 1 WHERE id = $1`,
        [bomRecord, `{${bomField}}`],
      )
    }, { code: '23514', message: 'bom_review_source_protected' })
  } finally {
    client.release()
  }
}

const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return { zzzz20261024010000_create_plm_collaboration_snapshots: { up, down } }
  },
}

describe('plm collaboration snapshot db guards', () => {
  test('catalog_shape_and_empty_reverse', async () => {
    await withFixture(async ({ schema, pool, admin, db }) => {
      const migrator = new Migrator({ db, provider: migrationProvider })
      const migrated = await migrator.migrateToLatest()
      if (migrated.error) throw migrated.error
      const firstHashes = await assertCatalog(admin, schema)
      const migratedDown = await migrator.migrateDown()
      if (migratedDown.error) throw migratedDown.error
      if (await relationCount(admin, schema, 'meta_plm_collaboration_%') !== 0) {
        throw new Error('migrator down left a collaboration relation')
      }
      await assertBomRemains(pool)
      await up(db)
      if (await functionHashes(admin, schema) !== firstHashes) throw new Error('direct up function definitions drifted')
      await down(db)
      await assertBomRemains(pool)
      await up(db)
      if (await functionHashes(admin, schema) !== firstHashes) throw new Error('second up function definitions drifted')
      await admit(pool)
      let refused: unknown
      try {
        await down(db)
      } catch (error) {
        refused = error
      }
      assertPg(refused, {
        code: '23514',
        constraint: 'meta_plm_collaboration_evidence_guard',
        message: 'plm_collaboration_source_evidence_present',
      })
      if (await relationCount(admin, schema, 'meta_plm_collaboration_%') !== 4) {
        throw new Error('evidence refusal dropped a relation')
      }
      await withRawSchema(admin, async (sidePool, sideSchema, sideDb) => {
        await sidePool.query('DROP TABLE meta_views')
        let failed: unknown
        try { await up(sideDb) } catch (error) { failed = error }
        assertPg(failed, {
          code: '23514',
          constraint: 'meta_plm_collaboration_predecessor_guard',
          message: 'plm_collaboration_predecessors_absent',
        })
        if (await relationCount(admin, sideSchema, 'meta_plm_collaboration_%') !== 0) {
          throw new Error('predecessor failure left a collaboration relation')
        }
      })
      await withRawSchema(admin, async (sidePool, sideSchema, sideDb) => {
        await sidePool.query('CREATE TABLE meta_plm_collaboration_previews (id int)')
        let failed: unknown
        try { await up(sideDb) } catch (error) { failed = error }
        assertPg(failed, {
          code: '23514',
          constraint: 'meta_plm_collaboration_predecessor_guard',
          message: 'plm_collaboration_relation_present',
        })
        const type = await sidePool.query(
          `SELECT data_type FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'meta_plm_collaboration_previews' AND column_name = 'id'`,
        )
        if ((type.rows[0] as { data_type: string }).data_type !== 'integer') {
          throw new Error('preflight adopted or altered the malformed preview table')
        }
        if (await relationCount(admin, sideSchema, 'meta_plm_collaboration_%') !== 1) {
          throw new Error('malformed preview preflight created another relation')
        }
      })
      await withRawSchema(admin, async (_pool, fullSchema, fullDb) => {
        await up(fullDb)
        await withRawSchema(admin, async (partialPool, partialSchema, partialDb) => {
          await partialPool.query('ALTER TABLE meta_bases DROP COLUMN workspace_id')
          let failed: unknown
          try { await up(partialDb) } catch (error) { failed = error }
          assertPg(failed, {
            code: '23514',
            constraint: 'meta_plm_collaboration_predecessor_guard',
            message: 'plm_collaboration_predecessors_absent',
          })
          if (await relationCount(admin, fullSchema, 'meta_plm_collaboration_%') !== 4) {
            throw new Error('foreign schema satisfied or lost the serving catalog')
          }
          if (await relationCount(admin, partialSchema, 'meta_plm_collaboration_%') !== 0) {
            throw new Error('partial schema gained a collaboration relation')
          }
        })
      })
      await withRawSchema(admin, async (_pool, _schema, sideDb) => {
        let failed: unknown
        try { await down(sideDb) } catch (error) { failed = error }
        assertPg(failed, {
          code: '23514',
          constraint: 'meta_plm_collaboration_predecessor_guard',
          message: 'plm_collaboration_relations_absent',
        })
        await assertBomRemains(_pool)
      })
    }, { migrate: false })
  })

  test('initial_mapping_before_record', async () => {
    await withFixture(async ({ pool }) => {
      const admitted = await admit(pool)
      const stored = await pool.query(
        `SELECT record.sheet_id, record.created_by, record.modified_by, record.version, row.record_id
           FROM meta_plm_collaboration_rows row
           JOIN meta_records record ON record.id = row.record_id
          WHERE row.binding_id = $1`,
        [admitted.bindingId],
      )
      const row = stored.rows[0] as { sheet_id: string; created_by: string; modified_by: string; version: number; record_id: string }
      if (row.sheet_id !== admitted.sheetId || row.created_by !== admitted.actorId || row.modified_by !== admitted.actorId || Number(row.version) !== 1) {
        throw new Error('initial source record identity did not match the sync actor')
      }
      await expectCommitFailure(pool, async (client) => {
        await insertAdmission(client, { omitRecord: true })
      }, {
        code: '23503',
        constraint: 'meta_plm_collaboration_rows_record_id_fkey',
      }, `SELECT count(*)::int AS n FROM meta_plm_collaboration_rows WHERE record_id <> $1`, [admitted.recordId])
      await expectCommitFailure(pool, async (client) => {
        const mapped = await insertAdmission(client, { omitRecord: true })
        const otherSheet = `${mapped.sheetId}_other`
        await client.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [otherSheet, mapped.baseId, 'other'])
        await client.query(
          `INSERT INTO meta_records (id, sheet_id, data, created_by, modified_by) VALUES ($1, $2, '{}'::jsonb, $3, $3)`,
          [mapped.recordId, otherSheet, mapped.actorId],
        )
      }, {
        code: '23514',
        constraint: 'meta_plm_collaboration_commit_guard',
        message: FAMILY,
      }, `SELECT count(*)::int AS n FROM meta_plm_collaboration_bindings WHERE id <> $1`, [admitted.bindingId])
    })
  })

  test('typed_keys_and_collection_identity', async () => {
    await withFixture(async ({ pool, admin }) => {
      const admitted = await admit(pool, { name: '' })
      const clientA = await pool.connect()
      const clientB = await pool.connect()
      try {
        await clientA.query('BEGIN')
        const slashEco = `${admitted.ecoId}a/b`
        const slashRecordId = `${admitted.recordId}_slash`
        const secondId = `${admitted.recordId}_b`
        const secondEco = `${admitted.ecoId}ab`
        const first = sourcePayload(admitted, { overrides: { id: slashEco, name: '' } })
        const second = sourcePayload({ ...admitted, ecoId: secondEco, recordId: secondId }, { overrides: { name: 'second' } })
        const syncId = randomUUID()
        await insertSync(clientA, admitted, {
          ...syncBody(admitted, first, { ecoId: slashEco, recordId: slashRecordId, hash: HEX_B }),
          ...syncBody(admitted, second, { ecoId: secondEco, recordId: secondId, hash: HEX_B }),
        }, syncId)
        await setCollaborationGuc(clientA, syncId)
        await clientA.query(
          `INSERT INTO meta_plm_collaboration_rows (binding_id, row_key, record_id, business_hash, captured_at)
           VALUES ($1, $2::jsonb, $3, $4, $5::timestamptz), ($1, $6::jsonb, $7, $4, $5::timestamptz)`,
          [
            admitted.bindingId,
            JSON.stringify(rowKey(admitted, slashEco)),
            slashRecordId,
            HEX_B,
            CAPTURED_AT,
            JSON.stringify(rowKey(admitted, secondEco)),
            secondId,
          ],
        )
        await clientA.query(
          `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, locked, locked_by)
           VALUES ($1, $2, $3::jsonb, 1, $4, $4, false, null),
                  ($5, $2, $6::jsonb, 1, $4, $4, false, null)`,
          [slashRecordId, admitted.sheetId, JSON.stringify(first), admitted.actorId, secondId, JSON.stringify(second)],
        )
        await clientA.query('COMMIT')
        const keys = await pool.query(
          'SELECT count(DISTINCT row_key)::int AS n FROM meta_plm_collaboration_rows WHERE binding_id = $1',
          [admitted.bindingId],
        )
        if (Number((keys.rows[0] as { n: number }).n) !== 3) {
          throw new Error('delimiter-distinct ECO rows did not commit beside the original row')
        }
        await clientA.query('BEGIN')
        await clientB.query('BEGIN')
        const leftSheet = `${admitted.sheetId}_left`
        const rightSheet = `${admitted.sheetId}_right`
        const leftView = `${admitted.viewId}_left`
        const rightView = `${admitted.viewId}_right`
        const leftIds = idsFor('race_left')
        const rightIds = idsFor('race_right')
        await clientA.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [leftSheet, admitted.baseId, 'left'])
        await clientB.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [rightSheet, admitted.baseId, 'right'])
        await insertFields(clientA, leftSheet, leftIds.sourceIds, leftIds.localIds)
        await insertFields(clientB, rightSheet, rightIds.sourceIds, rightIds.localIds)
        await clientA.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [leftView, leftSheet, 'left', 'grid'])
        await clientB.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [rightView, rightSheet, 'right', 'grid'])
        const raceCollection = {
          dataSourceId: `${admitted.dataSourceId}_race`,
          tenantId: `${admitted.tenantId}_race`,
          orgId: `${admitted.orgId}_race`,
          itemId: `${admitted.itemId}_race`,
        }
        await insertBinding(
          clientA,
          { ...admitted, ...raceCollection, sourceIds: leftIds.sourceIds, localIds: leftIds.localIds, bindingId: randomUUID(), sheetId: leftSheet, viewId: leftView },
          { sheetId: leftSheet, viewId: leftView },
        )
        const pending = insertBinding(
          clientB,
          { ...admitted, ...raceCollection, sourceIds: rightIds.sourceIds, localIds: rightIds.localIds, bindingId: randomUUID(), sheetId: rightSheet, viewId: rightView },
          { sheetId: rightSheet, viewId: rightView },
        )
        const raced = await Promise.race([
          waitForPidLock(admin, backendPid(clientB)).then(() => 'lock' as const),
          pending.then(() => 'done' as const, () => 'done' as const),
        ])
        if (raced !== 'lock') throw new Error('second collection insert did not wait on the unique lock')
        await clientA.query('COMMIT')
        let uniqueFailure: unknown
        try {
          await pending
        } catch (error) {
          uniqueFailure = error
        }
        assertPg(uniqueFailure, { code: '23505', constraint: 'meta_plm_collaboration_bindings_collection_key' })
        await clientB.query('ROLLBACK')
        const sheets = await pool.query('SELECT id FROM meta_sheets WHERE id IN ($1, $2)', [leftSheet, rightSheet])
        if (sheets.rowCount !== 1 || (sheets.rows[0] as { id: string }).id !== leftSheet) {
          throw new Error('collection conflict left an orphan sheet')
        }
        const revisions = await pool.query('SELECT count(*)::int AS n FROM meta_record_revisions WHERE sheet_id IN ($1, $2)', [leftSheet, rightSheet])
        if (Number((revisions.rows[0] as { n: number }).n) !== 0) throw new Error('collection conflict left history')
      } finally {
        try { await clientA.query('ROLLBACK') } catch { /* closed */ }
        try { await clientB.query('ROLLBACK') } catch { /* closed */ }
        clientA.release()
        clientB.release()
      }
      const valid = await pool.connect()
      try {
        await valid.query('BEGIN')
        await valid.query(
          `INSERT INTO meta_plm_collaboration_previews (
             id, actor_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id, base_id,
             name, row_key, source_fingerprint, business_hash, captured_at, created_at, expires_at
           ) VALUES
           ($1, $2, 'ab', 'eco', 'c', 'd', 'item-ab', $3, 'one', '["ab","c","d","e"]'::jsonb, $4, $4, now(), now(), now() + interval '1 day'),
           ($5, $2, 'a', 'eco', 'bc', 'd', 'item-a', $3, 'two', '["a","bc","d","e"]'::jsonb, $4, $4, now(), now(), now() + interval '1 day')`,
          [randomUUID(), admitted.actorId, admitted.baseId, HEX_A, randomUUID()],
        )
        await valid.query('COMMIT')
      } finally {
        valid.release()
      }
      const distinct = await pool.query(
        `SELECT count(*)::int AS n FROM meta_plm_collaboration_previews WHERE data_source_id IN ('ab', 'a')`,
      )
      if (Number((distinct.rows[0] as { n: number }).n) !== 2) {
        throw new Error('delimiter collision tuples were not stored as two rows')
      }
      const nullVersionSheet = `${admitted.sheetId}_null`
      const nullVersionView = `${admitted.viewId}_null`
      const nullIds = idsFor('null_version')
      const nullClient = await pool.connect()
      try {
        await nullClient.query('BEGIN')
        await nullClient.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [nullVersionSheet, admitted.baseId, 'null'])
        await insertFields(nullClient, nullVersionSheet, nullIds.sourceIds, nullIds.localIds)
        await nullClient.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [nullVersionView, nullVersionSheet, 'null', 'grid'])
        await nullClient.query(
          `INSERT INTO meta_plm_collaboration_bindings (
             id, creator_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
             current_version_id, source_fingerprint, base_id, sheet_id, view_id, name, source_fields, local_fields, status
           ) VALUES ($1, $2, $3, 'eco', $4, $5, $6, NULL, $7, $8, $9, $10, 'null version', $11::jsonb, $12::jsonb, 'active')`,
          [
            randomUUID(), admitted.actorId, `${admitted.dataSourceId}_null`, admitted.tenantId, admitted.orgId,
            `${admitted.itemId}_null`, HEX_A, admitted.baseId, nullVersionSheet, nullVersionView,
            JSON.stringify(nullIds.sourceIds), JSON.stringify(nullIds.localIds),
          ],
        )
        await nullClient.query('COMMIT')
      } finally {
        nullClient.release()
      }
      await expectAbort(pool, async (client) => {
        const again = idsFor('again')
        const sheetId = `${admitted.sheetId}_again`
        const viewId = `${admitted.viewId}_again`
        await client.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [sheetId, admitted.baseId, 'again'])
        await insertFields(client, sheetId, again.sourceIds, again.localIds)
        await client.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [viewId, sheetId, 'again', 'grid'])
        await client.query(
          `INSERT INTO meta_plm_collaboration_bindings (
             id, creator_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
             current_version_id, source_fingerprint, base_id, sheet_id, view_id, name, source_fields, local_fields, status
           ) VALUES ($1, $2, $3, 'eco', $4, $5, $6, 'other-version', $7, $8, $9, $10, 'again', $11::jsonb, $12::jsonb, 'active')`,
          [
            randomUUID(), admitted.actorId, admitted.dataSourceId, admitted.tenantId, admitted.orgId, admitted.itemId,
            HEX_A, admitted.baseId, sheetId, viewId, JSON.stringify(again.sourceIds), JSON.stringify(again.localIds),
          ],
        )
      }, { code: '23505', constraint: 'meta_plm_collaboration_bindings_collection_key' })
      await expectAbort(pool, async (client) => {
        const ids = idsFor('crlf_tenant')
        const sheetId = `${admitted.sheetId}_crlf_tenant`
        const viewId = `${admitted.viewId}_crlf_tenant`
        await client.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [sheetId, admitted.baseId, 'crlf tenant'])
        await insertFields(client, sheetId, ids.sourceIds, ids.localIds)
        await client.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [viewId, sheetId, 'crlf tenant', 'grid'])
        await client.query(
          `INSERT INTO meta_plm_collaboration_bindings (
             id, creator_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
             current_version_id, source_fingerprint, base_id, sheet_id, view_id, name, source_fields, local_fields, status
           ) VALUES ($1, $2, $3, 'eco', $4, $5, $6, $7, $8, $9, $10, $11, 'crlf tenant', $12::jsonb, $13::jsonb, 'active')`,
          [
            randomUUID(), admitted.actorId, `${admitted.dataSourceId}_crlf_tenant`, 'acme\n', admitted.orgId,
            `${admitted.itemId}_crlf_tenant`, admitted.versionId, HEX_A, admitted.baseId, sheetId, viewId,
            JSON.stringify(ids.sourceIds), JSON.stringify(ids.localIds),
          ],
        )
      }, { code: '23514', constraint: 'meta_plm_collaboration_bindings_tenant_check' })
      await expectAbort(pool, async (client) => {
        const ids = idsFor('crlf_org')
        const sheetId = `${admitted.sheetId}_crlf_org`
        const viewId = `${admitted.viewId}_crlf_org`
        await client.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [sheetId, admitted.baseId, 'crlf org'])
        await insertFields(client, sheetId, ids.sourceIds, ids.localIds)
        await client.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [viewId, sheetId, 'crlf org', 'grid'])
        await client.query(
          `INSERT INTO meta_plm_collaboration_bindings (
             id, creator_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
             current_version_id, source_fingerprint, base_id, sheet_id, view_id, name, source_fields, local_fields, status
           ) VALUES ($1, $2, $3, 'eco', $4, $5, $6, $7, $8, $9, $10, $11, 'crlf org', $12::jsonb, $13::jsonb, 'active')`,
          [
            randomUUID(), admitted.actorId, `${admitted.dataSourceId}_crlf_org`, admitted.tenantId, 'acme\r',
            `${admitted.itemId}_crlf_org`, admitted.versionId, HEX_A, admitted.baseId, sheetId, viewId,
            JSON.stringify(ids.sourceIds), JSON.stringify(ids.localIds),
          ],
        )
      }, { code: '23514', constraint: 'meta_plm_collaboration_bindings_org_check' })
      await expectAbort(pool, async (client) => {
        await insertSync(client, admitted, syncBody(admitted, sourcePayload(admitted, { overrides: { updated_at: '0000-01-01T00:00:00.000000Z' } })), randomUUID())
      }, { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
      await expectAbort(pool, async (client) => {
        await insertSync(client, admitted, syncBody(admitted, sourcePayload(admitted, { overrides: { updated_at: '2026-02-29T00:00:00.000000Z' } })), randomUUID())
      }, { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
      await expectAbort(pool, async (client) => {
        await insertSync(client, admitted, syncBody(admitted, sourcePayload(admitted, { omit: ['state'] })), randomUUID())
      }, { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
      await expectAbort(pool, async (client) => {
        await insertSync(client, admitted, syncBody(admitted, sourcePayload(admitted, { overrides: { name: null } })), randomUUID())
      }, { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
      await expectAbort(pool, async (client) => {
        await insertSync(client, admitted, syncBody(admitted, sourcePayload(admitted, { overrides: { product_id: 'other-item' } })), randomUUID())
      }, { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
      await expectAbort(pool, async (client) => {
        const body = syncBody(admitted, sourcePayload(admitted))
        ;(body[admitted.recordId] as { row_key: unknown[] }).row_key = [admitted.dataSourceId, admitted.tenantId, admitted.orgId]
        await insertSync(client, admitted, body, randomUUID())
      }, { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
      await expectAbort(pool, async (client) => {
        const body = syncBody(admitted, sourcePayload(admitted))
        ;(body[admitted.recordId] as { row_key: unknown[] }).row_key = [1, admitted.tenantId, admitted.orgId, admitted.ecoId]
        await insertSync(client, admitted, body, randomUUID())
      }, { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
      await expectAbort(pool, async (client) => {
        await client.query(
          `INSERT INTO meta_plm_collaboration_bindings (
             id, creator_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
             source_fingerprint, base_id, sheet_id, view_id, name, source_fields, local_fields, status
           ) VALUES ($1, $2, $3, 'readiness', $4, $5, $6, $7, $8, $9, $10, 'readiness', $11::jsonb, $12::jsonb, 'active')`,
          [
            randomUUID(), admitted.actorId, `${admitted.dataSourceId}_ready`, admitted.tenantId, admitted.orgId,
            `${admitted.itemId}_ready`, HEX_A, admitted.baseId, `${admitted.sheetId}_ready`, admitted.viewId,
            JSON.stringify(admitted.sourceIds), JSON.stringify(admitted.localIds),
          ],
        )
      }, { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: 'plm_collaboration_readiness_unadmitted' })
    })
  })

  test('source_guard_and_positive_local', async () => {
    const previousFence = process.env.MULTITABLE_ENABLE_WRITER_FENCE
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    __resetOperationLedgerColumnProbe()
    __resetRecoveryWriterStateColumnProbe()
    try {
      await withFixture(async ({ pool }) => {
        const admitted = await admit(pool)
        const refreshed = sourcePayload(admitted, { overrides: { name: 'Renamed' } })
        const refresh = await pool.connect()
        try {
          await refresh.query('BEGIN')
          const syncId = randomUUID()
          await insertSync(refresh, admitted, syncBody(admitted, refreshed), syncId)
          await setCollaborationGuc(refresh, syncId)
          await refresh.query(
            `UPDATE meta_records
                SET data = $2::jsonb, version = version + 1, modified_by = $3, updated_at = now()
              WHERE id = $1`,
            [admitted.recordId, JSON.stringify(refreshed), admitted.actorId],
          )
          await refresh.query('COMMIT')
        } finally {
          refresh.release()
        }
        await expectAbort(pool, async (client) => {
          const syncId = randomUUID()
          await insertSync(client, admitted, syncBody(admitted, sourcePayload(admitted, { overrides: { name: 'No guc' } })), syncId)
          await client.query(
            `UPDATE meta_records SET data = $2::jsonb, version = version + 1, modified_by = $3 WHERE id = $1`,
            [admitted.recordId, JSON.stringify(sourcePayload(admitted, { overrides: { name: 'No guc' } })), admitted.actorId],
          )
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        await expectAbort(pool, async (client) => {
          await client.query(`SELECT set_config('metasheet.bom_review_sync', $1, true)`, [admitted.syncId])
          await client.query(
            `UPDATE meta_records SET data = $2::jsonb, version = version + 1, modified_by = $3 WHERE id = $1`,
            [admitted.recordId, JSON.stringify(sourcePayload(admitted, { overrides: { name: 'BOM guc' } })), admitted.actorId],
          )
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        await expectAbort(pool, async (client) => {
          await setCollaborationGuc(client, admitted.syncId)
          await client.query(
            `UPDATE meta_records SET data = $2::jsonb, version = version + 1, modified_by = $3 WHERE id = $1`,
            [admitted.recordId, JSON.stringify(sourcePayload(admitted, { overrides: { name: 'stale tx' } })), admitted.actorId],
          )
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        await expectAbort(pool, async (client) => {
          const syncId = randomUUID()
          await insertSync(client, admitted, syncBody(admitted, refreshed, { recordId: 'other-record' }), syncId)
          await setCollaborationGuc(client, syncId)
          await client.query(
            `UPDATE meta_records SET data = $2::jsonb, version = version + 1, modified_by = $3 WHERE id = $1`,
            [admitted.recordId, JSON.stringify(refreshed), admitted.actorId],
          )
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        await expectAbort(pool, async (client) => {
          const mixedSource = sourcePayload(admitted, { overrides: { name: 'Mixed' } })
          const mixed = { ...mixedSource, [admitted.localIds.review_note]: 'mixed' }
          const syncId = randomUUID()
          await insertSync(client, admitted, syncBody(admitted, mixedSource), syncId)
          await setCollaborationGuc(client, syncId)
          await client.query(
            `UPDATE meta_records SET data = $2::jsonb, version = version + 1, modified_by = $3 WHERE id = $1`,
            [admitted.recordId, JSON.stringify(mixed), admitted.actorId],
          )
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        await expectAbort(pool, async (client) => {
          await client.query(
            `UPDATE meta_records SET created_by = $2, modified_by = $2, updated_at = now() WHERE id = $1`,
            [admitted.recordId, admitted.localActorId],
          )
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        await expectAbort(pool, async (client) => {
          await client.query('UPDATE meta_records SET id = $2 WHERE id = $1', [admitted.recordId, `${admitted.recordId}_moved`])
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        await expectAbort(pool, async (client) => {
          await client.query('UPDATE meta_records SET locked = true, locked_by = $2 WHERE id = $1', [admitted.recordId, admitted.actorId])
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        await expectAbort(pool, async (client) => {
          await client.query(
            `INSERT INTO meta_records (id, sheet_id, data, created_by, modified_by) VALUES ($1, $2, '{}'::jsonb, $3, $3)`,
            [`${admitted.recordId}_empty`, admitted.sheetId, admitted.actorId],
          )
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        const kept = await pool.query('SELECT data, version, created_by, locked FROM meta_records WHERE id = $1', [admitted.recordId])
        const beforeLocal = kept.rows[0] as { data: Record<string, unknown>; version: number; created_by: string; locked: boolean }
        if (beforeLocal.data[admitted.sourceIds.name] !== 'Renamed' || Number(beforeLocal.version) !== 2 || beforeLocal.created_by !== admitted.actorId || beforeLocal.locked) {
          throw new Error('rejected source writes changed the committed record')
        }
        const fields = ECO_COLLABORATION_LOCAL_FIELDS.map((field) => ({
          id: admitted.localIds[field.key],
          name: field.key,
          type: field.type,
          property: {},
        }))
        const fieldById = new Map(fields.map((field) => [field.id, { type: field.type, readOnly: false, hidden: false, property: {} }]))
        const changes = [
          { fieldId: admitted.localIds.collaboration_owner, value: [admitted.localActorId], expectedVersion: 2 },
          { fieldId: admitted.localIds.followup_due_at, value: '2026-10-25T00:00:00.000Z', expectedVersion: 2 },
          { fieldId: admitted.localIds.review_note, value: 'check the housing', expectedVersion: 2 },
        ]
        const service = new RecordWriteService(asServicePool(pool), new EventBus(), serviceHelpers(admitted.localActorId))
        const written = await service.patchRecords({
          sheetId: admitted.sheetId,
          changesByRecord: new Map([[admitted.recordId, changes]]),
          actorId: admitted.localActorId,
          fields,
          visiblePropertyFields: fields,
          visiblePropertyFieldIds: new Set(fields.map((field) => field.id)),
          attachmentFields: [],
          fieldById,
          capabilities: {
            canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
            canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: true, canExport: true,
          },
          access: { userId: admitted.localActorId, permissions: [], isAdminRole: true },
          source: 'rest',
        })
        if (written.updated.length !== 1 || written.updated[0]?.version !== 3) {
          throw new Error('RecordWriteService did not commit the local cells')
        }
        const after = await pool.query(
          `SELECT data, version, created_by, modified_by, locked, sheet_id FROM meta_records WHERE id = $1`,
          [admitted.recordId],
        )
        const local = after.rows[0] as { data: Record<string, unknown>; version: number; created_by: string; modified_by: string; locked: boolean; sheet_id: string }
        if (local.data[admitted.sourceIds.name] !== 'Renamed' || local.data[admitted.localIds.review_note] !== 'check the housing') {
          throw new Error('local write changed a source cell or dropped the note')
        }
        if (Number(local.version) !== 3 || local.created_by !== admitted.actorId || local.modified_by !== admitted.localActorId || local.locked || local.sheet_id !== admitted.sheetId) {
          throw new Error('local write changed frozen record identity')
        }
        const revision = await pool.query(
          `SELECT version, source, operation_id FROM meta_record_revisions WHERE record_id = $1 AND action = 'update'`,
          [admitted.recordId],
        )
        const revisionRow = revision.rows[0] as { version: number; source: string; operation_id: string | null }
        if (Number(revisionRow.version) !== 3 || revisionRow.source !== 'rest' || !revisionRow.operation_id) {
          throw new Error('local write did not seal a real history revision')
        }
        const operation = await pool.query(
          'SELECT event_count FROM meta_record_history_operations WHERE operation_id = $1',
          [revisionRow.operation_id],
        )
        if (Number((operation.rows[0] as { event_count: number }).event_count) !== 1) {
          throw new Error('local write operation endpoint was not sealed')
        }
      })
    } finally {
      if (previousFence === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
      else process.env.MULTITABLE_ENABLE_WRITER_FENCE = previousFence
      __resetOperationLedgerColumnProbe()
      __resetRecoveryWriterStateColumnProbe()
    }
  })

  test('controls_immutability', async () => {
    await withFixture(async ({ pool, db }) => {
      const admitted = await admit(pool)
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_plm_collaboration_bindings SET item_id = $2 WHERE id = $1',
        [admitted.bindingId, `${admitted.itemId}_x`],
      ), { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        'DELETE FROM meta_plm_collaboration_bindings WHERE id = $1',
        [admitted.bindingId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        'DELETE FROM meta_plm_collaboration_syncs WHERE id = $1',
        [admitted.syncId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        `INSERT INTO meta_plm_collaboration_syncs (id, binding_id, actor_id, binding_version, patches, accepted_txid)
         VALUES ($1, $2, $3, 1, $4::jsonb, '0')`,
        [randomUUID(), admitted.bindingId, admitted.actorId, JSON.stringify(syncBody(admitted, sourcePayload(admitted)))],
      ), { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_plm_collaboration_rows SET row_key = $2::jsonb WHERE record_id = $1',
        [admitted.recordId, JSON.stringify(rowKey(admitted, `${admitted.ecoId}_x`))],
      ), { code: '23514', constraint: 'meta_plm_collaboration_row_guard', message: FAMILY })
      await expectAbort(pool, async (client) => {
        await client.query(
          'UPDATE meta_plm_collaboration_rows SET business_hash = $2 WHERE record_id = $1',
          [admitted.recordId, HEX_B],
        )
      }, { code: '23514', constraint: 'meta_plm_collaboration_row_guard', message: FAMILY })
      const hashClient = await pool.connect()
      try {
        await hashClient.query('BEGIN')
        const syncId = randomUUID()
        const captured = '2026-10-24T04:05:06.000000Z'
        await insertSync(hashClient, admitted, syncBody(admitted, sourcePayload(admitted), { hash: HEX_B, capturedAt: captured }), syncId)
        await setCollaborationGuc(hashClient, syncId)
        await hashClient.query(
          'UPDATE meta_plm_collaboration_rows SET business_hash = $2, captured_at = $3::timestamptz WHERE record_id = $1',
          [admitted.recordId, HEX_B, captured],
        )
        await hashClient.query('COMMIT')
      } finally {
        hashClient.release()
      }
      const previewId = randomUUID()
      const preview = await pool.connect()
      try {
        await preview.query('BEGIN')
        await insertPreview(preview, admitted, previewId, {
          createdAt: '2026-10-24T00:00:00Z',
          expiresAt: '2026-10-25T00:00:00Z',
        })
        await preview.query('COMMIT')
      } finally {
        preview.release()
      }
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_plm_collaboration_previews SET name = $2 WHERE id = $1',
        [previewId, 'rewritten'],
      ), { code: '23514', constraint: 'meta_plm_collaboration_preview_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        'DELETE FROM meta_plm_collaboration_previews WHERE id = $1',
        [previewId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_preview_guard', message: FAMILY })
      await pool.query(
        `UPDATE meta_plm_collaboration_previews
            SET request_id = $2, binding_id = $3, consumed_at = now()
          WHERE id = $1`,
        [previewId, randomUUID(), admitted.bindingId],
      )
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_plm_collaboration_previews SET consumed_at = now() WHERE id = $1',
        [previewId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_preview_guard', message: FAMILY })
      await pool.query(
        `UPDATE meta_plm_collaboration_bindings
            SET version = version + 1, status = 'stale', last_failure_code = 'sync_failed', updated_at = now()
          WHERE id = $1`,
        [admitted.bindingId],
      )
      await expectAbort(pool, (client) => client.query(
        `UPDATE meta_plm_collaboration_bindings SET status = 'active', updated_at = now() WHERE id = $1`,
        [admitted.bindingId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: FAMILY })
      await pool.query(
        `UPDATE meta_plm_collaboration_bindings SET status = 'disabled', updated_at = now() WHERE id = $1`,
        [admitted.bindingId],
      )
      await expectAbort(pool, (client) => client.query(
        `UPDATE meta_plm_collaboration_bindings SET status = 'active', updated_at = now() WHERE id = $1`,
        [admitted.bindingId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        `UPDATE meta_plm_collaboration_bindings SET last_failure_code = 'again', updated_at = now() WHERE id = $1`,
        [admitted.bindingId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: FAMILY })
      await expectAbort(pool, async (client) => {
        await insertSync(client, admitted, syncBody(admitted, sourcePayload(admitted)), randomUUID(), 2)
      }, { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
      await pool.query(
        `UPDATE meta_records
            SET data = data || $2::jsonb, version = version + 1, modified_by = $3, updated_at = now()
          WHERE id = $1`,
        [admitted.recordId, JSON.stringify({ [admitted.localIds.review_note]: 'still local' }), admitted.localActorId],
      )
      let refused: unknown
      try { await down(db) } catch (error) { refused = error }
      assertPg(refused, {
        code: '23514',
        constraint: 'meta_plm_collaboration_evidence_guard',
        message: 'plm_collaboration_source_evidence_present',
      })
    })
  })

  test('generic_container_and_fields', async () => {
    await withFixture(async ({ pool }) => {
      const admitted = await admit(pool)
      await expectAbort(pool, (client) => client.query(
        `UPDATE meta_fields SET property = property || '{"readOnly":false}'::jsonb WHERE id = $1`,
        [admitted.sourceIds.id],
      ), { code: '23514', constraint: 'meta_plm_collaboration_field_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        `UPDATE meta_fields SET property = property || '{"readonly":false}'::jsonb WHERE id = $1`,
        [admitted.sourceIds.name],
      ), { code: '23514', constraint: 'meta_plm_collaboration_field_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        `UPDATE meta_fields SET property = property || '{"plmCollaborationSnapshot":{"source":true,"key":"other"}}'::jsonb WHERE id = $1`,
        [admitted.sourceIds.eco_type],
      ), { code: '23514', constraint: 'meta_plm_collaboration_field_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        `UPDATE meta_fields SET type = 'longText' WHERE id = $1`,
        [admitted.sourceIds.state],
      ), { code: '23514', constraint: 'meta_plm_collaboration_field_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_fields SET id = $2 WHERE id = $1',
        [admitted.sourceIds.priority, `${admitted.sourceIds.priority}_moved`],
      ), { code: '23514', constraint: 'meta_plm_collaboration_field_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        'DELETE FROM meta_fields WHERE id = $1',
        [admitted.localIds.review_note],
      ), { code: '23514', constraint: 'meta_plm_collaboration_field_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        `INSERT INTO meta_fields (id, sheet_id, name, type, property) VALUES ($1, $2, 'extra', 'string', '{"readOnly":true}'::jsonb)`,
        [`extra_${admitted.sheetId}`, admitted.sheetId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_field_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        `UPDATE meta_fields SET property = '{"readOnly":true}'::jsonb WHERE id = $1`,
        [admitted.localIds.collaboration_owner],
      ), { code: '23514', constraint: 'meta_plm_collaboration_field_guard', message: FAMILY })
      await pool.query('UPDATE meta_fields SET name = $2, "order" = 50 WHERE id = $1', [admitted.localIds.review_note, 'Review note'])
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_bases SET workspace_id = $2 WHERE id = $1',
        [admitted.baseId, 'moved-workspace'],
      ), { code: '23514', constraint: 'meta_plm_collaboration_container_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_bases SET owner_id = $2 WHERE id = $1',
        [admitted.baseId, admitted.localActorId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_container_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_bases SET deleted_at = now() WHERE id = $1',
        [admitted.baseId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_container_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_sheets SET base_id = $2 WHERE id = $1',
        [admitted.sheetId, `${admitted.baseId}_x`],
      ), { code: '23514', constraint: 'meta_plm_collaboration_container_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_sheets SET deleted_at = now() WHERE id = $1',
        [admitted.sheetId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_container_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query('DELETE FROM meta_sheets WHERE id = $1', [admitted.sheetId]), {
        code: '23514', constraint: 'meta_plm_collaboration_container_guard', message: FAMILY,
      })
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_views SET deleted_at = now() WHERE id = $1',
        [admitted.viewId],
      ), { code: '23514', constraint: 'meta_plm_collaboration_container_guard', message: FAMILY })
      await expectAbort(pool, (client) => client.query('DELETE FROM meta_views WHERE id = $1', [admitted.viewId]), {
        code: '23514', constraint: 'meta_plm_collaboration_container_guard', message: FAMILY,
      })
      await expectAbort(pool, (client) => client.query('DELETE FROM meta_records WHERE id = $1', [admitted.recordId]), {
        code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY,
      })
      const plain = `${admitted.sheetId}_plain`
      const plainView = `${admitted.viewId}_plain`
      const plainRecord = `${admitted.recordId}_plain`
      await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [plain, admitted.baseId, 'plain'])
      await pool.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [plainView, plain, 'plain', 'grid'])
      await pool.query(
        `INSERT INTO meta_records (id, sheet_id, data, created_by, modified_by) VALUES ($1, $2, '{"open":true}'::jsonb, $3, $3)`,
        [plainRecord, plain, admitted.actorId],
      )
      await pool.query('UPDATE meta_views SET deleted_at = now() WHERE id = $1', [plainView])
      await pool.query('DELETE FROM meta_records WHERE id = $1', [plainRecord])
      await pool.query('DELETE FROM meta_views WHERE id = $1', [plainView])
      await pool.query('DELETE FROM meta_sheets WHERE id = $1', [plain])
      const earlySheet = `${admitted.sheetId}_early`
      const earlyView = `${admitted.viewId}_early`
      const earlyIds = idsFor('early')
      const earlyField = `early_extra_${admitted.sheetId}`
      await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [earlySheet, admitted.baseId, 'early'])
      const early = await pool.connect()
      try {
        await early.query('BEGIN')
        await insertFields(early, earlySheet, earlyIds.sourceIds, earlyIds.localIds)
        await early.query(
          `INSERT INTO meta_fields (id, sheet_id, name, type, property) VALUES ($1, $2, 'extra', 'string', '{}'::jsonb)`,
          [earlyField, earlySheet],
        )
        await early.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [earlyView, earlySheet, 'early', 'grid'])
        await insertBinding(early, {
          ...admitted,
          bindingId: randomUUID(),
          sheetId: earlySheet,
          viewId: earlyView,
          dataSourceId: `${admitted.dataSourceId}_early`,
          itemId: `${admitted.itemId}_early`,
          sourceIds: earlyIds.sourceIds,
          localIds: earlyIds.localIds,
        })
        await early.query('COMMIT')
      } finally {
        early.release()
      }
      await expectAbort(pool, (client) => client.query(
        'UPDATE meta_fields SET name = $2 WHERE id = $1',
        [earlyField, 'renamed extra'],
      ), { code: '23514', constraint: 'meta_plm_collaboration_field_guard', message: FAMILY })
      await assertUnboundAndBom(pool)
    })
  })

  test('truncate_all_surfaces', async () => {
    await withFixture(async ({ pool }) => {
      const admitted = await admit(pool)
      const before = await pool.query(
        'SELECT business_hash FROM meta_plm_collaboration_rows WHERE record_id = $1',
        [admitted.recordId],
      )
      const hash = (before.rows[0] as { business_hash: string }).business_hash
      const statements: Array<{ sql: string; expectation: { code: string; constraint?: string; message: string } }> = [
        { sql: 'TRUNCATE meta_records', expectation: { code: '0A000', message: 'cannot truncate a table referenced in a foreign key constraint' } },
        { sql: 'TRUNCATE meta_fields', expectation: { code: '23514', constraint: 'meta_plm_collaboration_truncate_guard', message: FAMILY } },
        { sql: 'TRUNCATE meta_sheets', expectation: { code: '0A000', message: 'cannot truncate a table referenced in a foreign key constraint' } },
        { sql: 'TRUNCATE meta_bases', expectation: { code: '0A000', message: 'cannot truncate a table referenced in a foreign key constraint' } },
        { sql: 'TRUNCATE meta_views', expectation: { code: '0A000', message: 'cannot truncate a table referenced in a foreign key constraint' } },
        { sql: 'TRUNCATE meta_plm_collaboration_bindings', expectation: { code: '0A000', message: 'cannot truncate a table referenced in a foreign key constraint' } },
        { sql: 'TRUNCATE meta_plm_collaboration_rows', expectation: { code: '23514', constraint: 'meta_plm_collaboration_truncate_guard', message: FAMILY } },
        { sql: 'TRUNCATE meta_plm_collaboration_syncs', expectation: { code: '23514', constraint: 'meta_plm_collaboration_truncate_guard', message: FAMILY } },
        { sql: 'TRUNCATE meta_records, meta_fields, meta_sheets', expectation: { code: '0A000', message: 'cannot truncate a table referenced in a foreign key constraint' } },
        { sql: 'TRUNCATE meta_bases CASCADE', expectation: { code: '23514', constraint: 'meta_plm_collaboration_truncate_guard', message: FAMILY } },
        { sql: 'TRUNCATE meta_plm_collaboration_bindings CASCADE', expectation: { code: '23514', constraint: 'meta_plm_collaboration_truncate_guard', message: FAMILY } },
        { sql: 'TRUNCATE meta_records CASCADE', expectation: { code: '23514', constraint: 'meta_plm_collaboration_truncate_guard', message: FAMILY } },
        { sql: 'TRUNCATE meta_sheets CASCADE', expectation: { code: '23514', constraint: 'meta_plm_collaboration_truncate_guard', message: FAMILY } },
        { sql: 'TRUNCATE meta_views CASCADE', expectation: { code: '23514', constraint: 'meta_plm_collaboration_truncate_guard', message: FAMILY } },
      ]
      for (const statement of statements) {
        await expectAbort(pool, (client) => client.query(statement.sql), statement.expectation)
      }
      const after = await pool.query(
        'SELECT business_hash FROM meta_plm_collaboration_rows WHERE record_id = $1',
        [admitted.recordId],
      )
      if ((after.rows[0] as { business_hash: string }).business_hash !== hash) {
        throw new Error('failed truncate changed the row hash')
      }
      await pool.query('TRUNCATE meta_plm_collaboration_previews')
      const still = await pool.query('SELECT count(*)::int AS n FROM meta_plm_collaboration_bindings')
      if (Number((still.rows[0] as { n: number }).n) !== 1) throw new Error('empty preview truncate removed bindings')
    })
    await withFixture(async ({ pool }) => {
      await pool.query(
        `INSERT INTO users (id, is_active) VALUES ('truncate_user', true)`,
      )
      await pool.query(
        `INSERT INTO meta_bases (id, owner_id, name, workspace_id) VALUES ('truncate_base', 'truncate_user', 't', 'ws')`,
      )
      await pool.query(`INSERT INTO meta_sheets (id, base_id, name) VALUES ('truncate_sheet', 'truncate_base', 't')`)
      await pool.query(
        `INSERT INTO meta_records (id, sheet_id, data, created_by, modified_by)
         VALUES ('truncate_record', 'truncate_sheet', '{}'::jsonb, 'truncate_user', 'truncate_user')`,
      )
      await pool.query('TRUNCATE meta_records, meta_plm_collaboration_rows')
      await pool.query('TRUNCATE meta_plm_collaboration_previews, meta_plm_collaboration_bindings, meta_plm_collaboration_rows, meta_plm_collaboration_syncs')
      const left = await pool.query(`SELECT to_regclass('meta_plm_bom_review_bindings') AS binding`)
      if (!(left.rows[0] as { binding: string | null }).binding) throw new Error('empty truncate removed BOM')
    })
  })

  test('downgrade_serialization', async () => {
    await withFixture(async ({ pool, admin, db, schema }) => {
      let stale: unknown
      try {
        await db.transaction().execute(async (trx) => {
          await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`.execute(trx)
          await down(trx)
        })
      } catch (error) {
        stale = error
      }
      assertPg(stale, {
        code: '23514',
        constraint: 'meta_plm_collaboration_snapshot_guard',
        message: 'plm_collaboration_snapshot_stale',
      })
      if (await relationCount(admin, schema, 'meta_plm_collaboration_%') !== 4) {
        throw new Error('repeatable-read refusal dropped a relation')
      }
      const waiter = await pool.connect()
      try {
        let pending: Promise<{ failed: false } | { failed: true; error: unknown }> = Promise.resolve({ failed: false })
        await db.transaction().execute(async (trx) => {
          await sql`LOCK TABLE meta_plm_collaboration_previews IN ACCESS EXCLUSIVE MODE`.execute(trx)
          await sql`LOCK TABLE meta_plm_collaboration_bindings IN ACCESS EXCLUSIVE MODE`.execute(trx)
          await sql`LOCK TABLE meta_plm_collaboration_rows IN ACCESS EXCLUSIVE MODE`.execute(trx)
          await sql`LOCK TABLE meta_plm_collaboration_syncs IN ACCESS EXCLUSIVE MODE`.execute(trx)
          pending = waiter.query(
            `INSERT INTO meta_plm_collaboration_previews (
               id, actor_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id, base_id,
               name, row_key, source_fingerprint, business_hash, captured_at, created_at, expires_at
             ) VALUES ($1, 'actor', 'ds', 'eco', 'tenant', 'org', 'item', 'base', 'blocked',
               '["ds","tenant","org","eco"]'::jsonb, $2, $2, now(), now(), now() + interval '1 day')`,
            [randomUUID(), HEX_A],
          ).then(
            () => ({ failed: false as const }),
            (error: unknown) => ({ failed: true as const, error }),
          )
          await waitForPidLock(admin, backendPid(waiter))
          await down(trx)
        })
        const blocked = await pending
        if (!blocked.failed) throw new Error('blocked preview insert committed')
        assertPg(blocked.error, { code: '42P01' })
      } finally {
        waiter.release()
      }
      if (await relationCount(admin, schema, 'meta_plm_collaboration_%') !== 0) {
        throw new Error('down under its own locks left a collaboration relation')
      }
      await up(db)
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('LOCK TABLE meta_plm_collaboration_syncs IN SHARE ROW EXCLUSIVE MODE')
        const dropping = down(db).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
        const pid = await waitForQueryLock(admin, `%LOCK TABLE ${schema}.meta_plm_collaboration_syncs%`)
        const locks = await admin.query(
          `SELECT relation.relname, locked.granted, locked.mode
             FROM pg_catalog.pg_locks locked
             JOIN pg_catalog.pg_class relation ON relation.oid = locked.relation
             JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE locked.pid = $1 AND namespace.nspname = $2
              AND relation.relname LIKE 'meta_plm_collaboration_%'`,
          [pid, schema],
        )
        const granted = new Map((locks.rows as Array<{ relname: string; granted: boolean; mode: string }>).map((row) => [row.relname, row]))
        for (const name of ['meta_plm_collaboration_previews', 'meta_plm_collaboration_bindings', 'meta_plm_collaboration_rows']) {
          const row = granted.get(name)
          if (!row?.granted || row.mode !== 'AccessExclusiveLock') throw new Error(`${name} was not locked before syncs`)
        }
        const waiting = granted.get('meta_plm_collaboration_syncs')
        if (!waiting || waiting.granted) throw new Error('down did not wait on the syncs lock')
        await holder.query('COMMIT')
        const finished = await dropping
        if (!finished.ok) throw finished.error
      } finally {
        try { await holder.query('ROLLBACK') } catch { /* committed */ }
        holder.release()
      }
      await up(db)
      const writer = await pool.connect()
      try {
        await writer.query('BEGIN')
        await writer.query(
          `INSERT INTO meta_plm_collaboration_previews (
             id, actor_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id, base_id,
             name, row_key, source_fingerprint, business_hash, captured_at, created_at, expires_at
           ) VALUES ($1, 'actor', 'ds', 'eco', 'tenant', 'org', 'item', 'base', 'in progress',
             '["ds","tenant","org","eco"]'::jsonb, $2, $2, now(), now(), now() + interval '1 day')`,
          [randomUUID(), HEX_A],
        )
        const refusing = down(db).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
        await waitForQueryLock(admin, `%LOCK TABLE ${schema}.meta_plm_collaboration_previews%`)
        await writer.query('COMMIT')
        const refused = await refusing
        if (refused.ok) throw new Error('down committed over a preview inserted while it waited')
        assertPg(refused.error, {
          code: '23514',
          constraint: 'meta_plm_collaboration_evidence_guard',
          message: 'plm_collaboration_source_evidence_present',
        })
      } finally {
        try { await writer.query('ROLLBACK') } catch { /* committed */ }
        writer.release()
      }
      if (await relationCount(admin, schema, 'meta_plm_collaboration_%') !== 4) {
        throw new Error('evidence discovered during lock wait still dropped relations')
      }
    })
    await withFixture(async ({ pool, db }) => {
      await pool.query(
        `INSERT INTO meta_plm_collaboration_previews (
           id, actor_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id, base_id,
           name, row_key, source_fingerprint, business_hash, captured_at, created_at, expires_at
         ) VALUES ($1, 'actor', 'ds', 'eco', 'tenant', 'org', 'item', 'base', 'expired',
           '["ds","tenant","org","eco"]'::jsonb, $2, $2, '2020-01-03T00:00:00Z', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z')`,
        [randomUUID(), HEX_A],
      )
      let refused: unknown
      try { await down(db) } catch (error) { refused = error }
      assertPg(refused, {
        code: '23514',
        constraint: 'meta_plm_collaboration_evidence_guard',
        message: 'plm_collaboration_source_evidence_present',
      })
      const left = await pool.query('SELECT count(*)::int AS n FROM meta_plm_collaboration_previews')
      if (Number((left.rows[0] as { n: number }).n) !== 1) throw new Error('expired preview was deleted by down')
    })
  })

  test('operation_and_commit_atomicity', async () => {
    const previousFence = process.env.MULTITABLE_ENABLE_WRITER_FENCE
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    __resetOperationLedgerColumnProbe()
    __resetRecoveryWriterStateColumnProbe()
    try {
      await withFixture(async ({ pool }) => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const admitted = await insertAdmission(client)
          const query = (text: string, params?: unknown[]) => client.query(text, params)
          const ledger = await mintOperation(query, admitted.sheetId)
          if (!ledger.operationId) throw new Error('mintOperation returned an inert ledger')
          await recordRecordRevision(query, {
            sheetId: admitted.sheetId,
            recordId: admitted.recordId,
            version: 1,
            action: 'create',
            source: 'system_sync',
            actorId: admitted.actorId,
            changedFieldIds: Object.values(admitted.sourceIds),
            patch: sourcePayload(admitted),
            snapshot: sourcePayload(admitted),
            createdAt: CAPTURED_AT,
            ledger,
          })
          if (!await sealOperation(query, ledger)) throw new Error('sealOperation wrote no endpoint')
          await client.query('COMMIT')
          const revision = await pool.query(
            `SELECT source, operation_id FROM meta_record_revisions WHERE record_id = $1`,
            [admitted.recordId],
          )
          const row = revision.rows[0] as { source: string; operation_id: string }
          if (row.source !== 'system_sync' || row.operation_id !== ledger.operationId) {
            throw new Error('sealed revision is not the system_sync operation')
          }
        } finally {
          client.release()
        }
        await expectCommitFailure(pool, async (inner) => {
          await insertAdmission(inner, { omitRecord: true })
        }, {
          code: '23503',
          constraint: 'meta_plm_collaboration_rows_record_id_fkey',
        }, `SELECT count(*)::int AS n FROM meta_plm_collaboration_bindings WHERE id NOT IN (SELECT binding_id FROM meta_plm_collaboration_rows)`)
        await expectCommitFailure(pool, async (inner) => {
          const mapped = await insertAdmission(inner, { omitRecord: true })
          const otherSheet = `${mapped.sheetId}_other`
          await inner.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [otherSheet, mapped.baseId, 'other'])
          await inner.query(
            `INSERT INTO meta_records (id, sheet_id, data, created_by, modified_by) VALUES ($1, $2, '{}'::jsonb, $3, $3)`,
            [mapped.recordId, otherSheet, mapped.actorId],
          )
        }, {
          code: '23514',
          constraint: 'meta_plm_collaboration_commit_guard',
          message: FAMILY,
        }, `SELECT count(*)::int AS n FROM meta_record_revisions WHERE source = 'system_sync' AND record_id NOT IN (SELECT record_id FROM meta_plm_collaboration_rows)`)
        await expectCommitFailure(pool, async (inner) => {
          const admitted = await insertAdmission(inner)
          const query = (text: string, params?: unknown[]) => inner.query(text, params)
          const ledger = await mintOperation(query, admitted.sheetId)
          if (!ledger.operationId) throw new Error('mintOperation returned an inert ledger')
          await recordRecordRevision(query, {
            sheetId: admitted.sheetId,
            recordId: admitted.recordId,
            version: 1,
            action: 'create',
            source: 'system_sync',
            actorId: admitted.actorId,
            changedFieldIds: [],
            patch: {},
            snapshot: sourcePayload(admitted),
            createdAt: CAPTURED_AT,
            ledger,
          })
        }, {
          code: '23503',
          constraint: 'fk_mrr_operation',
        }, `SELECT count(*)::int AS n FROM meta_record_revisions WHERE operation_id IS NOT NULL AND record_id NOT IN (
              SELECT record_id FROM meta_plm_collaboration_rows
            )`)
      })
    } finally {
      if (previousFence === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
      else process.env.MULTITABLE_ENABLE_WRITER_FENCE = previousFence
      __resetOperationLedgerColumnProbe()
      __resetRecoveryWriterStateColumnProbe()
    }
  })

  test('guard_coexistence_and_runtime_origin', async () => {
    await withFixture(async ({ pool, admin, schema }) => {
      await assertUnboundAndBom(pool)
      const admitted = await admit(pool)
      await expectAbort(pool, async (client) => {
        await client.query(`SELECT set_config('metasheet.bom_review_sync', $1, true)`, [admitted.syncId])
        await client.query(
          `UPDATE meta_records SET data = $2::jsonb, version = version + 1, modified_by = $3 WHERE id = $1`,
          [admitted.recordId, JSON.stringify(sourcePayload(admitted, { overrides: { name: 'bom unlock' } })), admitted.actorId],
        )
      }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
      const overlapSheet = `${admitted.sheetId}_overlap`
      const overlapView = `${admitted.viewId}_overlap`
      await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [overlapSheet, admitted.baseId, 'overlap'])
      await pool.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [overlapView, overlapSheet, 'overlap', 'grid'])
      const overlapIds = idsFor('overlap')
      const overlap = await pool.connect()
      try {
        await overlap.query('BEGIN')
        await insertFields(overlap, overlapSheet, overlapIds.sourceIds, overlapIds.localIds)
        await overlap.query(
          `INSERT INTO meta_plm_bom_review_bindings (
             id, data_source_id, part_id, creator_id, source_fingerprint, source, base_id, sheet_id, view_id,
             name, fields, version, status, snapshot_hash, last_synced_at, line_count, occurrence_count
           ) VALUES ($1, 'ds', 'part', $2, $3, '{}'::jsonb, $4, $5, $6, 'overlap', '{}'::jsonb, 1, 'active', $3, now(), 0, 0)`,
          [randomUUID(), admitted.actorId, HEX_B, admitted.baseId, overlapSheet, overlapView],
        )
        await overlap.query('COMMIT')
      } finally {
        overlap.release()
      }
      await expectAbort(pool, (client) => insertBinding(client, {
        ...admitted,
        bindingId: randomUUID(),
        sheetId: overlapSheet,
        viewId: overlapView,
        dataSourceId: `${admitted.dataSourceId}_overlap`,
        itemId: `${admitted.itemId}_overlap`,
        sourceIds: overlapIds.sourceIds,
        localIds: overlapIds.localIds,
      }), { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: FAMILY })
      const decoy = `plm_w23_${randomBytes(8).toString('hex')}`
      assertSchema(decoy)
      await admin.query(`CREATE SCHEMA ${decoy}`)
      try {
        await admin.query(
          `CREATE TABLE ${decoy}.meta_plm_collaboration_bindings (id uuid, sheet_id text)`,
        )
        await admin.query(
          `CREATE FUNCTION ${decoy}.meta_plm_collaboration_record_guard() RETURNS trigger
           LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$`,
        )
        const shadow = await pool.connect()
        try {
          await shadow.query('BEGIN')
          await shadow.query(`SET LOCAL search_path TO ${decoy}, ${schema}`)
          let failed: unknown
          try {
            await shadow.query(
              `UPDATE meta_records SET data = $2::jsonb, version = version + 1, modified_by = $3 WHERE id = $1`,
              [admitted.recordId, JSON.stringify(sourcePayload(admitted, { overrides: { name: 'shadow' } })), admitted.actorId],
            )
          } catch (error) {
            failed = error
          }
          assertPg(failed, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
          await shadow.query('ROLLBACK')
        } finally {
          shadow.release()
        }
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS ${decoy} CASCADE`)
      }
      const origin = await admin.query(
        `SELECT current_setting('session_replication_role') AS role,
                bool_and(trigger.tgenabled = 'O') AS enabled
           FROM pg_catalog.pg_trigger trigger
           JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = $1 AND trigger.tgname LIKE 'meta_plm_collaboration_%'`,
        [schema],
      )
      const originRow = origin.rows[0] as { role: string; enabled: boolean }
      if (originRow.role !== 'origin' || originRow.enabled !== true) {
        throw new Error(`runtime origin is ${originRow.role} enabled=${originRow.enabled}`)
      }
      await functionHashes(admin, schema)
    })
  })

  test('native_lock_marker', async () => {
    await withWriterFence(async () => withFixture(async ({ pool }) => {
      const column = await pool.query(
        `SELECT udt_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'meta_records' AND column_name = 'locked_at'`,
      )
      if ((column.rows[0] as { udt_name?: string } | undefined)?.udt_name !== 'timestamptz') {
        throw new Error('locked_at prerequisite is not timestamptz')
      }
      const admitted = await admit(pool)
      const before = (await pool.query(
        'SELECT data, created_by, modified_by, version FROM meta_records WHERE id = $1',
        [admitted.recordId],
      )).rows[0] as { data: unknown; created_by: string; modified_by: string; version: number }
      const revisionsBefore = Number((await pool.query(
        'SELECT count(*)::int AS n FROM meta_record_revisions WHERE record_id = $1',
        [admitted.recordId],
      )).rows[0].n)
      const steps: Array<{ locked: boolean; kind: 'lock' | 'unlock'; version: number }> = [
        { locked: true, kind: 'lock', version: 2 },
        { locked: true, kind: 'lock', version: 3 },
        { locked: false, kind: 'unlock', version: 4 },
      ]
      for (const step of steps) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const query = (text: string, params?: unknown[]) => client.query(text, params)
          await fenceWriterEntry(query, admitted.sheetId)
          const ledger = await mintOperation(query, admitted.sheetId)
          if (!ledger.operationId) throw new Error('native marker operation is inert')
          const result = step.locked
            ? await query(
              `UPDATE meta_records SET locked = true, locked_by = $2, locked_at = NOW(), version = version + 1, updated_at = NOW()
                WHERE id = $1 AND sheet_id = $3 RETURNING version`,
              [admitted.recordId, admitted.localActorId, admitted.sheetId],
            )
            : await query(
              `UPDATE meta_records SET locked = false, locked_by = NULL, locked_at = NULL, version = version + 1, updated_at = NOW()
                WHERE id = $1 AND sheet_id = $2 RETURNING version`,
              [admitted.recordId, admitted.sheetId],
            )
          if (Number((result.rows[0] as { version?: number } | undefined)?.version) !== step.version) {
            throw new Error('native lock version mismatch')
          }
          await recordVersionMarker(query, {
            sheetId: admitted.sheetId,
            recordId: admitted.recordId,
            version: step.version,
            kind: step.kind,
            actorId: admitted.localActorId,
            ledger,
          })
          if (!await sealOperation(query, ledger)) throw new Error('native marker not sealed')
          await client.query('COMMIT')
        } catch (error) {
          try { await client.query('ROLLBACK') } catch { /* aborted */ }
          throw error
        } finally {
          client.release()
        }
        const after = (await pool.query(
          'SELECT data, created_by, modified_by, locked, locked_by, locked_at, version FROM meta_records WHERE id = $1',
          [admitted.recordId],
        )).rows[0] as {
          data: unknown
          created_by: string
          modified_by: string
          locked: boolean
          locked_by: string | null
          locked_at: string | null
          version: number
        }
        if (
          JSON.stringify(after.data) !== JSON.stringify(before.data)
          || after.created_by !== before.created_by
          || after.modified_by !== before.modified_by
          || Number(after.version) !== step.version
          || after.locked !== step.locked
        ) {
          throw new Error('native lock changed content, identity, or bookkeeping')
        }
        if (step.locked
          ? after.locked_by !== admitted.localActorId || after.locked_at == null
          : after.locked_by !== null || after.locked_at !== null) {
          throw new Error('native lock tuple incorrect')
        }
      }
      const markers = await pool.query(
        'SELECT version, kind, operation_id FROM meta_record_version_markers WHERE record_id = $1 ORDER BY version',
        [admitted.recordId],
      )
      const markerRows = markers.rows as Array<{ version: number; kind: string; operation_id: string | null }>
      if (
        markerRows.length !== 3
        || markerRows[0]?.kind !== 'lock' || Number(markerRows[0]?.version) !== 2
        || markerRows[1]?.kind !== 'lock' || Number(markerRows[1]?.version) !== 3
        || markerRows[2]?.kind !== 'unlock' || Number(markerRows[2]?.version) !== 4
        || markerRows.some((row) => !row.operation_id)
      ) {
        throw new Error('native marker history incorrect')
      }
      const endpoints = await pool.query(
        'SELECT event_count FROM meta_record_history_operations WHERE operation_id = ANY($1::uuid[])',
        [markerRows.map((row) => row.operation_id)],
      )
      if (endpoints.rows.length !== 3 || endpoints.rows.some((row) => Number((row as { event_count: number }).event_count) !== 1)) {
        throw new Error('native marker endpoints incorrect')
      }
      const revisionsAfter = Number((await pool.query(
        'SELECT count(*)::int AS n FROM meta_record_revisions WHERE record_id = $1',
        [admitted.recordId],
      )).rows[0].n)
      if (revisionsAfter !== revisionsBefore) throw new Error('native lock minted content revisions')
      await expectAbort(pool, async (client) => {
        await client.query(
          'UPDATE meta_records SET locked = true, locked_by = $2 WHERE id = $1',
          [admitted.recordId, admitted.actorId],
        )
      }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
      await expectAbort(pool, async (client) => {
        const syncId = randomUUID()
        const data = sourcePayload(admitted, { overrides: { name: 'lock override' } })
        await insertSync(client, admitted, syncBody(admitted, data), syncId)
        await setCollaborationGuc(client, syncId)
        await client.query(
          `UPDATE meta_records
              SET data = $2::jsonb, version = version + 1, modified_by = $3, updated_at = now(),
                  locked = true, locked_by = $3, locked_at = now()
            WHERE id = $1`,
          [admitted.recordId, JSON.stringify(data), admitted.actorId],
        )
      }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
      const kept = (await pool.query(
        'SELECT data, version, locked, locked_by FROM meta_records WHERE id = $1',
        [admitted.recordId],
      )).rows[0] as { data: Record<string, unknown>; version: number; locked: boolean; locked_by: string | null }
      if (
        kept.data[admitted.sourceIds.name] !== 'Pump housing'
        || Number(kept.version) !== 4
        || kept.locked !== false
        || kept.locked_by !== null
      ) {
        throw new Error('refused lock shapes changed the committed record')
      }
    }))
  })

  test('row_key_commit_refusal_and_same_eco_positive', async () => {
    await withFixture(async ({ pool }) => {
      const admitted = await admit(pool)
      const before = (await pool.query(
        `SELECT r.data, r.version, m.row_key
           FROM meta_records r
           JOIN meta_plm_collaboration_rows m ON m.record_id = r.id
          WHERE r.id = $1`,
        [admitted.recordId],
      )).rows[0]
      const ecoB = `${admitted.ecoId}-B`
      const dataB = sourcePayload(admitted, { overrides: { id: ecoB } })
      const client = await pool.connect()
      let committed = false
      let refused: unknown
      try {
        await client.query('BEGIN')
        const syncId = randomUUID()
        await insertSync(client, admitted, syncBody(admitted, dataB, { ecoId: ecoB }), syncId)
        await setCollaborationGuc(client, syncId)
        const evidence = (await client.query(
          `SELECT m.row_key,
                  s.patches -> $2 -> 'row_key' AS accepted_key,
                  s.patches -> $2 -> 'data' AS accepted_data
             FROM meta_plm_collaboration_rows m
             JOIN meta_plm_collaboration_syncs s ON s.binding_id = m.binding_id
            WHERE m.record_id = $2 AND s.id = $1`,
          [syncId, admitted.recordId],
        )).rows[0] as { row_key: unknown; accepted_key: unknown; accepted_data: Record<string, unknown> }
        if (
          JSON.stringify(evidence.row_key) !== JSON.stringify(rowKey(admitted))
          || JSON.stringify(evidence.accepted_key) !== JSON.stringify(rowKey(admitted, ecoB))
          || evidence.accepted_data[admitted.sourceIds.id] !== ecoB
        ) {
          throw new Error('B receipt was not stored against the immutable A mapping')
        }
        await client.query(
          `UPDATE meta_records
              SET data = $2::jsonb, version = version + 1, modified_by = $3, updated_at = now()
            WHERE id = $1`,
          [admitted.recordId, JSON.stringify(dataB), admitted.actorId],
        )
        await client.query('COMMIT')
        committed = true
      } catch (error) {
        refused = error
        try { await client.query('ROLLBACK') } catch { /* aborted */ }
      } finally {
        client.release()
      }
      if (committed) throw new Error('WRONG_COMMIT: source ECO-B persisted with immutable mapping ECO-A')
      assertPg(refused, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
      const after = (await pool.query(
        `SELECT r.data, r.version, m.row_key
           FROM meta_records r
           JOIN meta_plm_collaboration_rows m ON m.record_id = r.id
          WHERE r.id = $1`,
        [admitted.recordId],
      )).rows[0]
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error('rejected rebind changed mapping, source, or version')
      }
      const positive = await pool.connect()
      try {
        await positive.query('BEGIN')
        const syncId = randomUUID()
        const data = sourcePayload(admitted, { overrides: { name: 'same ECO accepted' } })
        await insertSync(positive, admitted, syncBody(admitted, data), syncId)
        await setCollaborationGuc(positive, syncId)
        await positive.query(
          `UPDATE meta_records
              SET data = $2::jsonb, version = version + 1, modified_by = $3, updated_at = now()
            WHERE id = $1`,
          [admitted.recordId, JSON.stringify(data), admitted.actorId],
        )
        await positive.query('COMMIT')
      } catch (error) {
        try { await positive.query('ROLLBACK') } catch { /* aborted */ }
        throw error
      } finally {
        positive.release()
      }
      const stored = (await pool.query(
        `SELECT r.data, r.version, m.row_key
           FROM meta_records r
           JOIN meta_plm_collaboration_rows m ON m.record_id = r.id
          WHERE r.id = $1`,
        [admitted.recordId],
      )).rows[0] as { data: Record<string, unknown>; version: number; row_key: unknown }
      if (
        stored.data[admitted.sourceIds.id] !== admitted.ecoId
        || stored.data[admitted.sourceIds.name] !== 'same ECO accepted'
        || Number(stored.version) !== 2
        || JSON.stringify(stored.row_key) !== JSON.stringify(rowKey(admitted))
      ) {
        throw new Error('same-ECO accepted refresh did not keep the mapped row key')
      }
    })
  })

  test('local_change_version_and_unset_history', async () => {
    await withWriterFence(async () => withFixture(async ({ pool }) => {
      const admitted = await admit(pool)
      await pool.query(
        `UPDATE meta_records
            SET data = data || jsonb_build_object($2::text, $3::text),
                version = version + 1, modified_by = $4, updated_at = now()
          WHERE id = $1`,
        [admitted.recordId, admitted.localIds.review_note, 'valid plus one', admitted.localActorId],
      )
      await pool.query('UPDATE meta_records SET updated_at = updated_at WHERE id = $1', [admitted.recordId])
      const before = (await pool.query(
        'SELECT data, version FROM meta_records WHERE id = $1',
        [admitted.recordId],
      )).rows[0] as { data: Record<string, unknown>; version: number }
      if (before.data[admitted.localIds.review_note] !== 'valid plus one' || Number(before.version) !== 2) {
        throw new Error('valid local plus-one did not commit')
      }
      const client = await pool.connect()
      let committed = false
      let refused: unknown
      try {
        await client.query('BEGIN')
        await client.query(
          'UPDATE meta_records SET data = data || jsonb_build_object($2::text, $3::text) WHERE id = $1',
          [admitted.recordId, admitted.localIds.review_note, 'same-version invalid'],
        )
        await client.query('COMMIT')
        committed = true
      } catch (error) {
        refused = error
        try { await client.query('ROLLBACK') } catch { /* aborted */ }
      } finally {
        client.release()
      }
      if (committed) throw new Error('WRONG_COMMIT: changed local cell persisted without version increment')
      assertPg(refused, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
      await expectAbort(pool, async (guard) => {
        await guard.query(
          'UPDATE meta_records SET data = data - $2::text WHERE id = $1',
          [admitted.recordId, admitted.localIds.review_note],
        )
      }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
      const kept = (await pool.query(
        'SELECT data, version FROM meta_records WHERE id = $1',
        [admitted.recordId],
      )).rows[0]
      if (JSON.stringify(kept) !== JSON.stringify(before)) {
        throw new Error('refused same-version local mutation changed data or version')
      }
      await writeLocalNote(pool, admitted, 2, 'unset')
      const after = (await pool.query(
        'SELECT data, version FROM meta_records WHERE id = $1',
        [admitted.recordId],
      )).rows[0] as { data: Record<string, unknown>; version: number }
      if (
        Object.hasOwn(after.data, admitted.localIds.review_note)
        || Number(after.version) !== 3
        || after.data[admitted.sourceIds.id] !== admitted.ecoId
      ) {
        throw new Error('canonical unset did not preserve source, remove the key, and bump')
      }
      const revision = (await pool.query(
        `SELECT version, source, patch, snapshot, operation_id
           FROM meta_record_revisions
          WHERE record_id = $1 AND version = 3 AND action = 'update'`,
        [admitted.recordId],
      )).rows[0] as {
        version: number
        source: string
        patch: Record<string, unknown>
        snapshot: Record<string, unknown>
        operation_id: string | null
      } | undefined
      if (
        !revision
        || revision.source !== 'rest'
        || revision.patch[admitted.localIds.review_note] !== null
        || Object.hasOwn(revision.snapshot, admitted.localIds.review_note)
        || revision.snapshot[admitted.sourceIds.id] !== admitted.ecoId
        || !revision.operation_id
      ) {
        throw new Error('unset full after-image or null-sentinel history incorrect')
      }
      const endpoint = await pool.query(
        'SELECT event_count FROM meta_record_history_operations WHERE operation_id = $1',
        [revision.operation_id],
      )
      if (Number((endpoint.rows[0] as { event_count?: number } | undefined)?.event_count) !== 1) {
        throw new Error('unset endpoint missing')
      }
    }))
  })

  test('initial_field_race_two_backends', async () => {
    await withFixture(async ({ pool, admin }) => {
      const prefix = `race_${randomBytes(4).toString('hex')}`
      const { sourceIds, localIds } = idsFor(prefix)
      const admitted: Admission = {
        actorId: `${prefix}_actor`,
        localActorId: `${prefix}_local`,
        baseId: `${prefix}_base`,
        sheetId: `${prefix}_sheet`,
        viewId: `${prefix}_view`,
        bindingId: randomUUID(),
        syncId: randomUUID(),
        recordId: `${prefix}_record`,
        dataSourceId: `${prefix}_ds`,
        tenantId: `${prefix}_tenant`,
        orgId: `${prefix}_org`,
        itemId: `${prefix}_item`,
        versionId: `${prefix}_version`,
        ecoId: `${prefix}_eco`,
        fingerprint: HEX_A,
        businessHash: HEX_A,
        capturedAt: CAPTURED_AT,
        nativeUpdatedAt: NATIVE_AT,
        sourceIds,
        localIds,
      }
      const setup = await pool.connect()
      try {
        await setup.query('BEGIN')
        await setup.query(
          'INSERT INTO users (id, is_active) VALUES ($1, true), ($2, true)',
          [admitted.actorId, admitted.localActorId],
        )
        await setup.query(
          'INSERT INTO meta_bases (id, owner_id, name, workspace_id) VALUES ($1, $2, $3, $4)',
          [admitted.baseId, admitted.actorId, 'race', `${prefix}_ws`],
        )
        await setup.query(
          'INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)',
          [admitted.sheetId, admitted.baseId, 'race'],
        )
        await insertFields(setup, admitted.sheetId, sourceIds, localIds)
        await setup.query(
          'INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)',
          [admitted.viewId, admitted.sheetId, 'race', 'grid'],
        )
        await setup.query('COMMIT')
      } catch (error) {
        try { await setup.query('ROLLBACK') } catch { /* aborted */ }
        throw error
      } finally {
        setup.release()
      }
      const binder = await pool.connect()
      const editor = await pool.connect()
      const binderPid = backendPid(binder)
      const editorPid = backendPid(editor)
      if (binderPid === editorPid) throw new Error('two independent backends required')
      type Edit = { ok: true; n: number | null } | { ok: false; error: unknown }
      let edit: Edit | undefined
      let pending: Promise<void> | undefined
      try {
        await binder.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        await editor.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        await editor.query("SET LOCAL statement_timeout = '10s'")
        const pre = await binder.query('SELECT type, property FROM meta_fields WHERE id = $1', [sourceIds.name])
        const predicate = pre.rows[0] as { type?: string; property?: { readOnly?: boolean } } | undefined
        if (pre.rows.length !== 1 || predicate?.type !== 'string' || predicate.property?.readOnly !== true) {
          throw new Error('admitted field predicate was not initially readOnly')
        }
        await insertBinding(binder, admitted)
        const invisible = await editor.query(
          'SELECT count(*)::int AS n FROM meta_plm_collaboration_bindings WHERE id = $1',
          [admitted.bindingId],
        )
        if (Number((invisible.rows[0] as { n: number }).n) !== 0) {
          throw new Error('editor sees the uncommitted binding')
        }
        const states = await admin.query(
          'SELECT pid, state, xact_start FROM pg_stat_activity WHERE pid = ANY($1::int[]) ORDER BY pid',
          [[binderPid, editorPid]],
        )
        if (
          states.rows.length !== 2
          || states.rows.some((row) => (row as { state: string; xact_start: unknown }).state !== 'idle in transaction' || !(row as { xact_start: unknown }).xact_start)
        ) {
          throw new Error('two live open transactions were not observed')
        }
        pending = editor.query(
          `UPDATE meta_fields SET property = property || '{"readOnly":false}'::jsonb WHERE id = $1`,
          [sourceIds.name],
        ).then(
          (result) => { edit = { ok: true, n: result.rowCount } },
          (error: unknown) => { edit = { ok: false, error } },
        )
        const started = Date.now()
        let blocked = false
        while (!edit) {
          const found = await admin.query(
            `SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers
               FROM pg_stat_activity WHERE pid = $1`,
            [editorPid],
          )
          const state = found.rows[0] as {
            wait_event_type: string | null
            blockers: unknown
          } | undefined
          if (state?.wait_event_type === 'Lock') {
            const blockers = Array.isArray(state.blockers) ? state.blockers.map((pid) => Number(pid)) : []
            if (!blockers.includes(binderPid)) throw new Error('editor lock waiter is blocked by an unrelated backend')
            blocked = true
            break
          }
          if (Date.now() - started > 8000) {
            throw new Error('neither edit completion nor an actual binder lock was observed')
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        if (!blocked) throw new Error('editor field update did not wait on the binder row lock')
        const data = sourcePayload(admitted)
        await insertSync(binder, admitted, syncBody(admitted, data))
        await insertMappedRecord(binder, admitted, data)
        await binder.query('COMMIT')
        await pending
        if (!edit || edit.ok) throw new Error('blocked edit succeeded after the binder committed')
        assertPg(edit.error, { code: '23514', constraint: 'meta_plm_collaboration_field_guard', message: FAMILY })
        await editor.query('ROLLBACK')
        const final = await pool.query(
          `SELECT binding.id,
                  field.property -> 'readOnly' AS readonly,
                  record.id AS record_id,
                  mapped.record_id AS mapped_id
             FROM meta_fields field
             LEFT JOIN meta_plm_collaboration_bindings binding ON binding.id = $1
             LEFT JOIN meta_plm_collaboration_rows mapped ON mapped.binding_id = binding.id
             LEFT JOIN meta_records record ON record.id = mapped.record_id
            WHERE field.id = $2`,
          [admitted.bindingId, sourceIds.name],
        )
        const row = final.rows[0] as {
          id: string | null
          readonly: boolean | null
          record_id: string | null
          mapped_id: string | null
        }
        if (!row?.id || row.readonly !== true || row.record_id !== admitted.recordId || row.mapped_id !== admitted.recordId) {
          throw new Error('binder commit did not keep readOnly true and the mapped record')
        }
      } finally {
        try { await binder.query('ROLLBACK') } catch { /* committed or aborted */ }
        if (pending) await pending
        try { await editor.query('ROLLBACK') } catch { /* aborted */ }
        binder.release()
        editor.release()
      }
    })
  })

  test('same_source_sync_intent', async () => {
    await withFixture(async ({ pool }) => {
      const admitted = await admit(pool)
      const data = sourcePayload(admitted)
      const positive = await pool.connect()
      try {
        await positive.query('BEGIN')
        const syncId = randomUUID()
        await insertSync(positive, admitted, syncBody(admitted, data), syncId)
        await setCollaborationGuc(positive, syncId)
        await positive.query(
          `UPDATE meta_records SET data = $2::jsonb, version = version + 1, modified_by = $3, updated_at = now() WHERE id = $1`,
          [admitted.recordId, JSON.stringify(data), admitted.actorId],
        )
        await positive.query('COMMIT')
      } finally {
        try { await positive.query('ROLLBACK') } catch { /* committed */ }
        positive.release()
      }
      const before = await pool.query(
        'SELECT data, version, created_by, modified_by FROM meta_records WHERE id = $1',
        [admitted.recordId],
      )
      const beforeRow = before.rows[0] as { data: Record<string, unknown>; version: number; created_by: string; modified_by: string }
      if (Number(beforeRow.version) !== 2 || beforeRow.data[admitted.sourceIds.id] !== admitted.ecoId) {
        throw new Error('valid same-source accepted refresh positive did not commit')
      }
      const mapped = await pool.query(
        'SELECT row_key FROM meta_plm_collaboration_rows WHERE record_id = $1',
        [admitted.recordId],
      )
      if (JSON.stringify((mapped.rows[0] as { row_key: unknown }).row_key) !== JSON.stringify(rowKey(admitted))) {
        throw new Error('valid same-source refresh rewrote the mapped row key')
      }
      const client = await pool.connect()
      let committed = false
      let refusal: unknown
      const wrongSync = randomUUID()
      try {
        await client.query('BEGIN')
        await insertSync(client, admitted, syncBody(admitted, data, { recordId: `${admitted.recordId}-wrong` }), wrongSync)
        await setCollaborationGuc(client, wrongSync)
        await client.query(
          `UPDATE meta_records SET data = $2::jsonb, version = version + 1, modified_by = $3, updated_at = now() WHERE id = $1`,
          [admitted.recordId, JSON.stringify(data), admitted.actorId],
        )
        await client.query('COMMIT')
        committed = true
      } catch (error) {
        refusal = error
        try { await client.query('ROLLBACK') } catch { /* already aborted */ }
      } finally {
        client.release()
      }
      const after = await pool.query(
        'SELECT data, version, created_by, modified_by FROM meta_records WHERE id = $1',
        [admitted.recordId],
      )
      const receipt = await pool.query(
        'SELECT count(*)::int AS n FROM meta_plm_collaboration_syncs WHERE id = $1',
        [wrongSync],
      )
      if (committed) throw new Error('explicit same-source sync intent committed despite receipt for wrong record')
      assertPg(refusal, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
      if (JSON.stringify(before.rows[0]) !== JSON.stringify(after.rows[0]) || Number((receipt.rows[0] as { n: number }).n) !== 0) {
        throw new Error('rejected same-source sync intent changed committed state')
      }
      const still = await pool.query(
        'SELECT row_key FROM meta_plm_collaboration_rows WHERE record_id = $1',
        [admitted.recordId],
      )
      if (JSON.stringify((still.rows[0] as { row_key: unknown }).row_key) !== JSON.stringify(rowKey(admitted))) {
        throw new Error('rejected same-source sync intent rewrote the mapped row key')
      }
    })
  })
})

import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Kysely, Migrator, PostgresDialect, sql, type MigrationProvider, type MigrationResultSet } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { describe, test } from 'vitest'
import { up as foundationUp, down as foundationDown } from '../../src/db/migrations/zzzz20261024010000_create_plm_collaboration_snapshots'
import { up as admitUp, down as admitDown } from '../../src/db/migrations/zzzz20261024020000_admit_plm_readiness_snapshots'
import { up as configRevisionsUp } from '../../src/db/migrations/zzzz20260624120000_create_meta_config_revisions'
import { up as configRevisionSourceUp } from '../../src/db/migrations/zzzz20260624200000_add_config_revision_source'
import { __resetRecoveryWriterStateColumnProbe, fenceWriterEntry } from '../../src/multitable/canonical-sheet-fence'
import { fieldCreateDiff, recordConfigRevision } from '../../src/multitable/config-revision-recorder'
import { __resetOperationLedgerColumnProbe, mintOperation, sealOperation, type OperationLedger } from '../../src/multitable/operation-ledger'
import {
  READINESS_COLLABORATION_COVERAGE_STATUS,
  READINESS_COLLABORATION_LOCAL_FIELDS,
  READINESS_COLLABORATION_SOURCE_FIELDS,
  readinessCollaborationSourceCells,
  type ReadinessCollaborationResource,
  type ReadinessCollaborationSource,
  type ReadinessCollaborationSourceCells,
} from '../../src/multitable/plm-collaboration-readiness-wire'
import {
  ECO_COLLABORATION_ECO_FIELDS,
  ECO_COLLABORATION_LOCAL_FIELDS,
} from '../../src/multitable/plm-collaboration-snapshot-wire'
import { recordRecordRevision } from '../../src/multitable/record-history-service'
import { bootstrapPlmCollaborationSnapshotTestDb } from '../plm-collaboration-snapshot/bootstrap'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for plm readiness collaboration snapshot realdb tests')
}

const DATABASE_URL = process.env.DATABASE_URL
const FAMILY = 'plm_collaboration_source_protected'
const HEX_A = 'a'.repeat(64)
const CAPTURED_AT = '2026-10-24T03:04:05.000000Z'
const NATIVE_AT = '2026-10-24T00:00:00.000000Z'
const FOUNDATION = 'zzzz20261024010000_create_plm_collaboration_snapshots'
const ADMISSION = 'zzzz20261024020000_admit_plm_readiness_snapshots'
const SCAN_TABLES = [
  'meta_fields',
  'meta_records',
  'meta_config_revisions',
  'meta_record_revisions',
  'meta_record_version_markers',
  'meta_record_history_operations',
] as const
const REPLACED = [
  'meta_plm_collaboration_accepted_sync',
  'meta_plm_collaboration_preview_guard',
  'meta_plm_collaboration_binding_guard',
  'meta_plm_collaboration_sync_guard',
]
const HELPERS = [
  'meta_plm_collaboration_readiness_request_id',
  'meta_plm_collaboration_readiness_scope_id',
  'meta_plm_collaboration_readiness_row_key',
  'meta_plm_collaboration_readiness_data_ok',
]
const CHECKS = [
  'meta_plm_collaboration_bindings_maps_check',
  'meta_plm_collaboration_bindings_datasource_check',
  'meta_plm_collaboration_bindings_tenant_check',
  'meta_plm_collaboration_bindings_org_check',
  'meta_plm_collaboration_bindings_item_check',
  'meta_plm_collaboration_bindings_current_version_check',
  'meta_plm_collaboration_previews_datasource_check',
  'meta_plm_collaboration_previews_tenant_check',
  'meta_plm_collaboration_previews_org_check',
  'meta_plm_collaboration_previews_item_check',
  'meta_plm_collaboration_previews_current_version_check',
]

if (READINESS_COLLABORATION_SOURCE_FIELDS.length !== 9) throw new Error('readiness source cell count')
if (READINESS_COLLABORATION_LOCAL_FIELDS.length !== 3) throw new Error('readiness local count')
if (READINESS_COLLABORATION_COVERAGE_STATUS !== 'bounded_not_proven_complete') throw new Error('coverage status')
if (JSON.stringify(ECO_COLLABORATION_LOCAL_FIELDS) !== JSON.stringify(READINESS_COLLABORATION_LOCAL_FIELDS)) {
  throw new Error('readiness and eco local fields diverged')
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

interface Graph {
  actorId: string
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
  rulesetId: string
  ecoId: string
  sourceIds: Record<string, string>
  localIds: Record<string, string>
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
      const message = current instanceof Error ? current.message : String((current as { message?: unknown }).message ?? '')
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
  if (actual.code !== expected.code) throw new Error(`expected SQLSTATE ${expected.code} got ${actual.code}: ${actual.message}`)
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

function queryOf(client: PoolClient) {
  return (text: string, params?: unknown[]) => client.query(text, params)
}

function backendPid(client: PoolClient): number {
  const pid = (client as PoolClient & { processID?: number }).processID
  if (typeof pid !== 'number') throw new Error('postgres backend pid is unavailable')
  return pid
}

function asPidList(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((entry) => Number(entry))
  if (typeof value === 'string') return value.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number)
  return []
}

function provider(): MigrationProvider {
  return {
    async getMigrations() {
      return {
        [FOUNDATION]: { up: foundationUp, down: foundationDown },
        [ADMISSION]: { up: admitUp, down: admitDown },
      }
    },
  }
}

async function migrate(db: Kysely<unknown>, direction: 'foundation' | 'latest' | 'down'): Promise<MigrationResultSet> {
  const migrator = new Migrator({ db, provider: provider() })
  const result = direction === 'foundation'
    ? await migrator.migrateTo(FOUNDATION)
    : direction === 'latest'
      ? await migrator.migrateToLatest()
      : await migrator.migrateDown()
  if (result.error) throw result.error
  return result
}

async function withFixture<T>(
  run: (ctx: Fixture) => Promise<T>,
  options?: { includeBom?: boolean; foundation?: boolean; admit?: boolean },
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
    await bootstrapPlmCollaborationSnapshotTestDb(pool, { includeBom: options?.includeBom === true })
    await configRevisionsUp(db)
    await configRevisionSourceUp(db)
    const current = await pool.query('SELECT current_schema() AS name, current_setting(\'server_encoding\') AS encoding')
    const row = current.rows[0] as { name: string; encoding: string }
    if (row.name !== schema || row.name === 'public') throw new Error(`schema ${row.name} is not the owned fixture`)
    if (row.encoding !== 'UTF8') throw new Error(`server encoding ${row.encoding}`)
    if (options?.foundation !== false) await foundationUp(db)
    if (options?.admit) await admitUp(db)
    return await run({ schema, pool, admin, db })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
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
  absentParams: unknown[] | (() => unknown[]) = [],
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
    const params = typeof absentParams === 'function' ? absentParams() : absentParams
    const left = await client.query(absentSql, params)
    if (Number((left.rows[0] as { n: number }).n) !== 0) throw new Error('failed COMMIT left rows behind')
  } finally {
    try { await client.query('ROLLBACK') } catch { /* the failed COMMIT already ended the transaction */ }
    client.release()
  }
}

async function waitForPidLock(admin: Pool, pid: number): Promise<void> {
  const started = Date.now()
  for (;;) {
    const found = await admin.query('SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1', [pid])
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

async function collaborationTables(pool: Pool, schema: string): Promise<number> {
  const found = await pool.query(
    `SELECT count(*)::int AS n FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1 AND relation.relkind = 'r' AND relation.relname LIKE 'meta_plm_collaboration_%'`,
    [schema],
  )
  return Number((found.rows[0] as { n: number }).n)
}

async function helperCount(pool: Pool, schema: string): Promise<number> {
  const found = await pool.query(
    `SELECT count(*)::int AS n FROM pg_proc proc
      JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
     WHERE namespace.nspname = $1 AND proc.proname = ANY($2::text[])`,
    [schema, HELPERS],
  )
  return Number((found.rows[0] as { n: number }).n)
}

async function catalog(pool: Pool, schema: string): Promise<string> {
  const found = await pool.query(
    `SELECT kind, name, def, oid FROM (
       SELECT 'fn' AS kind, proc.proname AS name, pg_get_functiondef(proc.oid) AS def, proc.oid::text AS oid
         FROM pg_proc proc JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
        WHERE namespace.nspname = $1 AND proc.proname LIKE 'meta_plm_collaboration_%'
       UNION ALL
       SELECT 'ck', constraint_row.conname, pg_get_constraintdef(constraint_row.oid), constraint_row.oid::text
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1 AND constraint_row.contype = 'c' AND constraint_row.conname LIKE 'meta_plm_collaboration_%'
       UNION ALL
       SELECT 'tg', tg.tgname, pg_get_triggerdef(tg.oid), tg.oid::text
         FROM pg_trigger tg
         JOIN pg_class relation ON relation.oid = tg.tgrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1 AND NOT tg.tgisinternal AND tg.tgname LIKE 'meta_plm_collaboration_%'
       UNION ALL
       SELECT 'fk', constraint_row.conname, pg_get_constraintdef(constraint_row.oid), constraint_row.oid::text
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1 AND constraint_row.contype = 'f' AND constraint_row.conname LIKE 'meta_plm_collaboration_%'
       UNION ALL
       SELECT 'rel', relation.relname, relation.relkind::text, relation.oid::text
         FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1 AND relation.relkind = 'r' AND relation.relname LIKE 'meta_plm_collaboration_%'
     ) rows
     ORDER BY 1, 2`,
    [schema],
  )
  return JSON.stringify(found.rows)
}

function assertRestoredCatalog(before: string, after: string): void {
  const left = JSON.parse(before) as Array<{ kind: string; name: string; def: string; oid: string }>
  const right = JSON.parse(after) as Array<{ kind: string; name: string; def: string; oid: string }>
  if (left.length !== right.length) throw new Error(`restored catalog row count ${left.length} vs ${right.length}`)
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]
    const next = right[index]
    if (!previous || !next || previous.kind !== next.kind || previous.name !== next.name || previous.def !== next.def) {
      throw new Error(`restored catalog drifted at ${previous?.kind ?? '?'}:${previous?.name ?? '?'}`)
    }
    // DROP CONSTRAINT and ADD CONSTRAINT allocate a new OID. The eleven replaced checks are compared by definition.
    const replacedCheck = previous.kind === 'ck' && CHECKS.includes(previous.name)
    if (!replacedCheck && previous.oid !== next.oid) {
      throw new Error(`restored oid drifted at ${previous.kind}:${previous.name}`)
    }
  }
}

async function evidenceCounts(pool: Pool): Promise<string> {
  const found = await pool.query(`
    SELECT
      (SELECT count(*) FROM meta_plm_collaboration_previews) AS previews,
      (SELECT count(*) FROM meta_plm_collaboration_bindings) AS bindings,
      (SELECT count(*) FROM meta_plm_collaboration_rows) AS rows,
      (SELECT count(*) FROM meta_plm_collaboration_syncs) AS syncs,
      (SELECT count(*) FROM meta_records) AS records,
      (SELECT count(*) FROM meta_record_revisions) AS revisions,
      (SELECT count(*) FROM meta_config_revisions) AS config_revisions,
      (SELECT count(*) FROM meta_fields) AS fields`)
  return JSON.stringify(found.rows[0])
}

async function expectEvidenceRefusal(ctx: Fixture): Promise<void> {
  const before = await evidenceCounts(ctx.pool)
  const tables = await collaborationTables(ctx.pool, ctx.schema)
  let failed: unknown
  try {
    await admitDown(ctx.db)
  } catch (error) {
    failed = error
  }
  assertPg(failed, {
    code: '23514',
    constraint: 'meta_plm_collaboration_evidence_guard',
    message: 'plm_collaboration_readiness_evidence_present',
  })
  if (await evidenceCounts(ctx.pool) !== before) throw new Error('evidence refusal changed counted rows')
  if (await collaborationTables(ctx.pool, ctx.schema) !== tables) throw new Error('evidence refusal dropped a collaboration table')
}

function graph(kind: 'eco' | 'readiness'): Graph {
  const prefix = randomBytes(4).toString('hex')
  const keys = kind === 'eco' ? ECO_COLLABORATION_ECO_FIELDS : READINESS_COLLABORATION_SOURCE_FIELDS
  const sourceIds: Record<string, string> = {}
  for (const key of keys) sourceIds[key] = `${prefix}_s_${key}`
  const localIds: Record<string, string> = {}
  for (const field of READINESS_COLLABORATION_LOCAL_FIELDS) localIds[field.key] = `${prefix}_l_${field.key}`
  return {
    actorId: `user_${prefix}`,
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
    rulesetId: `rules_${prefix}`,
    ecoId: `eco_${prefix}`,
    sourceIds,
    localIds,
  }
}

async function insertContainer(client: PoolClient, row: Graph): Promise<void> {
  await client.query('INSERT INTO users (id, is_active) VALUES ($1, true)', [row.actorId])
  await client.query(
    'INSERT INTO meta_bases (id, owner_id, name, workspace_id) VALUES ($1, $2, $3, $4)',
    [row.baseId, row.actorId, 'collaboration base', `ws_${row.actorId}`],
  )
  await client.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [row.sheetId, row.baseId, 'collaboration sheet'])
  await client.query(
    'INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)',
    [row.viewId, row.sheetId, 'Grid', 'grid'],
  )
}

async function insertFields(client: PoolClient, row: Graph, kind: 'eco' | 'readiness'): Promise<void> {
  const keys = kind === 'eco' ? ECO_COLLABORATION_ECO_FIELDS : READINESS_COLLABORATION_SOURCE_FIELDS
  let order = 1
  for (const key of keys) {
    await client.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, $3, 'string', $4::jsonb, $5)`,
      [row.sourceIds[key], row.sheetId, key, JSON.stringify({
        readOnly: true,
        plmCollaborationSnapshot: { source: true, key },
      }), order],
    )
    order += 1
  }
  for (const field of READINESS_COLLABORATION_LOCAL_FIELDS) {
    await client.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
      [row.localIds[field.key], row.sheetId, field.key, field.type, order],
    )
    order += 1
  }
}

function ecoData(row: Graph): Record<string, unknown> {
  const logical: Record<string, unknown> = {
    id: row.ecoId,
    name: 'Pump housing',
    eco_type: 'design',
    product_id: row.itemId,
    source_version_id: null,
    target_version_id: null,
    stage_id: null,
    state: null,
    kanban_state: null,
    priority: null,
    updated_at: NATIVE_AT,
  }
  const data: Record<string, unknown> = {}
  for (const key of ECO_COLLABORATION_ECO_FIELDS) data[row.sourceIds[key]] = logical[key]
  return data
}

function resource(input: {
  kind: ReadinessCollaborationResource['kind']
  resource_type: ReadinessCollaborationResource['resource_type']
  resource_id: string
  name?: string | null
  state?: string | null
  errors?: ReadinessCollaborationResource['errors']
  warnings?: ReadinessCollaborationResource['warnings']
}): ReadinessCollaborationResource {
  return {
    kind: input.kind,
    resource_type: input.resource_type,
    resource_id: input.resource_id,
    name: input.name === undefined ? 'name' : input.name,
    state: input.state === undefined ? 'state' : input.state,
    errors: input.errors ?? [],
    warnings: input.warnings ?? [],
  }
}

function readinessSource(row: Pick<Graph, 'itemId' | 'rulesetId' | 'tenantId' | 'orgId'>, resources: ReadinessCollaborationResource[]): ReadinessCollaborationSource {
  let errorCount = 0
  let warningCount = 0
  let okResources = 0
  for (const entry of resources) {
    errorCount += entry.errors.length
    warningCount += entry.warnings.length
    if (entry.errors.length === 0) okResources += 1
  }
  return {
    projection_contract: 'release_readiness_collaboration_source.v1',
    feature_key: 'collaboration_source_read',
    entitled: true,
    source: {
      tenant_id: row.tenantId,
      org_id: row.orgId,
      item_id: row.itemId,
      current_version_id: null,
    },
    snapshot_at: CAPTURED_AT,
    readiness: {
      item_id: row.itemId,
      ruleset_id: row.rulesetId,
      generated_at: CAPTURED_AT,
      coverage_status: READINESS_COLLABORATION_COVERAGE_STATUS,
      summary: {
        resources: resources.length,
        ok_resources: okResources,
        error_count: errorCount,
        warning_count: warningCount,
      },
      resources,
    },
  }
}

function readinessCells(row: Graph, resources: ReadinessCollaborationResource[] = []): ReadinessCollaborationSourceCells {
  return readinessCollaborationSourceCells(readinessSource(row, resources))
}

function readinessData(row: Graph, cells: ReadinessCollaborationSourceCells): Record<string, string> {
  const data: Record<string, string> = {}
  for (const key of READINESS_COLLABORATION_SOURCE_FIELDS) data[row.sourceIds[key]] = cells[key]
  return data
}

async function insertBinding(client: PoolClient, row: Graph, kind: 'eco' | 'readiness', maps?: { source: unknown; local: unknown }): Promise<void> {
  await client.query(
    `INSERT INTO meta_plm_collaboration_bindings (
       id, creator_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
       current_version_id, source_fingerprint, base_id, sheet_id, view_id, name,
       source_fields, local_fields, version, status
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, 1, 'active'
     )`,
    [
      row.bindingId, row.actorId, row.dataSourceId, kind, row.tenantId, row.orgId, row.itemId,
      row.versionId, HEX_A, row.baseId, row.sheetId, row.viewId,
      kind === 'eco' ? 'ECO collaboration' : 'Readiness collaboration',
      JSON.stringify(maps?.source ?? row.sourceIds), JSON.stringify(maps?.local ?? row.localIds),
    ],
  )
}

async function insertPreview(
  client: PoolClient,
  row: Graph,
  kind: 'eco' | 'readiness',
  patch?: {
    id?: string
    dataSourceId?: string
    tenantId?: string
    orgId?: string
    itemId?: string
    versionId?: string | null
    rowKey?: unknown
    bindingId?: string | null
    requestId?: string | null
    consumedAt?: string | null
    createdAt?: string
    expiresAt?: string
  },
): Promise<void> {
  const itemId = patch?.itemId ?? row.itemId
  const rowKey = patch?.rowKey ?? (kind === 'eco'
    ? [patch?.dataSourceId ?? row.dataSourceId, patch?.tenantId ?? row.tenantId, patch?.orgId ?? row.orgId, row.ecoId]
    : [patch?.dataSourceId ?? row.dataSourceId, patch?.tenantId ?? row.tenantId, patch?.orgId ?? row.orgId, itemId, row.rulesetId])
  await client.query(
    `INSERT INTO meta_plm_collaboration_previews (
       id, actor_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
       current_version_id, base_id, name, row_key, source_fingerprint, business_hash,
       captured_at, created_at, expires_at, request_id, binding_id, consumed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, 'preview', $10::jsonb, $11, $11,
       $12::timestamptz, $13::timestamptz, $14::timestamptz, $15, $16, $17::timestamptz
     )`,
    [
      patch?.id ?? randomUUID(), row.actorId, patch?.dataSourceId ?? row.dataSourceId, kind,
      patch?.tenantId ?? row.tenantId, patch?.orgId ?? row.orgId, itemId,
      patch && 'versionId' in patch ? patch.versionId : row.versionId,
      row.baseId, JSON.stringify(rowKey), HEX_A, CAPTURED_AT,
      patch?.createdAt ?? '2026-10-23T00:00:00Z', patch?.expiresAt ?? '2026-10-25T00:00:00Z',
      patch?.requestId ?? null, patch?.bindingId ?? null, patch?.consumedAt ?? null,
    ],
  )
}

async function insertEcoGraph(client: PoolClient, row = graph('eco')): Promise<Graph> {
  await insertContainer(client, row)
  await insertFields(client, row, 'eco')
  await insertBinding(client, row, 'eco')
  const data = ecoData(row)
  await client.query(
    `INSERT INTO meta_plm_collaboration_syncs (id, binding_id, actor_id, binding_version, patches)
     VALUES ($1, $2, $3, 1, $4::jsonb)`,
    [row.syncId, row.bindingId, row.actorId, JSON.stringify({
      [row.recordId]: {
        row_key: [row.dataSourceId, row.tenantId, row.orgId, row.ecoId],
        data,
        business_hash: HEX_A,
        captured_at: CAPTURED_AT,
      },
    })],
  )
  await client.query(`SELECT set_config('metasheet.plm_collaboration_sync', $1, true)`, [row.syncId])
  await client.query(
    `INSERT INTO meta_plm_collaboration_rows (binding_id, row_key, record_id, business_hash, captured_at)
     VALUES ($1, $2::jsonb, $3, $4, $5::timestamptz)`,
    [row.bindingId, JSON.stringify([row.dataSourceId, row.tenantId, row.orgId, row.ecoId]), row.recordId, HEX_A, CAPTURED_AT],
  )
  await client.query(
    `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, locked, locked_by)
     VALUES ($1, $2, $3::jsonb, 1, $4, $4, false, null)`,
    [row.recordId, row.sheetId, JSON.stringify(data), row.actorId],
  )
  await insertPreview(client, row, 'eco')
  const markerKey = ECO_COLLABORATION_ECO_FIELDS[0]
  const diff = fieldCreateDiff({
    name: markerKey,
    type: 'string',
    order: 1,
    property: { readOnly: true, plmCollaborationSnapshot: { source: true, key: markerKey } },
  })
  await recordConfigRevision(queryOf(client), {
    sheetId: row.sheetId,
    entityType: 'field',
    entityId: row.sourceIds[markerKey],
    action: 'create',
    before: diff.before,
    after: diff.after,
    changedKeys: diff.changedKeys,
    batchId: null,
    actorId: row.actorId,
  })
  return row
}

async function insertReadinessGraph(client: PoolClient, row = graph('readiness')): Promise<Graph> {
  await insertContainer(client, row)
  await insertFields(client, row, 'readiness')
  await insertBinding(client, row, 'readiness')
  return row
}

function readinessPatch(row: Graph, data: Record<string, unknown>, recordId = row.recordId): Record<string, unknown> {
  return {
    [recordId]: {
      row_key: [row.dataSourceId, row.tenantId, row.orgId, row.itemId, row.rulesetId],
      data,
      business_hash: HEX_A,
      captured_at: CAPTURED_AT,
    },
  }
}

async function insertReadinessSync(client: PoolClient, row: Graph, data: Record<string, unknown>, syncId = row.syncId, bindingVersion = 1): Promise<void> {
  await client.query(
    `INSERT INTO meta_plm_collaboration_syncs (id, binding_id, actor_id, binding_version, patches)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [syncId, row.bindingId, row.actorId, bindingVersion, JSON.stringify(readinessPatch(row, data))],
  )
}

async function insertAttributedReadinessRow(client: PoolClient, row: Graph, rulesetSuffix: string, recordId: string): Promise<void> {
  const variant: Graph = { ...row, rulesetId: `${row.rulesetId}${rulesetSuffix}`, recordId, syncId: randomUUID() }
  const data = readinessData(row, readinessCells(variant))
  await insertReadinessSync(client, variant, data, variant.syncId)
  await client.query(`SELECT set_config('metasheet.plm_collaboration_sync', $1, true)`, [variant.syncId])
  await client.query(
    `INSERT INTO meta_plm_collaboration_rows (binding_id, row_key, record_id, business_hash, captured_at)
     VALUES ($1, $2::jsonb, $3, $4, $5::timestamptz)`,
    [row.bindingId, JSON.stringify([row.dataSourceId, row.tenantId, row.orgId, row.itemId, variant.rulesetId]), recordId, HEX_A, CAPTURED_AT],
  )
}

async function publishReadiness(client: PoolClient, row: Graph, ledger: OperationLedger | null): Promise<void> {
  const cells = readinessCells(row)
  const data = readinessData(row, cells)
  await insertReadinessSync(client, row, data)
  await client.query(`SELECT set_config('metasheet.plm_collaboration_sync', $1, true)`, [row.syncId])
  await client.query(
    `INSERT INTO meta_plm_collaboration_rows (binding_id, row_key, record_id, business_hash, captured_at)
     VALUES ($1, $2::jsonb, $3, $4, $5::timestamptz)`,
    [row.bindingId, JSON.stringify([row.dataSourceId, row.tenantId, row.orgId, row.itemId, row.rulesetId]), row.recordId, HEX_A, CAPTURED_AT],
  )
  await client.query(
    `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, locked, locked_by)
     VALUES ($1, $2, $3::jsonb, 1, $4, $4, false, null)`,
    [row.recordId, row.sheetId, JSON.stringify(data), row.actorId],
  )
  await recordRecordRevision(queryOf(client), {
    sheetId: row.sheetId,
    recordId: row.recordId,
    version: 1,
    action: 'create',
    source: 'system_sync',
    actorId: row.actorId,
    changedFieldIds: Object.values(row.sourceIds),
    patch: data,
    snapshot: data,
    ledger,
  })
}

async function withWriterFence<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.MULTITABLE_ENABLE_WRITER_FENCE
  process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
  __resetOperationLedgerColumnProbe()
  __resetRecoveryWriterStateColumnProbe()
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    else process.env.MULTITABLE_ENABLE_WRITER_FENCE = previous
    __resetOperationLedgerColumnProbe()
    __resetRecoveryWriterStateColumnProbe()
  }
}

async function selectBoolean(pool: Pool, text: string, params: unknown[] = []): Promise<boolean | null> {
  const found = await pool.query(text, params)
  const value = (found.rows[0] as { ok: boolean | null }).ok
  return value
}

async function dataOk(pool: Pool, itemId: string, rulesetId: string, cells: Record<string, unknown>): Promise<boolean | null> {
  const fields = Object.fromEntries(READINESS_COLLABORATION_SOURCE_FIELDS.map((key) => [key, key]))
  return selectBoolean(
    pool,
    `SELECT meta_plm_collaboration_readiness_data_ok($1, $2, $3::jsonb, $4::jsonb) AS ok`,
    [itemId, rulesetId, JSON.stringify(fields), JSON.stringify(cells)],
  )
}

describe('D01 schema transaction restore', () => {
  test('migrator rollback and eco populated restore keep the foundation catalog', async () => {
    await withFixture(async (ctx) => {
      const first = await migrate(ctx.db, 'foundation')
      if (!first.results?.some((row) => row.migrationName === FOUNDATION && row.status === 'Success')) {
        throw new Error('migrator did not apply the foundation')
      }
      if (await collaborationTables(ctx.pool, ctx.schema) !== 4) throw new Error('foundation did not create four tables')
      if (await helperCount(ctx.pool, ctx.schema) !== 0) throw new Error('foundation created a readiness helper')
      const foundationCatalog = await catalog(ctx.pool, ctx.schema)
      let rolled: unknown
      try {
        await ctx.db.transaction().execute(async (trx) => {
          await admitUp(trx)
          throw new Error('caller rollback')
        })
      } catch (error) {
        rolled = error
      }
      if (!(rolled instanceof Error) || rolled.message !== 'caller rollback') throw rolled ?? new Error('caller rollback missing')
      if (await catalog(ctx.pool, ctx.schema) !== foundationCatalog) throw new Error('caller rollback drifted from the foundation catalog')
      let shape: unknown
      try {
        await admitDown(ctx.db)
      } catch (error) {
        shape = error
      }
      assertPg(shape, {
        code: '23514',
        constraint: 'meta_plm_collaboration_predecessor_guard',
        message: 'plm_collaboration_admission_shape_invalid',
      })
      if (await collaborationTables(ctx.pool, ctx.schema) !== 4) throw new Error('foundation-only down dropped a table')
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        await insertEcoGraph(client)
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      const populated = await evidenceCounts(ctx.pool)
      const forward = await migrate(ctx.db, 'latest')
      if (!forward.results?.some((row) => row.migrationName === ADMISSION && row.status === 'Success')) {
        throw new Error('migrator did not apply readiness admission')
      }
      if (await helperCount(ctx.pool, ctx.schema) !== 4) throw new Error('admission helper count')
      if (await evidenceCounts(ctx.pool) !== populated) throw new Error('forward changed ECO contents')
      const restored = await migrate(ctx.db, 'down')
      if (!restored.results?.some((row) => row.migrationName === ADMISSION && row.direction === 'Down')) {
        throw new Error('migrator down did not reverse readiness admission')
      }
      if (await helperCount(ctx.pool, ctx.schema) !== 0) throw new Error('down left a readiness helper')
      if (await collaborationTables(ctx.pool, ctx.schema) !== 4) throw new Error('down dropped a collaboration table')
      if (await evidenceCounts(ctx.pool) !== populated) throw new Error('down changed ECO contents')
      assertRestoredCatalog(foundationCatalog, await catalog(ctx.pool, ctx.schema))
      const defs = await ctx.pool.query(
        `SELECT proc.proname FROM pg_proc proc
          JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
         WHERE namespace.nspname = $1 AND proc.proname = ANY($2::text[])`,
        [ctx.schema, REPLACED],
      )
      if (defs.rows.length !== 4) throw new Error('restored function inventory')
    }, { foundation: false })
  })
})

describe('D02 id and scope parity', () => {
  test('request scope row key and preview checks keep both policies', async () => {
    await withFixture(async (ctx) => {
      const request = async (value: string | null) => selectBoolean(ctx.pool, 'SELECT meta_plm_collaboration_readiness_request_id($1) AS ok', [value])
      const scope = async (value: string | null) => selectBoolean(ctx.pool, 'SELECT meta_plm_collaboration_readiness_scope_id($1) AS ok', [value])
      if (await request(null) !== false || await request('') !== false) throw new Error('null or empty request id')
      if (await scope(null) !== false || await scope('') !== false) throw new Error('null or empty scope id')
      if (await request(`${'\uFEFF'}item`) !== true) throw new Error('FEFF request boundary')
      if (await scope(`${'\uFEFF'}tenant`) !== false) throw new Error('FEFF scope boundary')
      if (await scope(`${'\u00A0'}tenant`) !== false || await request(`${'\u00A0'}item`) !== false) throw new Error('NBSP boundary')
      if (await request(`${'\u001C'}item`) !== false || await scope(`${'\u001C'}tenant`) !== true) throw new Error('U+001C policy')
      if (await request(`${'\u0085'}item`) !== false || await scope(`${'\u0085'}tenant`) !== true) throw new Error('U+0085 policy')
      if (await request('ab\ncd') !== true || await scope('ab\ncd') !== false) throw new Error('interior LF policy')
      if (await request('\titem') !== false) throw new Error('tab request boundary')
      if (await request('😀'.repeat(128)) !== true || await request('😀'.repeat(129)) !== false) throw new Error('astral request length')
      if (await scope('s'.repeat(64)) !== true || await scope('s'.repeat(65)) !== false) throw new Error('scope length')
      const ready = graph('readiness')
      const ruleset = await ctx.pool.query(
        `SELECT meta_plm_collaboration_readiness_row_key($1::jsonb, $2, $3, $4, $5) AS ruleset`,
        [JSON.stringify([ready.dataSourceId, ready.tenantId, ready.orgId, ready.itemId, ready.rulesetId]), ready.dataSourceId, ready.tenantId, ready.orgId, ready.itemId],
      )
      if ((ruleset.rows[0] as { ruleset: string | null }).ruleset !== ready.rulesetId) throw new Error('row key did not return the ruleset')
      for (const tuple of [
        [ready.dataSourceId, ready.tenantId, ready.orgId, ready.itemId],
        [ready.dataSourceId, ready.tenantId, ready.orgId, ready.itemId, ready.rulesetId, 'extra'],
        [1, ready.tenantId, ready.orgId, ready.itemId, ready.rulesetId],
        ['other', ready.tenantId, ready.orgId, ready.itemId, ready.rulesetId],
        [ready.dataSourceId, 'other', ready.orgId, ready.itemId, ready.rulesetId],
        [ready.dataSourceId, ready.tenantId, 'other', ready.itemId, ready.rulesetId],
        [ready.dataSourceId, ready.tenantId, ready.orgId, 'other', ready.rulesetId],
      ]) {
        const found = await ctx.pool.query(
          `SELECT meta_plm_collaboration_readiness_row_key($1::jsonb, $2, $3, $4, $5) AS ruleset`,
          [JSON.stringify(tuple), ready.dataSourceId, ready.tenantId, ready.orgId, ready.itemId],
        )
        if ((found.rows[0] as { ruleset: string | null }).ruleset !== null) throw new Error(`row key accepted ${JSON.stringify(tuple)}`)
      }
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        await insertReadinessGraph(client, ready)
        await insertPreview(client, ready, 'readiness', { dataSourceId: 'ds\ninner', rowKey: ['ds\ninner', ready.tenantId, ready.orgId, ready.itemId, ready.rulesetId] })
        await insertPreview(client, ready, 'readiness', { versionId: null })
        await insertPreview(client, ready, 'readiness', { versionId: `\uFEFF${ready.versionId}` })
        await insertPreview(client, ready, 'readiness', { itemId: '😀'.repeat(128), rowKey: [ready.dataSourceId, ready.tenantId, ready.orgId, '😀'.repeat(128), ready.rulesetId] })
        await insertPreview(client, ready, 'readiness', { tenantId: `\u001C${ready.tenantId}`, rowKey: [ready.dataSourceId, `\u001C${ready.tenantId}`, ready.orgId, ready.itemId, ready.rulesetId] })
        const eco = graph('eco')
        await insertContainer(client, eco)
        await insertFields(client, eco, 'eco')
        await insertBinding(client, eco, 'eco')
        await insertPreview(client, eco, 'eco', { dataSourceId: `\t${eco.dataSourceId}`, rowKey: [`\t${eco.dataSourceId}`, eco.tenantId, eco.orgId, eco.ecoId] })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await expectAbort(ctx.pool, (db) => insertPreview(db, ready, 'readiness', {
        dataSourceId: `\t${ready.dataSourceId}`,
        rowKey: [`\t${ready.dataSourceId}`, ready.tenantId, ready.orgId, ready.itemId, ready.rulesetId],
      }), { code: '23514', constraint: 'meta_plm_collaboration_preview_guard', message: FAMILY })
      const ecoLf = graph('eco')
      const ecoClient = await ctx.pool.connect()
      try {
        await ecoClient.query('BEGIN')
        await insertContainer(ecoClient, ecoLf)
        await insertFields(ecoClient, ecoLf, 'eco')
        await insertBinding(ecoClient, ecoLf, 'eco')
        await ecoClient.query('COMMIT')
      } finally {
        ecoClient.release()
      }
      await expectAbort(ctx.pool, (db) => insertPreview(db, ecoLf, 'eco', {
        dataSourceId: 'eco\nid',
        rowKey: ['eco\nid', ecoLf.tenantId, ecoLf.orgId, ecoLf.ecoId],
      }), { code: '23514', constraint: 'meta_plm_collaboration_previews_datasource_check' })
      await expectAbort(ctx.pool, (db) => insertPreview(db, ready, 'readiness', {
        versionId: '',
      }), { code: '23514', constraint: 'meta_plm_collaboration_previews_current_version_check' })
      const defs = await ctx.pool.query(
        `SELECT constraint_row.conname, pg_get_constraintdef(constraint_row.oid) AS def
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid = constraint_row.conrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = $1 AND constraint_row.conname = ANY($2::text[])`,
        [ctx.schema, CHECKS],
      )
      if (defs.rows.length !== 11) throw new Error('eleven check inventory')
      for (const definition of defs.rows as Array<{ conname: string; def: string }>) {
        if (definition.conname.endsWith('_maps_check')) {
          if (!definition.def.includes('jsonb_path_exists') || definition.def.includes('jsonb_each_text')) {
            throw new Error('maps check does not use the typed jsonpath')
          }
        } else if (!definition.def.includes('btrim') || !definition.def.includes('chr(10)') || !definition.def.includes('meta_plm_collaboration_readiness_')) {
          throw new Error(`${definition.conname} lost an ECO or readiness branch`)
        }
      }
    }, { admit: true })
  })
})

describe('D03 map type readonly and generic guards', () => {
  test('exact readiness map admits and each bypass aborts', async () => {
    await withFixture(async (ctx) => {
      const row = graph('readiness')
      const extraId = `${row.actorId}_extra`
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        await insertContainer(client, row)
        await insertFields(client, row, 'readiness')
        await client.query(
          `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1, $2, 'extra', 'string', $3::jsonb, 30)`,
          [extraId, row.sheetId, JSON.stringify({ readOnly: true, plmCollaborationSnapshot: { source: true, key: 'extra' } })],
        )
        await client.query(
          `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ('123', $1, 'item_id', 'string', $2::jsonb, 31)`,
          [row.sheetId, JSON.stringify({ readOnly: true, plmCollaborationSnapshot: { source: true, key: 'item_id' } })],
        )
        await insertBinding(client, row, 'readiness')
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      const omitted = { ...row.sourceIds }
      delete omitted.item_id
      await expectAbort(ctx.pool, (db) => insertBinding(db, { ...row, bindingId: randomUUID(), sheetId: row.sheetId }, 'readiness', { source: omitted, local: row.localIds }), {
        code: '23514',
        constraint: 'meta_plm_collaboration_bindings_maps_check',
      })
      await expectAbort(ctx.pool, (db) => insertBinding(db, { ...row, bindingId: randomUUID() }, 'readiness', {
        source: { ...row.sourceIds, extra: extraId },
        local: row.localIds,
      }), { code: '23514', constraint: 'meta_plm_collaboration_bindings_maps_check' })
      const numeric = { ...row.sourceIds, item_id: 123 }
      await expectAbort(ctx.pool, (db) => insertBinding(db, { ...row, bindingId: randomUUID() }, 'readiness', {
        source: numeric,
        local: row.localIds,
      }), { code: '23514', constraint: 'meta_plm_collaboration_bindings_maps_check' })
      await expectAbort(ctx.pool, (db) => insertBinding(db, { ...row, bindingId: randomUUID() }, 'readiness', {
        source: { ...row.sourceIds, item_id: null },
        local: row.localIds,
      }), { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: FAMILY })
      await expectAbort(ctx.pool, (db) => insertBinding(db, { ...row, bindingId: randomUUID() }, 'readiness', {
        source: row.sourceIds,
        local: { ...row.localIds, collaboration_owner: row.sourceIds.item_id },
      }), { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: FAMILY })
      const otherSheet = `${row.sheetId}_other`
      const otherView = `${row.viewId}_other`
      const otherField = `${row.actorId}_other_item`
      const other = await ctx.pool.connect()
      try {
        await other.query('BEGIN')
        await other.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [otherSheet, row.baseId, 'other'])
        await other.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [otherView, otherSheet, 'Grid', 'grid'])
        await other.query(
          `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1, $2, 'item_id', 'string', $3::jsonb, 1)`,
          [otherField, otherSheet, JSON.stringify({ readOnly: true, plmCollaborationSnapshot: { source: true, key: 'item_id' } })],
        )
        await other.query('COMMIT')
      } finally {
        other.release()
      }
      await expectAbort(ctx.pool, (db) => insertBinding(db, { ...row, bindingId: randomUUID() }, 'readiness', {
        source: { ...row.sourceIds, item_id: otherField },
        local: row.localIds,
      }), { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: FAMILY })
      // The committed binding owns the sheet, so field_guard blocks a later field insert. Field-shape refusals use a fresh sheet.
      const fresh = async (mutate: (copy: Graph, client: PoolClient) => Promise<void>) => {
        const copy = graph('readiness')
        await expectAbort(ctx.pool, async (db) => {
          await insertContainer(db, copy)
          await insertFields(db, copy, 'readiness')
          await mutate(copy, db)
          await insertBinding(db, copy, 'readiness')
        }, { code: '23514', constraint: 'meta_plm_collaboration_binding_guard', message: FAMILY })
      }
      await fresh(async (copy, db) => {
        await db.query('UPDATE meta_fields SET type = \'text\' WHERE id = $1', [copy.sourceIds.item_id])
      })
      await fresh(async (copy, db) => {
        await db.query(
          `UPDATE meta_fields SET property = $2::jsonb WHERE id = $1`,
          [copy.sourceIds.item_id, JSON.stringify({ readOnly: false, plmCollaborationSnapshot: { source: true, key: 'item_id' } })],
        )
      })
      await fresh(async (copy, db) => {
        await db.query(
          `UPDATE meta_fields SET property = $2::jsonb WHERE id = $1`,
          [copy.sourceIds.item_id, JSON.stringify({ readOnly: true, readonly: false, plmCollaborationSnapshot: { source: true, key: 'item_id' } })],
        )
      })
      await fresh(async (copy, db) => {
        await db.query(
          `UPDATE meta_fields SET property = $2::jsonb WHERE id = $1`,
          [copy.sourceIds.item_id, JSON.stringify({ readOnly: true, plmCollaborationSnapshot: { source: true, key: 'other' } })],
        )
      })
      await fresh(async (copy, db) => {
        await db.query('UPDATE meta_fields SET type = \'string\' WHERE id = $1', [copy.localIds.collaboration_owner])
      })
      const cells = readinessCells(row)
      const data = readinessData(row, cells)
      for (const key of READINESS_COLLABORATION_SOURCE_FIELDS) {
        for (const value of [null, 1, { bad: true }, ['bad']]) {
          const mutated = { ...data, [row.sourceIds[key]]: value }
          await expectAbort(ctx.pool, (db) => insertReadinessSync(db, row, mutated, randomUUID()), {
            code: '23514',
            constraint: 'meta_plm_collaboration_sync_guard',
            message: FAMILY,
          })
        }
      }
    }, { admit: true })
  })

  test('field and sheet locks are observable and generic refusals abort', async () => {
    await withFixture(async (ctx) => {
      const row = graph('readiness')
      const setup = await ctx.pool.connect()
      try {
        await setup.query('BEGIN')
        await insertContainer(setup, row)
        await insertFields(setup, row, 'readiness')
        await setup.query('COMMIT')
      } finally {
        setup.release()
      }
      const holder = await ctx.pool.connect()
      const inserter = await ctx.pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM meta_fields WHERE id = $1 FOR UPDATE', [row.sourceIds.item_id])
        const pending = inserter.query('BEGIN').then(() => insertBinding(inserter, row, 'readiness')).then(
          () => ({ failed: false as const }),
          (error: unknown) => ({ failed: true as const, error }),
        )
        await waitForPidLock(ctx.admin, backendPid(inserter))
        const blockers = await ctx.admin.query('SELECT pg_blocking_pids($1) AS pids', [backendPid(inserter)])
        if (!asPidList((blockers.rows[0] as { pids: unknown }).pids).includes(backendPid(holder))) {
          throw new Error('readiness binding insert was not blocked by the field lock')
        }
        await holder.query('ROLLBACK')
        const finished = await pending
        if (finished.failed) throw finished.error
        await inserter.query('ROLLBACK')
      } finally {
        holder.release()
        inserter.release()
      }
      const sheetHolder = await ctx.pool.connect()
      const sheetInserter = await ctx.pool.connect()
      const second = graph('readiness')
      second.baseId = row.baseId
      second.sheetId = `${row.sheetId}_b`
      second.viewId = `${row.viewId}_b`
      second.actorId = row.actorId
      const prepare = await ctx.pool.connect()
      try {
        await prepare.query('BEGIN')
        await prepare.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [second.sheetId, row.baseId, 'second'])
        await prepare.query('INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)', [second.viewId, second.sheetId, 'Grid', 'grid'])
        await insertFields(prepare, second, 'readiness')
        await prepare.query('COMMIT')
      } finally {
        prepare.release()
      }
      try {
        await sheetHolder.query('BEGIN')
        await sheetHolder.query('SELECT id FROM meta_sheets WHERE id = $1 FOR NO KEY UPDATE', [second.sheetId])
        const pending = sheetInserter.query('BEGIN').then(() => insertBinding(sheetInserter, second, 'readiness')).then(
          () => ({ failed: false as const }),
          (error: unknown) => ({ failed: true as const, error }),
        )
        await waitForPidLock(ctx.admin, backendPid(sheetInserter))
        const blockers = await ctx.admin.query('SELECT pg_blocking_pids($1) AS pids', [backendPid(sheetInserter)])
        if (!asPidList((blockers.rows[0] as { pids: unknown }).pids).includes(backendPid(sheetHolder))) {
          throw new Error('readiness binding insert was not blocked by the sheet lock')
        }
        await sheetHolder.query('ROLLBACK')
        const finished = await pending
        if (finished.failed) throw finished.error
        await sheetInserter.query('ROLLBACK')
      } finally {
        sheetHolder.release()
        sheetInserter.release()
      }
      const bound = await ctx.pool.connect()
      try {
        await bound.query('BEGIN')
        await insertBinding(bound, row, 'readiness')
        await bound.query('COMMIT')
      } finally {
        bound.release()
      }
      await expectAbort(ctx.pool, (db) => db.query('DELETE FROM meta_fields WHERE id = $1', [row.sourceIds.item_id]), {
        code: '23514',
        constraint: 'meta_plm_collaboration_field_guard',
        message: FAMILY,
      })
      await expectAbort(ctx.pool, (db) => db.query('DELETE FROM meta_sheets WHERE id = $1', [row.sheetId]), {
        code: '23514',
        constraint: 'meta_plm_collaboration_container_guard',
        message: FAMILY,
      })
    }, { admit: true })
  })

  test('bom coexistence truncate sync and record delete refuse', async () => {
    await withFixture(async (ctx) => {
      const row = graph('readiness')
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        await insertContainer(client, row)
        await insertFields(client, row, 'readiness')
        await client.query(
          `INSERT INTO meta_plm_bom_review_bindings (
             id, data_source_id, part_id, creator_id, source_fingerprint, source, base_id, sheet_id, view_id,
             name, fields, version, status, snapshot_hash, last_synced_at, line_count, occurrence_count
           ) VALUES ($1, 'ds', 'part', $2, $3, '{}'::jsonb, $4, $5, $6, 'overlap', '{}'::jsonb, 1, 'active', $3, now(), 0, 0)`,
          [randomUUID(), row.actorId, HEX_A, row.baseId, row.sheetId, row.viewId],
        )
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await expectAbort(ctx.pool, (db) => insertBinding(db, row, 'readiness'), {
        code: '23514',
        constraint: 'meta_plm_collaboration_binding_guard',
        message: FAMILY,
      })
      const published = graph('readiness')
      const writer = await ctx.pool.connect()
      try {
        await writer.query('BEGIN')
        await insertReadinessGraph(writer, published)
        await insertReadinessSync(writer, published, readinessData(published, readinessCells(published)))
        await writer.query(`SELECT set_config('metasheet.plm_collaboration_sync', $1, true)`, [published.syncId])
        await writer.query(
          `INSERT INTO meta_plm_collaboration_rows (binding_id, row_key, record_id, business_hash, captured_at)
           VALUES ($1, $2::jsonb, $3, $4, $5::timestamptz)`,
          [published.bindingId, JSON.stringify([published.dataSourceId, published.tenantId, published.orgId, published.itemId, published.rulesetId]), published.recordId, HEX_A, CAPTURED_AT],
        )
        await writer.query(
          `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, locked, locked_by)
           VALUES ($1, $2, $3::jsonb, 1, $4, $4, false, null)`,
          [published.recordId, published.sheetId, JSON.stringify(readinessData(published, readinessCells(published))), published.actorId],
        )
        await writer.query('COMMIT')
      } finally {
        writer.release()
      }
      await expectAbort(ctx.pool, (db) => db.query('TRUNCATE meta_plm_collaboration_syncs'), {
        code: '23514',
        constraint: 'meta_plm_collaboration_truncate_guard',
        message: FAMILY,
      })
      await expectAbort(ctx.pool, (db) => db.query('DELETE FROM meta_records WHERE id = $1', [published.recordId]), {
        code: '23514',
        constraint: 'meta_plm_collaboration_record_guard',
        message: FAMILY,
      })
    }, { admit: true, includeBom: true })
  })
})

describe('D04 resources counts and canonical text', () => {
  test('whole row helper matches the frozen serializer and refuses the listed gaps', async () => {
    await withFixture(async (ctx) => {
      const row = graph('readiness')
      const positive = async (resources: ReadinessCollaborationResource[]) => {
        const cells = readinessCells(row, resources)
        if (await dataOk(ctx.pool, row.itemId, row.rulesetId, cells) !== true) {
          throw new Error(`positive resources rejected: ${resources.length}`)
        }
      }
      await positive([])
      const capped: ReadinessCollaborationResource[] = []
      for (let index = 0; index < 20; index += 1) {
        capped.push(resource({ kind: 'mbom_release', resource_type: 'mbom', resource_id: `mbom-${index}` }))
        capped.push(resource({ kind: 'routing_release', resource_type: 'routing', resource_id: `routing-${index}` }))
        capped.push(resource({ kind: 'baseline_release', resource_type: 'baseline', resource_id: `baseline-${index}` }))
      }
      capped.push(resource({ kind: 'item_release', resource_type: 'item', resource_id: row.itemId, name: null, state: null }))
      await positive(capped)
      await positive([resource({
        kind: 'mbom_release',
        resource_type: 'mbom',
        resource_id: 'mbom-warn',
        errors: [],
        warnings: [{ code: 'W', rule_id: 'R' }],
      })])
      await positive([resource({
        kind: 'mbom_release',
        resource_type: 'mbom',
        resource_id: 'mbom-dup',
        errors: [{ code: 'E', rule_id: 'R' }, { code: 'E', rule_id: 'R' }],
        warnings: [{ code: 'E', rule_id: 'R' }, { code: 'E', rule_id: 'R' }],
      })])
      const long = 'x'.repeat(400)
      await positive([resource({
        kind: 'mbom_release',
        resource_type: 'mbom',
        resource_id: `${long}😀`,
        name: `quote"slash\\newline\nunit\u0001line\u2028${long}`,
        state: `tab\t${long}`,
        errors: [{ code: long, rule_id: `rule-${long}` }],
        warnings: [],
      })])
      const negative = async (cells: Record<string, unknown>) => {
        if (await dataOk(ctx.pool, row.itemId, row.rulesetId, cells) !== false) throw new Error('negative resources returned true')
      }
      const base = readinessCells(row, [resource({ kind: 'mbom_release', resource_type: 'mbom', resource_id: 'mbom-1' })])
      await negative({ ...base, resources: base.resources.replace('"mbom"', '"routing"') })
      const duplicate = readinessCells(row, [
        resource({ kind: 'mbom_release', resource_type: 'mbom', resource_id: 'same' }),
        resource({ kind: 'mbom_release', resource_type: 'mbom', resource_id: 'same' }),
      ])
      await negative(duplicate)
      const overflow = [...capped, resource({ kind: 'mbom_release', resource_type: 'mbom', resource_id: 'mbom-extra' })]
      await negative(readinessCells(row, overflow))
      await negative(readinessCells(row, [resource({ kind: 'item_release', resource_type: 'item', resource_id: 'other-item' })]))
      const missingKey = base.resources.replace(',"name":"name"', '')
      await negative({ ...base, resources: missingKey })
      await negative({ ...base, resources: '{not-json' })
      await negative({ ...base, resources: base.resources.replace('"kind":"mbom_release"', '"kind":"mbom_release","kind":"mbom_release"') })
      await negative({ ...base, resources: base.resources.replace(':', ': ') })
      await negative({ ...base, resources: `[{"kind":"mbom_release","errors":[],"name":"name","resource_id":"mbom-1","resource_type":"mbom","state":"state","warnings":[]}]` })
      const reordered = readinessCells(row, [
        resource({ kind: 'routing_release', resource_type: 'routing', resource_id: 'routing-1' }),
        resource({ kind: 'mbom_release', resource_type: 'mbom', resource_id: 'mbom-1' }),
      ])
      const swapped = reordered.resources.replace(
        /\[(.+),(.+)\]/s,
        (_match, left: string, right: string) => `[${right},${left}]`,
      )
      await negative({ ...reordered, resources: swapped })
      for (const spelling of ['+1', '01', '-0', '1.0', ' 1', '1e1', '9007199254740992']) {
        await negative({ ...readinessCells(row), resources_count: spelling })
      }
      await negative({ ...readinessCells(row, [resource({ kind: 'mbom_release', resource_type: 'mbom', resource_id: 'one' })]), resources_count: '0' })
      if (await dataOk(ctx.pool, row.itemId, '', readinessCells(row)) !== false) throw new Error('empty ruleset was accepted')
    }, { admit: true })
  })
})

describe('D05 receipt generic and deferred guards', () => {
  test('accepted readiness receipt commits and the listed refusals leave no residue', async () => {
    await withWriterFence(async () => {
      await withFixture(async (ctx) => {
        const row = graph('readiness')
        const setup = await ctx.pool.connect()
        try {
          await setup.query('BEGIN')
          await insertReadinessGraph(setup, row)
          await setup.query('COMMIT')
        } finally {
          setup.release()
        }
        const publisher = await ctx.pool.connect()
        try {
          await publisher.query('BEGIN')
          const query = queryOf(publisher)
          await fenceWriterEntry(query, row.sheetId)
          const ledger = await mintOperation(query, row.sheetId)
          await publishReadiness(publisher, row, ledger)
          await sealOperation(query, ledger)
          await publisher.query('COMMIT')
        } finally {
          publisher.release()
        }
        const published = await ctx.pool.query(
          `SELECT
             (SELECT count(*) FROM meta_plm_collaboration_rows) AS rows,
             (SELECT count(*) FROM meta_records) AS records,
             (SELECT count(*) FROM meta_record_revisions WHERE source = 'system_sync') AS revisions,
             (SELECT count(*) FROM meta_record_history_operations) AS operations`,
        )
        const counts = published.rows[0] as { rows: string; records: string; revisions: string; operations: string }
        if (Number(counts.rows) !== 1 || Number(counts.records) !== 1 || Number(counts.revisions) !== 1 || Number(counts.operations) !== 1) {
          throw new Error(`accepted receipt did not publish ${JSON.stringify(counts)}`)
        }
        const comments = await ctx.pool.query(`SELECT to_regclass('meta_comments') AS comments, to_regclass('meta_subscriptions') AS subscriptions`)
        const absent = comments.rows[0] as { comments: string | null; subscriptions: string | null }
        if (absent.comments !== null || absent.subscriptions !== null) {
          throw new Error('this fixture unexpectedly has comment or subscription tables')
        }
        const data = readinessData(row, readinessCells(row))
        await expectAbort(ctx.pool, async (db) => {
          await db.query(`SELECT set_config('metasheet.plm_collaboration_sync', $1, true)`, [randomUUID()])
          await db.query('UPDATE meta_records SET data = $2::jsonb, version = version + 1 WHERE id = $1', [row.recordId, JSON.stringify({ ...data, [row.sourceIds.item_id]: 'changed' })])
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        await expectAbort(ctx.pool, async (db) => {
          await db.query(
            `INSERT INTO meta_plm_collaboration_syncs (id, binding_id, actor_id, binding_version, patches, accepted_txid)
             VALUES ($1, $2, $3, 1, $4::jsonb, '1')`,
            [randomUUID(), row.bindingId, row.actorId, JSON.stringify(readinessPatch(row, data))],
          )
        }, { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
        await expectAbort(ctx.pool, (db) => insertReadinessSync(db, row, data, randomUUID(), 2), {
          code: '23514',
          constraint: 'meta_plm_collaboration_sync_guard',
          message: FAMILY,
        })
        await expectAbort(ctx.pool, (db) => insertReadinessSync(db, row, { ...data, foreign: 'x' }, randomUUID()), {
          code: '23514',
          constraint: 'meta_plm_collaboration_sync_guard',
          message: FAMILY,
        })
        await expectAbort(ctx.pool, async (db) => {
          await db.query(
            `INSERT INTO meta_plm_collaboration_syncs (id, binding_id, actor_id, binding_version, patches)
             VALUES ($1, $2, $3, 1, $4::jsonb)`,
            [randomUUID(), row.bindingId, row.actorId, JSON.stringify({
              [row.recordId]: {
                row_key: [row.dataSourceId, row.tenantId, row.orgId, row.ecoId],
                data,
                business_hash: HEX_A,
                captured_at: CAPTURED_AT,
              },
            })],
          )
        }, { code: '23514', constraint: 'meta_plm_collaboration_sync_guard', message: FAMILY })
        await expectAbort(ctx.pool, (db) => db.query(
          'UPDATE meta_records SET data = $2::jsonb, version = version + 1 WHERE id = $1',
          [row.recordId, JSON.stringify({ ...data, [row.sourceIds.coverage_status]: 'changed' })],
        ), { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        await expectAbort(ctx.pool, async (db) => {
          await db.query(`SELECT set_config('metasheet.plm_collaboration_sync', $1, true)`, [randomUUID()])
          await db.query('UPDATE meta_records SET version = version + 1 WHERE id = $1', [row.recordId])
        }, { code: '23514', constraint: 'meta_plm_collaboration_record_guard', message: FAMILY })
        const local = await ctx.pool.connect()
        try {
          await local.query('BEGIN')
          await local.query(
            `UPDATE meta_records SET data = data || $2::jsonb, version = version + 1 WHERE id = $1`,
            [row.recordId, JSON.stringify({ [row.localIds.review_note]: 'kept local' })],
          )
          await local.query('COMMIT')
        } finally {
          local.release()
        }
        const missing = `missing_${row.recordId}`
        await expectCommitFailure(ctx.pool, async (db) => {
          await insertAttributedReadinessRow(db, row, 'm', missing)
        }, { code: '23503' }, 'SELECT count(*)::int AS n FROM meta_plm_collaboration_rows WHERE record_id = $1', [missing])
        const elsewhere = `${row.sheetId}_else`
        const elseRecord = `${row.recordId}_else`
        const elseClient = await ctx.pool.connect()
        try {
          await elseClient.query('BEGIN')
          await elseClient.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [elsewhere, row.baseId, 'else'])
          await elseClient.query(
            `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, locked) VALUES ($1, $2, '{}'::jsonb, 1, $3, $3, false)`,
            [elseRecord, elsewhere, row.actorId],
          )
          await elseClient.query('COMMIT')
        } finally {
          elseClient.release()
        }
        await expectCommitFailure(ctx.pool, async (db) => {
          await insertAttributedReadinessRow(db, row, 'w', elseRecord)
        }, { code: '23514', constraint: 'meta_plm_collaboration_commit_guard', message: FAMILY },
        'SELECT count(*)::int AS n FROM meta_plm_collaboration_rows WHERE record_id = $1', [elseRecord])
        let operationId = ''
        await expectCommitFailure(ctx.pool, async (db) => {
          const query = queryOf(db)
          await fenceWriterEntry(query, row.sheetId)
          const ledger = await mintOperation(query, row.sheetId)
          operationId = ledger.operationId ?? ''
          await recordRecordRevision(query, {
            sheetId: row.sheetId,
            recordId: row.recordId,
            version: 2,
            action: 'update',
            source: 'system_sync',
            actorId: row.actorId,
            changedFieldIds: [row.sourceIds.item_id],
            patch: data,
            snapshot: data,
            ledger,
          })
        }, { code: '23503' }, 'SELECT count(*)::int AS n FROM meta_record_revisions WHERE operation_id = $1::uuid', () => [operationId])
        await expectAbort(ctx.pool, async (db) => {
          const query = queryOf(db)
          await fenceWriterEntry(query, row.sheetId)
          const ledger = await mintOperation(query, row.sheetId)
          await recordRecordRevision(query, {
            sheetId: row.sheetId,
            recordId: row.recordId,
            version: 2,
            action: 'update',
            source: 'system_sync',
            actorId: row.actorId,
            changedFieldIds: [row.sourceIds.item_id],
            patch: data,
            snapshot: data,
            ledger,
          })
          ledger.track('999999')
          await sealOperation(query, ledger)
        }, { code: '23514', message: 'sealed operation' })
        await ctx.pool.query(`UPDATE meta_plm_collaboration_bindings SET status = 'stale', version = version + 1 WHERE id = $1`, [row.bindingId])
        await expectAbort(ctx.pool, (db) => insertReadinessSync(db, row, data, randomUUID()), {
          code: '23514',
          constraint: 'meta_plm_collaboration_sync_guard',
          message: FAMILY,
        })
        await ctx.pool.query(`UPDATE meta_plm_collaboration_bindings SET status = 'disabled', version = version + 1 WHERE id = $1`, [row.bindingId])
        await expectAbort(ctx.pool, (db) => insertReadinessSync(db, row, data, randomUUID()), {
          code: '23514',
          constraint: 'meta_plm_collaboration_sync_guard',
          message: FAMILY,
        })
      }, { admit: true })
    })
  })
})

describe('D06 down evidence filters', () => {
  test('every readiness preview and binding status refuses and keeps its rows', async () => {
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        const created = await insertReadinessGraph(client)
        await insertPreview(client, created, 'readiness')
        const stored = await client.query(
          `SELECT count(*)::int AS n FROM meta_plm_collaboration_previews
            WHERE source_kind = 'readiness' AND request_id IS NULL AND binding_id IS NULL AND consumed_at IS NULL`,
        )
        if (Number((stored.rows[0] as { n: number }).n) !== 1) throw new Error('unconsumed readiness preview was not stored')
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await expectEvidenceRefusal(ctx)
    }, { admit: true })
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        const row = await insertReadinessGraph(client)
        await insertPreview(client, row, 'readiness', { createdAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-02T00:00:00Z' })
        const stored = await client.query(
          `SELECT count(*)::int AS n FROM meta_plm_collaboration_previews
            WHERE source_kind = 'readiness' AND expires_at < now()`,
        )
        if (Number((stored.rows[0] as { n: number }).n) !== 1) throw new Error('expired readiness preview was not stored')
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await expectEvidenceRefusal(ctx)
    }, { admit: true })
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        const row = await insertReadinessGraph(client)
        const previewId = randomUUID()
        await insertPreview(client, row, 'readiness', { id: previewId })
        await client.query(
          `UPDATE meta_plm_collaboration_previews SET request_id = $2, binding_id = $3, consumed_at = $4::timestamptz WHERE id = $1`,
          [previewId, randomUUID(), row.bindingId, CAPTURED_AT],
        )
        const stored = await client.query(
          `SELECT count(*)::int AS n FROM meta_plm_collaboration_previews
            WHERE id = $1 AND request_id IS NOT NULL AND binding_id = $2 AND consumed_at IS NOT NULL`,
          [previewId, row.bindingId],
        )
        if (Number((stored.rows[0] as { n: number }).n) !== 1) throw new Error('consumed readiness preview was not stored')
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await expectEvidenceRefusal(ctx)
    }, { admit: true })
    for (const status of ['active', 'stale', 'disabled'] as const) {
      await withFixture(async (ctx) => {
        const client = await ctx.pool.connect()
        try {
          await client.query('BEGIN')
          const row = await insertReadinessGraph(client)
          if (status === 'stale') {
            await client.query(`UPDATE meta_plm_collaboration_bindings SET status = 'stale', version = version + 1 WHERE id = $1`, [row.bindingId])
          }
          if (status === 'disabled') {
            await client.query(`UPDATE meta_plm_collaboration_bindings SET status = 'disabled', version = version + 1 WHERE id = $1`, [row.bindingId])
          }
          await client.query('COMMIT')
        } finally {
          client.release()
        }
        await expectEvidenceRefusal(ctx)
      }, { admit: true })
    }
  })

  test('planted five key orphan and mismatched evidence refuses without claiming normal admission', async () => {
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        const row = await insertEcoGraph(client)
        await client.query(`SET LOCAL session_replication_role = replica`)
        await client.query(
          `INSERT INTO meta_plm_collaboration_rows (binding_id, row_key, record_id, business_hash, captured_at)
           VALUES ($1, $2::jsonb, $3, $4, $5::timestamptz)`,
          [row.bindingId, JSON.stringify([row.dataSourceId, row.tenantId, row.orgId, row.itemId, row.rulesetId]), `${row.recordId}_five`, HEX_A, CAPTURED_AT],
        )
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await expectEvidenceRefusal(ctx)
    }, { admit: true })
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        const row = await insertEcoGraph(client)
        await client.query(`SET LOCAL session_replication_role = replica`)
        await client.query(
          `INSERT INTO meta_plm_collaboration_syncs (id, binding_id, actor_id, binding_version, patches)
           VALUES ($1, $2, $3, 1, $4::jsonb)`,
          [randomUUID(), row.bindingId, row.actorId, JSON.stringify(readinessPatch(row, {}))],
        )
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await expectEvidenceRefusal(ctx)
    }, { admit: true })
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        await insertEcoGraph(client)
        await client.query(`SET LOCAL session_replication_role = replica`)
        await client.query(
          `INSERT INTO meta_plm_collaboration_rows (binding_id, row_key, record_id, business_hash, captured_at)
           VALUES ($1, '["a","b","c","d"]'::jsonb, 'orphan-record', $2, now())`,
          [randomUUID(), HEX_A],
        )
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await expectEvidenceRefusal(ctx)
    }, { admit: true })
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        const row = await insertEcoGraph(client)
        await insertPreview(client, row, 'eco', {
          itemId: `${row.itemId}_other`,
          rowKey: [row.dataSourceId, row.tenantId, row.orgId, row.ecoId],
          bindingId: row.bindingId,
          requestId: randomUUID(),
          consumedAt: CAPTURED_AT,
        })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await expectEvidenceRefusal(ctx)
    }, { admit: true })
    await withFixture(async (ctx) => {
      const row = graph('eco')
      await expectAbort(ctx.pool, async (db) => {
        await db.query(`SET LOCAL session_replication_role = replica`)
        await insertContainer(db, row)
        await insertBinding(db, row, 'eco', { source: { item_id: 'x' }, local: { review_note: 'y' } })
      }, { code: '23514', constraint: 'meta_plm_collaboration_bindings_maps_check' })
      await expectAbort(ctx.pool, async (db) => {
        await db.query(`SET LOCAL session_replication_role = replica`)
        await db.query(
          `INSERT INTO meta_plm_collaboration_previews (
             id, actor_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id, base_id,
             name, row_key, source_fingerprint, business_hash, captured_at, expires_at
           ) VALUES ($1, 'actor', 'ds', 'unknown', 'tenant', 'org', 'item', 'base', 'preview', '[]'::jsonb, $2, $2, now(), now() + interval '1 day')`,
          [randomUUID(), HEX_A],
        )
      }, { code: '23514' })
    })
  })

  test('eco only history restores and ambiguous markers refuse', async () => {
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      let row: Graph
      try {
        await client.query('BEGIN')
        row = await insertEcoGraph(client)
        const plainSheet = `${row.sheetId}_plain`
        const plainField = `${row.actorId}_plain`
        const plainRecord = `${row.recordId}_plain`
        await client.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [plainSheet, row.baseId, 'plain'])
        await client.query(
          `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1, $2, 'plain', 'string', '{}'::jsonb, 1)`,
          [plainField, plainSheet],
        )
        await client.query(
          `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, locked) VALUES ($1, $2, '{}'::jsonb, 1, $3, $3, false)`,
          [plainRecord, plainSheet, row.actorId],
        )
        await recordRecordRevision(queryOf(client), {
          sheetId: plainSheet,
          recordId: plainRecord,
          version: 1,
          action: 'create',
          source: 'system_sync',
          actorId: row.actorId,
          changedFieldIds: [plainField],
          patch: {},
          snapshot: {},
        })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      const before = await evidenceCounts(ctx.pool)
      await admitUp(ctx.db)
      await admitDown(ctx.db)
      if (await evidenceCounts(ctx.pool) !== before) throw new Error('eco-only down changed counted evidence')
      if (await helperCount(ctx.pool, ctx.schema) !== 0) throw new Error('eco-only down left a helper')
    })
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        const row = await insertEcoGraph(client)
        await recordConfigRevision(queryOf(client), {
          sheetId: row.sheetId,
          entityType: 'field',
          entityId: `${row.actorId}_historical`,
          action: 'update',
          before: { property: {} },
          after: { property: { plmCollaborationSnapshot: { source: true, key: 'item_id' } } },
          changedKeys: ['property'],
          batchId: null,
          actorId: row.actorId,
        })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await admitUp(ctx.db)
      await expectEvidenceRefusal(ctx)
    })
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        const row = graph('eco')
        await insertContainer(client, row)
        await client.query(
          `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1, $2, 'id', 'string', $3::jsonb, 1)`,
          [row.sourceIds.id, row.sheetId, JSON.stringify({ readOnly: true, plmCollaborationSnapshot: { source: true, key: 'id' } })],
        )
        await client.query(
          `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, locked) VALUES ($1, $2, $3::jsonb, 1, $4, $4, false)`,
          [row.recordId, row.sheetId, JSON.stringify({ [row.sourceIds.id]: 'x' }), row.actorId],
        )
        await recordRecordRevision(queryOf(client), {
          sheetId: row.sheetId,
          recordId: row.recordId,
          version: 1,
          action: 'create',
          source: 'rest',
          actorId: row.actorId,
          changedFieldIds: [row.sourceIds.id],
          patch: { [row.sourceIds.id]: 'x' },
          snapshot: { [row.sourceIds.id]: 'x' },
        })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      await admitUp(ctx.db)
      await expectEvidenceRefusal(ctx)
    })
  })
})

describe('D07 stale snapshot and lock order', () => {
  test('repeatable read and serializable refuse before mutation', async () => {
    await withFixture(async (ctx) => {
      for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
        for (const run of [admitUp, admitDown]) {
          let failed: unknown
          try {
            await ctx.db.transaction().execute(async (trx) => {
              await sql.raw(`SET TRANSACTION ISOLATION LEVEL ${level}`).execute(trx)
              await run(trx)
            })
          } catch (error) {
            failed = error
          }
          assertPg(failed, {
            code: '23514',
            constraint: 'meta_plm_collaboration_snapshot_guard',
            message: 'plm_collaboration_snapshot_stale',
          })
          if (await collaborationTables(ctx.pool, ctx.schema) !== 4) throw new Error(`${level} refusal dropped a table`)
        }
      }
    }, { admit: true })
  })

  test('down waits on a readiness preview then refuses or restores from the fresh statement', async () => {
    await withFixture(async (ctx) => {
      const writer = await ctx.pool.connect()
      try {
        await writer.query('BEGIN')
        const row = graph('readiness')
        await insertContainer(writer, row)
        await insertPreview(writer, row, 'readiness')
        const dropping = admitDown(ctx.db).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
        const pid = await waitForQueryLock(ctx.admin, '%LOCK TABLE%meta_plm_collaboration_previews%')
        const blockers = await ctx.admin.query('SELECT pg_blocking_pids($1) AS pids', [pid])
        if (!asPidList((blockers.rows[0] as { pids: unknown }).pids).includes(backendPid(writer))) {
          throw new Error('down was not blocked by the open readiness preview')
        }
        await writer.query('COMMIT')
        const finished = await dropping
        if (finished.ok) throw new Error('down committed over a readiness preview')
        assertPg(finished.error, {
          code: '23514',
          constraint: 'meta_plm_collaboration_evidence_guard',
          message: 'plm_collaboration_readiness_evidence_present',
        })
      } finally {
        try { await writer.query('ROLLBACK') } catch { /* committed */ }
        writer.release()
      }
    }, { admit: true })
    await withFixture(async (ctx) => {
      const writer = await ctx.pool.connect()
      try {
        await writer.query('BEGIN')
        const row = graph('readiness')
        await insertContainer(writer, row)
        await insertPreview(writer, row, 'readiness')
        const dropping = admitDown(ctx.db).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
        await waitForQueryLock(ctx.admin, '%LOCK TABLE%meta_plm_collaboration_previews%')
        await writer.query('ROLLBACK')
        const finished = await dropping
        if (!finished.ok) throw finished.error
        if (await helperCount(ctx.pool, ctx.schema) !== 0) throw new Error('rolled-back preview still blocked restore')
      } finally {
        try { await writer.query('ROLLBACK') } catch { /* rolled back */ }
        writer.release()
      }
    }, { admit: true })
    await withFixture(async (ctx) => {
      const holder = await ctx.pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('LOCK TABLE meta_plm_collaboration_syncs IN SHARE ROW EXCLUSIVE MODE')
        const dropping = admitDown(ctx.db).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
        const pid = await waitForQueryLock(ctx.admin, '%LOCK TABLE%meta_plm_collaboration_syncs%')
        const locks = await ctx.admin.query(
          `SELECT relation.relname, locked.granted, locked.mode
             FROM pg_locks locked
             JOIN pg_class relation ON relation.oid = locked.relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE locked.pid = $1 AND namespace.nspname = $2 AND relation.relname LIKE 'meta_plm_collaboration_%'`,
          [pid, ctx.schema],
        )
        const granted = new Map((locks.rows as Array<{ relname: string; granted: boolean; mode: string }>).map((lock) => [lock.relname, lock]))
        for (const name of ['meta_plm_collaboration_previews', 'meta_plm_collaboration_bindings', 'meta_plm_collaboration_rows']) {
          const lock = granted.get(name)
          if (!lock?.granted || lock.mode !== 'AccessExclusiveLock') throw new Error(`${name} was not locked before syncs`)
        }
        const waiting = granted.get('meta_plm_collaboration_syncs')
        if (!waiting || waiting.granted || waiting.mode !== 'AccessExclusiveLock') throw new Error('down did not wait on syncs')
        await holder.query('COMMIT')
        const finished = await dropping
        if (!finished.ok) throw finished.error
      } finally {
        try { await holder.query('ROLLBACK') } catch { /* committed */ }
        holder.release()
      }
    }, { admit: true })
  })
})

describe('D08 down first and canonical nowait', () => {
  test('a waiting readiness insert resumes as unadmitted after restore', async () => {
    await withFixture(async (ctx) => {
      const waiter = await ctx.pool.connect()
      try {
        let pending: Promise<{ failed: false } | { failed: true; error: unknown }> = Promise.resolve({ failed: false })
        await ctx.db.transaction().execute(async (trx) => {
          await sql`LOCK TABLE meta_plm_collaboration_previews IN ACCESS EXCLUSIVE MODE`.execute(trx)
          await sql`LOCK TABLE meta_plm_collaboration_bindings IN ACCESS EXCLUSIVE MODE`.execute(trx)
          await sql`LOCK TABLE meta_plm_collaboration_rows IN ACCESS EXCLUSIVE MODE`.execute(trx)
          await sql`LOCK TABLE meta_plm_collaboration_syncs IN ACCESS EXCLUSIVE MODE`.execute(trx)
          const holder = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
          const row = graph('readiness')
          pending = waiter.query(
            `INSERT INTO meta_plm_collaboration_previews (
               id, actor_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
               current_version_id, base_id, name, row_key, source_fingerprint, business_hash,
               captured_at, created_at, expires_at
             ) VALUES (
               $1, 'actor', $2, 'readiness', $3, $4, $5, NULL, 'base', 'preview', $6::jsonb, $7, $7,
               now(), now(), now() + interval '1 day'
             )`,
            [randomUUID(), row.dataSourceId, row.tenantId, row.orgId, row.itemId, JSON.stringify([row.dataSourceId, row.tenantId, row.orgId, row.itemId, row.rulesetId]), HEX_A],
          ).then(() => ({ failed: false as const }), (error: unknown) => ({ failed: true as const, error }))
          await waitForPidLock(ctx.admin, backendPid(waiter))
          const blockers = await ctx.admin.query('SELECT pg_blocking_pids($1) AS pids', [backendPid(waiter)])
          if (!asPidList((blockers.rows[0] as { pids: unknown }).pids).includes(Number(holder.rows[0]?.pid))) {
            throw new Error('readiness preview was not blocked by the down transaction')
          }
          await admitDown(trx)
        })
        const blocked = await pending
        if (!blocked.failed) throw new Error('readiness preview committed after restore')
        assertPg(blocked.error, { code: '23514', message: 'plm_collaboration_readiness_unadmitted' })
        if (await collaborationTables(ctx.pool, ctx.schema) !== 4) throw new Error('down-first restore dropped a table')
      } finally {
        waiter.release()
      }
    }, { admit: true })
  })

  test('canonical share nowait rolls back and the reverse wait is observed', async () => {
    for (const table of SCAN_TABLES) {
      await withFixture(async (ctx) => {
        const holder = await ctx.pool.connect()
        try {
          await holder.query('BEGIN')
          await holder.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`)
          let failed: unknown
          try {
            await admitDown(ctx.db)
          } catch (error) {
            failed = error
          }
          assertPg(failed, { code: '55P03' })
          if (await helperCount(ctx.pool, ctx.schema) !== 4) throw new Error(`${table} nowait changed the admission catalog`)
          if (await collaborationTables(ctx.pool, ctx.schema) !== 4) throw new Error(`${table} nowait dropped a table`)
        } finally {
          try { await holder.query('ROLLBACK') } catch { /* closed */ }
          holder.release()
        }
      }, { admit: true })
    }
    await withFixture(async (ctx) => {
      const owner = await ctx.pool.connect()
      const waiter = await ctx.pool.connect()
      let pending: Promise<unknown> = Promise.resolve()
      try {
        await owner.query('BEGIN')
        await owner.query('LOCK TABLE meta_fields IN SHARE MODE')
        await waiter.query('BEGIN')
        pending = waiter.query('LOCK TABLE meta_fields IN ROW EXCLUSIVE MODE')
        await waitForPidLock(ctx.admin, backendPid(waiter))
        const blockers = await ctx.admin.query('SELECT pg_blocking_pids($1) AS pids', [backendPid(waiter)])
        if (!asPidList((blockers.rows[0] as { pids: unknown }).pids).includes(backendPid(owner))) {
          throw new Error('canonical reverse wait was not observed')
        }
        await owner.query('ROLLBACK')
        await pending
        await waiter.query('ROLLBACK')
      } finally {
        try { await owner.query('ROLLBACK') } catch { /* closed */ }
        try { await pending } catch { /* the lock ended or failed */ }
        try { await waiter.query('ROLLBACK') } catch { /* closed */ }
        owner.release()
        waiter.release()
      }
    }, { admit: true })
  })
})

describe('D09 unknown dependent drop', () => {
  test('a helper view blocks down and the rollback keeps the admitted catalog', async () => {
    await withFixture(async (ctx) => {
      await ctx.pool.query(`CREATE VIEW readiness_request_probe AS SELECT meta_plm_collaboration_readiness_request_id('item-1') AS ok`)
      const before = await catalog(ctx.pool, ctx.schema)
      let failed: unknown
      try {
        await admitDown(ctx.db)
      } catch (error) {
        failed = error
      }
      assertPg(failed, { code: '2BP01' })
      if (await catalog(ctx.pool, ctx.schema) !== before) throw new Error('dependent drop rollback changed the catalog')
      const view = await ctx.pool.query(`SELECT to_regclass('readiness_request_probe') AS name`)
      if (!(view.rows[0] as { name: string | null }).name) throw new Error('dependent view was removed')
      if (await helperCount(ctx.pool, ctx.schema) !== 4) throw new Error('dependent refusal dropped a helper')
    }, { admit: true })
  })
})

describe('D10 registration and no fake postgres', () => {
  test('the suite is registered and missing database url is a hard failure in source', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const packageRoot = resolve(here, '../..')
    const repoRoot = resolve(here, '../../../..')
    const snapshotConfig = readFileSync(resolve(packageRoot, 'vitest.plm-collaboration-snapshot.config.ts'), 'utf8')
    const defaultConfig = readFileSync(resolve(packageRoot, 'vitest.config.ts'), 'utf8')
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/plm-bom-listener.yml'), 'utf8')
    const migration = readFileSync(resolve(packageRoot, 'src/db/migrations/zzzz20261024020000_admit_plm_readiness_snapshots.ts'), 'utf8')
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const names = [
      'tests/integration/plm-collaboration-snapshot-db-guards.realdb.test.ts',
      'tests/integration/plm-collaboration-snapshot-service.realdb.test.ts',
      'tests/integration/plm-collaboration-readiness-snapshot.realdb.test.ts',
    ]
    for (const name of names) {
      if (!snapshotConfig.includes(name)) throw new Error(`snapshot include lost ${name}`)
      if (!workflow.includes(name)) throw new Error(`workflow command lost ${name}`)
    }
    if (!defaultConfig.includes(names[2])) throw new Error('default exclude lost the readiness realdb file')
    for (const token of ['pool: \'forks\'', 'fileParallelism: false', 'testTimeout: 120000', 'hookTimeout: 120000', 'sequence: { concurrent: false }']) {
      if (!snapshotConfig.includes(token)) throw new Error(`snapshot config lost ${token}`)
    }
    for (const token of [
      'tests/unit/plm-collaboration-readiness-source-transport.test.ts',
      'tests/unit/plm-collaboration-eco-source-transport.test.ts',
      'vitest.plm-collaboration-snapshot.config.ts',
      'DATABASE_URL is required for snapshot DB guards',
    ]) {
      if (!workflow.includes(token)) throw new Error(`workflow lost ${token}`)
    }
    if (!self.includes('DATABASE_URL is required for plm readiness collaboration snapshot realdb tests')) {
      throw new Error('missing DATABASE_URL guard')
    }
    const skipStatement = (callee: string) => new RegExp(`(?:^|\\n)\\s*${callee.replaceAll('.', '\\.')}\\s*\\(`).test(self)
    if (skipStatement('describe.skip') || skipStatement('it.skip') || skipStatement('describe.skipIf')) {
      throw new Error('readiness realdb suite can skip green')
    }
    const migrations = readdirSync(resolve(packageRoot, 'src/db/migrations')).filter((name) => name.startsWith('zzzz')).sort()
    if (migrations.at(-1) !== 'zzzz20261024020000_admit_plm_readiness_snapshots.ts') {
      throw new Error(`admission migration is not after the last foundation: ${migrations.at(-1)}`)
    }
    if (!migrations.includes('zzzz20261024010000_create_plm_collaboration_snapshots.ts')) {
      throw new Error('foundation migration is missing')
    }
    if ((migration.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length !== 4) throw new Error('replacement function count')
    if ((migration.match(/DROP FUNCTION/g) ?? []).length !== 4) throw new Error('helper drop count')
    if (migration.includes('DROP TABLE') || migration.includes('DELETE FROM') || migration.includes('CASCADE') || migration.includes('IF NOT EXISTS') || /IF EXISTS(?!\s*\()/.test(migration)) {
      throw new Error('down contains a forbidden cleanup statement')
    }
  })
})

async function commitSql(ctx: Fixture, statements: string[]): Promise<void> {
  const client = await ctx.pool.connect()
  try {
    await client.query('BEGIN')
    for (const statement of statements) await client.query(statement)
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* the failed statement already aborted the transaction */ }
    throw error
  } finally {
    client.release()
  }
}

async function expectShapeRefusal(ctx: Fixture, direction: 'up' | 'down'): Promise<void> {
  const beforeCatalog = await catalog(ctx.pool, ctx.schema)
  const beforeEvidence = await evidenceCounts(ctx.pool)
  const beforeHelpers = await helperCount(ctx.pool, ctx.schema)
  let failed: unknown
  try {
    if (direction === 'up') await admitUp(ctx.db)
    else await admitDown(ctx.db)
  } catch (error) {
    failed = error
  }
  assertPg(failed, {
    code: '23514',
    constraint: 'meta_plm_collaboration_predecessor_guard',
    message: 'plm_collaboration_admission_shape_invalid',
  })
  if (await catalog(ctx.pool, ctx.schema) !== beforeCatalog) throw new Error('shape refusal repaired the catalog')
  if (await evidenceCounts(ctx.pool) !== beforeEvidence) throw new Error('shape refusal changed evidence rows')
  const helpers = await helperCount(ctx.pool, ctx.schema)
  if (helpers !== beforeHelpers) throw new Error('shape refusal changed helper count')
  if (direction === 'up' && helpers !== 0) throw new Error('up shape refusal left a helper')
  if (direction === 'down' && helpers !== 4) throw new Error('down shape refusal dropped a helper')
}

async function commitCatalogDrift(ctx: Fixture, statements: string[]): Promise<void> {
  const before = await catalog(ctx.pool, ctx.schema)
  await commitSql(ctx, statements)
  if (await catalog(ctx.pool, ctx.schema) === before) throw new Error('catalog tamper did not change the pre-attempt catalog')
}

const CHECK_TRUE = [
  'ALTER TABLE meta_plm_collaboration_bindings DROP CONSTRAINT meta_plm_collaboration_bindings_maps_check',
  'ALTER TABLE meta_plm_collaboration_bindings ADD CONSTRAINT meta_plm_collaboration_bindings_maps_check CHECK (true)',
]
const DROP_RECORD_TRIGGER = [
  'DROP TRIGGER meta_plm_collaboration_record_guard ON meta_records',
]
const KEPT_BODY_DRIFT = [`
CREATE OR REPLACE FUNCTION meta_plm_collaboration_refuse(constraint_name text, message text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $body$
BEGIN
  RETURN;
END
$body$`]
const HELPER_VOLATILITY_DRIFT = [
  'ALTER FUNCTION meta_plm_collaboration_readiness_request_id(text) STABLE',
]

describe('D11 finite catalog and canonical record', () => {
  test('CHECK(true) before up refuses and leaves that catalog', async () => {
    await withFixture(async (ctx) => {
      await commitCatalogDrift(ctx, CHECK_TRUE)
      await expectShapeRefusal(ctx, 'up')
    })
  })

  test('CHECK(true) before down refuses and leaves that catalog', async () => {
    await withFixture(async (ctx) => {
      await commitCatalogDrift(ctx, CHECK_TRUE)
      await expectShapeRefusal(ctx, 'down')
    }, { admit: true })
  })

  test('a missing record guard trigger refuses up', async () => {
    await withFixture(async (ctx) => {
      await commitCatalogDrift(ctx, DROP_RECORD_TRIGGER)
      await expectShapeRefusal(ctx, 'up')
    })
  })

  test('a missing record guard trigger refuses down', async () => {
    await withFixture(async (ctx) => {
      await commitCatalogDrift(ctx, DROP_RECORD_TRIGGER)
      await expectShapeRefusal(ctx, 'down')
    }, { admit: true })
  })

  test('an unchanged kept function body drift refuses up', async () => {
    await withFixture(async (ctx) => {
      await commitCatalogDrift(ctx, KEPT_BODY_DRIFT)
      await expectShapeRefusal(ctx, 'up')
    })
  })

  test('helper volatility drift refuses down', async () => {
    await withFixture(async (ctx) => {
      await commitCatalogDrift(ctx, HELPER_VOLATILITY_DRIFT)
      await expectShapeRefusal(ctx, 'down')
    }, { admit: true })
  })

  test('an intact eco graph downgrades and keeps the canonical record', async () => {
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        await insertEcoGraph(client)
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      const before = JSON.parse(await evidenceCounts(ctx.pool)) as { rows: string; records: string }
      if (Number(before.rows) !== 1 || Number(before.records) !== 1) throw new Error('eco graph did not keep one control row and one canonical record')
      await admitDown(ctx.db)
      if (await helperCount(ctx.pool, ctx.schema) !== 0) throw new Error('eco down left a helper')
      const after = JSON.parse(await evidenceCounts(ctx.pool)) as { rows: string; records: string }
      if (Number(after.rows) !== 1 || Number(after.records) !== 1) throw new Error('eco down removed the control row or canonical record')
    }, { admit: true })
  })

  test('a replica-deleted canonical record refuses down and keeps the control row', async () => {
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      let row: Graph
      try {
        await client.query('BEGIN')
        row = await insertEcoGraph(client)
        await client.query('COMMIT')
        await client.query('BEGIN')
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query('DELETE FROM meta_records WHERE id = $1', [row.recordId])
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      const counts = JSON.parse(await evidenceCounts(ctx.pool)) as { rows: string; records: string }
      if (Number(counts.rows) !== 1 || Number(counts.records) !== 0) throw new Error('orphan fixture lost the control row or kept the canonical record')
      await expectEvidenceRefusal(ctx)
      if (await helperCount(ctx.pool, ctx.schema) !== 4) throw new Error('orphan refusal dropped a helper')
    }, { admit: true })
  })

  test('a canonical record on a foreign sheet refuses down and keeps the control row', async () => {
    await withFixture(async (ctx) => {
      const client = await ctx.pool.connect()
      let row: Graph
      try {
        await client.query('BEGIN')
        row = await insertEcoGraph(client)
        await client.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [`${row.sheetId}_other`, row.baseId, 'other sheet'])
        await client.query('COMMIT')
        await client.query('BEGIN')
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query('UPDATE meta_records SET sheet_id = $2 WHERE id = $1', [row.recordId, `${row.sheetId}_other`])
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      const found = await ctx.pool.query('SELECT sheet_id FROM meta_records WHERE id = $1', [row.recordId])
      if ((found.rows[0] as { sheet_id: string } | undefined)?.sheet_id !== `${row.sheetId}_other`) {
        throw new Error('foreign-sheet fixture did not move the canonical record')
      }
      const counts = JSON.parse(await evidenceCounts(ctx.pool)) as { rows: string; records: string }
      if (Number(counts.rows) !== 1 || Number(counts.records) !== 1) throw new Error('foreign-sheet fixture lost the control row or canonical record')
      await expectEvidenceRefusal(ctx)
      if (await helperCount(ctx.pool, ctx.schema) !== 4) throw new Error('foreign-sheet refusal dropped a helper')
    }, { admit: true })
  })

  test('a committed record_guard sentinel body refuses up and keeps that catalog', async () => {
    await withFixture(async (ctx) => {
      await commitSentinelRecordGuard(ctx)
      await expectShapeRefusal(ctx, 'up')
    })
  })

  test('a committed record_guard sentinel body refuses down and keeps that catalog', async () => {
    await withFixture(async (ctx) => {
      await commitSentinelRecordGuard(ctx)
      await expectShapeRefusal(ctx, 'down')
    }, { admit: true })
  })
})

async function commitSentinelRecordGuard(ctx: Fixture): Promise<void> {
  const beforeCatalog = await catalog(ctx.pool, ctx.schema)
  const beforeEvidence = await evidenceCounts(ctx.pool)
  const client = await ctx.pool.connect()
  try {
    await client.query('BEGIN')
    const found = await client.query(
      `SELECT pg_catalog.quote_ident(current_schema()) AS ident, proc.prosrc AS body
         FROM pg_catalog.pg_proc proc
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
        WHERE namespace.nspname = current_schema()
          AND proc.proname = 'meta_plm_collaboration_record_guard'
          AND proc.pronargs = 0`,
    )
    const row = found.rows[0] as { ident: string; body: string } | undefined
    if (!row || found.rows.length !== 1) throw new Error('record_guard sentinel source is missing')
    if (row.ident !== ctx.schema) throw new Error('record_guard sentinel qualifier is not the fixture schema')
    const qualifier = `${row.ident}.`
    if (!row.body.includes(qualifier)) throw new Error('record_guard sentinel source has no canonical qualifier')
    if (row.body.includes('$sentinel_body$')) throw new Error('record_guard sentinel source contains the dollar tag')
    const corrupted = row.body.split(qualifier).join('__PLM_SERVING_SCHEMA__.')
    if (corrupted.includes(qualifier) || !corrupted.includes('__PLM_SERVING_SCHEMA__')) {
      throw new Error('record_guard sentinel replacement did not keep only the marker')
    }
    await client.query(
      `CREATE OR REPLACE FUNCTION meta_plm_collaboration_record_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $sentinel_body$${corrupted}$sentinel_body$`,
    )
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* the failed statement already aborted the transaction */ }
    throw error
  } finally {
    client.release()
  }
  if (await catalog(ctx.pool, ctx.schema) === beforeCatalog) throw new Error('sentinel tamper did not change the pre-attempt catalog')
  if (await evidenceCounts(ctx.pool) !== beforeEvidence) throw new Error('sentinel tamper changed evidence rows')
  const stored = await ctx.pool.query(
    `SELECT proc.prosrc AS body
       FROM pg_catalog.pg_proc proc
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
      WHERE namespace.nspname = $1
        AND proc.proname = 'meta_plm_collaboration_record_guard'
        AND proc.pronargs = 0`,
    [ctx.schema],
  )
  const body = (stored.rows[0] as { body: string } | undefined)?.body
  if (stored.rows.length !== 1 || !body || body.includes(`${ctx.schema}.`) || !body.includes('__PLM_SERVING_SCHEMA__')) {
    throw new Error('committed record_guard body is not the sentinel corruption')
  }
}

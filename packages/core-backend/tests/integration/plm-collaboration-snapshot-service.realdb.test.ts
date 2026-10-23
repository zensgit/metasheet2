import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, describe, expect, test } from 'vitest'
import { up } from '../../src/db/migrations/zzzz20261024010000_create_plm_collaboration_snapshots'
import { up as configHistoryUp } from '../../src/db/migrations/zzzz20260624120000_create_meta_config_revisions'
import { up as configSourceUp } from '../../src/db/migrations/zzzz20260624200000_add_config_revision_source'
import { up as rowReadDenyUp } from '../../src/db/migrations/zzzz20260617140000_rowlevel_read_deny_foundation'
import { up as conditionalReadRulesUp } from '../../src/db/migrations/zzzz20260618120000_conditional_read_rules'
import {
  EcoCollaborationSnapshotService,
  type EcoCollaborationSnapshotPool,
  type EcoQuery,
} from '../../src/multitable/plm-collaboration-snapshot-service'
import { EcoCollaborationSnapshotError } from '../../src/multitable/plm-collaboration-snapshot-service'
import { EcoCollaborationSourceError } from '../../src/multitable/plm-collaboration-snapshot-wire'
import { loadFieldPermissionScopeMap, loadRecordPermissionScopeMap } from '../../src/multitable/permission-service'
import { resolveSheetCapabilitiesForUserOnQuery } from '../../src/services/approval-record-link-txn-auth'
import { EventBus } from '../../src/integration/events/event-bus'
import { normalizeJson } from '../../src/multitable/field-codecs'
import {
  RecordWriteService,
  type ConnectionPool,
  type RecordWriteHelpers,
} from '../../src/multitable/record-write-service'
import { ensureRecordWriteAllowed } from '../../src/multitable/sheet-capabilities'
import { bootstrapPlmCollaborationSnapshotTestDb } from '../plm-collaboration-snapshot/bootstrap'

// Prepared PostgreSQL control. This file is not a passed acceptance run.
// A missing DATABASE_URL fails collection load. It never skips and never uses SQLite.
// Canonical bootstrap already owns the four RBAC tables. Config history and row-deny
// columns come from their migrations. The managed-link insert is classifier evidence
// from a second connection. It does not call provisionManagedLink.
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for plm collaboration snapshot service realdb tests')
}

const DATABASE_URL = process.env.DATABASE_URL
const actor = 'eco-owner'
const dataSourceId = 'ds-eco-1'
const baseId = 'base-eco-1'
const itemId = 'item-1'
const ecoId = 'eco-1'
const tenant = 'tenant-1'
const org = 'org-1'
const capturedAt = '2026-10-24T01:02:03.000000Z'

const sourceConfig = {
  connection: {
    url: 'https://plm.example',
    headers: { 'x-tenant-id': tenant, 'x-org-id': org },
  },
  options: { apiMode: 'yuantus', tenantId: tenant, orgId: org },
  credentials: { token: 'plain-token' },
}

function assertSchema(name: string): void {
  if (!/^plm_w23_[0-9a-f]{16}$/.test(name)) throw new Error(`refusing schema name ${name}`)
}

function servicePool(pool: Pool): EcoCollaborationSnapshotPool {
  return {
    async transaction<T>(fn: (tx: { query: EcoQuery }) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn({
          query: (sql, params) => client.query(sql, params),
        })
        await client.query('COMMIT')
        return result
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // The transaction is already aborted.
        }
        throw error
      } finally {
        client.release()
      }
    },
  }
}

// Same local-edit adapter as plm-collaboration-snapshot-db-guards.realdb.test.ts.
// The write gate is ensureRecordWriteAllowed from the current actor, not a constant true.
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
    ensureRecordWriteAllowed,
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

function ecoDto() {
  return {
    projection_contract: 'eco_collaboration_source.v1' as const,
    feature_key: 'collaboration_source_read' as const,
    entitled: true as const,
    source: {
      tenant_id: tenant,
      org_id: org,
      item_id: itemId,
      current_version_id: 'ver-1',
    },
    snapshot_at: capturedAt,
    eco: {
      id: ecoId,
      name: 'Gate',
      eco_type: 'design',
      product_id: itemId,
      source_version_id: null,
      target_version_id: null,
      stage_id: null,
      state: null,
      kanban_state: null,
      priority: null,
      updated_at: null,
    },
  }
}

async function withFixture(run: (pool: Pool, schema: string) => Promise<void>): Promise<void> {
  const schema = `plm_w23_${randomBytes(8).toString('hex')}`
  assertSchema(schema)
  const previousFence = process.env.MULTITABLE_ENABLE_WRITER_FENCE
  process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
  const admin = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: `${schema}_admin` })
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 4,
    application_name: schema,
    options: `-c search_path=${schema}`,
  })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    await bootstrapPlmCollaborationSnapshotTestDb(pool)
    await configHistoryUp(db)
    await configSourceUp(db)
    await rowReadDenyUp(db)
    await conditionalReadRulesUp(db)
    await up(db)
    for (const [table, column] of [
      ['user_roles', 'user_id'],
      ['user_permissions', 'permission_code'],
      ['role_permissions', 'permission_code'],
      ['roles', 'id'],
      ['meta_config_revisions', 'source'],
      ['meta_sheets', 'row_level_read_permissions_enabled'],
      ['meta_sheets', 'conditional_read_rules'],
    ] as const) {
      const found = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column],
      )
      if (found.rowCount !== 1) throw new Error(`missing prerequisite ${table}.${column}`)
    }
    await pool.query(`
      CREATE TABLE plm_managed_identity_links(
        id uuid PRIMARY KEY,
        status text,
        generation integer,
        meta_user_id text,
        meta_tenant_id text,
        meta_org_id text,
        native_auth_user_id text,
        native_tenant_id text,
        native_org_id text,
        installation_issuer text,
        client_origin text,
        root_part_id text,
        owner_user_id text
      );
      CREATE TABLE plm_managed_source_bindings(
        data_source_id text,
        link_id uuid,
        generation integer,
        status text,
        source_fingerprint text,
        frozen_origin text,
        frozen_root_part_id text
      );
    `)
    await pool.query(
      `INSERT INTO users(id, is_active, role, activation_status, local_password_set)
       VALUES ($1, true, 'member', 'activated', true)`,
      [actor],
    )
    await pool.query('INSERT INTO meta_bases(id, owner_id) VALUES ($1, $2)', [baseId, actor])
    await pool.query(
      `INSERT INTO data_sources(id, name, type, config, owner_id, is_active, deleted_at, workspace_id, tenant_id, scope_kind)
       VALUES ($1, 'ECO', 'plm', $2::jsonb, $3, true, NULL, 'ws-1', 'meta-tenant', 'personal')`,
      [dataSourceId, JSON.stringify(sourceConfig), actor],
    )
    await run(pool, schema)
  } finally {
    if (previousFence === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    else process.env.MULTITABLE_ENABLE_WRITER_FENCE = previousFence
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}

function previewBody() {
  return {
    sourceKind: 'eco' as const,
    dataSourceId,
    baseId,
    itemId,
    currentVersionId: 'ver-1',
    ecoId,
    name: 'ECO collection',
  }
}

async function count(pool: Pool, table: string): Promise<number> {
  const found = await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
  return Number(found.rows[0].n)
}

function openService(pool: Pool) {
  const state = { calls: [] as string[], rejectedSource: null as string | null }
  const service = new EcoCollaborationSnapshotService({
    pool: servicePool(pool),
    dataSourceManager: {
      getDataSource: (sourceId: string) => ({
        getEcoCollaborationSource: async (input: { itemId: string; ecoId: string; currentVersionId: string | null }) => {
          state.calls.push(sourceId)
          if (state.rejectedSource === sourceId) throw new EcoCollaborationSourceError(401, 'ECO_SOURCE_TOKEN_REJECTED')
          const dto = ecoDto()
          return {
            ...dto,
            source: { ...dto.source, item_id: input.itemId, current_version_id: input.currentVersionId },
            eco: { ...dto.eco, id: input.ecoId, product_id: input.itemId },
          }
        },
      }),
    } as never,
  })
  return { service, state }
}

describe('prepared ECO collaboration snapshot PostgreSQL service', () => {
  afterAll(() => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('a managed binding inserted after the provider returns consumes nothing', async () => {
    await withFixture(async (pool, schema) => {
      let release!: () => void
      let reached!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const providerReached = new Promise<void>((resolve) => { reached = resolve })
      let phase: 'open' | 'pause' = 'open'
      let providerCalls = 0
      const service = new EcoCollaborationSnapshotService({
        pool: servicePool(pool),
        dataSourceManager: {
          getDataSource: () => ({
            getEcoCollaborationSource: async () => {
              providerCalls += 1
              if (phase === 'pause') {
                reached()
                await gate
              }
              return ecoDto()
            },
          }),
        } as never,
      })
      const preview = await service.preview(actor, previewBody())
      expect(providerCalls).toBe(1)
      phase = 'pause'
      const requestId = randomUUID()
      const pending = service.confirm(actor, { previewId: preview.previewId, requestId, expectedVersion: 0 })
      const confirmed = pending.then(() => 'committed', (error: unknown) => error)
      await providerReached
      const before = await pool.query('SELECT config FROM data_sources WHERE id=$1', [dataSourceId])
      const peer = new Pool({
        connectionString: DATABASE_URL,
        max: 1,
        application_name: `${schema}_peer`,
        options: `-c search_path=${schema}`,
      })
      try {
        const linkId = randomUUID()
        await peer.query(
          `INSERT INTO plm_managed_identity_links(
             id, status, generation, meta_user_id, meta_tenant_id, meta_org_id, native_auth_user_id,
             native_tenant_id, native_org_id, installation_issuer, client_origin, root_part_id, owner_user_id
           ) VALUES ($1::uuid, 'active', 1, $2, 'meta-tenant', 'meta-org', 'native-user', $3, $4, 'issuer', 'https://plm.example', 'root', $2)`,
          [linkId, actor, tenant, org],
        )
        await peer.query(
          `INSERT INTO plm_managed_source_bindings(
             data_source_id, link_id, generation, status, source_fingerprint, frozen_origin, frozen_root_part_id
           ) VALUES ($1, $2::uuid, 1, 'active', $3, 'frozen', 'root')`,
          [dataSourceId, linkId, 'a'.repeat(64)],
        )
      } finally {
        await peer.end()
      }
      release()
      const error = await confirmed
      expect(error).toBeInstanceOf(EcoCollaborationSnapshotError)
      expect(error).toMatchObject({ status: 403, code: 'ECO_SOURCE_MANAGED' })
      expect(providerCalls).toBe(2)
      const previewRow = await pool.query(
        'SELECT request_id, binding_id, consumed_at FROM meta_plm_collaboration_previews WHERE id=$1::uuid',
        [preview.previewId],
      )
      expect(previewRow.rows[0]).toMatchObject({ request_id: null, binding_id: null, consumed_at: null })
      expect(await count(pool, 'meta_plm_collaboration_bindings')).toBe(0)
      expect(await count(pool, 'meta_plm_collaboration_rows')).toBe(0)
      expect(await count(pool, 'meta_plm_collaboration_syncs')).toBe(0)
      expect(await count(pool, 'meta_records')).toBe(0)
      expect(await count(pool, 'meta_record_revisions')).toBe(0)
      const after = await pool.query('SELECT config FROM data_sources WHERE id=$1', [dataSourceId])
      expect(after.rows[0].config).toEqual(before.rows[0].config)
    })
  })

  test('an unbound confirm publishes once and replays the consumed result without another provider call', async () => {
    await withFixture(async (pool) => {
      let providerCalls = 0
      const service = new EcoCollaborationSnapshotService({
        pool: servicePool(pool),
        dataSourceManager: {
          getDataSource: () => ({
            getEcoCollaborationSource: async () => {
              providerCalls += 1
              return ecoDto()
            },
          }),
        } as never,
      })
      const preview = await service.preview(actor, previewBody())
      const requestId = randomUUID()
      const body = { previewId: preview.previewId, requestId, expectedVersion: 0 }
      const created = await service.confirm(actor, body)
      expect(created).toMatchObject({ version: 1, status: 'active', replayed: false, noop: false })
      expect(providerCalls).toBe(2)
      expect(await count(pool, 'meta_plm_collaboration_bindings')).toBe(1)
      expect(await count(pool, 'meta_records')).toBe(1)
      expect(await count(pool, 'meta_record_revisions')).toBe(1)
      const history = await pool.query('SELECT source, operation_id FROM meta_record_revisions')
      expect(history.rows[0].source).toBe('system_sync')
      expect(history.rows[0].operation_id).toBeTruthy()
      expect(await count(pool, 'meta_record_history_operations')).toBe(1)
      const consumed = await pool.query(
        'SELECT request_id::text AS request_id, binding_id::text AS binding_id, consumed_at FROM meta_plm_collaboration_previews WHERE id=$1::uuid',
        [preview.previewId],
      )
      expect(consumed.rows[0].request_id).toBe(requestId)
      expect(consumed.rows[0].binding_id).toBe(created.bindingId)
      expect(consumed.rows[0].consumed_at).toBeTruthy()

      const replayed = await service.confirm(actor, body)
      expect(replayed).toMatchObject({ bindingId: created.bindingId, version: 1, replayed: true })
      expect(providerCalls).toBe(2)
      expect(await count(pool, 'meta_record_revisions')).toBe(1)
      expect(await count(pool, 'meta_plm_collaboration_bindings')).toBe(1)

      const conflict = service.confirm(actor, {
        previewId: preview.previewId,
        requestId,
        expectedVersion: 1,
        targetBindingId: randomUUID(),
      })
      await expect(conflict).rejects.toMatchObject({ status: 409, code: 'TARGET_MISMATCH' })
      expect(providerCalls).toBe(2)
      expect(await count(pool, 'meta_record_revisions')).toBe(1)
      expect(await count(pool, 'meta_plm_collaboration_syncs')).toBe(1)
      const binding = await pool.query('SELECT version, status FROM meta_plm_collaboration_bindings')
      expect(binding.rows[0]).toMatchObject({ version: '1', status: 'active' })
    })
  })

  test('a token refusal for preview A does not stale unrelated binding B', async () => {
    await withFixture(async (pool) => {
      const { service, state } = openService(pool)
      const createdPreview = await service.preview(actor, previewBody())
      const created = await service.confirm(actor, {
        previewId: createdPreview.previewId,
        requestId: randomUUID(),
        expectedVersion: 0,
      })
      const sourceA = 'ds-eco-A'
      await pool.query(
        `INSERT INTO data_sources(id, name, type, config, owner_id, is_active, deleted_at, workspace_id, tenant_id, scope_kind)
         VALUES ($1, 'A', 'plm', $2::jsonb, $3, true, NULL, 'ws-1', 'meta-tenant', 'personal')`,
        [sourceA, JSON.stringify({ ...sourceConfig, credentials: { token: 'own-token-A' } }), actor],
      )
      const previewA = await service.preview(actor, {
        ...previewBody(),
        dataSourceId: sourceA,
        itemId: 'item-A',
        ecoId: 'eco-A',
        name: 'A collection',
      })
      const calls = state.calls.length
      state.rejectedSource = sourceA
      await expect(service.confirm(actor, {
        previewId: previewA.previewId,
        requestId: randomUUID(),
        expectedVersion: 1,
        targetBindingId: created.bindingId,
      })).rejects.toMatchObject({ status: 409, code: 'TARGET_MISMATCH' })
      expect(state.calls.length).toBe(calls)
      const rows = await pool.query('SELECT id::text, status, version FROM meta_plm_collaboration_bindings ORDER BY version')
      expect(rows.rows).toEqual([{ id: created.bindingId, status: 'active', version: '1' }])
    })
  })

  test('an exact replay refuses a changed source fingerprint and a read-only grant', async () => {
    await withFixture(async (pool) => {
      const { service, state } = openService(pool)
      const preview = await service.preview(actor, previewBody())
      const body = { previewId: preview.previewId, requestId: randomUUID(), expectedVersion: 0 }
      const created = await service.confirm(actor, body)
      const calls = state.calls.length
      await pool.query(
        `UPDATE data_sources SET config = jsonb_set(config, '{credentials,token}', to_jsonb($2::text)) WHERE id = $1`,
        [dataSourceId, 'changed-own-token'],
      )
      await expect(service.confirm(actor, body)).rejects.toMatchObject({ status: 409, code: 'SOURCE_CHANGED' })
      expect(state.calls.length).toBe(calls)
      await pool.query(
        `UPDATE data_sources SET config = jsonb_set(config, '{credentials,token}', to_jsonb($2::text)) WHERE id = $1`,
        [dataSourceId, 'plain-token'],
      )
      await pool.query(
        `UPDATE spreadsheet_permissions SET perm_code = 'spreadsheet:read'
          WHERE sheet_id = $1 AND subject_type = 'user' AND subject_id = $2`,
        [created.sheetId, actor],
      )
      const capabilities = await servicePool(pool).transaction(async ({ query }) => (
        resolveSheetCapabilitiesForUserOnQuery(query, created.sheetId, actor)
      ))
      expect(capabilities.capabilities.canRead).toBe(true)
      expect(capabilities.capabilities.canManageSheetAccess).toBe(false)
      await expect(service.confirm(actor, body)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
      expect(state.calls.length).toBe(calls)
      const binding = await pool.query('SELECT version::text, status FROM meta_plm_collaboration_bindings')
      expect(binding.rows[0]).toMatchObject({ version: '1', status: 'active' })
    })
  })

  test('a denied row returns no record metadata and fence off publishes nothing', async () => {
    await withFixture(async (pool) => {
      const { service, state } = openService(pool)
      const preview = await service.preview(actor, previewBody())
      const created = await service.confirm(actor, {
        previewId: preview.previewId,
        requestId: randomUUID(),
        expectedVersion: 0,
      })
      const recordId = created.recordId
      expect(typeof recordId).toBe('string')
      const viewer = `eco-viewer-${randomUUID()}`
      await pool.query(
        `INSERT INTO users(id, is_active, role, activation_status, local_password_set)
         VALUES ($1, true, 'member', 'activated', true)`,
        [viewer],
      )
      await pool.query(
        `INSERT INTO spreadsheet_permissions(sheet_id, subject_type, subject_id, perm_code)
         VALUES ($1, 'user', $2, 'spreadsheet:read')`,
        [created.sheetId, viewer],
      )
      await pool.query('UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1', [created.sheetId])
      const visible = await service.get(viewer, created.bindingId)
      expect(visible.row?.recordId).toBe(recordId)
      const hiddenHash = visible.row?.businessHash
      const hiddenCapturedAt = visible.row?.capturedAt
      await pool.query(
        `INSERT INTO record_permissions(sheet_id, record_id, subject_type, subject_id, access_level)
         VALUES ($1, $2, 'user', $3, 'none')`,
        [created.sheetId, recordId, viewer],
      )
      const scope = await servicePool(pool).transaction(async ({ query }) => (
        loadRecordPermissionScopeMap(query, created.sheetId, [String(recordId)], viewer)
      ))
      expect(scope.get(String(recordId))?.accessLevel).toBe('none')
      const calls = state.calls.length
      const denied = await service.get(viewer, created.bindingId)
      expect(denied.row).toBeNull()
      expect(denied.canRefresh).toBe(false)
      expect(state.calls.length).toBe(calls)
      const serialized = JSON.stringify(denied)
      for (const secret of [String(recordId), hiddenHash, hiddenCapturedAt, `"${ecoId}"`]) {
        expect(serialized).not.toContain(String(secret))
      }

      const held = await service.preview(actor, { ...previewBody(), ecoId: 'eco-held', name: 'Held collection' })
      const callsAfterHeld = state.calls.length
      const prior = process.env.MULTITABLE_ENABLE_WRITER_FENCE
      try {
        process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'false'
        await expect(service.preview(actor, { ...previewBody(), ecoId: 'eco-off-preview' })).rejects.toMatchObject({
          status: 503,
          code: 'ECO_RUNTIME_UNAVAILABLE',
        })
        await expect(service.confirm(actor, {
          previewId: held.previewId,
          requestId: randomUUID(),
          expectedVersion: 0,
        })).rejects.toMatchObject({ status: 503, code: 'ECO_RUNTIME_UNAVAILABLE' })
      } finally {
        if (prior === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
        else process.env.MULTITABLE_ENABLE_WRITER_FENCE = prior
      }
      expect(state.calls.length).toBe(callsAfterHeld)
      expect(await count(pool, 'meta_plm_collaboration_bindings')).toBe(1)
      expect(await count(pool, 'meta_record_history_operations')).toBe(1)
    })
  })

  test('a hidden source field redacts ECO identity and a local-only hide does not', async () => {
    await withFixture(async (pool) => {
      const { service, state } = openService(pool)
      const preview = await service.preview(actor, previewBody())
      const created = await service.confirm(actor, {
        previewId: preview.previewId,
        requestId: randomUUID(),
        expectedVersion: 0,
      })
      const recordId = created.recordId
      expect(typeof recordId).toBe('string')
      const viewer = `eco-field-viewer-${randomUUID()}`
      await pool.query(
        `INSERT INTO users(id, is_active, role, activation_status, local_password_set)
         VALUES ($1, true, 'member', 'activated', true)`,
        [viewer],
      )
      await pool.query(
        `INSERT INTO spreadsheet_permissions(sheet_id, subject_type, subject_id, perm_code)
         VALUES ($1, 'user', $2, 'spreadsheet:read')`,
        [created.sheetId, viewer],
      )
      const positive = await service.get(viewer, created.bindingId)
      expect(positive.row?.recordId).toBe(recordId)
      expect(positive.row?.cells.id).toBe(ecoId)
      expect(positive.row?.rowKey).toEqual([dataSourceId, tenant, org, ecoId])
      expect(positive.row?.businessHash).toMatch(/^[0-9a-f]{64}$/)
      const hiddenHash = positive.row?.businessHash
      const fields = await pool.query(
        'SELECT source_fields, local_fields FROM meta_plm_collaboration_bindings WHERE id=$1::uuid',
        [created.bindingId],
      )
      const idField = fields.rows[0].source_fields.id
      const noteField = fields.rows[0].local_fields.review_note
      expect(typeof idField).toBe('string')
      expect(typeof noteField).toBe('string')
      await pool.query(
        `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only)
         VALUES ($1, $2, 'user', $3, false, true)`,
        [created.sheetId, idField, viewer],
      )
      const scope = await servicePool(pool).transaction(async ({ query }) => (
        loadFieldPermissionScopeMap(query, created.sheetId, viewer)
      ))
      expect(scope.get(String(idField))?.visible).toBe(false)
      const calls = state.calls.length
      const hidden = await service.get(viewer, created.bindingId)
      expect(hidden.row?.recordId).toBe(recordId)
      expect(hidden.row?.cells.id).toBeUndefined()
      expect(hidden.row?.cells.name).toBe('Gate')
      expect(hidden.row?.rowKey).toBeNull()
      expect(hidden.row?.businessHash).toBeNull()
      expect(hidden.row?.capturedAt).toBeNull()
      expect(hidden).toMatchObject({ id: created.bindingId, sheetId: created.sheetId, sourceKind: 'eco' })
      expect(state.calls.length).toBe(calls)
      const serialized = JSON.stringify(hidden)
      expect(serialized).not.toContain(JSON.stringify(ecoId))
      expect(serialized).not.toContain(JSON.stringify(hiddenHash))
      await pool.query(
        'DELETE FROM field_permissions WHERE sheet_id=$1 AND field_id=$2 AND subject_id=$3',
        [created.sheetId, idField, viewer],
      )
      const authority = await servicePool(pool).transaction(async ({ query }) => (
        resolveSheetCapabilitiesForUserOnQuery(query, created.sheetId, actor)
      ))
      expect(authority.isAdminRole).toBe(false)
      expect(authority.capabilities.canEditRecord).toBe(true)
      expect(authority.capabilities.canManageFields).toBe(true)
      expect(authority.capabilities.canManageSheetAccess).toBe(true)
      const versionRow = await pool.query('SELECT version FROM meta_records WHERE id=$1', [recordId])
      const recordVersion = Number(versionRow.rows[0]?.version)
      expect(Number.isInteger(recordVersion)).toBe(true)
      expect(recordVersion).toBeGreaterThan(0)
      const noteId = String(noteField)
      const noteFields = [{
        id: noteId,
        name: 'review_note',
        type: 'longText' as const,
        property: {},
      }]
      const writer = new RecordWriteService(asServicePool(pool), new EventBus(), serviceHelpers(actor))
      const written = await writer.patchRecords({
        sheetId: created.sheetId,
        changesByRecord: new Map([[String(recordId), [{
          fieldId: noteId,
          value: 'kept-local',
          expectedVersion: recordVersion,
        }]]]),
        actorId: actor,
        fields: noteFields,
        visiblePropertyFields: noteFields,
        visiblePropertyFieldIds: new Set([noteId]),
        attachmentFields: [],
        fieldById: new Map([[noteId, { type: 'longText', readOnly: false, hidden: false, property: {} }]]),
        capabilities: authority.capabilities,
        access: { userId: actor, permissions: authority.permissions, isAdminRole: authority.isAdminRole },
        source: 'rest',
      })
      expect(written.updated).toEqual([{ recordId: String(recordId), version: recordVersion + 1 }])
      const stored = await service.get(viewer, created.bindingId)
      expect(stored.row?.recordId).toBe(recordId)
      expect(stored.row?.cells.review_note).toBe('kept-local')
      expect(stored.row?.cells.id).toBe(ecoId)
      expect(stored.row?.rowKey).toEqual([dataSourceId, tenant, org, ecoId])
      expect(stored.row?.businessHash).toBe(hiddenHash)
      expect(stored.row?.capturedAt).toBeTruthy()
      expect(state.calls.length).toBe(calls)
      const storedRow = await pool.query(
        'SELECT version::text, modified_by, data->>$2 AS note FROM meta_records WHERE id=$1',
        [recordId, noteId],
      )
      expect(storedRow.rows).toEqual([{
        version: String(recordVersion + 1),
        modified_by: actor,
        note: 'kept-local',
      }])
      const revision = await pool.query(
        `SELECT version::text, source, operation_id
           FROM meta_record_revisions
          WHERE record_id = $1 AND source = 'rest' AND version = $2`,
        [recordId, recordVersion + 1],
      )
      expect(revision.rows).toHaveLength(1)
      expect(revision.rows[0]?.source).toBe('rest')
      expect(revision.rows[0]?.version).toBe(String(recordVersion + 1))
      expect(typeof revision.rows[0]?.operation_id).toBe('string')
      expect(String(revision.rows[0]?.operation_id).length).toBeGreaterThan(0)
      const operation = await pool.query(
        'SELECT event_count::text FROM meta_record_history_operations WHERE operation_id = $1',
        [revision.rows[0]?.operation_id],
      )
      expect(operation.rows).toEqual([{ event_count: '1' }])
      await pool.query(
        `UPDATE meta_fields
            SET property = jsonb_set(COALESCE(property, '{}'::jsonb), '{hidden}', 'true'::jsonb)
          WHERE id=$1`,
        [noteField],
      )
      const localOnly = await service.get(viewer, created.bindingId)
      expect(localOnly.row?.recordId).toBe(recordId)
      expect(localOnly.row?.cells.id).toBe(ecoId)
      expect(localOnly.row?.rowKey).toEqual([dataSourceId, tenant, org, ecoId])
      expect(localOnly.row?.businessHash).toBe(hiddenHash)
      expect(localOnly.row?.capturedAt).toBeTruthy()
      expect(JSON.stringify(localOnly.row)).not.toContain('kept-local')
      expect(state.calls.length).toBe(calls)
    })
  })

  test('two concurrent confirms leave one committed writer and one version conflict', async () => {
    await withFixture(async (pool) => {
      // The fixture admin pool stays idle. These two confirms are the participants.
      const { service, state } = openService(pool)
      const firstPreview = await service.preview(actor, previewBody())
      const created = await service.confirm(actor, {
        previewId: firstPreview.previewId,
        requestId: randomUUID(),
        expectedVersion: 0,
      })
      const previewA = await service.preview(actor, previewBody())
      const previewB = await service.preview(actor, previewBody())
      const callsBefore = state.calls.length
      const settled = await Promise.allSettled([
        service.confirm(actor, {
          previewId: previewA.previewId,
          requestId: randomUUID(),
          expectedVersion: 1,
          targetBindingId: created.bindingId,
        }),
        service.confirm(actor, {
          previewId: previewB.previewId,
          requestId: randomUUID(),
          expectedVersion: 1,
          targetBindingId: created.bindingId,
        }),
      ])
      const ok = settled.find((item) => item.status === 'fulfilled')
      const lost = settled.find((item) => item.status === 'rejected')
      if (!ok || ok.status !== 'fulfilled' || !lost || lost.status !== 'rejected') {
        throw new Error('concurrent confirm did not split into one commit and one refusal')
      }
      expect(ok.value).toMatchObject({
        bindingId: created.bindingId,
        version: 2,
        status: 'active',
        replayed: false,
      })
      expect(lost.reason).toBeInstanceOf(EcoCollaborationSnapshotError)
      expect(lost.reason).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' })
      const previews = await pool.query(
        `SELECT id::text, (consumed_at IS NOT NULL) AS consumed
           FROM meta_plm_collaboration_previews
          WHERE id = ANY($1::uuid[])`,
        [[previewA.previewId, previewB.previewId]],
      )
      expect(previews.rows.filter((row) => row.consumed === true)).toHaveLength(1)
      const binding = await pool.query(
        'SELECT version::text, status FROM meta_plm_collaboration_bindings WHERE id=$1::uuid',
        [created.bindingId],
      )
      expect(binding.rows).toEqual([{ version: '2', status: 'active' }])
      expect(await count(pool, 'meta_records')).toBe(1)
      expect(await count(pool, 'meta_record_revisions')).toBe(2)
      expect(await count(pool, 'meta_record_history_operations')).toBe(2)
      expect(await count(pool, 'meta_plm_collaboration_syncs')).toBe(2)
      expect(state.calls.length).toBeGreaterThan(callsBefore)
    })
  })
})

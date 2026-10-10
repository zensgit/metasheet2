/**
 * D-H1 route/univer-meta writer-closure — constructed fence-before-check goldens.
 *
 * Closes the univer-meta source writer/deleter gaps on top of D2e: view writes, generic
 * config restore, provisioning, GET /view seed, and sheet_config PUTs.
 * Each family is a distinct HTTP writer. The wrong-sheet / ordering oracle is
 * mutation-sensitive: fencing a decoy sheet (or taking the fence after the source write)
 * reds the log assertions; a durable block on the decoy must not refuse a write to the
 * target, and a block on the target must refuse before any source mutation.
 *
 * Flag-off: fenceWriterEntry is a no-op, so an applying block is inert and the request
 * proceeds into existing (non-RECOVERY_IN_PROGRESS) semantics.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
import { canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'

const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const ARCHIVE_FLAG = 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED'
const SHEET = 'sheet_dh1_src'
const DECOY = 'sheet_dh1_decoy'
const VIEW = 'view_dh1_src'
const FIELD = 'fld_dh1_src'
const BASE = 'base_dh1_src'
const ACTOR = 'user_dh1_src'
const REVISION = 'rev_dh1_src'

type QueryResult = { rows: any[]; rowCount?: number }
type LogEntry = {
  kind: 'fence' | 'block-check' | 'source-write'
  sql: string
  sheetId?: string
  key?: string
}
type SqlTraceEntry = {
  sql: string
  params: unknown[]
}

const SOURCE_TABLES = [
  'meta_views',
  'meta_sheets',
  'meta_records',
  'meta_fields',
  'meta_links',
  'meta_config_revisions',
]

function sourceTableOf(sql: string): string | null {
  const match = sql.match(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-zA-Z0-9_]+)/i)
  if (!match) return null
  const table = match[1]
  return SOURCE_TABLES.includes(table) ? table : null
}

function classifySql(sql: string, params?: unknown[]): LogEntry | null {
  if (sql.includes('pg_advisory_xact_lock')) {
    const key = typeof params?.[0] === 'string' ? params[0] : ''
    if (key.startsWith('meta:auto-number:sheet:')) {
      return { kind: 'fence', sql, key, sheetId: key.slice('meta:auto-number:sheet:'.length) }
    }
    return null
  }
  if (sql.includes('SELECT recovery_writer_state FROM meta_sheets')) {
    return { kind: 'block-check', sql, sheetId: typeof params?.[0] === 'string' ? params[0] : undefined }
  }
  if (sourceTableOf(sql)) {
    const sheetId = typeof params?.[1] === 'string' && sql.includes('INSERT INTO meta_views')
      ? params[1]
      : typeof params?.[0] === 'string'
        ? params[0]
        : typeof params?.[1] === 'string'
          ? params[1]
          : undefined
    return { kind: 'source-write', sql, sheetId }
  }
  return null
}

function assertFenceBeforeSourceWrite(log: LogEntry[], sheetId: string): void {
  const fences = log.filter((e) => e.kind === 'fence')
  const checks = log.filter((e) => e.kind === 'block-check')
  const writes = log.filter((e) => e.kind === 'source-write')
  expect(fences.length).toBeGreaterThan(0)
  expect(checks.length).toBeGreaterThan(0)
  expect(writes.length).toBeGreaterThan(0)
  const firstFence = log.findIndex((e) => e.kind === 'fence')
  const firstCheck = log.findIndex((e) => e.kind === 'block-check')
  const firstWrite = log.findIndex((e) => e.kind === 'source-write')
  expect(firstFence).toBeGreaterThanOrEqual(0)
  expect(firstCheck).toBeGreaterThan(firstFence)
  expect(firstWrite).toBeGreaterThan(firstCheck)
  expect(fences.every((e) => e.sheetId === sheetId)).toBe(true)
  expect(fences.some((e) => e.key === canonicalSheetFenceKey(sheetId))).toBe(true)
  expect(fences.some((e) => e.sheetId === DECOY)).toBe(false)
  expect(checks.every((e) => e.sheetId === sheetId)).toBe(true)
}

function assertNoSourceWrite(log: LogEntry[]): void {
  expect(log.filter((e) => e.kind === 'source-write')).toEqual([])
}

type Store = {
  log: LogEntry[]
  trace: SqlTraceEntry[]
  blocked: Set<string>
  views: Array<{
    id: string
    sheet_id: string
    name: string
    type: string
    filter_info: Record<string, unknown>
    sort_info: Record<string, unknown>
    group_info: Record<string, unknown>
    hidden_field_ids: unknown[]
    config: Record<string, unknown>
  }>
  sheets: Array<{ id: string; base_id: string; name: string; description: string | null; owner_id?: string | null }>
  fields: Array<{ id: string; sheet_id: string; name: string; type: string; property: unknown; order: number }>
  handler: (sql: string, params?: unknown[]) => QueryResult
}

function createStore(opts?: { emptyViews?: boolean }): Store {
  const log: LogEntry[] = []
  const trace: SqlTraceEntry[] = []
  const blocked = new Set<string>()
  const views = opts?.emptyViews
    ? []
    : [{
        id: VIEW,
        sheet_id: SHEET,
        name: 'Grid',
        type: 'grid',
        filter_info: {},
        sort_info: {},
        group_info: {},
        hidden_field_ids: [],
        config: {},
      }]
  const sheets = [
    { id: SHEET, base_id: BASE, name: 'Source', description: null, owner_id: ACTOR },
    { id: DECOY, base_id: BASE, name: 'Decoy', description: null, owner_id: ACTOR },
  ]
  const fields = [
    { id: FIELD, sheet_id: SHEET, name: 'Title', type: 'string', property: {}, order: 0 },
  ]

  const handler = (sql: string, params?: unknown[]): QueryResult => {
    trace.push({
      sql: sql.replace(/\s+/g, ' ').trim(),
      params: params ? [...params] : [],
    })
    const classified = classifySql(sql, params)
    if (classified) log.push(classified)

    if (sql.includes('information_schema.columns') && sql.includes('recovery_writer_state')) {
      return { rows: [{ column_name: 'recovery_writer_state' }] }
    }
    if (sql.includes('SELECT recovery_writer_state FROM meta_sheets')) {
      const id = params?.[0] as string
      return { rows: [{ recovery_writer_state: blocked.has(id) ? 'applying' : null }] }
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      return { rows: [{}] }
    }
    if (
      sql.includes('FROM spreadsheet_permissions')
      || sql.includes('FROM field_permissions')
      || sql.includes('FROM view_permissions')
      || sql.includes('FROM meta_view_permissions')
      || sql.includes('FROM record_permissions')
      || sql.includes('FROM formula_dependencies')
    ) {
      return { rows: [] }
    }
    if (sql.includes('FROM meta_bases WHERE id = $1')) {
      return { rows: [{ id: BASE, owner_id: ACTOR }] }
    }
    if (sql.includes('source_base_id') || sql.includes("property ->> 'foreignSheetId'")) {
      return { rows: [] }
    }
    if (sql.includes('FROM meta_config_revisions WHERE id = $1 AND sheet_id = $2')) {
      return {
        rows: [{
          id: REVISION,
          sheet_id: SHEET,
          entity_type: 'field',
          entity_id: FIELD,
          action: 'update',
          before: { name: 'Old', type: 'string', property: {}, order: 0 },
          after: { name: 'Title', type: 'string', property: {}, order: 0 },
          changed_keys: ['name'],
        }],
      }
    }
    if (sql.includes('SELECT name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      const field = fields.find((f) => f.id === params?.[0])
      return { rows: field ? [{ name: field.name, type: field.type, property: field.property, order: field.order }] : [] }
    }
    if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      const field = fields.find((f) => f.id === params?.[0])
      return { rows: field ? [field] : [] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      const sheetId = params?.[0]
      return { rows: fields.filter((f) => f.sheet_id === sheetId) }
    }
    if (sql.includes('FROM meta_views WHERE id = $1')) {
      const view = views.find((v) => v.id === params?.[0])
      return { rows: view ? [view] : [] }
    }
    if (sql.includes('FROM meta_views WHERE sheet_id = $1')) {
      const sheetId = params?.[0]
      return { rows: views.filter((v) => v.sheet_id === sheetId) }
    }
    if (sql.includes('FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL') || sql.includes('FROM meta_sheets WHERE id = $1')) {
      const sheet = sheets.find((s) => s.id === params?.[0])
      if (!sheet) return { rows: [] }
      return {
        rows: [{
          id: sheet.id,
          base_id: sheet.base_id,
          name: sheet.name,
          description: sheet.description,
          owner_id: sheet.owner_id ?? null,
        }],
      }
    }
    if (sql.includes('INSERT INTO meta_views')) {
      const id = String(params?.[0] ?? VIEW)
      const sheetId = String(params?.[1] ?? SHEET)
      views.push({
        id,
        sheet_id: sheetId,
        name: String(params?.[2] ?? '默认视图'),
        type: String(params?.[3] ?? 'grid'),
        filter_info: {},
        sort_info: {},
        group_info: {},
        hidden_field_ids: [],
        config: {},
      })
      return { rows: [{ id }], rowCount: 1 }
    }
    if (sql.includes('UPDATE meta_views')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('DELETE FROM meta_views')) {
      const idx = views.findIndex((v) => v.id === params?.[0])
      if (idx >= 0) views.splice(idx, 1)
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO meta_sheets')) {
      const id = String(params?.[0] ?? SHEET)
      if (!sheets.some((s) => s.id === id)) {
        sheets.push({
          id,
          base_id: String(params?.[1] ?? BASE),
          name: String(params?.[2] ?? id),
          description: typeof params?.[3] === 'string' ? params[3] : null,
        })
      }
      return { rows: [{ id }], rowCount: 1 }
    }
    if (sql.includes('DELETE FROM meta_sheets')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('DELETE FROM meta_links')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO meta_fields') || sql.includes('INSERT INTO meta_records') || sql.includes('INSERT INTO meta_config_revisions')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE meta_fields') || sql.includes('UPDATE meta_sheets') || sql.includes('UPDATE meta_records')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO meta_bases')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM users')) {
      return { rows: [] }
    }
    if (sql.includes('FROM meta_records')) {
      return { rows: [] }
    }
    return { rows: [], rowCount: 0 }
  }

  return { log, trace, blocked, views, sheets, fields, handler }
}

function createMockPool(handler: (sql: string, params?: unknown[]) => QueryResult) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params))
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(handler: (sql: string, params?: unknown[]) => QueryResult) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const { __resetRecoveryWriterStateColumnProbe } = await import('../../src/multitable/canonical-sheet-fence')
  __resetRecoveryWriterStateColumnProbe()
  const mockPool = createMockPool(handler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: ACTOR,
      roles: [],
      // config-restore / person-fields prepare are canManageFields-gated, which now needs
      // `multitable:manage-schema` (src/multitable/manage-schema-permission.ts).
      perms: ['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema'],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const pinned = usePinnedServer()
const recoveryBody = {
  ok: false,
  error: {
    code: 'RECOVERY_IN_PROGRESS',
    message: 'Another recovery operation is in progress on this sheet; retry shortly.',
  },
}

afterEach(() => {
  delete process.env[FLAG]
  delete process.env[ARCHIVE_FLAG]
  delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
  delete process.env.MULTITABLE_ENABLE_PIT_RESET
  delete process.env.MULTITABLE_META_REVISION_RETENTION_ENABLED
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('D7 flag-off HTTP parity', () => {
  // REBASELINED DELIBERATELY (sheet soft delete). This pin hashes the exact SQL sequence the recovery
  // routes issue with the archive flag off. The sequence changed for one stated reason: capability
  // resolution now establishes SHEET LIVENESS first (`SELECT deleted_at FROM meta_sheets WHERE id = $1`,
  // multitable/sheet-liveness.ts), because `DELETE /sheets/:sheetId` became a SOFT delete and a
  // deleted sheet would otherwise stay fully readable and writable to anyone holding its id.
  //
  // The pin's PURPOSE is intact: it still proves the flag-off path is byte-identical across every
  // non-exact archive flag value. Only the frozen constant moved, and only by the one added query.
  // Previous value (pre-soft-delete): d44200359ffcbed8462e9655944244dbfd6933e11351e5b687b31b82e83876f6
  const HISTORICAL_FLAG_OFF_SHA256 = '626bd3e1d1fbe6010b149ca7fba822462312094a2a67911d26de2577056db455'

  it('keeps existing recovery responses and SQL byte-identical for every non-exact archive flag value', async () => {
    const probe = async (archiveFlag: string | undefined) => {
      delete process.env[FLAG]
      process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'false'
      process.env.MULTITABLE_ENABLE_PIT_RESET = 'false'
      process.env.MULTITABLE_META_REVISION_RETENTION_ENABLED = '0'
      if (archiveFlag === undefined) delete process.env[ARCHIVE_FLAG]
      else process.env[ARCHIVE_FLAG] = archiveFlag

      const store = createStore()
      const app = await createApp(store.handler)
      pinned.setApp(app)
      const configRestore = await request(pinned.url())
        .post(`/api/multitable/sheets/${SHEET}/config-restore-execute`)
        .send({ revisionId: REVISION, previewToken: 'dummy-token' })
      const revert = await request(pinned.url())
        .post(`/api/multitable/sheets/${SHEET}/revert-execute`)
        .send({ previewIdentity: 'dummy-token' })
      const reset = await request(pinned.url())
        .post(`/api/multitable/sheets/${SHEET}/reset-preview`)
        .send({ anchorOperationId: 'dummy-anchor' })

      return {
        responses: [configRestore, revert, reset].map((response) => ({
          status: response.status,
          text: response.text,
        })),
        sql: store.trace,
      }
    }

    const baseline = await probe(undefined)
    expect(createHash('sha256').update(JSON.stringify(baseline)).digest('hex'))
      .toBe(HISTORICAL_FLAG_OFF_SHA256)
    for (const value of ['false', 'TRUE', ' true ', '1']) {
      expect(await probe(value)).toEqual(baseline)
    }
  })
})

describe('D-H1 univer-meta writer closure — view writes', () => {
  it('POST /views applying block ⇒ 409 before INSERT (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).post('/api/multitable/views').send({
      sheetId: SHEET,
      name: 'New view',
      type: 'grid',
    })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
    expect(store.log.some((e) => e.kind === 'fence' && e.sheetId === SHEET)).toBe(true)
  })

  it('POST /views FLAG OFF: applying block is inert and the insert proceeds', async () => {
    delete process.env[FLAG]
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).post('/api/multitable/views').send({
      sheetId: SHEET,
      name: 'New view',
      type: 'grid',
    })
    expect(res.status).toBe(201)
    expect(res.body?.error?.code).not.toBe('RECOVERY_IN_PROGRESS')
    expect(store.log.some((e) => e.kind === 'fence')).toBe(false)
    expect(store.log.some((e) => e.kind === 'source-write' && e.sql.includes('INSERT INTO meta_views'))).toBe(true)
  })

  it('PATCH /views applying block ⇒ 409 before UPDATE (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).patch(`/api/multitable/views/${VIEW}`).send({ name: 'Renamed' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
  })

  it('DELETE /views applying block ⇒ 409 before DELETE (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).delete(`/api/multitable/views/${VIEW}`)
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
  })

  it('GET /views empty-list seed applying block ⇒ 409 before default-view INSERT (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore({ emptyViews: true })
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/multitable/views').query({ sheetId: SHEET })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
  })

  it('wrong-sheet/ordering oracle: decoy block does not refuse the target; fence key+order bind the source sheet', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    store.blocked.add(DECOY)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).post('/api/multitable/views').send({
      id: 'view_oracle',
      sheetId: SHEET,
      name: 'Oracle view',
      type: 'grid',
    })
    expect(res.status).toBe(201)
    assertFenceBeforeSourceWrite(store.log, SHEET)
    expect(store.log.some((e) => e.kind === 'source-write' && e.sql.includes('INSERT INTO meta_views'))).toBe(true)

    const blocked = createStore()
    blocked.blocked.add(SHEET)
    const blockedApp = await createApp(blocked.handler)
    pinned.setApp(blockedApp)
    const refused = await request(pinned.url()).post('/api/multitable/views').send({
      sheetId: SHEET,
      name: 'Should refuse',
      type: 'grid',
    })
    expect(refused.status).toBe(409)
    expect(refused.body).toEqual(recoveryBody)
    assertNoSourceWrite(blocked.log)
  })
})

describe('D-H1 univer-meta writer closure — generic config restore', () => {
  it('config-restore-execute generic branch applying block ⇒ 409 before snapshot/UPDATE (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET}/config-restore-execute`)
      .send({ revisionId: REVISION, previewToken: 'dummy-token' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
    expect(store.log.some((e) => e.kind === 'fence' && e.sheetId === SHEET)).toBe(true)
  })

  it('FLAG OFF: applying block is inert ⇒ dummy token reaches PREVIEW_IDENTITY_INVALID, not RECOVERY', async () => {
    delete process.env[FLAG]
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET}/config-restore-execute`)
      .send({ revisionId: REVISION, previewToken: 'dummy-token' })
    expect(res.body?.error?.code).not.toBe('RECOVERY_IN_PROGRESS')
    expect(res.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')
    expect(store.log.some((e) => e.kind === 'fence')).toBe(false)
  })
})

describe('D-H1 univer-meta writer closure — form-share view.config UPDATE', () => {
  it('PATCH form-share applying block ⇒ 409 before meta_views UPDATE (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url())
      .patch(`/api/multitable/sheets/${SHEET}/views/${VIEW}/form-share`)
      .send({ enabled: true })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
    expect(store.log.some((e) => e.kind === 'fence' && e.sheetId === SHEET)).toBe(true)
  })

  it('POST form-share/regenerate applying block ⇒ 409 before meta_views UPDATE (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET}/views/${VIEW}/form-share/regenerate`)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
    expect(store.log.some((e) => e.kind === 'fence' && e.sheetId === SHEET)).toBe(true)
  })

  it('PATCH form-share FLAG OFF: applying block is inert, no fence traffic, and the UPDATE proceeds', async () => {
    delete process.env[FLAG]
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url())
      .patch(`/api/multitable/sheets/${SHEET}/views/${VIEW}/form-share`)
      .send({ enabled: true })
    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
    expect(res.body?.data?.enabled).toBe(true)
    expect(typeof res.body?.data?.publicToken).toBe('string')
    expect(res.body?.error?.code).not.toBe('RECOVERY_IN_PROGRESS')
    expect(store.log.some((e) => e.kind === 'fence')).toBe(false)
    expect(store.log.some((e) => e.kind === 'block-check')).toBe(false)
    expect(store.log.some((e) => e.kind === 'source-write' && e.sql.includes('UPDATE meta_views'))).toBe(true)
  })

  it('POST form-share/regenerate FLAG OFF: applying block is inert, no fence traffic, and the UPDATE proceeds', async () => {
    delete process.env[FLAG]
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url())
      .post(`/api/multitable/sheets/${SHEET}/views/${VIEW}/form-share/regenerate`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
    expect(typeof res.body?.data?.publicToken).toBe('string')
    expect(res.body?.error?.code).not.toBe('RECOVERY_IN_PROGRESS')
    expect(store.log.some((e) => e.kind === 'fence')).toBe(false)
    expect(store.log.some((e) => e.kind === 'block-check')).toBe(false)
    expect(store.log.some((e) => e.kind === 'source-write' && e.sql.includes('UPDATE meta_views'))).toBe(true)
  })
})

describe('D-H1 univer-meta writer closure — provisioning', () => {
  it('POST /sheets applying block ⇒ 409 before meta_sheets INSERT (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    store.blocked.add('sheet_new_1')
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).post('/api/multitable/sheets').send({
      id: 'sheet_new_1',
      baseId: BASE,
      name: 'Provisioned',
    })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
    expect(store.log.some((e) => e.kind === 'fence' && e.sheetId === 'sheet_new_1')).toBe(true)
  })

  it('POST /sheets FLAG OFF: applying block is inert and the sheet is created', async () => {
    delete process.env[FLAG]
    const store = createStore()
    store.blocked.add('sheet_new_off')
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).post('/api/multitable/sheets').send({
      id: 'sheet_new_off',
      baseId: BASE,
      name: 'Provisioned off',
    })
    expect(res.status).toBe(200)
    expect(res.body?.error?.code).not.toBe('RECOVERY_IN_PROGRESS')
    expect(store.log.some((e) => e.kind === 'fence')).toBe(false)
    expect(store.log.some((e) => e.kind === 'source-write' && e.sql.includes('INSERT INTO meta_sheets'))).toBe(true)
  })

  it('POST /person-fields/prepare applying block on the people sheet ⇒ 409 before INSERT (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    const original = store.handler
    // Newly provisioned people-sheet ids are generated inside the helper. Mark that generated id
    // applying on the fence-before-check so a wrong-target fence on the source sheet would miss it.
    const wrapping: Store['handler'] = (sql, params) => {
      const classified = classifySql(sql, params)
      if (classified?.kind === 'block-check' && classified.sheetId && classified.sheetId !== SHEET && classified.sheetId !== DECOY) {
        store.blocked.add(classified.sheetId)
      }
      return original(sql, params)
    }
    const app = await createApp(wrapping)
    pinned.setApp(app)
    const res = await request(pinned.url()).post('/api/multitable/person-fields/prepare').send({ sheetId: SHEET })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
    expect(store.log.some((e) => e.kind === 'fence' && e.sheetId !== SHEET && e.sheetId !== DECOY)).toBe(true)
  })
})

describe('D-H1 univer-meta writer closure — GET seed mutation', () => {
  it('GET /view?seed=true applying block ⇒ 409 before seeded INSERT (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/multitable/view').query({ sheetId: SHEET, seed: 'true' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
    expect(store.log.some((e) => e.kind === 'fence' && e.sheetId === SHEET)).toBe(true)
  })

  it('GET /view?seed=true FLAG OFF: applying block is inert and seed writes proceed', async () => {
    delete process.env[FLAG]
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/multitable/view').query({ sheetId: SHEET, seed: 'true' })
    expect(res.body?.error?.code).not.toBe('RECOVERY_IN_PROGRESS')
    expect(store.log.some((e) => e.kind === 'fence')).toBe(false)
    expect(store.log.some((e) => e.kind === 'source-write' && (
      e.sql.includes('INSERT INTO meta_records') || e.sql.includes('INSERT INTO meta_fields') || e.sql.includes('INSERT INTO meta_sheets')
    ))).toBe(true)
  })
})

describe('D-H1 univer-meta writer closure — sheet_config writers', () => {
  it('PUT row-level-read-deny applying block ⇒ 409 before UPDATE (flag ON)', async () => {
    process.env[FLAG] = 'true'
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url())
      .put(`/api/multitable/sheets/${SHEET}/row-level-read-deny`)
      .send({ enabled: true })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(recoveryBody)
    assertNoSourceWrite(store.log)
  })

  it('PUT conditional-rules FLAG OFF: applying block is inert and the update proceeds', async () => {
    delete process.env[FLAG]
    const store = createStore()
    store.blocked.add(SHEET)
    const app = await createApp(store.handler)
    pinned.setApp(app)
    const res = await request(pinned.url())
      .put(`/api/multitable/sheets/${SHEET}/conditional-rules`)
      .send({ rules: [] })
    expect(res.status).toBe(200)
    expect(res.body?.error?.code).not.toBe('RECOVERY_IN_PROGRESS')
    expect(store.log.some((e) => e.kind === 'source-write' && e.sql.includes('UPDATE meta_sheets'))).toBe(true)
  })
})

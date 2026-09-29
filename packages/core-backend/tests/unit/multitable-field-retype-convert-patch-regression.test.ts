/**
 * 字段类型转换第 2 刀的**新回归**（ADR docs/development/multitable-field-retype-first-batch-adr-20260926.md §1 L6 / §6 第 2 刀）：
 * 打开 `MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT='true'` 之后，`PATCH /fields/:fieldId` 对首批两对
 * `string → select` 与 `string → multiSelect` **仍然** 400 `FIELD_RETYPE_NOT_LOSSLESS`，且零记录写入、字段行不变。
 *
 * 为什么单独成文件：既有 narrowing 用例（tests/multitable-field-retype-revert-narrowing.test.ts 的 PATCH 强制 describe）
 * 与 integration F8A describe 只钉了 `string → number / person`，从没钉过这两对；而本 flag 恰恰「打开」这两对的另一条
 * 受控路径。这里证明 flag 只开新路径、不放宽 PATCH——转换只能走预览 → 执行，不能被一次裸 PATCH 替代。
 * 假 pool + pinned server（#4154），DB-free。
 */
import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { FIELD_RETYPE_NOT_LOSSLESS_CODE } from '../../src/multitable/field-retype-whitelist'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET = 'sheet_convert_patch'
const FIELD = 'fld_convert_patch'

type Row = { id: string; sheet_id: string; name: string; type: string; property: Record<string, unknown>; order: number }

function createStore() {
  const field: Row = { id: FIELD, sheet_id: SHEET, name: 'Status', type: 'string', property: {}, order: 0 }
  const writes: string[] = []
  const handler = (sql: string, params: unknown[] = []): { rows: any[]; rowCount?: number } => {
    if (/\b(INSERT|UPDATE|DELETE)\b/i.test(sql) && /\b(meta_records|meta_fields|meta_record_revisions|meta_config_revisions)\b/.test(sql)) {
      writes.push(sql)
    }
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET, base_id: 'base_1', name: 'Sheet', description: null, deleted_at: null }] }
    }
    if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
      return { rows: params[0] === FIELD ? [{ id: FIELD, sheet_id: SHEET }] : [] }
    }
    if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      return { rows: params[0] === FIELD ? [{ ...field }] : [] }
    }
    if (sql.includes('UPDATE meta_fields') && sql.includes('SET name = $2, type = $3')) {
      const [, name, type, propertyJson] = params as [string, string, string, string]
      field.name = name
      field.type = type
      field.property = JSON.parse(propertyJson)
      return { rows: [{ ...field }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) return { rows: [{ ...field }] }
    return { rows: [], rowCount: 0 }
  }
  return { field, writes, handler }
}

/** One router per file (imported once); each test swaps only the fake pool's handler. */
type Handler = (sql: string, params?: unknown[]) => { rows: any[]; rowCount?: number }
const state: { handler: Handler } = { handler: () => ({ rows: [] }) }

const pinned = usePinnedServer()

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(['multitable:read', 'multitable:write', 'multitable:manage-schema']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (
      sql.includes('FROM spreadsheet_permissions')
      || sql.includes('FROM field_permissions')
      || sql.includes('FROM view_permissions')
      || sql.includes('FROM meta_view_permissions')
      || sql.includes('FROM record_permissions')
      || sql.includes('FROM formula_dependencies')
    ) {
      return { rows: [], rowCount: 0 }
    }
    return state.handler(sql, params)
  })
  const mockPool = { query, transaction: vi.fn(async (fn: (c: { query: typeof query }) => Promise<unknown>) => fn({ query })) }
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'user_convert_patch', roles: [], perms: ['multitable:read', 'multitable:write', 'multitable:manage-schema'] } as any
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  pinned.setApp(app)
}, 120_000)

afterAll(() => {
  vi.restoreAllMocks()
  vi.doUnmock('../../src/rbac/service')
  vi.resetModules()
})

describe('PATCH /fields/:fieldId with MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT=true — the first-batch pairs stay refused', () => {
  beforeEach(() => {
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', 'true')
    vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  for (const target of ['select', 'multiSelect'] as const) {
    test(`string → ${target} ⇒ 400 FIELD_RETYPE_NOT_LOSSLESS, zero record writes, field row unchanged`, async () => {
      expect(process.env.MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT).toBe('true')
      const store = createStore()
      state.handler = store.handler
      const res = await request(pinned.url())
        .patch(`/api/multitable/fields/${FIELD}`)
        .send({ type: target, property: { options: [{ value: 'A' }] } })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe(FIELD_RETYPE_NOT_LOSSLESS_CODE)
      expect(store.writes).toEqual([])
      expect(store.field.type).toBe('string')
      expect(store.field.property).toEqual({})
    })
  }

  test('positive control: the same harness DOES write for a whitelisted retype (string → longText)', async () => {
    const store = createStore()
    state.handler = store.handler
    const res = await request(pinned.url()).patch(`/api/multitable/fields/${FIELD}`).send({ type: 'longText' })
    expect(res.status).toBe(200)
    expect(store.field.type).toBe('longText')
    expect(store.writes.some((sql) => sql.includes('UPDATE meta_fields'))).toBe(true)
  })
})

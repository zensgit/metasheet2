/**
 * 关联字段缺目标表 —— 写入口 fail-closed + 读取侧稳定错误码（2026-09-10，用户报告）。
 *
 * 现象：多维表关联字段点「选择关联记录」，弹窗直接显示
 * `Link field is missing foreignSheetId: fld_63b459ab-...`。
 *
 * 根因（写侧 fail-open）：`sanitizeFieldPropertyByType` 的 link 分支在 foreignSheetId 为空时把这个键
 * 省略掉，而 §2a.2 的墙 `validateLinkFieldConfig` 在 `parseLinkFieldConfig` 返回 null 时 return null，
 * 调用点还额外用 `linkForeignKeyInPayload` 收窄 —— 于是 `POST /fields {type:'link'}` 不带 property、或
 * `PATCH {type:'link'}` 类型转换，都能落一个没有目标表的 link 字段。
 *
 * 本文件钉三件事：
 *   1. 创建/更新侧拒绝落库，稳定码 LINK_FIELD_FOREIGN_SHEET_REQUIRED，message 不含 fieldId；
 *   2. 已有坏字段的读取侧（GET /fields/:fieldId/link-options）给稳定码
 *      LINK_FIELD_FOREIGN_SHEET_MISSING，message 同样不回显 fieldId；
 *   3. 正常 link 字段（创建 / 纯改名 PATCH）不受影响 —— 这道门只收紧"结果状态非法"的写。
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_lnkreq_1'
const TARGET_SHEET_ID = 'sheet_lnkreq_target'
const LINK_FIELD_ID = 'fld_lnkreq_broken'
const STRING_FIELD_ID = 'fld_lnkreq_string'
const HEALTHY_LINK_FIELD_ID = 'fld_lnkreq_healthy'

type QueryResult = { rows: any[]; rowCount?: number }

type StoredField = {
  id: string
  sheet_id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}

function createStore(fields: StoredField[]) {
  const byId = new Map(fields.map((f) => [f.id, { ...f, property: { ...f.property } }]))
  const inserted: Array<{ id: string; type: string; property: Record<string, unknown> }> = []

  const handler = (sql: string, params?: unknown[]): QueryResult => {
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      const id = String(params?.[0] ?? SHEET_ID)
      return { rows: [{ id, base_id: 'base_lnkreq', name: 'Sheet', description: null, deleted_at: null }] }
    }
    if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
      const f = byId.get(String(params?.[0]))
      return { rows: f ? [{ id: f.id, sheet_id: f.sheet_id }] : [] }
    }
    if (sql.includes('SELECT id, sheet_id, name, type, property FROM meta_fields WHERE id = $1')) {
      const f = byId.get(String(params?.[0]))
      return { rows: f ? [{ ...f }] : [] }
    }
    if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      const f = byId.get(String(params?.[0]))
      return { rows: f ? [{ ...f }] : [] }
    }
    if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      const f = byId.get(String(params?.[0]))
      return { rows: f ? [{ id: f.id, name: f.name, type: f.type, property: f.property, order: f.order }] : [] }
    }
    if (sql.includes('COALESCE(MAX("order")')) {
      return { rows: [{ max_order: byId.size - 1 }] }
    }
    if (sql.includes('INSERT INTO meta_fields')) {
      const [id, sheetId, name, type, propertyJson, order] = params as [string, string, string, string, string, number]
      const property = JSON.parse(propertyJson)
      byId.set(id, { id, sheet_id: sheetId, name, type, property, order })
      inserted.push({ id, type, property })
      return { rows: [{ id, name, type, property, order }] }
    }
    // 真实语句是多行的 `UPDATE meta_fields\n SET name = $2, ...`，用列名片段匹配，避开 order 位移的那几条
    if (sql.includes('UPDATE meta_fields') && sql.includes('SET name = $2, type = $3')) {
      const [, name, type, propertyJson, order] = params as [string, string, string, string, number]
      const fieldId = String(params?.[0])
      const existing = byId.get(fieldId)
      if (existing) {
        existing.name = name
        existing.type = type
        existing.property = JSON.parse(propertyJson)
        existing.order = order
        return { rows: [{ id: existing.id, name, type, property: existing.property, order }] }
      }
      return { rows: [] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return {
        rows: Array.from(byId.values()).map((f) => ({
          id: f.id, name: f.name, type: f.type, property: f.property, order: f.order,
        })),
      }
    }
    return { rows: [], rowCount: 0 }
  }

  return { byId, inserted, handler }
}

function createMockPool(handler: (sql: string, params?: unknown[]) => QueryResult) {
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
    return handler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(handler: (sql: string, params?: unknown[]) => QueryResult) {
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
  const mockPool = createMockPool(handler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_lnkreq',
      roles: [],
      perms: ['multitable:read', 'multitable:write', 'multitable:manage-schema'],
    } as any
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const pinned = usePinnedServer()

describe('link field without a foreign sheet — write fail-closed + readable read error', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('POST /fields rejects a link field with no foreignSheetId (stable code, no fieldId in message, nothing inserted)', async () => {
    const store = createStore([])
    pinned.setApp(await createApp(store.handler))

    const res = await request(pinned.url())
      .post('/api/multitable/fields')
      .send({ sheetId: SHEET_ID, name: '关联', type: 'link' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('LINK_FIELD_FOREIGN_SHEET_REQUIRED')
    // values-free：报错文案里不许出现字段 id / 表 id（用户报告的原始报错就是把 fld_... 甩了出来）
    expect(String(res.body.error.message)).not.toMatch(/fld[_-]/)
    expect(String(res.body.error.message)).not.toContain(SHEET_ID)
    expect(store.inserted).toHaveLength(0)
  })

  it('POST /fields rejects a link field whose foreign aliases are all blank', async () => {
    const store = createStore([])
    pinned.setApp(await createApp(store.handler))

    const res = await request(pinned.url())
      .post('/api/multitable/fields')
      .send({
        sheetId: SHEET_ID,
        name: '关联',
        type: 'link',
        property: { foreignSheetId: '  ', foreignDatasheetId: '', datasheetId: '', limitSingleRecord: true },
      })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('LINK_FIELD_FOREIGN_SHEET_REQUIRED')
    expect(store.inserted).toHaveLength(0)
  })

  it('POST /fields still accepts a link field WITH a foreign sheet (positive control)', async () => {
    const store = createStore([])
    pinned.setApp(await createApp(store.handler))

    const res = await request(pinned.url())
      .post('/api/multitable/fields')
      .send({
        sheetId: SHEET_ID,
        name: '关联',
        type: 'link',
        property: { foreignSheetId: TARGET_SHEET_ID, limitSingleRecord: false },
      })

    expect(res.status).toBe(201)
    expect(store.inserted).toHaveLength(1)
    expect(store.inserted[0].property.foreignSheetId).toBe(TARGET_SHEET_ID)
  })

  it('PATCH /fields/:id rejects converting a non-link field into a targetless link', async () => {
    const store = createStore([
      { id: STRING_FIELD_ID, sheet_id: SHEET_ID, name: '文本', type: 'string', property: {}, order: 0 },
    ])
    pinned.setApp(await createApp(store.handler))

    const res = await request(pinned.url())
      .patch(`/api/multitable/fields/${STRING_FIELD_ID}`)
      .send({ type: 'link' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('LINK_FIELD_FOREIGN_SHEET_REQUIRED')
    expect(String(res.body.error.message)).not.toMatch(/fld[_-]/)
    // 事务回滚语义：字段类型没有被改写
    expect(store.byId.get(STRING_FIELD_ID)?.type).toBe('string')
  })

  it('PATCH /fields/:id rejects re-writing a link property that drops the foreign sheet', async () => {
    const store = createStore([
      {
        id: HEALTHY_LINK_FIELD_ID,
        sheet_id: SHEET_ID,
        name: '关联',
        type: 'link',
        property: { foreignSheetId: TARGET_SHEET_ID, foreignDatasheetId: TARGET_SHEET_ID, limitSingleRecord: false },
        order: 0,
      },
    ])
    pinned.setApp(await createApp(store.handler))

    const res = await request(pinned.url())
      .patch(`/api/multitable/fields/${HEALTHY_LINK_FIELD_ID}`)
      .send({ property: { limitSingleRecord: true } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('LINK_FIELD_FOREIGN_SHEET_REQUIRED')
    expect(store.byId.get(HEALTHY_LINK_FIELD_ID)?.property.foreignSheetId).toBe(TARGET_SHEET_ID)
  })

  it('PATCH /fields/:id still accepts a rename on a healthy link field (positive control)', async () => {
    const store = createStore([
      {
        id: HEALTHY_LINK_FIELD_ID,
        sheet_id: SHEET_ID,
        name: '关联',
        type: 'link',
        property: { foreignSheetId: TARGET_SHEET_ID, foreignDatasheetId: TARGET_SHEET_ID, limitSingleRecord: false },
        order: 0,
      },
    ])
    pinned.setApp(await createApp(store.handler))

    const res = await request(pinned.url())
      .patch(`/api/multitable/fields/${HEALTHY_LINK_FIELD_ID}`)
      .send({ name: '关联记录' })

    expect(res.status).toBe(200)
    expect(store.byId.get(HEALTHY_LINK_FIELD_ID)?.name).toBe('关联记录')
  })

  it('PATCH /fields/:id repairs an EXISTING broken link field once a target sheet is chosen (self-heal)', async () => {
    const store = createStore([
      { id: LINK_FIELD_ID, sheet_id: SHEET_ID, name: '关联', type: 'link', property: {}, order: 0 },
    ])
    pinned.setApp(await createApp(store.handler))

    const res = await request(pinned.url())
      .patch(`/api/multitable/fields/${LINK_FIELD_ID}`)
      .send({ property: { foreignSheetId: TARGET_SHEET_ID, limitSingleRecord: false } })

    expect(res.status).toBe(200)
    expect(store.byId.get(LINK_FIELD_ID)?.property.foreignSheetId).toBe(TARGET_SHEET_ID)
  })

  it('GET /fields/:id/link-options answers a stable code and values-free message for an existing broken field', async () => {
    const store = createStore([
      { id: LINK_FIELD_ID, sheet_id: SHEET_ID, name: '关联', type: 'link', property: {}, order: 0 },
    ])
    pinned.setApp(await createApp(store.handler))

    const res = await request(pinned.url()).get(`/api/multitable/fields/${LINK_FIELD_ID}/link-options`)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('LINK_FIELD_FOREIGN_SHEET_MISSING')
    expect(String(res.body.error.message)).not.toContain(LINK_FIELD_ID)
    expect(String(res.body.error.message)).not.toMatch(/foreignSheetId/i)
  })
  it('PATCH /fields/:id accepts a legacy link-backed person field that CARRIES refKind + foreign sheet (positive control)', async () => {
    // 历史人员字段的存量形态是 type='link' + refKind:'user'，property 里带指向 People 表的 foreignSheetId。
    // 前端 person 分支现在把这两个结构键原样带回，所以"改单选/多选"这条合法编辑不会被这道门挡住 ——
    // 这条正控钉住这一点（它红 = 存量人员字段没法编辑了）。
    const PERSON_FIELD_ID = 'fld_lnkreq_person'
    const PEOPLE_SHEET_ID = 'sheet_lnkreq_people'
    const store = createStore([
      {
        id: PERSON_FIELD_ID,
        sheet_id: SHEET_ID,
        name: '负责人',
        type: 'link',
        property: { refKind: 'user', foreignSheetId: PEOPLE_SHEET_ID, foreignDatasheetId: PEOPLE_SHEET_ID, limitSingleRecord: true },
        order: 0,
      },
    ])
    pinned.setApp(await createApp(store.handler))

    const res = await request(pinned.url())
      .patch(`/api/multitable/fields/${PERSON_FIELD_ID}`)
      .send({ property: { refKind: 'user', foreignSheetId: PEOPLE_SHEET_ID, foreignDatasheetId: PEOPLE_SHEET_ID, limitSingleRecord: false } })

    expect(res.status).toBe(200)
    expect(store.byId.get(PERSON_FIELD_ID)?.property.foreignSheetId).toBe(PEOPLE_SHEET_ID)
    expect(store.byId.get(PERSON_FIELD_ID)?.property.refKind).toBe('user')
  })

  it('PATCH /fields/:id rejects the OLD person-edit shape that dropped refKind + foreign sheet (the bad-field factory)', async () => {
    // 修复前，前端 person 分支只发 `limitSingleRecord`，而 PATCH 是整体替换 property —— 一次编辑就把
    // 人员字段打成"link 但没有目标表"。这道门现在把这种写法拦在落库之前。
    const PERSON_FIELD_ID = 'fld_lnkreq_person2'
    const PEOPLE_SHEET_ID = 'sheet_lnkreq_people'
    const store = createStore([
      {
        id: PERSON_FIELD_ID,
        sheet_id: SHEET_ID,
        name: '负责人',
        type: 'link',
        property: { refKind: 'user', foreignSheetId: PEOPLE_SHEET_ID, foreignDatasheetId: PEOPLE_SHEET_ID, limitSingleRecord: true },
        order: 0,
      },
    ])
    pinned.setApp(await createApp(store.handler))

    const res = await request(pinned.url())
      .patch(`/api/multitable/fields/${PERSON_FIELD_ID}`)
      .send({ property: { limitSingleRecord: false } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('LINK_FIELD_FOREIGN_SHEET_REQUIRED')
    expect(store.byId.get(PERSON_FIELD_ID)?.property.foreignSheetId).toBe(PEOPLE_SHEET_ID)
  })
})

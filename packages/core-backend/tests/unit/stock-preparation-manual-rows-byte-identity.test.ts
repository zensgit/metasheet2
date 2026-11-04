/**
 * 人工补充行 B2 (ADR adr-stock-prep-manual-rows-20261030 §3.0, §3.7, §8 「B2 主机」 9) — BYTE IDENTITY for every sheet and
 * every actor the manual-row block must NOT reach.
 *
 * B2 adds `capabilities.stockPreparationManualRows` to `/context` on a P_reg sheet for an actor who can create, edit or
 * delete records, and `manualSupplement: true` to the rowActions of a manual row on `/view` and `/records/:id`. For
 * everything else the answers must be exactly what the base produced. This file records them for stock-preparation
 * template sheets that are NOT P_reg, and for the P_reg sheet where nothing may change:
 *   - S_NO087   the registered project-sheet shape (plugin-integration-core, `…_sandbox_p_<24 hex>`) WITHOUT a plugin
 *               registry (087) row — the PB-05 shape (provisioned only);
 *   - S_ENV     the env main table (`plm_stock_preparation_main`, never (a));
 *   - S_OTHER   a project-shaped object id registered by ANOTHER plugin;
 *   - S_COPY    the template stanza with no host registry row (a user's 复制数据表 copy);
 *   - S_PREG    a P_reg sheet (087 row, active): /context for the READER only (no create / edit / delete), /view and
 *               /records/:id for everyone (its rows carry no `manual:` key, so no row gains a mark);
 *   - S_PREG under "087 table missing" (42P01 on the plugin registry read): /context for the writer and the admin must be
 *               what the base answered — 42P01 means "not registered", so the old behaviour stays (§3.0).
 * Each over GET /context, GET /view and GET /records/:id (a PLM-keyed row and a keyless row), for an admin, a writer and
 * a reader. Each answer is reduced to canonical JSON (object keys sorted) and compared, as its sha256, with
 * tests/fixtures/stock-preparation-manual-rows-byte-identity.json (one hash per entry; the full answers run to ~1 MB
 * because every sheet carries the 33-column template, so the fixture holds their hashes — same strictness).
 *
 * PROVENANCE. The full answers were captured on the base this branch starts from (origin/main ccfe1432a, B1 merged), in
 * this worktree BEFORE any src change, with this file as the only addition (it imports nothing the PR adds):
 *   MRB2_CAPTURE_BASELINE=<path> vitest run tests/unit/stock-preparation-manual-rows-byte-identity.test.ts
 * (that capture's sha256: b4341418f812b1d0a4bdc388aa9f124cd6dcbec69b081655f322d2dd417f1c94). The fixture is
 * sha256(JSON.stringify(entry)) of each captured entry. The PR head must reproduce every hash. A capture now writes the
 * hash map to <path> and the full canonical answers to <path>.full.json (to diff a failure against).
 *
 * Mock pool, no DB, the real univer-meta router behind one pinned listener (`request(app)` is banned in tests/unit,
 * #4154). Every value is synthetic.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { getObjectFieldId, getObjectSheetId } from '../../src/multitable/provisioning'
import { usePinnedServer } from '../utils/pinned-server'

const requireCjs = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const templates = requireCjs('../../../../plugins/plugin-integration-core/lib/stock-preparation-templates.cjs') as any

const rbacState = vi.hoisted(() => ({ admin: {} as Record<string, boolean> }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async (userId: string) => rbacState.admin[userId] === true),
  userHasPermission: vi.fn(async () => false),
  listUserPermissions: vi.fn(async () => []),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))

const PROJECT_ID = 'tenant_mrb2_identity:integration-core'
const BASE_ID = 'base_mrb2_identity'
const PROJECT_OBJECT = 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567'
const NO087_OBJECT = 'plm_stock_preparation_sandbox_p_89abcdef0123456789abcdef'
const OTHER_OBJECT = 'plm_stock_preparation_sandbox_p_fedcba9876543210fedcba98'
const ENV_OBJECT = 'plm_stock_preparation_main'
const COPY_OBJECT = 'plm_stock_preparation_sandbox_p_00112233445566778899aabb'

type SheetSpec = { key: string; objectId: string; plugin: string | null; target: { status: string } | null }
const SHEET_SPECS: SheetSpec[] = [
  { key: 'S_PREG', objectId: PROJECT_OBJECT, plugin: 'plugin-integration-core', target: { status: 'active' } },
  { key: 'S_NO087', objectId: NO087_OBJECT, plugin: 'plugin-integration-core', target: null },
  { key: 'S_ENV', objectId: ENV_OBJECT, plugin: 'plugin-integration-core', target: null },
  { key: 'S_OTHER', objectId: OTHER_OBJECT, plugin: 'plugin-other-synthetic', target: null },
  { key: 'S_COPY', objectId: COPY_OBJECT, plugin: null, target: null },
]
const SHEETS = SHEET_SPECS.map((spec) => ({ ...spec, sheetId: getObjectSheetId(PROJECT_ID, spec.objectId) }))
const sheetByKey = (key: string) => SHEETS.find((s) => s.key === key)!
const sheetById = (id: unknown) => SHEETS.find((s) => s.sheetId === id)

type TemplateField = { id: string; label: string; type: string; ownership: string; required?: boolean; key?: boolean; preserveOnRefresh?: boolean }
const TEMPLATE_FIELDS = templates.STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields as TemplateField[]
const phys = (objectId: string, logical: string) => getObjectFieldId(PROJECT_ID, objectId, logical)

function fieldRowsFor(objectId: string, sheetId: string) {
  return TEMPLATE_FIELDS.map((field, order) => {
    const property: Record<string, unknown> = {}
    if (field.required) property.validation = [{ type: 'required' }]
    property.stockPreparation = { ownership: field.ownership, preserveOnRefresh: field.preserveOnRefresh === true, required: field.required === true, key: field.key === true }
    if (field.ownership === 'plm_system') property.humanWriteLock = 'plm_system'
    return { id: phys(objectId, field.id), sheet_id: sheetId, name: field.label, type: field.type, property, order }
  })
}

const PLM_KEY = JSON.stringify({ projectNo: 'SYN-MRB2-0001', componentSourceId: 'SYN-PART-1', parentSourceId: null, path: '["SYN-PART-1"]' })
function recordsFor(objectId: string, sheetId: string) {
  const p = (logical: string) => phys(objectId, logical)
  return [
    {
      id: `rec_mrb2_plm_${sheetId.slice(-6)}`, sheet_id: sheetId, version: 1, created_by: null,
      data: { [p('projectNo')]: 'SYN-MRB2-0001', [p('idempotencyKey')]: PLM_KEY, [p('componentSourceId')]: 'SYN-PART-1', [p('path')]: '["SYN-PART-1"]', [p('componentName')]: 'Synthetic part', [p('totalQuantity')]: 2, [p('active')]: true },
    },
    {
      id: `rec_mrb2_keyless_${sheetId.slice(-6)}`, sheet_id: sheetId, version: 1, created_by: 'u_mrb2_person',
      data: { [p('idempotencyKey')]: '', [p('notes')]: 'Synthetic note' },
    },
  ]
}
const RECORDS = SHEETS.flatMap((s) => recordsFor(s.objectId, s.sheetId))

const USERS = {
  admin: { id: 'u_mrb2_admin', roles: ['admin'], perms: [] as string[] },
  writer: { id: 'u_mrb2_writer', roles: [] as string[], perms: ['multitable:read', 'multitable:write'] },
  reader: { id: 'u_mrb2_reader', roles: [] as string[], perms: ['multitable:read'] },
} as const
type UserKey = keyof typeof USERS

const state = { target087Missing: false }
const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const asIds = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [])

function sheetRow(s: (typeof SHEETS)[number]) {
  return { id: s.sheetId, base_id: BASE_ID, name: s.key, description: null, system_kind: null, copied_from_kind: null, copied_at: null, copied_from_sheet_id: null }
}

async function answer(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
  const q = collapse(sql)
  const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length })
  if (q.includes('FROM plugin_multitable_object_registry')) {
    let hits = SHEETS.filter((s) => s.plugin && asIds(params[0]).includes(s.sheetId))
    if (/plugin_name = \$2/.test(q)) hits = hits.filter((s) => s.plugin === params[1])
    return rows(hits.map((s) => ({ '?column?': 1, sheet_id: s.sheetId, project_id: PROJECT_ID, object_id: s.objectId, plugin_name: s.plugin })))
  }
  if (q.includes('FROM integration_stock_prep_project_target')) {
    if (state.target087Missing) throw Object.assign(new Error('synthetic: relation does not exist'), { code: '42P01' })
    const hits = SHEETS.filter((s) => s.target && asIds(params[0]).includes(s.sheetId))
    return rows(hits.map((s) => ({ sheet_id: s.sheetId, project_no: 'SYN-MRB2-0001', status: s.target!.status, object_id: s.objectId, tenant_id: 'tenant_mrb2_identity' })))
  }
  if (/^SELECT deleted_at FROM meta_sheets WHERE id = \$1( FOR UPDATE)?$/.test(q)) {
    return rows(sheetById(params[0]) ? [{ deleted_at: null }] : [])
  }
  if (q.startsWith('SELECT 1 FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
    return rows(sheetById(params[0]) ? [{ '?column?': 1 }] : [])
  }
  if (q.includes('FROM meta_sheets s LEFT JOIN meta_bases b ON b.id = s.base_id')) {
    const s = sheetById(params[0])
    return rows(s ? [{ ...sheetRow(s), base_ref_id: BASE_ID, base_name: 'Identity', base_icon: null, base_color: null, base_owner_id: null, base_workspace_id: null }] : [])
  }
  if (/FROM meta_bases WHERE id = \$1 AND deleted_at IS NULL/.test(q)) {
    return rows(params[0] === BASE_ID ? [{ id: BASE_ID, name: 'Identity', icon: null, color: null, owner_id: null, workspace_id: null }] : [])
  }
  if (/FROM meta_sheets WHERE base_id = \$1 AND deleted_at IS NULL/.test(q)) {
    return rows(params[0] === BASE_ID ? SHEETS.map(sheetRow) : [])
  }
  if (q.includes('FROM meta_sheets') && (q.includes('WHERE s.id = $1') || q.includes('WHERE id = $1'))) {
    const s = sheetById(params[0])
    return rows(s ? [{ ...sheetRow(s), base_ref_id: BASE_ID, base_name: 'Identity', base_icon: null, base_color: null, base_owner_id: null, base_workspace_id: null }] : [])
  }
  if (/FROM meta_views WHERE sheet_id = \$1 ORDER BY created_at ASC$/.test(q)) {
    const s = sheetById(params[0])
    return rows(s ? [{ id: `vw_mrb2_${s.key}`, sheet_id: s.sheetId, name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }] : [])
  }
  if (/FROM meta_fields WHERE sheet_id = \$1/.test(q) && !/field_permissions/.test(q)) {
    const s = sheetById(params[0])
    return rows(s ? fieldRowsFor(s.objectId, s.sheetId) : [])
  }
  if (q.startsWith('SELECT id, created_by FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
    const ids = asIds(params[1])
    return rows(RECORDS.filter((r) => r.sheet_id === params[0] && ids.includes(r.id)).map((r) => ({ id: r.id, created_by: r.created_by })))
  }
  if (q.startsWith('SELECT id, version, data, locked, locked_by, locked_at FROM meta_records WHERE sheet_id = $1 ORDER BY')) {
    return rows(RECORDS.filter((r) => r.sheet_id === params[0]).map((r) => ({ id: r.id, version: r.version, data: r.data, locked: false, locked_by: null, locked_at: null })))
  }
  if (q.includes('FROM meta_records') && q.includes('WHERE id = $1')) {
    const r = RECORDS.find((rec) => rec.id === params[0])
    if (!r || (q.includes('AND sheet_id = $2') && r.sheet_id !== params[1])) return rows([])
    return rows([{ ...r, locked: false, locked_by: null, locked_at: null, created_at: null, updated_at: null }])
  }
  return rows([])
}

const pool = {
  query: vi.fn(answer),
  transaction: vi.fn(async () => { throw Object.assign(new Error('synthetic transaction refusal'), { code: 'SYNTHETIC' }) }),
}

const pinned = usePinnedServer()
let currentUser: UserKey = 'admin'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonical((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

const observed: Record<string, unknown> = {}

beforeAll(async () => {
  for (const user of Object.values(USERS)) rbacState.admin[user.id] = user.roles.includes('admin')
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as never)
  const app: Express = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const user = USERS[currentUser]
    ;(req as express.Request & { user?: unknown }).user = { id: user.id, roles: [...user.roles], perms: [...user.perms] }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  pinned.setApp(app)
}, 180_000)

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex')

afterAll(() => {
  const target = process.env.MRB2_CAPTURE_BASELINE
  if (!target) return
  const hashes: Record<string, string> = {}
  for (const key of Object.keys(observed).sort()) hashes[key] = digest(observed[key])
  writeFileSync(target, `${JSON.stringify(hashes, null, 2)}\n`, 'utf8')
  writeFileSync(`${target}.full.json`, `${JSON.stringify(canonical(observed), null, 2)}\n`, 'utf8')
})

const BASELINE_PATH = join(__dirname, '..', 'fixtures', 'stock-preparation-manual-rows-byte-identity.json')

function expectIdentical(key: string, value: unknown) {
  observed[key] = value
  if (process.env.MRB2_CAPTURE_BASELINE) return
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, string>
  expect(key in baseline, `baseline has no entry ${key}`).toBe(true)
  expect(digest(value), `${key} differs from the base answer (capture with MRB2_CAPTURE_BASELINE to diff)`).toBe(baseline[key])
}

it('the fixture holds exactly the 45 entries this file produces', () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, string>
  expect(Object.keys(baseline)).toHaveLength(45)
  for (const hash of Object.values(baseline)) expect(hash).toMatch(/^[0-9a-f]{64}$/)
})

const userKeys = Object.keys(USERS) as UserKey[]

describe('manual rows B2 — every non-P_reg stock-prep sheet, and the P_reg sheet where nothing may change, is byte-identical to the base', () => {
  for (const userKey of userKeys) {
    for (const s of SHEETS) {
      // On the P_reg sheet the block is expected for whoever can create / edit / delete: only the reader is pinned here.
      if (s.key !== 'S_PREG' || userKey === 'reader') {
        it(`GET /context (${userKey}, ${s.key})`, async () => {
          currentUser = userKey
          state.target087Missing = false
          const res = await request(pinned.url()).get('/api/multitable/context').query({ sheetId: s.sheetId })
          expectIdentical(`context:${userKey}:${s.key}`, { status: res.status, body: res.body })
          expect(JSON.stringify(res.body)).not.toContain('stockPreparationManualRows')
        }, 60_000)
      }

      it(`GET /view (${userKey}, ${s.key})`, async () => {
        currentUser = userKey
        state.target087Missing = false
        const res = await request(pinned.url()).get('/api/multitable/view').query({ sheetId: s.sheetId })
        expectIdentical(`view:${userKey}:${s.key}`, { status: res.status, body: res.body })
        expect(JSON.stringify(res.body)).not.toContain('manualSupplement')
      }, 60_000)

      it(`GET /records/:id (${userKey}, ${s.key}, PLM-keyed and keyless rows)`, async () => {
        currentUser = userKey
        state.target087Missing = false
        const [plm, keyless] = recordsFor(s.objectId, s.sheetId)
        const plmRes = await request(pinned.url()).get(`/api/multitable/records/${plm.id}`).query({ sheetId: s.sheetId })
        const keylessRes = await request(pinned.url()).get(`/api/multitable/records/${keyless.id}`).query({ sheetId: s.sheetId })
        expectIdentical(`record:${userKey}:${s.key}`, {
          plm: { status: plmRes.status, body: plmRes.body },
          keyless: { status: keylessRes.status, body: keylessRes.body },
        })
        expect(JSON.stringify([plmRes.body, keylessRes.body])).not.toContain('manualSupplement')
      }, 60_000)
    }
  }

  for (const userKey of ['admin', 'writer'] as UserKey[]) {
    it(`GET /context (${userKey}, S_PREG) while the plugin registry read answers 42P01: the old behaviour stays`, async () => {
      currentUser = userKey
      state.target087Missing = true
      try {
        const res = await request(pinned.url()).get('/api/multitable/context').query({ sheetId: sheetByKey('S_PREG').sheetId })
        expectIdentical(`context:${userKey}:S_PREG:087-missing`, { status: res.status, body: res.body })
        expect(JSON.stringify(res.body)).not.toContain('stockPreparationManualRows')
      } finally {
        state.target087Missing = false
      }
    }, 60_000)
  }
})

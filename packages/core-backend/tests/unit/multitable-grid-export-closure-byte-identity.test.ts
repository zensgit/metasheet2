/**
 * 备料分批拉取第一期 step 3 (PR A) — BYTE IDENTITY for every sheet the grid-export closure does NOT stamp.
 *
 * The closure adds a capability clamp to the three resolvers and a `gridExportClosure` key to `/context`. For an
 * unstamped sheet none of that may show: the `/context` body and the three resolvers' results must be exactly
 * what origin/main produced. This file records them for two unstamped sheets — an ordinary client-id sheet (the
 * closure lookup issues no statement for it) and an UNSTAMPED host-derived project sheet (the lookup runs and
 * answers "not closed") — for an admin, a reader and a writer, and compares them, as canonical JSON, with
 * tests/fixtures/multitable-grid-export-closure-byte-identity.json.
 *
 * THE BASELINE WAS CAPTURED ON origin/main fae8946d1 (this file imports nothing the PR adds, so it runs unchanged
 * there): `GEC_CAPTURE_BASELINE=<path> vitest run tests/unit/multitable-grid-export-closure-byte-identity.test.ts`
 * writes the observed set instead of comparing. The PR head must reproduce it byte for byte.
 *
 * Mock pool, no DB, the real univer-meta router behind one pinned listener (`request(app)` is banned in
 * tests/unit, #4154).
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const rbacState = vi.hoisted(() => ({ admin: {} as Record<string, boolean>, perms: {} as Record<string, string[]> }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async (userId: string) => rbacState.admin[userId] === true),
  userHasPermission: vi.fn(async () => false),
  listUserPermissions: vi.fn(async (userId: string) => rbacState.perms[userId] ?? []),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))

const BASE_ID = 'base_gec_identity'
const PLAIN = 'sht_gec_identity_plain'
/** A host-derived id (`sheet_` + 24 hex) that carries NO stamp. Synthetic. */
const DERIVED_OPEN = 'sheet_0123456789abcdef01234567'
const FIELD_ID = 'fld_gec_identity_title'
const VIEW_ID = 'vw_gec_identity_grid'

const USERS = {
  admin: { id: 'u_gec_admin', roles: ['admin'], perms: [] as string[] },
  reader: { id: 'u_gec_reader', roles: [] as string[], perms: ['multitable:read'] },
  writer: { id: 'u_gec_writer', roles: [] as string[], perms: ['multitable:read', 'multitable:write', 'multitable:share'] },
} as const
type UserKey = keyof typeof USERS

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim()

function sheetRow(id: string) {
  return { id, base_id: BASE_ID, name: id === PLAIN ? 'Plain' : 'Derived', description: null, system_kind: null, copied_from_kind: null, copied_at: null, copied_from_sheet_id: null }
}

async function answer(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
  const q = collapse(sql)
  const known = (id: unknown) => id === PLAIN || id === DERIVED_OPEN
  if (/^SELECT deleted_at FROM meta_sheets WHERE id = \$1( FOR UPDATE)?$/.test(q)) {
    return { rows: known(params[0]) ? [{ deleted_at: null }] : [], rowCount: 0 }
  }
  if (q.includes('FROM meta_sheets s LEFT JOIN meta_bases b ON b.id = s.base_id')) {
    return known(params[0])
      ? { rows: [{ ...sheetRow(String(params[0])), base_ref_id: BASE_ID, base_name: 'Identity', base_icon: null, base_color: null, base_owner_id: 'u_gec_owner', base_workspace_id: null }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  }
  if (/FROM meta_bases WHERE id = \$1 AND deleted_at IS NULL/.test(q)) {
    return params[0] === BASE_ID
      ? { rows: [{ id: BASE_ID, name: 'Identity', icon: null, color: null, owner_id: 'u_gec_owner', workspace_id: null }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  }
  if (/FROM meta_sheets WHERE base_id = \$1 AND deleted_at IS NULL/.test(q)) {
    return params[0] === BASE_ID ? { rows: [sheetRow(PLAIN), sheetRow(DERIVED_OPEN)], rowCount: 2 } : { rows: [], rowCount: 0 }
  }
  if (/FROM meta_views WHERE sheet_id = \$1 ORDER BY created_at ASC$/.test(q)) {
    return known(params[0])
      ? { rows: [{ id: `${VIEW_ID}_${params[0]}`, sheet_id: params[0], name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  }
  if (/FROM meta_fields WHERE sheet_id = \$1/.test(q) && !/field_permissions/.test(q)) {
    return known(params[0])
      ? { rows: [{ id: `${FIELD_ID}_${params[0]}`, sheet_id: params[0], name: 'Title', type: 'string', property: {}, order: 1 }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  }
  return { rows: [], rowCount: 0 }
}

const pool = {
  query: vi.fn(answer),
  transaction: vi.fn(async () => { throw Object.assign(new Error('synthetic transaction refusal'), { code: 'SYNTHETIC' }) }),
}

const pinned = usePinnedServer()
let currentUser: UserKey = 'admin'

let permissionService: typeof import('../../src/multitable/permission-service')
let sheetCapabilities: typeof import('../../src/multitable/sheet-capabilities')
let txnAuth: typeof import('../../src/services/approval-record-link-txn-auth')

/** Canonical JSON: object keys sorted, so the comparison is about content and key presence, not insertion order. */
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
  for (const user of Object.values(USERS)) {
    rbacState.admin[user.id] = user.roles.includes('admin')
    rbacState.perms[user.id] = [...user.perms]
  }
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  permissionService = await import('../../src/multitable/permission-service')
  sheetCapabilities = await import('../../src/multitable/sheet-capabilities')
  txnAuth = await import('../../src/services/approval-record-link-txn-auth')
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

afterAll(() => {
  const target = process.env.GEC_CAPTURE_BASELINE
  if (target) writeFileSync(target, `${JSON.stringify(canonical(observed), null, 2)}\n`, 'utf8')
})

const BASELINE_PATH = join(__dirname, '..', 'fixtures', 'multitable-grid-export-closure-byte-identity.json')

function expectIdentical(key: string, value: unknown) {
  observed[key] = value
  if (process.env.GEC_CAPTURE_BASELINE) return
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, unknown>
  expect(key in baseline, `baseline has no entry ${key}`).toBe(true)
  expect(JSON.stringify(canonical(value))).toBe(JSON.stringify(baseline[key]))
}

describe('grid-export closure — unstamped sheets are byte-identical to origin/main', () => {
  for (const userKey of Object.keys(USERS) as UserKey[]) {
    for (const sheetId of [PLAIN, DERIVED_OPEN]) {
      it(`GET /context (${userKey}, ${sheetId === PLAIN ? 'client-id' : 'derived-id'} sheet)`, async () => {
        currentUser = userKey
        const res = await request(pinned.url()).get('/api/multitable/context').query({ sheetId })
        expectIdentical(`context:${userKey}:${sheetId}`, { status: res.status, body: res.body })
        expect(res.status).toBe(200)
        expect(res.body?.data?.capabilities).not.toHaveProperty('gridExportClosure')
      }, 60_000)

      it(`the three resolvers (${userKey}, ${sheetId === PLAIN ? 'client-id' : 'derived-id'} sheet)`, async () => {
        const user = USERS[userKey]
        const access = { userId: user.id, permissions: [...user.perms], isAdminRole: user.roles.includes('admin') }
        const rest = await permissionService.resolveSheetCapabilitiesForAccess(pool.query as never, sheetId, access)
        const collab = await sheetCapabilities.resolveSheetCapabilitiesForUser(pool.query as never, sheetId, user.id)
        const onQuery = await txnAuth.resolveSheetCapabilitiesForUserOnQuery(pool.query as never, sheetId, user.id, undefined, {
          isAdminRole: access.isAdminRole,
          permissions: access.permissions,
        })
        expectIdentical(`resolvers:${userKey}:${sheetId}`, { rest, collab, onQuery })
        expect(rest).not.toHaveProperty('gridExportClosed')
        expect(collab).not.toHaveProperty('gridExportClosed')
        expect(onQuery).not.toHaveProperty('gridExportClosed')
      }, 60_000)
    }
  }
})

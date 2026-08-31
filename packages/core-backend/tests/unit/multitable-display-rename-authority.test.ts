/**
 * F21 — display rename, sheet soft delete/restore, and the mojibake gate (mock pool, no DB).
 *
 * The actor x route AUTHORITY matrix for these routes lives in
 * tests/unit/multitable-manage-schema-permission-matrix.test.ts (cells R12-R15), next to every other
 * `canManageFields` route. THIS file holds the legs that are specific to the routes themselves:
 *
 *   §1 payload validation      — empty / whitespace-only / oversized / extra-property, one coded reason
 *   §2 the mojibake gate       — U+FFFD and control characters REFUSED on every display-name write,
 *                                a legitimate CJK name accepted byte-for-byte
 *   §3 the 404 legs            — unknown sheet, unknown base, restore of a live sheet
 *   §4 what actually persists  — the UPDATE, the recorded history event, the no-op rename
 *   §5 soft delete + restore   — the sheet stops listing, nothing is destroyed, restore brings it back
 *   §6 no new restore path     — a `name` sheet_config revision stays GATED in the T9-W machinery
 *
 * WHY THESE ROUTES EXIST. Nothing could write `meta_sheets.name` or `meta_bases.name`, so the live
 * deployment's renames were done by direct DB UPDATE — an ops action a customer cannot take, while
 * §12/§15 of the application model promise display names are the customer's to change. And
 * `DELETE /sheets/:sheetId` was a HARD delete gated on `canManageViews`, which a write-only operator
 * holds: an operator refused a single field rename could destroy the whole table, irrecoverably.
 *
 * TRANSPORT: one pinned listener per file, app swapped per test — `request(app)` re-listens per
 * request and is banned by tests/unit/supertest-app-mode-tripwire.test.ts (#4154).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_rn'
const BASE_ID = 'base_rn'
const MISSING_SHEET_ID = 'sheet_rn_missing'
const MISSING_BASE_ID = 'base_rn_missing'
const ORIGINAL_SHEET_NAME = '备料主表'
const ORIGINAL_BASE_NAME = 'Ops base'

/** Admin — holds canManageFields through isAdminRole, like every other schema route. */
const ADMIN_USER = { id: 'u_rn_admin', roles: ['admin'], perms: [] as string[] }
/** The shop-floor operator: record authority, no schema authority. */
const OPERATOR_USER = {
  id: 'u_rn_writer',
  roles: ['member'],
  perms: ['multitable:read', 'multitable:write'],
}

// ── mock pool ──────────────────────────────────────────────────────────────────

type QueryResult = { rows: any[]; rowCount?: number }

interface SheetState {
  id: string
  base_id: string
  name: string
  description: string | null
  deleted_at: string | null
}

interface BaseState {
  id: string
  name: string
  icon: string | null
  color: string | null
  owner_id: string | null
  workspace_id: string | null
}

interface Store {
  sheet: SheetState
  base: BaseState
  /** Every `meta_config_revisions` INSERT, in order, as the recorder's positional params. */
  configRevisions: unknown[][]
  /** Every write actually issued against meta_sheets / meta_bases, for "nothing was written" legs. */
  writes: string[]
  /** Sheet-scoped `spreadsheet_permissions` codes held by the actor on SHEET_ID. Empty = global path. */
  scopedPermissionCodes: string[]
}

function freshStore(): Store {
  return {
    sheet: { id: SHEET_ID, base_id: BASE_ID, name: ORIGINAL_SHEET_NAME, description: null, deleted_at: null },
    base: { id: BASE_ID, name: ORIGINAL_BASE_NAME, icon: null, color: null, owner_id: 'owner_rn', workspace_id: null },
    configRevisions: [],
    writes: [],
    scopedPermissionCodes: [],
  }
}

function createMockPool(store: Store) {
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
    const p = (i: number) => String(params?.[i] ?? '')

    // No sheet-scoped assignments: isolates the GLOBAL capability derivation, exactly as the
    // manage-schema matrix does.
    // One ordinary column, so the read paths in §8 have a schema to resolve and their POSITIVE
    // CONTROLS reach a real 200 rather than a not-found for an unrelated reason.
    if (/FROM meta_fields\b/.test(sql)) {
      return {
        rows: [{ id: 'fld_rn_title', sheet_id: SHEET_ID, name: 'Title', type: 'string', property: {}, order: 0 }],
      }
    }

    // Sheet-scoped grants. Empty by default (so the GLOBAL derivation is what the other sections
    // measure); `store.scopedPermissionCodes` opts a test into the scoped path, which is where the
    // delete/restore authority differs from `canManageFields`.
    if (sql.includes('FROM spreadsheet_permissions')) {
      return {
        rows: store.scopedPermissionCodes.map((code) => ({
          sheet_id: SHEET_ID,
          perm_code: code,
          subject_type: 'user',
        })),
      }
    }
    if (sql.includes('FROM field_permissions')) return { rows: [] }
    if (sql.includes('FROM record_permissions')) return { rows: [] }
    if (sql.includes('FROM meta_view_permissions')) return { rows: [] }
    if (sql.includes('FROM formula_dependencies')) return { rows: [] }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    // approval-projection read guard — this sheet is not a projection sheet
    if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }

    if (/^\s*INSERT\s+INTO\s+meta_config_revisions\b/i.test(sql)) {
      store.configRevisions.push([...(params ?? [])])
      return { rows: [], rowCount: 1 }
    }

    // ── sheet writes ────────────────────────────────────────────────────────────
    if (/^\s*UPDATE\s+meta_sheets\s+SET\s+name\s*=/i.test(sql)) {
      store.writes.push('sheet.name')
      if (store.sheet.id !== p(1) || store.sheet.deleted_at !== null) return { rows: [], rowCount: 0 }
      store.sheet.name = p(0)
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*UPDATE\s+meta_sheets\s+SET\s+deleted_at\s*=\s*now\(\)/i.test(sql)) {
      store.writes.push('sheet.softDelete')
      if (store.sheet.id !== p(0) || store.sheet.deleted_at !== null) return { rows: [], rowCount: 0 }
      store.sheet.deleted_at = '2026-08-31T00:00:00.000Z'
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*UPDATE\s+meta_sheets\s+SET\s+deleted_at\s*=\s*NULL/i.test(sql)) {
      store.writes.push('sheet.restore')
      if (store.sheet.id !== p(0) || store.sheet.deleted_at === null) return { rows: [], rowCount: 0 }
      store.sheet.deleted_at = null
      return {
        rows: [{ id: store.sheet.id, base_id: store.sheet.base_id, name: store.sheet.name, description: store.sheet.description }],
        rowCount: 1,
      }
    }

    // ── base writes ─────────────────────────────────────────────────────────────
    if (/^\s*UPDATE\s+meta_bases\s+SET\s+name\s*=/i.test(sql)) {
      store.writes.push('base.name')
      if (store.base.id !== p(0)) return { rows: [], rowCount: 0 }
      store.base.name = p(1)
      return { rows: [{ ...store.base }], rowCount: 1 }
    }

    // ── sheet reads ─────────────────────────────────────────────────────────────
    // The restore route reads deleted_at, so it must match BEFORE the deleted_at IS NULL readers.
    if (sql.includes('deleted_at FROM meta_sheets WHERE id = $1')) {
      return { rows: store.sheet.id === p(0) ? [{ ...store.sheet }] : [] }
    }
    if (sql.includes('SELECT name FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      return { rows: store.sheet.id === p(0) && store.sheet.deleted_at === null ? [{ name: store.sheet.name }] : [] }
    }
    if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      return { rows: store.sheet.id === p(0) && store.sheet.deleted_at === null ? [{ id: store.sheet.id }] : [] }
    }
    if (/FROM meta_sheets\b/.test(sql) && sql.includes('WHERE id = $1')) {
      const visible = store.sheet.id === p(0) && (store.sheet.deleted_at === null || !sql.includes('deleted_at IS NULL'))
      return { rows: visible ? [{ ...store.sheet }] : [] }
    }

    if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
      return { rows: store.base.id === p(0) ? [{ ...store.base }] : [] }
    }

    return { rows: [] }
  })

  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

// ── app harness ────────────────────────────────────────────────────────────────

async function buildApp(
  user: { id: string; roles: string[]; perms: string[] } | null,
  store: Store,
): Promise<Express> {
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool(store) as any)

  const app = express()
  app.use(express.json())
  if (user) {
    app.use((req, _res, next) => {
      ;(req as any).user = { ...user }
      next()
    })
  }
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const pinned = usePinnedServer()

function on(app: Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

/** The display-name write surfaces this slice adds, addressed uniformly (route-agnostic assertions). */
const DISPLAY_NAME_WRITES = [
  { label: 'PATCH /sheets/:sheetId (sheet rename)', path: `/api/multitable/sheets/${SHEET_ID}` },
  { label: 'PATCH /bases/:baseId (base rename)', path: `/api/multitable/bases/${BASE_ID}` },
]

describe('F21 — sheet and base display rename', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  // ── §1 payload validation ────────────────────────────────────────────────────
  describe('§1 payload — one coded reason that says what would be accepted', () => {
    const REJECTED: Array<{ label: string; body: unknown }> = [
      { label: 'empty string', body: { name: '' } },
      { label: 'whitespace only (trims to empty)', body: { name: '   \t  ' } },
      { label: 'oversized (256 chars)', body: { name: 'x'.repeat(256) } },
      { label: 'missing name', body: {} },
      { label: 'name is not a string', body: { name: 42 } },
      { label: 'an extra property this slice does not accept', body: { name: 'Fine', icon: 'table' } },
    ]

    for (const write of DISPLAY_NAME_WRITES) {
      for (const bad of REJECTED) {
        it(`${write.label} refuses ${bad.label} with INVALID_NAME`, async () => {
          const store = freshStore()
          const app = await buildApp(ADMIN_USER, store)
          const res = await on(app).patch(write.path).send(bad.body as object)

          expect(res.status).toBe(400)
          expect(res.body.ok).toBe(false)
          expect(res.body.error.code).toBe('INVALID_NAME')
          // The refusal states the accepted shape rather than echoing what was sent.
          expect(res.body.error.message).toContain('1-255 characters')
          expect(JSON.stringify(res.body)).not.toContain('x'.repeat(256))
          // Nothing was written, and nothing was recorded.
          expect(store.writes).toEqual([])
          expect(store.configRevisions).toEqual([])
          expect(store.sheet.name).toBe(ORIGINAL_SHEET_NAME)
          expect(store.base.name).toBe(ORIGINAL_BASE_NAME)
        })
      }
    }

    it('a 255-character name is accepted — the boundary is inclusive, not off-by-one', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const name = 'y'.repeat(255)
      const res = await on(app).patch(`/api/multitable/sheets/${SHEET_ID}`).send({ name })
      expect(res.status).toBe(200)
      expect(store.sheet.name).toBe(name)
    })

    it('surrounding whitespace is trimmed, and the TRIMMED name is what persists', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).patch(`/api/multitable/sheets/${SHEET_ID}`).send({ name: '   交付日期   ' })
      expect(res.status).toBe(200)
      expect(res.body.data.sheet.name).toBe('交付日期')
      expect(store.sheet.name).toBe('交付日期')
    })
  })

  // ── §2 the mojibake gate ─────────────────────────────────────────────────────
  describe('§2 mojibake — a decoder’s U+FFFD is not a name', () => {
    // The live symptom: a Windows console codepage mangled the CJK bytes before the wire, and the
    // server stored the replacement characters verbatim. The grid then rendered four U+FFFD glyphs.
    //
    // Every corrupt fixture below is written as an ESCAPE, never as a raw byte: a test that pins an
    // encoding defect must not itself depend on this file surviving an encoding round trip.
    const REPLACEMENT = '\uFFFD'
    const MANGLED = REPLACEMENT.repeat(4)
    const CORRUPTED_CJK = `\u4EA4\u4ED8${REPLACEMENT}\u671F`

    const CORRUPT_NAMES: Array<{ label: string; name: string }> = [
      { label: 'all replacement characters', name: MANGLED },
      { label: 'a partially mangled CJK name', name: CORRUPTED_CJK },
      { label: 'an embedded C0 control character (BEL)', name: 'Delivery\u0007date' },
      { label: 'an embedded newline', name: 'Delivery\ndate' },
      { label: 'an embedded tab', name: 'Delivery\tdate' },
      { label: 'an embedded DEL', name: 'Delivery\u007Fdate' },
      { label: 'an embedded C1 control character (NEL)', name: 'Delivery\u0085date' },
      { label: 'a NUL byte', name: 'Delivery\u0000date' },
      { label: 'an unpaired high surrogate', name: 'Delivery\uD800date' },
    ]

    for (const write of DISPLAY_NAME_WRITES) {
      for (const corrupt of CORRUPT_NAMES) {
        it(`${write.label} refuses ${corrupt.label} with NAME_INVALID_CHARACTERS`, async () => {
          const store = freshStore()
          const app = await buildApp(ADMIN_USER, store)
          const res = await on(app).patch(write.path).send({ name: corrupt.name })

          expect(res.status).toBe(400)
          expect(res.body.error.code).toBe('NAME_INVALID_CHARACTERS')
          // It names the code point and where it is...
          expect(res.body.error.message).toMatch(/U\+[0-9A-F]{4} at position \d+/)
          // ...and never echoes the corrupt text back into the error channel.
          expect(JSON.stringify(res.body)).not.toContain(REPLACEMENT)
          // Fail-closed: refused, not normalized, not stripped.
          expect(store.writes).toEqual([])
          expect(store.sheet.name).toBe(ORIGINAL_SHEET_NAME)
          expect(store.base.name).toBe(ORIGINAL_BASE_NAME)
        })
      }
    }

    it('the U+FFFD refusal points at client encoding, because that is where the bytes were lost', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).patch(`/api/multitable/sheets/${SHEET_ID}`).send({ name: MANGLED })
      expect(res.body.error.message).toContain('UTF-8')
      expect(res.body.error.message).toContain('U+FFFD at position 1')
    })

    it('the gate reports the POSITION, so a name that is clean until late is still located', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app)
        .patch(`/api/multitable/sheets/${SHEET_ID}`)
        .send({ name: `abcd${REPLACEMENT}` })
      expect(res.body.error.message).toContain('U+FFFD at position 5')
    })

    it('the mojibake gate also guards FIELD create and FIELD rename - the surfaces the live incident used', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)

      const created = await on(app)
        .post('/api/multitable/fields')
        .send({ sheetId: SHEET_ID, name: CORRUPTED_CJK, type: 'string' })
      expect(created.status).toBe(400)
      expect(created.body.error.code).toBe('NAME_INVALID_CHARACTERS')

      const renamed = await on(app).patch('/api/multitable/fields/fld_rn').send({ name: MANGLED })
      expect(renamed.status).toBe(400)
      expect(renamed.body.error.code).toBe('NAME_INVALID_CHARACTERS')
    })

    // The round trip that must NEVER regress: legitimate CJK is stored byte-for-byte. If the stack
    // itself ever mangled an encoding, this leg goes red rather than the refusal legs going green
    // for the wrong reason.
    const LEGITIMATE: string[] = ['交付日期', '备料主表(客户改名)', 'Größe — naïve', 'Ωμέγα', '数量 📦', 'العربية']

    for (const name of LEGITIMATE) {
      it(`accepts a legitimate name and stores it byte-for-byte (${Array.from(name).length} code points)`, async () => {
        const store = freshStore()
        const app = await buildApp(ADMIN_USER, store)
        const res = await on(app).patch(`/api/multitable/sheets/${SHEET_ID}`).send({ name })
        expect(res.status).toBe(200)
        expect(res.body.data.sheet.name).toBe(name)
        expect(store.sheet.name).toBe(name)
        expect(Buffer.from(store.sheet.name, 'utf8').equals(Buffer.from(name, 'utf8'))).toBe(true)
      })
    }

    it('an emoji survives — it is a surrogate PAIR, not the unpaired surrogate the gate refuses', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).patch(`/api/multitable/bases/${BASE_ID}`).send({ name: '备料 📦 2026' })
      expect(res.status).toBe(200)
      expect(store.base.name).toBe('备料 📦 2026')
    })
  })

  // ── §3 the 404 legs ──────────────────────────────────────────────────────────
  describe('§3 not found', () => {
    it('renaming an unknown sheet is 404, and writes nothing', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).patch(`/api/multitable/sheets/${MISSING_SHEET_ID}`).send({ name: 'Anything' })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
      expect(store.writes).toEqual([])
    })

    it('renaming a SOFT-DELETED sheet is 404 — a deleted sheet is not renameable', async () => {
      const store = freshStore()
      store.sheet.deleted_at = '2026-08-30T00:00:00.000Z'
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).patch(`/api/multitable/sheets/${SHEET_ID}`).send({ name: 'Anything' })
      expect(res.status).toBe(404)
      expect(store.writes).toEqual([])
    })

    it('renaming an unknown base is 404, and writes nothing', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).patch(`/api/multitable/bases/${MISSING_BASE_ID}`).send({ name: 'Anything' })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
      expect(store.base.name).toBe(ORIGINAL_BASE_NAME)
    })

    it('an actor WITHOUT schema authority is refused before the base 404 — existence is not disclosed', async () => {
      const store = freshStore()
      const app = await buildApp(OPERATOR_USER, store)
      const res = await on(app).patch(`/api/multitable/bases/${MISSING_BASE_ID}`).send({ name: 'Anything' })
      // 403, not 404: the operator learns nothing about whether this base id exists.
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })
  })

  // ── §4 what actually persists ────────────────────────────────────────────────
  describe('§4 the write and its history event', () => {
    it('a sheet rename records ONE sheet_config revision with changedKeys ["name"] — the existing channel', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).patch(`/api/multitable/sheets/${SHEET_ID}`).send({ name: '备料主表(改名后)' })
      expect(res.status).toBe(200)
      expect(store.sheet.name).toBe('备料主表(改名后)')

      expect(store.configRevisions).toHaveLength(1)
      const [, sheetId, entityType, entityId, action, before, after, changedKeys] = store.configRevisions[0]!
      expect(sheetId).toBe(SHEET_ID)
      expect(entityType).toBe('sheet_config')
      expect(entityId).toBe(SHEET_ID) // a sheet_config revision's entity IS its sheet
      expect(action).toBe('update')
      expect(changedKeys).toEqual(['name'])
      expect(JSON.parse(String(before))).toEqual({ name: ORIGINAL_SHEET_NAME })
      expect(JSON.parse(String(after))).toEqual({ name: '备料主表(改名后)' })
    })

    it('a rename to the SAME name writes nothing and records nothing (no history spam)', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).patch(`/api/multitable/sheets/${SHEET_ID}`).send({ name: ORIGINAL_SHEET_NAME })
      expect(res.status).toBe(200)
      expect(store.writes).toEqual([])
      expect(store.configRevisions).toEqual([])
    })

    it('a rename that differs ONLY by surrounding whitespace is also a no-op', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).patch(`/api/multitable/sheets/${SHEET_ID}`).send({ name: `  ${ORIGINAL_SHEET_NAME}  ` })
      expect(res.status).toBe(200)
      expect(store.configRevisions).toEqual([])
    })

    it('a base rename returns the renamed base and changes nothing else about it', async () => {
      const store = freshStore()
      store.base.icon = 'table'
      store.base.color = '#1677ff'
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).patch(`/api/multitable/bases/${BASE_ID}`).send({ name: '运营 Base' })
      expect(res.status).toBe(200)
      expect(res.body.data.base).toMatchObject({
        id: BASE_ID,
        name: '运营 Base',
        icon: 'table',
        color: '#1677ff',
        ownerId: 'owner_rn',
      })
      expect(store.base.icon).toBe('table')
      expect(store.base.color).toBe('#1677ff')
    })
  })

  // ── §5 soft delete + restore ────────────────────────────────────────────────
  describe('§5 sheet delete is soft, and recoverable', () => {
    it('delete sets deleted_at instead of destroying the row, and restore brings it back', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)

      const deleted = await on(app).delete(`/api/multitable/sheets/${SHEET_ID}`)
      expect(deleted.status).toBe(200)
      expect(deleted.body.data).toEqual({ deleted: SHEET_ID })
      expect(store.sheet.deleted_at).not.toBeNull()
      // Nothing was destroyed: the row, its name and its base binding all survive.
      expect(store.sheet.name).toBe(ORIGINAL_SHEET_NAME)
      expect(store.sheet.base_id).toBe(BASE_ID)
      expect(store.writes).toEqual(['sheet.softDelete'])

      const restored = await on(app).post(`/api/multitable/sheets/${SHEET_ID}/restore`)
      expect(restored.status).toBe(200)
      expect(restored.body.data.restored).toBe(SHEET_ID)
      expect(restored.body.data.sheet).toMatchObject({ id: SHEET_ID, name: ORIGINAL_SHEET_NAME, baseId: BASE_ID })
      expect(store.sheet.deleted_at).toBeNull()
    })

    it('deleting an already-deleted sheet is 404 — the second call is not a silent success', async () => {
      const store = freshStore()
      store.sheet.deleted_at = '2026-08-30T00:00:00.000Z'
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).delete(`/api/multitable/sheets/${SHEET_ID}`)
      expect(res.status).toBe(404)
      expect(store.writes).toEqual([])
    })

    it('restoring a LIVE sheet is 404 — "restore" has no meaning for a sheet that was never deleted', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).post(`/api/multitable/sheets/${SHEET_ID}/restore`)
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
      expect(store.writes).toEqual([])
    })

    it('restoring an unknown sheet is 404', async () => {
      const store = freshStore()
      const app = await buildApp(ADMIN_USER, store)
      const res = await on(app).post(`/api/multitable/sheets/${MISSING_SHEET_ID}/restore`)
      expect(res.status).toBe(404)
    })

    it('the operator is refused BOTH the delete and the restore, and reaches neither write', async () => {
      const store = freshStore()
      const app = await buildApp(OPERATOR_USER, store)

      const deleted = await on(app).delete(`/api/multitable/sheets/${SHEET_ID}`)
      expect(deleted.status).toBe(403)
      expect(deleted.body.error.message).toContain('multitable:manage-schema')

      store.sheet.deleted_at = '2026-08-30T00:00:00.000Z'
      const restored = await on(app).post(`/api/multitable/sheets/${SHEET_ID}/restore`)
      expect(restored.status).toBe(403)
      expect(restored.body.error.message).toContain('multitable:manage-schema')

      expect(store.writes).toEqual([])
    })

    it('a refused restore does not disclose whether the sheet is deleted, live, or absent', async () => {
      const store = freshStore()
      const app = await buildApp(OPERATOR_USER, store)
      const onDeleted = await (async () => {
        store.sheet.deleted_at = '2026-08-30T00:00:00.000Z'
        return on(app).post(`/api/multitable/sheets/${SHEET_ID}/restore`)
      })()
      const onLive = await (async () => {
        store.sheet.deleted_at = null
        return on(app).post(`/api/multitable/sheets/${SHEET_ID}/restore`)
      })()
      const onAbsent = await on(app).post(`/api/multitable/sheets/${MISSING_SHEET_ID}/restore`)

      // Position-independent: all three refusals are the same status and the same body.
      const shapes = [onDeleted, onLive, onAbsent].map((r) => ({ status: r.status, body: r.body }))
      expect(shapes[1]).toEqual(shapes[0])
      expect(shapes[2]).toEqual(shapes[0])
      expect(shapes[0]!.status).toBe(403)
    })
  })

  // ── §8 the GHOST-SHEET refusals ──────────────────────────────────────────────
  //
  // What an adversarial review found, and what these pin. The hard delete was safe BY CONSTRUCTION:
  // the row was gone and the FK cascade took the records with it. Soft delete removed that guarantee
  // and, at first, replaced it with nothing — `deleted_at` only filtered the LISTING queries, while
  // dozens of read and write paths address `meta_records` by `sheet_id` and never join `meta_sheets`.
  // A soft-deleted sheet stayed fully live to anyone holding its id.
  //
  // Every leg below runs against a sheet whose `deleted_at` is SET, and asserts a 404 carrying the
  // coded, actionable `SHEET_DELETED` — not a 200, and not a bare 403.
  describe('§8 a soft-deleted sheet is a ghost to every path that holds its id', () => {
    async function deletedSheetApp() {
      const store = freshStore()
      store.sheet.deleted_at = '2026-08-30T00:00:00.000Z'
      return { store, app: await buildApp(ADMIN_USER, store) }
    }

    const GHOST_PATHS: Array<{ label: string; send: (app: Express) => request.Test }> = [
      {
        // P1-1 headline: the OAPI record list served the deleted sheet's COMPLETE record set.
        label: 'GET /records (OAPI record list)',
        send: (app) => on(app).get('/api/multitable/records').query({ sheetId: SHEET_ID }),
      },
      {
        label: 'GET /sheets/:sheetId/automations (rules of a deleted sheet)',
        send: (app) => on(app).get(`/api/multitable/sheets/${SHEET_ID}/automations`),
      },
      {
        label: 'PATCH /sheets/:sheetId (rename a deleted sheet)',
        send: (app) => on(app).patch(`/api/multitable/sheets/${SHEET_ID}`).send({ name: 'Ghost' }),
      },
      {
        label: 'DELETE /sheets/:sheetId (delete it twice)',
        send: (app) => on(app).delete(`/api/multitable/sheets/${SHEET_ID}`),
      },
    ]

    for (const ghost of GHOST_PATHS) {
      it(`${ghost.label} answers 404 for a deleted sheet`, async () => {
        const { store, app } = await deletedSheetApp()
        const res = await ghost.send(app)
        expect(res.status).toBe(404)
        // Nothing was written on the way to the refusal.
        expect(store.writes).toEqual([])
      })
    }

    it('the refusal is CODED and names the way back — not a bare NOT_FOUND', async () => {
      const { app } = await deletedSheetApp()
      const res = await on(app).get('/api/multitable/records').query({ sheetId: SHEET_ID })
      expect(res.body.error.code).toBe('SHEET_DELETED')
      expect(res.body.error.message).toContain('/restore')
    })

    // NOT VACUOUS: the identical requests against a LIVE sheet must not 404. Without this, a mock
    // that failed to serve any of these routes would make every leg above pass for the wrong reason.
    for (const ghost of GHOST_PATHS) {
      it(`POSITIVE CONTROL — ${ghost.label} does NOT 404 while the sheet is live`, async () => {
        const store = freshStore()
        const app = await buildApp(ADMIN_USER, store)
        const res = await ghost.send(app)
        expect(res.status).not.toBe(404)
      })
    }

    it('a deleted sheet is distinguishable from an absent one — different codes, same status', async () => {
      const { app } = await deletedSheetApp()
      const deleted = await on(app).get('/api/multitable/records').query({ sheetId: SHEET_ID })
      const absent = await on(app).get('/api/multitable/records').query({ sheetId: MISSING_SHEET_ID })
      expect(deleted.status).toBe(404)
      expect(absent.status).toBe(404)
      expect(deleted.body.error.code).toBe('SHEET_DELETED')
      expect(absent.body.error.code).toBe('NOT_FOUND')
    })
  })

  // ── §7 sheet-SCOPED grants ───────────────────────────────────────────────────
  //
  // THE CELL AN ADVERSARIAL REVIEW CAUGHT. `applyContextSheetSchemaWriteGrant` sets `canManageFields`
  // for ANY sheet-scoped grant with `canRead && canWrite`, so gating sheet delete on the post-grant
  // `canManageFields` silently handed delete + restore to a scoped `spreadsheet:write` holder — who is
  // NOT in SHEET_ADMIN_PERMISSION_CODES and who the OLD `canManageSheetAccess` branch refused. On the
  // takeover deployment roles are assigned PER SHEET, so that population is real shop-floor writers.
  //
  // The routes now gate on `hasSheetLifecycleAuthority` (global schema authority OR sheet admin), and
  // the resulting TWO-TIER story is asserted here in full:
  //   RENAME  — `canManageFields`: a scoped writer may rename the sheet, exactly as it may rename
  //             every FIELD in that sheet. Display-only and reversible.
  //   DELETE / RESTORE — strictly more: the sheet's existence is not the writer's to decide.
  describe('§7 a sheet-scoped grant separates renaming from deleting', () => {
    const SCOPED_USER = { id: 'u_rn_scoped', roles: ['member'], perms: ['multitable:read'] }
    /** Global share authority, no schema authority — the disclosed LOSS on a scoped sheet. */
    const SHARER_USER = { id: 'u_rn_sharer', roles: ['member'], perms: ['multitable:read', 'multitable:share'] }

    async function scopedApp(user: typeof SCOPED_USER, codes: string[]) {
      const store = freshStore()
      store.scopedPermissionCodes = codes
      return { store, app: await buildApp(user, store) }
    }

    it('spreadsheet:write MAY rename the sheet — the same tier that renames its fields', async () => {
      const { store, app } = await scopedApp(SCOPED_USER, ['spreadsheet:write'])
      const res = await on(app).patch(`/api/multitable/sheets/${SHEET_ID}`).send({ name: '车间改名' })
      expect(res.status).toBe(200)
      expect(store.sheet.name).toBe('车间改名')
    })

    it('spreadsheet:write MAY NOT delete the sheet, and never reaches the write', async () => {
      const { store, app } = await scopedApp(SCOPED_USER, ['spreadsheet:write'])
      const res = await on(app).delete(`/api/multitable/sheets/${SHEET_ID}`)
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
      expect(res.body.error.message).toContain('sheet-scoped admin grant')
      expect(store.writes).toEqual([])
      expect(store.sheet.deleted_at).toBeNull()
    })

    it('spreadsheet:write MAY NOT restore a deleted sheet either', async () => {
      const { store, app } = await scopedApp(SCOPED_USER, ['spreadsheet:write'])
      store.sheet.deleted_at = '2026-08-30T00:00:00.000Z'
      const res = await on(app).post(`/api/multitable/sheets/${SHEET_ID}/restore`)
      expect(res.status).toBe(403)
      expect(store.writes).toEqual([])
      expect(store.sheet.deleted_at).not.toBeNull()
    })

    // Positive control for the two above: the scoped grant IS being seen by the resolver. Without
    // this, a mock that silently dropped the scope rows would make both refusals pass for the wrong
    // reason (no scope at all rather than an insufficient one).
    it('spreadsheet:admin — the scope IS live, and an admin grant still deletes and restores', async () => {
      const { store, app } = await scopedApp(SCOPED_USER, ['spreadsheet:admin'])
      const deleted = await on(app).delete(`/api/multitable/sheets/${SHEET_ID}`)
      expect(deleted.status).toBe(200)
      expect(store.sheet.deleted_at).not.toBeNull()

      const restored = await on(app).post(`/api/multitable/sheets/${SHEET_ID}/restore`)
      expect(restored.status).toBe(200)
      expect(store.sheet.deleted_at).toBeNull()
    })

    it('global multitable:share is NOT whole-sheet authority on a scoped sheet — a disclosed loss', async () => {
      const { store, app } = await scopedApp(SHARER_USER, ['spreadsheet:read'])
      const res = await on(app).delete(`/api/multitable/sheets/${SHEET_ID}`)
      expect(res.status).toBe(403)
      expect(store.writes).toEqual([])
    })
  })
})

// ── §6 the rename opens no new RESTORE path ───────────────────────────────────
// The sheet rename rides the EXISTING config-revision channel (entity_type 'sheet_config'), which is
// also what the T9-W config-RESTORE machinery reads. That machinery must keep refusing a `name`
// revision fail-closed: `changedKeys: ['name']` is outside the Tier-1 set the flag opens, so it stays
// gated exactly like every other non-Tier-1 sheet_config key. Asserted on the PURE predicates, which
// is where the decision actually lives.
describe('F21 §6 — a sheet_config `name` revision stays gated in the config-restore machinery', () => {
  const nameRevision = {
    entity_type: 'sheet_config' as const,
    action: 'update' as const,
    changed_keys: ['name'],
  }

  it('classifyRevert reports it gated', async () => {
    const { classifyRevert } = await import('../../src/multitable/config-restore')
    expect(classifyRevert(nameRevision).kind).toBe('gated')
  })

  it('isSupportedSheetConfigRevert refuses it — the flag opens only the Tier-1 keys', async () => {
    const { isSupportedSheetConfigRevert, SUPPORTED_SHEET_CONFIG_REVERT_KEYS } = await import(
      '../../src/multitable/config-restore'
    )
    expect(isSupportedSheetConfigRevert(nameRevision)).toBe(false)
    expect(SUPPORTED_SHEET_CONFIG_REVERT_KEYS.has('name')).toBe(false)
    // Positive control, so the refusal above is not vacuous: a Tier-1 key IS supported.
    expect(
      isSupportedSheetConfigRevert({
        entity_type: 'sheet_config',
        action: 'update',
        changed_keys: ['rowLevelReadPermissionsEnabled'],
      }),
    ).toBe(true)
  })

  it('a name revision mixed with a Tier-1 key is still refused — every key must be supported', async () => {
    const { isSupportedSheetConfigRevert } = await import('../../src/multitable/config-restore')
    expect(
      isSupportedSheetConfigRevert({
        entity_type: 'sheet_config',
        action: 'update',
        changed_keys: ['rowLevelReadPermissionsEnabled', 'name'],
      }),
    ).toBe(false)
  })
})

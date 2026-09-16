/**
 * #5807 — the People system sheet stops storing email / avatar (mock pool, no DB).
 *
 * The People sheet behind legacy link-backed person fields is created / re-synced only by
 * `POST /person-fields/prepare`. It used to copy every active user's email and avatar URL into string
 * cells (and use the email as `Name` when a user had no name), where any reader of the sheet could pull
 * them in one request. This file pins what the change closes:
 *
 *   §1 first provision        — four columns still exist; rows carry only User ID + Name; a user with no
 *                                (or a blank) name is shown by id; deactivated users are not mirrored;
 *                                no write carries an email or avatar value; the users read asks for
 *                                neither
 *   §2 explicit re-sync       — a row that still carries an Email and/or Avatar URL key is rewritten ONCE
 *                                (same full-replace UPDATE shape: version + 1, updated_at = now()); a
 *                                second re-sync is a no-op; a deactivated user's row is left as it is
 *   §3 reserved sentinel      — `POST /sheets` refuses the People sentinel description (exact or
 *                                whitespace-padded) with a values-free 400 and writes nothing
 *   §4 target selection       — the sync prefers the server-owned `system_kind` sheet over an EARLIER
 *                                sentinel-only sheet, and still falls back to a sentinel-only sheet
 *                                without stamping `system_kind` on it
 *
 * NOT covered here because it is NOT closed: rows nobody re-syncs keep their old values, and names /
 * user ids stay readable by any reader of the sheet (#5807 stays open for the read gate).
 *
 * Fixtures are obviously fake (`*.example.test`). TRANSPORT: one pinned listener per file —
 * `request(app)` is banned in tests/unit by supertest-app-mode-tripwire.test.ts (#4154).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SYSTEM_PEOPLE_SHEET_DESCRIPTION } from '../../src/multitable/system-sheet-predicate'
import { usePinnedServer } from '../utils/pinned-server'

const BASE_ID = 'base_p5807'
const SOURCE_SHEET_ID = 'sheet_p5807_orders'
const PEOPLE_SHEET_ID = 'sheet_p5807_people'
const FORGED_SHEET_ID = 'sheet_p5807_forged'

const FLD_UID = 'fld_p5807_uid'
const FLD_NAME = 'fld_p5807_name'
const FLD_EMAIL = 'fld_p5807_email'
const FLD_AVATAR = 'fld_p5807_avatar'

const ADMIN_USER = { id: 'u_p5807_admin', roles: ['admin'], perms: [] as string[] }

const RESERVED_BODY = {
  ok: false,
  error: { code: 'VALIDATION_ERROR', message: 'This description is reserved for a system-managed sheet' },
}

// ── in-memory store ────────────────────────────────────────────────────────────

type QueryResult = { rows: any[]; rowCount?: number }

interface SheetRow {
  id: string
  base_id: string
  name: string
  description: string | null
  system_kind: string | null
  deleted_at: string | null
  created_at: string
}

interface FieldRow {
  id: string
  sheet_id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}

interface RecordRow {
  id: string
  sheet_id: string
  data: Record<string, unknown>
  version: number
  created_at: string
}

interface UserRow {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  is_active: boolean
  created_at: string
}

interface Store {
  sheets: SheetRow[]
  fields: FieldRow[]
  records: RecordRow[]
  users: UserRow[]
  /** Every INSERT / UPDATE / DELETE issued, in order. */
  writes: Array<{ sql: string; params: unknown[] }>
  /** The raw SQL of every read against `users`. */
  userReads: string[]
}

function sheet(id: string, createdAt: string, extra: Partial<SheetRow> = {}): SheetRow {
  return { id, base_id: BASE_ID, name: id, description: null, system_kind: null, deleted_at: null, created_at: createdAt, ...extra }
}

function peopleFields(sheetId: string, prefix = ''): FieldRow[] {
  return [
    { id: `${prefix}${FLD_UID}`, sheet_id: sheetId, name: 'User ID', type: 'string', property: {}, order: 0 },
    { id: `${prefix}${FLD_NAME}`, sheet_id: sheetId, name: 'Name', type: 'string', property: {}, order: 1 },
    { id: `${prefix}${FLD_EMAIL}`, sheet_id: sheetId, name: 'Email', type: 'string', property: {}, order: 2 },
    { id: `${prefix}${FLD_AVATAR}`, sheet_id: sheetId, name: 'Avatar URL', type: 'string', property: {}, order: 3 },
  ]
}

function freshStore(): Store {
  return {
    sheets: [sheet(SOURCE_SHEET_ID, '2026-01-01T00:00:00.000Z', { name: 'Orders' })],
    fields: [],
    records: [],
    users: [
      { id: 'u_amy', email: 'amy@people.example.test', name: 'Amy Example', avatar_url: 'https://avatars.example.test/amy.png', is_active: true, created_at: '2026-01-01T00:00:01.000Z' },
      { id: 'u_nameless', email: 'nameless@people.example.test', name: null, avatar_url: null, is_active: true, created_at: '2026-01-01T00:00:02.000Z' },
      { id: 'u_blank', email: 'blank@people.example.test', name: '   ', avatar_url: '', is_active: true, created_at: '2026-01-01T00:00:03.000Z' },
      { id: 'u_gone', email: 'gone@people.example.test', name: 'Gone Example', avatar_url: 'https://avatars.example.test/gone.png', is_active: false, created_at: '2026-01-01T00:00:04.000Z' },
    ],
    writes: [],
    userReads: [],
  }
}

/** Project a row onto the column list of `SELECT <cols> FROM`, so a query that stops asking for a
 *  column really stops seeing it (a mock that returned whole rows could hide a dropped column). */
function projectSelected(sql: string, row: Record<string, unknown>): Record<string, unknown> {
  const match = /SELECT\s+([\s\S]+?)\s+FROM\s/i.exec(sql)
  if (!match) return { ...row }
  const out: Record<string, unknown> = {}
  for (const raw of match[1].split(',')) {
    const col = raw.trim().replace(/"/g, '')
    if (col in row) out[col] = row[col]
  }
  return out
}

function createMockPool(store: Store) {
  let seq = 0
  const nextStamp = () => `2026-02-01T00:00:${String(seq++).padStart(2, '0')}.000Z`

  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const p = (i: number) => String(params[i] ?? '')
    const isWrite = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
    if (isWrite) store.writes.push({ sql, params: [...params] })

    // Capability / guard lookups: no sheet-scoped grants, nothing is a projection sheet.
    if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
    if (sql.includes('FROM field_permissions')) return { rows: [] }
    if (sql.includes('FROM record_permissions')) return { rows: [] }
    if (sql.includes('FROM meta_view_permissions')) return { rows: [] }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (sql.includes('source_base_id')) return { rows: [] }
    if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }

    // ── writes ──────────────────────────────────────────────────────────────────
    if (/^\s*INSERT\s+INTO\s+meta_sheets\b/i.test(sql)) {
      if (store.sheets.some((row) => row.id === p(0))) return { rows: [], rowCount: 0 }
      store.sheets.push(sheet(p(0), nextStamp(), {
        base_id: p(1),
        name: p(2),
        description: params[3] === null || params[3] === undefined ? null : p(3),
        system_kind: sql.includes("'people_directory'") ? 'people_directory' : null,
      }))
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*INSERT\s+INTO\s+meta_fields\b/i.test(sql)) {
      store.fields.push({ id: p(0), sheet_id: p(1), name: p(2), type: 'string', property: {}, order: Number(params[3]) })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*INSERT\s+INTO\s+meta_records\b/i.test(sql)) {
      store.records.push({ id: p(0), sheet_id: p(1), data: JSON.parse(p(2)), version: 1, created_at: nextStamp() })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*UPDATE\s+meta_records\s+SET\s+data\s*=/i.test(sql)) {
      const row = store.records.find((r) => r.id === p(1))
      if (!row) return { rows: [], rowCount: 0 }
      row.data = JSON.parse(p(0))
      row.version += 1
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*INSERT\s+INTO\s+meta_views\b/i.test(sql)) return { rows: [{ id: p(0) }], rowCount: 1 }
    if (/^\s*INSERT\s+INTO\s+meta_config_revisions\b/i.test(sql)) return { rows: [], rowCount: 1 }
    if (isWrite) return { rows: [], rowCount: 0 }

    // ── reads ───────────────────────────────────────────────────────────────────
    if (/\bFROM\s+users\b/i.test(sql)) {
      store.userReads.push(sql)
      const active = sql.includes('is_active = TRUE') ? store.users.filter((u) => u.is_active) : store.users
      return { rows: active.map((u) => projectSelected(sql, u as unknown as Record<string, unknown>)) }
    }
    if (sql.includes('FROM meta_records') && sql.includes('WHERE sheet_id = $1')) {
      return {
        rows: store.records
          .filter((r) => r.sheet_id === p(0))
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
          .map((r) => ({ id: r.id, data: structuredClone(r.data) })),
      }
    }
    if (sql.includes('FROM meta_fields') && sql.includes('WHERE sheet_id = $1')) {
      return {
        rows: store.fields
          .filter((f) => f.sheet_id === p(0))
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
          .map((f) => ({ ...f })),
      }
    }
    if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
      return {
        rows: store.sheets
          .filter((s) => s.base_id === p(0) && s.deleted_at === null)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((s) => projectSelected(sql, s as unknown as Record<string, unknown>)),
      }
    }
    if (sql.includes('FROM meta_sheets') && sql.includes('WHERE id = $1')) {
      const row = store.sheets.find((s) => s.id === p(0))
      if (!row) return { rows: [] }
      if (sql.includes('deleted_at IS NULL') && row.deleted_at !== null) return { rows: [] }
      return { rows: [{ ...row }] }
    }
    if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
      return p(0) === BASE_ID
        ? { rows: [{ id: BASE_ID, name: 'People base', icon: null, color: null, owner_id: 'u_p5807_owner', workspace_id: null }] }
        : { rows: [] }
    }
    return { rows: [] }
  })

  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

// ── app harness ────────────────────────────────────────────────────────────────

async function buildApp(store: Store): Promise<Express> {
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
  app.use((req, _res, next) => {
    ;(req as any).user = { ...ADMIN_USER }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const pinned = usePinnedServer()

function on(app: Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function prepare(app: Express) {
  return on(app).post('/api/multitable/person-fields/prepare').send({ sheetId: SOURCE_SHEET_ID })
}

const recordWrites = (store: Store) => store.writes.filter((w) => /meta_records/i.test(w.sql))
const sheetWrites = (store: Store) => store.writes.filter((w) => /^\s*(INSERT\s+INTO|UPDATE)\s+meta_sheets\b/i.test(w.sql))
const allWrittenText = (store: Store) => JSON.stringify(store.writes.map((w) => w.params))

describe('#5807 People system sheet — email and avatar are no longer stored', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  describe('§1 first provision', () => {
    it('keeps the four columns, writes only User ID + Name, and shows a nameless user by id', async () => {
      const store = freshStore()
      const app = await buildApp(store)

      const res = await prepare(app)
      expect(res.status).toBe(200)

      const people = store.sheets.find((s) => s.id !== SOURCE_SHEET_ID)!
      expect(people).toMatchObject({ base_id: BASE_ID, name: 'People', description: SYSTEM_PEOPLE_SHEET_DESCRIPTION, system_kind: 'people_directory' })
      // Response shape is unchanged.
      expect(res.body).toEqual({
        ok: true,
        data: {
          targetSheet: { id: people.id, baseId: BASE_ID, name: 'People', description: SYSTEM_PEOPLE_SHEET_DESCRIPTION },
          fieldProperty: { foreignSheetId: people.id, limitSingleRecord: true, refKind: 'user' },
        },
      })

      const fieldIdByName = new Map(store.fields.filter((f) => f.sheet_id === people.id).map((f) => [f.name, f.id]))
      expect([...fieldIdByName.keys()]).toEqual(['User ID', 'Name', 'Email', 'Avatar URL'])
      const uid = fieldIdByName.get('User ID')!
      const name = fieldIdByName.get('Name')!

      const rows = store.records.filter((r) => r.sheet_id === people.id)
      // Deactivated users are not mirrored; blank and missing names fall back to the user id.
      expect(rows.map((r) => r.data)).toEqual([
        { [uid]: 'u_amy', [name]: 'Amy Example' },
        { [uid]: 'u_nameless', [name]: 'u_nameless' },
        { [uid]: 'u_blank', [name]: 'u_blank' },
      ])
      for (const row of rows) {
        expect(row.data).not.toHaveProperty([fieldIdByName.get('Email')!])
        expect(row.data).not.toHaveProperty([fieldIdByName.get('Avatar URL')!])
      }

      // Nothing email- or avatar-shaped reached any write, and the users read never asked for them.
      expect(allWrittenText(store)).not.toContain('example.test')
      expect(store.userReads).toHaveLength(1)
      expect(store.userReads[0]).not.toMatch(/\bemail\b|\bavatar_url\b/)
    })
  })

  describe('§2 explicit re-sync of rows written before the change', () => {
    function seededStore(): Store {
      const store = freshStore()
      store.sheets.push(sheet(PEOPLE_SHEET_ID, '2026-01-02T00:00:00.000Z', {
        name: 'People',
        description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
        system_kind: 'people_directory',
      }))
      store.fields.push(...peopleFields(PEOPLE_SHEET_ID))
      store.users.push(
        { id: 'u_cy', email: 'cy@people.example.test', name: 'Cy Example', avatar_url: null, is_active: true, created_at: '2026-01-01T00:00:05.000Z' },
        { id: 'u_dee', email: 'dee@people.example.test', name: 'Dee Example', avatar_url: null, is_active: true, created_at: '2026-01-01T00:00:06.000Z' },
      )
      const legacy = (id: string, data: Record<string, unknown>, at: string): RecordRow =>
        ({ id, sheet_id: PEOPLE_SHEET_ID, data, version: 3, created_at: at })
      store.records.push(
        // Same id + name as today: ONLY the retired Email/Avatar keys make it stale.
        legacy('rec_amy', { [FLD_UID]: 'u_amy', [FLD_NAME]: 'Amy Example', [FLD_EMAIL]: 'amy@people.example.test', [FLD_AVATAR]: '' }, '2026-01-03T00:00:01.000Z'),
        // Old fallback wrote the email into Name.
        legacy('rec_nameless', { [FLD_UID]: 'u_nameless', [FLD_NAME]: 'nameless@people.example.test', [FLD_EMAIL]: 'nameless@people.example.test', [FLD_AVATAR]: '' }, '2026-01-03T00:00:02.000Z'),
        // Already clean — must never be touched.
        legacy('rec_blank', { [FLD_UID]: 'u_blank', [FLD_NAME]: 'u_blank' }, '2026-01-03T00:00:03.000Z'),
        // Only an Avatar key left.
        legacy('rec_cy', { [FLD_UID]: 'u_cy', [FLD_NAME]: 'Cy Example', [FLD_AVATAR]: 'https://avatars.example.test/cy.png' }, '2026-01-03T00:00:04.000Z'),
        // Only an Email key left.
        legacy('rec_dee', { [FLD_UID]: 'u_dee', [FLD_NAME]: 'Dee Example', [FLD_EMAIL]: 'dee@people.example.test' }, '2026-01-03T00:00:05.000Z'),
        // Deactivated user: today's behaviour is to leave the row alone (a residual an owner scrub must cover).
        legacy('rec_gone', { [FLD_UID]: 'u_gone', [FLD_NAME]: 'Gone Example', [FLD_EMAIL]: 'gone@people.example.test', [FLD_AVATAR]: '' }, '2026-01-03T00:00:06.000Z'),
      )
      return store
    }

    it('rewrites each row that still carries Email or Avatar once, then a second re-sync is a no-op', async () => {
      const store = seededStore()
      const app = await buildApp(store)

      const first = await prepare(app)
      expect(first.status).toBe(200)
      expect(first.body.data.targetSheet.id).toBe(PEOPLE_SHEET_ID)

      const writes = recordWrites(store)
      // Only UPDATEs on existing rows; no new sheet / field / record.
      expect(sheetWrites(store)).toEqual([])
      expect(store.writes.filter((w) => /INSERT\s+INTO\s+meta_fields/i.test(w.sql))).toEqual([])
      expect(writes.map((w) => w.params[1]).sort()).toEqual(['rec_amy', 'rec_cy', 'rec_dee', 'rec_nameless'])
      for (const write of writes) {
        // The existing full-replace shape: whole data, version bump, updated_at.
        expect(write.sql).toMatch(/UPDATE meta_records\s+SET data = \$1::jsonb, version = version \+ 1, updated_at = now\(\)\s+WHERE id = \$2/)
        const payload = JSON.parse(String(write.params[0]))
        expect(Object.keys(payload).sort()).toEqual([FLD_NAME, FLD_UID].sort())
      }

      const byId = new Map(store.records.map((r) => [r.id, r]))
      expect(byId.get('rec_amy')).toMatchObject({ version: 4, data: { [FLD_UID]: 'u_amy', [FLD_NAME]: 'Amy Example' } })
      expect(byId.get('rec_nameless')).toMatchObject({ version: 4, data: { [FLD_UID]: 'u_nameless', [FLD_NAME]: 'u_nameless' } })
      expect(byId.get('rec_cy')).toMatchObject({ version: 4, data: { [FLD_UID]: 'u_cy', [FLD_NAME]: 'Cy Example' } })
      expect(byId.get('rec_dee')).toMatchObject({ version: 4, data: { [FLD_UID]: 'u_dee', [FLD_NAME]: 'Dee Example' } })
      for (const id of ['rec_amy', 'rec_nameless', 'rec_cy', 'rec_dee', 'rec_blank']) {
        expect(byId.get(id)!.data).not.toHaveProperty([FLD_EMAIL])
        expect(byId.get(id)!.data).not.toHaveProperty([FLD_AVATAR])
      }
      expect(byId.get('rec_blank')!.version).toBe(3)
      // Deactivated user's row is untouched — it still holds the old value (NOT closed by this change).
      expect(byId.get('rec_gone')).toMatchObject({ version: 3, data: { [FLD_EMAIL]: 'gone@people.example.test' } })
      expect(allWrittenText(store)).not.toContain('example.test')

      // Second explicit re-sync: nothing left to rewrite.
      const writesBefore = store.writes.length
      const second = await prepare(app)
      expect(second.status).toBe(200)
      expect(store.writes.slice(writesBefore)).toEqual([])
      expect(store.records.map((r) => r.version)).toEqual([4, 4, 3, 4, 4, 3])
    })
  })

  describe('§3 POST /sheets refuses the reserved People sentinel description', () => {
    const reserved = [
      ['exact', SYSTEM_PEOPLE_SHEET_DESCRIPTION],
      ['space-padded', `  ${SYSTEM_PEOPLE_SHEET_DESCRIPTION}  `],
      ['tab/newline-padded', `\t${SYSTEM_PEOPLE_SHEET_DESCRIPTION}\n`],
    ] as const

    for (const [label, description] of reserved) {
      it(`refuses the ${label} sentinel with a values-free 400 and creates nothing (even for an admin)`, async () => {
        const store = freshStore()
        const app = await buildApp(store)
        const sheetsBefore = store.sheets.map((s) => ({ ...s }))

        const res = await on(app).post('/api/multitable/sheets').send({
          id: 'sheet_p5807_posing',
          baseId: BASE_ID,
          name: 'People',
          description,
        })

        expect(res.status).toBe(400)
        expect(res.body).toEqual(RESERVED_BODY)
        expect(JSON.stringify(res.body)).not.toContain('__metasheet_system')
        expect(store.writes).toEqual([])
        expect(store.sheets).toEqual(sheetsBefore)
      })
    }

    it('positive control: an ordinary or near-miss description is still created', async () => {
      const store = freshStore()
      const app = await buildApp(store)

      for (const [id, description] of [
        ['sheet_p5807_plain', 'Orders board'],
        ['sheet_p5807_nearmiss', `${SYSTEM_PEOPLE_SHEET_DESCRIPTION}x`],
      ] as const) {
        const res = await on(app).post('/api/multitable/sheets').send({ id, baseId: BASE_ID, name: 'Board', description })
        expect(res.status).toBe(200)
        expect(res.body.data.sheet).toMatchObject({ id, baseId: BASE_ID, description })
        expect(store.sheets.find((s) => s.id === id)).toMatchObject({ description, system_kind: null })
      }
    })
  })

  describe('§4 which People sheet the sync targets', () => {
    it('prefers the system_kind sheet over an earlier-created sentinel-only sheet in the same base', async () => {
      const store = freshStore()
      // The sentinel-only sheet is OLDER, so a sentinel-first pick would land on it.
      store.sheets.push(
        sheet(FORGED_SHEET_ID, '2026-01-02T00:00:00.000Z', { name: 'People', description: SYSTEM_PEOPLE_SHEET_DESCRIPTION }),
        sheet(PEOPLE_SHEET_ID, '2026-01-05T00:00:00.000Z', {
          name: 'People',
          description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
          system_kind: 'people_directory',
        }),
      )
      store.fields.push(...peopleFields(FORGED_SHEET_ID, 'forged_'), ...peopleFields(PEOPLE_SHEET_ID))
      const app = await buildApp(store)

      const res = await prepare(app)
      expect(res.status).toBe(200)
      expect(res.body.data.targetSheet.id).toBe(PEOPLE_SHEET_ID)
      expect(res.body.data.fieldProperty.foreignSheetId).toBe(PEOPLE_SHEET_ID)

      expect(sheetWrites(store)).toEqual([])
      expect(store.writes.filter((w) => /INSERT\s+INTO\s+meta_fields/i.test(w.sql))).toEqual([])
      const inserted = store.records.filter((r) => r.sheet_id === PEOPLE_SHEET_ID)
      expect(inserted.map((r) => r.data[FLD_UID])).toEqual(['u_amy', 'u_nameless', 'u_blank'])
      expect(store.records.filter((r) => r.sheet_id === FORGED_SHEET_ID)).toEqual([])
      expect(recordWrites(store).every((w) => w.params[1] === PEOPLE_SHEET_ID)).toBe(true)
    })

    it('still falls back to a sentinel-only sheet and does not stamp system_kind on it', async () => {
      const store = freshStore()
      store.sheets.push(sheet(FORGED_SHEET_ID, '2026-01-02T00:00:00.000Z', { name: 'People', description: ` ${SYSTEM_PEOPLE_SHEET_DESCRIPTION}` }))
      store.fields.push(...peopleFields(FORGED_SHEET_ID))
      const app = await buildApp(store)

      const res = await prepare(app)
      expect(res.status).toBe(200)
      expect(res.body.data.targetSheet.id).toBe(FORGED_SHEET_ID)
      expect(sheetWrites(store)).toEqual([])
      expect(store.sheets.find((s) => s.id === FORGED_SHEET_ID)!.system_kind).toBeNull()
      expect(store.records.filter((r) => r.sheet_id === FORGED_SHEET_ID).map((r) => r.data[FLD_UID])).toEqual(['u_amy', 'u_nameless', 'u_blank'])
    })
  })
})

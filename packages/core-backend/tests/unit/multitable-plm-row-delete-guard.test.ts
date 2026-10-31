/**
 * R-66 ① (owner ruling 2026-10-28「管理员也不能删 PLM 行」): PLM rows on a stock-preparation template sheet cannot
 * be deleted by anyone, platform admins included (multitable/plm-row-delete-guard.ts).
 *
 * What this file pins (mock pool, no DB; the real-DB half is tests/integration/multitable-record-duplicate.test.ts
 * and the plugin-SDK case in tests/integration/stock-preparation-generic-writer-governance-realdb.cases.ts):
 *  1. THE PURE RULE — exact `stockPreparation` stanza (not the other plugin namespaces), the `key: true` column
 *     (string-encoded property tolerated), the non-empty key value rule, fail-closed when no key column resolves.
 *  2. THE SHEET HALVES — no exact stanza ⇒ no statement; stanza ⇒ the registry decides; a registry error propagates.
 *  3. THE REST DELETE — 409 RECORD_DELETE_REFUSED_PLM_ROW for a writer AND for an admin, values-free, with NO write;
 *     a keyless row, a tagged-but-unregistered copy and an ordinary row are deleted as before; key_column_missing.
 *  4. THE RESTORE — 409 RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE while a live row holds the key, restored otherwise.
 *  5. THE TRASH LIST — `restoreBlocked` only on the rows the restore route would refuse.
 *  6. THE GET /view OVERRIDES — `canDelete: false` + `deleteBlockedReason: 'plm_row'` for PLM rows only.
 *  7. THE AUTOMATION — delete_record on a PLM row: failed step with the fixed string, no DELETE, the txn rolled back.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { serializeFieldRow } from '../../src/multitable/field-codecs'
import {
  applyPlmRowDeleteBlocks,
  assertPlmRowDeletable,
  fieldsCarryExactStockPreparationStanza,
  isPlmKeyValuePresent,
  loadPlmRowSheetProfile,
  PLM_ROW_DELETE_AUTOMATION_REFUSAL,
  plmRowDeleteRefusalReason,
  PlmRowDeleteRefusedError,
  plmRowDeleteRefusedBody,
  plmRowRestoreRefusedBody,
  resolvePlmKeyFieldIds,
  resolvePlmRowDeleteBlockedIds,
  RECORD_DELETE_REFUSED_PLM_ROW_CODE,
  RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE_CODE,
} from '../../src/multitable/plm-row-delete-guard'
import { RecordService } from '../../src/multitable/record-service'
import { AutomationExecutor, type AutomationDeps, type AutomationRule } from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import { usePinnedServer } from '../utils/pinned-server'

// The key column's property after provisioning + the PLM lock (target-provisioning.cjs buildFieldProperty).
const KEY_PROPERTY = {
  validation: [{ type: 'required' }],
  stockPreparation: { ownership: 'plm_system', preserveOnRefresh: false, required: true, key: true },
  humanWriteLock: 'plm_system',
}
const PLAIN_STANZA_PROPERTY = { stockPreparation: { ownership: 'human_preserved', preserveOnRefresh: true, required: false, key: false } }

// ── 1. the pure rule ─────────────────────────────────────────────────────────────

describe('the exact stanza (sheet half, in memory)', () => {
  it.each([
    ['the template stanza', { stockPreparation: { key: true } }],
    ['a stanza with key:false (customer-pack column)', { stockPreparation: { key: false } }],
    ['a stanza with a non-object value (key presence is enough)', { stockPreparation: null }],
  ])('YES for %s', (_label, property) => {
    expect(fieldsCarryExactStockPreparationStanza([{ property: {} }, { property }])).toBe(true)
  })

  it('YES for a property stored as a JSON string inside jsonb', () => {
    expect(fieldsCarryExactStockPreparationStanza([{ property: JSON.stringify(KEY_PROPERTY) }])).toBe(true)
  })

  it.each([
    ['the MVP namespace', { stockPreparationMvp: { ownership: 'human_preserved' } }],
    ['the confirmation ledger namespace', { stockPreparationConfirmationDecision: { role: 'x' } }],
    ['the project overview namespace', { stockPreparationProjectOverview: { column: 'x' } }],
    ['ordinary keys', { validation: [{ type: 'required' }] }],
    ['the human write lock alone', { humanWriteLock: 'plm_system' }],
    ['a stanza-looking VALUE', { note: 'stockPreparation' }],
  ])('NO for %s', (_label, property) => {
    expect(fieldsCarryExactStockPreparationStanza([{ property }])).toBe(false)
  })

  it('survives the read serializer on the string key column', () => {
    const field = serializeFieldRow({ id: 'fld_key', name: 'Key', type: 'string', property: KEY_PROPERTY, order: 1 })
    expect(fieldsCarryExactStockPreparationStanza([field])).toBe(true)
    expect(resolvePlmKeyFieldIds([field])).toEqual(['fld_key'])
  })
})

describe('the key column and the key value (row half)', () => {
  it('resolves exactly the fields whose stanza says key === true (string-encoded property / stanza tolerated)', () => {
    expect(resolvePlmKeyFieldIds([
      { id: 'a', property: KEY_PROPERTY },
      { id: 'b', property: PLAIN_STANZA_PROPERTY },
      { id: 'c', property: JSON.stringify(KEY_PROPERTY) },
      { id: 'd', property: { stockPreparation: JSON.stringify({ key: true }) } },
      { id: 'e', property: { stockPreparation: { key: 'true' } } },
      { id: 'f', property: { stockPreparationMvp: { key: true } } },
      { property: KEY_PROPERTY },
    ])).toEqual(['a', 'c', 'd'])
  })

  it.each([
    ['a key string', 'K-1', true],
    ['a padded key string', '  K-1 ', true],
    ['a finite number', 42, true],
    ['zero', 0, true],
    ['an empty string', '', false],
    ['a blank string', '   ', false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['NaN', Number.NaN, false],
    ['an object', { k: 1 }, false],
    ['a boolean', true, false],
  ])('%s (%j) ⇒ present=%s', (_label, value, present) => {
    expect(isPlmKeyValuePresent(value)).toBe(present)
  })

  it('profile → refusal: not_plm never refuses; plm refuses keyed rows only; key_column_missing refuses every row', () => {
    expect(plmRowDeleteRefusalReason({ kind: 'not_plm' }, { k: 'K-1' })).toBeNull()
    const plm = { kind: 'plm' as const, keyFieldIds: ['k'] }
    expect(plmRowDeleteRefusalReason(plm, { k: 'K-1' })).toBe('plm_row')
    expect(plmRowDeleteRefusalReason(plm, { k: '' })).toBeNull()
    expect(plmRowDeleteRefusalReason(plm, { other: 'K-1' })).toBeNull()
    expect(plmRowDeleteRefusalReason(plm, null)).toBeNull()
    expect(plmRowDeleteRefusalReason({ kind: 'key_column_missing' }, {})).toBe('key_column_missing')
  })
})

// ── 2. the sheet halves ──────────────────────────────────────────────────────────

describe('loadPlmRowSheetProfile (both sheet halves)', () => {
  const registryQuery = (hit: boolean) => vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: hit ? [{ '?column?': 1 }] : [] }))

  it('no exact stanza ⇒ not_plm with NO statement (an ordinary / MVP / overview sheet pays nothing)', async () => {
    const query = registryQuery(true)
    expect(await loadPlmRowSheetProfile(query, 'sheet_a', [{ property: { stockPreparationProjectOverview: {} } }])).toEqual({ kind: 'not_plm' })
    expect(query).not.toHaveBeenCalled()
  })

  it('stanza ∧ registry row ⇒ plm with the key column; asked by sheet id against the registry', async () => {
    const query = registryQuery(true)
    // B2 (ADR adr-stock-prep-manual-rows-20261030 §3.5): the same ONE statement now also reads plugin_name / object_id;
    // a registry row that is not a registered project sheet's carries no project-sheet object id.
    expect(await loadPlmRowSheetProfile(query, 'sheet_a', [{ id: 'k', property: KEY_PROPERTY }])).toEqual({ kind: 'plm', keyFieldIds: ['k'], projectSheetObjectId: null })
    expect(String(query.mock.calls[0][0])).toContain('plugin_multitable_object_registry')
    expect(query.mock.calls[0][1]).toEqual(['sheet_a'])
  })

  it('stanza without a registry row (a user\'s 复制数据表 copy) ⇒ not_plm', async () => {
    expect(await loadPlmRowSheetProfile(registryQuery(false), 'sheet_copy', [{ id: 'k', property: KEY_PROPERTY }])).toEqual({ kind: 'not_plm' })
  })

  it('stanza ∧ registry row but no key:true column ⇒ key_column_missing (fail closed)', async () => {
    expect(await loadPlmRowSheetProfile(registryQuery(true), 'sheet_a', [{ id: 'x', property: PLAIN_STANZA_PROPERTY }])).toEqual({ kind: 'key_column_missing' })
  })

  it('a registry error propagates and assertPlmRowDeletable deletes nothing', async () => {
    const query = vi.fn(async () => { throw new Error('relation does not exist') })
    await expect(assertPlmRowDeletable(query, 'sheet_a', [{ id: 'k', property: KEY_PROPERTY }], { k: '' })).rejects.toThrow('relation does not exist')
  })

  it('there is no admin input at all: the guard is the same for every actor', async () => {
    await expect(assertPlmRowDeletable(registryQuery(true), 'sheet_a', [{ id: 'k', property: KEY_PROPERTY }], { k: 'K-1' }))
      .rejects.toBeInstanceOf(PlmRowDeleteRefusedError)
    await expect(assertPlmRowDeletable(registryQuery(true), 'sheet_a', [{ id: 'k', property: KEY_PROPERTY }], { k: '' })).resolves.toBeUndefined()
  })

  it('the read-path helper fails CLOSED on a probe error and reports it', async () => {
    const onError = vi.fn()
    const query = vi.fn(async () => { throw new Error('boom') })
    const blocked = await resolvePlmRowDeleteBlockedIds(query, 'sheet_a', [{ id: 'k', property: KEY_PROPERTY }], [{ id: 'r1', data: { k: '' } }], onError)
    expect([...blocked]).toEqual(['r1'])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('applyPlmRowDeleteBlocks: only rows the actor could otherwise delete, override ?? default, others untouched', () => {
    const def = { canEdit: true, canDelete: true, canComment: true }
    const merged = applyPlmRowDeleteBlocks(
      { r2: { canEdit: false, canDelete: false, canComment: true }, r3: { canEdit: true, canDelete: true, canComment: false } },
      [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }, { id: 'r4' }],
      new Set(['r1', 'r2', 'r3']),
      def,
    )
    expect(merged).toEqual({
      r1: { canEdit: true, canDelete: false, canComment: true, deleteBlockedReason: 'plm_row' },
      r2: { canEdit: false, canDelete: false, canComment: true },
      r3: { canEdit: true, canDelete: false, canComment: false, deleteBlockedReason: 'plm_row' },
    })
    const untouched = { r9: def }
    expect(applyPlmRowDeleteBlocks(untouched, [{ id: 'r1' }], new Set(), def)).toBe(untouched)
    expect(applyPlmRowDeleteBlocks(undefined, [{ id: 'r1' }], new Set(['r1']), { ...def, canDelete: false })).toBeUndefined()
  })

  it('refusal bodies are values-free and carry the reason', () => {
    expect(plmRowDeleteRefusedBody('plm_row')).toEqual({
      ok: false,
      error: { code: 'RECORD_DELETE_REFUSED_PLM_ROW', message: '这一行由备料插件（PLM 拉取）维护，不能删除；请在 PLM 里处理后重新拉取。', details: { reason: 'plm_row' } },
    })
    expect(plmRowDeleteRefusedBody('key_column_missing').error.message).toBe('这张表由备料插件维护，但识别不出唯一键列，为安全起见不能删除 / 恢复行。')
    expect(plmRowRestoreRefusedBody('key_active')).toEqual({
      ok: false,
      error: { code: 'RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE', message: '表里已有同一唯一键的有效行，这条已删除的 PLM 行不能恢复（恢复会造成同键两行，拉取会被卡住）。', details: { reason: 'key_active' } },
    })
  })
})

// ── 3–6. routes and service over one fake pool ───────────────────────────────────

const BASE_ID = 'base_plmdel'
/** Registered ∧ exact stanza with the key column: a stock-preparation project / env sheet. */
const SHEET_PM = 'sheet_plmdel_pm'
/** Exact stanza, NOT registered: a user's「复制数据表」copy. */
const SHEET_COPY = 'sheet_plmdel_copy'
/** Registered ∧ exact stanza but no key:true column: fail closed. */
const SHEET_NOKEY = 'sheet_plmdel_nokey'
/** Ordinary. */
const SHEET_PLAIN = 'sheet_plmdel_plain'
const SHEETS = [SHEET_PM, SHEET_COPY, SHEET_NOKEY, SHEET_PLAIN]
const REGISTERED = new Set([SHEET_PM, SHEET_NOKEY])
const KEY = (sheetId: string) => `fld_${sheetId}_key`

const fieldRowsFor = (sheetId: string) => [{
  id: KEY(sheetId),
  name: 'Key',
  type: 'string',
  property: sheetId === SHEET_PLAIN ? {} : sheetId === SHEET_NOKEY ? PLAIN_STANZA_PROPERTY : KEY_PROPERTY,
  order: 0,
}]

type FakeRecord = { id: string; sheet_id: string; data: Record<string, unknown>; version: number; created_by: string | null }
type FakeTrash = { id: string; record_id: string; sheet_id: string; data: Record<string, unknown>; original_version: number; created_by: string | null; deleted_by: string | null; deleted_at: string }

const records = new Map<string, FakeRecord>()
const trash = new Map<string, FakeTrash>()
const sqlLog: string[] = []

function seed() {
  records.clear()
  trash.clear()
  const add = (id: string, sheetId: string, key: unknown) => records.set(id, { id, sheet_id: sheetId, data: { [KEY(sheetId)]: key }, version: 1, created_by: null })
  add('rec_pm_keyed', SHEET_PM, 'K-1')
  add('rec_pm_keyless', SHEET_PM, '')
  add('rec_pm_live', SHEET_PM, 'K-LIVE')
  add('rec_copy_keyed', SHEET_COPY, 'K-1')
  add('rec_nokey_row', SHEET_NOKEY, 'K-1')
  add('rec_plain_keyed', SHEET_PLAIN, 'K-1')
  const addTrash = (recordId: string, sheetId: string, key: unknown) => trash.set(recordId, {
    id: `trash_${recordId}`, record_id: recordId, sheet_id: sheetId, data: { [KEY(sheetId)]: key }, original_version: 1,
    created_by: null, deleted_by: 'u_x', deleted_at: '2026-10-28T00:00:00.000Z',
  })
  addTrash('rec_pm_trash_live', SHEET_PM, 'K-LIVE')
  addTrash('rec_pm_trash_gone', SHEET_PM, 'K-GONE')
  addTrash('rec_pm_trash_keyless', SHEET_PM, null)
  addTrash('rec_nokey_trash', SHEET_NOKEY, 'K-9')
}

function createFakePool() {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim()
    sqlLog.push(flat)
    const p = (i: number) => String(params?.[i] ?? '')
    if (flat.includes('FROM plugin_multitable_object_registry')) {
      return { rows: REGISTERED.has(p(0)) ? [{ '?column?': 1 }] : [] }
    }
    if (flat.includes('SELECT deleted_at FROM meta_sheets WHERE id = $1')) {
      return { rows: SHEETS.includes(p(0)) ? [{ deleted_at: null }] : [] }
    }
    if (flat.startsWith('SELECT 1 FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      return { rows: SHEETS.includes(p(0)) ? [{ '?column?': 1 }] : [] }
    }
    if (flat.includes('FROM meta_sheets') && flat.includes('= ANY(')) return { rows: [] }
    if (flat.includes('FROM meta_sheets') && (flat.includes('WHERE s.id = $1') || flat.includes('WHERE id = $1'))) {
      if (!SHEETS.includes(p(0))) return { rows: [] }
      return { rows: [{ id: p(0), base_id: BASE_ID, name: 'plmdel', description: null, base_ref_id: BASE_ID, base_name: 'plmdel', base_icon: null, base_color: null, base_owner_id: null, base_workspace_id: null }] }
    }
    if (flat.includes('FROM meta_fields') && flat.includes('WHERE sheet_id = $1')) {
      return { rows: SHEETS.includes(p(0)) ? fieldRowsFor(p(0)) : [] }
    }
    if (flat.includes('FROM meta_bases')) {
      return { rows: p(0) === BASE_ID ? [{ id: BASE_ID, name: 'plmdel', workspace_id: null }] : [] }
    }
    // ── trash ──
    if (flat.startsWith('SELECT COUNT(*)::int AS n FROM meta_records_trash WHERE sheet_id = $1')) {
      return { rows: [{ n: [...trash.values()].filter((t) => t.sheet_id === p(0)).length }] }
    }
    if (flat.startsWith('SELECT * FROM meta_records_trash WHERE sheet_id = $1')) {
      return { rows: [...trash.values()].filter((t) => t.sheet_id === p(0)) }
    }
    if (flat.startsWith('SELECT * FROM meta_records_trash WHERE record_id = $1')) {
      const t = trash.get(p(0))
      return { rows: t ? [t] : [] }
    }
    if (flat.startsWith('SELECT * FROM meta_records_trash WHERE id = $1 FOR UPDATE')) {
      return { rows: [...trash.values()].filter((t) => t.id === p(0)) }
    }
    if (flat.startsWith('SELECT sheet_id FROM meta_records_trash WHERE record_id = $1')) {
      const t = trash.get(p(0))
      return { rows: t ? [{ sheet_id: t.sheet_id }] : [] }
    }
    // ── the guard's live-key reads ──
    if (flat.startsWith('SELECT 1 FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3')) {
      return { rows: [...records.values()].some((r) => r.sheet_id === p(0) && String(r.data[p(1)] ?? '') === p(2)) ? [{ '?column?': 1 }] : [] }
    }
    if (flat.startsWith('SELECT DISTINCT data ->> $2 AS plm_key FROM meta_records')) {
      const keys = new Set((params[2] as string[]) ?? [])
      const live = [...records.values()].filter((r) => r.sheet_id === p(0) && keys.has(String(r.data[p(1)] ?? ''))).map((r) => String(r.data[p(1)]))
      return { rows: [...new Set(live)].map((plm_key) => ({ plm_key })) }
    }
    // GET /view's unpaged listing (no limit / search / sort / filter)
    if (flat.startsWith('SELECT id, version, data, locked, locked_by, locked_at FROM meta_records WHERE sheet_id = $1 ORDER BY')) {
      return { rows: [...records.values()].filter((r) => r.sheet_id === p(0)).map((r) => ({ ...r, locked: false, locked_by: null, locked_at: null })) }
    }
    if (flat.startsWith('SELECT 1 FROM meta_records WHERE id = $1 FOR UPDATE')) {
      return { rows: records.has(p(0)) ? [{ '?column?': 1 }] : [] }
    }
    if (flat.includes('FROM meta_records') && flat.includes('WHERE id = $1')) {
      const r = records.get(p(0))
      if (!r || (flat.includes('AND sheet_id = $2') && r.sheet_id !== p(1))) return { rows: [] }
      return { rows: [{ ...r, locked: false, locked_by: null, locked_at: null, created_at: null, updated_at: null }] }
    }
    if (/^(INSERT|UPDATE|DELETE)/.test(flat)) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

const pool = createFakePool()
const WRITER = { id: 'u_plmdel_writer', roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const ADMIN = { id: 'u_plmdel_admin', roles: ['admin'], perms: [] as string[] }
let actor: { id: string; roles: string[]; perms: string[] } = WRITER
let app: Express

async function buildApp(): Promise<Express> {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as any)
  const built = express()
  built.use(express.json())
  built.use((req, _res, next) => {
    ;(req as any).user = actor
    next()
  })
  built.use('/api/multitable', univerMetaRouter())
  return built
}

// ONE pinned listener for the file (#4154: `request(app)` is banned under tests/unit).
const pinned = usePinnedServer()

function prepare(): void {
  sqlLog.length = 0
  pinned.setApp(app)
}
const del = (recordId: string) => {
  prepare()
  return request(pinned.url()).delete(`/api/multitable/records/${recordId}`)
}
const restore = (recordId: string) => {
  prepare()
  return request(pinned.url()).post(`/api/multitable/records/${recordId}/restore`).send({})
}
const view = (sheetId: string) => {
  prepare()
  return request(pinned.url()).get('/api/multitable/view').query({ sheetId })
}

const writes = () => sqlLog.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s))
const recordDeletes = () => sqlLog.filter((s) => /^DELETE FROM meta_records WHERE id = \$1/.test(s))

// The router module is large; a cold import under a loaded runner can outlast the default 15 s hook timeout.
beforeAll(async () => {
  app = await buildApp()
}, 60_000)

describe('DELETE /records/:recordId on a stock-preparation template sheet (R-66 ①)', () => {
  it.each([
    ['a writer', WRITER],
    ['a platform admin', ADMIN],
  ])('a keyed PLM row: %s gets the exact values-free 409 and NOTHING is written', async (_label, who) => {
    seed()
    actor = who
    const res = await del('rec_pm_keyed')
    expect(res.status).toBe(409)
    expect(res.body).toEqual(plmRowDeleteRefusedBody('plm_row'))
    expect(res.body.error.code).toBe(RECORD_DELETE_REFUSED_PLM_ROW_CODE)
    for (const value of [SHEET_PM, 'rec_pm_keyed', KEY(SHEET_PM), 'K-1']) expect(res.text).not.toContain(value)
    expect(writes()).toEqual([])
    actor = WRITER
  })

  it('a keyless row on the same sheet is deleted as before', async () => {
    seed()
    const res = await del('rec_pm_keyless')
    expect(res.status).toBe(200)
    expect(recordDeletes()).toHaveLength(1)
  })

  it('a keyed row on a tagged but NOT registered copy is deleted as before', async () => {
    seed()
    const res = await del('rec_copy_keyed')
    expect(res.status).toBe(200)
    expect(recordDeletes()).toHaveLength(1)
  })

  it('an ordinary sheet: deleted, and no registry statement is issued', async () => {
    seed()
    const res = await del('rec_plain_keyed')
    expect(res.status).toBe(200)
    expect(recordDeletes()).toHaveLength(1)
    expect(sqlLog.some((s) => s.includes('plugin_multitable_object_registry'))).toBe(false)
  })

  it('registered stanza sheet without a resolvable key column: every row refused, reason key_column_missing', async () => {
    seed()
    actor = ADMIN
    const res = await del('rec_nokey_row')
    expect(res.status).toBe(409)
    expect(res.body).toEqual(plmRowDeleteRefusedBody('key_column_missing'))
    expect(writes()).toEqual([])
    actor = WRITER
  })

  it('a reader is refused by the capability gate first and learns nothing about PLM rows', async () => {
    seed()
    actor = { id: 'u_plmdel_reader', roles: ['member'], perms: ['multitable:read'] }
    const res = await del('rec_pm_keyed')
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).not.toBe(RECORD_DELETE_REFUSED_PLM_ROW_CODE)
    expect(sqlLog.some((s) => s.includes('plugin_multitable_object_registry'))).toBe(false)
    actor = WRITER
  })
})

describe('POST /records/:recordId/restore of a deleted PLM row (R-66 ①)', () => {
  it.each([
    ['a writer', WRITER],
    ['a platform admin', ADMIN],
  ])('a live row already holds the key: %s gets 409 RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE and nothing is inserted', async (_label, who) => {
    seed()
    actor = who
    const res = await restore('rec_pm_trash_live')
    expect(res.status).toBe(409)
    expect(res.body).toEqual(plmRowRestoreRefusedBody('key_active'))
    expect(res.body.error.code).toBe(RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE_CODE)
    for (const value of [SHEET_PM, 'rec_pm_trash_live', KEY(SHEET_PM), 'K-LIVE']) expect(res.text).not.toContain(value)
    expect(sqlLog.some((s) => s.startsWith('INSERT INTO meta_records '))).toBe(false)
    actor = WRITER
  })

  it('no live row holds the key: restored (the human cells come back; the next pull updates by key)', async () => {
    seed()
    const res = await restore('rec_pm_trash_gone')
    expect(res.status).toBe(200)
    expect(sqlLog.some((s) => s.startsWith('INSERT INTO meta_records '))).toBe(true)
  })

  it('a keyless trash row is restored', async () => {
    seed()
    const res = await restore('rec_pm_trash_keyless')
    expect(res.status).toBe(200)
  })

  it('key column unresolvable: refused with reason key_column_missing (the trash row stays)', async () => {
    seed()
    const res = await restore('rec_nokey_trash')
    expect(res.status).toBe(409)
    expect(res.body).toEqual(plmRowRestoreRefusedBody('key_column_missing'))
    expect(sqlLog.some((s) => s.startsWith('DELETE FROM meta_records_trash'))).toBe(false)
  })
})

describe('RecordService.listDeletedRecords marks restoreBlocked on PLM sheets only', () => {
  const access = { userId: 'u_plmdel_admin', permissions: [], isAdminRole: true }
  const full = { canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true, canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: true, canExport: true, canSendNotification: true, canSubmitApproval: false }
  const resolveSheetAccess = async () => ({ capabilities: full })

  it('the live-key trash row is plm_key_active; the others carry no marker', async () => {
    seed()
    const result = await new RecordService(pool as any, new EventBus()).listDeletedRecords({ sheetId: SHEET_PM, access, resolveSheetAccess })
    const byId = Object.fromEntries(result.records.map((r) => [r.recordId, r]))
    expect(byId.rec_pm_trash_live.restoreBlocked).toBe('plm_key_active')
    expect('restoreBlocked' in byId.rec_pm_trash_gone).toBe(false)
    expect('restoreBlocked' in byId.rec_pm_trash_keyless).toBe(false)
  })

  it('an unresolvable key column marks every row plm_key_unresolved', async () => {
    seed()
    const result = await new RecordService(pool as any, new EventBus()).listDeletedRecords({ sheetId: SHEET_NOKEY, access, resolveSheetAccess })
    expect(result.records.map((r) => r.restoreBlocked)).toEqual(['plm_key_unresolved'])
  })
})

describe('GET /view rowActionOverrides (R-66 ①, per-row channel, no /context key)', () => {
  it.each([
    ['a writer', WRITER],
    ['a platform admin', ADMIN],
  ])('%s: keyed PLM rows are canDelete=false + deleteBlockedReason; the keyless row has no override', async (_label, who) => {
    seed()
    actor = who
    const res = await view(SHEET_PM)
    expect(res.status).toBe(200)
    const { rowActions, rowActionOverrides: overrides } = res.body.data.meta.permissions
    expect(rowActions.canDelete).toBe(true)
    expect('deleteBlockedReason' in rowActions).toBe(false)
    const blocked = { ...rowActions, canDelete: false, deleteBlockedReason: 'plm_row' }
    expect(overrides.rec_pm_keyed).toEqual(blocked)
    expect(overrides.rec_pm_live).toEqual(blocked)
    expect(overrides.rec_pm_keyless).toBeUndefined()
    expect(Object.keys(overrides).sort()).toEqual(['rec_pm_keyed', 'rec_pm_live'])
    actor = WRITER
  })

  it.each([
    ['GET /records/:recordId', (recordId: string) => request(pinned.url()).get(`/api/multitable/records/${recordId}`).query({ sheetId: SHEET_PM })],
    ['GET /form-context', (recordId: string) => request(pinned.url()).get('/api/multitable/form-context').query({ sheetId: SHEET_PM, recordId })],
  ])('%s: the single-record rowActions carry the same PLM block; a keyless row is unchanged', async (_label, get) => {
    seed()
    actor = ADMIN
    prepare()
    const keyed = await get('rec_pm_keyed')
    expect(keyed.status).toBe(200)
    expect(keyed.body.data.rowActions).toMatchObject({ canDelete: false, deleteBlockedReason: 'plm_row' })
    prepare()
    const keyless = await get('rec_pm_keyless')
    expect(keyless.status).toBe(200)
    expect(keyless.body.data.rowActions.canDelete).toBe(true)
    expect('deleteBlockedReason' in keyless.body.data.rowActions).toBe(false)
    actor = WRITER
  })

  it('a copy and an ordinary sheet: no overrides at all', async () => {
    seed()
    for (const sheetId of [SHEET_COPY, SHEET_PLAIN]) {
      const res = await view(sheetId)
      expect(res.status, sheetId).toBe(200)
      expect('rowActionOverrides' in res.body.data.meta.permissions, sheetId).toBe(false)
    }
  })

  it('a reader (cannot delete anyway) on a page without a `manual:`-keyed row: no overrides and no registry statement', async () => {
    seed()
    actor = { id: 'u_plmdel_reader', roles: ['member'], perms: ['multitable:read'] }
    const res = await view(SHEET_PM)
    expect(res.status).toBe(200)
    expect('rowActionOverrides' in res.body.data.meta.permissions).toBe(false)
    expect(sqlLog.some((s) => s.includes('plugin_multitable_object_registry'))).toBe(false)
    actor = WRITER
  })
})

// ── 7. the automation executor ───────────────────────────────────────────────────

describe('automation delete_record on a PLM row', () => {
  function deps(data: Record<string, unknown>, sheetFields: unknown[], registered: boolean) {
    const state = { deletes: 0, rolledBack: 0, committed: 0, registryReads: 0 }
    const handle = async (sql: unknown, _params?: unknown[]) => {
      const s = String(sql).replace(/\s+/g, ' ').trim()
      if (s.includes('plugin_multitable_object_registry')) {
        state.registryReads += 1
        return { rows: registered ? [{ '?column?': 1 }] : [], rowCount: registered ? 1 : 0 }
      }
      if (s.startsWith('SELECT id, property FROM meta_fields WHERE sheet_id = $1')) return { rows: sheetFields, rowCount: sheetFields.length }
      if (/^DELETE FROM meta_records WHERE/.test(s)) {
        state.deletes += 1
        return { rows: [], rowCount: 1 }
      }
      if (/SELECT[\s\S]*FROM meta_records/.test(s)) {
        return { rows: [{ locked: false, locked_by: null, created_by: 'user_1', version: 1, data }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    const automationDeps: AutomationDeps = {
      eventBus: new EventBus(),
      queryFn: vi.fn(handle),
      transaction: vi.fn(async (handler) => {
        try {
          const out = await handler({ query: vi.fn(handle) })
          state.committed += 1
          return out
        } catch (err) {
          state.rolledBack += 1
          throw err
        }
      }),
    }
    return { state, automationDeps }
  }
  const rule = {
    id: 'rule_plm', name: 'delete rule', sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} }, actions: [{ type: 'delete_record', config: {} }],
    enabled: true, createdBy: 'user_1', createdAt: '2026-01-01T00:00:00Z',
  } as unknown as AutomationRule
  const trigger = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: {} }
  const keyField = [{ id: 'k', property: KEY_PROPERTY }]

  it('refused: failed step with the fixed string, no DELETE, the transaction rolled back', async () => {
    const { state, automationDeps } = deps({ k: 'K-1' }, keyField, true)
    const exec = await new AutomationExecutor(automationDeps).execute(rule, trigger)
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toBe(PLM_ROW_DELETE_AUTOMATION_REFUSAL)
    expect(state.deletes).toBe(0)
    expect(state.rolledBack).toBe(1)
    expect(state.committed).toBe(0)
  })

  it('a keyless row on the same sheet is deleted', async () => {
    const { state, automationDeps } = deps({ k: '' }, keyField, true)
    const exec = await new AutomationExecutor(automationDeps).execute(rule, trigger)
    expect(exec.steps[0]?.status).toBe('success')
    expect(state.deletes).toBe(1)
  })

  it('an ordinary sheet: deleted, no registry statement', async () => {
    const { state, automationDeps } = deps({ k: 'K-1' }, [{ id: 'k', property: {} }], true)
    const exec = await new AutomationExecutor(automationDeps).execute(rule, trigger)
    expect(exec.steps[0]?.status).toBe('success')
    expect(state.deletes).toBe(1)
    expect(state.registryReads).toBe(0)
  })
})

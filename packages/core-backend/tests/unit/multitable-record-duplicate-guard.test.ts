/**
 * Customer feedback 2026-10-27 (「在某行 右击 就出现 记录已复制」): the generic record duplicate is refused on a
 * sheet whose rows the stock-preparation plugin maintains (multitable/record-duplicate-guard.ts).
 *
 * What this file pins (mock pool, no DB; the real-DB half is
 * tests/integration/multitable-record-duplicate.test.ts, wired in plugin-tests.yml):
 *  1. THE PURE NAMESPACE HALF — any own `property` key starting with `stockPreparation` (all four plugin
 *     namespaces), string-encoded property included; nothing else (ordinary keys, the lock alone, null).
 *  2. THE SERIALIZER PIN — the predicate runs over fields that went through `serializeFieldRow`, so a
 *     stock-preparation column must keep its namespace through the read codec. If a sanitizer branch ever
 *     turned closed-allowlist for these types, the guard would fail OPEN on exactly the sheets it protects.
 *  3. THE TWO-HALF RULE — no namespace ⇒ no statement at all (an ordinary sheet pays nothing); namespace ⇒
 *     the registry decides; a registry error propagates.
 *  4. THE ROUTE — `POST /records/:recordId/duplicate` answers the exact values-free 409 on a registered ∧
 *     tagged sheet with NO write; an ordinary sheet and a tagged-but-unregistered sheet (a user's
 *     「复制数据表」copy) are not refused and issue the create.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { serializeFieldRow } from '../../src/multitable/field-codecs'
import {
  fieldsCarryPluginMaintainedRowNamespace,
  isPluginMaintainedRowSheet,
  RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_BODY,
  RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_CODE,
  RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_STATUS,
} from '../../src/multitable/record-duplicate-guard'
import { usePinnedServer } from '../utils/pinned-server'

// The property a stock-preparation project sheet's key column carries after provisioning + the PLM lock
// (target-provisioning.cjs buildFieldProperty + project-targets.cjs markProjectSheetPlmSystemColumns).
const KEY_COLUMN_PROPERTY = {
  validation: [{ type: 'required' }],
  stockPreparation: { ownership: 'plm_system', preserveOnRefresh: false, required: true, key: true },
  humanWriteLock: 'plm_system',
}

describe('fieldsCarryPluginMaintainedRowNamespace (pure)', () => {
  it.each([
    ['stockPreparation', { stockPreparation: { ownership: 'plm_system' } }],
    ['stockPreparationMvp', { stockPreparationMvp: { ownership: 'human_preserved' } }],
    ['stockPreparationConfirmationDecision', { stockPreparationConfirmationDecision: { role: 'x' } }],
    ['stockPreparationProjectOverview', { stockPreparationProjectOverview: {} }],
    ['a key with a non-object value (key presence is enough, fail-closed)', { stockPreparation: null }],
  ])('YES for %s', (_label, property) => {
    expect(fieldsCarryPluginMaintainedRowNamespace([{ property: {} }, { property }])).toBe(true)
  })

  it('YES for a property stored as a JSON string inside jsonb', () => {
    expect(fieldsCarryPluginMaintainedRowNamespace([{ property: JSON.stringify(KEY_COLUMN_PROPERTY) }])).toBe(true)
  })

  it.each([
    ['no fields', []],
    ['empty properties', [{ property: {} }, { property: null }, { property: undefined }, {}]],
    ['ordinary keys', [{ property: { validation: [{ type: 'required' }], options: [{ value: 'A' }] } }]],
    ['the human write lock alone', [{ property: { humanWriteLock: 'plm_system' } }]],
    ['a namespace-looking VALUE, not key', [{ property: { note: 'stockPreparation' } }]],
    ['a different prefix', [{ property: { stock: {}, preparation: {}, StockPreparation: {} } }]],
    ['a malformed string property', [{ property: '{not json' }]],
    ['an array property', [{ property: ['stockPreparation'] }]],
  ])('NO for %s', (_label, fields) => {
    expect(fieldsCarryPluginMaintainedRowNamespace(fields as Array<{ property?: unknown }>)).toBe(false)
  })
})

describe('the namespace survives the read serializer (serializeFieldRow)', () => {
  it.each([
    ['string', KEY_COLUMN_PROPERTY],
    ['number', { stockPreparation: { ownership: 'plm_system' }, humanWriteLock: 'plm_system' }],
    ['boolean', { stockPreparation: { ownership: 'plm_system', required: true } }],
    ['select', { options: [{ value: 'A' }], stockPreparation: { ownership: 'human_preserved', optionSource: { type: 'config_info', key: 'k' } } }],
    ['date', { stockPreparation: { ownership: 'human_preserved' } }],
    ['longText', { stockPreparationConfirmationDecision: { role: 'x' } }],
  ])('a %s column keeps it', (type, property) => {
    const field = serializeFieldRow({ id: 'fld_x', name: 'X', type, property, order: 1 })
    expect(fieldsCarryPluginMaintainedRowNamespace([field])).toBe(true)
  })

  it('also when meta_fields hands the property back as a JSON string', () => {
    const field = serializeFieldRow({ id: 'fld_x', name: 'X', type: 'string', property: JSON.stringify(KEY_COLUMN_PROPERTY), order: 1 })
    expect(fieldsCarryPluginMaintainedRowNamespace([field])).toBe(true)
  })
})

describe('isPluginMaintainedRowSheet (both halves)', () => {
  const registryQuery = (hit: boolean) => vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: hit ? [{ '?column?': 1 }] : [] }))

  it('no namespace ⇒ false with NO statement (an ordinary sheet pays nothing)', async () => {
    const query = registryQuery(true)
    expect(await isPluginMaintainedRowSheet(query, 'sheet_a', [{ property: { options: [] } }])).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })

  it('namespace ∧ registry row ⇒ true, asked by sheet id against the registry', async () => {
    const query = registryQuery(true)
    expect(await isPluginMaintainedRowSheet(query, 'sheet_a', [{ property: KEY_COLUMN_PROPERTY }])).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
    expect(String(query.mock.calls[0][0])).toContain('plugin_multitable_object_registry')
    expect(query.mock.calls[0][1]).toEqual(['sheet_a'])
  })

  it('namespace without a registry row (a user\'s 复制数据表 copy) ⇒ false', async () => {
    expect(await isPluginMaintainedRowSheet(registryQuery(false), 'sheet_copy', [{ property: KEY_COLUMN_PROPERTY }])).toBe(false)
  })

  it('a registry error propagates (the caller decides the fail-closed direction)', async () => {
    const query = vi.fn(async () => { throw new Error('relation does not exist') })
    await expect(isPluginMaintainedRowSheet(query, 'sheet_a', [{ property: KEY_COLUMN_PROPERTY }])).rejects.toThrow('relation does not exist')
  })
})

// ── the route ─────────────────────────────────────────────────────────────────

const BASE_ID = 'base_rc_dup'
/** Registered ∧ tagged: a stock-preparation project / env sheet. */
const SHEET_PLUGIN = 'sheet_rc_dup_plugin'
/** Tagged, NOT registered: a user's「复制数据表」copy of a stock-preparation sheet. */
const SHEET_COPY = 'sheet_rc_dup_copy'
/** Neither: an ordinary sheet. */
const SHEET_PLAIN = 'sheet_rc_dup_plain'

const SHEETS = [SHEET_PLUGIN, SHEET_COPY, SHEET_PLAIN]
const REGISTERED = new Set([SHEET_PLUGIN])
const recOn = (sheetId: string) => `rec_${sheetId}`
const FLD = (sheetId: string) => `fld_${sheetId}_key`

const fieldRowsFor = (sheetId: string) => [{
  id: FLD(sheetId),
  name: 'Key',
  type: 'string',
  property: sheetId === SHEET_PLAIN ? {} : { stockPreparation: { ownership: 'plm_system', required: false, key: true } },
  order: 0,
}]

const sqlLog: string[] = []

/** Unlisted SQL answers an empty result (never a throw): every cell asserts an exact status / body / statement. */
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
    if (flat.includes('FROM meta_sheets') && flat.includes('= ANY(')) return { rows: [] }
    if (flat.includes('FROM meta_sheets') && (flat.includes('WHERE s.id = $1') || flat.includes('WHERE id = $1'))) {
      if (!SHEETS.includes(p(0))) return { rows: [] }
      return { rows: [{ id: p(0), base_id: BASE_ID, name: 'rc', description: null, base_ref_id: BASE_ID, base_name: 'rc', base_icon: null, base_color: null, base_owner_id: null, base_workspace_id: null }] }
    }
    if (flat.includes('FROM meta_records') && flat.includes('WHERE id = $1')) {
      const sheetId = SHEETS.find((s) => recOn(s) === p(0))
      if (!sheetId || (params.length > 1 && sheetId !== p(1))) return { rows: [] }
      return { rows: [{ id: p(0), sheet_id: sheetId, version: 1, data: { [FLD(sheetId)]: 'K-1' }, created_by: null, locked: false, locked_by: null, locked_at: null }] }
    }
    if (flat.includes('FROM meta_fields') && flat.includes('WHERE sheet_id = $1')) {
      return { rows: SHEETS.includes(p(0)) ? fieldRowsFor(p(0)) : [] }
    }
    if (flat.includes('FROM meta_bases')) {
      return { rows: p(0) === BASE_ID ? [{ id: BASE_ID, name: 'rc', workspace_id: null }] : [] }
    }
    if (/^(INSERT|UPDATE|DELETE)/.test(flat)) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

const pool = createFakePool()
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
    ;(req as any).user = { id: 'u_rc_dup_admin', roles: ['admin'], perms: [] }
    next()
  })
  built.use('/api/multitable', univerMetaRouter())
  return built
}

// ONE pinned listener for the file (#4154: `request(app)` is banned under tests/unit).
const pinned = usePinnedServer()

function duplicate(sheetId: string) {
  sqlLog.length = 0
  pinned.setApp(app)
  return request(pinned.url()).post(`/api/multitable/records/${recOn(sheetId)}/duplicate`).send({ sheetId })
}

const recordInserts = () => sqlLog.filter((s) => /^INSERT INTO meta_records\b/i.test(s))
const registryReads = () => sqlLog.filter((s) => s.includes('plugin_multitable_object_registry'))

// The router module is large; a cold import under a loaded runner can outlast the default 15 s hook timeout.
beforeAll(async () => {
  app = await buildApp()
}, 60_000)

describe('POST /records/:recordId/duplicate on a plugin-maintained sheet', () => {
  it('registered ∧ tagged: the exact values-free 409, and NO record is written', async () => {
    const res = await duplicate(SHEET_PLUGIN)
    expect(res.status).toBe(RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_STATUS)
    expect(res.status).toBe(409)
    expect(res.body).toEqual(RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_BODY)
    expect(res.body.error.code).toBe(RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_CODE)
    // values-free: neither the sheet, the record, the field nor the cell value is echoed
    for (const value of [SHEET_PLUGIN, recOn(SHEET_PLUGIN), FLD(SHEET_PLUGIN), 'K-1']) expect(res.text).not.toContain(value)
    expect(registryReads()).toHaveLength(1)
    expect(recordInserts()).toHaveLength(0)
    expect(sqlLog.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s))).toBe(false)
  })

  it('ordinary sheet: not refused, no registry statement, the create is issued (unchanged)', async () => {
    const res = await duplicate(SHEET_PLAIN)
    expect(res.status).not.toBe(409)
    expect(res.body?.error?.code).not.toBe(RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_CODE)
    expect(registryReads()).toHaveLength(0)
    expect(recordInserts().length).toBeGreaterThan(0)
  })

  it('tagged but NOT registered (a user\'s 复制数据表 copy): not refused, the create is issued', async () => {
    const res = await duplicate(SHEET_COPY)
    expect(res.status).not.toBe(409)
    expect(res.body?.error?.code).not.toBe(RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET_CODE)
    expect(registryReads()).toHaveLength(1)
    expect(recordInserts().length).toBeGreaterThan(0)
  })
})

/**
 * 批次标识 BI-5 — unit lane for the two host primitives (multitable/view-landing.ts) and their plugin-scope wrappers.
 *
 *   VL-U01 promote: statement order (fence → view-row lock → the ONE UPDATE → existence read) and the SQL shape: the
 *          only write statement is `UPDATE meta_views` whose SET clause names `created_at` and nothing else, keyed by
 *          (id, sheet_id) derived for (projectId, objectId, viewLogicalId); a source census of view-landing.ts finds no
 *          INSERT / DELETE and exactly one UPDATE.
 *   VL-U02 promote: the tie rule is in the statement — compared against the OTHER views (`o.id <> $1`) with `>=`, never
 *          the design's literal `created_at > min(all)` (which leaves a view tied at the minimum unmoved).
 *   VL-U03 promote: refusals before any statement — 'default', empty / padded / non-string logical ids.
 *   VL-U04 promote: return shape — promoted / alreadyFirst / missing, exactly three boolean keys; idempotent answer.
 *   VL-U05 promote: the writer fence runs FIRST with the flag on; a durable block refuses before the lock or the UPDATE.
 *   VL-U06 describe: counts over a fixture (frozen prefix incl. hidden / property-hidden fields and a non-prefix frozen
 *          id, leftInsertCount 0 vs 2, personal overrides, trash), firstView mapping to 'default' / a candidate /
 *          'other' / null, read-only SQL, input refusals.
 *   VL-U06b describe reads hidden ids like every host view read (normalizeJsonArray): a leading / trailing / both-side
 *          padded id and a finite number id hide the field (the next column is the frozen prefix); the exact-id control.
 *   VL-U06c describe skips the view types the web never renders as a grid (form, kanban, gallery, calendar, timeline,
 *          gantt, hierarchy); grid, a missing type and unknown types are counted; viewCount / firstView count all.
 *   VL-U07 describe: VALUES-FREE — the key set is exactly the six, no view name / physical id / field id in the output.
 *   VL-U08 the server frozen-prefix mirror answers like the web util on the web unit's own cases, and end to end: the
 *          web rule over the hidden ids as the route ships them (normalizeJsonArray, then exact-id hiding) agrees with
 *          describe on padded, numeric and JSON-string hidden ids.
 *   VL-U09 plugin scope: exposed iff the host has them; project namespace and the overview object refused before the
 *          hook or the host; object scope asserted; values read once and the checked values forwarded.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __resetRecoveryWriterStateColumnProbe,
  canonicalSheetFenceKey,
  SheetWriterBlockedError,
} from '../../src/multitable/canonical-sheet-fence'
import { normalizeJsonArray } from '../../src/multitable/field-codecs'
import { countFrozenPrefix, parseFrozenLeftColumnIds } from '../../src/multitable/frozen-prefix'
import {
  createPluginScopedMultitableApi,
  MultitableProjectNamespaceError,
} from '../../src/multitable/plugin-scope'
import { getObjectSheetId, getObjectViewId, type MultitableProvisioningQueryFn } from '../../src/multitable/provisioning'
import { StockPreparationOverviewStructureWriteError } from '../../src/multitable/stock-preparation-overview-contract'
import {
  DESCRIBE_LAYOUT_FIELDS_SQL,
  DESCRIBE_LAYOUT_PERSONAL_SQL,
  DESCRIBE_LAYOUT_RESULT_KEYS,
  DESCRIBE_LAYOUT_TRASH_SQL,
  DESCRIBE_LAYOUT_VIEWS_SQL,
  MultitableViewLandingInputError,
  PROMOTE_VIEW_EXISTS_SQL,
  PROMOTE_VIEW_LOCK_SQL,
  PROMOTE_VIEW_UPDATE_SQL,
  VIEW_LANDING_INPUT_INVALID_CODE,
  describeObjectSheetLayout,
  promoteObjectViewToFirst,
} from '../../src/multitable/view-landing'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FENCE_ENV = 'MULTITABLE_ENABLE_WRITER_FENCE'
const PROJECT = 'tenant_vl:integration-core'
const OBJECT = 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567'
const SHEET = getObjectSheetId(PROJECT, OBJECT)
const FILL = getObjectViewId(PROJECT, OBJECT, 'prep-fill')
const DEFAULT = getObjectViewId(PROJECT, OBJECT, 'default')
const OVERVIEW_OBJECT = 'plm_stock_preparation_project_overview'
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()

type Seen = { sql: string; params: unknown[] }

function promoteQuery(opts: { updated: number; exists: boolean; blocked?: boolean }) {
  const seen: Seen[] = []
  const query: MultitableProvisioningQueryFn = async (sql, params = []) => {
    seen.push({ sql: norm(sql), params })
    if (sql.includes('information_schema.columns')) return { rows: [{}] }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (norm(sql) === 'SELECT recovery_writer_state FROM meta_sheets WHERE id = $1') {
      return { rows: [{ recovery_writer_state: opts.blocked ? 'archiving' : null }] }
    }
    if (sql === PROMOTE_VIEW_LOCK_SQL) return { rows: [{ id: FILL }], rowCount: 1 }
    if (sql === PROMOTE_VIEW_UPDATE_SQL) {
      return { rows: opts.updated ? [{ id: FILL }] : [], rowCount: opts.updated }
    }
    if (sql === PROMOTE_VIEW_EXISTS_SQL) return { rows: opts.exists ? [{ id: FILL }] : [] }
    throw new Error(`unexpected SQL in the promote fake: ${norm(sql)}`)
  }
  return { query, seen }
}

afterEach(() => {
  delete process.env[FENCE_ENV]
  __resetRecoveryWriterStateColumnProbe()
})

describe('promoteObjectViewToFirst (host)', () => {
  it('VL-U01 statement order and SQL shape: lock → the ONE UPDATE of meta_views.created_at → existence read; nothing else written', async () => {
    const { query, seen } = promoteQuery({ updated: 0, exists: true })
    await promoteObjectViewToFirst({ query, projectId: PROJECT, objectId: OBJECT, viewLogicalId: 'prep-fill' })
    expect(seen.map((s) => s.sql)).toEqual([norm(PROMOTE_VIEW_LOCK_SQL), norm(PROMOTE_VIEW_UPDATE_SQL), norm(PROMOTE_VIEW_EXISTS_SQL)])
    expect(seen[0].params).toEqual([SHEET])
    expect(seen[1].params).toEqual([FILL, SHEET])
    expect(seen[2].params).toEqual([FILL, SHEET])

    // The lock is a read with FOR UPDATE, not a write.
    expect(norm(PROMOTE_VIEW_LOCK_SQL)).toMatch(/^SELECT id FROM meta_views WHERE sheet_id = \$1 ORDER BY id FOR UPDATE$/)
    // The UPDATE writes ONE column of ONE table, keyed by (id, sheet_id).
    const update = norm(PROMOTE_VIEW_UPDATE_SQL)
    const writes = seen.filter((s) => /^(WITH .*\)\s*)?(UPDATE|INSERT|DELETE)\b/.test(s.sql) || /\b(INSERT INTO|DELETE FROM)\b/.test(s.sql))
    expect(writes).toHaveLength(1)
    expect(update).toMatch(/UPDATE meta_views AS v SET created_at = COALESCE\(others\.min_created_at - interval '1 microsecond', now\(\)\) FROM others WHERE v\.id = \$1 AND v\.sheet_id = \$2 /)
    let setClause = /\bSET (.+?) FROM others\b/.exec(update)?.[1] ?? ''
    // Drop parenthesised sub-expressions so only top-level `col = expr` assignments remain.
    while (/\([^()]*\)/.test(setClause)) setClause = setClause.replace(/\([^()]*\)/g, '')
    expect(setClause.split(',').map((part) => part.trim().split(/\s*=\s*/)[0])).toEqual(['created_at'])
    expect(update).not.toMatch(/updated_at|INSERT|DELETE/)

    // Source census of the module: one UPDATE, no INSERT, no DELETE (comments stripped).
    const source = readFileSync(path.join(HERE, '../../src/multitable/view-landing.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(source.match(/\bUPDATE meta_\w+/g)).toEqual(['UPDATE meta_views'])
    expect(source).not.toMatch(/\bINSERT INTO\b/)
    expect(source).not.toMatch(/\bDELETE FROM\b/)
  })

  it('VL-U02 the tie rule: compared against the OTHER views with >=, not created_at > min(all views)', () => {
    const update = norm(PROMOTE_VIEW_UPDATE_SQL)
    expect(update).toContain('WHERE o.sheet_id = $2 AND o.id <> $1')
    expect(update).toContain('v.created_at >= others.min_created_at')
    expect(update).toContain('others.other_count > 0')
    // NULL created_at sorts last under ASC: a NULL target is moved, an all-NULL sheet gets now().
    expect(update).toContain('others.min_created_at IS NULL AND v.created_at IS NULL')
    expect(update).toContain('v.created_at IS NULL OR v.created_at >= others.min_created_at')
    expect(update).not.toMatch(/created_at > \(SELECT min\(created_at\)/)
  })

  it('VL-U03 refusals before any statement: the default view, and malformed logical ids', async () => {
    for (const [viewLogicalId, reason] of [
      ['default', 'default_view'],
      ['', 'view_logical_id'],
      ['  ', 'view_logical_id'],
      [' prep-fill', 'view_logical_id'],
      [7, 'view_logical_id'],
      [null, 'view_logical_id'],
      ['x'.repeat(129), 'view_logical_id'],
    ] as const) {
      const { query, seen } = promoteQuery({ updated: 1, exists: true })
      const err = await promoteObjectViewToFirst({ query, projectId: PROJECT, objectId: OBJECT, viewLogicalId: viewLogicalId as never })
        .then(() => null, (e: unknown) => e)
      expect(err, String(viewLogicalId)).toBeInstanceOf(MultitableViewLandingInputError)
      expect((err as MultitableViewLandingInputError).code).toBe(VIEW_LANDING_INPUT_INVALID_CODE)
      expect((err as MultitableViewLandingInputError).reason).toBe(reason)
      expect((err as Error).message).not.toContain(OBJECT)
      expect(seen, `${String(viewLogicalId)}: no statement`).toEqual([])
    }
  })

  it('VL-U04 return shape: promoted, then alreadyFirst on the repeat (idempotent), missing when the view is absent; never a create', async () => {
    const first = promoteQuery({ updated: 1, exists: true })
    const r1 = await promoteObjectViewToFirst({ query: first.query, projectId: PROJECT, objectId: OBJECT, viewLogicalId: 'prep-fill' })
    expect(r1).toEqual({ promoted: true, alreadyFirst: false, missing: false })
    expect(Object.keys(r1).sort()).toEqual(['alreadyFirst', 'missing', 'promoted'])
    // A promoted call needs no existence read.
    expect(first.seen.map((s) => s.sql)).not.toContain(norm(PROMOTE_VIEW_EXISTS_SQL))

    const again = promoteQuery({ updated: 0, exists: true })
    expect(await promoteObjectViewToFirst({ query: again.query, projectId: PROJECT, objectId: OBJECT, viewLogicalId: 'prep-fill' }))
      .toEqual({ promoted: false, alreadyFirst: true, missing: false })

    const absent = promoteQuery({ updated: 0, exists: false })
    expect(await promoteObjectViewToFirst({ query: absent.query, projectId: PROJECT, objectId: OBJECT, viewLogicalId: 'prep-fill' }))
      .toEqual({ promoted: false, alreadyFirst: false, missing: true })
    expect(absent.seen.some((s) => /INSERT/.test(s.sql))).toBe(false)
  })

  it('VL-U05 the writer fence runs FIRST with the flag on, and a durable block refuses before the lock or the UPDATE', async () => {
    process.env[FENCE_ENV] = 'true'
    const open = promoteQuery({ updated: 1, exists: true })
    await promoteObjectViewToFirst({ query: open.query, projectId: PROJECT, objectId: OBJECT, viewLogicalId: 'prep-fill' })
    expect(open.seen[0].sql).toContain('pg_advisory_xact_lock')
    expect(open.seen[0].params).toEqual([canonicalSheetFenceKey(SHEET)])
    const lockAt = open.seen.findIndex((s) => s.sql === norm(PROMOTE_VIEW_LOCK_SQL))
    const blockCheckAt = open.seen.findIndex((s) => s.sql.startsWith('SELECT recovery_writer_state'))
    expect(blockCheckAt).toBeGreaterThan(0)
    expect(lockAt).toBeGreaterThan(blockCheckAt)

    __resetRecoveryWriterStateColumnProbe()
    const blocked = promoteQuery({ updated: 1, exists: true, blocked: true })
    await expect(promoteObjectViewToFirst({ query: blocked.query, projectId: PROJECT, objectId: OBJECT, viewLogicalId: 'prep-fill' }))
      .rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(blocked.seen.map((s) => s.sql)).not.toContain(norm(PROMOTE_VIEW_LOCK_SQL))
    expect(blocked.seen.map((s) => s.sql)).not.toContain(norm(PROMOTE_VIEW_UPDATE_SQL))
  })
})

// A fixture sheet: six fields in shared order f1..f6 (f3 property-hidden), five views.
const FIELDS = [
  { id: 'fld_secret_1', property: {} },
  { id: 'fld_secret_2', property: {} },
  { id: 'fld_secret_3', property: { hidden: true } },
  { id: 'fld_secret_4', property: { visible: false } },
  { id: 'fld_secret_5', property: {} },
  { id: 'fld_secret_6', property: {} },
]
const OTHER_VIEW = 'view_person_made_secret'
const VIEWS = [
  // first by created_at: the host default view — frozen f1,f2 → prefix 2.
  { id: DEFAULT, name: '全部记录', hidden_field_ids: [], config: { frozenLeftColumnIds: ['fld_secret_1', 'fld_secret_2'] } },
  // frozen f5 only, but f1 is visible first → prefix 0 (non-prefix frozen ids are ignored).
  { id: FILL, name: '备料填写视图', hidden_field_ids: [], config: { frozenLeftColumnIds: ['fld_secret_5'] } },
  // f1, f2 hidden by the view; f3, f4 property-hidden → the first visible is f5, frozen → prefix 1 (as a JSON string).
  { id: OTHER_VIEW, name: 'Someone’s view', hidden_field_ids: JSON.stringify(['fld_secret_1', 'fld_secret_2']), config: JSON.stringify({ frozenLeftColumnIds: ['fld_secret_5'] }) },
  // dirty frozen config (a non-string element) → [] → no frozen.
  { id: 'view_dirty_secret', name: 'Dirty', hidden_field_ids: [], config: { frozenLeftColumnIds: ['fld_secret_1', 2] } },
  // no config at all.
  { id: 'view_plain_secret', name: 'Plain', hidden_field_ids: null, config: null },
]

function describeQuery(views: unknown[] = VIEWS, counts = { personal: 3, trash: 4 }, fields: unknown[] = FIELDS) {
  const seen: Seen[] = []
  const query: MultitableProvisioningQueryFn = async (sql, params = []) => {
    seen.push({ sql: norm(sql), params })
    if (sql === DESCRIBE_LAYOUT_VIEWS_SQL) return { rows: views }
    if (sql === DESCRIBE_LAYOUT_FIELDS_SQL) return { rows: fields }
    if (sql === DESCRIBE_LAYOUT_PERSONAL_SQL) return { rows: [{ n: counts.personal }] }
    if (sql === DESCRIBE_LAYOUT_TRASH_SQL) return { rows: [{ n: counts.trash }] }
    throw new Error(`unexpected SQL in the describe fake: ${norm(sql)}`)
  }
  return { query, seen }
}

describe('describeObjectSheetLayout (host)', () => {
  it('VL-U06 counts, firstView mapping, read-only SQL and refusals', async () => {
    const { query, seen } = describeQuery()
    const got = await describeObjectSheetLayout({ query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: ['prep-fill', 'prep-todo'], leftInsertCount: 2 })
    expect(got).toEqual({
      viewCount: 5,
      firstView: 'default',
      viewsWithFrozenColumns: 2,
      viewsLosingFrozen: 2,
      personalOrderOverrides: 3,
      trashedRecordCount: 4,
    })
    expect(seen.every((s) => s.sql.startsWith('SELECT') && !/FOR UPDATE/.test(s.sql))).toBe(true)
    expect(seen.every((s) => JSON.stringify(s.params) === JSON.stringify([SHEET]))).toBe(true)
    // The view list is ordered EXACTLY like the context route / GET /views (no tie-break).
    expect(norm(DESCRIBE_LAYOUT_VIEWS_SQL)).toMatch(/ORDER BY created_at ASC$/)
    expect(norm(DESCRIBE_LAYOUT_FIELDS_SQL)).toMatch(/ORDER BY "order" ASC, id ASC$/)
    expect(norm(DESCRIBE_LAYOUT_PERSONAL_SQL)).toContain("jsonb_typeof(p.config -> 'fieldOrder') = 'array'")
    expect(norm(DESCRIBE_LAYOUT_TRASH_SQL)).toBe('SELECT count(*)::int AS n FROM meta_records_trash WHERE sheet_id = $1')

    // leftInsertCount 0: nothing would be inserted, nothing loses its frozen prefix.
    const none = await describeObjectSheetLayout({ query: describeQuery().query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: [], leftInsertCount: 0 })
    expect(none.viewsWithFrozenColumns).toBe(2)
    expect(none.viewsLosingFrozen).toBe(0)

    // firstView: a candidate, 'other', null.
    const fillFirst = [VIEWS[1], VIEWS[0]]
    expect((await describeObjectSheetLayout({ query: describeQuery(fillFirst).query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: ['prep-fill'], leftInsertCount: 0 })).firstView).toBe('prep-fill')
    // Not a candidate → 'other', never the logical id the caller did not name.
    expect((await describeObjectSheetLayout({ query: describeQuery(fillFirst).query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: ['prep-todo'], leftInsertCount: 0 })).firstView).toBe('other')
    expect((await describeObjectSheetLayout({ query: describeQuery([VIEWS[2]]).query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: ['prep-fill'], leftInsertCount: 0 })).firstView).toBe('other')
    expect(await describeObjectSheetLayout({ query: describeQuery([], { personal: 0, trash: 0 }).query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: [], leftInsertCount: 2 }))
      .toEqual({ viewCount: 0, firstView: null, viewsWithFrozenColumns: 0, viewsLosingFrozen: 0, personalOrderOverrides: 0, trashedRecordCount: 0 })

    for (const [input, reason] of [
      [{ candidateViewLogicalIds: 'prep-fill', leftInsertCount: 0 }, 'candidates'],
      [{ candidateViewLogicalIds: [''], leftInsertCount: 0 }, 'candidates'],
      [{ candidateViewLogicalIds: [3], leftInsertCount: 0 }, 'candidates'],
      [{ candidateViewLogicalIds: Array.from({ length: 33 }, (_u, i) => `v${i}`), leftInsertCount: 0 }, 'candidates'],
      [{ candidateViewLogicalIds: [], leftInsertCount: -1 }, 'left_insert_count'],
      [{ candidateViewLogicalIds: [], leftInsertCount: 1.5 }, 'left_insert_count'],
      [{ candidateViewLogicalIds: [], leftInsertCount: 65 }, 'left_insert_count'],
      [{ candidateViewLogicalIds: [], leftInsertCount: '2' }, 'left_insert_count'],
    ] as const) {
      const probe = describeQuery()
      const err = await describeObjectSheetLayout({ query: probe.query, projectId: PROJECT, objectId: OBJECT, ...(input as never) }).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(MultitableViewLandingInputError)
      expect((err as MultitableViewLandingInputError).reason).toBe(reason)
      expect(probe.seen).toEqual([])
    }
  })

  it('VL-U06b hidden ids are read like every host view read (normalizeJsonArray: trimmed, finite numbers stringified)', async () => {
    // The shared order: a numeric-looking field id first, then fld_n1..fld_n3. Every view freezes the column that is the
    // first visible one ONLY when its hidden ids are normalised the way GET /view ships them to the grid.
    const fields = [{ id: '7', property: {} }, { id: 'fld_n1', property: {} }, { id: 'fld_n2', property: {} }, { id: 'fld_n3', property: {} }]
    const cases: Array<[string, unknown, string]> = [
      ['a finite number id', [7], 'fld_n1'],
      ['a leading-space id', ['7', ' fld_n1'], 'fld_n2'],
      ['a trailing-space id (as a JSON string)', JSON.stringify(['7', 'fld_n1 ']), 'fld_n2'],
      ['a padded id on both sides', ['  7  '], 'fld_n1'],
      ['the exact-id control', ['7', 'fld_n1'], 'fld_n2'],
    ]
    for (const [label, hidden, frozen] of cases) {
      const views = [{ id: DEFAULT, name: 'v', type: 'grid', hidden_field_ids: hidden, config: { frozenLeftColumnIds: [frozen] } }]
      const got = await describeObjectSheetLayout({ query: describeQuery(views, { personal: 0, trash: 0 }, fields).query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: [], leftInsertCount: 2 })
      expect.soft({ with: got.viewsWithFrozenColumns, losing: got.viewsLosingFrozen }, label).toEqual({ with: 1, losing: 1 })
    }
    // Non-finite numbers and non-string, non-number elements hide nothing (normalizeJsonArray drops them).
    const dropped = [{ id: DEFAULT, name: 'v', type: 'grid', hidden_field_ids: [Number.NaN, null, { id: '7' }, ''], config: { frozenLeftColumnIds: ['7'] } }]
    expect((await describeObjectSheetLayout({ query: describeQuery(dropped, { personal: 0, trash: 0 }, fields).query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: [], leftInsertCount: 0 })).viewsWithFrozenColumns).toBe(1)
  })

  it('VL-U06c views the web never renders as a grid are not counted; grid, a missing type and unknown types are', async () => {
    // MultitableWorkbench.vue renders MetaGridTable (the only place frozenLeftColumnIds applies) in the v-else after the
    // form / kanban / gallery / calendar / timeline / gantt / hierarchy branches.
    const frozenFirst = { frozenLeftColumnIds: ['fld_secret_1'] }
    for (const type of ['form', 'kanban', 'gallery', 'calendar', 'timeline', 'gantt', 'hierarchy']) {
      const views = [{ id: DEFAULT, name: 'v', type, hidden_field_ids: [], config: frozenFirst }]
      const got = await describeObjectSheetLayout({ query: describeQuery(views).query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: [], leftInsertCount: 2 })
      expect.soft({ type, with: got.viewsWithFrozenColumns, losing: got.viewsLosingFrozen }).toEqual({ type, with: 0, losing: 0 })
      // viewCount and firstView still count every view, whatever its type.
      expect(got.viewCount).toBe(1)
      expect(got.firstView).toBe('default')
    }
    for (const type of ['grid', undefined, null, 'some-future-type', 'Kanban']) {
      const views = [{ id: DEFAULT, name: 'v', type, hidden_field_ids: [], config: frozenFirst }]
      const got = await describeObjectSheetLayout({ query: describeQuery(views).query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: [], leftInsertCount: 2 })
      expect.soft({ type, with: got.viewsWithFrozenColumns, losing: got.viewsLosingFrozen }).toEqual({ type, with: 1, losing: 1 })
    }
    expect(norm(DESCRIBE_LAYOUT_VIEWS_SQL)).toBe('SELECT id, type, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC')
  })

  it('VL-U07 values-free: exactly the six keys; no view name, physical view id or field id anywhere in the answer', async () => {
    const got = await describeObjectSheetLayout({ query: describeQuery().query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: ['prep-fill'], leftInsertCount: 2 })
    expect(Object.keys(got).sort()).toEqual([...DESCRIBE_LAYOUT_RESULT_KEYS])
    const text = JSON.stringify(got)
    for (const view of VIEWS) {
      expect(text).not.toContain(view.id)
      expect(text).not.toContain(view.name)
    }
    for (const field of FIELDS) expect(text).not.toContain(field.id)
    expect(text).not.toContain('secret')
    for (const [key, value] of Object.entries(got)) {
      if (key === 'firstView') expect(['default', 'prep-fill', 'other', null]).toContain(value)
      else expect(Number.isInteger(value), key).toBe(true)
    }
  })

  it('VL-U08 the frozen-prefix mirror answers like the web util on the web unit cases', async () => {
    const web = await import('../../../../apps/web/src/multitable/utils/frozen-columns')
    const configs: Array<Record<string, unknown> | null | undefined> = [
      { frozenLeftColumnIds: ['a', 'b'] }, {}, { other: 1 }, { frozenLeftColumnIds: 'a' }, { frozenLeftColumnIds: 3 },
      { frozenLeftColumnIds: { 0: 'a' } }, { frozenLeftColumnIds: ['a', 2] }, { frozenLeftColumnIds: [null] },
      { frozenLeftColumnIds: ['a', { x: 1 }] }, null, undefined, { frozenLeftColumnIds: [] },
    ]
    for (const config of configs) expect(parseFrozenLeftColumnIds(config)).toEqual(web.parseFrozenIds(config))
    const order = ['f1', 'f2', 'f3', 'f4']
    for (const frozen of [['f1', 'f2'], ['f1'], [], ['f3'], ['f1', 'f3'], ['f1', 'f2', 'f3', 'f4', 'gone']]) {
      expect(countFrozenPrefix(order, frozen)).toBe(web.frozenPrefixCount(order, frozen))
    }
    // End to end against the web rule: the grid hides by EXACT id over the hidden ids GET /view ships, which the host
    // reads with normalizeJsonArray (multitable/loaders.ts tryResolveView). describe must see the same visible order.
    const fields = ['7', 'f1', 'f2', 'f3'].map((id) => ({ id, property: {} }))
    for (const stored of [[' f1'], ['f1 '], [7], ['7', ' f1 '], JSON.stringify([' 7', 'f1']), ['f1'], [], ['nope']]) {
      for (const frozen of [['f1'], ['f2'], ['7'], ['f1', 'f2']]) {
        const shipped = new Set(normalizeJsonArray(stored))
        const webPrefix = web.frozenPrefixCount(fields.map((f) => f.id).filter((id) => !shipped.has(id)), web.parseFrozenIds({ frozenLeftColumnIds: frozen }))
        const views = [{ id: DEFAULT, name: 'v', type: 'grid', hidden_field_ids: stored, config: { frozenLeftColumnIds: frozen } }]
        const got = await describeObjectSheetLayout({ query: describeQuery(views, { personal: 0, trash: 0 }, fields).query, projectId: PROJECT, objectId: OBJECT, candidateViewLogicalIds: [], leftInsertCount: 0 })
        expect.soft(got.viewsWithFrozenColumns, JSON.stringify({ stored, frozen })).toBe(webPrefix > 0 ? 1 : 0)
      }
    }
  })
})

describe('plugin-scope wrappers', () => {
  const build = (hostHas = true) => {
    const host = {
      getObjectSheetId,
      ...(hostHas
        ? {
            promoteObjectViewToFirst: vi.fn(async () => ({ promoted: true, alreadyFirst: false, missing: false })),
            describeObjectSheetLayout: vi.fn(async () => ({ viewCount: 0, firstView: null, viewsWithFrozenColumns: 0, viewsLosingFrozen: 0, personalOrderOverrides: 0, trashedRecordCount: 0 })),
          }
        : {}),
    }
    const hooks = { assertObjectScope: vi.fn(async () => {}) }
    const api = createPluginScopedMultitableApi({ provisioning: host, records: {} } as never, 'plugin-integration-core', hooks as never)
    return { api, host: host as Required<typeof host>, hooks }
  }

  it('VL-U09a exposed iff the host exposes them', () => {
    expect(typeof build(true).api.provisioning.promoteObjectViewToFirst).toBe('function')
    expect(typeof build(true).api.provisioning.describeObjectSheetLayout).toBe('function')
    expect(build(false).api.provisioning.promoteObjectViewToFirst).toBeUndefined()
    expect(build(false).api.provisioning.describeObjectSheetLayout).toBeUndefined()
  })

  it('VL-U09b namespace and overview refusals come before the scope hook and the host; the checked values are forwarded', async () => {
    const calls = [
      ['promote', (s: ReturnType<typeof build>, i: Record<string, unknown>) => s.api.provisioning.promoteObjectViewToFirst!(i as never), (s: ReturnType<typeof build>) => s.host.promoteObjectViewToFirst, { viewLogicalId: 'prep-fill' }],
      ['describe', (s: ReturnType<typeof build>, i: Record<string, unknown>) => s.api.provisioning.describeObjectSheetLayout!(i as never), (s: ReturnType<typeof build>) => s.host.describeObjectSheetLayout, { candidateViewLogicalIds: ['prep-fill'], leftInsertCount: 2 }],
    ] as const
    for (const [name, run, hostFn, extra] of calls) {
      const foreign = build()
      await expect(run(foreign, { projectId: 'tenant_vl:after-sales', objectId: OBJECT, ...extra }), name).rejects.toBeInstanceOf(MultitableProjectNamespaceError)
      expect(foreign.hooks.assertObjectScope).not.toHaveBeenCalled()
      expect(hostFn(foreign)).not.toHaveBeenCalled()

      const overview = build()
      await expect(run(overview, { projectId: PROJECT, objectId: OVERVIEW_OBJECT, ...extra }), name).rejects.toBeInstanceOf(StockPreparationOverviewStructureWriteError)
      expect(overview.hooks.assertObjectScope).not.toHaveBeenCalled()
      expect(hostFn(overview)).not.toHaveBeenCalled()

      const scopeRefused = build()
      scopeRefused.hooks.assertObjectScope.mockRejectedValueOnce(new Error('scope refused'))
      await expect(run(scopeRefused, { projectId: PROJECT, objectId: OBJECT, ...extra }), name).rejects.toThrow('scope refused')
      expect(hostFn(scopeRefused)).not.toHaveBeenCalled()

      // Read once: a getter answering the plugin's own object first and a foreign one afterwards.
      const s = build()
      let reads = 0
      const input: Record<string, unknown> = { projectId: PROJECT, ...extra }
      Object.defineProperty(input, 'objectId', { enumerable: true, get() { reads += 1; return reads === 1 ? OBJECT : 'someone_elses_object' } })
      await run(s, input)
      expect(reads, name).toBe(1)
      expect(s.hooks.assertObjectScope).toHaveBeenCalledWith({ pluginName: 'plugin-integration-core', projectId: PROJECT, objectId: OBJECT })
      expect(hostFn(s)).toHaveBeenCalledWith({ projectId: PROJECT, objectId: OBJECT, ...extra })
    }
  })
})

/**
 * Copy-sheet S1 service (ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md §4/§7/§8) executed END TO
 * END on the table-aware fake Postgres (tests/utils/copy-sheet-fake-pg.ts). Every case below runs the REAL
 * `executeCopySheet` / `planCopySheet` — the real remap layer, the real `RecordService.createRecord` copy extension on
 * the real transaction-bound facade, the real dedupe module, the real deny-set loaders — against fake tables.
 *
 * What is proven (each guarantee has a MUTATION twin in the PR body: break the guard → the named case reds):
 *   E1  happy path: provenance row, fields (button → record_click, hidden stays hidden, formula remapped), views
 *       (filter leaf on the attachment dropped, publicForm gone), records in SOURCE ORDER with ordinal created_at,
 *       created_by preserved / modified_by = copier, blanked attachment + hidden values ABSENT, select out-of-set kept,
 *       auto-number renumbered 1..N, ONE revision batch with source 'copy-sheet', config revisions per field / view /
 *       permission sharing that batch, all four permission tables copied with id remap incl. every 'none' row,
 *       two audit rows, ledger row `intent_kind='copy-sheet'`, ZERO legacy bus emits and ZERO outbox rows.
 *   E2  replay: the same intent again within the window → `replayed`, no second sheet, body identical.
 *   E3  all-or-nothing: a source row whose link points at a missing foreign record → 422
 *       COPY_ROW_VALIDATION_FAILED { rowIndex, fieldId, code } and EVERY table is back to its pre-copy state
 *       (sheet, fields, views, records, links, permissions, revisions, audit, ledger).
 *   E4  deny-set parity re-reads the SOURCE: a 'none' row that appears on the source AFTER the copy read it (a
 *       concurrent PUT) → 500 COPY_PERMISSION_PARITY_FAILED, rolled back.
 *   E5  tripwire: a source record touched between baseline and re-read → 409 COPY_SOURCE_CHANGED, rolled back.
 *   E6  DB-fresh source gate INSIDE the transaction: the gate answering false → 403 COPY_SOURCE_NOT_FULLY_READABLE,
 *       nothing written; the error carries no count.
 *   E7  rules: a deny rule on an auto-number column whose values would change → 422
 *       COPY_SOURCE_RULE_ON_RENUMBERED_FIELD; the same rule when no row renumbers → copied and remapped.
 *   E8  managed source: new sheet `copied_from_kind='plugin-managed'`, NO registry row for it, and the plugin-scope
 *       deny refuses the copy to another plugin.
 *   E9  row cap: MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS=3 → 413 COPY_TOO_LARGE { rowCount, limit }, nothing written.
 *   E10 dry-run plan writes nothing (no INSERT / UPDATE / DELETE after the plan started).
 *   E11 property-hidden values copy when the copier holds canManageFields on the source.
 *   E12 write-own posture: source created_by survives per row (the write-own row policy keys on it).
 *   E13 lock order (TX-2): every canonical fence BEFORE the source row FOR UPDATE; baseline BEFORE any record read;
 *       row COUNT after the gates; fence set = {source, new, link foreign}; dedupe lock still statement #1.
 *   E14 view.config frozenLeftColumnIds / columnWidths / aggregations remapped, unknown ids dropped (FE-1).
 *   E15 '' is KEPT (only null/absent omitted) so a rule on that column denies identically on both sides (DATA-5).
 *   E16 relation-aggregation formulas: quoted link/target/criteria ids remapped; formula_dependencies → new link (DATA-1).
 *   E17 a copy of a plugin-managed snapshot stays 'plugin-managed'; the plugin-scope deny holds on the grandchild (SEC-1).
 *   E18 intent lock not acquired within the bounded wait → 409 CONFLICT, no ledger read, no install (TX-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakePg } from '../utils/copy-sheet-fake-pg'
import {
  COPY_SHEET_ERROR_CODES,
  CopySheetError,
  buildCopySheetIntentKey,
  executeCopySheet,
  planCopySheet,
  type CopySheetActor,
  type CopySheetDeps,
  type CopySheetRequest,
  type CopySheetResult,
} from '../../src/multitable/copy-sheet-service'
import { assertSheetNotCopiedFromPluginManaged } from '../../src/multitable/copied-sheet-plugin-scope'
import { MultitableSheetScopeError } from '../../src/multitable/plugin-scope'
import {
  FIELD_PERMISSION_HISTORY_KEYS,
  SHEET_PERMISSION_HISTORY_KEYS,
  VIEW_CONFIG_HISTORY_KEYS,
  VIEW_PERMISSION_HISTORY_KEYS,
  extractRelationAggregationLinkFieldId,
  fieldPermissionSnapshot,
  permissionConfigEntityId,
  sheetPermissionSnapshot,
  viewConfigSnapshot,
  viewPermissionSnapshot,
} from '../../src/routes/univer-meta'
import { deriveSheetAccessLevel } from '../../src/multitable/permission-service'
import { COPY_SHEET_INTENT_KIND, buildIntentScopeDigest } from '../../src/multitable/template-install-dedupe'

vi.mock('../../src/multitable/realtime-publish', () => ({
  publishMultitableSheetRealtime: vi.fn(),
}))

const BASE = 'base_cs'
const SRC = 'sheet_cs_src'
const FOREIGN = 'sheet_cs_foreign'
const ADMIN = 'u_cs_admin'
const READER = 'u_cs_reader'
const DENIED = 'u_cs_denied'
const WRITE_OWN = 'u_cs_writeown'
const GROUP = 'grp_cs_a'
const ROLE = 'role_cs_x'

const F = {
  title: 'fld_cs_title',
  status: 'fld_cs_status',
  num: 'fld_cs_num',
  link: 'fld_cs_link',
  auto: 'fld_cs_auto',
  formula: 'fld_cs_formula',
  att: 'fld_cs_att',
  btn: 'fld_cs_btn',
  hidden: 'fld_cs_hidden',
}

function seedFixture(pg: FakePg, opts: { autoStart?: number; rules?: unknown[]; managed?: boolean; brokenLink?: boolean; relationAggregation?: boolean; viewPrefs?: boolean } = {}) {
  pg.seedBase(BASE, ADMIN)
  pg.seedSheet({ id: FOREIGN, baseId: BASE, name: 'Foreign' })
  pg.seedField({ id: 'fld_cs_fname', sheetId: FOREIGN, type: 'string' })
  pg.seedRecord({ id: 'rec_f1', sheetId: FOREIGN, data: { fld_cs_fname: 'F1' } })
  pg.seedRecord({ id: 'rec_f2', sheetId: FOREIGN, data: { fld_cs_fname: 'F2' } })

  pg.seedSheet({ id: SRC, baseId: BASE, name: '备料主表', rowLevel: true, rules: opts.rules ?? [{ id: 'rule_num', fieldId: F.num, operator: 'gt', value: 100, effect: 'deny_read' }] })
  pg.seedField({ id: F.title, sheetId: SRC, type: 'string', property: { validation: [{ type: 'required' }] }, order: 0 })
  pg.seedField({ id: F.status, sheetId: SRC, type: 'select', property: { options: [{ value: 'open' }, { value: 'done' }] }, order: 1 })
  pg.seedField({ id: F.num, sheetId: SRC, type: 'number', order: 2 })
  pg.seedField({ id: F.link, sheetId: SRC, type: 'link', property: { foreignSheetId: FOREIGN, limitSingleRecord: false }, order: 3 })
  pg.seedField({ id: F.auto, sheetId: SRC, type: 'autoNumber', property: { start: 1 }, order: 4 })
  pg.seedField({ id: F.formula, sheetId: SRC, type: 'formula', property: { expression: `={${F.num}} * 2` }, order: 5 })
  pg.seedField({ id: F.att, sheetId: SRC, type: 'attachment', order: 6 })
  pg.seedField({ id: F.btn, sheetId: SRC, type: 'button', property: { label: 'Ship', actionType: 'send_webhook', actionConfig: { url: 'https://hook.invalid/x', secret: 'hmac-secret' } }, order: 7 })
  pg.seedField({ id: F.hidden, sheetId: SRC, type: 'string', property: { hidden: true }, order: 8 })

  pg.seedView({ id: 'view_cs_1', sheetId: SRC, name: '默认视图', filterInfo: { conjunction: 'and', conditions: [{ fieldId: F.title, operator: 'contains', value: 'a' }, { fieldId: F.att, operator: 'is_not_empty' }] }, config: { publicForm: { enabled: true, publicToken: 'tok_cs_secret' }, kanban: { groupFieldId: F.status } } })
  pg.seedView({ id: 'view_cs_2', sheetId: SRC, name: '第二视图', hiddenFieldIds: [F.hidden] })
  if (opts.relationAggregation) {
    // a self-link (blanked in S1) + two relation-aggregation formulas: one over the FOREIGN link, one over the self-link
    pg.seedField({ id: 'fld_cs_self', sheetId: SRC, type: 'link', property: { foreignSheetId: SRC, limitSingleRecord: false }, order: 9 })
    pg.seedField({ id: 'fld_cs_relsum', sheetId: SRC, type: 'formula', property: { expression: `=RELSUMIF("${F.link}", "fld_cs_fname", "fld_cs_fname", "=", "F1")` }, order: 10 })
    pg.seedField({ id: 'fld_cs_relcount', sheetId: SRC, type: 'formula', property: { expression: `=RELCOUNTIF("fld_cs_self", "${F.title}", "=", {${F.title}})` }, order: 11 })
  }
  if (opts.viewPrefs) {
    // the three Web-written view.config keys whose field ids are NOT under a `*fieldId(s)` key (FE-1): a frozen prefix,
    // per-column widths and per-column aggregations; the attachment column is blanked-but-built, so it stays.
    pg.seedView({ id: 'view_cs_3', sheetId: SRC, name: '冻结视图', config: {
      frozenLeftColumnIds: [F.title, F.status, 'fld_cs_unknown'],
      columnWidths: { [F.title]: 240, [F.num]: 90, fld_cs_unknown: 50 },
      aggregations: { [F.num]: 'sum', [F.att]: 'count', fld_cs_unknown: 'sum' },
      rowDensity: 'compact',
    } })
  }

  const autoStart = opts.autoStart ?? 1
  const base = Date.parse('2026-09-01T00:00:00.000Z')
  const rows = [
    { id: 'rec_cs_1', data: { [F.title]: 'A', [F.status]: 'open', [F.num]: 1, [F.auto]: autoStart, [F.att]: ['att_1'], [F.hidden]: 'h1' }, by: WRITE_OWN },
    { id: 'rec_cs_2', data: { [F.title]: 'B', [F.status]: 'archived', [F.num]: null, [F.auto]: autoStart + 1, [F.hidden]: 'h2' }, by: READER },
    { id: 'rec_cs_3', data: { [F.title]: 'C', [F.status]: '', [F.num]: 3, [F.auto]: autoStart + 2 }, by: WRITE_OWN },
    { id: 'rec_cs_4', data: { [F.title]: 'D', [F.num]: 4, [F.auto]: autoStart + 3 }, by: null },
    { id: 'rec_cs_5', data: { [F.title]: 'E', [F.num]: 200, [F.auto]: autoStart + 4 }, by: ADMIN },
  ]
  // seeded in REVERSE insertion order with ASCENDING created_at, so "source order" is created_at order, not array order
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]!
    pg.seedRecord({ id: r.id, sheetId: SRC, data: r.data, createdBy: r.by, createdAtMs: base + i * 60_000 })
  }
  pg.seedLink(F.link, 'rec_cs_1', 'rec_f1')
  pg.seedLink(F.link, 'rec_cs_2', 'rec_f2')
  pg.seedLink(F.link, 'rec_cs_2', 'rec_f1')
  if (opts.brokenLink) pg.seedLink(F.link, 'rec_cs_4', 'rec_missing')

  pg.rows('spreadsheet_permissions').push(
    { sheet_id: SRC, user_id: READER, subject_type: 'user', subject_id: READER, perm_code: 'spreadsheet:read' },
    { sheet_id: SRC, user_id: WRITE_OWN, subject_type: 'user', subject_id: WRITE_OWN, perm_code: 'spreadsheet:write-own' },
    { sheet_id: SRC, user_id: null, subject_type: 'role', subject_id: ROLE, perm_code: 'spreadsheet:write' },
    { sheet_id: SRC, user_id: null, subject_type: 'member-group', subject_id: GROUP, perm_code: 'spreadsheet:read' },
  )
  pg.rows('field_permissions').push(
    { sheet_id: SRC, field_id: F.hidden, subject_type: 'user', subject_id: READER, visible: false, read_only: true, created_by: 'pack:x' },
    { sheet_id: SRC, field_id: F.num, subject_type: 'role', subject_id: ROLE, visible: true, read_only: true, created_by: null },
  )
  pg.rows('meta_view_permissions').push({ view_id: 'view_cs_2', subject_type: 'user', subject_id: READER, permission: 'read' })
  pg.rows('record_permissions').push(
    { sheet_id: SRC, record_id: 'rec_cs_2', subject_type: 'user', subject_id: DENIED, access_level: 'none', created_by: ADMIN },
    { sheet_id: SRC, record_id: 'rec_cs_3', subject_type: 'user', subject_id: DENIED, access_level: 'none', created_by: ADMIN },
    { sheet_id: SRC, record_id: 'rec_cs_4', subject_type: 'member-group', subject_id: GROUP, access_level: 'none', created_by: ADMIN },
    { sheet_id: SRC, record_id: 'rec_cs_1', subject_type: 'user', subject_id: READER, access_level: 'write', created_by: ADMIN },
  )
  pg.groupMembers.set(DENIED, new Set([GROUP]))
  if (opts.managed) pg.rows('plugin_multitable_object_registry').push({ sheet_id: SRC, plugin_name: 'plugin-integration-core' })
}

const actor: CopySheetActor = {
  access: { userId: ADMIN, permissions: ['multitable:read', 'multitable:write'], isAdminRole: true },
  actorId: ADMIN,
  tenantId: null,
}

const request: CopySheetRequest = { sourceSheetId: SRC, name: null, withData: true, permissionMode: 'inherit' }

// Module-level so ids stay unique across deps() instances (the product mints randomUUID; a per-factory counter
// would make a SECOND copy in one test collide with the first on `sheet_new_1`).
let mintSeq = 0

function deps(overrides: Partial<CopySheetDeps> = {}): CopySheetDeps & { emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn()
  return {
    emit,
    eventBus: { emit } as never,
    hasFullTableReadAccess: vi.fn(async () => true),
    history: {
      permissionConfigEntityId, sheetPermissionSnapshot, fieldPermissionSnapshot, viewPermissionSnapshot, viewConfigSnapshot,
      sheetPermissionHistoryKeys: SHEET_PERMISSION_HISTORY_KEYS, fieldPermissionHistoryKeys: FIELD_PERMISSION_HISTORY_KEYS,
      viewPermissionHistoryKeys: VIEW_PERMISSION_HISTORY_KEYS, viewConfigHistoryKeys: VIEW_CONFIG_HISTORY_KEYS,
      deriveSheetAccessLevel: (codes) => deriveSheetAccessLevel(codes) ?? null,
    },
    mintId: (prefix) => `${prefix}_new_${++mintSeq}`,
    now: () => new Date('2026-09-27T10:00:00.000Z'),
    ...overrides,
  }
}

const buildBody = (result: CopySheetResult) => ({ ok: true, data: { sheet: { id: result.sheetId, name: result.name }, summary: result.summary, batchId: result.batchId } })

async function run(pg: FakePg, d = deps(), req = request, copierCanManageSourceFields = false, dedupe: { lockWaitMs?: number; lockPollMs?: number } = {}) {
  return executeCopySheet({
    pool: { transaction: (h) => pg.transaction(h) },
    request: req,
    actor,
    deps: d,
    targetBaseId: BASE,
    copierCanManageSourceFields,
    buildBody,
    dedupe: { sleep: async () => {}, ...dedupe },
  })
}

function snapshotCounts(pg: FakePg): Record<string, number> {
  return Object.fromEntries(Object.entries(pg.tables).map(([k, v]) => [k, v.length]))
}

async function expectRefusal(promise: Promise<unknown>, status: number, code: string): Promise<CopySheetError> {
  const err = await promise.then(() => null, (e) => e)
  expect(err).toBeInstanceOf(CopySheetError)
  expect((err as CopySheetError).statusCode).toBe(status)
  expect((err as CopySheetError).code).toBe(code)
  return err as CopySheetError
}

describe('copy-sheet service on the fake Postgres (ADR §7.2)', () => {
  const originalMax = process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS
  const originalDurable = process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
  beforeEach(() => {
    delete process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS
    delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
  })
  afterEach(() => {
    if (originalMax === undefined) delete process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS
    else process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS = originalMax
    if (originalDurable === undefined) delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    else process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = originalDurable
  })

  it('E1: happy path — structure, order, values, permissions, revisions, audit, ledger, zero events', async () => {
    const pg = new FakePg()
    seedFixture(pg)
    const d = deps()
    const outcome = await run(pg, d)
    expect(outcome.replayed).toBe(false)
    expect(outcome.lockHeld).toBe(true)
    const result = outcome.result
    const NEW = result.sheetId
    expect(NEW).toMatch(/^sheet_/)

    // provenance + copied sheet-level config
    const sheet = pg.rows('meta_sheets').find((r) => r.id === NEW)!
    expect(sheet).toMatchObject({ base_id: BASE, name: '备料主表 副本', copied_from_sheet_id: SRC, copied_from_kind: 'user', row_level_read_permissions_enabled: true })
    expect(sheet.copied_at).toBe('2026-09-27T10:00:00.000Z')
    const fieldMap = new Map(pg.rows('meta_fields').filter((f) => f.sheet_id === NEW).map((f) => [String(f.name), f]))
    expect(fieldMap.size).toBe(9)
    expect((sheet.conditional_read_rules as Array<{ fieldId: string }>)[0]!.fieldId).toBe(fieldMap.get(F.num)!.id)
    // fields
    const btn = fieldMap.get(F.btn)!.property as Record<string, unknown>
    expect(btn.actionType).toBe('record_click')
    expect(btn).not.toHaveProperty('actionConfig')
    expect(btn.label).toBe('Ship')
    expect((fieldMap.get(F.hidden)!.property as Record<string, unknown>).hidden).toBe(true)
    expect((fieldMap.get(F.formula)!.property as Record<string, unknown>).expression).toBe(`={${fieldMap.get(F.num)!.id}} * 2`)
    expect((fieldMap.get(F.link)!.property as Record<string, unknown>).foreignSheetId).toBe(FOREIGN)
    expect(pg.rows('formula_dependencies').filter((r) => r.sheet_id === NEW)).toEqual([{ sheet_id: NEW, field_id: fieldMap.get(F.formula)!.id, depends_on_field_id: fieldMap.get(F.num)!.id }])
    // views
    const views = pg.rows('meta_views').filter((v) => v.sheet_id === NEW).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    expect(views.map((v) => v.name)).toEqual(['默认视图', '第二视图'])
    expect((views[0]!.filter_info as { conditions: unknown[] }).conditions).toEqual([{ fieldId: fieldMap.get(F.title)!.id, operator: 'contains', value: 'a' }])
    expect(views[0]!.config).toEqual({ kanban: { groupFieldId: fieldMap.get(F.status)!.id } })
    expect(JSON.stringify(views)).not.toContain('tok_cs_secret')
    expect(views[1]!.hidden_field_ids).toEqual([fieldMap.get(F.hidden)!.id])
    expect(result.summary.droppedViewFilterLeaves).toEqual([{ viewId: 'view_cs_1', count: 1 }])

    // records: source ORDER (created_at asc → rec_cs_1..5), ordinal created_at, created_by preserved
    const newRecords = pg.rows('meta_records').filter((r) => r.sheet_id === NEW)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
    expect(newRecords).toHaveLength(5)
    expect(newRecords.map((r) => r.created_by)).toEqual([WRITE_OWN, READER, WRITE_OWN, null, ADMIN])
    expect(newRecords.every((r) => r.modified_by === ADMIN)).toBe(true)
    expect(newRecords.map((r) => r.created_at)).toEqual([0, 1, 2, 3, 4].map((i) => `2026-09-27T10:00:00.000${String(i).padStart(3, '0')}Z`))
    const t = fieldMap.get(F.title)!.id, st = fieldMap.get(F.status)!.id, nm = fieldMap.get(F.num)!.id, ln = fieldMap.get(F.link)!.id, au = fieldMap.get(F.auto)!.id
    expect(newRecords.map((r) => r.data)).toEqual([
      { [t]: 'A', [st]: 'open', [nm]: 1, [ln]: ['rec_f1'], [au]: 1 },
      { [t]: 'B', [st]: 'archived', [ln]: ['rec_f2', 'rec_f1'], [au]: 2 }, // null num omitted, out-of-set select kept
      { [t]: 'C', [st]: '', [nm]: 3, [au]: 3 }, // '' select KEPT (DATA-5: the rule evaluator treats '' and absent differently)
      { [t]: 'D', [nm]: 4, [au]: 4 },
      { [t]: 'E', [nm]: 200, [au]: 5 },
    ])
    // attachment + hidden values are ABSENT from every copied row (blanked), never carried
    expect(JSON.stringify(newRecords)).not.toContain('att_1')
    expect(JSON.stringify(newRecords)).not.toContain('h1')
    expect(result.summary.autoNumberRenumberedRows).toBe(0)
    // omitted NULL/absent cells over the 4 value-copied columns (title/status/num/link); '' and [] are kept:
    // rec2 num(null); rec3 link(absent); rec4 status(absent) + link(absent); rec5 status(absent) + link(absent) = 6
    expect(result.summary.nullCellsOmitted).toBe(6)
    expect(result.summary.overLimit).toBe(false)
    // meta_links remapped onto the new record ids
    const newIds = new Set(newRecords.map((r) => String(r.id)))
    const newLinks = pg.rows('meta_links').filter((l) => newIds.has(String(l.record_id)))
    expect(newLinks.map((l) => [l.field_id, l.foreign_record_id])).toEqual([[ln, 'rec_f1'], [ln, 'rec_f2'], [ln, 'rec_f1']])

    // revisions: one batch, source copy-sheet
    const revisions = pg.rows('meta_record_revisions').filter((r) => r.sheet_id === NEW)
    expect(revisions).toHaveLength(5)
    expect(new Set(revisions.map((r) => r.batch_id))).toEqual(new Set([result.batchId]))
    expect(revisions.every((r) => r.source === 'copy-sheet' && r.action === 'create' && r.actor_id === ADMIN)).toBe(true)
    // config revisions: 9 fields + 2 views + (4 sheet-subjects + 2 field + 1 view) permissions, ONE batch
    const config = pg.rows('meta_config_revisions').filter((r) => r.sheet_id === NEW)
    expect(config.filter((r) => r.entity_type === 'field')).toHaveLength(9)
    expect(config.filter((r) => r.entity_type === 'view')).toHaveLength(2)
    expect(config.filter((r) => r.entity_type === 'permission')).toHaveLength(7)
    expect(new Set(config.map((r) => r.batch_id))).toEqual(new Set([result.batchId]))
    expect(config.every((r) => r.action === 'create')).toBe(true)

    // permissions copied 1:1 with id remap (no row for the copier added)
    const sp = pg.rows('spreadsheet_permissions').filter((r) => r.sheet_id === NEW).map((r) => [r.subject_type, r.subject_id, r.perm_code, r.user_id])
    expect(sp).toEqual([
      ['user', READER, 'spreadsheet:read', READER],
      ['user', WRITE_OWN, 'spreadsheet:write-own', WRITE_OWN],
      ['role', ROLE, 'spreadsheet:write', null],
      ['member-group', GROUP, 'spreadsheet:read', null],
    ])
    const fp = pg.rows('field_permissions').filter((r) => r.sheet_id === NEW)
    expect(fp.map((r) => [r.field_id, r.subject_type, r.subject_id, r.visible, r.read_only])).toEqual([
      [fieldMap.get(F.hidden)!.id, 'user', READER, false, true],
      [fieldMap.get(F.num)!.id, 'role', ROLE, true, true],
    ])
    expect(fp.every((r) => typeof r.created_by === 'string' && !String(r.created_by).startsWith('pack:'))).toBe(true)
    const vp = pg.rows('meta_view_permissions').filter((r) => r.view_id === views[1]!.id)
    expect(vp).toEqual([{ view_id: views[1]!.id, subject_type: 'user', subject_id: READER, permission: 'read' }])
    const rp = pg.rows('record_permissions').filter((r) => r.sheet_id === NEW)
    const byOld = new Map(newRecords.map((r, i) => [`rec_cs_${i + 1}`, String(r.id)]))
    expect(rp.map((r) => [r.record_id, r.subject_type, r.subject_id, r.access_level]).sort()).toEqual([
      [byOld.get('rec_cs_1'), 'user', READER, 'write'],
      [byOld.get('rec_cs_2'), 'user', DENIED, 'none'],
      [byOld.get('rec_cs_3'), 'user', DENIED, 'none'],
      [byOld.get('rec_cs_4'), 'member-group', GROUP, 'none'],
    ].sort())
    expect(result.summary.recordPermissionRowCount).toBe(4)

    // audit: two rows, values-free metadata
    const audit = pg.rows('operation_audit_logs')
    expect(audit.map((a) => [a.action, a.resource_id])).toEqual([['multitable.sheet.copy', NEW], ['multitable.sheet.copy-source', SRC]])
    expect(JSON.stringify(audit)).not.toMatch(/"A"|"E"|archived|hmac-secret/)
    // ledger
    const ledger = pg.rows('meta_multitable_template_installs')
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.intent_kind).toBe('copy-sheet')
    expect(ledger[0]!.template_id).toBe(buildCopySheetIntentKey(request, BASE))
    expect(ledger[0]!.sheet_ids).toEqual([NEW])
    // events: NOTHING per row
    expect(d.emit).not.toHaveBeenCalled()
    expect(pg.rows('meta_automation_outbox')).toHaveLength(0)
    // registry: the copy is unmanaged
    expect(pg.rows('plugin_multitable_object_registry').some((r) => r.sheet_id === NEW)).toBe(false)
  })

  it('E1b: with AUTOMATION_DURABLE_DELIVERY_ENABLED=true the copy still enqueues NOTHING', async () => {
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
    const pg = new FakePg()
    seedFixture(pg)
    const d = deps()
    await run(pg, d)
    expect(pg.rows('meta_automation_outbox')).toHaveLength(0)
    expect(pg.statements.some((s) => s.sql.includes('pg_current_xact_id'))).toBe(false)
    expect(d.emit).not.toHaveBeenCalled()
  })

  it('E2: the same intent within the window replays — one sheet, identical body, install not re-run', async () => {
    const pg = new FakePg()
    seedFixture(pg)
    const first = await run(pg)
    const before = snapshotCounts(pg)
    const second = await run(pg)
    expect(second.replayed).toBe(true)
    expect(second.body).toEqual(first.body)
    const after = snapshotCounts(pg)
    // nothing but the ledger sweep could have moved; every content table is unchanged
    for (const table of Object.keys(before)) if (table !== 'meta_multitable_template_installs') expect(after[table]).toBe(before[table])
    expect(pg.rows('meta_sheets').filter((r) => r.copied_from_sheet_id === SRC)).toHaveLength(1)
    // a different intent (withData flipped) is a NEW copy
    const third = await run(pg, deps(), { ...request, withData: false })
    expect(third.replayed).toBe(false)
    expect(pg.rows('meta_sheets').filter((r) => r.copied_from_sheet_id === SRC)).toHaveLength(2)
  })

  it('E3: all-or-nothing — row 3 fails on a missing link target → 422 { rowIndex, fieldId, code } and every table is restored', async () => {
    const pg = new FakePg()
    seedFixture(pg, { brokenLink: true })
    const before = snapshotCounts(pg)
    const beforeSheets = structuredClone(pg.rows('meta_sheets'))
    const err = await expectRefusal(run(pg), 422, COPY_SHEET_ERROR_CODES.rowValidationFailed)
    expect(err.details).toEqual({ rowIndex: 3, fieldId: F.link, code: 'LINK_TARGET_NOT_FOUND' })
    expect(JSON.stringify(err.details)).not.toContain('rec_missing')
    expect(snapshotCounts(pg)).toEqual(before)
    expect(pg.rows('meta_sheets')).toEqual(beforeSheets)
    expect(pg.rows('meta_multitable_template_installs')).toHaveLength(0)
    expect(pg.rows('operation_audit_logs')).toHaveLength(0)
  })

  it('E4: deny-set parity RE-READS the source — a none row committed mid-copy → 500 COPY_PERMISSION_PARITY_FAILED, rolled back', async () => {
    let injected = false
    const pg = new FakePg({
      beforeStatement: (statement, store) => {
        // The FIRST parity statement of the copy transaction: right before the source deny subjects are re-read,
        // a "concurrent" PUT lands a new 'none' row on the SOURCE (the copy read its permissions long before).
        if (!injected && statement.sql.startsWith('SELECT DISTINCT subject_type, subject_id FROM record_permissions')) {
          injected = true
          store.rows('record_permissions').push({ sheet_id: SRC, record_id: 'rec_cs_5', subject_type: 'user', subject_id: DENIED, access_level: 'none', created_by: ADMIN })
        }
      },
    })
    seedFixture(pg)
    const before = snapshotCounts(pg)
    await expectRefusal(run(pg), 500, COPY_SHEET_ERROR_CODES.permissionParityFailed)
    expect(injected).toBe(true)
    // rollback restored the store to BEFORE the copy — including undoing the injected source row (it was inside the txn snapshot)
    expect(snapshotCounts(pg)).toEqual(before)
  })

  it('E5: tripwire — a source record patched AFTER the baseline but BEFORE the copy reads the records → 409 COPY_SOURCE_CHANGED, rolled back', async () => {
    // SEC-2 / TX-1 / DATA-6: the window that matters is between the baseline and the plan's record read. An unfenced
    // writer (patchRecords with the fence flag off — neither the row lock nor the fence) commits there.
    let baselineReads = 0
    let recordReads = 0
    let injectedAtStatement = -1
    const pg = new FakePg({
      beforeStatement: (statement, store) => {
        if (statement.sql.startsWith('SELECT COUNT(*)::int AS n, MAX(updated_at)::text AS max_updated FROM meta_records WHERE sheet_id = $1') && statement.params[0] === SRC) baselineReads += 1
        if (statement.sql.startsWith('SELECT id, data, created_by FROM meta_records WHERE sheet_id = $1') && statement.params[0] === SRC) {
          recordReads += 1
          if (recordReads === 1) {
            expect(baselineReads).toBe(1) // the baseline is already taken when the first record read happens
            const row = store.rows('meta_records').find((r) => r.id === 'rec_cs_3')!
            row.updated_at = '2026-09-27T10:59:59.000000Z'
            injectedAtStatement = store.statements.length
          }
        }
      },
    })
    seedFixture(pg)
    const before = snapshotCounts(pg)
    await expectRefusal(run(pg), 409, COPY_SHEET_ERROR_CODES.sourceChanged)
    expect(recordReads).toBe(1)
    expect(baselineReads).toBe(2) // baseline + the compare re-read
    expect(injectedAtStatement).toBeGreaterThan(0)
    expect(snapshotCounts(pg)).toEqual(before)
    expect(pg.rows('meta_sheets').some((r) => r.copied_from_sheet_id === SRC)).toBe(false)
  })

  it('E6: the in-transaction DB-fresh source gate refuses → 403 COPY_SOURCE_NOT_FULLY_READABLE, no count, nothing written', async () => {
    const pg = new FakePg()
    seedFixture(pg)
    const before = snapshotCounts(pg)
    const d = deps({ hasFullTableReadAccess: vi.fn(async () => false) })
    const err = await expectRefusal(run(pg, d), 403, COPY_SHEET_ERROR_CODES.sourceNotFullyReadable)
    expect(err.details).toEqual({})
    expect(d.hasFullTableReadAccess).toHaveBeenCalledTimes(1)
    expect(snapshotCounts(pg)).toEqual(before)
  })

  it('E7: a deny rule on a renumbered auto-number column refuses; the same rule with stable numbering copies', async () => {
    const renumbered = new FakePg()
    seedFixture(renumbered, { autoStart: 10, rules: [{ id: 'r_auto', fieldId: F.auto, operator: 'gt', value: 12, effect: 'deny_read' }] })
    const before = snapshotCounts(renumbered)
    const err = await expectRefusal(run(renumbered), 422, 'COPY_SOURCE_RULE_ON_RENUMBERED_FIELD')
    expect(err.details).toEqual({ fieldId: F.auto })
    expect(snapshotCounts(renumbered)).toEqual(before)

    const stable = new FakePg()
    seedFixture(stable, { autoStart: 1, rules: [{ id: 'r_auto', fieldId: F.auto, operator: 'gt', value: 3, effect: 'deny_read' }] })
    const outcome = await run(stable)
    const sheet = stable.rows('meta_sheets').find((r) => r.id === outcome.result.sheetId)!
    const newAuto = stable.rows('meta_fields').find((f) => f.sheet_id === outcome.result.sheetId && f.name === F.auto)!
    expect(sheet.conditional_read_rules).toEqual([{ id: 'r_auto', fieldId: newAuto.id, operator: 'gt', value: 3, effect: 'deny_read' }])
    expect(outcome.result.summary.autoNumberRenumberedRows).toBe(0)
  })

  it('E8: a managed source yields copied_from_kind=plugin-managed, no registry row, and the plugin-scope deny refuses another plugin', async () => {
    const pg = new FakePg()
    seedFixture(pg, { managed: true })
    const outcome = await run(pg)
    const NEW = outcome.result.sheetId
    expect(outcome.result.summary.copiedFromKind).toBe('plugin-managed')
    expect(pg.rows('meta_sheets').find((r) => r.id === NEW)!.copied_from_kind).toBe('plugin-managed')
    expect(pg.rows('plugin_multitable_object_registry').filter((r) => r.sheet_id === NEW)).toHaveLength(0)
    for (const pluginName of ['plugin-attendance', 'plugin-integration-core']) {
      await expect(assertSheetNotCopiedFromPluginManaged(pg.query, { pluginName, sheetId: NEW })).rejects.toBeInstanceOf(MultitableSheetScopeError)
    }
    // the SOURCE (a real managed sheet) is untouched by this rule — its own registry row keeps governing it
    await expect(assertSheetNotCopiedFromPluginManaged(pg.query, { pluginName: 'plugin-attendance', sheetId: SRC })).resolves.toBeUndefined()
  })

  it('E9: row cap — copy → 413 COPY_TOO_LARGE { rowCount, limit } before any write; dry-run → summary.overLimit=true without reading records', async () => {
    process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS = '3'
    const pg = new FakePg()
    seedFixture(pg)
    const before = snapshotCounts(pg)
    const err = await expectRefusal(run(pg), 413, COPY_SHEET_ERROR_CODES.tooLarge)
    expect(err.details).toEqual({ rowCount: 5, limit: 3 })
    expect(snapshotCounts(pg)).toEqual(before)

    // dry-run half (FE-2 / ADR §3「超限与否」): 'report' answers the structure + overLimit, records are NOT read
    const mark = pg.statements.length
    const plan = await planCopySheet(pg.query, request, actor, deps(), { copierCanManageSourceFields: false, overLimit: 'report' })
    const issued = pg.statements.slice(mark).map((s) => s.sql)
    expect(issued.some((sql) => sql.startsWith('SELECT id, data, created_by FROM meta_records'))).toBe(false)
    expect(plan.summary).toMatchObject({ overLimit: true, rowCount: 5, fieldCount: 9, builtFieldCount: 9, limits: { maxRows: 3, maxFields: 500 } })
    expect(plan.summary.disclosures).toEqual(expect.arrayContaining([{ fieldId: F.att, code: 'ATTACHMENT_BLANKED' }, { fieldId: F.btn, code: 'BUTTON_DISABLED' }]))
    // the execute path never reports — 'refuse' is the default
    await expectRefusal(planCopySheet(pg.query, request, actor, deps(), { copierCanManageSourceFields: false }), 413, COPY_SHEET_ERROR_CODES.tooLarge)
    expect(snapshotCounts(pg)).toEqual(before)
  })

  it('E10: the dry-run plan writes nothing', async () => {
    const pg = new FakePg()
    seedFixture(pg)
    const mark = pg.statements.length
    const plan = await planCopySheet(pg.query, request, actor, deps(), { copierCanManageSourceFields: false })
    const issued = pg.statements.slice(mark).map((s) => s.sql)
    expect(issued.length).toBeGreaterThan(5)
    expect(issued.some((sql) => /^(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
    expect(plan.summary).toMatchObject({ rowCount: 5, fieldCount: 9, builtFieldCount: 9, viewCount: 2, recordPermissionRowCount: 4, rowLevelReadEnabled: true, conditionalRuleCount: 1 })
    expect(plan.summary.disclosures).toEqual([
      { fieldId: F.att, code: 'ATTACHMENT_BLANKED' },
      { fieldId: F.btn, code: 'BUTTON_DISABLED' },
      { fieldId: F.hidden, code: 'PROPERTY_HIDDEN_BLANKED' },
    ])
  })

  it('E11: with canManageFields on the source the hidden column values copy (and the disclosure disappears)', async () => {
    const pg = new FakePg()
    seedFixture(pg)
    const outcome = await run(pg, deps(), request, true)
    const NEW = outcome.result.sheetId
    const hidden = pg.rows('meta_fields').find((f) => f.sheet_id === NEW && f.name === F.hidden)!
    const values = pg.rows('meta_records').filter((r) => r.sheet_id === NEW).map((r) => (r.data as Record<string, unknown>)[String(hidden.id)])
    expect(values.filter(Boolean).sort()).toEqual(['h1', 'h2'])
    expect(outcome.result.summary.disclosures.some((d) => d.code === 'PROPERTY_HIDDEN_BLANKED')).toBe(false)
  })

  it('E12: source created_by survives per row — the write-own subject keeps exactly its own rows', async () => {
    const pg = new FakePg()
    seedFixture(pg)
    const outcome = await run(pg)
    const mine = pg.rows('meta_records').filter((r) => r.sheet_id === outcome.result.sheetId && r.created_by === WRITE_OWN)
    expect(mine).toHaveLength(2)
    const copier = pg.rows('meta_records').filter((r) => r.sheet_id === outcome.result.sheetId && r.created_by === ADMIN)
    expect(copier).toHaveLength(1) // only the row the copier had ALSO created on the source
  })

  it('E13: lock order — every canonical fence is taken BEFORE the source row FOR UPDATE, the baseline BEFORE any record read, and the fence set covers source + new + link foreign sheets', async () => {
    // TX-2: fence → row lock is the direction every fenced writer uses (createRecord: fence → INSERT meta_records
    // → FK KEY SHARE on meta_sheets(source)); row lock → fence would close a 40P01 cycle with each of them.
    const pg = new FakePg()
    seedFixture(pg)
    const outcome = await run(pg)
    const inTx = pg.statements.filter((s) => s.tx !== null)
    const indexOf = (pred: (sql: string, params: unknown[]) => boolean) => inTx.findIndex((s) => pred(s.sql, s.params))
    const firstFence = indexOf((sql) => sql.startsWith('SELECT pg_advisory_xact_lock(hashtext($1))'))
    const lastFence = inTx.length - 1 - [...inTx].reverse().findIndex((s) => s.sql.startsWith('SELECT pg_advisory_xact_lock(hashtext($1))') && s.tx === inTx[firstFence]!.tx && inTx.indexOf(s) < indexOf((sql) => sql.includes('INSERT INTO meta_sheets')))
    const rowLock = indexOf((sql, params) => sql === 'SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE' && params[0] === SRC)
    const baseline = indexOf((sql, params) => sql.startsWith('SELECT COUNT(*)::int AS n, MAX(updated_at)::text AS max_updated FROM meta_records WHERE sheet_id = $1') && params[0] === SRC)
    const recordRead = indexOf((sql, params) => sql.startsWith('SELECT id, data, created_by FROM meta_records WHERE sheet_id = $1') && params[0] === SRC)
    const gate = indexOf((sql) => sql.startsWith('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1'))
    expect(firstFence).toBeGreaterThanOrEqual(0)
    expect(rowLock).toBeGreaterThan(firstFence)
    expect(rowLock).toBeGreaterThan(lastFence) // no fence is taken AFTER the row lock (the whole set is taken first)
    expect(baseline).toBeGreaterThan(rowLock)
    expect(recordRead).toBeGreaterThan(baseline)
    expect(gate).toBeGreaterThan(baseline) // the row COUNT (a 413 oracle) comes after the baseline, i.e. after the DB-fresh gates
    // the fence set: source, the pre-minted new sheet, the FOREIGN link target — sorted, each exactly once before the row lock
    const fenceKeys = inTx.slice(0, rowLock).filter((s) => s.sql.startsWith('SELECT pg_advisory_xact_lock(hashtext($1))')).map((s) => String(s.params[0]))
    expect(fenceKeys).toEqual([FOREIGN, SRC, outcome.result.sheetId].sort().map((id) => `meta:auto-number:sheet:${id}`))
    // the dedupe advisory lock is STILL the very first statement of the transaction (CS-16)
    expect(inTx[0]!.sql.startsWith('SELECT pg_try_advisory_xact_lock(')).toBe(true)
  })

  it('E14: a grid view with frozenLeftColumnIds / columnWidths / aggregations copies with the keys remapped and unknown ids dropped', async () => {
    const pg = new FakePg()
    seedFixture(pg, { viewPrefs: true })
    const outcome = await run(pg)
    const NEW = outcome.result.sheetId
    const fieldMap = new Map(pg.rows('meta_fields').filter((f) => f.sheet_id === NEW).map((f) => [String(f.name), String(f.id)]))
    const view = pg.rows('meta_views').find((v) => v.sheet_id === NEW && v.name === '冻结视图')!
    expect(view.config).toEqual({
      frozenLeftColumnIds: [fieldMap.get(F.title), fieldMap.get(F.status)],
      columnWidths: { [fieldMap.get(F.title)!]: 240, [fieldMap.get(F.num)!]: 90 },
      aggregations: { [fieldMap.get(F.num)!]: 'sum', [fieldMap.get(F.att)!]: 'count' },
      rowDensity: 'compact',
    })
    expect(JSON.stringify(view.config)).not.toContain('fld_cs_')
    expect(outcome.result.summary.viewCount).toBe(3)
  })

  it('E15: a rule on a column where a row holds \'\' → the copy keeps \'\' and deny parity passes (DATA-5)', async () => {
    const pg = new FakePg()
    seedFixture(pg, { rules: [{ id: 'rule_status', fieldId: F.status, operator: 'eq', value: 'X', effect: 'deny_read' }] })
    const outcome = await run(pg) // no COPY_PERMISSION_PARITY_FAILED
    const NEW = outcome.result.sheetId
    const status = pg.rows('meta_fields').find((f) => f.sheet_id === NEW && f.name === F.status)!
    const copied = pg.rows('meta_records').filter((r) => r.sheet_id === NEW).map((r) => (r.data as Record<string, unknown>)[String(status.id)])
    expect(copied.filter((v) => v === '')).toHaveLength(1) // rec_cs_3's '' survived
    expect(copied.filter((v) => v === undefined)).toHaveLength(2) // rec_cs_4 / rec_cs_5 stay absent (null-omission only)
    expect(outcome.result.summary.conditionalRuleCount).toBe(1)
  })

  it('E16: relation-aggregation formulas — the quoted link id is remapped (foreign target kept, self-link target remapped) and formula_dependencies points at the NEW link', async () => {
    const pg = new FakePg()
    seedFixture(pg, { relationAggregation: true })
    const outcome = await run(pg, deps({ relationAggregationLinkFieldId: extractRelationAggregationLinkFieldId }))
    const NEW = outcome.result.sheetId
    const fieldMap = new Map(pg.rows('meta_fields').filter((f) => f.sheet_id === NEW).map((f) => [String(f.name), f]))
    const newLink = String(fieldMap.get(F.link)!.id), newSelf = String(fieldMap.get('fld_cs_self')!.id), newTitle = String(fieldMap.get(F.title)!.id)
    expect((fieldMap.get('fld_cs_relsum')!.property as Record<string, unknown>).expression).toBe(`=RELSUMIF("${newLink}", "fld_cs_fname", "fld_cs_fname", "=", "F1")`)
    expect((fieldMap.get('fld_cs_relcount')!.property as Record<string, unknown>).expression).toBe(`=RELCOUNTIF("${newSelf}", "${newTitle}", "=", {${newTitle}})`)
    const deps_ = pg.rows('formula_dependencies').filter((r) => r.sheet_id === NEW).map((r) => [r.field_id, r.depends_on_field_id])
    expect(deps_).toEqual(expect.arrayContaining([
      [fieldMap.get('fld_cs_relsum')!.id, newLink],
      [fieldMap.get('fld_cs_relcount')!.id, newTitle],
      [fieldMap.get('fld_cs_relcount')!.id, newSelf],
    ]))
    // no SOURCE-sheet field id survives in any copied property (the FOREIGN sheet's `fld_cs_fname` legitimately stays;
    // field NAMES equal the source ids in this fixture, so scan properties only)
    const properties = JSON.stringify(pg.rows('meta_fields').filter((f) => f.sheet_id === NEW).map((f) => f.property))
    for (const sourceId of [...Object.values(F), 'fld_cs_self']) expect(properties).not.toContain(`"${sourceId}"`)
    // the self-link is blanked in S1, so the formula over it is disclosed as depending on a blanked column
    expect(outcome.result.summary.disclosures).toEqual(expect.arrayContaining([
      { fieldId: 'fld_cs_self', code: 'SELF_LINK_BLANKED' }, { fieldId: 'fld_cs_relcount', code: 'DEPENDS_ON_BLANKED_COLUMN' },
    ]))
  })

  it('E17: copying a plugin-managed SNAPSHOT keeps copied_from_kind=plugin-managed (no whitewash) and the plugin-scope deny holds on the grandchild', async () => {
    const pg = new FakePg()
    seedFixture(pg, { managed: true })
    const first = await run(pg)
    const child = first.result.sheetId
    expect(pg.rows('plugin_multitable_object_registry').some((r) => r.sheet_id === child)).toBe(false) // no registry row on the child
    const second = await run(pg, deps(), { ...request, sourceSheetId: child, name: 'grandchild' })
    const grandchild = second.result.sheetId
    expect(second.result.summary.copiedFromKind).toBe('plugin-managed')
    expect(pg.rows('meta_sheets').find((r) => r.id === grandchild)!.copied_from_kind).toBe('plugin-managed')
    await expect(assertSheetNotCopiedFromPluginManaged(pg.query, { pluginName: 'plugin-attendance', sheetId: grandchild })).rejects.toBeInstanceOf(MultitableSheetScopeError)
    // control: a copy of a plain user sheet's copy stays 'user'
    const plain = new FakePg()
    seedFixture(plain)
    const c1 = await run(plain)
    const c2 = await run(plain, deps(), { ...request, sourceSheetId: c1.result.sheetId, name: 'plain-grandchild' })
    expect(c2.result.summary.copiedFromKind).toBe('user')
  })

  it('E18: the intent lock held by another transaction past the bounded wait → 409 CONFLICT, install never runs, nothing written (TX-4)', async () => {
    const pg = new FakePg()
    seedFixture(pg)
    const before = snapshotCounts(pg)
    const digest = buildIntentScopeDigest({ tenantId: null, actorId: ADMIN, intentKind: COPY_SHEET_INTENT_KIND, intentKey: buildCopySheetIntentKey(request, BASE), workspaceId: null, baseName: null })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    // another transaction holds the same intent lock and does not commit until we let it
    const holder = pg.transaction(async ({ query }) => {
      const res = await query('SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked', [digest])
      expect(res.rows[0]).toEqual({ locked: true })
      await released
    })
    const mark = pg.statements.length
    const err = await expectRefusal(run(pg, deps(), request, false, { lockWaitMs: 1, lockPollMs: 1 }), 409, 'CONFLICT')
    expect(err.details).toEqual({})
    const issued = pg.statements.slice(mark).filter((s) => s.tx !== null).map((s) => s.sql)
    expect(issued.every((sql) => sql.startsWith('SELECT pg_try_advisory_xact_lock('))).toBe(true) // only lock polls: no ledger read, no plan, no write
    expect(snapshotCounts(pg)).toEqual(before)
    release()
    await holder
  })
})

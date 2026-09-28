/**
 * Field retype slice 3a — the post-fence field-schema re-check, per wired writer (fake PG).
 *
 * Design lock docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.11 rows 1–7 and row 13.
 * Each writer is driven through its real code with a fake query that records every statement and answers the
 * field catalogue in two voices: the SNAPSHOT read (what the writer validated against — `string`) and the
 * post-fence RE-READ (the helper's `FOR SHARE` statement — `select` when a conversion committed in between).
 * For every writer:
 *   drift, flag on   → 409 FIELD_SCHEMA_CHANGED (automation: step fails; derived merge: skipped), ZERO
 *                      `meta_records` writes, and the re-read ran on the WRITER'S transactional query;
 *   no drift, flag on → the write proceeds (the re-read ran and passed);
 *   drift, flag off   → the write proceeds exactly as before this slice and the re-read statement is NEVER
 *                      issued — the inertness proof (the change does nothing until the convert flag is 'true').
 * The structural guard (multitable-field-schema-fence-recheck.guard.test.ts) proves the call sits after the
 * fence and before the first write; this file proves the call does what it claims at each site.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import {
  DERIVED_MERGE_TARGET_RECHECK_SQL,
  DerivedMergeTargetRetypedError,
  FIELD_SCHEMA_CHANGED_CODE,
  FIELD_SCHEMA_FENCE_RECHECK_SQL,
  FIELD_SCHEMA_SNAPSHOT_SQL,
  FieldSchemaChangedError,
  assertDerivedMergeTargetsStillDerived,
  assertFieldSchemaUnchangedAfterFence,
  fieldSchemaSnapshotFromFields,
  fieldSchemaSnapshotFromRows,
  isFieldSchemaFenceRecheckEnabled,
  loadFieldSchemaSnapshot,
} from '../../src/multitable/field-schema-fence-recheck'
import { SheetWriterBlockedError, __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { serializeFieldRow } from '../../src/multitable/field-codecs'
import { usePinnedServer } from '../utils/pinned-server'

const FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT'
const WRITER_FENCE = 'MULTITABLE_ENABLE_WRITER_FENCE'
const SHEET = 'sheet_fsr_1'
const FIELD = 'fld_fsr_note'
const RECORD = 'rec_fsr_1'

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
const RECORDS_WRITE = /^(?:UPDATE|INSERT INTO|DELETE FROM) meta_records\b/i

type Stmt = { sql: string; params: unknown[]; via: string }
type FieldShape = { type: string; options?: string[] } | null

function fieldRow(shape: { type: string; options?: string[] }, id = FIELD) {
  return {
    id,
    sheet_id: SHEET,
    name: 'Note',
    type: shape.type,
    property: shape.options ? { options: shape.options.map((value) => ({ value })) } : {},
    order: 0,
  }
}

/**
 * The shared fake. `snapshot` answers every ordinary field-catalogue read; `recheck` answers the helper's FOR SHARE
 * re-read (and the derived variant's). Everything else gets a permissive default that lets the writer reach its
 * write.
 */
function makeDb(opts: { snapshot: { type: string; options?: string[] }; recheck: FieldShape; derivedType?: string }) {
  const stmts: Stmt[] = []
  const handler = (via: string) => async (sqlIn: unknown, params: unknown[] = []) => {
    const sql = collapse(String(sqlIn))
    stmts.push({ sql, params, via })
    if (sql === FIELD_SCHEMA_FENCE_RECHECK_SQL) return { rows: opts.recheck ? [fieldRow(opts.recheck)] : [], rowCount: opts.recheck ? 1 : 0 }
    if (sql === DERIVED_MERGE_TARGET_RECHECK_SQL) return { rows: [{ id: FIELD, type: opts.derivedType ?? 'formula' }], rowCount: 1 }
    if (/information_schema/i.test(sql)) return { rows: [], rowCount: 0 }
    if (/pg_current_xact_id/i.test(sql)) return { rows: [{ xid: '7' }], rowCount: 1 }
    if (/type = 'longText'/.test(sql)) return { rows: [], rowCount: 0 }
    if (/FROM meta_fields/i.test(sql)) return { rows: [fieldRow(opts.snapshot)], rowCount: 1 }
    if (/FROM meta_sheets WHERE id = \$1/i.test(sql)) return { rows: [{ id: SHEET, base_id: 'base_fsr', name: 'Sheet', description: null, deleted_at: null }], rowCount: 1 }
    if (/^UPDATE meta_records/i.test(sql)) return { rows: [{ id: RECORD, version: 2, data: { [FIELD]: 'x' } }], rowCount: 1 }
    if (/^INSERT INTO meta_records /i.test(sql)) return { rows: [{ id: RECORD, version: 1 }], rowCount: 1 }
    if (/FROM meta_records/i.test(sql)) {
      return {
        rows: [{ id: RECORD, sheet_id: SHEET, version: 1, data: { [FIELD]: 'before' }, created_by: 'u_fsr', locked: false, locked_by: null }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  }
  return {
    stmts,
    pool: handler('pool'),
    txn: handler('txn'),
    rechecks: () => stmts.filter((s) => s.sql === FIELD_SCHEMA_FENCE_RECHECK_SQL),
    derivedRechecks: () => stmts.filter((s) => s.sql === DERIVED_MERGE_TARGET_RECHECK_SQL),
    recordWrites: () => stmts.filter((s) => RECORDS_WRITE.test(s.sql)),
  }
}

const STRING = { type: 'string' }
const SELECT_B = { type: 'select', options: ['B'] }

beforeEach(() => {
  delete process.env[FLAG]
  delete process.env[WRITER_FENCE]
  __resetRecoveryWriterStateColumnProbe()
})
afterEach(() => {
  delete process.env[FLAG]
  delete process.env[WRITER_FENCE]
  vi.restoreAllMocks()
})

// ── the helper itself ───────────────────────────────────────────────────────────────────────────────────

describe('assertFieldSchemaUnchangedAfterFence — the helper', () => {
  const snapshot = fieldSchemaSnapshotFromRows([fieldRow(STRING)])

  it('flag gate is the exact literal: only "true" turns it on (no trim, no case folding)', () => {
    for (const v of ['TRUE', ' true', 'true ', '1', 'yes', '']) expect(isFieldSchemaFenceRecheckEnabled({ [FLAG]: v }), v).toBe(false)
    expect(isFieldSchemaFenceRecheckEnabled({ [FLAG]: 'true' })).toBe(true)
  })

  it('flag off ⇒ no query at all, even when the schema drifted', async () => {
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    process.env[FLAG] = 'TRUE'
    await expect(assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, snapshot, [FIELD])).resolves.toBeUndefined()
    expect(db.stmts).toEqual([])
  })

  it('flag on, unchanged ⇒ exactly one FOR SHARE re-read of the touched ids, passes', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: STRING })
    await assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, snapshot, [FIELD, FIELD])
    expect(db.stmts).toEqual([{ sql: FIELD_SCHEMA_FENCE_RECHECK_SQL, params: [SHEET, [FIELD]], via: 'txn' }])
    expect(FIELD_SCHEMA_FENCE_RECHECK_SQL).toMatch(/FOR SHARE$/)
  })

  it('flag on, type changed ⇒ 409 FIELD_SCHEMA_CHANGED, values-free', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    const err = await assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, snapshot, [FIELD]).catch((e) => e)
    expect(err).toBeInstanceOf(FieldSchemaChangedError)
    expect(err.code).toBe(FIELD_SCHEMA_CHANGED_CODE)
    expect(err.statusCode).toBe(409)
    for (const leak of [FIELD, SHEET, 'select', 'string', 'B']) expect(err.message).not.toContain(leak)
  })

  it('select option set: a removed or added option is drift; the same set in another order is not', async () => {
    process.env[FLAG] = 'true'
    const selectSnapshot = fieldSchemaSnapshotFromRows([fieldRow({ type: 'select', options: ['A', 'B'] })])
    await expect(assertFieldSchemaUnchangedAfterFence(makeDb({ snapshot: STRING, recheck: { type: 'select', options: ['B', 'A'] } }).txn, SHEET, selectSnapshot, [FIELD])).resolves.toBeUndefined()
    await expect(assertFieldSchemaUnchangedAfterFence(makeDb({ snapshot: STRING, recheck: { type: 'select', options: ['A'] } }).txn, SHEET, selectSnapshot, [FIELD])).rejects.toBeInstanceOf(FieldSchemaChangedError)
    await expect(assertFieldSchemaUnchangedAfterFence(makeDb({ snapshot: STRING, recheck: { type: 'select', options: ['A', 'B', 'C'] } }).txn, SHEET, selectSnapshot, [FIELD])).rejects.toBeInstanceOf(FieldSchemaChangedError)
  })

  it('a touched field that no longer exists is drift', async () => {
    process.env[FLAG] = 'true'
    await expect(assertFieldSchemaUnchangedAfterFence(makeDb({ snapshot: STRING, recheck: null }).txn, SHEET, snapshot, [FIELD])).rejects.toBeInstanceOf(FieldSchemaChangedError)
  })

  it('ids the snapshot does not carry, a null snapshot, or nothing touched ⇒ no query', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    await assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, snapshot, ['fld_unknown'])
    await assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, null, [FIELD])
    await assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, snapshot, [])
    expect(db.stmts).toEqual([])
  })

  it('snapshots from raw rows and from serialised fields agree (type aliases normalised like the read path)', () => {
    const raw = [{ id: 'a', type: 'multi_select', property: { options: [{ value: 'X' }] } }, { id: 'b', type: 'checkbox', property: {} }]
    const fromRows = fieldSchemaSnapshotFromRows(raw)
    const fromFields = fieldSchemaSnapshotFromFields(raw.map((r) => serializeFieldRow({ ...r, name: '', order: 0 })))
    expect(fromRows).toEqual(fromFields)
    expect(fromRows.get('a')).toEqual({ type: 'multiSelect', options: ['X'] })
    expect(fromRows.get('b')).toEqual({ type: 'boolean' })
  })

  it('loadFieldSchemaSnapshot: flag off ⇒ null and no query; on ⇒ one plain (unlocked) read', async () => {
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    expect(await loadFieldSchemaSnapshot(db.pool, SHEET, [FIELD])).toBeNull()
    expect(db.stmts).toEqual([])
    process.env[FLAG] = 'true'
    expect(await loadFieldSchemaSnapshot(db.pool, SHEET, [FIELD])).toEqual(new Map([[FIELD, { type: 'string' }]]))
    expect(db.stmts.map((s) => s.sql)).toEqual([FIELD_SCHEMA_SNAPSHOT_SQL])
  })
})

describe('assertDerivedMergeTargetsStillDerived — the row 13 variant', () => {
  it('flag off ⇒ no query', async () => {
    const db = makeDb({ snapshot: STRING, recheck: null, derivedType: 'string' })
    await assertDerivedMergeTargetsStillDerived(db.txn, SHEET, [FIELD])
    expect(db.stmts).toEqual([])
  })

  it('still a formula / lookup / rollup ⇒ passes', async () => {
    process.env[FLAG] = 'true'
    for (const t of ['formula', 'lookup', 'rollup']) {
      await expect(assertDerivedMergeTargetsStillDerived(makeDb({ snapshot: STRING, recheck: null, derivedType: t }).txn, SHEET, [FIELD])).resolves.toBeUndefined()
    }
  })

  it('retyped ⇒ a SheetWriterBlockedError subclass (the callers\' skip branch), reason derived_target_retyped, state null, values-free', async () => {
    process.env[FLAG] = 'true'
    const err = await assertDerivedMergeTargetsStillDerived(makeDb({ snapshot: STRING, recheck: null, derivedType: 'string' }).txn, SHEET, [FIELD]).catch((e) => e)
    expect(err).toBeInstanceOf(DerivedMergeTargetRetypedError)
    expect(err).toBeInstanceOf(SheetWriterBlockedError)
    expect(err.reason).toBe('derived_target_retyped')
    expect(err.state).toBeNull()
    expect(err.message).not.toContain(FIELD)
  })
})

// ── row 1: RecordWriteService.patchRecords ─────────────────────────────────────────────────────────────

import { RecordWriteService, type RecordWriteHelpers, type RecordPatchInput } from '../../src/multitable/record-write-service'

function writeHelpers(): RecordWriteHelpers {
  return {
    normalizeLinkIds: (v) => (Array.isArray(v) ? v.map(String) : []),
    normalizeAttachmentIds: (v) => (Array.isArray(v) ? v.map(String) : []),
    normalizeJson: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}),
    parseLinkFieldConfig: () => null,
    buildId: (prefix) => `${prefix}_fsr`,
    ensureRecordWriteAllowed: () => true,
    filterRecordDataByFieldIds: (data) => (data && typeof data === 'object' ? (data as Record<string, unknown>) : {}),
    extractLookupRollupData: () => ({}),
    mergeComputedRecords: (base) => base,
    filterRecordFieldSummaryMap: (map) => map,
    serializeLinkSummaryMap: () => ({}),
    serializeAttachmentSummaryMap: () => ({}),
    applyLookupRollup: vi.fn().mockResolvedValue(undefined),
    computeDependentLookupRollupRecords: vi.fn().mockResolvedValue([]),
    recalculateFormulaFields: vi.fn().mockResolvedValue([]),
    loadLinkValuesByRecord: vi.fn().mockResolvedValue(new Map()),
    buildLinkSummaries: vi.fn().mockResolvedValue(new Map()),
    buildAttachmentSummaries: vi.fn().mockResolvedValue(new Map()),
    ensureAttachmentIdsExist: vi.fn().mockResolvedValue(null),
    loadSheetMemberUserIds: vi.fn().mockResolvedValue(new Set()),
  } as RecordWriteHelpers
}

const CAPS = {
  canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
  canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: true, canExport: true,
}

async function runPatchRecords(db: ReturnType<typeof makeDb>) {
  const pool = { query: vi.fn(db.pool), transaction: vi.fn(async (fn: (c: { query: unknown }) => unknown) => fn({ query: db.txn })) }
  const svc = new RecordWriteService(pool as never, { emit: vi.fn(), publish: vi.fn() } as never, writeHelpers())
  const field = { id: FIELD, name: 'Note', type: 'string', property: {}, order: 0 }
  const input = {
    sheetId: SHEET,
    changesByRecord: new Map([[RECORD, [{ fieldId: FIELD, value: 'B ' }]]]),
    actorId: 'u_fsr',
    fields: [field],
    visiblePropertyFields: [field],
    visiblePropertyFieldIds: new Set([FIELD]),
    attachmentFields: [],
    fieldById: new Map([[FIELD, { type: 'string', readOnly: false, hidden: false }]]),
    capabilities: CAPS,
    access: { userId: 'u_fsr', permissions: ['multitable:write'], isAdminRole: false },
  } as unknown as RecordPatchInput
  return svc.patchRecords(input)
}

describe('row 1 — RecordWriteService.patchRecords (bulk / AI / OAPI batch)', () => {
  it('drift + flag on ⇒ FieldSchemaChangedError, zero meta_records writes, re-read on the transaction query', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    await expect(runPatchRecords(db)).rejects.toBeInstanceOf(FieldSchemaChangedError)
    expect(db.recordWrites()).toEqual([])
    expect(db.stmts.some((s) => /FOR UPDATE/.test(s.sql))).toBe(false) // refused before the first row lock
    expect(db.rechecks().map((s) => s.via)).toEqual(['txn'])
  })

  it('no drift + flag on ⇒ the write proceeds', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: STRING })
    await runPatchRecords(db)
    expect(db.rechecks()).toHaveLength(1)
    expect(db.recordWrites()).toHaveLength(1)
  })

  it('drift + flag off ⇒ legacy behaviour: no re-read issued, the stale write lands', async () => {
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    await runPatchRecords(db)
    expect(db.rechecks()).toEqual([])
    expect(db.recordWrites()).toHaveLength(1)
  })
})

// ── rows 2 / 3: plugin SDK patchRecord / createRecord ────────────────────────────────────────────────────

import { createRecord as pluginCreateRecord, patchRecord as pluginPatchRecord } from '../../src/multitable/records'

describe('rows 2 / 3 — plugin SDK patchRecord / createRecord', () => {
  const patch = (db: ReturnType<typeof makeDb>) =>
    pluginPatchRecord({ query: db.txn as never, sheetId: SHEET, recordId: RECORD, changes: { [FIELD]: 'B ' } })
  const create = (db: ReturnType<typeof makeDb>) =>
    pluginCreateRecord({ query: db.txn as never, sheetId: SHEET, data: { [FIELD]: 'B ' } })

  for (const [name, run] of [['row 2 patchRecord', patch], ['row 3 createRecord', create]] as const) {
    it(`${name}: drift + flag on ⇒ FieldSchemaChangedError, zero meta_records writes`, async () => {
      process.env[FLAG] = 'true'
      const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
      await expect(run(db)).rejects.toBeInstanceOf(FieldSchemaChangedError)
      expect(db.recordWrites()).toEqual([])
      expect(db.rechecks()).toHaveLength(1)
    })

    it(`${name}: no drift + flag on ⇒ the write proceeds`, async () => {
      process.env[FLAG] = 'true'
      const db = makeDb({ snapshot: STRING, recheck: STRING })
      await run(db)
      expect(db.rechecks()).toHaveLength(1)
      expect(db.recordWrites()).toHaveLength(1)
    })

    it(`${name}: drift + flag off ⇒ no re-read issued, the write lands`, async () => {
      const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
      await run(db)
      expect(db.rechecks()).toEqual([])
      expect(db.recordWrites()).toHaveLength(1)
    })
  }
})

// ── row 4: RecordService.patchRecord (REST + OAPI single-record PATCH) ───────────────────────────────────

import { RecordService } from '../../src/multitable/record-service'

async function runServicePatch(db: ReturnType<typeof makeDb>) {
  const pool = { query: vi.fn(db.pool), transaction: vi.fn(async (fn: (c: { query: unknown }) => unknown) => fn({ query: db.txn })) }
  const svc = new RecordService(pool as never, { emit: vi.fn(), publish: vi.fn() } as never)
  return svc.patchRecord({
    recordId: RECORD,
    sheetId: SHEET,
    data: { [FIELD]: 'B ' },
    actorId: 'u_fsr',
    access: { userId: 'u_fsr', permissions: ['multitable:write'], isAdminRole: false },
    capabilities: CAPS,
  } as never)
}

describe('row 4 — RecordService.patchRecord (REST + OAPI PATCH /records/:recordId)', () => {
  it('drift + flag on ⇒ FieldSchemaChangedError, zero writes, refused before the row lock', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    await expect(runServicePatch(db)).rejects.toBeInstanceOf(FieldSchemaChangedError)
    expect(db.recordWrites()).toEqual([])
    expect(db.stmts.some((s) => /FOR UPDATE/.test(s.sql))).toBe(false)
    expect(db.rechecks().map((s) => s.via)).toEqual(['txn'])
  })

  it('no drift + flag on ⇒ the write proceeds', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: STRING })
    await runServicePatch(db)
    expect(db.recordWrites()).toHaveLength(1)
  })

  it('drift + flag off ⇒ no re-read issued, the write lands', async () => {
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    await runServicePatch(db)
    expect(db.rechecks()).toEqual([])
    expect(db.recordWrites()).toHaveLength(1)
  })
})

// ── row 5: form submit (route) ───────────────────────────────────────────────────────────────────────────

const pinned = usePinnedServer()
const VIEW = 'view_fsr_form'

async function formApp(db: ReturnType<typeof makeDb>) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(['multitable:read', 'multitable:write']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const viewRow = { id: VIEW, sheet_id: SHEET, name: 'Form', type: 'form', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }
  const route = (via: 'pool' | 'txn') => async (sql: string, params?: unknown[]) => {
    if (/FROM (spreadsheet_permissions|field_permissions|view_permissions|meta_view_permissions|record_permissions|formula_dependencies)/.test(sql)) return { rows: [], rowCount: 0 }
    if (/FROM meta_views WHERE id = \$1/.test(sql)) return { rows: [viewRow], rowCount: 1 }
    return (via === 'pool' ? db.pool : db.txn)(sql, params)
  }
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query: vi.fn(route('pool')),
    transaction: vi.fn(async (fn: (c: { query: unknown }) => unknown) => fn({ query: route('txn') })),
  } as never)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { user?: unknown }).user = { id: 'u_fsr', roles: [], perms: ['multitable:read', 'multitable:write'] }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  pinned.setApp(app)
}

describe('row 5 — form submit POST /views/:viewId/submit (CREATE branch)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/rbac/service')
    vi.resetModules()
  })

  it('drift + flag on ⇒ 409 FIELD_SCHEMA_CHANGED, zero meta_records writes', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    await formApp(db)
    const res = await request(pinned.url()).post(`/api/multitable/views/${VIEW}/submit`).send({ data: { [FIELD]: 'B ' } })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('FIELD_SCHEMA_CHANGED')
    expect(db.recordWrites()).toEqual([])
    expect(db.rechecks().map((s) => s.via)).toEqual(['txn'])
  })

  it('no drift + flag on ⇒ 200 and the record is inserted', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: STRING })
    await formApp(db)
    const res = await request(pinned.url()).post(`/api/multitable/views/${VIEW}/submit`).send({ data: { [FIELD]: 'B ' } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(db.recordWrites().filter((s) => /^INSERT INTO meta_records /.test(s.sql))).toHaveLength(1)
  })

  it('drift + flag off ⇒ 200, no re-read issued', async () => {
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    await formApp(db)
    const res = await request(pinned.url()).post(`/api/multitable/views/${VIEW}/submit`).send({ data: { [FIELD]: 'B ' } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(db.rechecks()).toEqual([])
    expect(db.recordWrites().filter((s) => /^INSERT INTO meta_records /.test(s.sql))).toHaveLength(1)
  })
})

// ── row 6: automation update_record / create_record ──────────────────────────────────────────────────────

import { AutomationExecutor, type AutomationDeps, type AutomationRule } from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'

function automationDeps(db: ReturnType<typeof makeDb>): AutomationDeps {
  return {
    eventBus: new EventBus(),
    queryFn: vi.fn(db.pool) as never,
    transaction: vi.fn(async (fn) => fn({ query: vi.fn(db.txn) as never })) as never,
  }
}

function rule(action: { type: string; config: Record<string, unknown> }): AutomationRule {
  return {
    id: 'rule_fsr', name: 'fsr', sheetId: SHEET, trigger: { type: 'record.created', config: {} }, actions: [action as never],
    enabled: true, createdBy: 'u_fsr', createdAt: '2026-09-28T00:00:00Z',
  } as AutomationRule
}

const TRIGGER = { recordId: RECORD, sheetId: SHEET, actorId: 'u_fsr', data: {} }
const AUTOMATION_ACTIONS = [
  { type: 'update_record', config: { fields: { [FIELD]: 'B ' } } },
  { type: 'create_record', config: { sheetId: SHEET, data: { [FIELD]: 'B ' } } },
]

describe('row 6 — automation update_record / create_record', () => {
  for (const action of AUTOMATION_ACTIONS) {
    it(`${action.type}: drift + flag on ⇒ step failed with FIELD_SCHEMA_CHANGED's message, zero writes`, async () => {
      process.env[FLAG] = 'true'
      const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
      const exec = await new AutomationExecutor(automationDeps(db)).execute(rule(action), TRIGGER)
      expect(exec.steps[0]?.status).toBe('failed')
      expect(exec.steps[0]?.error).toBe(new FieldSchemaChangedError().message)
      expect(db.recordWrites()).toEqual([])
      expect(db.stmts.filter((s) => s.sql === FIELD_SCHEMA_SNAPSHOT_SQL).map((s) => s.via)).toEqual(['pool']) // pre-fence
      expect(db.rechecks().map((s) => s.via)).toEqual(['txn']) // post-fence
    })

    it(`${action.type}: no drift + flag on ⇒ step succeeds, one write`, async () => {
      process.env[FLAG] = 'true'
      const db = makeDb({ snapshot: STRING, recheck: STRING })
      const exec = await new AutomationExecutor(automationDeps(db)).execute(rule(action), TRIGGER)
      expect(exec.steps[0]?.status).toBe('success')
      expect(db.recordWrites()).toHaveLength(1)
    })

    it(`${action.type}: drift + flag off ⇒ no snapshot read, no re-read, the write lands`, async () => {
      const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
      const exec = await new AutomationExecutor(automationDeps(db)).execute(rule(action), TRIGGER)
      expect(exec.steps[0]?.status).toBe('success')
      expect(db.stmts.filter((s) => s.sql === FIELD_SCHEMA_SNAPSHOT_SQL || s.sql === FIELD_SCHEMA_FENCE_RECHECK_SQL)).toEqual([])
      expect(db.recordWrites()).toHaveLength(1)
    })
  }
})

// ── row 7: approval resultWriteback ────────────────────────────────────────────────────────────────────

import { AutomationService } from '../../src/multitable/automation-service'
import { poolManager } from '../../src/integration/db/connection-pool'

type WritebackInternals = {
  writeApprovalResultBack(bridge: unknown, config: Record<string, unknown>, event: unknown): Promise<unknown>
}

function writebackService(db: ReturnType<typeof makeDb>): WritebackInternals {
  const service = new AutomationService(new EventBus(), {} as never, vi.fn(db.pool) as never)
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query: vi.fn(db.pool),
    transaction: (fn: (c: { query: unknown }) => unknown) => fn({ query: db.txn }),
  } as never)
  return service as unknown as WritebackInternals
}

const BRIDGE = { id: 'aab_fsr', sheetId: SHEET, recordId: RECORD, triggerEvent: { actorId: 'u_fsr', recordId: RECORD, _automationDepth: 0 } }
const APPROVED = {
  version: 1, source: 'approval-product', eventType: 'approval.approved', eventId: 'evt_fsr', occurredAt: '2026-09-28T00:00:00.000Z',
  approval: { instanceId: 'ai_fsr', requestNo: 'R-1', templateId: 'tpl', publishedDefinitionId: 'pd' },
  transition: { toStatus: 'approved' }, actor: { id: 'u_fsr' }, requester: { id: 'u_fsr' },
}
const WRITEBACK = { templateId: 'tpl', resultWriteback: { statusField: FIELD } }

describe('row 7 — approval resultWriteback (the race form: validated before the fence, re-read after it)', () => {
  it('drift + flag on ⇒ throws FieldSchemaChangedError, zero writes; the pre-fence check itself passed on `string`', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    await expect(writebackService(db).writeApprovalResultBack(BRIDGE, WRITEBACK, APPROVED)).rejects.toBeInstanceOf(FieldSchemaChangedError)
    expect(db.recordWrites()).toEqual([])
    expect(db.rechecks().map((s) => s.via)).toEqual(['txn'])
  })

  it('no drift + flag on ⇒ the write-back lands', async () => {
    process.env[FLAG] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: STRING })
    await expect(writebackService(db).writeApprovalResultBack(BRIDGE, WRITEBACK, APPROVED)).resolves.toMatchObject({ kind: 'same-base' })
    expect(db.recordWrites()).toHaveLength(1)
  })

  it('drift + flag off ⇒ no re-read issued, the write-back lands', async () => {
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    await expect(writebackService(db).writeApprovalResultBack(BRIDGE, WRITEBACK, APPROVED)).resolves.toMatchObject({ kind: 'same-base' })
    expect(db.rechecks()).toEqual([])
    expect(db.recordWrites()).toHaveLength(1)
  })
})

// ── row 13: non-scoped derived merge ─────────────────────────────────────────────────────────────────────

import { applyFencedDerivedDataMerge } from '../../src/multitable/derived-write-fence'
import { MultitableFormulaEngine } from '../../src/multitable/formula-engine'

function derivedPool(db: ReturnType<typeof makeDb>) {
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query: vi.fn(db.pool),
    transaction: (fn: (c: { query: unknown }) => unknown) => fn({ query: db.txn }),
  } as never)
}

describe('row 13 — non-scoped derived merge (writer fence ON path)', () => {
  it('target retyped + flag on ⇒ DerivedMergeTargetRetypedError (a SheetWriterBlockedError), zero writes', async () => {
    process.env[FLAG] = 'true'
    process.env[WRITER_FENCE] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: null, derivedType: 'string' })
    derivedPool(db)
    const err = await applyFencedDerivedDataMerge(db.pool as never, SHEET, RECORD, { [FIELD]: 2 }).catch((e) => e)
    expect(err).toBeInstanceOf(SheetWriterBlockedError)
    expect(err).toBeInstanceOf(DerivedMergeTargetRetypedError)
    expect(db.recordWrites()).toEqual([])
    expect(db.derivedRechecks().map((s) => s.via)).toEqual(['txn'])
  })

  it('still a formula + flag on ⇒ the merge lands', async () => {
    process.env[FLAG] = 'true'
    process.env[WRITER_FENCE] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: null, derivedType: 'formula' })
    derivedPool(db)
    await applyFencedDerivedDataMerge(db.pool as never, SHEET, RECORD, { [FIELD]: 2 })
    expect(db.recordWrites()).toHaveLength(1)
  })

  it('target retyped + convert flag off ⇒ no re-read, the merge lands (legacy)', async () => {
    process.env[WRITER_FENCE] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: null, derivedType: 'string' })
    derivedPool(db)
    await applyFencedDerivedDataMerge(db.pool as never, SHEET, RECORD, { [FIELD]: 2 })
    expect(db.derivedRechecks()).toEqual([])
    expect(db.recordWrites()).toHaveLength(1)
  })

  it('the formula-engine caller takes its skip branch: returns null (no echo of the refused value), no write', async () => {
    process.env[FLAG] = 'true'
    process.env[WRITER_FENCE] = 'true'
    const db = makeDb({ snapshot: STRING, recheck: null, derivedType: 'string' })
    derivedPool(db)
    const engine = new MultitableFormulaEngine()
    const formula = serializeFieldRow({ id: FIELD, name: 'F', type: 'formula', property: { expression: '=1+1' }, order: 0 })
    const out = await engine.recalculateRecordFromData(db.pool as never, SHEET, RECORD, {}, [formula])
    expect(out).toBeNull()
    expect(db.recordWrites()).toEqual([])
    const control = makeDb({ snapshot: STRING, recheck: null, derivedType: 'formula' })
    derivedPool(control)
    const echoed = await engine.recalculateRecordFromData(control.pool as never, SHEET, RECORD, {}, [formula])
    expect(echoed).toMatchObject({ [FIELD]: 2 })
  })
})

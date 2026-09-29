/**
 * Field retype slice 3a — the post-fence field-schema re-check, per wired writer (fake PG).
 *
 * Design lock docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.11 rows 1–7 and row 13.
 * Each writer is driven through its real code with a fake query that records every statement and answers the
 * field catalogue in two voices: the SNAPSHOT read (what the writer validated against — `string`) and the
 * post-fence RE-READ (the helper's `FOR SHARE` statement — `select` when a conversion committed in between).
 *
 * The gate is TWO flags (fix round R-F1): the convert flag AND the canonical writer fence. For every writer:
 *   both on,  drift     → 409 FIELD_SCHEMA_CHANGED (automation: step fails; derived merge: skipped), ZERO
 *                         `meta_records` writes, and the re-read ran on the WRITER'S transactional query;
 *   both on,  no drift  → the write proceeds (the re-read ran and passed);
 *   convert off (fence on), drift → no re-read issued, the stale write lands (legacy behaviour);
 *   convert on, fence off,  drift → no re-read issued, the stale write lands — the state in which the re-check
 *                         closed new lock cycles with schema edits on real PostgreSQL (see the module note).
 * The structural guard (multitable-field-schema-fence-recheck.guard.test.ts) proves the call sits after the
 * fence and before the first write; this file proves the call does what it claims at each site.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
import {
  SheetWriterBlockedError,
  __resetRecoveryWriterStateColumnProbe,
  isWriterFenceEnabled,
} from '../../src/multitable/canonical-sheet-fence'
import { isFieldRetypeConvertEnabled } from '../../src/multitable/field-retype-convert'
import { serializeFieldRow } from '../../src/multitable/field-codecs'
import { usePinnedServer } from '../utils/pinned-server'

const CONVERT = 'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT'
const WRITER_FENCE = 'MULTITABLE_ENABLE_WRITER_FENCE'
const SHEET = 'sheet_fsr_1'
const FIELD = 'fld_fsr_note'
const RECORD = 'rec_fsr_1'

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
const RECORDS_WRITE = /^(?:UPDATE|INSERT INTO|DELETE FROM) meta_records\b/i

type Stmt = { sql: string; params: unknown[]; via: string }
type Shape = { type: string; options?: string[]; property?: Record<string, unknown> }

function fieldRow(shape: Shape, id = FIELD) {
  return {
    id,
    sheet_id: SHEET,
    name: 'Note',
    type: shape.type,
    property: shape.property ?? (shape.options ? { options: shape.options.map((value) => ({ value })) } : {}),
    order: 0,
  }
}

/**
 * The shared fake. `snapshot` answers every ordinary field-catalogue read; `recheck` answers the helper's FOR SHARE
 * re-read (and the derived variant's). With the writer fence on, the operation ledger probes for its column and
 * revisions return a seq; the recovery block column is reported absent (no durable block).
 */
function makeDb(opts: { snapshot: Shape; recheck: Shape | null; derivedType?: string }) {
  const stmts: Stmt[] = []
  const handler = (via: string) => async (sqlIn: unknown, params: unknown[] = []) => {
    const sql = collapse(String(sqlIn))
    stmts.push({ sql, params, via })
    if (sql === FIELD_SCHEMA_FENCE_RECHECK_SQL) return { rows: opts.recheck ? [fieldRow(opts.recheck)] : [], rowCount: opts.recheck ? 1 : 0 }
    if (sql === DERIVED_MERGE_TARGET_RECHECK_SQL) return { rows: [{ id: FIELD, type: opts.derivedType ?? 'formula' }], rowCount: 1 }
    if (/information_schema/i.test(sql)) {
      return /column_name = 'operation_id'/.test(sql) ? { rows: [{ present: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/pg_current_xact_id/i.test(sql)) return { rows: [{ xid: '7' }], rowCount: 1 }
    if (/type = 'longText'/.test(sql)) return { rows: [], rowCount: 0 }
    if (/FROM meta_fields/i.test(sql)) return { rows: [fieldRow(opts.snapshot)], rowCount: 1 }
    if (/FROM meta_sheets WHERE id = \$1/i.test(sql)) return { rows: [{ id: SHEET, base_id: 'base_fsr', name: 'Sheet', description: null, deleted_at: null }], rowCount: 1 }
    if (/^INSERT INTO meta_record_revisions/i.test(sql)) return { rows: [{ seq: '1' }], rowCount: 1 }
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
    snapshotReads: () => stmts.filter((s) => s.sql === FIELD_SCHEMA_SNAPSHOT_SQL),
    derivedRechecks: () => stmts.filter((s) => s.sql === DERIVED_MERGE_TARGET_RECHECK_SQL),
    recordWrites: () => stmts.filter((s) => RECORDS_WRITE.test(s.sql)),
  }
}
type Db = ReturnType<typeof makeDb>

const STRING: Shape = { type: 'string' }
const SELECT_B: Shape = { type: 'select', options: ['B'] }

function gate(convert: string | undefined, fence: string | undefined): void {
  if (convert === undefined) delete process.env[CONVERT]
  else process.env[CONVERT] = convert
  if (fence === undefined) delete process.env[WRITER_FENCE]
  else process.env[WRITER_FENCE] = fence
}
const bothOn = () => gate('true', 'true')

beforeEach(() => {
  gate(undefined, undefined)
  __resetRecoveryWriterStateColumnProbe()
})
afterEach(() => {
  gate(undefined, undefined)
  vi.restoreAllMocks()
})

// ── the gate ────────────────────────────────────────────────────────────────────────────────────────

describe('the gate — convert flag AND writer fence, one predicate', () => {
  const CONVERT_VALUES = [undefined, '', 'TRUE', '1', ' true', 'true ', 'yes', 'true']
  const FENCE_VALUES = [undefined, '', 'false', 'true', 'TRUE']

  it('on only when the convert flag is exactly "true" AND the writer fence is on', () => {
    for (const c of CONVERT_VALUES) {
      for (const f of FENCE_VALUES) {
        gate(c, f)
        const expected = c === 'true' && String(f ?? '').trim().toLowerCase() === 'true'
        expect(isFieldSchemaFenceRecheckEnabled(), `convert=${JSON.stringify(c)} fence=${JSON.stringify(f)}`).toBe(expected)
      }
    }
  })

  it('C1-F6: it IS the conversion endpoints\' predicate AND the fence predicate — never a copy', () => {
    for (const c of CONVERT_VALUES) {
      for (const f of FENCE_VALUES) {
        gate(c, f)
        expect(isFieldSchemaFenceRecheckEnabled()).toBe(isFieldRetypeConvertEnabled() && isWriterFenceEnabled())
      }
    }
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'multitable', 'field-schema-fence-recheck.ts'), 'utf8')
    expect(source).not.toContain('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT')
    expect(source).toMatch(/return isFieldRetypeConvertEnabled\(\) && isWriterFenceEnabled\(\)/)
  })
})

// ── the helper itself ───────────────────────────────────────────────────────────────────────────────────

describe('assertFieldSchemaUnchangedAfterFence — the helper', () => {
  const snapshot = fieldSchemaSnapshotFromRows([fieldRow(STRING)])

  it('gate off (either flag) ⇒ no query at all, even when the schema drifted', async () => {
    for (const [c, f] of [['TRUE', 'true'], ['true', undefined], ['true', 'false'], [undefined, 'true']] as const) {
      gate(c, f)
      const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
      await expect(assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, snapshot, [FIELD])).resolves.toBeNull()
      expect(db.stmts).toEqual([])
    }
  })

  it('both on, unchanged ⇒ exactly one ordered FOR SHARE re-read of the touched ids, passes', async () => {
    bothOn()
    const db = makeDb({ snapshot: STRING, recheck: STRING })
    await assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, snapshot, [FIELD, FIELD])
    expect(db.stmts).toEqual([{ sql: FIELD_SCHEMA_FENCE_RECHECK_SQL, params: [SHEET, [FIELD]], via: 'txn' }])
    expect(FIELD_SCHEMA_FENCE_RECHECK_SQL).toMatch(/ORDER BY id FOR SHARE$/)
  })

  it('both on, type changed ⇒ 409 FIELD_SCHEMA_CHANGED, values-free', async () => {
    bothOn()
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    const err = await assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, snapshot, [FIELD]).catch((e) => e)
    expect(err).toBeInstanceOf(FieldSchemaChangedError)
    expect(err.code).toBe(FIELD_SCHEMA_CHANGED_CODE)
    expect(err.statusCode).toBe(409)
    for (const leak of [FIELD, SHEET, 'select', 'string', 'B']) expect(err.message).not.toContain(leak)
  })

  it('select option set: a removed or added option is drift; the same set in another order is not', async () => {
    bothOn()
    const selectSnapshot = fieldSchemaSnapshotFromRows([fieldRow({ type: 'select', options: ['A', 'B'] })])
    await expect(assertFieldSchemaUnchangedAfterFence(makeDb({ snapshot: STRING, recheck: { type: 'select', options: ['B', 'A'] } }).txn, SHEET, selectSnapshot, [FIELD])).resolves.not.toThrow()
    await expect(assertFieldSchemaUnchangedAfterFence(makeDb({ snapshot: STRING, recheck: { type: 'select', options: ['A'] } }).txn, SHEET, selectSnapshot, [FIELD])).rejects.toBeInstanceOf(FieldSchemaChangedError)
    await expect(assertFieldSchemaUnchangedAfterFence(makeDb({ snapshot: STRING, recheck: { type: 'select', options: ['A', 'B', 'C'] } }).txn, SHEET, selectSnapshot, [FIELD])).rejects.toBeInstanceOf(FieldSchemaChangedError)
  })

  it('a touched field that no longer exists is drift', async () => {
    bothOn()
    await expect(assertFieldSchemaUnchangedAfterFence(makeDb({ snapshot: STRING, recheck: null }).txn, SHEET, snapshot, [FIELD])).rejects.toBeInstanceOf(FieldSchemaChangedError)
  })

  it('ids the snapshot does not carry, a null snapshot, or nothing touched ⇒ no query', async () => {
    bothOn()
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

  it('loadFieldSchemaSnapshot: gate off ⇒ null and no query (convert on + fence off included); on ⇒ one plain (unlocked) read', async () => {
    const db = makeDb({ snapshot: STRING, recheck: SELECT_B })
    expect(await loadFieldSchemaSnapshot(db.pool, SHEET, [FIELD])).toBeNull()
    gate('true', undefined)
    expect(await loadFieldSchemaSnapshot(db.pool, SHEET, [FIELD])).toBeNull()
    expect(db.stmts).toEqual([])
    bothOn()
    expect(await loadFieldSchemaSnapshot(db.pool, SHEET, [FIELD])).toEqual(new Map([[FIELD, { type: 'string' }]]))
    expect(db.stmts.map((s) => s.sql)).toEqual([FIELD_SCHEMA_SNAPSHOT_SQL])
  })
})

describe('assertDerivedMergeTargetsStillDerived — the row 13 variant', () => {
  it('gate off (either flag) ⇒ no query', async () => {
    for (const [c, f] of [[undefined, 'true'], ['true', undefined]] as const) {
      gate(c, f)
      const db = makeDb({ snapshot: STRING, recheck: null, derivedType: 'string' })
      await assertDerivedMergeTargetsStillDerived(db.txn, SHEET, [FIELD])
      expect(db.stmts).toEqual([])
    }
  })

  it('still a formula / lookup / rollup ⇒ passes', async () => {
    bothOn()
    for (const t of ['formula', 'lookup', 'rollup']) {
      await expect(assertDerivedMergeTargetsStillDerived(makeDb({ snapshot: STRING, recheck: null, derivedType: t }).txn, SHEET, [FIELD])).resolves.toBeUndefined()
    }
  })

  it('retyped ⇒ a SheetWriterBlockedError subclass (the callers\' skip branch), reason derived_target_retyped, state null, values-free', async () => {
    bothOn()
    const err = await assertDerivedMergeTargetsStillDerived(makeDb({ snapshot: STRING, recheck: null, derivedType: 'string' }).txn, SHEET, [FIELD]).catch((e) => e)
    expect(err).toBeInstanceOf(DerivedMergeTargetRetypedError)
    expect(err).toBeInstanceOf(SheetWriterBlockedError)
    expect(err.reason).toBe('derived_target_retyped')
    expect(err.state).toBeNull()
    expect(err.message).not.toContain(FIELD)
  })
})

// ── the writers ───────────────────────────────────────────────────────────────────────────────────────

import { RecordWriteService, type RecordWriteHelpers, type RecordPatchInput } from '../../src/multitable/record-write-service'
import { createRecord as pluginCreateRecord, patchRecord as pluginPatchRecord } from '../../src/multitable/records'
import { RecordService } from '../../src/multitable/record-service'
import { AutomationExecutor, type AutomationDeps, type AutomationRule } from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { poolManager } from '../../src/integration/db/connection-pool'
import { applyFencedDerivedDataMerge } from '../../src/multitable/derived-write-fence'
import { MultitableFormulaEngine } from '../../src/multitable/formula-engine'

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
const ACCESS = { userId: 'u_fsr', permissions: ['multitable:write'], isAdminRole: false }
const txPool = (db: Db) => ({ query: vi.fn(db.pool), transaction: vi.fn(async (fn: (c: { query: unknown }) => unknown) => fn({ query: db.txn })) })

/** A fieldById built the way routes/univer-meta.ts buildFieldMutationGuardMap builds it (serialised field). */
function serializedGuardMap(shape: Shape): Map<string, Record<string, unknown>> {
  const field = serializeFieldRow(fieldRow(shape))
  return new Map([[FIELD, {
    type: field.type,
    readOnly: false,
    hidden: false,
    property: field.property,
    ...(field.type === 'select' || field.type === 'multiSelect' ? { options: (field.options ?? []).map((o) => o.value) } : {}),
  }]])
}

async function runPatchRecords(db: Db, fieldById: Map<string, Record<string, unknown>> = serializedGuardMap(STRING), value: unknown = 'B ') {
  const svc = new RecordWriteService(txPool(db) as never, { emit: vi.fn(), publish: vi.fn() } as never, writeHelpers())
  const field = { id: FIELD, name: 'Note', type: 'string', property: {}, order: 0 }
  return svc.patchRecords({
    sheetId: SHEET,
    changesByRecord: new Map([[RECORD, [{ fieldId: FIELD, value }]]]),
    actorId: 'u_fsr',
    fields: [field],
    visiblePropertyFields: [field],
    visiblePropertyFieldIds: new Set([FIELD]),
    attachmentFields: [],
    fieldById,
    capabilities: CAPS,
    access: ACCESS,
  } as unknown as RecordPatchInput)
}

async function runServicePatch(db: Db) {
  const svc = new RecordService(txPool(db) as never, { emit: vi.fn(), publish: vi.fn() } as never)
  return svc.patchRecord({ recordId: RECORD, sheetId: SHEET, data: { [FIELD]: 'B ' }, actorId: 'u_fsr', access: ACCESS, capabilities: CAPS } as never)
}

const pinned = usePinnedServer()
const VIEW = 'view_fsr_form'

async function formSubmit(db: Db) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(['multitable:read', 'multitable:write']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager: freshPoolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const viewRow = { id: VIEW, sheet_id: SHEET, name: 'Form', type: 'form', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }
  const route = (via: 'pool' | 'txn') => async (sql: string, params?: unknown[]) => {
    if (/FROM (spreadsheet_permissions|field_permissions|view_permissions|meta_view_permissions|record_permissions|formula_dependencies)/.test(sql)) return { rows: [], rowCount: 0 }
    if (/FROM meta_views WHERE id = \$1/.test(sql)) return { rows: [viewRow], rowCount: 1 }
    return (via === 'pool' ? db.pool : db.txn)(sql, params)
  }
  vi.spyOn(freshPoolManager, 'get').mockReturnValue({
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
  try {
    return await request(pinned.url()).post(`/api/multitable/views/${VIEW}/submit`).send({ data: { [FIELD]: 'B ' } })
  } finally {
    vi.doUnmock('../../src/rbac/service')
    vi.resetModules()
  }
}

function automationDeps(db: Db): AutomationDeps {
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
const runAutomation = (db: Db, action: { type: string; config: Record<string, unknown> }) =>
  new AutomationExecutor(automationDeps(db)).execute(rule(action), TRIGGER)

type WritebackInternals = { writeApprovalResultBack(bridge: unknown, config: Record<string, unknown>, event: unknown): Promise<unknown> }
function spyPool(db: Db) {
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query: vi.fn(db.pool),
    transaction: (fn: (c: { query: unknown }) => unknown) => fn({ query: db.txn }),
  } as never)
}
const BRIDGE = { id: 'aab_fsr', sheetId: SHEET, recordId: RECORD, triggerEvent: { actorId: 'u_fsr', recordId: RECORD, _automationDepth: 0 } }
const APPROVED = {
  version: 1, source: 'approval-product', eventType: 'approval.approved', eventId: 'evt_fsr', occurredAt: '2026-09-28T00:00:00.000Z',
  approval: { instanceId: 'ai_fsr', requestNo: 'R-1', templateId: 'tpl', publishedDefinitionId: 'pd' },
  transition: { toStatus: 'approved' }, actor: { id: 'u_fsr' }, requester: { id: 'u_fsr' },
}
async function runWriteback(db: Db) {
  const service = new AutomationService(new EventBus(), {} as never, vi.fn(db.pool) as never) as unknown as WritebackInternals
  spyPool(db)
  return service.writeApprovalResultBack(BRIDGE, { templateId: 'tpl', resultWriteback: { statusField: FIELD } }, APPROVED)
}

async function runDerivedMerge(db: Db) {
  spyPool(db)
  return applyFencedDerivedDataMerge(db.pool as never, SHEET, RECORD, { [FIELD]: 2 })
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
const settle = (p: Promise<unknown>): Promise<Outcome> => p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }))

type Writer = {
  name: string
  run: (db: Db) => Promise<unknown>
  /** derived merge: drift is the target type, not the re-read */
  derived?: boolean
  refused: (o: Outcome) => void
  landed: (o: Outcome) => void
}

const threw = (cls: unknown) => (o: Outcome) => {
  expect(o.ok, 'expected a refusal').toBe(false)
  expect((o as { error: unknown }).error).toBeInstanceOf(cls as never)
}
const resolved = (o: Outcome) => expect(o.ok, String((o as { error?: unknown }).error ?? '')).toBe(true)
const stepFailed = (o: Outcome) => {
  resolved(o)
  const step = ((o as { value: { steps: Array<{ status: string; error?: string }> } }).value.steps)[0]
  expect(step?.status).toBe('failed')
  expect(step?.error).toBe(new FieldSchemaChangedError().message)
}
const stepOk = (o: Outcome) => {
  resolved(o)
  expect(((o as { value: { steps: Array<{ status: string }> } }).value.steps)[0]?.status).toBe('success')
}
const http = (status: number, code?: string) => (o: Outcome) => {
  resolved(o)
  const res = (o as { value: request.Response }).value
  expect(res.status, JSON.stringify(res.body)).toBe(status)
  if (code) expect(res.body.error.code).toBe(code)
}

const WRITERS: Writer[] = [
  { name: 'row 1 RecordWriteService.patchRecords', run: (db) => runPatchRecords(db), refused: threw(FieldSchemaChangedError), landed: resolved },
  { name: 'row 2 plugin SDK patchRecord', run: (db) => pluginPatchRecord({ query: db.txn as never, sheetId: SHEET, recordId: RECORD, changes: { [FIELD]: 'B ' } }), refused: threw(FieldSchemaChangedError), landed: resolved },
  { name: 'row 3 plugin SDK createRecord', run: (db) => pluginCreateRecord({ query: db.txn as never, sheetId: SHEET, data: { [FIELD]: 'B ' } }), refused: threw(FieldSchemaChangedError), landed: resolved },
  { name: 'row 4 RecordService.patchRecord', run: runServicePatch, refused: threw(FieldSchemaChangedError), landed: resolved },
  { name: 'row 5 form submit POST /views/:viewId/submit (CREATE)', run: formSubmit, refused: http(409, 'FIELD_SCHEMA_CHANGED'), landed: http(200) },
  { name: 'row 6 automation update_record', run: (db) => runAutomation(db, { type: 'update_record', config: { fields: { [FIELD]: 'B ' } } }), refused: stepFailed, landed: stepOk },
  { name: 'row 6 automation create_record', run: (db) => runAutomation(db, { type: 'create_record', config: { sheetId: SHEET, data: { [FIELD]: 'B ' } } }), refused: stepFailed, landed: stepOk },
  { name: 'row 7 approval resultWriteback', run: runWriteback, refused: threw(FieldSchemaChangedError), landed: resolved },
  { name: 'row 13 non-scoped derived merge', run: runDerivedMerge, derived: true, refused: threw(DerivedMergeTargetRetypedError), landed: resolved },
]

const driftDb = (w: Writer) => (w.derived ? makeDb({ snapshot: STRING, recheck: null, derivedType: 'string' }) : makeDb({ snapshot: STRING, recheck: SELECT_B }))
const calmDb = (w: Writer) => (w.derived ? makeDb({ snapshot: STRING, recheck: null, derivedType: 'formula' }) : makeDb({ snapshot: STRING, recheck: STRING }))
const recheckStmts = (w: Writer, db: Db) => (w.derived ? db.derivedRechecks() : db.rechecks())

for (const w of WRITERS) {
  describe(w.name, () => {
    it('both flags on, drift ⇒ refused, zero meta_records writes, the re-read ran on the transaction query', async () => {
      bothOn()
      const db = driftDb(w)
      w.refused(await settle(w.run(db)))
      expect(db.recordWrites()).toEqual([])
      expect(recheckStmts(w, db).map((s) => s.via)).toEqual(['txn'])
    })

    it('both flags on, no drift ⇒ the write proceeds', async () => {
      bothOn()
      const db = calmDb(w)
      w.landed(await settle(w.run(db)))
      expect(recheckStmts(w, db)).toHaveLength(1)
      expect(db.recordWrites()).toHaveLength(1)
    })

    it('convert flag off (fence on), drift ⇒ no re-read and no snapshot read, the write lands (legacy)', async () => {
      gate(undefined, 'true')
      const db = driftDb(w)
      w.landed(await settle(w.run(db)))
      expect(recheckStmts(w, db)).toEqual([])
      expect(db.snapshotReads()).toEqual([])
      expect(db.recordWrites()).toHaveLength(1)
    })

    it('R-F1: convert flag on, writer fence OFF, drift ⇒ no re-read and no snapshot read, the write lands', async () => {
      gate('true', undefined)
      const db = driftDb(w)
      w.landed(await settle(w.run(db)))
      expect(recheckStmts(w, db)).toEqual([])
      expect(db.snapshotReads()).toEqual([])
      expect(db.recordWrites()).toHaveLength(1)
    })
  })
}

describe('row 13 — the formula-engine caller takes its skip branch (no echo of the refused value)', () => {
  it('returns null, no write; the control echoes the value', async () => {
    bothOn()
    const db = makeDb({ snapshot: STRING, recheck: null, derivedType: 'string' })
    spyPool(db)
    const engine = new MultitableFormulaEngine()
    const formula = serializeFieldRow({ id: FIELD, name: 'F', type: 'formula', property: { expression: '=1+1' }, order: 0 })
    expect(await engine.recalculateRecordFromData(db.pool as never, SHEET, RECORD, {}, [formula])).toBeNull()
    expect(db.recordWrites()).toEqual([])
    const control = makeDb({ snapshot: STRING, recheck: null, derivedType: 'formula' })
    spyPool(control)
    expect(await engine.recalculateRecordFromData(control.pool as never, SHEET, RECORD, {}, [formula])).toMatchObject({ [FIELD]: 2 })
  })
})

// ── R-F2 (fix round): like with like — raw aliases and plain-string options never refuse without a change ──

import { mapFieldType } from '../../src/multitable/field-codecs'

/**
 * The realtime (Yjs) bridge's field guard, built exactly as src/index.ts builds it from RAW `meta_fields` rows
 * (raw stored type, raw property, options kept as plain strings). The tripwire below fails if index.ts changes that
 * shape, so this copy cannot drift silently.
 */
function realtimeGuardMap(rows: Array<{ id: string; type: string; property: unknown }>): Map<string, Record<string, unknown>> {
  return new Map(rows.map((f) => {
    const prop = (f.property && typeof f.property === 'object' ? f.property : {}) as Record<string, unknown>
    const guard: Record<string, unknown> = { type: f.type, readOnly: false, hidden: false, property: prop }
    if ((f.type === 'select' || f.type === 'multiSelect') && Array.isArray(prop.options)) {
      guard.options = (prop.options as unknown[]).map((o) => (typeof o === 'string' ? o : (o as { value?: unknown })?.value ?? ''))
    }
    return [f.id, guard] as const
  }))
}

/** Every raw spelling mapFieldType accepts, plus case variants of mapped names. */
const RAW_ALIASES = [
  'text', 'longtext', 'long_text', 'long-text', 'textarea', 'multi_line_text', 'multiline', 'checkbox', 'datetime',
  'date_time', 'date-time', 'timestamp', 'multiselect', 'multi_select', 'multi-select', 'bar_code', 'bar-code', 'qr',
  'qr_code', 'qr-code', 'geo', 'geolocation', 'geo_location', 'geo-location', 'autonumber', 'auto_number', 'auto-number',
  'createdtime', 'created_time', 'created-time', 'modifiedtime', 'modified_time', 'modified-time', 'createdby',
  'created_by', 'created-by', 'modifiedby', 'modified_by', 'modified-by', 'Number', 'SELECT', 'String', 'unknown_kind',
]
const MAPPED = [
  'string', 'number', 'boolean', 'date', 'dateTime', 'formula', 'button', 'select', 'multiSelect', 'link', 'person',
  'lookup', 'rollup', 'attachment', 'currency', 'percent', 'rating', 'duration', 'url', 'email', 'phone', 'barcode',
  'qrcode', 'location', 'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy', 'longText',
]

describe('R-F2 — the comparison is like with like, whatever builder made the snapshot', () => {
  it('mapFieldType is idempotent on every mapped name (the premise of normalising the snapshot side)', () => {
    for (const t of MAPPED) expect(mapFieldType(t), t).toBe(t)
    for (const t of RAW_ALIASES) expect(mapFieldType(String(mapFieldType(t))), t).toBe(mapFieldType(t))
  })

  it('tripwire: src/index.ts still builds the realtime guard from the RAW type and property (the shape this file copies)', () => {
    const indexTs = readFileSync(join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8')
    expect(indexTs).toContain("const guard: any = { type: f.type, readOnly: isReadOnly, hidden: isHidden, property: prop }")
    expect(indexTs).toContain("guard.options = prop.options.map((o: any) => typeof o === 'string' ? o : o?.value ?? '')")
  })

  for (const raw of RAW_ALIASES) {
    it(`raw type '${raw}', no change ⇒ no refusal (realtime guard, serialised guard, and rows snapshot)`, async () => {
      bothOn()
      const row = { id: FIELD, type: raw, property: {} }
      for (const snapshot of [realtimeGuardMap([row]), serializedGuardMap({ type: raw }), fieldSchemaSnapshotFromRows([row])]) {
        const db = makeDb({ snapshot: { type: raw }, recheck: { type: raw } })
        await expect(assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, snapshot as never, [FIELD])).resolves.not.toThrow()
        expect(db.rechecks()).toHaveLength(1)
      }
    })
  }

  it('a select whose options are plain strings, no change ⇒ no refusal from any builder', async () => {
    bothOn()
    const property = { options: ['A', 'B'] }
    const row = { id: FIELD, type: 'select', property }
    for (const snapshot of [realtimeGuardMap([row]), serializedGuardMap({ type: 'select', property }), fieldSchemaSnapshotFromRows([row])]) {
      const db = makeDb({ snapshot: { type: 'select', property }, recheck: { type: 'select', property } })
      await expect(assertFieldSchemaUnchangedAfterFence(db.txn, SHEET, snapshot as never, [FIELD])).resolves.not.toThrow()
    }
  })

  it('a real change still refuses on a raw-shaped snapshot: raw text → select, and an option removed', async () => {
    bothOn()
    await expect(assertFieldSchemaUnchangedAfterFence(
      makeDb({ snapshot: { type: 'text' }, recheck: SELECT_B }).txn, SHEET, realtimeGuardMap([{ id: FIELD, type: 'text', property: {} }]) as never, [FIELD],
    )).rejects.toBeInstanceOf(FieldSchemaChangedError)
    const two = { options: [{ value: 'A' }, { value: 'B' }] }
    await expect(assertFieldSchemaUnchangedAfterFence(
      makeDb({ snapshot: { type: 'select', property: two }, recheck: { type: 'select', options: ['A'] } }).txn, SHEET,
      realtimeGuardMap([{ id: FIELD, type: 'select', property: two }]) as never, [FIELD],
    )).rejects.toBeInstanceOf(FieldSchemaChangedError)
  })

  it('row 1 through the realtime-shaped guard: text / longtext / plain-string select stored raw, no change ⇒ every write lands', async () => {
    bothOn()
    for (const [shape, value] of [[{ type: 'text' }, 'hello'], [{ type: 'longtext' }, 'hi'], [{ type: 'select', property: { options: ['A', 'B'] } }, 'A']] as const) {
      const db = makeDb({ snapshot: shape, recheck: shape })
      await expect(runPatchRecords(db, realtimeGuardMap([{ id: FIELD, type: shape.type, property: (shape as Shape).property ?? {} }]), value)).resolves.toBeDefined()
      expect(db.rechecks()).toHaveLength(1)
      expect(db.recordWrites()).toHaveLength(1)
    }
  })
})

// ── ADR §3.12 (fix round, R-22): option validation for automation update_record / create_record, gated ──

import { classifySelectCellValue } from '../../src/multitable/field-codecs'
import {
  AUTOMATION_WRITE_VALUE_INVALID_CODE,
  AutomationWriteValueInvalidError,
  validateAutomationOptionValues,
} from '../../src/multitable/field-schema-fence-recheck'

const SELECT_AB: Shape = { type: 'select', options: ['A', 'B'] }
const MULTI_AB: Shape = { type: 'multiSelect', options: ['A', 'B'] }
const updateWith = (value: unknown) => ({ type: 'update_record', config: { fields: { [FIELD]: value } } })
const createWith = (value: unknown) => ({ type: 'create_record', config: { sheetId: SHEET, data: { [FIELD]: value } } })
const writtenCell = (db: Db): unknown => {
  const stmt = db.recordWrites()[0]
  if (!stmt) return undefined
  const json = /^UPDATE/i.test(stmt.sql) ? stmt.params[0] : stmt.params[2]
  return (JSON.parse(String(json)) as Record<string, unknown>)[FIELD]
}
const stepOf = (exec: unknown) => (exec as { steps: Array<{ status: string; error?: string }> }).steps[0]

describe('§3.12 — the shared select rule', () => {
  it('classifySelectCellValue: non-string refused, "" allowed, otherwise an option', () => {
    expect(classifySelectCellValue('A', ['A', 'B'])).toBe('ok')
    expect(classifySelectCellValue('', ['A'])).toBe('ok')
    expect(classifySelectCellValue('Z', ['A'])).toBe('not_in_options')
    expect(classifySelectCellValue('A ', ['A'])).toBe('not_in_options') // no trim on select (the write paths do not trim)
    for (const v of [null, undefined, 5, true, ['A'], { value: 'A' }]) expect(classifySelectCellValue(v, ['A']), JSON.stringify(v)).toBe('not_string')
  })

  it('RecordWriteService.validateChanges applies the same rule (parity with the classifier)', async () => {
    bothOn()
    for (const [value, verdict] of [['A', 'ok'], ['', 'ok'], ['Z', 'not_in_options'], [5, 'not_string']] as const) {
      expect(classifySelectCellValue(value, ['A', 'B'])).toBe(verdict)
      const outcome = await settle(runPatchRecords(makeDb({ snapshot: SELECT_AB, recheck: SELECT_AB }), serializedGuardMap(SELECT_AB), value))
      expect(outcome.ok, `${JSON.stringify(value)} → ${verdict}`).toBe(verdict === 'ok')
    }
  })

  it('validateAutomationOptionValues: null (gate off) validates nothing', () => {
    expect(validateAutomationOptionValues(null, { [FIELD]: 'Z' })).toEqual({})
  })
})

describe('§3.12 — automation update_record / create_record, gate ON', () => {
  for (const [kind, action] of [['update_record', updateWith], ['create_record', createWith]] as const) {
    it(`${kind}: select value in the options ("A") and the empty cell ("") ⇒ success, written as given`, async () => {
      bothOn()
      for (const value of ['A', '']) {
        const db = makeDb({ snapshot: SELECT_AB, recheck: SELECT_AB })
        expect(stepOf(await runAutomation(db, action(value)))?.status).toBe('success')
        expect(writtenCell(db)).toBe(value)
      }
    })

    it(`${kind}: select value outside the options ⇒ step failed, values-free (field id + reason), zero writes`, async () => {
      bothOn()
      const db = makeDb({ snapshot: SELECT_AB, recheck: SELECT_AB })
      const step = stepOf(await runAutomation(db, action('Zeta-not-an-option')))
      expect(step?.status).toBe('failed')
      expect(step?.error).toBe(new AutomationWriteValueInvalidError(FIELD, 'select_value_not_in_options').message)
      expect(step?.error).not.toContain('Zeta')
      expect(db.recordWrites()).toEqual([])
    })

    it(`${kind}: a non-string select value ⇒ step failed (select_value_not_string), zero writes`, async () => {
      bothOn()
      const db = makeDb({ snapshot: SELECT_AB, recheck: SELECT_AB })
      const step = stepOf(await runAutomation(db, action(5)))
      expect(step?.error).toBe(new AutomationWriteValueInvalidError(FIELD, 'select_value_not_string').message)
      expect(db.recordWrites()).toEqual([])
    })

    it(`${kind}: multiSelect is trimmed and de-duplicated like the record write paths; an item outside the options fails, values-free`, async () => {
      bothOn()
      const ok = makeDb({ snapshot: MULTI_AB, recheck: MULTI_AB })
      expect(stepOf(await runAutomation(ok, action([' A ', 'A', 'B', ''])))?.status).toBe('success')
      expect(writtenCell(ok)).toEqual(['A', 'B'])
      const bad = makeDb({ snapshot: MULTI_AB, recheck: MULTI_AB })
      const step = stepOf(await runAutomation(bad, action(['A', 'Zeta-not-an-option'])))
      expect(step?.error).toBe(new AutomationWriteValueInvalidError(FIELD, 'multiselect_value_invalid').message)
      expect(step?.error).not.toContain('Zeta')
      expect(bad.recordWrites()).toEqual([])
    })

    it(`${kind}: the validation reads nothing extra — one pre-fence snapshot read and one post-fence re-read`, async () => {
      bothOn()
      const db = makeDb({ snapshot: SELECT_AB, recheck: SELECT_AB })
      await runAutomation(db, action('A'))
      expect(db.snapshotReads().map((s) => s.via)).toEqual(['pool'])
      expect(db.rechecks().map((s) => s.via)).toEqual(['txn'])
    })
  }

  it('the error code is stable', () => {
    expect(new AutomationWriteValueInvalidError(FIELD, 'select_value_not_in_options').code).toBe(AUTOMATION_WRITE_VALUE_INVALID_CODE)
  })
})

describe('§3.12 — gate OFF (either flag): automation writes exactly as today, including values outside the options', () => {
  for (const [c, f] of [[undefined, 'true'], ['true', undefined], ['TRUE', 'true']] as const) {
    for (const [kind, action] of [['update_record', updateWith], ['create_record', createWith]] as const) {
      it(`${kind}, convert=${JSON.stringify(c)} fence=${JSON.stringify(f)}: an out-of-options value lands unvalidated`, async () => {
        gate(c, f)
        const db = makeDb({ snapshot: SELECT_AB, recheck: SELECT_AB })
        expect(stepOf(await runAutomation(db, action('Zeta-not-an-option')))?.status).toBe('success')
        expect(writtenCell(db)).toBe('Zeta-not-an-option')
        expect(db.rechecks()).toEqual([])
        expect(db.snapshotReads()).toEqual([])
      })
    }
  }
})

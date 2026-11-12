import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventBus } from '../../src/integration/events/event-bus'
import { normalizeJson } from '../../src/multitable/field-codecs'
import {
  COPY_SHEET_RECORD_CAPABILITIES,
  RecordPatchFieldValidationError,
  RecordService,
  RecordValidationError,
  type ConnectionPool,
  type QueryFn,
} from '../../src/multitable/record-service'
import {
  RecordWriteService,
  RecordValidationError as BatchValidationError,
  type RecordPatchInput,
  type RecordWriteHelpers,
  type UniverMetaField,
} from '../../src/multitable/record-write-service'

vi.mock('../../src/multitable/realtime-publish', () => ({ publishMultitableSheetRealtime: vi.fn() }))

const fields: UniverMetaField[] = [
  { id: 'day', name: 'Day', type: 'date', order: 0 },
  { id: 'title', name: 'Title', type: 'string', order: 1 },
  { id: 'rich', name: 'Rich', type: 'longText', property: { rich: true }, order: 2 },
  { id: 'when', name: 'When', type: 'dateTime', property: { timezone: 'Asia/Tokyo' }, order: 3 },
]
const capabilities = {
  canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
  canManageFields: true, canManageSheetAccess: true, canManageViews: true, canComment: true,
  canManageAutomation: true, canExport: true, canSendNotification: true, canSubmitApproval: false,
}
const access = { userId: 'user', permissions: [], isAdminRole: false }

function fixture() {
  const rows = new Map<string, Record<string, unknown>>([
    ['record_a', { day: 'legacy-invalid', title: 'before' }],
    ['record_b', { day: '2024-02-29', title: 'before' }],
  ])
  const query = vi.fn<QueryFn>(async (sql, params = []) => {
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('information_schema.columns')) return { rows: [] }
    if (sql.includes('FROM meta_sheets')) return { rows: [{ id: 'sheet' }] }
    if (sql.includes('FROM meta_fields')) return { rows: fields }
    if (sql.includes('FROM meta_record_subscriptions')) return { rows: [] }
    if (sql.includes('FROM meta_records')) {
      return { rows: [...rows].map(([id, data]) => ({ id, data, version: 1, created_by: 'user', locked: false })) }
    }
    if (sql.includes('INSERT INTO meta_records')) {
      rows.set(String(params[0]), JSON.parse(String(params[2])))
      return { rows: [{ version: 1 }] }
    }
    if (sql.includes('UPDATE meta_records')) {
      const recordId = String(params[sql.includes('WHERE sheet_id = $2') ? 2 : 1])
      const data = { ...rows.get(recordId) }
      for (const fieldId of (params[4] ?? []) as string[]) delete data[fieldId]
      rows.set(recordId, { ...data, ...JSON.parse(String(params[0])) })
      return { rows: [{ version: 2 }] }
    }
    if (sql.includes('INSERT INTO meta_record_revisions')) return { rows: [], rowCount: 1 }
    throw new Error(`Unexpected synthetic SQL: ${sql}`)
  })
  const transaction = vi.fn(async <Result>(handler: (client: { query: QueryFn }) => Promise<Result>) => {
    const snapshot = structuredClone(rows)
    try {
      return await handler({ query })
    } catch (error) {
      rows.clear()
      for (const [recordId, data] of snapshot) rows.set(recordId, data)
      throw error
    }
  })
  const pool: ConnectionPool = { query, transaction }
  const eventBus = { emit: vi.fn() }
  const helpers: RecordWriteHelpers = {
    normalizeLinkIds: (value) => Array.isArray(value) ? value.map(String) : [],
    normalizeAttachmentIds: (value) => Array.isArray(value) ? value.map(String) : [],
    normalizeJson,
    parseLinkFieldConfig: () => null,
    buildId: (prefix) => `${prefix}_synthetic`,
    ensureRecordWriteAllowed: () => true,
    filterRecordDataByFieldIds: (data) => normalizeJson(data),
    extractLookupRollupData: () => ({}),
    mergeComputedRecords: (base, extra) => [...(base ?? []), ...extra],
    filterRecordFieldSummaryMap: (summary) => summary,
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
  }
  return {
    rows, query, transaction, eventBus,
    writes: () => query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)),
    service: new RecordService(pool, eventBus as unknown as EventBus),
    batch: new RecordWriteService(pool, eventBus as unknown as EventBus, helpers),
  }
}

function batchInput(changesByRecord: RecordPatchInput['changesByRecord']): RecordPatchInput {
  return {
    sheetId: 'sheet', actorId: 'user', changesByRecord, fields, visiblePropertyFields: fields,
    visiblePropertyFieldIds: new Set(fields.map((field) => field.id)), attachmentFields: [],
    fieldById: new Map(fields.map((field) => [field.id, { type: field.type, property: field.property, hidden: false, readOnly: false }])),
    capabilities, access,
  }
}

beforeEach(() => vi.clearAllMocks())

const invalidData = [
  { day: '2026-02-29' }, { day: '1900-02-29' }, { day: '2024-02-30T12:00:00Z' },
  { title: 'a\u0000b' }, { title: { nested: ['a', { ['key\u0000']: 'safe' }] } },
  { title: { nested: ['a', { value: '\u0000' }] } }, { ['title\u0000']: 'safe' },
  { rich: '<p>a\u0000b</p>' },
]

describe.each(['create', 'patch'] as const)('RecordService %s validation', (operation) => {
  function write(service: RecordService, data: Record<string, unknown>) {
    return operation === 'create'
      ? service.createRecord({ sheetId: 'sheet', data, capabilities, actorId: 'user' })
      : service.patchRecord({ sheetId: 'sheet', recordId: 'record_a', data, capabilities, access })
  }

  it.each(invalidData)('rejects invalid input with existing HTTP-mapped types: %j', async (data) => {
    const state = fixture()
    const before = structuredClone(state.rows)
    const error = await write(state.service, data).catch((caught: unknown) => caught)
    if (operation === 'patch' && 'day' in data) {
      expect(error).toBeInstanceOf(RecordPatchFieldValidationError)
      expect(error).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400, fieldErrors: { day: expect.any(String) } })
    } else {
      expect(error).toBeInstanceOf(RecordValidationError)
      expect(error).toMatchObject({ code: 'VALIDATION_ERROR' })
    }
    expect(state.writes()).toEqual([])
    expect(state.rows).toEqual(before)
    expect(state.eventBus.emit).not.toHaveBeenCalled()
  })

  it.each(['2024-02-29', '2000-02-29', '', null])('persists valid/empty date and safe strings: %j', async (day) => {
    const state = fixture()
    await write(state.service, { day, title: '中文\\u0000\n', rich: '<p>safe</p>' })
    const statement = state.writes().find(([sql]) => /(?:INSERT INTO|UPDATE) meta_records\b/.test(sql))!
    expect(JSON.parse(String(statement[1]![operation === 'create' ? 2 : 0])))
      .toEqual({ day, title: '中文\\u0000\n', rich: '<p>safe</p>' })
  })

  it('wraps a final serializer rejection as a service validation error', async () => {
    const state = fixture()
    let reads = 0
    const data = { get title() { reads += 1; return reads === 1 ? 'safe' : 'unsafe\u0000' } }
    await expect(write(state.service, data)).rejects.toBeInstanceOf(RecordValidationError)
    expect(state.writes()).toEqual([])
    expect(state.eventBus.emit).not.toHaveBeenCalled()
  })
})

describe('RecordWriteService whole-batch validation', () => {
  it.each(invalidData)('rejects a bad second row before opening a transaction: %j', async (data) => {
    const state = fixture()
    const before = structuredClone(state.rows)
    const input = batchInput(new Map([
      ['record_a', [{ fieldId: 'title', value: 'would-write' }]],
      ['record_b', Object.entries(data).map(([fieldId, value]) => ({ fieldId, value }))],
    ]))
    await expect(state.batch.patchRecords(input)).rejects.toBeInstanceOf(BatchValidationError)
    expect(state.transaction).not.toHaveBeenCalled()
    expect(state.writes()).toEqual([])
    expect(state.rows).toEqual(before)
    expect(state.eventBus.emit).not.toHaveBeenCalled()
  })

  it('writes valid days and dateTime with unchanged normalization', async () => {
    const state = fixture()
    await state.batch.patchRecords(batchInput(new Map([
      ['record_a', [{ fieldId: 'day', value: '2000-02-29' }, { fieldId: 'when', value: '2026-09-24 09:00' }]],
      ['record_b', [{ fieldId: 'day', value: '' }]],
    ])))
    expect(state.rows.get('record_a')).toMatchObject({ day: '2000-02-29', when: '2026-09-24T00:00:00.000Z' })
    expect(state.rows.get('record_b')).toMatchObject({ day: '' })
  })

  it('keeps unset value ignored and old dirty dates unchanged on unrelated writes', async () => {
    const state = fixture()
    await state.batch.patchRecords(batchInput(new Map([
      ['record_a', [{ fieldId: 'title', value: 'after' }]],
      ['record_b', [{ fieldId: 'day', value: 'ignored\u0000', op: 'unset' }]],
    ])))
    expect(state.rows.get('record_a')).toEqual({ day: 'legacy-invalid', title: 'after' })
    expect(state.rows.get('record_b')).toEqual({ title: 'before' })
  })

  it('preserves historic date values on the server restore path', async () => {
    const state = fixture()
    const input = batchInput(new Map([['record_a', [{ fieldId: 'day', value: '2026-02-30' }]]]))
    await state.batch.patchRecords({ ...input, source: 'restore', restoredFromVersion: 1 })
    expect(state.rows.get('record_a')?.day).toBe('2026-02-30')
  })

  it('wraps final serialization failures and rolls back an earlier synthetic row write', async () => {
    const state = fixture()
    const before = structuredClone(state.rows)
    let serializations = 0
    const value = { toJSON() { serializations += 1; return serializations === 1 ? 'safe' : 'unsafe\u0000' } }
    const input = batchInput(new Map([
      ['record_a', [{ fieldId: 'title', value: 'would-write' }]],
      ['record_b', [{ fieldId: 'title', value }]],
    ]))
    await expect(state.batch.patchRecords(input)).rejects.toBeInstanceOf(BatchValidationError)
    expect(state.writes().filter(([sql]) => sql.includes('UPDATE meta_records'))).toHaveLength(1)
    expect(state.rows).toEqual(before)
    expect(state.eventBus.emit).not.toHaveBeenCalled()
  })
})

it('preserves old dates during copy while rejecting the same new create', async () => {
  const state = fixture()
  const data = { day: '2026-02-30' }
  const copied = await state.service.createRecord({
    sheetId: 'sheet', data, actorId: 'user', capabilities: COPY_SHEET_RECORD_CAPABILITIES,
    copy: { ordinal: 0, startedAt: new Date('2026-11-11T00:00:00Z'), batchId: 'synthetic-copy', createdBy: 'user' },
  })
  expect(copied.data).toEqual(data)
  await expect(state.service.createRecord({ sheetId: 'sheet', data, actorId: 'user', capabilities }))
    .rejects.toBeInstanceOf(RecordValidationError)
})

it('single patch leaves existing dirty dates and dateTime behavior unchanged', async () => {
  const state = fixture()
  await state.service.patchRecord({
    sheetId: 'sheet', recordId: 'record_a', data: { title: 'after', when: '2026-09-24 09:00' }, capabilities, access,
  })
  expect(state.rows.get('record_a')).toEqual({ day: 'legacy-invalid', title: 'after', when: '2026-09-24 09:00' })
})

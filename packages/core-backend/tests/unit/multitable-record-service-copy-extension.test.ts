/**
 * `RecordService.createRecord` copy-sheet extension (ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md
 * §7.3, CS-13, CS-19, CS-21) — the ONLY change to the record write entry point.
 *
 *   C1  capabilities MUST be the server constant object itself: an equal-shaped clone is refused BEFORE any
 *       read (RecordPermissionError, zero statements).
 *   C2  INSERT carries `created_at = startedAt + ordinal µs` and `created_by = copy.createdBy` (source creator
 *       preserved), `modified_by = actorId` (copier) — CS-13. The REST path is untouched (created_by = actor).
 *   C3  revision row: `source = 'copy-sheet'`, `batch_id = copy.batchId` (one batch per copy).
 *   C4  CS-19 suppression: no legacy eventBus emit, no realtime publish, no durable enqueue (flag ON), no
 *       formula hook — while the REST path on the same fixture still emits / publishes (positive control).
 *   C5  CS-21 shape-only: out-of-set select option copied as-is; multiSelect array copied without the option
 *       set; person ids copied WITHOUT the roster (no candidate query issued); `property.validation`
 *       (required) not run. Shape violations still refuse WITH `fieldId` (a non-array multiSelect).
 *   C6  what stays: readonly (system/derived) fields still refused; link targets still checked and a miss
 *       refuses with `fieldId` + code (message never used by the route); autoNumber still allocated.
 *   C7  a malformed copy context (negative ordinal) refuses with code COPY_CONTEXT_INVALID.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COPY_SHEET_RECORD_CAPABILITIES,
  COPY_SHEET_REVISION_SOURCE,
  RecordFieldForbiddenError,
  RecordPermissionError,
  RecordService,
  RecordValidationError,
  RecordValidationFailedError,
  type ConnectionPool,
  type QueryFn,
} from '../../src/multitable/record-service'

const mockPublish = vi.fn()
vi.mock('../../src/multitable/realtime-publish', () => ({
  publishMultitableSheetRealtime: (...args: unknown[]) => mockPublish(...args),
}))

type QueryResponse = { rows: unknown[]; rowCount?: number | null }

const restCapabilities = {
  canRead: true,
  canCreateRecord: true,
  canEditRecord: true,
  canDeleteRecord: true,
  canManageFields: true,
  canManageSheetAccess: true,
  canManageViews: true,
  canComment: true,
  canManageAutomation: true,
  canExport: true,
  canSendNotification: true,
  canSubmitApproval: false,
}

const FIELDS = [
  { id: 'fld_title', name: 'Title', type: 'string', property: { validation: [{ type: 'required' }] } },
  { id: 'fld_status', name: 'Status', type: 'select', property: { options: [{ value: 'open' }, { value: 'done' }] } },
  { id: 'fld_tags', name: 'Tags', type: 'multiSelect', property: { options: [{ value: 'a' }, { value: 'b' }] } },
  { id: 'fld_owner', name: 'Owner', type: 'person', property: { limitSingleRecord: false } },
  { id: 'fld_seq', name: 'Seq', type: 'autoNumber', property: {} },
  { id: 'fld_created', name: 'Created', type: 'createdTime', property: {} },
  { id: 'fld_link', name: 'Link', type: 'link', property: { foreignSheetId: 'sheet_foreign', limitSingleRecord: false } },
]

function createMockEventBus() {
  return { emit: vi.fn(), publish: vi.fn(), subscribe: vi.fn().mockReturnValue('sub_1'), unsubscribe: vi.fn() }
}

function createMockPool(): ConnectionPool & { statements: Array<{ sql: string; params: unknown[] }> } {
  const statements: Array<{ sql: string; params: unknown[] }> = []
  const queryMock = vi.fn(async (sql: string, params: unknown[] = []): Promise<QueryResponse> => {
    statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
    if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '4242' }] }
    if (sql.includes('INSERT INTO meta_automation_outbox_consumer')) return { rows: [], rowCount: 1 }
    if (sql.includes('INSERT INTO meta_automation_outbox')) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) return { rows: [{ id: 'sheet_new' }] }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) return { rows: FIELDS }
    if (sql.includes('SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
      const ids = params[1] as string[]
      return { rows: ids.filter((id) => id !== 'rec_missing').map((id) => ({ id })) }
    }
    if (sql.includes('WITH user_candidates AS')) return { rows: [] } // person roster (must NOT be hit on copy)
    if (sql.includes('INSERT INTO meta_records') && sql.includes('RETURNING version')) return { rows: [{ version: 1 }] }
    if (sql.includes('INSERT INTO meta_record_revisions')) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
    if (sql.includes('INSERT INTO meta_field_auto_number_sequences')) return { rows: [{ start_value: 7 }], rowCount: 1 }
    if (sql.includes('INSERT INTO meta_links')) return { rows: [], rowCount: 1 }
    if (sql.includes('information_schema.columns')) return { rows: [] }
    return { rows: [], rowCount: 0 }
  })
  return {
    query: queryMock as QueryFn,
    transaction: vi.fn(async <T>(handler: (client: { query: QueryFn }) => Promise<T>) => handler({ query: queryMock as QueryFn })),
    statements,
  }
}

const STARTED_AT = new Date('2026-09-27T08:00:00.000Z')
const copyCtx = (ordinal: number, createdBy: string | null = 'user_source') => ({
  batchId: 'batch_copy_1',
  ordinal,
  startedAt: STARTED_AT,
  createdBy,
})

describe('RecordService.createRecord — copy-sheet extension (ADR §7.3)', () => {
  let pool: ReturnType<typeof createMockPool>
  let eventBus: ReturnType<typeof createMockEventBus>
  const originalDurable = process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED

  beforeEach(() => {
    vi.clearAllMocks()
    pool = createMockPool()
    eventBus = createMockEventBus()
    delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
  })
  afterEach(() => {
    if (originalDurable === undefined) delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    else process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = originalDurable
  })

  it('C1: refuses an equal-shaped capability clone before any read; accepts the constant itself', async () => {
    const service = new RecordService(pool, eventBus as never)
    await expect(service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'x' },
      actorId: 'user_copier',
      capabilities: { ...COPY_SHEET_RECORD_CAPABILITIES },
      copy: copyCtx(0),
    })).rejects.toBeInstanceOf(RecordPermissionError)
    expect(pool.statements).toHaveLength(0)

    await expect(service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'x' },
      actorId: 'user_copier',
      capabilities: restCapabilities,
      copy: copyCtx(0),
    })).rejects.toBeInstanceOf(RecordPermissionError)
    expect(pool.statements).toHaveLength(0)

    const ok = await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'x' },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: copyCtx(0),
    })
    expect(ok.recordId).toMatch(/^rec_/)
    expect(Object.isFrozen(COPY_SHEET_RECORD_CAPABILITIES)).toBe(true)
    expect(COPY_SHEET_RECORD_CAPABILITIES.canCreateRecord).toBe(true)
    expect(Object.entries(COPY_SHEET_RECORD_CAPABILITIES).filter(([k, v]) => k !== 'canCreateRecord' && v === true)).toEqual([])
  })

  it('C2/C3: ordinal created_at + preserved created_by + copier modified_by; revision source/batch', async () => {
    const service = new RecordService(pool, eventBus as never)
    const result = await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'Alpha' },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: copyCtx(1238, 'user_source'),
    })

    const insert = pool.statements.find((s) => s.sql.startsWith('INSERT INTO meta_records ('))
    expect(insert).toBeDefined()
    expect(insert!.sql).toContain('created_at')
    expect(insert!.sql).toContain("$6::timestamptz + ($7::int * interval '1 microsecond')")
    expect(insert!.params).toEqual([
      result.recordId,
      'sheet_new',
      JSON.stringify({ fld_title: 'Alpha', fld_seq: 7 }),
      'user_source', // created_by = SOURCE creator (CS-13)
      'user_copier', // modified_by = copier
      STARTED_AT.toISOString(),
      1238,
    ])

    const revision = pool.statements.find((s) => s.sql.startsWith('INSERT INTO meta_record_revisions'))
    expect(revision).toBeDefined()
    expect(revision!.params[5]).toBe(COPY_SHEET_REVISION_SOURCE)
    expect(revision!.params[10]).toBe('batch_copy_1')
    expect(revision!.params[6]).toBe('user_copier')
  })

  it('C2 control: the REST path still writes created_by = actor and no explicit created_at', async () => {
    const service = new RecordService(pool, eventBus as never)
    await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'Alpha', fld_status: 'open' },
      actorId: 'user_1',
      capabilities: restCapabilities,
    })
    const insert = pool.statements.find((s) => s.sql.startsWith('INSERT INTO meta_records ('))
    expect(insert!.sql).not.toContain('created_at')
    expect(insert!.params[3]).toBe('user_1')
    const revision = pool.statements.find((s) => s.sql.startsWith('INSERT INTO meta_record_revisions'))
    expect(revision!.params[5]).toBe('rest')
  })

  it('C4: no legacy emit, no realtime, no formula hook on the copy path; REST control still emits', async () => {
    const service = new RecordService(pool, eventBus as never)
    const hook = vi.fn(async () => [])
    service.setFormulaRecalcHook(hook as never)

    await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'Alpha' },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: copyCtx(0),
    })
    expect(eventBus.emit).not.toHaveBeenCalled()
    expect(mockPublish).not.toHaveBeenCalled()
    expect(hook).not.toHaveBeenCalled()

    await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'Alpha' },
      actorId: 'user_1',
      capabilities: restCapabilities,
    })
    expect(eventBus.emit).toHaveBeenCalledWith('multitable.record.created', expect.objectContaining({ sheetId: 'sheet_new' }))
    expect(mockPublish).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it('C4 durable leg: with AUTOMATION_DURABLE_DELIVERY_ENABLED=true the copy path enqueues NOTHING; REST control enqueues', async () => {
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
    const service = new RecordService(pool, eventBus as never)

    await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'Alpha' },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: copyCtx(0),
    })
    expect(pool.statements.some((s) => s.sql.includes('meta_automation_outbox'))).toBe(false)
    expect(pool.statements.some((s) => s.sql.includes('pg_current_xact_id'))).toBe(false)
    expect(eventBus.emit).not.toHaveBeenCalled()

    pool.statements.length = 0
    await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'Alpha' },
      actorId: 'user_1',
      capabilities: restCapabilities,
    })
    expect(pool.statements.some((s) => s.sql.includes('INSERT INTO meta_automation_outbox'))).toBe(true)
  })

  it('C5: shape-only — out-of-set select, multiSelect without option set, person without roster, no property.validation', async () => {
    const service = new RecordService(pool, eventBus as never)
    const result = await service.createRecord({
      sheetId: 'sheet_new',
      data: {
        // fld_title (required) deliberately ABSENT — property.validation must not run on copy
        fld_status: 'archived', // not in the option set
        fld_tags: ['zzz', 'a', 'zzz'], // 'zzz' not in the set; deduped
        fld_owner: ['user_deactivated', 'user_other'],
      },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: copyCtx(3),
    })
    expect(result.data).toEqual({
      fld_status: 'archived',
      fld_tags: ['zzz', 'a'],
      fld_owner: ['user_deactivated', 'user_other'],
      fld_seq: 7,
    })
    // the person roster is never consulted on the copy path
    expect(pool.statements.some((s) => s.sql.includes('WITH user_candidates AS'))).toBe(false)

    // Positive control: the same payload on the REST path is refused (select option + validation).
    await expect(service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_status: 'archived' },
      actorId: 'user_1',
      capabilities: restCapabilities,
    })).rejects.toBeInstanceOf(RecordValidationError)
    await expect(service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_status: 'open' },
      actorId: 'user_1',
      capabilities: restCapabilities,
    })).rejects.toBeInstanceOf(RecordValidationFailedError) // required fld_title
  })

  it('C5b: a SHAPE violation still refuses, with fieldId (never a value in the code)', async () => {
    const service = new RecordService(pool, eventBus as never)
    const err = await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_tags: 'not-an-array' },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: copyCtx(0),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(RecordValidationError)
    expect((err as RecordValidationError).fieldId).toBe('fld_tags')
    expect((err as RecordValidationError).code).toBe('VALIDATION_ERROR')
    expect(pool.statements.some((s) => s.sql.startsWith('INSERT INTO meta_records ('))).toBe(false)
  })

  it('C6: readonly fields still refused; a missing link target refuses with fieldId + LINK_TARGET_NOT_FOUND; autoNumber allocated', async () => {
    const service = new RecordService(pool, eventBus as never)
    await expect(service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_created: '2026-01-01' },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: copyCtx(0),
    })).rejects.toBeInstanceOf(RecordFieldForbiddenError)

    const linkErr = await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_link: ['rec_ok', 'rec_missing'] },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: copyCtx(0),
    }).catch((e) => e)
    expect(linkErr).toBeInstanceOf(RecordValidationError)
    expect((linkErr as RecordValidationError).fieldId).toBe('fld_link')
    expect((linkErr as RecordValidationError).code).toBe('LINK_TARGET_NOT_FOUND')

    pool.statements.length = 0
    const ok = await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_link: ['rec_ok'] },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: copyCtx(5),
    })
    expect(ok.data).toEqual({ fld_link: ['rec_ok'], fld_seq: 7 })
    expect(pool.statements.some((s) => s.sql.startsWith('INSERT INTO meta_field_auto_number_sequences'))).toBe(true)
    expect(pool.statements.some((s) => s.sql.startsWith('INSERT INTO meta_links'))).toBe(true)
  })

  it('C7: a malformed copy context is refused with COPY_CONTEXT_INVALID before any read', async () => {
    const service = new RecordService(pool, eventBus as never)
    const err = await service.createRecord({
      sheetId: 'sheet_new',
      data: { fld_title: 'x' },
      actorId: 'user_copier',
      capabilities: COPY_SHEET_RECORD_CAPABILITIES,
      copy: { ...copyCtx(0), ordinal: -1 },
    }).catch((e) => e)
    expect(err).toBeInstanceOf(RecordValidationError)
    expect((err as RecordValidationError).code).toBe('COPY_CONTEXT_INVALID')
    expect(pool.statements).toHaveLength(0)
  })
})

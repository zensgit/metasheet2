import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  RecordWriteService,
  VersionConflictError,
  RecordNotFoundError,
  RecordValidationError,
  RecordFieldForbiddenError,
  type ConnectionPool,
  type RecordWriteHelpers,
  type RecordPatchInput,
  type UniverMetaField,
  type UniverMetaRecord,
} from '../../src/multitable/record-write-service'

// ---------------------------------------------------------------------------
// Mock: publishMultitableSheetRealtime
// ---------------------------------------------------------------------------
const mockPublish = vi.fn()
vi.mock('../../src/multitable/realtime-publish', () => ({
  publishMultitableSheetRealtime: (...args: unknown[]) => mockPublish(...args),
}))

// ---------------------------------------------------------------------------
// Helpers factory
// ---------------------------------------------------------------------------

function createMockHelpers(overrides: Partial<RecordWriteHelpers> = {}): RecordWriteHelpers {
  return {
    normalizeLinkIds: (v) => (Array.isArray(v) ? v.map(String) : []),
    normalizeAttachmentIds: (v) => (Array.isArray(v) ? v.map(String) : []),
    normalizeJson: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}),
    parseLinkFieldConfig: () => null,
    buildId: (prefix) => `${prefix}_test123`,
    ensureRecordWriteAllowed: () => true,
    filterRecordDataByFieldIds: (data, ids) => {
      if (!data || typeof data !== 'object') return {}
      return Object.fromEntries(
        Object.entries(data as Record<string, unknown>).filter(([k]) => ids.has(k)),
      )
    },
    extractLookupRollupData: () => ({}),
    mergeComputedRecords: (base, extra) => {
      if ((!base || base.length === 0) && extra.length === 0) return undefined
      return [...(base ?? []), ...extra]
    },
    filterRecordFieldSummaryMap: (map) => map,
    serializeLinkSummaryMap: () => ({}),
    serializeAttachmentSummaryMap: () => ({}),
    applyLookupRollup: vi.fn().mockResolvedValue(undefined),
    computeDependentLookupRollupRecords: vi.fn().mockResolvedValue([]),
    loadLinkValuesByRecord: vi.fn().mockResolvedValue(new Map()),
    buildLinkSummaries: vi.fn().mockResolvedValue(new Map()),
    buildAttachmentSummaries: vi.fn().mockResolvedValue(new Map()),
    ensureAttachmentIdsExist: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

function createMockPool(queryResponses: Record<string, { rows: unknown[] }> = {}): ConnectionPool {
  const defaultQueryResponse = { rows: [] }

  const queryFn = vi.fn(async (sql: string, _params?: unknown[]) => {
    // Match SQL patterns to return the correct responses
    if (sql.includes('SELECT id, version, created_by FROM meta_records') && sql.includes('FOR UPDATE')) {
      return queryResponses['SELECT_FOR_UPDATE'] ?? { rows: [{ id: 'rec1', version: 1, created_by: 'user1' }] }
    }
    if (sql.includes('UPDATE meta_records')) {
      return queryResponses['UPDATE'] ?? { rows: [{ version: 2 }] }
    }
    if (sql.includes('SELECT id, version, data FROM meta_records')) {
      return queryResponses['SELECT_UPDATED'] ?? defaultQueryResponse
    }
    if (sql.includes('SELECT id FROM meta_records WHERE sheet_id')) {
      return queryResponses['SELECT_LINK_TARGETS'] ?? { rows: [] }
    }
    return defaultQueryResponse
  })

  return {
    query: queryFn,
    transaction: vi.fn(async <T>(handler: (client: { query: typeof queryFn }) => Promise<T>) => {
      return handler({ query: queryFn })
    }),
  }
}

// ---------------------------------------------------------------------------
// Mock eventBus factory
// ---------------------------------------------------------------------------

function createMockEventBus() {
  return {
    emit: vi.fn(),
    publish: vi.fn(),
    subscribe: vi.fn().mockReturnValue('sub_1'),
    unsubscribe: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Shared test input builder
// ---------------------------------------------------------------------------

function buildTestFields(): UniverMetaField[] {
  return [
    { id: 'fld_name', name: 'Name', type: 'string', order: 0 },
    { id: 'fld_age', name: 'Age', type: 'number', order: 1 },
  ]
}

function buildTestInput(
  overrides: Partial<RecordPatchInput> = {},
): RecordPatchInput {
  const fields = buildTestFields()
  const fieldById = new Map(
    fields.map((f) => [f.id, { type: f.type, readOnly: false, hidden: false }]),
  )
  const changesByRecord = new Map([
    ['rec1', [{ fieldId: 'fld_name', value: 'Alice' }]],
  ])

  return {
    sheetId: 'sheet1',
    changesByRecord,
    actorId: 'user1',
    fields,
    visiblePropertyFields: fields,
    visiblePropertyFieldIds: new Set(fields.map((f) => f.id)),
    attachmentFields: [],
    fieldById: fieldById as any,
    capabilities: {
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
    },
    access: { userId: 'user1', permissions: [], isAdminRole: false },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecordWriteService', () => {
  let pool: ReturnType<typeof createMockPool>
  let eventBus: ReturnType<typeof createMockEventBus>
  let helpers: RecordWriteHelpers

  beforeEach(() => {
    vi.clearAllMocks()
    pool = createMockPool()
    eventBus = createMockEventBus()
    helpers = createMockHelpers()
  })

  it('should execute the full patch pipeline and return updated records', async () => {
    const service = new RecordWriteService(pool, eventBus as any, helpers)
    const input = buildTestInput()

    const result = await service.patchRecords(input)

    expect(result.updated).toHaveLength(1)
    expect(result.updated[0]).toEqual({ recordId: 'rec1', version: 2 })
  })

  it('should call eventBus.emit with correct payload', async () => {
    const service = new RecordWriteService(pool, eventBus as any, helpers)
    const input = buildTestInput()

    await service.patchRecords(input)

    expect(eventBus.emit).toHaveBeenCalledTimes(1)
    expect(eventBus.emit).toHaveBeenCalledWith('multitable.record.updated', {
      sheetId: 'sheet1',
      recordId: 'rec1',
      changes: { fld_name: 'Alice' },
      actorId: 'user1',
    })
  })

  it('should call publishMultitableSheetRealtime', async () => {
    const service = new RecordWriteService(pool, eventBus as any, helpers)
    const input = buildTestInput()

    await service.patchRecords(input)

    expect(mockPublish).toHaveBeenCalledTimes(1)
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: 'sheet1',
        kind: 'record-updated',
        recordIds: ['rec1'],
      }),
    )
  })

  it('should throw VersionConflictError when expectedVersion does not match', async () => {
    pool = createMockPool({
      SELECT_FOR_UPDATE: { rows: [{ id: 'rec1', version: 5, created_by: 'user1' }] },
    })
    const service = new RecordWriteService(pool, eventBus as any, helpers)

    const changesByRecord = new Map([
      ['rec1', [{ fieldId: 'fld_name', value: 'Alice', expectedVersion: 3 }]],
    ])
    const input = buildTestInput({ changesByRecord })

    await expect(service.patchRecords(input)).rejects.toThrow(VersionConflictError)
    await expect(service.patchRecords(input)).rejects.toMatchObject({
      serverVersion: 5,
      recordId: 'rec1',
    })
  })

  it('should throw RecordNotFoundError when record does not exist', async () => {
    pool = createMockPool({
      SELECT_FOR_UPDATE: { rows: [] },
    })
    const service = new RecordWriteService(pool, eventBus as any, helpers)
    const input = buildTestInput()

    await expect(service.patchRecords(input)).rejects.toThrow(RecordNotFoundError)
  })

  it('should handle link field mutations by validating targets exist', async () => {
    const linkHelpers = createMockHelpers({
      normalizeLinkIds: () => ['foreign_rec1'],
      parseLinkFieldConfig: () => ({ foreignSheetId: 'sheet2', limitSingleRecord: false }),
    })

    const linkField: UniverMetaField = {
      id: 'fld_link',
      name: 'Related',
      type: 'link',
      order: 2,
      property: { foreignSheetId: 'sheet2' },
    }

    const linkPool = createMockPool({
      SELECT_FOR_UPDATE: { rows: [{ id: 'rec1', version: 1, created_by: 'user1' }] },
      UPDATE: { rows: [{ version: 2 }] },
      SELECT_LINK_TARGETS: { rows: [{ id: 'foreign_rec1' }] },
    })

    const fields = [...buildTestFields(), linkField]
    const fieldById = new Map([
      ...buildTestFields().map((f) => [f.id, { type: f.type, readOnly: false, hidden: false }] as const),
      ['fld_link', { type: 'link' as const, readOnly: false, hidden: false, link: { foreignSheetId: 'sheet2', limitSingleRecord: false } }],
    ])

    const changesByRecord = new Map([
      ['rec1', [{ fieldId: 'fld_link', value: ['foreign_rec1'] }]],
    ])

    const input = buildTestInput({
      fields,
      visiblePropertyFields: fields,
      visiblePropertyFieldIds: new Set(fields.map((f) => f.id)),
      fieldById: fieldById as any,
      changesByRecord,
    })

    const service = new RecordWriteService(linkPool, eventBus as any, linkHelpers)
    const result = await service.patchRecords(input)

    expect(result.updated).toHaveLength(1)
  })

  it('should throw RecordValidationError when linked records are missing', async () => {
    const linkHelpers = createMockHelpers({
      normalizeLinkIds: () => ['missing_rec'],
    })

    const linkPool = createMockPool({
      SELECT_FOR_UPDATE: { rows: [{ id: 'rec1', version: 1, created_by: 'user1' }] },
      SELECT_LINK_TARGETS: { rows: [] },
    })

    const fieldById = new Map([
      ['fld_link', { type: 'link' as const, readOnly: false, hidden: false, link: { foreignSheetId: 'sheet2', limitSingleRecord: false } }],
    ])

    const changesByRecord = new Map([
      ['rec1', [{ fieldId: 'fld_link', value: ['missing_rec'] }]],
    ])

    const input = buildTestInput({
      fieldById: fieldById as any,
      changesByRecord,
    })

    const service = new RecordWriteService(linkPool, eventBus as any, linkHelpers)
    await expect(service.patchRecords(input)).rejects.toThrow(RecordValidationError)
  })

  it('should trigger computed field recalculation when lookup/rollup fields exist', async () => {
    const fieldsWithLookup: UniverMetaField[] = [
      { id: 'fld_name', name: 'Name', type: 'string', order: 0 },
      { id: 'fld_lookup', name: 'Lookup', type: 'lookup', order: 1, property: {} },
    ]

    const lookupPool = createMockPool({
      SELECT_FOR_UPDATE: { rows: [{ id: 'rec1', version: 1, created_by: 'user1' }] },
      UPDATE: { rows: [{ version: 2 }] },
      SELECT_UPDATED: { rows: [{ id: 'rec1', version: 2, data: { fld_name: 'Alice' } }] },
    })

    const input = buildTestInput({
      fields: fieldsWithLookup,
      visiblePropertyFields: fieldsWithLookup,
      visiblePropertyFieldIds: new Set(fieldsWithLookup.map((f) => f.id)),
    })

    const service = new RecordWriteService(lookupPool, eventBus as any, helpers)
    await service.patchRecords(input)

    expect(helpers.applyLookupRollup).toHaveBeenCalled()
  })

  it('should not emit events when no records are updated', async () => {
    // Pass a formula field change with invalid value (not starting with =), so applied === 0
    const changesByRecord = new Map([
      ['rec1', [{ fieldId: 'fld_formula', value: 123 }]],
    ])
    // Add formula field to fieldById so validation passes
    const fieldByIdWithFormula = new Map([
      ['fld_formula', { type: 'formula' as const, readOnly: false, hidden: false }],
    ])
    const input = buildTestInput({ changesByRecord, fieldById: fieldByIdWithFormula })
    const service = new RecordWriteService(pool, eventBus as any, helpers)
    const result = await service.patchRecords(input)

    expect(result.updated).toHaveLength(0)
    expect(eventBus.emit).not.toHaveBeenCalled()
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('should throw RecordValidationError when record editing is not allowed', async () => {
    const restrictedHelpers = createMockHelpers({
      ensureRecordWriteAllowed: () => false,
    })

    const service = new RecordWriteService(pool, eventBus as any, restrictedHelpers)
    const input = buildTestInput()

    await expect(service.patchRecords(input)).rejects.toThrow(RecordValidationError)
  })

  // -----------------------------------------------------------------------
  // validateChanges — field writability and value constraint tests
  // -----------------------------------------------------------------------

  describe('validateChanges', () => {
    it('rejects multiple expectedVersion values for same record', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const changesByRecord = new Map([
        ['rec1', [
          { fieldId: 'fld1', value: 'a', expectedVersion: 1 },
          { fieldId: 'fld2', value: 'b', expectedVersion: 2 },
        ]],
      ])
      const fieldById = new Map([
        ['fld1', { type: 'string' as const, readOnly: false, hidden: false }],
        ['fld2', { type: 'string' as const, readOnly: false, hidden: false }],
      ])

      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(RecordValidationError)
      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(/Multiple expectedVersion/)
    })

    it('rejects unknown fieldId', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const changesByRecord = new Map([
        ['rec1', [{ fieldId: 'nonexistent', value: 'x' }]],
      ])
      const fieldById = new Map<string, any>()

      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(RecordValidationError)
      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(/Unknown fieldId/)
    })

    it('rejects hidden field', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const changesByRecord = new Map([
        ['rec1', [{ fieldId: 'fld1', value: 'x' }]],
      ])
      const fieldById = new Map([
        ['fld1', { type: 'string' as const, readOnly: false, hidden: true }],
      ])

      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(RecordFieldForbiddenError)
    })

    it('rejects readOnly field', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const changesByRecord = new Map([
        ['rec1', [{ fieldId: 'fld1', value: 'x' }]],
      ])
      const fieldById = new Map([
        ['fld1', { type: 'string' as const, readOnly: true, hidden: false }],
      ])

      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(RecordFieldForbiddenError)
    })

    it('rejects lookup/rollup fields', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      for (const type of ['lookup', 'rollup'] as const) {
        const changesByRecord = new Map([
          ['rec1', [{ fieldId: 'fld1', value: 'x' }]],
        ])
        const fieldById = new Map([
          ['fld1', { type, readOnly: false, hidden: false }],
        ])

        await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
          .rejects.toThrow(RecordFieldForbiddenError)
      }
    })

    it('rejects invalid select option', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const changesByRecord = new Map([
        ['rec1', [{ fieldId: 'fld1', value: 'invalid' }]],
      ])
      const fieldById = new Map([
        ['fld1', { type: 'select' as const, readOnly: false, hidden: false, options: ['a', 'b'] }],
      ])

      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(RecordValidationError)
      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(/Invalid select option/)
    })

    it('rejects link field with multiple records when limitSingleRecord', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const changesByRecord = new Map([
        ['rec1', [{ fieldId: 'fld1', value: ['r1', 'r2'] }]],
      ])
      const fieldById = new Map([
        ['fld1', { type: 'link' as const, readOnly: false, hidden: false, link: { foreignSheetId: 's2', limitSingleRecord: true } }],
      ])

      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(RecordValidationError)
      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(/single record/)
    })

    it('passes valid changes', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const changesByRecord = new Map([
        ['rec1', [
          { fieldId: 'fld1', value: 'hello', expectedVersion: 1 },
          { fieldId: 'fld2', value: 42, expectedVersion: 1 },
        ]],
      ])
      const fieldById = new Map([
        ['fld1', { type: 'string' as const, readOnly: false, hidden: false }],
        ['fld2', { type: 'number' as const, readOnly: false, hidden: false }],
      ])

      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .resolves.not.toThrow()
    })
  })
})

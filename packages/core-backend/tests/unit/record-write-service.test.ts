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
import { createYjsInvalidationPostCommitHook } from '../../src/multitable/post-commit-hooks'

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
    if (sql.includes('SELECT id, version, data, created_by FROM meta_records') && sql.includes('FOR UPDATE')) {
      return queryResponses['SELECT_FOR_UPDATE'] ?? { rows: [{ id: 'rec1', version: 1, data: { fld_name: 'Before' }, created_by: 'user1' }] }
    }
    if (sql.includes('UPDATE meta_records')) {
      return queryResponses['UPDATE'] ?? { rows: [{ version: 2 }] }
    }
    if (sql.includes('INSERT INTO meta_record_revisions')) {
      return queryResponses['INSERT_REVISION'] ?? { rows: [], rowCount: 1 }
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

  it('persists modified_by with the patch actor', async () => {
    const service = new RecordWriteService(pool, eventBus as any, helpers)

    await service.patchRecords(buildTestInput({ actorId: 'user_editor' }))

    const updateCall = (pool.query as any).mock.calls.find((call: unknown[]) =>
      typeof call[0] === 'string' && call[0].includes('UPDATE meta_records'),
    )
    expect(updateCall[0]).toContain('modified_by = $4')
    expect(updateCall[1]).toEqual([
      JSON.stringify({ fld_name: 'Alice' }),
      'sheet1',
      'rec1',
      'user_editor',
    ])
  })

  it('writes one record revision for each authoritative patch', async () => {
    const service = new RecordWriteService(pool, eventBus as any, helpers)

    await service.patchRecords(buildTestInput({ actorId: 'user_editor' }))

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO meta_record_revisions'),
      expect.arrayContaining([
        expect.any(String),
        'sheet1',
        'rec1',
        2,
        'update',
        'rest',
        'user_editor',
        ['fld_name'],
        JSON.stringify({ fld_name: 'Alice' }),
        JSON.stringify({ fld_name: 'Alice' }),
      ]),
    )
  })

  it('preserves yjs-bridge as the record revision source', async () => {
    const service = new RecordWriteService(pool, eventBus as any, helpers)

    await service.patchRecords(buildTestInput({ source: 'yjs-bridge' }))

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO meta_record_revisions'),
      expect.arrayContaining(['yjs-bridge']),
    )
  })

  it('preserves longText multiline values in the shared write path', async () => {
    const service = new RecordWriteService(pool, eventBus as any, helpers)
    const fields: UniverMetaField[] = [
      { id: 'fld_notes', name: 'Notes', type: 'longText', order: 0 },
    ]
    const input = buildTestInput({
      fields,
      visiblePropertyFields: fields,
      visiblePropertyFieldIds: new Set(['fld_notes']),
      fieldById: new Map([
        ['fld_notes', { type: 'longText' as const, readOnly: false, hidden: false }],
      ]) as any,
      changesByRecord: new Map([
        ['rec1', [{ fieldId: 'fld_notes', value: 'line 1\n  line 2\n' }]],
      ]),
    })

    await service.patchRecords(input)

    const updateCall = (pool.query as any).mock.calls.find((call: unknown[]) =>
      typeof call[0] === 'string' && call[0].includes('UPDATE meta_records'),
    )
    expect(JSON.parse(updateCall[1][0])).toEqual({
      fld_notes: 'line 1\n  line 2\n',
    })
  })

  it('rejects non-string longText writes in the shared write path', async () => {
    const service = new RecordWriteService(pool, eventBus as any, helpers)
    const fields: UniverMetaField[] = [
      { id: 'fld_notes', name: 'Notes', type: 'longText', order: 0 },
    ]
    const input = buildTestInput({
      fields,
      visiblePropertyFields: fields,
      visiblePropertyFieldIds: new Set(['fld_notes']),
      fieldById: new Map([
        ['fld_notes', { type: 'longText' as const, readOnly: false, hidden: false }],
      ]) as any,
      changesByRecord: new Map([
        ['rec1', [{ fieldId: 'fld_notes', value: ['line'] }]],
      ]),
    })

    await expect(service.patchRecords(input)).rejects.toThrow(RecordValidationError)
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

    it('rejects scalar or invalid multiSelect options', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const fieldById = new Map([
        ['fld_tags', { type: 'multiSelect' as const, readOnly: false, hidden: false, options: ['a', 'b'] }],
      ])

      await expect(service.validateChanges({
        sheetId: 's1',
        changesByRecord: new Map([['rec1', [{ fieldId: 'fld_tags', value: 'a' }]]]),
        fieldById,
      })).rejects.toThrow(/must be an array/)

      await expect(service.validateChanges({
        sheetId: 's1',
        changesByRecord: new Map([['rec1', [{ fieldId: 'fld_tags', value: ['x'] }]]]),
        fieldById,
      })).rejects.toThrow(/Invalid multi-select option/)
    })

    it('passes valid multiSelect array changes', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const fieldById = new Map([
        ['fld_tags', { type: 'multiSelect' as const, readOnly: false, hidden: false, options: ['a', 'b'] }],
      ])

      await expect(service.validateChanges({
        sheetId: 's1',
        changesByRecord: new Map([['rec1', [{ fieldId: 'fld_tags', value: ['a', 'b'] }]]]),
        fieldById,
      })).resolves.not.toThrow()
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

    it('rejects non-string longText values during preflight validation', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const changesByRecord = new Map([
        ['rec1', [{ fieldId: 'fld_notes', value: { text: 'line' } }]],
      ])
      const fieldById = new Map([
        ['fld_notes', { type: 'longText' as const, readOnly: false, hidden: false }],
      ])

      await expect(service.validateChanges({ sheetId: 's1', changesByRecord, fieldById }))
        .rejects.toThrow(/Long text value must be a string/)
    })
  })

  // -------------------------------------------------------------------------
  // Post-commit wiring (REST → Yjs consistency hook)
  // -------------------------------------------------------------------------
  //
  // These tests prove that `patchRecords` correctly drives the injected
  // invalidator so Yjs snapshots are dropped after REST commits. The
  // isolated `yjs-rest-invalidation.test.ts` covers what `invalidateDocs`
  // actually does; this block proves the HOOK fires at all and respects
  // the `source` field that prevents bridge-originated writes from
  // destroying the live Y.Doc they just read from.
  //
  describe('post-commit hooks', () => {
    it('calls the Yjs invalidation hook with committed record IDs on a default (source unset) patch', async () => {
      const invalidator = vi.fn().mockResolvedValue(undefined)
      const service = new RecordWriteService(pool, eventBus as any, helpers, [
        createYjsInvalidationPostCommitHook(invalidator),
      ])

      await service.patchRecords(buildTestInput())

      expect(invalidator).toHaveBeenCalledTimes(1)
      expect(invalidator).toHaveBeenCalledWith(['rec1'])
    })

    it('invalidates before realtime broadcast and eventBus notification', async () => {
      const invalidator = vi.fn().mockResolvedValue(undefined)
      const service = new RecordWriteService(pool, eventBus as any, helpers, [
        createYjsInvalidationPostCommitHook(invalidator),
      ])

      await service.patchRecords(buildTestInput())

      expect(invalidator).toHaveBeenCalledOnce()
      expect(mockPublish).toHaveBeenCalledOnce()
      expect(eventBus.emit).toHaveBeenCalledOnce()
      expect(invalidator.mock.invocationCallOrder[0]).toBeLessThan(mockPublish.mock.invocationCallOrder[0])
      expect(invalidator.mock.invocationCallOrder[0]).toBeLessThan(eventBus.emit.mock.invocationCallOrder[0])
    })

    it('runs post-commit hooks before post-transaction recompute helpers', async () => {
      const invalidator = vi.fn().mockResolvedValue(undefined)
      const service = new RecordWriteService(pool, eventBus as any, helpers, [
        createYjsInvalidationPostCommitHook(invalidator),
      ])

      await service.patchRecords(buildTestInput())

      expect(invalidator).toHaveBeenCalledOnce()
      expect(helpers.computeDependentLookupRollupRecords).toHaveBeenCalledOnce()
      expect(invalidator.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(helpers.computeDependentLookupRollupRecords).mock.invocationCallOrder[0],
      )
    })

    it('runs post-commit hooks even when later recompute helpers fail', async () => {
      const invalidator = vi.fn().mockResolvedValue(undefined)
      helpers.computeDependentLookupRollupRecords = vi.fn().mockRejectedValue(new Error('recompute failed'))
      const service = new RecordWriteService(pool, eventBus as any, helpers, [
        createYjsInvalidationPostCommitHook(invalidator),
      ])

      await expect(service.patchRecords(buildTestInput())).rejects.toThrow('recompute failed')

      expect(invalidator).toHaveBeenCalledOnce()
    })

    it("calls the invalidator when source === 'rest' (explicit)", async () => {
      const invalidator = vi.fn().mockResolvedValue(undefined)
      const service = new RecordWriteService(pool, eventBus as any, helpers, [
        createYjsInvalidationPostCommitHook(invalidator),
      ])

      await service.patchRecords(buildTestInput({ source: 'rest' }))

      expect(invalidator).toHaveBeenCalledWith(['rec1'])
    })

    it("does NOT call the invalidator when source === 'yjs-bridge'", async () => {
      const invalidator = vi.fn().mockResolvedValue(undefined)
      const service = new RecordWriteService(pool, eventBus as any, helpers, [
        createYjsInvalidationPostCommitHook(invalidator),
      ])

      // The bridge's own writes must not invalidate the Y.Doc they were
      // derived from — that would tear out a live editor mid-session and
      // re-seed from DB that hasn't yet caught up to the bridge's commit.
      await service.patchRecords(buildTestInput({ source: 'yjs-bridge' }))

      expect(invalidator).not.toHaveBeenCalled()
    })

    it('does not fail the REST patch when the invalidator throws', async () => {
      const invalidator = vi.fn().mockRejectedValue(new Error('purge failed'))
      const service = new RecordWriteService(pool, eventBus as any, helpers, [
        createYjsInvalidationPostCommitHook(invalidator),
      ])

      const result = await service.patchRecords(buildTestInput())

      expect(result.updated).toHaveLength(1)
      expect(invalidator).toHaveBeenCalledOnce()
    })

    it('setPostCommitHooks replaces the callable post-construction', async () => {
      const service = new RecordWriteService(pool, eventBus as any, helpers)
      const first = vi.fn().mockResolvedValue(undefined)
      service.setPostCommitHooks([createYjsInvalidationPostCommitHook(first)])

      await service.patchRecords(buildTestInput())
      expect(first).toHaveBeenCalledTimes(1)

      // Replace with empty hooks → no-op, no throw.
      service.setPostCommitHooks([])
      await service.patchRecords(buildTestInput())
      expect(first).toHaveBeenCalledTimes(1) // still 1, no new call
    })

    it('passes every committed record ID (multi-record patch)', async () => {
      const invalidator = vi.fn().mockResolvedValue(undefined)
      const service = new RecordWriteService(pool, eventBus as any, helpers, [
        createYjsInvalidationPostCommitHook(invalidator),
      ])

      // Two records in the same patch. The mock pool returns version=2
      // for any UPDATE regardless of recordId, so both commit.
      const changesByRecord = new Map<string, Array<{ fieldId: string; value: unknown }>>([
        ['rec1', [{ fieldId: 'fld_name', value: 'Alice' }]],
        ['rec2', [{ fieldId: 'fld_name', value: 'Bob' }]],
      ])

      await service.patchRecords(buildTestInput({ changesByRecord }))

      expect(invalidator).toHaveBeenCalledTimes(1)
      const args = invalidator.mock.calls[0][0] as string[]
      expect(args.sort()).toEqual(['rec1', 'rec2'])
    })

    it('keeps running later hooks when an earlier hook throws', async () => {
      const failing = vi.fn().mockRejectedValue(new Error('hook failed'))
      const succeeding = vi.fn().mockResolvedValue(undefined)
      const service = new RecordWriteService(pool, eventBus as any, helpers, [failing, succeeding])

      const result = await service.patchRecords(buildTestInput())

      expect(result.updated).toHaveLength(1)
      expect(failing).toHaveBeenCalledOnce()
      expect(succeeding).toHaveBeenCalledOnce()
    })
  })
})

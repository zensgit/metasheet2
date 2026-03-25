import { describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'
import { bulkImportRecords } from '../src/multitable/import/bulk-import'
import { buildImportedRecords, parseDelimitedText } from '../src/multitable/import/delimited'

describe('multitable import parsing', () => {
  it('parses TSV text into rows', () => {
    const parsed = parseDelimitedText('Name\tAge\nAlice\t30\nBob\t28')
    expect(parsed.delimiter).toBe('\t')
    expect(parsed.rows).toEqual([
      ['Name', 'Age'],
      ['Alice', '30'],
      ['Bob', '28'],
    ])
  })

  it('parses CSV with quoted commas', () => {
    const parsed = parseDelimitedText('Name,Note\n"Alice, A.","says ""hi"""')
    expect(parsed.delimiter).toBe(',')
    expect(parsed.rows).toEqual([
      ['Name', 'Note'],
      ['Alice, A.', 'says "hi"'],
    ])
  })

  it('coerces imported values using field types', async () => {
    const records = await buildImportedRecords({
      parsedRows: [['Alice', '30', 'true', '2026-03-19']],
      fieldMapping: { 0: 'fld_name', 1: 'fld_age', 2: 'fld_active', 3: 'fld_date' },
      fields: [
        { id: 'fld_name', name: 'Name', type: 'string' },
        { id: 'fld_age', name: 'Age', type: 'number' },
        { id: 'fld_active', name: 'Active', type: 'boolean' },
        { id: 'fld_date', name: 'Date', type: 'date' },
      ],
    })
    expect(records.records).toEqual([
      {
        fld_name: 'Alice',
        fld_age: 30,
        fld_active: true,
        fld_date: '2026-03-19',
      },
    ])
    expect(records.rowIndexes).toEqual([0])
    expect(records.failures).toEqual([])
  })

  it('resolves people fields to linked record ids during import', async () => {
    const records = await buildImportedRecords({
      parsedRows: [['Alice <alice@example.com>']],
      fieldMapping: { 0: 'fld_people' },
      fields: [
        {
          id: 'fld_people',
          name: 'People',
          type: 'link',
          property: { refKind: 'user', foreignSheetId: 'sheet_people' },
        },
      ],
      fieldResolvers: {
        fld_people: async (rawValue) => {
          expect(rawValue).toContain('alice@example.com')
          return ['rec_person_1']
        },
      },
    })

    expect(records.records).toEqual([{ fld_people: ['rec_person_1'] }])
    expect(records.rowIndexes).toEqual([0])
    expect(records.failures).toEqual([])
  })

  it('reports unresolved people values as preflight failures', async () => {
    const records = await buildImportedRecords({
      parsedRows: [['Unknown Person']],
      fieldMapping: { 0: 'fld_people' },
      fields: [
        {
          id: 'fld_people',
          name: 'People',
          type: 'link',
          property: { refKind: 'user', foreignSheetId: 'sheet_people' },
        },
      ],
      fieldResolvers: {
        fld_people: async () => null,
      },
    })

    expect(records.records).toEqual([])
    expect(records.rowIndexes).toEqual([])
    expect(records.failures).toEqual([
      expect.objectContaining({
        rowIndex: 0,
        retryable: false,
        message: 'Unable to resolve people value for People: Unknown Person',
      }),
    ])
  })

  it('prefers field overrides over people resolution failures', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('Multiple people match "Owner". Use email for an exact match.')
    })

    const records = await buildImportedRecords({
      parsedRows: [['Owner']],
      fieldMapping: { 0: 'fld_people' },
      fields: [
        {
          id: 'fld_people',
          name: 'People',
          type: 'link',
          property: { refKind: 'user', foreignSheetId: 'sheet_people', limitSingleRecord: true },
        },
      ],
      fieldResolvers: {
        fld_people: resolver,
      },
      fieldOverrides: {
        0: {
          fld_people: ['rec_person_fixed'],
        },
      },
    })

    expect(records.records).toEqual([{ fld_people: ['rec_person_fixed'] }])
    expect(records.rowIndexes).toEqual([0])
    expect(records.failures).toEqual([])
    expect(resolver).not.toHaveBeenCalled()
  })
})

describe('multitable bulk import', () => {
  it('imports all records via createRecord', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { record: { id: 'rec_1', version: 1, data: {} } } }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    const result = await bulkImportRecords({
      client,
      sheetId: 'sheet_ops',
      viewId: 'view_grid',
      records: [{ fld_name: 'A' }, { fld_name: 'B' }],
    })

    expect(result).toEqual({ attempted: 2, succeeded: 2, failed: 0, firstError: null, failures: [] })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('reports partial failures instead of swallowing them', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { record: { id: 'rec_1', version: 1, data: {} } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: 'Invalid select option' } }), { status: 400 }))
    const client = new MultitableApiClient({ fetchFn })

    const result = await bulkImportRecords({
      client,
      sheetId: 'sheet_ops',
      records: [{ fld_name: 'A' }, { fld_name: 'B' }],
    })

    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.attempted).toBe(2)
    expect(result.firstError).toBe('Invalid select option')
    expect(result.failures).toEqual([
      { index: 1, message: 'Invalid select option', status: 400, code: undefined, retryable: false },
    ])
  })

  it('marks transient server failures as retryable', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: 'Temporary outage' } }), { status: 503 }))
    const client = new MultitableApiClient({ fetchFn })

    const result = await bulkImportRecords({
      client,
      sheetId: 'sheet_ops',
      records: [{ fld_name: 'A' }],
    })

    expect(result.failures).toEqual([
      { index: 0, message: 'Temporary outage', status: 503, code: undefined, retryable: true },
    ])
  })
})

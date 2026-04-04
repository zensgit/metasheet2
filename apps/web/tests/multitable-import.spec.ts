import { describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'
import { bulkImportRecords, skipDuplicateImportRows } from '../src/multitable/import/bulk-import'
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

  it('supports generic linked-record resolvers during import', async () => {
    const records = await buildImportedRecords({
      parsedRows: [['Acme Supply']],
      fieldMapping: { 0: 'fld_vendor' },
      fields: [
        {
          id: 'fld_vendor',
          name: 'Vendor',
          type: 'link',
          property: { foreignSheetId: 'sheet_vendors', limitSingleRecord: true },
        },
      ],
      fieldResolvers: {
        fld_vendor: async (rawValue) => {
          expect(rawValue).toBe('Acme Supply')
          return ['rec_vendor_1']
        },
      },
    })

    expect(records.records).toEqual([{ fld_vendor: ['rec_vendor_1'] }])
    expect(records.rowIndexes).toEqual([0])
    expect(records.failures).toEqual([])
  })

  it('fails link rows when the workbench has no resolver for the field', async () => {
    const records = await buildImportedRecords({
      parsedRows: [['Vendor']],
      fieldMapping: { 0: 'fld_vendor' },
      fields: [
        {
          id: 'fld_vendor',
          name: 'Vendor',
          type: 'link',
          property: { foreignSheetId: 'sheet_vendors', limitSingleRecord: true },
        },
      ],
      fieldResolvers: {},
    })

    expect(records.records).toEqual([])
    expect(records.rowIndexes).toEqual([])
    expect(records.failures).toEqual([
      expect.objectContaining({
        rowIndex: 0,
        fieldId: 'fld_vendor',
        fieldName: 'Vendor',
        retryable: false,
        message: 'No import resolver is configured for linked field Vendor',
      }),
    ])
  })

  it('skips duplicate rows using the primary import field against existing and in-batch values', () => {
    const result = skipDuplicateImportRows({
      records: [
        { fld_name: 'Alpha', fld_status: 'Open' },
        { fld_name: 'alpha', fld_status: 'Closed' },
        { fld_name: 'Beta', fld_status: 'Open' },
      ],
      rowIndexes: [0, 1, 2],
      primaryFieldId: 'fld_name',
      primaryFieldName: 'Name',
      existingKeys: ['beta'],
    })

    expect(result.records).toEqual([{ fld_name: 'Alpha', fld_status: 'Open' }])
    expect(result.rowIndexes).toEqual([0])
    expect(result.skippedRows).toEqual([
      expect.objectContaining({
        rowIndex: 1,
        fieldId: 'fld_name',
        skipped: true,
        message: 'Skipped duplicate row because Name already exists: alpha',
      }),
      expect.objectContaining({
        rowIndex: 2,
        fieldId: 'fld_name',
        skipped: true,
        message: 'Skipped duplicate row because Name already exists: Beta',
      }),
    ])
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
      maxRetryAttempts: 0,
    })

    expect(result.failures).toEqual([
      { index: 0, message: 'Temporary outage', status: 503, code: undefined, retryable: true },
    ])
  })

  it('retries retryable failures once using Retry-After when present', async () => {
    const sleepFn = vi.fn(async () => {})
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: 'Rate limited' } }), {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { record: { id: 'rec_1', version: 1, data: {} } } }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    const result = await bulkImportRecords({
      client,
      sheetId: 'sheet_ops',
      records: [{ fld_name: 'A' }],
      sleepFn,
      jitterFn: (delayMs) => delayMs,
    })

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenCalledWith(2000)
    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0, firstError: null, failures: [] })
  })

  it('uses bounded concurrency for larger imports', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const resolvers: Array<() => void> = []
    const fetchFn = vi.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => {
        resolvers.push(() => {
          inFlight -= 1
          resolve()
        })
      })
      return new Response(JSON.stringify({ ok: true, data: { record: { id: `rec_${maxInFlight}`, version: 1, data: {} } } }), { status: 200 })
    })
    const client = new MultitableApiClient({ fetchFn })

    const importPromise = bulkImportRecords({
      client,
      sheetId: 'sheet_ops',
      records: [{ fld_name: 'A' }, { fld_name: 'B' }, { fld_name: 'C' }],
      concurrency: 2,
    })

    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(maxInFlight).toBe(2)

    resolvers.splice(0, 2).forEach((resolve) => resolve())
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    expect(fetchFn).toHaveBeenCalledTimes(3)

    resolvers.splice(0).forEach((resolve) => resolve())
    const result = await importPromise

    expect(maxInFlight).toBe(2)
    expect(result).toEqual({ attempted: 3, succeeded: 3, failed: 0, firstError: null, failures: [] })
  })

  it('uses fallback exponential backoff with jitter when Retry-After is absent', async () => {
    const sleepFn = vi.fn(async () => {})
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: 'Temporary outage' } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { record: { id: 'rec_1', version: 1, data: {} } } }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    const result = await bulkImportRecords({
      client,
      sheetId: 'sheet_ops',
      records: [{ fld_name: 'A' }],
      retryBaseDelayMs: 250,
      sleepFn,
      jitterFn: (delayMs) => delayMs,
    })

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenCalledWith(250)
    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0, firstError: null, failures: [] })
  })

  it('caps server-provided Retry-After delays', async () => {
    const sleepFn = vi.fn(async () => {})
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: 'Rate limited' } }), {
        status: 429,
        headers: { 'Retry-After': '3600' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { record: { id: 'rec_1', version: 1, data: {} } } }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    await bulkImportRecords({
      client,
      sheetId: 'sheet_ops',
      records: [{ fld_name: 'A' }],
      maxRetryDelayMs: 1200,
      sleepFn,
      jitterFn: (delayMs) => delayMs,
    })

    expect(sleepFn).toHaveBeenCalledWith(1200)
  })

  it('returns retryable failures after exhausting retries', async () => {
    const sleepFn = vi.fn(async () => {})
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: 'Temporary outage' } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: 'Temporary outage' } }), { status: 503 }))
    const client = new MultitableApiClient({ fetchFn })

    const result = await bulkImportRecords({
      client,
      sheetId: 'sheet_ops',
      records: [{ fld_name: 'A' }],
      retryBaseDelayMs: 200,
      sleepFn,
      jitterFn: (delayMs) => delayMs,
    })

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenCalledWith(200)
    expect(result.failures).toEqual([
      { index: 0, message: 'Temporary outage', status: 503, code: undefined, retryable: true },
    ])
  })

  it('aborts an in-flight import before later chunks start', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined
      const abort = () => reject(Object.assign(new Error('Import cancelled'), { name: 'AbortError' }))
      if (!signal) {
        reject(new Error('Missing AbortSignal'))
        return
      }
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
    }))
    const client = new MultitableApiClient({ fetchFn })

    const importPromise = bulkImportRecords({
      client,
      sheetId: 'sheet_ops',
      records: [{ fld_name: 'A' }, { fld_name: 'B' }],
      concurrency: 1,
      signal: controller.signal,
    })

    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    controller.abort()

    await expect(importPromise).rejects.toMatchObject({ name: 'AbortError', message: 'Import cancelled' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

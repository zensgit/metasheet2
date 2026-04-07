import { describe, expect, it } from 'vitest'

import {
  createRecord,
  MultitableRecordNotFoundError,
  MultitableRecordValidationError,
  type MultitableRecordsQueryFn,
} from '../../src/multitable/records'

type FakeSheet = {
  id: string
  base_id: string
  name: string
  description: string | null
}

type FakeField = {
  id: string
  sheet_id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}

type FakeRecord = {
  id: string
  sheet_id: string
  data: Record<string, unknown>
  version: number
}

function createQuery(): {
  query: MultitableRecordsQueryFn
  sheets: FakeSheet[]
  fields: FakeField[]
  records: FakeRecord[]
} {
  const sheets: FakeSheet[] = [{
    id: 'sheet_service_ticket',
    base_id: 'base_legacy',
    name: 'Service Tickets',
    description: null,
  }]
  const fields: FakeField[] = [
    {
      id: 'ticketNo',
      sheet_id: 'sheet_service_ticket',
      name: 'Ticket No',
      type: 'string',
      property: {},
      order: 0,
    },
    {
      id: 'title',
      sheet_id: 'sheet_service_ticket',
      name: 'Title',
      type: 'string',
      property: {},
      order: 1,
    },
    {
      id: 'priority',
      sheet_id: 'sheet_service_ticket',
      name: 'Priority',
      type: 'select',
      property: {
        options: [
          { value: 'low' },
          { value: 'normal' },
          { value: 'high' },
          { value: 'urgent' },
        ],
      },
      order: 2,
    },
    {
      id: 'refundAmount',
      sheet_id: 'sheet_service_ticket',
      name: 'Refund Amount',
      type: 'number',
      property: {},
      order: 3,
    },
  ]
  const records: FakeRecord[] = []

  const query: MultitableRecordsQueryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()

    if (normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
      const [sheetId] = params as [string]
      return { rows: sheets.filter((sheet) => sheet.id === sheetId) }
    }

    if (normalized.includes('FROM meta_fields') && normalized.includes('WHERE sheet_id = $1')) {
      const [sheetId] = params as [string]
      return { rows: fields.filter((field) => field.sheet_id === sheetId) }
    }

    if (normalized.startsWith('INSERT INTO meta_records')) {
      const [id, sheetId, dataJson] = params as [string, string, string]
      const record = {
        id,
        sheet_id: sheetId,
        data: JSON.parse(dataJson),
        version: 1,
      }
      records.push(record)
      return { rows: [{ version: 1 }], rowCount: 1 }
    }

    return { rows: [] }
  }

  return { query, sheets, fields, records }
}

describe('multitable records helper', () => {
  it('creates a record for supported service ticket fields', async () => {
    const { query, records } = createQuery()

    const created = await createRecord({
      query,
      sheetId: 'sheet_service_ticket',
      data: {
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        priority: 'urgent',
        refundAmount: '88.5',
      },
    })

    expect(created.id).toMatch(/^rec_/)
    expect(created.version).toBe(1)
    expect(created.data).toEqual({
      ticketNo: 'TK-1001',
      title: 'Broken compressor',
      priority: 'urgent',
      refundAmount: 88.5,
    })
    expect(records).toHaveLength(1)
  })

  it('throws when the sheet is missing', async () => {
    const { query } = createQuery()

    await expect(createRecord({
      query,
      sheetId: 'sheet_missing',
      data: {},
    })).rejects.toBeInstanceOf(MultitableRecordNotFoundError)
  })

  it('throws when an unknown field is provided', async () => {
    const { query } = createQuery()

    await expect(createRecord({
      query,
      sheetId: 'sheet_service_ticket',
      data: {
        unknownField: 'nope',
      },
    })).rejects.toBeInstanceOf(MultitableRecordValidationError)
  })

  it('throws when a select value is invalid', async () => {
    const { query } = createQuery()

    await expect(createRecord({
      query,
      sheetId: 'sheet_service_ticket',
      data: {
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        priority: 'broken',
      },
    })).rejects.toBeInstanceOf(MultitableRecordValidationError)
  })
})

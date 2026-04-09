import { describe, expect, it } from 'vitest'

import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  MultitableRecordNotFoundError,
  MultitableRecordValidationError,
  queryRecords,
  patchRecord,
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

type FakeLink = {
  field_id: string
  record_id: string
  foreign_record_id: string
}

function createQuery(): {
  query: MultitableRecordsQueryFn
  sheets: FakeSheet[]
  fields: FakeField[]
  records: FakeRecord[]
  links: FakeLink[]
} {
  const sheets: FakeSheet[] = [
    {
      id: 'sheet_service_ticket',
      base_id: 'base_legacy',
      name: 'Service Tickets',
      description: null,
    },
    {
      id: 'sheet_customer',
      base_id: 'base_legacy',
      name: 'Customers',
      description: null,
    },
  ]
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
    {
      id: 'scheduledAt',
      sheet_id: 'sheet_service_ticket',
      name: 'Scheduled At',
      type: 'date',
      property: {},
      order: 4,
    },
    {
      id: 'customerId',
      sheet_id: 'sheet_service_ticket',
      name: 'Customer',
      type: 'link',
      property: {
        foreignSheetId: 'sheet_customer',
        limitSingleRecord: true,
      },
      order: 5,
    },
  ]
  const records: FakeRecord[] = []
  const links: FakeLink[] = []

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

    if (normalized.startsWith('SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
      const [sheetId, ids] = params as [string, string[]]
      const idSet = new Set(ids)
      return {
        rows: records
          .filter((record) => record.sheet_id === sheetId && idSet.has(record.id))
          .map((record) => ({ id: record.id })),
      }
    }

    if (normalized.startsWith('SELECT id, sheet_id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
      const [recordId, sheetId] = params as [string, string]
      return {
        rows: records.filter((record) => record.id === recordId && record.sheet_id === sheetId),
      }
    }

    if (normalized.startsWith('SELECT id, sheet_id, version, data FROM meta_records WHERE sheet_id = $1')) {
      let filtered = records.filter((record) => record.sheet_id === String(params[0]))

      const whereFilters = normalized.match(/data ->(?:>|) \$(\d+)(?: = \$(\d+)| IS NULL)/g) ?? []
      for (const clause of whereFilters) {
        const keyMatch = clause.match(/\$(\d+)/g) ?? []
        if (clause.includes('IS NULL')) {
          const fieldParamIndex = Number(keyMatch[0]?.slice(1))
          const fieldId = String(params[fieldParamIndex - 1])
          filtered = filtered.filter((record) => record.data[fieldId] == null)
          continue
        }
        const fieldParamIndex = Number(keyMatch[0]?.slice(1))
        const valueParamIndex = Number(keyMatch[1]?.slice(1))
        const fieldId = String(params[fieldParamIndex - 1])
        const value = String(params[valueParamIndex - 1])
        filtered = filtered.filter((record) => String(record.data[fieldId]) === value)
      }

      const searchMatch = normalized.match(/data::text ILIKE \$(\d+)/)
      if (searchMatch) {
        const searchIndex = Number(searchMatch[1])
        const pattern = String(params[searchIndex - 1]).replace(/%/g, '')
        filtered = filtered.filter((record) =>
          JSON.stringify(record.data).includes(pattern),
        )
      }

      const orderMatch = normalized.match(/ORDER BY data ->> \$(\d+) (ASC|DESC) NULLS LAST, id ASC/)
      if (orderMatch) {
        const fieldParamIndex = Number(orderMatch[1])
        const fieldId = String(params[fieldParamIndex - 1])
        const direction = orderMatch[2]
        filtered = [...filtered].sort((left, right) => {
          const leftValue = String(left.data[fieldId] ?? '')
          const rightValue = String(right.data[fieldId] ?? '')
          const comparison = leftValue.localeCompare(rightValue)
          return direction === 'DESC' ? -comparison : comparison
        })
      } else if (normalized.includes('ORDER BY id ASC')) {
        filtered = [...filtered].sort((left, right) => left.id.localeCompare(right.id))
      }

      const limitMatch = normalized.match(/LIMIT \$(\d+)/)
      const offsetMatch = normalized.match(/OFFSET \$(\d+)/)
      if (offsetMatch) {
        const offset = Number(params[Number(offsetMatch[1]) - 1])
        filtered = filtered.slice(offset)
      }
      if (limitMatch) {
        const limit = Number(params[Number(limitMatch[1]) - 1])
        filtered = filtered.slice(0, limit)
      }

      return {
        rows: filtered,
      }
    }

    if (normalized.startsWith('UPDATE meta_records')) {
      const [dataJson, recordId, sheetId] = params as [string, string, string]
      const existing = records.find((record) => record.id === recordId && record.sheet_id === sheetId)
      if (!existing) return { rows: [], rowCount: 0 }
      existing.data = JSON.parse(dataJson)
      existing.version += 1
      return {
        rows: [{ version: existing.version }],
        rowCount: 1,
      }
    }

    if (normalized.startsWith('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2')) {
      const [fieldId, recordId] = params as [string, string]
      return {
        rows: links
          .filter((link) => link.field_id === fieldId && link.record_id === recordId)
          .map((link) => ({ foreign_record_id: link.foreign_record_id })),
      }
    }

    if (normalized.startsWith('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY($3::text[])')) {
      const [fieldId, recordId, foreignIds] = params as [string, string, string[]]
      const foreignSet = new Set(foreignIds)
      for (let index = links.length - 1; index >= 0; index -= 1) {
        const link = links[index]
        if (
          link.field_id === fieldId &&
          link.record_id === recordId &&
          foreignSet.has(link.foreign_record_id)
        ) {
          links.splice(index, 1)
        }
      }
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('INSERT INTO meta_links')) {
      const [, fieldId, recordId, foreignRecordId] = params as [string, string, string, string]
      if (!links.find((link) =>
        link.field_id === fieldId &&
        link.record_id === recordId &&
        link.foreign_record_id === foreignRecordId
      )) {
        links.push({
          field_id: fieldId,
          record_id: recordId,
          foreign_record_id: foreignRecordId,
        })
      }
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2')) {
      const [fieldId, recordId] = params as [string, string]
      for (let index = links.length - 1; index >= 0; index -= 1) {
        const link = links[index]
        if (link.field_id === fieldId && link.record_id === recordId) {
          links.splice(index, 1)
        }
      }
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1')) {
      const [recordId] = params as [string]
      for (let index = links.length - 1; index >= 0; index -= 1) {
        const link = links[index]
        if (link.record_id === recordId || link.foreign_record_id === recordId) {
          links.splice(index, 1)
        }
      }
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('DELETE FROM meta_records')) {
      const [recordId, sheetId] = params as [string, string]
      const index = records.findIndex((record) => record.id === recordId && record.sheet_id === sheetId)
      if (index === -1) {
        return { rows: [], rowCount: 0 }
      }
      const [deleted] = records.splice(index, 1)
      return {
        rows: [{ version: deleted.version }],
        rowCount: 1,
      }
    }

    return { rows: [] }
  }

  return { query, sheets, fields, records, links }
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

  it('creates link field values and syncs meta_links', async () => {
    const { query, records, links } = createQuery()
    records.push({
      id: 'cust_1',
      sheet_id: 'sheet_customer',
      data: { name: 'Acme' },
      version: 1,
    })

    const created = await createRecord({
      query,
      sheetId: 'sheet_service_ticket',
      data: {
        ticketNo: 'TK-1001',
        customerId: 'cust_1',
      },
    })

    expect(created.data.customerId).toEqual(['cust_1'])
    expect(links).toEqual([
      {
        field_id: 'customerId',
        record_id: created.id,
        foreign_record_id: 'cust_1',
      },
    ])
  })

  it('loads an existing record by sheet and id', async () => {
    const { query, records } = createQuery()
    records.push({
      id: 'rec_existing',
      sheet_id: 'sheet_service_ticket',
      data: {
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        priority: 'urgent',
      },
      version: 2,
    })

    await expect(getRecord({
      query,
      sheetId: 'sheet_service_ticket',
      recordId: 'rec_existing',
    })).resolves.toEqual({
      id: 'rec_existing',
      sheetId: 'sheet_service_ticket',
      version: 2,
      data: {
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        priority: 'urgent',
      },
    })
  })

  it('patches a supported field and increments version', async () => {
    const { query, records } = createQuery()
    records.push({
      id: 'rec_existing',
      sheet_id: 'sheet_service_ticket',
      data: {
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        priority: 'urgent',
      },
      version: 2,
    })

    await expect(patchRecord({
      query,
      sheetId: 'sheet_service_ticket',
      recordId: 'rec_existing',
      changes: {
        refundAmount: '88.5',
      },
    })).resolves.toEqual({
      id: 'rec_existing',
      sheetId: 'sheet_service_ticket',
      version: 3,
      data: {
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        priority: 'urgent',
        refundAmount: 88.5,
      },
    })
  })

  it('allows clearing a date field with null during patch', async () => {
    const { query, records } = createQuery()
    records.push({
      id: 'rec_existing',
      sheet_id: 'sheet_service_ticket',
      data: {
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        priority: 'urgent',
        scheduledAt: '2026-04-09T11:00:00Z',
      },
      version: 2,
    })

    await expect(patchRecord({
      query,
      sheetId: 'sheet_service_ticket',
      recordId: 'rec_existing',
      changes: {
        scheduledAt: null,
      },
    })).resolves.toEqual({
      id: 'rec_existing',
      sheetId: 'sheet_service_ticket',
      version: 3,
      data: {
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        priority: 'urgent',
        scheduledAt: null,
      },
    })
  })

  it('patches link field values and replaces meta_links', async () => {
    const { query, records, links } = createQuery()
    records.push({
      id: 'cust_1',
      sheet_id: 'sheet_customer',
      data: { name: 'Acme' },
      version: 1,
    })
    records.push({
      id: 'cust_2',
      sheet_id: 'sheet_customer',
      data: { name: 'Beta' },
      version: 1,
    })
    records.push({
      id: 'rec_existing',
      sheet_id: 'sheet_service_ticket',
      data: {
        ticketNo: 'TK-1001',
        customerId: ['cust_1'],
      },
      version: 2,
    })
    links.push({
      field_id: 'customerId',
      record_id: 'rec_existing',
      foreign_record_id: 'cust_1',
    })

    const patched = await patchRecord({
      query,
      sheetId: 'sheet_service_ticket',
      recordId: 'rec_existing',
      changes: {
        customerId: 'cust_2',
      },
    })

    expect(patched.data.customerId).toEqual(['cust_2'])
    expect(links).toEqual([
      {
        field_id: 'customerId',
        record_id: 'rec_existing',
        foreign_record_id: 'cust_2',
      },
    ])
  })

  it('lists records in id order when no query filters are supplied', async () => {
    const { query, records } = createQuery()
    records.push({
      id: 'rec_b',
      sheet_id: 'sheet_service_ticket',
      data: {
        ticketNo: 'TK-1002',
        title: 'B compressor',
        priority: 'normal',
      },
      version: 1,
    })
    records.push({
      id: 'rec_a',
      sheet_id: 'sheet_service_ticket',
      data: {
        ticketNo: 'TK-1001',
        title: 'A compressor',
        priority: 'urgent',
      },
      version: 2,
    })

    await expect(listRecords({
      query,
      sheetId: 'sheet_service_ticket',
    })).resolves.toEqual([
      {
        id: 'rec_a',
        sheetId: 'sheet_service_ticket',
        version: 2,
        data: {
          ticketNo: 'TK-1001',
          title: 'A compressor',
          priority: 'urgent',
        },
      },
      {
        id: 'rec_b',
        sheetId: 'sheet_service_ticket',
        version: 1,
        data: {
          ticketNo: 'TK-1002',
          title: 'B compressor',
          priority: 'normal',
        },
      },
    ])
  })

  it('queries records with filters, search, and pagination', async () => {
    const { query, records } = createQuery()
    records.push(
      {
        id: 'rec_a',
        sheet_id: 'sheet_service_ticket',
        data: {
          ticketNo: 'TK-1001',
          title: 'Broken compressor',
          priority: 'urgent',
        },
        version: 1,
      },
      {
        id: 'rec_b',
        sheet_id: 'sheet_service_ticket',
        data: {
          ticketNo: 'TK-1002',
          title: 'Broken valve',
          priority: 'urgent',
        },
        version: 1,
      },
      {
        id: 'rec_c',
        sheet_id: 'sheet_service_ticket',
        data: {
          ticketNo: 'TK-1003',
          title: 'Routine maintenance',
          priority: 'normal',
        },
        version: 1,
      },
    )

    await expect(queryRecords({
      query,
      sheetId: 'sheet_service_ticket',
      filters: {
        priority: 'urgent',
      },
      search: 'compressor',
      orderBy: {
        fieldId: 'ticketNo',
        direction: 'desc',
      },
      limit: 1,
      offset: 0,
    })).resolves.toEqual([
      {
        id: 'rec_a',
        sheetId: 'sheet_service_ticket',
        version: 1,
        data: {
          ticketNo: 'TK-1001',
          title: 'Broken compressor',
          priority: 'urgent',
        },
      },
    ])
  })

  it('deletes an existing record', async () => {
    const { query, records, links } = createQuery()
    records.push({
      id: 'rec_existing',
      sheet_id: 'sheet_service_ticket',
      data: {
        ticketNo: 'TK-1001',
        title: 'Broken compressor',
        priority: 'urgent',
      },
      version: 2,
    })
    links.push({
      field_id: 'customerId',
      record_id: 'rec_existing',
      foreign_record_id: 'cust_1',
    })

    await expect(deleteRecord({
      query,
      sheetId: 'sheet_service_ticket',
      recordId: 'rec_existing',
    })).resolves.toEqual({
      id: 'rec_existing',
      sheetId: 'sheet_service_ticket',
      version: 2,
    })
    expect(records).toHaveLength(0)
    expect(links).toHaveLength(0)
  })

  it('throws when deleting a missing record', async () => {
    const { query } = createQuery()

    await expect(deleteRecord({
      query,
      sheetId: 'sheet_service_ticket',
      recordId: 'rec_missing',
    })).rejects.toBeInstanceOf(MultitableRecordNotFoundError)
  })
})

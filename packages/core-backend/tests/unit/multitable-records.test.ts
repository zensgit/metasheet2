import { afterEach, describe, expect, it } from 'vitest'

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
import { runWithMultitableRequestMetadataCache } from '../../src/multitable/request-metadata-cache'

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

type FakeRevision = {
  sheet_id: string
  record_id: string
  version: number
  action: string
  source: string
  snapshot: Record<string, unknown> | null
}

function createQuery(): {
  query: MultitableRecordsQueryFn
  sheets: FakeSheet[]
  fields: FakeField[]
  records: FakeRecord[]
  links: FakeLink[]
  revisions: FakeRevision[]
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
  const revisions: FakeRevision[] = []
  const autoNumberNextByField = new Map<string, number>()

  const query: MultitableRecordsQueryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()

    if (normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
      const [sheetId] = params as [string]
      return { rows: sheets.filter((sheet) => sheet.id === sheetId) }
    }

    if (normalized.includes('SELECT pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 1 }
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

    if (normalized.startsWith('INSERT INTO meta_field_auto_number_sequences')) {
      const [fieldId, , nextValueRaw, batchSizeRaw] = params as [string, string, number, number | undefined]
      const batchSize = typeof batchSizeRaw === 'number' ? batchSizeRaw : 1
      const initialNextValue = Number(nextValueRaw)
      const current = autoNumberNextByField.get(fieldId)
      if (current === undefined) {
        autoNumberNextByField.set(fieldId, initialNextValue)
        return { rows: [{ start_value: initialNextValue - batchSize }], rowCount: 1 }
      }
      autoNumberNextByField.set(fieldId, current + batchSize)
      return { rows: [{ start_value: current }], rowCount: 1 }
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

    if (
      normalized.includes('FROM meta_records WHERE id = $1 AND sheet_id = $2') &&
      normalized.includes('SELECT id, sheet_id, version, data')
    ) {
      const [recordId, sheetId] = params as [string, string]
      return {
        rows: records.filter((record) => record.id === recordId && record.sheet_id === sheetId),
      }
    }

    if (
      normalized.includes('FROM meta_records') &&
      normalized.includes('WHERE id = $1 AND sheet_id = $2') &&
      (normalized.includes('SELECT version, data') || normalized.includes('SELECT data, version'))
    ) {
      const [recordId, sheetId] = params as [string, string]
      return {
        rows: records
          .filter((record) => record.id === recordId && record.sheet_id === sheetId)
          .map((record) => ({ version: record.version, data: record.data })),
      }
    }

    if (
      normalized.includes('FROM meta_records WHERE sheet_id = $1') &&
      normalized.includes('SELECT id, sheet_id, version, data')
    ) {
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
      const [dataJson, recordId, sheetId, expectedVersion] = params as [string, string, string, number?]
      const existing = records.find((record) => record.id === recordId && record.sheet_id === sheetId)
      if (!existing) return { rows: [], rowCount: 0 }
      if (normalized.includes('AND version = $4') && existing.version !== expectedVersion) {
        return { rows: [], rowCount: 0 }
      }
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

    if (normalized.startsWith('INSERT INTO meta_record_revisions')) {
      const [, sheetId, recordId, version, action, source, , , , snapshotJson] = params as [
        string,
        string,
        string,
        number,
        string,
        string,
        string | null,
        string[],
        string,
        string | null,
        string | null,
      ]
      revisions.push({
        sheet_id: sheetId,
        record_id: recordId,
        version,
        action,
        source,
        snapshot: snapshotJson ? JSON.parse(snapshotJson) : null,
      })
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

  return { query, sheets, fields, records, links, revisions }
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

  it('allocates autoNumber values through the helper create path', async () => {
    const { query, fields } = createQuery()
    fields.push({
      id: 'autoNo',
      sheet_id: 'sheet_service_ticket',
      name: 'Auto No',
      type: 'autoNumber',
      property: { startAt: 100, prefix: 'TK-', digits: 4 },
      order: 6,
    })

    const first = await createRecord({
      query,
      sheetId: 'sheet_service_ticket',
      data: { title: 'Broken compressor' },
    })
    const second = await createRecord({
      query,
      sheetId: 'sheet_service_ticket',
      data: { title: 'Worn bearing' },
    })

    expect(first.data.autoNo).toBe(100)
    expect(second.data.autoNo).toBe(101)
  })

  it('rejects client supplied autoNumber values through the helper create path', async () => {
    const { query, fields } = createQuery()
    fields.push({
      id: 'autoNo',
      sheet_id: 'sheet_service_ticket',
      name: 'Auto No',
      type: 'autoNumber',
      property: {},
      order: 6,
    })

    await expect(createRecord({
      query,
      sheetId: 'sheet_service_ticket',
      data: { autoNo: 999 },
    })).rejects.toBeInstanceOf(MultitableRecordValidationError)
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
      locked: false,
      lockedBy: null,
      lockedAt: null,
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
      locked: false,
      lockedBy: null,
      lockedAt: null,
    })
  })

  it('patches when the optional expected version matches', async () => {
    const { query, records } = createQuery()
    records.push({
      id: 'rec_existing',
      sheet_id: 'sheet_service_ticket',
      data: { ticketNo: 'TK-1001', title: 'Before', priority: 'normal' },
      version: 2,
    })

    await expect(patchRecord({
      query,
      sheetId: 'sheet_service_ticket',
      recordId: 'rec_existing',
      expectedVersion: 2,
      changes: { title: 'After' },
    })).resolves.toMatchObject({
      version: 3,
      data: { title: 'After' },
    })
  })

  it('fails closed on a stale expected version without data, version, or revision mutation', async () => {
    const { query, records, revisions } = createQuery()
    records.push({
      id: 'rec_existing',
      sheet_id: 'sheet_service_ticket',
      data: { ticketNo: 'TK-1001', title: 'Canonical', priority: 'normal' },
      version: 3,
    })

    await expect(patchRecord({
      query,
      sheetId: 'sheet_service_ticket',
      recordId: 'rec_existing',
      expectedVersion: 2,
      changes: { title: 'Stale writer' },
    })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      message: 'Record version conflict',
    })
    expect(records[0]).toMatchObject({ version: 3, data: { title: 'Canonical' } })
    expect(revisions).toEqual([])
  })

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid expectedVersion %s before touching the record',
    async (expectedVersion) => {
      const { query, records, revisions } = createQuery()
      records.push({
        id: 'rec_existing',
        sheet_id: 'sheet_service_ticket',
        data: { ticketNo: 'TK-1001', title: 'Canonical', priority: 'normal' },
        version: 1,
      })

      await expect(patchRecord({
        query,
        sheetId: 'sheet_service_ticket',
        recordId: 'rec_existing',
        expectedVersion,
        changes: { title: 'Invalid writer' },
      })).rejects.toBeInstanceOf(MultitableRecordValidationError)
      expect(records[0]).toMatchObject({ version: 1, data: { title: 'Canonical' } })
      expect(revisions).toEqual([])
    },
  )

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
      locked: false,
      lockedBy: null,
      lockedAt: null,
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
        locked: false,
        lockedBy: null,
        lockedAt: null,
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
        locked: false,
        lockedBy: null,
        lockedAt: null,
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
        locked: false,
        lockedBy: null,
        lockedAt: null,
      },
    ])
  })

  it('deletes an existing record', async () => {
    const { query, records, links, revisions } = createQuery()
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
    expect(revisions).toEqual([
      expect.objectContaining({
        sheet_id: 'sheet_service_ticket',
        record_id: 'rec_existing',
        version: 2,
        action: 'delete',
        source: 'plugin',
        snapshot: {
          ticketNo: 'TK-1001',
          title: 'Broken compressor',
          priority: 'urgent',
        },
      }),
    ])
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

// W8-4 (L1): the measured cost driver on 222 was CONSTANT metadata re-read, once per written row
// (2x `meta_fields`, 2x `plugin_multitable_object_registry`, 3x `meta_sheets` per created row at
// 47.07ms of server wall-clock per row). These tests pin the SHAPE of the fix, not a timing: the
// number of metadata statements must stop scaling with the number of rows inside one scope, and
// must NOT be shared between two scopes.
describe('multitable records request-scoped metadata memo', () => {
  const FLAG = 'MULTITABLE_ENABLE_REQUEST_METADATA_CACHE'

  function countingQuery(inner: MultitableRecordsQueryFn) {
    const calls = { sheets: 0, fields: 0 }
    const query: MultitableRecordsQueryFn = async (sql, params) => {
      const normalized = sql.replace(/\s+/g, ' ')
      if (normalized.includes('FROM meta_sheets')) calls.sheets += 1
      if (normalized.includes('FROM meta_fields')) calls.fields += 1
      return inner(sql, params)
    }
    return { calls, query }
  }

  async function writeRows(query: MultitableRecordsQueryFn, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      // The exact per-row pair the apply writer runs: an existence probe, then the insert. Each
      // half runs its own `loadSheetAndFields` today, which is why the untouched baseline is 2N.
      await queryRecords({
        query,
        sheetId: 'sheet_service_ticket',
        filters: { ticketNo: `TK-${index}` },
        limit: 2,
      })
      await createRecord({
        query,
        sheetId: 'sheet_service_ticket',
        data: { ticketNo: `TK-${index}`, title: `Ticket ${index}` },
      })
    }
  }

  afterEach(() => {
    delete process.env[FLAG]
  })

  it('loads sheet and field metadata once per scope regardless of row count', async () => {
    process.env[FLAG] = 'true'
    const { query: inner, records } = createQuery()
    const { calls, query } = countingQuery(inner)

    await runWithMultitableRequestMetadataCache(async () => {
      await writeRows(query, 8)
    })

    expect(records).toHaveLength(8)
    // O(1), not O(N): one `meta_sheets` read and one `meta_fields` read for all 8 rows.
    expect(calls).toEqual({ sheets: 1, fields: 1 })
  })

  it('keeps the untouched per-row statements when no scope is open', async () => {
    process.env[FLAG] = 'true'
    const { query: inner, records } = createQuery()
    const { calls, query } = countingQuery(inner)

    await writeRows(query, 8)

    expect(records).toHaveLength(8)
    // 2 per row (query segment + write segment) x 8 rows, exactly as before this change.
    expect(calls).toEqual({ sheets: 16, fields: 16 })
  })

  it('keeps the untouched per-row statements when the flag is off, even inside a scope', async () => {
    delete process.env[FLAG]
    const { query: inner, records } = createQuery()
    const { calls, query } = countingQuery(inner)

    await runWithMultitableRequestMetadataCache(async () => {
      await writeRows(query, 8)
    })

    expect(records).toHaveLength(8)
    expect(calls).toEqual({ sheets: 16, fields: 16 })
  })

  it('never reuses one scope’s metadata in another scope', async () => {
    process.env[FLAG] = 'true'
    const { query: inner } = createQuery()
    const { calls, query } = countingQuery(inner)

    await runWithMultitableRequestMetadataCache(async () => {
      await writeRows(query, 3)
    })
    await runWithMultitableRequestMetadataCache(async () => {
      await writeRows(query, 3)
    })

    // Two scopes = two independent loads. A process-level cache would report 1/1 here; that is
    // exactly the shape this test exists to forbid, because a later request must see a field
    // added between the two.
    expect(calls).toEqual({ sheets: 2, fields: 2 })
  })

  it('sees a mid-scope field addition on the NEXT scope, not inside the current one', async () => {
    process.env[FLAG] = 'true'
    const { query, fields, records } = createQuery()

    await runWithMultitableRequestMetadataCache(async () => {
      await createRecord({
        query,
        sheetId: 'sheet_service_ticket',
        data: { ticketNo: 'TK-A', title: 'first' },
      })
      fields.push({
        id: 'addedMidScope',
        sheet_id: 'sheet_service_ticket',
        name: 'Added Mid Scope',
        type: 'string',
        property: {},
        order: 99,
      })
      // Documented, accepted trade-off: within ONE scope the snapshot the first row read is what
      // the rest of the rows see, so a field that appeared mid-scope is not yet writable here.
      await expect(createRecord({
        query,
        sheetId: 'sheet_service_ticket',
        data: { ticketNo: 'TK-B', addedMidScope: 'x' },
      })).rejects.toBeInstanceOf(MultitableRecordValidationError)
    })

    await runWithMultitableRequestMetadataCache(async () => {
      await createRecord({
        query,
        sheetId: 'sheet_service_ticket',
        data: { ticketNo: 'TK-C', addedMidScope: 'x' },
      })
    })

    expect(records.map((record) => record.data.ticketNo)).toEqual(['TK-A', 'TK-C'])
  })
})

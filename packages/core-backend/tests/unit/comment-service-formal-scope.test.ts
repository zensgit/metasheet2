import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ILogger } from '../../src/di/identifiers'

const dbMock = vi.hoisted(() => ({
  executeResults: [] as unknown[],
  executeTakeFirstResults: [] as unknown[],
  valuesCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../src/db/db', () => {
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {}
    const chainFn = () => chain
    for (const method of [
      'selectFrom',
      'selectAll',
      'select',
      'where',
      'insertInto',
      'onConflict',
      'columns',
      'doUpdateSet',
    ]) {
      chain[method] = vi.fn(chainFn)
    }
    chain.values = vi.fn((value: Record<string, unknown>) => {
      dbMock.valuesCalls.push(value)
      return chain
    })
    chain.execute = vi.fn(async () => dbMock.executeResults.shift() ?? [])
    chain.executeTakeFirst = vi.fn(async () => dbMock.executeTakeFirstResults.shift())
    return chain
  }

  const db = {
    selectFrom: vi.fn(() => makeChain()),
    insertInto: vi.fn(() => makeChain()),
  }

  return { db }
})

vi.mock('../../src/multitable/record-subscription-service', () => ({
  notifyRecordSubscribersWithKysely: vi.fn().mockResolvedValue({ inserted: 0, userIds: [] }),
}))

import { CommentService } from '../../src/services/CommentService'
import type { CollabService } from '../../src/services/CollabService'

function makeLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

function makeCollabService(): CollabService {
  return {
    broadcastTo: vi.fn(),
    sendTo: vi.fn(),
    broadcast: vi.fn(),
    initialize: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    onConnection: vi.fn(),
  } as unknown as CollabService
}

function makeCommentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmt_scope',
    spreadsheet_id: 'sheet_scope',
    row_id: 'rec_scope',
    field_id: 'fld_scope',
    content: 'Scope check',
    author_id: 'user_scope',
    parent_id: null,
    resolved: false,
    created_at: '2026-05-06T00:00:00.000Z',
    updated_at: '2026-05-06T00:00:00.000Z',
    mentions: '[]',
    ...overrides,
  }
}

describe('CommentService formalized scope writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbMock.executeResults.length = 0
    dbMock.executeTakeFirstResults.length = 0
    dbMock.valuesCalls.length = 0
  })

  it('writes canonical target/container columns when creating a record comment', async () => {
    dbMock.executeResults.push([])
    dbMock.executeTakeFirstResults.push(makeCommentRow())
    dbMock.executeResults.push([])

    const service = new CommentService(makeCollabService(), makeLogger())

    await service.createComment({
      spreadsheetId: 'sheet_scope',
      rowId: 'rec_scope',
      fieldId: 'fld_scope',
      content: 'Scope check',
      authorId: 'user_scope',
    })

    expect(dbMock.valuesCalls[0]).toMatchObject({
      spreadsheet_id: 'sheet_scope',
      row_id: 'rec_scope',
      field_id: 'fld_scope',
      target_type: 'meta_record',
      target_id: 'rec_scope',
      target_field_id: 'fld_scope',
      container_type: 'meta_sheet',
      container_id: 'sheet_scope',
    })
  })
})

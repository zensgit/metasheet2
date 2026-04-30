import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RecordNotFoundError,
  RecordPatchFieldValidationError,
  RecordPermissionError,
  RecordService,
  RecordValidationFailedError,
  RecordValidationError,
  VersionConflictError,
  type ConnectionPool,
  type QueryFn,
} from '../../src/multitable/record-service'
import { createYjsInvalidationPostCommitHook } from '../../src/multitable/post-commit-hooks'

const mockPublish = vi.fn()
vi.mock('../../src/multitable/realtime-publish', () => ({
  publishMultitableSheetRealtime: (...args: unknown[]) => mockPublish(...args),
}))

type QueryResponse = { rows: unknown[]; rowCount?: number | null }

const fullCapabilities = {
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
}

function createMockEventBus() {
  return {
    emit: vi.fn(),
    publish: vi.fn(),
    subscribe: vi.fn().mockReturnValue('sub_1'),
    unsubscribe: vi.fn(),
  }
}

function createMockPool(
  responses: Partial<Record<string, QueryResponse>> = {},
): ConnectionPool & { queryMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      return responses.SELECT_SHEET ?? { rows: [{ id: 'sheet_ops' }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return responses.SELECT_FIELDS ?? {
        rows: [{ id: 'fld_title', name: 'Title', type: 'string', property: {} }],
      }
    }
    if (sql.includes('SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
      return responses.SELECT_LINK_TARGETS ?? { rows: [] }
    }
    if (sql.includes('INSERT INTO meta_records') && sql.includes('RETURNING version')) {
      return responses.INSERT_RECORD ?? { rows: [{ version: 1 }] }
    }
    if (sql.includes('INSERT INTO meta_links')) {
      return responses.INSERT_LINK ?? { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT id, sheet_id, created_by FROM meta_records WHERE id = $1')) {
      return responses.SELECT_DELETE_RECORD ?? {
        rows: [{ id: 'rec_existing', sheet_id: 'sheet_ops', created_by: 'user_1' }],
      }
    }
    if (sql.includes('SELECT id, sheet_id, version FROM meta_records WHERE id = $1 FOR UPDATE')) {
      return responses.SELECT_DELETE_FOR_UPDATE ?? {
        rows: [{ id: 'rec_existing', sheet_id: 'sheet_ops', version: 4 }],
      }
    }
    if (sql.includes('SELECT id, version, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
      return responses.SELECT_PATCH_FOR_UPDATE ?? {
        rows: [{ id: 'rec_existing', version: 4, created_by: 'user_1' }],
      }
    }
    if (sql.includes('UPDATE meta_records') && sql.includes('RETURNING version')) {
      return responses.UPDATE_RECORD ?? { rows: [{ version: 5 }], rowCount: 1 }
    }
    if (sql.includes('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2')) {
      return responses.SELECT_CURRENT_LINKS ?? { rows: [] }
    }
    if (sql.includes('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY')) {
      return responses.DELETE_STALE_LINKS ?? { rows: [], rowCount: 1 }
    }
    if (sql.includes('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2')) {
      return responses.DELETE_EMPTY_LINKS ?? { rows: [], rowCount: 1 }
    }
    if (sql.includes('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1')) {
      return responses.DELETE_LINKS ?? { rows: [], rowCount: 1 }
    }
    if (sql.includes('DELETE FROM meta_records WHERE id = $1')) {
      return responses.DELETE_RECORD ?? { rows: [], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL in test: ${sql}`)
  })

  return {
    query: queryMock as QueryFn,
    queryMock,
    transaction: vi.fn(async <T>(handler: (client: { query: QueryFn }) => Promise<T>) =>
      handler({ query: queryMock as QueryFn })),
  }
}

describe('RecordService', () => {
  let pool: ReturnType<typeof createMockPool>
  let eventBus: ReturnType<typeof createMockEventBus>

  beforeEach(() => {
    vi.clearAllMocks()
    pool = createMockPool()
    eventBus = createMockEventBus()
  })

  it('creates a record and emits realtime + eventBus notifications', async () => {
    const service = new RecordService(pool, eventBus as any)

    const result = await service.createRecord({
      sheetId: 'sheet_ops',
      data: { fld_title: 'Alpha' },
      actorId: 'user_1',
      capabilities: {
        ...fullCapabilities,
      },
    })

    expect(result.recordId).toMatch(/^rec_/)
    expect(result.version).toBe(1)
    expect(result.data).toEqual({ fld_title: 'Alpha' })
    expect(eventBus.emit).toHaveBeenCalledWith('multitable.record.created', {
      sheetId: 'sheet_ops',
      recordId: result.recordId,
      data: { fld_title: 'Alpha' },
      actorId: 'user_1',
    })
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: 'sheet_ops',
        kind: 'record-created',
        recordId: result.recordId,
        recordIds: [result.recordId],
        fieldIds: ['fld_title'],
      }),
    )
  })

  it('creates a record with normalized multiSelect values', async () => {
    pool = createMockPool({
      SELECT_FIELDS: {
        rows: [{
          id: 'fld_tags',
          name: 'Tags',
          type: 'multiSelect',
          property: { options: [{ value: 'Urgent' }, { value: 'VIP' }] },
        }],
      },
    })
    const service = new RecordService(pool, eventBus as any)

    const result = await service.createRecord({
      sheetId: 'sheet_ops',
      data: { fld_tags: ['Urgent', 'VIP', 'Urgent'] },
      actorId: 'user_1',
      capabilities: fullCapabilities,
    })

    expect(result.data).toEqual({ fld_tags: ['Urgent', 'VIP'] })
    expect(pool.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO meta_records'),
      [expect.any(String), 'sheet_ops', JSON.stringify({ fld_tags: ['Urgent', 'VIP'] }), 'user_1'],
    )
  })

  it('rejects create when a linked target record is missing', async () => {
    pool = createMockPool({
      SELECT_FIELDS: {
        rows: [{
          id: 'fld_customer',
          name: 'Customer',
          type: 'link',
          property: { foreignSheetId: 'sheet_customer', limitSingleRecord: true },
        }],
      },
      SELECT_LINK_TARGETS: { rows: [] },
    })
    const service = new RecordService(pool, eventBus as any)

    await expect(service.createRecord({
      sheetId: 'sheet_ops',
      data: { fld_customer: 'rec_missing' },
      actorId: 'user_1',
      capabilities: {
        ...fullCapabilities,
      },
    })).rejects.toThrow(RecordValidationError)
  })

  it('surfaces direct field validation failures during create', async () => {
    pool = createMockPool({
      SELECT_FIELDS: {
        rows: [{
          id: 'fld_title',
          name: 'Title',
          type: 'string',
          property: {
            validation: [{ type: 'required', message: 'Title is required' }],
          },
        }],
      },
    })
    const service = new RecordService(pool, eventBus as any)

    await expect(service.createRecord({
      sheetId: 'sheet_ops',
      data: {},
      actorId: 'user_1',
      capabilities: {
        ...fullCapabilities,
      },
    })).rejects.toBeInstanceOf(RecordValidationFailedError)
  })

  it('deletes a record and emits realtime + eventBus notifications', async () => {
    const service = new RecordService(pool, eventBus as any)

    const result = await service.deleteRecord({
      recordId: 'rec_existing',
      actorId: 'user_1',
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
      resolveSheetAccess: vi.fn().mockResolvedValue({
        capabilities: {
          ...fullCapabilities,
        },
      }),
    })

    expect(result).toEqual({ recordId: 'rec_existing', sheetId: 'sheet_ops' })
    expect(eventBus.emit).toHaveBeenCalledWith('multitable.record.deleted', {
      sheetId: 'sheet_ops',
      recordId: 'rec_existing',
      actorId: 'user_1',
    })
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: 'sheet_ops',
        kind: 'record-deleted',
        recordId: 'rec_existing',
        recordIds: ['rec_existing'],
      }),
    )
  })

  it('throws VersionConflictError when delete expectedVersion does not match', async () => {
    pool = createMockPool({
      SELECT_DELETE_FOR_UPDATE: {
        rows: [{ id: 'rec_existing', sheet_id: 'sheet_ops', version: 7 }],
      },
    })
    const service = new RecordService(pool, eventBus as any)

    await expect(service.deleteRecord({
      recordId: 'rec_existing',
      expectedVersion: 5,
      actorId: 'user_1',
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
      resolveSheetAccess: vi.fn().mockResolvedValue({
        capabilities: {
          ...fullCapabilities,
        },
      }),
    })).rejects.toThrow(VersionConflictError)
  })

  it('rejects delete when record-level own-write policy blocks the row', async () => {
    pool = createMockPool({
      SELECT_DELETE_RECORD: {
        rows: [{ id: 'rec_existing', sheet_id: 'sheet_ops', created_by: 'user_2' }],
      },
    })
    const service = new RecordService(pool, eventBus as any)

    await expect(service.deleteRecord({
      recordId: 'rec_existing',
      actorId: 'user_1',
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
      resolveSheetAccess: vi.fn().mockResolvedValue({
        capabilities: {
          ...fullCapabilities,
        },
        sheetScope: {
          hasAssignments: true,
          canRead: true,
          canWrite: false,
          canWriteOwn: true,
          canAdmin: false,
        },
      }),
    })).rejects.toThrow(RecordPermissionError)
  })

  it('throws RecordNotFoundError when deleting a missing record', async () => {
    pool = createMockPool({
      SELECT_DELETE_RECORD: { rows: [] },
    })
    const service = new RecordService(pool, eventBus as any)

    await expect(service.deleteRecord({
      recordId: 'rec_missing',
      actorId: 'user_1',
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
      resolveSheetAccess: vi.fn(),
    })).rejects.toThrow(RecordNotFoundError)
  })

  it('patches a record, updates links, and invalidates Yjs state', async () => {
    const yjsInvalidator = vi.fn()
    pool = createMockPool({
      SELECT_FIELDS: {
        rows: [
          { id: 'fld_title', name: 'Title', type: 'string', property: {} },
          {
            id: 'fld_customer',
            name: 'Customer',
            type: 'link',
            property: { foreignSheetId: 'sheet_customer', limitSingleRecord: false },
          },
        ],
      },
      SELECT_LINK_TARGETS: { rows: [{ id: 'rec_customer_2' }] },
      SELECT_CURRENT_LINKS: { rows: [{ foreign_record_id: 'rec_customer_1' }] },
    })
    const service = new RecordService(pool, eventBus as any, [
      createYjsInvalidationPostCommitHook(yjsInvalidator),
    ])

    const result = await service.patchRecord({
      recordId: 'rec_existing',
      sheetId: 'sheet_ops',
      data: { fld_title: 'Updated', fld_customer: ['rec_customer_2'] },
      expectedVersion: 4,
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
      capabilities: fullCapabilities,
    })

    expect(result.version).toBe(5)
    expect(result.patch).toEqual({ fld_title: 'Updated', fld_customer: ['rec_customer_2'] })
    expect(yjsInvalidator).toHaveBeenCalledWith(['rec_existing'])
    expect(pool.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE meta_records'),
      [JSON.stringify({ fld_title: 'Updated', fld_customer: ['rec_customer_2'] }), 'rec_existing', 'sheet_ops', 'user_1'],
    )
    expect(pool.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY'),
      ['fld_customer', 'rec_existing', ['rec_customer_1']],
    )
    expect(pool.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO meta_links'),
      [expect.stringMatching(/^lnk_/), 'fld_customer', 'rec_existing', 'rec_customer_2'],
    )
  })

  it('patches a record with normalized multiSelect values', async () => {
    pool = createMockPool({
      SELECT_FIELDS: {
        rows: [{
          id: 'fld_tags',
          name: 'Tags',
          type: 'multiSelect',
          property: { options: [{ value: 'Urgent' }, { value: 'VIP' }] },
        }],
      },
    })
    const service = new RecordService(pool, eventBus as any)

    const result = await service.patchRecord({
      recordId: 'rec_existing',
      sheetId: 'sheet_ops',
      data: { fld_tags: ['VIP', 'Urgent', 'VIP'] },
      expectedVersion: 4,
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
      capabilities: fullCapabilities,
    })

    expect(result.patch).toEqual({ fld_tags: ['VIP', 'Urgent'] })
    expect(pool.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE meta_records'),
      [JSON.stringify({ fld_tags: ['VIP', 'Urgent'] }), 'rec_existing', 'sheet_ops', 'user_1'],
    )
  })

  it('patch rejects hidden fields with the legacy forbidden response classification', async () => {
    pool = createMockPool({
      SELECT_FIELDS: {
        rows: [{ id: 'fld_secret', name: 'Secret', type: 'string', property: { hidden: true } }],
      },
    })
    const service = new RecordService(pool, eventBus as any)

    await expect(service.patchRecord({
      recordId: 'rec_existing',
      sheetId: 'sheet_ops',
      data: { fld_secret: 'blocked' },
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
      capabilities: fullCapabilities,
    })).rejects.toBeInstanceOf(RecordPatchFieldValidationError)

    await expect(service.patchRecord({
      recordId: 'rec_existing',
      sheetId: 'sheet_ops',
      data: { fld_secret: 'blocked' },
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
      capabilities: fullCapabilities,
    })).rejects.toMatchObject({
      code: 'FIELD_HIDDEN',
      statusCode: 403,
      fieldErrors: { fld_secret: 'Field is hidden' },
    })
  })

  it('patch enforces expectedVersion before updating', async () => {
    pool = createMockPool({
      SELECT_PATCH_FOR_UPDATE: {
        rows: [{ id: 'rec_existing', version: 7, created_by: 'user_1' }],
      },
    })
    const service = new RecordService(pool, eventBus as any)

    await expect(service.patchRecord({
      recordId: 'rec_existing',
      sheetId: 'sheet_ops',
      data: { fld_title: 'Updated' },
      expectedVersion: 4,
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
      capabilities: fullCapabilities,
    })).rejects.toThrow(VersionConflictError)

    expect(pool.queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE meta_records'),
      expect.any(Array),
    )
  })

  it('patch preserves own-write policy for non-owned rows', async () => {
    pool = createMockPool({
      SELECT_PATCH_FOR_UPDATE: {
        rows: [{ id: 'rec_existing', version: 4, created_by: 'user_2' }],
      },
    })
    const service = new RecordService(pool, eventBus as any)

    await expect(service.patchRecord({
      recordId: 'rec_existing',
      sheetId: 'sheet_ops',
      data: { fld_title: 'Updated' },
      access: { userId: 'user_1', permissions: [], isAdminRole: false },
      capabilities: fullCapabilities,
      sheetScope: {
        hasAssignments: true,
        canRead: true,
        canWrite: false,
        canWriteOwn: true,
        canAdmin: false,
      },
    })).rejects.toThrow(RecordPermissionError)
  })
})

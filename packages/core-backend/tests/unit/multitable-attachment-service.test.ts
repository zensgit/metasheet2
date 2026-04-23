import { describe, expect, it, vi } from 'vitest'

import {
  buildAttachmentSummaries,
  deleteAttachmentBinary,
  ensureAttachmentIdsExist,
  normalizeAttachmentIds,
  readAttachmentBinary,
  readAttachmentForDelete,
  readAttachmentMetadata,
  serializeAttachmentRow,
  serializeAttachmentSummaryMap,
  softDeleteAttachmentRow,
  storeAttachment,
  type AttachmentQueryFn,
  type AttachmentUrlRequestLike,
} from '../../src/multitable/attachment-service'

type QueryRow = Record<string, unknown>

function createQuery(handler: (sql: string, params?: unknown[]) => QueryRow[] | Promise<QueryRow[]>) {
  return vi.fn(async (sql: string, params?: unknown[]) => ({
    rows: await handler(sql, params),
  })) as unknown as AttachmentQueryFn
}

function createRequestLike(host: string = 'example.test', protocol: string = 'https'): AttachmentUrlRequestLike {
  return {
    protocol,
    get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
  }
}

function createStorageMock(overrides: {
  upload?: ReturnType<typeof vi.fn>
  download?: ReturnType<typeof vi.fn>
  deleteFn?: ReturnType<typeof vi.fn>
} = {}) {
  return {
    upload: overrides.upload ?? vi.fn(async () => ({
      id: 'file_123',
      filename: 'out.bin',
      originalName: 'in.bin',
      mimeType: 'application/octet-stream',
      size: 4,
      path: 'sheets_sheet_1/unassigned/out.bin',
      url: 'http://localhost/files/file_123',
      provider: 'local',
      createdAt: new Date('2026-04-23T00:00:00Z'),
    })),
    download: overrides.download ?? vi.fn(async () => Buffer.from('abcd')),
    delete: overrides.deleteFn ?? vi.fn(async () => undefined),
  } as any
}

describe('attachment-service: normalizeAttachmentIds', () => {
  it('returns an empty array for null/undefined/empty inputs', () => {
    expect(normalizeAttachmentIds(null)).toEqual([])
    expect(normalizeAttachmentIds(undefined)).toEqual([])
    expect(normalizeAttachmentIds('')).toEqual([])
    expect(normalizeAttachmentIds('   ')).toEqual([])
  })

  it('de-duplicates arrays and preserves order', () => {
    expect(normalizeAttachmentIds(['a', 'b', 'a', 'c '])).toEqual(['a', 'b', 'c'])
  })

  it('parses a JSON-encoded array string', () => {
    expect(normalizeAttachmentIds('["x","y","x"]')).toEqual(['x', 'y'])
  })

  it('splits a comma-separated string', () => {
    expect(normalizeAttachmentIds('one, two , three')).toEqual(['one', 'two', 'three'])
  })

  it('accepts numeric ids', () => {
    expect(normalizeAttachmentIds([1, 2, 2])).toEqual(['1', '2'])
    expect(normalizeAttachmentIds(42)).toEqual(['42'])
  })
})

describe('attachment-service: serializers', () => {
  it('builds attachment url including thumbnail variant when image mime', () => {
    const req = createRequestLike('host.test', 'http')
    const row = {
      id: 'att_1',
      filename: 'image.png',
      original_name: 'IMG.png',
      mime_type: 'image/png',
      size: 100,
      created_at: new Date('2026-04-23T12:00:00Z'),
    }
    const serialized = serializeAttachmentRow(req, row)
    expect(serialized).toEqual({
      id: 'att_1',
      filename: 'image.png',
      mimeType: 'image/png',
      size: 100,
      url: 'http://host.test/api/multitable/attachments/att_1',
      thumbnailUrl: 'http://host.test/api/multitable/attachments/att_1?thumbnail=true',
      uploadedAt: '2026-04-23T12:00:00.000Z',
    })
  })

  it('omits thumbnail url for non-image mime types and falls back to original_name', () => {
    const req = createRequestLike()
    const row = {
      id: 'att_2',
      original_name: 'report.pdf',
      mime_type: 'application/pdf',
      size: 50,
      created_at: '2026-04-20T01:00:00Z',
    }
    const serialized = serializeAttachmentRow(req, row)
    expect(serialized.filename).toBe('report.pdf')
    expect(serialized.mimeType).toBe('application/pdf')
    expect(serialized.thumbnailUrl).toBeNull()
    expect(serialized.uploadedAt).toBe('2026-04-20T01:00:00Z')
  })

  it('flattens the summary Map into plain-object form', () => {
    const inner = new Map<string, any[]>()
    inner.set('fld_att', [{ id: 'att_1' }])
    const outer = new Map<string, Map<string, any[]>>()
    outer.set('rec_1', inner)
    expect(serializeAttachmentSummaryMap(outer as any)).toEqual({
      rec_1: { fld_att: [{ id: 'att_1' }] },
    })
  })
})

describe('attachment-service: ensureAttachmentIdsExist', () => {
  it('returns null when the input list is empty (no DB call)', async () => {
    const query = createQuery(() => {
      throw new Error('should not call')
    })
    expect(
      await ensureAttachmentIdsExist({ query, sheetId: 's1', fieldId: 'f1', attachmentIds: [] }),
    ).toBeNull()
  })

  it('reports missing ids with the canonical error message', async () => {
    const query = createQuery(() => [{ id: 'att_known', field_id: null }])
    const err = await ensureAttachmentIdsExist({
      query,
      sheetId: 's1',
      fieldId: 'f1',
      attachmentIds: ['att_known', 'att_missing'],
    })
    expect(err).toBe('Attachment(s) not found: att_missing')
  })

  it('reports mismatched field binding', async () => {
    const query = createQuery(() => [{ id: 'att_wrong', field_id: 'fld_other' }])
    const err = await ensureAttachmentIdsExist({
      query,
      sheetId: 's1',
      fieldId: 'fld_me',
      attachmentIds: ['att_wrong'],
    })
    expect(err).toBe('Attachment belongs to a different field: att_wrong')
  })

  it('returns null when all ids are present and correctly scoped', async () => {
    const query = createQuery(() => [
      { id: 'att_a', field_id: 'fld_me' },
      { id: 'att_b', field_id: null },
    ])
    expect(
      await ensureAttachmentIdsExist({
        query,
        sheetId: 's1',
        fieldId: 'fld_me',
        attachmentIds: ['att_a', 'att_b'],
      }),
    ).toBeNull()
  })
})

describe('attachment-service: buildAttachmentSummaries', () => {
  it('returns empty map when no rows or no attachment fields', async () => {
    const query = createQuery(() => {
      throw new Error('should not call')
    })
    const req = createRequestLike()
    await expect(
      buildAttachmentSummaries({
        query,
        req,
        sheetId: 's1',
        rows: [],
        attachmentFields: [{ id: 'fld_att', type: 'attachment' }],
      }),
    ).resolves.toEqual(new Map())
    await expect(
      buildAttachmentSummaries({
        query,
        req,
        sheetId: 's1',
        rows: [{ id: 'rec_1', data: {} }],
        attachmentFields: [],
      }),
    ).resolves.toEqual(new Map())
  })

  it('builds a nested map filtered by field pinning', async () => {
    const query = createQuery((_sql, params) => {
      expect(Array.isArray(params)).toBe(true)
      return [
        {
          id: 'att_a',
          sheet_id: 's1',
          record_id: 'rec_1',
          field_id: 'fld_att',
          filename: 'a.png',
          original_name: 'A.png',
          mime_type: 'image/png',
          size: 1,
          created_at: '2026-04-23T00:00:00Z',
        },
        {
          id: 'att_b',
          sheet_id: 's1',
          record_id: 'rec_1',
          field_id: 'fld_other',
          filename: 'b.pdf',
          original_name: 'B.pdf',
          mime_type: 'application/pdf',
          size: 1,
          created_at: '2026-04-23T00:00:00Z',
        },
      ]
    })

    const req = createRequestLike()
    const result = await buildAttachmentSummaries({
      query,
      req,
      sheetId: 's1',
      rows: [{ id: 'rec_1', data: { fld_att: ['att_a', 'att_b'] } }],
      attachmentFields: [{ id: 'fld_att', type: 'attachment' }],
    })

    const fieldMap = result.get('rec_1')
    expect(fieldMap?.get('fld_att')?.map((a) => a.id)).toEqual(['att_a'])
  })

  it('skips records with no matching attachments', async () => {
    const query = createQuery(() => [])
    const req = createRequestLike()
    const result = await buildAttachmentSummaries({
      query,
      req,
      sheetId: 's1',
      rows: [{ id: 'rec_1', data: { fld_att: ['att_missing'] } }],
      attachmentFields: [{ id: 'fld_att', type: 'attachment' }],
    })
    expect(result.size).toBe(0)
  })
})

describe('attachment-service: storeAttachment', () => {
  it('uploads binary, inserts row, and returns the row + storage metadata', async () => {
    const query = createQuery((sql, params) => {
      expect(sql).toContain('INSERT INTO multitable_attachments')
      expect(params?.[0]).toBe('att_fixed')
      return [
        {
          id: 'att_fixed',
          filename: 'hello.txt',
          original_name: 'hello.txt',
          mime_type: 'text/plain',
          size: 5,
          created_at: '2026-04-23T12:00:00Z',
        },
      ]
    })
    const storage = createStorageMock()
    const result = await storeAttachment({
      query,
      storage,
      sheetId: 's1',
      recordId: 'rec_1',
      fieldId: 'fld_att',
      file: {
        buffer: Buffer.from('hello'),
        originalname: 'hello.txt',
        mimetype: 'text/plain',
        size: 5,
      },
      uploaderId: 'u1',
      idGenerator: () => 'att_fixed',
    })
    expect(storage.upload).toHaveBeenCalledTimes(1)
    expect(result.row.id).toBe('att_fixed')
    expect(result.uploaded.id).toBe('file_123')
  })

  it('cleans up storage when the DB insert fails', async () => {
    const dbError = new Error('boom')
    const query = createQuery(() => {
      throw dbError
    })
    const storage = createStorageMock()
    await expect(
      storeAttachment({
        query,
        storage,
        sheetId: 's1',
        recordId: null,
        fieldId: null,
        file: {
          buffer: Buffer.from('x'),
          originalname: 'x.bin',
          mimetype: 'application/octet-stream',
          size: 1,
        },
        uploaderId: 'u1',
        idGenerator: () => 'att_tmp',
      }),
    ).rejects.toThrow('boom')
    expect(storage.delete).toHaveBeenCalledWith('file_123')
  })
})

describe('attachment-service: readAttachmentMetadata & readAttachmentBinary', () => {
  it('returns null when no row matches', async () => {
    const query = createQuery(() => [])
    const result = await readAttachmentMetadata({ query, attachmentId: 'att_missing' })
    expect(result).toBeNull()
  })

  it('maps the selected columns to the expected shape', async () => {
    const query = createQuery(() => [
      {
        id: 'att_1',
        sheet_id: 's1',
        storage_file_id: 'file_42',
        filename: 'report.pdf',
        original_name: 'Report.pdf',
        mime_type: 'application/pdf',
        size: 100,
      },
    ])
    const result = await readAttachmentMetadata({ query, attachmentId: 'att_1' })
    expect(result).toEqual({
      id: 'att_1',
      sheetId: 's1',
      storageFileId: 'file_42',
      filename: 'report.pdf',
      originalName: 'Report.pdf',
      mimeType: 'application/pdf',
      size: 100,
    })
  })

  it('delegates readAttachmentBinary to the storage adapter', async () => {
    const storage = createStorageMock({ download: vi.fn(async () => Buffer.from('payload')) as any })
    const result = await readAttachmentBinary({ storage, storageFileId: 'file_42' })
    expect(storage.download).toHaveBeenCalledWith('file_42')
    expect(result.toString()).toBe('payload')
  })
})

describe('attachment-service: readAttachmentForDelete', () => {
  it('returns null when the attachment is absent or already soft-deleted', async () => {
    const query = createQuery(() => [])
    await expect(
      readAttachmentForDelete({ query, attachmentId: 'att_gone' }),
    ).resolves.toBeNull()
  })

  it('returns the permission-relevant columns', async () => {
    const query = createQuery(() => [
      {
        id: 'att_1',
        sheet_id: 's1',
        record_id: 'rec_1',
        field_id: 'fld_att',
        storage_file_id: 'file_7',
        created_by: 'user_1',
      },
    ])
    await expect(
      readAttachmentForDelete({ query, attachmentId: 'att_1' }),
    ).resolves.toEqual({
      id: 'att_1',
      sheetId: 's1',
      recordId: 'rec_1',
      fieldId: 'fld_att',
      storageFileId: 'file_7',
      createdBy: 'user_1',
    })
  })
})

describe('attachment-service: soft delete and binary delete', () => {
  it('softDeleteAttachmentRow issues the canonical UPDATE', async () => {
    const query = createQuery((sql, params) => {
      expect(sql).toContain('UPDATE multitable_attachments SET deleted_at')
      expect(params).toEqual(['att_1'])
      return []
    })
    await softDeleteAttachmentRow({ query, attachmentId: 'att_1' })
  })

  it('deleteAttachmentBinary swallows storage adapter errors', async () => {
    const storage = createStorageMock({
      deleteFn: vi.fn(async () => {
        throw new Error('ENOENT')
      }) as any,
    })
    await expect(
      deleteAttachmentBinary({ storage, storageFileId: 'file_bad' }),
    ).resolves.toBeUndefined()
    expect(storage.delete).toHaveBeenCalledWith('file_bad')
  })
})

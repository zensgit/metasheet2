import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => queryHandler(sql, params))
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(args: {
  tokenPerms?: string[]
  tokenRoles?: string[]
  queryHandler?: QueryHandler
  fallbackPermissions?: string[]
  attachmentPath: string
  mockStorageDownload?: Buffer
}) {
  vi.resetModules()
  process.env.ATTACHMENT_PATH = args.attachmentPath
  const publishSpy = vi.fn()

  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(args.fallbackPermissions ?? []),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  vi.doMock('../../src/integration/events/event-bus', () => ({
    eventBus: { publish: publishSpy },
  }))
  if (args.mockStorageDownload) {
    const downloadSpy = vi.fn(async () => args.mockStorageDownload as Buffer)
    vi.doMock('../../src/services/StorageService', async () => {
      const actual = await vi.importActual<any>('../../src/services/StorageService')
      return {
        ...actual,
        StorageServiceImpl: {
          ...actual.StorageServiceImpl,
          createLocalService: vi.fn(() => ({
            download: downloadSpy,
          })),
        },
      }
    })
  } else {
    vi.doUnmock('../../src/services/StorageService')
  }

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(args.queryHandler ?? (() => ({ rows: [], rowCount: 0 })))
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_multitable_attachments',
      roles: args.tokenRoles ?? [],
      perms: args.tokenPerms ?? [],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())

  return { app, mockPool, publishSpy }
}

describe('Multitable attachment API', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    delete process.env.ATTACHMENT_PATH
  })

  test('uploads and downloads a multitable attachment', async () => {
    const attachmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'multitable-attachment-upload-'))
    let storedPath = ''
    let storedFileId = ''
    let uploadedAttachmentId = ''

    try {
      const { app, publishSpy } = await createApp({
        attachmentPath,
        tokenPerms: ['multitable:write', 'multitable:read'],
        queryHandler: async (sql, params) => {
          if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
            expect(params).toEqual(['sheet_ops'])
            return { rows: [{ id: 'sheet_ops' }] }
          }
          if (sql.includes('SELECT id, type FROM meta_fields WHERE id = $1 AND sheet_id = $2')) {
            expect(params).toEqual(['fld_files', 'sheet_ops'])
            return { rows: [{ id: 'fld_files', type: 'attachment' }] }
          }
          if (sql.includes('FROM spreadsheet_permissions')) {
            expect(params).toEqual(['user_multitable_attachments', ['sheet_ops']])
            return { rows: [] }
          }
          if (sql.includes('INSERT INTO multitable_attachments')) {
            uploadedAttachmentId = String(params?.[0] ?? '')
            storedFileId = String(params?.[4] ?? '')
            storedPath = String(params?.[9] ?? '')
            return {
              rows: [{
                id: uploadedAttachmentId,
                filename: params?.[5],
                original_name: params?.[6],
                mime_type: params?.[7],
                size: params?.[8],
                created_at: '2026-03-19T10:30:00.000Z',
              }],
            }
          }
          if (sql.includes('FROM multitable_attachments') && sql.includes('storage_file_id')) {
            expect(params).toEqual([uploadedAttachmentId])
          return {
              rows: [{
                id: uploadedAttachmentId,
                sheet_id: 'sheet_ops',
                storage_file_id: storedFileId,
                filename: 'brief.txt',
                original_name: 'brief.txt',
                mime_type: 'text/plain',
                size: 11,
              }],
            }
          }
          throw new Error(`Unhandled SQL in test: ${sql}`)
        },
      })

      const upload = await request(app)
        .post('/api/multitable/attachments')
        .field('sheetId', 'sheet_ops')
        .field('fieldId', 'fld_files')
        .attach('file', Buffer.from('hello world'), 'brief.txt')
        .expect(201)

      expect(upload.body.ok).toBe(true)
      expect(upload.body.data.attachment).toMatchObject({
        id: uploadedAttachmentId,
        filename: 'brief.txt',
        mimeType: 'text/plain',
        size: 11,
      })
      await expect(fs.stat(path.join(attachmentPath, storedPath))).resolves.toBeTruthy()

      const download = await request(app)
        .get(`/api/multitable/attachments/${uploadedAttachmentId}`)
        .expect(200)

      expect(download.headers['content-type']).toContain('text/plain')
      expect(download.text).toBe('hello world')
    } finally {
      await fs.rm(attachmentPath, { recursive: true, force: true })
    }
  })

  test('allows attachment download when sheet read grant exists without global multitable permission', async () => {
    const attachmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'multitable-attachment-read-scope-'))

    try {
      const { app } = await createApp({
        attachmentPath,
        mockStorageDownload: Buffer.from('scoped attachment'),
        queryHandler: async (sql, params) => {
          if (sql.includes('FROM multitable_attachments') && sql.includes('storage_file_id')) {
            expect(params).toEqual(['att_sheet_scope'])
            return {
              rows: [{
                id: 'att_sheet_scope',
                sheet_id: 'sheet_acl',
                storage_file_id: 'storage_att_sheet_scope',
                filename: 'scope.txt',
                original_name: 'scope.txt',
                mime_type: 'text/plain',
                size: 17,
              }],
            }
          }
          if (sql.includes('FROM spreadsheet_permissions')) {
            expect(params).toEqual(['user_multitable_attachments', ['sheet_acl']])
            return {
              rows: [{ sheet_id: 'sheet_acl', perm_code: 'spreadsheet:read', subject_type: 'user' }],
            }
          }
          throw new Error(`Unhandled SQL in test: ${sql}`)
        },
      })

      const response = await request(app)
        .get('/api/multitable/attachments/att_sheet_scope')
        .expect(200)

      expect(response.headers['content-type']).toContain('text/plain')
      expect(response.text).toBe('scoped attachment')
    } finally {
      await fs.rm(attachmentPath, { recursive: true, force: true })
    }
  })

  test('allows attachment download when sheet write-own grant exists without global multitable permission', async () => {
    const attachmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'multitable-attachment-own-scope-'))

    try {
      const { app } = await createApp({
        attachmentPath,
        mockStorageDownload: Buffer.from('owner scoped attachment'),
        queryHandler: async (sql, params) => {
          if (sql.includes('FROM multitable_attachments') && sql.includes('storage_file_id')) {
            expect(params).toEqual(['att_sheet_write_own'])
            return {
              rows: [{
                id: 'att_sheet_write_own',
                sheet_id: 'sheet_acl',
                storage_file_id: 'storage_att_sheet_write_own',
                filename: 'own.txt',
                original_name: 'own.txt',
                mime_type: 'text/plain',
                size: 23,
              }],
            }
          }
          if (sql.includes('FROM spreadsheet_permissions')) {
            expect(params).toEqual(['user_multitable_attachments', ['sheet_acl']])
            return {
              rows: [{
                sheet_id: 'sheet_acl',
                perm_code: 'spreadsheet:write-own',
                subject_type: 'user',
              }],
            }
          }
          throw new Error(`Unhandled SQL in test: ${sql}`)
        },
      })

      const response = await request(app)
        .get('/api/multitable/attachments/att_sheet_write_own')
        .expect(200)

      expect(response.headers['content-type']).toContain('text/plain')
      expect(response.text).toBe('owner scoped attachment')
    } finally {
      await fs.rm(attachmentPath, { recursive: true, force: true })
    }
  })

  test('rejects attachment download when sheet permission has no read access', async () => {
    const attachmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'multitable-attachment-read-blocked-'))

    try {
      const { app } = await createApp({
        attachmentPath,
        mockStorageDownload: Buffer.from('blocked attachment'),
        queryHandler: async (sql, params) => {
          if (sql.includes('FROM multitable_attachments') && sql.includes('storage_file_id')) {
            expect(params).toEqual(['att_sheet_blocked'])
            return {
              rows: [{
                id: 'att_sheet_blocked',
                sheet_id: 'sheet_acl',
                storage_file_id: 'storage_att_sheet_blocked',
                filename: 'blocked.txt',
                original_name: 'blocked.txt',
                mime_type: 'text/plain',
                size: 18,
              }],
            }
          }
          if (sql.includes('FROM spreadsheet_permissions')) {
            expect(params).toEqual(['user_multitable_attachments', ['sheet_acl']])
            return {
              rows: [{ sheet_id: 'sheet_acl', perm_code: 'spreadsheet:comment', subject_type: 'user' }],
            }
          }
          throw new Error(`Unhandled SQL in test: ${sql}`)
        },
      })

      const response = await request(app)
        .get('/api/multitable/attachments/att_sheet_blocked')
        .expect(403)

      expect(response.body).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      })
    } finally {
      await fs.rm(attachmentPath, { recursive: true, force: true })
    }
  })

  test('deletes an attachment and removes it from the owning record field', async () => {
    const attachmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'multitable-attachment-delete-'))
    let storedPath = ''
    let storedFileId = ''
    let uploadedAttachmentId = ''

    try {
      const { app, publishSpy } = await createApp({
        attachmentPath,
        tokenPerms: ['multitable:write', 'multitable:read'],
        queryHandler: async (sql, params) => {
          if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
            return { rows: [{ id: 'sheet_ops' }] }
          }
          if (sql.includes('SELECT id, type FROM meta_fields WHERE id = $1 AND sheet_id = $2')) {
            return { rows: [{ id: 'fld_files', type: 'attachment' }] }
          }
          if (sql.includes('FROM spreadsheet_permissions')) {
            expect(params).toEqual(['user_multitable_attachments', ['sheet_ops']])
            return { rows: [] }
          }
          if (sql.includes('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
            return { rows: [{ id: 'rec_ops_1' }] }
          }
          if (sql.includes('SELECT id, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
            expect(params).toEqual(['rec_ops_1', 'sheet_ops'])
            return { rows: [{ id: 'rec_ops_1', created_by: 'user_multitable_attachments' }] }
          }
          if (sql.includes('INSERT INTO multitable_attachments')) {
            uploadedAttachmentId = String(params?.[0] ?? '')
            storedFileId = String(params?.[4] ?? '')
            storedPath = String(params?.[9] ?? '')
            return {
              rows: [{
                id: uploadedAttachmentId,
                filename: params?.[5],
                original_name: params?.[6],
                mime_type: params?.[7],
                size: params?.[8],
                created_at: '2026-03-19T10:40:00.000Z',
              }],
            }
          }
          if (sql.includes('SELECT id, sheet_id, record_id, field_id, storage_file_id')) {
            expect(params).toEqual([uploadedAttachmentId])
            return {
              rows: [{
                id: uploadedAttachmentId,
                sheet_id: 'sheet_ops',
                record_id: 'rec_ops_1',
                field_id: 'fld_files',
                storage_file_id: storedFileId,
              }],
            }
          }
          if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
            expect(params).toEqual(['rec_ops_1', 'sheet_ops'])
            return {
              rows: [{
                id: 'rec_ops_1',
                version: 2,
                data: { fld_files: [uploadedAttachmentId, 'att_keep'] },
              }],
            }
          }
          if (sql.includes('SELECT id, created_by FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
            expect(params).toEqual(['sheet_ops', ['rec_ops_1']])
            return {
              rows: [{ id: 'rec_ops_1', created_by: 'user_multitable_attachments' }],
            }
          }
          if (sql.includes('UPDATE meta_records') && sql.includes('version = version + 1')) {
            expect(params).toEqual([JSON.stringify({ fld_files: ['att_keep'] }), 'rec_ops_1', 'sheet_ops'])
            return { rows: [{ version: 3 }] }
          }
          if (sql.includes('UPDATE multitable_attachments SET deleted_at = now(), updated_at = now()')) {
            expect(params).toEqual([uploadedAttachmentId])
            return { rows: [] }
          }
          throw new Error(`Unhandled SQL in test: ${sql}`)
        },
      })

      await request(app)
        .post('/api/multitable/attachments')
        .field('sheetId', 'sheet_ops')
        .field('recordId', 'rec_ops_1')
        .field('fieldId', 'fld_files')
        .attach('file', Buffer.from('delete me'), 'cleanup.txt')
        .expect(201)

      await expect(fs.stat(path.join(attachmentPath, storedPath))).resolves.toBeTruthy()

      const deleted = await request(app)
        .delete(`/api/multitable/attachments/${uploadedAttachmentId}`)
        .expect(200)

      expect(deleted.body).toEqual({
        ok: true,
        data: { deleted: uploadedAttachmentId },
      })
      expect(publishSpy).toHaveBeenCalledWith('spreadsheet.cell.updated', {
        spreadsheetId: 'sheet_ops',
        actorId: 'user_multitable_attachments',
        source: 'multitable',
        kind: 'attachment-updated',
        recordId: 'rec_ops_1',
        recordIds: ['rec_ops_1'],
        fieldIds: ['fld_files'],
        recordPatches: [{
          recordId: 'rec_ops_1',
          version: 3,
          patch: { fld_files: ['att_keep'] },
        }],
      })
      await expect(fs.stat(path.join(attachmentPath, storedPath))).rejects.toThrow()
    } finally {
      await fs.rm(attachmentPath, { recursive: true, force: true })
    }
  })
})

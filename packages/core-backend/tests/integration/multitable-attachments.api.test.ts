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
}) {
  vi.resetModules()
  process.env.ATTACHMENT_PATH = args.attachmentPath

  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(args.fallbackPermissions ?? []),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

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

  return { app, mockPool }
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
      const { app } = await createApp({
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

  test('deletes an attachment and removes it from the owning record field', async () => {
    const attachmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'multitable-attachment-delete-'))
    let storedPath = ''
    let storedFileId = ''
    let uploadedAttachmentId = ''

    try {
      const { app } = await createApp({
        attachmentPath,
        tokenPerms: ['multitable:write', 'multitable:read'],
        queryHandler: async (sql, params) => {
          if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
            return { rows: [{ id: 'sheet_ops' }] }
          }
          if (sql.includes('SELECT id, type FROM meta_fields WHERE id = $1 AND sheet_id = $2')) {
            return { rows: [{ id: 'fld_files', type: 'attachment' }] }
          }
          if (sql.includes('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
            return { rows: [{ id: 'rec_ops_1' }] }
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
      await expect(fs.stat(path.join(attachmentPath, storedPath))).rejects.toThrow()
    } finally {
      await fs.rm(attachmentPath, { recursive: true, force: true })
    }
  })
})

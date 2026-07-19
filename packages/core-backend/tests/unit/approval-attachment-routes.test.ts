/** Attachment routes — authorizeCreate before multer, plural path, scan, participation (pinned server). */
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { describe, expect, test, vi } from 'vitest'

import {
  APPROVAL_ATTACHMENTS_PATH_PREFIX,
  createApprovalAttachmentRouter,
  isApprovalAttachmentsEnabled,
} from '../../src/routes/approval-attachments'
import { APPROVAL_ATTACHMENT_LIMITS } from '../../src/services/approval-attachment-validation'
import type { ApprovalAttachmentStore } from '../../src/services/approval-attachment-storage'
import type { ScanHook } from '../../src/services/approval-attachment-scan'
import { usePinnedServer } from '../utils/pinned-server'

const FLAG_ON = { APPROVAL_ATTACHMENTS_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv
const pinned = usePinnedServer()

function makeApp(over: {
  rows?: unknown[]
  viewer?: { id: string; roles?: string[]; isAdmin?: boolean } | null
  participant?: boolean
  hidden?: boolean
  org?: string | null
  uploadTarget?: 'ok' | 'not_found' | 'not_published' | 'not_attachment_field'
  authorizeCreate?: (req: Request, res: Response, next: NextFunction) => void
  storeUnavailable?: boolean
  scanHook?: ScanHook
  storePut?: ReturnType<typeof vi.fn>
} = {}) {
  const blobs = new Map<string, Buffer>()
  const inserted: unknown[][] = []
  const storePut = over.storePut ?? vi.fn(async (k: string, b: Buffer) => void blobs.set(k, b))
  const store: ApprovalAttachmentStore = {
    put: storePut as ApprovalAttachmentStore['put'],
    get: async (k) => {
      const b = blobs.get(k)
      if (!b) throw new Error('missing')
      return b
    },
    delete: async (k) => blobs.delete(k),
  }
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO approval_attachments')) {
        inserted.push(params ?? [])
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('WITH doomed')) {
        if (params?.[1] !== 'u1' || params?.[0] === 'att_bound') return { rows: [], rowCount: 0 }
        return { rows: [{ id: 'pi_del_att_1' }], rowCount: 1 }
      }
      return { rows: over.rows ?? [], rowCount: (over.rows ?? []).length }
    },
  }
  const targetCode = over.uploadTarget ?? 'ok'
  const denyCreate =
    over.authorizeCreate ??
    ((_req: Request, _res: Response, next: NextFunction) => next())
  const viewer =
    over.viewer === null
      ? null
      : over.viewer === undefined
        ? { id: 'u1', roles: [] as string[], isAdmin: false }
        : { id: over.viewer.id, roles: over.viewer.roles ?? [], isAdmin: over.viewer.isAdmin ?? false }

  const router = createApprovalAttachmentRouter({
    db,
    store,
    storeUnavailable: over.storeUnavailable,
    scanHook: over.scanHook,
    authorizeCreate: denyCreate,
    authChecks: {
      isInstanceParticipant: async () => over.participant ?? false,
      isFieldHiddenAtActiveNode: async () => over.hidden ?? false,
    },
    viewerContext: () => viewer,
    orgId: () => (over.org === undefined ? 'org1' : over.org),
    uploadActor: () => (viewer ? { userId: viewer.id, departmentIds: [], roles: viewer.roles, isTemplateManager: false } : null),
    authorizeUploadTarget: async () =>
      targetCode === 'ok' ? { ok: true } : { ok: false, code: targetCode },
    env: FLAG_ON,
  })
  const app = express()
  if (router) app.use(router)
  return { app, blobs, inserted, storePut, router }
}

describe('approval attachment routes', () => {
  test('wire path is plural /api/approvals/attachments', () => {
    expect(APPROVAL_ATTACHMENTS_PATH_PREFIX).toBe('/api/approvals/attachments')
    expect(isApprovalAttachmentsEnabled({} as NodeJS.ProcessEnv)).toBe(false)
  })

  test('flag OFF → factory returns null', () => {
    const r = createApprovalAttachmentRouter({
      db: { query: async () => ({ rows: [], rowCount: 0 }) },
      store: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => false },
      authChecks: { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false },
      viewerContext: () => ({ id: 'u1', roles: [], isAdmin: false }),
      orgId: () => 'org1',
      authorizeCreate: (_r, _s, n) => n(),
      uploadActor: () => ({ userId: 'u1' }),
      authorizeUploadTarget: async () => ({ ok: true }),
      env: {} as NodeJS.ProcessEnv,
    })
    expect(r).toBeNull()
  })

  test('authorizeCreate denial runs BEFORE multer/store — no put, no parse side-effect', async () => {
    const storePut = vi.fn(async () => {})
    let createCalled = false
    const { app } = makeApp({
      storePut,
      authorizeCreate: (_req, res) => {
        createCalled = true
        res.status(403).json({ error: 'Authentication required' })
      },
    })
    pinned.setApp(app)
    const r = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(createCalled).toBe(true)
    expect(r.status).toBe(403)
    expect(storePut).not.toHaveBeenCalled() // denial before store
  })

  test('positive control: authorizeCreate next() + visible template → 201 + store put', async () => {
    const storePut = vi.fn(async (k: string, b: Buffer) => {})
    const { app, inserted } = makeApp({ storePut })
    pinned.setApp(app)
    // wrap storePut to also record
    const r = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(201)
    expect(storePut).toHaveBeenCalled()
    expect(inserted[0][8]).toBe('unscanned')
  })

  test('upload: invisible template 404; non-attachment field 400; oversize 413', async () => {
    const invis = makeApp({ uploadTarget: 'not_found' })
    pinned.setApp(invis.app)
    expect(
      (
        await request(pinned.url())
          .post('/api/approvals/attachments')
          .field('fieldId', 'f')
          .field('templateId', 'secret')
          .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
      ).status,
    ).toBe(404)
    expect(invis.blobs.size).toBe(0)

    const bad = makeApp({ uploadTarget: 'not_attachment_field' })
    pinned.setApp(bad.app)
    expect(
      (
        await request(pinned.url())
          .post('/api/approvals/attachments')
          .field('fieldId', 'x')
          .field('templateId', 't')
          .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
      ).status,
    ).toBe(400)

    const big = makeApp()
    pinned.setApp(big.app)
    const r = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'f')
      .field('templateId', 't')
      .attach('file', Buffer.alloc(APPROVAL_ATTACHMENT_LIMITS.maxFileBytes + 1), {
        filename: 'big.pdf',
        contentType: 'application/pdf',
      })
    expect(r.status).toBe(413)
  })

  test('download: participant 200 + G8 headers; non-participant 404; hidden 404; infected 404', async () => {
    const row = {
      status: 'bound',
      uploader_id: 'up1',
      instance_id: 'i1',
      field_id: 'fld1',
      storage_key: 'k1',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      scan_state: 'clean',
    }
    const ok = makeApp({ rows: [row], participant: true })
    ok.blobs.set('k1', Buffer.from('%PDF'))
    pinned.setApp(ok.app)
    const good = await request(pinned.url()).get('/api/approvals/attachments/att_1/download')
    expect(good.status).toBe(200)
    expect(good.headers['content-disposition']).toMatch(/^attachment;/)
    expect(good.headers['content-security-policy']).toBe("default-src 'none'")

    const deny = makeApp({ rows: [row], participant: false })
    pinned.setApp(deny.app)
    expect((await request(pinned.url()).get('/api/approvals/attachments/att_1/download')).status).toBe(404)

    const hidden = makeApp({ rows: [row], participant: true, hidden: true })
    hidden.blobs.set('k1', Buffer.from('%PDF'))
    pinned.setApp(hidden.app)
    expect((await request(pinned.url()).get('/api/approvals/attachments/att_1/download')).status).toBe(404)

    const infected = makeApp({
      rows: [{ ...row, scan_state: 'infected' }],
      participant: true,
    })
    infected.blobs.set('k1', Buffer.from('%PDF'))
    pinned.setApp(infected.app)
    expect((await request(pinned.url()).get('/api/approvals/attachments/att_1/download')).status).toBe(404)
  })

  test('singular path not registered', async () => {
    const { app } = makeApp()
    pinned.setApp(app)
    expect(
      (
        await request(pinned.url())
          .post('/api/approval/attachments')
          .field('fieldId', 'f')
          .field('templateId', 't')
          .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
      ).status,
    ).toBe(404)
  })

  test('DELETE unbound 204; O3 store unavailable 503', async () => {
    const { app } = makeApp()
    pinned.setApp(app)
    expect((await request(pinned.url()).delete('/api/approvals/attachments/att_1')).status).toBe(204)
    const s503 = makeApp({ storeUnavailable: true })
    pinned.setApp(s503.app)
    expect(
      (
        await request(pinned.url())
          .post('/api/approvals/attachments')
          .field('fieldId', 'f')
          .field('templateId', 't')
          .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
      ).status,
    ).toBe(503)
  })
})

/** Attachment routes — flag gate, write+visibility upload auth, plural path, scan_state, G8 (pinned server). */
import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

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
  viewer?: string | null
  participant?: boolean
  hidden?: boolean
  org?: string | null
  uploadTarget?: 'ok' | 'not_found' | 'not_published' | 'not_attachment_field'
  canCreate?: boolean
  storeUnavailable?: boolean
  scanHook?: ScanHook
  insertCapture?: unknown[][]
} = {}) {
  const blobs = new Map<string, Buffer>()
  const inserted: unknown[][] = over.insertCapture ?? []
  const store: ApprovalAttachmentStore = {
    put: async (k, b) => void blobs.set(k, b),
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
  const router = createApprovalAttachmentRouter({
    db,
    store,
    storeUnavailable: over.storeUnavailable,
    scanHook: over.scanHook,
    authChecks: {
      isInstanceParticipant: async () => over.participant ?? false,
      isFieldHiddenAtActiveNode: async () => over.hidden ?? false,
    },
    viewerId: () => (over.viewer === undefined ? 'u1' : over.viewer),
    orgId: () => (over.org === undefined ? 'org1' : over.org),
    canCreateApproval: async () => over.canCreate !== false,
    uploadActor: () => ({ userId: 'u1', departmentIds: [], roles: [], isTemplateManager: false }),
    authorizeUploadTarget: async () =>
      targetCode === 'ok' ? { ok: true } : { ok: false, code: targetCode },
    env: FLAG_ON,
  })
  const app = express()
  if (router) app.use(router)
  return { app, blobs, inserted, router }
}

describe('approval attachment routes (flag-gated, lock §4 plural path)', () => {
  test('wire path is plural /api/approvals/attachments (lock §4.1)', () => {
    expect(APPROVAL_ATTACHMENTS_PATH_PREFIX).toBe('/api/approvals/attachments')
  })

  test('flag OFF → factory returns null (nothing registered)', () => {
    expect(isApprovalAttachmentsEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    const r = createApprovalAttachmentRouter({
      db: { query: async () => ({ rows: [], rowCount: 0 }) },
      store: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => false },
      authChecks: { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false },
      viewerId: () => 'u1',
      orgId: () => 'org1',
      canCreateApproval: async () => true,
      uploadActor: () => ({ userId: 'u1' }),
      authorizeUploadTarget: async () => ({ ok: true }),
      env: {} as NodeJS.ProcessEnv,
    })
    expect(r).toBeNull()
  })

  test('upload happy path on plural path: 201, server key + org, client path ignored', async () => {
    const { app, inserted, blobs } = makeApp()
    pinned.setApp(app)
    const r = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .field('orgId', 'FORGED-ORG')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: '../../evil.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(201)
    expect(r.body.id).toMatch(/^att_/)
    expect(inserted[0][1]).toBe('org1')
    const storageKey = inserted[0][4] as string
    expect(storageKey).toMatch(/^approval\/\d{4}-\d{2}\/[0-9a-f-]{36}\.pdf$/)
    expect(blobs.has(storageKey)).toBe(true)
    // scan_state column present (pass-through default unscanned)
    expect(inserted[0][8]).toBe('unscanned')
  })

  test('upload auth: unauthenticated 401; no create capability 403; invisible template 404; non-attachment field 400', async () => {
    const anon = makeApp({ viewer: null })
    pinned.setApp(anon.app)
    expect((await request(pinned.url()).post('/api/approvals/attachments').field('fieldId', 'f').field('templateId', 't')).status).toBe(401)

    const noWrite = makeApp({ canCreate: false })
    pinned.setApp(noWrite.app)
    const denied = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'f')
      .field('templateId', 't')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(denied.status).toBe(403)
    expect(denied.body.error).toBe('forbidden')

    // Positive control: same file with write capability + visible template succeeds
    const ok = makeApp({ canCreate: true, uploadTarget: 'ok' })
    pinned.setApp(ok.app)
    const allowed = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'f')
      .field('templateId', 't')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(allowed.status).toBe(201)

    // Invisible template → 404 (not 400 — no existence oracle), blob never written
    const invis = makeApp({ uploadTarget: 'not_found' })
    pinned.setApp(invis.app)
    const r404 = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'f')
      .field('templateId', 'secret-tpl')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(r404.status).toBe(404)
    expect(invis.blobs.size).toBe(0)

    const badField = makeApp({ uploadTarget: 'not_attachment_field' })
    pinned.setApp(badField.app)
    const r400 = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'not_att')
      .field('templateId', 't')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(r400.status).toBe(400)
    expect(r400.body.error).toBe('not_an_attachment_field')
    expect(badField.blobs.size).toBe(0)
  })

  test('upload over multer byte cap → 413 values-free', async () => {
    const { app, blobs } = makeApp()
    pinned.setApp(app)
    const tooBig = Buffer.alloc(APPROVAL_ATTACHMENT_LIMITS.maxFileBytes + 1)
    const r = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', tooBig, { filename: 'big.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(413)
    expect(r.body).toEqual({ error: 'rejected', rejected: [{ code: 'file_too_large' }] })
    expect(blobs.size).toBe(0)
  })

  test('scanHook infected → 422; row persisted with infected; download/meta refuse; clean positive control', async () => {
    const infectedHook: ScanHook = async () => 'infected'
    const { app, inserted, blobs } = makeApp({ scanHook: infectedHook })
    pinned.setApp(app)
    const r = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'bad.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(422)
    expect(r.body.rejected[0].code).toBe('infected')
    expect(inserted[0][8]).toBe('infected')
    expect(blobs.size).toBe(1) // blob written for audit/GC; client got no usable id

    // Download of infected bound/unbound row refused after auth
    const row = {
      status: 'unbound',
      uploader_id: 'u1',
      instance_id: null,
      field_id: 'fld1',
      storage_key: 'approval/2026-07/x.pdf',
      file_name: 'bad.pdf',
      mime_type: 'application/pdf',
      scan_state: 'infected',
    }
    const dl = makeApp({ rows: [row], viewer: 'u1' })
    dl.blobs.set('approval/2026-07/x.pdf', Buffer.from('%PDF'))
    pinned.setApp(dl.app)
    expect((await request(pinned.url()).get('/api/approvals/attachments/att_inf/download')).status).toBe(404)
    const meta = await request(pinned.url()).get('/api/approvals/attachments/att_inf')
    expect(meta.status).toBe(200)
    expect(meta.body.tombstone).toBe(true)

    // Positive control: pass-through unscanned still downloads
    const clean = {
      status: 'bound',
      uploader_id: 'up1',
      instance_id: 'i1',
      field_id: 'fld1',
      storage_key: 'k1',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      scan_state: 'unscanned',
    }
    const ok = makeApp({ rows: [clean], participant: true })
    ok.blobs.set('k1', Buffer.from('%PDF'))
    pinned.setApp(ok.app)
    expect((await request(pinned.url()).get('/api/approvals/attachments/att_1/download')).status).toBe(200)
  })

  test('download: G8 headers + participant/non-participant + hidden redaction', async () => {
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
    expect(good.headers['x-content-type-options']).toBe('nosniff')
    expect(good.headers['content-security-policy']).toBe("default-src 'none'")

    const deny = makeApp({ rows: [row], participant: false })
    pinned.setApp(deny.app)
    expect((await request(pinned.url()).get('/api/approvals/attachments/att_1/download')).status).toBe(404)

    const hidden = makeApp({ rows: [{ ...row, field_id: 'secret' }], participant: true, hidden: true })
    hidden.blobs.set('k1', Buffer.from('%PDF'))
    pinned.setApp(hidden.app)
    expect((await request(pinned.url()).get('/api/approvals/attachments/att_1/download')).status).toBe(404)
  })

  test('O3 store unavailable → upload 503 values-free (positive control still 201)', async () => {
    const { app, blobs } = makeApp({ storeUnavailable: true })
    pinned.setApp(app)
    const denied = await request(pinned.url())
      .post('/api/approvals/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(denied.status).toBe(503)
    expect(denied.body).toEqual({ error: 'storage_unavailable' })
    expect(blobs.size).toBe(0)

    const { app: okApp } = makeApp()
    pinned.setApp(okApp)
    expect(
      (
        await request(pinned.url())
          .post('/api/approvals/attachments')
          .field('fieldId', 'fld1')
          .field('templateId', 'tpl1')
          .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
      ).status,
    ).toBe(201)
  })

  test('DELETE unbound dooms + enqueues purge intent; bound → 404', async () => {
    const { app } = makeApp()
    pinned.setApp(app)
    expect((await request(pinned.url()).delete('/api/approvals/attachments/att_1')).status).toBe(204)
    expect((await request(pinned.url()).delete('/api/approvals/attachments/att_bound')).status).toBe(404)
  })

  test('singular /api/approval/attachments is NOT registered (no parallel semantics)', async () => {
    const { app } = makeApp()
    pinned.setApp(app)
    const r = await request(pinned.url())
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(404)
  })
})

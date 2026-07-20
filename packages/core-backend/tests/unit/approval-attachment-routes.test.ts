/** Attachment slice ⑤ — route goldens (supertest over injected seams; required no-DB lane). */
import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

import { createApprovalAttachmentRouter, isApprovalAttachmentsEnabled } from '../../src/routes/approval-attachments'
import { APPROVAL_ATTACHMENT_LIMITS } from '../../src/services/approval-attachment-validation'
import type { ApprovalAttachmentStore } from '../../src/services/approval-attachment-storage'

const FLAG_ON = { APPROVAL_ATTACHMENTS_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv

// #4154 pinned-server transport: one listener for the whole suite; per-call apps stay swappable.
// serve(app) installs the app on the pinned listener and returns the URL-mode supertest transport —
// requests in this suite are strictly awaited, so swapping between sequential calls is race-free.
const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function makeApp(over: { rows?: unknown[]; viewer?: string | null; participant?: boolean; hidden?: boolean; org?: string | null; attachmentField?: boolean } = {}) {
  const blobs = new Map<string, Buffer>()
  const inserted: unknown[][] = []
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
      if (sql.startsWith('INSERT')) {
        inserted.push(params ?? [])
        return { rows: [], rowCount: 1 }
      }
      return { rows: over.rows ?? [], rowCount: (over.rows ?? []).length }
    },
  }
  const router = createApprovalAttachmentRouter({
    db,
    store,
    authChecks: {
      isInstanceParticipant: async () => over.participant ?? false,
      isFieldHiddenAtActiveNode: async () => over.hidden ?? false,
    },
    viewerId: () => (over.viewer === undefined ? 'u1' : over.viewer),
    orgId: () => (over.org === undefined ? 'org1' : over.org),
    resolveAttachmentField: async () => over.attachmentField ?? true,
    env: FLAG_ON,
  })
  const app = express()
  if (router) app.use(router)
  return { app, blobs, inserted, router }
}

describe('approval attachment routes (flag-gated)', () => {
  test('flag OFF → factory returns null (nothing registered)', () => {
    expect(isApprovalAttachmentsEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    const { router } = (() => {
      const r = createApprovalAttachmentRouter({
        db: { query: async () => ({ rows: [], rowCount: 0 }) },
        store: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => false },
        authChecks: { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false },
        viewerId: () => 'u1',
        orgId: () => 'org1',
        resolveAttachmentField: async () => true,
        env: {} as NodeJS.ProcessEnv,
      })
      return { router: r }
    })()
    expect(router).toBeNull()
  })

  test('upload happy path: 201, server-derived key + server-derived org persisted, client filename not used as path', async () => {
    const { app, inserted, blobs } = makeApp()
    const r = await serve(app)
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .field('orgId', 'FORGED-ORG') // a forged body org_id must be IGNORED
      .attach('file', Buffer.from('%PDF-1.4'), { filename: '../../evil.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(201)
    expect(r.body.id).toMatch(/^att_/)
    const orgPersisted = inserted[0][1] as string
    expect(orgPersisted).toBe('org1') // the principal's org (deps.orgId), NOT the forged body value
    const storageKey = inserted[0][4] as string
    expect(storageKey).toMatch(/^approval\/\d{4}-\d{2}\/[0-9a-f-]{36}\.pdf$/) // server key, no client path parts
    expect(blobs.has(storageKey)).toBe(true)
  })

  test('upload rejects: unauthenticated 401; principal without org 403; missing template/field 400; disallowed MIME 422', async () => {
    const anon = makeApp({ viewer: null })
    expect((await serve(anon.app).post('/api/approval/attachments').field('fieldId', 'f').field('templateId', 't')).status).toBe(401)
    const noOrg = makeApp({ org: null })
    expect((await serve(noOrg.app).post('/api/approval/attachments').field('fieldId', 'f').field('templateId', 't')).status).toBe(403)
    const { app } = makeApp()
    // missing file → 400; and a missing template/field also 400
    expect((await serve(app).post('/api/approval/attachments').field('fieldId', 'f').field('templateId', 't')).status).toBe(400)
    const bad = await serve(app)
      .post('/api/approval/attachments')
      .field('fieldId', 'f')
      .field('templateId', 't')
      .attach('file', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/x-msdownload' })
    expect(bad.status).toBe(422)
    expect(bad.body.rejected[0].code).toBe('mime_not_allowed')
  })

  // #6 route error handling: multer limit errors → values-free reject (not a framework 500 with a stack).
  test('upload over the multer byte cap → 413 values-free reject (no stack, no limit echo)', async () => {
    const { app, blobs } = makeApp()
    const tooBig = Buffer.alloc(APPROVAL_ATTACHMENT_LIMITS.maxFileBytes + 1)
    const r = await serve(app)
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', tooBig, { filename: 'big.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(413)
    expect(r.body).toEqual({ error: 'rejected', rejected: [{ code: 'file_too_large' }] }) // values-free
    expect(blobs.size).toBe(0) // never written
  })

  // #6: an async db/store rejection becomes a values-free 500, never an unhandled rejection / hung request.
  test('download whose blob store rejects → 500 (handled), not a hang', async () => {
    const row = { status: 'bound', uploader_id: 'up1', instance_id: 'i1', field_id: 'fld1', storage_key: 'gone', file_name: 'a.pdf', mime_type: 'application/pdf' }
    const app = makeApp({ rows: [row], participant: true }) // blob 'gone' is never seeded → store.get throws
    const r = await serve(app.app).get('/api/approval/attachments/att_1/download')
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'internal_error' }) // values-free
  })

  // G2: a fieldId that is NOT an attachment-typed field in the template schema is rejected (400).
  test('upload G2: a non-attachment fieldId is rejected 400; the blob is never written', async () => {
    const { app, inserted, blobs } = makeApp({ attachmentField: false })
    const r = await serve(app)
      .post('/api/approval/attachments')
      .field('fieldId', 'not_an_attachment')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('not_an_attachment_field')
    expect(inserted.length).toBe(0) // rejected before the durable row
    expect(blobs.size).toBe(0) // and before any blob write
  })

  test('download: participant streams bound blob; non-participant gets 404 (no oracle); deleted → 410', async () => {
    const row = { status: 'bound', uploader_id: 'up1', instance_id: 'i1', field_id: 'fld1', storage_key: 'k1', file_name: 'a.pdf', mime_type: 'application/pdf' }
    const ok = makeApp({ rows: [row], participant: true })
    ok.blobs.set('k1', Buffer.from('%PDF'))
    const good = await serve(ok.app).get('/api/approval/attachments/att_1/download')
    expect(good.status).toBe(200)
    expect(good.headers['content-type']).toContain('application/pdf')
    const deny = makeApp({ rows: [row], participant: false })
    expect((await serve(deny.app).get('/api/approval/attachments/att_1/download')).status).toBe(404)
    const missing = makeApp({ rows: [] })
    expect((await serve(missing.app).get('/api/approval/attachments/att_x/download')).status).toBe(404)
  })

  // G6 (no deleted-row oracle): the deleted lifecycle signal is emitted ONLY to an authorized viewer.
  test('download of a deleted row: participant sees 410 (tombstone); NON-participant sees 404 (no oracle)', async () => {
    const deleted = { status: 'deleted', uploader_id: 'up1', instance_id: 'i1', field_id: 'fld1', storage_key: 'k1', file_name: 'a.pdf', mime_type: 'application/pdf' }
    const authed = makeApp({ rows: [deleted], participant: true })
    expect((await serve(authed.app).get('/api/approval/attachments/att_1/download')).status).toBe(410)
    const outsider = makeApp({ rows: [deleted], participant: false })
    expect((await serve(outsider.app).get('/api/approval/attachments/att_1/download')).status).toBe(404) // NOT 410 — no 404→410 existence oracle
  })

  // approval-attachment-hidden-redaction (lock G7 / §4.2 gate 2 / test 6): a field hidden at the
  // active node serves NO bytes at the byte path — even to an authorized instance participant — the
  // same way redactHiddenFormFields strips it from the echoed snapshot. Non-hidden still serves.
  test('approval-attachment-hidden-redaction: participant is REFUSED (404) for a hidden field; non-hidden serves 200', async () => {
    const row = { status: 'bound', uploader_id: 'up1', instance_id: 'i1', field_id: 'secret', storage_key: 'k1', file_name: 'a.pdf', mime_type: 'application/pdf' }
    const hidden = makeApp({ rows: [row], participant: true, hidden: true })
    hidden.blobs.set('k1', Buffer.from('%PDF'))
    const refused = await serve(hidden.app).get('/api/approval/attachments/att_1/download')
    expect(refused.status).toBe(404) // hidden ⇒ same "not found" shape the snapshot redaction produces
    const visible = makeApp({ rows: [row], participant: true, hidden: false })
    visible.blobs.set('k1', Buffer.from('%PDF'))
    const served = await serve(visible.app).get('/api/approval/attachments/att_1/download')
    expect(served.status).toBe(200) // positive control: an identical NON-hidden field still serves bytes
  })
})

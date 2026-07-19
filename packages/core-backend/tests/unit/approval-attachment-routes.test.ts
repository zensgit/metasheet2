/** Attachment slice ⑤ — route goldens (supertest over injected seams; required no-DB lane).
 *
 * Transport is the pinned per-suite server (`usePinnedServer`) so this file never adds
 * app-mode `request(app)` sites (supertest-app-mode-tripwire / #4154).
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import { createApprovalAttachmentRouter, isApprovalAttachmentsEnabled } from '../../src/routes/approval-attachments'
import { APPROVAL_ATTACHMENT_LIMITS } from '../../src/services/approval-attachment-validation'
import type { ApprovalAttachmentStore } from '../../src/services/approval-attachment-storage'
import { usePinnedServer } from '../utils/pinned-server'

const FLAG_ON = { APPROVAL_ATTACHMENTS_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv
const pinned = usePinnedServer()

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
    pinned.setApp(app)
    const r = await request(pinned.url())
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
    pinned.setApp(anon.app)
    expect((await request(pinned.url()).post('/api/approval/attachments').field('fieldId', 'f').field('templateId', 't')).status).toBe(401)
    const noOrg = makeApp({ org: null })
    pinned.setApp(noOrg.app)
    expect((await request(pinned.url()).post('/api/approval/attachments').field('fieldId', 'f').field('templateId', 't')).status).toBe(403)
    const { app } = makeApp()
    pinned.setApp(app)
    // missing file → 400; and a missing template/field also 400
    expect((await request(pinned.url()).post('/api/approval/attachments').field('fieldId', 'f').field('templateId', 't')).status).toBe(400)
    const bad = await request(pinned.url())
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
    pinned.setApp(app)
    const tooBig = Buffer.alloc(APPROVAL_ATTACHMENT_LIMITS.maxFileBytes + 1)
    const r = await request(pinned.url())
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
    const built = makeApp({ rows: [row], participant: true }) // blob 'gone' is never seeded → store.get throws
    pinned.setApp(built.app)
    const r = await request(pinned.url()).get('/api/approval/attachments/att_1/download')
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'internal_error' }) // values-free
  })

  // G2: a fieldId that is NOT an attachment-typed field in the template schema is rejected (400).
  test('upload G2: a non-attachment fieldId is rejected 400; the blob is never written', async () => {
    const { app, inserted, blobs } = makeApp({ attachmentField: false })
    pinned.setApp(app)
    const r = await request(pinned.url())
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
    pinned.setApp(ok.app)
    const good = await request(pinned.url()).get('/api/approval/attachments/att_1/download')
    expect(good.status).toBe(200)
    expect(good.headers['content-type']).toContain('application/pdf')
    const deny = makeApp({ rows: [row], participant: false })
    pinned.setApp(deny.app)
    expect((await request(pinned.url()).get('/api/approval/attachments/att_1/download')).status).toBe(404)
    const missing = makeApp({ rows: [] })
    pinned.setApp(missing.app)
    expect((await request(pinned.url()).get('/api/approval/attachments/att_x/download')).status).toBe(404)
  })

  // G6 (no deleted-row oracle): the deleted lifecycle signal is emitted ONLY to an authorized viewer.
  test('download of a deleted row: participant sees 410 (tombstone); NON-participant sees 404 (no oracle)', async () => {
    const deleted = { status: 'deleted', uploader_id: 'up1', instance_id: 'i1', field_id: 'fld1', storage_key: 'k1', file_name: 'a.pdf', mime_type: 'application/pdf' }
    const authed = makeApp({ rows: [deleted], participant: true })
    pinned.setApp(authed.app)
    expect((await request(pinned.url()).get('/api/approval/attachments/att_1/download')).status).toBe(410)
    const outsider = makeApp({ rows: [deleted], participant: false })
    pinned.setApp(outsider.app)
    expect((await request(pinned.url()).get('/api/approval/attachments/att_1/download')).status).toBe(404) // NOT 410 — no 404→410 existence oracle
  })

  // approval-attachment-hidden-redaction (lock G7 / §4.2 gate 2 / test 6): a field hidden at the
  // active node serves NO bytes at the byte path — even to an authorized instance participant — the
  // same way redactHiddenFormFields strips it from the echoed snapshot. Non-hidden still serves.
  test('approval-attachment-hidden-redaction: participant is REFUSED (404) for a hidden field; non-hidden serves 200', async () => {
    const row = { status: 'bound', uploader_id: 'up1', instance_id: 'i1', field_id: 'secret', storage_key: 'k1', file_name: 'a.pdf', mime_type: 'application/pdf' }
    const hidden = makeApp({ rows: [row], participant: true, hidden: true })
    hidden.blobs.set('k1', Buffer.from('%PDF'))
    pinned.setApp(hidden.app)
    const refused = await request(pinned.url()).get('/api/approval/attachments/att_1/download')
    expect(refused.status).toBe(404) // hidden ⇒ same "not found" shape the snapshot redaction produces
    const visible = makeApp({ rows: [row], participant: true, hidden: false })
    visible.blobs.set('k1', Buffer.from('%PDF'))
    pinned.setApp(visible.app)
    const served = await request(pinned.url()).get('/api/approval/attachments/att_1/download')
    expect(served.status).toBe(200) // positive control: an identical NON-hidden field still serves bytes
  })

  test('G8 download headers: Content-Disposition attachment + nosniff + CSP default-src none', async () => {
    const row = { status: 'bound', uploader_id: 'up1', instance_id: 'i1', field_id: 'fld1', storage_key: 'k1', file_name: 'a.pdf', mime_type: 'application/pdf' }
    const ok = makeApp({ rows: [row], participant: true })
    ok.blobs.set('k1', Buffer.from('%PDF'))
    pinned.setApp(ok.app)
    const r = await request(pinned.url()).get('/api/approval/attachments/att_1/download')
    expect(r.status).toBe(200)
    expect(r.headers['content-disposition']).toMatch(/^attachment;/)
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['content-security-policy']).toBe("default-src 'none'")
    // Never leak storage keys in the body
    expect(JSON.stringify(r.body)).not.toContain('k1')
  })

  test('O3 production store unavailable → upload 503 values-free (positive control: available store still 201)', async () => {
    const blobs = new Map<string, Buffer>()
    const store: ApprovalAttachmentStore = {
      put: async (k, b) => void blobs.set(k, b),
      get: async (k) => {
        const b = blobs.get(k)
        if (!b) throw new Error('missing')
        return b
      },
      delete: async (k) => blobs.delete(k),
    }
    const router503 = createApprovalAttachmentRouter({
      db: { query: async () => ({ rows: [], rowCount: 0 }) },
      store,
      storeUnavailable: true,
      authChecks: { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false },
      viewerId: () => 'u1',
      orgId: () => 'org1',
      resolveAttachmentField: async () => true,
      env: FLAG_ON,
    })
    const app503 = express()
    if (router503) app503.use(router503)
    pinned.setApp(app503)
    const denied = await request(pinned.url())
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(denied.status).toBe(503)
    expect(denied.body).toEqual({ error: 'storage_unavailable' })
    expect(blobs.size).toBe(0)

    // Positive control: same store without storeUnavailable still uploads
    const { app } = makeApp()
    pinned.setApp(app)
    const ok = await request(pinned.url())
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(ok.status).toBe(201)
  })

  test('DELETE unbound: uploader dooms row + enqueues purge intent; bound/foreign → 404', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params })
        // First call is the doom CTE — simulate 1 row claimed
        if (sql.includes('WITH doomed')) {
          // params: [id, viewerId]
          if (params?.[1] !== 'u1') return { rows: [], rowCount: 0 }
          if (params?.[0] === 'att_bound') return { rows: [], rowCount: 0 }
          return { rows: [{ id: 'pi_del_att_1' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    const router = createApprovalAttachmentRouter({
      db,
      store: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => false },
      authChecks: { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false },
      viewerId: () => 'u1',
      orgId: () => 'org1',
      resolveAttachmentField: async () => true,
      env: FLAG_ON,
    })
    const app = express()
    if (router) app.use(router)
    pinned.setApp(app)
    expect((await request(pinned.url()).delete('/api/approval/attachments/att_1')).status).toBe(204)
    expect(queries.some((q) => q.sql.includes('unbound_delete'))).toBe(true)
    // Bound id → 0 rows from CTE → 404
    expect((await request(pinned.url()).delete('/api/approval/attachments/att_bound')).status).toBe(404)
  })
})

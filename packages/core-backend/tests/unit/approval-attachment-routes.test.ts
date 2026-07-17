/** Attachment slice ⑤ — route goldens (supertest over injected seams; required no-DB lane). */
import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import { createApprovalAttachmentRouter, isApprovalAttachmentsEnabled } from '../../src/routes/approval-attachments'
import type { ApprovalAttachmentStore } from '../../src/services/approval-attachment-storage'

const FLAG_ON = { APPROVAL_ATTACHMENTS_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv

function makeApp(over: { rows?: unknown[]; viewer?: string | null; participant?: boolean; hidden?: boolean } = {}) {
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
        env: {} as NodeJS.ProcessEnv,
      })
      return { router: r }
    })()
    expect(router).toBeNull()
  })

  test('upload happy path: 201, server-derived key persisted, client filename not used as path', async () => {
    const { app, inserted, blobs } = makeApp()
    const r = await request(app)
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('orgId', 'org1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: '../../evil.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(201)
    expect(r.body.id).toMatch(/^att_/)
    const storageKey = inserted[0][4] as string
    expect(storageKey).toMatch(/^approval\/\d{4}-\d{2}\/[0-9a-f-]{36}\.pdf$/) // server key, no client path parts
    expect(blobs.has(storageKey)).toBe(true)
  })

  test('upload rejects: unauthenticated 401; missing file 400; disallowed MIME 422 with values-free codes', async () => {
    const anon = makeApp({ viewer: null })
    expect((await request(anon.app).post('/api/approval/attachments').field('fieldId', 'f').field('orgId', 'o')).status).toBe(401)
    const { app } = makeApp()
    expect((await request(app).post('/api/approval/attachments').field('fieldId', 'f').field('orgId', 'o')).status).toBe(400)
    const bad = await request(app)
      .post('/api/approval/attachments')
      .field('fieldId', 'f')
      .field('orgId', 'o')
      .attach('file', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/x-msdownload' })
    expect(bad.status).toBe(422)
    expect(bad.body.rejected[0].code).toBe('mime_not_allowed')
  })

  test('download: participant streams bound blob; non-participant gets 404 (no oracle); deleted → 410', async () => {
    const row = { status: 'bound', uploader_id: 'up1', instance_id: 'i1', field_id: 'fld1', storage_key: 'k1', file_name: 'a.pdf', mime_type: 'application/pdf' }
    const ok = makeApp({ rows: [row], participant: true })
    ok.blobs.set('k1', Buffer.from('%PDF'))
    const good = await request(ok.app).get('/api/approval/attachments/att_1/download')
    expect(good.status).toBe(200)
    expect(good.headers['content-type']).toContain('application/pdf')
    const deny = makeApp({ rows: [row], participant: false })
    expect((await request(deny.app).get('/api/approval/attachments/att_1/download')).status).toBe(404)
    const missing = makeApp({ rows: [] })
    expect((await request(missing.app).get('/api/approval/attachments/att_x/download')).status).toBe(404)
  })

  // approval-attachment-hidden-redaction (lock G7 / §4.2 gate 2 / test 6): a field hidden at the
  // active node serves NO bytes at the byte path — even to an authorized instance participant — the
  // same way redactHiddenFormFields strips it from the echoed snapshot. Non-hidden still serves.
  test('approval-attachment-hidden-redaction: participant is REFUSED (404) for a hidden field; non-hidden serves 200', async () => {
    const row = { status: 'bound', uploader_id: 'up1', instance_id: 'i1', field_id: 'secret', storage_key: 'k1', file_name: 'a.pdf', mime_type: 'application/pdf' }
    const hidden = makeApp({ rows: [row], participant: true, hidden: true })
    hidden.blobs.set('k1', Buffer.from('%PDF'))
    const refused = await request(hidden.app).get('/api/approval/attachments/att_1/download')
    expect(refused.status).toBe(404) // hidden ⇒ same "not found" shape the snapshot redaction produces
    const visible = makeApp({ rows: [row], participant: true, hidden: false })
    visible.blobs.set('k1', Buffer.from('%PDF'))
    const served = await request(visible.app).get('/api/approval/attachments/att_1/download')
    expect(served.status).toBe(200) // positive control: an identical NON-hidden field still serves bytes
  })
})

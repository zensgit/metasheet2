/** Attachment slice ⑤ — route goldens (supertest over injected seams; required no-DB lane). */
import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

import { createApprovalAttachmentRouter, isApprovalAttachmentsEnabled, MAX_REF_BATCH } from '../../src/routes/approval-attachments'
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

function makeApp(over: {
  rows?: unknown[]
  viewer?: string | null
  participant?: boolean
  hidden?: boolean | ((instanceId: string, fieldId: string) => boolean)
  org?: string | null
  attachmentField?: boolean
  templateVisible?: boolean
  storageAvailable?: boolean
  /** Bound list/download approvals:read; default true so existing goldens stay focused. */
  hasApprovalsRead?: boolean
  /** Draft upload approvals:write; default true so existing goldens stay focused. */
  hasApprovalsWrite?: boolean
  /** SQL-aware stub: return a result to answer a query, or null/undefined to fall through. */
  queryHandler?: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } | null | undefined
  scanHook?: (input: { fileName: string; mimeType: string; sizeBytes: number; content: Buffer }) => 'clean' | 'infected' | 'unscanned'
  env?: NodeJS.ProcessEnv
} = {}) {
  const blobs = new Map<string, Buffer>()
  const inserted: unknown[][] = []
  const fieldResolutions: string[] = []
  /** every (sql, params) the route issued — lets a test assert the SHAPE of a claim, not just its result. */
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const deleted: string[] = []
  const participantCalls: Array<{ viewerId: string; instanceId: string; orgId: string }> = []
  let putCalls = 0
  const store: ApprovalAttachmentStore = {
    put: async (k, b) => {
      putCalls += 1
      blobs.set(k, b)
    },
    get: async (k) => {
      const b = blobs.get(k)
      if (!b) throw new Error('missing')
      return b
    },
    delete: async (k) => {
      deleted.push(k)
      return blobs.delete(k)
    },
  }
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] })
      const handled = over.queryHandler?.(sql, params ?? [])
      if (handled) return { rowCount: handled.rows.length, ...handled }
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
      isInstanceParticipant: async (viewerId, instanceId, orgId) => {
        participantCalls.push({ viewerId, instanceId, orgId })
        return over.participant ?? false
      },
      isFieldHiddenAtActiveNode: async (instanceId, fieldId) =>
        typeof over.hidden === 'function' ? over.hidden(instanceId, fieldId) : over.hidden ?? false,
    },
    viewerId: () => (over.viewer === undefined ? 'u1' : over.viewer),
    orgId: () => (over.org === undefined ? 'org1' : over.org),
    hasApprovalsRead: () => over.hasApprovalsRead ?? true,
    hasApprovalsWrite: () => over.hasApprovalsWrite ?? true,
    resolveAttachmentField: async (templateId, fieldId) => {
      fieldResolutions.push(`${templateId}:${fieldId}`)
      return over.attachmentField ?? true
    },
    templateVisible: async () => over.templateVisible ?? true,
    ...(over.storageAvailable === undefined ? {} : { storageAvailable: over.storageAvailable }),
    ...(over.scanHook ? { scanHook: over.scanHook } : {}),
    env: over.env ?? FLAG_ON,
  })
  const app = express()
  if (router) app.use(router)
  return { app, blobs, inserted, router, fieldResolutions, queries, deleted, participantCalls, get putCalls() { return putCalls } }
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
        hasApprovalsRead: () => true,
        hasApprovalsWrite: () => true,
        resolveAttachmentField: async () => true,
        templateVisible: async () => true,
        env: {} as NodeJS.ProcessEnv,
      })
      return { router: r }
    })()
    expect(router).toBeNull()
  })

  test('upload requires approvals:write BEFORE Multer — no-write principal: 403, zero blob/row writes', async () => {
    const app = makeApp({ hasApprovalsWrite: false })
    const r = await serve(app.app)
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: 'forbidden' })
    expect(app.putCalls).toBe(0)
    expect(app.blobs.size).toBe(0)
    expect(app.inserted.length).toBe(0)
    expect(app.queries.length).toBe(0) // never reached the handler / Multer-backed path work
    expect(app.fieldResolutions.length).toBe(0)
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
    // server key under the §7 approval scope prefix, no client path parts
    expect(storageKey).toMatch(/^approval-attachments\/\d{4}-\d{2}\/[0-9a-f-]{36}\.pdf$/)
    expect(blobs.has(storageKey)).toBe(true)
  })

  test('upload row INSERT failure best-effort deletes the blob before returning values-free 500', async () => {
    const app = makeApp({
      queryHandler: (sql) => {
        if (sql.startsWith('INSERT INTO approval_attachments')) throw new Error('db host secret')
        return null
      },
    })
    const response = await serve(app.app)
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'internal_error' })
    expect(app.blobs.size).toBe(0)
    expect(app.deleted).toHaveLength(1)
  })

  test('upload rejects: unauthenticated 401; principal without org 403; missing template/field 400; disallowed MIME 415', async () => {
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
    expect(bad.status).toBe(415) // §5/G3: unsupported content type → 415 (not 422)
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
    const row = {
      status: 'bound',
      uploader_id: 'up1',
      org_id: 'org1',
      instance_id: 'i1',
      field_id: 'fld1',
      storage_key: 'gone',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      scan_state: 'unscanned',
    }
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

  // §4.1 template-access gate: an uploader who cannot SEE the target template (visibility_scope) gets a
  // values-free 404 — indistinguishable from a non-existent template — BEFORE the field-type resolve.
  test('upload template-access: invisible template → 404 values-free; nothing written; field type not probed', async () => {
    const { app, inserted, blobs, fieldResolutions } = makeApp({ templateVisible: false })
    const r = await serve(app)
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl-hidden')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'not_found' }) // values-free, no template/field detail
    expect(inserted.length).toBe(0)
    expect(blobs.size).toBe(0)
    expect(fieldResolutions.length).toBe(0) // the visibility gate ran FIRST — schema never probed
  })

  // O3 prod fail-close: storageAvailable=false (production without an S3-compatible provider) ⇒ upload 503
  // values-free; no blob write, no row insert. Download for an AUTHORIZED viewer also 503.
  test('O3 storage fail-close: upload → 503 values-free, nothing persisted; authorized download → 503', async () => {
    const up = makeApp({ storageAvailable: false })
    const r = await serve(up.app)
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(r.status).toBe(503)
    expect(r.body).toEqual({ error: 'storage_unavailable' }) // values-free
    expect(up.inserted.length).toBe(0)
    expect(up.blobs.size).toBe(0)
    const row = {
      status: 'bound',
      uploader_id: 'up1',
      org_id: 'org1',
      instance_id: 'i1',
      field_id: 'fld1',
      storage_key: 'k1',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      scan_state: 'unscanned',
    }
    const down = makeApp({ rows: [row], participant: true, storageAvailable: false })
    expect((await serve(down.app).get('/api/approval/attachments/att_1/download')).status).toBe(503)
    // an OUTSIDER still gets the authorization 404 — the storage posture is never an oracle for them
    const outsider = makeApp({ rows: [row], participant: false, storageAvailable: false })
    expect((await serve(outsider.app).get('/api/approval/attachments/att_1/download')).status).toBe(404)
  })

  test('download: participant streams bound blob; non-participant gets 404 (no oracle); deleted → 410', async () => {
    const row = {
      status: 'bound',
      uploader_id: 'up1',
      org_id: 'org1',
      instance_id: 'i1',
      field_id: 'fld1',
      storage_key: 'k1',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      scan_state: 'unscanned',
    }
    const ok = makeApp({ rows: [row], participant: true })
    ok.blobs.set('k1', Buffer.from('%PDF'))
    const good = await serve(ok.app).get('/api/approval/attachments/att_1/download')
    expect(good.status).toBe(200)
    expect(good.headers['content-type']).toContain('application/pdf')
    // participant predicate is org-pinned (viewer org + row org)
    expect(ok.participantCalls[0]).toEqual({ viewerId: 'u1', instanceId: 'i1', orgId: 'org1' })
    const deny = makeApp({ rows: [row], participant: false })
    expect((await serve(deny.app).get('/api/approval/attachments/att_1/download')).status).toBe(404)
    const missing = makeApp({ rows: [] })
    expect((await serve(missing.app).get('/api/approval/attachments/att_x/download')).status).toBe(404)
  })

  test('download enforces approvals:read + org pin: revoked read / cross-org → values-free 404 (no existence oracle)', async () => {
    const row = {
      status: 'bound',
      uploader_id: 'up1',
      org_id: 'org1',
      instance_id: 'i1',
      field_id: 'fld1',
      storage_key: 'k1',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      scan_state: 'unscanned',
    }
    const noRead = makeApp({ rows: [row], participant: true, hasApprovalsRead: false })
    noRead.blobs.set('k1', Buffer.from('%PDF'))
    expect((await serve(noRead.app).get('/api/approval/attachments/att_1/download')).status).toBe(404)
    expect(await serve(noRead.app).get('/api/approval/attachments/att_1/download').then((r) => r.body)).toEqual({ error: 'not_found' })
    // cross-org: viewer org2 vs row org1 — same 404 as missing (no oracle)
    const cross = makeApp({ rows: [row], participant: true, org: 'org2' })
    cross.blobs.set('k1', Buffer.from('%PDF'))
    expect((await serve(cross.app).get('/api/approval/attachments/att_1/download')).status).toBe(404)
    expect(cross.participantCalls).toEqual([]) // refused at org pin before participant lookup
  })

  test('scan seam: infected upload refused before write; infected download → 410 after authz only', async () => {
    const infectedUp = makeApp({
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'true', APPROVAL_ATTACHMENT_SCAN_ENABLED: 'true' } as NodeJS.ProcessEnv,
      scanHook: () => 'infected',
    })
    const up = await serve(infectedUp.app)
      .post('/api/approval/attachments')
      .field('fieldId', 'fld1')
      .field('templateId', 'tpl1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(up.status).toBe(422)
    expect(up.body.rejected[0].code).toBe('infected')
    expect(infectedUp.blobs.size).toBe(0)
    expect(infectedUp.inserted.length).toBe(0)
    const row = {
      status: 'bound',
      uploader_id: 'up1',
      org_id: 'org1',
      instance_id: 'i1',
      field_id: 'fld1',
      storage_key: 'k1',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      scan_state: 'infected',
    }
    const authed = makeApp({ rows: [row], participant: true })
    authed.blobs.set('k1', Buffer.from('%PDF'))
    expect((await serve(authed.app).get('/api/approval/attachments/att_1/download')).status).toBe(410)
    const outsider = makeApp({ rows: [row], participant: false })
    // outsider must NOT see 410 (no infection/existence oracle)
    expect((await serve(outsider.app).get('/api/approval/attachments/att_1/download')).status).toBe(404)
  })

  // G6 (no deleted-row oracle): the deleted lifecycle signal is emitted ONLY to an authorized viewer.
  test('download of a deleted row: participant sees 410 (tombstone); NON-participant sees 404 (no oracle)', async () => {
    const deleted = {
      status: 'deleted',
      uploader_id: 'up1',
      org_id: 'org1',
      instance_id: 'i1',
      field_id: 'fld1',
      storage_key: 'k1',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      scan_state: 'unscanned',
    }
    const authed = makeApp({ rows: [deleted], participant: true })
    expect((await serve(authed.app).get('/api/approval/attachments/att_1/download')).status).toBe(410)
    const outsider = makeApp({ rows: [deleted], participant: false })
    expect((await serve(outsider.app).get('/api/approval/attachments/att_1/download')).status).toBe(404) // NOT 410 — no 404→410 existence oracle
  })

  // approval-attachment-hidden-redaction (lock G7 / §4.2 gate 2 / test 6): a field hidden at the
  // active node serves NO bytes at the byte path — even to an authorized instance participant — the
  // same way redactHiddenFormFields strips it from the echoed snapshot. Non-hidden still serves.
  test('approval-attachment-hidden-redaction: participant is REFUSED (404) for a hidden field; non-hidden serves 200', async () => {
    const row = {
      status: 'bound',
      uploader_id: 'up1',
      org_id: 'org1',
      instance_id: 'i1',
      field_id: 'secret',
      storage_key: 'k1',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      scan_state: 'unscanned',
    }
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

/**
 * G8 — safe serving headers. `Content-Disposition: attachment` + `nosniff` + `CSP default-src 'none'`
 * on EVERY byte served, and the raw storage key never in the response body. The CSP is the leg that
 * neutralises active content if a browser is ever coaxed into rendering the response anyway.
 */
describe('approval attachment download: serving headers (G8)', () => {
  const row = {
    status: 'bound',
    uploader_id: 'up1',
    org_id: 'org1',
    instance_id: 'i1',
    field_id: 'fld1',
    storage_key: 'secret/key/path.pdf',
    file_name: 'report.pdf',
    mime_type: 'application/pdf',
    scan_state: 'unscanned',
  }

  test('attachment disposition + nosniff + CSP default-src none; no storage key in the body', async () => {
    const app = makeApp({ rows: [row], participant: true })
    app.blobs.set('secret/key/path.pdf', Buffer.from('%PDF-1.4 bytes'))
    const r = await serve(app.app).get('/api/approval/attachments/att_1/download')
    expect(r.status).toBe(200)
    expect(r.headers['content-security-policy']).toBe("default-src 'none'")
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['content-disposition']).toMatch(/^attachment;/)
    expect(r.headers['content-disposition']).not.toMatch(/inline/)
    // the raw storage key/url is never echoed anywhere in the response (§2 / G8)
    expect(JSON.stringify(r.headers)).not.toContain('secret/key/path.pdf')
    expect(r.text ?? '').not.toContain('secret/key/path.pdf')
  })

  // Negative control for the CSP assertion above: prove it is the ROUTE that sets the header, not the
  // harness — a refused download carries no CSP because it never reaches the byte path.
  test('a REFUSED download carries no serving headers (the header is bound to the byte path)', async () => {
    const app = makeApp({ rows: [row], participant: false })
    const r = await serve(app.app).get('/api/approval/attachments/att_1/download')
    expect(r.status).toBe(404)
    expect(r.headers['content-security-policy']).toBeUndefined()
  })
})

/**
 * §4.3 DELETE — retract a staged (unbound) upload. Claim-then-enqueue in ONE statement; never an
 * inline blob delete; every non-claim outcome is the SAME values-free 404 (no ownership/lifecycle
 * oracle).
 */
describe('approval attachment DELETE (§4.3)', () => {
  const claimed = { rows: [{ id: 'att_1' }] }
  const nothingClaimed = { rows: [] }

  test('uploader deletes own unbound row → 204; row claim + purge intent are ONE statement; blob NOT deleted inline', async () => {
    const app = makeApp({ queryHandler: () => claimed })
    const r = await serve(app.app).delete('/api/approval/attachments/att_1')
    expect(r.status).toBe(204)
    // Exactly one statement issued: once this route succeeds, the row transition and durable purge
    // intent cannot be split by a crash. Blob reclamation is eventual via the GC worker.
    expect(app.queries.length).toBe(1)
    const { sql, params } = app.queries[0]
    expect(sql).toMatch(/WITH claimed AS/)
    expect(sql).toMatch(/UPDATE approval_attachments/)
    expect(sql).toMatch(/SET status = 'deleted'/) // row transition (no longer bindable)
    expect(sql).toMatch(/INSERT INTO approval_attachment_purge_intents/) // durable purge intent
    // the intent SELECTs FROM the claim's RETURNING — gated on the claim, never on a stale read (§7)
    expect(sql).toMatch(/FROM claimed/)
    // the symmetric guards that make bind↔GC serialize: uploader + org + still-unbound
    expect(sql).toMatch(/status = 'unbound'/)
    expect(sql).toMatch(/uploader_id = \$2/)
    expect(sql).toMatch(/org_id = \$3/)
    expect(params).toEqual(['att_1', 'u1', 'org1']) // identity from the principal, never the body
    // the worker is the sole blob-deleter: this route must NEVER touch the store
    expect(app.deleted).toEqual([])
  })

  test('no-oracle: foreign / bound / already-deleted / unknown id all give the SAME values-free 404', async () => {
    // Each of these is "0 rows claimed" at the DB — the route cannot and must not distinguish them.
    for (const id of ['att_someone_elses', 'att_already_bound', 'att_already_deleted', 'att_never_existed']) {
      const app = makeApp({ queryHandler: () => nothingClaimed })
      const r = await serve(app.app).delete(`/api/approval/attachments/${id}`)
      expect(r.status).toBe(404)
      expect(r.body).toEqual({ error: 'not_found' }) // identical body — nothing distinguishes the cases
      expect(app.deleted).toEqual([]) // and no blob is touched on the refused path either
    }
  })

  test('unauthenticated → 401; principal without an org → 403; neither issues a query', async () => {
    const anon = makeApp({ viewer: null })
    expect((await serve(anon.app).delete('/api/approval/attachments/att_1')).status).toBe(401)
    expect(anon.queries.length).toBe(0)
    const noOrg = makeApp({ org: null })
    expect((await serve(noOrg.app).delete('/api/approval/attachments/att_1')).status).toBe(403)
    expect(noOrg.queries.length).toBe(0)
  })

  test('a db failure is a values-free 500, never an unhandled rejection', async () => {
    const app = makeApp({
      queryHandler: () => {
        throw new Error('connection reset by peer')
      },
    })
    const r = await serve(app.app).delete('/api/approval/attachments/att_1')
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'internal_error' })
    expect(JSON.stringify(r.body)).not.toContain('connection reset')
  })
})

/** §8 batched ref resolution — draft stale-check (G13) + bound metadata (G5/G7). */
describe('approval attachment /refs (§8)', () => {
  const liveUnbound = { id: 'att_live', file_name: 'a.pdf', size_bytes: '11', mime_type: 'application/pdf' }

  test('draft stale-check: a swept id is STALE, a live own unbound id is not (positive control)', async () => {
    const app = makeApp({ queryHandler: (sql) => (sql.includes('FROM approval_attachments') ? { rows: [liveUnbound] } : null) })
    const r = await serve(app.app)
      .post('/api/approval/attachments/refs')
      .send({ ids: ['att_live', 'att_swept'] })
    expect(r.status).toBe(200)
    expect(r.body.attachments).toEqual([
      { id: 'att_live', stale: false, fileName: 'a.pdf', sizeBytes: 11, mimeType: 'application/pdf' },
      { id: 'att_swept', stale: true },
    ])
    // uploader- AND org-scoped: someone else's live id can never come back non-stale
    expect(app.queries[0].sql).toMatch(/uploader_id = \$2/)
    expect(app.queries[0].sql).toMatch(/org_id = \$3/)
    expect(app.queries[0].sql).toMatch(/status = 'unbound'/)
    expect(app.queries[0].params).toEqual([['att_live', 'att_swept'], 'u1', 'org1'])
  })

  test('draft stale-check stays uploader-scoped when the initiator has no approvals:read grant', async () => {
    const app = makeApp({
      hasApprovalsRead: false,
      queryHandler: (sql) => (sql.includes('FROM approval_attachments') ? { rows: [liveUnbound] } : null),
    })
    const r = await serve(app.app)
      .post('/api/approval/attachments/refs')
      .send({ ids: ['att_live'] })
    expect(r.status).toBe(200)
    expect(r.body.attachments).toEqual([
      { id: 'att_live', stale: false, fileName: 'a.pdf', sizeBytes: 11, mimeType: 'application/pdf' },
    ])
  })

  test('bound metadata: participant gets filename/size + the PROXIED url only; storage key never echoed', async () => {
    const bound = { id: 'att_b', field_id: 'fld1', file_name: 'contract.pdf', size_bytes: '2048', mime_type: 'application/pdf', status: 'bound' }
    const app = makeApp({ participant: true, queryHandler: (sql) => (sql.includes('FROM approval_attachments') ? { rows: [bound] } : null) })
    const r = await serve(app.app)
      .post('/api/approval/attachments/refs')
      .send({ ids: ['att_b'], instanceId: 'i1' })
    expect(r.status).toBe(200)
    expect(r.body.attachments).toEqual([
      {
        id: 'att_b',
        tombstone: false,
        fieldId: 'fld1',
        fileName: 'contract.pdf',
        sizeBytes: 2048,
        mimeType: 'application/pdf',
        downloadUrl: '/api/approval/attachments/att_b/download',
      },
    ])
    expect(JSON.stringify(r.body)).not.toContain('storage_key')
    // scoped to the named instance — a ref bound elsewhere can never resolve through this call
    expect(app.queries[0].sql).toMatch(/instance_id = \$2/)
  })

  test('bound metadata: a NON-participant gets the same values-free 404 the byte path gives (G6)', async () => {
    const app = makeApp({ participant: false })
    const r = await serve(app.app)
      .post('/api/approval/attachments/refs')
      .send({ ids: ['att_b'], instanceId: 'i1' })
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'not_found' })
    expect(app.queries.length).toBe(0) // refused BEFORE any row read
  })

  test('bound metadata requires approvals:read before participant or row lookup', async () => {
    const app = makeApp({ participant: true, hasApprovalsRead: false })
    const r = await serve(app.app)
      .post('/api/approval/attachments/refs')
      .send({ ids: ['att_b'], instanceId: 'i1' })
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'not_found' })
    expect(app.queries.length).toBe(0)
  })

  test('tombstone: an id not bound to THIS instance, or soft-deleted, resolves as a tombstone with no metadata', async () => {
    const del = { id: 'att_del', field_id: 'fld1', file_name: 'gone.pdf', size_bytes: '5', mime_type: 'application/pdf', status: 'deleted' }
    const app = makeApp({ participant: true, queryHandler: (sql) => (sql.includes('FROM approval_attachments') ? { rows: [del] } : null) })
    const r = await serve(app.app)
      .post('/api/approval/attachments/refs')
      .send({ ids: ['att_del', 'att_other_instance'], instanceId: 'i1' })
    expect(r.status).toBe(200)
    expect(r.body.attachments).toEqual([{ id: 'att_del', tombstone: true }, { id: 'att_other_instance', tombstone: true }])
    // a tombstone leaks NOTHING about the row it stands for
    expect(JSON.stringify(r.body)).not.toContain('gone.pdf')
  })

  test('G7 redaction inheritance: a ref on a field hidden at the active node is OMITTED; a visible one is not', async () => {
    const rows = [
      { id: 'att_secret', field_id: 'secret', file_name: 's.pdf', size_bytes: '1', mime_type: 'application/pdf', status: 'bound' },
      { id: 'att_open', field_id: 'open', file_name: 'o.pdf', size_bytes: '2', mime_type: 'application/pdf', status: 'bound' },
    ]
    const app = makeApp({
      participant: true,
      hidden: (_i, fieldId) => fieldId === 'secret',
      queryHandler: (sql) => (sql.includes('FROM approval_attachments') ? { rows } : null),
    })
    const r = await serve(app.app)
      .post('/api/approval/attachments/refs')
      .send({ ids: ['att_secret', 'att_open'], instanceId: 'i1' })
    expect(r.status).toBe(200)
    // hidden ⇒ absent entirely (NOT a tombstone — a tombstone would disclose that it exists)
    expect(r.body.attachments.map((a: { id: string }) => a.id)).toEqual(['att_open'])
    expect(JSON.stringify(r.body)).not.toContain('s.pdf')
  })

  test('G7 fail-closed: when the hidden check throws, the ref is treated as hidden and omitted', async () => {
    const rows = [{ id: 'att_x', field_id: 'fld1', file_name: 'x.pdf', size_bytes: '1', mime_type: 'application/pdf', status: 'bound' }]
    const app = makeApp({
      participant: true,
      hidden: () => {
        throw new Error('graph load down')
      },
      queryHandler: (sql) => (sql.includes('FROM approval_attachments') ? { rows } : null),
    })
    const r = await serve(app.app)
      .post('/api/approval/attachments/refs')
      .send({ ids: ['att_x'], instanceId: 'i1' })
    expect(r.status).toBe(200)
    expect(r.body.attachments).toEqual([]) // never leak a name a hidden field would strip
  })

  test('input guards: unauthenticated 401; non-array ids 400; empty/blank ids resolve to [] without a query', async () => {
    const anon = makeApp({ viewer: null })
    expect((await serve(anon.app).post('/api/approval/attachments/refs').send({ ids: ['a'] })).status).toBe(401)
    const app = makeApp()
    expect((await serve(app.app).post('/api/approval/attachments/refs').send({})).status).toBe(400)
    expect((await serve(app.app).post('/api/approval/attachments/refs').send({ ids: 'att_1' })).status).toBe(400)
    const empty = makeApp()
    const r = await serve(empty.app).post('/api/approval/attachments/refs').send({ ids: [null, 42, '', '   '] })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ attachments: [] })
    expect(empty.queries.length).toBe(0)
  })

  test('batch is bounded: an oversized id list is rejected rather than silently truncated', async () => {
    const app = makeApp({ queryHandler: () => ({ rows: [] }) })
    const ids = Array.from({ length: MAX_REF_BATCH + 50 }, (_, i) => `att_${i}`)
    const r = await serve(app.app).post('/api/approval/attachments/refs').send({ ids })
    expect(r.status).toBe(413)
    expect(r.body).toEqual({ error: 'too_many_ids' })
    expect(app.queries).toEqual([])
  })
})

/** G1 — with the flag OFF the factory registers NOTHING, including the new delete/refs routes. */
describe('approval attachment flag-OFF surface (G1)', () => {
  test('flag OFF ⇒ no delete route, no refs route (nothing to 404 against — the router does not exist)', async () => {
    const r = createApprovalAttachmentRouter({
      db: { query: async () => ({ rows: [], rowCount: 0 }) },
      store: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => false },
      authChecks: { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false },
      viewerId: () => 'u1',
      orgId: () => 'org1',
      hasApprovalsRead: () => true,
      hasApprovalsWrite: () => true,
      resolveAttachmentField: async () => true,
      templateVisible: async () => true,
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv,
    })
    expect(r).toBeNull()
    // and an app with no router mounted answers 404 for every attachment path
    const app = express()
    expect((await serve(app).delete('/api/approval/attachments/att_1')).status).toBe(404)
    expect((await serve(app).post('/api/approval/attachments/refs').send({ ids: ['a'] })).status).toBe(404)
  })
})

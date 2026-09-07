/**
 * Approval attachment round-trip guard (#4195, design-lock §7/§11/§12) — SLICE A: TESTS ONLY.
 *
 * This suite deliberately does NOT re-litigate what
 * `approval-attachment-pipeline-realdb.test.ts` already proves over a real booted server (upload →
 * unbound row, bind-at-create + `form_snapshot` freeze, DELETE 204 + purge intent, outsider download
 * 404, and the flag-OFF upload 404). It exists for the four things that sibling suite does not cover:
 *
 *   1. Upload rejects a request missing `templateId` and/or `fieldId` with 400 — proven at REAL-DB /
 *      booted-server altitude (today only mocked, `tests/unit/approval-attachment-routes.test.ts`).
 *   2. Upload rejects a `fieldId` naming a field that exists but is NOT `attachment`-typed — 400
 *      `not_an_attachment_field` — same altitude gap.
 *   3. With the flag forced OFF, ALL THREE surfaces this suite touches (upload / download / delete —
 *      not just upload) are measured and pinned to their CURRENT status code, in the SAME suite as
 *      the ON-path round trip, against a REAL pre-existing attachment id (proving the 404 is "route
 *      not mounted", not "row not found").
 *   4. The auth-proxied download response is checked for byte-EXACT payload equality against the
 *      uploaded content, and for the `Content-Security-Policy: default-src 'none'` header — neither
 *      of which the sibling suite asserts (it checks content-type/disposition/nosniff only).
 *
 * The round trip (upload → bind-at-create → download) is kept here too, minimally, because the
 * negative controls above need a live bound attachment to contrast against — not to re-prove bind
 * mechanics the sibling file already owns end-to-end (including its own double-submit race and
 * whole-create-rollback coverage, which this file does not repeat).
 *
 * Fixture note: the template carrying the attachment field is seeded via the BACKEND API
 * (`POST /api/approval-templates` + publish) — a fixture call, not a drive of the browser-based
 * TemplateAuthoringView (which cannot author an `attachment` field pre-rung-4 anyway). Calling the
 * backend authoring API does not make `attachment` an `AuthorableFieldType` and does not touch the
 * design-lock §7 rung-4 gate — it is the same fixture mechanism
 * `approval-attachment-pipeline-realdb.test.ts` already uses (`publishAttachmentTemplate`).
 *
 * Two-point wired: excluded from the no-DB `vitest.config.ts` job, and run by the standalone
 * `.github/workflows/approval-attachment-roundtrip-guard.yml` real-DB lane (EXPECT_DB=1 sentinel
 * below — modeled on `approval-list-scope-server-side.db.test.ts`'s top-level anti-skip-green check).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Anti-skip-green sentinel (top-level — NOT inside describeIfDatabase): the evidence lane sets
// EXPECT_DB=1, so a missing/broken DATABASE_URL there REDS this sentinel instead of the whole file
// silently reporting as skipped-green. Modeled on approval-list-scope-server-side.db.test.ts.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const REQUESTER = `artg-req-${RUN}`
const OUTSIDER = `artg-out-${RUN}`

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

describeIfDatabase('approval attachment round-trip + flag guard (real DB, booted server)', () => {
  let server: MetaSheetServer | undefined
  // Flag-OFF boot (last section) — stopped in afterAll AFTER DB cleanup: MetaSheetServer.stop() ends
  // the SHARED poolManager pool, so any later query would hit "Cannot use a pool after calling end".
  let offServer: MetaSheetServer | undefined
  let baseUrl = ''
  let offBaseUrl = ''
  let storageRoot = ''
  let templateId = ''
  const savedEnv: Record<string, string | undefined> = {}
  const pool = () => poolManager.get()
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdAttachmentIds = new Set<string>()
  const createdUserIds = new Set<string>()

  async function authToken(userId: string, roles = 'admin', perms = '*:*'): Promise<string> {
    if (perms.split(',').some((permission) => ['*:*', 'approvals:*', 'approvals:write'].includes(permission.trim()))) {
      await grantApprovalWriteForIntegrationActor(userId)
    }
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  async function jsonRequest(pathName: string, token: string, options: { method?: string; body?: unknown } = {}) {
    return fetch(`${baseUrl}${pathName}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
  }

  async function ensureUsers(...ids: string[]): Promise<void> {
    for (const id of ids) {
      createdUserIds.add(id)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active)
         VALUES ($1, $2, $3, 'test', 'user', '[]'::jsonb, TRUE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, updated_at = now()`,
        [id, `${id}@example.test`, id],
      )
    }
  }

  /** Fixture helper — a backend-API call, not a browser authoring flow (see file docblock). */
  async function publishAttachmentTemplate(adminToken: string): Promise<string> {
    const templateKey = `artg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest('/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Attachment round-trip guard template',
        description: 'approval-attachment-roundtrip-guard fixture',
        formSchema: {
          fields: [
            { id: 'reason', type: 'text', label: '事由', required: true },
            { id: 'files', type: 'attachment', label: '附件', required: false },
          ],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            { key: 'approve_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [`artg-approver-${RUN}`], approvalMode: 'single' } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approve_1' },
            { key: 'e2', source: 'approve_1', target: 'end' },
          ],
        },
      },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const template = (await create.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const publish = await jsonRequest(`/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publish.status, await publish.clone().text()).toBe(200)
    return template.id
  }

  function pdfBuffer(marker: string): Buffer {
    return Buffer.from(`%PDF-1.4 approval-attachment-roundtrip-guard ${marker}`)
  }

  async function uploadPdf(
    token: string,
    templateIdArg: string | undefined,
    fieldIdArg: string | undefined,
    content: Buffer,
    baseUrlArg = baseUrl,
  ): Promise<Response> {
    const form = new FormData()
    if (templateIdArg !== undefined) form.append('templateId', templateIdArg)
    if (fieldIdArg !== undefined) form.append('fieldId', fieldIdArg)
    form.append('file', new Blob([content], { type: 'application/pdf' }), 'evidence.pdf')
    return fetch(`${baseUrlArg}/api/approval/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
  }

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    storageRoot = mkdtempSync(path.join(tmpdir(), 'artg-pipeline-'))
    for (const key of ['APPROVAL_ATTACHMENTS_ENABLED', 'APPROVAL_ATTACHMENT_STORAGE_DIR']) {
      savedEnv[key] = process.env[key]
    }
    process.env.APPROVAL_ATTACHMENTS_ENABLED = 'true'
    process.env.APPROVAL_ATTACHMENT_STORAGE_DIR = storageRoot
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
    await ensureUsers(REQUESTER, OUTSIDER, `artg-approver-${RUN}`)
    const adminToken = await authToken(`artg-admin-${RUN}`)
    templateId = await publishAttachmentTemplate(adminToken)
  }, 30_000)

  afterAll(async () => {
    try {
      const attachmentIds = [...createdAttachmentIds]
      const keys = attachmentIds.length > 0
        ? (await pool().query('SELECT storage_key FROM approval_attachments WHERE id = ANY($1::text[])', [attachmentIds])).rows.map(
            (r: { storage_key: string }) => r.storage_key,
          )
        : []
      const approvalIds = [...createdApprovalIds]
      if (approvalIds.length > 0) {
        await pool().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds]) // cascades attachments
      }
      if (attachmentIds.length > 0) {
        await pool().query('DELETE FROM approval_attachments WHERE id = ANY($1::text[])', [attachmentIds])
      }
      if (keys.length > 0) {
        await pool().query('DELETE FROM approval_attachment_purge_intents WHERE storage_key = ANY($1::text[])', [keys])
      }
      const templateIds = [...createdTemplateIds]
      if (templateIds.length > 0) {
        await pool().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
      if (createdUserIds.size > 0) {
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [[...createdUserIds]])
      }
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      try {
        rmSync(storageRoot, { recursive: true, force: true })
      } catch {
        // best-effort temp cleanup
      }
      // Stop LAST (after all DB cleanup): stopping ends the shared pool. The second stop's pool.end
      // races the first — tolerated (both servers share one poolManager), matching the sibling suite.
      await offServer?.stop().catch(() => {})
      await server?.stop().catch(() => {})
    }
  }, 30_000)

  it('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // -------------------------------------------------------------------------------------------
  // Round trip (spine) — kept minimal; full bind/rollback/race coverage lives in the sibling file.
  // -------------------------------------------------------------------------------------------
  it('round trip: upload -> unbound; bind at create freezes form_snapshot; download returns byte-exact bytes with hardened headers', async () => {
    const requesterToken = await authToken(REQUESTER, 'user', 'approvals:read,approvals:write')
    const content = pdfBuffer(`roundtrip-${RUN}`)
    const up = await uploadPdf(requesterToken, templateId, 'files', content)
    expect(up.status, await up.clone().text()).toBe(201)
    const attId = ((await up.json()) as { id: string }).id
    createdAttachmentIds.add(attId)
    const staged = (await pool().query('SELECT status, uploader_id, org_id FROM approval_attachments WHERE id=$1', [attId])).rows[0]
    expect(staged).toMatchObject({ status: 'unbound', uploader_id: REQUESTER })

    const create = await jsonRequest('/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'round-trip guard', files: [attId] } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string }
    createdApprovalIds.add(inst.id)

    const bound = (await pool().query('SELECT status, instance_id, bound_at FROM approval_attachments WHERE id=$1', [attId])).rows[0]
    expect(bound.status).toBe('bound')
    expect(bound.instance_id).toBe(inst.id)
    expect(bound.bound_at).not.toBeNull()
    const snap = (await pool().query(`SELECT form_snapshot->'files' AS files FROM approval_instances WHERE id=$1`, [inst.id])).rows[0]
    expect(snap.files).toEqual([attId])

    const download = await fetch(`${baseUrl}/api/approval/attachments/${attId}/download`, {
      headers: { Authorization: `Bearer ${requesterToken}` },
    })
    expect(download.status).toBe(200)
    const bytes = Buffer.from(await download.arrayBuffer())
    expect(bytes.equals(content)).toBe(true) // byte-exact — not just "some pdf came back"
    expect(download.headers.get('content-type')).toContain('application/pdf')
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(download.headers.get('x-content-type-options')).toBe('nosniff')
    expect(download.headers.get('content-security-policy')).toBe("default-src 'none'")
  })

  it('delete: uploader retracts a separate unbound staged attachment', async () => {
    const requesterToken = await authToken(REQUESTER, 'user', 'approvals:read,approvals:write')
    const up = await uploadPdf(requesterToken, templateId, 'files', pdfBuffer(`delete-${RUN}`))
    expect(up.status, await up.clone().text()).toBe(201)
    const attId = ((await up.json()) as { id: string }).id
    createdAttachmentIds.add(attId)

    const removed = await jsonRequest(`/api/approval/attachments/${attId}`, requesterToken, { method: 'DELETE' })
    expect(removed.status, await removed.clone().text()).toBe(204)
    const row = (await pool().query('SELECT status FROM approval_attachments WHERE id=$1', [attId])).rows[0]
    expect(row).toEqual({ status: 'deleted' })
  })

  // -------------------------------------------------------------------------------------------
  // Negative controls NOT covered at real-DB altitude by the sibling suite (today mocked-only in
  // tests/unit/approval-attachment-routes.test.ts).
  // -------------------------------------------------------------------------------------------
  it('upload rejects a request missing templateId and/or fieldId — 400, no row/blob', async () => {
    const requesterToken = await authToken(REQUESTER, 'user', 'approvals:read,approvals:write')
    const before = Number((await pool().query('SELECT count(*)::int AS c FROM approval_attachments')).rows[0].c)

    const missingField = await uploadPdf(requesterToken, templateId, undefined, pdfBuffer('missing-field'))
    expect(missingField.status).toBe(400)
    expect(await missingField.json()).toEqual({ error: 'template_and_field_required' })

    const missingTemplate = await uploadPdf(requesterToken, undefined, 'files', pdfBuffer('missing-template'))
    expect(missingTemplate.status).toBe(400)
    expect(await missingTemplate.json()).toEqual({ error: 'template_and_field_required' })

    const missingBoth = await uploadPdf(requesterToken, undefined, undefined, pdfBuffer('missing-both'))
    expect(missingBoth.status).toBe(400)
    expect(await missingBoth.json()).toEqual({ error: 'template_and_field_required' })

    const after = Number((await pool().query('SELECT count(*)::int AS c FROM approval_attachments')).rows[0].c)
    expect(after).toBe(before) // none of the three refused uploads left a durable row
  })

  it('upload rejects a fieldId naming a field that exists but is NOT attachment-typed — 400 not_an_attachment_field', async () => {
    const requesterToken = await authToken(REQUESTER, 'user', 'approvals:read,approvals:write')
    const before = Number((await pool().query('SELECT count(*)::int AS c FROM approval_attachments')).rows[0].c)
    // 'reason' is a real field on this template's schema — just not attachment-typed.
    const res = await uploadPdf(requesterToken, templateId, 'reason', pdfBuffer('non-attachment-field'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'not_an_attachment_field' })
    const after = Number((await pool().query('SELECT count(*)::int AS c FROM approval_attachments')).rows[0].c)
    expect(after).toBe(before)
  })

  it('download by a non-participant is refused by the existing predicate — 404, values-free', async () => {
    const requesterToken = await authToken(REQUESTER, 'user', 'approvals:read,approvals:write')
    const up = await uploadPdf(requesterToken, templateId, 'files', pdfBuffer(`nonparticipant-${RUN}`))
    expect(up.status).toBe(201)
    const attId = ((await up.json()) as { id: string }).id
    createdAttachmentIds.add(attId)
    const create = await jsonRequest('/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'non-participant refusal', files: [attId] } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string }
    createdApprovalIds.add(inst.id)

    const outsiderToken = await authToken(OUTSIDER, 'user', 'approvals:read')
    const denied = await fetch(`${baseUrl}/api/approval/attachments/${attId}/download`, {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    })
    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual({ error: 'not_found' }) // values-free — same shape as a nonexistent id
  })

  // -------------------------------------------------------------------------------------------
  // Flag OFF — same suite, all THREE endpoints (the sibling pins upload only). Boots a SECOND
  // server with the flag off, against a REAL pre-existing attachment id from the ON boot above (so
  // a 404 here proves "route not mounted", never "row not found"). Status codes below are MEASURED
  // against the current implementation, then pinned — not asserted from a prior assumption.
  // -------------------------------------------------------------------------------------------
  it('flag OFF: upload / download / delete all answer exactly as they do today (measured, then pinned)', async () => {
    // A real, live, unbound attachment created while the flag was ON — proves the OFF 404s below are
    // "this route does not exist", not "no such row".
    const requesterToken = await authToken(REQUESTER, 'user', 'approvals:read,approvals:write')
    const liveUpload = await uploadPdf(requesterToken, templateId, 'files', pdfBuffer(`off-guard-${RUN}`))
    expect(liveUpload.status).toBe(201)
    const liveAttId = ((await liveUpload.json()) as { id: string }).id
    createdAttachmentIds.add(liveAttId)

    delete process.env.APPROVAL_ATTACHMENTS_ENABLED
    offServer = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    try {
      await offServer.start()
      const address = offServer.getAddress()
      const port = address && typeof address === 'object' ? address.port : undefined
      expect(port).toBeTruthy()
      offBaseUrl = `http://127.0.0.1:${port}`
      const tokenRes = await fetch(`${offBaseUrl}/api/auth/dev-token?userId=${encodeURIComponent(REQUESTER)}`)
      expect(tokenRes.status).toBe(200)
      const { token } = (await tokenRes.json()) as { token: string }

      // Upload — authenticated, approvals:write-capable principal, route unmounted.
      const upOff = await uploadPdf(token, templateId, 'files', pdfBuffer('off-upload'), offBaseUrl)
      expect(upOff.status).toBe(404) // MEASURED: unmounted route, Express routing-miss (not 401/403/503)
      expect(upOff.headers.get('content-type') ?? '').not.toContain('application/json') // routing-miss, not the router's JSON refusal shape

      // Download — same real, pre-existing (live) attachment id, flag OFF.
      const dlOff = await fetch(`${offBaseUrl}/api/approval/attachments/${liveAttId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(dlOff.status).toBe(404)
      expect(dlOff.headers.get('content-type') ?? '').not.toContain('application/json')

      // Delete — same id, flag OFF.
      const delOff = await fetch(`${offBaseUrl}/api/approval/attachments/${liveAttId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(delOff.status).toBe(404)
      expect(delOff.headers.get('content-type') ?? '').not.toContain('application/json')

      // Positive control: the SAME id, back on the flag-ON server, is still a normal live row (the
      // OFF boot above touched no data — it just never mounted the surface).
      const stillLive = (await pool().query('SELECT status FROM approval_attachments WHERE id=$1', [liveAttId])).rows[0]
      expect(stillLive).toEqual({ status: 'unbound' })
    } finally {
      process.env.APPROVAL_ATTACHMENTS_ENABLED = 'true'
      // offServer is stopped in afterAll AFTER DB cleanup (stop() ends the shared pool).
    }
  })
})

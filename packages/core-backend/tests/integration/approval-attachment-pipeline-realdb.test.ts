/**
 * Approval attachment PRODUCTION pipeline — end-to-end over a real booted server + real DB (#4195).
 *
 * Proves the boot wiring (flag-gated mount), the §4.1 template-access gate (outsider → values-free
 * 404), the §4.4 in-transaction submit bind (atomic freeze; a bind failure rolls back the WHOLE
 * create), and the §4.2 auth-proxied download (participant 200 + safe headers; outsider 404). The
 * flag-OFF posture is proven by a second boot without the flag: the surface is simply not mounted.
 * Two-point wired (vitest.config.ts exclusion + plugin-tests.yml approval real-DB run list).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const REQUESTER = `aatt-req-${RUN}`
const OUTSIDER = `aatt-out-${RUN}`
const OTHER = `aatt-other-${RUN}`
const APPROVER = `aatt-approver-${RUN}`

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

describeIfDatabase('approval attachment production pipeline (real DB, booted server)', () => {
  let server: MetaSheetServer | undefined
  // The flag-OFF boot (last test) — stopped in afterAll AFTER the DB cleanup, because MetaSheetServer.stop()
  // ends the SHARED poolManager pool and any later query would hit "Cannot use a pool after calling end".
  let offServer: MetaSheetServer | undefined
  let baseUrl = ''
  let storageRoot = ''
  const savedEnv: Record<string, string | undefined> = {}
  const pool = () => poolManager.get()
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdAttachmentIds = new Set<string>()
  const createdUserIds = new Set<string>()

  async function authToken(userId: string, roles = 'admin', perms = '*:*'): Promise<string> {
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

  async function uploadPdf(token: string, templateId: string, fieldId: string): Promise<Response> {
    const form = new FormData()
    form.append('templateId', templateId)
    form.append('fieldId', fieldId)
    form.append('file', new Blob([Buffer.from('%PDF-1.4 attachment pipeline')], { type: 'application/pdf' }), 'evidence.pdf')
    return fetch(`${baseUrl}/api/approval/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
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

  async function waitUntilAttachmentBindBlocksOnHolder(holderPid: number, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const blocked = await pool().query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND $1 = ANY(pg_blocking_pids(pid))
            AND query ILIKE '%UPDATE approval_attachments%'`,
        [holderPid],
      )
      if (Number(blocked.rows[0]?.n ?? 0) >= 1) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`timed out waiting for an approval attachment bind to block on holder ${holderPid}`)
  }

  async function publishAttachmentTemplate(adminToken: string, over: { visibilityScope?: unknown } = {}): Promise<string> {
    const templateKey = `aatt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest('/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Attachment pipeline template',
        description: 'attachment pipeline integration',
        formSchema: {
          fields: [
            { id: 'reason', type: 'text', label: '事由', required: true },
            { id: 'files', type: 'attachment', label: '附件', required: false },
          ],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            { key: 'approve_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [APPROVER], approvalMode: 'single' } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approve_1' },
            { key: 'e2', source: 'approve_1', target: 'end' },
          ],
        },
        ...(over.visibilityScope !== undefined ? { visibilityScope: over.visibilityScope } : {}),
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

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    storageRoot = mkdtempSync(path.join(tmpdir(), 'aatt-pipeline-'))
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
    await ensureUsers(REQUESTER, OUTSIDER, OTHER, APPROVER)
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
      // races the first — tolerated (both servers share one poolManager).
      await offServer?.stop().catch(() => {})
      await server?.stop().catch(() => {})
    }
  }, 30_000)

  it('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('flag-ON boot mounts the pipeline: upload persists an unbound uploader-owned row and the blob under the dedicated root', async () => {
    const adminToken = await authToken(`aatt-admin-${RUN}`)
    const requesterToken = await authToken(REQUESTER)
    const templateId = await publishAttachmentTemplate(adminToken)
    const res = await uploadPdf(requesterToken, templateId, 'files')
    expect(res.status, await res.clone().text()).toBe(201)
    const body = (await res.json()) as { id: string; sizeBytes: number }
    expect(body.id).toMatch(/^att_/)
    createdAttachmentIds.add(body.id)
    const row = (await pool().query('SELECT status, uploader_id, org_id, storage_key FROM approval_attachments WHERE id=$1', [body.id])).rows[0]
    expect(row).toMatchObject({ status: 'unbound', uploader_id: REQUESTER, org_id: 'default' })
    expect(existsSync(path.join(storageRoot, row.storage_key))).toBe(true) // blob physically under the dedicated root
  })

  it('DELETE atomically soft-deletes the staged row and records its durable purge intent', async () => {
    const adminToken = await authToken(`aatt-admin-${RUN}`)
    const requesterToken = await authToken(REQUESTER)
    const templateId = await publishAttachmentTemplate(adminToken)
    const upload = await uploadPdf(requesterToken, templateId, 'files')
    expect(upload.status, await upload.clone().text()).toBe(201)
    const body = (await upload.json()) as { id: string }
    createdAttachmentIds.add(body.id)

    const before = (await pool().query(
      'SELECT status, storage_key FROM approval_attachments WHERE id=$1',
      [body.id],
    )).rows[0] as { status: string; storage_key: string }
    expect(before.status).toBe('unbound')

    const removed = await jsonRequest(`/api/approval/attachments/${body.id}`, requesterToken, { method: 'DELETE' })
    expect(removed.status, await removed.clone().text()).toBe(204)

    const row = (await pool().query('SELECT status FROM approval_attachments WHERE id=$1', [body.id])).rows[0]
    expect(row).toEqual({ status: 'deleted' })
    expect(existsSync(path.join(storageRoot, before.storage_key))).toBe(true)
    const intents = await pool().query(
      `SELECT reason, status FROM approval_attachment_purge_intents
        WHERE storage_key=$1`,
      [before.storage_key],
    )
    expect(intents.rows).toEqual([{ reason: 'row_deleted', status: 'pending' }])
  })

  // §4.1 template-access gate (G2/authorization): visibility_scope is enforced ON UPLOAD with the same
  // predicate the create path uses — an outsider gets a values-free 404 (no template-existence oracle).
  // Callers hold approvals:write so the write-before-Multer gate is not the signal under test here.
  it('template-access: outsider upload against a user-scoped template → 404 values-free; a scoped-in NON-admin uploads fine', async () => {
    const adminToken = await authToken(`aatt-admin-${RUN}`)
    const restrictedId = await publishAttachmentTemplate(adminToken, {
      visibilityScope: { type: 'user', ids: [REQUESTER] },
    })
    const outsiderToken = await authToken(OUTSIDER, 'user', 'approvals:write')
    const denied = await uploadPdf(outsiderToken, restrictedId, 'files')
    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual({ error: 'not_found' }) // values-free — same shape as a nonexistent template
    // positive control: the scoped-in requester (NON-admin token — visibility via the user scope, not a bypass)
    const requesterToken = await authToken(REQUESTER, 'user', 'approvals:write')
    const allowed = await uploadPdf(requesterToken, restrictedId, 'files')
    expect(allowed.status, await allowed.clone().text()).toBe(201)
    createdAttachmentIds.add(((await allowed.json()) as { id: string }).id)
  })

  it('upload without approvals:write is refused before body work — 403, no blob/row', async () => {
    const adminToken = await authToken(`aatt-admin-${RUN}`)
    const templateId = await publishAttachmentTemplate(adminToken)
    const before = Number(
      (await pool().query('SELECT count(*)::int AS c FROM approval_attachments')).rows[0].c,
    )
    const noWrite = await authToken(REQUESTER, 'user', 'approvals:read')
    const denied = await uploadPdf(noWrite, templateId, 'files')
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'forbidden' })
    const after = Number(
      (await pool().query('SELECT count(*)::int AS c FROM approval_attachments')).rows[0].c,
    )
    expect(after).toBe(before) // no durable row from the refused upload
  })

  // §4.4 / G4: the submit txn freezes the id array into form_snapshot AND binds the rows atomically.
  it('bind at submit: staged attachments bind inside the create transaction; snapshot freezes the id array', async () => {
    const adminToken = await authToken(`aatt-admin-${RUN}`)
    const requesterToken = await authToken(REQUESTER)
    const templateId = await publishAttachmentTemplate(adminToken)
    const up = await uploadPdf(requesterToken, templateId, 'files')
    expect(up.status).toBe(201)
    const attId = ((await up.json()) as { id: string }).id
    createdAttachmentIds.add(attId)
    const create = await jsonRequest('/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'bind-at-submit', files: [attId] } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string }
    createdApprovalIds.add(inst.id)
    const att = (await pool().query('SELECT status, instance_id, bound_at FROM approval_attachments WHERE id=$1', [attId])).rows[0]
    expect(att.status).toBe('bound')
    expect(att.instance_id).toBe(inst.id)
    expect(att.bound_at).not.toBeNull()
    const snap = (await pool().query(`SELECT form_snapshot->'files' AS files FROM approval_instances WHERE id=$1`, [inst.id])).rows[0]
    expect(snap.files).toEqual([attId]) // the frozen snapshot IS the bound id array (§8)
  })

  it('double-submit through POST /api/approvals: one staged attachment yields exactly one 201 and no loser instance', async () => {
    const adminToken = await authToken(`aatt-admin-${RUN}`)
    const requesterToken = await authToken(REQUESTER)
    const templateId = await publishAttachmentTemplate(adminToken)
    const upload = await uploadPdf(requesterToken, templateId, 'files')
    expect(upload.status, await upload.clone().text()).toBe(201)
    const attachmentId = ((await upload.json()) as { id: string }).id
    createdAttachmentIds.add(attachmentId)

    const before = new Set<string>((await pool().query(
      'SELECT id FROM approval_instances WHERE template_id=$1',
      [templateId],
    )).rows.map((row: { id: string }) => row.id))
    const raw = pool().getInternalPool()
    const holder = await raw.connect()
    let submissions: Array<Promise<Response>> = []
    const settled = [false, false]
    try {
      await holder.query('BEGIN')
      const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await holder.query('SELECT id FROM approval_attachments WHERE id=$1 FOR UPDATE', [attachmentId])

      const body = { templateId, formData: { reason: 'same staged attachment race', files: [attachmentId] } }
      submissions = [
        jsonRequest('/api/approvals', requesterToken, { method: 'POST', body }),
        jsonRequest('/api/approvals', requesterToken, { method: 'POST', body }),
      ].map((submission, index) => submission.finally(() => {
        settled[index] = true
      }))
      // PostgreSQL's second waiter may queue behind the first waiter rather than list the external
      // holder as its direct blocker. Prove the bind SQL is genuinely parked, and both HTTP requests
      // are still in flight before releasing the row, instead of over-specifying lock-queue topology.
      await waitUntilAttachmentBindBlocksOnHolder(pid)
      expect(settled).toEqual([false, false])
      await holder.query('COMMIT')

      const responses = await Promise.all(submissions)
      expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 400])
      const winner = responses.find((response) => response.status === 201)
      expect(winner).toBeDefined()
      const winnerId = ((await winner!.json()) as { id: string }).id
      createdApprovalIds.add(winnerId)

      const afterRows = (await pool().query(
        'SELECT id FROM approval_instances WHERE template_id=$1 ORDER BY id',
        [templateId],
      )).rows as Array<{ id: string }>
      const createdByRace = afterRows.map((row) => row.id).filter((id) => !before.has(id))
      expect(createdByRace).toEqual([winnerId])
      const attachment = (await pool().query(
        'SELECT status, instance_id FROM approval_attachments WHERE id=$1',
        [attachmentId],
      )).rows[0]
      expect(attachment).toMatchObject({ status: 'bound', instance_id: winnerId })
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      await Promise.allSettled(submissions)
      const raceRows = await pool().query('SELECT id FROM approval_instances WHERE template_id=$1', [templateId])
      for (const row of raceRows.rows as Array<{ id: string }>) createdApprovalIds.add(row.id)
    }
  })

  it('bind failure rolls back the WHOLE create: a foreign attachment id fails the submit; no instance row remains', async () => {
    const adminToken = await authToken(`aatt-admin-${RUN}`)
    const requesterToken = await authToken(REQUESTER)
    const otherToken = await authToken(OTHER)
    const templateId = await publishAttachmentTemplate(adminToken)
    const up = await uploadPdf(otherToken, templateId, 'files') // staged by ANOTHER user
    expect(up.status).toBe(201)
    const foreignId = ((await up.json()) as { id: string }).id
    createdAttachmentIds.add(foreignId)
    const before = Number(
      (await pool().query('SELECT count(*)::int AS c FROM approval_instances WHERE template_id=$1', [templateId])).rows[0].c,
    )
    const create = await jsonRequest('/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'must roll back', files: [foreignId] } },
    })
    expect(create.status, await create.clone().text()).toBe(400) // values-free bind failure
    const after = Number(
      (await pool().query('SELECT count(*)::int AS c FROM approval_instances WHERE template_id=$1', [templateId])).rows[0].c,
    )
    expect(after).toBe(before) // the WHOLE create rolled back — no instance row
    const att = (await pool().query('SELECT status, instance_id FROM approval_attachments WHERE id=$1', [foreignId])).rows[0]
    expect(att).toMatchObject({ status: 'unbound', instance_id: null }) // the foreign row is untouched
  })

  it('auth-proxied download: participant 200 + safe headers; outsider 404 (no oracle)', async () => {
    const adminToken = await authToken(`aatt-admin-${RUN}`)
    const requesterToken = await authToken(REQUESTER, 'user', 'approvals:read,approvals:write')
    const templateId = await publishAttachmentTemplate(adminToken)
    const up = await uploadPdf(requesterToken, templateId, 'files')
    expect(up.status).toBe(201)
    const attId = ((await up.json()) as { id: string }).id
    createdAttachmentIds.add(attId)
    // unbound: uploader-only — the uploader can read it back
    const own = await fetch(`${baseUrl}/api/approval/attachments/${attId}/download`, {
      headers: { Authorization: `Bearer ${await authToken(REQUESTER, 'user', 'approvals:read')}` },
    })
    expect(own.status).toBe(200)
    expect(own.headers.get('content-type')).toContain('application/pdf')
    expect(own.headers.get('content-disposition')).toContain('attachment')
    expect(own.headers.get('x-content-type-options')).toBe('nosniff')
    const outsider = await fetch(`${baseUrl}/api/approval/attachments/${attId}/download`, {
      headers: { Authorization: `Bearer ${await authToken(OUTSIDER, 'user', 'approvals:read')}` },
    })
    expect(outsider.status).toBe(404) // not the uploader, not a participant — values-free denial
  })

  it('deleted-only bound attachment: authorized participant/admin → 410; outsider/cross-org → 404 (no live sibling required)', async () => {
    const adminId = `aatt-admin-${RUN}`
    const adminToken = await authToken(adminId)
    // isInstanceParticipant reads the users table for admin — stamp the real row, not only the JWT role.
    await ensureUsers(adminId)
    await pool().query(
      `UPDATE users SET role = 'admin', is_admin = TRUE WHERE id = $1`,
      [adminId],
    )
    const requesterToken = await authToken(REQUESTER, 'user', 'approvals:read,approvals:write')
    const templateId = await publishAttachmentTemplate(adminToken)
    const up = await uploadPdf(requesterToken, templateId, 'files')
    expect(up.status).toBe(201)
    const attId = ((await up.json()) as { id: string }).id
    createdAttachmentIds.add(attId)
    const create = await jsonRequest('/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'deleted-only 410', files: [attId] } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string }
    createdApprovalIds.add(inst.id)

    // Soft-delete the ONLY bound attachment — no live sibling remains on the instance.
    await pool().query(`UPDATE approval_attachments SET status = 'deleted' WHERE id = $1`, [attId])
    const remaining = await pool().query(
      `SELECT status FROM approval_attachments WHERE instance_id = $1`,
      [inst.id],
    )
    expect(remaining.rows.every((r: { status: string }) => r.status === 'deleted')).toBe(true)

    // Authorized participant (requester) reaches the lifecycle tombstone — 410, not 404.
    const participant = await fetch(`${baseUrl}/api/approval/attachments/${attId}/download`, {
      headers: { Authorization: `Bearer ${await authToken(REQUESTER, 'user', 'approvals:read')}` },
    })
    expect(participant.status).toBe(410)
    expect(await participant.json()).toEqual({ error: 'gone' })

    // Admin reaches the same 410 (authorized) even without a live sibling attachment.
    const adminDl = await fetch(`${baseUrl}/api/approval/attachments/${attId}/download`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(adminDl.status).toBe(410)

    // Outsider stays values-free 404 (no existence/lifecycle oracle) even with approvals:read.
    const outsider = await fetch(`${baseUrl}/api/approval/attachments/${attId}/download`, {
      headers: { Authorization: `Bearer ${await authToken(OUTSIDER, 'user', 'approvals:read')}` },
    })
    expect(outsider.status).toBe(404)
    expect(await outsider.json()).toEqual({ error: 'not_found' })

    // Cross-org: stamp a foreign org on the row and keep the same principal org — still 404.
    await pool().query(`UPDATE approval_attachments SET org_id = 'other-org' WHERE id = $1`, [attId])
    const cross = await fetch(`${baseUrl}/api/approval/attachments/${attId}/download`, {
      headers: { Authorization: `Bearer ${await authToken(REQUESTER, 'user', 'approvals:read')}` },
    })
    expect(cross.status).toBe(404)
  })

  // D5/G1: without the flag the runtime returns null, preserves the pre-feature form-value contract,
  // and cannot freeze an attachment-id array without running the same-transaction bind.
  it('flag OFF: upload is unmounted, legacy values still create, and id arrays cannot form phantom snapshots', async () => {
    const adminToken = await authToken(`aatt-admin-${RUN}`)
    const templateId = await publishAttachmentTemplate(adminToken)
    delete process.env.APPROVAL_ATTACHMENTS_ENABLED
    offServer = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    try {
      await offServer.start()
      const address = offServer.getAddress()
      const port = address && typeof address === 'object' ? address.port : undefined
      const offBase = `http://127.0.0.1:${port}`
      const tokenRes = await fetch(`${offBase}/api/auth/dev-token?userId=${encodeURIComponent(REQUESTER)}`)
      const { token } = (await tokenRes.json()) as { token: string }
      const form = new FormData()
      form.append('templateId', 'irrelevant')
      form.append('fieldId', 'files')
      form.append('file', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'a.pdf')
      const res = await fetch(`${offBase}/api/approval/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      expect(res.status).toBe(404) // unmounted — not 401/403/503: the route does not exist flag-OFF

      const legacyCreate = await fetch(`${offBase}/api/approvals`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId,
          formData: { reason: 'flag-off legacy value', files: 'legacy-file-reference' },
        }),
      })
      expect(legacyCreate.status, await legacyCreate.clone().text()).toBe(201)
      const legacy = (await legacyCreate.json()) as { id: string }
      createdApprovalIds.add(legacy.id)
      const snapshot = (await pool().query(
        `SELECT form_snapshot->>'files' AS files FROM approval_instances WHERE id=$1`,
        [legacy.id],
      )).rows[0]
      expect(snapshot.files).toBe('legacy-file-reference')

      const beforePhantom = Number((await pool().query(
        'SELECT count(*)::int AS c FROM approval_instances WHERE template_id=$1',
        [templateId],
      )).rows[0].c)
      const phantom = await fetch(`${offBase}/api/approvals`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId,
          formData: { reason: 'must not freeze unbound ids', files: ['att_phantom'] },
        }),
      })
      expect(phantom.status).toBe(400)
      const afterPhantom = Number((await pool().query(
        'SELECT count(*)::int AS c FROM approval_instances WHERE template_id=$1',
        [templateId],
      )).rows[0].c)
      expect(afterPhantom).toBe(beforePhantom)
    } finally {
      process.env.APPROVAL_ATTACHMENTS_ENABLED = 'true'
      // offServer is stopped in afterAll AFTER the DB cleanup (stop() ends the shared pool).
    }
  })
})

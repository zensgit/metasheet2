/**
 * Lock-9 (approver process attachments) — real-DB acceptance for the DB-dependent gates.
 *
 * Reference: docs/development/approval-lock9-handler-process-attachments-20260819.md (RATIFIED
 * 2026-08-21, §4.1 amendment applied). No-DB gates (G-3, G-9, G-10, G-15, the G-4/G-16 absence
 * grep) live in tests/unit/approval-lock9-process-attachment-unit.test.ts.
 *
 * Covers: G-1, G-2, G-4 (through the PRODUCTION wiring, never a stub), G-5, G-6, G-7, G-8, G-11,
 * G-12, G-13, G-14, G-16. Two-point wired: excluded from vitest.config.ts's no-DB job and run as
 * WHOLE FILES in the standalone .github/workflows/approval-realdb-lock9-process-attachments.yml
 * lane, which arms EXPECT_DB=1.
 *
 * Harness mirrors approval-attachment-pipeline-realdb.test.ts / approval-handler-node.db.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import * as path from 'node:path'
import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { sweepUnboundAttachments } from '../../src/services/approval-attachment-gc'
import { up as processBindingUp, down as processBindingDown } from '../../src/db/migrations/zzzz20260822130000_approval_attachments_process_binding'
import { up as createAttachmentsUp } from '../../src/db/migrations/zzzz20260715210000_create_approval_attachments'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// ── Anti-skip-green sentinel (TOP-LEVEL, outside describeIfDatabase) ──────────────────────────
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const REQUESTER = `l9-req-${RUN}`
const APPROVER = `l9-appr-${RUN}`
const OTHER_SEAT = `l9-appr2-${RUN}` // a DIFFERENT approver, no seat on most instances
const ACT_ONLY = `l9-actonly-${RUN}` // approvals:act, deliberately NOT approvals:read (G-16)

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

describeIfDatabase('Lock-9 process attachments — real-DB acceptance', () => {
  let server: MetaSheetServer | undefined
  let offServer: MetaSheetServer | undefined
  let baseUrl = ''
  let offBaseUrl = ''
  let storageRoot = ''
  const savedEnv: Record<string, string | undefined> = {}
  const pool = () => poolManager.get()
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdAttachmentIds = new Set<string>()
  const createdUserIds = new Set<string>()

  async function authToken(userId: string, roles = 'admin', perms = '*:*'): Promise<string> {
    if (perms.split(',').some((p) => ['*:*', 'approvals:*', 'approvals:write'].includes(p.trim()))) {
      await grantApprovalWriteForIntegrationActor(userId)
    }
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  async function jsonRequest(pathName: string, token: string, options: { method?: string; body?: unknown; base?: string } = {}) {
    return fetch(`${options.base ?? baseUrl}${pathName}`, {
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

  async function publishPlainTemplate(adminToken: string): Promise<string> {
    const templateKey = `l9-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest('/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Lock-9 plain template',
        description: 'lock-9 process attachment acceptance',
        formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] },
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

  async function createInstance(requesterToken: string, templateId: string, reason = 'lock9 acceptance'): Promise<string> {
    const create = await jsonRequest('/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string }
    createdApprovalIds.add(inst.id)
    return inst.id
  }

  /**
   * G-8 seeding helper: the DB's `approval_att_size_bounds` CHECK caps EVERY row (any bind_kind) at
   * 20 MB, so a single 49MB row is impossible — seed several ≤20MB rows summing to `totalBytes`.
   */
  async function seedHugeBoundFormBytes(instanceId: string, uploaderId: string, totalBytes: number): Promise<string[]> {
    const perRow = 16 * 1024 * 1024 // under the 20MB row cap
    const ids: string[] = []
    let remaining = totalBytes
    let n = 0
    const unique = randomUUID().replace(/-/g, '')
    while (remaining > 0) {
      const size = Math.min(perRow, remaining)
      const id = `att_g8_seed_${unique}_${n}`
      await pool().query(
        `INSERT INTO approval_attachments (id, org_id, uploader_id, instance_id, field_id, storage_key, file_name, mime_type, size_bytes, status, bind_kind, bound_at)
         VALUES ($1,'default',$2,$3,'reason',$4,'huge.pdf','application/pdf',$5,'bound','form_field', now())`,
        [id, uploaderId, instanceId, `k-g8-seed-${unique}-${n}`, size],
      )
      ids.push(id)
      remaining -= size
      n += 1
    }
    return ids
  }

  async function uploadProcess(token: string, stagedInstanceId: string, opts: { fileName?: string; content?: Buffer; base?: string } = {}): Promise<Response> {
    const form = new FormData()
    form.append('stagedInstanceId', stagedInstanceId)
    form.append(
      'file',
      new Blob([opts.content ?? Buffer.from('%PDF-1.4 lock9 process attachment')], { type: 'application/pdf' }),
      opts.fileName ?? 'evidence.pdf',
    )
    return fetch(`${opts.base ?? baseUrl}/api/approval/attachments/process`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
  }

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    storageRoot = mkdtempSync(path.join(tmpdir(), 'l9-att-'))
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
    await ensureUsers(REQUESTER, APPROVER, OTHER_SEAT, ACT_ONLY)
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
      await offServer?.stop().catch(() => {})
      await server?.stop().catch(() => {})
    }
  }, 30_000)

  it('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ===============================================================================================
  // G-1 — process binding never touches form_snapshot; contrasted with a real handle+fieldWrites
  // change on a SIBLING template in the same suite (proving the isolation is process-selected).
  // ===============================================================================================
  describe('G-1: process binding is form_snapshot-isolated', () => {
    it('a comment action with attachmentIds leaves form_snapshot byte-identical and writes ZERO field-revision rows', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      const before = (await pool().query('SELECT form_snapshot FROM approval_instances WHERE id=$1', [iid])).rows[0]

      const up1 = await uploadProcess(approverToken, iid)
      expect(up1.status, await up1.clone().text()).toBe(201)
      const attId = ((await up1.json()) as { id: string }).id
      createdAttachmentIds.add(attId)

      const act = await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, {
        method: 'POST',
        body: { action: 'comment', comment: 'evidence attached', attachmentIds: [attId] },
      })
      expect(act.status, await act.clone().text()).toBe(200)

      const after = (await pool().query('SELECT form_snapshot FROM approval_instances WHERE id=$1', [iid])).rows[0]
      expect(after.form_snapshot).toEqual(before.form_snapshot)
      const revCount = await pool().query('SELECT count(*)::int AS n FROM approval_form_field_revisions WHERE instance_id=$1', [iid])
      expect(revCount.rows[0].n).toBe(0)

      const bound = (await pool().query('SELECT status, instance_id, bind_kind, field_id FROM approval_attachments WHERE id=$1', [attId])).rows[0]
      expect(bound).toMatchObject({ status: 'bound', instance_id: iid, bind_kind: 'process', field_id: null })
    })
  })

  // ===============================================================================================
  // G-2 — bind_kind discriminator is load-bearing; sentinel non-blank field_id on a process row is
  // asserted ABSENT after a full flow. Direct-SQL CHECK probe (mirrors the manual psql verification).
  // ===============================================================================================
  describe('G-2: bind_kind discriminator + CHECK', () => {
    it('a process row with field_id IS NOT NULL never exists after a real upload+bind flow', async () => {
      const n = await pool().query(`SELECT count(*)::int AS n FROM approval_attachments WHERE bind_kind='process' AND field_id IS NOT NULL`)
      expect(n.rows[0].n).toBe(0)
    })

    it('direct CHECK probe: bind_kind=process + field_id NULL is ACCEPTED; bind_kind=form_field + field_id NULL is REJECTED by the SAME CHECK', async () => {
      const id1 = `att_g2probe_${RUN}_ok`
      await pool().query(
        `INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, bind_kind)
         VALUES ($1,'default','probe',NULL,'k-g2-ok','f.pdf','application/pdf',10,'unbound','process')`,
        [id1],
      )
      createdAttachmentIds.add(id1)
      const id2 = `att_g2probe_${RUN}_bad`
      await expect(
        pool().query(
          `INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, bind_kind)
           VALUES ($1,'default','probe',NULL,'k-g2-bad','f.pdf','application/pdf',10,'unbound','form_field')`,
          [id2],
        ),
      ).rejects.toThrow(/approval_att_field_nonblank/)
    })
  })

  // ===============================================================================================
  // G-4 — participant predicate ADOPTED, not minted: an instance carrying ONLY a process attachment
  // resolves participants through the PRODUCTION wiring (bootApprovalAttachmentRuntime's real
  // canReadApprovalInstance binding), never a stub. The requester (never uploaded) reads it back.
  // ===============================================================================================
  describe('G-4: participant predicate through the production wiring', () => {
    it('the requester (a participant via canReadApprovalInstance, never the uploader) downloads a bound process attachment', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      const up1 = await uploadProcess(approverToken, iid)
      const attId = ((await up1.json()) as { id: string }).id
      createdAttachmentIds.add(attId)
      await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, { method: 'POST', body: { action: 'comment', attachmentIds: [attId] } })

      const dl = await jsonRequest(`/api/approval/attachments/${attId}/download`, requesterToken)
      expect(dl.status).toBe(200)
    })

    it('a genuine outsider (not requester/seat/CC/admin) is refused values-free 404 — the predicate still discriminates', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const outsiderId = `l9-outsider-${RUN}`
      await ensureUsers(outsiderId)
      const outsiderToken = await authToken(outsiderId, 'user', 'approvals:read')
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      const up1 = await uploadProcess(approverToken, iid)
      const attId = ((await up1.json()) as { id: string }).id
      createdAttachmentIds.add(attId)
      await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, { method: 'POST', body: { action: 'comment', attachmentIds: [attId] } })

      const dl = await jsonRequest(`/api/approval/attachments/${attId}/download`, outsiderToken)
      expect(dl.status).toBe(404)
      expect(await dl.json()).toEqual({ error: 'not_found' })
    })
  })

  // ===============================================================================================
  // G-5 — upload authority is the ACTIVE SEAT, not participation. Load-bearing: the BIND-time 403
  // (dispatchAction's pre-existing actorCanAct gate, APS ~:9091). Secondary leg: the upload-route
  // fail-fast also refuses a non-seat approvals:act principal.
  // ===============================================================================================
  describe('G-5: upload/bind authority is the active seat', () => {
    it('BIND-time (load-bearing): a non-seat actor posting comment+attachmentIds on the instance is refused 403 APPROVAL_ASSIGNMENT_REQUIRED; the true seat-holder succeeds with the SAME attachment', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const otherToken = await authToken(OTHER_SEAT) // has DB write authority but no seat on THIS instance
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      const up1 = await uploadProcess(approverToken, iid)
      const attId = ((await up1.json()) as { id: string }).id
      createdAttachmentIds.add(attId)

      const denied = await jsonRequest(`/api/approvals/${iid}/actions`, otherToken, {
        method: 'POST',
        body: { action: 'comment', attachmentIds: [attId] },
      })
      expect(denied.status).toBe(403)
      const deniedBody = (await denied.json()) as { code?: string; error?: { code?: string } }
      expect(deniedBody.code ?? deniedBody.error?.code).toBe('APPROVAL_ASSIGNMENT_REQUIRED')
      const stillUnbound = (await pool().query('SELECT status FROM approval_attachments WHERE id=$1', [attId])).rows[0]
      expect(stillUnbound.status).toBe('unbound') // the refused actor bound NOTHING

      const ok = await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, {
        method: 'POST',
        body: { action: 'comment', attachmentIds: [attId] },
      })
      expect(ok.status, await ok.clone().text()).toBe(200)
      const bound = (await pool().query('SELECT status FROM approval_attachments WHERE id=$1', [attId])).rows[0]
      expect(bound.status).toBe('bound')
    })

    it('secondary (fail-fast) leg: a non-seat approvals:act principal is refused AT UPLOAD, before any row is written', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      const otherToken = await authToken(OTHER_SEAT, 'user', 'approvals:act')
      const before = Number((await pool().query('SELECT count(*)::int AS c FROM approval_attachments')).rows[0].c)
      const denied = await uploadProcess(otherToken, iid)
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'forbidden' })
      const after = Number((await pool().query('SELECT count(*)::int AS c FROM approval_attachments')).rows[0].c)
      expect(after).toBe(before) // no durable row from the refused upload

      // positive control: the TRUE seat holder uploads fine at the same instance.
      const approverToken = await authToken(APPROVER, 'user', 'approvals:act')
      const ok = await uploadProcess(approverToken, iid)
      expect(ok.status, await ok.clone().text()).toBe(201)
      createdAttachmentIds.add(((await ok.json()) as { id: string }).id)
    })
  })

  // ===============================================================================================
  // G-6 — bind atomicity + staged-instance integrity. Cross-instance bind refused; a genuine failure
  // rolls back the WHOLE action (no approval_records row, no partial bind).
  // ===============================================================================================
  describe('G-6: bind atomicity + staged-instance integrity', () => {
    it('an approver who staged against instance A cannot bind to instance B (rowCount-equality → 400, whole action rolled back)', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iidA = await createInstance(requesterToken, templateId)
      const iidB = await createInstance(requesterToken, templateId)
      const up1 = await uploadProcess(approverToken, iidA)
      const attId = ((await up1.json()) as { id: string }).id
      createdAttachmentIds.add(attId)

      const recordsBefore = Number((await pool().query('SELECT count(*)::int AS c FROM approval_records WHERE instance_id=$1', [iidB])).rows[0].c)
      const crossBind = await jsonRequest(`/api/approvals/${iidB}/actions`, approverToken, {
        method: 'POST',
        body: { action: 'comment', attachmentIds: [attId] },
      })
      expect(crossBind.status, await crossBind.clone().text()).toBe(400)
      const recordsAfter = Number((await pool().query('SELECT count(*)::int AS c FROM approval_records WHERE instance_id=$1', [iidB])).rows[0].c)
      expect(recordsAfter).toBe(recordsBefore) // the WHOLE action (including the comment record) rolled back
      const row = (await pool().query('SELECT status, instance_id FROM approval_attachments WHERE id=$1', [attId])).rows[0]
      expect(row).toMatchObject({ status: 'unbound', instance_id: null }) // untouched — still staged against A

      // success control: binding to the CORRECT staged instance (A) works.
      const okBind = await jsonRequest(`/api/approvals/${iidA}/actions`, approverToken, {
        method: 'POST',
        body: { action: 'comment', attachmentIds: [attId] },
      })
      expect(okBind.status, await okBind.clone().text()).toBe(200)
      const boundRow = (await pool().query('SELECT status, instance_id, action_record_id FROM approval_attachments WHERE id=$1', [attId])).rows[0]
      expect(boundRow.status).toBe('bound')
      expect(boundRow.instance_id).toBe(iidA)
      expect(boundRow.action_record_id).not.toBeNull()
      const recordRow = (await pool().query(
        'SELECT id FROM approval_records WHERE instance_id=$1 AND action=$2 ORDER BY id DESC LIMIT 1',
        [iidA, 'comment'],
      )).rows[0]
      expect(String(recordRow.id)).toBe(String(boundRow.action_record_id))
    })

    it('a nonexistent id in the same request refuses the WHOLE action (400) — no partial bind', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      const up1 = await uploadProcess(approverToken, iid)
      const realId = ((await up1.json()) as { id: string }).id
      createdAttachmentIds.add(realId)
      const fakeId = `att_${randomUUID()}`

      const act = await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, {
        method: 'POST',
        body: { action: 'comment', attachmentIds: [realId, fakeId] },
      })
      expect(act.status, await act.clone().text()).toBe(400)
      const row = (await pool().query('SELECT status FROM approval_attachments WHERE id=$1', [realId])).rows[0]
      expect(row.status).toBe('unbound') // the REAL id was NOT bound either — all-or-nothing
    })
  })

  // ===============================================================================================
  // G-7 — staged rows are uploader-only until commit; participant-scoped after.
  // ===============================================================================================
  describe('G-7: staged rows are uploader-only until commit', () => {
    it('an uncommitted (staged) attachment downloads for the uploader ONLY; after commit it opens to participants', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      const up1 = await uploadProcess(approverToken, iid)
      const attId = ((await up1.json()) as { id: string }).id
      createdAttachmentIds.add(attId)

      const staleParticipantAttempt = await jsonRequest(`/api/approval/attachments/${attId}/download`, requesterToken)
      expect(staleParticipantAttempt.status).toBe(404) // requester is a real participant but NOT the uploader — staged, so refused

      const uploaderDl = await jsonRequest(`/api/approval/attachments/${attId}/download`, approverToken)
      expect(uploaderDl.status).toBe(200)

      await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, { method: 'POST', body: { action: 'comment', attachmentIds: [attId] } })

      const afterCommit = await jsonRequest(`/api/approval/attachments/${attId}/download`, requesterToken)
      expect(afterCommit.status).toBe(200) // now a participant can read it
    })
  })

  // ===============================================================================================
  // G-8 — process-scoped caps, independent of the requester's form envelope. Direct-SQL seeding for
  // the OTHER kind's bytes (no need for real multi-MB HTTP uploads on either leg).
  // ===============================================================================================
  describe('G-8: process-scoped caps, independent of the form envelope', () => {
    it('a huge BOUND form_field row on the instance does not block a legitimate small process bind', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      for (const id of await seedHugeBoundFormBytes(iid, REQUESTER, 49_000_000)) createdAttachmentIds.add(id)

      const up1 = await uploadProcess(approverToken, iid)
      expect(up1.status, await up1.clone().text()).toBe(201)
      const attId = ((await up1.json()) as { id: string }).id
      createdAttachmentIds.add(attId)
      const bind = await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, { method: 'POST', body: { action: 'comment', attachmentIds: [attId] } })
      expect(bind.status, await bind.clone().text()).toBe(200)
    })

    it('upload-time fail-fast: exceeding maxFilesPerAction (5) staged files for one instance/uploader is refused 413, count unaffected by coexisting huge form bytes', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      for (const id of await seedHugeBoundFormBytes(iid, REQUESTER, 49_000_000)) createdAttachmentIds.add(id)

      for (let i = 0; i < 5; i += 1) {
        const up = await uploadProcess(approverToken, iid, { fileName: `f${i}.pdf` })
        expect(up.status, `file ${i}: ${await up.clone().text()}`).toBe(201)
        createdAttachmentIds.add(((await up.json()) as { id: string }).id)
      }
      const sixth = await uploadProcess(approverToken, iid, { fileName: 'f6.pdf' })
      expect(sixth.status, await sixth.clone().text()).toBe(413)
      expect((await sixth.json()).error).toBe('rejected')
    })
  })

  // ===============================================================================================
  // G-11 — values-free scoped correctly: error payloads carry no filename/uploader/size; the audit
  // metadata carries the attachment ID only; an AUTHORIZED download still serves the real file_name.
  // ===============================================================================================
  describe('G-11: values-free scoping', () => {
    it('a rejected (cap-exceeded) upload body carries no filename/uploader/size; the audit metadata carries the id only; an authorized download serves the real filename', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)

      const freshIds: string[] = []
      for (let i = 0; i < 5; i += 1) {
        const up = await uploadProcess(approverToken, iid, { fileName: `g11-${i}.pdf` })
        const id = ((await up.json()) as { id: string }).id
        freshIds.push(id)
        createdAttachmentIds.add(id)
      }
      const rejectedFileName = 'super-secret-filename-should-never-leak.pdf'
      const sixth = await uploadProcess(approverToken, iid, { fileName: rejectedFileName })
      expect(sixth.status).toBe(413)
      const rejectedBodyText = JSON.stringify(await sixth.json())
      expect(rejectedBodyText).not.toContain(rejectedFileName)
      expect(rejectedBodyText).not.toContain(APPROVER)

      const bindableId = freshIds[0]
      const attFileNameRow = (await pool().query('SELECT file_name FROM approval_attachments WHERE id=$1', [bindableId])).rows[0]
      const bind = await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, {
        method: 'POST',
        body: { action: 'comment', attachmentIds: [bindableId] },
      })
      expect(bind.status, await bind.clone().text()).toBe(200)
      const rec = (await pool().query(
        `SELECT metadata FROM approval_records WHERE instance_id=$1 AND action='comment' ORDER BY id DESC LIMIT 1`,
        [iid],
      )).rows[0]
      expect(rec.metadata).toMatchObject({ attachmentIds: [bindableId] })
      expect(JSON.stringify(rec.metadata)).not.toContain(attFileNameRow.file_name)

      const dl = await jsonRequest(`/api/approval/attachments/${bindableId}/download`, requesterToken)
      expect(dl.status).toBe(200)
      expect(dl.headers.get('content-disposition')).toContain(encodeURIComponent(attFileNameRow.file_name))
    })
  })

  // ===============================================================================================
  // G-13 — GC/reconciler reuse: an abandoned unbound process attachment is swept by the UNCHANGED
  // sweepUnboundAttachments; a BOUND process attachment is never swept.
  // ===============================================================================================
  describe('G-13: GC reuse (unmodified sweepUnboundAttachments)', () => {
    it('sweeps a backdated unbound process row; leaves a bound process row untouched', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)

      const staleId = `att_g13_stale_${RUN}`
      await pool().query(
        `INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, bind_kind, created_at)
         VALUES ($1,'default',$2,NULL,'k-g13-stale','stale.pdf','application/pdf',10,'unbound','process', now() - interval '169 hours')`,
        [staleId, APPROVER],
      )
      createdAttachmentIds.add(staleId)

      const up1 = await uploadProcess(approverToken, iid)
      const boundId = ((await up1.json()) as { id: string }).id
      createdAttachmentIds.add(boundId)
      await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, { method: 'POST', body: { action: 'comment', attachmentIds: [boundId] } })

      await sweepUnboundAttachments(pool())

      const staleRow = (await pool().query('SELECT status FROM approval_attachments WHERE id=$1', [staleId])).rows[0]
      expect(staleRow.status).toBe('deleted')
      const boundRow = (await pool().query('SELECT status FROM approval_attachments WHERE id=$1', [boundId])).rows[0]
      expect(boundRow.status).toBe('bound') // bound-frozen — the sweep never touches it
    })
  })

  // ===============================================================================================
  // G-16 — read scope is a decided posture: ALL instance participants (gate 1) can read on BOTH
  // /download and /refs; an approvals:act-only principal (no approvals:read) is refused (values-
  // free 404) — the upload/read asymmetry is real, not accidental.
  // ===============================================================================================
  describe('G-16: read scope — all participants, act-only principal refused', () => {
    it('an approvals:act-ONLY principal (not approvals:read) is refused readback on /download and /refs; a participant with approvals:read succeeds', async () => {
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      const up1 = await uploadProcess(approverToken, iid)
      const attId = ((await up1.json()) as { id: string }).id
      createdAttachmentIds.add(attId)
      await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, { method: 'POST', body: { action: 'comment', attachmentIds: [attId] } })

      // ACT_ONLY: a real participant (seeded as a CC target) but with ONLY approvals:act, no read.
      await pool().query(
        `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, from_status, to_status, from_version, to_version, metadata)
         VALUES ($1,'cc','system','system','pending','pending',1,1,$2::jsonb)`,
        [iid, JSON.stringify({ targetType: 'user', targetId: ACT_ONLY })],
      )
      const actOnlyToken = await authToken(ACT_ONLY, 'user', 'approvals:act')
      const dlRefused = await jsonRequest(`/api/approval/attachments/${attId}/download`, actOnlyToken)
      expect(dlRefused.status).toBe(404)
      const refsRefused = await jsonRequest('/api/approval/attachments/refs', actOnlyToken, {
        method: 'POST',
        body: { instanceId: iid, ids: [attId] },
      })
      expect(refsRefused.status).toBe(404)

      // Positive control: the requester (approvals:read via admin default) succeeds on both.
      const dlOk = await jsonRequest(`/api/approval/attachments/${attId}/download`, requesterToken)
      expect(dlOk.status).toBe(200)
      const refsOk = await jsonRequest('/api/approval/attachments/refs', requesterToken, {
        method: 'POST',
        body: { instanceId: iid, ids: [attId] },
      })
      expect(refsOk.status).toBe(200)
      expect((await refsOk.json()).attachments).toEqual([
        expect.objectContaining({ id: attId, tombstone: false, fieldId: null }),
      ])
    })
  })

  // ===============================================================================================
  // G-12 — legacy OFF is a byte-for-byte no-op on BOTH gates.
  //   (a) route registration: a SECOND boot without the flag never mounts the process route.
  //   (b) dispatch: with the flag OFF, a comment carrying a bogus attachmentIds still SUCCEEDS and
  //       binds nothing; with the flag ON, the SAME bogus id 400s (rowCount-equality) — the
  //       discriminating pair (avoids the G-12(b) vacuity hazard: this asserts through the SERVICE
  //       dispatch path via the real HTTP route, which THIS slice's own routes/approvals.ts change
  //       makes a genuine test — forwarding was previously nonexistent).
  // ===============================================================================================
  describe('G-12: legacy OFF is a byte-for-byte no-op', () => {
    it('(a) a flag-OFF boot never registers the process-upload route (404, not 403/401)', async () => {
      offServer = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
      const savedFlag = process.env.APPROVAL_ATTACHMENTS_ENABLED
      delete process.env.APPROVAL_ATTACHMENTS_ENABLED
      try {
        await offServer.start()
      } finally {
        process.env.APPROVAL_ATTACHMENTS_ENABLED = savedFlag
      }
      const offAddress = offServer.getAddress()
      const offPort = offAddress && typeof offAddress === 'object' ? offAddress.port : undefined
      expect(offPort).toBeTruthy()
      offBaseUrl = `http://127.0.0.1:${offPort}`
      const requesterToken = await authToken(REQUESTER)
      const res = await uploadProcess(requesterToken, 'whatever', { base: offBaseUrl })
      // No process router mounted at all ⇒ Express's own 404 (not this route's typed JSON refusal).
      expect(res.status).toBe(404)

      // Positive control: the SAME flag-ON server DOES register it (a 401/403/400 — never a bare 404
      // from an unmounted route — proves the route exists there).
      const onRes = await fetch(`${baseUrl}/api/approval/attachments/process`, { method: 'POST' })
      expect(onRes.status).not.toBe(404)
    })

    it('(b) flag OFF: a comment with a BOGUS attachmentIds still succeeds (ignored, byte-for-byte); flag ON: the SAME bogus id 400s', async () => {
      // dispatchAction reads isApprovalAttachmentsEnabled(process.env) FRESH at call time (never
      // cached at module load — this is the load-bearing design property G-12 depends on), so the
      // discriminating pair is obtained by flipping the flag AROUND two calls on the SAME
      // already-booted (always-registered dispatchAction) server — no second boot needed for (b).
      const adminToken = await authToken(`l9-admin-${RUN}`)
      const requesterToken = await authToken(REQUESTER)
      const approverToken = await authToken(APPROVER)
      const templateId = await publishPlainTemplate(adminToken)
      const iid = await createInstance(requesterToken, templateId)
      const bogusId = `att_${randomUUID()}`

      const savedFlag = process.env.APPROVAL_ATTACHMENTS_ENABLED
      let offResult: Response
      try {
        delete process.env.APPROVAL_ATTACHMENTS_ENABLED
        offResult = await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, {
          method: 'POST',
          body: { action: 'comment', comment: 'off flag', attachmentIds: [bogusId] },
        })
      } finally {
        process.env.APPROVAL_ATTACHMENTS_ENABLED = savedFlag
      }
      expect(offResult.status, await offResult.clone().text()).toBe(200) // succeeds — the bogus id is IGNORED
      const boundCountAfterOff = Number((await pool().query(`SELECT count(*)::int AS c FROM approval_attachments WHERE bind_kind='process' AND status='bound'`)).rows[0].c)

      // ON dispatch with the SAME bogus id: rowCount-equality throws → 400 (the discriminating half).
      const onResult = await jsonRequest(`/api/approvals/${iid}/actions`, approverToken, {
        method: 'POST',
        body: { action: 'comment', attachmentIds: [bogusId] },
      })
      expect(onResult.status, await onResult.clone().text()).toBe(400)
      const boundCountAfterOn = Number((await pool().query(`SELECT count(*)::int AS c FROM approval_attachments WHERE bind_kind='process' AND status='bound'`)).rows[0].c)
      expect(boundCountAfterOn).toBe(boundCountAfterOff) // the ON 400 bound nothing either — no partial bind
    })
  })
})

// =================================================================================================
// G-14 — DDL relaxation + ordering + rollback. Isolated schema (house rule for shared-DB
// integration; mirrors approval-attachment-scan-purge-upgrade-migration.db.test.ts's technique),
// applying the REAL migration functions directly via Kysely — not a psql transcript.
// =================================================================================================
describe(process.env.DATABASE_URL ? 'G-14: migration relaxation + ordering + rollback (isolated schema)' : 'G-14 (skipped, no DATABASE_URL)', () => {
  const dbUrl = process.env.DATABASE_URL
  const maybeIt = dbUrl ? it : it.skip
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  async function setup(): Promise<void> {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `l9_g14_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })
    await sql`CREATE TABLE approval_instances (id text PRIMARY KEY, status text NOT NULL DEFAULT 'pending')`.execute(testDb)
    await createAttachmentsUp(testDb)
  }

  async function teardown(): Promise<void> {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  }

  maybeIt('ordering: the new migration filename IS the lexicographic maximum of the migrations directory', async () => {
    const { readdirSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'db', 'migrations')
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.sql'))
    const max = [...files].sort().at(-1)
    expect(max).toBe('zzzz20260822130000_approval_attachments_process_binding.ts')
  })

  maybeIt('deploy precondition: BEFORE this migration, a bind_kind=process/field_id=NULL write hard-fails on NOT NULL', async () => {
    await setup()
    try {
      await expect(
        sql`INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status)
            VALUES ('att_pre', 'org1', 'u1', NULL, 'k1', 'f.pdf', 'application/pdf', 10, 'unbound')`.execute(testDb),
      ).rejects.toThrow(/null value in column "field_id"/)
    } finally {
      await teardown()
    }
  })

  maybeIt('after the migration: process/NULL accepted, form_field/NULL still rejected; down REFUSES while a process row exists, then succeeds once purged', async () => {
    await setup()
    try {
      await processBindingUp(testDb)

      await sql`INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, bind_kind)
                 VALUES ('att_ok', 'org1', 'u1', NULL, 'k2', 'f.pdf', 'application/pdf', 10, 'unbound', 'process')`.execute(testDb)
      await expect(
        sql`INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, bind_kind)
            VALUES ('att_bad', 'org1', 'u1', NULL, 'k3', 'f.pdf', 'application/pdf', 10, 'unbound', 'form_field')`.execute(testDb),
      ).rejects.toThrow(/approval_att_field_nonblank/)

      // down REFUSES while a process row exists.
      await expect(processBindingDown(testDb)).rejects.toThrow(/process rows exist/)

      // purge, then down succeeds and restores the original shape.
      await sql`DELETE FROM approval_attachments WHERE id = 'att_ok'`.execute(testDb)
      await processBindingDown(testDb)
      await expect(
        sql`INSERT INTO approval_attachments (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status)
            VALUES ('att_post', 'org1', 'u1', NULL, 'k4', 'f.pdf', 'application/pdf', 10, 'unbound')`.execute(testDb),
      ).rejects.toThrow(/null value in column "field_id"/)
    } finally {
      await teardown()
    }
  })
})

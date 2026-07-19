/**
 * Production createApproval path (not bind helper alone) — flag ON, attachment bind form-freeze.
 *
 *   - clean uploader-owned unbound id → instance commits, form_snapshot freezes ids, row bound
 *   - infected / foreign id → create rejects (values-free 400), instance/assignments/records = 0,
 *     attachment remains unbound/infected
 *
 * Mutating the create-path bind call or infected guard must RED this file.
 * Two-point wired (vitest exclude + plugin-tests.yml).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { ServiceError } from '../../src/services/ApprovalBridgeService'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const RUN = randomUUID().slice(0, 8)
const REQUESTER = `u_att_create_${RUN}`
const OTHER = `u_att_other_${RUN}`
const ATT_CLEAN = `att_clean_${RUN}`
const ATT_INF = `att_inf_${RUN}`
const ATT_FOREIGN = `att_foreign_${RUN}`

let svc: ApprovalProductService
let templateId = ''
const instanceIds: string[] = []

function linearGraph(approverId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 'Start', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        name: 'Approve',
        config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [approverId] }] },
      },
      { key: 'end', type: 'end', name: 'End', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'end' },
    ],
  }
}

async function countInstancesForTemplate(): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS n FROM approval_instances WHERE template_id = $1', [templateId])
  return (r.rows[0] as { n: number }).n
}

async function seedAttachment(over: {
  id: string
  uploader: string
  scanState?: string
  fieldId?: string
}) {
  await q(
    `INSERT INTO approval_attachments
       (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, scan_state)
     VALUES ($1,'org1',$2,$3,$4,'a.pdf','application/pdf',1024,'unbound',$5)
     ON CONFLICT (id) DO UPDATE SET status='unbound', scan_state=EXCLUDED.scan_state, uploader_id=EXCLUDED.uploader_id`,
    [
      over.id,
      over.uploader,
      over.fieldId ?? 'proof',
      `approval/2026-07/${over.id}.pdf`,
      over.scanState ?? 'unscanned',
    ],
  )
}

describeIfDatabase('createApproval attachment bind (real DB, production path)', () => {
  beforeAll(async () => {
    process.env.APPROVAL_ATTACHMENTS_ENABLED = 'true'
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [REQUESTER, `${REQUESTER}@test.local`],
    ).catch(() => {})
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [OTHER, `${OTHER}@test.local`],
    ).catch(() => {})

    svc = new ApprovalProductService()
    const tpl = await svc.createTemplate({
      key: `att-create-${RUN}`,
      name: 'Attachment create bind template',
      formSchema: {
        fields: [
          { id: 'reason', type: 'text', label: 'Reason', required: true },
          { id: 'proof', type: 'attachment', label: 'Proof', required: false },
        ],
      },
      approvalGraph: linearGraph(OTHER),
    } as never)
    templateId = (tpl as { id: string }).id
    await svc.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)
  })

  afterAll(async () => {
    delete process.env.APPROVAL_ATTACHMENTS_ENABLED
    for (const id of instanceIds) {
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [id]).catch(() => {})
    }
    await q('DELETE FROM approval_attachments WHERE id = ANY($1)', [[ATT_CLEAN, ATT_INF, ATT_FOREIGN]]).catch(() => {})
    await q('DELETE FROM approval_templates WHERE id = $1', [templateId]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1)', [[REQUESTER, OTHER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set + flag ON for this suite', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
    expect(process.env.APPROVAL_ATTACHMENTS_ENABLED).toBe('true')
  })

  test('clean uploader-owned attachment: createApproval commits instance + freezes ids + binds row', async () => {
    await seedAttachment({ id: ATT_CLEAN, uploader: REQUESTER, scanState: 'clean' })
    const before = await countInstancesForTemplate()
    const dto = await svc.createApproval(
      { templateId, formData: { reason: 'trip', proof: [ATT_CLEAN] } },
      { userId: REQUESTER, userName: REQUESTER },
    )
    instanceIds.push((dto as { id: string }).id)
    expect(await countInstancesForTemplate()).toBe(before + 1)

    const snap = (dto as { formSnapshot?: Record<string, unknown> }).formSnapshot
    expect(snap?.proof).toEqual([ATT_CLEAN])

    const row = await q('SELECT status, instance_id, scan_state FROM approval_attachments WHERE id=$1', [ATT_CLEAN])
    expect(row.rows[0]).toMatchObject({ status: 'bound', scan_state: 'clean' })
    expect(row.rows[0].instance_id).toBe((dto as { id: string }).id)

    // create path must have written assignments/records for the live instance
    const asg = await q('SELECT COUNT(*)::int AS n FROM approval_assignments WHERE instance_id=$1', [
      (dto as { id: string }).id,
    ])
    expect((asg.rows[0] as { n: number }).n).toBeGreaterThan(0)
  })

  test('infected attachment: create rejects 400 values-free; no instance; row stays unbound/infected', async () => {
    await seedAttachment({ id: ATT_INF, uploader: REQUESTER, scanState: 'infected' })
    const beforeInst = await countInstancesForTemplate()
    const beforeRec = await q(
      `SELECT COUNT(*)::int AS n FROM approval_records r
       JOIN approval_instances i ON i.id = r.instance_id WHERE i.template_id = $1`,
      [templateId],
    )

    let caught: unknown
    try {
      await svc.createApproval(
        { templateId, formData: { reason: 'trip', proof: [ATT_INF] } },
        { userId: REQUESTER, userName: REQUESTER },
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ServiceError)
    const se = caught as ServiceError
    expect(se.statusCode).toBe(400)
    expect(se.code).toBe('APPROVAL_ATTACHMENT_BIND_FAILED')
    expect(se.message).not.toMatch(/bindable|infected|host|5432|postgres/i)
    expect(JSON.stringify(se)).not.toMatch(/bindable|ECONNREFUSED|password/)

    expect(await countInstancesForTemplate()).toBe(beforeInst)
    const afterRec = await q(
      `SELECT COUNT(*)::int AS n FROM approval_records r
       JOIN approval_instances i ON i.id = r.instance_id WHERE i.template_id = $1`,
      [templateId],
    )
    expect((afterRec.rows[0] as { n: number }).n).toBe((beforeRec.rows[0] as { n: number }).n)

    const row = await q('SELECT status, instance_id, scan_state FROM approval_attachments WHERE id=$1', [ATT_INF])
    expect(row.rows[0]).toMatchObject({ status: 'unbound', scan_state: 'infected' })
    expect(row.rows[0].instance_id).toBeNull()
  })

  test('foreign uploader attachment: create rejects; attachment remains unbound; zero new instance', async () => {
    await seedAttachment({ id: ATT_FOREIGN, uploader: OTHER, scanState: 'clean' })
    const before = await countInstancesForTemplate()
    await expect(
      svc.createApproval(
        { templateId, formData: { reason: 'trip', proof: [ATT_FOREIGN] } },
        { userId: REQUESTER, userName: REQUESTER },
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_ATTACHMENT_BIND_FAILED' })
    expect(await countInstancesForTemplate()).toBe(before)
    const row = await q('SELECT status, instance_id FROM approval_attachments WHERE id=$1', [ATT_FOREIGN])
    expect(row.rows[0]).toMatchObject({ status: 'unbound' })
    expect(row.rows[0].instance_id).toBeNull()
  })

  test('source pin: createApproval calls bindAttachmentsOnSubmit under flag (mutation RED)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/ApprovalProductService.ts'),
      'utf8',
    )
    expect(src).toMatch(/bindAttachmentsOnSubmit\(/)
    // infected guard lives in bind SQL
    const bindSrc = fs.readFileSync(
      path.join(__dirname, '../../src/services/approval-attachment-reconciler.ts'),
      'utf8',
    )
    expect(bindSrc).toMatch(/scan_state[\s\S]*infected/)
  })
})

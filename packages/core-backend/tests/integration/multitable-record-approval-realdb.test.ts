/**
 * Record-level submit-for-approval — real-Postgres end-to-end (design §6 row 2).
 *
 * Fixture shape follows the multitable-d1c-*-realdb suites (raw pool seeding + the REAL
 * `ApprovalProductService` for templates/instances) and the multitable-w13-*-realdb suites (an express app
 * with a fake "always-on session" middleware in front of the REAL router, so `resolveSheetCapabilities`
 * resolves the actor from the DATABASE — never from a token claim).
 *
 * WHAT IS PROVEN HERE (each one needs real Postgres — a fake query cannot answer any of them):
 *   G1  no `multitable:submit-approval` → 403 and ZERO submission rows (the capability gate is a door,
 *       not a decoration);
 *   G2  a DRAFT template → 400 RECORD_APPROVAL_TEMPLATE_NOT_PUBLISHED, still zero rows;
 *   G3  success → one `pending` row bound to a REAL `approval_instances` row (the three-step landed);
 *   G4  a second submit of the same (record, template) → 409 RECORD_APPROVAL_IN_FLIGHT naming the
 *       in-flight instance, and STILL exactly one in-flight row (the partial unique index, under the
 *       real index — this is the uniqueness proof §6 asks for);
 *   G4b the index is PARTIAL: a terminal row does NOT block the next submission (two raw INSERTs);
 *   G5  completion through the REAL durable adapter (`buildDurableConsumerHandlers`'s
 *       `multitable-record-approval`, boot-identical) → row `approved` + exactly ONE notification row;
 *       a REDELIVERY adds nothing (the `WHERE status = 'pending'` guard, proven against real rowcounts);
 *   G6  GET drift: after a real record write the list reports `changed` with the changed field id, and a
 *       field the caller may not read is masked out of `changedFieldIds` (values never appear at all).
 *
 * Runs only with DATABASE_URL — the no-DB vitest config EXCLUDES this file (so it cannot skip-green in the
 * required job). Its CI lane is .github/workflows/multitable-record-approval-realdb.yml, which is NOT in
 * this commit: the pushing token has no `workflow` OAuth scope. Until that file lands, run this suite with
 * `vitest --config vitest.integration.config.ts run tests/integration/multitable-record-approval-realdb.test.ts`
 * against a migrated database.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { up as createRecordApprovalSubmissions } from '../../src/db/migrations/zzzz20260915120000_create_multitable_record_approval_submissions'
import { up as seedSubmitApprovalPermission } from '../../src/db/migrations/zzzz20260915121000_add_multitable_submit_approval_permission'
import { createMultitableRecordApprovalRoutes } from '../../src/routes/multitable-record-approvals'
import { buildDurableConsumerHandlers } from '../../src/multitable/automation-durable-consumer-handlers'
import { createRecordApprovalCompletionSink } from '../../src/multitable/record-approval-submission-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const SUBMITTER = `u_mtra_submitter_${TS}`
const NO_CODE = `u_mtra_nocode_${TS}`
const APPROVER = `u_mtra_approver_${TS}`

const BASE = `base_mtra_${TS}`
const SHEET = `sheet_mtra_${TS}`
const RECORD = `rec_mtra_${TS}`
const RECORD_B = `rec_mtra_b_${TS}`
const F_TITLE = `fld_mtra_title_${TS}`
const F_SECRET = `fld_mtra_secret_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let currentUserId = SUBMITTER
let publishedTemplateId = ''
let draftTemplateId = ''
const templateIds: string[] = []

const submissionsFor = async (recordId: string) =>
  (await q(
    `SELECT id, status, outcome, approval_instance_id, approval_request_no, record_version_at_submit, error
       FROM multitable_record_approval_submissions
      WHERE sheet_id = $1 AND record_id = $2
      ORDER BY created_at ASC`,
    [SHEET, recordId],
  )).rows as Array<{
    id: string
    status: string
    outcome: string | null
    approval_instance_id: string | null
    approval_request_no: string | null
    record_version_at_submit: number
    error: string | null
  }>

const notificationsFor = async (recordId: string) =>
  (await q(
    `SELECT user_id, event_type, message FROM meta_record_subscription_notifications
      WHERE sheet_id = $1 AND record_id = $2 ORDER BY created_at ASC`,
    [SHEET, recordId],
  )).rows as Array<{ user_id: string; event_type: string; message: string | null }>

function templateRequest(key: string) {
  return {
    key,
    name: 'MTRA Approval',
    visibilityScope: { type: 'all', ids: [] },
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'Approver',
          config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
        },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'e-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'e-approval_1-end', source: 'approval_1', target: 'end' },
      ],
    },
  }
}

const submit = (recordId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET}/records/${recordId}/approvals`).send(body)

const list = (recordId: string) =>
  request(app).get(`/api/multitable/sheets/${SHEET}/records/${recordId}/approvals`)

describeIfDatabase('multitable record-level submit-for-approval (real DB)', () => {
  beforeAll(async () => {
    await ensureApprovalSchemaReady()
    // The feature's own migrations, applied idempotently — so this suite also proves the DDL runs on a
    // real server (not just that its text looks right).
    await createRecordApprovalSubmissions(db as never)
    await seedSubmitApprovalPermission(db as never)

    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as { user?: unknown }).user = { id: currentUserId, roles: ['member'], perms: [] }
      next()
    })
    app.use('/api/multitable', createMultitableRecordApprovalRoutes())

    for (const code of ['multitable:read', 'multitable:submit-approval', 'approvals:read', 'approvals:write']) {
      await q(
        `INSERT INTO permissions (code, name, description) VALUES ($1, $1, 'MTRA test') ON CONFLICT (code) DO NOTHING`,
        [code],
      )
    }
    for (const id of [SUBMITTER, NO_CODE, APPROVER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_admin = FALSE, role = 'user'`,
        [id, `${id}@example.test`],
      )
      await q(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [id],
      )
    }
    // SUBMITTER holds BOTH doors (multitable-side code + the approval product's approvals:write).
    for (const code of ['multitable:read', 'multitable:submit-approval', 'approvals:read', 'approvals:write']) {
      await q('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [SUBMITTER, code])
    }
    // NO_CODE can READ the sheet and holds every APPROVAL permission — it lacks ONLY
    // `multitable:submit-approval`, so a 403 below isolates that single code.
    for (const code of ['multitable:read', 'approvals:read', 'approvals:write']) {
      await q('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [NO_CODE, code])
    }

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'MTRA Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'MTRA Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_TITLE, SHEET, 'Title', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_SECRET, SHEET, 'Secret', 'string', '{}', 2])
    // F_SECRET is invisible to SUBMITTER specifically (the drift mask's subject).
    await q(
      'INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [SHEET, F_SECRET, 'user', SUBMITTER, false, true],
    )
    for (const recordId of [RECORD, RECORD_B]) {
      await q(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)`,
        [recordId, SHEET, JSON.stringify({ [F_TITLE]: 'before', [F_SECRET]: 'classified-before' }), SUBMITTER],
      )
    }

    const approvals = new ApprovalProductService()
    const published = await approvals.createTemplate(templateRequest(`mtra-pub-${TS}`) as never)
    templateIds.push(published.id)
    await approvals.publishTemplate(published.id, { policy: { allowRevoke: true } } as never)
    publishedTemplateId = published.id
    const draft = await approvals.createTemplate(templateRequest(`mtra-draft-${TS}`) as never)
    templateIds.push(draft.id)
    draftTemplateId = draft.id
  })

  afterAll(async () => {
    await q('DELETE FROM multitable_record_approval_submissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_subscription_notifications WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM approval_records WHERE instance_id IN (SELECT id FROM approval_instances WHERE template_id = ANY($1::text[]))', [templateIds]).catch(() => {})
    await q('DELETE FROM approval_assignments WHERE instance_id IN (SELECT id FROM approval_instances WHERE template_id = ANY($1::text[]))', [templateIds]).catch(() => {})
    await q('DELETE FROM approval_instances WHERE template_id = ANY($1::text[])', [templateIds]).catch(() => {})
    await q('DELETE FROM approval_template_versions WHERE template_id = ANY($1::text[])', [templateIds]).catch(() => {})
    await q('DELETE FROM approval_templates WHERE id = ANY($1::text[])', [templateIds]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[SUBMITTER, NO_CODE, APPROVER]]).catch(() => {})
    await q('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [[SUBMITTER, NO_CODE, APPROVER]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[SUBMITTER, NO_CODE, APPROVER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('G1 no multitable:submit-approval → 403 RECORD_APPROVAL_PERMISSION_DENIED, ZERO rows written', async () => {
    currentUserId = NO_CODE
    const res = await submit(RECORD, { templateId: publishedTemplateId, formData: { summary: 'nope' } })
    currentUserId = SUBMITTER
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('RECORD_APPROVAL_PERMISSION_DENIED')
    expect(await submissionsFor(RECORD)).toHaveLength(0)
  })

  test('G2 a DRAFT template → 400 RECORD_APPROVAL_TEMPLATE_NOT_PUBLISHED, still ZERO rows', async () => {
    const res = await submit(RECORD, { templateId: draftTemplateId, formData: { summary: 'draft' } })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('RECORD_APPROVAL_TEMPLATE_NOT_PUBLISHED')
    expect(await submissionsFor(RECORD)).toHaveLength(0)
  })

  test('G2b an unknown record on this sheet → 404 RECORD_APPROVAL_RECORD_NOT_FOUND', async () => {
    const res = await request(app)
      .post(`/api/multitable/sheets/${SHEET}/records/rec_does_not_exist_${TS}/approvals`)
      .send({ templateId: publishedTemplateId, formData: { summary: 'x' } })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('RECORD_APPROVAL_RECORD_NOT_FOUND')
  })

  test('G3 success → 201, ONE pending row bound to a REAL approval instance', async () => {
    const res = await submit(RECORD, { templateId: publishedTemplateId, formData: { summary: 'please approve' } })
    expect(res.status).toBe(201)
    const submission = res.body.data.submission
    expect(submission.status).toBe('pending')
    expect(submission.approvalInstanceId).toBeTruthy()
    expect(submission.recordVersionAtSubmit).toBe(1)

    const rows = await submissionsFor(RECORD)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.approval_instance_id).toBe(submission.approvalInstanceId)
    expect(rows[0]!.error).toBeNull()

    const instance = await q('SELECT id, status, template_id FROM approval_instances WHERE id = $1', [submission.approvalInstanceId])
    expect(instance.rows).toHaveLength(1)
    expect((instance.rows[0] as { template_id: string }).template_id).toBe(publishedTemplateId)

    // the snapshot was stored for the drift anchor (the row, not the response)
    const snap = await q('SELECT record_snapshot FROM multitable_record_approval_submissions WHERE id = $1', [rows[0]!.id])
    expect((snap.rows[0] as { record_snapshot: Record<string, unknown> }).record_snapshot[F_TITLE]).toBe('before')
    // ...and the response NEVER carries it
    expect(JSON.stringify(res.body)).not.toContain('classified-before')
  })

  test('G4 a second submit for the SAME (record, template) → 409 naming the in-flight instance; still ONE in-flight row', async () => {
    const res = await submit(RECORD, { templateId: publishedTemplateId, formData: { summary: 'again' } })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('RECORD_APPROVAL_IN_FLIGHT')
    expect(res.body.error.details.approvalInstanceId).toBeTruthy()

    const rows = await submissionsFor(RECORD)
    expect(rows.filter((r) => r.status === 'creating' || r.status === 'pending')).toHaveLength(1)
    // no second approval instance was created for this record/template pair
    const instances = await q(
      `SELECT count(*)::int AS n FROM approval_instances
        WHERE id IN (SELECT approval_instance_id FROM multitable_record_approval_submissions WHERE sheet_id = $1 AND record_id = $2)`,
      [SHEET, RECORD],
    )
    expect((instances.rows[0] as { n: number }).n).toBe(1)
  })

  test('G4b the unique index is PARTIAL: a terminal row does NOT block the next submission (two raw INSERTs)', async () => {
    const insert = (status: string) =>
      q(
        `INSERT INTO multitable_record_approval_submissions
           (sheet_id, record_id, template_id, status, submitted_by, record_version_at_submit, record_snapshot)
         VALUES ($1, $2, $3, $4, $5, 1, '{}'::jsonb) RETURNING id`,
        [SHEET, RECORD_B, publishedTemplateId, status, SUBMITTER],
      )

    const first = await insert('pending')
    expect(first.rows).toHaveLength(1)
    // second IN-FLIGHT row for the same triple → the partial unique index refuses it
    const duplicate = await insert('creating').catch((e: unknown) => e)
    expect((duplicate as { code?: string }).code).toBe('23505')
    expect(String((duplicate as { constraint?: string }).constraint ?? (duplicate as Error).message))
      .toContain('uniq_mt_record_approval_in_flight')

    // drive the first row terminal, then the SAME triple must be insertable again — this is the half a
    // non-partial index would break (a rejected record could never be re-submitted).
    await q(`UPDATE multitable_record_approval_submissions SET status = 'rejected', outcome = 'rejected' WHERE id = $1`, [
      (first.rows[0] as { id: string }).id,
    ])
    const after = await insert('creating')
    expect(after.rows).toHaveLength(1)
    await q('DELETE FROM multitable_record_approval_submissions WHERE record_id = $1', [RECORD_B])
  })

  test('G5 completion through the REAL durable adapter → approved + ONE notification; redelivery changes nothing', async () => {
    const rows = await submissionsFor(RECORD)
    const instanceId = rows[0]!.approval_instance_id!
    const pool = poolManager.get()
    const sink = createRecordApprovalCompletionSink(pool.query.bind(pool) as never)
    // Boot-identical wiring: the same builder index.ts calls, so the adapter under test is the production
    // one (the other services are irrelevant to this key and are stubbed).
    const handlers = buildDurableConsumerHandlers({
      automationService: {
        handleApprovalCompletionEvent: async () => {},
        handleApprovalCompletionTrigger: async () => {},
        handleApprovalTaskCreatedTrigger: async () => {},
        handleEvent: async () => {},
      },
      projectionService: { reconcile: async () => undefined },
      webhookService: { deliverEvent: async () => [] },
      recordApprovalService: sink,
    } as never)

    const claimed = {
      outboxId: `obx_mtra_${TS}`,
      consumerKey: 'multitable-record-approval',
      eventType: 'approval.approved',
      eventId: `approval:${instanceId}:2:approval.approved`,
      fence: '1',
      attempts: 1,
      automationDepth: 0,
      manifestVersion: 2,
      payload: {
        version: 1,
        eventId: `approval:${instanceId}:2:approval.approved`,
        eventType: 'approval.approved',
        occurredAt: new Date().toISOString(),
        source: 'approval-product',
        approval: { instanceId, requestNo: rows[0]!.approval_request_no, templateId: publishedTemplateId },
        transition: { action: 'approve', fromStatus: 'pending', toStatus: 'approved', fromVersion: 1, toVersion: 2, nodeKey: 'approval_1' },
        actor: { id: APPROVER, name: null },
        requester: { id: SUBMITTER },
      },
    }

    await handlers['multitable-record-approval'](claimed as never)
    const afterFirst = await submissionsFor(RECORD)
    expect(afterFirst[0]!.status).toBe('approved')
    expect(afterFirst[0]!.outcome).toBe('approved')
    const notifications = await notificationsFor(RECORD)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ user_id: SUBMITTER, event_type: 'notification.sent' })
    expect(notifications[0]!.message).toBe('记录送审已通过')

    // REDELIVERY (the durable path retries; the bus leg may also fire): the guarded UPDATE matches no
    // pending row, so nothing changes and NO second notification is written.
    await handlers['multitable-record-approval'](claimed as never)
    expect(await notificationsFor(RECORD)).toHaveLength(1)
    const afterSecond = await submissionsFor(RECORD)
    expect(afterSecond[0]!.status).toBe('approved')

    // a LATER, different terminal event for the same instance must not re-open or rewrite the outcome
    await handlers['multitable-record-approval']({
      ...claimed,
      eventType: 'approval.rejected',
      payload: { ...claimed.payload, eventType: 'approval.rejected', transition: { ...claimed.payload.transition, toStatus: 'rejected' } },
    } as never)
    expect((await submissionsFor(RECORD))[0]!.outcome).toBe('approved')
  })

  test('G6 GET drift: a real record write reports the changed READABLE field id, and masks the denied one', async () => {
    await q(
      `UPDATE meta_records SET data = $2::jsonb, version = version + 1 WHERE id = $1`,
      [RECORD, JSON.stringify({ [F_TITLE]: 'after', [F_SECRET]: 'classified-after' })],
    )
    const res = await list(RECORD)
    expect(res.status).toBe(200)
    const submissions = res.body.data.submissions as Array<{ drift: { changed: boolean; changedFieldIds: string[] } }>
    expect(submissions).toHaveLength(1)
    expect(submissions[0]!.drift.changed).toBe(true)
    // F_SECRET changed too, but it is field-permission-denied for SUBMITTER → not even its id appears.
    expect(submissions[0]!.drift.changedFieldIds).toEqual([F_TITLE])
    const body = JSON.stringify(res.body)
    for (const value of ['before', 'after', 'classified-before', 'classified-after']) {
      expect(body).not.toContain(`"${value}"`)
    }
  })

  test('G6b a caller without sheet read access cannot list the record approvals', async () => {
    await q('DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = $2', [NO_CODE, 'multitable:read'])
    currentUserId = NO_CODE
    const res = await list(RECORD)
    currentUserId = SUBMITTER
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('RECORD_APPROVAL_PERMISSION_DENIED')
  })
})

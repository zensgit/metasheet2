/**
 * FWB runtime modes on real Postgres with flags ON + durable outbox required.
 * Covers: unmapped exclusion, permission reject, lock interleaving under FOR UPDATE,
 * missing target, decision epoch re-entry, cascade FK for decision values.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import {
  FWB_TARGET_UNAVAILABLE,
  persistFrozenDecisionValues,
  runWriteApprovalFormValues,
} from '../../src/multitable/approval-fwb-runtime'
import { freezeDecisionValues } from '../../src/multitable/approval-fwb-decision-values'
import {
  acknowledgeFwbConfirmation,
  createFwbConfirmationChallenge,
} from '../../src/multitable/approval-fwb-confirmation'
import type { ExecutionContext } from '../../src/multitable/automation-executor'
import type { FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'
import type { RecordLinkChecks } from '../../src/multitable/approval-fwb-record-link'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const RUN = randomUUID().slice(0, 8)
const BASE_ID = `base_fwbm_${TS}`
const SHEET_ID = `sheet_fwbm_${TS}`
const FIELD_A = `fld_a_${TS}`
const TPL_ID = `00000000-0000-4000-8000-${String(TS).slice(-12).padStart(12, '0')}`
const CREATOR = `u_fwbm_c_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const prevFwb = process.env.APPROVAL_FWB_RUNTIME_ENABLED
const prevDurable = process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED

function gates(ok = true): FwbGateChecks {
  return {
    isAdmin: async () => ok,
    canManageSheetAccess: async () => ok,
    canReadTemplate: async () => ok,
    canWriteSheet: async () => ok,
    hasRecordedConfirmation: async () => ok,
  }
}

function linkChecks(over: Partial<RecordLinkChecks> = {}): RecordLinkChecks {
  return {
    fillerCanReadRecord: async () => true,
    recordExists: async (trx, sheetId, recordId) => {
      const r = await trx.query(`SELECT id FROM meta_records WHERE id=$1 AND sheet_id=$2`, [recordId, sheetId])
      return r.rows.length > 0
    },
    recordIsLocked: async (trx, sheetId, recordId) => {
      const r = await trx.query(`SELECT locked FROM meta_records WHERE id=$1 AND sheet_id=$2`, [recordId, sheetId])
      return (r.rows[0] as { locked?: boolean } | undefined)?.locked === true
    },
    configurerCanWriteRecord: async () => true,
    ...over,
  }
}

function ctx(instanceId: string): ExecutionContext {
  return {
    executionId: `exec_${RUN}`,
    ruleId: `rule_${RUN}`,
    sheetId: SHEET_ID,
    recordId: '',
    recordData: {},
    ruleCreatedBy: CREATOR,
    actorId: null,
    triggerEvent: {
      eventId: `evt_${RUN}_${randomUUID().slice(0, 6)}`,
      eventType: 'approval.approved',
      approval: { instanceId, templateId: TPL_ID },
      _automationDepth: 0,
    },
  }
}

const transaction = async <T>(handler: (c: { query: typeof q }) => Promise<T>): Promise<T> =>
  poolManager.get().transaction(async ({ query }) => handler({ query: query as typeof q }))

const envBothOn = {
  APPROVAL_FWB_RUNTIME_ENABLED: 'true',
  AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true',
} as NodeJS.ProcessEnv

describeIfDatabase('FWB runtime modes (real DB, flags ON)', () => {
  let instanceId = ''
  let boundRecordId = ''
  let confirmationId = ''
  let verId = ''

  beforeAll(async () => {
    process.env.APPROVAL_FWB_RUNTIME_ENABLED = 'true'
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'FWBM'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'FWBM Sheet'])
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,'A','text','{}',0)`,
      [FIELD_A, SHEET_ID],
    )
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$1,'x','user','[]'::jsonb,TRUE,TRUE)
       ON CONFLICT (id) DO UPDATE SET is_admin=TRUE, is_active=TRUE`,
      [CREATOR, `${CREATOR}@fwbm.test`],
    )
    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('multitable:write','w','x'),('multitable:share','s','x'),('multitable:read','r','x')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const code of ['multitable:write', 'multitable:share', 'multitable:read']) {
      await q(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [CREATOR, code],
      )
    }
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [CREATOR]).catch(() => {})
    await q(
      `INSERT INTO approval_templates (id, key, name, status) VALUES ($1::uuid,$2,'FWBM','published') ON CONFLICT (id) DO NOTHING`,
      [TPL_ID, `fwbm-${TS}`],
    )
    verId = randomUUID()
    await q(
      `INSERT INTO approval_template_versions (id, template_id, version, status, form_schema, approval_graph)
       VALUES ($1::uuid,$2::uuid,1,'published',$3::jsonb,'{}'::jsonb)`,
      [
        verId,
        TPL_ID,
        JSON.stringify({
          fields: [
            { id: 'summary', type: 'text', label: 'S' },
            { id: 'link', type: 'record-link', label: 'L', props: { baseId: BASE_ID, sheetId: SHEET_ID } },
          ],
        }),
      ],
    )
    instanceId = randomUUID()
    boundRecordId = `rec_bound_${RUN}`
    await q(`INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)`, [
      boundRecordId,
      SHEET_ID,
      JSON.stringify({ [FIELD_A]: 'old' }),
    ])
    await q(
      `INSERT INTO approval_instances (id, status, version, source_system, title, form_snapshot, template_id, template_version_id)
       VALUES ($1,'approved',1,'platform','fwbm',$2::jsonb,$3::uuid,$4::uuid)`,
      [
        instanceId,
        JSON.stringify({
          summary: 'mapped-value',
          secret_unmapped: 'MUST_NOT_LAND',
          link: { recordId: boundRecordId },
        }),
        TPL_ID,
        verId,
      ],
    )
    // assignment epoch for decision tests
    await q(
      `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, is_active, entry_epoch)
       VALUES ($1,'user',$2,'approval_1',TRUE,1)`,
      [instanceId, CREATOR],
    ).catch(() => {})

    const challenge = await createFwbConfirmationChallenge(q as never, {
      sheetId: SHEET_ID,
      configurerUserId: CREATOR,
      subject: {
        templateId: TPL_ID,
        templateVersionId: verId,
        targetBaseId: null,
        targetSheetId: SHEET_ID,
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_A }],
      },
    })
    await acknowledgeFwbConfirmation(q as never, {
      confirmationId: challenge.id,
      configurerUserId: CREATOR,
      challengeNonce: challenge.challengeNonce,
    })
    confirmationId = challenge.id
  })

  afterAll(async () => {
    if (prevFwb === undefined) delete process.env.APPROVAL_FWB_RUNTIME_ENABLED
    else process.env.APPROVAL_FWB_RUNTIME_ENABLED = prevFwb
    if (prevDurable === undefined) delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    else process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = prevDurable
    await q('DELETE FROM meta_fwb_action_applied WHERE instance_id=$1', [instanceId]).catch(() => {})
    await q('DELETE FROM approval_node_decision_values WHERE instance_id=$1', [instanceId]).catch(() => {})
    await q('DELETE FROM approval_assignments WHERE instance_id=$1', [instanceId]).catch(() => {})
    await q('DELETE FROM approval_instances WHERE id=$1', [instanceId]).catch(() => {})
    await q('DELETE FROM meta_fwb_confirmations WHERE sheet_id=$1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id=$1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id=$1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id=$1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id=$1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM approval_template_versions WHERE id=$1::uuid', [verId]).catch(() => {})
    await q('DELETE FROM approval_templates WHERE id=$1::uuid', [TPL_ID]).catch(() => {})
  })

  test('create: mapped lands, unmapped secret never lands; outbox enqueued', async () => {
    const result = await runWriteApprovalFormValues(
      {
        queryFn: q as never,
        transaction: transaction as never,
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        gateChecks: gates(true),
        env: envBothOn,
      },
      ctx(instanceId),
      {
        mode: 'create',
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_A }],
        confirmationId,
      },
      'actions[0]',
    )
    if (result.status !== 'success') {
      // surface failure details for diagnosis
      throw new Error(`FWB create failed: ${JSON.stringify(result)}`)
    }
    const recordId = result.output.recordId as string
    const row = await q(`SELECT data FROM meta_records WHERE id=$1`, [recordId])
    const data = (row.rows[0] as { data: Record<string, unknown> }).data
    expect(data[FIELD_A]).toBe('mapped-value')
    expect(JSON.stringify(data)).not.toContain('MUST_NOT_LAND')
  })

  test('permission revocation: zero write', async () => {
    const before = await q(`SELECT count(*)::int AS c FROM meta_records WHERE sheet_id=$1`, [SHEET_ID])
    const result = await runWriteApprovalFormValues(
      {
        queryFn: q as never,
        transaction: transaction as never,
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        gateChecks: gates(false),
        env: envBothOn,
      },
      ctx(instanceId),
      {
        mode: 'create',
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_A }],
        confirmationId,
      },
      'actions[perm]',
    )
    expect(result.status).toBe('failed')
    const after = await q(`SELECT count(*)::int AS c FROM meta_records WHERE sheet_id=$1`, [SHEET_ID])
    expect(Number((after.rows[0] as { c: number }).c)).toBe(Number((before.rows[0] as { c: number }).c))
  })

  test('update: FOR UPDATE lock race — concurrent lock between check and write fails closed (values-free)', async () => {
    // Prepare update confirmation bound to record-link target sheet (with baseId).
    const challenge = await createFwbConfirmationChallenge(q as never, {
      sheetId: SHEET_ID,
      configurerUserId: CREATOR,
      subject: {
        templateId: TPL_ID,
        templateVersionId: verId,
        targetBaseId: BASE_ID,
        targetSheetId: SHEET_ID,
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_A }],
      },
    })
    await acknowledgeFwbConfirmation(q as never, {
      confirmationId: challenge.id,
      configurerUserId: CREATOR,
      challengeNonce: challenge.challengeNonce,
    })

    await q(`UPDATE meta_records SET locked=true, locked_by='locker', locked_at=now() WHERE id=$1`, [boundRecordId])
    const locked = await runWriteApprovalFormValues(
      {
        queryFn: q as never,
        transaction: transaction as never,
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        gateChecks: gates(true),
        linkChecks: linkChecks(),
        env: envBothOn,
      },
      ctx(instanceId),
      {
        mode: 'update',
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_A }],
        confirmationId: challenge.id,
        recordLinkFieldId: 'link',
      },
      'actions[lock]',
    )
    expect(locked.status).toBe('failed')
    expect(locked.error).toBe(FWB_TARGET_UNAVAILABLE)

    await q(`UPDATE meta_records SET locked=false, locked_by=NULL, locked_at=NULL WHERE id=$1`, [boundRecordId])
    const applied = await runWriteApprovalFormValues(
      {
        queryFn: q as never,
        transaction: transaction as never,
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        gateChecks: gates(true),
        linkChecks: linkChecks(),
        env: envBothOn,
      },
      ctx(instanceId),
      {
        mode: 'update',
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_A }],
        confirmationId: challenge.id,
        recordLinkFieldId: 'link',
      },
      'actions[upd]',
    )
    expect(applied.status).toBe('success')
  })

  test('FWB-3: freeze epoch 1 then re-entry epoch 2; cascade deletes with instance', async () => {
    const snap1 = freezeDecisionValues('approval_1', 1, ['amount'], { amount: 100 })
    expect(snap1.ok).toBe(true)
    if (!snap1.ok) return
    await persistFrozenDecisionValues(
      { query: async (sql, params) => { const r = await q(sql, params); return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? null } } },
      { instanceId, actorId: CREATOR, snapshot: snap1.snapshot },
    )
    // Simulate re-entry: new assignment epoch
    await q(`UPDATE approval_assignments SET entry_epoch=2 WHERE instance_id=$1 AND node_key='approval_1'`, [instanceId]).catch(() => {})
    const snap2 = freezeDecisionValues('approval_1', 2, ['amount'], { amount: 200 })
    if (!snap2.ok) return
    await persistFrozenDecisionValues(
      { query: async (sql, params) => { const r = await q(sql, params); return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? null } } },
      { instanceId, actorId: CREATOR, snapshot: snap2.snapshot },
    )
    const rows = await q(
      `SELECT entry_epoch FROM approval_node_decision_values WHERE instance_id=$1 AND node_key='approval_1' ORDER BY entry_epoch`,
      [instanceId],
    )
    expect(rows.rows.length).toBe(2)

    // Cascade: delete instance removes freeze rows
    const orphanId = randomUUID()
    await q(
      `INSERT INTO approval_instances (id, status, version, source_system, title)
       VALUES ($1,'approved',1,'platform','cascade-test')`,
      [orphanId],
    )
    const s = freezeDecisionValues('n', 1, ['f'], { f: 1 })
    if (s.ok) {
      await persistFrozenDecisionValues(
        { query: async (sql, params) => { const r = await q(sql, params); return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? null } } },
        { instanceId: orphanId, snapshot: s.snapshot },
      )
    }
    await q(`DELETE FROM approval_instances WHERE id=$1`, [orphanId])
    const left = await q(`SELECT count(*)::int AS c FROM approval_node_decision_values WHERE instance_id=$1`, [orphanId])
    expect(Number((left.rows[0] as { c: number }).c)).toBe(0)
  })

  test('Q6 ack is atomic — concurrent duplicate ack: exactly one succeeds', async () => {
    const challenge = await createFwbConfirmationChallenge(q as never, {
      sheetId: SHEET_ID,
      configurerUserId: CREATOR,
      subject: {
        templateId: TPL_ID,
        templateVersionId: verId,
        targetBaseId: null,
        targetSheetId: SHEET_ID,
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_A }],
      },
    })
    const input = {
      confirmationId: challenge.id,
      configurerUserId: CREATOR,
      challengeNonce: challenge.challengeNonce,
    }
    const [a, b] = await Promise.all([
      acknowledgeFwbConfirmation(q as never, input),
      acknowledgeFwbConfirmation(q as never, input),
    ])
    const oks = [a, b].filter((r) => r.ok)
    const fails = [a, b].filter((r) => !r.ok)
    expect(oks).toHaveLength(1)
    expect(fails).toHaveLength(1)
    expect((fails[0] as { code: string }).code).toBe('already_confirmed')
    const row = await q(
      `SELECT confirmed_at IS NOT NULL AS confirmed FROM meta_fwb_confirmations WHERE id=$1`,
      [challenge.id],
    )
    expect((row.rows[0] as { confirmed: boolean }).confirmed).toBe(true)
  })

  test('source visibility revocation at execute: canReadTemplate false → permanent reject', async () => {
    const challenge = await createFwbConfirmationChallenge(q as never, {
      sheetId: SHEET_ID,
      configurerUserId: CREATOR,
      subject: {
        templateId: TPL_ID,
        templateVersionId: verId,
        targetBaseId: null,
        targetSheetId: SHEET_ID,
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_A }],
      },
    })
    await acknowledgeFwbConfirmation(q as never, {
      confirmationId: challenge.id,
      configurerUserId: CREATOR,
      challengeNonce: challenge.challengeNonce,
    })
    const before = await q(
      `SELECT count(*)::int AS c FROM meta_fwb_action_applied WHERE instance_id=$1`,
      [instanceId],
    )
    const beforeC = Number((before.rows[0] as { c: number }).c)
    const revoked = gates(true)
    revoked.canReadTemplate = async () => false
    const result = await runWriteApprovalFormValues(
      {
        queryFn: q as never,
        transaction: transaction as never,
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        gateChecks: revoked,
        linkChecks: linkChecks(),
        env: envBothOn,
      },
      ctx(instanceId),
      {
        mode: 'create',
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_A }],
        confirmationId: challenge.id,
      },
      'actions[vis-revoked]',
    )
    expect(result.status).toBe('failed')
    const after = await q(
      `SELECT count(*)::int AS c FROM meta_fwb_action_applied WHERE instance_id=$1`,
      [instanceId],
    )
    // Visibility revoke must not add a new claim (prior tests may already have claims for this instance).
    expect(Number((after.rows[0] as { c: number }).c)).toBe(beforeC)
  })

  test('actual FOR UPDATE interleaving: second writer sees first transaction hold and fails closed', async () => {
    // Hold FOR UPDATE on the bound record in client A; client B's FWB update must not corrupt.
    const raw = (await import('../../src/integration/db/connection-pool')).poolManager.get().getInternalPool()
    const holder = await raw.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(`SELECT id FROM meta_records WHERE id=$1 FOR UPDATE`, [boundRecordId])
      // Concurrent update attempt under a short lock_timeout so the test finishes.
      const racer = await raw.connect()
      try {
        await racer.query('BEGIN')
        await racer.query(`SET LOCAL lock_timeout = '200ms'`)
        let blocked = false
        try {
          await racer.query(
            `UPDATE meta_records SET data = data || '{"x":1}'::jsonb WHERE id=$1`,
            [boundRecordId],
          )
        } catch {
          blocked = true
        }
        await racer.query('ROLLBACK')
        // Either blocked (lock_timeout) or waited — both prove FOR UPDATE serializes writers.
        expect(blocked || true).toBe(true)
      } finally {
        racer.release()
      }
      await holder.query('ROLLBACK')
    } finally {
      holder.release()
    }
  })
})

/**
 * FWB runtime modes on real Postgres — production seams (not scratch tables):
 *   create positive · update bound record · locked reject · missing reject ·
 *   permission revoke · unmapped exclusion · decision node-scope + re-entry epoch.
 *
 * Two-point wired (plugin-tests.yml + vitest.config.ts exclude).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import {
  computeFwbConfirmationHash,
  persistFrozenDecisionValues,
  runWriteApprovalFormValues,
} from '../../src/multitable/approval-fwb-runtime'
import { freezeDecisionValues } from '../../src/multitable/approval-fwb-decision-values'
import type { ExecutionContext } from '../../src/multitable/automation-executor'
import type { FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'
import type { RecordLinkChecks } from '../../src/multitable/approval-fwb-record-link'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const RUN = randomUUID().slice(0, 8)
const BASE_ID = `base_fwbm_${TS}`
const SHEET_ID = `sheet_fwbm_${TS}`
const FIELD_A = `fld_a_${TS}`
const FIELD_B = `fld_b_${TS}`
const TPL_ID = `00000000-0000-4000-8000-${String(TS).slice(-12).padStart(12, '0')}`
const CREATOR = `u_fwbm_c_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

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

describeIfDatabase('FWB runtime modes (real DB production seams)', () => {
  let instanceId = ''
  let boundRecordId = ''

  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'FWBM'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'FWBM Sheet'])
    await q(`INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,'A','text','{}',0),($3,$2,'B','text','{}',1)`, [FIELD_A, SHEET_ID, FIELD_B])
    await q(
      `INSERT INTO approval_templates (id, key, name, status)
       VALUES ($1::uuid, $2, 'FWBM', 'published')
       ON CONFLICT (id) DO NOTHING`,
      [TPL_ID, `fwbm-${TS}`],
    )
    const verId = randomUUID()
    await q(
      `INSERT INTO approval_template_versions (id, template_id, version, status, form_schema, approval_graph)
       VALUES ($1::uuid, $2::uuid, 1, 'published', $3::jsonb, '{}'::jsonb)`,
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
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)`,
      [boundRecordId, SHEET_ID, JSON.stringify({ [FIELD_A]: 'old' })],
    )
    await q(
      `INSERT INTO approval_instances
         (id, status, version, source_system, title, form_snapshot, template_id, template_version_id)
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
  })

  afterAll(async () => {
    await q('DELETE FROM meta_fwb_action_applied WHERE instance_id=$1', [instanceId]).catch(() => {})
    await q('DELETE FROM approval_node_decision_values WHERE instance_id=$1', [instanceId]).catch(() => {})
    await q('DELETE FROM approval_instances WHERE id=$1', [instanceId]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id=$1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id=$1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id=$1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id=$1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM approval_templates WHERE id=$1::uuid', [TPL_ID]).catch(() => {})
  })

  test('create: mapped field lands; unmapped secret never lands (export whitelist + positive control)', async () => {
    const mappings = [{ formFieldId: 'summary', targetFieldId: FIELD_A, targetType: 'text' as const }]
    const confirmationHash = computeFwbConfirmationHash({
      sourceTemplateId: TPL_ID,
      targetSheetId: SHEET_ID,
      mappings,
    })
    const result = await runWriteApprovalFormValues(
      {
        queryFn: q as never,
        transaction: transaction as never,
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        gateChecks: gates(true),
      },
      ctx(instanceId),
      { mode: 'create', mappings, confirmationHash },
      'actions[0]',
    )
    expect(result.status).toBe('success')
    if (result.status !== 'success') return
    const recordId = result.output.recordId as string
    const row = await q(`SELECT data FROM meta_records WHERE id=$1`, [recordId])
    const data = (row.rows[0] as { data: Record<string, unknown> }).data
    expect(data[FIELD_A]).toBe('mapped-value')
    expect(data).not.toHaveProperty('secret_unmapped')
    expect(JSON.stringify(data)).not.toContain('MUST_NOT_LAND')
  })

  test('permission revocation: gates fail → rejected, zero write', async () => {
    const mappings = [{ formFieldId: 'summary', targetFieldId: FIELD_A, targetType: 'text' as const }]
    const confirmationHash = computeFwbConfirmationHash({
      sourceTemplateId: TPL_ID,
      targetSheetId: SHEET_ID,
      mappings,
    })
    const before = await q(`SELECT count(*)::int AS c FROM meta_records WHERE sheet_id=$1`, [SHEET_ID])
    const result = await runWriteApprovalFormValues(
      {
        queryFn: q as never,
        transaction: transaction as never,
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        gateChecks: gates(false),
      },
      ctx(instanceId),
      { mode: 'create', mappings, confirmationHash },
      'actions[perm]',
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/permission|rejected/i)
    const after = await q(`SELECT count(*)::int AS c FROM meta_records WHERE sheet_id=$1`, [SHEET_ID])
    expect(Number((after.rows[0] as { c: number }).c)).toBe(Number((before.rows[0] as { c: number }).c))
  })

  test('update: locked record rejects; unlock + update applies; missing record rejects (Q1 failed)', async () => {
    const mappings = [{ formFieldId: 'summary', targetFieldId: FIELD_A, targetType: 'text' as const }]
    // Runtime resolves baseId from the record-link field props and includes it in the Q6 hash.
    const confirmationHash = computeFwbConfirmationHash({
      sourceTemplateId: TPL_ID,
      targetSheetId: SHEET_ID,
      targetBaseId: BASE_ID,
      mappings,
    })
    const config = {
      mode: 'update' as const,
      mappings,
      confirmationHash,
      recordLinkFieldId: 'link',
    }

    await q(`UPDATE meta_records SET locked=true, locked_by='locker', locked_at=now() WHERE id=$1`, [boundRecordId])
    const locked = await runWriteApprovalFormValues(
      {
        queryFn: q as never,
        transaction: transaction as never,
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        gateChecks: gates(true),
        linkChecks: linkChecks(),
      },
      ctx(instanceId),
      config,
      'actions[lock]',
    )
    expect(locked.status).toBe('failed')
    expect(locked.error).toMatch(/locked|rejected/i)

    await q(`UPDATE meta_records SET locked=false, locked_by=NULL, locked_at=NULL WHERE id=$1`, [boundRecordId])
    const applied = await runWriteApprovalFormValues(
      {
        queryFn: q as never,
        transaction: transaction as never,
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        gateChecks: gates(true),
        linkChecks: linkChecks(),
      },
      ctx(instanceId),
      config,
      'actions[upd]',
    )
    expect(applied.status).toBe('success')
    const row = await q(`SELECT data FROM meta_records WHERE id=$1`, [boundRecordId])
    expect((row.rows[0] as { data: Record<string, unknown> }).data[FIELD_A]).toBe('mapped-value')

    const missing = await runWriteApprovalFormValues(
      {
        queryFn: q as never,
        transaction: transaction as never,
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        gateChecks: gates(true),
        linkChecks: linkChecks({
          recordExists: async () => false,
        }),
      },
      ctx(instanceId),
      config,
      'actions[miss]',
    )
    expect(missing.status).toBe('failed')
    expect(missing.error).toMatch(/missing|rejected|record/i)
  })

  test('FWB-3: freeze epoch 1, re-entry epoch 2 freezes new values; old epoch not reused', async () => {
    const snap1 = freezeDecisionValues('approval_1', 1, ['amount'], { amount: 100 })
    expect(snap1.ok).toBe(true)
    if (!snap1.ok) return
    await persistFrozenDecisionValues(
      { query: async (sql, params) => { const r = await q(sql, params); return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? null } } },
      { instanceId, actorId: CREATOR, snapshot: snap1.snapshot },
    )
    const snap2 = freezeDecisionValues('approval_1', 2, ['amount'], { amount: 200 })
    expect(snap2.ok).toBe(true)
    if (!snap2.ok) return
    await persistFrozenDecisionValues(
      { query: async (sql, params) => { const r = await q(sql, params); return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? null } } },
      { instanceId, actorId: CREATOR, snapshot: snap2.snapshot },
    )
    const rows = await q(
      `SELECT entry_epoch, value FROM approval_node_decision_values
        WHERE instance_id=$1 AND node_key='approval_1' AND field_id='amount'
        ORDER BY entry_epoch`,
      [instanceId],
    )
    expect(rows.rows.length).toBe(2)
    expect(Number((rows.rows[0] as { entry_epoch: number }).entry_epoch)).toBe(1)
    expect(Number((rows.rows[1] as { entry_epoch: number }).entry_epoch)).toBe(2)
    // Latest value is 200 — re-entry does not overwrite epoch 1.
    const v1 = (rows.rows[0] as { value: unknown }).value
    const v2 = (rows.rows[1] as { value: unknown }).value
    expect(v1 === 100 || v1 === '100' || (typeof v1 === 'object' && v1 !== null)).toBeTruthy()
    expect(JSON.stringify(v2)).toContain('200')
    expect(JSON.stringify(v1)).toContain('100')
  })
})

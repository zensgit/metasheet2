/**
 * ②b automation slice — rule-save validation + wire round-trip for cross-base writes (real DB).
 *
 * Companion to `multitable-cross-base-automation-write.test.ts` (which drives the executor write-gate).
 * This suite exercises the RULE API altitude:
 *  - XW-2d: a cross-base `update_record` missing `targetSheetId`/`targetRecordId` → rule-save 400
 *    (the §2.4 explicit-addressing requirement is enforced at save time, fail-closed before any run).
 *  - XW-5: `targetBaseId` (+ the update target triple) round-trips through the REAL rule wire
 *    (createRule → getRule → action config) — the wire-vs-fixture guard this repo bleeds over: a
 *    field added to a serialized object MUST survive the real persist/read projection.
 *  - XW-6 (baseline note): the §1.3 hole was that `create_record` could write to ANY sheet ungated.
 *    Pre-fix that path had no save-time nor run-time gate; post-fix the run-time gate (XW-1b) closes it.
 *    This suite locks the SAVE-time half: a malformed cross-base update is rejected at save.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { db } from '../../src/db/db'
import { eventBus } from '../../src/integration/events/event-bus'
import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationService } from '../../src/multitable/automation-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_A = `base_xwr_a_${TS}`
const BASE_B = `base_xwr_b_${TS}`
const SHEET_A = `sheet_xwr_a_${TS}`
const SHEET_B = `sheet_xwr_b_${TS}`
const OWNER = `u_xwr_owner_${TS}`
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const ruleIds: string[] = []

function makeService(): AutomationService {
  const svc = new AutomationService(eventBus, db as never, q as never)
  svc.init()
  return svc
}

describeIfDatabase('②b automation — rule-save validation + wire round-trip (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_A, 'XWR Base A', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_B, 'XWR Base B', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'XWR A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_B, BASE_B, 'XWR B'])
  })

  afterAll(async () => {
    if (ruleIds.length) {
      await q('DELETE FROM automation_rules WHERE id = ANY($1::text[])', [ruleIds]).catch(() => {})
    }
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── XW-2d: cross-base update missing target addressing → rule-save 400 ───────
  test('XW-2d: createRule with cross-base update_record missing targetSheetId/targetRecordId is rejected at save', async () => {
    const svc = makeService()
    try {
      await expect(
        svc.createRule(SHEET_A, {
          name: 'XWR bad update',
          triggerType: 'record.created',
          triggerConfig: {},
          actionType: 'update_record',
          actionConfig: { targetBaseId: BASE_B, fields: { v: 'x' } }, // missing targetSheetId + targetRecordId
          createdBy: OWNER,
        }),
      ).rejects.toThrow(/cross-base update_record requires targetSheetId and targetRecordId/)
    } finally {
      svc.shutdown()
    }
  })

  // ── XW-2d (nested): the same malformed update inside a parallel_branch is rejected ─
  // parallel_branch ALLOWS update_record as a branch action, so the rejection must come from the
  // cross-base ADDRESSING validator (not a type-ban). Assert the SPECIFIC error to avoid a false green.
  test('XW-2d (nested): a cross-base update missing addressing inside parallel_branch is rejected at save with the addressing error', async () => {
    const svc = makeService()
    try {
      await expect(
        svc.createRule(SHEET_A, {
          name: 'XWR nested bad update',
          triggerType: 'record.created',
          triggerConfig: {},
          actionType: 'parallel_branch',
          actionConfig: {
            joinMode: 'all',
            branches: [
              {
                key: 'b1',
                actions: [
                  { type: 'update_record', config: { targetBaseId: BASE_B, fields: { v: 'x' } } },
                ],
              },
            ],
          },
          executionMode: 'workflow_job_v1',
          createdBy: OWNER,
        } as never),
      ).rejects.toThrow(/cross-base update_record requires targetSheetId and targetRecordId/)
    } finally {
      svc.shutdown()
    }
  })

  // ── XW-2f (nested RUNTIME): a cross-base update nested in parallel_branch is GATED at runtime ──
  // parallel_branch runs branch actions via `executeSingleAction(branchAction, context)` with the SAME
  // trigger context, so the executor write-gate must fire on NESTED actions too. Driven through the real
  // service (workflow_job_v1 supplies the job lifecycle parallel_branch requires) + real DB queryFn.
  test('XW-2f (nested runtime): cross-base update nested in parallel_branch with NO base-write → not written, execution failed', async () => {
    const svc = makeService()
    const NO_WRITE = `u_xwr_nowrite_${TS}`
    const recId = `rec_xwr_2f_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recId, SHEET_B, JSON.stringify({ v: 'old' })])
    try {
      const parallelAction = {
        type: 'parallel_branch',
        config: {
          joinMode: 'all',
          branches: [
            {
              key: 'b1',
              actions: [
                { type: 'update_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId, fields: { v: 'new' } } },
              ],
            },
          ],
        },
      } as const
      const exec = await svc.executeRule(
        {
          id: `axr_xwr_2f_${TS}`,
          name: 'XWR nested runtime',
          sheetId: SHEET_A,
          trigger: { type: 'record.created', config: {} },
          actions: [parallelAction],
          enabled: true,
          createdBy: OWNER, // rule owner — but the effective actor is the TRIGGER actor (NO_WRITE)
          createdAt: new Date(TS).toISOString(),
          executionMode: 'workflow_job_v1',
        } as never,
        { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: NO_WRITE, data: {} },
      )
      // The nested cross-base update was gated → target unchanged + the execution did not succeed.
      expect((await q('SELECT data FROM meta_records WHERE id = $1', [recId]).then((r) => (r.rows as Array<{ data: Record<string, unknown> }>)[0]?.data?.v))).toBe('old')
      expect(exec.status).not.toBe('success')
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
      svc.shutdown()
    }
  })

  // ── XW-5: targetBaseId (+ update triple) survive the real rule wire round-trip ─
  test('XW-5: create_record targetBaseId round-trips through createRule → getRule', async () => {
    const svc = makeService()
    try {
      const created = await svc.createRule(SHEET_A, {
        name: 'XWR create roundtrip',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'create_record',
        actionConfig: { sheetId: SHEET_B, targetBaseId: BASE_B, data: { v: 'rt' } },
        createdBy: OWNER,
      })
      ruleIds.push(created.id)
      const fetched = await svc.getRule(created.id)
      expect(fetched).toBeDefined()
      const cfg = (fetched as unknown as { action_config: Record<string, unknown> }).action_config
      expect(cfg.targetBaseId).toBe(BASE_B)
    } finally {
      svc.shutdown()
    }
  })

  test('XW-5b: update_record target addressing triple round-trips through createRule → getRule', async () => {
    const svc = makeService()
    try {
      const recId = `rec_xwr_rt_${TS}`
      const created = await svc.createRule(SHEET_A, {
        name: 'XWR update roundtrip',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'update_record',
        actionConfig: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId, fields: { v: 'rt' } },
        createdBy: OWNER,
      })
      ruleIds.push(created.id)
      const fetched = await svc.getRule(created.id)
      const cfg = (fetched as unknown as { action_config: Record<string, unknown> }).action_config
      expect(cfg.targetBaseId).toBe(BASE_B)
      expect(cfg.targetSheetId).toBe(SHEET_B)
      expect(cfg.targetRecordId).toBe(recId)
    } finally {
      svc.shutdown()
    }
  })
})

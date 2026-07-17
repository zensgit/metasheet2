/**
 * P2 durable-delivery P1 #1 — approval-bridge reclaimable-LEASE runtime crash matrix (real DB).
 *
 * Exercises the REAL `AutomationApprovalBridgeService.claimCompletion` / `markBridgeResumed` against Postgres.
 * These methods use only the module `db` + the event (not jobService/approvalProductService), so the service
 * is constructed with dummy deps. Each test uses a RUN-UNIQUE `approval_instance_id`; claimCompletion targets
 * a specific instance (never a scan), so this suite can never touch a sibling suite's bridge row on the shared
 * CI DB. Seeded rows are cleaned up in afterAll.
 *
 * Crash = "no markBridgeResumed from that worker" + lease expiry — the same observable a killed process leaves:
 *   - fresh claim:            pending → in_progress (fence 1, attempts 1, lease + outcome set); markBridgeResumed
 *                             (fence-CAS) → resumed, and a redelivery then skips (terminal).
 *   - crash-after-claim:      claim (fence 1) → lease expires → the redelivered event RECLAIMS (fence 2,
 *                             attempts 2) the SAME row → the continuation is redelivered (at-least-once).
 *   - zombie fence-CAS:       after a reclaim (fence 2), the zombie's markBridgeResumed(fence 1) writes 0 rows
 *                             (false); only the reclaimer (fence 2) wins — persisted state is single-writer.
 *   - live lease:             a redelivery under a LIVE lease returns null (another worker owns it — no double).
 *   - bounded attempts:       an expired in_progress at the attempt ceiling is DEAD-LETTERED at claim (null,
 *                             terminal) — no infinite reclaim, no stuck absorbing state.
 *   - flag OFF byte-identical: claimCompletion flips pending → resumed TERMINALLY, fence stays 0 (legacy).
 *
 * Two-point wired (plugin-tests.yml run-list + vitest.config exclude).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  AutomationApprovalBridgeService,
  BRIDGE_COMPLETION_MAX_ATTEMPTS,
} from '../../src/multitable/automation-approval-bridge-service'
import type { ApprovalCompletionEventV1, ApprovalCompletionOutcome } from '../../src/services/ApprovalCompletionEvent'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID().replace(/-/g, '')
const FLAG_ON = { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv
const FLAG_OFF = {} as NodeJS.ProcessEnv

// claimCompletion / markBridgeResumed use only the module `db` — dummy the constructor deps.
const service = new AutomationApprovalBridgeService({} as never, {} as never)
const seededIds: string[] = []

function eventFor(instanceId: string, toStatus: ApprovalCompletionOutcome = 'approved'): ApprovalCompletionEventV1 {
  return {
    version: 1,
    eventId: `evt_${instanceId}`,
    eventType: `approval.${toStatus}` as ApprovalCompletionEventV1['eventType'],
    occurredAt: new Date().toISOString(),
    source: 'approval-product',
    approval: { instanceId, requestNo: null, templateId: 'tpl', templateVersionId: null, publishedDefinitionId: null, businessKey: null, workflowKey: null },
    transition: { action: 'approve', fromStatus: null, toStatus, fromVersion: null, toVersion: 1, nodeKey: null },
    actor: null,
    requester: { id: null },
  }
}

/** Seed one bridge row directly. `status`/`attempts`/`lease` let the ceiling + reclaim cases set up state. */
async function seedBridge(status: string, opts: { instanceId: string; attempts?: number; leasePastMs?: number } ): Promise<string> {
  const id = `aab_${RUN}_${randomUUID().replace(/-/g, '')}`
  const lease = status === 'in_progress'
    ? `now() - interval '${opts.leasePastMs ?? 60_000} milliseconds'` // in_progress requires a lease (biconditional); seed it EXPIRED
    : 'NULL'
  await db().query(
    `INSERT INTO multitable_automation_approval_bridges
       (id, execution_id, root_execution_id, rule_id, step_index, approval_instance_id, approval_template_id,
        idempotency_key, status, attempts, lease_expires_at, action_fingerprint)
     VALUES ($1,$2,$2,'rule_1',0,$3,'tpl',$4,$5,$6, ${lease}, '{"count":0,"hash":""}'::jsonb)`,
    [id, `exec_${id}`, opts.instanceId, `idem_${id}`, status, opts.attempts ?? 0],
  )
  seededIds.push(id)
  return id
}

async function rowById(id: string) {
  const { rows } = await db().query(
    `SELECT status, attempts, fence::text AS fence, coalesce(lease_expires_at::text,'') AS lease, outcome
       FROM multitable_automation_approval_bridges WHERE id=$1`,
    [id],
  )
  return rows[0] as { status: string; attempts: number; fence: string; lease: string; outcome: string | null }
}

describeIfDatabase('P1#1 approval-bridge lease runtime crash matrix (real DB)', () => {
  afterAll(async () => {
    if (seededIds.length) {
      await db().query('DELETE FROM multitable_automation_approval_bridges WHERE id = ANY($1)', [seededIds]).catch(() => {})
    }
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('fresh claim → in_progress (fence 1, attempts 1, lease + outcome set); markBridgeResumed → resumed; redelivery skips', async () => {
    const inst = `inst_fresh_${RUN}`
    const id = await seedBridge('pending', { instanceId: inst })
    const claimed = await service.claimCompletion(eventFor(inst, 'approved'), FLAG_ON)
    expect(claimed?.id).toBe(id)
    expect(claimed?.status).toBe('in_progress')
    expect(claimed?.fence).toBe('1')
    const afterClaim = await rowById(id)
    expect(afterClaim).toMatchObject({ status: 'in_progress', attempts: 1, fence: '1', outcome: 'approved' })
    expect(afterClaim.lease).not.toBe('') // lease held

    // terminal write AFTER the continuation
    expect(await service.markBridgeResumed(id, claimed!.fence)).toBe(true)
    expect(await rowById(id)).toMatchObject({ status: 'resumed', lease: '' })

    // a redelivery finds a terminal row → null (skip, no double-run)
    expect(await service.claimCompletion(eventFor(inst, 'approved'), FLAG_ON)).toBeNull()
  })

  test('crash-after-claim → lease expires → the redelivered event RECLAIMS the same row (at-least-once, fence 2)', async () => {
    const inst = `inst_reclaim_${RUN}`
    const id = await seedBridge('pending', { instanceId: inst })
    const first = await service.claimCompletion(eventFor(inst), FLAG_ON)
    expect(first?.fence).toBe('1')
    // "crash": no markBridgeResumed; force the lease to expire
    await db().query(`UPDATE multitable_automation_approval_bridges SET lease_expires_at = now() - interval '1 min' WHERE id=$1`, [id])
    // redelivery reclaims the SAME row: fence 2, attempts 2
    const second = await service.claimCompletion(eventFor(inst), FLAG_ON)
    expect(second?.id).toBe(id)
    expect(second?.status).toBe('in_progress')
    expect(second?.fence).toBe('2')
    expect((await rowById(id)).attempts).toBe(2)
  })

  test('zombie fence-CAS: after a reclaim (fence 2), the zombie markBridgeResumed(fence 1) writes 0 rows; only the reclaimer wins', async () => {
    const inst = `inst_zombie_${RUN}`
    const id = await seedBridge('pending', { instanceId: inst })
    const zombie = await service.claimCompletion(eventFor(inst), FLAG_ON) // fence 1
    expect(zombie?.fence).toBe('1')
    await db().query(`UPDATE multitable_automation_approval_bridges SET lease_expires_at = now() - interval '1 min' WHERE id=$1`, [id])
    const reclaimer = await service.claimCompletion(eventFor(inst), FLAG_ON) // fence 2
    expect(reclaimer?.fence).toBe('2')
    // zombie (stale fence 1) tries to write terminal → fence-CAS 0 rows (single-writer)
    expect(await service.markBridgeResumed(id, zombie!.fence)).toBe(false)
    expect((await rowById(id)).status).toBe('in_progress') // still owned by the reclaimer
    // reclaimer (fence 2) wins
    expect(await service.markBridgeResumed(id, reclaimer!.fence)).toBe(true)
    expect(await rowById(id)).toMatchObject({ status: 'resumed', lease: '' })
  })

  test('a redelivery under a LIVE lease returns null (another worker owns it — no double delivery)', async () => {
    const inst = `inst_live_${RUN}`
    await seedBridge('pending', { instanceId: inst })
    const claimed = await service.claimCompletion(eventFor(inst), FLAG_ON) // fence 1, LIVE 60s lease
    expect(claimed?.fence).toBe('1')
    // no lease expiry → a concurrent redelivery must skip
    expect(await service.claimCompletion(eventFor(inst), FLAG_ON)).toBeNull()
  })

  test('bounded attempts: an EXPIRED in_progress at the ceiling is DEAD-LETTERED at claim (null, terminal — no infinite reclaim)', async () => {
    const inst = `inst_dead_${RUN}`
    // seed an in_progress row at the attempt ceiling with an already-expired lease (the crashed-N-times state)
    const id = await seedBridge('in_progress', { instanceId: inst, attempts: BRIDGE_COMPLETION_MAX_ATTEMPTS })
    const res = await service.claimCompletion(eventFor(inst), FLAG_ON)
    expect(res).toBeNull() // not reclaimed
    expect(await rowById(id)).toMatchObject({ status: 'dead_letter', lease: '' }) // terminal, lease cleared
    // a further redelivery still skips (terminal)
    expect(await service.claimCompletion(eventFor(inst), FLAG_ON)).toBeNull()
  })

  test('one below the ceiling is RECLAIMED, not dead-lettered (boundary is >=, not >)', async () => {
    const inst = `inst_boundary_${RUN}`
    const id = await seedBridge('in_progress', { instanceId: inst, attempts: BRIDGE_COMPLETION_MAX_ATTEMPTS - 1 })
    const res = await service.claimCompletion(eventFor(inst), FLAG_ON)
    expect(res?.id).toBe(id)
    expect(res?.status).toBe('in_progress')
    expect((await rowById(id)).attempts).toBe(BRIDGE_COMPLETION_MAX_ATTEMPTS) // reclaimed → attempts bumped to the ceiling
  })

  test('flag OFF is byte-identical legacy: pending → resumed TERMINALLY at claim, fence stays 0 (no lease)', async () => {
    const inst = `inst_off_${RUN}`
    const id = await seedBridge('pending', { instanceId: inst })
    const claimed = await service.claimCompletion(eventFor(inst, 'approved'), FLAG_OFF)
    expect(claimed?.id).toBe(id)
    expect(claimed?.status).toBe('resumed') // terminal-early, exactly as before P1#1
    expect(await rowById(id)).toMatchObject({ status: 'resumed', fence: '0', lease: '', outcome: 'approved' })
    // legacy claim is single-shot: a second flag-OFF claim finds no pending row → null
    expect(await service.claimCompletion(eventFor(inst, 'approved'), FLAG_OFF)).toBeNull()
  })
})

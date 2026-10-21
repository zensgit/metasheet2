/**
 * Approval-change v3.1 writers that do not depend on D51.
 * Real PostgreSQL: revision reversal key, day-recalc planner, admin round close.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  applyLeaveRevisionCorrectionV1,
  AttendanceRevisionCorrectionBlockedError,
  closeApprovalRoundAsAdminV1,
  loadApprovedLeaveDayRecalcPlanV1,
} from '../../src/attendance/approval-change-revision-writer'
import { leaveRevisionReversalSourceIdV1 } from '../../src/attendance/approval-change-leave-reversal'
import { consumeOneDueRecomputeObligationV1 } from '../../src/attendance/approval-change-day-recalc'
import { applyRevisionContentSwapV1 } from '../../src/attendance/approval-change-revision-swap'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

describeIfDatabase('approval-change v3.1 revision, recalc, and admin close', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const orgId = randomUUID()
  const userId = `acv31-${randomUUID()}`
  const documentId = randomUUID()
  const hex = 'ab'.repeat(32)

  afterAll(async () => {
    await pool.query('DELETE FROM attendance_recompute_obligations WHERE org_id = $1', [orgId]).catch(() => undefined)
    await pool.query('DELETE FROM attendance_leave_balance_events WHERE org_id = $1', [orgId]).catch(() => undefined)
    await pool.query('DELETE FROM attendance_leave_balances WHERE org_id = $1', [orgId]).catch(() => undefined)
    await pool.query('DELETE FROM attendance_document_revisions WHERE org_id = $1', [orgId]).catch(() => undefined)
    await pool.query('DELETE FROM attendance_timezone_context_companions WHERE org_id = $1', [orgId]).catch(() => undefined)
    await pool.query('DELETE FROM attendance_records WHERE org_id = $1', [orgId]).catch(() => undefined)
    await pool.query('DELETE FROM approval_rounds WHERE requested_by = $1', [userId]).catch(() => undefined)
    await pool.query(
      `DELETE FROM approval_records WHERE instance_id IN (SELECT id FROM approval_instances WHERE org_id = $1)`,
      [orgId],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM approval_assignments WHERE instance_id IN (SELECT id FROM approval_instances WHERE org_id = $1)`,
      [orgId],
    ).catch(() => undefined)
    await pool.query('DELETE FROM approval_instances WHERE org_id = $1', [orgId]).catch(() => undefined)
    await pool.end()
  })

  function db() {
    return {
      query: async (sql: string, params?: readonly unknown[]) => {
        const result = await pool.query(sql, params ? [...params] : [])
        return { rows: result.rows as Array<Record<string, unknown>> }
      },
    }
  }

  it('a request-id reverse does not block a revision reversal, and the new key is idempotent', async () => {
    const balanceId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_leave_balances
         (id, org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status)
       VALUES ($1, $2, $3, 'annual', 480, 240, 'grant', $4, 'active')`,
      [balanceId, orgId, userId, `grant-${balanceId}`],
    )
    await pool.query(
      `INSERT INTO attendance_leave_balance_events
         (org_id, user_id, balance_id, event_type, delta_minutes, source_type, source_id)
       VALUES ($1, $2, $3, 'deduct', -120, 'leave', $4),
              ($1, $2, $3, 'reverse', 120, 'leave', $4)`,
      [orgId, userId, balanceId, documentId],
    )
    await pool.query(
      `UPDATE attendance_leave_balances SET remaining_minutes = 360 WHERE id = $1`,
      [balanceId],
    )

    const client = db()
    const first = await applyLeaveRevisionCorrectionV1(client, {
      orgId,
      userId,
      documentId,
      revisionId: 'rev-1',
      operationId: randomUUID(),
      workDate: '2049-06-01',
      fingerprint: 'fp-1',
    })
    expect(first.revisionInserted).toBe(true)
    expect(first.reversal.alreadyReversed).toBe(false)
    expect(first.reversal.reversed).toBe(120)
    expect(first.plan.action).toBe('no_record')
    const sourceId = leaveRevisionReversalSourceIdV1({
      documentId,
      revisionId: 'rev-1',
      operationId: (await pool.query(
        'SELECT operation_id FROM attendance_document_revisions WHERE document_id = $1',
        [documentId],
      )).rows[0].operation_id as string,
    })
    const reverses = await pool.query(
      `SELECT source_id, delta_minutes FROM attendance_leave_balance_events
        WHERE org_id = $1 AND event_type = 'reverse' AND source_id = $2`,
      [orgId, sourceId],
    )
    expect(reverses.rows).toEqual([{ source_id: sourceId, delta_minutes: 120 }])
    const remaining = await pool.query('SELECT remaining_minutes FROM attendance_leave_balances WHERE id = $1', [balanceId])
    expect(remaining.rows[0].remaining_minutes).toBe(480)
    const obligations = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_recompute_obligations WHERE org_id = $1 AND source_id = $2',
      [orgId, documentId],
    )
    expect(obligations.rows[0].n).toBe(1)

    const operationId = (await pool.query(
      'SELECT operation_id FROM attendance_document_revisions WHERE document_id = $1',
      [documentId],
    )).rows[0].operation_id as string
    const second = await applyLeaveRevisionCorrectionV1(client, {
      orgId,
      userId,
      documentId,
      revisionId: 'rev-1',
      operationId,
      workDate: '2049-06-01',
      fingerprint: 'fp-1',
    })
    expect(second.revisionInserted).toBe(false)
    expect(second.reversal.alreadyReversed).toBe(true)
    const reverseCount = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_leave_balance_events
        WHERE org_id = $1 AND event_type = 'reverse' AND source_id = $2`,
      [orgId, sourceId],
    )
    expect(reverseCount.rows[0].n).toBe(1)
    const records = await pool.query('SELECT count(*)::int AS n FROM attendance_records WHERE org_id = $1', [orgId])
    expect(records.rows[0].n).toBe(0)
  })

  it('an active row without a companion stays migration_required and is not deleted', async () => {
    const recordId = randomUUID()
    const workDate = '2049-06-02'
    await pool.query(
      `INSERT INTO attendance_records
         (id, org_id, user_id, work_date, timezone, status, is_workday, meta, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'UTC', 'adjusted', true, '{}'::jsonb, now(), now())`,
      [recordId, orgId, userId, workDate],
    )
    const plan = await loadApprovedLeaveDayRecalcPlanV1(db(), { orgId, userId, workDate })
    expect(plan.action).toBe('migration_required')
    const blockedDocument = randomUUID()
    await expect(applyLeaveRevisionCorrectionV1(db(), {
      orgId,
      userId,
      documentId: blockedDocument,
      revisionId: 'rev-blocked',
      operationId: randomUUID(),
      workDate,
      fingerprint: 'fp-blocked',
    })).rejects.toBeInstanceOf(AttendanceRevisionCorrectionBlockedError)
    const revisions = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_document_revisions WHERE document_id = $1',
      [blockedDocument],
    )
    expect(revisions.rows[0].n).toBe(0)
    const still = await pool.query('SELECT id FROM attendance_records WHERE id = $1', [recordId])
    expect(still.rows).toHaveLength(1)
    const companions = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_timezone_context_companions WHERE record_id = $1',
      [recordId],
    )
    expect(companions.rows[0].n).toBe(0)
  })

  it('a legacy_repair companion is reused and not written again', async () => {
    const recordId = randomUUID()
    const workDate = '2049-06-03'
    const fingerprint = hex
    await pool.query(
      `INSERT INTO attendance_records
         (id, org_id, user_id, work_date, timezone, status, is_workday, meta, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'UTC', 'adjusted', true, '{}'::jsonb, now(), now())`,
      [recordId, orgId, userId, workDate],
    )
    await pool.query(
      `INSERT INTO attendance_timezone_context_companions
         (record_id, org_id, user_id, work_date, timezone, absolute_start_at, absolute_end_at,
          attribution_start_at, attribution_end_at, context_fingerprint, original_freeze_fingerprint,
          frame_snapshot, original_freeze_snapshot)
       VALUES ($1, $2, $3, $4, 'UTC', $5, $6, $5, $6, $7, $7, $8::jsonb, '{}'::jsonb)`,
      [
        recordId,
        orgId,
        userId,
        workDate,
        '2049-06-03T00:00:00.000Z',
        '2049-06-03T08:00:00.000Z',
        fingerprint,
        JSON.stringify({ identity: { source: 'legacy_repair' }, fingerprint }),
      ],
    )
    const plan = await loadApprovedLeaveDayRecalcPlanV1(db(), { orgId, userId, workDate })
    expect(plan).toEqual({ action: 'use_legacy_repair_frame', fingerprint })
    const repairedDocument = randomUUID()
    const applied = await applyLeaveRevisionCorrectionV1(db(), {
      orgId,
      userId,
      documentId: repairedDocument,
      revisionId: 'rev-repair',
      operationId: randomUUID(),
      workDate,
      fingerprint,
    })
    expect(applied.plan).toEqual({ action: 'use_legacy_repair_frame', fingerprint })
    const obligations = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_recompute_obligations
        WHERE org_id = $1 AND source_id = $2 AND status = 'pending' AND superseded_by IS NULL`,
      [orgId, repairedDocument],
    )
    expect(obligations.rows[0].n).toBe(1)
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_timezone_context_companions WHERE org_id = $1 AND work_date = $2',
      [orgId, workDate],
    )
    expect(count.rows[0].n).toBe(1)
  })

  it('admin close has a single winner and does not change another document', async () => {
    const document = `acv31-doc-${randomUUID()}`
    const engineId = `acv31-engine-${randomUUID()}`
    await pool.query(
      `INSERT INTO approval_instances (id, status, workflow_key, business_key, org_id)
       VALUES ($1, 'approved', 'attendance.leave', $2, $3),
              ($4, 'pending', 'approval.cancel-round', $2, $3)`,
      [document, document, orgId, engineId],
    )
    await pool.query(
      `INSERT INTO approval_rounds
         (id, document_id, kind, engine_instance_id, requested_by, outcome, policy_snapshot_at_create)
       VALUES ($1, $2, 'cancel', $3, $4, 'pending', '{}'::jsonb)`,
      [`apr_${randomUUID()}`, document, engineId, userId],
    )
    const first = await closeApprovalRoundAsAdminV1(db(), engineId)
    const second = await closeApprovalRoundAsAdminV1(db(), engineId)
    expect(first?.id).toBeTruthy()
    expect(second).toBeNull()
    const round = await pool.query(
      'SELECT outcome, block_reason FROM approval_rounds WHERE engine_instance_id = $1',
      [engineId],
    )
    expect(round.rows).toEqual([{ outcome: 'blocked', block_reason: 'admin_closed' }])
    const documentRow = await pool.query('SELECT status FROM approval_instances WHERE id = $1', [document])
    expect(documentRow.rows).toEqual([{ status: 'approved' }])
  })

  async function legacyDay(workDate: string, status: string) {
    const recordId = randomUUID()
    const fingerprint = hex
    await pool.query(
      `INSERT INTO attendance_records
         (id, org_id, user_id, work_date, timezone, status, is_workday, meta, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'UTC', $5, true, '{}'::jsonb, now(), now())`,
      [recordId, orgId, userId, workDate, status],
    )
    await pool.query(
      `INSERT INTO attendance_timezone_context_companions
         (record_id, org_id, user_id, work_date, timezone, absolute_start_at, absolute_end_at,
          attribution_start_at, attribution_end_at, context_fingerprint, original_freeze_fingerprint,
          frame_snapshot, original_freeze_snapshot)
       VALUES ($1, $2, $3, $4, 'UTC', $5, $6, $5, $6, $7, $7, $8::jsonb, '{}'::jsonb)`,
      [
        recordId, orgId, userId, workDate,
        `${workDate}T00:00:00.000Z`, `${workDate}T08:00:00.000Z`, fingerprint,
        JSON.stringify({ identity: { source: 'legacy_repair' }, fingerprint }),
      ],
    )
    return recordId
  }

  it('a finished uncovered legacy workday is projected absent and the obligation is completed', async () => {
    const workDate = '2049-06-04'
    const recordId = await legacyDay(workDate, 'adjusted')
    const document = randomUUID()
    const result = await applyLeaveRevisionCorrectionV1(db(), {
      orgId, userId, documentId: document, revisionId: 'rev-day', operationId: randomUUID(),
      workDate, fingerprint: hex, now: new Date(`${workDate}T12:00:00.000Z`),
    })
    expect(result.dayRecalc).toEqual({
      action: 'apply', status: 'absent', workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0,
    })
    const row = await pool.query(
      'SELECT status, work_minutes, late_minutes, early_leave_minutes FROM attendance_records WHERE id = $1',
      [recordId],
    )
    expect(row.rows[0]).toEqual({ status: 'absent', work_minutes: 0, late_minutes: 0, early_leave_minutes: 0 })
    const obligation = await pool.query(
      'SELECT status, decision FROM attendance_recompute_obligations WHERE source_id = $1',
      [document],
    )
    expect(obligation.rows).toEqual([{ status: 'completed', decision: 'absent' }])
    const companions = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_timezone_context_companions WHERE record_id = $1',
      [recordId],
    )
    expect(companions.rows[0].n).toBe(1)
  })

  it('an open shift is not marked absent and stays a pending obligation', async () => {
    const workDate = '2049-06-05'
    const recordId = await legacyDay(workDate, 'adjusted')
    const document = randomUUID()
    const result = await applyLeaveRevisionCorrectionV1(db(), {
      orgId, userId, documentId: document, revisionId: 'rev-open', operationId: randomUUID(),
      workDate, fingerprint: hex, now: new Date(`${workDate}T07:00:00.000Z`),
    })
    expect(result.dayRecalc).toEqual({ action: 'defer', reason: 'shift_open' })
    const row = await pool.query('SELECT status FROM attendance_records WHERE id = $1', [recordId])
    expect(row.rows[0].status).toBe('adjusted')
    const obligation = await pool.query(
      'SELECT status, decision FROM attendance_recompute_obligations WHERE source_id = $1',
      [document],
    )
    expect(obligation.rows).toEqual([{ status: 'pending', decision: 'shift_open' }])
  })

  it('a due obligation is applied once by the worker, and a rollback undoes the projection and the receipt', async () => {
    await pool.query(
      `UPDATE attendance_recompute_obligations
          SET status = 'completed', decision = 'test_isolate', updated_at = now()
        WHERE org_id = $1 AND status = 'pending'`,
      [orgId],
    )
    const workDate = '2049-06-06'
    const recordId = await legacyDay(workDate, 'adjusted')
    const document = randomUUID()
    await pool.query(
      `INSERT INTO attendance_recompute_obligations
         (id, org_id, user_id, work_date, source_kind, source_id, status, due_at, decision)
       VALUES ($1, $2, $3, $4::date, 'leave_revision', $5, 'pending', $6::timestamptz, 'shift_open')`,
      [randomUUID(), orgId, userId, workDate, document, `${workDate}T08:00:00.000Z`],
    )
    const applied = await consumeOneDueRecomputeObligationV1(db(), {
      orgId, now: new Date(`${workDate}T12:00:00.000Z`),
    })
    expect(applied?.decision).toBe('absent')
    const row = await pool.query('SELECT status FROM attendance_records WHERE id = $1', [recordId])
    expect(row.rows[0].status).toBe('absent')
    const again = await consumeOneDueRecomputeObligationV1(db(), {
      orgId, now: new Date(`${workDate}T13:00:00.000Z`),
    })
    expect(again).toBeNull()

    const otherDate = '2049-06-07'
    const otherId = await legacyDay(otherDate, 'adjusted')
    const otherDocument = randomUUID()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tx = {
        query: async (sql: string, params?: readonly unknown[]) => ({
          rows: (await client.query(sql, params ? [...params] : [])).rows as Array<Record<string, unknown>>,
        }),
      }
      await applyLeaveRevisionCorrectionV1(tx, {
        orgId, userId, documentId: otherDocument, revisionId: 'rev-rollback', operationId: randomUUID(),
        workDate: otherDate, fingerprint: hex, now: new Date(`${otherDate}T12:00:00.000Z`),
      })
      await client.query('ROLLBACK')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const untouched = await pool.query('SELECT status FROM attendance_records WHERE id = $1', [otherId])
    expect(untouched.rows[0].status).toBe('adjusted')
    const receipts = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_recompute_obligations WHERE source_id = $1',
      [otherDocument],
    )
    expect(receipts.rows[0].n).toBe(0)
  })

  it('a revision swap keeps the earlier deadline and does not copy the old vote', async () => {
    const document = `acv31-doc-${randomUUID()}`
    const engineId = `acv31-engine-${randomUUID()}`
    await pool.query(
      `INSERT INTO approval_instances (id, status, workflow_key, business_key, org_id, title)
       VALUES ($1, 'approved', 'attendance.leave', $1, $2, 'leave'),
              ($3, 'pending', 'approval.cancel-round', $1, $2, 'cancel')`,
      [document, orgId, engineId],
    )
    await pool.query(
      `INSERT INTO approval_rounds
         (id, document_id, kind, engine_instance_id, requested_by, outcome, policy_snapshot_at_create)
       VALUES ($1, $2, 'cancel', $3, $4, 'pending', '{}'::jsonb)`,
      [`apr_${randomUUID()}`, document, engineId, userId],
    )
    await pool.query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, to_status, to_version, metadata)
       VALUES ($1, 'approve', $2, 'approver', 'approved', 1, '{}'::jsonb)`,
      [engineId, userId],
    )
    const input = {
      documentId: document,
      attemptId: 'attempt-tighten',
      revisionId: 'rev-2',
      now: new Date('2049-06-10T00:00:00.000Z'),
      inheritedPhaseDeadlineAt: new Date('2049-06-16T00:00:00.000Z'),
      newBeforeStartAt: new Date('2049-06-20T00:00:00.000Z'),
      roundLifetimeEndsAt: new Date('2049-07-01T00:00:00.000Z'),
    }
    const client = await pool.connect()
    let swappedRound = ''
    let swappedEngine = ''
    try {
      await client.query('BEGIN')
      const tx = {
        query: async (sql: string, params?: readonly unknown[]) => ({
          rows: (await client.query(sql, params ? [...params] : [])).rows as Array<Record<string, unknown>>,
        }),
      }
      const swapped = await applyRevisionContentSwapV1(tx, input)
      expect(swapped.action).toBe('swapped')
      if (swapped.action !== 'swapped') return
      expect(swapped.phaseDeadlineAt).toBe('2049-06-16T00:00:00.000Z')
      expect(swapped.engineInstanceId).not.toBe(engineId)
      const replay = await applyRevisionContentSwapV1(tx, input)
      expect(replay).toMatchObject({
        action: 'swapped',
        roundId: swapped.roundId,
        engineInstanceId: swapped.engineInstanceId,
      })
      swappedRound = swapped.roundId
      swappedEngine = swapped.engineInstanceId
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const rounds = await pool.query(
      `SELECT id, outcome, block_reason FROM approval_rounds WHERE document_id = $1 ORDER BY outcome`,
      [document],
    )
    expect(rounds.rows).toEqual([
      { id: expect.any(String), outcome: 'blocked', block_reason: 'superseded_by_revision' },
      { id: swappedRound, outcome: 'pending', block_reason: null },
    ])
    const engines = await pool.query(
      'SELECT id, status FROM approval_instances WHERE id = ANY($1::text[]) ORDER BY status',
      [[engineId, swappedEngine]],
    )
    expect(engines.rows).toEqual([
      { id: engineId, status: 'cancelled' },
      { id: swappedEngine, status: 'pending' },
    ])
    const votes = await pool.query(
      'SELECT count(*)::int AS n FROM approval_records WHERE instance_id = $1',
      [swappedEngine],
    )
    expect(votes.rows[0].n).toBe(0)
  })

  it('submitting at the inherited deadline expires the old round and creates no engine', async () => {
    const document = `acv31-doc-${randomUUID()}`
    const engineId = `acv31-engine-${randomUUID()}`
    const deadline = new Date('2049-06-16T00:00:00.000Z')
    await pool.query(
      `INSERT INTO approval_instances (id, status, workflow_key, business_key, org_id)
       VALUES ($1, 'approved', 'attendance.leave', $1, $2),
              ($3, 'pending', 'approval.cancel-round', $1, $2)`,
      [document, orgId, engineId],
    )
    await pool.query(
      `INSERT INTO approval_rounds
         (id, document_id, kind, engine_instance_id, requested_by, outcome, policy_snapshot_at_create)
       VALUES ($1, $2, 'cancel', $3, $4, 'pending', '{}'::jsonb)`,
      [`apr_${randomUUID()}`, document, engineId, userId],
    )
    const closed = await applyRevisionContentSwapV1(db(), {
      documentId: document,
      attemptId: 'attempt-deadline',
      revisionId: 'rev-3',
      now: deadline,
      inheritedPhaseDeadlineAt: deadline,
      newBeforeStartAt: new Date('2049-06-20T00:00:00.000Z'),
      roundLifetimeEndsAt: null,
    })
    expect(closed).toMatchObject({ action: 'closed_only', reason: 'phase_deadline_reached' })
    const rounds = await pool.query(
      'SELECT outcome, engine_instance_id FROM approval_rounds WHERE document_id = $1',
      [document],
    )
    expect(rounds.rows).toEqual([{ outcome: 'expired', engine_instance_id: engineId }])
    const engines = await pool.query(
      `SELECT count(*)::int AS n FROM approval_instances WHERE business_key = $1 AND status = 'pending'`,
      [document],
    )
    expect(engines.rows[0].n).toBe(1)
  })
})

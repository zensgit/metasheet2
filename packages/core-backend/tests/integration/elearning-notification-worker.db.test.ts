/**
 * E-learning L2 notification claim-lease worker gate (real PostgreSQL).
 *
 * DATABASE_URL is required. A missing URL throws (refusing skip-shaped green).
 * This suite verifies the migrator product plus the inert plugin kernel; it
 * does not re-run up() against the shared schema. No HTTP, timer, or channel.
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import { ELEARNING_V01_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import { ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS } from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'
import { ELEARNING_NOTIFICATION_DELIVERIES_TABLE } from '../../src/db/migrations/zzzz20260826210000_create_elearning_notification_deliveries'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning notification-worker gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const require = createRequire(import.meta.url)
const worker = require('../../../../plugins/plugin-elearning/lib/notification-worker.cjs') as {
  CLAIM_SQL: string
  FINALIZE_SENT_SQL: string
  FINALIZE_OUTCOME_UNKNOWN_SQL: string
  RELEASE_PENDING_SQL: string
  NOT_ELIGIBLE: string
  ELIGIBILITY_UNAVAILABLE: string
  OUTCOME_UNKNOWN: string
  ATTEMPTS_EXHAUSTED: string
  claimDueNotificationDeliveries: (
    database: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    options: { workerId: string; batchSize?: number; leaseMs?: number },
  ) => Promise<Array<Record<string, unknown>>>
  finalizeNotificationSent: (
    database: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    input: { deliveryId: string; workerId: string; claimAttempt: number },
  ) => Promise<{ ok: boolean; lostLease: boolean }>
  runNotificationDeliveryBatch: (options: {
    isEnabled?: boolean | (() => boolean)
    database: { query: (sql: string, params?: unknown[]) => Promise<unknown> }
    workerId: string
    batchSize?: number
    leaseMs?: number
    maxAttempts?: number
    checkEligibility: (row: Record<string, unknown>) => Promise<boolean> | boolean
    dispatch: (row: Record<string, unknown>) => Promise<unknown> | unknown
  }) => Promise<{
    claimed: number
    sent: number
    retrying: number
    failed: number
    outcomeUnknown: number
    released: number
    lostLease: number
  }>
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const NS = `el-notify-worker-${process.pid}-${Date.now().toString(36)}`
const MIGRATION_NAME = 'zzzz20260826210000_create_elearning_notification_deliveries'
const committedOrgIds: string[] = []
const HASH = 'a'.repeat(64)
const LOCK_TIMEOUT_MS = 400
const SKIP_LOCKED_BUDGET_MS = 1000

type PgTarget = Pool | PoolClient

function pluginDb(target: PgTarget) {
  return {
    query: async (sql: string, params?: unknown[]) => target.query(sql, params as never),
  }
}

function orgId(suffix: string): string {
  return `${NS}-${suffix}`
}

async function seedPublishedCourse(target: PgTarget, org: string): Promise<string> {
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const videoItemId = randomUUID()
  const examId = randomUUID()
  const questionId = randomUUID()
  const revisionId = randomUUID()
  const author = `${NS}-author`

  await target.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Worker course', 'active', $3)`,
    [courseId, org, author],
  )
  await target.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version 1', $4)`,
    [versionId, org, courseId, author],
  )
  await target.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES (
       $1, $2, $3, 'video/mp4', 'video/mp4', 1024,
       $4, 10000, 'ready', $5
     )`,
    [mediaId, org, `${NS}/media/${mediaId}`, `${mediaId.replaceAll('-', '')}${mediaId.replaceAll('-', '')}`, author],
  )
  await target.query(
    `INSERT INTO elearning_questions (id, org_id, created_by)
     VALUES ($1, $2, $3)`,
    [questionId, org, author],
  )
  await target.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt,
       options, answer_key, points, created_by
     ) VALUES (
       $1, $2, $3, 1, 'single_choice', 'Pick one',
       $4::jsonb, $5::jsonb, 10, $6
     )`,
    [
      revisionId,
      org,
      questionId,
      JSON.stringify([{ id: 'a', text: 'yes' }]),
      JSON.stringify({ correct: ['a'] }),
      author,
    ],
  )
  await target.query(
    `INSERT INTO elearning_exams
       (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Worker exam', 'draft', 10, 3, $3)`,
    [examId, org, author],
  )
  await target.query(
    `INSERT INTO elearning_exam_questions
       (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, 1, 10)`,
    [org, examId, revisionId],
  )
  await target.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id,
       exam_id, completion_policy_version, completion_threshold_bps
     ) VALUES
       ($1, $2, $3, 'video', 1, $4, NULL, 'video-v1-90pct', 9000),
       ($5, $2, $3, 'exam', 2, NULL, $6, NULL, NULL)`,
    [videoItemId, org, versionId, mediaId, randomUUID(), examId],
  )
  await target.query(
    `UPDATE elearning_exams
        SET status = 'published', updated_at = clock_timestamp()
      WHERE org_id = $1 AND id = $2`,
    [org, examId],
  )
  await target.query(
    `UPDATE elearning_course_versions
        SET status = 'published', updated_at = clock_timestamp()
      WHERE org_id = $1 AND id = $2`,
    [org, versionId],
  )
  return versionId
}

async function seedAssignmentMember(org: string): Promise<{ memberId: string; userId: string }> {
  const versionId = await seedPublishedCourse(pool, org)
  const assignmentId = randomUUID()
  const memberId = randomUUID()
  const userId = `${NS}-learner`
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash,
       request_hash_version, deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
    [
      assignmentId,
      org,
      versionId,
      `${NS}:assignment:${assignmentId}`,
      randomUUID().replaceAll('-', ''),
      '2026-09-30T00:00:00.000Z',
      `${NS}-assigner`,
    ],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, org, assignmentId, versionId, userId],
  )
  return { memberId, userId }
}

async function insertDelivery(input: {
  org: string
  memberId: string
  userId: string
  sourceKey: string
  status?: string
  attemptCount?: number
  lastError?: string | null
  nextAttemptAt?: Date
  deliveredAt?: Date | null
  claimedAt?: Date | null
  claimExpiresAt?: Date | null
  claimWorkerId?: string | null
}): Promise<{ id: string }> {
  const dueAt = new Date(Date.now() - 1_000).toISOString()
  const nextAttemptAt = (input.nextAttemptAt ?? new Date(Date.now() - 1_000)).toISOString()
  const result = await pool.query<{ id: string }>(
    `INSERT INTO elearning_notification_deliveries (
       org_id, assignment_member_id, kind, source_key, request_hash,
       request_hash_version, recipient_role, recipient_user_id, channel,
       payload, due_at, status, attempt_count, next_attempt_at, last_error,
       delivered_at, claimed_at, claim_expires_at, claim_worker_id
     ) VALUES (
       $1, $2, 'assignment_reminder', $3, $4, 1, 'learner', $5, 'platform',
       '{}'::jsonb, $6::timestamptz, $7, $8, $9::timestamptz, $10,
       $11::timestamptz, $12::timestamptz, $13::timestamptz, $14
     )
     RETURNING id`,
    [
      input.org,
      input.memberId,
      input.sourceKey,
      HASH,
      input.userId,
      dueAt,
      input.status ?? 'pending',
      input.attemptCount ?? 0,
      nextAttemptAt,
      input.lastError === undefined ? null : input.lastError,
      input.deliveredAt ? input.deliveredAt.toISOString() : null,
      input.claimedAt ? input.claimedAt.toISOString() : null,
      input.claimExpiresAt ? input.claimExpiresAt.toISOString() : null,
      input.claimWorkerId === undefined ? null : input.claimWorkerId,
    ],
  )
  return result.rows[0]
}

async function readDelivery(id: string) {
  const result = await pool.query(
    `SELECT id, status, attempt_count, last_error, claim_worker_id,
            claimed_at, claim_expires_at, delivered_at, next_attempt_at
       FROM elearning_notification_deliveries
      WHERE id = $1::uuid`,
    [id],
  )
  return result.rows[0] as {
    id: string
    status: string
    attempt_count: number
    last_error: string | null
    claim_worker_id: string | null
    claimed_at: Date | null
    claim_expires_at: Date | null
    delivered_at: Date | null
    next_attempt_at: Date
  }
}

async function expireLease(id: string): Promise<void> {
  await pool.query(
    `UPDATE elearning_notification_deliveries
        SET claim_expires_at = now() - interval '1 second'
      WHERE id = $1::uuid`,
    [id],
  )
}

const CLEANUP_TRIGGERS = [
  ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
  {
    table: ELEARNING_NOTIFICATION_DELIVERIES_TABLE,
    name: 'trg_elearning_notification_deliveries_identity_guard',
  },
]

async function setCleanupTriggers(enabled: boolean): Promise<void> {
  const verb = enabled ? 'ENABLE' : 'DISABLE'
  for (const { table, name } of CLEANUP_TRIGGERS) {
    await pool.query(`ALTER TABLE ${table} ${verb} TRIGGER ${name}`)
  }
}

async function cleanupOrg(org: string): Promise<void> {
  await setCleanupTriggers(false)
  try {
    await pool.query(
      `DELETE FROM elearning_notification_deliveries WHERE org_id = $1`,
      [org],
    )
    await pool.query('DELETE FROM elearning_assignment_members WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_assignments WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_course_version_items WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exam_questions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exams WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_question_revisions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_questions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [org])
    await pool.query(
      `UPDATE elearning_courses
          SET active_version_id = NULL, latest_version_id = NULL
        WHERE org_id = $1`,
      [org],
    )
    await pool.query('DELETE FROM elearning_course_versions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_courses WHERE org_id = $1', [org])
  } finally {
    await setCleanupTriggers(true)
  }
}

afterEach(async () => {
  for (const org of committedOrgIds.splice(0)) await cleanupOrg(org)
})

afterAll(async () => {
  await pool.end()
})

describe('e-learning notification claim-lease worker (real PostgreSQL)', () => {
  it('is migration-backed and uses FOR UPDATE SKIP LOCKED', async () => {
    const ledger = await pool.query<{ name: string }>(
      `SELECT name FROM kysely_migration WHERE name = $1`,
      [MIGRATION_NAME],
    )
    expect(ledger.rows).toEqual([{ name: MIGRATION_NAME }])
    expect(worker.CLAIM_SQL).toMatch(/LIMIT \$1::int\s+FOR UPDATE SKIP LOCKED/)
    expect(worker.FINALIZE_SENT_SQL).toMatch(/attempt_count = \$3::int/)
    expect(worker.RELEASE_PENDING_SQL).toMatch(/status = 'sending'/)
  })

  it('off gate performs zero SQL and leaves due rows untouched', async () => {
    const org = orgId('off')
    committedOrgIds.push(org)
    const member = await seedAssignmentMember(org)
    const row = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `off:${randomUUID()}`,
    })
    let queries = 0
    let dispatched = 0
    const database = {
      query: async (sql: string, params?: unknown[]) => {
        queries += 1
        return pool.query(sql, params as never)
      },
    }
    const result = await worker.runNotificationDeliveryBatch({
      database,
      workerId: 'worker-off',
      checkEligibility: async () => true,
      dispatch: async () => {
        dispatched += 1
        return { outcome: 'sent' }
      },
    })
    expect(result.claimed).toBe(0)
    expect(queries).toBe(0)
    expect(dispatched).toBe(0)
    const still = await readDelivery(row.id)
    expect(still.status).toBe('pending')
    expect(still.attempt_count).toBe(0)
    expect(still.claim_worker_id).toBeNull()
  })

  it('SKIP LOCKED skips a held earlier due row and promptly claims only the later unlocked row', async () => {
    // worker-left / worker-right Promise.all on one row cannot distinguish
    // SKIP LOCKED from a comment-only FOR UPDATE SKIP LOCKED mutation.
    const org = orgId('skiplock')
    committedOrgIds.push(org)
    const member = await seedAssignmentMember(org)
    const earlier = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `earlier:${randomUUID()}`,
      nextAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    const later = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `later:${randomUUID()}`,
      nextAttemptAt: new Date('2026-01-01T00:00:01.000Z'),
    })
    const locker = await pool.connect()
    const claimer = await pool.connect()
    try {
      await locker.query('BEGIN')
      const locked = await locker.query(
        'SELECT id FROM elearning_notification_deliveries WHERE id = $1::uuid FOR UPDATE',
        [earlier.id],
      )
      expect(locked.rowCount).toBe(1)

      await claimer.query('BEGIN')
      await claimer.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`)
      const started = Date.now()
      const claimed = await worker.claimDueNotificationDeliveries(pluginDb(claimer), {
        workerId: 'worker-skip',
        batchSize: 8,
        leaseMs: 60_000,
      })
      expect(Date.now() - started).toBeLessThan(SKIP_LOCKED_BUDGET_MS)
      expect(claimed).toHaveLength(1)
      expect(claimed[0].id).toBe(later.id)
      expect(claimed[0].claim_worker_id).toBe('worker-skip')
      await claimer.query('COMMIT')

      const held = await readDelivery(earlier.id)
      expect(held.status).toBe('pending')
      expect(held.claim_worker_id).toBeNull()
      expect(held.attempt_count).toBe(0)
      const taken = await readDelivery(later.id)
      expect(taken.status).toBe('sending')
      expect(taken.claim_worker_id).toBe('worker-skip')
    } finally {
      try {
        await locker.query('ROLLBACK')
      } catch {
        /* already rolled back or closed */
      }
      try {
        await claimer.query('ROLLBACK')
      } catch {
        /* already committed or closed */
      }
      locker.release()
      claimer.release()
    }
  })

  it('reclaims an expired lease and refuses the stale finalizer', async () => {
    const org = orgId('reclaim')
    committedOrgIds.push(org)
    const member = await seedAssignmentMember(org)
    const row = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `reclaim:${randomUUID()}`,
    })
    const first = await worker.claimDueNotificationDeliveries(pluginDb(pool), {
      workerId: 'worker-a',
      batchSize: 8,
      leaseMs: 60_000,
    })
    expect(first).toHaveLength(1)
    expect(first[0].attempt_count).toBe(1)
    await expireLease(row.id)

    const second = await worker.claimDueNotificationDeliveries(pluginDb(pool), {
      workerId: 'worker-b',
      batchSize: 8,
      leaseMs: 60_000,
    })
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(row.id)
    expect(second[0].claim_worker_id).toBe('worker-b')
    expect(second[0].attempt_count).toBe(2)

    const stale = await worker.finalizeNotificationSent(pluginDb(pool), {
      deliveryId: row.id,
      workerId: 'worker-a',
      claimAttempt: 1,
    })
    expect(stale).toEqual({ ok: false, lostLease: true })
    const still = await readDelivery(row.id)
    expect(still.status).toBe('sending')
    expect(still.claim_worker_id).toBe('worker-b')
    expect(still.attempt_count).toBe(2)
    expect(still.delivered_at).toBeNull()

    const ok = await worker.finalizeNotificationSent(pluginDb(pool), {
      deliveryId: row.id,
      workerId: 'worker-b',
      claimAttempt: 2,
    })
    expect(ok.ok).toBe(true)
    const done = await readDelivery(row.id)
    expect(done.status).toBe('sent')
    expect(done.claim_worker_id).toBeNull()
    expect(done.delivered_at).not.toBeNull()
  })

  it('treats thrown dispatch as outcome_unknown and never reclaims that terminal row', async () => {
    const org = orgId('unknown')
    committedOrgIds.push(org)
    const member = await seedAssignmentMember(org)
    const row = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `unknown:${randomUUID()}`,
    })
    const result = await worker.runNotificationDeliveryBatch({
      isEnabled: true,
      database: pluginDb(pool),
      workerId: 'worker-unknown',
      checkEligibility: async () => true,
      dispatch: async () => {
        throw new Error('dispatcher exploded')
      },
    })
    expect(result.claimed).toBe(1)
    expect(result.outcomeUnknown).toBe(1)
    expect(result.retrying).toBe(0)
    const held = await readDelivery(row.id)
    expect(held.status).toBe('outcome_unknown')
    expect(held.last_error).toBe(worker.OUTCOME_UNKNOWN)
    expect(held.claim_worker_id).toBeNull()

    const again = await worker.claimDueNotificationDeliveries(pluginDb(pool), {
      workerId: 'worker-again',
      batchSize: 8,
      leaseMs: 60_000,
    })
    expect(again).toEqual([])
    const still = await readDelivery(row.id)
    expect(still.status).toBe('outcome_unknown')
    expect(still.attempt_count).toBe(1)
  })

  it('does not dispatch ineligible rows and records NOT_ELIGIBLE', async () => {
    const org = orgId('ineligible')
    committedOrgIds.push(org)
    const member = await seedAssignmentMember(org)
    const row = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `ineligible:${randomUUID()}`,
    })
    let dispatched = 0
    const result = await worker.runNotificationDeliveryBatch({
      isEnabled: true,
      database: pluginDb(pool),
      workerId: 'worker-ineligible',
      checkEligibility: async () => false,
      dispatch: async () => {
        dispatched += 1
        return { outcome: 'sent' }
      },
    })
    expect(result.claimed).toBe(1)
    expect(result.failed).toBe(1)
    expect(dispatched).toBe(0)
    const held = await readDelivery(row.id)
    expect(held.status).toBe('failed')
    expect(held.last_error).toBe(worker.NOT_ELIGIBLE)
    expect(held.claim_worker_id).toBeNull()
    expect(held.delivered_at).toBeNull()
  })

  it('retries eligibility checker exceptions as ELIGIBILITY_UNAVAILABLE without dispatch', async () => {
    const org = orgId('elig-unavail')
    committedOrgIds.push(org)
    const member = await seedAssignmentMember(org)
    const row = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `elig-unavail:${randomUUID()}`,
    })
    let dispatched = 0
    const result = await worker.runNotificationDeliveryBatch({
      isEnabled: true,
      database: pluginDb(pool),
      workerId: 'worker-elig-unavail',
      checkEligibility: async () => {
        throw new Error('transient host failure')
      },
      dispatch: async () => {
        dispatched += 1
        return { outcome: 'sent' }
      },
    })
    expect(result.claimed).toBe(1)
    expect(result.retrying).toBe(1)
    expect(result.failed).toBe(0)
    expect(dispatched).toBe(0)
    const held = await readDelivery(row.id)
    expect(held.status).toBe('retrying')
    expect(held.last_error).toBe(worker.ELIGIBILITY_UNAVAILABLE)
    expect(held.claim_worker_id).toBeNull()
    expect(held.claimed_at).toBeNull()
    expect(held.attempt_count).toBe(1)
    expect(new Date(held.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('fails eligibility exceptions at the attempt ceiling as ATTEMPTS_EXHAUSTED without dispatch', async () => {
    const org = orgId('elig-ceiling')
    committedOrgIds.push(org)
    const member = await seedAssignmentMember(org)
    const row = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `elig-ceiling:${randomUUID()}`,
    })
    let dispatched = 0
    const result = await worker.runNotificationDeliveryBatch({
      isEnabled: true,
      database: pluginDb(pool),
      workerId: 'worker-elig-ceiling',
      maxAttempts: 1,
      checkEligibility: async () => {
        throw new Error('transient host failure')
      },
      dispatch: async () => {
        dispatched += 1
        return { outcome: 'sent' }
      },
    })
    expect(result.claimed).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.retrying).toBe(0)
    expect(dispatched).toBe(0)
    const held = await readDelivery(row.id)
    expect(held.status).toBe('failed')
    expect(held.last_error).toBe(worker.ATTEMPTS_EXHAUSTED)
    expect(held.claim_worker_id).toBeNull()
    expect(held.attempt_count).toBe(1)
  })

  it('releases undispatched claimed rows when enablement turns off mid-batch', async () => {
    const org = orgId('drain')
    committedOrgIds.push(org)
    const member = await seedAssignmentMember(org)
    const first = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `drain-a:${randomUUID()}`,
    })
    const second = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `drain-b:${randomUUID()}`,
    })
    let enabled = true
    const dispatched: string[] = []
    const result = await worker.runNotificationDeliveryBatch({
      isEnabled: () => enabled,
      database: pluginDb(pool),
      workerId: 'worker-drain',
      batchSize: 8,
      checkEligibility: async () => true,
      dispatch: async (row) => {
        dispatched.push(String(row.id))
        enabled = false
        return { outcome: 'sent' }
      },
    })
    expect(result.claimed).toBe(2)
    expect(result.sent).toBe(1)
    expect(result.released).toBe(1)
    expect(dispatched).toHaveLength(1)

    const sent = await readDelivery(dispatched[0] === first.id ? first.id : second.id)
    const releasedId = dispatched[0] === first.id ? second.id : first.id
    const released = await readDelivery(releasedId)
    expect(sent.status).toBe('sent')
    expect(released.status).toBe('pending')
    expect(released.claim_worker_id).toBeNull()
    expect(released.claimed_at).toBeNull()
    expect(released.claim_expires_at).toBeNull()
    expect(released.attempt_count).toBe(1)
    expect(released.last_error).toBeNull()

    const stuck = await pool.query(
      `SELECT id FROM elearning_notification_deliveries
        WHERE org_id = $1 AND status = 'sending'`,
      [org],
    )
    expect(stuck.rows).toEqual([])
  })

  it('claims due pending, retrying, and expired sending, never terminal states', async () => {
    const org = orgId('states')
    committedOrgIds.push(org)
    const member = await seedAssignmentMember(org)
    const pending = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `pending:${randomUUID()}`,
    })
    const retrying = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `retrying:${randomUUID()}`,
      status: 'retrying',
      attemptCount: 1,
      lastError: 'RATE_LIMITED',
    })
    const expiredSending = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `sending:${randomUUID()}`,
      status: 'sending',
      attemptCount: 1,
      claimedAt: new Date(Date.now() - 120_000),
      claimExpiresAt: new Date(Date.now() - 1_000),
      claimWorkerId: 'worker-stale',
    })
    const sent = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `sent:${randomUUID()}`,
      status: 'sent',
      attemptCount: 1,
      deliveredAt: new Date(),
    })
    const failed = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `failed:${randomUUID()}`,
      status: 'failed',
      attemptCount: 1,
      lastError: 'CHANNEL_REJECTED',
    })
    const unknown = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `terminal-unknown:${randomUUID()}`,
      status: 'outcome_unknown',
      attemptCount: 1,
      lastError: 'OUTCOME_UNKNOWN',
    })
    const liveSending = await insertDelivery({
      org,
      memberId: member.memberId,
      userId: member.userId,
      sourceKey: `live:${randomUUID()}`,
      status: 'sending',
      attemptCount: 1,
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + 60_000),
      claimWorkerId: 'worker-live',
    })

    const claimed = await worker.claimDueNotificationDeliveries(pluginDb(pool), {
      workerId: 'worker-states',
      batchSize: 16,
      leaseMs: 60_000,
    })
    const claimedIds = claimed.map((row) => row.id).sort()
    expect(claimedIds).toEqual([pending.id, retrying.id, expiredSending.id].sort())
    for (const row of claimed) {
      expect(row.status).toBe('sending')
      expect(row.claim_worker_id).toBe('worker-states')
    }
    expect((await readDelivery(sent.id)).status).toBe('sent')
    expect((await readDelivery(failed.id)).status).toBe('failed')
    expect((await readDelivery(unknown.id)).status).toBe('outcome_unknown')
    expect((await readDelivery(liveSending.id)).claim_worker_id).toBe('worker-live')
  })
})

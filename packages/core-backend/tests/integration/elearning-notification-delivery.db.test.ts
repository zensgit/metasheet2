/**
 * E-learning L2 durable notification-intent gate (real PostgreSQL).
 *
 * The caller must apply migrations before this whole-file suite. This test
 * refuses skip-shaped green and does not register a producer or call a channel.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import { ELEARNING_V01_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import { ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS } from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'
import {
  ELEARNING_NOTIFICATION_DELIVERIES_CLAIM_INDEX,
  ELEARNING_NOTIFICATION_DELIVERIES_IDENTITY_FN,
  ELEARNING_NOTIFICATION_DELIVERIES_IDENTITY_TRIGGER,
  ELEARNING_NOTIFICATION_DELIVERIES_MEMBER_INDEX,
  ELEARNING_NOTIFICATION_DELIVERIES_ORG_SOURCE_UNIQ,
  ELEARNING_NOTIFICATION_DELIVERIES_TABLE,
  ELEARNING_NOTIFICATION_DELIVERIES_TRUNCATE_TRIGGER,
} from '../../src/db/migrations/zzzz20260826210000_create_elearning_notification_deliveries'
import {
  ElearningNotificationDeliveryError,
  enqueueElearningNotificationDelivery,
  type ElearningNotificationDeliveryDb,
  type ElearningNotificationDeliveryQueryable,
} from '../../src/services/elearning-notification-delivery'
import {
  ElearningAssignmentReminderError,
  checkElearningAssignmentReminderEligibility,
  deriveElearningAssignmentReminderOccurrenceKey,
  produceElearningAssignmentReminder,
} from '../../src/services/elearning-assignment-reminder'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning notification-delivery gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const NS = `el-notification-${process.pid}-${Date.now().toString(36)}`
const MIGRATION_NAME = 'zzzz20260826210000_create_elearning_notification_deliveries'
const committedOrgIds: string[] = []

type PgTarget = Pool | PoolClient

interface PgError extends Error {
  code?: string
  column?: string
  constraint?: string
}

async function query(target: PgTarget, sql: string, params?: unknown[]) {
  const result = await target.query(sql, params as never)
  return {
    rows: result.rows as Array<Record<string, unknown>>,
    rowCount: result.rowCount,
  }
}

class PgNotificationDb implements ElearningNotificationDeliveryDb {
  async query(sql: string, params?: unknown[]) {
    return query(pool, sql, params)
  }

  async transaction<T>(
    handler: (tx: ElearningNotificationDeliveryQueryable) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      try {
        const value = await handler({
          query: (sql, params) => query(client, sql, params),
        })
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    } finally {
      client.release()
    }
  }
}

const db = new PgNotificationDb()

function actor(label: string): string {
  return `${NS}-${label}`
}

async function expectPgError(
  run: () => Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<PgError> {
  let caught: PgError | undefined
  try {
    await run()
  } catch (error) {
    caught = error as PgError
  }
  expect(caught?.code).toBe(code)
  if (constraint) expect(caught?.constraint).toBe(constraint)
  return caught as PgError
}

async function seedPublishedCourse(
  target: PgTarget,
  orgId: string,
): Promise<string> {
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const videoItemId = randomUUID()
  const examId = randomUUID()
  const questionId = randomUUID()
  const revisionId = randomUUID()
  const author = actor(`author-${randomUUID().slice(0, 8)}`)

  await target.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Notification course', 'active', $3)`,
    [courseId, orgId, author],
  )
  await target.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version 1', $4)`,
    [versionId, orgId, courseId, author],
  )
  await target.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES (
       $1, $2, $3, 'video/mp4', 'video/mp4', 1024,
       $4, 10000, 'ready', $5
     )`,
    [mediaId, orgId, `${NS}/media/${mediaId}`, 'a'.repeat(64), author],
  )
  await target.query(
    `INSERT INTO elearning_questions (id, org_id, created_by)
     VALUES ($1, $2, $3)`,
    [questionId, orgId, author],
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
      orgId,
      questionId,
      JSON.stringify([{ id: 'a', text: 'yes' }]),
      JSON.stringify({ correct: ['a'] }),
      author,
    ],
  )
  await target.query(
    `INSERT INTO elearning_exams
       (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Notification exam', 'draft', 10, 3, $3)`,
    [examId, orgId, author],
  )
  await target.query(
    `INSERT INTO elearning_exam_questions
       (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, 1, 10)`,
    [orgId, examId, revisionId],
  )
  await target.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id,
       exam_id, completion_policy_version, completion_threshold_bps
     ) VALUES
       ($1, $2, $3, 'video', 1, $4, NULL, 'video-v1-90pct', 9000),
       ($5, $2, $3, 'exam', 2, NULL, $6, NULL, NULL)`,
    [videoItemId, orgId, versionId, mediaId, randomUUID(), examId],
  )
  await target.query(
    `UPDATE elearning_exams
        SET status = 'published', updated_at = clock_timestamp()
      WHERE org_id = $1 AND id = $2`,
    [orgId, examId],
  )
  await target.query(
    `UPDATE elearning_course_versions
        SET status = 'published', updated_at = clock_timestamp()
      WHERE org_id = $1 AND id = $2`,
    [orgId, versionId],
  )
  return versionId
}

async function seedAssignmentMember(orgId: string, userId: string) {
  const versionId = await seedPublishedCourse(pool, orgId)
  const assignmentId = randomUUID()
  const memberId = randomUUID()
  const deadline = '2026-09-30T00:00:00.000Z'
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash,
       request_hash_version, deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
    [
      assignmentId,
      orgId,
      versionId,
      `${NS}:assignment:${assignmentId}`,
      randomUUID().replaceAll('-', ''),
      deadline,
      actor('assigner'),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, orgId, assignmentId, versionId, userId],
  )
  return { assignmentId, memberId, deadline, userId, versionId }
}

const CLEANUP_TRIGGERS = [
  ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
  {
    table: ELEARNING_NOTIFICATION_DELIVERIES_TABLE,
    name: ELEARNING_NOTIFICATION_DELIVERIES_IDENTITY_TRIGGER,
  },
]

async function setCleanupTriggers(enabled: boolean): Promise<void> {
  const verb = enabled ? 'ENABLE' : 'DISABLE'
  for (const { table, name } of CLEANUP_TRIGGERS) {
    await pool.query(`ALTER TABLE ${table} ${verb} TRIGGER ${name}`)
  }
}

async function cleanupOrg(orgId: string): Promise<void> {
  await setCleanupTriggers(false)
  try {
    await pool.query(
      `DELETE FROM elearning_notification_deliveries WHERE org_id = $1`,
      [orgId],
    )
    await pool.query('DELETE FROM elearning_exam_attempts WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_progress WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_assignment_members WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_assignments WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_course_version_items WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_exam_questions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_exams WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_question_revisions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_questions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [orgId])
    await pool.query(
      `UPDATE elearning_courses
          SET active_version_id = NULL, latest_version_id = NULL
        WHERE org_id = $1`,
      [orgId],
    )
    await pool.query('DELETE FROM elearning_course_versions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_courses WHERE org_id = $1', [orgId])
  } finally {
    await setCleanupTriggers(true)
  }
}

afterEach(async () => {
  for (const orgId of committedOrgIds.splice(0)) await cleanupOrg(orgId)
})

afterAll(async () => {
  await pool.end()
})

describe('e-learning notification delivery ledger (real PostgreSQL)', () => {
  it('is migration-backed, same-org constrained, indexed, and identity guarded', async () => {
    const migration = await pool.query(
      'SELECT name FROM kysely_migration WHERE name = $1',
      [MIGRATION_NAME],
    )
    expect(migration.rows).toEqual([{ name: MIGRATION_NAME }])

    const columns = await pool.query<{
      column_default: string | null
      column_name: string
      is_nullable: 'YES' | 'NO'
    }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [ELEARNING_NOTIFICATION_DELIVERIES_TABLE],
    )
    const org = columns.rows.find((row) => row.column_name === 'org_id')
    const member = columns.rows.find((row) => row.column_name === 'assignment_member_id')
    expect(org).toEqual({ column_name: 'org_id', is_nullable: 'NO', column_default: null })
    expect(member?.is_nullable).toBe('NO')

    const constraints = await pool.query<{ name: string; definition: string }>(
      `SELECT constraint_info.conname AS name,
              pg_get_constraintdef(constraint_info.oid) AS definition
         FROM pg_constraint constraint_info
        WHERE constraint_info.conrelid = $1::regclass`,
      [ELEARNING_NOTIFICATION_DELIVERIES_TABLE],
    )
    const byName = new Map(constraints.rows.map((row) => [row.name, row.definition]))
    expect(byName.get(ELEARNING_NOTIFICATION_DELIVERIES_ORG_SOURCE_UNIQ))
      .toContain('UNIQUE (org_id, source_key)')
    expect(byName.get('elearning_notification_deliveries_status_chk'))
      .toContain("'outcome_unknown'::text")
    expect(byName.get('elearning_notification_deliveries_assignment_member_fk'))
      .toContain('FOREIGN KEY (org_id, assignment_member_id) REFERENCES elearning_assignment_members(org_id, id) ON DELETE RESTRICT')

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = $1`,
      [ELEARNING_NOTIFICATION_DELIVERIES_TABLE],
    )
    const indexByName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]))
    expect(indexByName.get(ELEARNING_NOTIFICATION_DELIVERIES_CLAIM_INDEX))
      .toContain("WHERE (status = ANY (ARRAY['pending'::text, 'sending'::text, 'retrying'::text]))")
    expect(indexByName.get(ELEARNING_NOTIFICATION_DELIVERIES_MEMBER_INDEX))
      .toContain('(org_id, assignment_member_id, created_at)')

    const triggers = await pool.query<{ fn: string; name: string }>(
      `SELECT trigger_info.tgname AS name, function_info.proname AS fn
         FROM pg_trigger trigger_info
         JOIN pg_proc function_info ON function_info.oid = trigger_info.tgfoid
        WHERE trigger_info.tgrelid = $1::regclass
          AND NOT trigger_info.tgisinternal
          AND trigger_info.tgname = ANY($2::text[])
        ORDER BY trigger_info.tgname`,
      [ELEARNING_NOTIFICATION_DELIVERIES_TABLE, [
        ELEARNING_NOTIFICATION_DELIVERIES_IDENTITY_TRIGGER,
        ELEARNING_NOTIFICATION_DELIVERIES_TRUNCATE_TRIGGER,
      ]],
    )
    expect(triggers.rows).toEqual([
      {
        name: ELEARNING_NOTIFICATION_DELIVERIES_IDENTITY_TRIGGER,
        fn: ELEARNING_NOTIFICATION_DELIVERIES_IDENTITY_FN,
      },
      {
        name: ELEARNING_NOTIFICATION_DELIVERIES_TRUNCATE_TRIGGER,
        fn: ELEARNING_NOTIFICATION_DELIVERIES_IDENTITY_FN,
      },
    ])

    const missingOrg = await expectPgError(
      () => pool.query(
        `INSERT INTO elearning_notification_deliveries (
           org_id, assignment_member_id, kind, source_key, request_hash,
           request_hash_version, recipient_role, recipient_user_id, channel,
           payload, due_at, next_attempt_at
         ) VALUES (
           NULL, $1, 'assignment_reminder', 'missing-org', $2, 1,
           'learner', 'learner', 'platform', '{}'::jsonb, now(), now()
         )`,
        [randomUUID(), 'a'.repeat(64)],
      ),
      '23502',
    )
    expect(missingOrg.column).toBe('org_id')
  })

  it('deduplicates concurrent writes, isolates organizations, and freezes intent identity', async () => {
    const orgA = `${NS}-org-a-${randomUUID().slice(0, 8)}`
    const orgB = `${NS}-org-b-${randomUUID().slice(0, 8)}`
    committedOrgIds.push(orgA, orgB)
    const a = await seedAssignmentMember(orgA, `${NS}-learner-a`)
    const b = await seedAssignmentMember(orgB, `${NS}-learner-b`)
    const sourceKey = 'assignment:shared:user:shared:window:2026-08-27T00:00:00Z'
    const dueAt = '2026-08-27T00:00:00.000Z'
    const requestA = {
      orgId: orgA,
      assignmentMemberId: a.memberId,
      recipientUserId: a.userId,
      sourceKey,
      dueAt,
      payload: { assignment: 'required', window: 1 },
    }

    const concurrent = await Promise.all([
      enqueueElearningNotificationDelivery(db, requestA),
      enqueueElearningNotificationDelivery(db, requestA),
    ])
    expect(concurrent.map((row) => row.duplicate).sort()).toEqual([false, true])
    expect(new Set(concurrent.map((row) => row.deliveryId)).size).toBe(1)
    const deliveryId = concurrent[0].deliveryId

    await expect(enqueueElearningNotificationDelivery(db, {
      ...requestA,
      payload: { window: 2, assignment: 'required' },
    })).rejects.toMatchObject({ code: 'conflict' })

    const inOrgB = await enqueueElearningNotificationDelivery(db, {
      orgId: orgB,
      assignmentMemberId: b.memberId,
      recipientUserId: b.userId,
      sourceKey,
      dueAt,
      payload: { window: 1, assignment: 'required' },
    })
    expect(inOrgB.duplicate).toBe(false)
    expect(inOrgB.deliveryId).not.toBe(deliveryId)

    let crossOrg: unknown
    try {
      await enqueueElearningNotificationDelivery(db, {
        ...requestA,
        assignmentMemberId: b.memberId,
        sourceKey: `${sourceKey}:cross-org`,
      })
    } catch (error) {
      crossOrg = error
    }
    expect(crossOrg).toBeInstanceOf(ElearningNotificationDeliveryError)
    expect(crossOrg).toMatchObject({ code: 'not_found' })
    expect(`${(crossOrg as Error).message}\n${(crossOrg as Error).stack ?? ''}`)
      .not.toContain(orgA)
    expect(`${(crossOrg as Error).message}\n${(crossOrg as Error).stack ?? ''}`)
      .not.toContain(b.memberId)

    await expectPgError(
      () => pool.query(
        `INSERT INTO elearning_notification_deliveries (
           org_id, assignment_member_id, kind, source_key, request_hash,
           request_hash_version, recipient_role, recipient_user_id, channel,
           payload, due_at, next_attempt_at
         ) VALUES (
           $1, $2, 'assignment_reminder', $3, $4, 1,
           'learner', $5, 'platform', '{}'::jsonb, $6, $6
         )`,
        [orgA, b.memberId, `${sourceKey}:fk`, 'b'.repeat(64), a.userId, dueAt],
      ),
      '23503',
      'elearning_notification_deliveries_assignment_member_fk',
    )

    const sending = await pool.query<{ attempt_count: number; status: string }>(
      `UPDATE elearning_notification_deliveries
          SET status = 'sending',
              attempt_count = attempt_count + 1,
              last_attempt_at = clock_timestamp(),
              claimed_at = clock_timestamp(),
              claim_expires_at = clock_timestamp() + interval '1 minute',
              claim_worker_id = 'notification-worker',
              updated_at = clock_timestamp()
        WHERE org_id = $1 AND id = $2
        RETURNING status, attempt_count`,
      [orgA, deliveryId],
    )
    expect(sending.rows).toEqual([{ status: 'sending', attempt_count: 1 }])

    const ambiguous = await pool.query<{ status: string }>(
      `UPDATE elearning_notification_deliveries
          SET status = 'outcome_unknown',
              claimed_at = NULL,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              last_error = 'OUTCOME_UNKNOWN',
              updated_at = clock_timestamp()
        WHERE org_id = $1 AND id = $2
        RETURNING status`,
      [orgA, deliveryId],
    )
    expect(ambiguous.rows).toEqual([{ status: 'outcome_unknown' }])
    await expect(enqueueElearningNotificationDelivery(db, requestA)).resolves.toEqual({
      deliveryId,
      status: 'outcome_unknown',
      duplicate: true,
    })

    await pool.query(
      `UPDATE elearning_courses
          SET status = 'withdrawn', updated_at = clock_timestamp()
        WHERE org_id = $1`,
      [orgA],
    )
    await expect(enqueueElearningNotificationDelivery(db, {
      ...requestA,
      sourceKey: `${sourceKey}:withdrawn`,
    })).rejects.toMatchObject({ code: 'not_eligible' })

    await expectPgError(
      () => pool.query(
        `UPDATE elearning_notification_deliveries
            SET source_key = source_key || ':mutated'
          WHERE org_id = $1 AND id = $2`,
        [orgA, deliveryId],
      ),
      'P0001',
    )
    await expectPgError(
      () => pool.query(
        `DELETE FROM elearning_notification_deliveries
          WHERE org_id = $1 AND id = $2`,
        [orgA, deliveryId],
      ),
      'P0001',
    )

    const counts = await pool.query<{ count: number; org_id: string }>(
      `SELECT org_id, count(*)::integer AS count
         FROM elearning_notification_deliveries
        WHERE org_id = ANY($1::text[])
        GROUP BY org_id
        ORDER BY org_id`,
      [[orgA, orgB]],
    )
    expect(counts.rows).toEqual([
      { org_id: orgA, count: 1 },
      { org_id: orgB, count: 1 },
    ])

    const truncateClient = await pool.connect()
    try {
      await truncateClient.query('BEGIN')
      await expectPgError(
        () => truncateClient.query(`TRUNCATE ${ELEARNING_NOTIFICATION_DELIVERIES_TABLE}`),
        'P0001',
      )
    } finally {
      await truncateClient.query('ROLLBACK')
      truncateClient.release()
    }
  })

  it('produces assignment reminders from canonical course state and stops after withdrawal or completion', async () => {
    const orgA = `${NS}-producer-a-${randomUUID().slice(0, 8)}`
    const orgB = `${NS}-producer-b-${randomUUID().slice(0, 8)}`
    committedOrgIds.push(orgA, orgB)
    const a = await seedAssignmentMember(orgA, `${NS}-producer-learner-a`)
    const b = await seedAssignmentMember(orgB, `${NS}-producer-learner-b`)

    const produce = (windowStart: string, dueAt: string) => {
      const occurrenceKey = deriveElearningAssignmentReminderOccurrenceKey({
        assignmentId: a.assignmentId,
        userId: a.userId,
        windowStart,
      })
      return produceElearningAssignmentReminder(db, {
        orgId: orgA,
        assignmentMemberId: a.memberId,
        occurrenceKey,
        windowStart,
        dueAt,
      })
    }

    const active = await produce(
      '2026-08-27T00:00:00.000Z',
      '2026-08-27T01:00:00.000Z',
    )
    expect(active).toMatchObject({ outcome: 'enqueued' })
    await expect(checkElearningAssignmentReminderEligibility(db, {
      orgId: orgA,
      assignmentMemberId: a.memberId,
      recipientUserId: a.userId,
    })).resolves.toBe(true)
    await expect(checkElearningAssignmentReminderEligibility(db, {
      orgId: orgA,
      assignmentMemberId: a.memberId,
      recipientUserId: b.userId,
    })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(produceElearningAssignmentReminder(db, {
      orgId: orgA,
      assignmentMemberId: a.memberId,
      occurrenceKey: `${deriveElearningAssignmentReminderOccurrenceKey({
        assignmentId: a.assignmentId,
        userId: a.userId,
        windowStart: '2026-08-27T00:00:00.000Z',
      })}:tampered`,
      windowStart: '2026-08-27T00:00:00.000Z',
      dueAt: '2026-08-27T01:00:00.000Z',
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(produce(
      '2026-08-27T00:00:00.000Z',
      '2026-08-27T01:00:00.000Z',
    )).resolves.toEqual({
      outcome: 'duplicate',
      deliveryId: active.outcome === 'enqueued' ? active.deliveryId : '',
    })

    await pool.query(
      `UPDATE elearning_courses
          SET status = 'archived', updated_at = clock_timestamp()
        WHERE org_id = $1`,
      [orgA],
    )
    await expect(produce(
      '2026-08-28T00:00:00.000Z',
      '2026-08-28T02:00:00.000Z',
    )).resolves.toMatchObject({ outcome: 'enqueued' })
    await expect(checkElearningAssignmentReminderEligibility(db, {
      orgId: orgA,
      assignmentMemberId: a.memberId,
      recipientUserId: a.userId,
    })).resolves.toBe(true)

    await pool.query(
      `UPDATE elearning_courses
          SET status = 'withdrawn', updated_at = clock_timestamp()
        WHERE org_id = $1`,
      [orgA],
    )
    await expect(produce(
      '2026-08-29T00:00:00.000Z',
      '2026-08-29T01:00:00.000Z',
    )).resolves.toEqual({ outcome: 'ineligible' })
    await expect(checkElearningAssignmentReminderEligibility(db, {
      orgId: orgA,
      assignmentMemberId: a.memberId,
      recipientUserId: a.userId,
    })).resolves.toBe(false)

    await pool.query(
      `UPDATE elearning_courses
          SET status = 'active', updated_at = clock_timestamp()
        WHERE org_id = $1`,
      [orgA],
    )
    const items = await pool.query<{
      exam_id: string | null
      id: string
      item_type: 'exam' | 'video'
    }>(
      `SELECT id, item_type, exam_id
         FROM elearning_course_version_items
        WHERE org_id = $1 AND course_version_id = $2
        ORDER BY position ASC, id ASC`,
      [orgA, a.versionId],
    )
    const video = items.rows.find((item) => item.item_type === 'video')
    const exam = items.rows.find((item) => item.item_type === 'exam')
    expect(video?.id).toBeTruthy()
    expect(exam?.id).toBeTruthy()
    expect(exam?.exam_id).toBeTruthy()

    await pool.query(
      `INSERT INTO elearning_progress (
         org_id, assignment_member_id, course_version_id, course_version_item_id,
         user_id, status, effective_ms, max_position_ms, completed_at,
         required_at_completion
       ) VALUES ($1, $2, $3, $4, $5, 'completed', 9000, 10000, now(), TRUE)`,
      [orgA, a.memberId, a.versionId, video?.id, a.userId],
    )
    await expect(produce(
      '2026-08-30T00:00:00.000Z',
      '2026-08-30T01:00:00.000Z',
    )).resolves.toMatchObject({ outcome: 'enqueued' })
    await expect(checkElearningAssignmentReminderEligibility(db, {
      orgId: orgA,
      assignmentMemberId: a.memberId,
      recipientUserId: a.userId,
    })).resolves.toBe(true)

    const attemptId = randomUUID()
    await pool.query(
      `INSERT INTO elearning_exam_attempts (
         id, org_id, exam_id, course_version_id, course_version_item_id,
         user_id, attempt_no, paper_snapshot, status
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, '{}'::jsonb, 'started')`,
      [attemptId, orgA, exam?.exam_id, a.versionId, exam?.id, a.userId],
    )
    await pool.query(
      `UPDATE elearning_exam_attempts
          SET status = 'submitted', answers = '{}'::jsonb, submitted_at = now()
        WHERE org_id = $1 AND id = $2`,
      [orgA, attemptId],
    )
    await pool.query(
      `UPDATE elearning_exam_attempts
          SET status = 'graded', auto_score = 10, total_score = 10,
              passed = TRUE, graded_at = now()
        WHERE org_id = $1 AND id = $2`,
      [orgA, attemptId],
    )
    await expect(produce(
      '2026-08-31T00:00:00.000Z',
      '2026-08-31T01:00:00.000Z',
    )).resolves.toEqual({ outcome: 'ineligible' })
    await expect(checkElearningAssignmentReminderEligibility(db, {
      orgId: orgA,
      assignmentMemberId: a.memberId,
      recipientUserId: a.userId,
    })).resolves.toBe(false)

    const otherOrgKey = deriveElearningAssignmentReminderOccurrenceKey({
      assignmentId: b.assignmentId,
      userId: b.userId,
      windowStart: '2026-09-01T00:00:00.000Z',
    })
    await expect(checkElearningAssignmentReminderEligibility(db, {
      orgId: orgA,
      assignmentMemberId: b.memberId,
      recipientUserId: b.userId,
    })).rejects.toMatchObject({ code: 'not_found' })
    let crossOrg: unknown
    try {
      await produceElearningAssignmentReminder(db, {
        orgId: orgA,
        assignmentMemberId: b.memberId,
        occurrenceKey: otherOrgKey,
        windowStart: '2026-09-01T00:00:00.000Z',
        dueAt: '2026-09-01T01:00:00.000Z',
      })
    } catch (error) {
      crossOrg = error
    }
    expect(crossOrg).toBeInstanceOf(ElearningAssignmentReminderError)
    expect(crossOrg).toMatchObject({ code: 'not_found' })
    expect(`${(crossOrg as Error).message}\n${(crossOrg as Error).stack ?? ''}`)
      .not.toContain(b.memberId)

    const intents = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM elearning_notification_deliveries
        WHERE org_id = $1`,
      [orgA],
    )
    expect(intents.rows).toEqual([{ count: 3 }])
  })
})

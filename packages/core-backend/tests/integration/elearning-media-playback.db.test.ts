/**
 * E-learning V0.1 protected-playback service gate (real PostgreSQL).
 *
 * Assumes content/assessment + watch-progress migrations have already been
 * applied by the caller. Does not call up()/down() and does not write
 * kysely_migration.
 *
 * DATABASE_URL is required. A missing URL throws (refuses skip-shaped green).
 * HTTP/API surfaces are out of this slice.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { ELEARNING_V01_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import { ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS } from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'
import {
  SCOPE_REVISIONS_DENY_MUTATION_TRIGGER,
  SCOPE_RULES_DENY_MUTATION_TRIGGER,
} from '../../src/db/migrations/zzzz20260826150000_add_elearning_scope_access'
import {
  listElearningLearnerCourses,
  type ElearningLearnerCoursesDb,
} from '../../src/services/elearning-learner-courses'
import { ELEARNING_MEDIA_RANGE_MAX_BYTES } from '../../src/services/elearning-media-storage'
import {
  authorizeElearningMediaPlayback,
  ElearningPlaybackError,
  issueElearningMediaPlaybackTicket,
  signElearningMediaPlaybackToken,
  verifyElearningMediaPlaybackToken,
  type ElearningMediaPlaybackClaims,
  type ElearningPlaybackDb,
  type ElearningPlaybackQueryable,
} from '../../src/services/elearning-media-playback'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning V0.1 playback service gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const STAMP = Date.now().toString(36)
const NS = `el-pbsvc-${STAMP}`
const PLAYBACK_SECRET = 'playback-signing-secret-min-32chars!'
const JWT_SECRET = 'jwt-secret-must-remain-unused-32b!!'
const NOW = new Date('2026-08-25T12:00:00.000Z')

const ALL_TRIGGERS = [
  ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
  {
    table: 'elearning_scope_revisions',
    name: SCOPE_REVISIONS_DENY_MUTATION_TRIGGER,
  },
  {
    table: 'elearning_scope_revision_rules',
    name: SCOPE_RULES_DENY_MUTATION_TRIGGER,
  },
]

class PgPlaybackDb implements ElearningPlaybackDb, ElearningLearnerCoursesDb {
  constructor(
    private readonly target: Pool,
    private readonly afterQuery?: (sql: string) => Promise<void>,
  ) {}

  async query(sql: string, params?: unknown[]) {
    const result = await this.target.query(sql, params as never)
    return {
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rowCount,
    }
  }

  async transaction<T>(
    handler: (tx: ElearningPlaybackQueryable) => Promise<T>,
  ): Promise<T> {
    const client = await this.target.connect()
    try {
      await client.query('BEGIN')
      const value = await handler(
        new PgPlaybackTransaction(client, this.afterQuery),
      )
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

class PgPlaybackTransaction implements ElearningPlaybackQueryable {
  constructor(
    private readonly client: PoolClient,
    private readonly afterQuery?: (sql: string) => Promise<void>,
  ) {}

  async query(sql: string, params?: unknown[]) {
    const result = await this.client.query(sql, params as never)
    await this.afterQuery?.(sql)
    return {
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rowCount,
    }
  }
}

const db = new PgPlaybackDb(pool)

function orgId(suffix: string): string {
  return `${NS}-${suffix}`
}

function actor(suffix: string): string {
  return `${NS}-actor-${suffix}`
}

async function setTriggers(enabled: boolean): Promise<void> {
  const verb = enabled ? 'ENABLE' : 'DISABLE'
  for (const { table, name } of ALL_TRIGGERS) {
    await pool.query(`ALTER TABLE ${table} ${verb} TRIGGER ${name}`)
  }
}

async function cleanupOrg(org: string): Promise<void> {
  await setTriggers(false)
  try {
    await pool.query(
      'DELETE FROM elearning_completion_evidence WHERE org_id = $1',
      [org],
    )
    await pool.query('DELETE FROM elearning_progress WHERE org_id = $1', [org])
    await pool.query(
      'DELETE FROM elearning_progress_events WHERE org_id = $1',
      [org],
    )
    await pool.query(
      'DELETE FROM elearning_learning_sessions WHERE org_id = $1',
      [org],
    )
    await pool.query(
      'DELETE FROM elearning_assignment_members WHERE org_id = $1',
      [org],
    )
    await pool.query('DELETE FROM elearning_assignments WHERE org_id = $1', [
      org,
    ])
    await pool.query(
      'DELETE FROM elearning_course_version_items WHERE org_id = $1',
      [org],
    )
    await pool.query('DELETE FROM elearning_exam_questions WHERE org_id = $1', [
      org,
    ])
    await pool.query('DELETE FROM elearning_exams WHERE org_id = $1', [org])
    await pool.query(
      'DELETE FROM elearning_question_revisions WHERE org_id = $1',
      [org],
    )
    await pool.query('DELETE FROM elearning_questions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [org])
    await pool.query(
      `UPDATE elearning_courses
          SET active_version_id = NULL, latest_version_id = NULL
        WHERE org_id = $1`,
      [org],
    )
    await pool.query(
      'DELETE FROM elearning_course_versions WHERE org_id = $1',
      [org],
    )
    await pool.query('DELETE FROM elearning_courses WHERE org_id = $1', [org])
    await pool.query(
      `UPDATE elearning_scopes
          SET active_revision_id = NULL, latest_revision_id = NULL
        WHERE org_id = $1`,
      [org],
    )
    await pool.query(
      'DELETE FROM elearning_scope_revision_rules WHERE org_id = $1',
      [org],
    )
    await pool.query(
      'DELETE FROM elearning_scope_revisions WHERE org_id = $1',
      [org],
    )
    await pool.query('DELETE FROM elearning_scopes WHERE org_id = $1', [org])
    await pool.query('DELETE FROM directory_integrations WHERE org_id = $1', [org])
    await pool.query('DELETE FROM user_orgs WHERE org_id = $1', [org])
    await pool.query(
      `DELETE FROM users user_row
        WHERE user_row.id LIKE $1
          AND NOT EXISTS (
            SELECT 1 FROM user_orgs membership WHERE membership.user_id = user_row.id
          )`,
      [`${NS}-actor-learner-%`],
    )
  } finally {
    await setTriggers(true)
  }
}

function createQueryBarrier(tag: string): {
  hit: Promise<void>
  release: () => void
  afterQuery: (sql: string) => Promise<void>
} {
  let hitResolve!: () => void
  let releaseResolve!: () => void
  let consumed = false
  const hit = new Promise<void>((resolve) => {
    hitResolve = resolve
  })
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve
  })
  return {
    hit,
    release: releaseResolve,
    async afterQuery(sql) {
      if (consumed || !sql.includes(`/* ${tag} */`)) return
      consumed = true
      hitResolve()
      await released
    },
  }
}

async function expectBarrierHit(hit: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      hit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`expected ${label} query lock`)),
          1_000,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForBackendLock(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await pool.query(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid],
    )
    if (state.rows[0]?.wait_event_type === 'Lock') return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('expected updater to wait on playback authorization lock')
}

interface Seed {
  org: string
  userId: string
  courseId: string
  versionId: string
  itemId: string
  mediaId: string
  storageKey: string
  sizeBytes: number
  mimeType: string
  assignmentId: string
  memberId: string
}

async function seedPublishedAssignment(input: {
  org: string
  sizeBytes?: number
}): Promise<Seed> {
  const sizeBytes = input.sizeBytes ?? 1024
  const userId = actor(`learner-${randomUUID().slice(0, 8)}`)
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const examId = randomUUID()
  const questionId = randomUUID()
  const revisionId = randomUUID()
  const itemId = randomUUID()
  const assignmentId = randomUUID()
  const memberId = randomUUID()
  const storageKey = `elearning-media/${NS}/${mediaId}.mp4`

  await pool.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, is_admin, activation_status, local_password_set,
       must_change_password, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'x', 'user', '[]'::jsonb,
       TRUE, FALSE, 'activated', TRUE,
       FALSE, now(), now()
     )`,
    [userId, `${userId}@playback.test`, userId],
  )
  await pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     VALUES ($1, $2, TRUE)`,
    [userId, input.org],
  )
  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Playback service course', 'active', $3)`,
    [courseId, input.org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version 1', $4)`,
    [versionId, input.org, courseId, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', $4, $5, 10000, 'ready', $6)`,
    [
      mediaId,
      input.org,
      storageKey,
      sizeBytes,
      'a'.repeat(64),
      actor('uploader'),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_questions (id, org_id, created_by) VALUES ($1, $2, $3)`,
    [questionId, input.org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt, options, answer_key, points, created_by
     ) VALUES ($1, $2, $3, 1, 'single_choice', 'Pick one', $4::jsonb, $5::jsonb, 10, $6)`,
    [
      revisionId,
      input.org,
      questionId,
      JSON.stringify([{ id: 'a', text: 'yes' }]),
      JSON.stringify({ correct: ['a'] }),
      actor('author'),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_exams (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Playback exam', 'draft', 10, 3, $3)`,
    [examId, input.org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_exam_questions (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, 1, 10)`,
    [input.org, examId, revisionId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, $3, 'video', 1, $4, NULL, 'video-v1-90pct', 9000)`,
    [itemId, input.org, versionId, mediaId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, 'exam', 2, NULL, $3, NULL, NULL)`,
    [input.org, versionId, examId],
  )
  await pool.query(
    `UPDATE elearning_exams SET status = 'published', updated_at = now() WHERE org_id = $1 AND id = $2`,
    [input.org, examId],
  )
  await pool.query(
    `UPDATE elearning_course_versions SET status = 'published', updated_at = now() WHERE org_id = $1 AND id = $2`,
    [input.org, versionId],
  )
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash, request_hash_version,
       deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, NULL, $6)`,
    [
      assignmentId,
      input.org,
      versionId,
      `${input.org}-src`,
      `hash-${assignmentId}`,
      actor('assigner'),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, input.org, assignmentId, versionId, userId],
  )

  return {
    org: input.org,
    userId,
    courseId,
    versionId,
    itemId,
    mediaId,
    storageKey,
    sizeBytes,
    mimeType: 'video/mp4',
    assignmentId,
    memberId,
  }
}

function decodeClaims(token: string): ElearningMediaPlaybackClaims {
  const payload = token.split('.')[0]
  return JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as ElearningMediaPlaybackClaims
}

async function insertAssignedPeer(seed: Seed, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [randomUUID(), seed.org, seed.assignmentId, seed.versionId, userId],
  )
}

async function replaceAssignmentWithVisibility(
  seed: Seed,
  rule: { subjectType: 'all'; subjectRef: null } | {
    subjectType: 'position'
    subjectRef: string
  } = { subjectType: 'all', subjectRef: null },
): Promise<{
  scopeId: string
  revisionId: string
}> {
  const scopeId = randomUUID()
  const revisionId = randomUUID()
  await pool.query(
    `INSERT INTO elearning_scopes (id, org_id, created_by)
     VALUES ($1, $2, $3)`,
    [scopeId, seed.org, actor('scope-author')],
  )
  await pool.query(
    `INSERT INTO elearning_scope_revisions
       (id, org_id, scope_id, revision, actor_id, reason)
     VALUES ($1, $2, $3, 1, $4, 'initial visibility')`,
    [revisionId, seed.org, scopeId, actor('scope-author')],
  )
  await pool.query(
    `INSERT INTO elearning_scope_revision_rules
       (org_id, scope_revision_id, subject_type, subject_ref, include_children)
     VALUES ($1, $2, $3, $4, FALSE)`,
    [seed.org, revisionId, rule.subjectType, rule.subjectRef],
  )
  await pool.query(
    `UPDATE elearning_scopes
        SET active_revision_id = $1, latest_revision_id = $1, updated_at = now()
      WHERE org_id = $2 AND id = $3`,
    [revisionId, seed.org, scopeId],
  )
  await pool.query(
    `UPDATE elearning_courses
        SET scope_id = $1,
            active_version_id = $2,
            latest_version_id = $2,
            updated_at = now()
      WHERE org_id = $3 AND id = $4`,
    [scopeId, seed.versionId, seed.org, seed.courseId],
  )
  await pool.query(
    `UPDATE elearning_assignment_members
        SET revoked_at = now(), revoked_by = $1, revocation_reason = 'visibility test'
      WHERE org_id = $2 AND id = $3`,
    [actor('revoker'), seed.org, seed.memberId],
  )
  return { scopeId, revisionId }
}

async function seedDirectoryPosition(seed: Seed, title: string): Promise<{
  linkId: string
}> {
  const integrationId = randomUUID()
  const accountId = randomUUID()
  const linkId = randomUUID()
  const suffix = randomUUID()
  await pool.query(
    `INSERT INTO directory_integrations (
       id, org_id, provider, name, status, corp_id, sync_enabled
     ) VALUES ($1, $2, 'dingtalk', $3, 'active', $4, FALSE)`,
    [integrationId, seed.org, `${NS}-${suffix}`, `${NS}-corp-${suffix}`],
  )
  await pool.query(
    `INSERT INTO directory_accounts (
       id, integration_id, provider, external_user_id, external_key,
       name, title, is_active
     ) VALUES ($1, $2, 'dingtalk', $3, $4, 'Learner', $5, TRUE)`,
    [accountId, integrationId, `${NS}-external-${suffix}`, `${NS}-key-${suffix}`, title],
  )
  await pool.query(
    `INSERT INTO directory_account_links (
       id, directory_account_id, local_user_id, link_status, match_strategy
     ) VALUES ($1, $2, $3, 'linked', 'test')`,
    [linkId, accountId, seed.userId],
  )
  return { linkId }
}

function assertValuesFree(
  payload: unknown,
  org: string,
  userId: string,
  storageKey: string,
): void {
  const blob = JSON.stringify(payload)
  expect(blob).not.toContain(org)
  expect(blob).not.toContain(userId)
  expect(blob).not.toContain(storageKey)
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('storage_key')
  expect(blob).not.toContain(PLAYBACK_SECRET)
  expect(blob).not.toContain(JWT_SECRET)
}

describe('elearning V0.1 playback service gate (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await cleanupOrg(org)
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  it('issues a ticket then authorizes a single range after a live DB recheck', async () => {
    const org = orgId('happy')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const ticket = await issueElearningMediaPlaybackTicket(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    expect(ticket.itemId).toBe(seed.itemId)
    expect(ticket.mediaId).toBe(seed.mediaId)
    assertValuesFree(ticket, org, seed.userId, seed.storageKey)

    const auth = await authorizeElearningMediaPlayback(db, {
      token: ticket.token,
      orgId: org,
      userId: seed.userId,
      rangeHeader: 'bytes=0-255',
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    expect(auth).toEqual({
      storageKey: seed.storageKey,
      mimeType: seed.mimeType,
      sizeBytes: seed.sizeBytes,
      range: {
        start: 0,
        end: 255,
        size: seed.sizeBytes,
        length: 256,
        complete: false,
        absent: false,
        httpStatus: 206,
        contentRange: `bytes 0-255/${seed.sizeBytes}`,
      },
    })
  })

  it('linearizes authorization before a concurrent course withdrawal', async () => {
    const org = orgId('withdraw-race')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const ticket = await issueElearningMediaPlaybackTicket(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    const barrier = createQueryBarrier('elearning-access:lock-assignment')
    const authorization = authorizeElearningMediaPlayback(
      new PgPlaybackDb(pool, barrier.afterQuery),
      {
        token: ticket.token,
        orgId: org,
        userId: seed.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      },
    )
    await expectBarrierHit(barrier.hit, 'playback assignment dependency')

    const updater = await pool.connect()
    try {
      await updater.query('BEGIN')
      const pid = Number(
        (await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      )
      const withdrawal = updater.query(
        `UPDATE elearning_courses
            SET status = 'withdrawn', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [org, seed.courseId],
      )
      await waitForBackendLock(pid)
      barrier.release()
      await expect(authorization).resolves.toMatchObject({
        storageKey: seed.storageKey,
      })
      await withdrawal
      await updater.query('COMMIT')
    } catch (error) {
      barrier.release()
      await updater.query('ROLLBACK')
      throw error
    } finally {
      updater.release()
    }

    await expect(
      authorizeElearningMediaPlayback(db, {
        token: ticket.token,
        orgId: org,
        userId: seed.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'course_withdrawn' })
  })

  it('linearizes visibility authorization before a concurrent scope shrink', async () => {
    const org = orgId('scope-race')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const { scopeId } = await replaceAssignmentWithVisibility(seed)
    const ticket = await issueElearningMediaPlaybackTicket(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    const barrier = createQueryBarrier('elearning-audience:load-revision-rules')
    const authorization = authorizeElearningMediaPlayback(
      new PgPlaybackDb(pool, barrier.afterQuery),
      {
        token: ticket.token,
        orgId: org,
        userId: seed.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      },
    )
    await barrier.hit

    const updater = await pool.connect()
    try {
      await updater.query('BEGIN')
      const revisionId = randomUUID()
      await updater.query(
        `INSERT INTO elearning_scope_revisions
           (id, org_id, scope_id, revision, actor_id, reason)
         VALUES ($1, $2, $3, 2, $4, 'remove all visibility')`,
        [revisionId, org, scopeId, actor('scope-editor')],
      )
      await updater.query(
        `INSERT INTO elearning_scope_revision_rules
           (org_id, scope_revision_id, subject_type, subject_ref, include_children)
         VALUES ($1, $2, 'user', $3, FALSE)`,
        [org, revisionId, actor('other-learner')],
      )
      const pid = Number(
        (await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      )
      const shrink = updater.query(
        `UPDATE elearning_scopes
            SET active_revision_id = $1, latest_revision_id = $1, updated_at = now()
          WHERE org_id = $2 AND id = $3`,
        [revisionId, org, scopeId],
      )
      await waitForBackendLock(pid)
      barrier.release()
      await expect(authorization).resolves.toMatchObject({
        storageKey: seed.storageKey,
      })
      await shrink
      await updater.query('COMMIT')
    } catch (error) {
      barrier.release()
      await updater.query('ROLLBACK')
      throw error
    } finally {
      updater.release()
    }

    await expect(
      authorizeElearningMediaPlayback(db, {
        token: ticket.token,
        orgId: org,
        userId: seed.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'assignment_unavailable' })
  })

  it('linearizes directory-position authorization before a concurrent unlink', async () => {
    const org = orgId('directory-race')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const title = `${NS}-Engineer`
    const { linkId } = await seedDirectoryPosition(seed, title)
    await replaceAssignmentWithVisibility(seed, {
      subjectType: 'position',
      subjectRef: title,
    })
    const ticket = await issueElearningMediaPlaybackTicket(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    const barrier = createQueryBarrier('elearning-audience:lock-directory-accounts')
    const authorization = authorizeElearningMediaPlayback(
      new PgPlaybackDb(pool, barrier.afterQuery),
      {
        token: ticket.token,
        orgId: org,
        userId: seed.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      },
    )
    await barrier.hit

    const updater = await pool.connect()
    try {
      await updater.query('BEGIN')
      const pid = Number(
        (await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      )
      const unlink = updater.query(
        `UPDATE directory_account_links
            SET link_status = 'unlinked', updated_at = now()
          WHERE id = $1`,
        [linkId],
      )
      await waitForBackendLock(pid)
      barrier.release()
      await expect(authorization).resolves.toMatchObject({
        storageKey: seed.storageKey,
      })
      await unlink
      await updater.query('COMMIT')
    } catch (error) {
      barrier.release()
      await updater.query('ROLLBACK')
      throw error
    } finally {
      updater.release()
    }

    await expect(
      authorizeElearningMediaPlayback(db, {
        token: ticket.token,
        orgId: org,
        userId: seed.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'assignment_unavailable' })
  })

  it('holds directory-position membership through learner catalog details', async () => {
    const org = orgId('catalog-directory-race')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const title = `${NS}-Catalog-Engineer`
    const { linkId } = await seedDirectoryPosition(seed, title)
    await replaceAssignmentWithVisibility(seed, {
      subjectType: 'position',
      subjectRef: title,
    })
    const barrier = createQueryBarrier('elearning-audience:lock-directory-accounts')
    const listing = listElearningLearnerCourses(
      new PgPlaybackDb(pool, barrier.afterQuery),
      { orgId: org, userId: seed.userId },
    )
    await expectBarrierHit(barrier.hit, 'learner catalog directory dependency')

    const updater = await pool.connect()
    try {
      await updater.query('BEGIN')
      const pid = Number(
        (await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      )
      const unlink = updater.query(
        `UPDATE directory_account_links
            SET link_status = 'unlinked', updated_at = now()
          WHERE id = $1`,
        [linkId],
      )
      await waitForBackendLock(pid)
      barrier.release()
      await expect(listing).resolves.toEqual([
        expect.objectContaining({
          courseId: seed.courseId,
          courseVersionId: seed.versionId,
          access: { kind: 'visibility', required: false },
        }),
      ])
      await unlink
      await updater.query('COMMIT')
    } catch (error) {
      barrier.release()
      await updater.query('ROLLBACK')
      throw error
    } finally {
      updater.release()
    }

    await expect(listElearningLearnerCourses(db, {
      orgId: org,
      userId: seed.userId,
    })).resolves.toEqual([])
  })

  it('returns a bounded first-chunk contract when Range is absent', async () => {
    const org = orgId('absent')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({
      org,
      sizeBytes: ELEARNING_MEDIA_RANGE_MAX_BYTES + 4096,
    })
    const ticket = await issueElearningMediaPlaybackTicket(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    const auth = await authorizeElearningMediaPlayback(db, {
      token: ticket.token,
      orgId: org,
      userId: seed.userId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    expect(auth.range.absent).toBe(true)
    expect(auth.range.start).toBe(0)
    expect(auth.range.length).toBe(ELEARNING_MEDIA_RANGE_MAX_BYTES)
    expect(auth.range.length).toBeLessThanOrEqual(
      ELEARNING_MEDIA_RANGE_MAX_BYTES,
    )
    expect(auth.range.complete).toBe(false)
    expect(auth.range.httpStatus).toBe(206)
    expect(auth.sizeBytes).toBe(seed.sizeBytes)
    expect(auth.storageKey).toBe(seed.storageKey)
    assertValuesFree(ticket, org, seed.userId, seed.storageKey)
  })

  it('fails revoke, withdraw, cross-org, tamper, and expiry; retired pinned versions stay allowed', async () => {
    const revokedOrg = orgId('revoked')
    seededOrgIds.push(revokedOrg)
    const revoked = await seedPublishedAssignment({ org: revokedOrg })
    const revokedTicket = await issueElearningMediaPlaybackTicket(db, {
      orgId: revokedOrg,
      userId: revoked.userId,
      itemId: revoked.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    await pool.query(
      `UPDATE elearning_assignment_members
          SET revoked_at = now(), revoked_by = $1, revocation_reason = 'pilot revoke'
        WHERE org_id = $2 AND id = $3`,
      [actor('revoker'), revokedOrg, revoked.memberId],
    )
    await expect(
      authorizeElearningMediaPlayback(db, {
        token: revokedTicket.token,
        orgId: revokedOrg,
        userId: revoked.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'assignment_unavailable' })

    const withdrawnOrg = orgId('withdrawn')
    seededOrgIds.push(withdrawnOrg)
    const withdrawn = await seedPublishedAssignment({ org: withdrawnOrg })
    const withdrawnTicket = await issueElearningMediaPlaybackTicket(db, {
      orgId: withdrawnOrg,
      userId: withdrawn.userId,
      itemId: withdrawn.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    await pool.query(
      `UPDATE elearning_courses SET status = 'withdrawn' WHERE org_id = $1 AND id = $2`,
      [withdrawnOrg, withdrawn.courseId],
    )
    await expect(
      authorizeElearningMediaPlayback(db, {
        token: withdrawnTicket.token,
        orgId: withdrawnOrg,
        userId: withdrawn.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'course_withdrawn' })

    const liveOrg = orgId('live')
    seededOrgIds.push(liveOrg)
    const live = await seedPublishedAssignment({ org: liveOrg })
    const liveTicket = await issueElearningMediaPlaybackTicket(db, {
      orgId: liveOrg,
      userId: live.userId,
      itemId: live.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    await expect(
      authorizeElearningMediaPlayback(db, {
        token: liveTicket.token,
        orgId: orgId('other'),
        userId: live.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_token' })

    const [payloadB64] = liveTicket.token.split('.')
    await expect(
      authorizeElearningMediaPlayback(db, {
        token: `${payloadB64}.${'C'.repeat(43)}`,
        orgId: liveOrg,
        userId: live.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_token' })

    await expect(
      authorizeElearningMediaPlayback(db, {
        token: liveTicket.token,
        orgId: liveOrg,
        userId: live.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: new Date(NOW.getTime() + 601_000),
      }),
    ).rejects.toMatchObject({ code: 'token_expired' })

    const retiredOrg = orgId('retired')
    seededOrgIds.push(retiredOrg)
    const retired = await seedPublishedAssignment({ org: retiredOrg })
    await pool.query(
      `UPDATE elearning_course_versions SET status = 'retired', updated_at = now() WHERE org_id = $1 AND id = $2`,
      [retiredOrg, retired.versionId],
    )
    const retiredTicket = await issueElearningMediaPlaybackTicket(db, {
      orgId: retiredOrg,
      userId: retired.userId,
      itemId: retired.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    await expect(
      authorizeElearningMediaPlayback(db, {
        token: retiredTicket.token,
        orgId: retiredOrg,
        userId: retired.userId,
        rangeHeader: 'bytes=0-1',
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      storageKey: retired.storageKey,
      mimeType: retired.mimeType,
      sizeBytes: retired.sizeBytes,
    })

    try {
      await authorizeElearningMediaPlayback(db, {
        token: `${payloadB64}.${'C'.repeat(43)}`,
        orgId: liveOrg,
        userId: live.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningPlaybackError)
      assertValuesFree(error, liveOrg, live.userId, live.storageKey)
    }
  })

  it('rejects a valid issued ticket presented by a different same-org assigned user', async () => {
    const org = orgId('peer')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const peer = actor(`peer-${randomUUID().slice(0, 8)}`)
    await insertAssignedPeer(seed, peer)
    const ticket = await issueElearningMediaPlaybackTicket(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    try {
      await authorizeElearningMediaPlayback(db, {
        token: ticket.token,
        orgId: org,
        userId: peer,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      })
      throw new Error('expected invalid_token')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningPlaybackError)
      expect((error as ElearningPlaybackError).code).toBe('invalid_token')
      assertValuesFree(error, org, seed.userId, seed.storageKey)
      assertValuesFree(error, org, peer, seed.storageKey)
    }
  })

  it('rejects a correctly HMAC-signed exact-schema ticket whose media claim differs from the current item', async () => {
    const org = orgId('media-claim')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const ticket = await issueElearningMediaPlaybackTicket(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    const claims = decodeClaims(ticket.token)
    const otherMedia = randomUUID()
    expect(otherMedia).not.toBe(seed.mediaId)
    const mismatched: ElearningMediaPlaybackClaims = {
      ...claims,
      media: otherMedia,
    }
    const token = signElearningMediaPlaybackToken(
      mismatched,
      PLAYBACK_SECRET,
      JWT_SECRET,
    )
    expect(
      verifyElearningMediaPlaybackToken(
        token,
        PLAYBACK_SECRET,
        JWT_SECRET,
        NOW,
      ),
    ).toEqual(mismatched)
    try {
      await authorizeElearningMediaPlayback(db, {
        token,
        orgId: org,
        userId: seed.userId,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      })
      throw new Error('expected not_found')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningPlaybackError)
      expect((error as ElearningPlaybackError).code).toBe('not_found')
      assertValuesFree(error, org, seed.userId, seed.storageKey)
      const blob = JSON.stringify(error)
      expect(blob).not.toContain(otherMedia)
      expect(blob).not.toContain(seed.mediaId)
    }
  })
})

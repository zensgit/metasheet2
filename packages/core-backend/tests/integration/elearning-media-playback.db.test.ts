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
import { Pool } from 'pg'
import { ELEARNING_V01_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import { ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS } from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'
import { ELEARNING_MEDIA_RANGE_MAX_BYTES } from '../../src/services/elearning-media-storage'
import {
  authorizeElearningMediaPlayback,
  ElearningPlaybackError,
  issueElearningMediaPlaybackTicket,
  signElearningMediaPlaybackToken,
  verifyElearningMediaPlaybackToken,
  type ElearningMediaPlaybackClaims,
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
]

class PgPlaybackDb implements ElearningPlaybackQueryable {
  constructor(private readonly target: Pool) {}

  async query(sql: string, params?: unknown[]) {
    const result = await this.target.query(sql, params as never)
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
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
    await pool.query('DELETE FROM elearning_completion_evidence WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_progress WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_progress_events WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_learning_sessions WHERE org_id = $1', [org])
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
    await setTriggers(true)
  }
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
    [mediaId, input.org, storageKey, sizeBytes, 'a'.repeat(64), actor('uploader')],
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
    [assignmentId, input.org, versionId, `${input.org}-src`, `hash-${assignmentId}`, actor('assigner')],
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
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ElearningMediaPlaybackClaims
}

async function insertAssignedPeer(seed: Seed, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [randomUUID(), seed.org, seed.assignmentId, seed.versionId, userId],
  )
}

function assertValuesFree(payload: unknown, org: string, userId: string, storageKey: string): void {
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
    expect(auth.range.length).toBeLessThanOrEqual(ELEARNING_MEDIA_RANGE_MAX_BYTES)
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
    await expect(authorizeElearningMediaPlayback(db, {
      token: revokedTicket.token,
      orgId: revokedOrg,
      userId: revoked.userId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })).rejects.toMatchObject({ code: 'assignment_unavailable' })

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
    await expect(authorizeElearningMediaPlayback(db, {
      token: withdrawnTicket.token,
      orgId: withdrawnOrg,
      userId: withdrawn.userId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })).rejects.toMatchObject({ code: 'course_withdrawn' })

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
    await expect(authorizeElearningMediaPlayback(db, {
      token: liveTicket.token,
      orgId: orgId('other'),
      userId: live.userId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })).rejects.toMatchObject({ code: 'invalid_token' })

    const [payloadB64] = liveTicket.token.split('.')
    await expect(authorizeElearningMediaPlayback(db, {
      token: `${payloadB64}.${'C'.repeat(43)}`,
      orgId: liveOrg,
      userId: live.userId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })).rejects.toMatchObject({ code: 'invalid_token' })

    await expect(authorizeElearningMediaPlayback(db, {
      token: liveTicket.token,
      orgId: liveOrg,
      userId: live.userId,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: new Date(NOW.getTime() + 601_000),
    })).rejects.toMatchObject({ code: 'token_expired' })

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
    await expect(authorizeElearningMediaPlayback(db, {
      token: retiredTicket.token,
      orgId: retiredOrg,
      userId: retired.userId,
      rangeHeader: 'bytes=0-1',
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })).resolves.toMatchObject({
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
    const mismatched: ElearningMediaPlaybackClaims = { ...claims, media: otherMedia }
    const token = signElearningMediaPlaybackToken(mismatched, PLAYBACK_SECRET, JWT_SECRET)
    expect(verifyElearningMediaPlaybackToken(token, PLAYBACK_SECRET, JWT_SECRET, NOW)).toEqual(mismatched)
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

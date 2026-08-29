import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CONTENT_IMMUTABLE_ROW_TRIGGERS,
  CONTENT_IMMUTABLE_TRUNCATE_TRIGGERS,
  ELEARNING_CONTENT_RUNTIME_TABLES,
  down as contentRuntimeDown,
  up as contentRuntimeUp,
} from '../../src/db/migrations/zzzz20260829213000_create_elearning_content_revisions'
import {
  publishElearningContentCourse,
  type ElearningContentCoursePublishDb,
  type ElearningContentCoursePublishQueryable,
} from '../../src/services/elearning-content-course-publish'
import {
  storeElearningContentRevision,
  type ElearningContentRevisionDb,
} from '../../src/services/elearning-content-revision-postgres'
import {
  recordElearningOpenCompletion,
  type ElearningOpenCompletionDb,
} from '../../src/services/elearning-open-completion-postgres'
import {
  publishElearningCourse,
  type ElearningCoursePublishDb,
} from '../../src/services/elearning-course-publish'
import { ELEARNING_MEDIA_MIME } from '../../src/services/elearning-media-validation'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning content runtime authority requires DATABASE_URL; refusing skip-shaped green',
  )
}

const MIGRATION_NAME = 'zzzz20260829213000_create_elearning_content_revisions'
const scratchName = `ms2_elcontent_${randomUUID().replaceAll('-', '').slice(0, 12)}`

let adminPool: Pool
let firstPool: Pool
let secondPool: Pool
let database: Kysely<unknown>
let firstMigrationNames: string[] = []
const execFileAsync = promisify(execFile)
const NS = `el-content-${Date.now().toString(36)}`

type RuntimeDb = ElearningContentRevisionDb
  & ElearningContentCoursePublishDb
  & ElearningOpenCompletionDb
  & ElearningCoursePublishDb

function databaseUrl(base: string, name: string): string {
  const url = new URL(base)
  url.pathname = `/${name}`
  return url.toString()
}

async function migrate(action: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
  await database.transaction().execute((tx) => action(tx))
}

async function query(
  target: Pool | import('pg').PoolClient,
  text: string,
  params?: unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
  const result = await target.query(text, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

function runtimeDb(pool: Pool): RuntimeDb {
  return {
    async transaction<T>(
      handler: (tx: ElearningContentCoursePublishQueryable) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await handler({ query: (text, params) => query(client, text, params) })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

function org(suffix: string): string {
  return `${NS}-${suffix}`
}

function actor(suffix: string): string {
  return `${NS}-actor-${suffix}`
}

async function createRevision(
  db: RuntimeDb,
  orgId: string,
  itemType: 'article' | 'external_link',
  suffix: string,
) {
  return storeElearningContentRevision(db, {
    orgId,
    actorId: actor('author'),
    requestId: randomUUID(),
    itemType,
    title: `${itemType} ${suffix}`,
    articleHtml: itemType === 'article'
      ? `<p>${suffix}</p><script>forbidden()</script>`
      : null,
    externalUrl: itemType === 'external_link'
      ? `https://example.test/${suffix}`
      : null,
  })
}

async function ensureMembership(pool: Pool, userId: string, orgId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, is_admin, activation_status, local_password_set,
       must_change_password, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'x', 'user', '[]'::jsonb,
       TRUE, FALSE, 'activated', TRUE, FALSE, now(), now()
     )`,
    [userId, `${userId}@content-runtime.test`, userId],
  )
  await pool.query(
    'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
    [userId, orgId],
  )
}

async function assignVersion(
  pool: Pool,
  orgId: string,
  userId: string,
  versionId: string,
): Promise<string> {
  const assignmentId = randomUUID()
  const memberId = randomUUID()
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash,
       request_hash_version, deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, NULL, $6)`,
    [assignmentId, orgId, versionId, randomUUID(), 'a'.repeat(64), actor('assigner')],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, orgId, assignmentId, versionId, userId],
  )
  return memberId
}

async function seedReadyMedia(pool: Pool, orgId: string): Promise<string> {
  const mediaId = randomUUID()
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, $4, $4, 1024, $5, 60000, 'ready', $6)`,
    [
      mediaId,
      orgId,
      `${NS}/media/${mediaId}`,
      ELEARNING_MEDIA_MIME,
      'b'.repeat(64),
      actor('uploader'),
    ],
  )
  return mediaId
}

function migrationFailed(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : 'unknown'
  throw new Error(`e-learning content migration failed code=${code}`, { cause: error })
}

async function runFullMigration(connectionString: string): Promise<void> {
  try {
    await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/db/migrate.ts',
      ],
      {
        cwd: pathForCoreBackend(),
        env: {
          ...process.env,
          DATABASE_URL: connectionString,
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    )
  } catch (error) {
    migrationFailed(error)
  }
}

function pathForCoreBackend(): string {
  return new URL('../..', import.meta.url).pathname
}

describe('e-learning content runtime PostgreSQL authority', () => {
  beforeAll(async () => {
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-content-runtime-admin',
      connectionString: DATABASE_URL,
      max: 1,
    })
    const collision = await adminPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [scratchName],
    )
    if (collision.rows.length !== 0) throw new Error('scratch database name collision')
    await adminPool.query(`CREATE DATABASE "${scratchName}"`)

    const connectionString = databaseUrl(DATABASE_URL, scratchName)
    firstPool = new Pool({
      application_name: 'elearning-content-runtime-first',
      connectionString,
      max: 4,
    })
    secondPool = new Pool({
      application_name: 'elearning-content-runtime-second',
      connectionString,
      max: 4,
    })
    database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
    await runFullMigration(connectionString)
    const applied = await firstPool.query(
      'SELECT name FROM kysely_migration ORDER BY name',
    )
    firstMigrationNames = applied.rows.map((row) => String(row.name))
    await runFullMigration(connectionString)
  }, 120_000)

  afterAll(async () => {
    const firstTermination = firstPool
      ? attachOwnedPoolTerminationHandler(firstPool)
      : null
    const secondTermination = secondPool
      ? attachOwnedPoolTerminationHandler(secondPool)
      : null
    try {
      if (database) await database.destroy()
      if (secondPool) await secondPool.end()
      if (adminPool) {
        try {
          const outcome = await dropScratchDatabase(adminPool, scratchName)
          console.info(formatScratchDropOutcome('elearning-content-runtime', outcome))
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-content-runtime', error))
          throw error
        }
        const residue = await adminPool.query(
          `SELECT count(*)::int AS count
             FROM pg_database
            WHERE datname = $1 OR datname LIKE 'ms2_elcontent_%'`,
          [scratchName],
        )
        expect(residue.rows).toEqual([{ count: 0 }])
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  }, 30_000)

  it('applies the complete stream, replays, rolls content authority down, and reapplies exactly', async () => {
    expect(firstMigrationNames).toContain(MIGRATION_NAME)
    const tables = await firstPool.query(
      `SELECT relname
         FROM pg_class
        WHERE relnamespace = current_schema()::regnamespace
          AND relkind = 'r'
          AND relname = ANY($1::text[])
        ORDER BY relname`,
      [[...ELEARNING_CONTENT_RUNTIME_TABLES]],
    )
    expect(tables.rows.map((row) => row.relname)).toEqual(
      [...ELEARNING_CONTENT_RUNTIME_TABLES].sort(),
    )
    const triggerNames = [
      ...CONTENT_IMMUTABLE_ROW_TRIGGERS.map((trigger) => trigger.name),
      ...CONTENT_IMMUTABLE_TRUNCATE_TRIGGERS.map((trigger) => trigger.name),
    ].sort()
    const triggers = await firstPool.query(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal AND tgname = ANY($1::text[])
        ORDER BY tgname`,
      [triggerNames],
    )
    expect(triggers.rows.map((row) => row.tgname)).toEqual(triggerNames)

    await migrate(contentRuntimeDown)
    const absent = await firstPool.query(
      `SELECT to_regclass('elearning_content_revisions') AS revisions,
              to_regclass('elearning_open_completion_events') AS events`,
    )
    expect(absent.rows).toEqual([{ revisions: null, events: null }])
    await migrate(contentRuntimeDown)
    await migrate(contentRuntimeUp)
    await migrate(contentRuntimeUp)
  }, 30_000)

  it('fails loud on unique, check-shape, immutable-function, and publish-readiness drift then restores cleanly', async () => {
    await firstPool.query(
      `ALTER TABLE elearning_open_completion_events
         DROP CONSTRAINT elearning_open_completion_events_effect_uniq`,
    )
    try {
      await expect(migrate(contentRuntimeUp)).rejects.toThrow(
        'elearning content runtime migration drift: elearning_open_completion_events_effect_uniq',
      )
    } finally {
      await firstPool.query(
        `ALTER TABLE elearning_open_completion_events
           ADD CONSTRAINT elearning_open_completion_events_effect_uniq
           UNIQUE (org_id, user_id, course_version_item_id)`,
      )
    }
    await migrate(contentRuntimeUp)

    const immutableDefinition = await firstPool.query<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'elearning_content_reject_immutable_write()'::regprocedure
       ) AS definition`,
    )
    try {
      await firstPool.query(`
        CREATE OR REPLACE FUNCTION elearning_content_reject_immutable_write()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$
      `)
      await expect(migrate(contentRuntimeUp)).rejects.toThrow(
        'elearning content runtime migration drift: elearning_content_reject_immutable_write',
      )
    } finally {
      await firstPool.query(immutableDefinition.rows[0].definition)
    }
    await migrate(contentRuntimeUp)

    const readinessDefinition = await firstPool.query<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'elearning_course_versions_state_guard()'::regprocedure
       ) AS definition`,
    )
    try {
      await firstPool.query(`
        CREATE OR REPLACE FUNCTION elearning_course_versions_state_guard()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$
      `)
      await expect(migrate(contentRuntimeUp)).rejects.toThrow(
        'elearning content runtime migration drift: elearning_course_versions_state_guard function',
      )
    } finally {
      await firstPool.query(readinessDefinition.rows[0].definition)
    }
    await migrate(contentRuntimeUp)

    const evidenceShape = await firstPool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid, true) AS definition
         FROM pg_constraint
        WHERE conrelid = 'elearning_completion_evidence'::regclass
          AND conname = 'elearning_completion_evidence_item_type_shape_chk'`,
    )
    try {
      await firstPool.query(
        `ALTER TABLE elearning_completion_evidence
           DROP CONSTRAINT elearning_completion_evidence_item_type_shape_chk,
           ADD CONSTRAINT elearning_completion_evidence_item_type_shape_chk CHECK (true)`,
      )
      await expect(migrate(contentRuntimeUp)).rejects.toThrow(
        'elearning content runtime migration drift: '
        + 'elearning_completion_evidence_item_type_shape_chk',
      )
    } finally {
      await firstPool.query(
        `ALTER TABLE elearning_completion_evidence
           DROP CONSTRAINT elearning_completion_evidence_item_type_shape_chk,
           ADD CONSTRAINT elearning_completion_evidence_item_type_shape_chk
           ${evidenceShape.rows[0].definition}`,
      )
    }
    await migrate(contentRuntimeUp)
  })

  it('publishes article-only, link-only, mixed ordered, and legacy video-exam courses while empty publish fails', async () => {
    const db = runtimeDb(firstPool)
    const articleOrg = org('article-only')
    const article = await createRevision(db, articleOrg, 'article', 'article-only')
    expect(article.articleHtml).toBe('<p>article-only</p>')
    const articleRequest = randomUUID()
    const articleCourse = await publishElearningContentCourse(db, {
      orgId: articleOrg,
      actorId: actor('publisher'),
      requestId: articleRequest,
      title: 'Article only',
      items: [{ itemType: 'article', contentRevisionId: article.contentRevisionId }],
    })
    expect(articleCourse.status).toBe('published')
    expect(articleCourse.items.map((item) => item.itemType)).toEqual(['article'])
    await expect(publishElearningContentCourse(db, {
      orgId: articleOrg,
      actorId: actor('publisher'),
      requestId: articleRequest,
      title: 'Article only',
      items: [{ itemType: 'article', contentRevisionId: article.contentRevisionId }],
    })).resolves.toEqual(articleCourse)
    await expect(publishElearningContentCourse(db, {
      orgId: articleOrg,
      actorId: actor('publisher'),
      requestId: articleRequest,
      title: 'Changed title',
      items: [{ itemType: 'article', contentRevisionId: article.contentRevisionId }],
    })).rejects.toMatchObject({ code: 'conflict' })

    const linkOrg = org('link-only')
    const link = await createRevision(db, linkOrg, 'external_link', 'link-only')
    const linkCourse = await publishElearningContentCourse(db, {
      orgId: linkOrg,
      actorId: actor('publisher'),
      requestId: randomUUID(),
      title: 'Link only',
      items: [{ itemType: 'external_link', contentRevisionId: link.contentRevisionId }],
    })
    expect(linkCourse.items.map((item) => item.itemType)).toEqual(['external_link'])

    const mixedOrg = org('mixed')
    const mixedArticle = await createRevision(db, mixedOrg, 'article', 'mixed-a')
    const mixedLink = await createRevision(db, mixedOrg, 'external_link', 'mixed-b')
    const mixed = await publishElearningContentCourse(db, {
      orgId: mixedOrg,
      actorId: actor('publisher'),
      requestId: randomUUID(),
      title: 'Mixed course',
      items: [
        { itemType: 'external_link', contentRevisionId: mixedLink.contentRevisionId },
        { itemType: 'article', contentRevisionId: mixedArticle.contentRevisionId },
      ],
    })
    expect(mixed.items.map((item) => [item.position, item.itemType])).toEqual([
      [1, 'external_link'],
      [2, 'article'],
    ])

    const emptyCourseId = randomUUID()
    const emptyVersionId = randomUUID()
    await firstPool.query(
      `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
       VALUES ($1, $2, 'Empty course', 'active', $3)`,
      [emptyCourseId, org('empty'), actor('publisher')],
    )
    await firstPool.query(
      `INSERT INTO elearning_course_versions (
         id, org_id, course_id, version, status, title, created_by
       ) VALUES ($1, $2, $3, 1, 'draft', 'Empty course', $4)`,
      [emptyVersionId, org('empty'), emptyCourseId, actor('publisher')],
    )
    await expect(firstPool.query(
      `UPDATE elearning_course_versions SET status = 'published' WHERE id = $1`,
      [emptyVersionId],
    )).rejects.toThrow('cannot publish course version: at least one valid item is required')

    const legacyOrg = org('legacy')
    const mediaId = await seedReadyMedia(firstPool, legacyOrg)
    const legacy = await publishElearningCourse(db, {
      orgId: legacyOrg,
      actorId: actor('legacy-publisher'),
      requestId: randomUUID(),
      title: 'Legacy video exam',
      mediaId,
      passScore: 5,
      maxAttempts: 2,
      questions: [{
        questionType: 'single_choice',
        prompt: 'Pick one',
        options: [{ id: 'a', text: 'yes' }, { id: 'b', text: 'no' }],
        correctOptionIds: ['a'],
        points: 5,
      }],
    })
    expect(legacy).toEqual({
      courseId: legacy.courseId,
      courseVersionId: legacy.courseVersionId,
      videoItemId: legacy.videoItemId,
      examItemId: legacy.examItemId,
      examId: legacy.examId,
      status: 'published',
      questionCount: 1,
      totalScore: 5,
    })
  }, 30_000)

  it('serializes one open effect, replays requests, honors assignment/archive/withdrawn access, and keeps evidence single-source', async () => {
    const orgId = org('open')
    const userId = actor('learner')
    const firstDb = runtimeDb(firstPool)
    const secondDb = runtimeDb(secondPool)
    const article = await createRevision(firstDb, orgId, 'article', 'open-a')
    const link = await createRevision(firstDb, orgId, 'external_link', 'open-b')
    const last = await createRevision(firstDb, orgId, 'article', 'open-c')
    const course = await publishElearningContentCourse(firstDb, {
      orgId,
      actorId: actor('publisher'),
      requestId: randomUUID(),
      title: 'Open course',
      items: [
        { itemType: 'article', contentRevisionId: article.contentRevisionId },
        { itemType: 'external_link', contentRevisionId: link.contentRevisionId },
        { itemType: 'article', contentRevisionId: last.contentRevisionId },
      ],
    })
    await ensureMembership(firstPool, userId, orgId)
    await assignVersion(firstPool, orgId, userId, course.courseVersionId)

    const requestA = randomUUID()
    const requestB = randomUUID()
    const raced = await Promise.all([
      recordElearningOpenCompletion(firstDb, {
        orgId,
        userId,
        requestId: requestA,
        itemId: course.items[0].itemId,
      }),
      recordElearningOpenCompletion(secondDb, {
        orgId,
        userId,
        requestId: requestB,
        itemId: course.items[0].itemId,
      }),
    ])
    expect(raced[0]).toEqual(raced[1])
    expect(raced[0]).toMatchObject({
      itemId: course.items[0].itemId,
      itemType: 'article',
      articleHtml: '<p>open-a</p>',
      externalUrl: null,
      status: 'completed',
      assurance: 'weak_server_recorded_open',
    })
    const counts = await firstPool.query(
      `SELECT
         (SELECT count(*)::int FROM elearning_open_completion_events
           WHERE org_id = $1 AND user_id = $2) AS events,
         (SELECT count(*)::int FROM elearning_completion_evidence
           WHERE org_id = $1 AND user_id = $2) AS evidence,
         (SELECT count(*)::int FROM elearning_open_completion_requests
           WHERE org_id = $1 AND user_id = $2) AS requests`,
      [orgId, userId],
    )
    expect(counts.rows).toEqual([{ events: 1, evidence: 1, requests: 2 }])
    await expect(recordElearningOpenCompletion(firstDb, {
      orgId,
      userId,
      requestId: requestA,
      itemId: course.items[1].itemId,
    })).rejects.toMatchObject({ code: 'conflict' })

    await firstPool.query(
      `UPDATE elearning_courses SET status = 'archived' WHERE org_id = $1 AND id = $2`,
      [orgId, course.courseId],
    )
    await expect(recordElearningOpenCompletion(firstDb, {
      orgId,
      userId,
      requestId: randomUUID(),
      itemId: course.items[1].itemId,
    })).resolves.toMatchObject({ itemType: 'external_link', status: 'completed' })

    await firstPool.query(
      `UPDATE elearning_courses SET status = 'withdrawn' WHERE org_id = $1 AND id = $2`,
      [orgId, course.courseId],
    )
    await expect(recordElearningOpenCompletion(firstDb, {
      orgId,
      userId,
      requestId: randomUUID(),
      itemId: course.items[2].itemId,
    })).rejects.toMatchObject({ code: 'course_withdrawn' })

    const evidenceColumns = await firstPool.query(
      `SELECT item_type, completion_threshold_bps, media_duration_ms,
              effective_ms, max_position_ms, content_revision_id,
              open_event_id, completion_assurance
         FROM elearning_completion_evidence
        WHERE org_id = $1 AND user_id = $2
        ORDER BY completed_at, id`,
      [orgId, userId],
    )
    expect(evidenceColumns.rows).toHaveLength(2)
    for (const row of evidenceColumns.rows) {
      expect(row.completion_threshold_bps).toBeNull()
      expect(row.media_duration_ms).toBeNull()
      expect(row.effective_ms).toBeNull()
      expect(row.max_position_ms).toBeNull()
      expect(row.content_revision_id).not.toBeNull()
      expect(row.open_event_id).not.toBeNull()
    }
    expect(await firstPool.query(
      `SELECT to_regclass('elearning_content_completion_evidence') AS second_truth`,
    )).toEqual(expect.objectContaining({ rows: [{ second_truth: null }] }))
  }, 30_000)

  it('rejects cross-org and cross-type references and enforces append-only rows and truncate', async () => {
    const db = runtimeDb(firstPool)
    const orgA = org('isolation-a')
    const orgB = org('isolation-b')
    await expect(storeElearningContentRevision(db, {
      orgId: orgA,
      actorId: actor('author'),
      requestId: randomUUID(),
      itemType: 'external_link',
      title: 'Unsafe link',
      articleHtml: null,
      externalUrl: 'http://example.test/not-https',
    })).rejects.toMatchObject({ code: 'invalid_input' })
    const external = await createRevision(db, orgA, 'external_link', 'isolated')
    await expect(publishElearningContentCourse(db, {
      orgId: orgB,
      actorId: actor('publisher'),
      requestId: randomUUID(),
      title: 'Cross org',
      items: [{ itemType: 'external_link', contentRevisionId: external.contentRevisionId }],
    })).rejects.toMatchObject({ code: 'reference_unavailable' })

    const courseId = randomUUID()
    const versionId = randomUUID()
    await firstPool.query(
      `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
       VALUES ($1, $2, 'Type mismatch', 'active', $3)`,
      [courseId, orgA, actor('publisher')],
    )
    await firstPool.query(
      `INSERT INTO elearning_course_versions (
         id, org_id, course_id, version, status, title, created_by
       ) VALUES ($1, $2, $3, 1, 'draft', 'Type mismatch', $4)`,
      [versionId, orgA, courseId, actor('publisher')],
    )
    await expect(firstPool.query(
      `INSERT INTO elearning_course_version_items (
         id, org_id, course_version_id, item_type, position,
         article_revision_id, completion_policy_version
       ) VALUES ($1, $2, $3, 'article', 1, $4, 'article-open-v1')`,
      [randomUUID(), orgA, versionId, external.contentRevisionId],
    )).rejects.toMatchObject({ code: '23503' })

    await expect(firstPool.query(
      `UPDATE elearning_content_revisions SET title = title WHERE org_id = $1 AND id = $2`,
      [orgA, external.contentRevisionId],
    )).rejects.toThrow('ELEARNING_CONTENT_IMMUTABLE')
    await expect(firstPool.query(
      `DELETE FROM elearning_content_revisions WHERE org_id = $1 AND id = $2`,
      [orgA, external.contentRevisionId],
    )).rejects.toThrow('ELEARNING_CONTENT_IMMUTABLE')
    await expect(firstPool.query('TRUNCATE elearning_open_completion_requests'))
      .rejects.toThrow('ELEARNING_CONTENT_IMMUTABLE')
  })
})

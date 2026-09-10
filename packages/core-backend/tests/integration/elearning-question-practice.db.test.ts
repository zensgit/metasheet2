import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  down as practiceDown,
  up as practiceUp,
} from '../../src/db/migrations/zzzz20260830230000_create_elearning_question_practice'
import { ElearningPracticeError } from '../../src/services/elearning-question-practice'
import {
  createElearningPracticeSet,
  listElearningWrongQuestions,
  startElearningPracticeSession,
  submitElearningPracticeAnswer,
  type ElearningPracticeDb,
  type ElearningPracticeQueryable,
} from '../../src/services/elearning-question-practice-postgres'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const DATABASE_URL = process.env.DATABASE_URL
const scratchPrefix = 'ms2_elpractice_'
const scratchName = `${scratchPrefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`
const ENABLED = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_ASSESSMENT_ENABLED: 'true',
} as NodeJS.ProcessEnv

let adminPool: Pool
let firstPool: Pool
let secondPool: Pool
let database: Kysely<unknown>

function scratchUrl(base: string, name: string): string {
  const url = new URL(base)
  url.pathname = `/${name}`
  return url.toString()
}

async function query(
  target: Pool | PoolClient,
  text: string,
  params?: unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
  const result = await target.query(text, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

function practiceDb(pool: Pool): ElearningPracticeDb {
  return {
    query: (text, params) => query(pool, text, params),
    async transaction<T>(
      handler: (tx: ElearningPracticeQueryable) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const value = await handler({ query: (text, params) => query(client, text, params) })
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

async function migrate(action: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
  await database.transaction().execute(async (tx) => action(tx))
}

async function createParentSchema(): Promise<void> {
  await firstPool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE user_orgs (
      user_id text NOT NULL,
      org_id text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, org_id)
    );
    CREATE TABLE elearning_questions (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      created_by text NOT NULL,
      CONSTRAINT test_questions_org_id_id_uniq UNIQUE (org_id, id)
    );
    CREATE TABLE elearning_question_revisions (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      question_id uuid NOT NULL,
      revision integer NOT NULL,
      question_type text NOT NULL,
      prompt text NOT NULL,
      options jsonb NOT NULL,
      answer_key jsonb NOT NULL,
      explanation text,
      points integer NOT NULL,
      created_by text NOT NULL,
      CONSTRAINT test_revisions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT test_revisions_org_question_id_uniq UNIQUE (org_id, question_id, id),
      CONSTRAINT test_revisions_question_fk FOREIGN KEY (org_id, question_id)
        REFERENCES elearning_questions (org_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE elearning_papers (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      title text NOT NULL,
      composition_mode text NOT NULL,
      status text NOT NULL,
      created_by text NOT NULL,
      CONSTRAINT test_papers_org_id_id_uniq UNIQUE (org_id, id)
    );
    CREATE TABLE elearning_paper_questions (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      paper_id uuid NOT NULL,
      question_id uuid NOT NULL,
      question_revision_id uuid NOT NULL,
      position integer NOT NULL,
      points integer NOT NULL,
      CONSTRAINT test_paper_questions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT test_paper_questions_paper_fk FOREIGN KEY (org_id, paper_id)
        REFERENCES elearning_papers (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT test_paper_questions_revision_fk FOREIGN KEY (org_id, question_id, question_revision_id)
        REFERENCES elearning_question_revisions (org_id, question_id, id) ON DELETE RESTRICT
    )
  `)
}

async function seedMember(orgId: string, userId: string): Promise<void> {
  await firstPool.query(
    `INSERT INTO users (id, is_active) VALUES ($1, true)
     ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
    [userId],
  )
  await firstPool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
     ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = EXCLUDED.is_active`,
    [userId, orgId],
  )
}

async function seedPaper(input: {
  orgId: string
  actorId: string
  status?: 'draft' | 'published'
  questionTypes?: Array<'single_choice' | 'multiple_choice' | 'true_false' | 'short_answer'>
}) {
  const paperId = randomUUID()
  const questionTypes = input.questionTypes ?? ['single_choice', 'multiple_choice']
  await firstPool.query(
    `INSERT INTO elearning_papers
       (id, org_id, title, composition_mode, status, created_by)
     VALUES ($1, $2, 'Practice paper', 'fixed', $3, $4)`,
    [paperId, input.orgId, input.status ?? 'published', input.actorId],
  )
  const revisions: string[] = []
  for (let index = 0; index < questionTypes.length; index += 1) {
    const questionId = randomUUID()
    const revisionId = randomUUID()
    const type = questionTypes[index]!
    const options = type === 'short_answer'
      ? []
      : [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]
    const answerKey = type === 'short_answer'
      ? {}
      : { correct: type === 'multiple_choice' ? ['a', 'b'] : ['a'] }
    await firstPool.query(
      `INSERT INTO elearning_questions (id, org_id, created_by) VALUES ($1, $2, $3)`,
      [questionId, input.orgId, input.actorId],
    )
    await firstPool.query(
      `INSERT INTO elearning_question_revisions (
         id, org_id, question_id, revision, question_type, prompt,
         options, answer_key, explanation, points, created_by
       ) VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, $7::jsonb, $8, 1, $9)`,
      [revisionId, input.orgId, questionId, type, `Question ${index + 1}`,
        JSON.stringify(options), JSON.stringify(answerKey), `secret-${index}`, input.actorId],
    )
    await firstPool.query(
      `INSERT INTO elearning_paper_questions (
         id, org_id, paper_id, question_id, question_revision_id, position, points
       ) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [randomUUID(), input.orgId, paperId, questionId, revisionId, index + 1],
    )
    revisions.push(revisionId)
  }
  return { paperId, revisions }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningPracticeError)
  expect((error as ElearningPracticeError).code).toBe(code)
  expect((error as Error).message).toBe(code)
}

describe.sequential('e-learning question practice PostgreSQL authority', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is required; refusing skip-shaped green')
    }
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-question-practice-admin',
      connectionString: DATABASE_URL,
      max: 1,
    })
    const residue = await adminPool.query(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${scratchPrefix}%`],
    )
    if (residue.rows.length !== 0) throw new Error('scratch database prefix residue detected')
    await adminPool.query(`CREATE DATABASE "${scratchName}"`)
    const connectionString = scratchUrl(DATABASE_URL, scratchName)
    firstPool = new Pool({
      application_name: 'elearning-question-practice-first',
      connectionString,
      max: 4,
    })
    secondPool = new Pool({
      application_name: 'elearning-question-practice-second',
      connectionString,
      max: 3,
    })
    database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
    await createParentSchema()
    await migrate(practiceUp)
  }, 30_000)

  afterAll(async () => {
    const firstTermination = firstPool ? attachOwnedPoolTerminationHandler(firstPool) : null
    const secondTermination = secondPool ? attachOwnedPoolTerminationHandler(secondPool) : null
    try {
      if (database) await database.destroy()
      if (secondPool) await secondPool.end()
      if (adminPool) {
        try {
          const outcome = await dropScratchDatabase(adminPool, scratchName)
          console.info(formatScratchDropOutcome('elearning-question-practice', outcome))
          if (!outcome.drained || outcome.residualBackends !== 0) {
            throw new Error('practice scratch database did not drain cleanly')
          }
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-question-practice', error))
          throw error
        }
        const exact = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [scratchName])
        const prefix = await adminPool.query(
          'SELECT datname FROM pg_database WHERE datname LIKE $1',
          [`${scratchPrefix}%`],
        )
        if (exact.rows.length !== 0 || prefix.rows.length !== 0) {
          throw new Error('practice scratch database residue')
        }
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  }, 30_000)

  it('replays, detects constraint drift, and supports empty down/down/reapply', async () => {
    await migrate(practiceUp)
    await firstPool.query(
      'ALTER TABLE elearning_practice_sessions DROP CONSTRAINT elearning_practice_sessions_request_uniq',
    )
    await expect(migrate(practiceUp)).rejects.toThrow('elearning practice migration drift: constraint set')
    await firstPool.query(
      'ALTER TABLE elearning_practice_sessions ADD CONSTRAINT elearning_practice_sessions_request_uniq UNIQUE (org_id, user_id, source_key)',
    )
    await migrate(practiceUp)
    await firstPool.query(
      'ALTER TABLE elearning_practice_sessions DROP CONSTRAINT elearning_practice_sessions_request_uniq',
    )
    await firstPool.query(
      'ALTER TABLE elearning_practice_sessions ADD CONSTRAINT elearning_practice_sessions_request_uniq UNIQUE (org_id, id, source_key)',
    )
    await expect(migrate(practiceUp)).rejects.toThrow(
      'elearning practice migration drift: constraint definition',
    )
    await firstPool.query(
      'ALTER TABLE elearning_practice_sessions DROP CONSTRAINT elearning_practice_sessions_request_uniq',
    )
    await firstPool.query(
      'ALTER TABLE elearning_practice_sessions ADD CONSTRAINT elearning_practice_sessions_request_uniq UNIQUE (org_id, user_id, source_key)',
    )
    await migrate(practiceUp)
    await firstPool.query(
      'ALTER TABLE elearning_practice_sessions ALTER COLUMN request_hash DROP NOT NULL',
    )
    await expect(migrate(practiceUp)).rejects.toThrow(
      'elearning practice migration drift: column nullability',
    )
    await firstPool.query(
      'ALTER TABLE elearning_practice_sessions ALTER COLUMN request_hash SET NOT NULL',
    )
    await migrate(practiceUp)
    await firstPool.query(`
      CREATE OR REPLACE FUNCTION elearning_practice_sessions_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RETURN OLD;
      END $fn$
    `)
    await expect(migrate(practiceUp)).rejects.toThrow(
      'elearning practice migration drift: function definition',
    )
    await migrate(practiceDown)
    await migrate(practiceUp)
    await firstPool.query(`
      CREATE SCHEMA elearning_practice_shadow;
      CREATE FUNCTION elearning_practice_shadow.elearning_practice_sessions_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $fn$;
      DROP TRIGGER trg_elearning_practice_sessions_immutable ON elearning_practice_sessions;
      CREATE TRIGGER trg_elearning_practice_sessions_immutable
        BEFORE UPDATE OR DELETE ON elearning_practice_sessions
        FOR EACH ROW EXECUTE FUNCTION elearning_practice_shadow.elearning_practice_sessions_immutable();
    `)
    await expect(migrate(practiceUp)).rejects.toThrow(
      'elearning practice migration drift: trigger set',
    )
    await firstPool.query(`
      DROP TRIGGER trg_elearning_practice_sessions_immutable ON elearning_practice_sessions;
      CREATE TRIGGER trg_elearning_practice_sessions_immutable
        BEFORE UPDATE OR DELETE ON elearning_practice_sessions
        FOR EACH ROW EXECUTE FUNCTION elearning_practice_sessions_immutable();
      DROP SCHEMA elearning_practice_shadow CASCADE;
    `)
    await migrate(practiceUp)
    await migrate(practiceDown)
    await migrate(practiceDown)
    await migrate(practiceUp)
  })

  it('accepts only published, dense, objective papers in the same organization', async () => {
    const orgId = `practice-org-${randomUUID()}`
    const actorId = `practice-actor-${randomUUID()}`
    await seedMember(orgId, actorId)
    const objective = await seedPaper({ orgId, actorId })
    const result = await createElearningPracticeSet(practiceDb(firstPool), {
      orgId,
      actorId,
      requestId: randomUUID(),
      paperId: objective.paperId,
      title: 'Objective practice',
    }, ENABLED)
    expect(result).toMatchObject({ paperId: objective.paperId, status: 'active', duplicate: false })

    const draft = await seedPaper({ orgId, actorId, status: 'draft' })
    await expect(createElearningPracticeSet(practiceDb(firstPool), {
      orgId,
      actorId,
      requestId: randomUUID(),
      paperId: draft.paperId,
      title: 'Draft practice',
    }, ENABLED)).rejects.toMatchObject({ code: 'unavailable' })

    const subjective = await seedPaper({ orgId, actorId, questionTypes: ['short_answer'] })
    await expect(createElearningPracticeSet(practiceDb(firstPool), {
      orgId,
      actorId,
      requestId: randomUUID(),
      paperId: subjective.paperId,
      title: 'Subjective practice',
    }, ENABLED)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('replays exact session commands, rejects changed payloads, and never leaks answers', async () => {
    const orgId = `practice-org-${randomUUID()}`
    const actorId = `practice-user-${randomUUID()}`
    await seedMember(orgId, actorId)
    const paper = await seedPaper({ orgId, actorId })
    const set = await createElearningPracticeSet(practiceDb(firstPool), {
      orgId, actorId, requestId: randomUUID(), paperId: paper.paperId, title: 'Replay set',
    }, ENABLED)
    const requestId = randomUUID()
    const first = await startElearningPracticeSession(practiceDb(firstPool), {
      orgId, userId: actorId, requestId, practiceSetId: set.practiceSetId, mode: 'random',
    }, ENABLED)
    const replay = await startElearningPracticeSession(practiceDb(firstPool), {
      orgId, userId: actorId, requestId, practiceSetId: set.practiceSetId, mode: 'random',
    }, ENABLED)
    expect(replay).toEqual({ ...first, duplicate: true })
    expect(JSON.stringify(first)).not.toMatch(/answer_key|answerKey|explanation|secret-/)
    await expect(startElearningPracticeSession(practiceDb(firstPool), {
      orgId, userId: actorId, requestId, practiceSetId: set.practiceSetId, mode: 'sequential',
    }, ENABLED)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('serializes concurrent same-request starts to one immutable session', async () => {
    const orgId = `practice-org-${randomUUID()}`
    const userId = `practice-user-${randomUUID()}`
    await seedMember(orgId, userId)
    const paper = await seedPaper({ orgId, actorId: userId })
    const set = await createElearningPracticeSet(practiceDb(firstPool), {
      orgId, actorId: userId, requestId: randomUUID(), paperId: paper.paperId, title: 'Race set',
    }, ENABLED)
    const input = {
      orgId, userId, requestId: randomUUID(), practiceSetId: set.practiceSetId, mode: 'sequential',
    }
    const [left, right] = await Promise.all([
      startElearningPracticeSession(practiceDb(firstPool), input, ENABLED),
      startElearningPracticeSession(practiceDb(secondPool), input, ENABLED),
    ])
    expect(left.sessionId).toBe(right.sessionId)
    expect([left.duplicate, right.duplicate].sort()).toEqual([false, true])
    const count = await firstPool.query(
      'SELECT count(*)::int AS count FROM elearning_practice_sessions WHERE org_id = $1 AND source_key = $2',
      [orgId, input.requestId],
    )
    expect(count.rows[0]?.count).toBe(1)
  })

  it('appends answers and projects wrong then resolved without disclosing the key', async () => {
    const orgId = `practice-org-${randomUUID()}`
    const userId = `practice-user-${randomUUID()}`
    await seedMember(orgId, userId)
    const paper = await seedPaper({ orgId, actorId: userId, questionTypes: ['single_choice'] })
    const set = await createElearningPracticeSet(practiceDb(firstPool), {
      orgId, actorId: userId, requestId: randomUUID(), paperId: paper.paperId, title: 'Wrong set',
    }, ENABLED)
    const firstSession = await startElearningPracticeSession(practiceDb(firstPool), {
      orgId, userId, requestId: randomUUID(), practiceSetId: set.practiceSetId, mode: 'sequential',
    }, ENABLED)
    const wrongRequest = randomUUID()
    const wrong = await submitElearningPracticeAnswer(practiceDb(firstPool), {
      orgId, userId, requestId: wrongRequest, sessionId: firstSession.sessionId,
      questionRevisionId: paper.revisions[0], selectedOptionIds: ['b'],
    }, ENABLED)
    expect(wrong).toMatchObject({ correct: false, wrongState: 'wrong', duplicate: false })
    const replay = await submitElearningPracticeAnswer(practiceDb(firstPool), {
      orgId, userId, requestId: wrongRequest, sessionId: firstSession.sessionId,
      questionRevisionId: paper.revisions[0], selectedOptionIds: ['b'],
    }, ENABLED)
    expect(replay).toEqual({ ...wrong, duplicate: true })
    await expect(submitElearningPracticeAnswer(practiceDb(firstPool), {
      orgId, userId, requestId: wrongRequest, sessionId: firstSession.sessionId,
      questionRevisionId: paper.revisions[0], selectedOptionIds: ['a'],
    }, ENABLED)).rejects.toMatchObject({ code: 'conflict' })
    expect((await listElearningWrongQuestions(practiceDb(firstPool), {
      orgId, userId, practiceSetId: set.practiceSetId,
    }, ENABLED)).questions).toHaveLength(1)

    const nextSession = await startElearningPracticeSession(practiceDb(firstPool), {
      orgId, userId, requestId: randomUUID(), practiceSetId: set.practiceSetId, mode: 'wrong_book',
    }, ENABLED)
    const resolved = await submitElearningPracticeAnswer(practiceDb(firstPool), {
      orgId, userId, requestId: randomUUID(), sessionId: nextSession.sessionId,
      questionRevisionId: paper.revisions[0], selectedOptionIds: ['a'],
    }, ENABLED)
    expect(resolved).toMatchObject({ correct: true, wrongState: 'resolved' })
    expect((await listElearningWrongQuestions(practiceDb(firstPool), {
      orgId, userId, practiceSetId: set.practiceSetId,
    }, ENABLED)).questions).toEqual([])
    expect(JSON.stringify({ wrong, replay, resolved })).not.toMatch(/answerKey|answer_key|explanation/)
  })

  it('rejects inactive or cross-organization members without creating effects', async () => {
    const orgId = `practice-org-${randomUUID()}`
    const userId = `practice-user-${randomUUID()}`
    const otherOrg = `practice-org-${randomUUID()}`
    await seedMember(orgId, userId)
    const paper = await seedPaper({ orgId, actorId: userId })
    const set = await createElearningPracticeSet(practiceDb(firstPool), {
      orgId, actorId: userId, requestId: randomUUID(), paperId: paper.paperId, title: 'Scope set',
    }, ENABLED)
    await expect(startElearningPracticeSession(practiceDb(firstPool), {
      orgId: otherOrg, userId, requestId: randomUUID(), practiceSetId: set.practiceSetId,
      mode: 'sequential',
    }, ENABLED)).rejects.toMatchObject({ code: 'forbidden' })
    await firstPool.query(
      'UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2',
      [userId, orgId],
    )
    await expect(startElearningPracticeSession(practiceDb(firstPool), {
      orgId, userId, requestId: randomUUID(), practiceSetId: set.practiceSetId,
      mode: 'sequential',
    }, ENABLED)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('enforces append-only evidence and refuses destructive down with authoritative rows', async () => {
    await expect(firstPool.query(
      'UPDATE elearning_practice_sessions SET mode = \'random\' WHERE false',
    )).resolves.toBeDefined()
    const row = await firstPool.query('SELECT id FROM elearning_practice_sessions LIMIT 1')
    expect(row.rows).toHaveLength(1)
    await expect(firstPool.query(
      'UPDATE elearning_practice_sessions SET mode = \'random\' WHERE id = $1',
      [row.rows[0]!.id],
    )).rejects.toThrow('elearning_practice_sessions is immutable')
    await expect(migrate(practiceDown)).rejects.toThrow(
      'elearning practice down refused: authoritative rows exist',
    )
  })
})

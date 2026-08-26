/**
 * E-learning L3 paper-bound exam rules gate against fully migrated PostgreSQL.
 * DATABASE_URL is mandatory; missing infrastructure must fail, never skip.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import {
  EXAMS_STATE_TRIGGER,
  EXAM_QUESTIONS_DRAFT_TRIGGER,
} from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { EXAMS_PUBLISH_POINTS_TRIGGER } from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'
import {
  ELEARNING_EXAM_AFTER_WINDOW_CHECK,
  ELEARNING_EXAM_DISCLOSURE_CHECK,
  ELEARNING_EXAM_DURATION_CHECK,
  ELEARNING_EXAM_PAPER_FK,
  ELEARNING_EXAM_PAPER_INDEX,
  ELEARNING_EXAM_WINDOW_CHECK,
} from '../../src/db/migrations/zzzz20260826230000_extend_elearning_exam_rules'
import {
  createElearningBankQuestion,
  createElearningQuestionBank,
  publishElearningFixedPaper,
  type ElearningAssessmentCatalogDb,
  type ElearningAssessmentCatalogQueryable,
} from '../../src/services/elearning-assessment-catalog'
import {
  ElearningPaperExamError,
  publishElearningPaperExam,
  type ElearningPaperExamDb,
  type ElearningPaperExamQueryable,
  type PublishElearningPaperExamInput,
} from '../../src/services/elearning-paper-exam'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning paper-exam DB gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
const NS = `el-paper-exam-${Date.now().toString(36)}`
const MIGRATION_NAME = 'zzzz20260826230000_extend_elearning_exam_rules'

class ClientDb implements ElearningAssessmentCatalogDb, ElearningPaperExamDb {
  private savepoint = 0

  constructor(private readonly client: PoolClient) {}

  async transaction<T>(
    handler: (
      tx: ElearningAssessmentCatalogQueryable & ElearningPaperExamQueryable,
    ) => Promise<T>,
  ): Promise<T> {
    const name = `elearning_paper_exam_${++this.savepoint}`
    await this.client.query(`SAVEPOINT ${name}`)
    try {
      const result = await handler({
        query: async (sql, params) => {
          const queryResult = await this.client.query(sql, params as never)
          return {
            rows: queryResult.rows as Array<Record<string, unknown>>,
            rowCount: queryResult.rowCount,
          }
        },
      })
      await this.client.query(`RELEASE SAVEPOINT ${name}`)
      return result
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`)
      await this.client.query(`RELEASE SAVEPOINT ${name}`)
      throw error
    }
  }
}

async function withRolledBackDb(
  run: (client: PoolClient, db: ClientDb) => Promise<void>,
): Promise<void> {
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    await run(client, new ClientDb(client))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function expectSqlState(
  client: PoolClient,
  expected: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const name = `negative_${randomUUID().replaceAll('-', '')}`
  await client.query(`SAVEPOINT ${name}`)
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
  await client.query(`RELEASE SAVEPOINT ${name}`)
  expect(caught).toBeDefined()
  expect((caught as { code?: string }).code).toBe(expected)
}

function org(label: string): string {
  return `${NS}-${label}`
}

function actor(label: string): string {
  return `${NS}-actor-${label}`
}

async function seedPublishedPaper(
  db: ClientDb,
  orgId: string,
  label: string,
  points = 10,
) {
  const bank = await createElearningQuestionBank(db, {
    orgId,
    actorId: actor(`bank-${label}`),
    title: `Bank ${label}`,
  })
  const revision = await createElearningBankQuestion(db, {
    orgId,
    actorId: actor(`question-${label}`),
    bankId: bank.bankId,
    question: {
      questionType: 'single_choice',
      prompt: `Question ${label}`,
      options: [
        { id: 'a', text: 'Alpha' },
        { id: 'b', text: 'Beta' },
      ],
      correctOptionIds: ['a'],
      points,
      explanation: 'Internal explanation',
    },
  })
  const paper = await publishElearningFixedPaper(db, {
    orgId,
    actorId: actor(`paper-${label}`),
    title: `Paper ${label}`,
    items: [{ questionRevisionId: revision.questionRevisionId, points }],
  })
  return { ...bank, ...revision, ...paper }
}

function paperExamInput(
  orgId: string,
  paperId: string,
  overrides: Partial<PublishElearningPaperExamInput> = {},
): PublishElearningPaperExamInput {
  return {
    orgId,
    actorId: actor('exam-author'),
    paperId,
    title: 'Fixed-paper exam',
    passScore: 6,
    maxAttempts: 2,
    windowStartsAt: '2026-09-01T01:00:00+08:00',
    windowEndsAt: '2026-09-02T01:00:00+08:00',
    durationSeconds: 1800,
    shuffleQuestions: true,
    shuffleOptions: true,
    disclosurePolicy: 'correctness_after_window',
    ...overrides,
  }
}

afterAll(async () => {
  await pool.end()
})

describe('e-learning L3 paper-bound exam rules', () => {
  it('runs on the named schema with same-org binding, closed rules, and active DB guards', async () => {
    const migration = await pool.query(
      'SELECT name FROM kysely_migration WHERE name = $1',
      [MIGRATION_NAME],
    )
    expect(migration.rows).toHaveLength(1)

    const columns = await pool.query<{
      column_name: string
      is_nullable: string
      column_default: string | null
    }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'elearning_exams'
          AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [
        [
          'paper_id',
          'window_starts_at',
          'window_ends_at',
          'duration_seconds',
          'shuffle_questions',
          'shuffle_options',
          'disclosure_policy',
        ],
      ],
    )
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'disclosure_policy',
      'duration_seconds',
      'paper_id',
      'shuffle_options',
      'shuffle_questions',
      'window_ends_at',
      'window_starts_at',
    ])
    expect(
      columns.rows.find((row) => row.column_name === 'shuffle_questions'),
    ).toMatchObject({
      is_nullable: 'NO',
      column_default: 'false',
    })
    expect(
      columns.rows.find((row) => row.column_name === 'shuffle_options'),
    ).toMatchObject({
      is_nullable: 'NO',
      column_default: 'false',
    })
    expect(
      columns.rows.find((row) => row.column_name === 'disclosure_policy'),
    ).toMatchObject({
      is_nullable: 'NO',
      column_default: "'no_review'::text",
    })

    const constraintNames = [
      ELEARNING_EXAM_PAPER_FK,
      ELEARNING_EXAM_WINDOW_CHECK,
      ELEARNING_EXAM_DURATION_CHECK,
      ELEARNING_EXAM_DISCLOSURE_CHECK,
      ELEARNING_EXAM_AFTER_WINDOW_CHECK,
    ]
    const constraints = await pool.query<{
      conname: string
      definition: string
    }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      [constraintNames],
    )
    expect(constraints.rows).toHaveLength(constraintNames.length)
    const byName = new Map(
      constraints.rows.map((row) => [row.conname, row.definition]),
    )
    expect(byName.get(ELEARNING_EXAM_PAPER_FK)).toContain(
      'FOREIGN KEY (org_id, paper_id)',
    )
    expect(byName.get(ELEARNING_EXAM_WINDOW_CHECK)).toContain(
      'window_starts_at < window_ends_at',
    )
    expect(byName.get(ELEARNING_EXAM_DURATION_CHECK)).toContain(
      'duration_seconds >= 1',
    )

    const index = await pool.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = $1`,
      [ELEARNING_EXAM_PAPER_INDEX],
    )
    expect(index.rows).toEqual([{ indexname: ELEARNING_EXAM_PAPER_INDEX }])

    const triggers = await pool.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname = ANY($1::text[])
        ORDER BY tgname`,
      [
        [
          EXAMS_STATE_TRIGGER,
          EXAM_QUESTIONS_DRAFT_TRIGGER,
          EXAMS_PUBLISH_POINTS_TRIGGER,
        ],
      ],
    )
    expect(triggers.rows).toEqual(
      [
        EXAM_QUESTIONS_DRAFT_TRIGGER,
        EXAMS_STATE_TRIGGER,
        EXAMS_PUBLISH_POINTS_TRIGGER,
      ]
        .sort()
        .map((tgname) => ({ tgname, tgenabled: 'O' })),
    )

    const functions = await pool.query<{ proname: string; definition: string }>(
      `SELECT p.proname, pg_get_functiondef(p.oid) AS definition
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY($1::text[])`,
      [
        [
          'elearning_exams_state_guard',
          'elearning_exam_questions_draft_parent',
          'elearning_exams_publish_points_guard',
        ],
      ],
    )
    const functionByName = new Map(
      functions.rows.map((row) => [row.proname, row.definition]),
    )
    expect(functionByName.get('elearning_exams_state_guard')).toContain(
      'NEW.paper_id IS DISTINCT FROM OLD.paper_id',
    )
    expect(
      functionByName.get('elearning_exam_questions_draft_parent'),
    ).toContain('parent_paper_id IS NOT NULL')
    expect(
      functionByName.get('elearning_exams_publish_points_guard'),
    ).toContain('FROM elearning_paper_questions')
  })

  it('publishes one paper-bound exam atomically and preserves its immutable binding', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('publish')
      const paper = await seedPublishedPaper(db, orgId, 'publish')
      const result = await publishElearningPaperExam(
        db,
        paperExamInput(orgId, paper.paperId),
      )
      expect(result).toEqual({
        examId: expect.any(String),
        paperId: paper.paperId,
        status: 'published',
        totalPoints: 10,
      })

      const stored = await client.query(
        `SELECT paper_id, status, pass_score::integer, max_attempts,
                window_starts_at, window_ends_at, duration_seconds,
                shuffle_questions, shuffle_options, disclosure_policy,
                (SELECT count(*)::integer
                   FROM elearning_exam_questions q
                  WHERE q.org_id = e.org_id AND q.exam_id = e.id) AS inline_count
           FROM elearning_exams e
          WHERE org_id = $1 AND id = $2`,
        [orgId, result.examId],
      )
      expect(stored.rows).toHaveLength(1)
      expect(stored.rows[0]).toMatchObject({
        paper_id: paper.paperId,
        status: 'published',
        pass_score: 6,
        max_attempts: 2,
        duration_seconds: 1800,
        shuffle_questions: true,
        shuffle_options: true,
        disclosure_policy: 'correctness_after_window',
        inline_count: 0,
      })
      expect((stored.rows[0]?.window_starts_at as Date).toISOString()).toBe(
        '2026-08-31T17:00:00.000Z',
      )
      expect((stored.rows[0]?.window_ends_at as Date).toISOString()).toBe(
        '2026-09-01T17:00:00.000Z',
      )

      await expectSqlState(client, 'P0001', () =>
        client.query(
          `UPDATE elearning_exams
            SET paper_id = NULL
          WHERE org_id = $1 AND id = $2`,
          [orgId, result.examId],
        ),
      )
      await expectSqlState(client, 'P0001', () =>
        client.query(
          `UPDATE elearning_exams
            SET status = 'retired', disclosure_policy = 'no_review', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
          [orgId, result.examId],
        ),
      )

      await client.query(
        `UPDATE elearning_papers
            SET status = 'retired', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, paper.paperId],
      )
      await client.query(
        `UPDATE elearning_exams
            SET status = 'retired', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, result.examId],
      )
      const retired = await client.query(
        `SELECT status, paper_id
           FROM elearning_exams
          WHERE org_id = $1 AND id = $2`,
        [orgId, result.examId],
      )
      expect(retired.rows).toEqual([
        { status: 'retired', paper_id: paper.paperId },
      ])

      await expect(
        publishElearningPaperExam(
          db,
          paperExamInput(orgId, paper.paperId, { title: 'Second binding' }),
        ),
      ).rejects.toMatchObject({
        name: 'ElearningPaperExamError',
        code: 'not_found',
        message: 'not_found',
      })
    })
  })

  it('keeps legacy inline exams compatible with safe rule defaults', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('legacy')
      const paper = await seedPublishedPaper(db, orgId, 'legacy')
      const examId = randomUUID()
      await client.query(
        `INSERT INTO elearning_exams
           (id, org_id, title, status, pass_score, max_attempts, created_by)
         VALUES ($1, $2, 'Legacy inline exam', 'draft', 5, 1, $3)`,
        [examId, orgId, actor('legacy')],
      )
      const defaults = await client.query(
        `SELECT paper_id, window_starts_at, window_ends_at, duration_seconds,
                shuffle_questions, shuffle_options, disclosure_policy
           FROM elearning_exams
          WHERE org_id = $1 AND id = $2`,
        [orgId, examId],
      )
      expect(defaults.rows).toEqual([
        {
          paper_id: null,
          window_starts_at: null,
          window_ends_at: null,
          duration_seconds: null,
          shuffle_questions: false,
          shuffle_options: false,
          disclosure_policy: 'no_review',
        },
      ])
      await client.query(
        `INSERT INTO elearning_exam_questions
           (org_id, exam_id, question_revision_id, position, points)
         VALUES ($1, $2, $3, 1, 10)`,
        [orgId, examId, paper.questionRevisionId],
      )
      await client.query(
        `UPDATE elearning_exams
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, examId],
      )
      const published = await client.query(
        'SELECT status FROM elearning_exams WHERE org_id = $1 AND id = $2',
        [orgId, examId],
      )
      expect(published.rows).toEqual([{ status: 'published' }])
    })
  })

  it('enforces exactly one immutable content source in the database', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('source')
      const paper = await seedPublishedPaper(db, orgId, 'source')

      const emptyExamId = randomUUID()
      await client.query(
        `INSERT INTO elearning_exams
           (id, org_id, title, status, pass_score, max_attempts, created_by)
         VALUES ($1, $2, 'No source', 'draft', 1, 1, $3)`,
        [emptyExamId, orgId, actor('empty')],
      )
      await expectSqlState(client, 'P0001', () =>
        client.query(
          `UPDATE elearning_exams
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
          [orgId, emptyExamId],
        ),
      )

      const boundExamId = randomUUID()
      await client.query(
        `INSERT INTO elearning_exams (
           id, org_id, title, status, pass_score, max_attempts, created_by, paper_id
         ) VALUES ($1, $2, 'Paper source', 'draft', 1, 1, $3, $4)`,
        [boundExamId, orgId, actor('bound'), paper.paperId],
      )
      await expectSqlState(client, 'P0001', () =>
        client.query(
          `INSERT INTO elearning_exam_questions
           (org_id, exam_id, question_revision_id, position, points)
         VALUES ($1, $2, $3, 1, 10)`,
          [orgId, boundExamId, paper.questionRevisionId],
        ),
      )

      const inlineExamId = randomUUID()
      await client.query(
        `INSERT INTO elearning_exams
           (id, org_id, title, status, pass_score, max_attempts, created_by)
         VALUES ($1, $2, 'Inline source', 'draft', 1, 1, $3)`,
        [inlineExamId, orgId, actor('inline')],
      )
      await client.query(
        `INSERT INTO elearning_exam_questions
           (org_id, exam_id, question_revision_id, position, points)
         VALUES ($1, $2, $3, 1, 10)`,
        [orgId, inlineExamId, paper.questionRevisionId],
      )
      await expectSqlState(client, 'P0001', () =>
        client.query(
          `UPDATE elearning_exams
            SET paper_id = $1
          WHERE org_id = $2 AND id = $3`,
          [paper.paperId, orgId, inlineExamId],
        ),
      )
    })
  })

  it('rejects cross-org, unpublished-paper, and over-score bindings', async () => {
    await withRolledBackDb(async (client, db) => {
      const sourceOrg = org('binding-source')
      const otherOrg = org('binding-other')
      const paper = await seedPublishedPaper(db, sourceOrg, 'binding')

      await expectSqlState(client, '23503', () =>
        client.query(
          `INSERT INTO elearning_exams (
           id, org_id, title, status, pass_score, max_attempts, created_by, paper_id
         ) VALUES ($1, $2, 'Cross-org', 'draft', 1, 1, $3, $4)`,
          [randomUUID(), otherOrg, actor('cross-org'), paper.paperId],
        ),
      )
      await expect(
        publishElearningPaperExam(db, paperExamInput(otherOrg, paper.paperId)),
      ).rejects.toMatchObject({ code: 'not_found' })

      const draftPaperId = randomUUID()
      await client.query(
        `INSERT INTO elearning_papers
           (id, org_id, title, composition_mode, status, created_by)
         VALUES ($1, $2, 'Draft paper', 'fixed', 'draft', $3)`,
        [draftPaperId, sourceOrg, actor('draft-paper')],
      )
      await expect(
        publishElearningPaperExam(db, paperExamInput(sourceOrg, draftPaperId)),
      ).rejects.toMatchObject({ code: 'not_found' })

      await expect(
        publishElearningPaperExam(
          db,
          paperExamInput(sourceOrg, paper.paperId, { passScore: 11 }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' })

      const overScoreExamId = randomUUID()
      await client.query(
        `INSERT INTO elearning_exams (
           id, org_id, title, status, pass_score, max_attempts, created_by, paper_id
         ) VALUES ($1, $2, 'Over score', 'draft', 11, 1, $3, $4)`,
        [overScoreExamId, sourceOrg, actor('over-score'), paper.paperId],
      )
      await expectSqlState(client, 'P0001', () =>
        client.query(
          `UPDATE elearning_exams
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
          [sourceOrg, overScoreExamId],
        ),
      )
    })
  })

  it('fails closed on malformed rule combinations in service and SQL paths', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('rules')
      const paper = await seedPublishedPaper(db, orgId, 'rules')

      const invalidInputs: PublishElearningPaperExamInput[] = [
        paperExamInput(orgId, paper.paperId, { windowEndsAt: null }),
        paperExamInput(orgId, paper.paperId, {
          windowStartsAt: '2026-09-02T00:00:00Z',
          windowEndsAt: '2026-09-01T00:00:00Z',
        }),
        paperExamInput(orgId, paper.paperId, { durationSeconds: 0 }),
        paperExamInput(orgId, paper.paperId, {
          windowStartsAt: null,
          windowEndsAt: null,
          disclosurePolicy: 'correctness_after_window',
        }),
      ]
      for (const input of invalidInputs) {
        await expect(
          publishElearningPaperExam(db, input),
        ).rejects.toBeInstanceOf(ElearningPaperExamError)
        await expect(
          publishElearningPaperExam(db, input),
        ).rejects.toMatchObject({
          code: 'invalid_input',
          message: 'invalid_input',
        })
      }
      await expect(
        publishElearningPaperExam(db, {
          ...paperExamInput(orgId, paper.paperId),
          unexpected: true,
        } as never),
      ).rejects.toMatchObject({ code: 'invalid_input' })

      const baseParams = [
        randomUUID(),
        orgId,
        actor('sql-rules'),
        paper.paperId,
      ]
      await expectSqlState(client, '23514', () =>
        client.query(
          `INSERT INTO elearning_exams (
           id, org_id, title, status, pass_score, max_attempts, created_by,
           paper_id, window_starts_at
         ) VALUES ($1, $2, 'Half window', 'draft', 1, 1, $3, $4, now())`,
          baseParams,
        ),
      )
      await expectSqlState(client, '23514', () =>
        client.query(
          `INSERT INTO elearning_exams (
           id, org_id, title, status, pass_score, max_attempts, created_by,
           paper_id, duration_seconds
         ) VALUES ($1, $2, 'Bad duration', 'draft', 1, 1, $3, $4, 0)`,
          [randomUUID(), orgId, actor('sql-duration'), paper.paperId],
        ),
      )
      await expectSqlState(client, '23514', () =>
        client.query(
          `INSERT INTO elearning_exams (
           id, org_id, title, status, pass_score, max_attempts, created_by,
           paper_id, disclosure_policy
         ) VALUES ($1, $2, 'Bad policy', 'draft', 1, 1, $3, $4, 'answer_key')`,
          [randomUUID(), orgId, actor('sql-policy'), paper.paperId],
        ),
      )
      await expectSqlState(client, '23514', () =>
        client.query(
          `INSERT INTO elearning_exams (
           id, org_id, title, status, pass_score, max_attempts, created_by,
           paper_id, disclosure_policy
         ) VALUES (
           $1, $2, 'Missing window end', 'draft', 1, 1, $3, $4,
           'correctness_after_window'
         )`,
          [randomUUID(), orgId, actor('sql-after-window'), paper.paperId],
        ),
      )
    })
  })
})

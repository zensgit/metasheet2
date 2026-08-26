/**
 * E-learning L3 assessment-catalog gate against a fully migrated PostgreSQL DB.
 * DATABASE_URL is mandatory; missing infrastructure must fail, never skip.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import {
  ELEARNING_ASSESSMENT_CATALOG_TRIGGERS,
  ELEARNING_PAPERS_TABLE,
  ELEARNING_PAPER_QUESTIONS_TABLE,
  ELEARNING_QUESTION_BANKS_TABLE,
} from '../../src/db/migrations/zzzz20260826220000_create_elearning_assessment_catalog'
import {
  appendElearningQuestionRevision,
  createElearningBankQuestion,
  createElearningQuestionBank,
  ElearningAssessmentCatalogError,
  importElearningBankQuestions,
  publishElearningFixedPaper,
  type ElearningAssessmentCatalogDb,
  type ElearningAssessmentCatalogQueryable,
  type ElearningAssessmentQuestionInput,
} from '../../src/services/elearning-assessment-catalog'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning assessment-catalog DB gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
const NS = `el-catalog-${Date.now().toString(36)}`
const MIGRATION_NAME = 'zzzz20260826220000_create_elearning_assessment_catalog'

class ClientDb implements ElearningAssessmentCatalogDb {
  private savepoint = 0

  constructor(private readonly client: PoolClient) {}

  async transaction<T>(
    handler: (tx: ElearningAssessmentCatalogQueryable) => Promise<T>,
  ): Promise<T> {
    const name = `elearning_assessment_catalog_${++this.savepoint}`
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

function question(
  prompt: string,
  correctOptionIds: string[] = ['a'],
): ElearningAssessmentQuestionInput {
  return {
    questionType: correctOptionIds.length > 1 ? 'multiple_choice' : 'single_choice',
    prompt,
    options: [
      { id: 'a', text: 'Alpha' },
      { id: 'b', text: 'Beta' },
      { id: 'c', text: 'Gamma' },
    ],
    correctOptionIds,
    points: 5,
    explanation: 'Internal answer explanation',
  }
}

async function seedBankedQuestion(
  db: ClientDb,
  orgId: string,
  label: string,
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
    question: question(`Question ${label}`),
  })
  return { ...bank, ...revision }
}

afterAll(async () => {
  await pool.end()
})

describe('e-learning L3 assessment catalog', () => {
  it('runs on the named migrated schema with composite constraints and active guards', async () => {
    const migration = await pool.query(
      'SELECT name FROM kysely_migration WHERE name = $1',
      [MIGRATION_NAME],
    )
    expect(migration.rows).toHaveLength(1)

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [[
        ELEARNING_QUESTION_BANKS_TABLE,
        ELEARNING_PAPERS_TABLE,
        ELEARNING_PAPER_QUESTIONS_TABLE,
      ]],
    )
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      ELEARNING_PAPERS_TABLE,
      ELEARNING_PAPER_QUESTIONS_TABLE,
      ELEARNING_QUESTION_BANKS_TABLE,
    ].sort())

    const constraints = await pool.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      [[
        'elearning_questions_question_bank_fk',
        'elearning_paper_questions_paper_fk',
        'elearning_paper_questions_revision_fk',
        'elearning_paper_questions_org_paper_question_uniq',
      ]],
    )
    expect(constraints.rows).toHaveLength(4)
    const byName = new Map(constraints.rows.map((row) => [row.conname, row.definition]))
    expect(byName.get('elearning_questions_question_bank_fk')).toContain(
      'FOREIGN KEY (org_id, question_bank_id)',
    )
    expect(byName.get('elearning_paper_questions_paper_fk')).toContain(
      'FOREIGN KEY (org_id, paper_id)',
    )
    expect(byName.get('elearning_paper_questions_revision_fk')).toContain(
      'FOREIGN KEY (org_id, question_id, question_revision_id)',
    )
    expect(byName.get('elearning_paper_questions_org_paper_question_uniq')).toContain(
      'UNIQUE (org_id, paper_id, question_id)',
    )

    const triggers = await pool.query<{ tgname: string }>(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname = ANY($1::text[])
        ORDER BY tgname`,
      [ELEARNING_ASSESSMENT_CATALOG_TRIGGERS.map((entry) => entry.name)],
    )
    expect(triggers.rows.map((row) => row.tgname)).toEqual(
      ELEARNING_ASSESSMENT_CATALOG_TRIGGERS.map((entry) => entry.name).sort(),
    )
  })

  it('keeps legacy questions unbanked and permits duplicate bank titles', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('legacy')
      const first = await createElearningQuestionBank(db, {
        orgId,
        actorId: actor('legacy-a'),
        title: 'Shared title',
      })
      const second = await createElearningQuestionBank(db, {
        orgId,
        actorId: actor('legacy-b'),
        title: 'Shared title',
      })
      expect(second.bankId).not.toBe(first.bankId)

      const legacyQuestionId = randomUUID()
      await client.query(
        `INSERT INTO elearning_questions (id, org_id, created_by)
         VALUES ($1, $2, $3)`,
        [legacyQuestionId, orgId, actor('legacy-question')],
      )
      const rows = await client.query(
        `SELECT question_bank_id
           FROM elearning_questions
          WHERE org_id = $1 AND id = $2`,
        [orgId, legacyQuestionId],
      )
      expect(rows.rows).toEqual([{ question_bank_id: null }])
      const legacyRevisionId = randomUUID()
      await client.query(
        `INSERT INTO elearning_question_revisions (
           id, org_id, question_id, revision, question_type, prompt, options,
           answer_key, explanation, points, created_by
         ) VALUES (
           $1, $2, $3, 1, 'single_choice', 'Legacy prompt',
           '[{"id":"a","text":"Alpha"},{"id":"b","text":"Beta"}]'::jsonb,
           '{"correct":["a"]}'::jsonb, NULL, 5, $4
         )`,
        [legacyRevisionId, orgId, legacyQuestionId, actor('legacy-question')],
      )
      const legacyPaper = await publishElearningFixedPaper(db, {
        orgId,
        actorId: actor('legacy-paper'),
        title: 'Legacy-compatible paper',
        items: [{ questionRevisionId: legacyRevisionId, points: 5 }],
      })
      expect(legacyPaper).toMatchObject({ status: 'published', itemCount: 1 })
      const count = await client.query(
        `SELECT count(*)::integer AS count
           FROM elearning_question_banks
          WHERE org_id = $1 AND title = 'Shared title'`,
        [orgId],
      )
      expect(count.rows).toEqual([{ count: 2 }])
    })
  })

  it('imports duplicate rows atomically and leaves zero residue for one invalid row', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('import')
      const createdBy = actor('import')
      const bank = await createElearningQuestionBank(db, {
        orgId,
        actorId: createdBy,
        title: 'Imported bank',
      })

      await expect(importElearningBankQuestions(db, {
        orgId,
        actorId: createdBy,
        bankId: bank.bankId,
        questions: [question('Duplicate'), question('Duplicate')],
      })).resolves.toEqual({ importedCount: 2 })
      const imported = await client.query(
        `SELECT count(DISTINCT q.id)::integer AS question_count,
                count(qr.id)::integer AS revision_count
           FROM elearning_questions q
           JOIN elearning_question_revisions qr
             ON qr.org_id = q.org_id AND qr.question_id = q.id
          WHERE q.org_id = $1
            AND q.question_bank_id = $2
            AND q.created_by = $3`,
        [orgId, bank.bankId, createdBy],
      )
      expect(imported.rows).toEqual([{ question_count: 2, revision_count: 2 }])

      await expect(importElearningBankQuestions(db, {
        orgId,
        actorId: createdBy,
        bankId: bank.bankId,
        questions: [question('Would roll back'), { ...question('Invalid'), points: 0 }],
      })).rejects.toMatchObject({ code: 'invalid_input' })
      const afterInvalid = await client.query(
        `SELECT count(*)::integer AS count
           FROM elearning_questions
          WHERE org_id = $1 AND question_bank_id = $2`,
        [orgId, bank.bankId],
      )
      expect(afterInvalid.rows).toEqual([{ count: 2 }])
    })
  })

  it('enforces same-org bank ownership in both the FK and service path', async () => {
    await withRolledBackDb(async (client, db) => {
      const sourceOrg = org('bank-source')
      const otherOrg = org('bank-other')
      const bank = await createElearningQuestionBank(db, {
        orgId: sourceOrg,
        actorId: actor('bank-source'),
        title: 'Source bank',
      })

      await expectSqlState(client, '23503', () => client.query(
        `INSERT INTO elearning_questions
           (id, org_id, question_bank_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), otherOrg, bank.bankId, actor('cross-org')],
      ))
      await expect(createElearningBankQuestion(db, {
        orgId: otherOrg,
        actorId: actor('wrong-org-service'),
        bankId: bank.bankId,
        question: question('Cross-org question'),
      })).rejects.toMatchObject({
        name: 'ElearningAssessmentCatalogError',
        code: 'not_found',
        message: 'not_found',
      })
      await expect(importElearningBankQuestions(db, {
        orgId: otherOrg,
        actorId: actor('wrong-org-import'),
        bankId: bank.bankId,
        questions: [question('Cross-org import')],
      })).rejects.toMatchObject({
        name: 'ElearningAssessmentCatalogError',
        code: 'not_found',
        message: 'not_found',
      })
    })
  })

  it('rejects the deferred random mode and unsupported question types', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('closed-enums')
      await expectSqlState(client, '23514', () => client.query(
        `INSERT INTO elearning_papers
           (id, org_id, title, composition_mode, status, created_by)
         VALUES ($1, $2, 'Deferred random paper', 'random', 'draft', $3)`,
        [randomUUID(), orgId, actor('closed-enums')],
      ))

      const bank = await createElearningQuestionBank(db, {
        orgId,
        actorId: actor('closed-enums'),
        title: 'Closed enum bank',
      })
      await expect(createElearningBankQuestion(db, {
        orgId,
        actorId: actor('closed-enums'),
        bankId: bank.bankId,
        question: {
          ...question('Unsupported question type'),
          questionType: 'essay' as never,
        },
      })).rejects.toMatchObject({
        name: 'ElearningAssessmentCatalogError',
        code: 'invalid_input',
        message: 'invalid_input',
      })
    })
  })

  it('pins revision R1 after R2 is appended and freezes the published paper', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('pin')
      const first = await seedBankedQuestion(db, orgId, 'pin')
      const paper = await publishElearningFixedPaper(db, {
        orgId,
        actorId: actor('paper-pin'),
        title: 'Pinned paper',
        items: [{ questionRevisionId: first.questionRevisionId, points: 7 }],
      })
      expect(paper).toEqual({
        paperId: expect.any(String),
        status: 'published',
        itemCount: 1,
        totalPoints: 7,
      })

      const second = await appendElearningQuestionRevision(db, {
        orgId,
        actorId: actor('revision-two'),
        questionId: first.questionId,
        question: question('Question pin revision two', ['b']),
      })
      expect(second.revision).toBe(2)

      const item = await client.query(
        `SELECT p.status, p.composition_mode, pq.question_id,
                pq.question_revision_id, pq.position, pq.points
           FROM elearning_papers p
           JOIN elearning_paper_questions pq
             ON pq.org_id = p.org_id AND pq.paper_id = p.id
          WHERE p.org_id = $1 AND p.id = $2`,
        [orgId, paper.paperId],
      )
      expect(item.rows).toEqual([{
        status: 'published',
        composition_mode: 'fixed',
        question_id: first.questionId,
        question_revision_id: first.questionRevisionId,
        position: 1,
        points: 7,
      }])

      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_paper_questions
            SET question_revision_id = $1
          WHERE org_id = $2 AND paper_id = $3`,
        [second.questionRevisionId, orgId, paper.paperId],
      ))
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_papers
            SET title = 'Mutated'
          WHERE org_id = $1 AND id = $2`,
        [orgId, paper.paperId],
      ))
      // The pre-existing append-only revision trigger fires before the new
      // paper-item RESTRICT FK. The schema assertion above proves the FK is
      // installed; this negative proves the composed chain still blocks delete.
      await expectSqlState(client, 'P0001', () => client.query(
        `DELETE FROM elearning_question_revisions
          WHERE org_id = $1 AND id = $2`,
        [orgId, first.questionRevisionId],
      ))
      await expectSqlState(client, '23503', () => client.query(
        `DELETE FROM elearning_question_banks
          WHERE org_id = $1 AND id = $2`,
        [orgId, first.bankId],
      ))

      await client.query(
        `UPDATE elearning_papers
            SET status = 'retired', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, paper.paperId],
      )
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_papers
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, paper.paperId],
      ))
    })
  })

  it('rejects cross-org revisions and two revisions of one stable question', async () => {
    await withRolledBackDb(async (client, db) => {
      const sourceOrg = org('paper-source')
      const otherOrg = org('paper-other')
      const first = await seedBankedQuestion(db, sourceOrg, 'paper-source')
      const second = await appendElearningQuestionRevision(db, {
        orgId: sourceOrg,
        actorId: actor('paper-source-r2'),
        questionId: first.questionId,
        question: question('Second revision', ['b']),
      })

      await expect(publishElearningFixedPaper(db, {
        orgId: otherOrg,
        actorId: actor('paper-cross-org'),
        title: 'Cross-org paper',
        items: [{ questionRevisionId: first.questionRevisionId, points: 5 }],
      })).rejects.toMatchObject({ code: 'not_found' })

      await expect(publishElearningFixedPaper(db, {
        orgId: sourceOrg,
        actorId: actor('paper-duplicate-question'),
        title: 'Duplicate stable question',
        items: [
          { questionRevisionId: first.questionRevisionId, points: 5 },
          { questionRevisionId: second.questionRevisionId, points: 5 },
        ],
      })).rejects.toBeInstanceOf(ElearningAssessmentCatalogError)
      await expect(publishElearningFixedPaper(db, {
        orgId: sourceOrg,
        actorId: actor('paper-duplicate-question'),
        title: 'Duplicate stable question',
        items: [
          { questionRevisionId: first.questionRevisionId, points: 5 },
          { questionRevisionId: second.questionRevisionId, points: 5 },
        ],
      })).rejects.toMatchObject({ code: 'invalid_input' })

      const count = await client.query(
        `SELECT count(*)::integer AS count
           FROM elearning_papers
          WHERE org_id = $1`,
        [sourceOrg],
      )
      expect(count.rows).toEqual([{ count: 0 }])
    })
  })

  it('requires dense positions at publish and keeps paper items draft-only', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('dense')
      const first = await seedBankedQuestion(db, orgId, 'dense')
      const paperId = randomUUID()
      await client.query(
        `INSERT INTO elearning_papers
           (id, org_id, title, composition_mode, status, created_by)
         VALUES ($1, $2, 'Dense paper', 'fixed', 'draft', $3)`,
        [paperId, orgId, actor('dense-paper')],
      )
      await client.query(
        `INSERT INTO elearning_paper_questions (
           id, org_id, paper_id, question_id, question_revision_id, position, points
         ) VALUES ($1, $2, $3, $4, $5, 2, 5)`,
        [randomUUID(), orgId, paperId, first.questionId, first.questionRevisionId],
      )
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_papers
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, paperId],
      ))

      await client.query(
        `UPDATE elearning_paper_questions
            SET position = 1
          WHERE org_id = $1 AND paper_id = $2`,
        [orgId, paperId],
      )
      await client.query(
        `UPDATE elearning_papers
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, paperId],
      )
      await expectSqlState(client, 'P0001', () => client.query(
        `DELETE FROM elearning_paper_questions
          WHERE org_id = $1 AND paper_id = $2`,
        [orgId, paperId],
      ))
      await expectSqlState(client, 'P0001', () => client.query(
        `INSERT INTO elearning_paper_questions (
           id, org_id, paper_id, question_id, question_revision_id, position, points
         ) VALUES ($1, $2, $3, $4, $5, 2, 5)`,
        [randomUUID(), orgId, paperId, first.questionId, first.questionRevisionId],
      ))
    })
  })
})

import { randomUUID } from 'node:crypto'
import {
  ElearningExamError,
  validateElearningExamQuestion,
  type ElearningQuestionType,
} from './elearning-exam-domain'

export const ELEARNING_ASSESSMENT_TITLE_MAX = 200
export const ELEARNING_ASSESSMENT_ACTOR_MAX = 256
export const ELEARNING_ASSESSMENT_PROMPT_MAX = 2000
export const ELEARNING_ASSESSMENT_OPTION_ID_MAX = 64
export const ELEARNING_ASSESSMENT_OPTION_TEXT_MAX = 500
export const ELEARNING_ASSESSMENT_EXPLANATION_MAX = 2000
export const ELEARNING_ASSESSMENT_OPTION_MAX = 20
export const ELEARNING_ASSESSMENT_IMPORT_MAX = 500
export const ELEARNING_FIXED_PAPER_ITEM_MAX = 200

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PG_INT32_MAX = 2147483647

const BANK_KEYS = ['orgId', 'actorId', 'title'] as const
const CREATE_QUESTION_KEYS = ['orgId', 'actorId', 'bankId', 'question'] as const
const IMPORT_QUESTIONS_KEYS = ['orgId', 'actorId', 'bankId', 'questions'] as const
const APPEND_REVISION_KEYS = ['orgId', 'actorId', 'questionId', 'question'] as const
const PAPER_KEYS = ['orgId', 'actorId', 'title', 'items'] as const
const PAPER_ITEM_KEYS = ['questionRevisionId', 'points'] as const
const QUESTION_KEYS = [
  'questionType',
  'prompt',
  'options',
  'correctOptionIds',
  'points',
] as const
const QUESTION_OPTIONAL_KEYS = ['explanation'] as const
const OPTION_KEYS = ['id', 'text'] as const

export type ElearningAssessmentCatalogErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'unavailable'

export class ElearningAssessmentCatalogError extends Error {
  constructor(readonly code: ElearningAssessmentCatalogErrorCode) {
    super(code)
    this.name = 'ElearningAssessmentCatalogError'
  }
}

export interface ElearningAssessmentCatalogQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningAssessmentCatalogDb {
  transaction<T>(
    handler: (tx: ElearningAssessmentCatalogQueryable) => Promise<T>,
  ): Promise<T>
}

export interface ElearningAssessmentOption {
  id: string
  text: string
}

export interface ElearningAssessmentQuestionInput {
  questionType: ElearningQuestionType
  prompt: string
  options: ElearningAssessmentOption[]
  correctOptionIds: string[]
  points: number
  explanation?: string | null
}

export interface CreateElearningQuestionBankInput {
  orgId: string
  actorId: string
  title: string
}

export interface CreateElearningBankQuestionInput {
  orgId: string
  actorId: string
  bankId: string
  question: ElearningAssessmentQuestionInput
}

export interface ImportElearningBankQuestionsInput {
  orgId: string
  actorId: string
  bankId: string
  questions: ElearningAssessmentQuestionInput[]
}

export interface AppendElearningQuestionRevisionInput {
  orgId: string
  actorId: string
  questionId: string
  question: ElearningAssessmentQuestionInput
}

export interface PublishElearningFixedPaperItem {
  questionRevisionId: string
  points: number
}

export interface PublishElearningFixedPaperInput {
  orgId: string
  actorId: string
  title: string
  items: PublishElearningFixedPaperItem[]
}

export interface ElearningQuestionBankResult {
  bankId: string
}

export interface ElearningQuestionRevisionResult {
  questionId: string
  questionRevisionId: string
  revision: number
}

export interface ElearningQuestionImportResult {
  importedCount: number
}

export interface ElearningFixedPaperResult {
  paperId: string
  status: 'published'
  itemCount: number
  totalPoints: number
}

interface CanonicalQuestion {
  questionType: ElearningQuestionType
  prompt: string
  options: ElearningAssessmentOption[]
  correctOptionIds: string[]
  points: number
  explanation: string | null
}

interface CanonicalPaperItem {
  questionRevisionId: string
  points: number
}

function fail(code: ElearningAssessmentCatalogErrorCode): never {
  throw new ElearningAssessmentCatalogError(code)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('invalid_input')
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail('invalid_input')
  }
}

function requireText(value: unknown, max: number): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function requireInt(value: unknown, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > PG_INT32_MAX) {
    fail('invalid_input')
  }
  return value as number
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asSafeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null
    }
    return Number(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function canonicalizeQuestion(value: unknown): CanonicalQuestion {
  if (!isPlainObject(value)) fail('invalid_input')
  requireExactKeys(value, QUESTION_KEYS, QUESTION_OPTIONAL_KEYS)
  const questionType = value.questionType
  if (
    questionType !== 'single_choice'
    && questionType !== 'multiple_choice'
    && questionType !== 'true_false'
    && questionType !== 'short_answer'
  ) {
    fail('invalid_input')
  }
  const prompt = requireText(value.prompt, ELEARNING_ASSESSMENT_PROMPT_MAX)
  const points = requireInt(value.points, 1)
  if (!Array.isArray(value.options) || value.options.length > ELEARNING_ASSESSMENT_OPTION_MAX) {
    fail('invalid_input')
  }
  if (questionType === 'short_answer') {
    if (value.options.length !== 0) fail('invalid_input')
  } else if (questionType === 'true_false') {
    if (value.options.length !== 2) fail('invalid_input')
  } else if (value.options.length < 2) {
    fail('invalid_input')
  }
  const options: ElearningAssessmentOption[] = []
  const optionIds = new Set<string>()
  for (const raw of value.options) {
    if (!isPlainObject(raw)) fail('invalid_input')
    requireExactKeys(raw, OPTION_KEYS)
    const id = requireText(raw.id, ELEARNING_ASSESSMENT_OPTION_ID_MAX)
    const text = requireText(raw.text, ELEARNING_ASSESSMENT_OPTION_TEXT_MAX)
    if (optionIds.has(id)) fail('invalid_input')
    optionIds.add(id)
    options.push({ id, text })
  }
  if (!Array.isArray(value.correctOptionIds)) {
    fail('invalid_input')
  }
  if (
    questionType === 'short_answer'
      ? value.correctOptionIds.length !== 0
      : value.correctOptionIds.length < 1
  ) {
    fail('invalid_input')
  }
  const correctOptionIds: string[] = []
  const seenCorrect = new Set<string>()
  for (const raw of value.correctOptionIds) {
    const id = requireText(raw, ELEARNING_ASSESSMENT_OPTION_ID_MAX)
    if (!optionIds.has(id) || seenCorrect.has(id)) fail('invalid_input')
    seenCorrect.add(id)
    correctOptionIds.push(id)
  }
  if (
    questionType !== 'short_answer'
    && questionType !== 'multiple_choice'
    && correctOptionIds.length !== 1
  ) {
    fail('invalid_input')
  }
  let explanation: string | null = null
  if (value.explanation != null) {
    explanation = requireText(value.explanation, ELEARNING_ASSESSMENT_EXPLANATION_MAX)
  }

  const canonical: CanonicalQuestion = {
    questionType,
    prompt,
    options,
    correctOptionIds: [...correctOptionIds].sort(),
    points,
    explanation,
  }
  try {
    validateElearningExamQuestion({
      position: 1,
      points: canonical.points,
      questionRevisionId: randomUUID(),
      questionId: randomUUID(),
      questionType: canonical.questionType,
      prompt: canonical.prompt,
      options: canonical.options,
      answerKey:
        canonical.questionType === 'short_answer'
          ? {}
          : { correct: canonical.correctOptionIds },
      explanation: canonical.explanation,
    })
  } catch (error) {
    if (error instanceof ElearningExamError) fail('invalid_input')
    throw error
  }
  return canonical
}

async function runValuesFree<T>(handler: () => Promise<T>): Promise<T> {
  try {
    return await handler()
  } catch (error) {
    if (error instanceof ElearningAssessmentCatalogError) throw error
    throw new ElearningAssessmentCatalogError('unavailable')
  }
}

async function insertBankQuestionRevision(
  tx: ElearningAssessmentCatalogQueryable,
  input: {
    orgId: string
    actorId: string
    bankId: string
    question: CanonicalQuestion
  },
): Promise<ElearningQuestionRevisionResult> {
  const questionId = randomUUID()
  const questionRevisionId = randomUUID()
  await tx.query(
    `/* elearning-assessment-catalog:create-question */
     INSERT INTO elearning_questions
       (id, org_id, question_bank_id, created_by)
     VALUES ($1, $2, $3, $4)`,
    [questionId, input.orgId, input.bankId, input.actorId],
  )
  await tx.query(
    `/* elearning-assessment-catalog:create-revision */
     INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt, options,
       answer_key, explanation, points, created_by
     ) VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      questionRevisionId,
      input.orgId,
      questionId,
      input.question.questionType,
      input.question.prompt,
      JSON.stringify(input.question.options),
      JSON.stringify(
        input.question.questionType === 'short_answer'
          ? {}
          : { correct: input.question.correctOptionIds },
      ),
      input.question.explanation,
      input.question.points,
      input.actorId,
    ],
  )
  return { questionId, questionRevisionId, revision: 1 }
}

export async function createElearningQuestionBank(
  db: ElearningAssessmentCatalogDb,
  input: CreateElearningQuestionBankInput,
): Promise<ElearningQuestionBankResult> {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, BANK_KEYS)
  const orgId = requireText(input.orgId, ELEARNING_ASSESSMENT_ACTOR_MAX)
  const actorId = requireText(input.actorId, ELEARNING_ASSESSMENT_ACTOR_MAX)
  const title = requireText(input.title, ELEARNING_ASSESSMENT_TITLE_MAX)
  const bankId = randomUUID()

  return runValuesFree(() => db.transaction(async (tx) => {
    await tx.query(
      `/* elearning-assessment-catalog:create-bank */
       INSERT INTO elearning_question_banks (id, org_id, title, created_by)
       VALUES ($1, $2, $3, $4)`,
      [bankId, orgId, title, actorId],
    )
    return { bankId }
  }))
}

export async function createElearningBankQuestion(
  db: ElearningAssessmentCatalogDb,
  input: CreateElearningBankQuestionInput,
): Promise<ElearningQuestionRevisionResult> {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, CREATE_QUESTION_KEYS)
  const orgId = requireText(input.orgId, ELEARNING_ASSESSMENT_ACTOR_MAX)
  const actorId = requireText(input.actorId, ELEARNING_ASSESSMENT_ACTOR_MAX)
  const bankId = requireUuid(input.bankId)
  const question = canonicalizeQuestion(input.question)

  return runValuesFree(() => db.transaction(async (tx) => {
    const bank = await tx.query(
      `/* elearning-assessment-catalog:load-bank */
       SELECT id
         FROM elearning_question_banks
        WHERE org_id = $1
          AND id = $2
        FOR SHARE`,
      [orgId, bankId],
    )
    if (bank.rows.length !== 1) fail('not_found')
    return insertBankQuestionRevision(tx, { orgId, actorId, bankId, question })
  }))
}

export async function importElearningBankQuestions(
  db: ElearningAssessmentCatalogDb,
  input: ImportElearningBankQuestionsInput,
): Promise<ElearningQuestionImportResult> {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, IMPORT_QUESTIONS_KEYS)
  const orgId = requireText(input.orgId, ELEARNING_ASSESSMENT_ACTOR_MAX)
  const actorId = requireText(input.actorId, ELEARNING_ASSESSMENT_ACTOR_MAX)
  const bankId = requireUuid(input.bankId)
  if (
    !Array.isArray(input.questions)
    || input.questions.length < 1
    || input.questions.length > ELEARNING_ASSESSMENT_IMPORT_MAX
  ) {
    fail('invalid_input')
  }
  const questions = input.questions.map(canonicalizeQuestion)

  return runValuesFree(() => db.transaction(async (tx) => {
    const bank = await tx.query(
      `/* elearning-assessment-catalog:load-import-bank */
       SELECT id
         FROM elearning_question_banks
        WHERE org_id = $1
          AND id = $2
        FOR SHARE`,
      [orgId, bankId],
    )
    if (bank.rows.length !== 1) fail('not_found')
    for (const question of questions) {
      await insertBankQuestionRevision(tx, {
        orgId,
        actorId,
        bankId,
        question,
      })
    }
    return { importedCount: questions.length }
  }))
}

export async function appendElearningQuestionRevision(
  db: ElearningAssessmentCatalogDb,
  input: AppendElearningQuestionRevisionInput,
): Promise<ElearningQuestionRevisionResult> {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, APPEND_REVISION_KEYS)
  const orgId = requireText(input.orgId, ELEARNING_ASSESSMENT_ACTOR_MAX)
  const actorId = requireText(input.actorId, ELEARNING_ASSESSMENT_ACTOR_MAX)
  const questionId = requireUuid(input.questionId)
  const question = canonicalizeQuestion(input.question)
  const questionRevisionId = randomUUID()

  return runValuesFree(() => db.transaction(async (tx) => {
    const locked = await tx.query(
      `/* elearning-assessment-catalog:lock-question */
       SELECT id
         FROM elearning_questions
        WHERE org_id = $1
          AND id = $2
        FOR UPDATE`,
      [orgId, questionId],
    )
    if (locked.rows.length !== 1) fail('not_found')
    const latest = await tx.query(
      `/* elearning-assessment-catalog:latest-revision */
       SELECT max(revision) AS latest_revision
         FROM elearning_question_revisions
        WHERE org_id = $1
          AND question_id = $2`,
      [orgId, questionId],
    )
    const latestRevision = asSafeInt(latest.rows[0]?.latest_revision)
    if (latestRevision === null || latestRevision < 1 || latestRevision >= PG_INT32_MAX) {
      fail('unavailable')
    }
    const revision = latestRevision + 1
    await tx.query(
      `/* elearning-assessment-catalog:append-revision */
       INSERT INTO elearning_question_revisions (
         id, org_id, question_id, revision, question_type, prompt, options,
         answer_key, explanation, points, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)`,
      [
        questionRevisionId,
        orgId,
        questionId,
        revision,
        question.questionType,
        question.prompt,
        JSON.stringify(question.options),
        JSON.stringify(
          question.questionType === 'short_answer'
            ? {}
            : { correct: question.correctOptionIds },
        ),
        question.explanation,
        question.points,
        actorId,
      ],
    )
    return { questionId, questionRevisionId, revision }
  }))
}

export async function publishElearningFixedPaper(
  db: ElearningAssessmentCatalogDb,
  input: PublishElearningFixedPaperInput,
): Promise<ElearningFixedPaperResult> {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, PAPER_KEYS)
  const orgId = requireText(input.orgId, ELEARNING_ASSESSMENT_ACTOR_MAX)
  const actorId = requireText(input.actorId, ELEARNING_ASSESSMENT_ACTOR_MAX)
  const title = requireText(input.title, ELEARNING_ASSESSMENT_TITLE_MAX)
  if (
    !Array.isArray(input.items)
    || input.items.length < 1
    || input.items.length > ELEARNING_FIXED_PAPER_ITEM_MAX
  ) {
    fail('invalid_input')
  }
  const revisionIds = new Set<string>()
  const items: CanonicalPaperItem[] = input.items.map((raw) => {
    if (!isPlainObject(raw)) fail('invalid_input')
    requireExactKeys(raw, PAPER_ITEM_KEYS)
    const questionRevisionId = requireUuid(raw.questionRevisionId)
    const points = requireInt(raw.points, 0)
    if (revisionIds.has(questionRevisionId)) fail('invalid_input')
    revisionIds.add(questionRevisionId)
    return { questionRevisionId, points }
  })
  const totalPoints = items.reduce((sum, item) => sum + item.points, 0)
  if (!Number.isSafeInteger(totalPoints) || totalPoints < 1) fail('invalid_input')
  const paperId = randomUUID()

  return runValuesFree(() => db.transaction(async (tx) => {
    const revisions = await tx.query(
      `/* elearning-assessment-catalog:load-paper-revisions */
       SELECT id, question_id
         FROM elearning_question_revisions
        WHERE org_id = $1
          AND id = ANY($2::uuid[])
        FOR SHARE`,
      [orgId, items.map((item) => item.questionRevisionId)],
    )
    if (revisions.rows.length !== items.length) fail('not_found')
    const questionByRevision = new Map<string, string>()
    const questionIds = new Set<string>()
    for (const row of revisions.rows) {
      const revisionId = asText(row.id)
      const questionId = asText(row.question_id)
      if (!revisionId || !questionId || questionByRevision.has(revisionId)) fail('unavailable')
      if (questionIds.has(questionId)) fail('invalid_input')
      questionByRevision.set(revisionId, questionId)
      questionIds.add(questionId)
    }

    await tx.query(
      `/* elearning-assessment-catalog:create-paper */
       INSERT INTO elearning_papers
         (id, org_id, title, composition_mode, status, created_by)
       VALUES ($1, $2, $3, 'fixed', 'draft', $4)`,
      [paperId, orgId, title, actorId],
    )
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const questionId = questionByRevision.get(item.questionRevisionId)
      if (!questionId) fail('unavailable')
      await tx.query(
        `/* elearning-assessment-catalog:create-paper-question */
         INSERT INTO elearning_paper_questions (
           id, org_id, paper_id, question_id, question_revision_id, position, points
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          orgId,
          paperId,
          questionId,
          item.questionRevisionId,
          index + 1,
          item.points,
        ],
      )
    }
    const published = await tx.query(
      `/* elearning-assessment-catalog:publish-paper */
       UPDATE elearning_papers
          SET status = 'published', updated_at = now()
        WHERE org_id = $1
          AND id = $2
          AND status = 'draft'
      RETURNING id`,
      [orgId, paperId],
    )
    if (published.rows.length !== 1) fail('unavailable')
    return {
      paperId,
      status: 'published',
      itemCount: items.length,
      totalPoints,
    }
  }))
}

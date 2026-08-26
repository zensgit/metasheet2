import {
  ElearningAssessmentCatalogError,
  type ElearningAssessmentCatalogDb,
  type ElearningAssessmentOption,
} from './elearning-assessment-catalog'
import {
  validateElearningObjectiveQuestion,
  type ElearningQuestionType,
} from './elearning-exam-domain'

export const ELEARNING_ASSESSMENT_PAGE_DEFAULT = 1
export const ELEARNING_ASSESSMENT_PAGE_MAX = 1_000_000
export const ELEARNING_ASSESSMENT_PAGE_SIZE_DEFAULT = 50
export const ELEARNING_ASSESSMENT_PAGE_SIZE_MAX = 100

const PG_INT32_MAX = 2_147_483_647
const LIST_BANK_KEYS = ['orgId', 'page', 'pageSize'] as const
const LIST_QUESTION_KEYS = ['orgId', 'bankId', 'page', 'pageSize'] as const
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ListElearningQuestionBanksInput {
  orgId: string
  page: number
  pageSize: number
}

export interface ListElearningBankQuestionsInput
  extends ListElearningQuestionBanksInput {
  bankId: string
}

export interface ElearningQuestionBankListItem {
  bankId: string
  title: string
  questionCount: number
  createdAt: string
  updatedAt: string
}

export interface ElearningQuestionBankListResult {
  items: ElearningQuestionBankListItem[]
  page: number
  pageSize: number
  total: number
}

export interface ElearningQuestionBankSummary {
  bankId: string
  title: string
}

export interface ElearningQuestionLatestRevision {
  questionId: string
  questionRevisionId: string
  revision: number
  questionType: ElearningQuestionType
  prompt: string
  options: ElearningAssessmentOption[]
  correctOptionIds: string[]
  points: number
  explanation: string | null
  createdAt: string
}

export interface ElearningQuestionBankQuestionsResult {
  bank: ElearningQuestionBankSummary
  items: ElearningQuestionLatestRevision[]
  page: number
  pageSize: number
  total: number
}

function fail(code: 'invalid_input' | 'not_found' | 'unavailable'): never {
  throw new ElearningAssessmentCatalogError(code)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): void {
  const keys = Object.keys(value)
  if (
    keys.length !== required.length
    || keys.some((key) => !required.includes(key))
  ) {
    fail('invalid_input')
  }
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '') fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function requirePage(value: unknown): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > ELEARNING_ASSESSMENT_PAGE_MAX
  ) {
    fail('invalid_input')
  }
  return value as number
}

function requirePageSize(value: unknown): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > ELEARNING_ASSESSMENT_PAGE_SIZE_MAX
  ) {
    fail('invalid_input')
  }
  return value as number
}

function pagination(pageValue: unknown, pageSizeValue: unknown): {
  page: number
  pageSize: number
  offset: number
} {
  const page = requirePage(pageValue)
  const pageSize = requirePageSize(pageSizeValue)
  const offset = (page - 1) * pageSize
  if (!Number.isSafeInteger(offset) || offset > PG_INT32_MAX) fail('invalid_input')
  return { page, pageSize, offset }
}

function asText(value: unknown): string {
  if (typeof value !== 'string' || value === '') fail('unavailable')
  return value
}

function asUuid(value: unknown): string {
  const text = asText(value)
  if (!UUID_RE.test(text)) fail('unavailable')
  return text.toLowerCase()
}

function asSafeInt(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('unavailable')
    return Number(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  fail('unavailable')
}

function asTimestamp(value: unknown): string {
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === 'string'
      ? new Date(value)
      : null
  if (!parsed || !Number.isFinite(parsed.getTime())) fail('unavailable')
  return parsed.toISOString()
}

function bankItem(row: Record<string, unknown>): ElearningQuestionBankListItem {
  return {
    bankId: asUuid(row.id),
    title: asText(row.title),
    questionCount: asSafeInt(row.question_count),
    createdAt: asTimestamp(row.created_at),
    updatedAt: asTimestamp(row.updated_at),
  }
}

function latestQuestion(row: Record<string, unknown>): ElearningQuestionLatestRevision {
  const questionId = asUuid(row.question_id)
  const questionRevisionId = asUuid(row.question_revision_id)
  const validated = validateElearningObjectiveQuestion({
    position: 1,
    questionId,
    questionRevisionId,
    questionType: row.question_type,
    prompt: row.prompt,
    options: row.options,
    answerKey: row.answer_key,
    explanation: row.explanation,
    points: row.points,
  }, 'unavailable')
  return {
    questionId,
    questionRevisionId,
    revision: asSafeInt(row.revision),
    questionType: validated.questionType,
    prompt: validated.prompt,
    options: validated.options.map((option) => ({
      id: option.id,
      text: option.text,
    })),
    correctOptionIds: [...validated.answerKey.correct],
    points: validated.points,
    explanation: validated.explanation,
    createdAt: asTimestamp(row.created_at),
  }
}

async function runValuesFree<T>(handler: () => Promise<T>): Promise<T> {
  try {
    return await handler()
  } catch (error) {
    if (error instanceof ElearningAssessmentCatalogError) throw error
    throw new ElearningAssessmentCatalogError('unavailable')
  }
}

export async function listElearningQuestionBanks(
  db: ElearningAssessmentCatalogDb,
  input: ListElearningQuestionBanksInput,
): Promise<ElearningQuestionBankListResult> {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, LIST_BANK_KEYS)
  const orgId = requireText(input.orgId)
  const { page, pageSize, offset } = pagination(input.page, input.pageSize)

  return runValuesFree(() => db.transaction(async (tx) => {
    const totals = await tx.query(
      `/* elearning-assessment-catalog-read:count-banks */
       SELECT count(*)::integer AS total
         FROM elearning_question_banks
        WHERE org_id = $1`,
      [orgId],
    )
    const total = asSafeInt(totals.rows[0]?.total)
    const listed = await tx.query(
      `/* elearning-assessment-catalog-read:list-banks */
       SELECT b.id, b.title, b.created_at, b.updated_at,
              count(q.id)::integer AS question_count
         FROM elearning_question_banks b
         LEFT JOIN elearning_questions q
           ON q.org_id = b.org_id AND q.question_bank_id = b.id
        WHERE b.org_id = $1
        GROUP BY b.id, b.title, b.created_at, b.updated_at
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT $2 OFFSET $3`,
      [orgId, pageSize, offset],
    )
    return {
      items: listed.rows.map(bankItem),
      page,
      pageSize,
      total,
    }
  }))
}

export async function listElearningBankQuestions(
  db: ElearningAssessmentCatalogDb,
  input: ListElearningBankQuestionsInput,
): Promise<ElearningQuestionBankQuestionsResult> {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, LIST_QUESTION_KEYS)
  const orgId = requireText(input.orgId)
  const bankId = requireUuid(input.bankId)
  const { page, pageSize, offset } = pagination(input.page, input.pageSize)

  return runValuesFree(() => db.transaction(async (tx) => {
    const bank = await tx.query(
      `/* elearning-assessment-catalog-read:load-bank */
       SELECT id, title
         FROM elearning_question_banks
        WHERE org_id = $1 AND id = $2`,
      [orgId, bankId],
    )
    if (bank.rows.length !== 1) fail('not_found')
    const totals = await tx.query(
      `/* elearning-assessment-catalog-read:count-questions */
       SELECT count(*)::integer AS total
         FROM elearning_questions
        WHERE org_id = $1 AND question_bank_id = $2`,
      [orgId, bankId],
    )
    const total = asSafeInt(totals.rows[0]?.total)
    const listed = await tx.query(
      `/* elearning-assessment-catalog-read:list-latest-questions */
       SELECT q.id AS question_id,
              latest.id AS question_revision_id,
              latest.revision,
              latest.question_type,
              latest.prompt,
              latest.options,
              latest.answer_key,
              latest.explanation,
              latest.points,
              latest.created_at
         FROM elearning_questions q
         JOIN LATERAL (
           SELECT qr.id, qr.revision, qr.question_type, qr.prompt, qr.options,
                  qr.answer_key, qr.explanation, qr.points, qr.created_at
             FROM elearning_question_revisions qr
            WHERE qr.org_id = q.org_id AND qr.question_id = q.id
            ORDER BY qr.revision DESC, qr.id DESC
            LIMIT 1
         ) latest ON TRUE
        WHERE q.org_id = $1 AND q.question_bank_id = $2
        ORDER BY q.created_at ASC, q.id ASC
        LIMIT $3 OFFSET $4`,
      [orgId, bankId, pageSize, offset],
    )
    const bankRow = bank.rows[0]
    return {
      bank: {
        bankId: asUuid(bankRow.id),
        title: asText(bankRow.title),
      },
      items: listed.rows.map(latestQuestion),
      page,
      pageSize,
      total,
    }
  }))
}

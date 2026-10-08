import { randomUUID } from 'node:crypto'

export const ELEARNING_PAPER_EXAM_TITLE_MAX = 200
export const ELEARNING_PAPER_EXAM_ACTOR_MAX = 256
export const ELEARNING_EXAM_DISCLOSURE_POLICIES = [
  'no_review',
  'correctness_after_submit',
  'wrong_items_after_submit',
  'correctness_after_window',
] as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const PG_INT32_MAX = 2147483647

const CREATE_KEYS = [
  'orgId',
  'actorId',
  'paperId',
  'title',
  'passScore',
  'maxAttempts',
  'windowStartsAt',
  'windowEndsAt',
  'durationSeconds',
  'shuffleQuestions',
  'shuffleOptions',
  'disclosurePolicy',
] as const

export type ElearningExamDisclosurePolicy =
  (typeof ELEARNING_EXAM_DISCLOSURE_POLICIES)[number]

export type ElearningPaperExamErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'unavailable'

export class ElearningPaperExamError extends Error {
  constructor(readonly code: ElearningPaperExamErrorCode) {
    super(code)
    this.name = 'ElearningPaperExamError'
  }
}

export interface ElearningPaperExamQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningPaperExamDb {
  transaction<T>(
    handler: (tx: ElearningPaperExamQueryable) => Promise<T>,
  ): Promise<T>
}

export interface PublishElearningPaperExamInput {
  orgId: string
  actorId: string
  paperId: string
  title: string
  passScore: number
  maxAttempts: number
  windowStartsAt: string | null
  windowEndsAt: string | null
  durationSeconds: number | null
  shuffleQuestions: boolean
  shuffleOptions: boolean
  disclosurePolicy: ElearningExamDisclosurePolicy
}

export interface ElearningPaperExamResult {
  examId: string
  paperId: string
  status: 'published'
  totalPoints: number
}

interface CanonicalPaperExam {
  orgId: string
  actorId: string
  paperId: string
  title: string
  passScore: number
  maxAttempts: number
  windowStartsAt: string | null
  windowEndsAt: string | null
  durationSeconds: number | null
  shuffleQuestions: boolean
  shuffleOptions: boolean
  disclosurePolicy: ElearningExamDisclosurePolicy
}

function fail(code: ElearningPaperExamErrorCode): never {
  throw new ElearningPaperExamError(code)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): void {
  const allowed = new Set(required)
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
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > PG_INT32_MAX
  ) {
    fail('invalid_input')
  }
  return value as number
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('invalid_input')
  return value
}

function requireNullableTimestamp(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !RFC3339_RE.test(value))
    fail('invalid_input')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) fail('invalid_input')
  return parsed.toISOString()
}

function requireDisclosurePolicy(
  value: unknown,
): ElearningExamDisclosurePolicy {
  if (
    typeof value !== 'string' ||
    !ELEARNING_EXAM_DISCLOSURE_POLICIES.includes(
      value as ElearningExamDisclosurePolicy,
    )
  ) {
    fail('invalid_input')
  }
  return value as ElearningExamDisclosurePolicy
}

function canonicalize(
  input: PublishElearningPaperExamInput,
): CanonicalPaperExam {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, CREATE_KEYS)
  const windowStartsAt = requireNullableTimestamp(input.windowStartsAt)
  const windowEndsAt = requireNullableTimestamp(input.windowEndsAt)
  if ((windowStartsAt === null) !== (windowEndsAt === null))
    fail('invalid_input')
  if (
    windowStartsAt !== null &&
    windowEndsAt !== null &&
    Date.parse(windowStartsAt) >= Date.parse(windowEndsAt)
  ) {
    fail('invalid_input')
  }
  const durationSeconds =
    input.durationSeconds === null ? null : requireInt(input.durationSeconds, 1)
  const disclosurePolicy = requireDisclosurePolicy(input.disclosurePolicy)
  if (
    disclosurePolicy === 'correctness_after_window' &&
    windowEndsAt === null
  ) {
    fail('invalid_input')
  }

  return {
    orgId: requireText(input.orgId, ELEARNING_PAPER_EXAM_ACTOR_MAX),
    actorId: requireText(input.actorId, ELEARNING_PAPER_EXAM_ACTOR_MAX),
    paperId: requireUuid(input.paperId),
    title: requireText(input.title, ELEARNING_PAPER_EXAM_TITLE_MAX),
    passScore: requireInt(input.passScore, 0),
    maxAttempts: requireInt(input.maxAttempts, 1),
    windowStartsAt,
    windowEndsAt,
    durationSeconds,
    shuffleQuestions: requireBoolean(input.shuffleQuestions),
    shuffleOptions: requireBoolean(input.shuffleOptions),
    disclosurePolicy,
  }
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asSafeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint') {
    if (
      value < BigInt(Number.MIN_SAFE_INTEGER) ||
      value > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
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

async function runValuesFree<T>(handler: () => Promise<T>): Promise<T> {
  try {
    return await handler()
  } catch (error) {
    if (error instanceof ElearningPaperExamError) throw error
    throw new ElearningPaperExamError('unavailable')
  }
}

/**
 * Creates and publishes one fixed-paper exam atomically.
 *
 * A published paper is itself the immutable content version: paper items and
 * their pinned question revisions cannot change after publication. Retiring
 * that paper later stops new bindings but does not invalidate this exam.
 */
export async function publishElearningPaperExam(
  db: ElearningPaperExamDb,
  input: PublishElearningPaperExamInput,
): Promise<ElearningPaperExamResult> {
  const canonical = canonicalize(input)
  const examId = randomUUID()

  return runValuesFree(() =>
    db.transaction(async (tx) => {
      const paper = await tx.query(
        `/* elearning-paper-exam:lock-paper */
       SELECT id, status
         FROM elearning_papers
        WHERE org_id = $1 AND id = $2
        FOR SHARE`,
        [canonical.orgId, canonical.paperId],
      )
      const paperRow = paper.rows[0]
      if (!paperRow || asText(paperRow.status) !== 'published')
        fail('not_found')

      const totals = await tx.query(
        `/* elearning-paper-exam:paper-total */
       SELECT count(*)::integer AS item_count,
              COALESCE(sum(points), 0)::text AS total_points
         FROM elearning_paper_questions
        WHERE org_id = $1 AND paper_id = $2`,
        [canonical.orgId, canonical.paperId],
      )
      const totalRow = totals.rows[0]
      const itemCount = asSafeInt(totalRow?.item_count)
      const totalPoints = asSafeInt(totalRow?.total_points)
      if (
        itemCount === null ||
        totalPoints === null ||
        itemCount < 1 ||
        totalPoints < 1
      ) {
        fail('unavailable')
      }
      if (canonical.passScore > totalPoints) fail('invalid_input')

      await tx.query(
        `/* elearning-paper-exam:create */
       INSERT INTO elearning_exams (
         id, org_id, title, status, pass_score, max_attempts, created_by,
         paper_id, window_starts_at, window_ends_at, duration_seconds,
         shuffle_questions, shuffle_options, disclosure_policy
       ) VALUES (
         $1, $2, $3, 'draft', $4, $5, $6,
         $7, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13
       )`,
        [
          examId,
          canonical.orgId,
          canonical.title,
          canonical.passScore,
          canonical.maxAttempts,
          canonical.actorId,
          canonical.paperId,
          canonical.windowStartsAt,
          canonical.windowEndsAt,
          canonical.durationSeconds,
          canonical.shuffleQuestions,
          canonical.shuffleOptions,
          canonical.disclosurePolicy,
        ],
      )
      const published = await tx.query(
        `/* elearning-paper-exam:publish */
       UPDATE elearning_exams
          SET status = 'published', updated_at = clock_timestamp()
        WHERE org_id = $1 AND id = $2 AND status = 'draft'`,
        [canonical.orgId, examId],
      )
      if (published.rowCount !== 1) fail('unavailable')

      return {
        examId,
        paperId: canonical.paperId,
        status: 'published' as const,
        totalPoints,
      }
    }),
  )
}

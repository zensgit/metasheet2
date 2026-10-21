import { randomUUID } from 'node:crypto'

import {
  ELEARNING_ASSESSMENT_ENABLED,
  isElearningEnabled,
  isElearningFlagEnabled,
} from '../elearning/feature-flags'
import {
  ELEARNING_PRACTICE_MAX_QUESTIONS,
  ELEARNING_PRACTICE_REQUEST_HASH_VERSION,
  ElearningPracticeError,
  hashElearningPracticeRequest,
  isElearningPracticeAnswerCorrect,
  normalizePracticeMode,
  normalizePracticeSelectedOptionIds,
  orderElearningPracticeQuestions,
  parseElearningPracticeStoredQuestion,
  publicElearningPracticeQuestion,
  requirePracticeText,
  requirePracticeUuid,
  type ElearningPracticeMode,
  type ElearningPracticeQuestion,
  type ElearningPracticeStoredQuestion,
} from './elearning-question-practice'

export interface ElearningPracticeQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningPracticeDb extends ElearningPracticeQueryable {
  transaction<T>(handler: (tx: ElearningPracticeQueryable) => Promise<T>): Promise<T>
}

export interface ElearningPracticeSet {
  practiceSetId: string
  paperId: string
  title: string
  status: 'active'
  createdAt: string
}

export interface ElearningPracticeSession {
  sessionId: string
  practiceSetId: string
  mode: ElearningPracticeMode
  questions: ElearningPracticeQuestion[]
  createdAt: string
}

export interface ElearningPracticeAnswerResult {
  answerId: string
  sessionId: string
  questionRevisionId: string
  correct: boolean
  wrongState: 'wrong' | 'resolved' | 'unchanged'
  createdAt: string
}

export interface CreateElearningPracticeSetInput {
  orgId: string
  actorId: string
  requestId: unknown
  paperId: unknown
  title: unknown
}

export interface StartElearningPracticeSessionInput {
  orgId: string
  userId: string
  requestId: unknown
  practiceSetId: unknown
  mode: unknown
}

export interface SubmitElearningPracticeAnswerInput {
  orgId: string
  userId: string
  requestId: unknown
  sessionId: unknown
  questionRevisionId: unknown
  selectedOptionIds: unknown
}

function fail(code: ConstructorParameters<typeof ElearningPracticeError>[0]): never {
  throw new ElearningPracticeError(code)
}

export function isElearningPracticeSurfaceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isElearningEnabled(env)
    && isElearningFlagEnabled(ELEARNING_ASSESSMENT_ENABLED, env)
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') fail('unavailable')
  return value
}

function integer(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value)
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed)) fail('unavailable')
  return parsed
}

function date(value: unknown): string {
  const parsed = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null
  if (!parsed || !Number.isFinite(parsed.getTime())) fail('unavailable')
  return parsed.toISOString()
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('unavailable')
  return value
}

async function advisoryLock(
  tx: ElearningPracticeQueryable,
  domain: string,
  identity: string,
): Promise<void> {
  await tx.query(
    `/* elearning-practice:advisory-lock */
     SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
    [domain, identity],
  )
}

async function requireActiveMember(
  tx: ElearningPracticeQueryable,
  orgId: string,
  userId: string,
): Promise<void> {
  const result = await tx.query(
    `/* elearning-practice:membership */
     SELECT 1 AS ok
     FROM user_orgs membership
     JOIN users account ON account.id = membership.user_id
     WHERE membership.org_id = $1 AND membership.user_id = $2
       AND membership.is_active = true AND account.is_active = true
     FOR SHARE OF membership, account`,
    [orgId, userId],
  )
  if (result.rows.length !== 1) fail('forbidden')
}

function practiceSet(row: Record<string, unknown>): ElearningPracticeSet {
  const status = text(row.status)
  if (status !== 'active') fail('unavailable')
  return {
    practiceSetId: requirePracticeUuid(text(row.practice_set_id ?? row.id)),
    paperId: requirePracticeUuid(text(row.paper_id)),
    title: text(row.title),
    status,
    createdAt: date(row.created_at),
  }
}

function storedQuestion(row: Record<string, unknown>): ElearningPracticeStoredQuestion {
  return parseElearningPracticeStoredQuestion({
    position: row.position,
    questionRevisionId: row.question_revision_id,
    questionId: row.question_id,
    questionType: row.question_type,
    prompt: row.prompt,
    options: row.options,
    points: row.points,
    answerKey: row.answer_key,
    explanation: row.explanation,
  })
}

async function loadSession(
  tx: ElearningPracticeQueryable,
  orgId: string,
  userId: string,
  sessionId: string,
): Promise<ElearningPracticeSession> {
  const session = await tx.query(
    `/* elearning-practice:load-session */
     SELECT id::text AS session_id, practice_set_id::text, mode, created_at
     FROM elearning_practice_sessions
     WHERE org_id = $1 AND user_id = $2 AND id = $3::uuid`,
    [orgId, userId, sessionId],
  )
  if (session.rows.length !== 1) fail('not_found')
  const questionRows = await tx.query(
    `/* elearning-practice:load-session-questions */
     SELECT item.question_id::text, item.question_revision_id::text,
            item.position, item.points, revision.question_type,
            revision.prompt, revision.options, revision.answer_key,
            revision.explanation
     FROM elearning_practice_session_questions item
     JOIN elearning_question_revisions revision
       ON revision.org_id = item.org_id AND revision.id = item.question_revision_id
     WHERE item.org_id = $1 AND item.session_id = $2::uuid
     ORDER BY item.position ASC`,
    [orgId, sessionId],
  )
  if (questionRows.rows.length > ELEARNING_PRACTICE_MAX_QUESTIONS) fail('unavailable')
  const questions = questionRows.rows.map((row) => publicElearningPracticeQuestion(
    parseElearningPracticeStoredQuestion(row),
  ))
  const row = session.rows[0]!
  return {
    sessionId: requirePracticeUuid(text(row.session_id)),
    practiceSetId: requirePracticeUuid(text(row.practice_set_id)),
    mode: normalizePracticeMode(row.mode),
    questions,
    createdAt: date(row.created_at),
  }
}

function answerResult(row: Record<string, unknown>): ElearningPracticeAnswerResult {
  const wrongState = row.wrong_state
  if (wrongState !== 'wrong' && wrongState !== 'resolved' && wrongState !== 'unchanged') {
    fail('unavailable')
  }
  return {
    answerId: requirePracticeUuid(text(row.answer_id ?? row.id)),
    sessionId: requirePracticeUuid(text(row.session_id)),
    questionRevisionId: requirePracticeUuid(text(row.question_revision_id)),
    correct: bool(row.correct),
    wrongState,
    createdAt: date(row.created_at),
  }
}

function runValuesFree<T>(action: () => Promise<T>): Promise<T> {
  return action().catch((error: unknown) => {
    if (error instanceof ElearningPracticeError) throw error
    fail('unavailable')
  })
}

export async function createElearningPracticeSet(
  db: ElearningPracticeDb,
  input: CreateElearningPracticeSetInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningPracticeSet & { duplicate: boolean }> {
  if (!isElearningPracticeSurfaceEnabled(env)) fail('disabled')
  const orgId = requirePracticeText(input.orgId)
  const actorId = requirePracticeText(input.actorId)
  const requestId = requirePracticeUuid(input.requestId)
  const paperId = requirePracticeUuid(input.paperId)
  const title = requirePracticeText(input.title, 200)
  const requestHash = hashElearningPracticeRequest('create_set', { paperId, title })

  return runValuesFree(() => db.transaction(async (tx) => {
    await advisoryLock(tx, 'elearning-practice-set-request', `${orgId}:${requestId}`)
    await requireActiveMember(tx, orgId, actorId)
    const existing = await tx.query(
      `/* elearning-practice:load-set-request */
       SELECT id::text AS practice_set_id, paper_id::text, title, status,
              request_hash, request_hash_version, created_at
       FROM elearning_practice_sets WHERE org_id = $1 AND source_key = $2
       FOR SHARE`,
      [orgId, requestId],
    )
    if (existing.rows.length === 1) {
      const row = existing.rows[0]!
      if (text(row.request_hash) !== requestHash
        || integer(row.request_hash_version) !== ELEARNING_PRACTICE_REQUEST_HASH_VERSION) {
        fail('conflict')
      }
      return { ...practiceSet(row), duplicate: true }
    }
    if (existing.rows.length !== 0) fail('unavailable')
    const practiceSetId = randomUUID()
    const inserted = await tx.query(
      `/* elearning-practice:create-set */
       INSERT INTO elearning_practice_sets (
         id, org_id, paper_id, title, source_key, request_hash,
         request_hash_version, created_by
       ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8)
       RETURNING id::text AS practice_set_id, paper_id::text, title, status, created_at`,
      [practiceSetId, orgId, paperId, title, requestId, requestHash,
        ELEARNING_PRACTICE_REQUEST_HASH_VERSION, actorId],
    )
    if (inserted.rows.length !== 1) fail('unavailable')
    return { ...practiceSet(inserted.rows[0]!), duplicate: false }
  }))
}

export async function listElearningPracticeSets(
  db: ElearningPracticeQueryable,
  input: { orgId: string; userId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningPracticeSet[]> {
  if (!isElearningPracticeSurfaceEnabled(env)) fail('disabled')
  const orgId = requirePracticeText(input.orgId)
  const userId = requirePracticeText(input.userId)
  return runValuesFree(async () => {
    await requireActiveMember(db, orgId, userId)
    const result = await db.query(
      `/* elearning-practice:list-sets */
       SELECT id::text AS practice_set_id, paper_id::text, title, status, created_at
       FROM elearning_practice_sets
       WHERE org_id = $1 AND status = 'active'
       ORDER BY created_at DESC, id DESC`,
      [orgId],
    )
    return result.rows.map(practiceSet)
  })
}

export async function startElearningPracticeSession(
  db: ElearningPracticeDb,
  input: StartElearningPracticeSessionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningPracticeSession & { duplicate: boolean }> {
  if (!isElearningPracticeSurfaceEnabled(env)) fail('disabled')
  const orgId = requirePracticeText(input.orgId)
  const userId = requirePracticeText(input.userId)
  const requestId = requirePracticeUuid(input.requestId)
  const practiceSetId = requirePracticeUuid(input.practiceSetId)
  const mode = normalizePracticeMode(input.mode)
  const requestHash = hashElearningPracticeRequest('start_session', { mode, practiceSetId })

  return runValuesFree(() => db.transaction(async (tx) => {
    await advisoryLock(tx, 'elearning-practice-session-request', `${orgId}:${userId}:${requestId}`)
    await requireActiveMember(tx, orgId, userId)
    const existing = await tx.query(
      `/* elearning-practice:load-session-request */
       SELECT id::text, request_hash, request_hash_version
       FROM elearning_practice_sessions
       WHERE org_id = $1 AND user_id = $2 AND source_key = $3 FOR SHARE`,
      [orgId, userId, requestId],
    )
    if (existing.rows.length === 1) {
      const row = existing.rows[0]!
      if (text(row.request_hash) !== requestHash
        || integer(row.request_hash_version) !== ELEARNING_PRACTICE_REQUEST_HASH_VERSION) {
        fail('conflict')
      }
      return { ...(await loadSession(tx, orgId, userId, text(row.id))), duplicate: true }
    }
    if (existing.rows.length !== 0) fail('unavailable')

    const set = await tx.query(
      `/* elearning-practice:lock-set */
       SELECT practice.id::text, practice.paper_id::text
       FROM elearning_practice_sets practice
       JOIN elearning_papers paper
         ON paper.org_id = practice.org_id AND paper.id = practice.paper_id
       WHERE practice.org_id = $1 AND practice.id = $2::uuid
         AND practice.status = 'active' AND paper.status = 'published'
       FOR SHARE OF practice, paper`,
      [orgId, practiceSetId],
    )
    if (set.rows.length !== 1) fail('not_found')
    const paperId = requirePracticeUuid(text(set.rows[0]!.paper_id))
    const rows = await tx.query(
      `/* elearning-practice:load-paper */
       SELECT paper_item.id::text AS paper_question_id,
              paper_item.question_id::text, paper_item.question_revision_id::text,
              paper_item.position AS source_position, paper_item.position,
              paper_item.points, revision.question_type, revision.prompt,
              revision.options, revision.answer_key, revision.explanation
       FROM elearning_paper_questions paper_item
       JOIN elearning_question_revisions revision
         ON revision.org_id = paper_item.org_id AND revision.id = paper_item.question_revision_id
       WHERE paper_item.org_id = $1 AND paper_item.paper_id = $2::uuid
       ORDER BY paper_item.position ASC`,
      [orgId, paperId],
    )
    if (rows.rows.length < 1 || rows.rows.length > ELEARNING_PRACTICE_MAX_QUESTIONS) {
      fail('unavailable')
    }
    const questions = rows.rows.map(storedQuestion)
    let wrongIds = new Set<string>()
    if (mode === 'wrong_book') {
      const wrong = await tx.query(
        `/* elearning-practice:load-wrong-projection */
         SELECT question_revision_id::text
         FROM (
           SELECT DISTINCT ON (question_revision_id)
             question_revision_id, event_kind, created_at, id
           FROM elearning_wrong_question_events
           WHERE org_id = $1 AND user_id = $2 AND practice_set_id = $3::uuid
           ORDER BY question_revision_id, created_at DESC, id DESC
         ) latest
         WHERE event_kind = 'wrong'`,
        [orgId, userId, practiceSetId],
      )
      wrongIds = new Set(wrong.rows.map((row) => requirePracticeUuid(text(row.question_revision_id))))
    }
    const sessionId = randomUUID()
    const ordered = orderElearningPracticeQuestions(questions, mode, sessionId, wrongIds)
    await tx.query(
      `/* elearning-practice:create-session */
       INSERT INTO elearning_practice_sessions (
         id, org_id, user_id, practice_set_id, mode, source_key,
         request_hash, request_hash_version
       ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8)`,
      [sessionId, orgId, userId, practiceSetId, mode, requestId, requestHash,
        ELEARNING_PRACTICE_REQUEST_HASH_VERSION],
    )
    const rowByRevision = new Map(rows.rows.map((row) => [text(row.question_revision_id), row]))
    for (const question of ordered) {
      const source = rowByRevision.get(question.questionRevisionId)
      if (!source) fail('unavailable')
      await tx.query(
        `/* elearning-practice:create-session-question */
         INSERT INTO elearning_practice_session_questions (
           org_id, session_id, paper_question_id, question_id,
           question_revision_id, source_position, position, points
         ) VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8)`,
        [orgId, sessionId, text(source.paper_question_id), question.questionId,
          question.questionRevisionId, integer(source.source_position), question.position,
          question.points],
      )
    }
    return { ...(await loadSession(tx, orgId, userId, sessionId)), duplicate: false }
  }))
}

export async function submitElearningPracticeAnswer(
  db: ElearningPracticeDb,
  input: SubmitElearningPracticeAnswerInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningPracticeAnswerResult & { duplicate: boolean }> {
  if (!isElearningPracticeSurfaceEnabled(env)) fail('disabled')
  const orgId = requirePracticeText(input.orgId)
  const userId = requirePracticeText(input.userId)
  const requestId = requirePracticeUuid(input.requestId)
  const sessionId = requirePracticeUuid(input.sessionId)
  const questionRevisionId = requirePracticeUuid(input.questionRevisionId)

  return runValuesFree(() => db.transaction(async (tx) => {
    await advisoryLock(tx, 'elearning-practice-answer-request', `${orgId}:${userId}:${requestId}`)
    await requireActiveMember(tx, orgId, userId)
    const questionRows = await tx.query(
      `/* elearning-practice:load-answer-question */
       SELECT session.practice_set_id::text, item.id::text AS session_question_id,
              item.question_id::text, item.question_revision_id::text,
              item.position, item.points, revision.question_type, revision.prompt,
              revision.options, revision.answer_key, revision.explanation
       FROM elearning_practice_sessions session
       JOIN elearning_practice_session_questions item
         ON item.org_id = session.org_id AND item.session_id = session.id
       JOIN elearning_question_revisions revision
         ON revision.org_id = item.org_id AND revision.id = item.question_revision_id
       WHERE session.org_id = $1 AND session.id = $2::uuid AND session.user_id = $3
         AND item.question_revision_id = $4::uuid
       FOR SHARE OF session, item, revision`,
      [orgId, sessionId, userId, questionRevisionId],
    )
    if (questionRows.rows.length !== 1) fail('not_found')
    const row = questionRows.rows[0]!
    const question = storedQuestion(row)
    const selectedOptionIds = normalizePracticeSelectedOptionIds(question, input.selectedOptionIds)
    const requestHash = hashElearningPracticeRequest('answer', {
      questionRevisionId,
      selectedOptionIds,
      sessionId,
    })
    const existing = await tx.query(
      `/* elearning-practice:load-answer-request */
       SELECT answer.id::text AS answer_id, answer.session_id::text,
              item.question_revision_id::text, answer.correct,
              answer.request_hash, answer.request_hash_version, answer.created_at,
              COALESCE(event.event_kind, 'unchanged') AS wrong_state
       FROM elearning_practice_answers answer
       JOIN elearning_practice_session_questions item
         ON item.org_id = answer.org_id AND item.id = answer.session_question_id
       LEFT JOIN elearning_wrong_question_events event
         ON event.org_id = answer.org_id AND event.answer_id = answer.id
       WHERE answer.org_id = $1 AND answer.user_id = $2 AND answer.source_key = $3
       FOR SHARE OF answer`,
      [orgId, userId, requestId],
    )
    if (existing.rows.length === 1) {
      const replay = existing.rows[0]!
      if (text(replay.request_hash) !== requestHash
        || integer(replay.request_hash_version) !== ELEARNING_PRACTICE_REQUEST_HASH_VERSION) {
        fail('conflict')
      }
      return { ...answerResult(replay), duplicate: true }
    }
    if (existing.rows.length !== 0) fail('unavailable')

    const sessionQuestionId = requirePracticeUuid(text(row.session_question_id))
    await advisoryLock(tx, 'elearning-practice-question-answer', `${orgId}:${sessionId}:${sessionQuestionId}`)
    const answered = await tx.query(
      `/* elearning-practice:existing-question-answer */
       SELECT 1 FROM elearning_practice_answers
       WHERE org_id = $1 AND session_id = $2::uuid AND session_question_id = $3::uuid
       FOR SHARE`,
      [orgId, sessionId, sessionQuestionId],
    )
    if (answered.rows.length !== 0) fail('conflict')
    const correct = isElearningPracticeAnswerCorrect(question, selectedOptionIds)
    const answerId = randomUUID()
    const inserted = await tx.query(
      `/* elearning-practice:append-answer */
       INSERT INTO elearning_practice_answers (
         id, org_id, user_id, session_id, session_question_id,
         selected_option_ids, correct, source_key, request_hash, request_hash_version
       ) VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::jsonb, $7, $8, $9, $10)
       RETURNING created_at`,
      [answerId, orgId, userId, sessionId, sessionQuestionId,
        JSON.stringify(selectedOptionIds), correct, requestId, requestHash,
        ELEARNING_PRACTICE_REQUEST_HASH_VERSION],
    )
    if (inserted.rows.length !== 1) fail('unavailable')

    const practiceSetId = requirePracticeUuid(text(row.practice_set_id))
    await advisoryLock(
      tx,
      'elearning-practice-wrong-projection',
      `${orgId}:${userId}:${practiceSetId}:${questionRevisionId}`,
    )
    const latest = await tx.query(
      `/* elearning-practice:latest-wrong-event */
       SELECT event_kind FROM elearning_wrong_question_events
       WHERE org_id = $1 AND user_id = $2 AND practice_set_id = $3::uuid
         AND question_revision_id = $4::uuid
       ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE`,
      [orgId, userId, practiceSetId, questionRevisionId],
    )
    const latestKind = latest.rows[0]?.event_kind
    const wrongState: ElearningPracticeAnswerResult['wrongState'] = !correct
      ? 'wrong'
      : latestKind === 'wrong'
        ? 'resolved'
        : 'unchanged'
    if (wrongState !== 'unchanged') {
      await tx.query(
        `/* elearning-practice:append-wrong-event */
         INSERT INTO elearning_wrong_question_events (
           org_id, user_id, practice_set_id, question_id, question_revision_id,
           session_id, answer_id, event_kind
         ) VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8)`,
        [orgId, userId, practiceSetId, question.questionId, questionRevisionId,
          sessionId, answerId, wrongState],
      )
    }
    return {
      answerId,
      sessionId,
      questionRevisionId,
      correct,
      wrongState,
      createdAt: date(inserted.rows[0]!.created_at),
      duplicate: false,
    }
  }))
}

export async function listElearningWrongQuestions(
  db: ElearningPracticeQueryable,
  input: { orgId: string; userId: string; practiceSetId: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ practiceSetId: string; questions: ElearningPracticeQuestion[] }> {
  if (!isElearningPracticeSurfaceEnabled(env)) fail('disabled')
  const orgId = requirePracticeText(input.orgId)
  const userId = requirePracticeText(input.userId)
  const practiceSetId = requirePracticeUuid(input.practiceSetId)
  return runValuesFree(async () => {
    await requireActiveMember(db, orgId, userId)
    const result = await db.query(
      `/* elearning-practice:list-wrong-questions */
       WITH latest AS (
         SELECT DISTINCT ON (question_revision_id)
           question_revision_id, event_kind
         FROM elearning_wrong_question_events
         WHERE org_id = $1 AND user_id = $2 AND practice_set_id = $3::uuid
         ORDER BY question_revision_id, created_at DESC, id DESC
       )
       SELECT item.question_id::text, item.question_revision_id::text,
              item.position, item.points, revision.question_type,
              revision.prompt, revision.options, revision.answer_key,
              revision.explanation
       FROM latest
       JOIN elearning_practice_sets practice
         ON practice.org_id = $1 AND practice.id = $3::uuid AND practice.status = 'active'
       JOIN elearning_paper_questions item
         ON item.org_id = practice.org_id AND item.paper_id = practice.paper_id
        AND item.question_revision_id = latest.question_revision_id
       JOIN elearning_question_revisions revision
         ON revision.org_id = item.org_id AND revision.id = item.question_revision_id
       WHERE latest.event_kind = 'wrong'
       ORDER BY item.position ASC`,
      [orgId, userId, practiceSetId],
    )
    return {
      practiceSetId,
      questions: result.rows.map((row) => publicElearningPracticeQuestion(
        parseElearningPracticeStoredQuestion(row),
      )),
    }
  })
}

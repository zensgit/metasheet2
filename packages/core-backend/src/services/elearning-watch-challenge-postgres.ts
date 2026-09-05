import { createHash, randomInt, randomUUID } from 'node:crypto'
import {
  renderElearningWatchChallengeRaster,
  type ElearningWatchChallengeRasterOption,
} from './elearning-watch-challenge-raster.js'
import {
  createElearningWatchChallengeSchedule,
  resolveElearningWatchChallengeDue,
  type ElearningWatchChallengeSchedule,
} from './elearning-watch-challenge-schedule.js'

export const ELEARNING_WATCH_CHALLENGE_REQUEST_HASH_VERSION = 2 as const
export const ELEARNING_WATCH_CHALLENGE_REQUEST_DOMAIN =
  'elearning.watch.challenge.ack.v2' as const
export const ELEARNING_WATCH_CHALLENGE_PROMPT_VERSION = 'raster-position-v2' as const

const PROMPT_SYMBOLS = ['●', '▲', '■', '◆', '★', '♥'] as const

interface ElearningWatchChallengeSnapshotOption {
  optionId: string
  label: string
}

export interface ElearningWatchChallengePrompt {
  promptVersion: typeof ELEARNING_WATCH_CHALLENGE_PROMPT_VERSION
  imagePngBase64: string
  imageWidth: number
  imageHeight: number
  options: ElearningWatchChallengeRasterOption[]
}

export interface ElearningWatchChallengePromptSnapshot {
  promptVersion: typeof ELEARNING_WATCH_CHALLENGE_PROMPT_VERSION
  targets: [string, string]
  options: ElearningWatchChallengeSnapshotOption[]
  expectedSelections: [string, string]
}

export interface ElearningWatchChallengeQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningWatchChallengeView {
  challengeId: string
  deadlineAt: string
  ordinal: number
  status: 'challenged' | 'paused'
  promptVersion: typeof ELEARNING_WATCH_CHALLENGE_PROMPT_VERSION
  imagePngBase64: string
  imageWidth: number
  imageHeight: number
  options: ElearningWatchChallengeRasterOption[]
}

export interface ElearningWatchChallengeHeartbeatResult {
  challenge: ElearningWatchChallengeView | null
  completionReady: boolean
  creditedMs: number
  discardedMs: number
  maxPositionMs: number
}

export type ElearningWatchChallengePostgresErrorCode =
  | 'challenge_mismatch'
  | 'challenge_incorrect'
  | 'challenge_stale'
  | 'conflict'
  | 'unavailable'

export class ElearningWatchChallengePostgresError extends Error {
  constructor(readonly code: ElearningWatchChallengePostgresErrorCode) {
    super(code)
    this.name = 'ElearningWatchChallengePostgresError'
  }
}

interface ScheduleRow {
  id: string
  orgId: string
  sessionId: string
  versionId: string
  itemId: string
  userId: string
  schedule: ElearningWatchChallengeSchedule
  issuedCount: number
  status: 'watching' | 'challenged' | 'paused' | 'completed'
  activeChallengeId: string | null
  activeOrdinal: number | null
  activeDeadlineAt: Date | null
  challengeBaseMaxPositionMs: number | null
  provisionalMs: number
  prompt: ElearningWatchChallengePromptSnapshot | null
  now: Date
}

function fail(code: ElearningWatchChallengePostgresErrorCode): never {
  throw new ElearningWatchChallengePostgresError(code)
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function asDate(value: unknown): Date | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null
  return value
}

function requireInt(value: unknown): number {
  const parsed = asInt(value)
  if (parsed === null) fail('unavailable')
  return parsed
}

function shuffle<T>(values: T[]): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1)
    ;[values[index], values[other]] = [values[other]!, values[index]!]
  }
  return values
}

export function createElearningWatchChallengePrompt(): ElearningWatchChallengePromptSnapshot {
  const options = shuffle(PROMPT_SYMBOLS.map((symbol) => ({
    optionId: randomUUID(),
    label: `${symbol}${randomInt(1, 10)}`,
  })))
  const first = randomInt(options.length)
  const secondOffset = randomInt(options.length - 1)
  const second = secondOffset >= first ? secondOffset + 1 : secondOffset
  return {
    promptVersion: ELEARNING_WATCH_CHALLENGE_PROMPT_VERSION,
    targets: [options[first]!.label, options[second]!.label],
    options,
    expectedSelections: [options[first]!.optionId, options[second]!.optionId],
  }
}

function parseUuidArray(value: unknown, length: number): string[] | null {
  if (!Array.isArray(value) || value.length !== length) return null
  const parsed = value.map(asText)
  return parsed.every((item): item is string => item !== null) ? parsed : null
}

function parsePrompt(row: Record<string, unknown>): ElearningWatchChallengePromptSnapshot | null {
  if (
    row.prompt_version === null
    && row.prompt_option_ids === null
    && row.prompt_option_labels === null
    && row.expected_selection === null
  ) return null
  if (row.prompt_version !== ELEARNING_WATCH_CHALLENGE_PROMPT_VERSION) fail('unavailable')
  const optionIds = parseUuidArray(row.prompt_option_ids, 6)
  const labels = parseUuidArray(row.prompt_option_labels, 6)
  const expectedSelections = parseUuidArray(row.expected_selection, 2)
  if (!optionIds || !labels || !expectedSelections) fail('unavailable')
  if (
    new Set(optionIds).size !== 6
    || new Set(labels).size !== 6
    || new Set(expectedSelections).size !== 2
    || expectedSelections.some((selection) => !optionIds.includes(selection))
  ) fail('unavailable')
  const options = optionIds.map((optionId, index) => ({ optionId, label: labels[index]! }))
  const labelById = new Map(options.map((option) => [option.optionId, option.label]))
  return {
    promptVersion: ELEARNING_WATCH_CHALLENGE_PROMPT_VERSION,
    targets: [labelById.get(expectedSelections[0]!)!, labelById.get(expectedSelections[1]!)!],
    options,
    expectedSelections: expectedSelections as [string, string],
  }
}

function parseScheduleSnapshot(value: {
  checkpoints: unknown
  mode: unknown
  policyRevision: unknown
  responseWindowMs: unknown
  videoDurationMs: unknown
}): ElearningWatchChallengeSchedule {
  try {
    const schedule = {
      checkpoints: value.checkpoints,
      mode: value.mode,
      policyRevision: value.policyRevision,
      responseWindowMs: requireInt(value.responseWindowMs),
      videoDurationMs: requireInt(value.videoDurationMs),
    }
    resolveElearningWatchChallengeDue(schedule, { issuedCount: 0, trustedMs: 0 })
    return schedule as ElearningWatchChallengeSchedule
  } catch {
    fail('unavailable')
  }
}

function parseScheduleRow(row: Record<string, unknown>): ScheduleRow {
  const id = asText(row.id)
  const orgId = asText(row.org_id)
  const sessionId = asText(row.session_id)
  const versionId = asText(row.course_version_id)
  const itemId = asText(row.course_version_item_id)
  const userId = asText(row.user_id)
  const status = asText(row.status)
  const activeChallengeId = row.active_challenge_id === null
    ? null
    : asText(row.active_challenge_id)
  const activeOrdinal = row.active_ordinal === null ? null : asInt(row.active_ordinal)
  const activeDeadlineAt = row.active_deadline_at === null
    ? null
    : asDate(row.active_deadline_at)
  const challengeBaseMaxPositionMs = row.challenge_base_max_position_ms === null
    ? null
    : asInt(row.challenge_base_max_position_ms)
  const now = asDate(row.now_at)
  if (
    !id || !orgId || !sessionId || !versionId || !itemId || !userId || !now
    || !status || !['watching', 'challenged', 'paused', 'completed'].includes(status)
    || (row.active_challenge_id !== null && !activeChallengeId)
    || (row.active_ordinal !== null && activeOrdinal === null)
    || (row.active_deadline_at !== null && !activeDeadlineAt)
    || (row.challenge_base_max_position_ms !== null && challengeBaseMaxPositionMs === null)
  ) fail('unavailable')
  const prompt = parsePrompt(row)
  if (
    (status === 'challenged' || status === 'paused') !== (prompt !== null)
  ) fail('unavailable')
  return {
    id,
    orgId,
    sessionId,
    versionId,
    itemId,
    userId,
    schedule: parseScheduleSnapshot({
      checkpoints: row.checkpoints,
      mode: row.mode,
      policyRevision: row.policy_revision,
      responseWindowMs: row.response_window_ms,
      videoDurationMs: row.video_duration_ms,
    }),
    issuedCount: requireInt(row.issued_count),
    status: status as ScheduleRow['status'],
    activeChallengeId,
    activeOrdinal,
    activeDeadlineAt,
    challengeBaseMaxPositionMs,
    provisionalMs: requireInt(row.provisional_ms),
    prompt,
    now,
  }
}

function isCompletionReady(row: ScheduleRow): boolean {
  return row.status === 'watching'
    && (row.schedule.mode !== 'scheduled'
      || row.issuedCount === row.schedule.checkpoints.length)
}

export function createElearningWatchChallengePublicPrompt(
  prompt: ElearningWatchChallengePromptSnapshot,
): ElearningWatchChallengePrompt {
  return {
    promptVersion: prompt.promptVersion,
    ...renderElearningWatchChallengeRaster({ targets: prompt.targets, options: prompt.options }),
  }
}

function view(row: ScheduleRow): ElearningWatchChallengeView | null {
  if (
    (row.status !== 'challenged' && row.status !== 'paused')
    || !row.activeChallengeId
    || row.activeOrdinal === null
    || !row.activeDeadlineAt
    || !row.prompt
  ) return null
  const prompt = createElearningWatchChallengePublicPrompt(row.prompt)
  return {
    challengeId: row.activeChallengeId,
    deadlineAt: row.activeDeadlineAt.toISOString(),
    ordinal: row.activeOrdinal,
    status: row.status,
    ...prompt,
  }
}

async function lockSchedule(
  tx: ElearningWatchChallengeQueryable,
  orgId: string,
  sessionId: string,
  userId: string,
): Promise<ScheduleRow | null> {
  const result = await tx.query(
    `/* elearning-watch-challenge:lock-schedule */
     SELECT schedule.*, clock_timestamp() AS now_at,
            issue.prompt_version, issue.prompt_option_ids,
            issue.prompt_option_labels, issue.expected_selection
       FROM elearning_watch_challenge_schedules schedule
       LEFT JOIN elearning_watch_challenge_events issue
         ON issue.org_id = schedule.org_id
        AND issue.schedule_id = schedule.id
        AND issue.challenge_id = schedule.active_challenge_id
        AND issue.kind = 'issue'
      WHERE schedule.org_id = $1
        AND schedule.session_id = $2
        AND schedule.user_id = $3
      FOR UPDATE OF schedule`,
    [orgId, sessionId, userId],
  )
  return result.rows[0] ? parseScheduleRow(result.rows[0]) : null
}

export function deriveElearningWatchChallengeRequestHash(input: {
  orgId: string
  userId: string
  sessionId: string
  challengeId: string
  selections: readonly [string, string]
}): string {
  return createHash('sha256').update([
    ELEARNING_WATCH_CHALLENGE_REQUEST_DOMAIN,
    input.orgId,
    input.userId,
    input.sessionId,
    input.challengeId,
    input.selections[0],
    input.selections[1],
  ].join('\n'), 'utf8').digest('hex')
}

export async function initializeElearningWatchChallenge(
  tx: ElearningWatchChallengeQueryable,
  input: {
    orgId: string
    userId: string
    sessionId: string
    versionId: string
    itemId: string
    durationMs: number
  },
): Promise<ElearningWatchChallengeView | null> {
  const policy = await tx.query(
    `/* elearning-watch-challenge:load-policy */
     SELECT watch_challenge_policy_revision, watch_challenge_count,
            watch_challenge_min_duration_ms, watch_challenge_response_window_ms
       FROM elearning_course_version_items
      WHERE org_id = $1 AND id = $2
      FOR SHARE`,
    [input.orgId, input.itemId],
  )
  const row = policy.rows[0]
  if (!row) fail('unavailable')
  const policyDisabled = (
    row.watch_challenge_policy_revision === null
    && row.watch_challenge_count === null
    && row.watch_challenge_min_duration_ms === null
    && row.watch_challenge_response_window_ms === null
  )
  const policyRevision = policyDisabled
    ? 'watch-challenge-disabled-v1'
    : asText(row.watch_challenge_policy_revision)
  const challengeCount = policyDisabled ? 0 : asInt(row.watch_challenge_count)
  const minimumVideoDurationMs = policyDisabled
    ? 1
    : asInt(row.watch_challenge_min_duration_ms)
  const responseWindowMs = policyDisabled
    ? 1
    : asInt(row.watch_challenge_response_window_ms)
  if (!policyRevision || challengeCount === null || minimumVideoDurationMs === null
    || responseWindowMs === null) fail('unavailable')
  const entropy = challengeCount === 0 || input.durationMs < minimumVideoDurationMs
    ? []
    : Array.from({ length: challengeCount }, () => randomInt(0, 0x1_0000_0000))
  const schedule = createElearningWatchChallengeSchedule({
    challengeCount,
    entropy,
    minimumVideoDurationMs,
    policyRevision,
    responseWindowMs,
    videoDurationMs: input.durationMs,
  })
  await tx.query(
    `/* elearning-watch-challenge:insert-schedule */
     INSERT INTO elearning_watch_challenge_schedules (
       id, org_id, session_id, course_version_id, course_version_item_id, user_id, mode,
       policy_revision, response_window_ms, video_duration_ms, checkpoints
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (org_id, session_id) DO NOTHING`,
    [
      randomUUID(), input.orgId, input.sessionId, input.versionId, input.itemId, input.userId,
      schedule.mode, schedule.policyRevision, schedule.responseWindowMs,
      schedule.videoDurationMs, JSON.stringify(schedule.checkpoints),
    ],
  )
  const stored = await lockSchedule(tx, input.orgId, input.sessionId, input.userId)
  if (!stored) fail('unavailable')
  return view(stored)
}

export async function getElearningWatchChallengeView(
  tx: ElearningWatchChallengeQueryable,
  input: { orgId: string; userId: string; sessionId: string },
): Promise<ElearningWatchChallengeView | null> {
  const row = await lockSchedule(tx, input.orgId, input.sessionId, input.userId)
  return row ? view(row) : null
}

export async function applyElearningWatchChallengeHeartbeat(
  tx: ElearningWatchChallengeQueryable,
  input: {
    orgId: string
    userId: string
    sessionId: string
    rawCreditedMs: number
    rawMaxPositionMs: number
    nextEffectiveMs: number
  },
): Promise<ElearningWatchChallengeHeartbeatResult> {
  const row = await lockSchedule(tx, input.orgId, input.sessionId, input.userId)
  if (!row) fail('unavailable')
  if (row.status === 'completed') fail('unavailable')

  if (row.status === 'challenged' && row.activeDeadlineAt && row.now > row.activeDeadlineAt) {
    const discardedMs = row.provisionalMs + input.rawCreditedMs
    await tx.query(
      `/* elearning-watch-challenge:timeout */
       UPDATE elearning_watch_challenge_schedules
          SET status = 'paused', provisional_ms = 0, updated_at = clock_timestamp()
        WHERE org_id = $1 AND id = $2 AND status = 'challenged'`,
      [input.orgId, row.id],
    )
    await insertEvent(tx, row, 'timeout', 0, discardedMs)
    return {
      challenge: { ...view({ ...row, status: 'paused' })! },
      completionReady: false,
      creditedMs: 0,
      discardedMs,
      maxPositionMs: row.challengeBaseMaxPositionMs ?? input.rawMaxPositionMs,
    }
  }
  if (row.status === 'paused') {
    return {
      challenge: view(row),
      completionReady: false,
      creditedMs: 0,
      discardedMs: input.rawCreditedMs,
      maxPositionMs: row.challengeBaseMaxPositionMs ?? input.rawMaxPositionMs,
    }
  }
  if (row.status === 'challenged') {
    await tx.query(
      `/* elearning-watch-challenge:provisional */
       UPDATE elearning_watch_challenge_schedules
          SET provisional_ms = provisional_ms + $1, updated_at = clock_timestamp()
        WHERE org_id = $2 AND id = $3 AND status = 'challenged'`,
      [input.rawCreditedMs, input.orgId, row.id],
    )
    return {
      challenge: view(row),
      completionReady: false,
      creditedMs: 0,
      discardedMs: 0,
      maxPositionMs: input.rawMaxPositionMs,
    }
  }

  const due = resolveElearningWatchChallengeDue(row.schedule, {
    issuedCount: row.issuedCount,
    trustedMs: input.nextEffectiveMs,
  })
  if (!due) {
    return {
      challenge: null,
      completionReady: isCompletionReady(row),
      creditedMs: input.rawCreditedMs,
      discardedMs: 0,
      maxPositionMs: input.rawMaxPositionMs,
    }
  }
  const challengeId = randomUUID()
  const prompt = createElearningWatchChallengePrompt()
  const issue = await tx.query(
    `/* elearning-watch-challenge:issue */
     UPDATE elearning_watch_challenge_schedules
        SET issued_count = issued_count + 1,
            status = 'challenged',
            active_challenge_id = $1,
            active_ordinal = $2,
            active_issued_at = clock_timestamp(),
            active_deadline_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
            challenge_base_max_position_ms = $4,
            provisional_ms = $5,
            updated_at = clock_timestamp()
      WHERE org_id = $6 AND id = $7 AND status = 'watching'
      RETURNING active_deadline_at`,
    [
      challengeId,
      due.ordinal,
      due.responseWindowMs,
      input.rawMaxPositionMs - input.rawCreditedMs,
      input.rawCreditedMs,
      input.orgId,
      row.id,
    ],
  )
  const deadlineAt = asDate(issue.rows[0]?.active_deadline_at)
  if (issue.rowCount !== 1 || !deadlineAt) fail('unavailable')
  await insertEvent(tx, {
    ...row,
    activeChallengeId: challengeId,
    activeOrdinal: due.ordinal,
  }, 'issue', 0, 0, prompt)
  const publicChallengePrompt = createElearningWatchChallengePublicPrompt(prompt)
  return {
    challenge: {
      challengeId,
      deadlineAt: deadlineAt.toISOString(),
      ordinal: due.ordinal,
      status: 'challenged',
      ...publicChallengePrompt,
    },
    completionReady: false,
    creditedMs: 0,
    discardedMs: 0,
    maxPositionMs: input.rawMaxPositionMs,
  }
}

async function insertEvent(
  tx: ElearningWatchChallengeQueryable,
  row: ScheduleRow,
  kind: 'issue' | 'ack' | 'timeout',
  creditedMs: number,
  discardedMs: number,
  prompt: ElearningWatchChallengePromptSnapshot | null = null,
): Promise<void> {
  if (!row.activeChallengeId || row.activeOrdinal === null) fail('unavailable')
  await tx.query(
    `/* elearning-watch-challenge:insert-event */
     INSERT INTO elearning_watch_challenge_events (
       id, org_id, schedule_id, session_id, course_version_id, course_version_item_id, user_id,
       challenge_id, ordinal, kind, policy_revision, credited_ms, discarded_ms,
       prompt_version, prompt_option_ids, prompt_option_labels, expected_selection
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15::uuid[], $16::text[], $17::uuid[]
     )`,
    [
      randomUUID(), row.orgId, row.id, row.sessionId, row.versionId, row.itemId, row.userId,
      row.activeChallengeId, row.activeOrdinal, kind, row.schedule.policyRevision,
      creditedMs, discardedMs,
      prompt?.promptVersion ?? null,
      prompt?.options.map((option) => option.optionId) ?? null,
      prompt?.options.map((option) => option.label) ?? null,
      prompt?.expectedSelections ?? null,
    ],
  )
}

export async function acknowledgeElearningWatchChallengeState<T extends object>(
  tx: ElearningWatchChallengeQueryable,
  input: {
    orgId: string
    userId: string
    requestId: string
    sessionId: string
    challengeId: string
    selections: readonly [string, string]
  },
  finalize: (transition: {
    completionReady: boolean
    creditedMs: number
    discardedMs: number
    maxPositionMs: number
  }) => Promise<T>,
): Promise<{ duplicate: boolean; result: T }> {
  await tx.query(
    `/* elearning-watch-challenge:lock-request-identity */
     SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`${ELEARNING_WATCH_CHALLENGE_REQUEST_DOMAIN}\n${input.orgId}\n${input.userId}\n${input.requestId}`],
  )
  const row = await lockSchedule(tx, input.orgId, input.sessionId, input.userId)
  if (!row) fail('challenge_stale')
  const requestHash = deriveElearningWatchChallengeRequestHash(input)
  const prior = await tx.query(
    `/* elearning-watch-challenge:load-request */
     SELECT request_hash, result
       FROM elearning_watch_challenge_requests
      WHERE org_id = $1 AND user_id = $2 AND request_id = $3`,
    [input.orgId, input.userId, input.requestId],
  )
  if (prior.rows[0]) {
    if (asText(prior.rows[0].request_hash) !== requestHash) fail('conflict')
    const result = prior.rows[0].result
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('unavailable')
    return { duplicate: true, result: result as T }
  }
  if (!row.activeChallengeId) fail('challenge_stale')
  if (row.activeChallengeId !== input.challengeId) fail('challenge_mismatch')
  if (
    !row.prompt
    || input.selections[0] !== row.prompt.expectedSelections[0]
    || input.selections[1] !== row.prompt.expectedSelections[1]
  ) fail('challenge_incorrect')
  const onTime = row.status === 'challenged'
    && row.activeDeadlineAt !== null
    && row.now <= row.activeDeadlineAt
  const creditedMs = onTime ? row.provisionalMs : 0
  const discardedMs = onTime ? 0 : row.provisionalMs
  const maxPositionMs = onTime
    ? (row.challengeBaseMaxPositionMs ?? 0) + row.provisionalMs
    : row.challengeBaseMaxPositionMs ?? 0
  await tx.query(
    `/* elearning-watch-challenge:ack */
     UPDATE elearning_watch_challenge_schedules
        SET status = 'watching', active_challenge_id = NULL, active_ordinal = NULL,
            active_issued_at = NULL, active_deadline_at = NULL,
            challenge_base_max_position_ms = NULL, provisional_ms = 0,
            updated_at = clock_timestamp()
      WHERE org_id = $1 AND id = $2 AND status IN ('challenged', 'paused')`,
    [input.orgId, row.id],
  )
  await insertEvent(tx, row, 'ack', creditedMs, discardedMs)
  const result = await finalize({
    completionReady: row.issuedCount === row.schedule.checkpoints.length,
    creditedMs,
    discardedMs,
    maxPositionMs,
  })
  await tx.query(
    `/* elearning-watch-challenge:insert-request */
     INSERT INTO elearning_watch_challenge_requests (
       id, org_id, user_id, request_id, request_hash, request_hash_version,
       schedule_id, session_id, course_version_id, course_version_item_id,
       challenge_id, result
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [
      randomUUID(), input.orgId, input.userId, input.requestId, requestHash,
      ELEARNING_WATCH_CHALLENGE_REQUEST_HASH_VERSION, row.id, input.sessionId,
      row.versionId, row.itemId, input.challengeId, JSON.stringify(result),
    ],
  )
  return { duplicate: false, result }
}

export async function completeElearningWatchChallengeSchedule(
  tx: ElearningWatchChallengeQueryable,
  orgId: string,
  sessionId: string,
): Promise<void> {
  await tx.query(
    `/* elearning-watch-challenge:complete */
     UPDATE elearning_watch_challenge_schedules
        SET status = 'completed', active_challenge_id = NULL, active_ordinal = NULL,
            active_issued_at = NULL, active_deadline_at = NULL,
            challenge_base_max_position_ms = NULL, provisional_ms = 0,
            updated_at = clock_timestamp()
      WHERE org_id = $1 AND session_id = $2 AND status = 'watching'`,
    [orgId, sessionId],
  )
}

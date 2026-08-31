/**
 * Transactional video watch engine.
 * Client events are start|heartbeat only. Completion, credit, and evidence
 * are server-derived. Returned values and errors are values-free.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  ElearningCourseAccessError,
  resolveElearningCourseAccess,
  type ElearningCourseAccessBasis,
} from './elearning-course-access.js'
import {
  ElearningWatchChallengePostgresError,
  acknowledgeElearningWatchChallengeState,
  applyElearningWatchChallengeHeartbeat,
  completeElearningWatchChallengeSchedule,
  getElearningWatchChallengeView,
  initializeElearningWatchChallenge,
  type ElearningWatchChallengeView,
} from './elearning-watch-challenge-postgres.js'

export const ELEARNING_WATCH_POLICY_VERSION = 'video-v1-90pct' as const
export const ELEARNING_WATCH_THRESHOLD_BPS = 9000 as const
export const ELEARNING_WATCH_EVALUATOR_VERSION = 'elearning-watch-eval-v1' as const
export const ELEARNING_WATCH_DIGEST_DOMAIN = 'elearning.watch.event.v1' as const
export const ELEARNING_WATCH_MAX_ELAPSED_MS = 30_000 as const
export const ELEARNING_WATCH_PLAYBACK_RATE_CAP = 2 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ElearningWatchErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'assignment_unavailable'
  | 'course_withdrawn'
  | 'unsupported_item'
  | 'unsupported_policy'
  | 'conflict'
  | 'sequence_gap'
  | 'session_inactive'
  | 'challenge_mismatch'
  | 'challenge_stale'
  | 'unavailable'

export class ElearningWatchError extends Error {
  constructor(readonly code: ElearningWatchErrorCode) {
    super(code)
    this.name = 'ElearningWatchError'
  }
}

export interface ElearningWatchQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningWatchDb extends ElearningWatchQueryable {
  transaction<T>(handler: (tx: ElearningWatchQueryable) => Promise<T>): Promise<T>
}

export interface StartElearningWatchInput {
  orgId: string
  userId: string
  itemId: string
  challengeEnabled?: true
}

export interface RecordElearningHeartbeatInput {
  sessionId: string
  orgId: string
  userId: string
  sequence: number
  positionMs: number
  playing: boolean
  challengeEnabled?: true
}

export interface AcknowledgeElearningWatchChallengeInput {
  sessionId: string
  orgId: string
  userId: string
  challengeId: string
  requestId: string
}

export interface ElearningWatchState {
  sessionId: string | null
  status: 'in_progress' | 'completed'
  lastSequence: number
  lastClientPositionMs: number
  effectiveMs: number
  maxPositionMs: number
  durationMs: number
  creditedMs: number
  duplicate: boolean
  challenge?: ElearningWatchChallengeView | null
}

export function elearningWatchLockKey(orgId: string, userId: string, itemId: string): string {
  return `elearning-watch:${orgId}:${userId}:${itemId}`
}

export function rollElearningWatchEventDigest(
  previousDigest: string,
  parts: {
    sequence: number
    kind: 'start' | 'heartbeat'
    reportedPositionMs: number
    playing: boolean
    creditedMs: number
  },
): string {
  const payload = [
    ELEARNING_WATCH_DIGEST_DOMAIN,
    previousDigest,
    String(parts.sequence),
    parts.kind,
    String(parts.reportedPositionMs),
    parts.playing ? '1' : '0',
    String(parts.creditedMs),
  ].join('\n')
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function elearningWatchCompletionThresholdMs(
  durationMs: number,
  thresholdBps: number = ELEARNING_WATCH_THRESHOLD_BPS,
): number {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) fail('invalid_input')
  if (!Number.isSafeInteger(thresholdBps) || thresholdBps < 0) fail('invalid_input')
  const threshold = (BigInt(durationMs) * BigInt(thresholdBps) + 9999n) / 10000n
  if (threshold > BigInt(Number.MAX_SAFE_INTEGER)) fail('unavailable')
  return Number(threshold)
}

export function computeElearningWatchCredit(input: {
  playing: boolean
  reportedPositionMs: number
  durationMs: number
  priorMaxPositionMs: number
  priorLastClientPositionMs: number
  elapsedMs: number
}): { clampedPositionMs: number; creditedMs: number; maxPositionMs: number } {
  const clampedPositionMs = Math.min(input.reportedPositionMs, input.durationMs)
  // lastClientPositionMs is the raw client cursor; maxPositionMs is the credited frontier.
  if (!input.playing) {
    return { clampedPositionMs, creditedMs: 0, maxPositionMs: input.priorMaxPositionMs }
  }
  const elapsedMs = Math.min(
    ELEARNING_WATCH_MAX_ELAPSED_MS,
    Math.max(0, Math.floor(input.elapsedMs)),
  )
  const forwardMovement = Math.max(0, clampedPositionMs - input.priorLastClientPositionMs)
  const novelBudget = Math.max(0, clampedPositionMs - input.priorMaxPositionMs)
  const creditedMs = Math.min(
    forwardMovement,
    novelBudget,
    elapsedMs * ELEARNING_WATCH_PLAYBACK_RATE_CAP,
  )
  const maxPositionMs = Math.min(input.durationMs, input.priorMaxPositionMs + creditedMs)
  return { clampedPositionMs, creditedMs, maxPositionMs }
}

function fail(code: ElearningWatchErrorCode): never {
  throw new ElearningWatchError(code)
}

function rethrowChallenge(error: unknown): never {
  if (!(error instanceof ElearningWatchChallengePostgresError)) throw error
  if (error.code === 'challenge_mismatch') fail('challenge_mismatch')
  if (error.code === 'challenge_stale') fail('challenge_stale')
  if (error.code === 'conflict') fail('conflict')
  fail('unavailable')
}

function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '') fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value
}

function requireSafeInt(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail('invalid_input')
  }
  return value
}

function requireBoolean(value: unknown): boolean {
  if (value !== true && value !== false) fail('invalid_input')
  return value
}

function asSafeInt(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^\d+$/.test(text)) return null
    const parsed = Number(text)
    if (!Number.isSafeInteger(parsed)) return null
    return parsed
  }
  return null
}

function requireRowInt(value: unknown): number {
  const parsed = asSafeInt(value)
  if (parsed === null) fail('unavailable')
  return parsed
}

function asBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value
  return null
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

async function resolveWatchAccess(
  tx: ElearningWatchQueryable,
  orgId: string,
  userId: string,
  versionId: string,
): Promise<ElearningCourseAccessBasis> {
  try {
    return (await resolveElearningCourseAccess(tx, {
      orgId,
      userId,
      courseVersionId: versionId,
    })).basis
  } catch (error) {
    if (!(error instanceof ElearningCourseAccessError)) throw error
    if (error.code === 'withdrawn') fail('course_withdrawn')
    if (error.code === 'denied') fail('assignment_unavailable')
    if (error.code === 'unsupported_version') fail('unsupported_item')
    if (error.code === 'not_found') fail('not_found')
    fail('unavailable')
  }
}

async function advisoryLock(
  tx: ElearningWatchQueryable,
  orgId: string,
  userId: string,
  itemId: string,
): Promise<void> {
  await tx.query(
    `/* elearning-watch:lock */
     SELECT pg_advisory_xact_lock(hashtext($1))`,
    [elearningWatchLockKey(orgId, userId, itemId)],
  )
}

async function lockCourseHead(
  tx: ElearningWatchQueryable,
  orgId: string,
  itemId: string,
): Promise<void> {
  const result = await tx.query(
    `/* elearning-watch:lock-course */
     SELECT c.status
       FROM elearning_course_version_items i
       JOIN elearning_course_versions v
         ON v.org_id = i.org_id AND v.id = i.course_version_id
       JOIN elearning_courses c
         ON c.org_id = v.org_id AND c.id = v.course_id
      WHERE i.org_id = $1 AND i.id = $2
      FOR SHARE OF c`,
    [orgId, itemId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  if (asText(row.status) === 'withdrawn') fail('course_withdrawn')
}

interface WatchableItem {
  itemId: string
  versionId: string
  mediaId: string
  durationMs: number
}

async function loadWatchableItem(
  tx: ElearningWatchQueryable,
  orgId: string,
  itemId: string,
): Promise<WatchableItem> {
  const result = await tx.query(
    `/* elearning-watch:load-item */
     SELECT
       i.id,
       i.course_version_id,
       i.item_type,
       i.completion_policy_version,
       i.completion_threshold_bps,
       i.media_id,
       v.status AS version_status,
       c.status AS course_status,
       m.status AS media_status,
       m.duration_ms
     FROM elearning_course_version_items i
     JOIN elearning_course_versions v
       ON v.org_id = i.org_id AND v.id = i.course_version_id
     JOIN elearning_courses c
       ON c.org_id = v.org_id AND c.id = v.course_id
     LEFT JOIN elearning_media m
       ON m.org_id = i.org_id AND m.id = i.media_id
     WHERE i.org_id = $1 AND i.id = $2
     FOR SHARE OF c FOR UPDATE OF i`,
    [orgId, itemId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  if (asText(row.course_status) === 'withdrawn') fail('course_withdrawn')
  const versionStatus = asText(row.version_status)
  if (versionStatus !== 'published' && versionStatus !== 'retired') fail('unsupported_item')
  if (asText(row.item_type) !== 'video') fail('unsupported_item')
  if (asText(row.media_status) !== 'ready') fail('unsupported_item')
  const durationMs = asSafeInt(row.duration_ms)
  if (durationMs === null || durationMs <= 0) fail('unsupported_item')
  if (
    asText(row.completion_policy_version) !== ELEARNING_WATCH_POLICY_VERSION ||
    asSafeInt(row.completion_threshold_bps) !== ELEARNING_WATCH_THRESHOLD_BPS
  ) {
    fail('unsupported_policy')
  }
  const versionId = asText(row.course_version_id)
  const mediaId = asText(row.media_id)
  const loadedId = asText(row.id)
  if (!versionId || !mediaId || !loadedId) fail('unavailable')
  return { itemId: loadedId, versionId, mediaId, durationMs }
}

interface ProgressRow {
  id: string
  status: 'in_progress' | 'completed'
  effectiveMs: number
  maxPositionMs: number
}

async function lockProgress(
  tx: ElearningWatchQueryable,
  orgId: string,
  userId: string,
  itemId: string,
): Promise<ProgressRow | null> {
  const result = await tx.query(
    `/* elearning-watch:load-progress */
     SELECT id, status, effective_ms, max_position_ms
       FROM elearning_progress
      WHERE org_id = $1
        AND user_id = $2
        AND course_version_item_id = $3
      FOR UPDATE`,
    [orgId, userId, itemId],
  )
  const row = result.rows[0]
  if (!row) return null
  const id = asText(row.id)
  const status = asText(row.status)
  if (!id || (status !== 'in_progress' && status !== 'completed')) fail('unavailable')
  return {
    id,
    status,
    effectiveMs: requireRowInt(row.effective_ms),
    maxPositionMs: requireRowInt(row.max_position_ms),
  }
}

interface SessionRow {
  id: string
  assignmentMemberId: string | null
  scopeRevisionRuleId: string | null
  versionId: string
  itemId: string
  status: string
  lastSequence: number
  lastClientPositionMs: number
  effectiveMs: number
  maxPositionMs: number
  rollingEventDigest: string
  elapsedMs: number
}

async function lockActiveSession(
  tx: ElearningWatchQueryable,
  orgId: string,
  userId: string,
  itemId: string,
): Promise<SessionRow | null> {
  const result = await tx.query(
    `/* elearning-watch:load-active-session */
     SELECT
       s.id,
       s.assignment_member_id,
       s.scope_revision_rule_id,
       s.course_version_id,
       s.course_version_item_id,
       s.status,
       s.last_sequence,
       s.last_client_position_ms,
       s.effective_ms,
       s.max_position_ms,
       s.rolling_event_digest
       FROM elearning_learning_sessions s
      WHERE s.org_id = $1
        AND s.user_id = $2
        AND s.course_version_item_id = $3
        AND s.status = 'active'
      FOR UPDATE OF s`,
    [orgId, userId, itemId],
  )
  const row = result.rows[0]
  if (!row) return null
  return parseSessionRow(row, 0)
}

function parseSessionRow(row: Record<string, unknown>, elapsedMs: number): SessionRow {
  const id = asText(row.id)
  const assignmentMemberId = asText(row.assignment_member_id)
  const scopeRevisionRuleId = asText(row.scope_revision_rule_id)
  const versionId = asText(row.course_version_id)
  const itemId = asText(row.course_version_item_id)
  const status = asText(row.status)
  const digest = asText(row.rolling_event_digest)
  if (
    !id
    || !versionId
    || !itemId
    || !status
    || !digest
    || (assignmentMemberId === null) === (scopeRevisionRuleId === null)
  ) {
    fail('unavailable')
  }
  return {
    id,
    assignmentMemberId,
    scopeRevisionRuleId,
    versionId,
    itemId,
    status,
    lastSequence: requireRowInt(row.last_sequence),
    lastClientPositionMs: requireRowInt(row.last_client_position_ms),
    effectiveMs: requireRowInt(row.effective_ms),
    maxPositionMs: requireRowInt(row.max_position_ms),
    rollingEventDigest: digest,
    elapsedMs,
  }
}

function stateFrom(
  sessionId: string | null,
  status: 'in_progress' | 'completed',
  lastSequence: number,
  lastClientPositionMs: number,
  effectiveMs: number,
  maxPositionMs: number,
  durationMs: number,
  creditedMs: number,
  duplicate: boolean,
  challenge?: ElearningWatchChallengeView | null,
): ElearningWatchState {
  const state: ElearningWatchState = {
    sessionId,
    status,
    lastSequence,
    lastClientPositionMs,
    effectiveMs,
    maxPositionMs,
    durationMs,
    creditedMs,
    duplicate,
  }
  if (challenge !== undefined) state.challenge = challenge
  return state
}

async function initializeChallengeForState(
  tx: ElearningWatchQueryable,
  enabled: boolean,
  input: {
    orgId: string
    userId: string
    sessionId: string
    itemId: string
    durationMs: number
  },
): Promise<ElearningWatchChallengeView | null | undefined> {
  if (!enabled) return undefined
  try {
    return await initializeElearningWatchChallenge(tx, input)
  } catch (error) {
    rethrowChallenge(error)
  }
}

export async function startElearningWatch(
  db: ElearningWatchDb,
  input: StartElearningWatchInput,
): Promise<ElearningWatchState> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const itemId = requireUuid(input.itemId)
  const challengeEnabled = input.challengeEnabled === true

  return db.transaction(async (tx) => {
    await advisoryLock(tx, orgId, userId, itemId)
    await lockCourseHead(tx, orgId, itemId)
    const item = await loadWatchableItem(tx, orgId, itemId)
    // Completed progress is retained but does not grant visibility/access.
    const access = await resolveWatchAccess(tx, orgId, userId, item.versionId)
    const progress = await lockProgress(tx, orgId, userId, item.itemId)
    if (progress?.status === 'completed') {
      return stateFrom(
        null,
        'completed',
        0,
        progress.maxPositionMs,
        progress.effectiveMs,
        progress.maxPositionMs,
        item.durationMs,
        0,
        false,
        challengeEnabled ? null : undefined,
      )
    }

    const existing = await lockActiveSession(tx, orgId, userId, item.itemId)
    if (existing) {
      if (!progress) fail('unavailable')
      await rebindInProgressAccess(tx, {
        orgId,
        userId,
        itemId: item.itemId,
        sessionId: existing.id,
        access,
      })
      const challenge = await initializeChallengeForState(tx, challengeEnabled, {
        orgId,
        userId,
        sessionId: existing.id,
        itemId: item.itemId,
        durationMs: item.durationMs,
      })
      return stateFrom(
        existing.id,
        'in_progress',
        existing.lastSequence,
        existing.lastClientPositionMs,
        existing.effectiveMs,
        existing.maxPositionMs,
        item.durationMs,
        0,
        false,
        challenge,
      )
    }

    // An in-progress rollup without its active event chain is not resumable:
    // cumulative credit must never outlive the digest that proves it.
    if (progress) fail('unavailable')

    const sessionId = await insertActiveStart(tx, {
      orgId,
      userId,
      access,
      versionId: item.versionId,
      itemId: item.itemId,
    })
    if (!progress) {
      await tx.query(
        `/* elearning-watch:insert-progress */
         INSERT INTO elearning_progress (
           org_id, assignment_member_id, scope_revision_rule_id, course_version_id,
           course_version_item_id, user_id, status, effective_ms, max_position_ms,
           completed_at, required_at_completion
         ) VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', 0, 0, NULL, $7)`,
        [
          orgId,
          access.assignmentMemberId,
          access.scopeRevisionRuleId,
          item.versionId,
          item.itemId,
          userId,
          access.required,
        ],
      )
    }

    const challenge = await initializeChallengeForState(tx, challengeEnabled, {
      orgId,
      userId,
      sessionId,
      itemId: item.itemId,
      durationMs: item.durationMs,
    })
    return stateFrom(
      sessionId,
      'in_progress',
      0,
      0,
      0,
      0,
      item.durationMs,
      0,
      false,
      challenge,
    )
  })
}

async function insertActiveStart(
  tx: ElearningWatchQueryable,
  input: {
    orgId: string
    userId: string
    access: ElearningCourseAccessBasis
    versionId: string
    itemId: string
  },
): Promise<string> {
  const sessionId = randomUUID()
  const digest = rollElearningWatchEventDigest('', {
    sequence: 0,
    kind: 'start',
    reportedPositionMs: 0,
    playing: false,
    creditedMs: 0,
  })
  await tx.query(
    `/* elearning-watch:insert-session */
     INSERT INTO elearning_learning_sessions (
       id, org_id, assignment_member_id, scope_revision_rule_id, course_version_id,
       course_version_item_id, user_id, status, last_sequence, last_client_position_ms,
       effective_ms, max_position_ms, rolling_event_digest
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 0, 0, 0, 0, $8)`,
    [
      sessionId,
      input.orgId,
      input.access.assignmentMemberId,
      input.access.scopeRevisionRuleId,
      input.versionId,
      input.itemId,
      input.userId,
      digest,
    ],
  )
  await tx.query(
    `/* elearning-watch:insert-event */
     INSERT INTO elearning_progress_events (
       org_id, session_id, course_version_id, course_version_item_id, user_id,
       sequence, kind, reported_position_ms, playing, credited_ms, event_digest
     ) VALUES ($1, $2, $3, $4, $5, 0, 'start', 0, false, 0, $6)`,
    [input.orgId, sessionId, input.versionId, input.itemId, input.userId, digest],
  )
  return sessionId
}

async function rebindInProgressAccess(
  tx: ElearningWatchQueryable,
  input: {
    orgId: string
    userId: string
    itemId: string
    sessionId: string
    access: ElearningCourseAccessBasis
  },
): Promise<void> {
  const session = await tx.query(
    `/* elearning-watch:rebind-session-access */
     UPDATE elearning_learning_sessions
        SET assignment_member_id = $1,
            scope_revision_rule_id = $2
      WHERE org_id = $3 AND id = $4 AND status = 'active'`,
    [
      input.access.assignmentMemberId,
      input.access.scopeRevisionRuleId,
      input.orgId,
      input.sessionId,
    ],
  )
  if (session.rowCount !== 1) fail('unavailable')

  const progress = await tx.query(
    `/* elearning-watch:rebind-progress */
     UPDATE elearning_progress
        SET assignment_member_id = $1,
            scope_revision_rule_id = $2,
            required_at_completion = $3
      WHERE org_id = $4
        AND user_id = $5
        AND course_version_item_id = $6
        AND status = 'in_progress'`,
    [
      input.access.assignmentMemberId,
      input.access.scopeRevisionRuleId,
      input.access.required,
      input.orgId,
      input.userId,
      input.itemId,
    ],
  )
  if (progress.rowCount !== 1) fail('unavailable')
}

async function peekSessionItem(
  tx: ElearningWatchQueryable,
  orgId: string,
  sessionId: string,
  userId: string,
): Promise<string> {
  const result = await tx.query(
    `/* elearning-watch:peek-session */
     SELECT user_id, course_version_item_id
       FROM elearning_learning_sessions
      WHERE org_id = $1 AND id = $2`,
    [orgId, sessionId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  if (asText(row.user_id) !== userId) fail('not_found')
  const itemId = asText(row.course_version_item_id)
  if (!itemId) fail('unavailable')
  return itemId
}

async function lockHeartbeatSession(
  tx: ElearningWatchQueryable,
  orgId: string,
  sessionId: string,
  userId: string,
): Promise<{ session: SessionRow; durationMs: number }> {
  const result = await tx.query(
    `/* elearning-watch:lock-session */
     SELECT
       s.id,
       s.assignment_member_id,
       s.scope_revision_rule_id,
       s.course_version_id,
       s.course_version_item_id,
       s.status,
       s.last_sequence,
       s.last_client_position_ms,
       s.effective_ms,
       s.max_position_ms,
       s.rolling_event_digest,
       s.user_id,
       i.item_type,
       i.completion_policy_version,
       i.completion_threshold_bps,
       v.status AS version_status,
       c.status AS course_status,
       m.status AS media_status,
       m.duration_ms,
       GREATEST(
         0,
         FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - s.last_event_at)) * 1000)
       )::bigint AS elapsed_ms
     FROM elearning_learning_sessions s
     JOIN elearning_course_version_items i
       ON i.org_id = s.org_id
      AND i.course_version_id = s.course_version_id
      AND i.id = s.course_version_item_id
     JOIN elearning_course_versions v
       ON v.org_id = s.org_id AND v.id = s.course_version_id
     JOIN elearning_courses c
       ON c.org_id = v.org_id AND c.id = v.course_id
     LEFT JOIN elearning_media m
       ON m.org_id = i.org_id AND m.id = i.media_id
     WHERE s.org_id = $1 AND s.id = $2
     FOR SHARE OF c FOR UPDATE OF s`,
    [orgId, sessionId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  if (asText(row.user_id) !== userId) fail('not_found')
  if (asText(row.course_status) === 'withdrawn') fail('course_withdrawn')
  const versionStatus = asText(row.version_status)
  if (versionStatus !== 'published' && versionStatus !== 'retired') fail('unsupported_item')
  if (asText(row.item_type) !== 'video') fail('unsupported_item')
  if (asText(row.media_status) !== 'ready') fail('unsupported_item')
  const durationMs = asSafeInt(row.duration_ms)
  if (durationMs === null || durationMs <= 0) fail('unsupported_item')
  if (
    asText(row.completion_policy_version) !== ELEARNING_WATCH_POLICY_VERSION ||
    asSafeInt(row.completion_threshold_bps) !== ELEARNING_WATCH_THRESHOLD_BPS
  ) {
    fail('unsupported_policy')
  }
  return {
    session: parseSessionRow(row, requireRowInt(row.elapsed_ms)),
    durationMs,
  }
}

async function loadEventPayload(
  tx: ElearningWatchQueryable,
  orgId: string,
  sessionId: string,
  sequence: number,
): Promise<{ reportedPositionMs: number; playing: boolean } | null> {
  const result = await tx.query(
    `/* elearning-watch:load-event */
     SELECT reported_position_ms, playing
       FROM elearning_progress_events
      WHERE org_id = $1 AND session_id = $2 AND sequence = $3`,
    [orgId, sessionId, sequence],
  )
  const row = result.rows[0]
  if (!row) return null
  const playing = asBoolean(row.playing)
  if (playing === null) fail('unavailable')
  return {
    reportedPositionMs: requireRowInt(row.reported_position_ms),
    playing,
  }
}

export async function recordElearningHeartbeat(
  db: ElearningWatchDb,
  input: RecordElearningHeartbeatInput,
): Promise<ElearningWatchState> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const sessionId = requireUuid(input.sessionId)
  const sequence = requireSafeInt(input.sequence, 1)
  const positionMs = requireSafeInt(input.positionMs, 0)
  const playing = requireBoolean(input.playing)
  const challengeEnabled = input.challengeEnabled === true

  return db.transaction(async (tx) => {
    const itemId = await peekSessionItem(tx, orgId, sessionId, userId)
    await advisoryLock(tx, orgId, userId, itemId)
    await lockCourseHead(tx, orgId, itemId)
    const { session, durationMs } = await lockHeartbeatSession(tx, orgId, sessionId, userId)
    const access = await resolveWatchAccess(tx, orgId, userId, session.versionId)
    const progress = await lockProgress(tx, orgId, userId, session.itemId)
    if (!progress) fail('unavailable')

    if (session.status === 'active' && progress.status === 'in_progress') {
      await rebindInProgressAccess(tx, {
        orgId,
        userId,
        itemId: session.itemId,
        sessionId: session.id,
        access,
      })
    }

    if (sequence <= session.lastSequence) {
      const prior = await loadEventPayload(tx, orgId, sessionId, sequence)
      if (!prior) fail('conflict')
      const clamped = Math.min(positionMs, durationMs)
      if (prior.reportedPositionMs !== clamped || prior.playing !== playing) {
        fail('conflict')
      }
      let challenge: ElearningWatchChallengeView | null | undefined
      if (challengeEnabled) {
        try {
          challenge = await getElearningWatchChallengeView(tx, { orgId, userId, sessionId })
        } catch (error) {
          rethrowChallenge(error)
        }
      }
      return stateFrom(
        session.id,
        progress.status,
        session.lastSequence,
        session.lastClientPositionMs,
        session.effectiveMs,
        session.maxPositionMs,
        durationMs,
        0,
        true,
        challenge,
      )
    }

    if (sequence > session.lastSequence + 1) fail('sequence_gap')
    if (session.status !== 'active' || progress.status !== 'in_progress') {
      fail('session_inactive')
    }

    const credit = computeElearningWatchCredit({
      playing,
      reportedPositionMs: positionMs,
      durationMs,
      priorMaxPositionMs: session.maxPositionMs,
      priorLastClientPositionMs: session.lastClientPositionMs,
      elapsedMs: session.elapsedMs,
    })
    let challengeResult = {
      challenge: undefined as ElearningWatchChallengeView | null | undefined,
      creditedMs: credit.creditedMs,
      discardedMs: 0,
      maxPositionMs: credit.maxPositionMs,
    }
    if (challengeEnabled) {
      try {
        challengeResult = await applyElearningWatchChallengeHeartbeat(tx, {
          orgId,
          userId,
          sessionId,
          rawCreditedMs: credit.creditedMs,
          rawMaxPositionMs: credit.maxPositionMs,
          nextEffectiveMs: session.effectiveMs + credit.creditedMs,
        })
      } catch (error) {
        rethrowChallenge(error)
      }
    }
    const nextEffective = session.effectiveMs + challengeResult.creditedMs
    const parts = {
      sequence,
      kind: 'heartbeat' as const,
      reportedPositionMs: credit.clampedPositionMs,
      playing,
      creditedMs: challengeResult.creditedMs,
    }
    const digest = rollElearningWatchEventDigest(session.rollingEventDigest, parts)
    const completed =
      nextEffective >= elearningWatchCompletionThresholdMs(durationMs, ELEARNING_WATCH_THRESHOLD_BPS)
      && (!challengeEnabled || challengeResult.challenge === null)

    await tx.query(
      `/* elearning-watch:insert-event */
       INSERT INTO elearning_progress_events (
         org_id, session_id, course_version_id, course_version_item_id, user_id,
         sequence, kind, reported_position_ms, playing, credited_ms, event_digest
       ) VALUES ($1, $2, $3, $4, $5, $6, 'heartbeat', $7, $8, $9, $10)`,
      [
        orgId,
        session.id,
        session.versionId,
        session.itemId,
        userId,
        sequence,
        credit.clampedPositionMs,
        playing,
        challengeResult.creditedMs,
        digest,
      ],
    )
    await tx.query(
      `/* elearning-watch:update-session */
       UPDATE elearning_learning_sessions
          SET last_sequence = $1,
              last_client_position_ms = $2,
              effective_ms = $3,
              max_position_ms = $4,
              rolling_event_digest = $5,
              last_event_at = clock_timestamp()
        WHERE org_id = $6 AND id = $7 AND status = 'active'`,
      [
        sequence,
        credit.clampedPositionMs,
        nextEffective,
        challengeResult.maxPositionMs,
        digest,
        orgId,
        session.id,
      ],
    )
    await tx.query(
      `/* elearning-watch:update-progress */
       UPDATE elearning_progress
          SET effective_ms = $1,
              max_position_ms = $2
        WHERE org_id = $3
          AND user_id = $4
          AND course_version_item_id = $5
          AND status = 'in_progress'`,
      [nextEffective, challengeResult.maxPositionMs, orgId, userId, session.itemId],
    )

    if (completed) {
      await tx.query(
        `/* elearning-watch:insert-evidence */
         INSERT INTO elearning_completion_evidence (
           org_id, assignment_member_id, scope_revision_rule_id, course_version_id,
           course_version_item_id, user_id, item_type, completion_policy_version,
           completion_threshold_bps, media_duration_ms, effective_ms, max_position_ms,
           event_digest, evaluator_version, completed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'video', $7, $8, $9, $10, $11, $12, $13,
           clock_timestamp()
         )`,
        [
          orgId,
          access.assignmentMemberId,
          access.scopeRevisionRuleId,
          session.versionId,
          session.itemId,
          userId,
          ELEARNING_WATCH_POLICY_VERSION,
          ELEARNING_WATCH_THRESHOLD_BPS,
          durationMs,
          nextEffective,
          challengeResult.maxPositionMs,
          digest,
          ELEARNING_WATCH_EVALUATOR_VERSION,
        ],
      )
      await tx.query(
        `/* elearning-watch:complete-progress */
         UPDATE elearning_progress
            SET status = 'completed',
                completed_at = clock_timestamp(),
                required_at_completion = $1
          WHERE org_id = $2
            AND user_id = $3
            AND course_version_item_id = $4
            AND status = 'in_progress'`,
        [access.required, orgId, userId, session.itemId],
      )
      await tx.query(
        `/* elearning-watch:close-session */
         UPDATE elearning_learning_sessions
            SET status = 'completed',
                closed_at = clock_timestamp()
          WHERE org_id = $1 AND id = $2 AND status = 'active'`,
        [orgId, session.id],
      )
      if (challengeEnabled) {
        try {
          await completeElearningWatchChallengeSchedule(tx, orgId, session.id)
        } catch (error) {
          rethrowChallenge(error)
        }
      }
    }

    return stateFrom(
      session.id,
      completed ? 'completed' : 'in_progress',
      sequence,
      credit.clampedPositionMs,
      nextEffective,
      challengeResult.maxPositionMs,
      durationMs,
      challengeResult.creditedMs,
      false,
      challengeResult.challenge,
    )
  })
}

function parseStoredChallengeAckState(input: object): ElearningWatchState {
  const row = input as Record<string, unknown>
  const keys = Object.keys(row).sort()
  const expected = [
    'challenge', 'creditedMs', 'duplicate', 'durationMs', 'effectiveMs',
    'lastClientPositionMs', 'lastSequence', 'maxPositionMs', 'sessionId', 'status',
  ].sort()
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || row.challenge !== null
    || row.duplicate !== false
    || asText(row.sessionId) === null
    || (row.status !== 'in_progress' && row.status !== 'completed')
  ) fail('unavailable')
  for (const key of [
    'creditedMs', 'durationMs', 'effectiveMs', 'lastClientPositionMs',
    'lastSequence', 'maxPositionMs',
  ]) {
    if (asSafeInt(row[key]) === null) fail('unavailable')
  }
  return row as unknown as ElearningWatchState
}

export async function acknowledgeElearningWatchChallenge(
  db: ElearningWatchDb,
  input: AcknowledgeElearningWatchChallengeInput,
): Promise<ElearningWatchState> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const sessionId = requireUuid(input.sessionId)
  const challengeId = requireUuid(input.challengeId)
  const requestId = requireUuid(input.requestId)

  return db.transaction(async (tx) => {
    const itemId = await peekSessionItem(tx, orgId, sessionId, userId)
    await advisoryLock(tx, orgId, userId, itemId)
    await lockCourseHead(tx, orgId, itemId)
    const { session, durationMs } = await lockHeartbeatSession(tx, orgId, sessionId, userId)
    const access = await resolveWatchAccess(tx, orgId, userId, session.versionId)
    const progress = await lockProgress(tx, orgId, userId, session.itemId)
    if (!progress) fail('unavailable')
    if (session.status === 'active' && progress.status === 'in_progress') {
      await rebindInProgressAccess(tx, {
        orgId,
        userId,
        itemId: session.itemId,
        sessionId: session.id,
        access,
      })
    }

    let acknowledged: { duplicate: boolean; result: ElearningWatchState }
    try {
      acknowledged = await acknowledgeElearningWatchChallengeState(tx, {
        orgId,
        userId,
        requestId,
        sessionId,
        challengeId,
      }, async (transition) => {
        if (session.status !== 'active' || progress.status !== 'in_progress') {
          fail('session_inactive')
        }
        const nextEffective = session.effectiveMs + transition.creditedMs
        if (!Number.isSafeInteger(nextEffective)) fail('unavailable')
        const digest = createHash('sha256').update([
          'elearning.watch.challenge.ack.digest.v1',
          session.rollingEventDigest,
          challengeId,
          String(transition.creditedMs),
          String(transition.discardedMs),
        ].join('\n'), 'utf8').digest('hex')
        const completed = nextEffective >= elearningWatchCompletionThresholdMs(
          durationMs,
          ELEARNING_WATCH_THRESHOLD_BPS,
        )
        const sessionUpdate = await tx.query(
          `/* elearning-watch-challenge:update-session */
           UPDATE elearning_learning_sessions
              SET effective_ms = $1, max_position_ms = $2,
                  rolling_event_digest = $3, last_event_at = clock_timestamp()
            WHERE org_id = $4 AND id = $5 AND status = 'active'`,
          [nextEffective, transition.maxPositionMs, digest, orgId, session.id],
        )
        if (sessionUpdate.rowCount !== 1) fail('unavailable')
        const progressUpdate = await tx.query(
          `/* elearning-watch-challenge:update-progress */
           UPDATE elearning_progress
              SET effective_ms = $1, max_position_ms = $2
            WHERE org_id = $3 AND user_id = $4
              AND course_version_item_id = $5 AND status = 'in_progress'`,
          [nextEffective, transition.maxPositionMs, orgId, userId, session.itemId],
        )
        if (progressUpdate.rowCount !== 1) fail('unavailable')

        if (completed) {
          await tx.query(
            `/* elearning-watch-challenge:insert-evidence */
             INSERT INTO elearning_completion_evidence (
               org_id, assignment_member_id, scope_revision_rule_id, course_version_id,
               course_version_item_id, user_id, item_type, completion_policy_version,
               completion_threshold_bps, media_duration_ms, effective_ms, max_position_ms,
               event_digest, evaluator_version, completed_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, 'video', $7, $8, $9, $10, $11, $12, $13,
               clock_timestamp()
             )`,
            [
              orgId, access.assignmentMemberId, access.scopeRevisionRuleId,
              session.versionId, session.itemId, userId, ELEARNING_WATCH_POLICY_VERSION,
              ELEARNING_WATCH_THRESHOLD_BPS, durationMs, nextEffective,
              transition.maxPositionMs, digest, ELEARNING_WATCH_EVALUATOR_VERSION,
            ],
          )
          await tx.query(
            `/* elearning-watch-challenge:complete-progress */
             UPDATE elearning_progress
                SET status = 'completed', completed_at = clock_timestamp(),
                    required_at_completion = $1
              WHERE org_id = $2 AND user_id = $3
                AND course_version_item_id = $4 AND status = 'in_progress'`,
            [access.required, orgId, userId, session.itemId],
          )
          await tx.query(
            `/* elearning-watch-challenge:close-session */
             UPDATE elearning_learning_sessions
                SET status = 'completed', closed_at = clock_timestamp()
              WHERE org_id = $1 AND id = $2 AND status = 'active'`,
            [orgId, session.id],
          )
          await completeElearningWatchChallengeSchedule(tx, orgId, session.id)
        }
        return stateFrom(
          session.id,
          completed ? 'completed' : 'in_progress',
          session.lastSequence,
          session.lastClientPositionMs,
          nextEffective,
          transition.maxPositionMs,
          durationMs,
          transition.creditedMs,
          false,
          null,
        )
      })
    } catch (error) {
      rethrowChallenge(error)
    }
    const result = parseStoredChallengeAckState(acknowledged.result)
    return { ...result, duplicate: acknowledged.duplicate }
  })
}

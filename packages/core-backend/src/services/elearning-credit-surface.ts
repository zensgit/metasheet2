import { createHash, randomUUID } from 'node:crypto'

import {
  normalizeElearningCreditBehavior,
  normalizeElearningCreditTimeZone,
  type ElearningCreditBehavior,
} from './elearning-credit-policy'

export const ELEARNING_CREDIT_RULE_REQUEST_DOMAIN =
  'elearning.credit.rule.request.v1' as const
export const ELEARNING_CREDIT_RULE_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_CREDIT_WALLET_PAGE_DEFAULT = 20 as const
export const ELEARNING_CREDIT_WALLET_PAGE_MAX = 100 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AUTOMATIC_BEHAVIORS = new Set<ElearningCreditBehavior>([
  'login',
  'complete_course',
  'complete_plan',
  'pass_exam',
  'submit_survey',
  'complete_map',
  'complete_offline',
])

export type ElearningCreditSurfaceErrorCode =
  | 'invalid_input'
  | 'conflict'
  | 'not_found'
  | 'unavailable'

export class ElearningCreditSurfaceError extends Error {
  constructor(readonly code: ElearningCreditSurfaceErrorCode) {
    super(code)
    this.name = 'ElearningCreditSurfaceError'
  }
}

export interface ElearningCreditSurfaceQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningCreditSurfaceDb extends ElearningCreditSurfaceQueryable {
  transaction<T>(handler: (tx: ElearningCreditSurfaceQueryable) => Promise<T>): Promise<T>
}

export interface ElearningCreditRule {
  behavior: Exclude<ElearningCreditBehavior, 'manual_adjust'>
  ruleId: string
  version: number
  points: number
  dailyCap: number | null
  timeZone: string
  createdAt: string
}

export interface PublishElearningCreditRuleInput {
  orgId: string
  actorId: string
  requestId: string
  behavior: unknown
  points: unknown
  dailyCap: unknown
  timeZone: unknown
}

export interface PublishElearningCreditRuleResult extends ElearningCreditRule {
  duplicate: boolean
}

export interface ElearningCreditWalletItem {
  decisionId: string
  behavior: Exclude<ElearningCreditBehavior, 'manual_adjust'>
  awardedPoints: number
  status: 'awarded' | 'capped' | 'exhausted'
  occurredAt: string
  createdAt: string
}

export interface ElearningCreditWalletResult {
  userId: string
  balancePoints: number
  items: ElearningCreditWalletItem[]
  nextCursor: string | null
}

export interface GetElearningCreditWalletInput {
  orgId: string
  userId: string
  limit?: number
  cursor?: string | null
}

type WalletCursor = { createdAt: string; decisionId: string }

function fail(code: ElearningCreditSurfaceErrorCode): never {
  throw new ElearningCreditSurfaceError(code)
}

function requireText(value: unknown, max = 512): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > max || text.includes('\0')) fail('invalid_input')
  return text
}

function requirePositiveInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('invalid_input')
  }
  return value
}

function normalizeDailyCap(value: unknown): number | null {
  return value === null ? null : requirePositiveInt(value)
}

function normalizeAutomaticBehavior(
  value: unknown,
): Exclude<ElearningCreditBehavior, 'manual_adjust'> {
  try {
    const behavior = normalizeElearningCreditBehavior(value)
    if (!AUTOMATIC_BEHAVIORS.has(behavior)) fail('invalid_input')
    return behavior as Exclude<ElearningCreditBehavior, 'manual_adjust'>
  } catch (error) {
    if (error instanceof ElearningCreditSurfaceError) throw error
    fail('invalid_input')
  }
}

function normalizeTimeZone(value: unknown): string {
  try {
    return normalizeElearningCreditTimeZone(value)
  } catch {
    fail('invalid_input')
  }
}

function canonicalize(value: unknown): string {
  const walk = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(walk)
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.keys(candidate as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((candidate as Record<string, unknown>)[key])]),
      )
    }
    return candidate
  }
  return JSON.stringify(walk(value ?? null))
}

export function hashElearningCreditRuleRequest(input: {
  behavior: Exclude<ElearningCreditBehavior, 'manual_adjust'>
  points: number
  dailyCap: number | null
  timeZone: string
}): string {
  return createHash('sha256')
    .update(canonicalize({
      behavior: input.behavior,
      dailyCap: input.dailyCap,
      domain: ELEARNING_CREDIT_RULE_REQUEST_DOMAIN,
      points: input.points,
      timeZone: input.timeZone,
      version: ELEARNING_CREDIT_RULE_REQUEST_HASH_VERSION,
    }), 'utf8')
    .digest('hex')
}

function storedText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function storedInt(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value)
      ? Number(value)
      : Number.NaN
  return Number.isSafeInteger(parsed) ? parsed : null
}

function storedDate(value: unknown): string | null {
  const date = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function storedRule(row: Record<string, unknown>): ElearningCreditRule {
  const behavior = normalizeAutomaticBehavior(row.behavior)
  const ruleId = storedText(row.rule_id ?? row.id)
  const version = storedInt(row.rule_version ?? row.version)
  const points = storedInt(row.points)
  const dailyCap = row.daily_cap === null ? null : storedInt(row.daily_cap)
  const timeZone = storedText(row.time_zone)
  const createdAt = storedDate(row.created_at)
  if (
    !ruleId
    || !version
    || !points
    || dailyCap !== null && dailyCap <= 0
    || !timeZone
    || !createdAt
  ) fail('unavailable')
  return { behavior, ruleId, version, points, dailyCap, timeZone, createdAt }
}

function commandLockKey(orgId: string, requestId: string): string {
  return `${orgId}:request:${requestId}`
}

function behaviorLockKey(orgId: string, behavior: string): string {
  return `${orgId}:behavior:${behavior}`
}

export async function publishElearningCreditRule(
  db: ElearningCreditSurfaceDb,
  input: PublishElearningCreditRuleInput,
): Promise<PublishElearningCreditRuleResult> {
  const orgId = requireText(input.orgId, 256)
  const actorId = requireText(input.actorId, 256)
  const requestId = requireText(input.requestId, 256)
  const behavior = normalizeAutomaticBehavior(input.behavior)
  const points = requirePositiveInt(input.points)
  const dailyCap = normalizeDailyCap(input.dailyCap)
  const timeZone = normalizeTimeZone(input.timeZone)
  const requestHash = hashElearningCreditRuleRequest({
    behavior,
    dailyCap,
    points,
    timeZone,
  })

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `/* elearning-credit-rule:request-lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['elearning-credit-rule-request', commandLockKey(orgId, requestId)],
      )
      const existing = await tx.query(
        `/* elearning-credit-rule:load-request */
         SELECT
           request_hash, request_hash_version, rule_id, rule_version,
           behavior, points, daily_cap, time_zone, created_at
         FROM elearning_credit_rule_requests
         WHERE org_id = $1 AND source_key = $2
         FOR SHARE`,
        [orgId, requestId],
      )
      if (existing.rows.length > 1) fail('unavailable')
      if (existing.rows[0]) {
        if (
          storedText(existing.rows[0].request_hash) !== requestHash
          || storedInt(existing.rows[0].request_hash_version)
            !== ELEARNING_CREDIT_RULE_REQUEST_HASH_VERSION
        ) fail('conflict')
        return { ...storedRule(existing.rows[0]), duplicate: true }
      }

      await tx.query(
        `/* elearning-credit-rule:behavior-lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['elearning-credit-rule-behavior', behaviorLockKey(orgId, behavior)],
      )
      const latest = await tx.query(
        `/* elearning-credit-rule:load-latest */
         SELECT id, version
         FROM elearning_credit_rules
         WHERE org_id = $1 AND behavior = $2
         ORDER BY version DESC
         LIMIT 1
         FOR UPDATE`,
        [orgId, behavior],
      )
      if (latest.rows.length > 1) fail('unavailable')
      const previousId = latest.rows[0] ? storedText(latest.rows[0].id) : null
      const previousVersion = latest.rows[0] ? storedInt(latest.rows[0].version) : null
      if (latest.rows[0] && (!previousId || !previousVersion)) fail('unavailable')
      const ruleId = previousId ?? randomUUID()
      const version = previousVersion === null ? 1 : previousVersion + 1
      if (!Number.isSafeInteger(version) || version <= 0) fail('unavailable')

      await tx.query(
        `/* elearning-credit-rule:retire-active */
         UPDATE elearning_credit_rules
         SET status = 'retired'
         WHERE org_id = $1 AND behavior = $2 AND status = 'active'`,
        [orgId, behavior],
      )
      const inserted = await tx.query(
        `/* elearning-credit-rule:insert-version */
         INSERT INTO elearning_credit_rules (
           org_id, id, version, behavior, points, daily_cap, time_zone, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         RETURNING created_at`,
        [orgId, ruleId, version, behavior, points, dailyCap, timeZone],
      )
      const createdAt = storedDate(inserted.rows[0]?.created_at)
      if (inserted.rows.length !== 1 || !createdAt) fail('unavailable')
      await tx.query(
        `/* elearning-credit-rule:record-request */
         INSERT INTO elearning_credit_rule_requests (
           org_id, source_key, request_hash, request_hash_version, actor_id,
           rule_id, rule_version, behavior, points, daily_cap, time_zone
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          orgId,
          requestId,
          requestHash,
          ELEARNING_CREDIT_RULE_REQUEST_HASH_VERSION,
          actorId,
          ruleId,
          version,
          behavior,
          points,
          dailyCap,
          timeZone,
        ],
      )
      return {
        behavior,
        ruleId,
        version,
        points,
        dailyCap,
        timeZone,
        createdAt,
        duplicate: false,
      }
    })
  } catch (error) {
    if (error instanceof ElearningCreditSurfaceError) throw error
    fail('unavailable')
  }
}

export async function listElearningCreditRules(
  db: ElearningCreditSurfaceQueryable,
  orgIdInput: string,
): Promise<ElearningCreditRule[]> {
  const orgId = requireText(orgIdInput, 256)
  try {
    const result = await db.query(
      `/* elearning-credit-rule:list-active */
       SELECT id, version, behavior, points, daily_cap, time_zone, created_at
       FROM elearning_credit_rules
       WHERE org_id = $1 AND status = 'active'
       ORDER BY behavior ASC`,
      [orgId],
    )
    return result.rows.map(storedRule)
  } catch (error) {
    if (error instanceof ElearningCreditSurfaceError) throw error
    fail('unavailable')
  }
}

function encodeCursor(cursor: WalletCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: unknown): WalletCursor | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('invalid_input')
  }
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) fail('invalid_input')
    const parsed = JSON.parse(decoded.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid_input')
    const object = parsed as Record<string, unknown>
    if (
      Object.keys(object).sort().join(',') !== 'createdAt,decisionId'
      || typeof object.createdAt !== 'string'
      || !UUID_RE.test(String(object.decisionId))
    ) fail('invalid_input')
    const date = new Date(object.createdAt)
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== object.createdAt) {
      fail('invalid_input')
    }
    return {
      createdAt: object.createdAt,
      decisionId: String(object.decisionId).toLowerCase(),
    }
  } catch (error) {
    if (error instanceof ElearningCreditSurfaceError) throw error
    fail('invalid_input')
  }
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) return ELEARNING_CREDIT_WALLET_PAGE_DEFAULT
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > ELEARNING_CREDIT_WALLET_PAGE_MAX
  ) fail('invalid_input')
  return value
}

function storedWalletItem(row: Record<string, unknown>): ElearningCreditWalletItem {
  const decisionId = storedText(row.id)
  const behavior = normalizeAutomaticBehavior(row.behavior)
  const awardedPoints = storedInt(row.awarded_points)
  const status = row.status === 'awarded' || row.status === 'capped' || row.status === 'exhausted'
    ? row.status
    : null
  const occurredAt = storedDate(row.occurred_at)
  const createdAt = storedDate(row.created_at)
  if (
    !decisionId
    || !UUID_RE.test(decisionId)
    || awardedPoints === null
    || awardedPoints < 0
    || !status
    || !occurredAt
    || !createdAt
  ) fail('unavailable')
  return {
    decisionId: decisionId.toLowerCase(),
    behavior,
    awardedPoints,
    status,
    occurredAt,
    createdAt,
  }
}

export async function getElearningCreditWallet(
  db: ElearningCreditSurfaceDb,
  input: GetElearningCreditWalletInput,
): Promise<ElearningCreditWalletResult> {
  const orgId = requireText(input.orgId, 256)
  const userId = requireText(input.userId, 256)
  const limit = normalizeLimit(input.limit)
  const cursor = decodeCursor(input.cursor)

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `/* elearning-credit-wallet:snapshot */
         SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
      )
      const member = await tx.query(
        `/* elearning-credit-wallet:membership */
         SELECT 1 AS ok
         FROM user_orgs membership
         JOIN users account ON account.id = membership.user_id
         WHERE membership.org_id = $1
           AND membership.user_id = $2
           AND membership.is_active = true
           AND account.is_active = true`,
        [orgId, userId],
      )
      if (member.rows.length !== 1) fail('not_found')

      const balance = await tx.query(
        `/* elearning-credit-wallet:balance */
         SELECT balance_points
         FROM elearning_credit_balances
         WHERE org_id = $1 AND user_id = $2`,
        [orgId, userId],
      )
      if (balance.rows.length > 1) fail('unavailable')
      const balancePoints = balance.rows.length === 0
        ? 0
        : storedInt(balance.rows[0]?.balance_points)
      if (balancePoints === null || balancePoints < 0) fail('unavailable')

      const params: unknown[] = [orgId, userId]
      let after = ''
      if (cursor) {
        params.push(cursor.createdAt, cursor.decisionId)
        after = `AND (created_at, id) < ($3::timestamptz, $4::uuid)`
      }
      params.push(limit + 1)
      const result = await tx.query(
        `/* elearning-credit-wallet:history */
         SELECT id::text, behavior, awarded_points, status, occurred_at, created_at
         FROM elearning_credit_decisions
         WHERE org_id = $1 AND user_id = $2
         ${after}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
        params,
      )
      const rows = result.rows.map(storedWalletItem)
      const hasMore = rows.length > limit
      const items = hasMore ? rows.slice(0, limit) : rows
      const last = items.at(-1)
      return {
        userId,
        balancePoints,
        items,
        nextCursor: hasMore && last
          ? encodeCursor({ createdAt: last.createdAt, decisionId: last.decisionId })
          : null,
      }
    })
  } catch (error) {
    if (error instanceof ElearningCreditSurfaceError) throw error
    fail('unavailable')
  }
}

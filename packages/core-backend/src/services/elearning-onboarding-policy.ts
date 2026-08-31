import { createHash, randomUUID } from 'node:crypto'

import { normalizeElearningBatchAssignmentRules } from './elearning-batch-assignment'
import type { ElearningAudienceRule } from './elearning-audience-resolver'

export const ELEARNING_ONBOARDING_POLICY_REQUEST_DOMAIN =
  'elearning.onboarding.policy.request.v1' as const
export const ELEARNING_ONBOARDING_POLICY_HASH_VERSION = 1 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ElearningOnboardingPolicyErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unavailable'

export class ElearningOnboardingPolicyError extends Error {
  constructor(readonly code: ElearningOnboardingPolicyErrorCode) {
    super(code)
    this.name = 'ElearningOnboardingPolicyError'
  }
}

export interface ElearningOnboardingPolicyQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningOnboardingPolicyDb extends ElearningOnboardingPolicyQueryable {
  transaction<T>(run: (tx: ElearningOnboardingPolicyQueryable) => Promise<T>): Promise<T>
}

export interface CreateElearningOnboardingPolicyInput {
  orgId: unknown
  actorId: unknown
  requestId: unknown
  trainingPlanId: unknown
  matchRules: unknown
  hireWindowDays: unknown
  deadlineDays: unknown
  weeklyReportEnabled: unknown
}

export interface RetireElearningOnboardingPolicyInput {
  orgId: unknown
  actorId: unknown
  policyId: unknown
}

export interface ElearningOnboardingPolicyDto {
  policyId: string
  trainingPlanId: string
  matchRules: ElearningAudienceRule[]
  hireWindowDays: number
  deadlineDays: number
  weeklyReportEnabled: boolean
  status: 'active' | 'retired'
  createdAt: string
  retiredAt: string | null
  duplicate: boolean
}

interface CanonicalPolicyRequest {
  trainingPlanId: string
  matchRules: ElearningAudienceRule[]
  hireWindowDays: number
  deadlineDays: number
  weeklyReportEnabled: boolean
}

function fail(code: ElearningOnboardingPolicyErrorCode): never {
  throw new ElearningOnboardingPolicyError(code)
}

function requireText(value: unknown, max = 512): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > max || text.includes('\0')) fail('invalid_input')
  return text
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function requireInteger(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    fail('invalid_input')
  }
  return value as number
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('invalid_input')
  return value
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') fail('unavailable')
  return value
}

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function storedInteger(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('unavailable')
  return parsed
}

function storedBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('unavailable')
  return value
}

function storedTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) fail('unavailable')
  return date.toISOString()
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
  return JSON.stringify(walk(value))
}

export function normalizeElearningOnboardingMatchRules(
  value: unknown,
): ElearningAudienceRule[] {
  let rules: ElearningAudienceRule[]
  try {
    rules = normalizeElearningBatchAssignmentRules(value)
  } catch {
    fail('invalid_input')
  }
  if (
    rules.length < 1
    || rules.some((rule) => !['department', 'position'].includes(rule.subjectType))
  ) fail('invalid_input')
  return rules
}

export function canonicalizeElearningOnboardingPolicyRequest(
  input: CanonicalPolicyRequest,
): string {
  return canonicalize({
    deadlineDays: input.deadlineDays,
    domain: ELEARNING_ONBOARDING_POLICY_REQUEST_DOMAIN,
    hireWindowDays: input.hireWindowDays,
    matchRules: input.matchRules,
    trainingPlanId: input.trainingPlanId,
    version: ELEARNING_ONBOARDING_POLICY_HASH_VERSION,
    weeklyReportEnabled: input.weeklyReportEnabled,
  })
}

export function hashElearningOnboardingPolicyRequest(
  input: CanonicalPolicyRequest,
): string {
  return createHash('sha256')
    .update(canonicalizeElearningOnboardingPolicyRequest(input), 'utf8')
    .digest('hex')
}

function storedRules(value: unknown): ElearningAudienceRule[] {
  try {
    return normalizeElearningOnboardingMatchRules(value)
  } catch {
    fail('unavailable')
  }
}

function storedStatus(value: unknown): 'active' | 'retired' {
  if (value !== 'active' && value !== 'retired') fail('unavailable')
  return value
}

function dto(row: Record<string, unknown>, duplicate: boolean): ElearningOnboardingPolicyDto {
  const status = storedStatus(row.status)
  const retiredAt = row.retired_at === null ? null : storedTimestamp(row.retired_at)
  if ((status === 'active') !== (retiredAt === null)) fail('unavailable')
  return {
    policyId: storedUuid(row.id),
    trainingPlanId: storedUuid(row.training_plan_id),
    matchRules: storedRules(row.match_rules),
    hireWindowDays: storedInteger(row.hire_window_days),
    deadlineDays: storedInteger(row.deadline_days),
    weeklyReportEnabled: storedBoolean(row.weekly_report_enabled),
    status,
    createdAt: storedTimestamp(row.created_at),
    retiredAt,
    duplicate,
  }
}

async function assertActiveActor(
  db: ElearningOnboardingPolicyQueryable,
  orgId: string,
  actorId: string,
): Promise<void> {
  const result = await db.query(
    `/* elearning-onboarding-policy:actor */
     SELECT platform_user.id
     FROM users platform_user
     JOIN user_orgs membership
       ON membership.user_id = platform_user.id
      AND membership.org_id = $1
      AND membership.is_active = TRUE
     WHERE platform_user.id = $2
       AND platform_user.is_active = TRUE
     FOR SHARE OF platform_user, membership`,
    [orgId, actorId],
  )
  if (result.rows.length !== 1) fail('forbidden')
}

export async function createElearningOnboardingPolicy(
  db: ElearningOnboardingPolicyDb,
  input: CreateElearningOnboardingPolicyInput,
): Promise<ElearningOnboardingPolicyDto> {
  const orgId = requireText(input.orgId, 256)
  const actorId = requireText(input.actorId, 256)
  const requestId = requireUuid(input.requestId)
  const trainingPlanId = requireUuid(input.trainingPlanId)
  const matchRules = normalizeElearningOnboardingMatchRules(input.matchRules)
  const hireWindowDays = requireInteger(input.hireWindowDays, 365)
  const deadlineDays = requireInteger(input.deadlineDays, 3650)
  const weeklyReportEnabled = requireBoolean(input.weeklyReportEnabled)
  const requestHash = hashElearningOnboardingPolicyRequest({
    trainingPlanId,
    matchRules,
    hireWindowDays,
    deadlineDays,
    weeklyReportEnabled,
  })

  return db.transaction(async (tx) => {
    try {
      await tx.query(
        `/* elearning-onboarding-policy:lock-request */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`elearning-onboarding-policy:${orgId}:${requestId}`],
      )
      const existing = await tx.query(
        `/* elearning-onboarding-policy:load-request */
         SELECT id, training_plan_id, match_rules, hire_window_days,
                deadline_days, weekly_report_enabled, status, created_at, retired_at,
                request_hash, request_hash_version
         FROM elearning_onboarding_policies
         WHERE org_id = $1 AND request_id = $2
         FOR UPDATE`,
        [orgId, requestId],
      )
      if (existing.rows[0]) {
        if (
          storedText(existing.rows[0].request_hash) !== requestHash
          || storedInteger(existing.rows[0].request_hash_version)
            !== ELEARNING_ONBOARDING_POLICY_HASH_VERSION
        ) fail('conflict')
        return dto(existing.rows[0], true)
      }

      await assertActiveActor(tx, orgId, actorId)
      const plan = await tx.query(
        `/* elearning-onboarding-policy:plan */
         SELECT id
         FROM elearning_training_plans
         WHERE org_id = $1 AND id = $2 AND status = 'active'
         FOR SHARE`,
        [orgId, trainingPlanId],
      )
      if (plan.rows.length !== 1) fail('not_found')

      const inserted = await tx.query(
        `/* elearning-onboarding-policy:insert */
         INSERT INTO elearning_onboarding_policies (
           id, org_id, request_id, request_hash, request_hash_version,
           training_plan_id, match_rules, hire_window_days, deadline_days,
           weekly_report_enabled, status, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'active', $11)
         RETURNING id, training_plan_id, match_rules, hire_window_days,
                   deadline_days, weekly_report_enabled, status, created_at, retired_at`,
        [
          randomUUID(), orgId, requestId, requestHash,
          ELEARNING_ONBOARDING_POLICY_HASH_VERSION, trainingPlanId,
          JSON.stringify(matchRules), hireWindowDays, deadlineDays,
          weeklyReportEnabled, actorId,
        ],
      )
      if (inserted.rows.length !== 1) fail('unavailable')
      return dto(inserted.rows[0], false)
    } catch (error) {
      if (error instanceof ElearningOnboardingPolicyError) throw error
      fail('unavailable')
    }
  })
}

export async function retireElearningOnboardingPolicy(
  db: ElearningOnboardingPolicyDb,
  input: RetireElearningOnboardingPolicyInput,
): Promise<ElearningOnboardingPolicyDto> {
  const orgId = requireText(input.orgId, 256)
  const actorId = requireText(input.actorId, 256)
  const policyId = requireUuid(input.policyId)
  return db.transaction(async (tx) => {
    try {
      await assertActiveActor(tx, orgId, actorId)
      const current = await tx.query(
        `/* elearning-onboarding-policy:lock-retire */
         SELECT id, training_plan_id, match_rules, hire_window_days,
                deadline_days, weekly_report_enabled, status, created_at, retired_at
         FROM elearning_onboarding_policies
         WHERE org_id = $1 AND id = $2
         FOR UPDATE`,
        [orgId, policyId],
      )
      if (!current.rows[0]) fail('not_found')
      if (current.rows[0].status === 'retired') return dto(current.rows[0], true)
      const updated = await tx.query(
        `/* elearning-onboarding-policy:retire */
         UPDATE elearning_onboarding_policies
         SET status = 'retired', retired_at = clock_timestamp(), retired_by = $3
         WHERE org_id = $1 AND id = $2 AND status = 'active'
         RETURNING id, training_plan_id, match_rules, hire_window_days,
                   deadline_days, weekly_report_enabled, status, created_at, retired_at`,
        [orgId, policyId, actorId],
      )
      if (updated.rows.length !== 1) fail('conflict')
      return dto(updated.rows[0], false)
    } catch (error) {
      if (error instanceof ElearningOnboardingPolicyError) throw error
      fail('unavailable')
    }
  })
}

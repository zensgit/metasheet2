import { createHash, randomUUID } from 'node:crypto'

import {
  resolveElearningAudienceMembers,
  type ElearningAudienceQueryable,
  type ElearningAudienceRule,
} from './elearning-audience-resolver'
import {
  assignElearningTrainingPlan,
  ElearningTrainingPlanAssignmentError,
  type ElearningTrainingPlanAssignmentDb,
  type ElearningTrainingPlanAssignmentQueryable,
} from './elearning-training-plan-assignment'
import { normalizeElearningOnboardingMatchRules } from './elearning-onboarding-policy'

export const ELEARNING_ONBOARDING_ASSIGN_JOB_KIND = 'onboarding_assign' as const
export const ELEARNING_ONBOARDING_ASSIGNMENT_DOMAIN =
  'elearning.onboarding.assignment.v1' as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type ElearningOnboardingAssignmentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'not_eligible'
  | 'conflict'
  | 'unavailable'

export class ElearningOnboardingAssignmentError extends Error {
  constructor(readonly code: ElearningOnboardingAssignmentErrorCode) {
    super(code)
    this.name = 'ElearningOnboardingAssignmentError'
  }
}

export interface ElearningOnboardingAssignmentQueryable
  extends ElearningAudienceQueryable, ElearningTrainingPlanAssignmentQueryable {}

export interface ElearningOnboardingAssignmentDb
  extends ElearningOnboardingAssignmentQueryable {
  transaction<T>(run: (tx: ElearningOnboardingAssignmentQueryable) => Promise<T>): Promise<T>
}

export interface EnqueueElearningOnboardingForUserInput {
  orgId: unknown
  userId: unknown
  eventAt: unknown
}

export interface ProcessElearningOnboardingAssignmentInput {
  orgId: unknown
  jobId: unknown
}

export interface EnqueueElearningOnboardingForUserResult {
  matchedPolicyCount: number
  enqueuedCount: number
}

export interface ProcessElearningOnboardingAssignmentResult {
  effectId: string
  policyId: string
  userId: string
  planAssignmentId: string
  duplicate: boolean
}

interface StoredPolicy {
  policyId: string
  trainingPlanId: string
  matchRules: ElearningAudienceRule[]
  hireWindowDays: number
  deadlineDays: number
  actorId: string
}

interface JobPayload {
  policyId: string
  userId: string
  hireDate: string
}

function fail(code: ElearningOnboardingAssignmentErrorCode): never {
  throw new ElearningOnboardingAssignmentError(code)
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

function requireTimestamp(value: unknown): string {
  if (
    typeof value !== 'string'
    || !TIMESTAMP_RE.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) fail('invalid_input')
  return value
}

function storedTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) fail('unavailable')
  return date.toISOString()
}

function storedDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail('unavailable')
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail('unavailable')
  }
  return value
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ))
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function deriveElearningOnboardingOccurrenceKey(input: {
  orgId: string
  policyId: string
  userId: string
  hireDate: string
}): string {
  return `onboarding-assign-v1:${sha256(canonical({
    domain: ELEARNING_ONBOARDING_ASSIGNMENT_DOMAIN,
    hireDate: input.hireDate,
    orgId: input.orgId,
    policyId: input.policyId,
    userId: input.userId,
  }))}`
}

export function deriveElearningOnboardingPlanSourceKey(input: {
  orgId: string
  policyId: string
  userId: string
  hireDate: string
}): string {
  return `elearning-onboarding-plan-v1:${sha256(canonical({
    domain: ELEARNING_ONBOARDING_ASSIGNMENT_DOMAIN,
    effect: 'training-plan-assignment',
    hireDate: input.hireDate,
    orgId: input.orgId,
    policyId: input.policyId,
    userId: input.userId,
  }))}`
}

function dateOffsetDays(left: string, right: string): number {
  return Math.floor(
    (Date.parse(`${left}T00:00:00.000Z`) - Date.parse(`${right}T00:00:00.000Z`))
      / 86_400_000,
  )
}

function deadlineForHireDate(hireDate: string, deadlineDays: number): string {
  const date = new Date(`${hireDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + deadlineDays)
  return date.toISOString()
}

function storedPolicy(row: Record<string, unknown>): StoredPolicy {
  let matchRules: ElearningAudienceRule[]
  try {
    matchRules = normalizeElearningOnboardingMatchRules(row.match_rules)
  } catch {
    fail('unavailable')
  }
  return {
    policyId: storedUuid(row.id),
    trainingPlanId: storedUuid(row.training_plan_id),
    matchRules,
    hireWindowDays: storedInteger(row.hire_window_days),
    deadlineDays: storedInteger(row.deadline_days),
    actorId: storedText(row.created_by),
  }
}

function parseJobPayload(value: unknown): JobPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('unavailable')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'hireDate,policyId,userId') fail('unavailable')
  return {
    policyId: storedUuid(row.policyId),
    userId: storedText(row.userId),
    hireDate: storedDate(row.hireDate),
  }
}

async function userMatchesPolicy(
  db: ElearningAudienceQueryable,
  orgId: string,
  userId: string,
  rules: ElearningAudienceRule[],
): Promise<boolean> {
  const users = await resolveElearningAudienceMembers(db, {
    orgId,
    rules,
    maxMembers: 10_000,
  })
  return users.includes(userId)
}

export async function enqueueElearningOnboardingForUser(
  db: ElearningOnboardingAssignmentDb,
  input: EnqueueElearningOnboardingForUserInput,
): Promise<EnqueueElearningOnboardingForUserResult> {
  const orgId = requireText(input.orgId, 256)
  const userId = requireText(input.userId, 256)
  const eventAt = requireTimestamp(input.eventAt)
  const eventDate = eventAt.slice(0, 10)
  return db.transaction(async (tx) => {
    try {
      const principal = await tx.query(
        `/* elearning-onboarding-enqueue:principal */
         SELECT platform_user.hire_date::text AS hire_date
         FROM users platform_user
         JOIN user_orgs membership
           ON membership.user_id = platform_user.id
          AND membership.org_id = $1
          AND membership.is_active = TRUE
         WHERE platform_user.id = $2
           AND platform_user.is_active = TRUE
         FOR SHARE OF platform_user, membership`,
        [orgId, userId],
      )
      if (!principal.rows[0]) fail('not_eligible')
      const hireDate = storedDate(principal.rows[0].hire_date)
      const policies = await tx.query(
        `/* elearning-onboarding-enqueue:policies */
         SELECT id, training_plan_id, match_rules, hire_window_days,
                deadline_days, created_by
         FROM elearning_onboarding_policies
         WHERE org_id = $1 AND status = 'active'
         ORDER BY id ASC
         FOR SHARE`,
        [orgId],
      )
      let matchedPolicyCount = 0
      let enqueuedCount = 0
      for (const row of policies.rows) {
        const policy = storedPolicy(row)
        const ageDays = dateOffsetDays(eventDate, hireDate)
        if (ageDays < 0 || ageDays > policy.hireWindowDays) continue
        if (!await userMatchesPolicy(tx, orgId, userId, policy.matchRules)) continue
        matchedPolicyCount += 1
        const occurrenceKey = deriveElearningOnboardingOccurrenceKey({
          orgId, policyId: policy.policyId, userId, hireDate,
        })
        const inserted = await tx.query(
          `/* elearning-onboarding-enqueue:job */
           INSERT INTO elearning_jobs (
             org_id, kind, occurrence_key, ref, payload, due_at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (org_id, kind, occurrence_key) DO NOTHING
           RETURNING id`,
          [
            orgId,
            ELEARNING_ONBOARDING_ASSIGN_JOB_KIND,
            occurrenceKey,
            policy.policyId,
            JSON.stringify({ policyId: policy.policyId, userId, hireDate }),
            eventAt,
          ],
        )
        if (inserted.rows.length === 1) enqueuedCount += 1
      }
      return { matchedPolicyCount, enqueuedCount }
    } catch (error) {
      if (error instanceof ElearningOnboardingAssignmentError) throw error
      fail('unavailable')
    }
  })
}

function nestedTrainingPlanDb(
  tx: ElearningOnboardingAssignmentQueryable,
): ElearningTrainingPlanAssignmentDb {
  return {
    query: (sql, params) => tx.query(sql, params),
    transaction: async <T>(
      run: (nested: ElearningTrainingPlanAssignmentQueryable) => Promise<T>,
    ): Promise<T> => run(tx),
  }
}

export async function processElearningOnboardingAssignment(
  db: ElearningOnboardingAssignmentDb,
  input: ProcessElearningOnboardingAssignmentInput,
): Promise<ProcessElearningOnboardingAssignmentResult> {
  const orgId = requireText(input.orgId, 256)
  const jobId = requireUuid(input.jobId)
  return db.transaction(async (tx) => {
    try {
      const jobResult = await tx.query(
        `/* elearning-onboarding-process:job */
         SELECT occurrence_key, ref, payload, due_at, status
         FROM elearning_jobs
         WHERE org_id = $1 AND id = $2 AND kind = $3
         FOR UPDATE`,
        [orgId, jobId, ELEARNING_ONBOARDING_ASSIGN_JOB_KIND],
      )
      const job = jobResult.rows[0]
      if (!job) fail('not_found')
      if (job.status !== 'running') fail('conflict')
      const payload = parseJobPayload(job.payload)
      const dueDate = storedTimestamp(job.due_at).slice(0, 10)
      const expectedOccurrenceKey = deriveElearningOnboardingOccurrenceKey({
        orgId,
        policyId: payload.policyId,
        userId: payload.userId,
        hireDate: payload.hireDate,
      })
      if (
        storedText(job.ref) !== payload.policyId
        || storedText(job.occurrence_key) !== expectedOccurrenceKey
      ) fail('conflict')

      await tx.query(
        `/* elearning-onboarding-process:effect-lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`elearning-onboarding-effect:${orgId}:${payload.policyId}:${payload.userId}`],
      )
      const existing = await tx.query(
        `/* elearning-onboarding-process:existing */
         SELECT id, hire_date::text AS hire_date, job_occurrence_key, source_key,
                training_plan_assignment_id
         FROM elearning_onboarding_assignment_effects
         WHERE org_id = $1 AND policy_id = $2 AND user_id = $3
         FOR UPDATE`,
        [orgId, payload.policyId, payload.userId],
      )
      if (existing.rows[0]) {
        const expectedSourceKey = deriveElearningOnboardingPlanSourceKey({
          orgId,
          policyId: payload.policyId,
          userId: payload.userId,
          hireDate: payload.hireDate,
        })
        if (
          storedDate(existing.rows[0].hire_date) !== payload.hireDate
          || storedText(existing.rows[0].job_occurrence_key) !== expectedOccurrenceKey
          || storedText(existing.rows[0].source_key) !== expectedSourceKey
        ) fail('conflict')
        return {
          effectId: storedUuid(existing.rows[0].id),
          policyId: payload.policyId,
          userId: payload.userId,
          planAssignmentId: storedUuid(existing.rows[0].training_plan_assignment_id),
          duplicate: true,
        }
      }

      const policyResult = await tx.query(
        `/* elearning-onboarding-process:policy */
         SELECT id, training_plan_id, match_rules, hire_window_days,
                deadline_days, created_by
         FROM elearning_onboarding_policies
         WHERE org_id = $1 AND id = $2 AND status = 'active'
         FOR SHARE`,
        [orgId, payload.policyId],
      )
      if (!policyResult.rows[0]) fail('not_eligible')
      const policy = storedPolicy(policyResult.rows[0])
      const principal = await tx.query(
        `/* elearning-onboarding-process:principal */
         SELECT platform_user.hire_date::text AS hire_date
         FROM users platform_user
         JOIN user_orgs membership
           ON membership.user_id = platform_user.id
          AND membership.org_id = $1
          AND membership.is_active = TRUE
         WHERE platform_user.id = $2
           AND platform_user.is_active = TRUE
         FOR SHARE OF platform_user, membership`,
        [orgId, payload.userId],
      )
      if (!principal.rows[0]) fail('not_eligible')
      const hireDate = storedDate(principal.rows[0].hire_date)
      if (
        hireDate !== payload.hireDate
        || dateOffsetDays(dueDate, hireDate) < 0
        || dateOffsetDays(dueDate, hireDate) > policy.hireWindowDays
        || !await userMatchesPolicy(tx, orgId, payload.userId, policy.matchRules)
      ) fail('not_eligible')

      const sourceKey = deriveElearningOnboardingPlanSourceKey({
        orgId, policyId: policy.policyId, userId: payload.userId, hireDate,
      })
      let assignment
      try {
        assignment = await assignElearningTrainingPlan(nestedTrainingPlanDb(tx), {
          orgId,
          actorId: policy.actorId,
          planId: policy.trainingPlanId,
          sourceKey,
          deadline: deadlineForHireDate(hireDate, policy.deadlineDays),
          rules: [{
            subjectType: 'user',
            subjectRef: payload.userId,
            includeChildren: false,
          }],
        })
      } catch (error) {
        if (error instanceof ElearningTrainingPlanAssignmentError) {
          if (error.code === 'conflict') fail('conflict')
          if (['not_found', 'plan_unavailable', 'course_unavailable'].includes(error.code)) {
            fail('not_eligible')
          }
        }
        throw error
      }

      const effectId = randomUUID()
      const inserted = await tx.query(
        `/* elearning-onboarding-process:insert-effect */
         INSERT INTO elearning_onboarding_assignment_effects (
           id, org_id, policy_id, user_id, hire_date, job_occurrence_key, source_key,
           training_plan_assignment_id
         ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8)
         RETURNING id`,
        [
          effectId, orgId, policy.policyId, payload.userId, hireDate,
          expectedOccurrenceKey, sourceKey, assignment.planAssignmentId,
        ],
      )
      if (inserted.rows.length !== 1) fail('unavailable')
      return {
        effectId,
        policyId: policy.policyId,
        userId: payload.userId,
        planAssignmentId: assignment.planAssignmentId,
        duplicate: false,
      }
    } catch (error) {
      if (error instanceof ElearningOnboardingAssignmentError) throw error
      fail('unavailable')
    }
  })
}

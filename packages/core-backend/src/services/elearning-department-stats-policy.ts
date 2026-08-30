import { createHash } from 'node:crypto'

import {
  applyElearningAnalyticsSuppression,
  ElearningAnalyticsSuppressionError,
} from './elearning-analytics-suppression'

/**
 * Pure L5 department-learning-statistics projection policy. The future
 * projection adapter owns management-scope filtering, the single department
 * hierarchy level, advisory locking, persistence, export, and reconciliation.
 * sourceVersion must be an opaque monotonic token and must not encode metrics.
 */

export const ELEARNING_DEPARTMENT_STATS_DOMAIN =
  'elearning.department-stats.v1' as const

const MAX_KEY_LENGTH = 512

const INPUT_KEYS = [
  'counters',
  'departmentId',
  'minGroupSize',
  'orgId',
  'periodEnd',
  'periodStart',
  'sourceVersion',
] as const
const COUNTER_KEYS = [
  'assignedCount',
  'completedCount',
  'creditTotal',
  'examParticipantCount',
  'learnerCount',
  'learningSeconds',
  'memberCount',
  'overdueCount',
] as const

export type ElearningDepartmentStatsPolicyErrorCode =
  | 'invalid_counters'
  | 'invalid_input'
  | 'invalid_period'
  | 'invalid_threshold'

export class ElearningDepartmentStatsPolicyError extends Error {
  constructor(readonly code: ElearningDepartmentStatsPolicyErrorCode) {
    super(code)
    this.name = 'ElearningDepartmentStatsPolicyError'
  }
}

export interface ElearningDepartmentStatsMetrics {
  readonly assignedCount: number
  readonly completedCount: number
  readonly completionRate: number
  readonly creditAverage: number
  readonly creditTotal: number
  readonly examParticipantCount: number
  readonly learnerCount: number
  readonly learningSeconds: number
  readonly memberCount: number
  readonly overdueCount: number
}

interface ElearningDepartmentStatsProjectionBase {
  readonly departmentId: string
  readonly domain: typeof ELEARNING_DEPARTMENT_STATS_DOMAIN
  readonly orgId: string
  readonly payloadDigest: string
  readonly periodEnd: string
  readonly periodStart: string
  readonly projectionKey: string
  readonly sourceVersion: string
}

export interface ElearningDepartmentStatsSuppressedProjection
  extends ElearningDepartmentStatsProjectionBase {
  readonly suppressed: true
}

export interface ElearningDepartmentStatsVisibleProjection
  extends ElearningDepartmentStatsProjectionBase {
  readonly metrics: ElearningDepartmentStatsMetrics
  readonly suppressed: false
}

export type ElearningDepartmentStatsProjection =
  | ElearningDepartmentStatsSuppressedProjection
  | ElearningDepartmentStatsVisibleProjection

function fail(code: ElearningDepartmentStatsPolicyErrorCode): never {
  throw new ElearningDepartmentStatsPolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ElearningDepartmentStatsPolicyErrorCode,
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(code)
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail(code)
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== expectedKeys.length
      || sorted.some((key, index) => key !== expectedKeys[index])
    ) fail(code)
    const values: Record<string, unknown> = {}
    for (const key of expectedKeys) values[key] = (input as Record<string, unknown>)[key]
    return values
  } catch (error) {
    if (error instanceof ElearningDepartmentStatsPolicyError) throw error
    fail(code)
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      return false
    }
  }
  return true
}

function requireKey(
  value: unknown,
  code: ElearningDepartmentStatsPolicyErrorCode,
): string {
  if (typeof value !== 'string') fail(code)
  const text = value.trim()
  if (
    text === ''
    || text.length > MAX_KEY_LENGTH
    || text.includes('\0')
    || !isWellFormedUnicode(text)
  ) fail(code)
  return text
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_period')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('invalid_period')
  }
  return value
}

function requireCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('invalid_counters')
  }
  return value
}

function requireCreditTotal(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || Math.abs(value) > Number.MAX_SAFE_INTEGER
  ) fail('invalid_counters')
  return value
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

export function buildElearningDepartmentStatsProjection(
  input: unknown,
): ElearningDepartmentStatsProjection {
  const values = readExactObject(input, INPUT_KEYS, 'invalid_input')
  const counters = readExactObject(values.counters, COUNTER_KEYS, 'invalid_counters')
  const assignedCount = requireCount(counters.assignedCount)
  const completedCount = requireCount(counters.completedCount)
  const overdueCount = requireCount(counters.overdueCount)
  if (completedCount > assignedCount || overdueCount > assignedCount) {
    fail('invalid_counters')
  }
  const memberCount = requireCount(counters.memberCount)
  const metrics = Object.freeze({
    assignedCount,
    completedCount,
    completionRate: assignedCount === 0 ? 0 : completedCount / assignedCount,
    creditAverage: memberCount === 0
      ? 0
      : requireCreditTotal(counters.creditTotal) / memberCount,
    creditTotal: requireCreditTotal(counters.creditTotal),
    examParticipantCount: requireCount(counters.examParticipantCount),
    learnerCount: requireCount(counters.learnerCount),
    learningSeconds: requireCount(counters.learningSeconds),
    memberCount,
    overdueCount,
  })
  const periodStart = requireTimestamp(values.periodStart)
  const periodEnd = requireTimestamp(values.periodEnd)
  if (periodStart >= periodEnd) fail('invalid_period')
  const orgId = requireKey(values.orgId, 'invalid_input')
  const departmentId = requireKey(values.departmentId, 'invalid_input')
  const sourceVersion = requireKey(values.sourceVersion, 'invalid_input')

  let suppression: ReturnType<typeof applyElearningAnalyticsSuppression>
  try {
    suppression = applyElearningAnalyticsSuppression({
      groupSize: memberCount,
      metrics,
      minGroupSize: values.minGroupSize,
    })
  } catch (error) {
    if (
      error instanceof ElearningAnalyticsSuppressionError
      && error.code === 'invalid_min_group_size'
    ) fail('invalid_threshold')
    fail('invalid_input')
  }

  const projectionIdentity = {
    departmentId,
    domain: ELEARNING_DEPARTMENT_STATS_DOMAIN,
    orgId,
    periodEnd,
    periodStart,
  }
  const common = {
    departmentId,
    domain: ELEARNING_DEPARTMENT_STATS_DOMAIN,
    orgId,
    periodEnd,
    periodStart,
    projectionKey: `${ELEARNING_DEPARTMENT_STATS_DOMAIN}:${hash(projectionIdentity)}`,
    sourceVersion,
  }
  if (suppression.suppressed) {
    const payload = { ...common, suppressed: true as const }
    return Object.freeze({
      ...payload,
      payloadDigest: hash(payload),
    })
  }
  const payload = {
    ...common,
    metrics,
    suppressed: false as const,
  }
  return Object.freeze({
    ...payload,
    payloadDigest: hash(payload),
  })
}

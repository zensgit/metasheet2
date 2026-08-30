import { apiFetch } from '../utils/api'
import { ElearningApiError } from './elearning'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CANONICAL_ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/

const BASE_KEYS = [
  'departmentId',
  'statsDate',
  'periodStart',
  'periodEnd',
  'sourceVersion',
  'minGroupSize',
  'projectedVersion',
  'lastProjectedAt',
  'lastErrorCode',
  'suppressed',
] as const

const METRIC_KEYS = [
  'assignedCount',
  'completedCount',
  'completionRate',
  'creditAverage',
  'creditTotal',
  'examParticipantCount',
  'learnerCount',
  'learningSeconds',
  'memberCount',
  'overdueCount',
] as const

export interface ElearningDepartmentStatsDailyMetrics {
  assignedCount: number
  completedCount: number
  completionRate: number
  creditAverage: number
  creditTotal: number
  examParticipantCount: number
  learnerCount: number
  learningSeconds: number
  memberCount: number
  overdueCount: number
}

interface ElearningDepartmentStatsDailyBase {
  departmentId: string
  statsDate: string
  periodStart: string
  periodEnd: string
  sourceVersion: string
  minGroupSize: number
  projectedVersion: number
  lastProjectedAt: string
  lastErrorCode: string | null
}

export interface ElearningDepartmentStatsDailySuppressed
  extends ElearningDepartmentStatsDailyBase {
  suppressed: true
}

export interface ElearningDepartmentStatsDailyVisible
  extends ElearningDepartmentStatsDailyBase {
  suppressed: false
  metrics: ElearningDepartmentStatsDailyMetrics
}

export type ElearningDepartmentStatsDaily =
  | ElearningDepartmentStatsDailySuppressed
  | ElearningDepartmentStatsDailyVisible

interface ElearningDepartmentStatsPeriodBase {
  departmentId: string
  periodStart: string
  periodEnd: string
  sourceVersion: string
}

export interface ElearningDepartmentStatsPeriodSuppressed
  extends ElearningDepartmentStatsPeriodBase {
  suppressed: true
}

export interface ElearningDepartmentStatsPeriodVisible
  extends ElearningDepartmentStatsPeriodBase {
  suppressed: false
  metrics: ElearningDepartmentStatsDailyMetrics
}

export type ElearningDepartmentStatsPeriod =
  | ElearningDepartmentStatsPeriodSuppressed
  | ElearningDepartmentStatsPeriodVisible

function fail(code: string, status: number): never {
  throw new ElearningApiError(code, status)
}

function failShape(status: number): never {
  fail('invalid_response', status)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function requireUuid(value: unknown, status: number): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failShape(status)
  return value.toLowerCase()
}

function requireInputUuid(value: string): string {
  if (!UUID_RE.test(value)) fail('invalid_input', 400)
  return value.toLowerCase()
}

function requireDate(value: unknown, status: number): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) failShape(status)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    failShape(status)
  }
  return value
}

function requireInputDate(value: string): string {
  try {
    return requireDate(value, 400)
  } catch {
    fail('invalid_input', 400)
  }
}

function requireInputTimestamp(value: string): string {
  if (!CANONICAL_ISO_INSTANT_RE.test(value)) fail('invalid_input', 400)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('invalid_input', 400)
  }
  return value
}

function requireTimestamp(value: unknown, status: number): string {
  if (typeof value !== 'string' || !CANONICAL_ISO_INSTANT_RE.test(value)) {
    failShape(status)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) failShape(status)
  return value
}

function requireText(value: unknown, status: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    failShape(status)
  }
  return value
}

function requireInteger(value: unknown, status: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    failShape(status)
  }
  return value
}

function requireFinite(value: unknown, status: number, min?: number, max?: number): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || (min !== undefined && value < min)
    || (max !== undefined && value > max)
  ) failShape(status)
  return value
}

function parseMetrics(value: unknown, status: number): ElearningDepartmentStatsDailyMetrics {
  if (!isPlainObject(value) || !exactKeys(value, METRIC_KEYS)) failShape(status)
  const assignedCount = requireInteger(value.assignedCount, status)
  const completedCount = requireInteger(value.completedCount, status)
  const overdueCount = requireInteger(value.overdueCount, status)
  if (completedCount > assignedCount || overdueCount > assignedCount) failShape(status)
  return {
    assignedCount,
    completedCount,
    completionRate: requireFinite(value.completionRate, status, 0, 1),
    creditAverage: requireFinite(value.creditAverage, status),
    creditTotal: requireInteger(value.creditTotal, status, Number.MIN_SAFE_INTEGER),
    examParticipantCount: requireInteger(value.examParticipantCount, status),
    learnerCount: requireInteger(value.learnerCount, status),
    learningSeconds: requireInteger(value.learningSeconds, status),
    memberCount: requireInteger(value.memberCount, status),
    overdueCount,
  }
}

function parseDailyStats(value: unknown, status: number): ElearningDepartmentStatsDaily {
  if (!isPlainObject(value) || typeof value.suppressed !== 'boolean') failShape(status)
  const expectedKeys = value.suppressed ? BASE_KEYS : [...BASE_KEYS, 'metrics']
  if (!exactKeys(value, expectedKeys)) failShape(status)
  const departmentId = requireUuid(value.departmentId, status)
  const statsDate = requireDate(value.statsDate, status)
  const periodStart = requireTimestamp(value.periodStart, status)
  const periodEnd = requireTimestamp(value.periodEnd, status)
  if (
    periodStart !== `${statsDate}T00:00:00.000Z`
    || Date.parse(periodEnd) - Date.parse(periodStart) !== 86_400_000
  ) failShape(status)
  const lastErrorCode = value.lastErrorCode === null
    ? null
    : typeof value.lastErrorCode === 'string' && ERROR_CODE_RE.test(value.lastErrorCode)
      ? value.lastErrorCode
      : failShape(status)
  const common = {
    departmentId,
    statsDate,
    periodStart,
    periodEnd,
    sourceVersion: requireText(value.sourceVersion, status),
    minGroupSize: requireInteger(value.minGroupSize, status, 5),
    projectedVersion: requireInteger(value.projectedVersion, status, 1),
    lastProjectedAt: requireTimestamp(value.lastProjectedAt, status),
    lastErrorCode,
  }
  if (value.suppressed) return { ...common, suppressed: true }
  return { ...common, suppressed: false, metrics: parseMetrics(value.metrics, status) }
}

function parsePeriodStats(value: unknown, status: number): ElearningDepartmentStatsPeriod {
  if (!isPlainObject(value) || typeof value.suppressed !== 'boolean') failShape(status)
  const baseKeys = [
    'departmentId',
    'periodStart',
    'periodEnd',
    'sourceVersion',
    'suppressed',
  ] as const
  const expectedKeys = value.suppressed ? baseKeys : [...baseKeys, 'metrics']
  if (!exactKeys(value, expectedKeys)) failShape(status)
  const periodStart = requireTimestamp(value.periodStart, status)
  const periodEnd = requireTimestamp(value.periodEnd, status)
  if (periodStart >= periodEnd) failShape(status)
  const common = {
    departmentId: requireUuid(value.departmentId, status),
    periodStart,
    periodEnd,
    sourceVersion: requireText(value.sourceVersion, status),
  }
  if (value.suppressed) return { ...common, suppressed: true }
  return { ...common, suppressed: false, metrics: parseMetrics(value.metrics, status) }
}

function readErrorCode(payload: unknown): string {
  if (!isPlainObject(payload) || typeof payload.error !== 'string') return 'request_failed'
  const code = payload.error.trim()
  if (code === 'ORG_CONTEXT_REQUIRED') return code
  return /^[a-z][a-z0-9_]{0,62}$/.test(code) ? code : 'request_failed'
}

export async function getElearningDepartmentStatsDaily(
  departmentId: string,
  statsDate: string,
): Promise<ElearningDepartmentStatsDaily> {
  const department = requireInputUuid(departmentId)
  const date = requireInputDate(statsDate)
  let response: Response
  try {
    response = await apiFetch(
      `/api/elearning/admin/analytics/departments/${department}/daily/${date}`,
      { method: 'GET' },
    )
  } catch {
    fail('network_error', 0)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (response.status !== 200) fail(readErrorCode(payload), response.status)
  return parseDailyStats(payload, response.status)
}

export async function getElearningDepartmentStatsPeriod(
  departmentId: string,
  periodStart: string,
  periodEnd: string,
): Promise<ElearningDepartmentStatsPeriod> {
  const department = requireInputUuid(departmentId)
  const start = requireInputTimestamp(periodStart)
  const end = requireInputTimestamp(periodEnd)
  if (start >= end) fail('invalid_input', 400)
  const query = new URLSearchParams({ periodStart: start, periodEnd: end })
  let response: Response
  try {
    response = await apiFetch(
      `/api/elearning/admin/analytics/departments/${department}?${query.toString()}`,
      { method: 'GET' },
    )
  } catch {
    fail('network_error', 0)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (response.status !== 200) fail(readErrorCode(payload), response.status)
  return parsePeriodStats(payload, response.status)
}

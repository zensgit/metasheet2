import { apiFetch } from '../utils/api'
import { ElearningApiError } from './elearning'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CANONICAL_ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export type ElearningOnboardingSubjectType = 'department' | 'position'

export interface ElearningOnboardingMatchRule {
  subjectType: ElearningOnboardingSubjectType
  subjectRef: string
  includeChildren: boolean
}

export interface ElearningOnboardingPolicyCommand {
  requestId: string
  trainingPlanId: string
  matchRules: ElearningOnboardingMatchRule[]
  hireWindowDays: number
  deadlineDays: number
  weeklyReportEnabled: boolean
}

export interface ElearningOnboardingPolicy {
  policyId: string
  trainingPlanId: string
  matchRules: ElearningOnboardingMatchRule[]
  hireWindowDays: number
  deadlineDays: number
  weeklyReportEnabled: boolean
  status: 'active' | 'retired'
  createdAt: string
  retiredAt: string | null
  duplicate: boolean
}

interface ElearningOnboardingWeeklyReportBase {
  reportId: string
  policyId: string
  weekStart: string
  weekEnd: string
  minGroupSize: 5
  duplicate: boolean
}

export interface ElearningOnboardingWeeklyReportSuppressed
  extends ElearningOnboardingWeeklyReportBase {
  suppressed: true
  enqueuedCount: null
  assignedUserCount: null
  failedCount: null
  deadCount: null
}

export interface ElearningOnboardingWeeklyReportVisible
  extends ElearningOnboardingWeeklyReportBase {
  suppressed: false
  enqueuedCount: number
  assignedUserCount: number
  failedCount: number
  deadCount: number
}

export type ElearningOnboardingWeeklyReport =
  | ElearningOnboardingWeeklyReportSuppressed
  | ElearningOnboardingWeeklyReportVisible

function fail(code: string, status: number): never {
  throw new ElearningApiError(code, status)
}

function failInput(): never {
  fail('invalid_input', 400)
}

function failShape(status: number): never {
  fail('invalid_response', status)
}

function failForStatus(status: number): never {
  if (status === 400) failInput()
  failShape(status)
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
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    failForStatus(status)
  }
  return value.toLowerCase()
}

function requireText(value: unknown, status: number): string {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || value.length > 512
    || value.includes('\0')
  ) {
    failForStatus(status)
  }
  return value.trim()
}

function requireInteger(value: unknown, status: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    failForStatus(status)
  }
  return value as number
}

function requireCanonicalDate(value: unknown, status: number): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    failForStatus(status)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    failForStatus(status)
  }
  return value
}

function requireTimestamp(value: unknown, status: number): string {
  if (typeof value !== 'string' || !CANONICAL_ISO_INSTANT_RE.test(value)) failShape(status)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) failShape(status)
  return value
}

function parseRule(value: unknown, status: number): ElearningOnboardingMatchRule {
  if (!isPlainObject(value) || !exactKeys(value, [
    'subjectType',
    'subjectRef',
    'includeChildren',
  ])) {
    failForStatus(status)
  }
  if (value.subjectType !== 'department' && value.subjectType !== 'position') {
    failForStatus(status)
  }
  if (typeof value.includeChildren !== 'boolean') {
    failForStatus(status)
  }
  if (value.subjectType === 'position' && value.includeChildren) {
    failForStatus(status)
  }
  return {
    subjectType: value.subjectType,
    subjectRef: value.subjectType === 'department'
      ? requireUuid(value.subjectRef, status)
      : requireText(value.subjectRef, status),
    includeChildren: value.includeChildren,
  }
}

function parseRules(value: unknown, status: number): ElearningOnboardingMatchRule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    failForStatus(status)
  }
  const rules = value.map((rule) => parseRule(rule, status))
  const keys = rules.map((rule) => `${rule.subjectType}:${rule.subjectRef}`)
  if (new Set(keys).size !== keys.length) {
    failForStatus(status)
  }
  if (status !== 400 && keys.some((key, index) => index > 0 && keys[index - 1] >= key)) {
    failShape(status)
  }
  return rules
}

function parsePolicy(value: unknown, status: number): ElearningOnboardingPolicy {
  if (!isPlainObject(value) || !exactKeys(value, [
    'policyId',
    'trainingPlanId',
    'matchRules',
    'hireWindowDays',
    'deadlineDays',
    'weeklyReportEnabled',
    'status',
    'createdAt',
    'retiredAt',
    'duplicate',
  ])) failShape(status)
  if (value.status !== 'active' && value.status !== 'retired') failShape(status)
  if (typeof value.weeklyReportEnabled !== 'boolean' || typeof value.duplicate !== 'boolean') {
    failShape(status)
  }
  const retiredAt = value.retiredAt === null ? null : requireTimestamp(value.retiredAt, status)
  if ((value.status === 'active') !== (retiredAt === null)) failShape(status)
  return {
    policyId: requireUuid(value.policyId, status),
    trainingPlanId: requireUuid(value.trainingPlanId, status),
    matchRules: parseRules(value.matchRules, status),
    hireWindowDays: requireInteger(value.hireWindowDays, status, 365),
    deadlineDays: requireInteger(value.deadlineDays, status, 3650),
    weeklyReportEnabled: value.weeklyReportEnabled,
    status: value.status,
    createdAt: requireTimestamp(value.createdAt, status),
    retiredAt,
    duplicate: value.duplicate,
  }
}

function addDays(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function parseCount(value: unknown, status: number): number {
  return requireInteger(value, status, Number.MAX_SAFE_INTEGER)
}

function parseReport(value: unknown, status: number): ElearningOnboardingWeeklyReport {
  if (!isPlainObject(value) || !exactKeys(value, [
    'reportId',
    'policyId',
    'weekStart',
    'weekEnd',
    'suppressed',
    'minGroupSize',
    'enqueuedCount',
    'assignedUserCount',
    'failedCount',
    'deadCount',
    'duplicate',
  ])) failShape(status)
  if (
    typeof value.suppressed !== 'boolean'
    || value.minGroupSize !== 5
    || typeof value.duplicate !== 'boolean'
  ) failShape(status)
  const weekStart = requireCanonicalDate(value.weekStart, status)
  const weekEnd = requireCanonicalDate(value.weekEnd, status)
  if (weekEnd !== addDays(weekStart, 7)) failShape(status)
  const common = {
    reportId: requireUuid(value.reportId, status),
    policyId: requireUuid(value.policyId, status),
    weekStart,
    weekEnd,
    minGroupSize: 5 as const,
    duplicate: value.duplicate,
  }
  if (value.suppressed) {
    if (
      value.enqueuedCount !== null
      || value.assignedUserCount !== null
      || value.failedCount !== null
      || value.deadCount !== null
    ) failShape(status)
    return {
      ...common,
      suppressed: true,
      enqueuedCount: null,
      assignedUserCount: null,
      failedCount: null,
      deadCount: null,
    }
  }
  const enqueuedCount = parseCount(value.enqueuedCount, status)
  const assignedUserCount = parseCount(value.assignedUserCount, status)
  const failedCount = parseCount(value.failedCount, status)
  const deadCount = parseCount(value.deadCount, status)
  if (
    assignedUserCount > enqueuedCount
    || failedCount > enqueuedCount
    || deadCount > enqueuedCount
    || failedCount + deadCount > enqueuedCount
  ) failShape(status)
  return {
    ...common,
    suppressed: false,
    enqueuedCount,
    assignedUserCount,
    failedCount,
    deadCount,
  }
}

function readErrorCode(value: unknown): string {
  if (isPlainObject(value) && typeof value.error === 'string' && ERROR_CODE_RE.test(value.error)) {
    return value.error
  }
  return 'request_failed'
}

async function requestJson(
  path: string,
  options: RequestInit,
  expectedStatuses: readonly number[],
): Promise<{ payload: unknown; status: number }> {
  let response: Response
  try {
    response = await apiFetch(path, options)
  } catch {
    fail('network_error', 0)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!expectedStatuses.includes(response.status)) {
    fail(readErrorCode(payload), response.status)
  }
  return { payload, status: response.status }
}

export async function createElearningOnboardingPolicy(
  input: ElearningOnboardingPolicyCommand,
): Promise<ElearningOnboardingPolicy> {
  if (!isPlainObject(input) || !exactKeys(input, [
    'requestId',
    'trainingPlanId',
    'matchRules',
    'hireWindowDays',
    'deadlineDays',
    'weeklyReportEnabled',
  ])) failInput()
  const body = {
    requestId: requireUuid(input.requestId, 400),
    trainingPlanId: requireUuid(input.trainingPlanId, 400),
    matchRules: parseRules(input.matchRules, 400),
    hireWindowDays: requireInteger(input.hireWindowDays, 400, 365),
    deadlineDays: requireInteger(input.deadlineDays, 400, 3650),
    weeklyReportEnabled: input.weeklyReportEnabled,
  }
  if (typeof body.weeklyReportEnabled !== 'boolean') failInput()
  const { payload, status } = await requestJson(
    '/api/elearning/admin/onboarding/policies',
    { method: 'POST', body: JSON.stringify(body) },
    [200, 201],
  )
  return parsePolicy(payload, status)
}

export async function retireElearningOnboardingPolicy(
  policyId: string,
): Promise<ElearningOnboardingPolicy> {
  const id = requireUuid(policyId, 400)
  const { payload, status } = await requestJson(
    `/api/elearning/admin/onboarding/policies/${encodeURIComponent(id)}/retire`,
    { method: 'POST' },
    [200],
  )
  const result = parsePolicy(payload, status)
  if (result.policyId !== id || result.status !== 'retired') failShape(status)
  return result
}

export async function getElearningOnboardingWeeklyReport(
  policyId: string,
  weekStart: string,
): Promise<ElearningOnboardingWeeklyReport> {
  const id = requireUuid(policyId, 400)
  const date = requireCanonicalDate(weekStart, 400)
  const { payload, status } = await requestJson(
    `/api/elearning/admin/onboarding/policies/${encodeURIComponent(id)}/reports/${encodeURIComponent(date)}`,
    { method: 'GET' },
    [200],
  )
  const result = parseReport(payload, status)
  if (result.policyId !== id || result.weekStart !== date) failShape(status)
  return result
}

import { apiFetch } from '../utils/api'
import { ElearningApiError } from './elearning'

export const ELEARNING_CREDIT_WALLET_PAGE_DEFAULT = 20 as const
export const ELEARNING_CREDIT_WALLET_PAGE_MAX = 100 as const
export const ELEARNING_TITLE_SNAPSHOT_MAX_ROWS = 100 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STABLE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/
const CANONICAL_ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const AUTOMATIC_BEHAVIORS = [
  'login',
  'complete_course',
  'complete_plan',
  'pass_exam',
  'submit_survey',
  'complete_map',
  'complete_offline',
] as const
const WALLET_BEHAVIORS = [...AUTOMATIC_BEHAVIORS, 'manual_adjust'] as const
const WALLET_STATUSES = ['awarded', 'capped', 'exhausted', 'adjusted'] as const
const PG_INT4_MAX = 2_147_483_647
const FORBIDDEN_KEYS = new Set([
  'actorId',
  'actor_id',
  'effectKey',
  'effect_key',
  'rawReference',
  'raw_reference',
  'reason',
  'reference',
  'requestHash',
  'request_hash',
  'sourceKey',
  'source_key',
])

export type ElearningCreditAutomaticBehavior = (typeof AUTOMATIC_BEHAVIORS)[number]
export type ElearningCreditBehavior = (typeof WALLET_BEHAVIORS)[number]
export type ElearningCreditWalletStatus = (typeof WALLET_STATUSES)[number]

export interface ElearningCreditRule {
  behavior: ElearningCreditAutomaticBehavior
  ruleId: string
  version: number
  points: number
  dailyCap: number | null
  timeZone: string
  createdAt: string
}

export interface ElearningCreditRulePublishInput {
  requestId: string
  behavior: ElearningCreditAutomaticBehavior
  points: number
  dailyCap: number | null
  timeZone: string
}

export interface ElearningCreditWalletItem {
  decisionId: string
  behavior: ElearningCreditBehavior
  awardedPoints: number
  status: ElearningCreditWalletStatus
  occurredAt: string
  createdAt: string
}

export interface ElearningCreditAdjustmentInput {
  requestId: string
  userId: string
  points: number
  reason: string
}

export interface ElearningCreditAdjustmentResult {
  adjustmentId: string
  userId: string
  points: number
  balancePoints: number
  createdAt: string
}

export interface ElearningCreditWallet {
  userId: string
  balancePoints: number
  currentTitle: ElearningTitleRow | null
  items: ElearningCreditWalletItem[]
  nextCursor: string | null
}

export interface ElearningTitleRow {
  id: string
  name: string
  threshold: number
}

export interface ElearningTitleSnapshot {
  revisionId: string | null
  version: number
  titles: ElearningTitleRow[]
  createdAt: string | null
}

export interface ElearningTitlePublishInput {
  requestId: string
  titles: ElearningTitleRow[]
}

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

function hasForbiddenKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKeys)
  if (!isPlainObject(value)) return false
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_KEYS.has(key) || hasForbiddenKeys(child)
  ))
}

function requireUuid(value: unknown, status: number): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failShape(status)
  return value.toLowerCase()
}

function requireInputUuid(value: string): string {
  if (!UUID_RE.test(value)) fail('invalid_input', 400)
  return value.toLowerCase()
}

function requireText(value: unknown, status: number): string {
  if (typeof value !== 'string' || value.trim() === '') failShape(status)
  return value
}

function requireIsoTimestamp(value: unknown, status: number): string {
  const text = requireText(value, status)
  const date = new Date(text)
  if (
    !CANONICAL_ISO_INSTANT_RE.test(text)
    || Number.isNaN(date.getTime())
    || date.toISOString() !== text
  ) failShape(status)
  return text
}

function requireSafeInt(
  value: unknown,
  status: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < min
    || value > max
  ) {
    failShape(status)
  }
  return value
}

function requirePositiveInput(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail('invalid_input', 400)
  return value
}

function requireAdjustmentPointsInput(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value === 0
    || value < -PG_INT4_MAX
    || value > PG_INT4_MAX
  ) fail('invalid_input', 400)
  return value
}

function requireTitleThresholdInput(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > PG_INT4_MAX) {
    fail('invalid_input', 400)
  }
  return value
}

function requireInputText(value: string): string {
  const text = value.trim()
  if (
    text === ''
    || text.length > 512
    || text.includes('\0')
    || /[\ud800-\udfff]/u.test(text)
  ) fail('invalid_input', 400)
  return text
}

function requireNullablePositiveInput(value: number | null): number | null {
  return value === null ? null : requirePositiveInput(value)
}

function requireBehavior(value: unknown, status: number): ElearningCreditAutomaticBehavior {
  if (!AUTOMATIC_BEHAVIORS.includes(value as ElearningCreditAutomaticBehavior)) {
    failShape(status)
  }
  return value as ElearningCreditAutomaticBehavior
}

function requireInputBehavior(value: string): ElearningCreditAutomaticBehavior {
  if (!AUTOMATIC_BEHAVIORS.includes(value as ElearningCreditAutomaticBehavior)) {
    fail('invalid_input', 400)
  }
  return value as ElearningCreditAutomaticBehavior
}

function requireWalletBehavior(value: unknown, status: number): ElearningCreditBehavior {
  if (!WALLET_BEHAVIORS.includes(value as ElearningCreditBehavior)) failShape(status)
  return value as ElearningCreditBehavior
}

function requireStatus(value: unknown, status: number): ElearningCreditWalletStatus {
  if (!WALLET_STATUSES.includes(value as ElearningCreditWalletStatus)) failShape(status)
  return value as ElearningCreditWalletStatus
}

function requireTimeZone(value: string): string {
  const timeZone = value.trim()
  if (timeZone === '' || timeZone.length > 128) fail('invalid_input', 400)
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    fail('invalid_input', 400)
  }
}

function readErrorCode(payload: unknown): string {
  if (!isPlainObject(payload) || typeof payload.error !== 'string') return 'request_failed'
  const code = payload.error.trim()
  if (code === 'ORG_CONTEXT_REQUIRED') return code
  return STABLE_ERROR_CODE_RE.test(code) ? code : 'request_failed'
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await apiFetch(path, init)
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
  if (hasForbiddenKeys(payload)) failShape(response.status)
  return payload
}

function parseRule(value: unknown, status: number): ElearningCreditRule {
  const keys = [
    'behavior', 'ruleId', 'version', 'points', 'dailyCap', 'timeZone', 'createdAt',
  ] as const
  if (!isPlainObject(value) || !exactKeys(value, keys)) failShape(status)
  const dailyCap = value.dailyCap === null
    ? null
    : requireSafeInt(value.dailyCap, status, 1)
  return {
    behavior: requireBehavior(value.behavior, status),
    ruleId: requireUuid(value.ruleId, status),
    version: requireSafeInt(value.version, status, 1),
    points: requireSafeInt(value.points, status, 1),
    dailyCap,
    timeZone: requireText(value.timeZone, status),
    createdAt: requireIsoTimestamp(value.createdAt, status),
  }
}

function parseWalletItem(value: unknown, status: number): ElearningCreditWalletItem {
  const keys = [
    'decisionId', 'behavior', 'awardedPoints', 'status', 'occurredAt', 'createdAt',
  ] as const
  if (!isPlainObject(value) || !exactKeys(value, keys)) failShape(status)
  const behavior = requireWalletBehavior(value.behavior, status)
  const walletStatus = requireStatus(value.status, status)
  const awardedPoints = requireSafeInt(
    value.awardedPoints,
    status,
    -PG_INT4_MAX,
    PG_INT4_MAX,
  )
  if (
    behavior === 'manual_adjust'
      ? walletStatus !== 'adjusted' || awardedPoints === 0
      : walletStatus === 'adjusted' || awardedPoints < 0
  ) failShape(status)
  return {
    decisionId: requireUuid(value.decisionId, status),
    behavior,
    awardedPoints,
    status: walletStatus,
    occurredAt: requireIsoTimestamp(value.occurredAt, status),
    createdAt: requireIsoTimestamp(value.createdAt, status),
  }
}

function parseTitleRow(value: unknown, status: number): ElearningTitleRow {
  if (!isPlainObject(value) || !exactKeys(value, ['id', 'name', 'threshold'])) {
    failShape(status)
  }
  return {
    id: requireText(value.id, status),
    name: requireText(value.name, status),
    threshold: requireSafeInt(value.threshold, status, 0, PG_INT4_MAX),
  }
}

function parseTitleSnapshot(value: unknown, status: number): ElearningTitleSnapshot {
  if (!isPlainObject(value) || !exactKeys(value, [
    'revisionId', 'version', 'titles', 'createdAt',
  ]) || !Array.isArray(value.titles) || value.titles.length > ELEARNING_TITLE_SNAPSHOT_MAX_ROWS) {
    failShape(status)
  }
  const revisionId = value.revisionId === null
    ? null
    : requireUuid(value.revisionId, status)
  const createdAt = value.createdAt === null
    ? null
    : requireIsoTimestamp(value.createdAt, status)
  const version = requireSafeInt(value.version, status, 0, PG_INT4_MAX)
  if ((revisionId === null) !== (createdAt === null) || (revisionId === null) !== (version === 0)) {
    failShape(status)
  }
  const titles = value.titles.map((title) => parseTitleRow(title, status))
  const ids = new Set(titles.map((title) => title.id))
  const thresholds = new Set(titles.map((title) => title.threshold))
  if (
    ids.size !== titles.length
    || thresholds.size !== titles.length
    || titles.some((title, index) => index > 0 && title.threshold <= titles[index - 1]!.threshold)
  ) failShape(status)
  return { revisionId, version, titles, createdAt }
}

function normalizeTitleInput(titles: ElearningTitleRow[]): ElearningTitleRow[] {
  if (!Array.isArray(titles) || titles.length > ELEARNING_TITLE_SNAPSHOT_MAX_ROWS) {
    fail('invalid_input', 400)
  }
  const normalized = titles.map((title) => ({
    id: requireInputText(title.id),
    name: requireInputText(title.name),
    threshold: requireTitleThresholdInput(title.threshold),
  })).sort((left, right) => left.threshold - right.threshold)
  if (
    new Set(normalized.map((title) => title.id)).size !== normalized.length
    || new Set(normalized.map((title) => title.threshold)).size !== normalized.length
  ) fail('invalid_input', 400)
  return normalized
}

function parseAdjustment(
  value: unknown,
  status: number,
): ElearningCreditAdjustmentResult {
  if (!isPlainObject(value) || !exactKeys(value, [
    'adjustmentId', 'userId', 'points', 'balancePoints', 'createdAt',
  ])) failShape(status)
  const points = requireSafeInt(value.points, status, -PG_INT4_MAX, PG_INT4_MAX)
  if (points === 0) failShape(status)
  return {
    adjustmentId: requireUuid(value.adjustmentId, status),
    userId: requireText(value.userId, status),
    points,
    balancePoints: requireSafeInt(value.balancePoints, status, 0, PG_INT4_MAX),
    createdAt: requireIsoTimestamp(value.createdAt, status),
  }
}

function parseWallet(value: unknown, status: number): ElearningCreditWallet {
  if (!isPlainObject(value) || !exactKeys(value, [
    'userId', 'balancePoints', 'currentTitle', 'items', 'nextCursor',
  ])) failShape(status)
  if (!Array.isArray(value.items)) failShape(status)
  const nextCursor = value.nextCursor === null
    ? null
    : requireText(value.nextCursor, status)
  return {
    userId: requireText(value.userId, status),
    balancePoints: requireSafeInt(value.balancePoints, status, 0, PG_INT4_MAX),
    currentTitle: value.currentTitle === null
      ? null
      : parseTitleRow(value.currentTitle, status),
    items: value.items.map((item) => parseWalletItem(item, status)),
    nextCursor,
  }
}

export async function listElearningCreditRules(): Promise<ElearningCreditRule[]> {
  const payload = await requestJson('/api/elearning/admin/credit-rules', { method: 'GET' })
  if (!isPlainObject(payload) || !exactKeys(payload, ['items']) || !Array.isArray(payload.items)) {
    failShape(200)
  }
  return payload.items.map((item) => parseRule(item, 200))
}

export async function publishElearningCreditRule(
  input: ElearningCreditRulePublishInput,
): Promise<ElearningCreditRule> {
  const body = {
    requestId: requireInputUuid(input.requestId),
    behavior: requireInputBehavior(input.behavior),
    points: requirePositiveInput(input.points),
    dailyCap: requireNullablePositiveInput(input.dailyCap),
    timeZone: requireTimeZone(input.timeZone),
  }
  return parseRule(await requestJson('/api/elearning/admin/credit-rules', {
    method: 'POST',
    body: JSON.stringify(body),
  }), 200)
}

export async function getElearningTitleSnapshot(): Promise<ElearningTitleSnapshot> {
  return parseTitleSnapshot(await requestJson(
    '/api/elearning/admin/credit-titles',
    { method: 'GET' },
  ), 200)
}

export async function publishElearningTitleSnapshot(
  input: ElearningTitlePublishInput,
): Promise<ElearningTitleSnapshot> {
  const body = {
    requestId: requireInputUuid(input.requestId),
    titles: normalizeTitleInput(input.titles),
  }
  return parseTitleSnapshot(await requestJson(
    '/api/elearning/admin/credit-titles',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  ), 200)
}

export async function adjustElearningCredit(
  input: ElearningCreditAdjustmentInput,
): Promise<ElearningCreditAdjustmentResult> {
  const body = {
    requestId: requireInputUuid(input.requestId),
    userId: requireInputText(input.userId),
    points: requireAdjustmentPointsInput(input.points),
    reason: requireInputText(input.reason),
  }
  return parseAdjustment(await requestJson('/api/elearning/admin/credits/adjustments', {
    method: 'POST',
    body: JSON.stringify(body),
  }), 200)
}

function walletQuery(cursor: string | null, limit: number): URLSearchParams {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ELEARNING_CREDIT_WALLET_PAGE_MAX) {
    fail('invalid_input', 400)
  }
  const query = new URLSearchParams({ limit: String(limit) })
  if (cursor !== null) {
    const value = cursor.trim()
    if (value === '' || value.length > 512) fail('invalid_input', 400)
    query.set('cursor', value)
  }
  return query
}

export async function getMyElearningCreditWallet(
  cursor: string | null = null,
  limit: number = ELEARNING_CREDIT_WALLET_PAGE_DEFAULT,
): Promise<ElearningCreditWallet> {
  const query = walletQuery(cursor, limit)
  return parseWallet(await requestJson(
    `/api/elearning/credits/wallet?${query.toString()}`,
    { method: 'GET' },
  ), 200)
}

export async function getAdminElearningCreditWallet(
  userId: string,
  cursor: string | null = null,
  limit: number = ELEARNING_CREDIT_WALLET_PAGE_DEFAULT,
): Promise<ElearningCreditWallet> {
  const target = userId.trim()
  if (target === '' || target.length > 512) fail('invalid_input', 400)
  const query = walletQuery(cursor, limit)
  query.set('userId', target)
  return parseWallet(await requestJson(
    `/api/elearning/admin/credits/wallet?${query.toString()}`,
    { method: 'GET' },
  ), 200)
}

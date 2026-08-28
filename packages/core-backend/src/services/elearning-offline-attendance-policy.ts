/**
 * Pure L6 offline-training attendance policy. Enrollment, QR verification,
 * persistence, rewards, notifications, and feature flags stay outside.
 */

const MAX_KEY_LENGTH = 512

const POLICY_KEYS = ['attendanceMode', 'policyRevision', 'targets'] as const
const TARGET_KEYS = [
  'checkInWindow',
  'checkOutWindow',
  'endsAt',
  'startsAt',
  'targetKey',
] as const
const WINDOW_KEYS = ['closesAt', 'opensAt'] as const
const STATE_KEYS = ['checkedInAt', 'checkedOutAt', 'policyRevision', 'targetKey'] as const
const COMMAND_KEYS = ['action', 'now'] as const
const COMPLETION_KEYS = ['attendanceStates'] as const

export type ElearningOfflineAttendanceMode = 'session' | 'training'
export type ElearningOfflineAttendanceAction = 'check_in' | 'check_out'
export type ElearningOfflineAttendanceStatus = 'checked_in' | 'checked_out' | 'not_checked_in'
export type ElearningOfflineAttendanceOutcome =
  | 'already_applied'
  | 'applied'
  | 'check_in_required'
  | 'invalid_transition'
  | 'window_closed'
  | 'window_not_open'

export type ElearningOfflineAttendancePolicyErrorCode =
  | 'invalid_input'
  | 'invalid_policy'
  | 'invalid_state'
  | 'policy_mismatch'
  | 'unknown_target'

export class ElearningOfflineAttendancePolicyError extends Error {
  constructor(readonly code: ElearningOfflineAttendancePolicyErrorCode) {
    super(code)
    this.name = 'ElearningOfflineAttendancePolicyError'
  }
}

export interface ElearningOfflineAttendanceWindow {
  readonly closesAt: string
  readonly opensAt: string
}

export interface ElearningOfflineAttendanceTargetPolicy {
  readonly checkInWindow: ElearningOfflineAttendanceWindow
  readonly checkOutWindow: ElearningOfflineAttendanceWindow
  readonly endsAt: string
  readonly startsAt: string
  readonly targetKey: string
}

declare const normalizedOfflineAttendancePolicy: unique symbol

export interface ElearningOfflineAttendancePolicy {
  readonly attendanceMode: ElearningOfflineAttendanceMode
  readonly policyRevision: string
  readonly targets: readonly ElearningOfflineAttendanceTargetPolicy[]
  readonly [normalizedOfflineAttendancePolicy]: true
}

export interface ElearningOfflineAttendanceSnapshot {
  readonly checkedInAt: string | null
  readonly checkedOutAt: string | null
  readonly policyRevision: string
  readonly targetKey: string
}

export interface ElearningOfflineAttendanceDecision extends ElearningOfflineAttendanceSnapshot {
  readonly completed: boolean
  readonly outcome: ElearningOfflineAttendanceOutcome
  readonly status: ElearningOfflineAttendanceStatus
}

export interface ElearningOfflineAttendanceCompletion {
  readonly completedTargetCount: number
  readonly policyRevision: string
  readonly status: 'completed' | 'in_progress'
  readonly totalTargetCount: number
}

function fail(code: ElearningOfflineAttendancePolicyErrorCode): never {
  throw new ElearningOfflineAttendancePolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_input')
  }
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail('invalid_input')
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== expectedKeys.length
      || sorted.some((key, index) => key !== expectedKeys[index])
    ) fail('invalid_input')

    const values: Record<string, unknown> = {}
    for (const key of expectedKeys) values[key] = (input as Record<string, unknown>)[key]
    return values
  } catch (error) {
    if (error instanceof ElearningOfflineAttendancePolicyError) throw error
    fail('invalid_input')
  }
}

function readDenseArray(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value)) fail('invalid_input')
    if (Reflect.ownKeys(value).length !== value.length + 1) fail('invalid_input')
    const snapshot: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) fail('invalid_input')
      snapshot.push(value[index])
    }
    return snapshot
  } catch (error) {
    if (error instanceof ElearningOfflineAttendancePolicyError) throw error
    fail('invalid_input')
  }
}

function requireKey(value: unknown, code: 'invalid_policy' | 'invalid_state'): string {
  if (typeof value !== 'string') fail(code)
  const text = value.trim()
  if (text === '' || text.length > MAX_KEY_LENGTH || text.includes('\0')) fail(code)
  for (let index = 0; index < text.length; index += 1) {
    const point = text.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail(code)
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      fail(code)
    }
  }
  return text
}

function requireInstant(
  value: unknown,
  code: 'invalid_input' | 'invalid_policy' | 'invalid_state',
): string {
  if (typeof value !== 'string' || !/^\d{4}-/.test(value)) fail(code)
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) fail(code)
  try {
    if (new Date(instant).toISOString() !== value) fail(code)
  } catch {
    fail(code)
  }
  return value
}

function readWindow(input: unknown): ElearningOfflineAttendanceWindow {
  const values = readExactObject(input, WINDOW_KEYS)
  const closesAt = requireInstant(values.closesAt, 'invalid_policy')
  const opensAt = requireInstant(values.opensAt, 'invalid_policy')
  if (Date.parse(closesAt) <= Date.parse(opensAt)) fail('invalid_policy')
  return Object.freeze({ closesAt, opensAt })
}

export function createElearningOfflineAttendancePolicy(
  input: unknown,
): ElearningOfflineAttendancePolicy {
  const values = readExactObject(input, POLICY_KEYS)
  const attendanceMode = values.attendanceMode
  if (attendanceMode !== 'training' && attendanceMode !== 'session') fail('invalid_policy')
  const policyRevision = requireKey(values.policyRevision, 'invalid_policy')
  const targetInputs = readDenseArray(values.targets)
  if (targetInputs.length === 0 || (attendanceMode === 'training' && targetInputs.length !== 1)) {
    fail('invalid_policy')
  }

  const targetKeys = new Set<string>()
  const targets = targetInputs.map((targetInput) => {
    const targetValues = readExactObject(targetInput, TARGET_KEYS)
    const targetKey = requireKey(targetValues.targetKey, 'invalid_policy')
    if (targetKeys.has(targetKey)) fail('invalid_policy')
    targetKeys.add(targetKey)
    const startsAt = requireInstant(targetValues.startsAt, 'invalid_policy')
    const endsAt = requireInstant(targetValues.endsAt, 'invalid_policy')
    if (Date.parse(endsAt) <= Date.parse(startsAt)) fail('invalid_policy')
    const checkInWindow = readWindow(targetValues.checkInWindow)
    const checkOutWindow = readWindow(targetValues.checkOutWindow)
    if (
      Date.parse(checkOutWindow.opensAt) < Date.parse(checkInWindow.opensAt)
      || Date.parse(checkOutWindow.closesAt) < Date.parse(checkInWindow.closesAt)
    ) fail('invalid_policy')
    return Object.freeze({
      checkInWindow,
      checkOutWindow,
      endsAt,
      startsAt,
      targetKey,
    })
  })

  return Object.freeze({
    attendanceMode,
    policyRevision,
    targets: Object.freeze(targets),
  }) as ElearningOfflineAttendancePolicy
}

function readSnapshot(
  input: unknown,
  policy: ElearningOfflineAttendancePolicy,
): ElearningOfflineAttendanceSnapshot {
  const values = readExactObject(input, STATE_KEYS)
  const policyRevision = requireKey(values.policyRevision, 'invalid_state')
  if (policyRevision !== policy.policyRevision) fail('policy_mismatch')
  const targetKey = requireKey(values.targetKey, 'invalid_state')
  const target = policy.targets.find((candidate) => candidate.targetKey === targetKey)
  if (!target) fail('unknown_target')
  const checkedInAt = values.checkedInAt === null
    ? null
    : requireInstant(values.checkedInAt, 'invalid_state')
  const checkedOutAt = values.checkedOutAt === null
    ? null
    : requireInstant(values.checkedOutAt, 'invalid_state')
  if (checkedOutAt !== null && checkedInAt === null) fail('invalid_state')
  if (
    checkedInAt !== null
    && !isInsideWindow(target.checkInWindow, Date.parse(checkedInAt))
  ) fail('invalid_state')
  if (
    checkedOutAt !== null
    && (!isInsideWindow(target.checkOutWindow, Date.parse(checkedOutAt))
      || Date.parse(checkedOutAt) < Date.parse(checkedInAt as string))
  ) fail('invalid_state')
  return Object.freeze({ checkedInAt, checkedOutAt, policyRevision, targetKey })
}

function statusOf(snapshot: ElearningOfflineAttendanceSnapshot): ElearningOfflineAttendanceStatus {
  if (snapshot.checkedOutAt !== null) return 'checked_out'
  if (snapshot.checkedInAt !== null) return 'checked_in'
  return 'not_checked_in'
}

function isInsideWindow(window: ElearningOfflineAttendanceWindow, instant: number): boolean {
  return instant >= Date.parse(window.opensAt) && instant < Date.parse(window.closesAt)
}

function windowOutcome(
  window: ElearningOfflineAttendanceWindow,
  instant: number,
): 'window_closed' | 'window_not_open' | null {
  if (instant < Date.parse(window.opensAt)) return 'window_not_open'
  if (instant >= Date.parse(window.closesAt)) return 'window_closed'
  return null
}

function decision(
  snapshot: ElearningOfflineAttendanceSnapshot,
  outcome: ElearningOfflineAttendanceOutcome,
): ElearningOfflineAttendanceDecision {
  return Object.freeze({
    ...snapshot,
    completed: snapshot.checkedOutAt !== null,
    outcome,
    status: statusOf(snapshot),
  })
}

export function applyElearningOfflineAttendance(
  policyInput: unknown,
  stateInput: unknown,
  commandInput: unknown,
): ElearningOfflineAttendanceDecision {
  const policy = createElearningOfflineAttendancePolicy(policyInput)
  const snapshot = readSnapshot(stateInput, policy)
  const target = policy.targets.find((candidate) => candidate.targetKey === snapshot.targetKey)
  if (!target) fail('unknown_target')
  const command = readExactObject(commandInput, COMMAND_KEYS)
  const action = command.action
  if (action !== 'check_in' && action !== 'check_out') fail('invalid_input')
  const now = requireInstant(command.now, 'invalid_input')

  if (action === 'check_in' && snapshot.checkedInAt !== null) {
    return decision(snapshot, 'already_applied')
  }
  if (action === 'check_out' && snapshot.checkedOutAt !== null) {
    return decision(snapshot, 'already_applied')
  }
  if (action === 'check_out' && snapshot.checkedInAt === null) {
    return decision(snapshot, 'check_in_required')
  }
  if (
    action === 'check_out'
    && Date.parse(now) < Date.parse(snapshot.checkedInAt as string)
  ) return decision(snapshot, 'invalid_transition')

  const window = action === 'check_in' ? target.checkInWindow : target.checkOutWindow
  const denied = windowOutcome(window, Date.parse(now))
  if (denied !== null) return decision(snapshot, denied)
  const next = action === 'check_in'
    ? Object.freeze({ ...snapshot, checkedInAt: now })
    : Object.freeze({ ...snapshot, checkedOutAt: now })
  return decision(next, 'applied')
}

export function evaluateElearningOfflineAttendanceCompletion(
  policyInput: unknown,
  input: unknown,
): ElearningOfflineAttendanceCompletion {
  const policy = createElearningOfflineAttendancePolicy(policyInput)
  const values = readExactObject(input, COMPLETION_KEYS)
  const stateInputs = readDenseArray(values.attendanceStates)
  if (stateInputs.length !== policy.targets.length) fail('invalid_state')
  const seen = new Set<string>()
  let completedTargetCount = 0
  for (const stateInput of stateInputs) {
    const snapshot = readSnapshot(stateInput, policy)
    if (seen.has(snapshot.targetKey)) fail('invalid_state')
    seen.add(snapshot.targetKey)
    if (snapshot.checkedOutAt !== null) completedTargetCount += 1
  }
  if (policy.targets.some((target) => !seen.has(target.targetKey))) fail('invalid_state')

  return Object.freeze({
    completedTargetCount,
    policyRevision: policy.policyRevision,
    status: completedTargetCount === policy.targets.length ? 'completed' : 'in_progress',
    totalTargetCount: policy.targets.length,
  })
}

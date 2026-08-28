import { createHash } from 'node:crypto'

import {
  createElearningOfflineAttendancePolicy,
  ElearningOfflineAttendancePolicyError,
} from './elearning-offline-attendance-policy'

/**
 * Pure L6 offline-training calendar projection. A future adapter must reconcile
 * all provider bindings scoped by authoritative org + trainingKey against the
 * desired event keys. This module never calls or names an external provider.
 */

export const ELEARNING_OFFLINE_CALENDAR_DOMAIN =
  'elearning.offline.calendar.v1' as const

const MAX_KEY_LENGTH = 512
const MAX_DISPLAY_NAME_LENGTH = 512

const CALENDAR_POLICY_KEYS = ['calendarPolicyRevision', 'syncEnabled'] as const
const ROSTER_KEYS = [
  'assistantUserIds',
  'displayName',
  'learnerUserIds',
  'orgId',
  'organizerUserId',
  'trainingKey',
] as const

export type ElearningOfflineCalendarPolicyErrorCode =
  | 'invalid_input'
  | 'invalid_policy'
  | 'invalid_roster'

export class ElearningOfflineCalendarPolicyError extends Error {
  constructor(readonly code: ElearningOfflineCalendarPolicyErrorCode) {
    super(code)
    this.name = 'ElearningOfflineCalendarPolicyError'
  }
}

declare const normalizedOfflineCalendarPolicy: unique symbol

export interface ElearningOfflineCalendarPolicy {
  readonly calendarPolicyRevision: string
  readonly syncEnabled: boolean
  readonly [normalizedOfflineCalendarPolicy]: true
}

export interface ElearningOfflineCalendarDesiredEvent {
  readonly assistantUserIds: readonly string[]
  readonly calendarEventKey: string
  readonly displayName: string
  readonly endsAt: string
  readonly learnerUserIds: readonly string[]
  readonly payloadDigest: string
  readonly startsAt: string
  readonly targetKey: string
}

export interface ElearningOfflineCalendarProjection {
  readonly attendancePolicyRevision: string
  readonly calendarPolicyRevision: string
  readonly desiredEvents: readonly ElearningOfflineCalendarDesiredEvent[]
  readonly orgId: string
  readonly organizerUserId: string
  readonly syncEnabled: boolean
  readonly trainingKey: string
}

interface ElearningOfflineCalendarRoster {
  readonly assistantUserIds: readonly string[]
  readonly displayName: string
  readonly learnerUserIds: readonly string[]
  readonly orgId: string
  readonly organizerUserId: string
  readonly trainingKey: string
}

function fail(code: ElearningOfflineCalendarPolicyErrorCode): never {
  throw new ElearningOfflineCalendarPolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: 'invalid_input' | 'invalid_policy',
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
    if (error instanceof ElearningOfflineCalendarPolicyError) throw error
    fail(code)
  }
}

function readDenseArray(input: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(input)) fail('invalid_roster')
    if (Reflect.ownKeys(input).length !== input.length + 1) fail('invalid_roster')
    const values: unknown[] = []
    for (let index = 0; index < input.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail('invalid_roster')
      values.push(input[index])
    }
    return values
  } catch (error) {
    if (error instanceof ElearningOfflineCalendarPolicyError) throw error
    fail('invalid_roster')
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

function requireText(
  value: unknown,
  code: 'invalid_policy' | 'invalid_roster',
  maxLength: number,
): string {
  if (typeof value !== 'string') fail(code)
  const text = value.trim()
  if (
    text === ''
    || text.length > maxLength
    || text.includes('\0')
    || !isWellFormedUnicode(text)
  ) fail(code)
  return text
}

function readUserIds(input: unknown): readonly string[] {
  const values = readDenseArray(input)
  const userIds: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const userId = requireText(value, 'invalid_roster', MAX_KEY_LENGTH)
    if (seen.has(userId)) fail('invalid_roster')
    seen.add(userId)
    userIds.push(userId)
  }
  return Object.freeze(userIds.sort())
}

export function createElearningOfflineCalendarPolicy(
  input: unknown,
): ElearningOfflineCalendarPolicy {
  const values = readExactObject(input, CALENDAR_POLICY_KEYS, 'invalid_policy')
  if (typeof values.syncEnabled !== 'boolean') fail('invalid_policy')
  return Object.freeze({
    calendarPolicyRevision: requireText(
      values.calendarPolicyRevision,
      'invalid_policy',
      MAX_KEY_LENGTH,
    ),
    syncEnabled: values.syncEnabled,
  }) as ElearningOfflineCalendarPolicy
}

function readRoster(input: unknown): ElearningOfflineCalendarRoster {
  const values = readExactObject(input, ROSTER_KEYS, 'invalid_input')
  const assistantUserIds = readUserIds(values.assistantUserIds)
  const learnerUserIds = readUserIds(values.learnerUserIds)
  const organizerUserId = requireText(
    values.organizerUserId,
    'invalid_roster',
    MAX_KEY_LENGTH,
  )
  const occupied = new Set(assistantUserIds)
  if (occupied.has(organizerUserId)) fail('invalid_roster')
  for (const learnerUserId of learnerUserIds) {
    if (learnerUserId === organizerUserId || occupied.has(learnerUserId)) {
      fail('invalid_roster')
    }
  }
  return Object.freeze({
    assistantUserIds,
    displayName: requireText(
      values.displayName,
      'invalid_roster',
      MAX_DISPLAY_NAME_LENGTH,
    ),
    learnerUserIds,
    orgId: requireText(values.orgId, 'invalid_roster', MAX_KEY_LENGTH),
    organizerUserId,
    trainingKey: requireText(values.trainingKey, 'invalid_roster', MAX_KEY_LENGTH),
  })
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function eventKey(orgId: string, trainingKey: string, targetKey: string): string {
  return `${ELEARNING_OFFLINE_CALENDAR_DOMAIN}:${hash({
    domain: ELEARNING_OFFLINE_CALENDAR_DOMAIN,
    orgId,
    targetKey,
    trainingKey,
  })}`
}

/**
 * Build provider-neutral desired state. Missing desired keys are deletions for
 * the future reconciler; an empty set therefore disables every bound event for
 * the authoritative org + trainingKey scope.
 */
export function projectElearningOfflineCalendar(
  attendancePolicyInput: unknown,
  calendarPolicyInput: unknown,
  rosterInput: unknown,
): ElearningOfflineCalendarProjection {
  let attendancePolicy: ReturnType<typeof createElearningOfflineAttendancePolicy>
  try {
    attendancePolicy = createElearningOfflineAttendancePolicy(attendancePolicyInput)
  } catch (error) {
    if (error instanceof ElearningOfflineAttendancePolicyError) fail('invalid_policy')
    fail('invalid_policy')
  }
  const calendarPolicy = createElearningOfflineCalendarPolicy(calendarPolicyInput)
  const roster = readRoster(rosterInput)
  const desiredEvents = calendarPolicy.syncEnabled
    ? attendancePolicy.targets.map((target) => Object.freeze({
        assistantUserIds: roster.assistantUserIds,
        calendarEventKey: eventKey(roster.orgId, roster.trainingKey, target.targetKey),
        displayName: roster.displayName,
        endsAt: target.endsAt,
        learnerUserIds: roster.learnerUserIds,
        payloadDigest: hash({
          assistantUserIds: roster.assistantUserIds,
          attendancePolicyRevision: attendancePolicy.policyRevision,
          calendarPolicyRevision: calendarPolicy.calendarPolicyRevision,
          displayName: roster.displayName,
          domain: ELEARNING_OFFLINE_CALENDAR_DOMAIN,
          endsAt: target.endsAt,
          learnerUserIds: roster.learnerUserIds,
          orgId: roster.orgId,
          organizerUserId: roster.organizerUserId,
          startsAt: target.startsAt,
          targetKey: target.targetKey,
          trainingKey: roster.trainingKey,
        }),
        startsAt: target.startsAt,
        targetKey: target.targetKey,
      }))
    : []

  return Object.freeze({
    attendancePolicyRevision: attendancePolicy.policyRevision,
    calendarPolicyRevision: calendarPolicy.calendarPolicyRevision,
    desiredEvents: Object.freeze(desiredEvents),
    orgId: roster.orgId,
    organizerUserId: roster.organizerUserId,
    syncEnabled: calendarPolicy.syncEnabled,
    trainingKey: roster.trainingKey,
  })
}

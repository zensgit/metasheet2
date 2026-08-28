import { createHash } from 'node:crypto'

/**
 * Pure L6 named-survey binding policy for multitable form submissions. The
 * producer must supply the exact viewId and an authoritative actor; persistence,
 * record ownership checks, routing, credits, and feature flags stay outside.
 */

export const ELEARNING_NAMED_SURVEY_DOMAIN =
  'elearning.named-survey.v1' as const

const MAX_KEY_LENGTH = 512

const BINDING_KEYS = [
  'bindingRevision',
  'orgId',
  'sheetId',
  'surveyKey',
  'trainingKey',
  'viewId',
] as const
const CONTEXT_KEYS = ['orgId'] as const
const EVENT_KEYS = [
  '_eventId',
  'actorId',
  'mode',
  'recordId',
  'sheetId',
  'viewId',
] as const

export type ElearningNamedSurveyPolicyErrorCode =
  | 'invalid_binding'
  | 'invalid_context'
  | 'invalid_event'

export class ElearningNamedSurveyPolicyError extends Error {
  constructor(readonly code: ElearningNamedSurveyPolicyErrorCode) {
    super(code)
    this.name = 'ElearningNamedSurveyPolicyError'
  }
}

declare const normalizedNamedSurveyBinding: unique symbol

export interface ElearningNamedSurveyBinding {
  readonly bindingRevision: string
  readonly orgId: string
  readonly sheetId: string
  readonly surveyKey: string
  readonly trainingKey: string
  readonly viewId: string
  readonly [normalizedNamedSurveyBinding]: true
}

export interface ElearningNamedSurveyCompletionReference {
  readonly orgId: string
  readonly recordId: string
  readonly sheetId: string
  readonly surveyKey: string
  readonly trainingKey: string
  readonly viewId: string
}

export interface ElearningNamedSurveyCompletionEffect {
  readonly actorUserId: string
  readonly effectKey: string
  readonly kind: 'named_survey_completion'
  readonly payloadDigest: string
  readonly reference: ElearningNamedSurveyCompletionReference
}

export type ElearningNamedSurveyIgnoredReason =
  | 'anonymous_not_allowed'
  | 'binding_mismatch'
  | 'context_mismatch'

export type ElearningNamedSurveyDecision =
  | {
      readonly bindingRevision: string
      readonly completionEffect: ElearningNamedSurveyCompletionEffect
      readonly eventId: string
      readonly eventMode: 'create' | 'update'
      readonly reason: null
      readonly status: 'accepted'
    }
  | {
      readonly bindingRevision: string
      readonly completionEffect: null
      readonly eventId: string
      readonly eventMode: 'create' | 'update'
      readonly reason: ElearningNamedSurveyIgnoredReason
      readonly status: 'ignored'
    }

interface ElearningNamedSurveyEvent {
  readonly actorId: string | null
  readonly eventId: string
  readonly mode: 'create' | 'update'
  readonly recordId: string
  readonly sheetId: string
  readonly viewId: string
}

function fail(code: ElearningNamedSurveyPolicyErrorCode): never {
  throw new ElearningNamedSurveyPolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ElearningNamedSurveyPolicyErrorCode,
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
    if (error instanceof ElearningNamedSurveyPolicyError) throw error
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

function requireKey(value: unknown, code: ElearningNamedSurveyPolicyErrorCode): string {
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

export function createElearningNamedSurveyBinding(
  input: unknown,
): ElearningNamedSurveyBinding {
  const values = readExactObject(input, BINDING_KEYS, 'invalid_binding')
  return Object.freeze({
    bindingRevision: requireKey(values.bindingRevision, 'invalid_binding'),
    orgId: requireKey(values.orgId, 'invalid_binding'),
    sheetId: requireKey(values.sheetId, 'invalid_binding'),
    surveyKey: requireKey(values.surveyKey, 'invalid_binding'),
    trainingKey: requireKey(values.trainingKey, 'invalid_binding'),
    viewId: requireKey(values.viewId, 'invalid_binding'),
  }) as ElearningNamedSurveyBinding
}

function readContext(input: unknown): { readonly orgId: string } {
  const values = readExactObject(input, CONTEXT_KEYS, 'invalid_context')
  return Object.freeze({ orgId: requireKey(values.orgId, 'invalid_context') })
}

function readEvent(input: unknown): ElearningNamedSurveyEvent {
  const values = readExactObject(input, EVENT_KEYS, 'invalid_event')
  const mode = values.mode
  if (mode !== 'create' && mode !== 'update') fail('invalid_event')
  const actorId = values.actorId === null
    ? null
    : requireKey(values.actorId, 'invalid_event')
  return Object.freeze({
    actorId,
    eventId: requireKey(values._eventId, 'invalid_event'),
    mode,
    recordId: requireKey(values.recordId, 'invalid_event'),
    sheetId: requireKey(values.sheetId, 'invalid_event'),
    viewId: requireKey(values.viewId, 'invalid_event'),
  })
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function ignored(
  bindingRevision: string,
  event: ElearningNamedSurveyEvent,
  reason: ElearningNamedSurveyIgnoredReason,
): ElearningNamedSurveyDecision {
  return Object.freeze({
    bindingRevision,
    completionEffect: null,
    eventId: event.eventId,
    eventMode: event.mode,
    reason,
    status: 'ignored',
  })
}

export function evaluateElearningNamedSurveySubmission(
  bindingInput: unknown,
  contextInput: unknown,
  eventInput: unknown,
): ElearningNamedSurveyDecision {
  const binding = createElearningNamedSurveyBinding(bindingInput)
  const context = readContext(contextInput)
  const event = readEvent(eventInput)
  if (context.orgId !== binding.orgId) {
    return ignored(binding.bindingRevision, event, 'context_mismatch')
  }
  if (event.sheetId !== binding.sheetId || event.viewId !== binding.viewId) {
    return ignored(binding.bindingRevision, event, 'binding_mismatch')
  }
  if (event.actorId === null) {
    return ignored(binding.bindingRevision, event, 'anonymous_not_allowed')
  }

  const reference = Object.freeze({
    orgId: binding.orgId,
    recordId: event.recordId,
    sheetId: binding.sheetId,
    surveyKey: binding.surveyKey,
    trainingKey: binding.trainingKey,
    viewId: binding.viewId,
  })
  const completionEffect = Object.freeze({
    actorUserId: event.actorId,
    effectKey: `${ELEARNING_NAMED_SURVEY_DOMAIN}:${hash({
      actorUserId: event.actorId,
      domain: ELEARNING_NAMED_SURVEY_DOMAIN,
      orgId: binding.orgId,
      surveyKey: binding.surveyKey,
      trainingKey: binding.trainingKey,
    })}`,
    kind: 'named_survey_completion' as const,
    payloadDigest: hash({
      actorUserId: event.actorId,
      domain: ELEARNING_NAMED_SURVEY_DOMAIN,
      ...reference,
    }),
    reference,
  })

  return Object.freeze({
    bindingRevision: binding.bindingRevision,
    completionEffect,
    eventId: event.eventId,
    eventMode: event.mode,
    reason: null,
    status: 'accepted',
  })
}

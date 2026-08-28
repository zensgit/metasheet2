/**
 * Pure L6 learning-map reward trigger policy. It emits deterministic effect
 * identities only; credit/certificate ledgers remain the persistence authority.
 */
import { createHash } from 'node:crypto'
import {
  ElearningLearningMapPolicyError,
  evaluateElearningLearningMap,
} from './elearning-learning-map-policy'

const MAX_TEXT_LENGTH = 512
const REWARD_INPUT_KEYS = [
  'afterCompletedTaskKeys',
  'beforeCompletedTaskKeys',
  'certificateMode',
  'creditMode',
  'mapKey',
] as const

export const ELEARNING_LEARNING_MAP_REWARD_DOMAIN =
  'elearning.learning-map.reward.v1' as const

export type ElearningLearningMapCreditMode = 'map' | 'stage'
export type ElearningLearningMapCertificateMode = 'map' | 'none' | 'stage'
export type ElearningLearningMapRewardKind = 'certificate' | 'credit'
export type ElearningLearningMapRewardScope = 'map' | 'stage'

export type ElearningLearningMapRewardPolicyErrorCode =
  | 'invalid_input'
  | 'invalid_transition'

export class ElearningLearningMapRewardPolicyError extends Error {
  constructor(readonly code: ElearningLearningMapRewardPolicyErrorCode) {
    super(code)
    this.name = 'ElearningLearningMapRewardPolicyError'
  }
}

export interface ElearningLearningMapRewardEffect {
  readonly effectKey: string
  readonly kind: ElearningLearningMapRewardKind
  readonly scope: ElearningLearningMapRewardScope
  readonly stageKey: string | null
}

export interface ElearningLearningMapRewardDecision {
  readonly certificateEffects: readonly ElearningLearningMapRewardEffect[]
  readonly creditEffects: readonly ElearningLearningMapRewardEffect[]
  readonly mapCompletedNow: boolean
  readonly newlyCompletedStageKeys: readonly string[]
  readonly policyRevision: string
}

function fail(code: ElearningLearningMapRewardPolicyErrorCode): never {
  throw new ElearningLearningMapRewardPolicyError(code)
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
    if (error instanceof ElearningLearningMapRewardPolicyError) throw error
    fail('invalid_input')
  }
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > MAX_TEXT_LENGTH || text.includes('\0')) {
    fail('invalid_input')
  }
  for (let index = 0; index < text.length; index += 1) {
    const point = text.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        fail('invalid_input')
      }
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      fail('invalid_input')
    }
  }
  return text
}

function normalizeCreditMode(value: unknown): ElearningLearningMapCreditMode {
  if (value !== 'map' && value !== 'stage') fail('invalid_input')
  return value
}

function normalizeCertificateMode(value: unknown): ElearningLearningMapCertificateMode {
  if (value !== 'map' && value !== 'none' && value !== 'stage') fail('invalid_input')
  return value
}

function effectKey(input: {
  kind: ElearningLearningMapRewardKind
  mapKey: string
  policyRevision: string
  scope: ElearningLearningMapRewardScope
  stageKey: string | null
}): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({
      domain: ELEARNING_LEARNING_MAP_REWARD_DOMAIN,
      kind: input.kind,
      mapKey: input.mapKey,
      policyRevision: input.policyRevision,
      scope: input.scope,
      stageKey: input.stageKey,
    }), 'utf8')
    .digest('hex')
  return `${ELEARNING_LEARNING_MAP_REWARD_DOMAIN}:${hash}`
}

function createEffect(
  kind: ElearningLearningMapRewardKind,
  scope: ElearningLearningMapRewardScope,
  stageKey: string | null,
  mapKey: string,
  policyRevision: string,
): ElearningLearningMapRewardEffect {
  return Object.freeze({
    effectKey: effectKey({ kind, mapKey, policyRevision, scope, stageKey }),
    kind,
    scope,
    stageKey,
  })
}

function effectsForMode(
  kind: ElearningLearningMapRewardKind,
  mode: ElearningLearningMapCertificateMode | ElearningLearningMapCreditMode,
  newlyCompletedStageKeys: readonly string[],
  mapCompletedNow: boolean,
  mapKey: string,
  policyRevision: string,
): readonly ElearningLearningMapRewardEffect[] {
  if (mode === 'none') return Object.freeze([])
  if (mode === 'map') {
    return Object.freeze(mapCompletedNow
      ? [createEffect(kind, 'map', null, mapKey, policyRevision)]
      : [])
  }
  return Object.freeze(newlyCompletedStageKeys.map((stageKey) => (
    createEffect(kind, 'stage', stageKey, mapKey, policyRevision)
  )))
}

export function deriveElearningLearningMapRewards(
  policyInput: unknown,
  input: unknown,
): ElearningLearningMapRewardDecision {
  const values = readExactObject(input, REWARD_INPUT_KEYS)
  const mapKey = requireText(values.mapKey)
  const creditMode = normalizeCreditMode(values.creditMode)
  const certificateMode = normalizeCertificateMode(values.certificateMode)

  let before: ReturnType<typeof evaluateElearningLearningMap>
  let after: ReturnType<typeof evaluateElearningLearningMap>
  try {
    before = evaluateElearningLearningMap(policyInput, {
      completedTaskKeys: values.beforeCompletedTaskKeys,
    })
    after = evaluateElearningLearningMap(policyInput, {
      completedTaskKeys: values.afterCompletedTaskKeys,
    })
  } catch (error) {
    if (error instanceof ElearningLearningMapPolicyError) {
      fail(error.code === 'invalid_progress' ? 'invalid_transition' : 'invalid_input')
    }
    throw error
  }

  const beforeCompleted = new Set(before.stages.flatMap((stage) => (
    stage.tasks.filter((task) => task.status === 'completed').map((task) => task.taskKey)
  )))
  const afterCompleted = new Set(after.stages.flatMap((stage) => (
    stage.tasks.filter((task) => task.status === 'completed').map((task) => task.taskKey)
  )))
  if ([...beforeCompleted].some((taskKey) => !afterCompleted.has(taskKey))) {
    fail('invalid_transition')
  }

  const newlyCompletedStageKeys = Object.freeze(after.stages
    .filter((stage, index) => (
      stage.status === 'completed' && before.stages[index].status !== 'completed'
    ))
    .map((stage) => stage.stageKey))
  const mapCompletedNow = before.status !== 'completed' && after.status === 'completed'

  return Object.freeze({
    certificateEffects: effectsForMode(
      'certificate',
      certificateMode,
      newlyCompletedStageKeys,
      mapCompletedNow,
      mapKey,
      after.policyRevision,
    ),
    creditEffects: effectsForMode(
      'credit',
      creditMode,
      newlyCompletedStageKeys,
      mapCompletedNow,
      mapKey,
      after.policyRevision,
    ),
    mapCompletedNow,
    newlyCompletedStageKeys,
    policyRevision: after.policyRevision,
  })
}

import {
  createElearningLearningMapPolicy,
  evaluateElearningLearningMap,
  type ElearningLearningMapPolicy,
  type ElearningLearningMapStageStatus,
  type ElearningLearningMapTaskStatus,
  type ElearningLearningMapUnlockMode,
} from './elearning-learning-map-policy'

/**
 * Pure L6 learning-map time-window policy. Storage, default window creation,
 * feature flags, and authorization stay outside this module.
 */

const MAX_STAGES = 10
const MAX_KEY_LENGTH = 512

const POLICY_KEYS = ['mapWindow', 'policyRevision', 'stages'] as const
const STAGE_KEYS = ['stageKey', 'window'] as const
const WINDOW_KEYS = ['closesAt', 'opensAt'] as const
const EVALUATION_KEYS = ['now'] as const

export type ElearningLearningMapTemporalGate = 'closed' | 'not_open' | 'open'
export type ElearningLearningMapTemporalPolicyErrorCode =
  | 'invalid_input'
  | 'invalid_policy'
  | 'policy_mismatch'

export class ElearningLearningMapTemporalPolicyError extends Error {
  constructor(readonly code: ElearningLearningMapTemporalPolicyErrorCode) {
    super(code)
    this.name = 'ElearningLearningMapTemporalPolicyError'
  }
}

export interface ElearningLearningMapTimeWindow {
  readonly closesAt: string | null
  readonly opensAt: string | null
}

export interface ElearningLearningMapStageTemporalPolicy {
  readonly stageKey: string
  readonly window: ElearningLearningMapTimeWindow
}

declare const normalizedTemporalPolicy: unique symbol

export interface ElearningLearningMapTemporalPolicy {
  readonly mapWindow: ElearningLearningMapTimeWindow
  readonly policyRevision: string
  readonly stages: readonly ElearningLearningMapStageTemporalPolicy[]
  readonly [normalizedTemporalPolicy]: true
}

export interface ElearningLearningMapTemporalStageState {
  readonly gate: ElearningLearningMapTemporalGate
  readonly stageKey: string
}

export interface ElearningLearningMapTemporalState {
  readonly evaluatedAt: string
  readonly mapGate: ElearningLearningMapTemporalGate
  readonly policyRevision: string
  readonly stages: readonly ElearningLearningMapTemporalStageState[]
}

export interface ElearningLearningMapEffectiveTaskState {
  readonly accessAllowed: boolean
  readonly status: ElearningLearningMapTaskStatus
  readonly taskKey: string
  readonly temporalGate: ElearningLearningMapTemporalGate
}

export interface ElearningLearningMapEffectiveStageState {
  readonly accessAllowed: boolean
  readonly stageKey: string
  readonly status: ElearningLearningMapStageStatus
  readonly tasks: readonly ElearningLearningMapEffectiveTaskState[]
  readonly temporalGate: ElearningLearningMapTemporalGate
}

export interface ElearningLearningMapEffectiveState {
  readonly completedTaskCount: number
  readonly evaluatedAt: string
  readonly mapAccessAllowed: boolean
  readonly mapGate: ElearningLearningMapTemporalGate
  readonly policyRevision: string
  readonly stages: readonly ElearningLearningMapEffectiveStageState[]
  readonly status: 'completed' | 'in_progress'
  readonly totalTaskCount: number
  readonly unlockMode: ElearningLearningMapUnlockMode
}

function fail(code: ElearningLearningMapTemporalPolicyErrorCode): never {
  throw new ElearningLearningMapTemporalPolicyError(code)
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
    if (error instanceof ElearningLearningMapTemporalPolicyError) throw error
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
    if (error instanceof ElearningLearningMapTemporalPolicyError) throw error
    fail('invalid_input')
  }
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_policy')
  const text = value.trim()
  if (text === '' || text.length > MAX_KEY_LENGTH || text.includes('\0')) fail('invalid_policy')
  for (let index = 0; index < text.length; index += 1) {
    const point = text.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail('invalid_policy')
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      fail('invalid_policy')
    }
  }
  return text
}

function requireInstant(value: unknown, code: 'invalid_input' | 'invalid_policy'): string {
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

function readWindow(input: unknown): ElearningLearningMapTimeWindow {
  const values = readExactObject(input, WINDOW_KEYS)
  const opensAt = values.opensAt === null
    ? null
    : requireInstant(values.opensAt, 'invalid_policy')
  const closesAt = values.closesAt === null
    ? null
    : requireInstant(values.closesAt, 'invalid_policy')
  if (opensAt !== null && closesAt !== null && Date.parse(closesAt) <= Date.parse(opensAt)) {
    fail('invalid_policy')
  }
  return Object.freeze({ closesAt, opensAt })
}

export function createElearningLearningMapTemporalPolicy(
  input: unknown,
): ElearningLearningMapTemporalPolicy {
  const values = readExactObject(input, POLICY_KEYS)
  const policyRevision = requireKey(values.policyRevision)
  const mapWindow = readWindow(values.mapWindow)
  const stageInputs = readDenseArray(values.stages)
  if (stageInputs.length === 0 || stageInputs.length > MAX_STAGES) fail('invalid_policy')

  const stageKeys = new Set<string>()
  const stages = stageInputs.map((stageInput) => {
    const stageValues = readExactObject(stageInput, STAGE_KEYS)
    const stageKey = requireKey(stageValues.stageKey)
    if (stageKeys.has(stageKey)) fail('invalid_policy')
    stageKeys.add(stageKey)
    return Object.freeze({
      stageKey,
      window: readWindow(stageValues.window),
    })
  })

  return Object.freeze({
    mapWindow,
    policyRevision,
    stages: Object.freeze(stages),
  }) as ElearningLearningMapTemporalPolicy
}

function evaluateWindow(
  window: ElearningLearningMapTimeWindow,
  nowMs: number,
): ElearningLearningMapTemporalGate {
  if (window.opensAt !== null && nowMs < Date.parse(window.opensAt)) return 'not_open'
  if (window.closesAt !== null && nowMs >= Date.parse(window.closesAt)) return 'closed'
  return 'open'
}

export function evaluateElearningLearningMapTemporalPolicy(
  policyInput: unknown,
  input: unknown,
): ElearningLearningMapTemporalState {
  const policy = createElearningLearningMapTemporalPolicy(policyInput)
  const values = readExactObject(input, EVALUATION_KEYS)
  const evaluatedAt = requireInstant(values.now, 'invalid_input')
  const nowMs = Date.parse(evaluatedAt)
  const mapGate = evaluateWindow(policy.mapWindow, nowMs)
  const stages = policy.stages.map((stage) => Object.freeze({
    gate: mapGate === 'open' ? evaluateWindow(stage.window, nowMs) : mapGate,
    stageKey: stage.stageKey,
  }))

  return Object.freeze({
    evaluatedAt,
    mapGate,
    policyRevision: policy.policyRevision,
    stages: Object.freeze(stages),
  })
}

function assertSameMapRevision(
  mapPolicy: ElearningLearningMapPolicy,
  temporalPolicy: ElearningLearningMapTemporalPolicy,
): void {
  if (
    mapPolicy.policyRevision !== temporalPolicy.policyRevision
    || mapPolicy.stages.length !== temporalPolicy.stages.length
    || mapPolicy.stages.some((stage, index) => (
      stage.stageKey !== temporalPolicy.stages[index]?.stageKey
    ))
  ) fail('policy_mismatch')
}

/**
 * Combine sequence progress with the time gate pinned to the same immutable map
 * revision. Access is denied outside either map or stage window even for a
 * completed item; completion evidence remains visible and unchanged.
 */
export function evaluateElearningLearningMapEffectiveState(
  mapPolicyInput: unknown,
  temporalPolicyInput: unknown,
  progressInput: unknown,
  input: unknown,
): ElearningLearningMapEffectiveState {
  const mapPolicy = createElearningLearningMapPolicy(mapPolicyInput)
  const temporalPolicy = createElearningLearningMapTemporalPolicy(temporalPolicyInput)
  assertSameMapRevision(mapPolicy, temporalPolicy)
  const progress = evaluateElearningLearningMap(mapPolicy, progressInput)
  const temporal = evaluateElearningLearningMapTemporalPolicy(temporalPolicy, input)

  const stages = progress.stages.map((stage, stageIndex) => {
    const temporalStage = temporal.stages[stageIndex]
    if (temporalStage?.stageKey !== stage.stageKey) fail('policy_mismatch')
    const temporalGate = temporalStage.gate
    const tasks = stage.tasks.map((task) => Object.freeze({
      accessAllowed: temporalGate === 'open'
        && stage.status !== 'locked'
        && task.status !== 'locked',
      status: task.status,
      taskKey: task.taskKey,
      temporalGate,
    }))
    return Object.freeze({
      accessAllowed: temporalGate === 'open' && stage.status !== 'locked',
      stageKey: stage.stageKey,
      status: stage.status,
      tasks: Object.freeze(tasks),
      temporalGate,
    })
  })

  return Object.freeze({
    completedTaskCount: progress.completedTaskCount,
    evaluatedAt: temporal.evaluatedAt,
    mapAccessAllowed: temporal.mapGate === 'open',
    mapGate: temporal.mapGate,
    policyRevision: progress.policyRevision,
    stages: Object.freeze(stages),
    status: progress.status,
    totalTaskCount: progress.totalTaskCount,
    unlockMode: progress.unlockMode,
  })
}

/**
 * Pure L6 blended-project/cohort policy. A learning-map policy owns stages,
 * tasks, and unlock order; this module pins each cohort's required subset and
 * role references. Membership, authorization, persistence, and stats stay out.
 */
import {
  createElearningLearningMapPolicy,
  ElearningLearningMapPolicyError,
  evaluateElearningLearningMap,
  type ElearningLearningMapPolicy,
  type ElearningLearningMapTaskStatus,
} from './elearning-learning-map-policy'

const MAX_KEY_LENGTH = 512
const PROJECT_KEYS = [
  'cohorts',
  'createdByUserId',
  'mapPolicyRevision',
  'projectKey',
  'projectOwnerUserId',
  'projectPolicyRevision',
] as const
const COHORT_KEYS = [
  'cohortKey',
  'homeroomTeacherUserId',
  'requiredTaskKeys',
] as const
const EVALUATION_KEYS = ['cohortKey', 'completedTaskKeys'] as const

export type ElearningBlendedProjectPolicyErrorCode =
  | 'invalid_input'
  | 'invalid_policy'
  | 'invalid_progress'
  | 'policy_mismatch'
  | 'unknown_cohort'

export class ElearningBlendedProjectPolicyError extends Error {
  constructor(readonly code: ElearningBlendedProjectPolicyErrorCode) {
    super(code)
    this.name = 'ElearningBlendedProjectPolicyError'
  }
}

export interface ElearningBlendedCohortPolicy {
  readonly cohortKey: string
  readonly homeroomTeacherUserId: string
  readonly requiredTaskKeys: readonly string[]
}

declare const normalizedBlendedProjectPolicy: unique symbol

export interface ElearningBlendedProjectPolicy {
  readonly cohorts: readonly ElearningBlendedCohortPolicy[]
  readonly createdByUserId: string
  readonly mapPolicyRevision: string
  readonly projectKey: string
  readonly projectOwnerUserId: string
  readonly projectPolicyRevision: string
  readonly [normalizedBlendedProjectPolicy]: true
}

export interface ElearningBlendedProjectTaskState {
  readonly required: boolean
  readonly status: ElearningLearningMapTaskStatus
  readonly taskKey: string
}

export interface ElearningBlendedProjectStageState {
  readonly stageKey: string
  readonly tasks: readonly ElearningBlendedProjectTaskState[]
}

export interface ElearningBlendedProjectState {
  readonly cohortKey: string
  readonly completedRequiredTaskCount: number
  readonly mapPolicyRevision: string
  readonly projectKey: string
  readonly projectPolicyRevision: string
  readonly stages: readonly ElearningBlendedProjectStageState[]
  readonly status: 'completed' | 'in_progress'
  readonly totalRequiredTaskCount: number
}

function fail(code: ElearningBlendedProjectPolicyErrorCode): never {
  throw new ElearningBlendedProjectPolicyError(code)
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
    if (error instanceof ElearningBlendedProjectPolicyError) throw error
    fail('invalid_input')
  }
}

function readDenseArray(input: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(input)) fail('invalid_input')
    if (Reflect.ownKeys(input).length !== input.length + 1) fail('invalid_input')
    const values: unknown[] = []
    for (let index = 0; index < input.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail('invalid_input')
      values.push(input[index])
    }
    return values
  } catch (error) {
    if (error instanceof ElearningBlendedProjectPolicyError) throw error
    fail('invalid_input')
  }
}

function requireKey(
  value: unknown,
  code: 'invalid_input' | 'invalid_policy',
): string {
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

function normalizeMapPolicy(input: unknown): ElearningLearningMapPolicy {
  try {
    return createElearningLearningMapPolicy(input)
  } catch {
    fail('invalid_policy')
  }
}

function mapPolicyInput(policy: ElearningLearningMapPolicy): unknown {
  return {
    policyRevision: policy.policyRevision,
    stages: policy.stages.map((stage) => ({
      stageKey: stage.stageKey,
      tasks: stage.tasks.map((task) => ({ taskKey: task.taskKey })),
    })),
    unlockMode: policy.unlockMode,
  }
}

function readRequiredTaskKeys(
  input: unknown,
  knownTaskKeys: ReadonlySet<string>,
): readonly string[] {
  const values = readDenseArray(input)
  if (values.length === 0) fail('invalid_policy')
  const requiredTaskKeys: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const taskKey = requireKey(value, 'invalid_policy')
    if (!knownTaskKeys.has(taskKey) || seen.has(taskKey)) fail('invalid_policy')
    seen.add(taskKey)
    requiredTaskKeys.push(taskKey)
  }
  return Object.freeze(requiredTaskKeys)
}

export function createElearningBlendedProjectPolicy(
  learningMapPolicyInput: unknown,
  input: unknown,
): ElearningBlendedProjectPolicy {
  const mapPolicy = normalizeMapPolicy(learningMapPolicyInput)
  const knownTaskKeys = new Set(
    mapPolicy.stages.flatMap((stage) => stage.tasks.map((task) => task.taskKey)),
  )
  const values = readExactObject(input, PROJECT_KEYS)
  const mapPolicyRevision = requireKey(values.mapPolicyRevision, 'invalid_policy')
  if (mapPolicyRevision !== mapPolicy.policyRevision) fail('policy_mismatch')
  const cohortInputs = readDenseArray(values.cohorts)
  if (cohortInputs.length === 0) fail('invalid_policy')
  const cohortKeys = new Set<string>()
  const cohorts = cohortInputs.map((cohortInput) => {
    const cohortValues = readExactObject(cohortInput, COHORT_KEYS)
    const cohortKey = requireKey(cohortValues.cohortKey, 'invalid_policy')
    if (cohortKeys.has(cohortKey)) fail('invalid_policy')
    cohortKeys.add(cohortKey)
    return Object.freeze({
      cohortKey,
      homeroomTeacherUserId: requireKey(
        cohortValues.homeroomTeacherUserId,
        'invalid_policy',
      ),
      requiredTaskKeys: readRequiredTaskKeys(
        cohortValues.requiredTaskKeys,
        knownTaskKeys,
      ),
    })
  })

  return Object.freeze({
    cohorts: Object.freeze(cohorts),
    createdByUserId: requireKey(values.createdByUserId, 'invalid_policy'),
    mapPolicyRevision,
    projectKey: requireKey(values.projectKey, 'invalid_policy'),
    projectOwnerUserId: requireKey(values.projectOwnerUserId, 'invalid_policy'),
    projectPolicyRevision: requireKey(values.projectPolicyRevision, 'invalid_policy'),
  }) as ElearningBlendedProjectPolicy
}

function evaluateMap(policy: ElearningLearningMapPolicy, completedTaskKeys: unknown) {
  try {
    return evaluateElearningLearningMap(mapPolicyInput(policy), { completedTaskKeys })
  } catch (error) {
    if (error instanceof ElearningLearningMapPolicyError) {
      fail(error.code === 'invalid_progress' ? 'invalid_progress' : 'invalid_input')
    }
    fail('invalid_input')
  }
}

export function evaluateElearningBlendedProject(
  learningMapPolicyInput: unknown,
  blendedProjectPolicyInput: unknown,
  input: unknown,
): ElearningBlendedProjectState {
  const mapPolicy = normalizeMapPolicy(learningMapPolicyInput)
  const projectPolicy = createElearningBlendedProjectPolicy(
    mapPolicyInput(mapPolicy),
    blendedProjectPolicyInput,
  )
  const values = readExactObject(input, EVALUATION_KEYS)
  const cohortKey = requireKey(values.cohortKey, 'invalid_input')
  const cohort = projectPolicy.cohorts.find((candidate) => candidate.cohortKey === cohortKey)
  if (!cohort) fail('unknown_cohort')
  const mapState = evaluateMap(mapPolicy, values.completedTaskKeys)
  const completedTaskKeys = new Set(
    mapState.stages.flatMap((stage) => stage.tasks
      .filter((task) => task.status === 'completed')
      .map((task) => task.taskKey)),
  )
  const requiredTaskKeys = new Set(cohort.requiredTaskKeys)
  const completedRequiredTaskCount = cohort.requiredTaskKeys
    .filter((taskKey) => completedTaskKeys.has(taskKey)).length
  const stages = mapState.stages.map((stage) => Object.freeze({
    stageKey: stage.stageKey,
    tasks: Object.freeze(stage.tasks.map((task) => Object.freeze({
      required: requiredTaskKeys.has(task.taskKey),
      status: task.status,
      taskKey: task.taskKey,
    }))),
  }))

  return Object.freeze({
    cohortKey,
    completedRequiredTaskCount,
    mapPolicyRevision: mapPolicy.policyRevision,
    projectKey: projectPolicy.projectKey,
    projectPolicyRevision: projectPolicy.projectPolicyRevision,
    stages: Object.freeze(stages),
    status: completedRequiredTaskCount === cohort.requiredTaskKeys.length
      ? 'completed'
      : 'in_progress',
    totalRequiredTaskCount: cohort.requiredTaskKeys.length,
  })
}

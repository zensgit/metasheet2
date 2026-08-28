/**
 * Pure L6 learning-map unlock policy. Persistence, assignment, time windows,
 * rewards, transport, and feature flags stay outside this module.
 */

const MAX_STAGES = 10
const MAX_TASKS_PER_STAGE = 20
const MAX_KEY_LENGTH = 512

const MAP_KEYS = ['policyRevision', 'stages', 'unlockMode'] as const
const STAGE_KEYS = ['stageKey', 'tasks'] as const
const TASK_KEYS = ['taskKey'] as const
const PROGRESS_KEYS = ['completedTaskKeys'] as const

export type ElearningLearningMapUnlockMode =
  | 'free'
  | 'stage_sequential'
  | 'task_sequential'

export type ElearningLearningMapPolicyErrorCode =
  | 'invalid_input'
  | 'invalid_policy'
  | 'invalid_progress'

export class ElearningLearningMapPolicyError extends Error {
  constructor(readonly code: ElearningLearningMapPolicyErrorCode) {
    super(code)
    this.name = 'ElearningLearningMapPolicyError'
  }
}

export interface ElearningLearningMapTaskPolicy {
  readonly taskKey: string
}

export interface ElearningLearningMapStagePolicy {
  readonly stageKey: string
  readonly tasks: readonly ElearningLearningMapTaskPolicy[]
}

declare const normalizedLearningMap: unique symbol

export interface ElearningLearningMapPolicy {
  readonly policyRevision: string
  readonly stages: readonly ElearningLearningMapStagePolicy[]
  readonly unlockMode: ElearningLearningMapUnlockMode
  readonly [normalizedLearningMap]: true
}

export type ElearningLearningMapTaskStatus = 'available' | 'completed' | 'locked'
export type ElearningLearningMapStageStatus = 'available' | 'completed' | 'locked'
export type ElearningLearningMapStatus = 'completed' | 'in_progress'

export interface ElearningLearningMapTaskState {
  readonly status: ElearningLearningMapTaskStatus
  readonly taskKey: string
}

export interface ElearningLearningMapStageState {
  readonly stageKey: string
  readonly status: ElearningLearningMapStageStatus
  readonly tasks: readonly ElearningLearningMapTaskState[]
}

export interface ElearningLearningMapState {
  readonly completedTaskCount: number
  readonly policyRevision: string
  readonly stages: readonly ElearningLearningMapStageState[]
  readonly status: ElearningLearningMapStatus
  readonly totalTaskCount: number
  readonly unlockMode: ElearningLearningMapUnlockMode
}

function fail(code: ElearningLearningMapPolicyErrorCode): never {
  throw new ElearningLearningMapPolicyError(code)
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
    if (error instanceof ElearningLearningMapPolicyError) throw error
    fail('invalid_input')
  }
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_policy')
  const text = value.trim()
  if (text === '' || text.length > MAX_KEY_LENGTH || text.includes('\0')) {
    fail('invalid_policy')
  }
  for (let index = 0; index < text.length; index += 1) {
    const point = text.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        fail('invalid_policy')
      }
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      fail('invalid_policy')
    }
  }
  return text
}

function readDenseArray(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value)) fail('invalid_input')
    const length = value.length
    if (Reflect.ownKeys(value).length !== length + 1) fail('invalid_input')
    const snapshot: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) fail('invalid_input')
      snapshot.push(value[index])
    }
    return snapshot
  } catch (error) {
    if (error instanceof ElearningLearningMapPolicyError) throw error
    fail('invalid_input')
  }
}

export function createElearningLearningMapPolicy(input: unknown): ElearningLearningMapPolicy {
  const values = readExactObject(input, MAP_KEYS)
  const policyRevision = requireKey(values.policyRevision)
  const unlockMode = values.unlockMode
  if (
    unlockMode !== 'free'
    && unlockMode !== 'stage_sequential'
    && unlockMode !== 'task_sequential'
  ) fail('invalid_policy')

  // Published map policies require at least one stage and one task per stage.
  const stageInputs = readDenseArray(values.stages)
  if (stageInputs.length === 0 || stageInputs.length > MAX_STAGES) fail('invalid_policy')
  const stageKeys = new Set<string>()
  const taskKeys = new Set<string>()
  const stages = stageInputs.map((stageInput) => {
    const stageValues = readExactObject(stageInput, STAGE_KEYS)
    const stageKey = requireKey(stageValues.stageKey)
    if (stageKeys.has(stageKey)) fail('invalid_policy')
    stageKeys.add(stageKey)

    const taskInputs = readDenseArray(stageValues.tasks)
    if (taskInputs.length === 0 || taskInputs.length > MAX_TASKS_PER_STAGE) {
      fail('invalid_policy')
    }
    const tasks = taskInputs.map((taskInput) => {
      const taskValues = readExactObject(taskInput, TASK_KEYS)
      const taskKey = requireKey(taskValues.taskKey)
      if (taskKeys.has(taskKey)) fail('invalid_policy')
      taskKeys.add(taskKey)
      return Object.freeze({ taskKey })
    })
    return Object.freeze({
      stageKey,
      tasks: Object.freeze(tasks),
    })
  })

  return Object.freeze({
    policyRevision,
    stages: Object.freeze(stages),
    unlockMode,
  }) as ElearningLearningMapPolicy
}

function readCompletedTaskKeys(
  input: unknown,
  knownTaskKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const values = readExactObject(input, PROGRESS_KEYS)
  const completedTaskInputs = readDenseArray(values.completedTaskKeys)
  const completedTaskKeys = new Set<string>()
  for (const value of completedTaskInputs) {
    if (typeof value !== 'string' || !knownTaskKeys.has(value) || completedTaskKeys.has(value)) {
      fail('invalid_progress')
    }
    completedTaskKeys.add(value)
  }
  return completedTaskKeys
}

/**
 * Derive learner-visible availability from immutable policy and authoritative
 * completion evidence. Impossible non-prefix progress fails closed.
 */
export function evaluateElearningLearningMap(
  policyInput: unknown,
  input: unknown,
): ElearningLearningMapState {
  const policy = createElearningLearningMapPolicy(policyInput)
  const allTasks = policy.stages.flatMap((stage) => stage.tasks)
  const knownTaskKeys = new Set(allTasks.map((task) => task.taskKey))
  const completedTaskKeys = readCompletedTaskKeys(input, knownTaskKeys)
  const firstIncompleteTaskIndex = allTasks.findIndex((task) => !completedTaskKeys.has(task.taskKey))
  const firstIncompleteStageIndex = policy.stages.findIndex((stage) => (
    stage.tasks.some((task) => !completedTaskKeys.has(task.taskKey))
  ))

  if (policy.unlockMode === 'task_sequential') {
    const prefixLength = firstIncompleteTaskIndex === -1 ? allTasks.length : firstIncompleteTaskIndex
    if (allTasks.slice(prefixLength + 1).some((task) => completedTaskKeys.has(task.taskKey))) {
      fail('invalid_progress')
    }
  } else if (policy.unlockMode === 'stage_sequential' && firstIncompleteStageIndex !== -1) {
    if (policy.stages.slice(firstIncompleteStageIndex + 1).some((stage) => (
      stage.tasks.some((task) => completedTaskKeys.has(task.taskKey))
    ))) fail('invalid_progress')
  }

  const stages = policy.stages.map((stage, stageIndex) => {
    const stageComplete = stage.tasks.every((task) => completedTaskKeys.has(task.taskKey))
    const stageAvailable = !stageComplete && (
      policy.unlockMode === 'free'
      || stageIndex === firstIncompleteStageIndex
    )
    const tasks = stage.tasks.map((task) => {
      const taskIndex = allTasks.findIndex((candidate) => candidate.taskKey === task.taskKey)
      const status: ElearningLearningMapTaskStatus = completedTaskKeys.has(task.taskKey)
        ? 'completed'
        : policy.unlockMode === 'free'
          || (policy.unlockMode === 'stage_sequential' && stageAvailable)
          || (policy.unlockMode === 'task_sequential' && taskIndex === firstIncompleteTaskIndex)
          ? 'available'
          : 'locked'
      return Object.freeze({ status, taskKey: task.taskKey })
    })
    const status: ElearningLearningMapStageStatus = stageComplete
      ? 'completed'
      : stageAvailable
        ? 'available'
        : 'locked'
    return Object.freeze({
      stageKey: stage.stageKey,
      status,
      tasks: Object.freeze(tasks),
    })
  })

  return Object.freeze({
    completedTaskCount: completedTaskKeys.size,
    policyRevision: policy.policyRevision,
    stages: Object.freeze(stages),
    status: completedTaskKeys.size === allTasks.length ? 'completed' : 'in_progress',
    totalTaskCount: allTasks.length,
    unlockMode: policy.unlockMode,
  })
}

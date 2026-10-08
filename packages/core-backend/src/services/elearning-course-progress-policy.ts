/**
 * Pure course-level progress policy for one immutable course version.
 *
 * Every item in the supplied version snapshot is required. Adapters translate
 * their server-owned item facts into these states; clients never submit course
 * completion. Adding optional-item semantics requires a new policy version.
 */

export const ELEARNING_COURSE_PROGRESS_POLICY_VERSION =
  'course-required-items-v1' as const
export const ELEARNING_COURSE_PROGRESS_MAX_ITEMS = 10_000 as const

const INPUT_KEYS = ['itemStates', 'policyVersion'] as const
const ITEM_STATES = ['not_started', 'in_progress', 'completed'] as const

export type ElearningCourseItemProgressState = (typeof ITEM_STATES)[number]
export type ElearningCourseProgressStatus = ElearningCourseItemProgressState

export class ElearningCourseProgressPolicyError extends Error {
  constructor(readonly code: 'invalid_input') {
    super(code)
    this.name = 'ElearningCourseProgressPolicyError'
  }
}

export interface ElearningCourseProgressEvaluation {
  readonly completedItemCount: number
  readonly itemCount: number
  readonly policyVersion: typeof ELEARNING_COURSE_PROGRESS_POLICY_VERSION
  readonly startedItemCount: number
  readonly status: ElearningCourseProgressStatus
}

function fail(): never {
  throw new ElearningCourseProgressPolicyError('invalid_input')
}

function readExactObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail()
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail()
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== INPUT_KEYS.length
      || sorted.some((key, index) => key !== INPUT_KEYS[index])
    ) fail()
    return Object.fromEntries(
      INPUT_KEYS.map((key) => [key, (input as Record<string, unknown>)[key]]),
    )
  } catch (error) {
    if (error instanceof ElearningCourseProgressPolicyError) throw error
    fail()
  }
}

function readItemStates(input: unknown): readonly ElearningCourseItemProgressState[] {
  try {
    if (
      !Array.isArray(input)
      || input.length < 1
      || input.length > ELEARNING_COURSE_PROGRESS_MAX_ITEMS
      || Reflect.ownKeys(input).length !== input.length + 1
    ) fail()
    const states: ElearningCourseItemProgressState[] = []
    for (let index = 0; index < input.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail()
      const value: unknown = input[index]
      if (!(ITEM_STATES as readonly unknown[]).includes(value)) fail()
      states.push(value as ElearningCourseItemProgressState)
    }
    return Object.freeze(states)
  } catch (error) {
    if (error instanceof ElearningCourseProgressPolicyError) throw error
    fail()
  }
}

export function evaluateElearningCourseProgress(
  input: unknown,
): ElearningCourseProgressEvaluation {
  const values = readExactObject(input)
  if (values.policyVersion !== ELEARNING_COURSE_PROGRESS_POLICY_VERSION) fail()
  const itemStates = readItemStates(values.itemStates)
  const completedItemCount = itemStates.filter((state) => state === 'completed').length
  const startedItemCount = itemStates.filter((state) => state !== 'not_started').length
  const status: ElearningCourseProgressStatus = completedItemCount === itemStates.length
    ? 'completed'
    : startedItemCount === 0
      ? 'not_started'
      : 'in_progress'
  return Object.freeze({
    completedItemCount,
    itemCount: itemStates.length,
    policyVersion: ELEARNING_COURSE_PROGRESS_POLICY_VERSION,
    startedItemCount,
    status,
  })
}

import { describe, expect, it } from 'vitest'

import {
  ElearningCourseLifecyclePolicyError,
  planElearningCourseDraftPointers,
  planElearningCourseHeadTransition,
  planElearningCoursePublishPointers,
  validateElearningCourseVersionTransition,
} from '../../src/services/elearning-course-lifecycle-policy'

const SENTINEL = 'secret-lifecycle-value'
const COURSE = '10000000-0000-4000-8000-000000000001'
const VERSION_A = '20000000-0000-4000-8000-000000000001'
const VERSION_B = '20000000-0000-4000-8000-000000000002'

function head(overrides: Record<string, unknown> = {}) {
  return {
    actorId: 'user-1',
    courseId: COURSE,
    fromStatus: 'active',
    reason: null,
    toStatus: 'archived',
    ...overrides,
  }
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    activeVersionId: VERSION_A,
    courseId: COURSE,
    draftVersionId: VERSION_B,
    latestVersionId: VERSION_A,
    ...overrides,
  }
}

function publish(overrides: Record<string, unknown> = {}) {
  return {
    activeVersionId: VERSION_A,
    courseId: COURSE,
    draftVersionId: VERSION_B,
    draftVersionStatus: 'draft',
    latestVersionId: VERSION_B,
    previousActiveVersionStatus: 'published',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected lifecycle policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningCourseLifecyclePolicyError)
    const policyError = error as ElearningCourseLifecyclePolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning course lifecycle policy', () => {
  it('accepts only the contracted course-head transitions', () => {
    const transitions = [
      head(),
      head({ fromStatus: 'archived', toStatus: 'active' }),
      head({ reason: '  urgent correction  ', toStatus: 'withdrawn' }),
      head({ fromStatus: 'archived', reason: 'unsafe content', toStatus: 'withdrawn' }),
      head({ fromStatus: 'withdrawn', reason: 'remediated', toStatus: 'active' }),
    ]
    expect(transitions.map(planElearningCourseHeadTransition)).toEqual([
      head(),
      head({ fromStatus: 'archived', toStatus: 'active' }),
      head({ reason: 'urgent correction', toStatus: 'withdrawn' }),
      head({ fromStatus: 'archived', reason: 'unsafe content', toStatus: 'withdrawn' }),
      head({ fromStatus: 'withdrawn', reason: 'remediated', toStatus: 'active' }),
    ])
  })

  it('requires an audit reason whenever withdrawal is entered or reversed', () => {
    for (const input of [
      head({ toStatus: 'withdrawn' }),
      head({ fromStatus: 'archived', toStatus: 'withdrawn' }),
      head({ fromStatus: 'withdrawn', toStatus: 'active' }),
    ]) expectCode(() => planElearningCourseHeadTransition(input), 'reason_required')
  })

  it('rejects no-op and illegal course-head transitions', () => {
    for (const input of [
      head({ fromStatus: 'active', toStatus: 'active' }),
      head({ fromStatus: 'archived', toStatus: 'archived' }),
      head({ fromStatus: 'withdrawn', reason: 'x', toStatus: 'withdrawn' }),
      head({ fromStatus: 'withdrawn', reason: 'x', toStatus: 'archived' }),
    ]) expectCode(() => planElearningCourseHeadTransition(input), 'illegal_transition')
  })

  it('moves only latest_version_id when creating a draft', () => {
    expect(planElearningCourseDraftPointers(draft())).toEqual({
      activeVersionId: VERSION_A,
      courseId: COURSE,
      draftVersionId: VERSION_B,
      latestVersionId: VERSION_B,
    })
    expect(planElearningCourseDraftPointers(draft({
      activeVersionId: null,
      latestVersionId: null,
    }))).toEqual({
      activeVersionId: null,
      courseId: COURSE,
      draftVersionId: VERSION_B,
      latestVersionId: VERSION_B,
    })
  })

  it('does not overwrite an existing draft or alias it to the active version', () => {
    for (const input of [
      draft({ latestVersionId: VERSION_B }),
      draft({ draftVersionId: VERSION_A }),
      draft({ activeVersionId: null, latestVersionId: VERSION_A }),
    ]) expectCode(() => planElearningCourseDraftPointers(input), 'illegal_transition')
  })

  it('publishes the latest draft, moves both pointers, then retires the previous active version', () => {
    expect(planElearningCoursePublishPointers(publish())).toEqual({
      courseId: COURSE,
      nextActiveVersionId: VERSION_B,
      nextLatestVersionId: VERSION_B,
      previousActiveVersionId: VERSION_A,
      publishVersionId: VERSION_B,
      retireAfterPointerMoveVersionId: VERSION_A,
    })
    expect(planElearningCoursePublishPointers(publish({
      activeVersionId: null,
      previousActiveVersionStatus: null,
    }))).toEqual({
      courseId: COURSE,
      nextActiveVersionId: VERSION_B,
      nextLatestVersionId: VERSION_B,
      previousActiveVersionId: null,
      publishVersionId: VERSION_B,
      retireAfterPointerMoveVersionId: null,
    })
  })

  it('rejects stale or inconsistent publication pointer snapshots', () => {
    for (const input of [
      publish({ draftVersionStatus: 'published' }),
      publish({ latestVersionId: VERSION_A }),
      publish({ draftVersionId: VERSION_A, latestVersionId: VERSION_A }),
      publish({ previousActiveVersionStatus: 'retired' }),
      publish({ activeVersionId: null }),
      publish({ activeVersionId: null, previousActiveVersionStatus: 'published' }),
      publish({ activeVersionId: VERSION_A, previousActiveVersionStatus: null }),
    ]) expectCode(() => planElearningCoursePublishPointers(input), 'illegal_transition')
  })

  it('allows only draft-to-published and inactive published-to-retired version transitions', () => {
    expect(validateElearningCourseVersionTransition({
      fromStatus: 'draft',
      isActiveVersion: false,
      toStatus: 'published',
    })).toEqual({ fromStatus: 'draft', toStatus: 'published' })
    expect(validateElearningCourseVersionTransition({
      fromStatus: 'published',
      isActiveVersion: false,
      toStatus: 'retired',
    })).toEqual({ fromStatus: 'published', toStatus: 'retired' })
    for (const input of [
      { fromStatus: 'draft', isActiveVersion: true, toStatus: 'published' },
      { fromStatus: 'published', isActiveVersion: true, toStatus: 'retired' },
      { fromStatus: 'draft', isActiveVersion: false, toStatus: 'retired' },
      { fromStatus: 'published', isActiveVersion: false, toStatus: 'published' },
      { fromStatus: 'retired', isActiveVersion: false, toStatus: 'published' },
    ]) expectCode(
      () => validateElearningCourseVersionTransition(input),
      'illegal_transition',
    )
  })

  it('rejects invalid identities, enums, booleans, text, and open shapes values-free', () => {
    for (const input of [
      null,
      {},
      { ...head(), extra: SENTINEL },
      head({ actorId: '' }),
      head({ actorId: '\ud800' }),
      head({ courseId: 'course-1' }),
      head({ fromStatus: 'disabled' }),
      head({ toStatus: 'disabled' }),
      head({ reason: SENTINEL.repeat(300) }),
    ]) expectCode(() => planElearningCourseHeadTransition(input), 'invalid_input')

    for (const input of [
      { ...draft(), extra: SENTINEL },
      draft({ activeVersionId: 'version-a' }),
      draft({ draftVersionId: 'version-b' }),
      draft({ latestVersionId: 1 }),
    ]) expectCode(() => planElearningCourseDraftPointers(input), 'invalid_input')

    for (const input of [
      { ...publish(), extra: SENTINEL },
      publish({ courseId: 'course-1' }),
      publish({ previousActiveVersionStatus: 'disabled' }),
    ]) expectCode(() => planElearningCoursePublishPointers(input), 'invalid_input')

    for (const input of [
      { fromStatus: 'in_review', isActiveVersion: false, toStatus: 'published' },
      { fromStatus: 'draft', isActiveVersion: 'false', toStatus: 'published' },
      { fromStatus: 'draft', isActiveVersion: false, toStatus: 'in_review' },
      { fromStatus: 'draft', isActiveVersion: false, toStatus: 'published', extra: SENTINEL },
    ]) expectCode(
      () => validateElearningCourseVersionTransition(input),
      'invalid_input',
    )
  })

  it('fails closed on hostile accessors and returns immutable detached plans', () => {
    const hostile = Object.defineProperty(head(), 'reason', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => planElearningCourseHeadTransition(hostile), 'invalid_input')

    const source = head({ actorId: '  user-1  ' })
    const result = planElearningCourseHeadTransition(source)
    source.actorId = SENTINEL
    expect(result.actorId).toBe('user-1')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(planElearningCourseDraftPointers(draft()))).toBe(true)
    expect(Object.isFrozen(planElearningCoursePublishPointers(publish()))).toBe(true)
    expect(Object.isFrozen(validateElearningCourseVersionTransition({
      fromStatus: 'draft',
      isActiveVersion: false,
      toStatus: 'published',
    }))).toBe(true)
  })
})

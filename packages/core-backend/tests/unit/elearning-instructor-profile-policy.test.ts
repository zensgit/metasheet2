import { describe, expect, it } from 'vitest'

import {
  buildElearningInstructorPublicProfile,
  createElearningInstructorProfileSnapshot,
  ElearningInstructorProfilePolicyError,
} from '../../src/services/elearning-instructor-profile-policy'

const SENTINEL = 'secret-instructor-value'
const INSTRUCTOR_ID = '10000000-0000-4000-8000-000000000001'
const PROFILE_REVISION_ID = '10000000-0000-4000-8000-000000000002'
const AVATAR_MEDIA_ID = '10000000-0000-4000-8000-000000000003'
const LEVEL_ID = '10000000-0000-4000-8000-000000000004'
const COURSE_ID = '10000000-0000-4000-8000-000000000005'
const LIVE_ID = '10000000-0000-4000-8000-000000000006'
const OFFLINE_ID = '10000000-0000-4000-8000-000000000007'
const HIDDEN_ID = '10000000-0000-4000-8000-000000000008'

function profile(overrides: Record<string, unknown> = {}) {
  return {
    avatarMediaId: AVATAR_MEDIA_ID,
    bio: '专注于企业协作与流程设计',
    displayName: '  陈老师  ',
    instructorId: INSTRUCTOR_ID,
    level: {
      capabilityRequirements: '完成认证并具有三次授课经验',
      levelId: LEVEL_ID,
      name: '高级讲师',
    },
    orgId: 'org-1',
    profileRevisionId: PROFILE_REVISION_ID,
    status: 'active',
    ...overrides,
  }
}

function content(
  contentId: string,
  contentKind: string,
  title: unknown,
  visible = true,
) {
  return { contentId, contentKind, title, visible }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected instructor profile policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningInstructorProfilePolicyError)
    const policyError = error as ElearningInstructorProfilePolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning instructor profile policy', () => {
  it('creates a closed deeply immutable profile and level snapshot', () => {
    const result = createElearningInstructorProfileSnapshot(profile())
    expect(result).toEqual({
      avatarMediaId: AVATAR_MEDIA_ID,
      bio: '专注于企业协作与流程设计',
      displayName: '陈老师',
      instructorId: INSTRUCTOR_ID,
      level: {
        capabilityRequirements: '完成认证并具有三次授课经验',
        levelId: LEVEL_ID,
        name: '高级讲师',
      },
      orgId: 'org-1',
      profileRevisionId: PROFILE_REVISION_ID,
      status: 'active',
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.level)).toBe(true)
  })

  it('publishes only visible teaching content and counts the three dimensions', () => {
    const result = buildElearningInstructorPublicProfile({
      profile: profile(),
      teachingContent: [
        content(COURSE_ID, 'course', '流程设计入门'),
        content(LIVE_ID, 'live', '流程答疑直播'),
        content(OFFLINE_ID, 'offline_training', '流程工作坊'),
        content(HIDDEN_ID, 'course', SENTINEL, false),
      ],
    })
    expect(result).toEqual({
      avatarMediaId: AVATAR_MEDIA_ID,
      bio: '专注于企业协作与流程设计',
      displayName: '陈老师',
      instructorId: INSTRUCTOR_ID,
      level: { levelId: LEVEL_ID, name: '高级讲师' },
      profileRevisionId: PROFILE_REVISION_ID,
      teachingContent: [
        { contentId: COURSE_ID, contentKind: 'course', title: '流程设计入门' },
        { contentId: LIVE_ID, contentKind: 'live', title: '流程答疑直播' },
        {
          contentId: OFFLINE_ID,
          contentKind: 'offline_training',
          title: '流程工作坊',
        },
      ],
      teachingContentCounts: { course: 1, live: 1, offlineTraining: 1 },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.level)).toBe(true)
    expect(Object.isFrozen(result.teachingContent)).toBe(true)
    expect(result.teachingContent.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(result.teachingContentCounts)).toBe(true)
  })

  it('keeps organization, capability requirements, visibility and storage metadata private', () => {
    const result = buildElearningInstructorPublicProfile({
      profile: profile(),
      teachingContent: [content(COURSE_ID, 'course', '课程')],
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('org-1')
    expect(serialized).not.toContain('完成认证并具有三次授课经验')
    expect(serialized).not.toContain('visible')
    expect(serialized).not.toMatch(/storageKey|userId|internal/i)
    expect(Object.keys(result)).toEqual([
      'avatarMediaId',
      'bio',
      'displayName',
      'instructorId',
      'level',
      'profileRevisionId',
      'teachingContent',
      'teachingContentCounts',
    ])
  })

  it('supports an instructor without a level or optional presentation fields', () => {
    const result = buildElearningInstructorPublicProfile({
      profile: profile({ avatarMediaId: null, bio: null, level: null }),
      teachingContent: [],
    })
    expect(result).toEqual({
      avatarMediaId: null,
      bio: null,
      displayName: '陈老师',
      instructorId: INSTRUCTOR_ID,
      level: null,
      profileRevisionId: PROFILE_REVISION_ID,
      teachingContent: [],
      teachingContentCounts: { course: 0, live: 0, offlineTraining: 0 },
    })
  })

  it('blocks archived profiles from the employee-facing view', () => {
    expectCode(() => buildElearningInstructorPublicProfile({
      profile: profile({ status: 'archived' }),
      teachingContent: [],
    }), 'profile_unavailable')
  })

  it('accepts only the closed profile and level shapes', () => {
    for (const value of [
      null,
      {},
      { ...profile(), extra: SENTINEL },
      profile({ status: 'disabled' }),
      profile({ displayName: '' }),
      profile({ bio: '\ud800' }),
      profile({ avatarMediaId: 'storage/private/avatar.png' }),
      profile({ instructorId: 'instructor-1' }),
      profile({ profileRevisionId: 'revision-1' }),
      profile({ orgId: '' }),
    ]) {
      expectCode(() => createElearningInstructorProfileSnapshot(value), 'invalid_profile')
    }
    for (const level of [
      {},
      { capabilityRequirements: '', levelId: LEVEL_ID, name: '高级讲师' },
      { capabilityRequirements: '认证', levelId: 'level-1', name: '高级讲师' },
      { capabilityRequirements: '认证', levelId: LEVEL_ID, name: '' },
      {
        capabilityRequirements: '认证',
        levelId: LEVEL_ID,
        name: '高级讲师',
        extra: SENTINEL,
      },
    ]) {
      expectCode(
        () => createElearningInstructorProfileSnapshot(profile({ level })),
        'invalid_level',
      )
    }
  })

  it('accepts only the closed employee-profile request and content-kind set', () => {
    for (const value of [
      null,
      {},
      { profile: profile(), teachingContent: [], extra: SENTINEL },
    ]) {
      expectCode(() => buildElearningInstructorPublicProfile(value), 'invalid_profile')
    }
    for (const value of [
      content(COURSE_ID, 'article', 'Bad'),
      content('course-1', 'course', 'Bad'),
      content(COURSE_ID, 'course', ''),
      { ...content(COURSE_ID, 'course', 'Bad'), extra: SENTINEL },
      { ...content(COURSE_ID, 'course', 'Bad'), visible: 'yes' },
    ]) {
      expectCode(() => buildElearningInstructorPublicProfile({
        profile: profile(),
        teachingContent: [value],
      }), 'invalid_content')
    }
  })

  it('rejects duplicate visible content identities', () => {
    expectCode(() => buildElearningInstructorPublicProfile({
      profile: profile(),
      teachingContent: [
        content(COURSE_ID, 'course', 'One'),
        content(COURSE_ID.toUpperCase(), 'course', 'Two'),
      ],
    }), 'duplicate_content')
    const result = buildElearningInstructorPublicProfile({
      profile: profile(),
      teachingContent: [
        content(COURSE_ID, 'course', 'Visible'),
        content(COURSE_ID, 'course', SENTINEL, false),
      ],
    })
    expect(result.teachingContent).toHaveLength(1)
  })

  it('fails closed on sparse arrays, oversized lists and hostile accessors', () => {
    expectCode(() => buildElearningInstructorPublicProfile({
      profile: profile(),
      teachingContent: new Array(1),
    }), 'invalid_content')
    expectCode(() => buildElearningInstructorPublicProfile({
      profile: profile(),
      teachingContent: Array.from(
        { length: 501 },
        (_, index) => content(
          `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          'course',
          `Course ${index}`,
        ),
      ),
    }), 'invalid_content')
    const hostileProfile = Object.defineProperty(profile(), 'displayName', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(
      () => createElearningInstructorProfileSnapshot(hostileProfile),
      'invalid_profile',
    )
    const hostileContent = Object.defineProperty(
      content(COURSE_ID, 'course', 'Bad'),
      'visible',
      { enumerable: true, get(): never { throw new Error(SENTINEL) } },
    )
    expectCode(() => buildElearningInstructorPublicProfile({
      profile: profile(),
      teachingContent: [hostileContent],
    }), 'invalid_content')
  })

  it('does not read hidden titles or retain mutable caller objects', () => {
    const hidden = content(HIDDEN_ID, 'course', 'Hidden', false)
    Object.defineProperty(hidden, 'title', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    const sourceProfile = profile()
    const visible = content(COURSE_ID, 'course', 'Original')
    const request = { profile: sourceProfile, teachingContent: [hidden, visible] }
    const result = buildElearningInstructorPublicProfile(request)
    ;(sourceProfile as { displayName: string }).displayName = SENTINEL
    visible.title = SENTINEL
    request.teachingContent.push(content(LIVE_ID, 'live', SENTINEL))
    expect(result.displayName).toBe('陈老师')
    expect(result.teachingContent).toEqual([
      { contentId: COURSE_ID, contentKind: 'course', title: 'Original' },
    ])
  })
})

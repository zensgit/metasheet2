import { describe, expect, it } from 'vitest'

import {
  ElearningLearningProfileError,
  getElearningLearningProfile,
  type ElearningLearningProfileDb,
} from '../../src/services/elearning-learning-profile'

const ORG = 'org-profile'
const USER = 'user-profile'
const COURSE_1 = '11111111-1111-4111-8111-111111111111'
const VERSION_1 = '22222222-2222-4222-8222-222222222222'
const COURSE_2 = '33333333-3333-4333-8333-333333333333'
const VERSION_2 = '44444444-4444-4444-8444-444444444444'
const EXAM_ITEM = '55555555-5555-4555-8555-555555555555'

function dbWith(rows: Array<Record<string, unknown>>, capture?: unknown[][]): ElearningLearningProfileDb {
  return {
    query: async (sql, params) => {
      expect(sql).toContain('/* elearning-learning-profile:list */')
      expect(sql).toContain('attempt.user_id = $2')
      expect(sql).toContain('attempt.course_version_id = v.id')
      expect(sql).toContain('attempt.course_version_item_id = i.id')
      expect(sql).toContain("evidence.item_type = i.item_type")
      expect(sql).toContain('JOIN users account')
      expect(sql).toContain('account.is_active IS TRUE')
      expect(sql).toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'")
      expect(sql).toContain("count(*) FILTER (WHERE item_type = 'video') >= 1")
      expect(sql).toContain("count(*) FILTER (WHERE item_type IN ('article', 'external_link')) = count(*)")
      expect(sql).not.toMatch(/paper_snapshot|answers|grading_records|event_digest/)
      capture?.push(params ?? [])
      return { rows, rowCount: rows.length }
    },
  }
}

function rows() {
  return [
    {
      membership_active: true,
      completed_courses: '2',
      assessment_courses: '1',
      content_courses: '1',
      course_id: COURSE_1,
      course_version_id: VERSION_1,
      title: 'Assessment course',
      kind: 'assessment',
      completed_at: new Date('2026-08-30T02:00:00.000Z'),
      cursor_completed_at: '2026-08-30T02:00:00.000900Z',
      exams: [{
        itemId: EXAM_ITEM,
        earnedScore: 9,
        totalScore: 10,
        passedAt: '2026-08-30T02:00:00.000Z',
      }],
      raw_secret: 'must-not-leak',
    },
    {
      membership_active: true,
      completed_courses: '2',
      assessment_courses: '1',
      content_courses: '1',
      course_id: COURSE_2,
      course_version_id: VERSION_2,
      title: 'Content course',
      kind: 'content',
      completed_at: '2026-08-29T02:00:00.000Z',
      cursor_completed_at: '2026-08-29T02:00:00.000100Z',
      exams: null,
    },
  ]
}

describe('e-learning learning profile', () => {
  it('returns a closed learner-owned archive and opaque stable cursor', async () => {
    const capture: unknown[][] = []
    const result = await getElearningLearningProfile(dbWith(rows(), capture), {
      orgId: ORG,
      userId: USER,
      limit: 1,
    })
    expect(capture).toEqual([[ORG, USER, null, null, 2]])
    expect(result).toEqual({
      userId: USER,
      summary: {
        completedCourses: 2,
        assessmentCourses: 1,
        contentCourses: 1,
      },
      courses: [{
        courseId: COURSE_1,
        courseVersionId: VERSION_1,
        title: 'Assessment course',
        kind: 'assessment',
        completedAt: '2026-08-30T02:00:00.000Z',
        exams: [{
          itemId: EXAM_ITEM,
          earnedScore: 9,
          totalScore: 10,
          passedAt: '2026-08-30T02:00:00.000Z',
        }],
      }],
      nextCursor: expect.any(String),
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|answer|requestHash|actorId/)

    const secondCapture: unknown[][] = []
    await getElearningLearningProfile(dbWith([rows()[1]!], secondCapture), {
      orgId: ORG,
      userId: USER,
      cursor: result.nextCursor!,
      limit: 1,
    })
    expect(secondCapture[0]?.slice(0, 2)).toEqual([ORG, USER])
    expect(secondCapture[0]?.[2]).toBe('2026-08-30T02:00:00.000900Z')
    expect(secondCapture[0]?.[3]).toBe(VERSION_1)
  })

  it('returns an empty archive with authoritative summary', async () => {
    await expect(getElearningLearningProfile(dbWith([{
      membership_active: true,
      completed_courses: '0',
      assessment_courses: '0',
      content_courses: '0',
      course_id: null,
    }]), { orgId: ORG, userId: USER })).resolves.toEqual({
      userId: USER,
      summary: { completedCourses: 0, assessmentCourses: 0, contentCourses: 0 },
      courses: [],
      nextCursor: null,
    })
  })

  it('fails closed for inactive membership, malformed cursor and corrupt rows', async () => {
    await expect(getElearningLearningProfile(dbWith([{
      membership_active: false,
      completed_courses: '0',
      assessment_courses: '0',
      content_courses: '0',
      course_id: null,
    }]), { orgId: ORG, userId: USER })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(getElearningLearningProfile(dbWith([]), {
      orgId: ORG,
      userId: USER,
      cursor: 'not-a-cursor',
    })).rejects.toMatchObject({ code: 'invalid_input' })
    const corrupt = rows()
    corrupt[0]!.exams = [{
      itemId: EXAM_ITEM,
      earnedScore: 11,
      totalScore: 10,
      passedAt: '2026-08-30T02:00:00.000Z',
    }]
    await expect(getElearningLearningProfile(dbWith(corrupt), {
      orgId: ORG,
      userId: USER,
    })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects invalid context, limits and query failures with values-free errors', async () => {
    for (const input of [
      { orgId: '', userId: USER },
      { orgId: ORG, userId: '' },
      { orgId: ORG, userId: USER, limit: 0 },
      { orgId: ORG, userId: USER, limit: 101 },
    ]) {
      await expect(getElearningLearningProfile(dbWith([]), input))
        .rejects.toBeInstanceOf(ElearningLearningProfileError)
    }
    await expect(getElearningLearningProfile({
      query: async () => { throw new Error('database details') },
    }, { orgId: ORG, userId: USER })).rejects.toEqual(
      new ElearningLearningProfileError('unavailable'),
    )
  })
})

import { describe, expect, it } from 'vitest'

import { ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION } from '../../src/services/elearning-document-completion-policy'
import {
  ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION,
  ELEARNING_COURSE_VERSION_MAX_ITEMS,
  ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION,
  ElearningCourseVersionItemsPolicyError,
  normalizeElearningCourseVersionItems,
  type ElearningCourseVersionItemType,
} from '../../src/services/elearning-course-version-items-policy'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
} from '../../src/services/elearning-watch-progress'

const SENTINEL = 'secret-version-item-value'
const IDS = {
  article: '10000000-0000-4000-8000-000000000001',
  document: '10000000-0000-4000-8000-000000000002',
  exam: '10000000-0000-4000-8000-000000000003',
  external_link: '10000000-0000-4000-8000-000000000004',
  video: '10000000-0000-4000-8000-000000000005',
} as const
const REFS = {
  article: '20000000-0000-4000-8000-000000000001',
  document: '20000000-0000-4000-8000-000000000002',
  exam: '20000000-0000-4000-8000-000000000003',
  external_link: '20000000-0000-4000-8000-000000000004',
  video: '20000000-0000-4000-8000-000000000005',
} as const

function item(
  itemType: ElearningCourseVersionItemType,
  position: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    articleRevisionId: null,
    completionPolicyVersion: null,
    completionThresholdBps: null,
    examId: null,
    externalLinkRevisionId: null,
    itemId: IDS[itemType],
    itemType,
    mediaId: null,
    position,
  }
  if (itemType === 'article') {
    row.articleRevisionId = REFS.article
    row.completionPolicyVersion = ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION
  } else if (itemType === 'external_link') {
    row.externalLinkRevisionId = REFS.external_link
    row.completionPolicyVersion = ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION
  } else if (itemType === 'document') {
    row.mediaId = REFS.document
    row.completionPolicyVersion = ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION
    row.completionThresholdBps = 8_000
  } else if (itemType === 'video') {
    row.mediaId = REFS.video
    row.completionPolicyVersion = ELEARNING_WATCH_POLICY_VERSION
    row.completionThresholdBps = ELEARNING_WATCH_THRESHOLD_BPS
  } else {
    row.examId = REFS.exam
  }
  return { ...row, ...overrides }
}

function expectInvalid(action: () => unknown): void {
  try {
    action()
    throw new Error('expected version items policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningCourseVersionItemsPolicyError)
    const policyError = error as ElearningCourseVersionItemsPolicyError
    expect(policyError.code).toBe('invalid_input')
    expect(policyError.message).toBe('invalid_input')
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning course version items policy', () => {
  it('normalizes an ordered mixed-content series without mutable child aliases', () => {
    const result = normalizeElearningCourseVersionItems([
      item('exam', 5),
      item('video', 4),
      item('article', 1, { articleRevisionId: REFS.article.toUpperCase() }),
      item('external_link', 2),
      item('document', 3),
    ])
    expect(result).toEqual([
      item('article', 1),
      item('external_link', 2),
      item('document', 3),
      item('video', 4),
      item('exam', 5),
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.every(Object.isFrozen)).toBe(true)
  })

  it('requires exactly one type-appropriate immutable content reference', () => {
    for (const row of [
      item('article', 1, { articleRevisionId: null }),
      item('article', 1, { mediaId: REFS.video }),
      item('external_link', 1, { externalLinkRevisionId: null }),
      item('external_link', 1, { articleRevisionId: REFS.article }),
      item('document', 1, { mediaId: null }),
      item('document', 1, { examId: REFS.exam }),
      item('video', 1, { mediaId: null }),
      item('video', 1, { externalLinkRevisionId: REFS.external_link }),
      item('exam', 1, { examId: null }),
      item('exam', 1, { mediaId: REFS.video }),
    ]) expectInvalid(() => normalizeElearningCourseVersionItems([row]))
  })

  it('binds each item type to its versioned completion policy', () => {
    for (const row of [
      item('article', 1, { completionPolicyVersion: null }),
      item('article', 1, { completionThresholdBps: 1 }),
      item('external_link', 1, {
        completionPolicyVersion: ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION,
      }),
      item('document', 1, { completionPolicyVersion: ELEARNING_WATCH_POLICY_VERSION }),
      item('document', 1, { completionThresholdBps: 0 }),
      item('document', 1, { completionThresholdBps: 10_001 }),
      item('document', 1, { completionThresholdBps: 8_000.5 }),
      item('video', 1, {
        completionPolicyVersion: ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
      }),
      item('video', 1, { completionThresholdBps: ELEARNING_WATCH_THRESHOLD_BPS - 1 }),
      item('exam', 1, { completionPolicyVersion: 'exam-pass-v1' }),
    ]) expectInvalid(() => normalizeElearningCourseVersionItems([row]))
  })

  it('rejects invalid identities, positions, duplicate ids, and duplicate positions', () => {
    for (const rows of [
      [item('article', 1, { itemId: 'item-1' })],
      [item('article', 1, { articleRevisionId: 'article-1' })],
      [item('article', 0)],
      [item('article', 1.5)],
      [item('article', ELEARNING_COURSE_VERSION_MAX_ITEMS + 1)],
      [item('article', 1), item('document', 2, { itemId: IDS.article })],
      [item('article', 1), item('document', 1)],
    ]) expectInvalid(() => normalizeElearningCourseVersionItems(rows))
  })

  it('rejects empty, sparse, oversized, and decorated item arrays', () => {
    expectInvalid(() => normalizeElearningCourseVersionItems([]))
    expectInvalid(() => normalizeElearningCourseVersionItems(new Array(1)))
    expectInvalid(() => normalizeElearningCourseVersionItems(
      new Array(ELEARNING_COURSE_VERSION_MAX_ITEMS + 1).fill(item('article', 1)),
    ))
    const decorated = [item('article', 1)] as Array<Record<string, unknown>> & {
      secret?: string
    }
    decorated.secret = SENTINEL
    expectInvalid(() => normalizeElearningCourseVersionItems(decorated))
  })

  it('rejects open or hostile item snapshots values-free', () => {
    for (const value of [
      null,
      {},
      [{ ...item('article', 1), secret: SENTINEL }],
      [item('article', 1, { itemType: 'unsupported' })],
    ]) expectInvalid(() => normalizeElearningCourseVersionItems(value))

    const hostile = item('article', 1)
    Object.defineProperty(hostile, 'articleRevisionId', {
      enumerable: true,
      get() {
        throw new Error(SENTINEL)
      },
    })
    expectInvalid(() => normalizeElearningCourseVersionItems([hostile]))
  })

  it('does not retain caller array or item object mutations', () => {
    const source = item('article', 1)
    const rows = [source]
    const result = normalizeElearningCourseVersionItems(rows)
    source.position = 2
    rows.push(item('document', 2))
    expect(result).toEqual([item('article', 1)])
  })
})

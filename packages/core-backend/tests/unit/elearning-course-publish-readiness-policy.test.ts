import { describe, expect, it } from 'vitest'

import {
  ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
  ELEARNING_DOCUMENT_MAX_PAGES,
} from '../../src/services/elearning-document-completion-policy'
import {
  ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION,
  ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION,
  type ElearningCourseVersionItemType,
} from '../../src/services/elearning-course-version-items-policy'
import {
  assertElearningCoursePublishReadiness,
  ElearningCoursePublishReadinessError,
} from '../../src/services/elearning-course-publish-readiness-policy'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
} from '../../src/services/elearning-watch-progress'

const SENTINEL = 'secret-readiness-value'
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

function item(itemType: ElearningCourseVersionItemType, position: number) {
  const row = {
    articleRevisionId: null as string | null,
    completionPolicyVersion: null as string | null,
    completionThresholdBps: null as number | null,
    examId: null as string | null,
    externalLinkRevisionId: null as string | null,
    itemId: IDS[itemType],
    itemType,
    mediaId: null as string | null,
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
  return row
}

function authority(
  itemType: ElearningCourseVersionItemType,
  overrides: Record<string, unknown> = {},
) {
  const media = itemType === 'document' || itemType === 'video'
  return {
    itemId: IDS[itemType],
    itemType,
    measurementAuthority: media ? 'server_probe' : null,
    referenceId: REFS[itemType],
    referenceState: itemType === 'article' || itemType === 'external_link'
      ? 'revision_verified'
      : itemType === 'exam'
        ? 'published'
        : 'ready',
    serverDurationMs: itemType === 'video' ? 120_000 : null,
    serverPageCount: itemType === 'document' ? 12 : null,
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected publish readiness error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningCoursePublishReadinessError)
    const policyError = error as ElearningCoursePublishReadinessError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning course publish readiness policy', () => {
  it('accepts a fully verified mixed-content version and orders authorities by item', () => {
    const items = [
      item('article', 1),
      item('external_link', 2),
      item('document', 3),
      item('video', 4),
      item('exam', 5),
    ]
    const result = assertElearningCoursePublishReadiness({
      authorities: [
        authority('exam'),
        authority('video'),
        authority('article', { itemId: IDS.article.toUpperCase() }),
        authority('document'),
        authority('external_link'),
      ],
      items,
    })
    expect(result.items).toEqual(items)
    expect(result.authorities.map((row) => row.itemType)).toEqual([
      'article',
      'external_link',
      'document',
      'video',
      'exam',
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.items)).toBe(true)
    expect(Object.isFrozen(result.authorities)).toBe(true)
    expect(result.authorities.every(Object.isFrozen)).toBe(true)
  })

  it('does not impose the V0.1 video-plus-exam shape on L1 courses', () => {
    expect(assertElearningCoursePublishReadiness({
      authorities: [authority('article')],
      items: [item('article', 1)],
    }).items.map((row) => row.itemType)).toEqual(['article'])
    expect(assertElearningCoursePublishReadiness({
      authorities: [authority('document')],
      items: [item('document', 1)],
    }).items.map((row) => row.itemType)).toEqual(['document'])
  })

  it('requires verified immutable revisions and published exams', () => {
    for (const input of [
      { authorities: [authority('article', { referenceState: 'ready' })], items: [item('article', 1)] },
      { authorities: [authority('article', { referenceState: 'revision_unverified' })], items: [item('article', 1)] },
      { authorities: [authority('external_link', { referenceState: 'ready' })], items: [item('external_link', 1)] },
      { authorities: [authority('exam', { referenceState: 'draft' })], items: [item('exam', 1)] },
      { authorities: [authority('exam', { referenceState: 'retired' })], items: [item('exam', 1)] },
      { authorities: [authority('exam', { referenceState: 'ready' })], items: [item('exam', 1)] },
    ]) expectCode(
      () => assertElearningCoursePublishReadiness(input),
      'reference_unavailable',
    )
  })

  it('requires ready server-probed document pages and video duration', () => {
    for (const input of [
      { authorities: [authority('document', { referenceState: 'published' })], items: [item('document', 1)] },
      { authorities: [authority('document', { referenceState: 'uploading' })], items: [item('document', 1)] },
      { authorities: [authority('document', { measurementAuthority: null })], items: [item('document', 1)] },
      { authorities: [authority('document', { serverPageCount: null })], items: [item('document', 1)] },
      { authorities: [authority('document', { serverPageCount: ELEARNING_DOCUMENT_MAX_PAGES + 1 })], items: [item('document', 1)] },
      { authorities: [authority('video', { referenceState: 'published' })], items: [item('video', 1)] },
      { authorities: [authority('video', { referenceState: 'probing' })], items: [item('video', 1)] },
      { authorities: [authority('video', { referenceState: 'rejected' })], items: [item('video', 1)] },
      { authorities: [authority('video', { measurementAuthority: null })], items: [item('video', 1)] },
      { authorities: [authority('video', { serverDurationMs: null })], items: [item('video', 1)] },
    ]) expectCode(() => assertElearningCoursePublishReadiness(input), 'reference_unavailable')
  })

  it('enforces a one-to-one item, type, and immutable-reference match', () => {
    const items = [item('article', 1), item('document', 2)]
    for (const authorities of [
      [authority('article')],
      [authority('article'), authority('document'), authority('exam')],
      [authority('article'), authority('article')],
      [authority('article'), authority('document', { itemId: IDS.exam })],
      [
        authority('article'),
        authority('article', {
          itemId: IDS.document,
          referenceId: REFS.document,
        }),
      ],
      [authority('article'), authority('document', { referenceId: REFS.video })],
    ]) expectCode(
      () => assertElearningCoursePublishReadiness({ authorities, items }),
      'reference_unavailable',
    )
  })

  it('rejects invalid authority fields and unexpected measurements', () => {
    for (const authorityInput of [
      authority('article', { itemId: 'item-1' }),
      authority('article', { itemType: 'survey' }),
      authority('article', { referenceId: 'revision-1' }),
      authority('article', { referenceState: 'unknown' }),
      authority('article', { measurementAuthority: 'client' }),
      authority('video', { serverDurationMs: 0 }),
      authority('document', { serverPageCount: 1.5 }),
      { ...authority('article'), extra: SENTINEL },
    ]) expectCode(
      () => assertElearningCoursePublishReadiness({
        authorities: [authorityInput],
        items: [item('article', 1)],
      }),
      'invalid_input',
    )
    for (const authorityInput of [
      authority('article', { serverPageCount: 1 }),
      authority('exam', { serverDurationMs: 1 }),
    ]) expectCode(
      () => assertElearningCoursePublishReadiness({
        authorities: [authorityInput],
        items: [item('article', 1)],
      }),
      'reference_unavailable',
    )
  })

  it('rejects open, sparse, decorated, invalid-item, and hostile inputs values-free', () => {
    for (const input of [
      null,
      {},
      { authorities: [], items: [], extra: SENTINEL },
      { authorities: {}, items: [item('article', 1)] },
      { authorities: [authority('article')], items: [] },
      { authorities: [authority('article')], items: [{ ...item('article', 1), extra: SENTINEL }] },
    ]) expectCode(() => assertElearningCoursePublishReadiness(input), 'invalid_input')

    expectCode(() => assertElearningCoursePublishReadiness({
      authorities: new Array(1),
      items: [item('article', 1)],
    }), 'invalid_input')
    const decorated = [authority('article')] as ReturnType<typeof authority>[] & {
      secret?: string
    }
    decorated.secret = SENTINEL
    expectCode(() => assertElearningCoursePublishReadiness({
      authorities: decorated,
      items: [item('article', 1)],
    }), 'invalid_input')

    const hostile = Object.defineProperty(authority('article'), 'referenceState', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => assertElearningCoursePublishReadiness({
      authorities: [hostile],
      items: [item('article', 1)],
    }), 'invalid_input')
  })

  it('does not retain mutable caller arrays or authority rows', () => {
    const authorityRow = authority('article')
    const authorities = [authorityRow]
    const items = [item('article', 1)]
    const result = assertElearningCoursePublishReadiness({ authorities, items })
    authorityRow.referenceState = SENTINEL
    authorities.push(authority('document'))
    items[0].position = 2
    expect(result.authorities).toEqual([authority('article')])
    expect(result.items).toEqual([item('article', 1)])
  })
})

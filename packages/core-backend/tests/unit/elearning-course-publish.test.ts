import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ELEARNING_MEDIA_MIME } from '../../src/services/elearning-media-validation'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
} from '../../src/services/elearning-watch-progress'
import {
  ELEARNING_COURSE_PUBLISH_ACTOR_MAX,
  ELEARNING_COURSE_PUBLISH_EXPLANATION_MAX,
  ELEARNING_COURSE_PUBLISH_OPTION_ID_MAX,
  ELEARNING_COURSE_PUBLISH_OPTION_MAX,
  ELEARNING_COURSE_PUBLISH_OPTION_TEXT_MAX,
  ELEARNING_COURSE_PUBLISH_PROMPT_MAX,
  ELEARNING_COURSE_PUBLISH_QUESTION_MAX,
  ELEARNING_COURSE_PUBLISH_TITLE_MAX,
  canonicalizeElearningCoursePublishInput,
  elearningCoursePublishLockKey,
  ElearningCoursePublishError,
  publishElearningCourse,
  type ElearningCoursePublishDb,
  type ElearningCoursePublishQueryable,
  type PublishElearningCourseInput,
} from '../../src/services/elearning-course-publish'

const ORG = 'org-publish-1'
const ORG_B = 'org-publish-2'
const ACTOR = 'actor-publish-1'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const MEDIA = '22222222-2222-4222-8222-222222222222'
const TITLE = 'Pilot composite course'

const PUBLIC_KEYS = [
  'courseId',
  'courseVersionId',
  'videoItemId',
  'examItemId',
  'examId',
  'status',
  'questionCount',
  'totalScore',
] as const

const EXPECTED_TAG_ORDER = [
  'elearning-publish:lock',
  'elearning-publish:existing-course',
  'elearning-publish:load-media',
  'elearning-publish:insert-course',
  'elearning-publish:insert-version',
  'elearning-publish:insert-exam',
  'elearning-publish:insert-question',
  'elearning-publish:insert-revision',
  'elearning-publish:insert-exam-question',
  'elearning-publish:insert-video-item',
  'elearning-publish:insert-exam-item',
  'elearning-publish:publish-exam',
  'elearning-publish:publish-version',
  'elearning-publish:set-pointers',
] as const

const SERVICE_SOURCE = path.join(
  __dirname,
  '../../src/services/elearning-course-publish.ts',
)

function sampleQuestion(over: Record<string, unknown> = {}) {
  return {
    questionType: 'single_choice',
    prompt: 'Pick one',
    options: [
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ],
    correctOptionIds: ['a'],
    points: 10,
    explanation: 'secret rationale',
    ...over,
  }
}

function baseInput(over: Record<string, unknown> = {}): PublishElearningCourseInput {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: REQUEST,
    title: TITLE,
    mediaId: MEDIA,
    passScore: 10,
    maxAttempts: 3,
    questions: [sampleQuestion()],
    ...over,
  } as PublishElearningCourseInput
}

function tagOf(sql: string): string | null {
  const match = /\/\* (elearning-publish:[a-z-]+) \*\//.exec(sql)
  return match ? match[1] : null
}

interface Mem {
  existing: boolean
  media: boolean
  queries: string[]
  params: unknown[][]
  lockKeys: string[]
}

function createMemoryDb(seed: Partial<Mem> = {}): { db: ElearningCoursePublishDb; mem: Mem } {
  const mem: Mem = {
    existing: false,
    media: true,
    queries: [],
    params: [],
    lockKeys: [],
    ...seed,
  }
  const query: ElearningCoursePublishQueryable['query'] = async (sql, params = []) => {
    mem.queries.push(sql)
    mem.params.push(params)
    const tag = tagOf(sql)
    if (tag === 'elearning-publish:lock') {
      expect(sql).toContain('pg_advisory_xact_lock')
      mem.lockKeys.push(String(params[0]))
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-publish:existing-course') {
      return mem.existing ? { rows: [{ ok: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-publish:load-media') {
      expect(sql).toContain("status = 'ready'")
      expect(sql).toContain('mime_type = $3')
      expect(sql).toContain('magic_mime_type = $3')
      expect(sql).toContain('duration_ms > 0')
      expect(sql).toContain('FOR SHARE')
      expect(params[2]).toBe(ELEARNING_MEDIA_MIME)
      return mem.media ? { rows: [{ id: MEDIA }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-publish:insert-course') {
      expect(sql).toContain('status')
      expect(sql).toContain("'active'")
      expect(sql).not.toContain('active_version_id')
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-publish:insert-version') {
      expect(sql).toMatch(/1, 'draft'/)
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-publish:insert-exam') {
      expect(sql).toMatch(/'draft'/)
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-publish:insert-question') return { rows: [], rowCount: 1 }
    if (tag === 'elearning-publish:insert-revision') return { rows: [], rowCount: 1 }
    if (tag === 'elearning-publish:insert-exam-question') return { rows: [], rowCount: 1 }
    if (tag === 'elearning-publish:insert-video-item') {
      expect(sql).toContain("'video'")
      expect(params[4]).toBe(ELEARNING_WATCH_POLICY_VERSION)
      expect(params[5]).toBe(ELEARNING_WATCH_THRESHOLD_BPS)
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-publish:insert-exam-item') {
      expect(sql).toContain("'exam'")
      expect(sql).toMatch(/NULL, NULL\)/)
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-publish:publish-exam') {
      expect(sql).toContain("status = 'published'")
      expect(sql).toContain("status = 'draft'")
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-publish:publish-version') {
      expect(sql).toContain("status = 'published'")
      expect(sql).toContain("status = 'draft'")
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-publish:set-pointers') {
      expect(sql).toContain('active_version_id')
      expect(sql).toContain('latest_version_id')
      expect(sql).toContain('IS NULL')
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected publish query: ${tag ?? sql}`)
  }
  return {
    mem,
    db: {
      transaction: async (handler) => handler({ query }),
    },
  }
}

function assertValuesFree(error: unknown): void {
  expect(error).toBeInstanceOf(ElearningCoursePublishError)
  const err = error as ElearningCoursePublishError
  const blob = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`
  expect(blob).not.toContain(ORG)
  expect(blob).not.toContain(ORG_B)
  expect(blob).not.toContain(ACTOR)
  expect(blob).not.toContain(REQUEST)
  expect(blob).not.toContain(MEDIA)
  expect(blob).not.toContain(TITLE)
  expect(blob).not.toContain('secret rationale')
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('storage_key')
  expect(err.message).toBe(err.code)
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect((error as ElearningCoursePublishError).code).toBe(code)
    assertValuesFree(error)
  }
}

async function expectAsyncCode(
  db: ElearningCoursePublishDb,
  input: Record<string, unknown>,
  code: string,
): Promise<void> {
  try {
    await publishElearningCourse(db, input as PublishElearningCourseInput)
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect((error as ElearningCoursePublishError).code).toBe(code)
    assertValuesFree(error)
  }
}

function assertPublicShape(payload: unknown): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  expect(Object.keys(raw)).toEqual([...PUBLIC_KEYS])
  expect(raw.status).toBe('published')
  const blob = JSON.stringify(raw)
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('answerKey')
  expect(blob).not.toContain('correctOptionIds')
  expect(blob).not.toContain('explanation')
  expect(blob).not.toContain('secret rationale')
  expect(blob).not.toContain('prompt')
  expect(blob).not.toContain('options')
  expect(blob).not.toContain('storage_key')
  expect(blob).not.toContain('sha256')
  expect(blob).not.toContain('mime_type')
  expect(blob).not.toContain(ORG)
  expect(blob).not.toContain(ACTOR)
  expect(blob).not.toContain(TITLE)
  expect(blob).not.toContain('Pick one')
  expect(blob).not.toMatch(/"correct"/)
  return raw
}

describe('elearning course publish source SQL order', () => {
  it('pins lock → media → draft inserts → exam publish → version publish → pointers, and the ready-mp4 media check', async () => {
    const source = await fs.readFile(SERVICE_SOURCE, 'utf8')
    const tags = [...source.matchAll(/elearning-publish:[a-z-]+/g)].map((match) => match[0])
    const unique: string[] = []
    for (const tag of tags) {
      if (unique[unique.length - 1] !== tag) unique.push(tag)
    }
    expect(unique).toEqual([...EXPECTED_TAG_ORDER])

    const lockAt = source.indexOf('elearning-publish:lock')
    const mediaAt = source.indexOf('elearning-publish:load-media')
    const examAt = source.indexOf('elearning-publish:publish-exam')
    const versionAt = source.indexOf('elearning-publish:publish-version')
    const pointersAt = source.indexOf('elearning-publish:set-pointers')
    expect(lockAt).toBeGreaterThan(-1)
    expect(mediaAt).toBeGreaterThan(lockAt)
    expect(examAt).toBeGreaterThan(mediaAt)
    expect(versionAt).toBeGreaterThan(examAt)
    expect(pointersAt).toBeGreaterThan(versionAt)

    const mediaSqlStart = source.indexOf('elearning-publish:load-media')
    const mediaSqlEnd = source.indexOf('elearning-publish:insert-course')
    const mediaSql = source.slice(mediaSqlStart, mediaSqlEnd)
    expect(mediaSql).toContain("status = 'ready'")
    expect(mediaSql).toContain('mime_type = $3')
    expect(mediaSql).toContain('magic_mime_type = $3')
    expect(mediaSql).toContain('duration_ms IS NOT NULL')
    expect(mediaSql).toContain('duration_ms > 0')
    expect(mediaSql).toContain('org_id = $1')
    expect(mediaSql).toContain('FOR SHARE')
    expect(source).toContain('ELEARNING_WATCH_POLICY_VERSION')
    expect(source).toContain('ELEARNING_WATCH_THRESHOLD_BPS')
  })
})

describe('elearning course publish input closure', () => {
  it('names the advisory lock from org and request id', () => {
    expect(elearningCoursePublishLockKey(ORG, REQUEST)).toBe(`elearning-publish:${ORG}:${REQUEST}`)
    expect(elearningCoursePublishLockKey(ORG, REQUEST)).not.toBe(
      `elearning-publish:${ORG_B}:${REQUEST}`,
    )
  })

  it('canonicalizes exact shape, trims bounded strings, and sorts unique correct ids', () => {
    const canonical = canonicalizeElearningCoursePublishInput(baseInput({
      orgId: ` ${ORG} `,
      actorId: ` ${ACTOR} `,
      requestId: REQUEST.toUpperCase(),
      mediaId: MEDIA.toUpperCase(),
      title: ` ${TITLE} `,
      questions: [sampleQuestion({
        questionType: 'multiple_choice',
        options: [
          { id: ' a ', text: ' alpha ' },
          { id: 'b', text: 'beta' },
          { id: 'c', text: 'gamma' },
        ],
        correctOptionIds: [' c ', 'a'],
        points: 4,
      })],
      passScore: 4,
    }))
    expect(canonical).toEqual(expect.objectContaining({
      orgId: ORG,
      actorId: ACTOR,
      requestId: REQUEST,
      mediaId: MEDIA,
      title: TITLE,
      totalScore: 4,
      passScore: 4,
      maxAttempts: 3,
    }))
    expect(canonical.questions[0].correctOptionIds).toEqual(['a', 'c'])
    expect(canonical.questions[0].options[0]).toEqual({ id: 'a', text: 'alpha' })
  })

  it('rejects extra keys, blank/bounded strings, cardinality, and passScore above total without leaking secrets', () => {
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ extra: true })), 'invalid_input')
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ orgId: '' })), 'invalid_input')
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ actorId: '  ' })), 'invalid_input')
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ title: '' })), 'invalid_input')
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ requestId: 'not-a-uuid' })), 'invalid_input')
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ mediaId: REQUEST.slice(0, 8) })), 'invalid_input')
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ maxAttempts: 0 })), 'invalid_input')
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ maxAttempts: 1.5 })), 'invalid_input')
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ passScore: -1 })), 'invalid_input')
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ passScore: 11 })), 'invalid_input')
    expectCode(() => canonicalizeElearningCoursePublishInput(baseInput({ questions: [] })), 'invalid_input')
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: Array.from({ length: ELEARNING_COURSE_PUBLISH_QUESTION_MAX + 1 }, () => sampleQuestion()),
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ options: [] })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({
          options: Array.from({ length: ELEARNING_COURSE_PUBLISH_OPTION_MAX + 1 }, (_, i) => ({
            id: `o${i}`,
            text: `opt ${i}`,
          })),
          correctOptionIds: ['o0'],
        })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({
          options: [
            { id: 'a', text: 'alpha' },
            { id: 'a', text: 'again' },
          ],
        })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ correctOptionIds: ['z'] })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ correctOptionIds: ['a', 'a'] })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ questionType: 'single_choice', correctOptionIds: ['a', 'b'] })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({
          questionType: 'true_false',
          options: [{ id: 't', text: 'true' }, { id: 'f', text: 'false' }],
          correctOptionIds: ['t', 'f'],
        })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ questionType: 'multiple_choice', correctOptionIds: [] })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ points: 0 })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ questionType: 'essay' })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ extra: 1 })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({
          options: [
            { id: 'a', text: 'alpha', extra: true },
            { id: 'b', text: 'beta' },
          ],
        })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        title: 't'.repeat(ELEARNING_COURSE_PUBLISH_TITLE_MAX + 1),
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ prompt: 'p'.repeat(ELEARNING_COURSE_PUBLISH_PROMPT_MAX + 1) })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({
          options: [
            { id: 'i'.repeat(ELEARNING_COURSE_PUBLISH_OPTION_ID_MAX + 1), text: 'alpha' },
            { id: 'b', text: 'beta' },
          ],
          correctOptionIds: ['i'.repeat(ELEARNING_COURSE_PUBLISH_OPTION_ID_MAX + 1)],
        })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({
          options: [
            { id: 'a', text: 'x'.repeat(ELEARNING_COURSE_PUBLISH_OPTION_TEXT_MAX + 1) },
            { id: 'b', text: 'beta' },
          ],
        })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ explanation: 'e'.repeat(ELEARNING_COURSE_PUBLISH_EXPLANATION_MAX + 1) })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        orgId: 'o'.repeat(ELEARNING_COURSE_PUBLISH_ACTOR_MAX + 1),
      })),
      'invalid_input',
    )
  })

  it('rejects maxAttempts and points outside the signed int32 positive range before a transaction', async () => {
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({ maxAttempts: 2147483648 })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({ maxAttempts: Number.MAX_SAFE_INTEGER })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ points: 2147483648 })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({ points: Number.MAX_SAFE_INTEGER })],
      })),
      'invalid_input',
    )

    const canonical = canonicalizeElearningCoursePublishInput(baseInput({
      maxAttempts: 2147483647,
      passScore: 2147483647,
      questions: [sampleQuestion({ points: 2147483647 })],
    }))
    expect(canonical.maxAttempts).toBe(2147483647)
    expect(canonical.questions[0].points).toBe(2147483647)
    expect(canonical.totalScore).toBe(2147483647)
    expect(Number.isSafeInteger(canonical.totalScore)).toBe(true)

    let opened = false
    const db: ElearningCoursePublishDb = {
      transaction: async () => {
        opened = true
        throw new Error('transaction should not open')
      },
    }
    await expectAsyncCode(db, baseInput({ maxAttempts: 2147483648 }), 'invalid_input')
    await expectAsyncCode(db, baseInput({
      questions: [sampleQuestion({ points: 2147483648 })],
    }), 'invalid_input')
    expect(opened).toBe(false)
  })

  it('rejects single_choice/multiple_choice with fewer than two options and true_false unless exactly two', async () => {
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({
          questionType: 'single_choice',
          options: [{ id: 'a', text: 'alpha' }],
          correctOptionIds: ['a'],
        })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({
          questionType: 'multiple_choice',
          options: [{ id: 'a', text: 'alpha' }],
          correctOptionIds: ['a'],
        })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({
          questionType: 'true_false',
          options: [{ id: 't', text: 'true' }],
          correctOptionIds: ['t'],
        })],
      })),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningCoursePublishInput(baseInput({
        questions: [sampleQuestion({
          questionType: 'true_false',
          options: [
            { id: 't', text: 'true' },
            { id: 'f', text: 'false' },
            { id: 'm', text: 'maybe' },
          ],
          correctOptionIds: ['t'],
        })],
      })),
      'invalid_input',
    )

    const allowed = canonicalizeElearningCoursePublishInput(baseInput({
      questions: [sampleQuestion({
        questionType: 'true_false',
        options: [
          { id: 't', text: 'true' },
          { id: 'f', text: 'false' },
        ],
        correctOptionIds: ['t'],
      })],
    }))
    expect(allowed.questions[0].options).toHaveLength(2)
    expect(allowed.questions[0].correctOptionIds).toEqual(['t'])

    let opened = false
    const db: ElearningCoursePublishDb = {
      transaction: async () => {
        opened = true
        throw new Error('transaction should not open')
      },
    }
    await expectAsyncCode(db, baseInput({
      questions: [sampleQuestion({
        questionType: 'true_false',
        options: [{ id: 't', text: 'true' }],
        correctOptionIds: ['t'],
      })],
    }), 'invalid_input')
    expect(opened).toBe(false)
  })

  it('does not open a transaction for invalid input', async () => {
    let opened = false
    const db: ElearningCoursePublishDb = {
      transaction: async () => {
        opened = true
        throw new Error('transaction should not open')
      },
    }
    await expectAsyncCode(db, baseInput({ passScore: 99 }), 'invalid_input')
    expect(opened).toBe(false)
  })
})

describe('publishElearningCourse', () => {
  it('executes trigger-required SQL order and returns the public published shape', async () => {
    const { db, mem } = createMemoryDb()
    const result = await publishElearningCourse(db, baseInput())
    const raw = assertPublicShape(result)
    expect(raw.courseId).toBe(REQUEST)
    expect(raw.status).toBe('published')
    expect(raw.questionCount).toBe(1)
    expect(raw.totalScore).toBe(10)
    expect(mem.lockKeys).toEqual([elearningCoursePublishLockKey(ORG, REQUEST)])
    expect(mem.queries.map((sql) => tagOf(sql))).toEqual([...EXPECTED_TAG_ORDER])
    expect(mem.params[0][0]).toBe(elearningCoursePublishLockKey(ORG, REQUEST))
    expect(mem.params[3][0]).toBe(REQUEST)
    expect(mem.params[3][3]).toBe(ACTOR)
    const revisionParams = mem.params[mem.queries.findIndex((sql) => tagOf(sql) === 'elearning-publish:insert-revision')]
    expect(JSON.parse(String(revisionParams[5]))).toEqual([
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ])
    expect(JSON.parse(String(revisionParams[6]))).toEqual({ correct: ['a'] })
    expect(revisionParams[7]).toBe('secret rationale')
  })

  it('repeats question SQL per item then still publishes exam before version', async () => {
    const { db, mem } = createMemoryDb()
    await publishElearningCourse(db, baseInput({
      passScore: 20,
      questions: [
        sampleQuestion(),
        sampleQuestion({
          questionType: 'true_false',
          prompt: 'Is this true',
          options: [{ id: 't', text: 'true' }, { id: 'f', text: 'false' }],
          correctOptionIds: ['t'],
          explanation: null,
        }),
      ],
    }))
    expect(mem.queries.map((sql) => tagOf(sql))).toEqual([
      'elearning-publish:lock',
      'elearning-publish:existing-course',
      'elearning-publish:load-media',
      'elearning-publish:insert-course',
      'elearning-publish:insert-version',
      'elearning-publish:insert-exam',
      'elearning-publish:insert-question',
      'elearning-publish:insert-revision',
      'elearning-publish:insert-exam-question',
      'elearning-publish:insert-question',
      'elearning-publish:insert-revision',
      'elearning-publish:insert-exam-question',
      'elearning-publish:insert-video-item',
      'elearning-publish:insert-exam-item',
      'elearning-publish:publish-exam',
      'elearning-publish:publish-version',
      'elearning-publish:set-pointers',
    ])
  })

  it('fails closed on missing, not-ready, or cross-org media without leaking values', async () => {
    await expectAsyncCode(createMemoryDb({ media: false }).db, baseInput(), 'media_unavailable')
  })

  it('conflicts when the request id already exists as a course', async () => {
    await expectAsyncCode(createMemoryDb({ existing: true }).db, baseInput(), 'conflict')
  })

  it('maps unique violations to values-free conflict and other faults to unavailable', async () => {
    const uniqueDb: ElearningCoursePublishDb = {
      transaction: async (handler) => handler({
        query: async (sql) => {
          if (tagOf(sql) === 'elearning-publish:insert-course') {
            const error = new Error('duplicate') as Error & { code: string }
            error.code = '23505'
            throw error
          }
          return { rows: tagOf(sql) === 'elearning-publish:load-media' ? [{ id: MEDIA }] : [], rowCount: 1 }
        },
      }),
    }
    await expectAsyncCode(uniqueDb, baseInput(), 'conflict')

    const unavailableDb: ElearningCoursePublishDb = {
      transaction: async (handler) => handler({
        query: async () => {
          throw new Error('connection reset')
        },
      }),
    }
    await expectAsyncCode(unavailableDb, baseInput(), 'unavailable')
  })
})

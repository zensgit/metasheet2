import { describe, expect, it } from 'vitest'

import {
  ELEARNING_ARTICLE_HTML_MAX,
  ELEARNING_CONTENT_REVISION_TITLE_MAX,
  ELEARNING_EXTERNAL_URL_MAX,
  ElearningContentRevisionPolicyError,
  createElearningContentRevision,
} from '../../src/services/elearning-content-revision-policy'

const SENTINEL = 'secret-content-revision-value'
const REVISION_ID = '10000000-0000-4000-8000-000000000001'
const SHA256_RE = /^[0-9a-f]{64}$/

function article(overrides: Record<string, unknown> = {}) {
  return {
    articleHtml: '<p>Hello <strong>learner</strong></p>',
    contentRevisionId: REVISION_ID,
    externalUrl: null,
    itemType: 'article',
    title: 'Article title',
    ...overrides,
  }
}

function external(overrides: Record<string, unknown> = {}) {
  return {
    articleHtml: null,
    contentRevisionId: REVISION_ID,
    externalUrl: 'https://example.com/lesson',
    itemType: 'external_link',
    title: 'External lesson',
    ...overrides,
  }
}

function expectInvalid(action: () => unknown): void {
  try {
    action()
    throw new Error('expected content revision policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningContentRevisionPolicyError)
    const policyError = error as ElearningContentRevisionPolicyError
    expect(policyError.code).toBe('invalid_input')
    expect(policyError.message).toBe('invalid_input')
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning content revision policy', () => {
  it('stores only allow-list-clean article HTML and an immutable digest', () => {
    const result = createElearningContentRevision(article({
      articleHtml: [
        '<script>secret()</script>',
        '<p onclick="secret()">Hello <strong>learner</strong></p>',
        '<a href="https://example.com/next">next</a>',
        '<a href="javascript:secret()">blocked</a>',
        '<a href="https://user:pass@example.com/secret">credentialed</a>',
        '<img src="x" onerror="secret()">',
      ].join(''),
      contentRevisionId: REVISION_ID.toUpperCase(),
      title: '  Article title  ',
    }))
    expect(result).toEqual({
      articleHtml: [
        '<p>Hello <strong>learner</strong></p>',
        '<a href="https://example.com/next" rel="noopener noreferrer" target="_blank">next</a>',
        'blocked',
        'credentialed',
      ].join(''),
      contentDigest: expect.stringMatching(SHA256_RE),
      contentRevisionId: REVISION_ID,
      externalUrl: null,
      itemType: 'article',
      title: 'Article title',
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('normalizes an HTTPS external navigation target without granting egress', () => {
    expect(createElearningContentRevision(external({
      externalUrl: '  https://EXAMPLE.com:443/lesson?q=1#part  ',
    }))).toEqual({
      articleHtml: null,
      contentDigest: expect.stringMatching(SHA256_RE),
      contentRevisionId: REVISION_ID,
      externalUrl: 'https://example.com/lesson?q=1#part',
      itemType: 'external_link',
      title: 'External lesson',
    })
  })

  it('enforces one content body shape for each revision type', () => {
    for (const value of [
      article({ articleHtml: null }),
      article({ externalUrl: 'https://example.com' }),
      external({ externalUrl: null }),
      external({ articleHtml: '<p>alias</p>' }),
      { ...article(), itemType: 'video' },
    ]) expectInvalid(() => createElearningContentRevision(value))
  })

  it('rejects active or empty-after-sanitize article bodies', () => {
    for (const articleHtml of [
      '',
      '   ',
      '<script>only active content</script>',
      '<style>only active content</style>',
      '<p><br></p>',
      `\ud800${SENTINEL}`,
      `x${'a'.repeat(ELEARNING_ARTICLE_HTML_MAX)}`,
    ]) expectInvalid(() => createElearningContentRevision(article({ articleHtml })))
  })

  it('rejects unsafe, credentialed, malformed, and oversized external URLs', () => {
    for (const externalUrl of [
      'http://example.com/lesson',
      'javascript:alert(1)',
      'https://user:pass@example.com/lesson',
      '//example.com/lesson',
      'not-a-url',
      `https://example.com/${'a'.repeat(ELEARNING_EXTERNAL_URL_MAX)}`,
    ]) expectInvalid(() => createElearningContentRevision(external({ externalUrl })))
  })

  it('rejects invalid metadata and open or hostile inputs values-free', () => {
    for (const value of [
      null,
      {},
      article({ contentRevisionId: 'revision-1' }),
      article({ title: '' }),
      article({ title: `x${'a'.repeat(ELEARNING_CONTENT_REVISION_TITLE_MAX)}` }),
      { ...article(), secret: SENTINEL },
    ]) expectInvalid(() => createElearningContentRevision(value))
    const hostile = article()
    Object.defineProperty(hostile, 'articleHtml', {
      enumerable: true,
      get() {
        throw new Error(SENTINEL)
      },
    })
    expectInvalid(() => createElearningContentRevision(hostile))
  })

  it('binds the digest to sanitized content, target, title, type, and revision id', () => {
    const first = createElearningContentRevision(article())
    const same = createElearningContentRevision(article())
    const changedBody = createElearningContentRevision(article({
      articleHtml: '<p>Changed</p>',
    }))
    const changedTitle = createElearningContentRevision(article({ title: 'Changed' }))
    const changedRevision = createElearningContentRevision(article({
      contentRevisionId: '10000000-0000-4000-8000-000000000002',
    }))
    const changedType = createElearningContentRevision(external())
    expect(same.contentDigest).toBe(first.contentDigest)
    expect(changedBody.contentDigest).not.toBe(first.contentDigest)
    expect(changedTitle.contentDigest).not.toBe(first.contentDigest)
    expect(changedRevision.contentDigest).not.toBe(first.contentDigest)
    expect(changedType.contentDigest).not.toBe(first.contentDigest)
  })

  it('does not retain mutable caller data', () => {
    const source = article()
    const result = createElearningContentRevision(source)
    source.articleHtml = '<p>Changed</p>'
    source.title = 'Changed'
    expect(result).toMatchObject({
      articleHtml: '<p>Hello <strong>learner</strong></p>',
      title: 'Article title',
    })
  })
})

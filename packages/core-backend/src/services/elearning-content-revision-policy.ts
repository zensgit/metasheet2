import { createHash } from 'node:crypto'
import sanitizeHtml from 'sanitize-html'

/**
 * Pure L1 authority for immutable article and external-link revisions.
 *
 * Article HTML uses the repository's established sanitize-html dependency with
 * a domain-local allow-list narrower than multitable rich text. External links
 * are navigation targets only; this policy never fetches them and therefore
 * does not treat URL validation as an egress grant.
 */

export const ELEARNING_CONTENT_REVISION_DIGEST_DOMAIN =
  'elearning.content.revision.v1' as const
export const ELEARNING_CONTENT_REVISION_TITLE_MAX = 200 as const
export const ELEARNING_ARTICLE_HTML_MAX = 1_000_000 as const
export const ELEARNING_EXTERNAL_URL_MAX = 2_048 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INPUT_KEYS = [
  'articleHtml',
  'contentRevisionId',
  'externalUrl',
  'itemType',
  'title',
] as const

function normalizeArticleHref(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    parsed.protocol === 'https:'
    && parsed.username === ''
    && parsed.password === ''
  ) return parsed.toString()
  if (parsed.protocol === 'mailto:') return parsed.toString()
  return null
}

const ARTICLE_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'b', 'strong', 'i', 'em', 'u', 's',
    'a',
    'ul', 'ol', 'li',
    'h1', 'h2', 'h3',
    'p', 'br', 'blockquote', 'code', 'pre',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target'],
  },
  allowedSchemes: ['https', 'mailto'],
  allowedSchemesByTag: { a: ['https', 'mailto'] },
  allowProtocolRelative: false,
  nonTextTags: [
    'script', 'style', 'iframe', 'object', 'embed', 'form', 'svg',
    'noscript', 'textarea', 'title',
  ],
  transformTags: {
    a: (tagName, attributes): sanitizeHtml.Tag => {
      const href = typeof attributes.href === 'string'
        ? normalizeArticleHref(attributes.href)
        : null
      if (href === null) return { tagName: 'span', attribs: {} }
      return {
        tagName,
        attribs: {
          href,
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      }
    },
  },
  allowedStyles: {},
  disallowedTagsMode: 'discard',
}

export type ElearningContentRevisionItemType = 'article' | 'external_link'

export class ElearningContentRevisionPolicyError extends Error {
  constructor(readonly code: 'invalid_input') {
    super(code)
    this.name = 'ElearningContentRevisionPolicyError'
  }
}

export interface ElearningContentRevision {
  readonly articleHtml: string | null
  readonly contentDigest: string
  readonly contentRevisionId: string
  readonly externalUrl: string | null
  readonly itemType: ElearningContentRevisionItemType
  readonly title: string
}

function fail(): never {
  throw new ElearningContentRevisionPolicyError('invalid_input')
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
    if (error instanceof ElearningContentRevisionPolicyError) throw error
    fail()
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) return false
  }
  return true
}

function requireText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') fail()
  const text = value.trim()
  if (
    text === ''
    || text.length > maxLength
    || text.includes('\0')
    || !isWellFormedUnicode(text)
  ) fail()
  return text
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail()
  return value.toLowerCase()
}

function sanitizeArticle(value: unknown): string {
  const source = requireText(value, ELEARNING_ARTICLE_HTML_MAX)
  const sanitized = sanitizeHtml(source, ARTICLE_SANITIZE_OPTIONS).trim()
  if (
    sanitized === ''
    || sanitized.length > ELEARNING_ARTICLE_HTML_MAX
    || sanitizeHtml(sanitized, { allowedTags: [], allowedAttributes: {} })
      .replace(/\u00a0/g, ' ')
      .trim() === ''
  ) fail()
  return sanitized
}

function normalizeExternalUrl(value: unknown): string {
  const source = requireText(value, ELEARNING_EXTERNAL_URL_MAX)
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    fail()
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
  ) fail()
  const normalized = parsed.toString()
  if (normalized.length > ELEARNING_EXTERNAL_URL_MAX) fail()
  return normalized
}

function contentDigest(input: Omit<ElearningContentRevision, 'contentDigest'>): string {
  return createHash('sha256').update(JSON.stringify({
    articleHtml: input.articleHtml,
    contentRevisionId: input.contentRevisionId,
    domain: ELEARNING_CONTENT_REVISION_DIGEST_DOMAIN,
    externalUrl: input.externalUrl,
    itemType: input.itemType,
    title: input.title,
  }), 'utf8').digest('hex')
}

export function createElearningContentRevision(
  input: unknown,
): ElearningContentRevision {
  const values = readExactObject(input)
  const rawItemType = values.itemType
  if (rawItemType !== 'article' && rawItemType !== 'external_link') fail()
  const itemType: ElearningContentRevisionItemType = rawItemType
  const contentRevisionId = requireUuid(values.contentRevisionId)
  const title = requireText(values.title, ELEARNING_CONTENT_REVISION_TITLE_MAX)
  let articleHtml: string | null = null
  let externalUrl: string | null = null
  if (itemType === 'article') {
    if (values.externalUrl !== null) fail()
    articleHtml = sanitizeArticle(values.articleHtml)
  } else {
    if (values.articleHtml !== null) fail()
    externalUrl = normalizeExternalUrl(values.externalUrl)
  }
  const revision = {
    articleHtml,
    contentRevisionId,
    externalUrl,
    itemType,
    title,
  }
  return Object.freeze({
    ...revision,
    contentDigest: contentDigest(revision),
  })
}

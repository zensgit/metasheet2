import { ELEARNING_DOCUMENT_MAX_PAGES } from './elearning-document-completion-policy'

/**
 * Format-neutral authority for a document that is ready for page-based study.
 *
 * The persistence/probe adapter may support PDF, office conversion, text, or
 * another format. This contract only accepts the server-owned facts required
 * by the completion engine: document kind, ready state, and a probed page
 * count. Client metadata is never an authority.
 */

export const ELEARNING_DOCUMENT_MEDIA_KIND = 'document' as const
export const ELEARNING_DOCUMENT_MEDIA_STATUS = 'ready' as const
export const ELEARNING_DOCUMENT_PAGE_COUNT_AUTHORITY = 'server_probe' as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AUTHORITY_KEYS = [
  'documentMediaId',
  'documentMediaKind',
  'documentMediaStatus',
  'documentPageCountAuthority',
  'serverPageCount',
] as const

export class ElearningDocumentMediaAuthorityError extends Error {
  constructor(readonly code: 'invalid_input') {
    super(code)
    this.name = 'ElearningDocumentMediaAuthorityError'
  }
}

export interface ElearningDocumentMediaAuthority {
  readonly documentMediaId: string
  readonly documentMediaKind: typeof ELEARNING_DOCUMENT_MEDIA_KIND
  readonly documentMediaStatus: typeof ELEARNING_DOCUMENT_MEDIA_STATUS
  readonly documentPageCountAuthority: typeof ELEARNING_DOCUMENT_PAGE_COUNT_AUTHORITY
  readonly serverPageCount: number
}

function fail(): never {
  throw new ElearningDocumentMediaAuthorityError('invalid_input')
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
      sorted.length !== AUTHORITY_KEYS.length
      || sorted.some((key, index) => key !== AUTHORITY_KEYS[index])
    ) fail()
    return Object.fromEntries(
      AUTHORITY_KEYS.map((key) => [key, (input as Record<string, unknown>)[key]]),
    )
  } catch (error) {
    if (error instanceof ElearningDocumentMediaAuthorityError) throw error
    fail()
  }
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail()
  return value.toLowerCase()
}

function requirePageCount(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > ELEARNING_DOCUMENT_MAX_PAGES
  ) fail()
  return value
}

export function normalizeElearningDocumentMediaAuthority(
  input: unknown,
): ElearningDocumentMediaAuthority {
  const values = readExactObject(input)
  if (values.documentMediaKind !== ELEARNING_DOCUMENT_MEDIA_KIND) fail()
  if (values.documentMediaStatus !== ELEARNING_DOCUMENT_MEDIA_STATUS) fail()
  if (
    values.documentPageCountAuthority
    !== ELEARNING_DOCUMENT_PAGE_COUNT_AUTHORITY
  ) fail()
  return Object.freeze({
    documentMediaId: requireUuid(values.documentMediaId),
    documentMediaKind: ELEARNING_DOCUMENT_MEDIA_KIND,
    documentMediaStatus: ELEARNING_DOCUMENT_MEDIA_STATUS,
    documentPageCountAuthority: ELEARNING_DOCUMENT_PAGE_COUNT_AUTHORITY,
    serverPageCount: requirePageCount(values.serverPageCount),
  })
}

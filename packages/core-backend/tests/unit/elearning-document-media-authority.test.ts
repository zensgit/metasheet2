import { describe, expect, it } from 'vitest'

import { ELEARNING_DOCUMENT_MAX_PAGES } from '../../src/services/elearning-document-completion-policy'
import {
  ELEARNING_DOCUMENT_MEDIA_KIND,
  ELEARNING_DOCUMENT_MEDIA_STATUS,
  ELEARNING_DOCUMENT_PAGE_COUNT_AUTHORITY,
  ElearningDocumentMediaAuthorityError,
  normalizeElearningDocumentMediaAuthority,
} from '../../src/services/elearning-document-media-authority'

const SENTINEL = 'secret-document-authority-value'
const MEDIA_ID = '10000000-0000-4000-8000-000000000001'

function authority(overrides: Record<string, unknown> = {}) {
  return {
    documentMediaId: MEDIA_ID,
    documentMediaKind: ELEARNING_DOCUMENT_MEDIA_KIND,
    documentMediaStatus: ELEARNING_DOCUMENT_MEDIA_STATUS,
    documentPageCountAuthority: ELEARNING_DOCUMENT_PAGE_COUNT_AUTHORITY,
    serverPageCount: 12,
    ...overrides,
  }
}

function expectInvalid(action: () => unknown): void {
  try {
    action()
    throw new Error('expected document media authority error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningDocumentMediaAuthorityError)
    const authorityError = error as ElearningDocumentMediaAuthorityError
    expect(authorityError.code).toBe('invalid_input')
    expect(authorityError.message).toBe('invalid_input')
    expect(authorityError.cause).toBeUndefined()
    expect(`${authorityError.message}\n${authorityError.stack ?? ''}`).not.toContain(
      SENTINEL,
    )
  }
}

describe('elearning document media authority', () => {
  it('accepts only a ready document with a server-probed page count', () => {
    const result = normalizeElearningDocumentMediaAuthority(authority({
      documentMediaId: MEDIA_ID.toUpperCase(),
      serverPageCount: ELEARNING_DOCUMENT_MAX_PAGES,
    }))
    expect(result).toEqual({
      documentMediaId: MEDIA_ID,
      documentMediaKind: 'document',
      documentMediaStatus: 'ready',
      documentPageCountAuthority: 'server_probe',
      serverPageCount: ELEARNING_DOCUMENT_MAX_PAGES,
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('rejects a video, non-ready media, or client-declared page count authority', () => {
    for (const value of [
      authority({ documentMediaKind: 'video' }),
      authority({ documentMediaStatus: 'probing' }),
      authority({ documentMediaStatus: 'rejected' }),
      authority({ documentPageCountAuthority: 'client' }),
      authority({ documentPageCountAuthority: 'upload_metadata' }),
    ]) expectInvalid(() => normalizeElearningDocumentMediaAuthority(value))
  })

  it('rejects invalid page counts and media identities', () => {
    for (const value of [
      authority({ documentMediaId: 'media-1' }),
      authority({ serverPageCount: 0 }),
      authority({ serverPageCount: 1.5 }),
      authority({ serverPageCount: ELEARNING_DOCUMENT_MAX_PAGES + 1 }),
      authority({ serverPageCount: '12' }),
    ]) expectInvalid(() => normalizeElearningDocumentMediaAuthority(value))
  })

  it('rejects open or hostile authority objects values-free', () => {
    for (const value of [
      null,
      {},
      authority({ secret: SENTINEL }),
    ]) expectInvalid(() => normalizeElearningDocumentMediaAuthority(value))
    const hostile = authority()
    Object.defineProperty(hostile, 'serverPageCount', {
      enumerable: true,
      get() {
        throw new Error(SENTINEL)
      },
    })
    expectInvalid(() => normalizeElearningDocumentMediaAuthority(hostile))
  })
})

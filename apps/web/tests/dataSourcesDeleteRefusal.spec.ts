import { afterEach, describe, expect, it, vi } from 'vitest'

// 被引用 N 列 (2026-09-10): the seam between the server's coded 409 and the operator-facing copy.
//
// The panel specs inject an already-shaped error, so they pin the COPY but not the EXTRACTION.
// This file mocks one layer lower — the shared `apiFetch` — so the real `deleteDataSource` runs
// against a real refusal envelope. Without it, a client that silently stopped carrying
// `error.code` / `error.details.referenceCount` off the wire would leave every other test green
// while the operator got English prose about an internal table back on screen.
const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({
  apiFetch: apiFetchMock,
  apiGet: vi.fn(),
}))

import { deleteDataSource } from '../src/data-sources/api'
import { describeDeleteFailure, DATA_SOURCE_REFERENCED_CODE } from '../src/data-sources/deleteRefusalCopy'

/** The exact refusal body the referential delete guard answers with. */
function referentialRefusal(referenceCount: number): Response {
  return {
    ok: false,
    status: 409,
    statusText: 'Conflict',
    json: async () => ({
      ok: false,
      error: {
        code: 'DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS',
        message:
          `Data source 'a' is referenced by ${referenceCount} external system(s) ` +
          '(integration_external_systems.config.dataSourceId) and deleting it would leave dangling ' +
          'references. A platform admin may repeat the request with force=true to break the ' +
          'reference deliberately.',
        details: { referenceCount },
      },
    }),
  } as unknown as Response
}

describe('deleteDataSource carries the coded 409 off the wire', () => {
  afterEach(() => {
    apiFetchMock.mockReset()
  })

  it('attaches the server code and details.referenceCount to the thrown error', async () => {
    apiFetchMock.mockResolvedValue(referentialRefusal(3))
    const error = await deleteDataSource('a').then(
      () => null,
      (e: unknown) => e as Error & { code?: string; referenceCount?: number },
    )
    expect(error).toBeInstanceOf(Error)
    expect(error?.code).toBe(DATA_SOURCE_REFERENCED_CODE)
    expect(error?.referenceCount).toBe(3)
  })

  it('END TO END: the wire refusal becomes the operator copy, count intact', async () => {
    apiFetchMock.mockResolvedValue(referentialRefusal(2))
    const error = await deleteDataSource('a').then(() => null, (e: unknown) => e)
    const shown = describeDeleteFailure(error)
    expect(shown).toContain('2 个绑定')
    expect(shown).toContain('409')
    expect(shown).toContain('已配置连接')
    // What must NOT survive the translation: the internal table, the English prose, and the
    // platform-admin-only escape hatch this UI does not expose.
    expect(shown).not.toContain('integration_external_systems')
    expect(shown).not.toContain('external system')
    expect(shown).not.toContain('force')
  })

  it('a 409 without details still translates, just without a number', async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({
        ok: false,
        error: { code: 'DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS', message: 'referenced' },
      }),
    } as unknown as Response)
    const error = await deleteDataSource('a').then(() => null, (e: unknown) => e)
    expect((error as { referenceCount?: number }).referenceCount).toBeUndefined()
    const shown = describeDeleteFailure(error)
    expect(shown).toContain('409')
    expect(shown).toContain('已配置连接')
    expect(shown).not.toMatch(/\d+ 个绑定/)
  })

  it('any OTHER failure keeps the server message verbatim (unchanged behavior)', async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
    } as unknown as Response)
    const error = await deleteDataSource('a').then(() => null, (e: unknown) => e)
    expect(describeDeleteFailure(error)).toBe('boom')
  })

  it('an unparseable body still fails with a status-bearing message, not a swallowed success', async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Response)
    await expect(deleteDataSource('a')).rejects.toThrow(/502 Bad Gateway/)
  })

  it('a successful delete throws nothing', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' } as unknown as Response)
    await expect(deleteDataSource('a')).resolves.toBeUndefined()
  })
})

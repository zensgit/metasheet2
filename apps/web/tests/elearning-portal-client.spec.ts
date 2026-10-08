import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  createElearningPortalRequestIdTracker,
  getElearningPortalSettings,
  publishElearningPortalSettings,
} from '../src/services/elearningPortal'

const REQUEST_1 = '11111111-1111-4111-8111-111111111111'
const REQUEST_2 = '22222222-2222-4222-8222-222222222222'
const REVISION = '33333333-3333-4333-8333-333333333333'
const CREATED = '2026-08-30T01:02:03.456Z'
const SETTINGS = {
  revisionId: REVISION,
  version: 1,
  siteName: 'MetaSheet Academy',
  tagline: 'Learn together',
  bannerUrl: 'https://assets.example.test/banner.png',
  navigation: [
    { label: 'My courses', href: '/elearning' },
    { label: 'My wallet', href: '/elearning/wallet' },
  ],
  createdAt: CREATED,
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastRequest() {
  const [path, init] = apiFetchMock.mock.calls.at(-1) ?? []
  return { path: String(path), init: (init ?? {}) as RequestInit }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('e-learning portal client', () => {
  it('parses populated and empty closed settings', async () => {
    apiFetchMock.mockResolvedValueOnce(response(200, SETTINGS))
    await expect(getElearningPortalSettings()).resolves.toEqual(SETTINGS)
    expect(lastRequest()).toEqual({ path: '/api/elearning/portal', init: {} })

    apiFetchMock.mockResolvedValueOnce(response(200, {
      revisionId: null,
      version: 0,
      siteName: null,
      tagline: null,
      bannerUrl: null,
      navigation: [],
      createdAt: null,
    }))
    await expect(getElearningPortalSettings()).resolves.toMatchObject({
      revisionId: null,
      version: 0,
    })
  })

  it.each([
    { ...SETTINGS, extra: true },
    { ...SETTINGS, revisionId: null },
    { ...SETTINGS, version: 0 },
    { ...SETTINGS, siteName: ' MetaSheet Academy' },
    { ...SETTINGS, createdAt: '2026-02-31T00:00:00.000Z' },
    { ...SETTINGS, createdAt: '2026-08-30T01:02:03Z' },
    { ...SETTINGS, bannerUrl: 'http://assets.example.test/banner.png' },
    { ...SETTINGS, bannerUrl: 'https://user@assets.example.test/banner.png' },
    { ...SETTINGS, navigation: [{ label: 'External', href: 'https://example.test' }] },
    { ...SETTINGS, navigation: [{ label: 'A', href: '/same' }, { label: 'B', href: '/same' }] },
    { ...SETTINGS, navigation: [{ label: 'A', href: '/a', extra: true }] },
  ])('rejects an inconsistent, unsafe or widened response %#', async (body) => {
    apiFetchMock.mockResolvedValueOnce(response(200, body))
    await expect(getElearningPortalSettings()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('sends a normalized closed publish command and parses a closed result', async () => {
    apiFetchMock.mockResolvedValueOnce(response(200, { ...SETTINGS, duplicate: false }))
    await expect(publishElearningPortalSettings({
      requestId: REQUEST_1.toUpperCase(),
      siteName: ' MetaSheet Academy ',
      tagline: ' Learn together ',
      bannerUrl: ' https://assets.example.test/banner.png ',
      navigation: [{ label: ' My courses ', href: ' /elearning ' }],
    })).resolves.toEqual({ ...SETTINGS, duplicate: false })

    const sent = lastRequest()
    expect(sent.path).toBe('/api/elearning/admin/portal')
    expect(sent.init.method).toBe('PUT')
    expect(JSON.parse(String(sent.init.body))).toEqual({
      requestId: REQUEST_1,
      siteName: 'MetaSheet Academy',
      tagline: 'Learn together',
      bannerUrl: 'https://assets.example.test/banner.png',
      navigation: [{ label: 'My courses', href: '/elearning' }],
    })
  })

  it.each([
    { ...SETTINGS, duplicate: false, requestHash: 'secret' },
    { ...SETTINGS, duplicate: 'false' },
    { ...SETTINGS, duplicate: false, createdAt: null },
  ])('rejects malformed publish results %#', async (body) => {
    apiFetchMock.mockResolvedValueOnce(response(200, body))
    await expect(publishElearningPortalSettings({
      requestId: REQUEST_1,
      siteName: SETTINGS.siteName,
      tagline: SETTINGS.tagline,
      bannerUrl: SETTINGS.bannerUrl,
      navigation: SETTINGS.navigation,
    })).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
  })

  it('rejects unsafe client commands before transport', async () => {
    await expect(publishElearningPortalSettings({
      requestId: REQUEST_1,
      siteName: SETTINGS.siteName,
      tagline: null,
      bannerUrl: null,
      navigation: [{ label: 'External', href: 'https://example.test' }],
    })).rejects.toMatchObject({ code: 'invalid_input', status: 400 })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('reuses request identity for logical retries and rotates on content or order change', () => {
    const ids = [REQUEST_1, REQUEST_2, REVISION]
    const tracker = createElearningPortalRequestIdTracker(() => ids.shift() ?? REVISION)
    const draft = {
      siteName: SETTINGS.siteName,
      tagline: SETTINGS.tagline,
      bannerUrl: SETTINGS.bannerUrl,
      navigation: SETTINGS.navigation,
    }
    expect(tracker.forPublish(draft)).toBe(REQUEST_1)
    expect(tracker.forPublish({
      ...draft,
      siteName: ` ${SETTINGS.siteName} `,
    })).toBe(REQUEST_1)
    expect(tracker.forPublish({ ...draft, tagline: 'Changed' })).toBe(REQUEST_2)
    expect(tracker.forPublish({
      ...draft,
      tagline: 'Changed',
      navigation: [...draft.navigation].reverse(),
    })).toBe(REVISION)
  })

  it('maps values-free stable errors and network failures', async () => {
    apiFetchMock.mockResolvedValueOnce(response(409, { error: 'conflict', detail: 'ignored' }))
    await expect(getElearningPortalSettings()).rejects.toMatchObject({ code: 'conflict', status: 409 })
    apiFetchMock.mockRejectedValueOnce(new Error('host detail'))
    await expect(getElearningPortalSettings()).rejects.toMatchObject({ code: 'network_error', status: 0 })
  })
})

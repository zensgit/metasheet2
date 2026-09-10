import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  issueElearningCertificate,
  listElearningCertificateTemplates,
  listMyElearningCertificates,
  publishElearningCertificateTemplate,
} from '../src/services/elearningCertificate'

const REQUEST = '11111111-1111-4111-8111-111111111111'
const REVISION = '22222222-2222-4222-8222-222222222222'
const ISSUE = '33333333-3333-4333-8333-333333333333'
const SERIAL = '44444444-4444-4444-8444-444444444444'
const CREATED = '2026-08-30T04:00:00.000Z'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function template(over: Record<string, unknown> = {}) {
  return {
    certificateId: 'course-completion',
    revisionId: REVISION,
    version: 2,
    name: 'Course completion',
    templateText: '#learnerName# completed #courseName#',
    backgroundImageUrl: 'https://assets.example.test/certificate.png',
    placeholders: ['learnerName', 'courseName'],
    createdAt: CREATED,
    ...over,
  }
}

function issue(over: Record<string, unknown> = {}) {
  return {
    issueId: ISSUE,
    certificateId: 'course-completion',
    templateRevisionId: REVISION,
    templateName: 'Course completion',
    serialNumber: SERIAL,
    parameters: { courseName: 'Safety', learnerName: 'Learner' },
    backgroundImageUrl: null,
    issuedAt: CREATED,
    ...over,
  }
}

function lastCall(): { path: string; options: RequestInit } {
  const [path, options] = apiFetchMock.mock.calls.at(-1) ?? []
  return { path: String(path), options: (options ?? {}) as RequestInit }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('e-learning certificate client', () => {
  it('lists and publishes closed templates with exact command fields', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [template()] }))
    await expect(listElearningCertificateTemplates()).resolves.toEqual([template()])
    expect(lastCall()).toMatchObject({
      path: '/api/elearning/admin/certificate-templates',
      options: { method: 'GET' },
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, template({ version: 3 })))
    await expect(publishElearningCertificateTemplate({
      requestId: REQUEST,
      certificateId: ' course-completion ',
      name: ' Course completion ',
      templateText: '#learnerName# completed #courseName#',
      backgroundImageUrl: 'https://assets.example.test/certificate.png',
    })).resolves.toEqual(template({ version: 3 }))
    expect(lastCall().path).toBe('/api/elearning/admin/certificate-templates')
    expect(JSON.parse(String(lastCall().options.body))).toEqual({
      requestId: REQUEST,
      certificateId: 'course-completion',
      name: 'Course completion',
      templateText: '#learnerName# completed #courseName#',
      backgroundImageUrl: 'https://assets.example.test/certificate.png',
    })
  })

  it('issues and lists only closed certificate snapshots', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, issue()))
    await expect(issueElearningCertificate({
      requestId: REQUEST,
      certificateId: 'course-completion',
      userId: ' learner-1 ',
      parameters: { learnerName: ' Learner ', courseName: ' Safety ' },
    })).resolves.toEqual(issue())
    expect(JSON.parse(String(lastCall().options.body))).toEqual({
      requestId: REQUEST,
      certificateId: 'course-completion',
      userId: 'learner-1',
      parameters: { courseName: 'Safety', learnerName: 'Learner' },
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [issue()] }))
    await expect(listMyElearningCertificates()).resolves.toEqual([issue()])
    expect(lastCall()).toMatchObject({
      path: '/api/elearning/certificates',
      options: { method: 'GET' },
    })
  })

  it.each([
    template({ requestHash: 'secret' }),
    template({ placeholders: ['courseName', 'learnerName'] }),
    template({ placeholders: ['learnerName', 'courseName', 'extra'] }),
    template({ backgroundImageUrl: 'http://assets.example.test/certificate.png' }),
    template({ createdAt: '2026-02-31T04:00:00.000Z' }),
    template({ version: 2_147_483_648 }),
  ])('rejects malformed template payload %#', async (payload) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [payload] }))
    await expect(listElearningCertificateTemplates()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it.each([
    issue({ sourceKey: 'secret' }),
    issue({ parameters: ['not-an-object'] }),
    issue({ issuedAt: '2026-08-30T04:00:00Z' }),
    issue({ issuedAt: '2026-02-31T04:00:00.000Z' }),
    issue({ serialNumber: 'not-a-uuid' }),
    issue({ backgroundImageUrl: 'https://user@example.test/certificate.png' }),
  ])('rejects malformed issue payload %#', async (payload) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [payload] }))
    await expect(listMyElearningCertificates()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('rejects invalid client inputs before network I/O', async () => {
    await expect(publishElearningCertificateTemplate({
      requestId: REQUEST,
      certificateId: 'course-completion',
      name: 'Course completion',
      templateText: '#missing',
      backgroundImageUrl: null,
    })).rejects.toMatchObject({ code: 'invalid_input', status: 400 })
    await expect(issueElearningCertificate({
      requestId: REQUEST,
      certificateId: 'course-completion',
      userId: 'learner-1',
      parameters: { learnerName: '' },
    })).rejects.toMatchObject({ code: 'invalid_input', status: 400 })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('keeps server error responses values-free and stable', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, {
      error: 'conflict',
      attemptedValue: 'must-not-echo',
    }))
    await expect(issueElearningCertificate({
      requestId: REQUEST,
      certificateId: 'course-completion',
      userId: 'learner-1',
      parameters: {},
    })).rejects.toMatchObject({ code: 'conflict', status: 409 })
  })
})

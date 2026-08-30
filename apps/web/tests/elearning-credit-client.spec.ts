import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  adjustElearningCredit,
  getAdminElearningCreditWallet,
  getElearningTitleSnapshot,
  getMyElearningCreditWallet,
  listElearningCreditRules,
  publishElearningCreditRule,
  publishElearningTitleSnapshot,
} from '../src/services/elearningCredit'

const RULE = '11111111-1111-4111-8111-111111111111'
const REQUEST = '22222222-2222-4222-8222-222222222222'
const DECISION = '33333333-3333-4333-8333-333333333333'
const ADJUSTMENT = '44444444-4444-4444-8444-444444444444'
const TITLE_REVISION = '55555555-5555-4555-8555-555555555555'
const CREATED = '2026-08-29T01:02:03.000Z'
const NONCANONICAL = '2026-08-29T01:02:03Z'
const IMPOSSIBLE = '2026-02-31T01:02:03.000Z'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function rule(over: Record<string, unknown> = {}) {
  return {
    behavior: 'complete_course',
    ruleId: RULE,
    version: 1,
    points: 5,
    dailyCap: 10,
    timeZone: 'Asia/Taipei',
    createdAt: CREATED,
    ...over,
  }
}

function wallet(over: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    balancePoints: 5,
    currentTitle: null,
    items: [{
      decisionId: DECISION,
      behavior: 'complete_course',
      awardedPoints: 5,
      status: 'awarded',
      occurredAt: CREATED,
      createdAt: CREATED,
    }],
    nextCursor: 'cursor-2',
    ...over,
  }
}

function titleSnapshot(over: Record<string, unknown> = {}) {
  return {
    revisionId: TITLE_REVISION,
    version: 2,
    titles: [
      { id: 'starter', name: 'Starter', threshold: 0 },
      { id: 'expert', name: 'Expert', threshold: 100 },
    ],
    createdAt: CREATED,
    ...over,
  }
}

function adjustment(over: Record<string, unknown> = {}) {
  return {
    adjustmentId: ADJUSTMENT,
    userId: 'user-2',
    points: -3,
    balancePoints: 7,
    createdAt: CREATED,
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

describe('e-learning credit client', () => {
  it('parses active rules and publishes only the five command fields', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [rule()] }))
    await expect(listElearningCreditRules()).resolves.toEqual([rule()])
    expect(lastCall()).toMatchObject({
      path: '/api/elearning/admin/credit-rules',
      options: { method: 'GET' },
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, rule({ version: 2 })))
    await expect(publishElearningCreditRule({
      requestId: REQUEST,
      behavior: 'complete_course',
      points: 5,
      dailyCap: null,
      timeZone: 'Asia/Taipei',
    })).resolves.toEqual(rule({ version: 2 }))
    expect(lastCall().path).toBe('/api/elearning/admin/credit-rules')
    expect(JSON.parse(String(lastCall().options.body))).toEqual({
      requestId: REQUEST,
      behavior: 'complete_course',
      points: 5,
      dailyCap: null,
      timeZone: 'Asia/Taipei',
    })
  })

  it('rejects extra keys and sensitive internal authority fields in successful responses', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [rule({ status: 'active' })] }))
    await expect(listElearningCreditRules()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, wallet({ requestHash: 'secret' })))
    await expect(getMyElearningCreditWallet()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, wallet({
      items: [{ ...wallet().items[0], effectKey: 'internal' }],
    })))
    await expect(getMyElearningCreditWallet()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('uses stable keyset queries for own/admin wallets and parses the closed DTO', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, wallet()))
    await expect(getMyElearningCreditWallet('cursor-1', 25)).resolves.toEqual(wallet())
    expect(lastCall().path).toBe('/api/elearning/credits/wallet?limit=25&cursor=cursor-1')

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, wallet({ userId: 'user-2' })))
    await expect(getAdminElearningCreditWallet('user-2')).resolves.toMatchObject({ userId: 'user-2' })
    expect(lastCall().path).toBe('/api/elearning/admin/credits/wallet?limit=20&userId=user-2')
  })

  it('gets and publishes a canonical closed title snapshot', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, titleSnapshot()))
    await expect(getElearningTitleSnapshot()).resolves.toEqual(titleSnapshot())
    expect(lastCall()).toMatchObject({
      path: '/api/elearning/admin/credit-titles',
      options: { method: 'GET' },
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, titleSnapshot({ version: 3 })))
    await expect(publishElearningTitleSnapshot({
      requestId: REQUEST,
      titles: [
        { id: 'expert', name: 'Expert', threshold: 100 },
        { id: 'starter', name: 'Starter', threshold: 0 },
      ],
    })).resolves.toEqual(titleSnapshot({ version: 3 }))
    expect(lastCall().path).toBe('/api/elearning/admin/credit-titles')
    expect(JSON.parse(String(lastCall().options.body))).toEqual({
      requestId: REQUEST,
      titles: [
        { id: 'starter', name: 'Starter', threshold: 0 },
        { id: 'expert', name: 'Expert', threshold: 100 },
      ],
    })
  })

  it.each([
    titleSnapshot({ secret: true }),
    titleSnapshot({ titles: [{ id: 'starter', name: 'Starter', threshold: 0, extra: true }] }),
    titleSnapshot({ titles: [
      { id: 'expert', name: 'Expert', threshold: 100 },
      { id: 'starter', name: 'Starter', threshold: 0 },
    ] }),
    titleSnapshot({ titles: [
      { id: 'starter', name: 'Starter', threshold: 0 },
      { id: 'starter', name: 'Duplicate', threshold: 100 },
    ] }),
    titleSnapshot({ revisionId: null }),
    titleSnapshot({ createdAt: IMPOSSIBLE }),
    titleSnapshot({ titles: [{ id: 'overflow', name: 'Overflow', threshold: 2_147_483_648 }] }),
  ])('rejects malformed title snapshot %#', async (payload) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, payload))
    await expect(getElearningTitleSnapshot()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('parses a nullable closed current title and rejects title leakage in wallet DTOs', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, wallet({
      currentTitle: { id: 'starter', name: 'Starter', threshold: 0 },
    })))
    await expect(getMyElearningCreditWallet()).resolves.toMatchObject({
      currentTitle: { id: 'starter', name: 'Starter', threshold: 0 },
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, wallet({
      currentTitle: { id: 'starter', name: 'Starter', threshold: 0, rowId: TITLE_REVISION },
    })))
    await expect(getMyElearningCreditWallet()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('posts only the four manual-adjustment command fields and parses a closed result', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, adjustment()))
    await expect(adjustElearningCredit({
      requestId: REQUEST,
      userId: ' user-2 ',
      points: -3,
      reason: ' correction ',
    })).resolves.toEqual(adjustment())
    expect(lastCall().path).toBe('/api/elearning/admin/credits/adjustments')
    expect(lastCall().options.method).toBe('POST')
    expect(JSON.parse(String(lastCall().options.body))).toEqual({
      requestId: REQUEST,
      userId: 'user-2',
      points: -3,
      reason: 'correction',
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, adjustment({ duplicate: false })))
    await expect(adjustElearningCredit({
      requestId: REQUEST,
      userId: 'user-2',
      points: 3,
      reason: 'correction',
    })).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
  })

  it.each([
    ['rule createdAt', (bad: string) => ({
      body: { items: [rule({ createdAt: bad })] },
      request: () => listElearningCreditRules(),
    })],
    ['wallet occurredAt', (bad: string) => ({
      body: wallet({
        items: [{ ...wallet().items[0], occurredAt: bad }],
      }),
      request: () => getMyElearningCreditWallet(),
    })],
    ['wallet createdAt', (bad: string) => ({
      body: wallet({
        items: [{ ...wallet().items[0], createdAt: bad }],
      }),
      request: () => getMyElearningCreditWallet(),
    })],
    ['adjustment createdAt', (bad: string) => ({
      body: adjustment({ createdAt: bad }),
      request: () => adjustElearningCredit({
        requestId: REQUEST,
        userId: 'user-2',
        points: -3,
        reason: 'correction',
      }),
    })],
  ])('rejects a noncanonical or impossible %s timestamp', async (_label, makeCase) => {
    for (const bad of [NONCANONICAL, IMPOSSIBLE]) {
      const { body, request } = makeCase(bad)
      apiFetchMock.mockResolvedValueOnce(jsonResponse(200, body))
      await expect(request()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
    }
  })

  it('accepts a closed manual-adjust wallet row and rejects impossible behavior/status/points pairs', async () => {
    const manual = {
      decisionId: ADJUSTMENT,
      behavior: 'manual_adjust',
      awardedPoints: -3,
      status: 'adjusted',
      occurredAt: CREATED,
      createdAt: CREATED,
    }
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, wallet({ items: [manual] })))
    await expect(getMyElearningCreditWallet()).resolves.toEqual(wallet({ items: [manual] }))

    for (const boundary of [
      { ...manual, awardedPoints: -2_147_483_647 },
      { ...manual, awardedPoints: 2_147_483_647 },
      {
        ...manual,
        behavior: 'pass_exam',
        status: 'exhausted',
        awardedPoints: 0,
      },
      {
        ...manual,
        behavior: 'pass_exam',
        status: 'awarded',
        awardedPoints: 2_147_483_647,
      },
    ]) {
      apiFetchMock.mockResolvedValueOnce(jsonResponse(200, wallet({
        balancePoints: 2_147_483_647,
        items: [boundary],
      })))
      await expect(getMyElearningCreditWallet()).resolves.toMatchObject({
        balancePoints: 2_147_483_647,
        items: [{ awardedPoints: boundary.awardedPoints }],
      })
    }

    for (const impossible of [
      { ...manual, awardedPoints: 0 },
      { ...manual, awardedPoints: -2_147_483_648 },
      { ...manual, awardedPoints: 2_147_483_648 },
      { ...manual, status: 'awarded' },
      { ...manual, behavior: 'pass_exam', status: 'adjusted' },
      { ...manual, behavior: 'pass_exam', status: 'awarded', awardedPoints: -1 },
      {
        ...manual,
        behavior: 'pass_exam',
        status: 'awarded',
        awardedPoints: 2_147_483_648,
      },
    ]) {
      apiFetchMock.mockResolvedValueOnce(jsonResponse(200, wallet({ items: [impossible] })))
      await expect(getMyElearningCreditWallet()).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      })
    }
  })

  it('fails before IO for invalid commands and preserves values-free server conflicts', async () => {
    await expect(publishElearningCreditRule({
      requestId: 'not-a-uuid',
      behavior: 'complete_course',
      points: 5,
      dailyCap: null,
      timeZone: 'UTC',
    })).rejects.toMatchObject({ code: 'invalid_input', status: 400 })
    expect(apiFetchMock).not.toHaveBeenCalled()

    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'conflict' }))
    await expect(publishElearningCreditRule({
      requestId: REQUEST,
      behavior: 'pass_exam',
      points: 5,
      dailyCap: null,
      timeZone: 'UTC',
    })).rejects.toMatchObject({ code: 'conflict', status: 409 })

    for (const over of [
      { points: 0 },
      { points: 1.5 },
      { points: 2_147_483_648 },
      { points: -2_147_483_648 },
      { userId: ' ' },
      { reason: '' },
      { requestId: 'not-a-uuid' },
      { reason: 'bad\ud800reason' },
    ]) {
      await expect(adjustElearningCredit({
        requestId: REQUEST,
        userId: 'user-2',
        points: 3,
        reason: 'correction',
        ...over,
      })).rejects.toMatchObject({ code: 'invalid_input', status: 400 })
    }

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, adjustment({
      balancePoints: 2_147_483_648,
    })))
    await expect(adjustElearningCredit({
      requestId: REQUEST,
      userId: 'user-2',
      points: 3,
      reason: 'correction',
    })).rejects.toMatchObject({ code: 'invalid_response', status: 200 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, adjustment({
      points: 2_147_483_648,
    })))
    await expect(adjustElearningCredit({
      requestId: REQUEST,
      userId: 'user-2',
      points: 3,
      reason: 'correction',
    })).rejects.toMatchObject({ code: 'invalid_response', status: 200 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, wallet({
      balancePoints: 2_147_483_648,
    })))
    await expect(getMyElearningCreditWallet()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })
})

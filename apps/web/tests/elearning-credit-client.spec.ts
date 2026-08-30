import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  adjustElearningCredit,
  getAdminElearningCreditWallet,
  getMyElearningCreditWallet,
  listElearningCreditRules,
  publishElearningCreditRule,
} from '../src/services/elearningCredit'

const RULE = '11111111-1111-4111-8111-111111111111'
const REQUEST = '22222222-2222-4222-8222-222222222222'
const DECISION = '33333333-3333-4333-8333-333333333333'
const ADJUSTMENT = '44444444-4444-4444-8444-444444444444'
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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { query } from '../../src/db/pg'
import type { QueryResult } from 'pg'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: mocks.query }))

import { createUserSession } from '../../src/auth/session-registry'

const options = { sessionId: 'session', expiresAt: '2030-01-01T00:00:00.000Z' }

describe('createUserSession caller executor', () => {
  beforeEach(() => {
    mocks.query.mockReset().mockResolvedValue({ rows: [] })
  })

  it('uses the caller method and unchanged INSERT with the missing-user allowance disabled', async () => {
    await expect(createUserSession('user', options)).resolves.toBeNull()
    const [legacySql, legacyParams] = mocks.query.mock.calls[0]
    mocks.query.mockClear()
    const callerQuery = vi.fn<Parameters<typeof query>, Promise<QueryResult<never>>>(async function (this: unknown): Promise<QueryResult<never>> {
      expect(this).toBe(executor)
      return { rows: [], command: 'INSERT', rowCount: 0, oid: 0, fields: [] }
    })
    const executor = { query: callerQuery }
    await expect(createUserSession('user', options, executor)).resolves.toBeNull()
    expect(callerQuery.mock.calls).toEqual([[legacySql, [...legacyParams.slice(0, 6), false]]])
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('keeps the generation fence on the caller executor', async () => {
    const callerQuery = vi.fn<Parameters<typeof query>, Promise<QueryResult<never>>>().mockResolvedValue({ rows: [], command: 'INSERT', rowCount: 0, oid: 0, fields: [] })
    await expect(createUserSession('user', { ...options, expectedAccessGeneration: 7 }, { query: callerQuery })).resolves.toBeNull()
    expect(callerQuery.mock.calls[0]?.[0]).toContain(' FOR SHARE')
    expect(callerQuery.mock.calls[0]?.[1]).toEqual(['session', 'user', options.expiresAt, null, null, 7, false])
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it.each(['42P01', '42703', '08006'])('propagates %s from the caller without a pool retry or synthetic result', async (code) => {
    const error = Object.assign(new Error('native failure'), { code })
    const callerQuery = vi.fn<Parameters<typeof query>, Promise<QueryResult<never>>>().mockRejectedValue(error)
    await expect(createUserSession('user', options, { query: callerQuery })).rejects.toBe(error)
    expect(callerQuery).toHaveBeenCalledTimes(1)
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('preserves omitted-executor schema fallback and generation-fenced null', async () => {
    mocks.query.mockRejectedValue(Object.assign(new Error('schema absent'), { code: '42P01' }))
    const session = await createUserSession('user', options)
    expect(session).toEqual({
      id: 'session', userId: 'user', issuedAt: expect.any(String), expiresAt: options.expiresAt,
      lastSeenAt: expect.any(String), revokedAt: null, revokedBy: null, revokeReason: null,
      ipAddress: null, userAgent: null, createdAt: expect.any(String), updatedAt: expect.any(String),
    })
    await expect(createUserSession('user', { ...options, expectedAccessGeneration: 7 })).resolves.toBeNull()
  })
})

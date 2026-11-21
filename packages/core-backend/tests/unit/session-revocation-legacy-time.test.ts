import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query }))
import { isUserSessionRevoked } from '../../src/auth/session-revocation'

describe('ordinary session timestamps and the revocation watermark', () => {
  beforeEach(() => query.mockReset())

  it.each([undefined, NaN, Infinity])('requires a successful empty-watermark read for non-comparable issue times', async issuedAt => {
    query.mockResolvedValueOnce({ rows: [{ revoked: false }] })
    await expect(isUserSessionRevoked('fixture', issuedAt)).resolves.toBe(false)
    query.mockResolvedValueOnce({ rows: [{ revoked: true }] })
    await expect(isUserSessionRevoked('fixture', issuedAt)).resolves.toBe(true)
    expect(query.mock.calls[0][1]).toEqual(['fixture'])
  })

  it('fails closed on an incomplete result, unavailable schema or failed authority read', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await expect(isUserSessionRevoked('fixture')).resolves.toBe(true)
    for (const code of ['42P01', '08006']) {
      const error = Object.assign(new Error('watermark unavailable'), { code })
      query.mockRejectedValueOnce(error)
      await expect(isUserSessionRevoked('fixture')).rejects.toBe(error)
    }
  })
})

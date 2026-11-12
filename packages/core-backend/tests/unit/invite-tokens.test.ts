/**
 * Invite tokens.
 *
 * Invariants:
 *  - every issued invite token is distinct, whatever it is issued for;
 *  - an issued token verifies, with the claims it was issued for;
 *  - the identifier that makes a token distinct is not something verification asks for.
 *
 * Real `jsonwebtoken` signatures. Tests that compare tokens run on a frozen clock, so the tokens they
 * compare agree on every claim except their identifier.
 */
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  INVITE_SECRET: 'unit-test-invite-secret-abcdefghijklmnopqrstuvwxyz012345',
}))

vi.mock('../../src/security/SecretManager', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  secretManager: { get: (key: string) => (key === 'INVITE_TOKEN_SECRET' ? fixtures.INVITE_SECRET : undefined) },
}))

vi.stubEnv('NODE_ENV', 'test')

import { getInviteTokenExpiry, issueInviteToken, verifyInviteToken } from '../../src/auth/invite-tokens'

const USER_ID = 'invite-token-user'
const EMAIL = 'invite-token@example.test'
const INSTANT = new Date('2026-03-13T08:00:00.250Z')
const INSTANT_SECONDS = Math.floor(INSTANT.getTime() / 1000)

function claimsOf(token: string): Record<string, unknown> {
  return jwt.verify(token, fixtures.INVITE_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>
}

function freezeClock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(INSTANT)
}

describe('invite tokens', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.stubEnv('NODE_ENV', 'test')
  })

  it.each([
    ['with a preset', { userId: USER_ID, email: EMAIL, presetId: 'attendance-employee' }],
    ['without a preset', { userId: USER_ID, email: EMAIL }],
    ['with an explicit lifetime', { userId: USER_ID, email: EMAIL, presetId: 'attendance-employee', expiresIn: 3600 }],
  ])('every issued invite token is distinct: tokens issued for the same account with the same inputs all differ (%s)', (_label, options) => {
    freezeClock()

    const tokens = Array.from({ length: 25 }, () => issueInviteToken(options))

    expect(new Set(tokens).size).toBe(tokens.length)
    const claims = tokens.map(claimsOf)
    // One set of inputs: the tokens agree on every claim except their identifier.
    for (const claim of claims) {
      expect(claim.iat).toBe(INSTANT_SECONDS)
      const { jti, ...rest } = claim
      const { jti: _firstJti, ...firstRest } = claims[0]
      expect(rest).toEqual(firstRest)
      expect(typeof jti).toBe('string')
      expect(String(jti).length).toBeGreaterThanOrEqual(32)
    }
    expect(new Set(claims.map((claim) => claim.jti)).size).toBe(tokens.length)
  })

  it('tokens issued under the default lifetime, with the lifetime taken from configuration, are distinct too', () => {
    vi.stubEnv('INVITE_TOKEN_EXPIRY', '2d')
    freezeClock()

    const first = issueInviteToken({ userId: USER_ID, email: EMAIL })
    const second = issueInviteToken({ userId: USER_ID, email: EMAIL })

    expect(second).not.toBe(first)
    expect(claimsOf(first).exp).toBe(INSTANT_SECONDS + 2 * 86_400)
    expect(claimsOf(second).exp).toBe(claimsOf(first).exp)
  })

  it('an issued token verifies with the claims it was issued for', () => {
    const token = issueInviteToken({ userId: USER_ID, email: EMAIL, presetId: 'attendance-employee' })

    const payload = verifyInviteToken(token)

    expect(payload).toMatchObject({
      type: 'invite',
      userId: USER_ID,
      email: EMAIL,
      presetId: 'attendance-employee',
    })
    expect(typeof payload?.jti).toBe('string')
    expect(getInviteTokenExpiry(token)).toBe(new Date(Number(claimsOf(token).exp) * 1000).toISOString())
  })

  it('verification does not ask for the identifier: an invite claim set without one still verifies', () => {
    const token = jwt.sign(
      { type: 'invite', userId: USER_ID, email: EMAIL, presetId: null },
      fixtures.INVITE_SECRET,
      { algorithm: 'HS256', expiresIn: '7d' },
    )

    expect(verifyInviteToken(token)).toMatchObject({ type: 'invite', userId: USER_ID, email: EMAIL })
  })

  it('verification still refuses a claim set that is not an invite, with or without an identifier', () => {
    const sign = (payload: Record<string, unknown>) =>
      jwt.sign(payload, fixtures.INVITE_SECRET, { algorithm: 'HS256', expiresIn: '7d' })

    expect(verifyInviteToken(sign({ userId: USER_ID, email: EMAIL, jti: 'a' }))).toBeNull()
    expect(verifyInviteToken(sign({ type: 'other', userId: USER_ID, email: EMAIL, jti: 'a' }))).toBeNull()
    expect(verifyInviteToken(sign({ type: 'invite', email: EMAIL, jti: 'a' }))).toBeNull()
    expect(verifyInviteToken(sign({ type: 'invite', userId: USER_ID, jti: 'a' }))).toBeNull()
  })
})

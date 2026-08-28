import { describe, expect, it } from 'vitest'
import {
  ELEARNING_OFFLINE_ATTENDANCE_QR_VERSION,
  ElearningOfflineAttendanceQrError,
  signElearningOfflineAttendanceQrToken,
  verifyElearningOfflineAttendanceQrToken,
} from '../../src/services/elearning-offline-attendance-qr'

const SENTINEL = 'secret-qr-value'
const SECRET = Buffer.alloc(32, 7)

function claims(overrides: Record<string, unknown> = {}) {
  return {
    action: 'check_in',
    expiresAt: '2026-09-01T09:05:00.000Z',
    issuedAt: '2026-09-01T09:00:00.000Z',
    nonce: 'nonce_1234567890',
    orgId: 'org-1',
    policyRevision: 'offline-v1',
    targetKey: 'session-1',
    trainingKey: 'training-1',
    version: ELEARNING_OFFLINE_ATTENDANCE_QR_VERSION,
    ...overrides,
  }
}

function expected(overrides: Record<string, unknown> = {}) {
  return {
    action: 'check_in',
    maxTtlSeconds: 300,
    now: '2026-09-01T09:02:00.000Z',
    orgId: 'org-1',
    policyRevision: 'offline-v1',
    targetKey: 'session-1',
    trainingKey: 'training-1',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected offline attendance QR error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningOfflineAttendanceQrError)
    const qrError = error as ElearningOfflineAttendanceQrError
    expect(qrError.code).toBe(code)
    expect(qrError.message).toBe(code)
    expect(qrError.cause).toBeUndefined()
    expect(`${qrError.message}\n${qrError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning offline attendance QR', () => {
  it('signs a deterministic context-bound token and verifies immutable claims', () => {
    const token = signElearningOfflineAttendanceQrToken(claims(), SECRET, 300)
    expect(signElearningOfflineAttendanceQrToken(claims(), SECRET, 300)).toBe(token)
    const verified = verifyElearningOfflineAttendanceQrToken(token, SECRET, expected())
    expect(verified).toEqual(claims())
    expect(Object.isFrozen(verified)).toBe(true)
    const decoded = JSON.parse(Buffer.from(token.split('.')[0] as string, 'base64url').toString('utf8'))
    expect(Object.keys(decoded).sort()).toEqual([
      'action',
      'expiresAt',
      'issuedAt',
      'nonce',
      'orgId',
      'policyRevision',
      'targetKey',
      'trainingKey',
      'version',
    ])
    expect(JSON.stringify(decoded)).not.toContain('user')
  })

  it('rejects tampered payloads, signatures, non-canonical encoding, and wrong secrets', () => {
    const token = signElearningOfflineAttendanceQrToken(claims(), SECRET, 300)
    const [payload, signature] = token.split('.') as [string, string]
    const flip = (value: string) => `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`
    expectCode(() => verifyElearningOfflineAttendanceQrToken(
      `${flip(payload)}.${signature}`,
      SECRET,
      expected(),
    ), 'invalid_token')
    expectCode(() => verifyElearningOfflineAttendanceQrToken(
      `${payload}.${flip(signature)}`,
      SECRET,
      expected(),
    ), 'invalid_token')
    expectCode(() => verifyElearningOfflineAttendanceQrToken(
      `${payload}.${signature}=`,
      SECRET,
      expected(),
    ), 'invalid_token')
    expectCode(() => verifyElearningOfflineAttendanceQrToken(
      token,
      Buffer.alloc(32, 8),
      expected(),
    ), 'invalid_token')
  })

  it('binds action, organization, training, target, and policy revision', () => {
    const token = signElearningOfflineAttendanceQrToken(claims(), SECRET, 300)
    for (const mismatch of [
      { action: 'check_out' },
      { orgId: 'org-2' },
      { trainingKey: 'training-2' },
      { targetKey: 'session-2' },
      { policyRevision: 'offline-v2' },
    ]) {
      expectCode(() => verifyElearningOfflineAttendanceQrToken(
        token,
        SECRET,
        expected(mismatch),
      ), 'context_mismatch')
    }
  })

  it('uses a half-open validity interval at issued and expiry boundaries', () => {
    const token = signElearningOfflineAttendanceQrToken(claims(), SECRET, 300)
    expect(verifyElearningOfflineAttendanceQrToken(token, SECRET, expected({
      now: '2026-09-01T09:00:00.000Z',
    }))).toMatchObject({ nonce: 'nonce_1234567890' })
    expectCode(() => verifyElearningOfflineAttendanceQrToken(token, SECRET, expected({
      now: '2026-09-01T08:59:59.999Z',
    })), 'not_yet_valid')
    expectCode(() => verifyElearningOfflineAttendanceQrToken(token, SECRET, expected({
      now: '2026-09-01T09:05:00.000Z',
    })), 'expired')
  })

  it('requires an explicit maximum TTL at both signing and verification', () => {
    expectCode(() => signElearningOfflineAttendanceQrToken(claims(), SECRET, 299), 'ttl_exceeded')
    const token = signElearningOfflineAttendanceQrToken(claims(), SECRET, 300)
    expectCode(() => verifyElearningOfflineAttendanceQrToken(
      token,
      SECRET,
      expected({ maxTtlSeconds: 299 }),
    ), 'ttl_exceeded')
    for (const invalid of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '300']) {
      expectCode(() => signElearningOfflineAttendanceQrToken(claims(), SECRET, invalid), 'invalid_input')
    }
  })

  it('rejects short or oversized secrets without exposing secret bytes', () => {
    expectCode(() => signElearningOfflineAttendanceQrToken(
      claims(),
      Buffer.from(SENTINEL),
      300,
    ), 'invalid_secret')
    expectCode(() => signElearningOfflineAttendanceQrToken(
      claims(),
      Buffer.alloc(1025, 1),
      300,
    ), 'invalid_secret')
    expectCode(() => signElearningOfflineAttendanceQrToken(claims(), SENTINEL, 300), 'invalid_secret')
  })

  it('rejects malformed claims, non-canonical instants, and user-bearing payloads', () => {
    expectCode(() => signElearningOfflineAttendanceQrToken(claims({
      action: 'unknown',
    }), SECRET, 300), 'invalid_input')
    expectCode(() => signElearningOfflineAttendanceQrToken(claims({
      issuedAt: '2026-09-01T09:00:00Z',
    }), SECRET, 300), 'invalid_input')
    expectCode(() => signElearningOfflineAttendanceQrToken(claims({
      issuedAt: '+010000-01-01T00:00:00.000Z',
    }), SECRET, 300), 'invalid_input')
    expectCode(() => signElearningOfflineAttendanceQrToken(claims({
      expiresAt: '2026-09-01T09:00:00.000Z',
    }), SECRET, 300), 'invalid_input')
    expectCode(() => signElearningOfflineAttendanceQrToken(claims({
      nonce: 'short',
    }), SECRET, 300), 'invalid_input')
    expectCode(() => signElearningOfflineAttendanceQrToken({
      ...claims(),
      userId: SENTINEL,
    }, SECRET, 300), 'invalid_input')
  })

  it('rejects malformed token and verification shapes values-free', () => {
    for (const token of [null, '', 'one-part', 'a.b.c', `${'a'.repeat(8193)}.b`]) {
      expectCode(() => verifyElearningOfflineAttendanceQrToken(
        token,
        SECRET,
        expected(),
      ), 'invalid_token')
    }
    const token = signElearningOfflineAttendanceQrToken(claims(), SECRET, 300)
    expectCode(() => verifyElearningOfflineAttendanceQrToken(
      token,
      SECRET,
      { ...expected(), extra: SENTINEL },
    ), 'invalid_input')

    const throwing = Object.defineProperty(claims(), 'orgId', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => signElearningOfflineAttendanceQrToken(throwing, SECRET, 300), 'invalid_input')
  })
})

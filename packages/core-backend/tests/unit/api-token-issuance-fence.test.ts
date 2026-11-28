/**
 * API token issuance fence (create and rotate), against a recording Kysely: real PostgreSQL SQL is
 * compiled and every statement is recorded in order; no database is contacted.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sessionHelpers = vi.hoisted(() => ({
  isUserSessionRevoked: vi.fn(async () => { throw new Error('issuance must not call isUserSessionRevoked') }),
  getSessionRevocationSnapshot: vi.fn(async () => { throw new Error('issuance must not call getSessionRevocationSnapshot') }),
  isUserSessionActive: vi.fn(async () => { throw new Error('issuance must not call isUserSessionActive') }),
}))

vi.mock('../../src/auth/session-revocation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/session-revocation')>()
  return {
    ...actual,
    isUserSessionRevoked: sessionHelpers.isUserSessionRevoked,
    getSessionRevocationSnapshot: sessionHelpers.getSessionRevocationSnapshot,
  }
})

vi.mock('../../src/auth/session-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/session-registry')>()
  return { ...actual, isUserSessionActive: sessionHelpers.isUserSessionActive }
})

import { StrictCredentialChainError } from '../../src/auth/strict-credential-chain'
import type { Database } from '../../src/db/types'
import {
  AUTHENTICATION_CHANGED_MESSAGE,
  ApiTokenIssuanceError,
  requireIssuanceCredential,
  type ApiTokenIssuanceCredential,
} from '../../src/multitable/api-token-issuance'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import {
  createRecordingKysely,
  issuanceResponder,
  issuanceStatementKind,
  type IssuanceAnswers,
  type RecordedStatement,
  type StatementResponder,
} from '../helpers/recording-kysely'

const USER = 'user-issuance'
const SID = 'sess.issuance-fence'
const IAT = 1_790_000_000
const DATED: ApiTokenIssuanceCredential = { expectedAccessGeneration: 0, sessionId: SID, issuedAt: IAT }
const UNDATED_NO_SID: ApiTokenIssuanceCredential = { expectedAccessGeneration: 0, sessionId: null, issuedAt: null }
const INPUT = { name: 'fence', scopes: ['records:read' as const] }
const OLD_TOKEN_ROW = {
  id: 'old-token',
  name: 'old',
  token_hash: 'a'.repeat(64),
  token_prefix: 'mst_aaaa',
  scopes: JSON.stringify(['records:read']),
  created_by: USER,
  created_at: '2026-11-01T00:00:00.000Z',
  revoked: false,
}

function service(answers: IssuanceAnswers | StatementResponder = {}) {
  const responder = typeof answers === 'function' ? answers : issuanceResponder({ tokenRow: OLD_TOKEN_ROW, ...answers })
  const { db, log } = createRecordingKysely<Database>(responder)
  return { svc: new ApiTokenService(db), log }
}

function kinds(log: RecordedStatement[]): string[] {
  return log.map((statement) => issuanceStatementKind(statement.sql))
}

function indexOfKind(log: RecordedStatement[], kind: string): number {
  return kinds(log).indexOf(kind)
}

function expectNoTokenWrite(log: RecordedStatement[]): void {
  expect(kinds(log)).not.toContain('token-insert')
  expect(kinds(log)).not.toContain('token-update')
  expect(kinds(log)).not.toContain('commit')
}

async function expectChanged(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ApiTokenIssuanceError)
  expect((error as ApiTokenIssuanceError).code).toBe('AUTHENTICATION_CHANGED')
  expect((error as ApiTokenIssuanceError).statusCode).toBe(409)
  expect((error as Error).message).toBe(AUTHENTICATION_CHANGED_MESSAGE)
}

type TokenWrite = 'token-insert' | 'token-update'

function expectFenceOrder(
  log: RecordedStatement[],
  { withSession, writes }: { withSession: boolean; writes: readonly TokenWrite[] },
): void {
  // No locking statement reads the session row or the watermark.
  for (const statement of log) {
    if (/\bFOR (NO KEY |KEY )?(SHARE|UPDATE)\b|pg_advisory/i.test(statement.sql)) {
      expect(statement.sql).not.toMatch(/user_sessions|user_session_revocations/)
    }
  }
  const order = kinds(log)
  const begin = order.indexOf('begin')
  const isolation = order.indexOf('isolation')
  const probe = order.indexOf('isolation-probe')
  const advisory = order.indexOf('advisory-shared')
  const rowLock = order.indexOf('users-for-share')
  const restore = order.indexOf('lock-timeout-restore')
  const session = order.indexOf('session-read')
  const watermark = order.indexOf('watermark-read')
  expect(begin).toBeGreaterThanOrEqual(0)
  // The isolation pin is the first statement of the transaction, and the probe follows it.
  expect(isolation).toBe(begin + 1)
  expect(log[isolation].sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
  expect(probe).toBe(isolation + 1)
  // The shared user access lock: advisory key, then the users row FOR SHARE, then the timeout restore.
  expect(advisory).toBeGreaterThan(probe)
  expect(rowLock).toBeGreaterThan(advisory)
  expect(log[rowLock].sql).toMatch(/\bFOR SHARE\b/)
  expect(restore).toBeGreaterThan(rowLock)
  // Both re-reads come after the lock returns, each as its own statement.
  if (withSession) {
    expect(session).toBeGreaterThan(restore)
    expect(watermark).toBeGreaterThan(session)
    expect(order.filter((kind) => kind === 'session-read')).toHaveLength(1)
  } else {
    expect(session).toBe(-1)
    expect(watermark).toBeGreaterThan(restore)
  }
  expect(order.filter((kind) => kind === 'watermark-read')).toHaveLength(1)
  expect(order).not.toContain('users-read')
  // The session checks and token writes share one transaction and one connection.
  // Every token write follows the checks and precedes the single commit.
  expect(order.filter((kind) => kind === 'begin')).toHaveLength(1)
  expect(order.filter((kind) => kind === 'commit')).toHaveLength(1)
  expect(order).not.toContain('rollback')
  const commit = order.indexOf('commit')
  expect(commit).toBe(order.length - 1)
  for (const write of writes) {
    const at = order.indexOf(write)
    expect(at, write).toBeGreaterThan(watermark)
    expect(at, write).toBeLessThan(commit)
  }
  expect(order.filter((kind) => kind === 'token-insert' || kind === 'token-update')).toHaveLength(writes.length)
  expect(log[begin].connection).toEqual(expect.any(Number))
  expect(log.slice(begin).filter((statement) => statement.connection !== log[begin].connection)).toEqual([])
}

beforeEach(() => {
  sessionHelpers.isUserSessionRevoked.mockClear()
  sessionHelpers.getSessionRevocationSnapshot.mockClear()
  sessionHelpers.isUserSessionActive.mockClear()
})

describe('U1 statement order of the issuance transaction', () => {
  it('create: isolation pin, probe, user lock, session row read, watermark read, then insert', async () => {
    const { svc, log } = service()
    await svc.createToken(USER, INPUT, DATED)
    expectFenceOrder(log, { withSession: true, writes: ['token-insert'] })
    const order = kinds(log)
    expect(order.indexOf('token-insert')).toBeGreaterThan(order.indexOf('watermark-read'))
    expect(order[order.length - 1]).toBe('commit')
    expect(log[indexOfKind(log, 'advisory-shared')].params[1]).toEqual(expect.any(Number))
    expect(log[indexOfKind(log, 'users-for-share')].params).toEqual([USER])
    expect(log[indexOfKind(log, 'session-read')].params).toEqual([SID, USER])
    expect(log[indexOfKind(log, 'watermark-read')].params).toEqual([USER, IAT])
  })

  it('create without a sid skips the session row read and still reads the watermark', async () => {
    const { svc, log } = service()
    await svc.createToken(USER, INPUT, UNDATED_NO_SID)
    expectFenceOrder(log, { withSession: false, writes: ['token-insert'] })
    expect(log[indexOfKind(log, 'watermark-read')].params).toEqual([USER])
  })

  it('rotate: the same fence runs before the old token is revoked and the new one inserted', async () => {
    const { svc, log } = service()
    await svc.rotateToken('old-token', USER, DATED)
    const order = kinds(log)
    expect(order.indexOf('token-select')).toBeLessThan(order.indexOf('begin'))
    expectFenceOrder(log, { withSession: true, writes: ['token-update', 'token-insert'] })
    expect(order.indexOf('token-update')).toBeGreaterThan(order.indexOf('watermark-read'))
    expect(order.indexOf('token-insert')).toBeGreaterThan(order.indexOf('token-update'))
    expect(order[order.length - 1]).toBe('commit')
  })
})

describe('U2 session row', () => {
  it.each(['create', 'rotate'] as const)('%s: a revoked or missing session row refuses with 409 and writes nothing', async (action) => {
    const { svc, log } = service({ sessionRows: [] })
    await expectChanged(action === 'create' ? svc.createToken(USER, INPUT, DATED) : svc.rotateToken('old-token', USER, DATED))
    expect(log[indexOfKind(log, 'session-read')].sql).toMatch(/WHERE id = \$1 AND user_id = \$2 AND revoked_at IS NULL/)
    expectNoTokenWrite(log)
  })

  it('more than one row is not exactly one live session and refuses', async () => {
    const { svc, log } = service({ sessionRows: [{ present: 1 }, { present: 1 }] })
    await expectChanged(svc.createToken(USER, INPUT, DATED))
    expectNoTokenWrite(log)
  })
})

describe('U3 dated watermark', () => {
  it('reads the watermark at or after iat', async () => {
    const { svc, log } = service()
    await svc.createToken(USER, INPUT, DATED)
    expect(log[indexOfKind(log, 'watermark-read')].sql).toMatch(/revoked_after >= to_timestamp\(\$2::double precision\)/)
  })

  it.each(['create', 'rotate'] as const)('%s: a watermark at or after iat refuses with 409 and writes nothing', async (action) => {
    const { svc, log } = service({ revoked: true })
    await expectChanged(action === 'create' ? svc.createToken(USER, INPUT, DATED) : svc.rotateToken('old-token', USER, DATED))
    expectNoTokenWrite(log)
  })

  it('a watermark earlier than iat passes', async () => {
    const { svc, log } = service({ revoked: false })
    await expect(svc.createToken(USER, INPUT, DATED)).resolves.toMatchObject({ token: { createdBy: USER } })
    expect(kinds(log)).toContain('token-insert')
  })

  it.each([null, undefined, 'false', 0, 'f'])('a watermark answer of %s is not exactly false and refuses', async (answer) => {
    const { svc, log } = service({ revoked: answer })
    await expectChanged(svc.createToken(USER, INPUT, DATED))
    expectNoTokenWrite(log)
  })
})

describe('U4 undated watermark', () => {
  it('any watermark other than the epoch placeholder refuses', async () => {
    const { svc, log } = service({ revoked: true })
    await expectChanged(svc.createToken(USER, INPUT, UNDATED_NO_SID))
    expect(log[indexOfKind(log, 'watermark-read')].sql).toMatch(/revoked_after <> TIMESTAMPTZ '1970-01-01 00:00:00\+00'/)
    expectNoTokenWrite(log)
  })

  it('only the epoch placeholder or no row passes', async () => {
    const { svc, log } = service({ revoked: false })
    await svc.createToken(USER, INPUT, UNDATED_NO_SID)
    expect(kinds(log)).toContain('token-insert')
  })

  it('the issuance path never calls the pooled session helpers', async () => {
    const { svc } = service()
    await svc.createToken(USER, INPUT, DATED)
    await svc.createToken(USER, INPUT, UNDATED_NO_SID)
    await svc.rotateToken('old-token', USER, DATED)
    expect(sessionHelpers.isUserSessionRevoked).not.toHaveBeenCalled()
    expect(sessionHelpers.getSessionRevocationSnapshot).not.toHaveBeenCalled()
    expect(sessionHelpers.isUserSessionActive).not.toHaveBeenCalled()
  })

  it('the service module neither imports nor names the pooled session helpers', () => {
    const source = readFileSync(path.join(__dirname, '../../src/multitable/api-token-service.ts'), 'utf8')
    for (const name of ['isUserSessionRevoked', 'getSessionRevocationSnapshot', 'isUserSessionActive', 'session-revocation', 'session-registry']) {
      expect(source).not.toContain(name)
    }
  })
})

describe('U5 read errors propagate and nothing is written', () => {
  const errors = {
    'undefined table code': () => Object.assign(new Error('relation "user_sessions" does not exist'), { code: '42P01' }),
    'missing-relation text without a code': () => new Error('relation "user_session_revocations" does not exist'),
    'general error': () => new Error('synthetic read failure'),
  }
  const reads = ['users-for-share', 'session-read', 'watermark-read'] as const
  const cells = (['create', 'rotate'] as const).flatMap((action) =>
    reads.flatMap((read) => Object.entries(errors).map(([label, make]) => ({ action, read, label, make }))))

  it.each(cells)('$action: $read with $label refuses without a token write', async ({ action, read, make }) => {
    const error = make()
    const base = issuanceResponder({ tokenRow: OLD_TOKEN_ROW })
    const { svc, log } = service((statement) => {
      if (issuanceStatementKind(statement.sql) === read) throw error
      return base(statement)
    })
    await expect(action === 'create' ? svc.createToken(USER, INPUT, DATED) : svc.rotateToken('old-token', USER, DATED)).rejects.toBe(error)
    expect(kinds(log)).toContain('rollback')
    expectNoTokenWrite(log)
  })
})

describe('U6 rotate keeps its revoked-token refusal', () => {
  it('an old token revoked concurrently answers 401 API_TOKEN_REVOKED_CONCURRENTLY and inserts nothing', async () => {
    const { svc, log } = service({ revokeOldRows: [] })
    const error = await svc.rotateToken('old-token', USER, DATED).then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(StrictCredentialChainError)
    expect((error as StrictCredentialChainError).code).toBe('API_TOKEN_REVOKED_CONCURRENTLY')
    expect((error as StrictCredentialChainError).statusCode).toBe(401)
    expect(kinds(log)).not.toContain('token-insert')
    expect(kinds(log).indexOf('token-update')).toBeGreaterThan(kinds(log).indexOf('watermark-read'))
  })
})

describe('account checks after the lock', () => {
  it.each([
    { label: 'missing users row', account: null },
    { label: 'inactive account', account: { is_active: false } },
    { label: 'null activity', account: { is_active: null } },
    { label: 'advanced access generation', account: { access_generation: 1 } },
  ])('$label refuses with 409 before any re-read', async ({ account }) => {
    const { svc, log } = service({ account })
    await expectChanged(svc.createToken(USER, INPUT, DATED))
    expect(kinds(log)).not.toContain('session-read')
    expect(kinds(log)).not.toContain('watermark-read')
    expectNoTokenWrite(log)
  })
})

describe('U16 busy user lock', () => {
  const busy = [
    { label: '55P03', make: () => Object.assign(new Error('lock timeout'), { code: '55P03' }) },
    { label: '40P01', make: () => Object.assign(new Error('deadlock'), { code: '40P01' }) },
    { label: '57014', make: () => Object.assign(new Error('statement timeout'), { code: '57014' }) },
    { label: '40001', make: () => Object.assign(new Error('serialization'), { code: '40001' }) },
    { label: 'query read timeout', make: () => new Error('Query read timeout') },
  ]
  const at = ['advisory-shared', 'users-for-share'] as const
  const cells = at.flatMap((kind) => busy.map((entry) => ({ kind, ...entry })))

  it.each(cells)('$label at $kind is a retryable 409 API_TOKEN_ISSUANCE_BUSY without a token write', async ({ kind, make }) => {
    const base = issuanceResponder({ tokenRow: OLD_TOKEN_ROW })
    for (const action of ['create', 'rotate'] as const) {
      const { svc, log } = service((statement) => {
        if (issuanceStatementKind(statement.sql) === kind) throw make()
        return base(statement)
      })
      const error = await (action === 'create' ? svc.createToken(USER, INPUT, DATED) : svc.rotateToken('old-token', USER, DATED))
        .then(() => undefined, (caught: unknown) => caught)
      expect(error).toBeInstanceOf(ApiTokenIssuanceError)
      expect((error as ApiTokenIssuanceError).code).toBe('API_TOKEN_ISSUANCE_BUSY')
      expect((error as ApiTokenIssuanceError).statusCode).toBe(409)
      expectNoTokenWrite(log)
    }
  })

  it('a busy error from a re-read is not reclassified', async () => {
    const error = Object.assign(new Error('lock timeout'), { code: '55P03' })
    const base = issuanceResponder()
    const { svc, log } = service((statement) => {
      if (issuanceStatementKind(statement.sql) === 'watermark-read') throw error
      return base(statement)
    })
    await expect(svc.createToken(USER, INPUT, DATED)).rejects.toBe(error)
    expectNoTokenWrite(log)
  })
})

describe('isolation probe', () => {
  it.each(['repeatable read', 'serializable', 'READ COMMITTED', ''])('a transaction reporting %j answers 503 API_TOKEN_ISSUANCE_UNAVAILABLE before the lock', async (isolation) => {
    for (const action of ['create', 'rotate'] as const) {
      const { svc, log } = service({ isolation })
      const error = await (action === 'create' ? svc.createToken(USER, INPUT, DATED) : svc.rotateToken('old-token', USER, DATED))
        .then(() => undefined, (caught: unknown) => caught)
      expect(error).toBeInstanceOf(ApiTokenIssuanceError)
      expect((error as ApiTokenIssuanceError).code).toBe('API_TOKEN_ISSUANCE_UNAVAILABLE')
      expect((error as ApiTokenIssuanceError).statusCode).toBe(503)
      expect(kinds(log)).not.toContain('advisory-shared')
      expectNoTokenWrite(log)
    }
  })
})

describe('U17 mandatory issuance credential', () => {
  const invalid: Array<{ label: string; value: unknown }> = [
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'array', value: [0, null, null] },
    { label: 'number', value: 0 },
    { label: 'empty object', value: {} },
    { label: 'missing sessionId', value: { expectedAccessGeneration: 0, issuedAt: null } },
    { label: 'missing issuedAt', value: { expectedAccessGeneration: 0, sessionId: null } },
    { label: 'missing generation', value: { sessionId: null, issuedAt: null } },
    { label: 'extra key', value: { ...UNDATED_NO_SID, userId: USER } },
    { label: 'symbol key', value: { ...UNDATED_NO_SID, [Symbol('extra')]: true } },
    { label: 'undefined sessionId', value: { expectedAccessGeneration: 0, sessionId: undefined, issuedAt: null } },
    { label: 'undefined issuedAt', value: { expectedAccessGeneration: 0, sessionId: null, issuedAt: undefined } },
    { label: 'string generation', value: { expectedAccessGeneration: '0', sessionId: null, issuedAt: null } },
    { label: 'negative generation', value: { expectedAccessGeneration: -1, sessionId: null, issuedAt: null } },
    { label: 'fractional generation', value: { expectedAccessGeneration: 1.5, sessionId: null, issuedAt: null } },
    { label: 'unsafe generation', value: { expectedAccessGeneration: Number.MAX_SAFE_INTEGER + 1, sessionId: null, issuedAt: null } },
    { label: 'NaN iat', value: { expectedAccessGeneration: 0, sessionId: null, issuedAt: Number.NaN } },
    { label: 'infinite iat', value: { expectedAccessGeneration: 0, sessionId: null, issuedAt: Number.POSITIVE_INFINITY } },
    { label: 'overflowing iat', value: { expectedAccessGeneration: 0, sessionId: null, issuedAt: Number.MAX_VALUE } },
    { label: 'string iat', value: { expectedAccessGeneration: 0, sessionId: null, issuedAt: '1790000000' } },
    { label: 'empty sid', value: { expectedAccessGeneration: 0, sessionId: '', issuedAt: IAT } },
    { label: 'padded sid', value: { expectedAccessGeneration: 0, sessionId: ` ${SID}`, issuedAt: IAT } },
    { label: 'trailing-space sid', value: { expectedAccessGeneration: 0, sessionId: `${SID} `, issuedAt: IAT } },
    { label: 'numeric sid', value: { expectedAccessGeneration: 0, sessionId: 7, issuedAt: IAT } },
  ]

  it.each(invalid)('create with $label refuses with 409 before any SQL', async ({ value }) => {
    const { svc, log } = service()
    await expectChanged(svc.createToken(USER, INPUT, value as ApiTokenIssuanceCredential))
    expect(log).toEqual([])
  })

  it.each(invalid)('rotate with $label refuses with 409 before any SQL', async ({ value }) => {
    const { svc, log } = service()
    await expectChanged(svc.rotateToken('old-token', USER, value as ApiTokenIssuanceCredential))
    expect(log).toEqual([])
  })

  it('a well-formed credential is copied, frozen and not read again', () => {
    let reads = 0
    const value = {
      get expectedAccessGeneration() { reads += 1; return 3 },
      sessionId: SID,
      issuedAt: IAT,
    }
    const checked = requireIssuanceCredential(value)
    expect(checked).toEqual({ expectedAccessGeneration: 3, sessionId: SID, issuedAt: IAT })
    expect(Object.isFrozen(checked)).toBe(true)
    expect(reads).toBe(1)
  })
})

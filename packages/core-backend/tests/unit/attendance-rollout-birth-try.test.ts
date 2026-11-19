import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { mintAuthorizationInputBrand, AuthorizationInputTokenRejectedError } from '../../src/rbac/authorization-input-brand'
import {
  AttendanceW4IdentityError,
  buildAttendanceCalculationRolloutAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  tryAcquireAttendanceCalculationRolloutLockForBirthV1,
} from '../../src/attendance/w4c0-identity'
import { AttendanceW4OperationError } from '../../src/attendance/w4c0-operation-contract'
import { runInSettlementCoordinationContextV1, type SettlementCoordinationContextV1 } from '../../src/attendance/coordination/settlement-coordination-context'

const SRC = path.resolve(__dirname, '../../src')
const ORG = parseCanonicalAttendanceRolloutOrgKeyV1('default')
const TRY_SQL = 'SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS acquired'

function tx(patch: Record<string, unknown> = {}, brand: 'mint' | 'closed' | 'none' = 'mint') {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ acquired: true }] }))
  const acquire = vi.fn()
  const token = {
    query,
    locked: new Map(),
    world: 'shared',
    plan: { intent: 'BIRTH', roleIds: [], witness: { userIds: ['actor-1'], admissionUserIds: ['actor-1'] } },
    born: new Set<string>(),
    roleRows: new Map(),
    missingRoleIds: [],
    witnessed: { userIds: new Set<string>(), admissionUserIds: new Set<string>() },
    acquire,
    requireUserRows: vi.fn(),
    requireRoleRows: vi.fn(),
    requireIdentityRead: vi.fn(),
    insertUserForBirth: vi.fn(),
    open: true,
    ...patch,
  }
  const handle = brand === 'none' ? null : mintAuthorizationInputBrand(token, [token])
  if (brand === 'closed') handle?.close()
  return { token: token as AuthorizationInputTx, query, acquire, handle }
}

describe('tryAcquireAttendanceCalculationRolloutLockForBirthV1', () => {
  it('takes one shared try on the canonical key and nothing else', async () => {
    const { token, query, acquire } = tx()
    await tryAcquireAttendanceCalculationRolloutLockForBirthV1(token, ORG)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(TRY_SQL, [buildAttendanceCalculationRolloutAdvisoryKey(ORG).toString()])
    expect(typeof query.mock.calls[0]?.[1]?.[0]).toBe('string')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('turns a false try into rollout busy and a malformed result into the protocol code', async () => {
    const missed = tx()
    missed.query.mockResolvedValueOnce({ rows: [{ acquired: false }] })
    await expect(tryAcquireAttendanceCalculationRolloutLockForBirthV1(missed.token, ORG)).rejects.toMatchObject({
      name: 'AttendanceW4OperationError',
      code: 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY',
      httpStatus: 503,
    })
    for (const rows of [[], [{ acquired: true }, { acquired: false }], [{ acquired: null }], [{ acquired: 'true' }], [{}]]) {
      const bad = tx()
      bad.query.mockResolvedValueOnce({ rows } as never)
      await expect(tryAcquireAttendanceCalculationRolloutLockForBirthV1(bad.token, ORG)).rejects.toMatchObject({
        name: 'AttendanceW4IdentityError',
        code: 'W4C0_BIRTH_ROLLOUT_TRY_RESULT_INVALID',
      })
    }
    expect(AttendanceW4OperationError).toBeTruthy()
  })

  it('refuses a raw, closed, non-birth, exclusive, shut, or coordinated token before SQL', async () => {
    const raw = tx({}, 'none')
    await expect(tryAcquireAttendanceCalculationRolloutLockForBirthV1(raw.token, ORG)).rejects.toMatchObject({
      name: 'AuthorizationInputTokenRejectedError',
      reason: 'unbranded',
    })
    expect(raw.query).not.toHaveBeenCalled()
    const closed = tx({}, 'closed')
    await expect(tryAcquireAttendanceCalculationRolloutLockForBirthV1(closed.token, ORG)).rejects.toBeInstanceOf(AuthorizationInputTokenRejectedError)
    expect(closed.query).not.toHaveBeenCalled()
    for (const patch of [
      { plan: { intent: 'GRANT_ROLE', roleIds: [], witness: { userIds: ['actor-1'], admissionUserIds: ['actor-1'] } } },
      { world: 'exclusive' },
      { open: false },
    ]) {
      const refused = tx(patch)
      await expect(tryAcquireAttendanceCalculationRolloutLockForBirthV1(refused.token, ORG)).rejects.toMatchObject({
        code: 'W4C0_BIRTH_ROLLOUT_TRY_CONTEXT_INVALID',
      })
      expect(refused.query).not.toHaveBeenCalled()
    }
    const coordinated = tx()
    const context: SettlementCoordinationContextV1 = {
      connection: {},
      orgLexical: 'default',
      classZeroHeld: true,
      entryLabel: 'birth-try-test',
      isLive: () => true,
      covers: () => false,
    }
    await expect(runInSettlementCoordinationContextV1(context, () => tryAcquireAttendanceCalculationRolloutLockForBirthV1(coordinated.token, ORG))).rejects.toMatchObject({
      name: 'AttendanceW4IdentityError',
      code: 'W4C0_BIRTH_ROLLOUT_TRY_COORDINATED',
    })
    expect(coordinated.query).not.toHaveBeenCalled()
  })

  it('refuses a non-canonical org through the existing key builder', async () => {
    const { token, query } = tx()
    await expect(tryAcquireAttendanceCalculationRolloutLockForBirthV1(token, 'NOPE' as typeof ORG)).rejects.toMatchObject({
      code: 'W4C0_ROLLOUT_ORG_KEY_INVALID',
    })
    expect(query).not.toHaveBeenCalled()
    expect(AttendanceW4IdentityError).toBeTruthy()
  })

  it('keeps the blocking helper body and limits the try helper to this birth command', () => {
    const identity = fs.readFileSync(path.join(SRC, 'attendance/w4c0-identity.ts'), 'utf8')
    const blocking = identity.slice(
      identity.indexOf('export async function acquireAttendanceCalculationRolloutLock('),
      identity.indexOf('export async function tryAcquireAttendanceCalculationRolloutLockForBirthV1('),
    )
    expect(blocking).toContain("mode === 'shared'")
    expect(blocking).toContain('SELECT pg_advisory_xact_lock_shared($1::bigint)')
    expect(blocking).toContain('SELECT pg_advisory_xact_lock($1::bigint)')
    expect(blocking).not.toContain('pg_try_advisory')
    const helperAt = identity.indexOf('export async function tryAcquireAttendanceCalculationRolloutLockForBirthV1(')
    const helper = identity.slice(helperAt, identity.indexOf('export async function', helperAt + 1))
    expect(helper).toContain(TRY_SQL)
    expect(identity).toContain('B2 single-create exception: tryAcquireAttendanceCalculationRolloutLockForBirthV1')
    expect(tryAcquireAttendanceCalculationRolloutLockForBirthV1.length).toBe(2)
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8')
          if (text.includes('tryAcquireAttendanceCalculationRolloutLockForBirthV1')) hits.push(path.relative(SRC, full))
        }
      }
    }
    walk(SRC)
    expect(hits.sort()).toEqual(['admin/admin-user-birth-command.ts', 'attendance/w4c0-identity.ts'])
  })
})

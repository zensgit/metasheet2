/**
 * Trust-checkpoint activation — canary allowlist parser (pure, no DB).
 *
 * The FAIL-CLOSED direction is the whole point: an unset or empty
 * `MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST` must refuse EVERY sheet, so the operator has to
 * designate the canary explicitly before any trust checkpoint can be minted anywhere. These cases
 * pin that direction and the exact-match rule; the real-DB legs in
 * tests/integration/multitable-l5wire-checkpoint-activation-realdb.test.ts pin the route behavior.
 *
 * Env is passed EXPLICITLY (the functions take a `NodeJS.ProcessEnv`), so these cases never mutate
 * `process.env` and cannot leak posture into a neighboring suite.
 */
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'

import {
  acquireTrustCheckpointActivationLease,
  assertTrustCheckpointSheetAllowlisted,
  assertTrustCheckpointSheetExists,
  isTrustCheckpointSheetAllowlisted,
  resolveTrustCheckpointSheetAllowlist,
  TrustCheckpointActivationForbiddenError,
  TrustCheckpointAuthorityBusyError,
  TrustCheckpointAuthorityUnavailableError,
  TrustCheckpointSheetMissingError,
  TrustCheckpointSheetNotAllowlistedError,
  TRUST_CHECKPOINT_AUTHORITY_BUSY_CODE,
  TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_CODE,
  TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV,
  TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED_CODE,
} from '../../src/multitable/trust-checkpoint-activation-authz'

const env = (value?: string): NodeJS.ProcessEnv =>
  (value === undefined ? {} : { [TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV]: value })

describe('trust-checkpoint canary allowlist (fail-closed)', () => {
  it('the env var name is the manifest-registered literal', () => {
    expect(TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV).toBe('MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST')
  })

  it('UNSET ⇒ empty list ⇒ no sheet is allowlisted', () => {
    expect(resolveTrustCheckpointSheetAllowlist(env())).toEqual([])
    expect(isTrustCheckpointSheetAllowlisted('sheet_a', env())).toBe(false)
  })

  it('EMPTY string ⇒ empty list ⇒ no sheet is allowlisted', () => {
    expect(resolveTrustCheckpointSheetAllowlist(env(''))).toEqual([])
    expect(isTrustCheckpointSheetAllowlisted('sheet_a', env(''))).toBe(false)
  })

  it("separator-only / whitespace-only (' , , ') ⇒ empty list, NOT a list containing ''", () => {
    expect(resolveTrustCheckpointSheetAllowlist(env(' , , '))).toEqual([])
    expect(resolveTrustCheckpointSheetAllowlist(env('   '))).toEqual([])
    expect(resolveTrustCheckpointSheetAllowlist(env(','))).toEqual([])
    // the discriminating consequence: a blank sheet id must never match a blank entry
    expect(isTrustCheckpointSheetAllowlisted('', env(' , , '))).toBe(false)
    expect(isTrustCheckpointSheetAllowlisted('   ', env(' , , '))).toBe(false)
  })

  it('entries are trimmed; a whitespace-padded id still matches exactly', () => {
    expect(resolveTrustCheckpointSheetAllowlist(env('  sheet_a , sheet_b  '))).toEqual(['sheet_a', 'sheet_b'])
    expect(isTrustCheckpointSheetAllowlisted('sheet_a', env('  sheet_a , sheet_b  '))).toBe(true)
    expect(isTrustCheckpointSheetAllowlisted('sheet_b', env('  sheet_a , sheet_b  '))).toBe(true)
    expect(isTrustCheckpointSheetAllowlisted(' sheet_a ', env('sheet_a'))).toBe(true)
  })

  it('match is EXACT — no prefix, no substring, no case folding', () => {
    const listed = env('sheet_canary')
    expect(isTrustCheckpointSheetAllowlisted('sheet_canary', listed)).toBe(true)
    expect(isTrustCheckpointSheetAllowlisted('sheet_canary_2', listed)).toBe(false)
    expect(isTrustCheckpointSheetAllowlisted('sheet_cana', listed)).toBe(false)
    expect(isTrustCheckpointSheetAllowlisted('SHEET_CANARY', listed)).toBe(false)
    expect(isTrustCheckpointSheetAllowlisted('*', listed)).toBe(false)
  })

  it('a designated list does NOT admit some other sheet (positive + negative in one posture)', () => {
    const listed = env('sheet_a,sheet_b')
    expect(isTrustCheckpointSheetAllowlisted('sheet_a', listed)).toBe(true)
    expect(isTrustCheckpointSheetAllowlisted('sheet_c', listed)).toBe(false)
  })

  it('a non-string env value (deleted key present as undefined) is treated as unset', () => {
    expect(resolveTrustCheckpointSheetAllowlist({ [TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV]: undefined })).toEqual([])
  })
})

/**
 * The throwing adjudicators. They exist so the allowlist and existence decisions can run INSIDE the
 * activation transaction (after the lease and after the post-lease final authorization) instead of
 * before it — an abort, not a `return res.status(...)`, is what makes that placement possible.
 */
describe('trust-checkpoint post-lease adjudication (throwing form)', () => {
  it('assertTrustCheckpointSheetAllowlisted throws the named error for a non-designated sheet and is silent for a designated one', () => {
    const listed = env('sheet_a')
    expect(() => assertTrustCheckpointSheetAllowlisted('sheet_b', listed)).toThrow(TrustCheckpointSheetNotAllowlistedError)
    expect(() => assertTrustCheckpointSheetAllowlisted('sheet_a', listed)).not.toThrow()
    try {
      assertTrustCheckpointSheetAllowlisted('sheet_b', listed)
      throw new Error('unreachable')
    } catch (error) {
      expect((error as { code?: string }).code).toBe(TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED_CODE)
      // values-free: the error carries neither the requested sheet nor the designated ones
      expect(String((error as Error).message)).not.toContain('sheet_a')
      expect(String((error as Error).message)).not.toContain('sheet_b')
    }
  })

  it('assertTrustCheckpointSheetExists throws only when the sheet row is absent', async () => {
    const missing = async () => ({ rows: [] as unknown[] })
    const present = async () => ({ rows: [{ '?column?': 1 }] as unknown[] })
    await expect(assertTrustCheckpointSheetExists(missing as never, 'sheet_a')).rejects.toBeInstanceOf(TrustCheckpointSheetMissingError)
    await expect(assertTrustCheckpointSheetExists(present as never, 'sheet_a')).resolves.toBeUndefined()
  })
})

/**
 * The actor authority lease adapter. `'ready'` is deliberately NOT faked here — it requires a real
 * canonical substrate (nine armed triggers plus six matching function-body fingerprints, which cannot
 * be forged without inverting sha256), so the ready path is pinned by the real-DB goldens in
 * tests/integration/multitable-l5wire-checkpoint-activation-realdb.test.ts. What IS pinnable without a
 * database is exactly what a real DB makes hardest to see: the STATEMENT ORDER inside the lease, and
 * that a refusal is a THROW rather than a value the caller could carry on to COMMIT.
 */
describe('trust-checkpoint actor authority lease adapter', () => {
  const principal = { user: { id: 'actor_1', perms: ['multitable:read'] } } as unknown as Request
  const anonymous = {} as unknown as Request

  /** Records every statement the lease issues, answering each with a caller-supplied handler. */
  const recorder = (respond: (sql: string) => Promise<{ rows: unknown[] }>) => {
    const statements: string[] = []
    const query = async (sql: string) => {
      statements.push(sql)
      return respond(sql)
    }
    return { statements, query: query as never }
  }
  const empty = async () => ({ rows: [] as unknown[] })

  it('takes the table lock BEFORE it verifies the substrate — lock-then-verify is the DDL TOCTOU defense, never swap it', async () => {
    const { statements, query } = recorder(empty)
    await expect(acquireTrustCheckpointActivationLease(principal, query)).rejects.toBeInstanceOf(TrustCheckpointAuthorityUnavailableError)
    expect(statements.length).toBeGreaterThanOrEqual(2)
    expect(statements[0]).toMatch(/LOCK TABLE .*IN ROW EXCLUSIVE MODE NOWAIT/s)
    expect(statements[0]).not.toMatch(/pg_trigger|pg_proc/)
    // the substrate verification is the NEXT statement, i.e. strictly after the lock
    expect(statements[1]).toMatch(/pg_trigger/)
  })

  it("a non-canonical substrate ⇒ 'unavailable' ⇒ a THROWN, non-retryable refusal (never a value that could reach COMMIT)", async () => {
    const { query } = recorder(empty)
    const error = await acquireTrustCheckpointActivationLease(principal, query).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TrustCheckpointAuthorityUnavailableError)
    expect((error as { code?: string }).code).toBe(TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_CODE)
    expect((error as { retryable?: boolean }).retryable).toBe(false)
  })

  it("a missing lock function (42883) ⇒ 'unavailable' — the same fail-closed refusal, not a crash", async () => {
    const { query } = recorder(async (sql) => {
      if (/LOCK TABLE/.test(sql)) return { rows: [] }
      throw Object.assign(new Error('function does not exist'), { code: '42883' })
    })
    await expect(acquireTrustCheckpointActivationLease(principal, query)).rejects.toBeInstanceOf(TrustCheckpointAuthorityUnavailableError)
  })

  it("a contended authority table (55P03 on the NOWAIT lock) ⇒ 'busy' ⇒ a THROWN, RETRYABLE refusal", async () => {
    const { query } = recorder(async () => {
      throw Object.assign(new Error('could not obtain lock'), { code: '55P03' })
    })
    const error = await acquireTrustCheckpointActivationLease(principal, query).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TrustCheckpointAuthorityBusyError)
    expect((error as { code?: string }).code).toBe(TRUST_CHECKPOINT_AUTHORITY_BUSY_CODE)
    expect((error as { retryable?: boolean }).retryable).toBe(true)
  })

  it('an unrelated database error is NOT laundered into a refusal — it propagates unchanged', async () => {
    const boom = Object.assign(new Error('connection terminated'), { code: '08006' })
    const { query } = recorder(async () => { throw boom })
    await expect(acquireTrustCheckpointActivationLease(principal, query)).rejects.toBe(boom)
  })

  it('an unauthenticated request leases NOTHING: it is refused before a single statement is issued', async () => {
    const { statements, query } = recorder(empty)
    await expect(acquireTrustCheckpointActivationLease(anonymous, query)).rejects.toBeInstanceOf(TrustCheckpointActivationForbiddenError)
    expect(statements).toEqual([])
  })

  it('the subject can come ONLY from the authenticated principal — the adapter accepts no other value', () => {
    // Values-free by construction rather than by review: with only (req, query) in scope there is no
    // request body, sheet id, or allowlist entry from which a lease subject could be taken.
    expect(acquireTrustCheckpointActivationLease.length).toBe(2)
  })

  it('exactly ONE lease attempt — no hidden auto-retry (an in-transaction re-poll would hold the fence across attempts)', async () => {
    const { statements, query } = recorder(async () => {
      throw Object.assign(new Error('could not obtain lock'), { code: '55P03' })
    })
    await expect(acquireTrustCheckpointActivationLease(principal, query)).rejects.toBeInstanceOf(TrustCheckpointAuthorityBusyError)
    expect(statements.filter((sql) => /LOCK TABLE/.test(sql))).toHaveLength(1)
  })
})

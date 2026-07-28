import { describe, expect, it } from 'vitest'
import {
  ACTIVATE_ERROR_FALLBACK,
  ACTIVATE_ERROR_POLICY,
  mapActivateError,
} from '../../src/routes/admin-users'

/**
 * The activate endpoint's error surface, at RUNTIME. (The static-consistency layer lives in
 * `admin-users-activate-error-closure.test.ts`; it is a different kind of evidence and does not
 * substitute for these calls.)
 *
 * History this file is guarding, retraction-first:
 *
 *   #4581 r2 stopped `ACTIVATE_ALIAS_FAILED` being reported as a client 409 and stopped it
 *   echoing the alias claim's message. r3 then claimed "the message is ours too, whenever the
 *   code is not". That claim was FALSE: the branch selecting the code was a prefix test
 *   (`rawCode.startsWith('ACTIVATE_')`), so an unauthored but `ACTIVATE_`-shaped `.code` was
 *   treated as ours and its `error.message` was published verbatim. Owner's executed repro:
 *   `ACTIVATE_DB_FAILURE -> 500 / ACTIVATE_DB_FAILURE / column "secret_col" does not exist`.
 *
 *   What holds now (owner ruling 2026-07-27): membership in `ACTIVATE_ERROR_POLICY`, never a
 *   prefix; and `error.message` is not read on the response path at all, so no authored reason
 *   inherits the thrown text either.
 *
 * The original `pg` observation still stands and is still asserted below: `pg` puts its SQLSTATE
 * in the same `.code` property `throwCoded` uses. Verified against real Postgres by renaming a
 * column out from under the activate transaction — the client received
 * `500 / 42703 / column "created_at" of relation "user_orgs" does not exist`.
 */
describe('mapActivateError (activate endpoint error surface)', () => {
  const codedError = (code: string, message: string) =>
    Object.assign(new Error(message), { code })

  /**
   * Owner ruling 2026-07-27, transcribed. Written out longhand rather than derived from
   * `ACTIVATE_ERROR_POLICY` on purpose: a table-driven expectation that reads the table under
   * test asserts only that the table equals itself.
   */
  const RULED: Record<string, { status: number; message: string }> = {
    ACTIVATE_USER_REQUIRED: { status: 400, message: 'A target user id is required to activate' },
    ACTIVATE_USER_NOT_FOUND: { status: 404, message: 'User not found' },
    ACTIVATE_NOT_PENDING: { status: 409, message: 'User is not pending activation' },
    ACTIVATE_RACE: { status: 409, message: 'User is no longer pending activation' },
    ACTIVATE_ALIAS_CONFLICT: {
      status: 409,
      message: 'A login identifier is already claimed by another account',
    },
    ACTIVATE_ALIAS_REQUIRED: {
      status: 409,
      message: 'Activation requires at least one usable login identifier',
    },
    ACTIVATE_ALIAS_FAILED: {
      status: 500,
      message: 'Failed to claim login alias during activation',
    },
    ACTIVATE_SOURCE_MISSING: {
      status: 409,
      message: 'No linked active directory account for activation',
    },
    ACTIVATE_SOURCE_INACTIVE: {
      status: 409,
      message: 'Directory account is inactive; cannot activate',
    },
    ACTIVATE_INTEGRATION_INACTIVE: {
      status: 409,
      message: 'Directory integration is not active; cannot activate',
    },
    ACTIVATE_LINK_MISMATCH: {
      status: 409,
      message: 'Directory link points to a different user',
    },
  }

  it('maps every authored reason to the RULED status and OUR message, never the thrown text', () => {
    for (const [code, expected] of Object.entries(RULED)) {
      // Thrown text is deliberately hostile: if any branch ever reads `error.message` again,
      // this string is what lands in the response.
      const mapped = mapActivateError(
        codedError(code, `driver leak: relation "user_orgs" column "secret_col" does not exist`),
      )
      expect({ code: mapped.code, status: mapped.status, message: mapped.message })
        .toEqual({ code, status: expected.status, message: expected.message })
      expect(mapped.message).not.toMatch(/secret_col|user_orgs|relation|driver leak/i)
    }
  })

  it('covers the three reasons the owner ruled on 2026-07-27 (previously untested)', () => {
    // These three had NO case before this change: the suite covered 8 of 11 authored reasons.
    expect(mapActivateError(codedError('ACTIVATE_INTEGRATION_INACTIVE', 'x')).status).toBe(409)
    expect(mapActivateError(codedError('ACTIVATE_RACE', 'x')).status).toBe(409)
    expect(mapActivateError(codedError('ACTIVATE_SOURCE_MISSING', 'x')).status).toBe(409)
  })

  it('asserts the RULED transcription covers exactly the policy table (no silent drift)', () => {
    expect(Object.keys(RULED).sort()).toEqual(Object.keys(ACTIVATE_ERROR_POLICY).sort())
    expect(Object.keys(RULED)).toHaveLength(11)
  })

  it('collapses an unauthored but ACTIVATE_-shaped code — the fail-open the owner reproduced', () => {
    // This is the exact repro. Under the prefix test it returned
    // 500 / ACTIVATE_DB_FAILURE / column "secret_col" does not exist.
    const mapped = mapActivateError(
      codedError('ACTIVATE_DB_FAILURE', 'column "secret_col" does not exist'),
    )
    expect(mapped).toEqual({ status: 500, code: 'ACTIVATE_FAILED', message: 'Activation failed' })
    expect(mapped.code).not.toBe('ACTIVATE_DB_FAILURE')
    expect(mapped.message).not.toMatch(/secret_col|column|does not exist/i)
  })

  it('collapses an unauthored ACTIVATE_SOURCE*-shaped code to 500, not the old prefix 409', () => {
    // Discriminates the SECOND prefix test specifically: `code.startsWith('ACTIVATE_SOURCE')`
    // handed 409 to anything source-shaped, authored or not.
    const mapped = mapActivateError(
      codedError('ACTIVATE_SOURCE_EXPLODED', 'deadlock detected on directory_accounts'),
    )
    expect(mapped.status).toBe(500)
    expect(mapped.code).toBe('ACTIVATE_FAILED')
    expect(mapped.message).toBe('Activation failed')
  })

  it('never lets a prototype-chain name borrow a policy row', () => {
    for (const code of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(mapActivateError(codedError(code, 'x'))).toEqual({
        status: 500,
        code: 'ACTIVATE_FAILED',
        message: 'Activation failed',
      })
    }
  })

  it('collapses the owner-named row verbatim: unknown / unauthenticated / non-closed', () => {
    // Owner ruling 2026-07-27 names this row explicitly, so it gets named cases rather than
    // relying on "structurally the same as the SQLSTATE case".
    const generic = { status: 500, code: 'ACTIVATE_FAILED', message: 'Activation failed' }
    for (const code of [
      'UNAUTHENTICATED', // the route's own 401 code, were it ever to arrive as a thrown reason
      'FORBIDDEN',
      'ACTIVATE_', // the bare prefix itself
      'activate_race', // right letters, wrong case — membership is exact
      ' ACTIVATE_RACE', // leading space
      'ACTIVATE_RACE ', // trailing space
      '', // empty
    ]) {
      expect(mapActivateError(codedError(code, 'relation "user_orgs" does not exist')), code)
        .toEqual(generic)
    }
  })

  it('never publishes a PostgreSQL SQLSTATE as the API error code, nor driver text as the message', () => {
    const pgError = codedError('42703', 'column "created_at" of relation "user_orgs" does not exist')
    const mapped = mapActivateError(pgError)

    expect(mapped.status).toBe(500)
    expect(mapped.code).toBe('ACTIVATE_FAILED')
    expect(mapped.message).toBe('Activation failed')
    expect(mapped.code).not.toMatch(/^[0-9A-Z]{5}$/)
    expect(mapped.message).not.toMatch(/column|relation|does not exist|user_orgs/i)
  })

  it('collapses an uncoded throw, a non-string code, and a non-error throw', () => {
    const generic = { status: 500, code: 'ACTIVATE_FAILED', message: 'Activation failed' }
    expect(mapActivateError(new Error('Cannot read properties of undefined (reading foo)')))
      .toEqual(generic)
    expect(mapActivateError(Object.assign(new Error('x'), { code: 42703 }))).toEqual(generic)
    expect(mapActivateError(null)).toEqual(generic)
    expect(mapActivateError(undefined)).toEqual(generic)
    expect(mapActivateError('ACTIVATE_RACE')).toEqual(generic)
  })

  it('keeps ACTIVATE_FAILED out of the throwable-reason table (closure must not be vacuous)', () => {
    expect(Object.prototype.hasOwnProperty.call(ACTIVATE_ERROR_POLICY, 'ACTIVATE_FAILED'))
      .toBe(false)
    expect(ACTIVATE_ERROR_FALLBACK.code).toBe('ACTIVATE_FAILED')
  })

  /**
   * OWNER POST-MERGE FINDING (P2, 2026-07-27), reproduced before it was fixed.
   *
   * `ACTIVATE_ERROR_FALLBACK` and `ACTIVATE_ERROR_POLICY` were exported and NOT recursively
   * frozen, and `ACTIVATE_ERROR_POLICY_LOOKUP = new Map(Object.entries(ACTIVATE_ERROR_POLICY))`
   * held THE SAME row objects. Owner's executed repro: an external importer set `ACTIVATE_RACE`
   * to 200 plus database text and `mapActivateError()` returned it verbatim — the closure this
   * change exists to build was runtime-mutable from any importer.
   *
   * The mutation is attempted through the PUBLIC export, exactly as an importer would. On a
   * deep-frozen object a strict-mode assignment throws; that is a pass, so the attempt is
   * caught and the BEHAVIOUR is what the assertions read.
   */
  it('survives the owner mutation: the policy is deep-frozen and the response never moves', () => {
    const importerView = ACTIVATE_ERROR_POLICY as unknown as
      Record<string, { status: number; message: string }>
    const driverText = 'relation "user_orgs" column "secret_col" does not exist'

    try {
      importerView.ACTIVATE_RACE.status = 200
      importerView.ACTIVATE_RACE.message = driverText
    } catch {
      // Frozen: the assignment threw. That is the desired outcome, not a test failure.
    }
    try {
      importerView.ACTIVATE_RACE = { status: 200, message: driverText }
    } catch {
      // Frozen table: replacing a whole row threw.
    }

    const mapped = mapActivateError(Object.assign(new Error('x'), { code: 'ACTIVATE_RACE' }))
    expect(mapped.status).toBe(409)
    expect(mapped.code).toBe('ACTIVATE_RACE')
    expect(mapped.message).toBe('User is no longer pending activation')
    expect(mapped.message).not.toMatch(/secret_col|user_orgs|relation/i)

    // The exported projection itself must also be unchanged, so a later reader of the
    // export is not shown a value the response would never publish.
    expect(ACTIVATE_ERROR_POLICY.ACTIVATE_RACE.status).toBe(409)
    expect(ACTIVATE_ERROR_POLICY.ACTIVATE_RACE.message).toBe('User is no longer pending activation')
  })

  it('is deep-frozen: the table, every row, and the fallback', () => {
    expect(Object.isFrozen(ACTIVATE_ERROR_POLICY)).toBe(true)
    for (const [code, row] of Object.entries(ACTIVATE_ERROR_POLICY)) {
      expect(Object.isFrozen(row), `policy row ${code} must be frozen`).toBe(true)
    }
    expect(Object.isFrozen(ACTIVATE_ERROR_FALLBACK)).toBe(true)
  })

  it('the fallback cannot be rewritten through its export either', () => {
    const importerView = ACTIVATE_ERROR_FALLBACK as unknown as { status: number; message: string }
    try {
      importerView.status = 200
      importerView.message = 'column "secret_col" does not exist'
    } catch {
      // Frozen: the assignment threw.
    }
    expect(mapActivateError(new Error('boom')))
      .toEqual({ status: 500, code: 'ACTIVATE_FAILED', message: 'Activation failed' })
  })

  it('returns a fresh object each call — a caller cannot mutate the shared fallback', () => {
    const first = mapActivateError(new Error('boom')) as { message: string }
    first.message = 'mutated'
    expect(mapActivateError(new Error('boom')).message).toBe('Activation failed')
    expect(ACTIVATE_ERROR_FALLBACK.message).toBe('Activation failed')
  })
})

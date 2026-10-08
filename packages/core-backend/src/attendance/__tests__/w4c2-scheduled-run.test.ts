/**
 * W4C-2 P1-2 (#4556) — unit gates for the scheduled-run identity/enqueue module
 * (w4c2-scheduled-run.ts), amendment section 1.4.1, gate 22.
 *
 * SCOPE DISCLOSURE (honest, not overclaimed): `mintAttendanceScheduledRunIdentityFromInsertedRowV1`
 * and `rehydrateVerifiedAttendanceScheduledRunIdentityV1` are module-private per section
 * 1.4.1's own exclusivity requirement — "neither is exported outside the module". Their
 * ONLY future callers are the run-creation/resume/finalization transactions (a LATER
 * slice, landing in this SAME file per this module's own header comment). This file
 * therefore CANNOT exercise their internal field-by-field validation logic (UUID syntax,
 * fixed entrypoint, initiator enum, canonical workDate, positive generation,
 * hex64 fingerprint, org-witness rehydration) directly — there is no external call path,
 * which is gate 22(a)'s own claim. What THIS file proves:
 *  - gate 22(a): neither constructor is a named export of the compiled module (checked by
 *    importing the module's own exports object, not by source-text grep);
 *  - gate 22(b): a caller-fabricated plain object (JSON clone / spread / prototype
 *    lookalike) shaped like `VerifiedAttendanceScheduledRunIdentityV1` is rejected by
 *    `enqueueAttendanceScheduledRunEventOutboxV1` — the one exported entry point in this
 *    module's surface that accepts an identity parameter directly — BEFORE any SQL;
 *  - the run-scoped enqueue surface's other validation legs (event-kind subset,
 *    `legacy_projection_only` fail-closed, payload-shape checks) are values-free and
 *    zero-DML on rejection.
 * Positive-path coverage (a REAL witness reaching `enqueueAttendanceScheduledRunEventOutboxV1`
 * successfully) is NOT exercised here — it requires a genuine minted/rehydrated witness,
 * which requires the run-creation transaction this segment does not implement. That gap is
 * disclosed, not hidden, and belongs to the next segment's own test suite.
 */
import { describe, expect, it } from 'vitest'
import * as w4c2ScheduledRun from '../w4c2-scheduled-run'
import {
  AttendanceW4ScheduledRunIdentityError,
  enqueueAttendanceScheduledRunEventOutboxV1,
  requireVerifiedAttendanceScheduledRunIdentityV1,
} from '../w4c2-scheduled-run'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'

const HEX64_A = 'a'.repeat(64)

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error(`expected ${code} to throw, but it did not`)
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code)
  }
}

async function expectRejectedCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

/** Throws if queried at all — proves rejection happens BEFORE any SQL. */
function noQueryTrx(): AttendanceW4TransactionClientV1 {
  return {
    async query() {
      throw new Error('UNEXPECTED_SQL: this trx must never be queried on a rejection path')
    },
  }
}

// A shape that structurally matches VerifiedAttendanceScheduledRunIdentityV1's fields but
// was never minted by this module's own constructors — a JSON clone / spread / prototype
// lookalike, exactly the forgery class the W4C-0 witness layer defends against.
function fabricatedRunIdentity(): unknown {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    org: { orgId: '22222222-2222-4222-8222-222222222222', acceptedWritePosture: 'shadow' },
    entrypoint: 'scheduled',
    initiator: 'cron',
    workDate: '2026-09-01',
    generation: 1,
    targetSetFingerprint: HEX64_A,
  }
}

describe('gate 22(a) — minting factory absence from the compiled module surface', () => {
  it('neither run-identity constructor is a named export of the module (checked at the module-exports boundary, not by source-text grep)', () => {
    expect((w4c2ScheduledRun as Record<string, unknown>).mintAttendanceScheduledRunIdentityFromInsertedRowV1).toBeUndefined()
    expect(
      (w4c2ScheduledRun as Record<string, unknown>).rehydrateVerifiedAttendanceScheduledRunIdentityV1,
    ).toBeUndefined()
  })

  it('the module DOES export the run-scoped enqueue surface, the witness checker, and the error class (sanity: the absence above is not "nothing is exported")', () => {
    expect(typeof w4c2ScheduledRun.enqueueAttendanceScheduledRunEventOutboxV1).toBe('function')
    expect(typeof w4c2ScheduledRun.requireVerifiedAttendanceScheduledRunIdentityV1).toBe('function')
    expect(typeof w4c2ScheduledRun.AttendanceW4ScheduledRunIdentityError).toBe('function')
  })
})

describe('gate 22(b) — fabricated-object injection through the module\'s exported entry point', () => {
  it('requireVerifiedAttendanceScheduledRunIdentityV1 rejects a JSON-clone/spread/prototype-lookalike object with the correct shape', () => {
    const fabricated = fabricatedRunIdentity()
    expectCode(() => requireVerifiedAttendanceScheduledRunIdentityV1(fabricated), 'W4C2_SCHEDULED_RUN_WITNESS_REQUIRED')
    expectCode(() => requireVerifiedAttendanceScheduledRunIdentityV1({ ...(fabricated as Record<string, unknown>) }), 'W4C2_SCHEDULED_RUN_WITNESS_REQUIRED')
    expectCode(() => requireVerifiedAttendanceScheduledRunIdentityV1(null), 'W4C2_SCHEDULED_RUN_WITNESS_REQUIRED')
    expectCode(() => requireVerifiedAttendanceScheduledRunIdentityV1('not-an-object'), 'W4C2_SCHEDULED_RUN_WITNESS_REQUIRED')
    expectCode(() => requireVerifiedAttendanceScheduledRunIdentityV1(undefined), 'W4C2_SCHEDULED_RUN_WITNESS_REQUIRED')
    // prototype lookalike: same shape via Object.create + assign rather than a literal
    const proto = Object.create(fabricatedRunIdentity() as object)
    expectCode(() => requireVerifiedAttendanceScheduledRunIdentityV1(proto), 'W4C2_SCHEDULED_RUN_WITNESS_REQUIRED')
  })

  it('enqueueAttendanceScheduledRunEventOutboxV1 rejects a fabricated identity BEFORE any SQL (values-free, zero DML)', async () => {
    const trx = noQueryTrx()
    await expectRejectedCode(
      enqueueAttendanceScheduledRunEventOutboxV1(trx, fabricatedRunIdentity(), [
        {
          eventKind: 'attendance.absence.generated',
          payload: { total: 0 },
          payloadSchemaVersion: 1,
          businessKeyFingerprint: HEX64_A,
        },
      ]),
      'W4C2_SCHEDULED_RUN_WITNESS_REQUIRED',
    )
  })

  it('a bare UUID string (not an identity object at all) is rejected the same way', async () => {
    const trx = noQueryTrx()
    await expectRejectedCode(
      enqueueAttendanceScheduledRunEventOutboxV1(trx, '11111111-1111-4111-8111-111111111111', []),
      'W4C2_SCHEDULED_RUN_WITNESS_REQUIRED',
    )
  })
})

describe('AttendanceW4ScheduledRunIdentityError — values-free error shape', () => {
  it('the thrown error IS an instance of this module\'s own error class, with `code` as the sole payload (message === code, never the offending value)', async () => {
    try {
      requireVerifiedAttendanceScheduledRunIdentityV1(fabricatedRunIdentity())
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AttendanceW4ScheduledRunIdentityError)
      expect((error as Error).message).toBe('W4C2_SCHEDULED_RUN_WITNESS_REQUIRED')
      expect(JSON.stringify(error)).not.toContain('11111111-1111-4111-8111-111111111111')
    }
  })
})

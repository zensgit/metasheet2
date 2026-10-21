import { describe, expect, it } from 'vitest'
import { mapGroupConstraintError } from '../../src/services/ApprovalTemplateGroupService'
import { ServiceError } from '../../src/services/ApprovalBridgeService'

/**
 * Approval form grouping — design lock v2.13, A-3 backfill batch header.
 *
 * `impl-gate-A3-round1-20260918.md` §6 P3-3: the batch header table's own non-blank CHECK
 * (`atgbb_org_nonblank`, `zzzz20260919090000_create_approval_template_group_backfill_batches.ts`)
 * was NOT in `NONBLANK_CHECK_CONSTRAINTS`, so a 23514 violation on it — the FIRST write inside
 * `executeApprovalTemplateGroupBackfill{,WithClient}`'s transaction — would surface as an
 * un-mapped `DatabaseError` (generic 500), unlike the phase-1 `atg_org_nonblank` /
 * `atgl_org_nonblank` entries, which already get a typed 400. Not reachable end-to-end today (the
 * route layer 403s a blank `req.authenticatedTenantId` before this file is ever called, and every
 * org id already in the database is ASCII), so this is a real-DB-free unit test against the
 * mapper directly — no route, no transaction, no live Postgres — mirroring how a real pg
 * `DatabaseError` on this constraint would arrive at `mapGroupConstraintError` (a plain object
 * carrying `code: '23514'` and `constraint: 'atgbb_org_nonblank'`, exactly the two fields the
 * mapper reads).
 */
describe('mapGroupConstraintError — atgbb_org_nonblank (A-3 backfill batch header)', () => {
  it('maps a 23514 violation on atgbb_org_nonblank to a typed 400 ServiceError, not a passthrough', () => {
    const pgErr = { code: '23514', constraint: 'atgbb_org_nonblank' }

    const mapped = mapGroupConstraintError(pgErr)

    expect(mapped).toBeInstanceOf(ServiceError)
    const serviceError = mapped as ServiceError
    expect(serviceError.statusCode).toBe(400)
    expect(serviceError.code).toBe('GROUP_NAME_UNSUPPORTED')
    expect(serviceError.details).toEqual({ constraint: 'atgbb_org_nonblank' })
  })

  it('control: an UNRELATED 23514 constraint still passes through unmapped (mapper is not a catch-all)', () => {
    const pgErr = { code: '23514', constraint: 'some_other_check_not_in_the_set' }

    const mapped = mapGroupConstraintError(pgErr)

    // Passthrough: the original object comes back unchanged, NOT a ServiceError.
    expect(mapped).toBe(pgErr)
    expect(mapped).not.toBeInstanceOf(ServiceError)
  })

  it('control: the phase-1 atg_org_nonblank entry this change sits beside is still mapped (set was extended, not replaced)', () => {
    const pgErr = { code: '23514', constraint: 'atg_org_nonblank' }

    const mapped = mapGroupConstraintError(pgErr)

    expect(mapped).toBeInstanceOf(ServiceError)
    expect((mapped as ServiceError).statusCode).toBe(400)
  })
})

import { describe, expect, test } from 'vitest'

import {
  createTenantPrincipalDirectoryBoundaryV1,
  type TenantPrincipalDirectoryQueryFn,
} from '../../src/services/tenant-principal-directory-boundary'

// THE HOST VOUCHING SEAM — the port a plugin's value-bearing read stands on.
//
// `plugin-integration-core`'s three value-bearing stock-preparation reads (the per-decision value
// readback, the materials workbook, and the operator project directory) refuse outright unless this
// port says the caller really belongs to the tenant they claim. That makes THIS the thing between a
// spoofed `x-tenant-id` header and another factory's project names — and it shipped with no test at
// all, so every one of the properties its header promises was a promise rather than a guard.
//
// B-01 FAIL-CLOSED ON MALFORMED INPUT: a non-object, a missing field, a non-string field, a blank or
//      whitespace-only field, and — the load-bearing one — ANY extra key yield `member:false` WITHOUT
//      querying. The extra-key rule is what stops a caller smuggling a second selector past a port
//      whose entire security value is that it takes exactly two.
// B-02 FAIL-CLOSED ON A DATABASE THAT CANNOT ANSWER: a throwing query is `member:false`, never a
//      throw the plugin might catch into a permissive branch and never a silent `true`.
// B-03 THE VERDICT IS THE ROW COUNT: zero rows -> false; one or more -> true. Nothing else decides.
// B-04 THE SQL AND ITS PARAMETERS ARE PINNED: the single `is_active` predicate on `user_orgs`, the
//      LIMIT 1 that stops this port ever reporting HOW MANY memberships exist, the two parameters in
//      order, and the absence of a `users` join (the rejected dual-`is_active` shape).
// B-05 CONSTRUCTION IS FAIL-CLOSED: a boundary cannot be built without a query function.
// B-06 THE VERDICT IS A BARE, FROZEN BOOLEAN CARRIER: nothing about WHY a pairing failed crosses, so
//      a caller asking about a pairing they are not part of learns exactly what a genuine
//      non-membership yields.

interface QueryCall {
  readonly sql: string
  readonly params: unknown[] | undefined
}

function recordingQuery(rows: unknown[]): { query: TenantPrincipalDirectoryQueryFn; calls: QueryCall[] } {
  const calls: QueryCall[] = []
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows }
    },
  }
}

const USER = 'user_42'
const TENANT = 'org_7'

describe('tenant principal directory boundary v1', () => {
  test('B-05 refuses to be constructed without a query function', () => {
    for (const dependencies of [undefined, null, {}, { query: 'SELECT 1' }, { query: null }]) {
      expect(() => createTenantPrincipalDirectoryBoundaryV1(dependencies as never))
        .toThrowError('TENANT_PRINCIPAL_DIRECTORY_DEPENDENCIES_INVALID')
    }
  })

  test('B-03 a matching row admits, and no row denies', async () => {
    const admitting = recordingQuery([{ '?column?': 1 }])
    const admitted = await createTenantPrincipalDirectoryBoundaryV1({ query: admitting.query })
      .verifyTenantMembership({ userId: USER, tenantId: TENANT })
    expect(admitted).toEqual({ member: true })

    const denying = recordingQuery([])
    const denied = await createTenantPrincipalDirectoryBoundaryV1({ query: denying.query })
      .verifyTenantMembership({ userId: USER, tenantId: TENANT })
    expect(denied).toEqual({ member: false })
  })

  test('B-03 more than one row is still exactly one boolean', async () => {
    const many = recordingQuery([{ a: 1 }, { a: 1 }, { a: 1 }])
    const verdict = await createTenantPrincipalDirectoryBoundaryV1({ query: many.query })
      .verifyTenantMembership({ userId: USER, tenantId: TENANT })
    expect(verdict).toEqual({ member: true })
  })

  test('B-03 a result that is not a row array is a denial, not a crash', async () => {
    for (const result of [undefined, null, {}, { rows: null }, { rows: 'nope' }]) {
      const boundary = createTenantPrincipalDirectoryBoundaryV1({
        query: async () => result as unknown as { rows: unknown[] },
      })
      await expect(boundary.verifyTenantMembership({ userId: USER, tenantId: TENANT }))
        .resolves.toEqual({ member: false })
    }
  })

  test('B-04 pins the SQL text, its parameters and their order', async () => {
    const recorder = recordingQuery([{ ok: 1 }])
    await createTenantPrincipalDirectoryBoundaryV1({ query: recorder.query })
      .verifyTenantMembership({ userId: USER, tenantId: TENANT })

    expect(recorder.calls).toHaveLength(1)
    const [call] = recorder.calls
    // Byte-pinned: this is the SAME single-`is_active`-on-`user_orgs` predicate the approval reader
    // and writer agree on (approval-instance-org-derivation.ts D-9). Rewriting it here would silently
    // put this port out of agreement with the rest of the platform's notion of a live membership.
    expect(call.sql).toBe(
      'SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE LIMIT 1',
    )
    // Identity strings only, in the order the placeholders name them. A swap here would ask the host
    // whether the TENANT belongs to the USER, which is a different (and always-false) question.
    expect(call.params).toEqual([USER, TENANT])
    // LIMIT 1 is part of the contract, not an optimisation: without it this port could report how
    // many memberships exist, which is more than one boolean's worth of information.
    expect(call.sql).toMatch(/\bLIMIT 1$/)
    // Deliberately NO `users` join — that is the rejected dual-`is_active` shape.
    expect(call.sql).not.toMatch(/\busers\b/)
    // One statement, no second selector.
    expect(call.sql.split(';')).toHaveLength(1)
  })

  test('B-04 the inputs are trimmed before they reach the query', async () => {
    const recorder = recordingQuery([{ ok: 1 }])
    await createTenantPrincipalDirectoryBoundaryV1({ query: recorder.query })
      .verifyTenantMembership({ userId: `  ${USER}\t`, tenantId: ` ${TENANT} ` })
    expect(recorder.calls[0].params).toEqual([USER, TENANT])
  })

  test('B-01 every malformed input is denied WITHOUT touching the database', async () => {
    const malformed: unknown[] = [
      undefined,
      null,
      'user_42',
      42,
      [USER, TENANT],
      {},
      { userId: USER },
      { tenantId: TENANT },
      { userId: USER, tenantId: '' },
      { userId: '', tenantId: TENANT },
      { userId: '   ', tenantId: TENANT },
      { userId: USER, tenantId: '   ' },
      { userId: 42, tenantId: TENANT },
      { userId: USER, tenantId: 42 },
      { userId: USER, tenantId: null },
      // THE EXTRA KEY. A port whose security value is that it takes exactly two selectors must refuse
      // a third, even one that looks harmless — and even when the two it does take are perfectly good.
      { userId: USER, tenantId: TENANT, includeInactive: true },
      { userId: USER, tenantId: TENANT, orgId: 'org_other' },
      { userId: USER, tenantId: TENANT, extra: undefined },
    ]
    for (const input of malformed) {
      const recorder = recordingQuery([{ ok: 1 }])
      const verdict = await createTenantPrincipalDirectoryBoundaryV1({ query: recorder.query })
        .verifyTenantMembership(input as never)
      expect(verdict, `input ${JSON.stringify(input)} must be denied`).toEqual({ member: false })
      expect(recorder.calls, `input ${JSON.stringify(input)} must not reach the database`).toHaveLength(0)
    }
  })

  test('B-01 a symbol-keyed extra selector is an extra key too', async () => {
    const recorder = recordingQuery([{ ok: 1 }])
    const smuggled: Record<string | symbol, unknown> = { userId: USER, tenantId: TENANT }
    smuggled[Symbol('orgId')] = 'org_other'
    const verdict = await createTenantPrincipalDirectoryBoundaryV1({ query: recorder.query })
      .verifyTenantMembership(smuggled as never)
    expect(verdict).toEqual({ member: false })
    expect(recorder.calls).toHaveLength(0)
  })

  test('B-02 a database that cannot answer is a denial, never a throw and never a pass', async () => {
    const failures = [
      () => { throw new Error('connection terminated') },
      () => { throw Object.assign(new Error('permission denied for relation user_orgs'), { code: '42501' }) },
      () => { throw 'not even an Error' },
    ]
    for (const fail of failures) {
      const boundary = createTenantPrincipalDirectoryBoundaryV1({
        query: async () => { return fail() as never },
      })
      await expect(boundary.verifyTenantMembership({ userId: USER, tenantId: TENANT }))
        .resolves.toEqual({ member: false })
    }
  })

  test('B-06 the verdict carries the boolean and nothing else, and cannot be mutated', async () => {
    const recorder = recordingQuery([{ ok: 1 }])
    const boundary = createTenantPrincipalDirectoryBoundaryV1({ query: recorder.query })
    const verdict = await boundary.verifyTenantMembership({ userId: USER, tenantId: TENANT })
    // No reason, no row, no count — a refusal must be indistinguishable from a non-membership.
    expect(Object.keys(verdict)).toEqual(['member'])
    expect(Object.isFrozen(verdict)).toBe(true)
    // ...and the boundary object itself exposes exactly the one method the port promises.
    expect(Object.keys(boundary)).toEqual(['verifyTenantMembership'])
    expect(Object.isFrozen(boundary)).toBe(true)
  })

  test('B-06 the ADMITTED and DENIED verdicts are shared frozen singletons a caller cannot poison', async () => {
    const admitting = createTenantPrincipalDirectoryBoundaryV1({ query: async () => ({ rows: [{ ok: 1 }] }) })
    const first = await admitting.verifyTenantMembership({ userId: USER, tenantId: TENANT })
    // A caller that tries to flip a shared verdict must not be able to change what the NEXT caller
    // sees — the freeze is what makes returning a singleton safe.
    expect(() => {
      (first as { member: boolean }).member = false
    }).toThrowError()
    const second = await admitting.verifyTenantMembership({ userId: USER, tenantId: TENANT })
    expect(second).toEqual({ member: true })
  })
})

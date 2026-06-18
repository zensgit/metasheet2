/**
 * 2c-S2 — resolvePersonAssignableDirectory (source = B: member-group directory) unit coverage.
 *
 * The allowed-set resolver is INJECTED here (the canonical createPersonMemberResolver is exercised
 * end-to-end by the real-DB person-member-group-restrict suite). These tests pin the read-model's
 * own behavior: hydration → display mapping, stable ordering + active-only SQL, the empty-set
 * short-circuit (fail-closed parity), the exact id params, and non-string field coercion.
 */
import { describe, expect, test } from 'vitest'

import { resolvePersonAssignableDirectory } from '../../src/multitable/person-field-restriction'
import type { QueryFn } from '../../src/multitable/permission-service'

describe('2c-S2 resolvePersonAssignableDirectory (member-group directory read model)', () => {
  test('hydrates the allowed set into display entries (id/name/email); active-only + ordered SQL', async () => {
    const calls: string[] = []
    const query: QueryFn = async (sql) => {
      calls.push(sql)
      return { rows: [{ uid: 'u1', name: 'Alice', email: 'a@x.io' }, { uid: 'u2', name: 'Bob', email: null }] }
    }
    const out = await resolvePersonAssignableDirectory(query, 'sheet1', ['g1'], async () => new Set(['u1', 'u2']))
    expect(out).toEqual([
      { userId: 'u1', name: 'Alice', email: 'a@x.io' },
      { userId: 'u2', name: 'Bob', email: null },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/is_active = TRUE/) // inactive/deleted excluded from the assignable directory
    expect(calls[0]).toMatch(/ORDER BY name/) // stable display order
  })

  test('empty allowed set short-circuits — no hydration query (fail-closed parity with the validator)', async () => {
    let called = false
    const query: QueryFn = async () => {
      called = true
      return { rows: [] }
    }
    const out = await resolvePersonAssignableDirectory(query, 'sheet1', ['g1'], async () => new Set())
    expect(out).toEqual([])
    expect(called).toBe(false)
  })

  test('passes exactly the allowed ids as the hydration params', async () => {
    let params: unknown[] | undefined
    const query: QueryFn = async (_sql, p) => {
      params = p
      return { rows: [] }
    }
    await resolvePersonAssignableDirectory(query, 'sheet1', [], async () => new Set(['u9']))
    expect(params?.[0]).toEqual(['u9'])
  })

  test('non-string name/email coerced to null (no numeric/object leakage into display)', async () => {
    const query: QueryFn = async () => ({ rows: [{ uid: 'u1', name: undefined, email: 123 }] })
    const out = await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(['u1']))
    expect(out).toEqual([{ userId: 'u1', name: null, email: null }])
  })
})

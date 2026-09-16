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

  /**
   * #5781 — the hydration BOUNDS (search + LIMIT). These live in the SQL, so the ceiling holds for
   * THIS query's DB round trip.
   *
   * SCOPE (the first wording of this docstring overclaimed): the bound is on the DISPLAY hydration
   * only. On the route path the allowed-set resolution runs first (loadSheetMemberUserIdSet →
   * listSheetPermissionCandidates with `{ limit: 10000 }`) and reads up to 10,000 candidate rows
   * INCLUDING name/email into the process, so "names/emails past the ceiling never enter the process"
   * is NOT true end to end — only "they never leave it". Bounding that first read is the tracked
   * set-narrowing follow-up.
   *
   * The bounds must NOT touch the allowed set — $1 stays the full eligible set on every path, because
   * that set is shared with the write validator (createPersonMemberResolver).
   */
  describe('#5781 hydration bounds', () => {
    function capture() {
      const seen: Array<{ sql: string; params: unknown[] }> = []
      const query: QueryFn = async (sql, params) => {
        seen.push({ sql, params: (params ?? []) as unknown[] })
        return { rows: [] }
      }
      return { seen, query }
    }

    test('no options ⇒ byte-identical pre-#5781 behavior (no search predicate, no LIMIT)', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(['u1', 'u2']))
      expect(seen[0].sql).not.toMatch(/ILIKE/)
      expect(seen[0].sql).not.toMatch(/LIMIT/)
      expect(seen[0].params).toEqual([['u1', 'u2']])
    })

    test('limit is applied as SQL LIMIT with the value bound as a param', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(['u1']), { limit: 51 })
      expect(seen[0].sql).toMatch(/LIMIT \$\d+/)
      expect(seen[0].params[seen[0].params.length - 1]).toBe(51)
    })

    test('search is applied as a name/email ILIKE predicate in SQL — not a post-hoc filter', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(['u1']), { search: 'ali', limit: 51 })
      expect(seen[0].sql).toMatch(/name, ''\) ILIKE \$2/)
      expect(seen[0].sql).toMatch(/email, ''\) ILIKE \$2/)
      expect(seen[0].params[1]).toBe('%ali%')
    })

    test('LIKE metacharacters in the term are escaped — `%` stays a literal, it cannot re-open the roster', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(['u1']), { search: '%_\\', limit: 51 })
      expect(seen[0].params[1]).toBe('%\\%\\_\\\\%')
    })

    test('the bounds never touch the ALLOWED set — $1 is still exactly the eligible ids', async () => {
      const { seen, query } = capture()
      const allowed = new Set(['u1', 'u2', 'u3'])
      await resolvePersonAssignableDirectory(query, 's', ['g1'], async () => allowed, { search: 'a', limit: 1 })
      expect(seen[0].params[0]).toEqual(['u1', 'u2', 'u3'])
      expect(seen[0].sql).toMatch(/id::text = ANY\(\$1::text\[\]\)/)
      expect(seen[0].sql).toMatch(/is_active = TRUE/) // active-only, unchanged
      expect(seen[0].sql).toMatch(/ORDER BY name/) // stable order, unchanged
    })

    test('the restrict groups still reach the canonical allowed-set resolver unchanged', async () => {
      const { query } = capture()
      let received: string[] | undefined
      await resolvePersonAssignableDirectory(
        query,
        's',
        ['g1', 'g2'],
        async (groupIds) => {
          received = groupIds
          return new Set(['u1'])
        },
        { search: 'a', limit: 51 },
      )
      expect(received).toEqual(['g1', 'g2'])
    })

    test('an empty allowed set still short-circuits with the bounds present (fail-closed preserved)', async () => {
      const { seen, query } = capture()
      const out = await resolvePersonAssignableDirectory(query, 's', ['g1'], async () => new Set(), { search: 'a', limit: 51 })
      expect(out).toEqual([])
      expect(seen).toHaveLength(0)
    })
  })

  /**
   * #5809 — the EXACT lookup mode the import resolver uses. An extra equality predicate on the same row
   * set: `$1` stays the full eligible set, `is_active` and the LIMIT stay, and no LIKE is issued.
   */
  describe('#5809 exact lookup mode', () => {
    function capture() {
      const seen: Array<{ sql: string; params: unknown[] }> = []
      const query: QueryFn = async (sql, params) => {
        seen.push({ sql, params: (params ?? []) as unknown[] })
        return { rows: [] }
      }
      return { seen, query }
    }

    test('matches id / trimmed name / trimmed email by case-insensitive EQUALITY, never by LIKE', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(['u1']), {
        exact: '  Fake.Person@example.invalid ',
        limit: 51,
      })
      expect(seen).toHaveLength(1)
      expect(seen[0].sql).not.toMatch(/LIKE/i)
      expect(seen[0].sql).toContain('lower(id::text) = lower($2::text)')
      expect(seen[0].sql).toContain("lower(btrim(COALESCE(name, ''))) = lower($2::text)")
      expect(seen[0].sql).toContain("lower(btrim(COALESCE(email, ''))) = lower($2::text)")
      // Bound as a trimmed parameter, never interpolated.
      expect(seen[0].params[1]).toBe('Fake.Person@example.invalid')
      expect(seen[0].sql).not.toContain('example.invalid')
      expect(seen[0].sql).toMatch(/LIMIT \$3/)
      expect(seen[0].params[2]).toBe(51)
    })

    test('exact wins over search when both are given (one predicate, no substring arm)', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(['u1']), {
        exact: 'Fake Person',
        search: 'fake',
        limit: 51,
      })
      expect(seen[0].sql).not.toMatch(/ILIKE/)
      expect(seen[0].params).toEqual([['u1'], 'Fake Person', 51])
    })

    test('the exact mode never touches the ALLOWED set or the active-only filter', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', ['g1'], async () => new Set(['u1', 'u2']), { exact: 'u9', limit: 51 })
      expect(seen[0].params[0]).toEqual(['u1', 'u2'])
      expect(seen[0].sql).toMatch(/id::text = ANY\(\$1::text\[\]\)/)
      expect(seen[0].sql).toMatch(/is_active = TRUE/)
    })

    test('a blank exact term is no exact term (the substring path, byte-identical)', async () => {
      const exactBlank = capture()
      const plain = capture()
      await resolvePersonAssignableDirectory(exactBlank.query, 's', [], async () => new Set(['u1']), { exact: '   ', search: 'ali', limit: 51 })
      await resolvePersonAssignableDirectory(plain.query, 's', [], async () => new Set(['u1']), { search: 'ali', limit: 51 })
      expect(exactBlank.seen).toEqual(plain.seen)
    })

    test('an empty allowed set still short-circuits in exact mode', async () => {
      const { seen, query } = capture()
      const out = await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(), { exact: 'u1', limit: 51 })
      expect(out).toEqual([])
      expect(seen).toHaveLength(0)
    })
  })
})

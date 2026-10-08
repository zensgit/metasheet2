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
import { JS_TRIM_WHITESPACE } from '../../src/utils/js-trim-whitespace'

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
      expect(seen[0].sql).toContain("lower(btrim(COALESCE(name, ''), $3::text)) = lower($2::text)")
      expect(seen[0].sql).toContain("lower(btrim(COALESCE(email, ''), $3::text)) = lower($2::text)")
      // Bound as a trimmed parameter, never interpolated.
      expect(seen[0].params[1]).toBe('Fake.Person@example.invalid')
      expect(seen[0].sql).not.toContain('example.invalid')
      // The trim set is a bound parameter as well.
      expect(seen[0].params[2]).toBe(JS_TRIM_WHITESPACE)
      expect(seen[0].sql).toMatch(/LIMIT \$4/)
      expect(seen[0].params[3]).toBe(51)
    })

    // Refuter round: PG `btrim(x)` strips only U+0020, while the pre-#5809 client matched on JS
    // `trim()` of both sides. A name stored as "Name<U+3000>" / "Name<NBSP>" / "Name<TAB>" must still
    // EQUAL the trimmed term, so both stored-side trims take the JS trim set, never the one-arg form.
    test('trims the STORED name and email with the JS trim() set, not btrim\'s ASCII-space default', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(['u1']), { exact: 'Fake Person', limit: 51 })
      const sql = seen[0].sql
      expect(sql).not.toMatch(/btrim\(COALESCE\((name|email), ''\)\)/)
      expect(sql.match(/btrim\(COALESCE\((name|email), ''\), \$3::text\)/g)).toHaveLength(2)
      const trimSet = seen[0].params[2] as string
      for (const ch of ['\u3000', '\u00A0', '\t', '\u2003', '\uFEFF', ' ']) {
        expect(trimSet).toContain(ch)
      }
    })

    test('JS_TRIM_WHITESPACE is exactly the set String.prototype.trim() strips (every code point)', () => {
      const expected: string[] = []
      for (let cp = 0; cp <= 0x10ffff; cp += 1) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue
        const ch = String.fromCodePoint(cp)
        if (ch.trim() === '') expected.push(ch)
      }
      expect([...JS_TRIM_WHITESPACE]).toEqual(expected)
    })

    test('exact wins over search when both are given (one predicate, no substring arm)', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(['u1']), {
        exact: 'Fake Person',
        search: 'fake',
        limit: 51,
      })
      expect(seen[0].sql).not.toMatch(/ILIKE/)
      expect(seen[0].params).toEqual([['u1'], 'Fake Person', JS_TRIM_WHITESPACE, 51])
    })

    test('the exact mode never touches the ALLOWED set or the active-only filter', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', ['g1'], async () => new Set(['u1', 'u2']), { exact: 'u9', limit: 51 })
      expect(seen[0].params[0]).toEqual(['u1', 'u2'])
      expect(seen[0].sql).toMatch(/id::text = ANY\(\$1::text\[\]\)/)
      expect(seen[0].sql).toMatch(/is_active = TRUE/)
    })

    // Refuter round: a blank exact term used to fall through to "no predicate at all" and hand back
    // the first `limit` rows of the allowed set — the browse exact mode must never be. It now fails
    // closed before ANY query, including the allowed-set resolution.
    test('a blank exact term matches nobody: [] with no query and no allowed-set resolution', async () => {
      for (const blank of ['', '   ', '\u3000\t']) {
        for (const search of [undefined, 'ali']) {
          const { seen, query } = capture()
          let resolved = false
          const out = await resolvePersonAssignableDirectory(query, 's', [], async () => {
            resolved = true
            return new Set(['u1', 'u2'])
          }, { exact: blank, search, limit: 51 })
          expect(out).toEqual([])
          expect(seen).toHaveLength(0)
          expect(resolved).toBe(false)
        }
      }
    })

    test('without an exact key the substring path is unchanged', async () => {
      const { seen, query } = capture()
      await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(['u1']), { exact: undefined, search: 'ali', limit: 51 })
      expect(seen).toHaveLength(1)
      expect(seen[0].sql).toContain("(COALESCE(name, '') ILIKE $2 OR COALESCE(email, '') ILIKE $2)")
      expect(seen[0].params).toEqual([['u1'], '%ali%', 51])
    })

    test('an empty allowed set still short-circuits in exact mode', async () => {
      const { seen, query } = capture()
      const out = await resolvePersonAssignableDirectory(query, 's', [], async () => new Set(), { exact: 'u1', limit: 51 })
      expect(out).toEqual([])
      expect(seen).toHaveLength(0)
    })
  })
})

/**
 * W7-1a (#4556) — the three FSER-mirroring SELECTs in the group-effective
 * facts resolver stay equivalent to the FSER originals.
 *
 * WHY THIS TEST EXISTS. The resolver's header used to assert that its three
 * queries were "pinned byte-for-byte against the FSER original by a test".
 * No such test existed — an independent gate proved it by whitespace-
 * reformatting one query and watching the whole battery stay green. A
 * comment-asserted invariant that nothing checks is a hidden bug, not
 * documentation, so this file makes the claim true and the header now states
 * exactly what is enforced.
 *
 * WHY "BYTE-FOR-BYTE" WAS THE WRONG CLAIM, and is not what this enforces.
 * The two literals are nested at different depths — the FSER original sits
 * inside a `.cjs` factory closure (9-space continuation indent), the W7 copy
 * inside a TS module function (7-space). Their bytes therefore CANNOT be
 * equal without gratuitously reindenting one file to match the other's
 * nesting, which would be churn in service of a test rather than a real
 * invariant. Verified, not assumed: the three pairs differ ONLY in leading
 * whitespace.
 *
 * WHAT IS ENFORCED INSTEAD: equality after whitespace normalisation — i.e.
 * the SQL token stream must be identical. That is the invariant with
 * behavioural content. It catches a dropped `ORDER BY`, a changed predicate,
 * a renamed column, an added/removed clause, or FSER moving underneath us —
 * every way the two can actually diverge in meaning. It deliberately does NOT
 * catch reindentation, because reindentation cannot change what the database
 * does.
 *
 * WHY IT MATTERS AT ALL. The resolver reissues these SELECTs rather than
 * calling FSER's own `loadEffectivenessFacts`, because that function is a
 * private closure and the exported wrappers read UNLOCKED — unusable for a
 * resolver that must read under its own locks. Reissuing is a duplicated
 * READ, and duplicated reads drift. The effectiveness PREDICATE stays
 * singular (the exported pure derivation is injected, W6-R4), but the facts
 * fed to it must keep coming from the same rows, or the predicate is being
 * applied to a different question than the one FSER answers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../../')

const FSER_MODULE = 'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs'
const W7_RESOLVER = 'packages/core-backend/src/attendance/w7-resolver/w7-group-effective-facts-resolver.ts'

/** Template-literal contents of a file. Both modules write their SQL as
 *  backticked template literals, so this is the whole candidate set. */
function templateLiterals(relPath: string): string[] {
  const text = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')
  return [...text.matchAll(/`([^`]*)`/gs)].map((match) => match[1])
}

function sqlLiterals(relPath: string): string[] {
  return templateLiterals(relPath).filter((lit) => lit.includes('SELECT') && lit.includes('FROM'))
}

/** Collapse every run of whitespace to a single space. The ONLY difference
 *  this is allowed to erase is layout. */
function normaliseSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/** The three fact families the resolver reissues, named by the table they
 *  read so a failure says which one drifted. */
const MIRRORED_TABLES = [
  'attendance_group_fixed_schedule_configs',
  'attendance_group_members',
  'attendance_shift_assignments',
] as const

/**
 * Queries that READ FROM `table` as their primary relation.
 *
 * Anchored on `FROM <table>` after normalisation, not on a bare substring:
 * FSER's member-safe self projection also mentions
 * `attendance_group_members`, but as `JOIN attendance_group_members agm`. A
 * bare `includes(table)` matches both and makes "the query" ambiguous — which
 * is exactly what the first version of this file did, and the
 * exactly-one-match assertion below is what caught it.
 */
function findByTable(literals: readonly string[], table: string): string[] {
  return literals.filter((lit) => normaliseSql(lit).includes(`FROM ${table}`))
}

describe('W7-1a: the resolver’s three FSER-mirroring SELECTs match the FSER originals', () => {
  it('both source files really were read and really do contain SQL (non-vacuity)', () => {
    // Without this, a renamed/moved file would make every leg below compare
    // empty-to-empty and pass — the "an empty read is not an absence" trap.
    const fser = sqlLiterals(FSER_MODULE)
    const w7 = sqlLiterals(W7_RESOLVER)
    expect(fser.length).toBeGreaterThanOrEqual(3)
    expect(w7.length).toBeGreaterThanOrEqual(6)
  })

  it.each(MIRRORED_TABLES)('the %s query is token-identical to FSER’s', (table) => {
    const fserMatches = findByTable(sqlLiterals(FSER_MODULE), table)
    const w7Matches = findByTable(sqlLiterals(W7_RESOLVER), table)

    // Exactly one query per table on each side — if either grew a second one,
    // "the query" is ambiguous and the pin would be comparing an arbitrary pick.
    expect(fserMatches, `FSER should have exactly one ${table} query`).toHaveLength(1)
    expect(w7Matches, `the resolver should have exactly one ${table} query`).toHaveLength(1)

    expect(normaliseSql(w7Matches[0])).toBe(normaliseSql(fserMatches[0]))
  })

  it('the pin is layout-insensitive but NOT content-insensitive (control on the normaliser)', () => {
    const fser = findByTable(sqlLiterals(FSER_MODULE), 'attendance_group_members')[0]
    const w7 = findByTable(sqlLiterals(W7_RESOLVER), 'attendance_group_members')[0]

    // Layout: the two really do differ in raw bytes, and only in whitespace.
    // This is the fact that makes "byte-for-byte" unachievable and is asserted
    // rather than asserted-about.
    expect(w7).not.toBe(fser)
    expect(w7.replace(/\s/g, '')).toBe(fser.replace(/\s/g, ''))

    // Content: dropping the ORDER BY — the exact fidelity drift a reviewer
    // flagged as behaviourally inert but a real divergence — must NOT survive
    // normalisation.
    const withoutOrderBy = normaliseSql(w7).replace(' ORDER BY user_id ASC', '')
    expect(withoutOrderBy).not.toBe(normaliseSql(fser))

    // ...and a renamed column must not survive either.
    const renamed = normaliseSql(w7).replace('user_id', 'usr_id')
    expect(renamed).not.toBe(normaliseSql(fser))
  })

  it('the resolver header describes what is enforced, and no longer claims a byte-for-byte pin', () => {
    // The header and this test are two halves of one claim; pinning the
    // wording here is what stops them drifting apart again.
    const header = fs.readFileSync(path.join(REPO_ROOT, W7_RESOLVER), 'utf8')
    expect(header).not.toContain('byte-for-byte')
    expect(header).toContain('attendance-w7-1a-fser-query-parity.test.ts')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGGREGATE_ROUTE_ENTRY_FILE,
  AGGREGATE_ROUTE_ENTRY_PATH,
  buildAggregateCallPathClosure,
  collectQuerySqlArguments,
  extractRouteHandlerSource,
  findRepoRoot,
  pluginLibFilesInClosure,
} from '../helpers/attendance-w6-call-path-closure'

/**
 * W6-R1 — GET-only, zero writes: STATIC leg.
 *
 * What this file used to claim and could not deliver, recorded so the claim is
 * not quietly re-made: its header said "static DML sweep over the whole
 * aggregate CALL PATH" and "the primary, unfoolable proof is behavioral", while
 * `SWEPT_FILES` was a hand-list of TWO files and the detector was literal text.
 * Two independent probes walked through it:
 *   - DML injected into `canReadAttendanceDirectoryReadiness` — called from
 *     inside the route block, DECLARED outside it — wrote 130 rows with the
 *     sweep green;
 *   - `deps.query('IN' + "SERT INTO …")` inside the MOST-swept file wrote 6
 *     rows with the sweep green.
 * Those are two independent defects: the DOMAIN and the DETECTOR. Fixing one
 * does not close W6-R1.
 *
 * DOMAIN — derived, not listed. `tests/helpers/attendance-w6-call-path-closure.ts`
 * starts at the route registration block (anchored on the route's own path
 * literal) and expands transitively over DECLARATIONS: same-file declarations,
 * relative imports, and `requirePluginAttendanceLib` literals into the plugin
 * `lib/` CJS modules (declaration-by-declaration there too, keyed on the
 * properties actually read). Three legs below, because two are not enough:
 * `unclaimed = 0`, a non-empty-domain floor, and an OFF-PATH NEGATIVE — without
 * the third, "sweep the whole repo" satisfies the first two trivially.
 *
 * DETECTOR — refuses what it cannot sweep. Every `query(...)` first argument is
 * classified: a literal is swept, a STRING-COMPOSED expression is a FINDING,
 * and a pass-through identifier is recorded (the generic pg adapter authors no
 * SQL and its callers are themselves in the closure).
 *
 * SCOPE, stated narrowly rather than inflated: this is a STATIC leg. It proves
 * no reachable declaration contains a DML verb or unsweepable SQL. The
 * behavioural leg lives in
 * `tests/integration/attendance-w6-group-effective-policy.db.test.ts` — and
 * under the phase-1 scope fence that file is NOT CI-wired and is reported
 * skipped in the default no-DB lane, so on this branch W6-R1's behavioural
 * proof does not execute in any required check. That is a disclosure, not a
 * caveat to be read past.
 */

const repoRoot = findRepoRoot(__dirname)
const closure = buildAggregateCallPathClosure(repoRoot)
const sqlArguments = collectQuerySqlArguments(closure, repoRoot)

// Raw-SQL DML verbs (word-boundary, case-insensitive).
const RAW_SQL_DML = [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w/i, /\bDELETE\s+FROM\b/i, /\bMERGE\s+INTO\b/i, /\bTRUNCATE\b/i]
// Kysely query-builder DML entry points (this house's writer-audit rule
// requires BOTH syntaxes to be swept).
const KYSELY_DML = [/\.insertInto\s*\(/, /\.updateTable\s*\(/, /\.deleteFrom\s*\(/, /\.replaceInto\s*\(/]

/** Files that MUST be in any honest "aggregate call path" domain. The list is
 * a FLOOR the derivation has to clear, not the domain itself — the domain is
 * whatever the closure computes. Both entries below are files the previous
 * hand-list omitted and a probe wrote through. */
const REQUIRED_IN_DOMAIN = [
  'packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts',
  'packages/core-backend/src/attendance/w6-group-effective-policy-response-contract.ts',
  'packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts',
  'packages/core-backend/src/routes/attendance-admin.ts',
  'packages/core-backend/src/util/resolve-plugin-attendance-lib.ts',
  'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs',
]

/** Files that must NOT be in the domain: real repo files, on no path from this
 * route. Without this leg a trivially over-wide domain passes everything. */
const MUST_BE_OFF_PATH = [
  'packages/core-backend/src/routes/api-tokens.ts',
  'packages/core-backend/src/services/AttendanceCalculationGroupMembership.ts',
  'plugins/plugin-attendance/index.cjs',
]

describe('W6-R1 static leg — the swept DOMAIN is derived and complete', () => {
  it('LEG 1 (unclaimed = 0): every file that must be on the path IS in the derived closure', () => {
    const unclaimed = REQUIRED_IN_DOMAIN.filter((file) => !closure.files.includes(file))
    expect(unclaimed).toEqual([])
  })

  it('LEG 2 (non-empty domain): the closure is substantial — an empty scan is not an absence', () => {
    expect(closure.files.length).toBeGreaterThanOrEqual(15)
    expect(closure.units.length).toBeGreaterThanOrEqual(100)
    // And it really reached through the plugin-lib require seam.
    expect(pluginLibFilesInClosure(closure).length).toBeGreaterThanOrEqual(2)
  })

  it('LEG 3 (off-path negative): real repo files that are NOT on this route are absent', () => {
    // Non-vacuity first: the named files must actually exist, or "absent from
    // the closure" would be true for the boring reason.
    for (const file of MUST_BE_OFF_PATH) {
      expect(readFileSync(join(repoRoot, file), 'utf8').length).toBeGreaterThan(100)
    }
    const wronglyIncluded = MUST_BE_OFF_PATH.filter((file) => closure.files.includes(file))
    expect(wronglyIncluded).toEqual([])
  })

  it('the plugin-lib CJS modules enter DECLARATION-BY-DECLARATION, not whole-file', () => {
    // `attendance-shift-service.cjs` is on the path only because the route
    // reads ONE constant from it; the module also contains genuine
    // `INSERT INTO attendance_shift_segments` / `DELETE FROM …` writers on
    // paths the aggregate never executes. Whole-file expansion would red this
    // guard on code that is not on the call path.
    const shiftServiceUnits = closure.units.filter((unit) => unit.file.endsWith('attendance-shift-service.cjs'))
    expect(shiftServiceUnits.map((unit) => unit.name)).toEqual(['SEGMENT_CALCULATION_IMPLEMENTED'])
    // Positive control that the exclusion is real and not a mis-parse: the
    // whole module DOES contain DML the closure deliberately does not carry.
    const wholeModule = readFileSync(
      join(repoRoot, 'plugins/plugin-attendance/lib/attendance-shift-service.cjs'),
      'utf8',
    )
    expect(RAW_SQL_DML.some((pattern) => pattern.test(wholeModule))).toBe(true)
  })

  it('the route-block extraction is anchored to the route path, not a line number', () => {
    const text = readFileSync(join(repoRoot, AGGREGATE_ROUTE_ENTRY_FILE), 'utf8')
    const block = extractRouteHandlerSource(text, 'get', AGGREGATE_ROUTE_ENTRY_PATH)
    const shifted = '// unrelated leading comment\n'.repeat(50) + text
    expect(extractRouteHandlerSource(shifted, 'get', AGGREGATE_ROUTE_ENTRY_PATH)).toEqual(block)
    // Landed on the RIGHT route and captured its full body.
    expect(block).toContain('attendanceGroupEffectivePolicyAggregateService.getAggregate')
    expect(block).toContain('QUERY_NOT_ACCEPTED')
    expect(block).toContain('BODY_NOT_ACCEPTED')
    expect(block.length).toBeGreaterThan(500)
  })
})

describe('W6-R1 static leg — zero DML anywhere in the derived closure', () => {
  it('no reachable declaration contains a raw-SQL DML verb', () => {
    const offenders = closure.units
      .filter((unit) => RAW_SQL_DML.some((pattern) => pattern.test(unit.text)))
      .map((unit) => `${unit.file}::${unit.name}`)
    expect(offenders).toEqual([])
  })

  it('no reachable declaration contains a kysely DML call', () => {
    const offenders = closure.units
      .filter((unit) => KYSELY_DML.some((pattern) => pattern.test(unit.text)))
      .map((unit) => `${unit.file}::${unit.name}`)
    expect(offenders).toEqual([])
  })

  it('positive control: the DML detector DOES fire on a synthetic write injected into the real route block', () => {
    const text = readFileSync(join(repoRoot, AGGREGATE_ROUTE_ENTRY_FILE), 'utf8')
    const block = extractRouteHandlerSource(text, 'get', AGGREGATE_ROUTE_ENTRY_PATH)
    const poisoned = block.replace(
      'attendanceGroupEffectivePolicyAggregateService.getAggregate',
      "await query(`UPDATE attendance_groups SET updated_at = now() WHERE id = $1`); attendanceGroupEffectivePolicyAggregateService.getAggregate",
    )
    expect(poisoned).not.toEqual(block)
    expect(RAW_SQL_DML.some((pattern) => pattern.test(poisoned))).toBe(true)
  })
})

describe('W6-R1 static leg — every reachable query() argument is sweepable', () => {
  it('zero STRING-COMPOSED SQL arguments (the class that defeated the literal-text detector)', () => {
    expect(sqlArguments.composed).toEqual([])
  })

  it('every resolved SQL literal is a SELECT, or one of the three transaction-control keywords', () => {
    expect(sqlArguments.resolved.length).toBeGreaterThan(0) // non-vacuity
    // BEGIN/COMMIT/ROLLBACK come from the generic pool's transaction helper and
    // write nothing by themselves. They are named as a CLOSED set rather than
    // waved through as "not SELECT but fine": anything else non-SELECT is a
    // finding, and the DML legs above run over the same units regardless.
    const TRANSACTION_CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK'])
    const offenders = sqlArguments.resolved
      .filter((entry) => {
        const sql = entry.sql.trim().toUpperCase()
        return !sql.startsWith('SELECT') && !TRANSACTION_CONTROL.has(sql)
      })
      .map((entry) => `${entry.file}: ${entry.sql.slice(0, 80)}`)
    expect(offenders).toEqual([])
  })

  it('the pass-through sites are the generic pg adapter only, and are disclosed rather than exempted silently', () => {
    // Deliberately asserted as a SHAPE, not a count: the adapter forwards SQL
    // authored by its callers, and those callers are themselves in the
    // closure, so their literals are swept at the authoring site.
    const files = [...new Set(sqlArguments.passthrough.map((entry) => entry.file))].sort()
    expect(files).toEqual([
      'packages/core-backend/src/db/pg.ts',
      'packages/core-backend/src/integration/db/connection-pool.ts',
      'packages/core-backend/src/routes/attendance-admin.ts',
    ])
  })

  it('positive control: a composed SQL argument in the SAME shape as the probe that beat the old detector IS flagged', () => {
    // The probe was `deps.query('IN' + "SERT INTO attendance_schedule_groups …")`
    // injected into the aggregate module — the most-swept file — and the old
    // literal-text sweep stayed green while 6 rows were written. Re-run the
    // detector over a synthetic unit carrying exactly that shape.
    const synthetic = {
      files: ['synthetic.ts'],
      units: [
        {
          file: 'synthetic.ts',
          name: 'probe',
          text: `async function probe() { await deps.query('IN' + "SERT INTO attendance_schedule_groups (org_id) VALUES ($1)", [orgId]) }`,
        },
      ],
      externals: [],
    }
    const result = collectQuerySqlArguments(synthetic, repoRoot)
    expect(result.composed.length).toBe(1)
    expect(result.resolved).toEqual([])
    // And the same shape with a plain literal is NOT flagged, so "composed"
    // is discriminating rather than "anything with a query() call".
    const clean = {
      files: ['synthetic.ts'],
      units: [
        {
          file: 'synthetic.ts',
          name: 'probe',
          text: 'async function probe() { await deps.query(`SELECT 1 FROM attendance_groups`, []) }',
        },
      ],
      externals: [],
    }
    const cleanResult = collectQuerySqlArguments(clean, repoRoot)
    expect(cleanResult.composed).toEqual([])
    expect(cleanResult.resolved.length).toBe(1)
  })
})

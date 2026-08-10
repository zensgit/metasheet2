import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGGREGATE_ROUTE_ENTRY_FILE,
  AGGREGATE_ROUTE_ENTRY_PATH,
  buildAggregateCallPathClosure,
  checkPassThroughCallers,
  collectQuerySqlArguments,
  extractRouteHandlerSource,
  findRepoRoot,
  pluginLibFilesInClosure,
  type CallPathClosure,
} from '../helpers/attendance-w6-call-path-closure'

/**
 * W6-R1 — GET-only, zero writes: static leg.
 *
 * W6-R1's red line is "the aggregate performs zero writes", proved by two
 * legs: this static one, and the behavioural one in
 * `tests/integration/attendance-w6-group-effective-policy.db.test.ts` (plus
 * `…-membership-overlap.db.test.ts`), which raises the read-only transaction
 * against a real write and asserts the raise.
 *
 * Domain — derived, not listed. `tests/helpers/attendance-w6-call-path-closure.ts`
 * starts at the route registration block (anchored on the route's own path
 * literal) and expands transitively over declarations: same-file declarations,
 * relative imports, and `requirePluginAttendanceLib` literals into the plugin
 * `lib/` CJS modules (declaration-by-declaration there too, keyed on the
 * properties actually read). Three legs below, because two are not enough:
 * `unclaimed = 0`, a non-empty-domain floor, and an off-path negative —
 * without the third, "sweep the whole repo" satisfies the first two trivially.
 *
 * Detector — refuses what it cannot sweep, and exempts no file. Every DB-seam
 * argument is `resolved` (a literal), `passthrough` (a named adapter's own
 * formal parameter, forwarded, with a non-empty and fully-classified caller
 * set), or a finding. There is no fourth bucket and no file allowlist.
 *
 * Scope, stated narrowly rather than inflated: this is a static leg over
 * source text. It proves no reachable declaration contains a DML verb and no
 * reachable DB seam receives SQL the sweep cannot account for. It is not the
 * mechanism of record for W6-R1 — the read-only transaction
 * (`createAttendanceGroupEffectivePolicyReadOnlyService` in
 * `src/routes/attendance-admin.ts`) is; this sweep is a second, independent
 * leg.
 */

const repoRoot = findRepoRoot(__dirname)
const closure = buildAggregateCallPathClosure(repoRoot)
const sqlArguments = collectQuerySqlArguments(closure, repoRoot)
const callerReports = checkPassThroughCallers(closure, repoRoot, sqlArguments)

// Raw-SQL DML verbs (word-boundary, case-insensitive).
const RAW_SQL_DML = [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w/i, /\bDELETE\s+FROM\b/i, /\bMERGE\s+INTO\b/i, /\bTRUNCATE\b/i]
// Kysely query-builder DML entry points (this house's writer-audit rule
// requires BOTH syntaxes to be swept).
const KYSELY_DML = [/\.insertInto\s*\(/, /\.updateTable\s*\(/, /\.deleteFrom\s*\(/, /\.replaceInto\s*\(/]

/** Files that MUST be in any honest "aggregate call path" domain. The list is
 * a FLOOR the derivation has to clear, not the domain itself — the domain is
 * whatever the closure computes. */
const REQUIRED_IN_DOMAIN = [
  'packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts',
  'packages/core-backend/src/attendance/w6-group-effective-policy-response-contract.ts',
  'packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts',
  'packages/core-backend/src/routes/attendance-admin.ts',
  'packages/core-backend/src/util/resolve-plugin-attendance-lib.ts',
  // The READ ONLY transaction seam the aggregate now runs inside. If this
  // stops being reachable from the route, the backstop has been unwired.
  'packages/core-backend/src/services/AttendanceSetupReadinessAggregate.ts',
  'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs',
]

/** Files that must NOT be in the domain: real repo files, on no path from this
 * route. Without this leg a trivially over-wide domain passes everything. */
const MUST_BE_OFF_PATH = [
  'packages/core-backend/src/routes/api-tokens.ts',
  'packages/core-backend/src/services/AttendanceCalculationGroupMembership.ts',
  'plugins/plugin-attendance/index.cjs',
]

/** Builds a one-unit synthetic closure so a candidate shape can be classified
 *  in isolation. `file` is a real repo path on purpose in the battery below:
 *  the point being proved is that file identity buys nothing. */
function syntheticClosure(file: string, name: string, text: string): CallPathClosure {
  return { files: [file], units: [{ file, name, text }], externals: [] }
}

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
    expect(block).toContain('createAttendanceGroupEffectivePolicyReadOnlyService')
    expect(block).toContain('QUERY_NOT_ACCEPTED')
    expect(block).toContain('BODY_NOT_ACCEPTED')
    expect(block.length).toBeGreaterThan(500)
  })
})

/**
 * `canReadAttendanceDirectoryReadiness` (declared in the route file itself,
 * on the seed path) short-circuits on `isRbacAdmin(userId)` —
 * `rbac/service.ts`'s `isAdmin`, imported under that alias — BEFORE it ever
 * reaches the injected `readOnlyQuery`. That call runs on the shared pool,
 * not on this route's own read-only transaction handle, so this closure —
 * reached through the relative-import expansion the walker already
 * performs — is the mechanism that keeps it inside W6-R1's "no write
 * anywhere on the call path" claim.
 *
 * `REQUIRED_IN_DOMAIN` above pins `rbac/service.ts` at FILE granularity;
 * that alone is not enough, because a different declaration in the same
 * file (`userHasPermission`) could keep the FILE in-domain even if THIS
 * declaration's own reachability broke. This block pins the declaration
 * itself — narrower than a file floor, not a whole-file scan: everything
 * here operates on `isAdmin`'s own extracted unit text, never on
 * `rbac/service.ts`'s full source.
 */
describe('W6-R1 static leg — the platform-admin short-circuit (rbac/service.ts::isAdmin) is pinned by DECLARATION', () => {
  const ISADMIN_FILE = 'packages/core-backend/src/rbac/service.ts'
  const isAdminUnit = closure.units.find((unit) => unit.file === ISADMIN_FILE && unit.name === 'isAdmin')

  it('the declaration is reachable in the closure — a future refactor that drops it fails here, not by the domain silently shrinking', () => {
    expect(isAdminUnit).toBeDefined()
  })

  it('its DB seam is a SELECT', () => {
    const resolved = sqlArguments.resolved.find((entry) => entry.file === ISADMIN_FILE && entry.unit === 'isAdmin')
    expect(resolved).toBeDefined()
    expect(resolved?.sql.trim().toUpperCase().startsWith('SELECT')).toBe(true)
  })

  it('EXECUTED positive control: a single-write mutation at that exact seam is caught by both the DML-verb leg and the SELECT-only leg', () => {
    const original = (isAdminUnit as { text: string }).text
    const needle = 'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1'
    expect(original).toContain(needle)
    const mutated = original.replace(needle, 'UPDATE user_roles SET role_id = $2 WHERE user_id = $1')
    expect(mutated).not.toEqual(original)

    // Non-vacuity: the write really is there — this is what the "no raw-SQL
    // DML verb" leg below sweeps for.
    expect(RAW_SQL_DML.some((pattern) => pattern.test(mutated))).toBe(true)

    // A synthetic ONE-UNIT closure carrying only the mutated declaration —
    // not a whole-file re-scan — run through the SAME classifier the real
    // legs use.
    const mutatedClosure = syntheticClosure(ISADMIN_FILE, 'isAdmin', mutated)
    const mutatedArgs = collectQuerySqlArguments(mutatedClosure, repoRoot)
    expect(mutatedArgs.findings).toEqual([])
    expect(mutatedArgs.resolved.length).toBe(1)
    // The exact predicate the "every resolved SQL literal is a SELECT" leg
    // checks over the whole closure: on the REAL (unmutated) closure this
    // seam passes it; mutated, it does not.
    expect(mutatedArgs.resolved[0].sql.trim().toUpperCase().startsWith('SELECT')).toBe(false)
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
      'const aggregate = await runAttendanceSetupReadinessReadOnly',
      "await query(`UPDATE attendance_groups SET updated_at = now() WHERE id = $1`); const aggregate = await runAttendanceSetupReadinessReadOnly",
    )
    expect(poisoned).not.toEqual(block)
    expect(RAW_SQL_DML.some((pattern) => pattern.test(poisoned))).toBe(true)
  })
})

describe('W6-R3 static leg — every AGGREGATE-authored read is org-scoped', () => {
  /**
   * The module header claims "every query it issues carries an `org_id`
   * predicate". Absolute claims about this codebase are swept mechanically,
   * not asserted in prose, so this checks every SQL literal the derived
   * closure attributes to the aggregate module directly rather than probing
   * behaviour: `shiftId` reaches the shift-scoped reads only from
   * `fser.desired.shiftId`, and a composite `(shift_id, org_id)` FK already
   * guarantees same-org, so a behavioural probe of dropping the predicate
   * would change no observable output — a static, textual check is the only
   * discriminating one here.
   */
  const aggregateSql = sqlArguments.resolved.filter((entry) =>
    entry.file.endsWith('w6-group-effective-policy-aggregate.ts'),
  )

  it('non-vacuity: the aggregate really does author several SQL literals', () => {
    expect(aggregateSql.length).toBeGreaterThanOrEqual(8)
  })

  it('every one of them names org_id in its predicate', () => {
    const unscoped = aggregateSql
      .filter((entry) => !/\borg_id\b/i.test(entry.sql))
      .map((entry) => entry.sql.replace(/\s+/g, ' ').slice(0, 100))
    expect(unscoped).toEqual([])
  })

  it('positive control: the check DOES reject an unscoped read', () => {
    const unscoped = { file: 'w6-group-effective-policy-aggregate.ts', sql: 'SELECT flex_mode FROM attendance_shifts WHERE id = $1 LIMIT 1' }
    expect(/\borg_id\b/i.test(unscoped.sql)).toBe(false)
  })
})

describe('W6-R1 static leg — every reachable DB-seam argument is accounted for', () => {
  it('the sweep REFUSES nothing today: findings is empty', () => {
    // The headline. `findings` is the bucket for "SQL this sweep cannot
    // account for" — composed strings, helper-authored strings, anonymous
    // adapters, callees it cannot see. A non-empty list is a failure of the
    // static leg, never something to be waved through.
    expect(sqlArguments.findings.map((entry) => `${entry.file} :: ${entry.snippet} — ${entry.reason}`)).toEqual([])
  })

  it('non-vacuity: the sweep really did classify a substantial number of DB-seam sites', () => {
    expect(sqlArguments.resolved.length).toBeGreaterThanOrEqual(20)
    expect(sqlArguments.passthrough.length).toBeGreaterThanOrEqual(3)
  })

  it('every resolved SQL literal is a SELECT, or one of the four transaction-control statements', () => {
    // Named as a CLOSED set rather than waved through as "not SELECT but
    // fine". `SET TRANSACTION READ ONLY` is the W6-R1 backstop's own first
    // statement; BEGIN/COMMIT/ROLLBACK come from the generic pool's
    // transaction helper. None of them writes. Anything else non-SELECT is a
    // finding, and the DML legs above run over the same units regardless.
    const TRANSACTION_CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SET TRANSACTION READ ONLY'])
    const offenders = sqlArguments.resolved
      .filter((entry) => {
        const sql = entry.sql.trim().toUpperCase()
        return !sql.startsWith('SELECT') && !TRANSACTION_CONTROL.has(sql)
      })
      .map((entry) => `${entry.file}: ${entry.sql.slice(0, 80)}`)
    expect(offenders).toEqual([])
  })

  it('the pool `query` is still in scope in the route file, so the transaction is not a whole-process write block — this leg covers writes routed around the handle', () => {
    /**
     * PostgreSQL refuses writes on the transaction's handle, not on the
     * process. `attendance-admin.ts` still imports the pool `query` for its
     * many other routes, and a call-path helper that reaches for that
     * instead of the injected `runQuery` never touches the transaction — so
     * this static sweep is what covers a write routed through the pool
     * instead of the handle, and the read-only transaction is what covers a
     * write routed through the handle regardless of how it was composed.
     * Neither leg substitutes for the other.
     */
    const routeText = readFileSync(join(repoRoot, AGGREGATE_ROUTE_ENTRY_FILE), 'utf8')
    // Non-vacuity: the pool import really is there. If it ever goes away the
    // claim above changes and this leg should be revisited, not deleted.
    expect(routeText).toContain("import { query } from '../db/pg'")

    // And the sweep really does catch a pool-routed write planted in a
    // call-path declaration — both by DML text and by the SELECT-only
    // predicate over resolved literals.
    const poolWrite = "async function probe() { await query(`INSERT INTO attendance_schedule_groups (org_id, name, source, is_active) VALUES ('x','y','manual',false)`) }"
    expect(RAW_SQL_DML.some((pattern) => pattern.test(poolWrite))).toBe(true)
    const classified = collectQuerySqlArguments(
      syntheticClosure(AGGREGATE_ROUTE_ENTRY_FILE, 'pool-routed write', poolWrite),
      repoRoot,
    )
    expect(classified.findings).toEqual([])
    expect(classified.resolved.length).toBe(1)
    expect(classified.resolved[0].sql.trim().toUpperCase().startsWith('SELECT')).toBe(false)
  })

  it('the READ ONLY backstop is statically ON the route path (its own literal is in the swept set)', () => {
    // A structural backstop that is not reachable from the route is not a
    // backstop. This is the static half of that claim; the behavioural half
    // (a write RAISES 25006 on the shared handle) is in the real-DB suite.
    const readOnly = sqlArguments.resolved.filter((entry) => entry.sql.trim().toUpperCase() === 'SET TRANSACTION READ ONLY')
    expect(readOnly.length).toBe(1)
    expect(readOnly[0].file).toBe('packages/core-backend/src/services/AttendanceSetupReadinessAggregate.ts')
  })

  it('every pass-through is a NAMED adapter forwarding its OWN first formal parameter', () => {
    // The narrowed definition, asserted as a SHAPE over every entry — not as
    // a list of blessed files. `paramIndex === 0` is load-bearing: a
    // "pass-through" that forwards some OTHER parameter into the SQL position
    // is a shape nobody has justified, and an earlier revision of the
    // classifier silently produced exactly that (index 1, `params`) because
    // its local lookup ignored scope.
    const shapes = sqlArguments.passthrough.map((entry) => ({
      adapterName: entry.adapterName,
      paramIndex: entry.paramIndex,
      named: entry.adapterName.length > 0,
    }))
    expect(shapes.every((shape) => shape.named)).toBe(true)
    expect(shapes.every((shape) => shape.paramIndex === 0)).toBe(true)
    // And every entry names the parameter it actually traced to.
    expect(sqlArguments.passthrough.every((entry) => entry.provenanceLeaf.length > 0)).toBe(true)
  })

  it('every pass-through adapter has a NON-EMPTY, fully-classified caller set inside the closure', () => {
    // Requirement (5). Two failure modes, both asserted: a pass-through whose
    // adapter has zero callers in the closure is the empty-read trap (it
    // proves nothing about where its SQL comes from), and a caller that
    // passes something unclassifiable at that position is a hole in the
    // justification.
    expect(callerReports.length).toBeGreaterThan(0)
    expect(callerReports.filter((report) => report.callerCount === 0)).toEqual([])
    const holes = callerReports.flatMap((report) =>
      report.unclassifiedCallers.map((caller) => `${report.adapterName}#${report.paramIndex} <- ${caller.file}: ${caller.snippet} — ${caller.reason}`),
    )
    expect(holes).toEqual([])
  })
})

describe('W6-R1 static leg — no file is exempt as a file (composition/provenance shapes the sweep must refuse)', () => {
  /**
   * Every case below is planted in `src/routes/attendance-admin.ts`, and every
   * one must be a finding. If any of these goes back to passing, a whole-file
   * exemption has been reintroduced under another name.
   */
  const ROUTE_FILE = AGGREGATE_ROUTE_ENTRY_FILE

  function classifyIn(text: string, name = 'probe'): ReturnType<typeof collectQuerySqlArguments> {
    return collectQuerySqlArguments(syntheticClosure(ROUTE_FILE, name, text), repoRoot)
  }

  it('a module-scope helper returning composed SQL, called as query(helper()), is refused', () => {
    const result = classifyIn(
      `async function handler(req, res) { await query(buildAttendanceGroupTouchSql()) }`,
    )
    expect(result.resolved).toEqual([])
    expect(result.passthrough).toEqual([])
    expect(result.findings.length).toBe(1)
    expect(result.findings[0].reason).toMatch(/no formal-parameter provenance/)
  })

  it('the same shape spliced into the real route handler text is refused', () => {
    // Stronger than a hand-written stand-in: this is the actual registration
    // block off disk, with the composed-SQL call inserted where a real call would sit.
    const text = readFileSync(join(repoRoot, ROUTE_FILE), 'utf8')
    const block = extractRouteHandlerSource(text, 'get', AGGREGATE_ROUTE_ENTRY_PATH)
    const poisoned = block.replace(
      'const aggregate = await runAttendanceSetupReadinessReadOnly',
      'await query(buildAttendanceGroupTouchSql()); const aggregate = await runAttendanceSetupReadinessReadOnly',
    )
    expect(poisoned).not.toEqual(block)
    // Baseline: the UNPOISONED real block refuses nothing.
    expect(classifyIn(block, '<route registration block>').findings).toEqual([])
    const result = classifyIn(poisoned, '<route registration block>')
    expect(result.findings.length).toBe(1)
    // The route handler is an anonymous arrow passed to `r.get(...)`, so this
    // shape reds on the anonymity of its adapter as well as on provenance.
    expect(result.findings[0].reason).toMatch(/anonymous enclosing function|no formal-parameter provenance/)
  })

  it('query(factory()) inline is refused', () => {
    const result = classifyIn(`async function handler(req, res) { await query(makeSql()) }`)
    expect(result.findings.length).toBe(1)
    expect(result.passthrough).toEqual([])
  })

  it('a two-hop helper routed through local variables is refused', () => {
    const result = classifyIn(
      `async function handler(req, res) {
         const fragment = makeFragment()
         const sql = wrap(fragment)
         await query(sql)
       }`,
    )
    expect(result.findings.length).toBe(1)
    expect(result.passthrough).toEqual([])
  })

  it('a helper imported from another module is refused', () => {
    // `importedBuilder` has no declaration inside the swept unit, so there is
    // nothing for the DML legs to sweep — refused rather than assumed benign.
    const result = classifyIn(
      `async function handler(req, res) { const sql = importedBuilder(req.params.groupId); await query(sql) }`,
    )
    expect(result.findings.length).toBe(1)
    expect(result.passthrough).toEqual([])
  })

  it('a write reached through requirePluginAttendanceLib into the plugin CJS lib is refused', () => {
    // Two halves. (a) a LITERAL write inside the lib is caught by the DML
    // legs — proven here on the real detector; (b) an obfuscated write at the
    // lib's own db seam is a FINDING.
    const literalWrite = `async function touch(db, orgId) { await db.query('INSERT INTO attendance_groups (org_id) VALUES ($1)', [orgId]) }`
    expect(RAW_SQL_DML.some((pattern) => pattern.test(literalWrite))).toBe(true)
    const obfuscated = collectQuerySqlArguments(
      syntheticClosure(
        'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs',
        'touch',
        `async function touch(db, orgId) { await db.query(buildTouchSql(orgId)) }`,
      ),
      repoRoot,
    )
    expect(obfuscated.findings.length).toBe(1)
    expect(obfuscated.passthrough).toEqual([])
  })

  it('a directly string-composed argument is refused', () => {
    // `deps.query('IN' + "SERT INTO …")`: a regression check so a rewrite of
    // the classifier cannot silently drop this case.
    const result = collectQuerySqlArguments(
      syntheticClosure(
        'packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts',
        'probe',
        `async function probe() { await deps.query('IN' + "SERT INTO attendance_schedule_groups (org_id) VALUES ($1)", [orgId]) }`,
      ),
      repoRoot,
    )
    expect(result.findings.length).toBe(1)
    expect(result.findings[0].reason).toMatch(/string-composed/)
    expect(result.resolved).toEqual([])
  })

  it('composition with real parameter provenance is still refused (the veto overrides provenance)', () => {
    // `query('IN' + suffix)` where `suffix` IS a formal parameter would satisfy
    // provenance on its own. It must still red, or the provenance rule becomes
    // a way to launder concatenation.
    const result = classifyIn(`async function adapter(suffix) { await query('IN' + suffix) }`)
    expect(result.findings.length).toBe(1)
    expect(result.findings[0].reason).toMatch(/string-composed/)
  })

  it('an anonymous adapter cannot be a pass-through (no caller set is checkable)', () => {
    const result = classifyIn(`const handlers = [async (sql) => { await query(sql) }]`)
    expect(result.findings.length).toBe(1)
    expect(result.findings[0].reason).toMatch(/anonymous enclosing function/)
  })

  it('DISCRIMINATION: the legitimate adapter shape is NOT a finding', () => {
    // Without this the battery above would be satisfied by a classifier that
    // simply refuses everything, which would be a useless test that looks
    // identical to a working one.
    const result = classifyIn(`async function runSql(sql, params) { return query(sql, params) }`)
    expect(result.findings).toEqual([])
    expect(result.passthrough.length).toBe(1)
    expect(result.passthrough[0].adapterName).toBe('runSql')
    expect(result.passthrough[0].paramIndex).toBe(0)
    expect(result.passthrough[0].provenanceLeaf).toBe('sql')
  })

  it('DISCRIMINATION: a plain literal in the same position is resolved, not refused', () => {
    const result = classifyIn('async function probe() { await deps.query(`SELECT 1 FROM attendance_groups`, []) }')
    expect(result.findings).toEqual([])
    expect(result.resolved.length).toBe(1)
    expect(result.resolved[0].sql).toBe('SELECT 1 FROM attendance_groups')
  })

  it('the caller-set check DOES fail a pass-through whose only caller launders SQL', () => {
    // Positive control for requirement (5) specifically: the adapter itself is
    // a textbook pass-through, and it is the CALLER that is dirty. Without
    // this leg, requirement (5) could be permanently vacuous and look green.
    const text = `
      async function runSql(sql, params) { return query(sql, params) }
      async function handler(req) { return runSql(buildTouchSql(req.params.groupId), []) }
    `
    const probeClosure = syntheticClosure(ROUTE_FILE, 'probe', text)
    const args = collectQuerySqlArguments(probeClosure, repoRoot)
    expect(args.passthrough.length).toBe(1)
    expect(args.passthrough[0].adapterName).toBe('runSql')
    const reports = checkPassThroughCallers(probeClosure, repoRoot, args)
    const runSqlReport = reports.find((report) => report.adapterName === 'runSql')
    expect(runSqlReport?.callerCount).toBe(1)
    expect(runSqlReport?.unclassifiedCallers.length).toBe(1)
    // The reason is requirement (4), not (1), and that is worth stating
    // exactly rather than papering over with a loose matcher. `req` IS a
    // formal parameter of `handler`, and it reaches the argument through
    // `buildTouchSql(req.params.groupId)` — so raw provenance is satisfied
    // and would have let this through on its own. What refuses it is that
    // `buildTouchSql` has no declaration inside the closure, so the DML legs
    // never see its body. Provenance alone is NOT the guarantee; the
    // conjunction is.
    expect(runSqlReport?.unclassifiedCallers[0].reason).toBe(
      'callee `buildTouchSql` is not declared inside the swept closure',
    )
  })

  it('the caller-set check DOES fail a caller whose builder IS in the closure but composes SQL', () => {
    // The sibling of the case above: requirement (4)'s second half. Here the
    // builder is right there in the unit — so "is it swept?" is satisfied —
    // and the refusal has to come from the composition veto reaching INTO the
    // callee's body, not merely inspecting the argument expression.
    const text = `
      async function runSql(sql, params) { return query(sql, params) }
      function buildTouchSql(groupId) { return 'UPD' + 'ATE attendance_groups SET updated_at = now() WHERE id = ' + groupId }
      async function handler(req) { return runSql(buildTouchSql(req.params.groupId), []) }
    `
    const probeClosure = syntheticClosure(ROUTE_FILE, 'probe', text)
    const args = collectQuerySqlArguments(probeClosure, repoRoot)
    const reports = checkPassThroughCallers(probeClosure, repoRoot, args)
    const runSqlReport = reports.find((report) => report.adapterName === 'runSql')
    expect(runSqlReport?.unclassifiedCallers.length).toBe(1)
    expect(runSqlReport?.unclassifiedCallers[0].reason).toBe('callee `buildTouchSql` composes strings in its body')
  })

  it('a chain longer than the trace depth cap fails closed, not open', () => {
    // The trace is depth-capped. A capped analysis that returned "no
    // composition found, no callee found, provenance satisfied" would be an
    // open door at exactly the depth an attacker controls. Asserted, not
    // reasoned: five hops is past the cap, and it must still be a FINDING.
    const result = classifyIn(
      `async function adapter(seed) {
         const h1 = seed
         const h2 = h1
         const h3 = h2
         const h4 = h3
         const h5 = h4
         const h6 = launder(h5)
         await query(h6)
       }`,
    )
    expect(result.passthrough).toEqual([])
    expect(result.findings.length).toBe(1)
  })

  it('the transaction-control set is CLOSED: READ WRITE is not silently accepted alongside READ ONLY', () => {
    // The backstop's own literal is the one non-SELECT statement this sweep
    // waves through. If `SET TRANSACTION READ ONLY` were ever flipped to
    // `READ WRITE`, a set that matched loosely (prefix, or "starts with SET
    // TRANSACTION") would accept the flip and the guard would report green on
    // an unwired backstop. Same predicate as the production leg, run over a
    // synthetic literal to prove it discriminates.
    const TRANSACTION_CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SET TRANSACTION READ ONLY'])
    const accepts = (sql: string): boolean => {
      const normalised = sql.trim().toUpperCase()
      return normalised.startsWith('SELECT') || TRANSACTION_CONTROL.has(normalised)
    }
    expect(accepts('SET TRANSACTION READ ONLY')).toBe(true)
    expect(accepts('SET TRANSACTION READ WRITE')).toBe(false)
    expect(accepts('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toBe(false)
  })

  it('the caller-set check DOES fail a pass-through with ZERO callers (the empty-read trap)', () => {
    const text = `async function orphanQuery(sql) { return client.query(sql) }`
    const probeClosure = syntheticClosure(ROUTE_FILE, 'probe', text)
    const args = collectQuerySqlArguments(probeClosure, repoRoot)
    expect(args.passthrough.length).toBe(1)
    const reports = checkPassThroughCallers(probeClosure, repoRoot, args)
    expect(reports.find((report) => report.adapterName === 'orphanQuery')?.callerCount).toBe(0)
  })

  it('a formal parameter that shares a name with a module-scope constant is not resolved to that constant', () => {
    /**
     * The classifier's module-scope literal-constant table is keyed by NAME
     * across every file in the closure. Consulting it before testing for a
     * nearer binding meant a textbook adapter came back as a `resolved`
     * LITERAL — SQL text the seam never receives.
     *
     * Two harms, and the second is the worse one:
     *  (a) the sweep FABRICATES SQL, which downstream legs consume as fact
     *      (the "every resolved literal is a SELECT" check here, and the
     *      real-DB suite's derived `TOUCHED_TABLES` relation set);
     *  (b) the site silently skips requirement (5) — only pass-throughs get
     *      their caller set checked, so a misread parameter is never traced
     *      back to what its callers actually pass.
     *
     * `AttendanceSetupReadinessAggregate.ts` is a REAL closure file that
     * really does declare `const ATTENDANCE_SETTINGS_KEY = 'attendance.settings'`
     * at module scope, so this collision is reproduced from live code rather
     * than invented.
     */
    const READ_ONLY_SEAM_FILE = 'packages/core-backend/src/services/AttendanceSetupReadinessAggregate.ts'
    // Non-vacuity: the constant really is there, at module scope, with that text.
    const seamSource = readFileSync(join(repoRoot, READ_ONLY_SEAM_FILE), 'utf8')
    expect(seamSource).toContain("const ATTENDANCE_SETTINGS_KEY = 'attendance.settings'")

    const probeClosure: CallPathClosure = {
      files: [ROUTE_FILE, READ_ONLY_SEAM_FILE],
      units: [{
        file: ROUTE_FILE,
        name: 'probe',
        text: 'async function runSql(ATTENDANCE_SETTINGS_KEY, params) { return query(ATTENDANCE_SETTINGS_KEY, params) }',
      }],
      externals: [],
    }
    const result = collectQuerySqlArguments(probeClosure, repoRoot)
    expect(result.resolved).toEqual([])
    expect(result.findings).toEqual([])
    expect(result.passthrough.length).toBe(1)
    expect(result.passthrough[0].adapterName).toBe('runSql')
    expect(result.passthrough[0].paramIndex).toBe(0)
    expect(result.passthrough[0].provenanceLeaf).toBe('ATTENDANCE_SETTINGS_KEY')

    // DISCRIMINATION: with NOTHING nearer binding the name, the same identifier
    // in the same position IS still resolved from the constant table. Without
    // this the fix could be "never consult the table", which would be a
    // different (and unjustified) narrowing.
    const unshadowed = collectQuerySqlArguments(
      {
        files: [ROUTE_FILE, READ_ONLY_SEAM_FILE],
        units: [{ file: ROUTE_FILE, name: 'probe', text: 'async function h() { return query(ATTENDANCE_SETTINGS_KEY) }' }],
        externals: [],
      },
      repoRoot,
    )
    expect(unshadowed.resolved.map((entry) => entry.sql)).toEqual(['attendance.settings'])
  })

  it('MEASURED RESIDUAL: DB seams reached under a name outside the `*query` pattern are NOT swept — the true boundary of this leg', () => {
    /**
     * Stated as a measurement, not as a caveat, and asserted so it cannot
     * quietly drift. Each shape below reaches a DB seam without a callee name
     * this sweep matches, so it produces NO classification at all — not a
     * pass, not a finding, nothing. Enumerating fixes for them is the failure
     * mode that produced the allowlist twice already; what bounds the residual
     * instead is stated below and is checkable.
     */
    const SHAPES: Array<[string, string]> = [
      ['local alias', 'async function h() { const q = query; await q(buildTouchSql()) }'],
      ['destructured alias', 'async function h(deps) { const { query: q } = deps; await q(buildTouchSql()) }'],
      ['element access', "async function h() { await client['query'](buildTouchSql()) }"],
      ['computed element access', 'async function h(k) { await client[k](buildTouchSql()) }'],
      ['Function.prototype.call', 'async function h() { await query.call(null, buildTouchSql()) }'],
      ['Function.prototype.apply', 'async function h() { await query.apply(null, [buildTouchSql()]) }'],
    ]
    for (const [label, text] of SHAPES) {
      const result = classifyIn(text, label)
      expect({
        label,
        resolved: result.resolved.length,
        passthrough: result.passthrough.length,
        findings: result.findings.length,
      }).toEqual({ label, resolved: 0, passthrough: 0, findings: 0 })
    }

    // BOUND 1 — evading BOTH static legs needs a split-literal composer too: a
    // plain literal write through the very same aliased seam still reds the
    // raw-SQL DML text leg, which reads unit TEXT and never looks at call shape.
    const literalThroughAlias = "async function h() { const q = query; await q('INSERT INTO attendance_groups (org_id) VALUES ($1)') }"
    expect(classifyIn(literalThroughAlias, 'literal via alias').findings.length).toBe(0)
    expect(RAW_SQL_DML.some((pattern) => pattern.test(literalThroughAlias))).toBe(true)

    // BOUND 2 — none of these shapes exists on the real call path today. If one
    // ever appears, this count moves and the assertion reds, which is the point
    // of measuring rather than conceding.
    let indirectSeamCallSites = 0
    for (const unit of closure.units) {
      // `.call`/`.apply`/`.bind` and element-access invocations, counted over
      // the SAME unit text the sweep reads.
      for (const m of unit.text.matchAll(/\.(?:call|apply|bind)\s*\(/g)) {
        void m
        indirectSeamCallSites += 1
      }
      for (const m of unit.text.matchAll(/\[[^\]\n]+\]\s*\(/g)) {
        void m
        indirectSeamCallSites += 1
      }
    }
    // The five live hits are all `Object.prototype.hasOwnProperty.call(...)` in
    // the response contract — named explicitly so a SIXTH cannot hide behind a
    // loose inequality.
    const hasOwnPropertyCalls = closure.units
      .map((unit) => [...unit.text.matchAll(/Object\.prototype\.hasOwnProperty\.call\s*\(/g)].length)
      .reduce((a, b) => a + b, 0)
    expect(hasOwnPropertyCalls).toBe(5)
    expect(indirectSeamCallSites).toBe(hasOwnPropertyCalls)
  })
})

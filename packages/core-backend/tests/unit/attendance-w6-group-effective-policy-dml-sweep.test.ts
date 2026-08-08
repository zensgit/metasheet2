/**
 * W6-R1 — GET-only, zero writes: static DML sweep over the whole aggregate
 * CALL PATH (whole-file scope for the two service files, not a positional
 * window — this repo has been burned before by "next sibling key" window
 * scans that a later addition silently escapes; see
 * `multitable-d2-sidedoor-txn-wiring.guard.test.ts`'s PROBE-1 history —
 * PLUS the route-handler block in `attendance-admin.ts`, extracted by
 * anchoring on the route's own path string and balanced-paren scanning
 * from the enclosing `r.get(...)` call, not a hand-picked line range
 * (#4814 P2-3: the route handler is part of "the aggregate call path" R1
 * governs and was previously entirely unswept — a raw `UPDATE` injected
 * there passed every existing gate).
 *
 * Both query syntaxes this house's writer-audit rule requires (raw SQL AND
 * kysely query-builder) are swept. This is the CHEAP tripwire; the primary,
 * unfoolable proof is behavioral — the real-DB integration test snapshots
 * both row COUNTS and row VERSIONS (`xmin`) across every table the
 * aggregate touches, so it also catches an in-place `UPDATE` that a
 * count-only leg cannot see
 * (`tests/integration/attendance-w6-group-effective-policy.db.test.ts`).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '../../src/attendance')
const ROUTES_DIR = join(__dirname, '../../src/routes')
const SWEPT_FILES = ['w6-group-effective-policy-aggregate.ts', 'w6-group-effective-policy-response-contract.ts']

// Raw-SQL DML verbs (word-boundary, case-insensitive).
const RAW_SQL_DML = [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w/i, /\bDELETE\s+FROM\b/i, /\bMERGE\s+INTO\b/i, /\bTRUNCATE\b/i]
// Kysely query-builder DML entry points.
const KYSELY_DML = [/\.insertInto\s*\(/, /\.updateTable\s*\(/, /\.deleteFrom\s*\(/, /\.replaceInto\s*\(/]

/**
 * Extracts the full source text of the `r.<method>(<routePath>, ...)` call
 * registering one route, DERIVED from the route's own path string (a
 * stable anchor that moves with the code) rather than a hand-picked line
 * range. `attendance-admin.ts` is a single large file with many routes —
 * legitimate writes elsewhere in it must stay out of scope, so the sweep
 * is bounded to exactly this route's registration, from `r.<method>(` to
 * its balanced closing `)` (string/template-literal-aware, so a `)`
 * inside a string or backtick body does not end the scan early).
 */
function extractRouteHandlerSource(text: string, method: string, routePath: string): string {
  const marker = `r.${method}(`
  const pathNeedle = `'${routePath}'`
  const pathIdx = text.indexOf(pathNeedle)
  if (pathIdx === -1) throw new Error(`route path literal not found: ${routePath}`)
  const callStart = text.lastIndexOf(marker, pathIdx)
  if (callStart === -1) throw new Error(`no preceding "${marker}" found before route path ${routePath}`)
  const openParenIdx = callStart + marker.length - 1
  let depth = 0
  let inString: '"' | "'" | '`' | false = false
  let i = openParenIdx
  for (; i < text.length; i += 1) {
    const c = text[i]
    if (inString) {
      if (c === '\\') { i += 1; continue }
      if (c === inString) inString = false
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) { i += 1; break }
    }
  }
  if (depth !== 0) throw new Error(`unbalanced parens extracting route handler for ${routePath}`)
  return text.slice(callStart, i)
}

const ROUTE_HANDLER_FILE = 'attendance-admin.ts'
const ROUTE_HANDLER_PATH = '/api/attendance/groups/:groupId/effective-policy'
const routeHandlerFullText = readFileSync(join(ROUTES_DIR, ROUTE_HANDLER_FILE), 'utf8')
const routeHandlerSource = extractRouteHandlerSource(routeHandlerFullText, 'get', ROUTE_HANDLER_PATH)

describe('W6-R1 — DML sweep (both query syntaxes) over the aggregate module files', () => {
  it('swept the expected file set (guards against a silently-empty scope)', () => {
    for (const file of SWEPT_FILES) {
      const text = readFileSync(join(SRC_DIR, file), 'utf8')
      expect(text.length).toBeGreaterThan(500)
    }
  })

  for (const file of SWEPT_FILES) {
    it(`${file}: zero raw-SQL DML verbs`, () => {
      const text = readFileSync(join(SRC_DIR, file), 'utf8')
      const hits = RAW_SQL_DML.filter((pattern) => pattern.test(text))
      expect(hits.map((p) => p.source)).toEqual([])
    })

    it(`${file}: zero kysely DML calls`, () => {
      const text = readFileSync(join(SRC_DIR, file), 'utf8')
      const hits = KYSELY_DML.filter((pattern) => pattern.test(text))
      expect(hits.map((p) => p.source)).toEqual([])
    })

    if (file === 'w6-group-effective-policy-aggregate.ts') {
      it(`${file}: every SQL template literal starts with SELECT (positive control — proves the sweep can see real SQL text)`, () => {
        const text = readFileSync(join(SRC_DIR, file), 'utf8')
        const templateLiterals = [...text.matchAll(/`([^`]*)`/gs)].map((m) => m[1]).filter((s) => /\bFROM\b/i.test(s))
        expect(templateLiterals.length).toBeGreaterThan(0) // positive control: SQL literals do exist here
        for (const literal of templateLiterals) {
          expect(literal.trim().toUpperCase().startsWith('SELECT')).toBe(true)
        }
      })
    }
  }
})

describe('W6-R1 — DML sweep over the route handler (#4814 P2-3: the aggregate call path, not just the service files)', () => {
  it('extracted a non-trivial, correctly-bounded route handler block (guards against a silently-empty or mis-anchored scope)', () => {
    expect(routeHandlerSource.length).toBeGreaterThan(500)
    // Proves the extraction landed on the RIGHT route (not an earlier
    // sibling that happens to share a prefix) and captured its full body.
    expect(routeHandlerSource).toContain('attendanceGroupEffectivePolicyAggregateService.getAggregate')
    expect(routeHandlerSource).toContain('QUERY_NOT_ACCEPTED')
    expect(routeHandlerSource).toContain('BODY_NOT_ACCEPTED')
  })

  it('zero raw-SQL DML verbs in the route handler block', () => {
    const hits = RAW_SQL_DML.filter((pattern) => pattern.test(routeHandlerSource))
    expect(hits.map((p) => p.source)).toEqual([])
  })

  it('zero kysely DML calls in the route handler block', () => {
    const hits = KYSELY_DML.filter((pattern) => pattern.test(routeHandlerSource))
    expect(hits.map((p) => p.source)).toEqual([])
  })

  it('positive control: the extractor + sweep DOES catch a synthetic DML string inside the extracted block (proves the detector is not vacuously passing)', () => {
    const poisoned = routeHandlerSource.replace(
      'attendanceGroupEffectivePolicyAggregateService.getAggregate',
      "await query(`UPDATE attendance_groups SET updated_at = now() WHERE id = $1`); attendanceGroupEffectivePolicyAggregateService.getAggregate",
    )
    expect(poisoned).not.toEqual(routeHandlerSource) // the replace actually matched something
    const hits = RAW_SQL_DML.filter((pattern) => pattern.test(poisoned))
    expect(hits.length).toBeGreaterThan(0)
  })

  it('extraction is anchored to the route path, not a line number: re-extracting after prepending unrelated text yields the identical block', () => {
    const shifted = '// unrelated leading comment\n'.repeat(50) + routeHandlerFullText
    const reExtracted = extractRouteHandlerSource(shifted, 'get', ROUTE_HANDLER_PATH)
    expect(reExtracted).toEqual(routeHandlerSource)
  })
})

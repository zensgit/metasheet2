/**
 * W6-R1 — GET-only, zero writes: static DML sweep over the W6-1 aggregate
 * module's OWN files (whole-file scope, not a positional window — this
 * repo has been burned before by "next sibling key" window scans that a
 * later addition silently escapes; see
 * `multitable-d2-sidedoor-txn-wiring.guard.test.ts`'s PROBE-1 history).
 *
 * Both query syntaxes this house's writer-audit rule requires (raw SQL AND
 * kysely query-builder) are swept. This is the CHEAP tripwire; the primary,
 * unfoolable proof is behavioral — the real-DB integration test asserts
 * row counts across every table the aggregate touches are byte-identical
 * before and after a full route round-trip
 * (`tests/integration/attendance-w6-group-effective-policy.db.test.ts`).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '../../src/attendance')
const SWEPT_FILES = ['w6-group-effective-policy-aggregate.ts', 'w6-group-effective-policy-response-contract.ts']

// Raw-SQL DML verbs (word-boundary, case-insensitive).
const RAW_SQL_DML = [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w/i, /\bDELETE\s+FROM\b/i, /\bMERGE\s+INTO\b/i, /\bTRUNCATE\b/i]
// Kysely query-builder DML entry points.
const KYSELY_DML = [/\.insertInto\s*\(/, /\.updateTable\s*\(/, /\.deleteFrom\s*\(/, /\.replaceInto\s*\(/]

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

/**
 * Capability-depth 1a — user-facing formula catalog guard.
 * The catalog (FORMULA_FUNCTION_DOCS) is the picker/autocomplete source and was drifting from the
 * engine (#2930 added the math functions but not their catalog docs). This locks: every entry is
 * well-formed + uniquely named, and the full 1a scalar set is present under the right categories.
 */
import { describe, it, expect } from 'vitest'
import { FORMULA_FUNCTION_DOCS, FORMULA_FUNCTION_CATEGORIES } from '../src/multitable/utils/formula-docs'

describe('formula catalog — 1a scalar expansion', () => {
  it('every catalog entry is well-formed and uniquely named', () => {
    const seen = new Set<string>()
    const validCategories = new Set(FORMULA_FUNCTION_CATEGORIES.map((c) => c.id))
    for (const doc of FORMULA_FUNCTION_DOCS) {
      expect(doc.name, 'name').toBeTruthy()
      expect(doc.signature, `signature for ${doc.name}`).toBeTruthy()
      expect(doc.description, `description for ${doc.name}`).toBeTruthy()
      expect(doc.example, `example for ${doc.name}`).toBeTruthy()
      expect(validCategories.has(doc.category), `category for ${doc.name}`).toBe(true)
      expect(seen.has(doc.name), `duplicate ${doc.name}`).toBe(false)
      seen.add(doc.name)
    }
  })

  it('lists the full 1a scalar set under the right categories (math reconcile + text/date)', () => {
    const byName = new Map(FORMULA_FUNCTION_DOCS.map((d) => [d.name, d]))
    const expected: Record<string, 'math' | 'text' | 'date'> = {
      INT: 'math', TRUNC: 'math', EXP: 'math', LN: 'math', LOG: 'math',
      FIND: 'text', SEARCH: 'text', REPLACE: 'text', REPT: 'text', TEXT: 'text',
      REGEXMATCH: 'text', REGEXEXTRACT: 'text', REGEXREPLACE: 'text',
      HOUR: 'date', MINUTE: 'date', DATEADD: 'date', EOMONTH: 'date', WORKDAY: 'date', WEEKNUM: 'date',
    }
    for (const [name, category] of Object.entries(expected)) {
      const doc = byName.get(name)
      expect(doc, `catalog missing ${name}`).toBeDefined()
      expect(doc!.category, `category for ${name}`).toBe(category)
    }
  })

  it('does NOT advertise range/criteria functions as scalar (SUMIF/COUNTIFS/AVERAGEIF are 1b)', () => {
    const names = new Set(FORMULA_FUNCTION_DOCS.map((d) => d.name))
    for (const fn of ['SUMIF', 'COUNTIFS', 'AVERAGEIF']) expect(names.has(fn)).toBe(false)
  })
})

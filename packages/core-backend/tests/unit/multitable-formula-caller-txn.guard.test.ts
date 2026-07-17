/**
 * W0-1 L4-cov-services — FORMULA-CALLER TRANSACTION guard (durable structural guard, OD-6 tradition).
 *
 * Owner ruling 2026-07-17 (P2, TOCTOU root fix): every PRODUCTION caller of the formula-materializing
 * recompute helpers must pass a TRANSACTION-scoped query — a bare `pool.query.bind(pool)` makes the
 * engine's `fenceWriterEntry` evaporate per-statement (advisory xact lock in autocommit), reopening the
 * block-check→UPDATE TOCTOU window this fix closed. This guard fails if anyone reintroduces a bare-pool
 * call site; the behavioural halves are the L4cov F1 golden (block refusal on the engine) plus the
 * transactionalized-caller regression suites.
 *
 * Scope: the two helpers whose call chains reach the formula UPDATE (`recalculateFormulaFields`,
 * `computeDependentLookupRollupRecords`). A new production caller must wrap in `pool.transaction` (or
 * thread an existing transactional query) — never add it to an allowlist here; there is none.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const FILES = ['multitable/record-write-service.ts', 'routes/univer-meta.ts'] as const
const HELPERS = ['recalculateFormulaFields', 'computeDependentLookupRollupRecords'] as const

describe('formula-caller txn guard — no bare pool query may reach the formula-materializing helpers', () => {
  for (const rel of FILES) {
    test(`${rel}: every ${HELPERS.join('/')} call passes a txn-scoped query (no pool.query.bind in the argument window)`, () => {
      const text = readFileSync(join(SRC, rel), 'utf8')
      const offenders: string[] = []
      for (const helper of HELPERS) {
        // Find CALL sites (skip the function's own definition and type positions).
        const re = new RegExp(String.raw`(?:h\.|await |=> |\()${helper}\(`, 'g')
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          const window = text.slice(m.index, m.index + 400) // the argument window of this call
          const line = text.slice(0, m.index).split('\n').length
          if (/function\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue // definition
          if (window.includes('.query.bind(')) offenders.push(`${rel}:${line} ${helper}(… pool.query.bind …)`)
        }
      }
      expect(
        offenders,
        `FORMULA-CALLER TXN GUARD: bare autocommit pool query passed to a formula-materializing helper — ` +
          `wrap the call in pool.transaction(({query}) => …) so the engine's fence is txn-scoped ` +
          `(TOCTOU root fix, owner ruling 2026-07-17):\n  ${offenders.join('\n  ')}`,
      ).toEqual([])
    })
  }
})

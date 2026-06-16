/**
 * Egress-coverage guard — the field-read-gate arc's §3 forward-defense (tracker
 * `docs/development/multitable-field-read-gate-tracker-20260602.md` §3 Layer-3).
 *
 * WHAT THIS IS: a **change gate**, not a gating proof. It snapshots every call-site of the record-data
 * egress/mask helpers across `src/` (count per file × helper) against the GOLDEN below. A new (or removed)
 * call-site changes the count → this test goes RED → the author MUST consciously: route the new egress
 * through the layer-2 ∧ layer-3 `allowedFieldIds` composite, add a real-DB locking test in
 * `plugin-tests.yml`, update the tracker §2, then update the GOLDEN. So a new ungated egress cannot land
 * silently — it trips review by construction.
 *
 * WHAT THIS IS **NOT** (documented gaps — do NOT read a green here as "egress is gated"):
 *   1. It does NOT verify gating. The mask helpers take a `Set<string>`; whether the set is actually
 *      layer-2 ∧ layer-3 (vs a layer-2-only leak) is a by-VALUE property no static scan can check —
 *      that is proven only by each channel's **real-DB locking test** (§2 of the tracker). (The compile-time
 *      `AllowedFieldIds` branded type would close this; deferred to its own design-lock + refactor PR.)
 *   2. It only tracks the known egress HELPERS. A handler that ships raw `record.data` WITHOUT one of these
 *      helpers (e.g. `res.json({ data: row.data })`) is invisible here — that residual stays on the §3
 *      manual re-scan trigger. (A noisy raw-`.data` scan was deliberately not built.)
 */
import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../src')

// The record-data egress/mask helpers: they produce or mask record cell values on the wire.
const EGRESS_HELPERS = [
  'filterRecordDataByFieldIds',
  'loadRecordSummaries',
  'buildLinkSummaries',
  'serializeLinkSummaryMap',
  'filterRecordFieldSummaryMap',
  'filterSingleRecordFieldSummaryMap',
] as const

/**
 * GOLDEN: the registered record-data egress surface — { src-relative file → { helper → call-site count } }.
 * To change it you MUST have routed the new egress through `allowedFieldIds` + added a locking test (see
 * header). Seeded from the first run; update deliberately, never to silence a red without doing the above.
 */
const GOLDEN: Record<string, Partial<Record<(typeof EGRESS_HELPERS)[number], number>>> = {
  'multitable/record-write-service.ts': {
    filterRecordDataByFieldIds: 3,
    buildLinkSummaries: 1,
    serializeLinkSummaryMap: 1,
    filterRecordFieldSummaryMap: 2,
  },
  'routes/univer-meta.ts': {
    filterRecordDataByFieldIds: 13,
    loadRecordSummaries: 3,
    buildLinkSummaries: 4,
    serializeLinkSummaryMap: 1,
    // 3 = linkSummaries + attachmentSummaries + native person (人员) personSummaries (design
    // 2026-06-16). The personSummaries egress is routed through the SAME layer-2 ∧ layer-3
    // `allowedFieldIds` composite as linkSummaries — `filterRecordFieldSummaryMap(serializePersonSummaryMap(...), allowedFieldIds)`.
    filterRecordFieldSummaryMap: 3,
    filterSingleRecordFieldSummaryMap: 5,
  },
}

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...listTsFiles(full))
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      out.push(full)
    }
  }
  return out
}

// Count CALL-sites of a helper in a file (exclude its `function`/`async function` definition; interface
// members `name: (` and generic defs `name<T>(` already don't match `name(`). Returns line numbers.
// Comment lines are skipped: the gate tracks real egress call-sites, so a prose mention of `helper(` inside
// a JSDoc/`//` comment (e.g. the §2a.3 chokepoint doc citing `filterRecordDataByFieldIds(...)`) must NOT
// inflate the count — that would let a future real ungated call-site hide under a phantom comment slot.
const COMMENT_LINE_RE = /^\s*(\/\/|\*|\/\*)/
function callSiteLines(content: string, helper: string): number[] {
  const callRe = new RegExp(`\\b${helper}\\s*\\(`)
  const defRe = new RegExp(`\\bfunction\\s+${helper}\\b`)
  const lines: number[] = []
  content.split('\n').forEach((line, i) => {
    if (COMMENT_LINE_RE.test(line)) return
    if (callRe.test(line) && !defRe.test(line)) lines.push(i + 1)
  })
  return lines
}

describe('multitable record-data egress-coverage guard (change gate, see header)', () => {
  test('the record-data egress surface matches the registered GOLDEN', () => {
    const actual: Record<string, Record<string, number>> = {}
    const lineIndex: Record<string, Record<string, number[]>> = {}
    for (const file of listTsFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      const content = fs.readFileSync(file, 'utf8')
      for (const helper of EGRESS_HELPERS) {
        const lines = callSiteLines(content, helper)
        if (lines.length > 0) {
          ;(actual[rel] ??= {})[helper] = lines.length
          ;(lineIndex[rel] ??= {})[helper] = lines
        }
      }
    }

    // Build a human diff vs GOLDEN.
    const diffs: string[] = []
    const files = new Set([...Object.keys(GOLDEN), ...Object.keys(actual)])
    for (const file of [...files].sort()) {
      const exp = (GOLDEN as Record<string, Record<string, number>>)[file] ?? {}
      const act = actual[file] ?? {}
      const helpers = new Set([...Object.keys(exp), ...Object.keys(act)])
      for (const helper of [...helpers].sort()) {
        const e = exp[helper] ?? 0
        const a = act[helper] ?? 0
        if (e !== a) {
          const where = lineIndex[file]?.[helper]?.length ? ` (now at ${file}:${lineIndex[file][helper].join(`, ${file}:`)})` : ''
          diffs.push(`  ${file} → ${helper}: registered ${e}, found ${a}${where}`)
        }
      }
    }

    if (diffs.length > 0) {
      throw new Error(
        'Record-data egress surface changed — this is the field-read-gate §3 change gate.\n' +
          diffs.join('\n') +
          '\n\nIf you ADDED a record-data egress: route it through the layer-2 ∧ layer-3 `allowedFieldIds`\n' +
          'composite (computeAllowedFieldIds / loadAllowedFieldIds), add a real-DB locking test in\n' +
          'plugin-tests.yml asserting a denied-field canary is absent, update the tracker §2, THEN update\n' +
          'GOLDEN in this file. If you removed/refactored: confirm no channel lost its mask, then update GOLDEN.\n' +
          'This guard does NOT verify the set is actually layer-2∧3 (by-value) — the locking tests do.',
      )
    }

    expect(actual).toEqual(
      Object.fromEntries(Object.entries(GOLDEN).map(([f, h]) => [f, Object.fromEntries(Object.entries(h).filter(([, v]) => v && v > 0))])),
    )
  })
})

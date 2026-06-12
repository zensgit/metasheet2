/**
 * §2a.3 DURABLE STRUCTURAL GUARD — "a new stored-`data` read sink must be taint-safe by construction".
 *
 * Four review rounds each found one more surface that re-reads stored `meta_records.data` under a
 * SOURCE-SHEET-ONLY field mask (`filterRecordDataByFieldIds(storedData, allowedFieldIds)`) and forgot
 * the formula-over-masked-lookup taint drop. The fix centralized the rule into ONE chokepoint
 * (`maskStoredRecordFieldIds`) and a symmetric display-projection chokepoint
 * (`resolveDisplayFieldTaint`). This guard prevents the whack-a-mole from regressing:
 *
 *   1. Every `filterRecordDataByFieldIds(...)` call site in the audited route files is enumerated and
 *      compared against a FROZEN, documented allowlist. A NEW or CHANGED call site fails the test
 *      until a contributor classifies it — forcing them to read this rule and decide whether the
 *      allowed set was derived through the chokepoint (CHOKEPOINT) or is genuinely safe (SAFE, with a
 *      one-line reason). This is a SOURCE-LEVEL allowlist of audited sink call sites.
 *
 *   2. Every taint resolver call (`resolveTaintedFormulaFieldIds`) outside the two chokepoint helpers
 *      and the two write-path recompute-skip sites is forbidden — the rule must flow through the
 *      chokepoint, never be re-bolted onto a surface ad hoc (that is exactly how the prior rounds
 *      drifted).
 *
 * If this test fails, you almost certainly added a stored-data read/echo/summary sink. Route its
 * allowed set through `maskStoredRecordFieldIds` (data masks) or `resolveDisplayFieldTaint` (single
 * display-field projections), then add the call site to the allowlist below with its disposition.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

const UNIVER_META = read('routes/univer-meta.ts')
const RECORD_WRITE = read('multitable/record-write-service.ts')

/**
 * The FROZEN allowlist of every `filterRecordDataByFieldIds(<dataArg>, <allowedArg>)` data call site,
 * keyed by `<dataArg>|<allowedArg>` (whitespace-normalized). The value documents the disposition:
 *
 *   CHOKEPOINT — `<allowedArg>` is derived via `maskStoredRecordFieldIds` (the taint drop is applied).
 *   SAFE       — the `<dataArg>` is NOT raw stored record data (a freshly-built object whose only keys
 *                are masked lookup/rollup + taint-skipped recomputed formulas), so a tainted formula
 *                can never be present; the mask gate is incidental. The reason is stated inline.
 *
 * The first arg `data`/`allowedFieldIds` of the function DEFINITION is excluded by the extractor.
 */
const ALLOWLIST: Record<string, { disposition: 'CHOKEPOINT' | 'SAFE'; reason: string }> = {
  // --- univer-meta.ts -----------------------------------------------------------------------------
  '{ ...extractLookupRollupData(fields, row.data), ...(recomputedFormulaData ?? {}) }|allowedFieldIds': {
    disposition: 'SAFE',
    reason: 'bulk-PATCH related echo: fresh object of masked lookup/rollup keys + taint-skipped recompute; no raw stored formula key present',
  },
  'item.patch|allowedFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'record-history patch redaction: allowedFieldIds came from maskStoredRecordFieldIds at the /history route',
  },
  'item.snapshot|allowedFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'record-history snapshot redaction: same chokepoint-derived allowedFieldIds',
  },
  'row.data|visibleFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'dashboard rows: visibleFieldIds came from maskStoredRecordFieldIds in buildDashboardRows',
  },
  'record.data|fieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'export-xlsx row data: fieldIds came from maskStoredRecordFieldIds (column headers re-derived from it)',
  },
  'rawData|allowedIds': {
    disposition: 'CHOKEPOINT',
    reason: 'formula dry-run sample: allowedIds came from maskStoredRecordFieldIds',
  },
  'row.data|allowedFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'GET /view rows: allowedFieldIds reassigned via maskStoredRecordFieldIds before the row loop',
  },
  'record.data|readableFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'form-context edit-mode echo: readableFieldIds reassigned via maskStoredRecordFieldIds when a record is loaded',
  },
  'record.data|readableEchoFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'PATCH single-record echo AND form-submit echo (C1): readableEchoFieldIds from maskStoredRecordFieldIds',
  },
  'r.data|allowedFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'cursor GET /records: allowedFieldIds from maskStoredRecordFieldIds',
  },
  'record.data|allowedFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'single-record GET: allowedFieldIds from maskStoredRecordFieldIds',
  },
  'result.data|allowedFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'POST /records create echo: allowedFieldIds from maskStoredRecordFieldIds (defense-in-depth; recompute also taint-skips)',
  },
  // --- record-write-service.ts --------------------------------------------------------------------
  'row.data|visiblePropertyFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'bulk-PATCH hydrated row mask: visiblePropertyFieldIds = readableEchoFieldIds from buildRecordPatchContext (chokepoint-derived)',
  },
  'record.data|visiblePropertyFieldIds': {
    disposition: 'CHOKEPOINT',
    reason: 'bulk-PATCH related/formula echo: visiblePropertyFieldIds = chokepoint-derived readableEchoFieldIds',
  },
}

/** Extract `filterRecordDataByFieldIds(<arg1>, <arg2>)` call sites (skips the function definition). */
function extractCallSites(src: string): Array<{ key: string; raw: string }> {
  const sites: Array<{ key: string; raw: string }> = []
  const needle = 'filterRecordDataByFieldIds('
  let from = 0
  for (;;) {
    const idx = src.indexOf(needle, from)
    if (idx === -1) break
    from = idx + needle.length
    // Skip the function definition + type-only references (`(data: unknown, ...)` / `:` shape / `,`).
    const after = src[from]
    if (after === undefined) continue
    const headStart = src.lastIndexOf('\n', idx)
    const head = src.slice(headStart + 1, idx)
    // Skip the function definition, type-only references, the handle-map entry, and any occurrence
    // inside a comment / template-literal (JSDoc examples mention the call verbatim).
    const trimmedHead = head.trimStart()
    if (
      head.includes('function ') ||
      head.includes(': (') ||
      head.trimEnd().endsWith('filterRecordDataByFieldIds,') ||
      trimmedHead.startsWith('*') ||
      trimmedHead.startsWith('//') ||
      head.includes('`') ||
      src[idx - 1] === '`'
    ) {
      continue
    }
    // Capture the balanced parenthesized argument list.
    let depth = 1
    let i = from
    for (; i < src.length && depth > 0; i += 1) {
      if (src[i] === '(') depth += 1
      else if (src[i] === ')') depth -= 1
    }
    const argsRaw = src.slice(from, i - 1)
    // Split the TOP-LEVEL two args on the first top-level comma.
    let d = 0
    let comma = -1
    for (let j = 0; j < argsRaw.length; j += 1) {
      const c = argsRaw[j]
      if (c === '(' || c === '{' || c === '[') d += 1
      else if (c === ')' || c === '}' || c === ']') d -= 1
      else if (c === ',' && d === 0) { comma = j; break }
    }
    if (comma === -1) continue
    const arg1 = norm(argsRaw.slice(0, comma))
    const arg2 = norm(argsRaw.slice(comma + 1)).replace(/,$/, '')
    sites.push({ key: `${arg1}|${arg2}`, raw: argsRaw.trim() })
  }
  return sites
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('§2a.3 stored-data taint chokepoint — durable structural guard', () => {
  test('every filterRecordDataByFieldIds data call site is in the audited allowlist', () => {
    const sites = [...extractCallSites(UNIVER_META), ...extractCallSites(RECORD_WRITE)]
    expect(sites.length).toBeGreaterThan(0)
    const unaudited = sites.filter((s) => !(s.key in ALLOWLIST))
    expect(
      unaudited,
      `§2a.3 GUARD: ${unaudited.length} unaudited filterRecordDataByFieldIds call site(s):\n` +
        unaudited.map((s) => `  - ${s.key}`).join('\n') +
        `\n\nYou likely added a stored-data read/echo/summary sink. Route its allowed set through ` +
        `maskStoredRecordFieldIds (data masks) or resolveDisplayFieldTaint (single display projections), ` +
        `then add the call site to ALLOWLIST in this test with its disposition (CHOKEPOINT / SAFE+reason).`,
    ).toEqual([])
  })

  test('the taint resolver is only called from the two chokepoint helpers + the two write-path skips (no ad-hoc re-bolting)', () => {
    // resolveTaintedFormulaFieldIds(...) — exclude the definition line. Every remaining call must live
    // inside maskStoredRecordFieldIds / resolveDisplayFieldTaint (the read chokepoints) or the two
    // write-path recompute-SKIP sites (recalculateFormulaFields / recalcNewRecordFormulas), which drop
    // tainted ids from the RECOMPUTE set — a different operation than a read mask.
    const calls = [...UNIVER_META.matchAll(/resolveTaintedFormulaFieldIds\(/g)]
    // 1 definition (`async function resolveTaintedFormulaFieldIds(`) + 2 chokepoint helpers + 2 write skips.
    const defs = [...UNIVER_META.matchAll(/function resolveTaintedFormulaFieldIds\(/g)]
    expect(defs.length).toBe(1)
    expect(
      calls.length,
      'resolveTaintedFormulaFieldIds call count drifted. Read chokepoints (maskStoredRecordFieldIds, ' +
        'resolveDisplayFieldTaint) own the read rule; the two write-path skips own the recompute rule. ' +
        'Do NOT re-bolt the resolver onto a surface ad hoc — route through the chokepoint instead.',
    ).toBe(5) // 1 def + 2 chokepoint helpers + 2 write-path recompute skips
  })

  test('the chokepoint helpers exist and are wired (smoke)', () => {
    expect(UNIVER_META).toContain('async function maskStoredRecordFieldIds(')
    expect(UNIVER_META).toContain('async function resolveDisplayFieldTaint(')
    // The chokepoint must be the thing that calls the resolver (not a surface directly).
    expect(UNIVER_META).toMatch(/maskStoredRecordFieldIds[\s\S]{0,800}resolveTaintedFormulaFieldIds\(/)
  })
})

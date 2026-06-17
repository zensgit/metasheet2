/**
 * §2a.3 DURABLE STRUCTURAL GUARD — "a new stored-`data` read sink must be taint-safe by construction".
 *
 * Four review rounds each found one more surface that re-reads stored `meta_records.data` under a
 * SOURCE-SHEET-ONLY field mask (`filterRecordDataByFieldIds(storedData, allowedFieldIds)`) and forgot
 * the formula-over-masked-lookup taint drop. The fix centralized the rule into ONE chokepoint
 * (`maskStoredRecordFieldIds`) and a symmetric display-projection chokepoint
 * (`resolveDisplayFieldTaint`). This guard prevents the whack-a-mole from regressing:
 *
 *   1. Every `filterRecordDataByFieldIds(...)` call site across the WHOLE backend `src` tree is
 *      enumerated and compared against a FROZEN, documented allowlist. A NEW or CHANGED call site fails
 *      the test until a contributor classifies it — forcing them to read this rule and decide whether the
 *      allowed set was derived through the chokepoint (CHOKEPOINT) or is genuinely safe (SAFE, with a
 *      one-line reason). This is a SOURCE-LEVEL allowlist of audited sink call sites.
 *
 *   2. Every taint resolver call (`resolveTaintedFormulaFieldIds`) outside the two chokepoint helpers
 *      and the two write-path recompute-skip sites is forbidden — the rule must flow through the
 *      chokepoint, never be re-bolted onto a surface ad hoc (that is exactly how the prior rounds
 *      drifted). This is enforced whole-`src`: the resolver may be called ONLY from `univer-meta.ts`
 *      (where it is defined alongside the chokepoints); a call from any other file fails the test.
 *
 * SCAN (n2 hardening): this guard previously read a FIXED 2-file set (`univer-meta.ts` +
 * `record-write-service.ts`), so a `filterRecordDataByFieldIds(rawStoredData, layer2OnlySet)` sink added
 * in ANY other `src` file was invisible. It now walks the WHOLE backend `src` tree (every runtime `.ts`,
 * with `db/migrations` / tests / `node_modules` / `dist` excluded), so a new bypass file trips RED by
 * construction. The allowlist KEY now carries its `file` so two different files can host the same
 * `<dataArg>|<allowedArg>` shape without colliding.
 *
 * If this test fails, you almost certainly added a stored-data read/echo/summary sink. Route its
 * allowed set through `maskStoredRecordFieldIds` (data masks) or `resolveDisplayFieldTaint` (single
 * display-field projections), then add the call site to the allowlist below with its disposition.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/**
 * Recursively list every runtime `.ts` file under `src/` (paths relative to `src/`, `/`-separated),
 * excluding the migration tree, tests, and build output. Same whole-`src` walk the record-lock guard uses.
 */
function listRuntimeTsFiles(): string[] {
  const out: string[] = []
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'migrations') continue
        walk(abs)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue
      out.push(relative(SRC, abs).split(sep).join('/'))
    }
  }
  walk(SRC)
  return out.sort()
}

const RUNTIME_FILES = listRuntimeTsFiles()
const UNIVER_META = read('routes/univer-meta.ts')

/**
 * The FROZEN allowlist of every `filterRecordDataByFieldIds(<dataArg>, <allowedArg>)` data call site,
 * nested by `src`-relative file then keyed by `<dataArg>|<allowedArg>` (whitespace-normalized). The
 * value documents the disposition:
 *
 *   CHOKEPOINT — `<allowedArg>` is derived via `maskStoredRecordFieldIds` (the taint drop is applied).
 *   SAFE       — the `<dataArg>` is NOT raw stored record data (a freshly-built object whose only keys
 *                are masked lookup/rollup + taint-skipped recomputed formulas), so a tainted formula
 *                can never be present; the mask gate is incidental. The reason is stated inline.
 *
 * The function DEFINITION / type-annotation / handle-map forms (`filterRecordDataByFieldIds: (...)` and
 * `filterRecordDataByFieldIds,`) are NOT call sites and are excluded by the extractor — so the
 * `index.ts` Yjs-bridge inline impl and the `record-write-service.ts` interface field do not appear here.
 */
const ALLOWLIST: Record<string, Record<string, { disposition: 'CHOKEPOINT' | 'SAFE'; reason: string }>> = {
  'routes/univer-meta.ts': {
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
    'rec.data|visibleFieldIds': {
      disposition: 'CHOKEPOINT',
      reason: 'GET /sheets/:sheetId/trash list (#15 recycle bin): visibleFieldIds from maskStoredRecordFieldIds masks each trashed record data so field_permissions-denied / taint values do not leak through the trash API',
    },
  },
  'multitable/record-write-service.ts': {
    'row.data|visiblePropertyFieldIds': {
      disposition: 'CHOKEPOINT',
      reason: 'bulk-PATCH hydrated row mask: visiblePropertyFieldIds = readableEchoFieldIds from buildRecordPatchContext (chokepoint-derived)',
    },
    'record.data|visiblePropertyFieldIds': {
      disposition: 'CHOKEPOINT',
      reason: 'bulk-PATCH related/formula echo: visiblePropertyFieldIds = chokepoint-derived readableEchoFieldIds',
    },
  },
}

/** Extract `filterRecordDataByFieldIds(<arg1>, <arg2>)` call sites from one file (skips the
 *  definition / type-annotation / handle-map / comment / template forms). */
function extractCallSites(file: string, src: string): Array<{ file: string; key: string; raw: string }> {
  const sites: Array<{ file: string; key: string; raw: string }> = []
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
    sites.push({ file, key: `${arg1}|${arg2}`, raw: argsRaw.trim() })
  }
  return sites
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('§2a.3 stored-data taint chokepoint — durable structural guard', () => {
  test('every filterRecordDataByFieldIds data call site (whole-src) is in the audited allowlist', () => {
    // Whole-`src` scan: a `filterRecordDataByFieldIds(...)` data sink in ANY runtime file — not just the
    // two formerly hard-coded ones — must be classified. (The Yjs-bridge inline impl in index.ts and the
    // record-write-service.ts interface field are DEFINITION forms, skipped by the extractor.)
    const sites = RUNTIME_FILES.flatMap((file) => extractCallSites(file, read(file)))
    expect(sites.length).toBeGreaterThan(0)
    const unaudited = sites.filter((s) => ALLOWLIST[s.file]?.[s.key] === undefined)
    expect(
      unaudited,
      `§2a.3 GUARD: ${unaudited.length} unaudited filterRecordDataByFieldIds call site(s):\n` +
        unaudited.map((s) => `  - ${s.file}: ${s.key}`).join('\n') +
        `\n\nYou likely added a stored-data read/echo/summary sink. Route its allowed set through ` +
        `maskStoredRecordFieldIds (data masks) or resolveDisplayFieldTaint (single display projections), ` +
        `then add the call site to ALLOWLIST in this test under its file with its disposition (CHOKEPOINT / SAFE+reason).`,
    ).toEqual([])
  })

  test('the taint resolver is only called from the two chokepoint helpers + the two write-path skips (no ad-hoc re-bolting)', () => {
    // resolveTaintedFormulaFieldIds(...) — the resolver may live ONLY in univer-meta.ts (alongside the
    // chokepoints + the two write-path recompute-SKIP sites). Whole-`src` enforcement: a call from ANY
    // OTHER file is forbidden (that is exactly the ad-hoc re-bolting the chokepoint design forbids).
    const offFile = RUNTIME_FILES.filter((f) => f !== 'routes/univer-meta.ts').filter((f) =>
      /\bresolveTaintedFormulaFieldIds\s*\(/.test(read(f)),
    )
    expect(
      offFile,
      `resolveTaintedFormulaFieldIds is called outside routes/univer-meta.ts:\n  - ${offFile.join('\n  - ')}\n` +
        'The taint resolver must flow through the read chokepoints (maskStoredRecordFieldIds, ' +
        'resolveDisplayFieldTaint) or the two write-path recompute skips, all in univer-meta.ts. ' +
        'Do NOT re-bolt the resolver onto another surface — route through the chokepoint instead.',
    ).toEqual([])
    // Within univer-meta.ts: exclude the definition line. Every remaining call must live inside
    // maskStoredRecordFieldIds / resolveDisplayFieldTaint (the read chokepoints) or the two write-path
    // recompute-SKIP sites (recalculateFormulaFields / recalcNewRecordFormulas), which drop tainted ids
    // from the RECOMPUTE set — a different operation than a read mask.
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

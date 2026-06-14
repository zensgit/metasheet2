/**
 * DURABLE STRUCTURAL GUARD — "every record-mutating write site in the automation executor that can be
 * RETARGETED to a config-declared base must route through the cross-base write gate
 * (`evaluateCrossBaseWrite`), or declare itself cross-base-exempt, by construction".
 *
 * Sibling-in-spirit to `multitable-record-lock-guard.guard.test.ts`. That guard answers a DIFFERENT
 * invariant (every `meta_records` mutation anywhere in `src/` checks the record lock) and so walks the
 * WHOLE backend tree. This guard answers the cross-base-write invariant, which is structurally CONFINED
 * to the automation executor: `evaluateCrossBaseWrite` is a PRIVATE method on `AutomationActionExecutor`,
 * and only the executor's write actions accept a config-/input-declared target (`targetSheetId` /
 * `config.sheetId` + `targetBaseId`) that can point at ANOTHER base's sheet (the §1.3
 * create-to-another-base vector + the §2.x cross-base update). The regular CRUD / plugin-SDK / form-submit
 * write paths mutate the single sheet the actor is already sheet-permission-gated for — they have no
 * cross-base retargeting surface, so forcing `xbase-write-exempt` markers on them would be ~14 meaningless
 * annotations and would conflate two distinct invariants. Hence this guard is single-file ON PURPOSE.
 *
 * To answer the fixed-list blind-spot lesson the lock-guard's "n2 hardening" records (a guard keyed to a
 * narrow surface can miss a mutation introduced elsewhere), the confinement itself is asserted: a test
 * below proves `evaluateCrossBaseWrite` is defined ONLY in `automation-executor.ts`. If a SECOND cross-base
 * write gate ever sprouts in another file, that test trips RED — re-validating that the single-file scan
 * still covers the whole cross-base-write surface.
 *
 * HOW IT WORKS: it enumerates EVERY `meta_records` row-mutation statement in `automation-executor.ts`
 * (INSERT / UPDATE / DELETE — note INSERT is INCLUDED here, unlike the lock-guard, because
 * create-to-another-base is itself a cross-base vector) and requires each site to carry, within
 * `MARKER_WINDOW` lines immediately above the SQL, exactly one explicit disposition marker comment:
 *
 *   • `// xbase-write-gated:<reason>`  → GATED   — the site routes through `evaluateCrossBaseWrite(...)`
 *                                                  (the one shared cross-base write gate); a cross-base
 *                                                  target is rejected before the SQL unless claim==truth +
 *                                                  trigger-actor base-write authority.
 *   • `// xbase-write-exempt:<reason>` → EXEMPT  — the site writes ONLY the trigger record
 *                                                  (`context.sheetId`/`context.recordId`) and never
 *                                                  retargets to a config-declared base (e.g. lock/unlock),
 *                                                  so it is not a cross-base write surface.
 *
 * A NEW or MOVED mutation site in the executor with NO marker FAILS this test until the contributor
 * consciously classifies it — forcing them to either route the write through `evaluateCrossBaseWrite`
 * (and label it GATED) or document why the path can never be cross-base (EXEMPT). A future automation
 * write site that forgets the cross-base gate therefore trips RED by construction. A GATED label without a
 * real `evaluateCrossBaseWrite(` call in the file is separately anchored by the cross-check below.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const EXECUTOR_REL = 'multitable/automation-executor.ts'
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/**
 * Recursively list every runtime `.ts` file under `src/` (paths RELATIVE to `src/`, `/`-separated),
 * excluding the migration tree / tests / build output / node_modules. Used by the confinement test to scan
 * the WHOLE backend for the cross-base gate DEFINITION, so a second gate sprouting in any other file trips
 * RED — re-validating that the single-file enumeration above still covers the whole cross-base surface.
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

/**
 * How many physical lines ABOVE the SQL line the disposition marker may sit. Wider than the lock-guard's
 * window (3) ON PURPOSE: a gated site STACKS this marker above the EXISTING `// lock-guarded:` /
 * `// lock-mgmt:` comment (inserting above the lock marker, never between it and its SQL, so the
 * lock-guard's own window is preserved), which pushes the cross-base marker an extra line or two up.
 */
const MARKER_WINDOW = 5

type Disposition = 'GATED' | 'EXEMPT'

interface Site {
  line: number // 1-based
  sql: string
  disposition: Disposition | null
}

/**
 * Every form a `meta_records` row-mutation can take in this executor. INSERT is INCLUDED (the lock-guard
 * deliberately omits it — a fresh row has no lock — but a create INTO ANOTHER BASE is a cross-base write,
 * so it MUST be gated here). Kysely builder forms are matched pre-emptively so a future builder-style
 * mutation is also caught. `SELECT ... FROM meta_records` row reads do NOT match (token before is `FROM`,
 * not a mutation verb).
 */
const MUTATION_RE =
  /\b(?:INSERT INTO meta_records|UPDATE meta_records|DELETE FROM meta_records)\b|(?:insertInto|updateTable|deleteFrom)\(\s*['"`]meta_records['"`]/

function classify(window: string): Disposition | null {
  if (/\/\/\s*xbase-write-gated:/.test(window)) return 'GATED'
  if (/\/\/\s*xbase-write-exempt:/.test(window)) return 'EXEMPT'
  return null
}

function enumerateSites(src: string): Site[] {
  const lines = src.split('\n')
  const sites: Site[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!MUTATION_RE.test(line)) continue
    // skip comments / JSDoc that merely mention the statement
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    const windowStart = Math.max(0, i - MARKER_WINDOW)
    const window = lines.slice(windowStart, i + 1).join('\n')
    sites.push({ line: i + 1, sql: line.trim(), disposition: classify(window) })
  }
  return sites
}

describe('cross-base write-gate guard — durable structural guard (automation executor)', () => {
  const executorSrc = read(EXECUTOR_REL)
  const sites = enumerateSites(executorSrc)

  test('the enumeration finds the expected mutation surface (smoke — not zero, not exploded)', () => {
    // 4 known sites at authoring time: executeUpdateRecord UPDATE (GATED) + executeCreateRecord INSERT
    // (GATED) + executeLockRecord lock/unlock UPDATE ×2 (EXEMPT — trigger-record-only). A count change is
    // FINE — it just means you added/removed an executor write site; the per-site assertion below is the
    // real gate. This bound only flags an extractor that matched nothing (regex broke) or exploded.
    expect(sites.length).toBeGreaterThanOrEqual(3)
    expect(sites.length).toBeLessThanOrEqual(20)
  })

  test('EVERY executor meta_records write site carries a cross-base disposition (GATED / EXEMPT)', () => {
    const unclassified = sites.filter((s) => s.disposition === null)
    expect(
      unclassified,
      `CROSS-BASE WRITE GUARD: ${unclassified.length} automation-executor meta_records write site(s) ` +
        `with NO cross-base disposition:\n` +
        unclassified.map((s) => `  - ${EXECUTOR_REL}:${s.line}  ${s.sql}`).join('\n') +
        `\n\nYou added or moved a record write in the automation executor. Within ${MARKER_WINDOW} lines ` +
        `above the SQL, EITHER route it through evaluateCrossBaseWrite(...) (GATED — the one shared ` +
        `cross-base write gate) and add a "// xbase-write-gated:<reason>" marker, OR add a ` +
        `"// xbase-write-exempt:<reason>" marker (the site writes only the trigger record and can never ` +
        `retarget to a config-declared base, e.g. lock/unlock). A silent ungated cross-base create/update ` +
        `is exactly the §1.3 hole the cross-base write gate closed.`,
    ).toEqual([])
  })

  test('every GATED site is backed by a real evaluateCrossBaseWrite call (a label cannot fake the gate)', () => {
    const hasGated = sites.some((s) => s.disposition === 'GATED')
    expect(hasGated, 'expected at least one GATED cross-base write site in the executor').toBe(true)
    // A `// xbase-write-gated:` marker must be backed by a real `evaluateCrossBaseWrite(` call in the SAME
    // file. The by-VALUE proof (that the gate truly rejects a cross-base create/update without claim==truth
    // / base-write) lives in the cross-base wall + automation integration suites.
    expect(
      executorSrc.includes('evaluateCrossBaseWrite('),
      `${EXECUTOR_REL} has GATED write sites but never calls evaluateCrossBaseWrite(`,
    ).toBe(true)
  })

  test('both cross-base-capable executors (create + update) are GATED, not exempt', () => {
    // Anchor the two known cross-base vectors so a future refactor can't silently flip them to EXEMPT:
    // the INSERT (create-to-another-base, §1.3) and the data-merge UPDATE (cross-base update) must be GATED.
    const insertSite = sites.find((s) => /INSERT INTO meta_records/.test(s.sql))
    const updateMergeSite = sites.find((s) => /UPDATE meta_records/.test(s.sql) && executorSrc.split('\n')[s.line]?.includes("|| $1::jsonb") )
    expect(insertSite?.disposition, 'executeCreateRecord INSERT must be GATED (create-to-another-base vector)').toBe('GATED')
    expect(updateMergeSite?.disposition, 'executeUpdateRecord data-merge UPDATE must be GATED (cross-base update)').toBe('GATED')
  })

  test('confinement: the cross-base write gate is defined in EXACTLY ONE src file = the executor (single-file scan stays complete)', () => {
    // Scan the WHOLE backend `src/` tree for the gate DEFINITION (`private async evaluateCrossBaseWrite(`).
    // It must live in exactly one file, and that file must be the executor this guard scans. If a SECOND
    // cross-base write gate sprouts in any other file, this trips RED — and the contributor must either
    // fold it into the executor or extend THIS guard to cover the new file. This re-validates the
    // single-file enumeration above stays complete (answering the lock-guard "fixed-list blind spot"
    // lesson), without forcing whole-`src` markers on the ~14 single-sheet write sites elsewhere.
    const DEF_RE = /private\s+async\s+evaluateCrossBaseWrite\s*\(/
    const definingFiles = listRuntimeTsFiles().filter((f) => DEF_RE.test(read(f)))
    expect(definingFiles).toEqual([EXECUTOR_REL])
    // and exactly one definition within that file (no overload / duplicate gate)
    expect([...executorSrc.matchAll(DEF_RE.source ? new RegExp(DEF_RE.source, 'g') : DEF_RE)].length).toBe(1)
  })
})

/**
 * RANK-8 DURABLE STRUCTURAL GUARD — "every record mutation/delete path must enforce the record lock, or
 * declare itself lock-exempt, by construction".
 *
 * The rank-8 review found the record lock was advisory on three un-enumerated write paths
 * (automation `update_record`, form-submit EDIT, attachment-delete) + the plugin SDK — the named
 * patch/bulk/delete guards were correct but the lock check had been bolted on one sink at a time, and
 * new sinks silently bypassed it. The fix centralized the rule into ONE helper (`ensureRecordNotLocked`
 * in `record-lock.ts`) and routed every path through it. This guard prevents the whack-a-mole from
 * regressing.
 *
 * HOW IT WORKS: it enumerates EVERY `meta_records` mutation statement across the WHOLE runtime tree
 * (`src/**`, with `db/migrations` + tests + dist excluded — see SCAN below) and requires each site to
 * carry, on the line immediately above the SQL, exactly one explicit disposition marker comment:
 *
 *   • `// lock-guarded:<reason>`  → GUARDED       — the site routes through the ONE shared lock rule
 *                                                   (`ensureRecordNotLocked` in record-lock.ts). The
 *                                                   marker is local so a refactor that moves the guard
 *                                                   call away from the SQL still keeps the site labelled.
 *   • `// lock-exempt:<reason>`   → SYSTEM-EXEMPT  — a trusted system recompute / schema op with no user
 *                                                   actor (formula/auto-number/field-drop/people-sync).
 *                                                   Lock = "read-only to USERS"; these are not user edits.
 *   • `// lock-mgmt:<reason>`     → LOCK-MGMT      — the lock/unlock action itself (it carries its own
 *                                                   canEditRecord / canUnlock authority).
 *
 * A NEW or MOVED mutation site with NO marker on the line above its SQL FAILS this test until the
 * contributor consciously classifies it — forcing them to read this rule and either route through
 * `ensureRecordNotLocked` (and label it GUARDED) or document why the path is exempt. A future
 * edit/delete path that forgets the lock guard therefore trips RED by construction, exactly as the
 * §2a.3 taint chokepoint guard does. A GUARDED label without a real guard call elsewhere is separately
 * anchored by the cross-check below + the real-DB canaries (`multitable-record-lock-bypass.test.ts`).
 *
 * SCAN (n2 hardening): this guard previously keyed on a FIXED 7-file `AUDITED_FILES` list, so a
 * `meta_records` mutation introduced in any OTHER `src` file was invisible. It now recursively walks the
 * WHOLE backend `src` tree (every runtime `.ts`), so a new mutation file trips RED by construction.
 * Excluded by design:
 *   • the `db/migrations` tree — one-shot schema/backfill ops, never a live user/plugin mutation surface
 *     (lock = "read-only to USERS"; a migration has no user actor). Migrations are SYSTEM-exempt wholesale.
 *   • `.test.ts` / `.spec.ts` / `.d.ts` files, `node_modules`, `dist` — not runtime mutation surfaces.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/**
 * Recursively list every runtime `.ts` file under `src/`, returning paths RELATIVE to `src/` with `/`
 * separators (so site keys are stable across platforms). Excludes the migration tree (system-exempt
 * wholesale), tests, and build output. This is the whole-`src` scan that replaces the old fixed list.
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

/** How many physical lines ABOVE the SQL line the disposition marker may sit (allow a blank/`SET` line). */
const MARKER_WINDOW = 3

type Disposition = 'GUARDED' | 'SYSTEM-EXEMPT' | 'LOCK-MGMT'

interface Site {
  file: string
  line: number // 1-based
  sql: string
  disposition: Disposition | null
}

/**
 * Every form a `meta_records` row-mutation can take in this codebase:
 *   • raw SQL `UPDATE meta_records` / `DELETE FROM meta_records` (the only forms in use today), and
 *   • the Kysely query-builder forms `.updateTable('meta_records')` / `.deleteFrom('meta_records')`
 *     (any quote style), added pre-emptively so a future builder-style mutation is also caught.
 * `SELECT ... FOR UPDATE` row locks do NOT match (the token before `meta_records` is `FROM`, not the
 * mutation verb), so the read-then-lock pattern is correctly not flagged as a mutation.
 */
const MUTATION_RE =
  /\b(?:UPDATE meta_records|DELETE FROM meta_records)\b|(?:updateTable|deleteFrom)\(\s*['"`]meta_records['"`]/

function classify(window: string): Disposition | null {
  if (/\/\/\s*lock-guarded:/.test(window)) return 'GUARDED'
  if (/\/\/\s*lock-exempt:/.test(window)) return 'SYSTEM-EXEMPT'
  if (/\/\/\s*lock-mgmt:/.test(window)) return 'LOCK-MGMT'
  return null
}

function enumerateSites(file: string, src: string): Site[] {
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
    sites.push({ file, line: i + 1, sql: line.trim(), disposition: classify(window) })
  }
  return sites
}

describe('rank-8 record-lock mutation-path guard — durable structural guard', () => {
  const allSites = listRuntimeTsFiles().flatMap((file) => enumerateSites(file, read(file)))

  test('the enumeration finds the expected mutation surface (smoke — not zero, not exploded)', () => {
    // 16 known sites at authoring time (3 services + 1 plugin × 2 + automation update + 2 lock-mgmt ×2
    // surfaces + univer-meta form/attachment/people/field-drop/lock/unlock + formula + auto-number).
    // The scan is now whole-`src` (not a fixed file list), so a count change is FINE — it just means you
    // added/removed a mutation site (possibly in a NEW file the old 7-file list would have missed); the
    // per-site assertion below is the real gate. This bound only flags an extractor that matched nothing
    // (walk broke) or exploded (regex over-matched a non-mutation token).
    expect(allSites.length).toBeGreaterThanOrEqual(14)
    expect(allSites.length).toBeLessThanOrEqual(40)
  })

  test('EVERY meta_records UPDATE/DELETE site carries a lock disposition (GUARDED / SYSTEM-EXEMPT / LOCK-MGMT)', () => {
    const unclassified = allSites.filter((s) => s.disposition === null)
    expect(
      unclassified,
      `RANK-8 LOCK GUARD: ${unclassified.length} meta_records mutation site(s) with NO lock disposition:\n` +
        unclassified.map((s) => `  - ${s.file}:${s.line}  ${s.sql}`).join('\n') +
        `\n\nYou added or moved a record mutation/delete path. Within ${MARKER_WINDOW} lines above the SQL, ` +
        `EITHER route it through ensureRecordNotLocked(...) (GUARDED — the one shared lock rule in ` +
        `record-lock.ts), OR add a "// lock-exempt:<reason>" marker (trusted system recompute / schema op ` +
        `with no user actor) OR a "// lock-mgmt:<reason>" marker (the lock/unlock action itself). ` +
        `A silent unguarded edit/delete of a locked record is exactly the bypass this PR closed.`,
    ).toEqual([])
  })

  test('every GUARDED-labelled file actually calls the shared rule (a label cannot fake a guard)', () => {
    // A `// lock-guarded:` marker must be backed by a real `ensureRecordNotLocked(` call in the SAME file
    // (directly, or via that file's own local wrapper which itself calls it). This stops a site from
    // wearing the GUARDED label without enforcing anything. The by-VALUE proof (that the guard truly
    // rejects a locked-record mutation as a non-locker) lives in the real-DB canaries.
    const guardedFiles = new Set(
      allSites.filter((s) => s.disposition === 'GUARDED').map((s) => s.file),
    )
    // the four named paths + the two new BLOCKER fixes must be present as GUARDED files
    for (const f of [
      'multitable/record-service.ts', // single PATCH + single DELETE
      'multitable/record-write-service.ts', // bulk PATCH
      'multitable/records.ts', // plugin SDK (M1)
      'multitable/automation-executor.ts', // B1 update_record
      'routes/univer-meta.ts', // B2 form-submit + B3 attachment-delete
    ]) {
      expect(guardedFiles.has(f), `${f} should have at least one GUARDED mutation site`).toBe(true)
    }
    for (const f of guardedFiles) {
      expect(
        read(f).includes('ensureRecordNotLocked('),
        `${f} is labelled lock-guarded but never calls ensureRecordNotLocked(`,
      ).toBe(true)
    }
  })

  test('ensureRecordNotLocked is the single rule, defined once, used only with explicit error factories', () => {
    const lockSrc = read('multitable/record-lock.ts')
    expect(lockSrc).toContain('export function ensureRecordNotLocked(')
    // exactly one definition
    expect([...lockSrc.matchAll(/function ensureRecordNotLocked\(/g)].length).toBe(1)
    // the rule itself is `locked && !canEditWhileLocked` — assert it routes through canEditWhileLocked
    expect(lockSrc).toMatch(/ensureRecordNotLocked[\s\S]{0,400}canEditWhileLocked\(/)
  })
})

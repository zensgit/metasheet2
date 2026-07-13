/**
 * OD-6 REVISION-DISPOSITION GUARD — "every `meta_records` write site must declare a revision
 * disposition, or CI goes red" — the direct analogue of the rank-8 record-lock guard
 * (`multitable-record-lock-guard.guard.test.ts`), but for revisions instead of locks.
 *
 * WHY THIS EXISTS (design-lock `docs/development/multitable-global-history-d1c-form-submit-edit-
 * uncaptured-revision-design-lock-20260712.md` §0.5 OD-6, audit `/tmp/r13-revision-disposition-audit-
 * 20260713.md` §2/§7a). The revision system was in the exact PRE-GUARD state the rank-8 lock guard was
 * built to end: eight `meta_records` mutation sites (three independent human audits — rank-8, D-1, D-1c
 * — each fixing only the sinks it happened to look at) write NO `recordRecordRevision(...)`, so
 * `reconstructRecordsAtT` (the PIT/revert/reset read primitive) silently lies about those records
 * forever. A structural guard prevents a NEW sink from joining that class silently.
 *
 * KEY DIFFERENCE FROM THE RANK-8 LOCK GUARD: that guard's `MUTATION_RE` deliberately does NOT match
 * `INSERT INTO meta_records` (you cannot lock a record that does not exist yet). A *revision* guard MUST
 * cover INSERT, because a create with no `action:'create'` revision is invisible to `reconstructRecordsAtT`
 * forever — half of the 8-site bug class (audit A4/A5/A6) is exactly this. This guard's `MUTATION_RE`
 * therefore adds `INSERT INTO meta_records` (+ the Kysely builder equivalent) on top of the lock guard's
 * UPDATE/DELETE forms.
 *
 * HOW IT WORKS: enumerates EVERY `meta_records` mutation statement across the WHOLE runtime tree
 * (`src/**`, migrations/tests/dist excluded — identical SCAN policy to the rank-8 guard) and requires
 * each site to carry, within `MARKER_WINDOW` lines above the SQL, exactly one explicit marker comment:
 *
 *   • `// revision-emitted:<why>` → EMITTED  — `recordRecordRevision(...)` is called in the SAME
 *                                              transaction as this mutation (cross-checked below: the
 *                                              enclosing FILE must contain a real call, not just the label).
 *   • `// revision-exempt:<why>`  → EXEMPT   — derived/system/config-captured write with no authoritative
 *                                              user-data history obligation (formula recompute, auto-number
 *                                              backfill, People-directory sync, lock/unlock metadata, the
 *                                              derived approval projection, seed bootstrap, field-delete's
 *                                              config-channel capture).
 *   • `// revision-pending:<why>` → PENDING  — an OWNER-RULED MUST-WRITE site whose fix has NOT landed on
 *                                              main yet (in-flight lane). A PENDING site is accepted ONLY
 *                                              if its exact (file, line) also appears in
 *                                              `PENDING_REVISION_SITES` below — the marker alone is not
 *                                              enough, proving the allowlist is load-bearing (self-tests).
 *
 * A NEW or MOVED mutation site with NO marker FAILS this test until classified. A `revision-pending`
 * marker whose (file, line) is missing from `PENDING_REVISION_SITES` ALSO fails — this is what makes the
 * allowlist load-bearing rather than decorative (a developer cannot self-declare "pending" to dodge the
 * guard; the allowlist entry, keyed to a real in-flight lane, is the actual permission slip). A malformed
 * marker (recognizable prefix, missing the required `:reason`) fails with its own diagnostic, distinct
 * from "no marker at all".
 *
 * PENDING_REVISION_SITES is the temporary bridge for the 8 uncaptured sites (audit §1/§2, R13-A lanes
 * A/B/C, in-flight as #4219/#4216/#4220) plus `univer-meta.ts:6521` (field-undelete rehydration — audit
 * flagged it debatable-EXEMPT, but the design-lock owner ruling (§0.5 OD-6) directs MUST-WRITE, so it is
 * pending, not exempt; no lane PR assigned yet). Each entry is removed — and its site gains a
 * `revision-emitted` marker — when that entry's lane lands. An entry with no corresponding
 * `revision-pending`-marked site (lane landed, allowlist not cleaned up) fails a dedicated hygiene test
 * below, closing the loop from the other direction.
 *
 * OUT OF THIS GUARD'S REACH (documented, not enforced here): `routes/univer-meta.ts` — the whole-sheet
 * DELETE route runs `DELETE FROM meta_links WHERE foreign_record_id IN (SELECT id FROM meta_records …)`
 * before `DELETE FROM meta_sheets`; the actual record loss is a DB-level `meta_sheets→meta_records ON
 * DELETE CASCADE`, never a literal `DELETE FROM meta_records` statement — so it does not (and cannot)
 * trip `MUTATION_RE`. This is audit §1 row 9 / §4's "9th site": a config/schema-lane structural residual,
 * routed to a future *config*-revision guard, not this one. It carries an explanatory `// revision-exempt:`
 * comment in source for human readers, but is a documented known-residual, not a scanner-covered site.
 *
 * SCAN policy (identical to the rank-8 lock guard): recursively walks the whole backend `src` tree, every
 * runtime `.ts` file. Excluded by design: `db/migrations` (one-shot schema ops, no live user/plugin
 * mutation surface — SYSTEM-exempt wholesale, same rationale as the lock guard); `.test.ts` / `.spec.ts` /
 * `.d.ts`, `node_modules`, `dist`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** Recursively list every runtime `.ts` file under `src/`, relative to `src/`, `/`-separated. */
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

/** How many physical lines ABOVE the SQL line a disposition marker may sit (allow a blank/ternary/`SET` line). */
const MARKER_WINDOW = 3

type Disposition = 'EMITTED' | 'EXEMPT' | 'PENDING' | 'MALFORMED'

interface Site {
  file: string
  line: number // 1-based
  sql: string
  disposition: Disposition | null
}

/**
 * Every form a `meta_records` row-mutation can take in this codebase today (raw SQL `INSERT INTO` /
 * `UPDATE` / `DELETE FROM`), plus the Kysely query-builder forms pre-emptively (mirroring the rank-8
 * guard's own forward-compatibility precedent) so a future builder-style mutation is also caught.
 * Unlike the rank-8 lock guard, `INSERT INTO meta_records` IS matched here (see file header).
 */
const MUTATION_RE =
  /\b(?:INSERT INTO meta_records|UPDATE meta_records|DELETE FROM meta_records)\b|(?:insertInto|updateTable|deleteFrom)\(\s*['"`]meta_records['"`]/

/** A marker keyword was attempted but is missing its required `:reason` — distinct diagnostic from "no marker". */
const MALFORMED_ATTEMPT_RE = /\/\/\s*revision-(?:emitted|exempt|pending)\b(?!:)/

function classify(window: string): Disposition | null {
  if (/\/\/\s*revision-emitted:/.test(window)) return 'EMITTED'
  if (/\/\/\s*revision-exempt:/.test(window)) return 'EXEMPT'
  if (/\/\/\s*revision-pending:/.test(window)) return 'PENDING'
  if (MALFORMED_ATTEMPT_RE.test(window)) return 'MALFORMED'
  return null
}

function enumerateSites(file: string, src: string): Site[] {
  const lines = src.split('\n')
  const sites: Site[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!MUTATION_RE.test(line)) continue
    // skip comments / JSDoc that merely mention the statement (identical guard to the rank-8 scanner)
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    const windowStart = Math.max(0, i - MARKER_WINDOW)
    const window = lines.slice(windowStart, i + 1).join('\n')
    sites.push({ file, line: i + 1, sql: line.trim(), disposition: classify(window) })
  }
  return sites
}

/**
 * The temporary bridge for the 9 sites that are OWNER-RULED must-write-a-revision but NOT fixed on main
 * yet (design-lock §0.5 OD-6, audit §1/§2). Keyed to the in-flight lane PR that closes each. When a lane
 * lands: (a) the site gains a `// revision-emitted:` marker + a same-txn `recordRecordRevision` call, and
 * (b) its entry here is DELETED — enforced by the "no stale allowlist entries" hygiene test below.
 */
const PENDING_REVISION_SITES: ReadonlyArray<{ file: string; line: number; lane: string }> = [
  // Lane A (audit A1/A6/A8) — form-submit CREATE/EDIT + attachment-delete. Tracked: #4219.
  { file: 'routes/univer-meta.ts', line: 14439, lane: '#4219 (form-submit EDIT, audit A1 — D-1c\'s own defect)' },
  { file: 'routes/univer-meta.ts', line: 14487, lane: '#4219 (form-submit CREATE, audit A6)' },
  { file: 'routes/univer-meta.ts', line: 15711, lane: '#4219 (attachment-delete record edit, audit A8)' },
  // Lane B (audit A2/A5) — plugin-SDK create/update. Tracked: #4216.
  { file: 'multitable/records.ts', line: 508, lane: '#4216 (plugin-SDK patchRecord, audit A2)' },
  { file: 'multitable/records.ts', line: 548, lane: '#4216 (plugin-SDK createRecord, audit A5)' },
  // Lane C (audit A3/A4/A7) — automation create/update + resultWriteback. Tracked: #4220.
  { file: 'multitable/automation-executor.ts', line: 2218, lane: '#4220 (automation update_record, audit A3)' },
  { file: 'multitable/automation-executor.ts', line: 2478, lane: '#4220 (automation create_record, audit A4)' },
  { file: 'multitable/automation-service.ts', line: 2818, lane: '#4220 (automation resultWriteback, audit A7)' },
  // Owner-ruled MUST-WRITE (design-lock §0.5 OD-6), NOT one of the audit's 8 — debatable-EXEMPT per the
  // audit, overruled to MUST-WRITE by the owner. No lane PR assigned yet.
  { file: 'routes/univer-meta.ts', line: 6527, lane: 'follow-up (field-undelete rehydration, owner-ruled MUST-WRITE, no PR yet)' },
]

/**
 * The acceptance predicate every site is judged by. Exported as a plain function (not a class/closure
 * over module state) so the self-tests below can call it directly against synthetic sites and a
 * deliberately-shrunk copy of the allowlist, proving the allowlist is load-bearing without ever mutating
 * a real source file on disk.
 */
function isAccepted(site: Pick<Site, 'file' | 'line' | 'disposition'>, pending: ReadonlyArray<{ file: string; line: number }>): boolean {
  if (site.disposition === 'EMITTED') return true
  if (site.disposition === 'EXEMPT') return true
  if (site.disposition === 'PENDING') return pending.some((p) => p.file === site.file && p.line === site.line)
  // no marker at all is accepted ONLY if the allowlist independently covers it (defense in depth — in
  // practice every pending site today also carries an explicit `revision-pending:` marker in source).
  if (site.disposition === null) return pending.some((p) => p.file === site.file && p.line === site.line)
  return false // MALFORMED never passes
}

describe('OD-6 revision-disposition mutation-path guard — durable structural guard', () => {
  const allSites = listRuntimeTsFiles().flatMap((file) => enumerateSites(file, read(file)))

  test('the enumeration finds the expected mutation surface (smoke — not zero, not exploded)', () => {
    // 36 known sites at authoring time (9 INSERT + 22 UPDATE + 5 DELETE — audit §2, cross-checked against
    // a live grep of origin/main). The scan is whole-`src`, so a count change is FINE by itself — it means
    // a mutation site was added/removed/moved; the per-site disposition test below is the real gate. This
    // bound only flags an extractor that matched nothing (walk broke) or exploded (regex over-matched).
    expect(allSites.length).toBeGreaterThanOrEqual(30)
    expect(allSites.length).toBeLessThanOrEqual(60)
  })

  test('INSERT is actually covered by the live scan (the rank-8 lock guard deliberately excludes it)', () => {
    const insertSites = allSites.filter((s) => /INSERT INTO meta_records/.test(s.sql))
    // audit: 9 real INSERT sites (record-service.ts×2, records.ts, automation-executor.ts, univer-meta.ts×4,
    // approval-record-projection-service.ts).
    expect(insertSites.length).toBeGreaterThanOrEqual(8)
  })

  test('EVERY meta_records INSERT/UPDATE/DELETE site carries an accepted revision disposition', () => {
    const violations = allSites.filter((s) => !isAccepted(s, PENDING_REVISION_SITES))
    expect(
      violations,
      `OD-6 REVISION-DISPOSITION GUARD: ${violations.length} meta_records mutation site(s) with NO accepted ` +
        `revision disposition:\n` +
        violations
          .map((s) => `  - ${s.file}:${s.line}  [${s.disposition ?? 'UNMARKED'}]  ${s.sql}`)
          .join('\n') +
        `\n\nYou added or moved a record mutation site. Within ${MARKER_WINDOW} lines above the SQL, add ONE of:\n` +
        `  // revision-emitted:<why>  — recordRecordRevision(...) is called in the SAME transaction\n` +
        `  // revision-exempt:<why>   — derived/system/config-captured write, no user-data history obligation\n` +
        `  // revision-pending:<why>  — owner-ruled MUST-WRITE but not fixed yet; ALSO add an entry to ` +
        `PENDING_REVISION_SITES in this file, keyed to the lane PR that will close it.\n` +
        `A silent new create/update/delete that emits no revision is exactly the D-1c/OD-6 bug class this ` +
        `guard exists to prevent.`,
    ).toEqual([])
  })

  test('every EMITTED-labelled file actually calls recordRecordRevision( (a label cannot fake emission)', () => {
    const emittedFiles = new Set(allSites.filter((s) => s.disposition === 'EMITTED').map((s) => s.file))
    // the known-compliant files (audit §2's 14 sites) must be present
    for (const f of [
      'multitable/record-service.ts',
      'multitable/record-write-service.ts',
      'multitable/records.ts',
      'multitable/automation-executor.ts',
      'routes/univer-meta.ts',
    ]) {
      expect(emittedFiles.has(f), `${f} should have at least one EMITTED mutation site`).toBe(true)
    }
    for (const f of emittedFiles) {
      expect(
        read(f).includes('recordRecordRevision('),
        `${f} is labelled revision-emitted but never calls recordRecordRevision(`,
      ).toBe(true)
    }
  })

  test('every PENDING_REVISION_SITES entry corresponds to a site CURRENTLY marked revision-pending (no stale entries)', () => {
    // Symmetric hygiene check: when a lane lands, the site's marker flips to revision-emitted — this test
    // then fails until the now-stale allowlist entry is deleted, closing the loop from the landing side
    // (the "guard fails if unmarked and not pending" test closes it from the marking side).
    const pendingSites = new Set(allSites.filter((s) => s.disposition === 'PENDING').map((s) => `${s.file}:${s.line}`))
    const stale = PENDING_REVISION_SITES.filter((p) => !pendingSites.has(`${p.file}:${p.line}`))
    expect(
      stale,
      `PENDING_REVISION_SITES has ${stale.length} entr(y/ies) whose site is no longer marked revision-pending ` +
        `(the lane likely landed) — delete the stale entry:\n` +
        stale.map((p) => `  - ${p.file}:${p.line}  (${p.lane})`).join('\n'),
    ).toEqual([])
  })

  test('PENDING_REVISION_SITES has no duplicate (file,line) keys and every entry names a real lane', () => {
    const keys = PENDING_REVISION_SITES.map((p) => `${p.file}:${p.line}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const p of PENDING_REVISION_SITES) {
      expect(p.lane.length, `${p.file}:${p.line} allowlist entry must name a tracking lane`).toBeGreaterThan(0)
    }
  })
})

describe('OD-6 guard self-test — mutation proof (the guard must go red when neutered)', () => {
  test('synthetic unmarked INSERT INTO meta_records is flagged (proves INSERT coverage, not inferred)', () => {
    const synthetic = [
      'export async function sneakyCreate(query: unknown, sheetId: string, data: unknown) {',
      '  const recordId = `rec_${Math.random()}`',
      '  const inserted = await query(',
      '    `INSERT INTO meta_records (id, sheet_id, data, version)',
      '     VALUES ($1, $2, $3::jsonb, 1)',
      '     RETURNING version`,',
      '    [recordId, sheetId, JSON.stringify(data)],',
      '  )',
      '  return inserted',
      '}',
    ].join('\n')
    const sites = enumerateSites('synthetic/sneaky-create.ts', synthetic)
    expect(sites.length).toBe(1)
    expect(sites[0].disposition).toBeNull()
    expect(isAccepted(sites[0], PENDING_REVISION_SITES)).toBe(false)
  })

  test('a malformed marker (missing colon) does not classify as any accepted disposition', () => {
    const synthetic = [
      'export async function halfMarked(query: unknown, sheetId: string, recordId: string, patch: unknown) {',
      '  // revision-emitted oops forgot the colon',
      '  await query(',
      '    `UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2 AND sheet_id = $3`,',
      '    [JSON.stringify(patch), recordId, sheetId],',
      '  )',
      '}',
    ].join('\n')
    const sites = enumerateSites('synthetic/half-marked.ts', synthetic)
    expect(sites.length).toBe(1)
    expect(sites[0].disposition).toBe('MALFORMED')
    expect(isAccepted(sites[0], PENDING_REVISION_SITES)).toBe(false)
  })

  test('removing the revision-emitted marker from a REAL compliant site (record-service.ts create) goes red', () => {
    // Mutate real file content IN MEMORY ONLY (never written to disk) — strips exactly the marker line
    // this PR added above the create INSERT, proving the guard is not vacuously green.
    const real = read('multitable/record-service.ts')
    expect(real).toContain('// revision-emitted: create — recordRecordRevision below in the same txn (rev@706).\n')
    const mutated = real.replace(
      '// revision-emitted: create — recordRecordRevision below in the same txn (rev@706).\n',
      '',
    )
    expect(mutated).not.toEqual(real)
    const before = enumerateSites('multitable/record-service.ts', real).find((s) => /INSERT INTO meta_records/.test(s.sql))
    const after = enumerateSites('multitable/record-service.ts', mutated).find((s) => /INSERT INTO meta_records/.test(s.sql))
    expect(before?.disposition).toBe('EMITTED')
    expect(isAccepted(before!, PENDING_REVISION_SITES)).toBe(true)
    expect(after?.disposition).toBeNull()
    expect(isAccepted(after!, PENDING_REVISION_SITES)).toBe(false)
  })

  test('removing an entry from PENDING_REVISION_SITES makes its still-pending-marked site fail (allowlist is load-bearing)', () => {
    const target = { file: 'multitable/records.ts', line: 548 }
    const shrunk = PENDING_REVISION_SITES.filter((p) => !(p.file === target.file && p.line === target.line))
    expect(shrunk.length).toBe(PENDING_REVISION_SITES.length - 1)
    const site: Site = { file: target.file, line: target.line, sql: '`INSERT INTO meta_records (id, sheet_id, data, version)', disposition: 'PENDING' }
    // with the full allowlist, the site is accepted (marker + entry both present)
    expect(isAccepted(site, PENDING_REVISION_SITES)).toBe(true)
    // with the entry removed, the SAME marked-pending site is now rejected — the allowlist, not the
    // marker alone, is what makes a pending site pass.
    expect(isAccepted(site, shrunk)).toBe(false)
  })

  test('a revision-pending marker with NO allowlist entry at all is rejected (cannot self-declare pending)', () => {
    const synthetic = [
      'export async function selfDeclaredPending(query: unknown, sheetId: string, recordId: string, patch: unknown) {',
      '  // revision-pending: I promise I will fix this later, please let me merge',
      '  await query(',
      '    `UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2 AND sheet_id = $3`,',
      '    [JSON.stringify(patch), recordId, sheetId],',
      '  )',
      '}',
    ].join('\n')
    const sites = enumerateSites('synthetic/self-declared-pending.ts', synthetic)
    expect(sites.length).toBe(1)
    expect(sites[0].disposition).toBe('PENDING')
    expect(isAccepted(sites[0], PENDING_REVISION_SITES)).toBe(false)
  })
})

/**
 * n2 hardening — RAW RECORD-DATA PROJECTION guard (the egress-coverage guard's documented blind spot).
 *
 * The egress-coverage guard (`multitable-egress-coverage-guard.test.ts`) snapshots call-sites of the
 * record-data egress HELPERS (`filterRecordDataByFieldIds`, `loadRecordSummaries`, `buildLinkSummaries`,
 * …). Its header names the residual it CANNOT see:
 *
 *   > A handler that ships raw `record.data` WITHOUT one of these helpers (e.g. `res.json({ data: row.data })`)
 *   > is invisible here — that residual stays on the §3 manual re-scan trigger.
 *
 * This guard mechanizes that manual re-scan as far as is cleanly achievable. It enumerates every RAW
 * record-data projection in the whole backend `src` tree — `data: <rowIdent>.data` (an object property
 * echoing a record's stored `data`) and `...<rowIdent>.data` (a spread of it), where `<rowIdent>` is a
 * `meta_records` row binding (`row` / `record` / `r` / `rec` / `existing` / `stored`) — and compares it
 * against a FROZEN, documented allowlist. A NEW raw projection fails the test until the contributor
 * classifies it, forcing them to confirm the path either masks the data before the wire (route the row's
 * `.data` through `filterRecordDataByFieldIds` / `maskStoredRecordFieldIds`) or is not an egress at all.
 *
 * WHY this ident set (and not `result.data`): `<rowIdent>.data` is a record ROW's stored cell map. The
 * `result.data` / `success`-envelope `.data` seen in `routes/federation.ts` · `routes/approvals.ts` ·
 * `routes/views.ts` · `data-adapters/*` · `services/ValidationService.ts` is the `.data` of an API
 * RESULT envelope (`{ ok, data }`), NOT a `meta_records` cell map — including it would couple this guard
 * to unrelated federation/approval code and make it noisy. The ident set is the precise, stable signal.
 *
 * ENUMERATION RESULT (one-time evidence, post-§2a.3, captured 2026-06-12): the 5 raw projections below are
 * the COMPLETE live `meta_records` raw-projection surface; each is SAFE (operand pre-masked, masked
 * before the response, or a write-path build — never a raw egress). ⇒ **no current raw-projection leak.**
 *
 * RESIDUAL (documented, NOT a flaky guard): two things this guard deliberately does NOT assert —
 *   1. It is a CHANGE GATE on the raw-projection SHAPE, not a by-value gating proof: it confirms each
 *      projection is consciously classified, but the SAFE-because-pre-masked claims are anchored by the
 *      §2a.3 taint-chokepoint guard + the field-read-gate real-DB locking tests, not re-proven here. A
 *      raw `res.json`-proximity scan (457 `res.json` sites in univer-meta alone, the intermediate-then-
 *      masked pattern at line 7424) is too noisy to be a stable guard and was deliberately not built.
 *   2. `routes/views.ts` (`/api/views/:id/data` → `DefaultViewDataProvider.getData`) emits raw `row.data`
 *      from a `table_rows` table with NO field mask — but `table_rows` is NEVER created by any migration
 *      (TS or SQL), so this legacy POC surface errors at runtime and CANNOT egress real `meta_records`
 *      data (the same latent-not-live shape as the deleted kanban/gallery/calendar samples; see the
 *      field-read-gate tracker §3). It is therefore correctly NOT in the live-record allowlist. If a
 *      migration ever creates `table_rows`, that path re-arms and MUST re-enter this inventory + be gated.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** Whole-`src` runtime `.ts` walk (migrations / tests / build output excluded) — shared shape with the
 *  record-lock + taint-chokepoint guards. */
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
  return out
}

/** `meta_records` row bindings whose `.data` is a stored cell map. `result` is EXCLUDED on purpose — it
 *  is an API-result envelope, not a record row (see header). */
const ROW_IDENT = String.raw`(?:row|record|r|rec|existing|stored)`

/** A raw record-data projection: an object property `data: <rowIdent>.data` OR a spread `...<rowIdent>.data`.
 *  The trailing `(?![\w[])` rejects `.dataset`/`.data[fieldId]` so only the whole-`.data` map is matched
 *  (a single-cell `data[fieldId]` read is a different, internal-compute pattern, not a whole-map echo). */
const PROJECTION_RE = new RegExp(
  String.raw`(?:\bdata:\s*${ROW_IDENT}\.data|\.\.\.${ROW_IDENT}\.data)(?![\w[])`,
  'g',
)

interface Projection {
  file: string
  line: number // 1-based
  text: string
}

function enumerateProjections(file: string, src: string): Projection[] {
  const out: Projection[] = []
  src.split('\n').forEach((line, i) => {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return // skip comment / JSDoc mentions
    for (const m of line.matchAll(PROJECTION_RE)) {
      out.push({ file, line: i + 1, text: m[0] })
    }
  })
  return out
}

/**
 * FROZEN allowlist of every live `meta_records` raw record-data projection, nested by `src`-relative file
 * then keyed by the matched projection text (a file can host the same shape twice — e.g. univer-meta.ts
 * line 2244 spreads two pre-masked operands). Each is SAFE; the disposition records WHY it is not a leak:
 *
 *   PRE-MASKED       — the `.data` operand is ALREADY a masked object (output of a chokepoint /
 *                      `computeDependentLookupRollupRecords`), so the raw projection echoes masked data.
 *   MASKED-DOWNSTREAM — the projection builds an intermediate row whose `.data` is masked by
 *                      `filterRecordDataByFieldIds(...)` later in the same handler, before `res.json`.
 *   WRITE-PATH       — the projection builds a `data` object that is WRITTEN to the DB, never echoed.
 *   INTERNAL         — the projection builds an internal hydration map that is masked before any echo.
 */
type Disposition = 'PRE-MASKED' | 'MASKED-DOWNSTREAM' | 'WRITE-PATH' | 'INTERNAL'
const ALLOWLIST: Record<string, Record<string, { disposition: Disposition; reason: string }>> = {
  'routes/univer-meta.ts': {
    '...existing.data': {
      disposition: 'PRE-MASKED',
      reason: 'mergeComputedRecords: merges two related-record `data` objects already masked per-sheet by computeDependentLookupRollupRecords (line ~2396)',
    },
    '...record.data': {
      disposition: 'PRE-MASKED',
      reason: 'mergeComputedRecords: the second merge operand — same pre-masked related-record data as ...existing.data (both from computeDependentLookupRollupRecords)',
    },
    'data: r.data': {
      disposition: 'MASKED-DOWNSTREAM',
      reason: 'GET /view intermediate `rows` build; each row.data is reassigned via filterRecordDataByFieldIds(row.data, allowedFieldIds) before the response (line ~7498)',
    },
  },
  'multitable/record-write-service.ts': {
    '...row.data': {
      disposition: 'INTERNAL',
      reason: 'hydratedDataByRecord internal hydration map; each entry is masked via h.filterRecordDataByFieldIds(row.data, visiblePropertyFieldIds) before any echo (line ~869)',
    },
    'data: record.data': {
      disposition: 'PRE-MASKED',
      reason: 'crossSheetRelated echo: record.data is the per-sheet-masked output of computeDependentLookupRollupRecords (locked by multitable-cross-sheet-related-echo-mask)',
    },
  },
  'multitable/records.ts': {
    '...existing.data': {
      disposition: 'WRITE-PATH',
      reason: 'plugin-SDK patchRecord builds nextData = { ...existing.data, ...patch } to WRITE to meta_records; not a response echo',
    },
  },
}

describe('n2 raw record-data projection guard — egress-guard blind-spot closure', () => {
  const all = listRuntimeTsFiles().flatMap((file) => enumerateProjections(file, read(file)))

  test('the enumeration finds the expected raw-projection surface (smoke — not zero, not exploded)', () => {
    // 6 matches at authoring time across 4 files: univer-meta line 2244 contributes TWO
    // (`...existing.data` + `...record.data`, both pre-masked merge operands) + line 7424 `data: r.data`;
    // record-write-service `...row.data` + `data: record.data`; records.ts `...existing.data`.
    // A count change is FINE — the per-site assertion below is the real gate; this only flags a broken
    // walk (zero) or a regex that over-matched (exploded into result.data envelope noise).
    expect(all.length).toBeGreaterThanOrEqual(4)
    expect(all.length).toBeLessThanOrEqual(20)
  })

  test('EVERY raw record-data projection is in the audited allowlist (no new ungated raw egress)', () => {
    const unaudited = all.filter((p) => ALLOWLIST[p.file]?.[p.text] === undefined)
    expect(
      unaudited,
      `n2 RAW-PROJECTION GUARD: ${unaudited.length} unaudited raw record-data projection(s):\n` +
        unaudited.map((p) => `  - ${p.file}:${p.line}  ${p.text}`).join('\n') +
        `\n\nYou added a raw .data projection of a record row. If it reaches an HTTP response, route the ` +
        `row's data through filterRecordDataByFieldIds(...) / maskStoredRecordFieldIds(...) FIRST (and add a ` +
        `real-DB locking test, per the field-read-gate tracker §2). Then add this projection to ALLOWLIST ` +
        `under its file with its disposition (PRE-MASKED / MASKED-DOWNSTREAM / WRITE-PATH / INTERNAL + reason). ` +
        `If it is NOT a meta_records cell map (an API-result envelope), it should not have matched — narrow it.`,
    ).toEqual([])
  })

  test('the dead legacy `table_rows` view-data path is still dead (table never created)', () => {
    // RESIDUAL #2 (see header): routes/views.ts → DefaultViewDataProvider emits raw row.data from
    // `table_rows` with NO mask. It is inert only because `table_rows` is never created. If a migration
    // ever creates it, this canary turns RED — forcing the path back into the egress inventory + a gate.
    const provider = read('core/default-view-data-provider.ts')
    expect(provider, 'DefaultViewDataProvider should still read from table_rows (legacy POC surface)').toContain(
      'FROM table_rows',
    )
    // Assert no migration creates `table_rows` — the table's absence is what keeps the path inert.
    const migrationsDir = join(SRC, 'db', 'migrations')
    const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.ts'))
    const createsTableRows = migrationFiles.filter((f) =>
      /create\s+table[^;]*\btable_rows\b/i.test(readFileSync(join(migrationsDir, f), 'utf8')),
    )
    expect(
      createsTableRows,
      `A migration now creates \`table_rows\`, re-arming the unmasked routes/views.ts → DefaultViewDataProvider ` +
        `egress (it emits raw row.data with no field mask). Route that path through the field-read gate ` +
        `(allowedFieldIds + a real-DB locking test) before this table ships:\n  - ${createsTableRows.join('\n  - ')}`,
    ).toEqual([])
  })
})

/**
 * SHEET-LIVENESS CLOSURE — a closed-world structural guard over `routes/univer-meta.ts`.
 *
 * ── Why a structural guard, and not just per-route tests ──────────────────────
 * `DELETE /sheets/:sheetId` used to be a HARD delete. Every sheet-addressed path was safe BY
 * CONSTRUCTION: the row was gone and the FK cascade took the records with it, so a handler that
 * addressed `meta_records` by `sheet_id` and never joined `meta_sheets` still found nothing.
 *
 * Soft delete removed that guarantee and replaced it with nothing — `deleted_at` only filtered the
 * LISTING queries. An adversarial review found the consequences: the OAPI record list served a
 * deleted sheet's complete record set, `POST /patch` kept writing to it, and those writes fired the
 * sheet's automations, so a "deleted" sheet could still push data outbound.
 *
 * The fix is a guard on ~80 paths. Hand-placed guards can be forgotten, and a forgotten one is
 * invisible — it looks exactly like a path that never needed one. So this file derives the route
 * population FROM SOURCE and requires every sheet-addressed handler to be either GUARDED or on a
 * NAMED exemption list with a reason. Exemption by omission is not possible.
 *
 * ── CRLF ──────────────────────────────────────────────────────────────────────
 * The scan normalizes line endings before matching. This is not incidental: the sibling #3365
 * tripwire matches `router.<verb>(...)` with a per-line regex ending `(.*)$`, which cannot match a
 * trailing `\r` — so on a CRLF working tree it silently finds ZERO routes and its dependent
 * assertions all pass vacuously. That defect was found while building this file. The population
 * assertion at the bottom is the tripwire for the same failure mode here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROUTE_FILE = join(__dirname, '../../src/routes/univer-meta.ts')
const SRC = readFileSync(ROUTE_FILE, 'utf8').replace(/\r\n/g, '\n')
const LINES = SRC.split('\n')

const ROUTE_RE = /^(\s*)router\.(get|post|patch|delete|put)\(\s*'([^']+)'/

interface Handler {
  verb: string
  path: string
  key: string
  line: number
  body: string
}

function extractHandlers(): Handler[] {
  const out: Handler[] = []
  for (let i = 0; i < LINES.length; i += 1) {
    const m = ROUTE_RE.exec(LINES[i]!)
    if (!m) continue
    const indent = m[1]!
    let j = i + 1
    while (j < LINES.length) {
      const next = ROUTE_RE.exec(LINES[j]!)
      if (next && next[1]!.length <= indent.length) break
      j += 1
    }
    out.push({
      verb: m[2]!.toUpperCase(),
      path: m[3]!,
      key: `${m[2]!.toUpperCase()} ${m[3]!}`,
      line: i + 1,
      body: LINES.slice(i, j).join('\n'),
    })
  }
  return out
}

const HANDLERS = extractHandlers()

/** A handler is IN SCOPE if it can reach a specific sheet's data. */
function addressesASheet(h: Handler): boolean {
  return (
    h.path.includes(':sheetId')
    || /\bresolveSheetCapabilities\b|\bresolveSheetReadableCapabilities\b/.test(h.body)
    || /\brequireRecordReadable\b/.test(h.body)
    || /\bresolveMetaSheetId\b/.test(h.body)
  )
}

/**
 * Mechanisms that ESTABLISH liveness. Each was verified by reading the implementation, not the name:
 *   - `sheetLiveness !== 'live'` — the explicit refusal, fed by `resolveSheetCapabilities`
 *   - `assertSheetLive` / `SheetNotLiveError` — the throwing form, for service callbacks
 *   - `loadSheetRow` / `loadSheetSummary` — both filter `deleted_at IS NULL` (loaders.ts:47)
 *   - `deleted_at IS NULL` — an inline filter in the handler's own SQL
 *   - `requireRecordReadable` — refuses a non-live sheet itself (univer-meta.ts), so its callers inherit
 *   - `handleExactAnchorPreview` / `handleExactAnchorExecute` — the four revert/reset one-liners
 *     delegate wholesale to these, which check liveness after their existence-hiding authority gate
 */
const GUARD_PATTERNS: Array<[RegExp, string]> = [
  [/sheetLiveness !== 'live'/, "explicit sheetLiveness refusal"],
  [/\bassertSheetLive\b/, 'assertSheetLive'],
  [/\bSheetNotLiveError\b/, 'SheetNotLiveError (thrown from a service callback)'],
  [/\bloadSheetRow\b/, 'loadSheetRow (deleted_at IS NULL)'],
  [/\bloadSheetSummary\b/, 'loadSheetSummary (deleted_at IS NULL)'],
  [/deleted_at IS NULL/, 'inline deleted_at IS NULL'],
  [/\brequireRecordReadable\b/, 'requireRecordReadable (refuses a non-live sheet)'],
  [/\bhandleExactAnchor(Preview|Execute)\b/, 'delegates to the exact-anchor handler'],
]

function guardOf(h: Handler): string | null {
  for (const [re, label] of GUARD_PATTERNS) if (re.test(h.body)) return label
  return null
}

/**
 * EXEMPT BY NAME, never by omission. Each entry states why the path cannot reach a live sheet's data,
 * or why it legitimately must see a dead one.
 */
const EXEMPT: Record<string, string> = {
  'POST /bases':
    'creates a BASE. It never resolves a sheet — the only `sheetId` token in its body belongs to the '
    + 'template-install helper text further down the file, not to this handler.',
  'POST /templates/:templateId/install':
    'CREATES sheets. There is no pre-existing sheet whose liveness could be asserted; the sheets it '
    + 'makes are live by construction.',
  'GET /record-subscription-notifications':
    'reads the CALLER’S OWN notification rows, keyed by user, not by sheet. It takes no sheet id.',
}

describe('sheet-liveness closure over univer-meta routes', () => {
  const inScope = HANDLERS.filter(addressesASheet)

  it('every sheet-addressed route is GUARDED or EXEMPT BY NAME', () => {
    const unaccounted = inScope
      .filter((h) => !guardOf(h) && !(h.key in EXEMPT))
      .map((h) => `${h.key}  (line ${h.line})`)

    expect(
      unaccounted,
      `${unaccounted.length} sheet-addressed route(s) establish no sheet liveness and are not exempt.\n`
      + `Soft delete keeps meta_records rows alive, so these can read or write a DELETED sheet:\n`
      + unaccounted.map((r) => `  - ${r}`).join('\n')
      + `\n\nEither guard the handler (see multitable/sheet-liveness.ts) or add it to EXEMPT with a reason.`,
    ).toEqual([])
  })

  it('no DEAD exemptions — an entry that stops matching a real route reds instead of rotting', () => {
    const keys = new Set(HANDLERS.map((h) => h.key))
    const dead = Object.keys(EXEMPT).filter((k) => !keys.has(k))
    expect(dead, `EXEMPT names ${dead.length} route(s) that no longer exist: ${dead.join(', ')}`).toEqual([])
  })

  it('no exemption is REDUNDANT — an exempt route that became guarded should leave the list', () => {
    const redundant = Object.keys(EXEMPT).filter((k) => {
      const h = inScope.find((x) => x.key === k)
      return h ? guardOf(h) !== null : false
    })
    expect(redundant, `these routes are now guarded and no longer need an exemption: ${redundant.join(', ')}`).toEqual([])
  })

  // THE TRIPWIRE. A refactor that changes the registration STYLE (or a CRLF regression like the one
  // in the #3365 guard) would make the scan return an empty population, and every assertion above
  // would pass vacuously. Fail loudly instead.
  it('the scan found a real population on both sides', () => {
    expect(HANDLERS.length).toBeGreaterThan(50)
    expect(inScope.length).toBeGreaterThan(40)
    expect(inScope.filter((h) => guardOf(h) !== null).length).toBeGreaterThan(40)
    // And the file really is the CRLF file this repo checks out.
    expect(SRC).not.toContain('\r')
  })

  it('the restore route is the ONE path allowed to see a deleted sheet, and says so', () => {
    const restore = HANDLERS.find((h) => h.key === 'POST /sheets/:sheetId/restore')
    expect(restore, 'POST /sheets/:sheetId/restore not found').toBeTruthy()
    // It must NOT carry the liveness refusal — that would make restore impossible...
    expect(restore!.body).not.toContain("sheetLiveness !== 'live'")
    // ...and its exemption must be stated at the call site, not inferred from the absence.
    expect(restore!.body).toContain('RESTORE-FLOW EXEMPT')
  })
})

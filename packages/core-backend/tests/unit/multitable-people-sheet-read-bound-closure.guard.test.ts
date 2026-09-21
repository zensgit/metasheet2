/**
 * #5807 — CLOSED WORLD over the People-sheet read bound in `routes/univer-meta.ts`.
 *
 * The bound itself lives in ONE helper (`multitable/people-sheet-read-bound.ts`), but a helper only
 * binds the routes that call it. The leak #5807 reports is not "this route is wrong", it is "this
 * SHEET is readable by quantity through whichever route happens to enumerate it" — so a reader added
 * tomorrow re-opens it silently. This guard makes that impossible to do quietly.
 *
 * WHAT IS CLOSED: every route handler registered in `routes/univer-meta.ts` that can ENUMERATE rows of
 * a caller-addressed sheet must either
 *   (a) name the resolver `resolvePeopleSheetReadBound` in its OWN body (the bound is resolved per
 *       request, after the gate — a helper doing it out of sight would not be reviewable), or
 *   (b) appear in EXEMPT below with a reason.
 * Exemption by omission is impossible: an entry whose route no longer exists, or which has since
 * started calling the resolver, reds too — so the list cannot rot into a rubber stamp.
 *
 * Running it is how `POST /dashboard/query` got bound at all: it never appeared in the issue's route
 * list, and the scan found it enumerating under a bare `canRead` — `view-aggregate`'s twin, one
 * group-by bucket per person. It answers the same refusal now, so it is NOT in EXEMPT below.
 *
 * ENUMERATING means: the handler, or a same-file helper it reaches transitively, issues SQL that reads
 * `meta_records` scoped by `sheet_id` and NOT narrowed to caller-supplied record ids (`id = $n` /
 * `id = ANY($n)` / `record_id = $n`). A pure `COUNT(*)` is deliberately NOT enumeration — it yields no
 * row identity — which is why `view-aggregate` is caught by its record read, not by its count.
 *
 * The scan is AST-based and shared with the sheet-liveness closed world
 * (tests/utils/sheet-liveness-route-scan.ts): registrations, handler resolution (wrappers, consts,
 * factories) and transitive same-file helper bodies all come from there, with comments stripped — so
 * prose can never satisfy a pattern, and an unreadable handler is recorded rather than skipped.
 *
 * CRLF: the scanner normalizes to LF before parsing (the #3365 tripwire defect).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { scanRouteSource, type RouteHandler } from '../utils/sheet-liveness-route-scan'

const REL = 'routes/univer-meta.ts'
const SRC = join(__dirname, '../../src', ...REL.split('/'))

/** The resolver every bound reader must name in its own body. */
const RESOLVER = 'resolvePeopleSheetReadBound'

/** `meta_records` read that is scoped to a sheet and NOT narrowed to specific record ids. */
function isEnumeratingSql(sql: string): boolean {
  const text = sql.replace(/\s+/g, ' ')
  if (!/FROM meta_records\b/i.test(text)) return false
  if (!/\bsheet_id\s*=\s*(\$\d|ANY\s*\()/i.test(text)) return false
  // `\b` before `id` does NOT fire inside `sheet_id` (`_` is a word char), so these really are the
  // "narrowed to named records" shapes.
  if (/\bid\s*=\s*(\$\d|ANY\s*\()/i.test(text)) return false
  if (/\brecord_id\s*=\s*\$\d/i.test(text)) return false
  // A pure count yields a number, not rows.
  if (/SELECT\s+COUNT\(\*\)/i.test(text) && !/,/.test(text.replace(/COUNT\(\*\)[^,]*/i, ''))) return false
  return true
}

/** SQL string / template literals appearing anywhere in a chunk of code-only text. */
function sqlLiteralsIn(code: string): string[] {
  const out: string[] = []
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) out.push(match[2])
  return out
}

function enumeratesRecords(handler: RouteHandler): boolean {
  const chunks = [handler.code, ...handler.helpers.values()]
  return chunks.some((chunk) => sqlLiteralsIn(chunk).some(isEnumeratingSql))
}

/**
 * Enumerating readers that deliberately do NOT resolve the bound, each with the reason it is safe.
 * Keyed by the scanner's route key (`<VERB> <path>`).
 */
const EXEMPT: Record<string, string> = {
  'GET /sheets/:sheetId/point-in-time':
    'GAP — tracked in #5807 — gated on canRead alone and it pages a reconstructed record set ' +
    '(`records` + `total` + offset/limit), so the roster is reachable through history the same way it ' +
    'was through /view. NOT closed in this first cut for two reasons: it is a recovery surface whose ' +
    'paging semantics (as-of reconstruction, deleted rows deliberately visible) need their own decision ' +
    'rather than the live-read window, and it sits inside the univer-meta region a sibling PR is editing ' +
    'right now. It is named here so the hole is visible and a later cut must come back to it.',
  'POST /sheets/:sheetId/config-restore-preview':
    'CONFIG restore, not a record reader: its gate is canManageFields / canManageViews / ' +
    'canManageSheetAccess — schema authority the #5807 actor (a bare global multitable:read) does not ' +
    'hold — and the meta_records read is a per-FIELD probe (`WHERE sheet_id = $1 AND data ? $2`) used to ' +
    'decide whether restoring a field would strand stored cells. Its response carries the config diff, ' +
    'never a page of roster rows.',
  'POST /sheets/:sheetId/config-restore-execute':
    'Same as the preview above: canManageFields / canManageViews / canManageSheetAccess authority, a ' +
    'per-FIELD `data ? $2` probe rather than a roster page, and a response that reports what was ' +
    'restored. A bound here would clamp a WRITE path, which is not what the read window means.',
  'POST /person-fields/prepare':
    'This is the MATERIALIZER the issue is about, not a reader of it: gate canManageFields, it reads the ' +
    'sheet to find which active users already have a row and answers `{ targetSheet, fieldProperty }` — ' +
    'no records at all. Bounding it would break the sync (it must see every existing row to avoid ' +
    'duplicating people); the write side is a separate question from this read-side quantity cut.',
  'GET /people-search':
    'Deliberately untouched by this cut and already the narrow surface: it is clamped to 20 items and ' +
    'returns DISPLAY values only (id + display), never the row. It is also the one path the person chip ' +
    'and MetaLinkPicker use on first open, so adding a mandatory search term here would empty them — ' +
    'the summary-display-field-mask suites call it with no term on purpose.',
  'PATCH /fields/:fieldId':
    'Field-schema write gated on canManageFields, not canRead: it enumerates the sheet only to rewrite ' +
    'stored cells for a type conversion, and its response is the updated FIELD. The rows never reach the ' +
    'caller, so a read window would bound nothing that is returned.',
}

const RAW = readFileSync(SRC, 'utf8')
const scanned = scanRouteSource(REL, RAW)
const enumerating = scanned.handlers.filter(enumeratesRecords)

describe('#5807 — every enumerating reader of a sheet in univer-meta.ts is bound or named', () => {
  it('the scan finds the file and a non-trivial population (a scanner that reads nothing proves nothing)', () => {
    expect(scanned.handlers.length).toBeGreaterThan(50)
    expect(enumerating.length).toBeGreaterThan(3)
  })

  it('every enumerating reader either resolves the bound or is EXEMPT with a reason', () => {
    const unaccounted = enumerating
      .filter((h) => !h.code.includes(RESOLVER))
      .filter((h) => !(h.key in EXEMPT))
      .map((h) => `${h.key} (line ${h.line})`)
    expect(unaccounted).toEqual([])
  })

  it('no EXEMPT entry is stale — its route still exists and still does not resolve the bound', () => {
    const byKey = new Map(scanned.handlers.map((h) => [h.key, h]))
    const stale: string[] = []
    for (const key of Object.keys(EXEMPT)) {
      const handler = byKey.get(key)
      if (!handler) stale.push(`${key}: route no longer exists`)
      else if (!enumeratesRecords(handler)) stale.push(`${key}: no longer enumerates — drop the exemption`)
      else if (handler.code.includes(RESOLVER)) stale.push(`${key}: now resolves the bound — drop the exemption`)
    }
    expect(stale).toEqual([])
  })

  it('every EXEMPT reason is a real sentence, not a placeholder', () => {
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, key).toBeGreaterThan(40)
      expect(reason, key).not.toMatch(/\b(TBD|TODO|FIXME|\?\?\?)\b/i)
    }
  })

  it('the verdict is identical on a CRLF tree (#3365: a per-line pattern silently matches nothing there)', () => {
    const crlf = scanRouteSource(REL, RAW.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'))
    expect(crlf.handlers.length).toBe(scanned.handlers.length)
    expect(crlf.handlers.filter(enumeratesRecords).map((h) => h.key)).toEqual(enumerating.map((h) => h.key))
    expect(crlf.handlers.filter((h) => h.code.includes(RESOLVER)).map((h) => h.key))
      .toEqual(scanned.handlers.filter((h) => h.code.includes(RESOLVER)).map((h) => h.key))
  })

  it('the bound routes resolve it AFTER the gate — the resolver never precedes a canRead refusal', () => {
    const bound = scanned.handlers.filter((h) => h.code.includes(RESOLVER))
    expect(bound.length).toBeGreaterThan(3)
    for (const handler of bound) {
      const gateAt = handler.code.indexOf('sendForbidden(res)')
      const resolverAt = handler.code.indexOf(RESOLVER)
      expect(gateAt, handler.key).toBeGreaterThanOrEqual(0)
      // A bound resolved before the authority refusal would make the People sheet an oracle for a
      // caller that may not read it at all.
      expect(resolverAt, handler.key).toBeGreaterThan(gateAt)
    }
  })
})

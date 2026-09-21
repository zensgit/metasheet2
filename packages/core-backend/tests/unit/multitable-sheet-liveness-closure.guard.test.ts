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
  /** CODE only — comments stripped. See {@link stripComments}. */
  body: string
  /** The handler verbatim, comments included — for assertions ABOUT the prose (the exemption marker). */
  rawBody: string
}

/**
 * Comments are stripped before classification. Without this, a handler is classified GUARDED because
 * its PROSE mentions a guard: `POST /sheets/:sheetId/restore` explains that "`loadSheetRow`
 * (deleted_at IS NULL) cannot see it", and that sentence alone satisfied two patterns. A guard whose
 * verdict can be changed by a comment cannot be trusted to find a missing one.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
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
    // Cut at the handler's OWN closing `})`, not at the next registration. The gap between two
    // handlers holds the next one's docblock, and letting that bleed in would classify a handler
    // guarded because its NEIGHBOUR's comment mentions `loadSheetRow`. (Caught while auditing this
    // file's own output: it was calling `POST /sheets/:sheetId/restore` guarded on the rename
    // route's docblock.)
    const slice = LINES.slice(i, j)
    let close = slice.length
    for (let k = slice.length - 1; k >= 0; k -= 1) {
      if (slice[k] === `${indent}})`) {
        close = k + 1
        break
      }
    }
    out.push({
      verb: m[2]!.toUpperCase(),
      path: m[3]!,
      key: `${m[2]!.toUpperCase()} ${m[3]!}`,
      line: i + 1,
      body: stripComments(slice.slice(0, close).join('\n')),
      rawBody: slice.slice(0, close).join('\n'),
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
  // A handler resolving TWO sheets names them apart (`livenessA` / `livenessB`), so match the
  // refusal CALL as well as the canonical variable — otherwise such a handler would be classified
  // guarded only by accident, or not at all.
  [/\bsendSheetNotLive\(/, 'sendSheetNotLive refusal'],
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
  'POST /sheets/:sheetId/restore':
    'THE RESTORE FLOW ITSELF — the one operation that must see a deleted sheet. It is gated on the '
    + 'restore authority (hasSheetLifecycleAuthority) instead, and it can only ever clear `deleted_at`; '
    + 'it never reads or writes the sheet’s records. The call site carries a RESTORE-FLOW EXEMPT marker, '
    + 'asserted below.',
  'POST /sheets/:sheetId/trust-checkpoint-activate':
    'GUARDED, but DELIBERATELY NOT AT THIS LAYER. Existence — and so soft-deleted-ness — is a '
    + 'DIFFERENTIATED response on this route, and it moved every such response INSIDE the transaction, '
    + 'after the actor-authority lease and the post-lease final authorization, so a revoked-but-unexpired '
    + 'claims-admin cannot enumerate designated canary sheets. A refusal at the usual place re-opens that '
    + 'oracle (it broke the GATE-ORDER and ORACLE-AFTER-LEASE goldens). The `deleted_at IS NULL` filter '
    + 'therefore lives in `assertTrustCheckpointSheetExists` (multitable/trust-checkpoint-activation-authz.ts) '
    + 'at step 4c, where it inherits the correct ordering. The route does not even destructure '
    + '`sheetLiveness`, so nothing here can begin refusing on it out of order.',
  'POST /bases':
    'creates a BASE. It never resolves a sheet — the only `sheetId` token in its body belongs to the '
    + 'template-install helper text further down the file, not to this handler.',
  'POST /templates/:templateId/install':
    'CREATES sheets — and, since the #5861 install dedupe, MAY REPLAY a create it recorded up to the '
    + 'dedupe window ago. On the fresh path the sheets it returns are live by construction. On the '
    + 'replay path the liveness of exactly what it hands back IS asserted, just not in this handler '
    + 'body: `multitable/template-install-dedupe.ts` re-reads the recorded base (`meta_bases ... AND '
    + 'deleted_at IS NULL`) AND every recorded sheet id (`meta_sheets WHERE id = ANY(...) AND '
    + 'deleted_at IS NULL`, all of them or no replay) before returning the recorded response; any miss '
    + 'drops the ledger row and installs afresh. That is why the classifier still sees no guard token '
    + 'here. If that module ever stops re-asserting liveness, this exemption is false again.',
  'GET /record-subscription-notifications':
    'reads the CALLER’S OWN notification rows, keyed by user, not by sheet. It takes no sheet id.',
}

/**
 * ORDER, for the sheet-row EXISTENCE PROBE. The classifier above counts `loadSheetRow` (and an inline
 * `deleted_at IS NULL` sheet read) as a liveness guard, and it has no order rule. A probe that answers
 * 404 for a soft-deleted or absent sheet BEFORE the handler's first authority refusal tells a caller
 * who may not use that sheet whether it is still there — the oracle #5830 removed from
 * `requireRecordReadable`, still present in the route handlers named below. The list is exact and can
 * only shrink: a new handler of this shape reds, and a fixed one must leave.
 */
const EXISTENCE_PROBE = /\bawait\s+loadSheet(?:Row|RowShared|Summary)\s*\(|\bFROM meta_sheets WHERE id = \$1 AND deleted_at IS NULL\b/
/** Where a handler first refuses a caller for lack of authority (the shared record gate refuses inside). */
const AUTHORITY_REFUSAL = /\.status\(\s*403\s*\)|\bstatus:\s*403\b|\bsend\w*Forbidden\w*\(|\bForbiddenError\b|\brequireRecordReadable\(/
/** The probe's miss is answered with a 404 by the very next `if`. */
const PROBE_MISS_IS_404 = /^(?:(?!\bif\b)[\s\S]){0,160}\bif\s*\(\s*(?:!\s*\w+|\w+\.rows\.length\s*===\s*0)\s*\)\s*(?:\{\s*)?(?:return\s+res\.status\(\s*404\s*\)|throw\s+new\s+NotFoundError\b|return\s*\{\s*kind:\s*'error',\s*status:\s*404\b)/

function probesExistenceBeforeAuthority(body: string): boolean {
  const probe = body.search(EXISTENCE_PROBE)
  if (probe === -1) return false
  const authority = body.search(AUTHORITY_REFUSAL)
  return authority === -1 || probe < authority
}

const EXISTENCE_BEFORE_AUTHORITY_GAP = {
  reason: 'GAP — tracked in #5839 — each handler below reads the sheet row (deleted_at IS NULL) and answers 404 '
    + '(mostly echoing the id) before its first 403, so a signed-in caller the handler then refuses can tell a live '
    + 'sheet from a soft-deleted or absent one. Fix per handler: drop the probe (sheetLiveness already refuses a '
    + 'non-live sheet after the 403) or move it after the 403, with the values-free SHEET_NOT_FOUND_MESSAGE.',
  handlers: [
    'GET /fields',
    'GET /records-summary',
    'GET /sheets/:sheetId/config-history',
    'GET /sheets/:sheetId/form-share-candidates',
    'GET /sheets/:sheetId/view-aggregate',
    'GET /views',
    'PATCH /records/:recordId',
    'POST /fields',
    'POST /sheets/:sheetId/import-xlsx',
    'POST /views',
    'POST /views/:viewId/submit',
  ],
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

  /**
   * PROPORTIONALITY. Presence of *a* refusal is not enough for a handler that resolves MORE THAN ONE
   * sheet: `POST /crossbase/mirror-link` resolves both ends of the edge, and dropping the guard on
   * either one leaves the other's `sendSheetNotLive(` in the body, so a presence-only classifier still
   * calls it guarded. (Found by a witnessed-RED mutation that SURVIVED — the mutation was kept and the
   * guard strengthened, rather than the anchor quietly moved.)
   *
   * So: a handler that resolves N sheets through the capability resolver must carry at least N
   * liveness refusals, unless it establishes liveness some other way (loadSheetRow et al.) for all of
   * them, or is exempt.
   */
  it('every bound liveness variable is USED to refuse — counting refusals is not enough', () => {
    // Bind-and-use, not count-and-hope. `POST /crossbase/mirror-link` binds `livenessA` and
    // `livenessB`; a count-based check passes when one guard is dropped, because the OTHER end's
    // refusal is still in the body. Tie each BINDING to a refusal that names THAT variable.
    const offenders: string[] = []
    for (const h of inScope) {
      if (h.key in EXEMPT) continue
      const bound = new Set<string>()
      for (const m of h.body.matchAll(/sheetLiveness\s*:\s*(\w+)/g)) bound.add(m[1]!)
      if (/\{[^}]*\bsheetLiveness\b\s*[,}]/.test(h.body)) bound.add('sheetLiveness')
      for (const name of bound) {
        const used = new RegExp(`${name}\\s*!==\\s*'live'|sendSheetNotLive\\(\\s*res\\s*,\\s*${name}\\b|SheetNotLiveError\\(\\s*[^,]+,\\s*${name}\\b`)
          .test(h.body)
        if (!used) offenders.push(`${h.key} (line ${h.line}): binds \`${name}\` but never refuses on it`)
      }
    }

    expect(
      offenders,
      `${offenders.length} handler(s) resolve a sheet's liveness and then ignore it. A cross-sheet `
      + `write must not proceed because the OTHER end happened to be live:\n`
      + offenders.map((r) => `  - ${r}`).join('\n'),
    ).toEqual([])
  })

  it('GAP ledger: the handlers that probe sheet existence before their first authority refusal are exactly the named ones', () => {
    expect(EXISTENCE_BEFORE_AUTHORITY_GAP.reason).toMatch(/^GAP — tracked in #[1-9]\d* — \S/)
    const found = inScope.filter((h) => probesExistenceBeforeAuthority(h.body)).map((h) => h.key).sort()
    const named = [...EXISTENCE_BEFORE_AUTHORITY_GAP.handlers].sort()
    expect(
      found,
      'A sheet-row existence probe answers 404 before the first 403: move it after the authority check '
      + '(or drop it — sheetLiveness refuses after the 403). A fixed handler must leave the ledger.',
    ).toEqual(named)
    // What the reason rests on, per handler: the probe's miss is a 404.
    const notA404 = inScope
      .filter((h) => named.includes(h.key))
      .filter((h) => !PROBE_MISS_IS_404.test(h.body.slice(h.body.search(EXISTENCE_PROBE))))
      .map((h) => h.key)
    expect(notA404).toEqual([])
  })

  it('the existence-before-authority check reads order, not presence', () => {
    const probe = "const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)\n  if (!sheet) {\n    return res.status(404).json({})\n  }"
    const inline = "const r = await pool.query(\n  'SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',\n  [sheetId],\n)\nif (r.rows.length === 0) throw new NotFoundError('x')"
    const cap = "const { capabilities, sheetLiveness } = await resolveSheetCapabilities(req, q, sheetId)"
    const refuse = 'if (!capabilities.canRead) return sendForbidden(res)'
    const liveness = "if (sheetLiveness !== 'live') return sendSheetNotLive(res, sheetLiveness)"
    expect(probesExistenceBeforeAuthority([probe, cap, refuse, liveness].join('\n'))).toBe(true)
    expect(probesExistenceBeforeAuthority([inline, cap, refuse].join('\n'))).toBe(true)
    expect(probesExistenceBeforeAuthority([probe, cap].join('\n'))).toBe(true)
    expect(probesExistenceBeforeAuthority([probe, 'return res.status(403).json({})'].join('\n'))).toBe(true)
    expect(probesExistenceBeforeAuthority([cap, refuse, liveness, probe].join('\n'))).toBe(false)
    expect(probesExistenceBeforeAuthority(['if (!ok) return { kind: \'error\', status: 403 }', probe].join('\n'))).toBe(false)
    expect(probesExistenceBeforeAuthority(['const r = await requireRecordReadable(req, q, sheetId, recordId)', probe].join('\n'))).toBe(false)
    expect(probesExistenceBeforeAuthority([cap, refuse, liveness].join('\n'))).toBe(false)
    expect(PROBE_MISS_IS_404.test(probe.slice(probe.search(EXISTENCE_PROBE)))).toBe(true)
    expect(PROBE_MISS_IS_404.test(inline.slice(inline.search(EXISTENCE_PROBE)))).toBe(true)
    const soft = "const sheet = await loadSheetRow(q, sheetId)\nif (flag) log()\nif (!sheet) return res.status(404).json({})"
    expect(PROBE_MISS_IS_404.test(soft.slice(soft.search(EXISTENCE_PROBE)))).toBe(false)
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
    // ...it must be exempt BY NAME, not by the classifier happening to miss it...
    expect(Object.keys(EXEMPT)).toContain('POST /sheets/:sheetId/restore')
    // ...and the exemption must be stated at the call site too. Checked against the RAW body: the
    // classifier reads comment-stripped code, so this is the one assertion that is about the prose.
    expect(restore!.rawBody).toContain('RESTORE-FLOW EXEMPT')
  })
})

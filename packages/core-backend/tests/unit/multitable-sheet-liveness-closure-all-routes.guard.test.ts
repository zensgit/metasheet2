/**
 * SHEET-LIVENESS CLOSURE — ALL ROUTE FILES. The closed world of
 * `multitable-sheet-liveness-closure.guard.test.ts`, extended past `routes/univer-meta.ts`.
 *
 * ── Why ───────────────────────────────────────────────────────────────────────
 * Soft delete keeps `meta_records` (and every other `sheet_id`-keyed row) alive, so any path that
 * addresses a sheet by id and never asks "is this sheet live?" keeps serving and mutating a DELETED
 * sheet. The sibling guard proves that for univer-meta.ts only. The same gap was then found by hand in
 * files it never looked at — automation.ts rule-scoped reads and test-run (#5791, #5812, #5817) and the
 * api-tokens.ts DingTalk group routes (#5818) — and building this guard found three more unguarded
 * files (comments.ts, dashboard.ts, and four multitable-ai.ts routes), fixed in the same change.
 *
 * ── What is closed ────────────────────────────────────────────────────────────
 *  1. FILES. Every module under src/ that registers a route is scanned. A file with at least one
 *     sheet-addressed handler must be listed in COVERED below (or be univer-meta.ts, which the sibling
 *     guard owns). A new route file that addresses a sheet reds here until someone decides about it.
 *  2. HANDLERS. In a covered file every sheet-addressed handler is GUARDED or EXEMPT BY NAME with a
 *     reason. Exemption by omission is not possible; an exemption whose route disappeared, or whose
 *     route became guarded, reds too. Exemptions that rest on a checkable fact carry a `stillTrue`
 *     check, so the reason cannot quietly rot.
 *  3. EVERY RESOLVER CALL. A handler that calls the capability resolver must bind the liveness THAT
 *     call returned and refuse on it, in the same function, after the capability decision (capability
 *     403 first, then the liveness 404 — no liveness oracle). Presence of "some" refusal is not enough:
 *     the AI bulk routes looked guarded (a per-row `requireRecordReadable` in the body) while the
 *     hoisted sheet-level gate ignored liveness and ran the scope read, the job lookup and the quota
 *     decision against a deleted sheet.
 *  4. POPULATION. Each covered file must yield at least its recorded number of handlers and of
 *     sheet-addressed handlers — a scanner or style regression that finds nothing reds instead of
 *     passing vacuously.
 *
 * A handler is SHEET-ADDRESSED if its path has `:sheetId` / `:spreadsheetId`, or it (or a same-file
 * helper it calls) reads `sheetId` / `spreadsheetId` from the request, declares one in a request schema,
 * calls a sheet capability/liveness resolver, or filters rows by `sheet_id`. Helpers are resolved
 * lexically from the call site and READ — never classified by name (tests/utils/sheet-liveness-route-scan.ts).
 * Helpers imported from another file count only when listed in VETTED_EXTERNAL_GUARDS, whose own
 * bodies are proven below.
 *
 * CRLF: sources are normalized before scanning, and a self-test re-scans a file forced to CRLF and
 * demands the identical verdict (the #3365 tripwire once found zero routes on a CRLF tree).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  LIVENESS_BLIND_RESOLVERS,
  codeOf,
  findFunctionsNamed,
  namedImports,
  resolveInjectedFunctions,
  resolverCallSites,
  scanRouteSource,
  type HandlerUnit,
  type RouteHandler,
  type ScannedRouteFile,
} from '../utils/sheet-liveness-route-scan'

const SRC_ROOT = join(__dirname, '../../src')

function readSource(rel: string): string {
  return readFileSync(join(SRC_ROOT, ...rel.split('/')), 'utf8')
}

function listSourceFiles(dir = SRC_ROOT, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      listSourceFiles(abs, out)
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) {
      out.push(relative(SRC_ROOT, abs).split(sep).join('/'))
    }
  }
  return out
}

// ── Classification ──────────────────────────────────────────────────────────

const SHEET_ID_INPUTS: RegExp[] = [
  /\breq\.(query|body|params)\??\.(sheetId|spreadsheetId)\b/,
  /\b(sheetId|spreadsheetId)\s*:\s*z\./,
  /\b(body|input|payload|parsed\.data|parse\.data)\??\.(sheetId|spreadsheetId)\b/,
  /\{[^}]*\b(sheetId|spreadsheetId)\b[^}]*\}\s*=\s*(req\.(body|query|params)|parsed?\.data)\b/,
  /\b(resolveSheetCapabilities|resolveSheetReadableCapabilities|resolveSheetCapabilitiesForUser|resolveSheetCapabilitiesForAccess|requireRecordReadable|loadSheetLiveness|assertSheetLive)\(/,
  /\bsheet_id\s*=\s*\$\d/,
  /\bwhere\(\s*'sheet_id'/,
]

function addressesASheet(h: RouteHandler): boolean {
  if (h.paths.some((p) => /:(sheetId|spreadsheetId)\b/.test(p))) return true
  const text = [h.code, ...h.helpers.values(), h.referenced].join('\n')
  return SHEET_ID_INPUTS.some((re) => re.test(text))
}

/** Mechanisms that REFUSE a non-live sheet. Matched against code only (comments are gone). */
const LIVENESS_REFUSALS: Array<[RegExp, string]> = [
  [/\bsheetLiveness\s*!==\s*'live'/, 'explicit sheetLiveness refusal'],
  [/\bsendSheetNotLive\(/, 'sendSheetNotLive refusal'],
  [/\bassertSheetLive\(/, 'assertSheetLive'],
  [/\bSheetNotLiveError\b/, 'SheetNotLiveError'],
  [/\bloadSheetRow\(/, 'loadSheetRow (deleted_at IS NULL)'],
  [/\bloadSheetSummary\(/, 'loadSheetSummary (deleted_at IS NULL)'],
  [/deleted_at IS NULL/, 'inline deleted_at IS NULL'],
]

function livenessRefusalIn(code: string): string | null {
  for (const [re, label] of LIVENESS_REFUSALS) if (re.test(code)) return label
  return null
}

/**
 * Imported guards, trusted ONLY because their definitions are proven below ('vetted external guards
 * refuse a non-live sheet'), and only when the handler really imports them from that file.
 */
const VETTED_EXTERNAL_GUARDS: Record<string, { file: string }> = {
  requireRecordReadable: { file: 'routes/univer-meta.ts' },
}

/**
 * Guards injected through dependency injection. The route file's helper must hand the request to the
 * injected resolver, and every registrar call site must inject a function that filters
 * `deleted_at IS NULL` — both proven below.
 */
const DELEGATED_GUARDS: Record<string, { helper: string; delegation: RegExp; wiringFile: string; registrar: string; property: string }> = {
  'routes/recovery-archive-restore-owner.ts': {
    helper: 'resolveContext',
    delegation: /\bdependencies\.resolveContext\(/,
    wiringFile: 'routes/univer-meta.ts',
    registrar: 'registerRecoveryArchiveRestoreOwnerRoutes',
    property: 'resolveContext',
  },
}

const scanCache = new Map<string, ScannedRouteFile>()
function scan(rel: string): ScannedRouteFile {
  let scanned = scanCache.get(rel)
  if (!scanned) {
    scanned = scanRouteSource(rel, readSource(rel))
    scanCache.set(rel, scanned)
  }
  return scanned
}

function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  return `${posix.normalize(posix.join(posix.dirname(fromFile), specifier))}.ts`
}

function guardOf(file: string, h: RouteHandler): string | null {
  const direct = livenessRefusalIn([h.code, ...h.helpers.values()].join('\n'))
  if (direct) return direct
  const imports = namedImports(scan(file).sourceFile)
  for (const [name, vetted] of Object.entries(VETTED_EXTERNAL_GUARDS)) {
    const spec = imports.get(name)
    const calls = new RegExp(`\\b${name}\\(`).test([h.code, ...h.helpers.values()].join('\n'))
    if (calls && !h.helpers.has(name) && spec && resolveImport(file, spec) === vetted.file) {
      return `${name} (${vetted.file}; proven to refuse a non-live sheet)`
    }
  }
  const delegated = DELEGATED_GUARDS[file]
  if (delegated) {
    const helper = h.helpers.get(delegated.helper)
    if (helper && delegated.delegation.test(helper)) {
      return `delegated to the resolver injected at ${delegated.wiringFile} (proven below)`
    }
  }
  return null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function refusalOn(code: string, subject: string): RegExpExecArray | null {
  const s = escapeRegExp(subject)
  return new RegExp(`\\b${s}\\s*!==\\s*'live'|\\bsendSheetNotLive\\(\\s*\\w+\\s*,\\s*${s}\\s*\\)|\\bSheetNotLiveError\\([^,()]+,\\s*${s}\\b`).exec(code)
}

/**
 * Per-call-site rule (3 in the header). Returns the violations for one function unit. `requireOrder`
 * additionally demands a capability decision (`.can<X>` / `can<X>`) between the resolver call and the
 * liveness refusal.
 */
function resolverViolations(unit: HandlerUnit, sf: ScannedRouteFile['sourceFile'], requireOrder: boolean): string[] {
  const problems: string[] = []
  for (const site of resolverCallSites(unit.node, sf)) {
    const where = `${unit.label}: ${site.resolver}(…) at line ${site.line}`
    let subject: string
    let bindAt: number
    if (LIVENESS_BLIND_RESOLVERS.has(site.resolver)) {
      const bound = /\b(\w+)\s*=\s*await\s+loadSheetLiveness\(/.exec(unit.code)
      if (!bound) {
        problems.push(`${where} returns no liveness and the function never loads it (loadSheetLiveness)`)
        continue
      }
      subject = bound[1]!
      bindAt = unit.code.indexOf(`= await ${site.resolver}(`)
    } else if (!site.binding) {
      problems.push(`${where} does not bind the sheetLiveness it returns`)
      continue
    } else {
      subject = site.binding.kind === 'name' ? site.binding.name : `${site.binding.name}.sheetLiveness`
      const bindRe = site.binding.kind === 'member'
        ? new RegExp(`\\b${escapeRegExp(site.binding.name)}\\s*=\\s*await\\s+${site.resolver}\\(`)
        : new RegExp(`\\{[^}]*\\bsheetLiveness\\b(\\s*:\\s*${escapeRegExp(site.binding.name)})?[^}]*\\}\\s*=\\s*await\\s+${site.resolver}\\(`)
      bindAt = bindRe.exec(unit.code)?.index ?? -1
    }
    const refusal = refusalOn(unit.code, subject)
    if (!refusal) {
      problems.push(`${where} binds \`${subject}\` but never refuses on it`)
      continue
    }
    if (requireOrder) {
      const between = bindAt >= 0 ? unit.code.slice(bindAt, refusal.index) : ''
      if (!/\bcan[A-Z]\w*\b/.test(between.replace(/^[^\n]*\n/, ''))) {
        problems.push(`${where} refuses on \`${subject}\` BEFORE any capability decision (403 must come first — no liveness oracle)`)
      }
    }
  }
  return problems
}

// ── The closed world ────────────────────────────────────────────────────────

interface Exemption {
  reason: string
  /** A checkable fact the reason rests on. */
  stillTrue?: (h: RouteHandler) => boolean
}

interface CoveredFile {
  /** Floor for registrations found in the file. */
  minHandlers: number
  /** Floor for sheet-addressed handlers found in the file. */
  minInScope: number
  exempt: Record<string, Exemption>
}

const readsNoSheetData = (h: RouteHandler) => !/\b(pool|poolManager|db|query|selectFrom|insertInto|updateTable|meta_records|meta_fields)\b/.test(h.code)

const ownJobGate = (h: RouteHandler) => {
  const gate = h.helpers.get('resolveBulkJobForActor') ?? ''
  return /\bheader\.actorId !== userId\b/.test(gate)
    && /\bheader\.sheetId !== sheetId\b/.test(gate)
    && !/\b(meta_records|meta_fields|requireRecordReadable|readRecordOnce|resolveSheet\w*Capabilities)\b/.test(h.code)
}

const LEGACY_SHEET_GAP = 'GAP — tracked in #TBD-legacy-sheet-parent-liveness — LEGACY spreadsheet API: `:sheetId` names a row of '
  + 'the legacy `sheets` table (kysely `selectFrom(\'sheets\')`), not `meta_sheets`, so multitable/sheet-liveness.ts '
  + 'does not apply. But DELETE /api/spreadsheets/:id soft-deletes the parent (`spreadsheets.deleted_at`) and this '
  + 'handler never checks it, so a soft-deleted spreadsheet'

const LEGACY_PERMISSION_GAP = 'GAP — tracked in #TBD-legacy-spreadsheet-permissions — `:id` is read from / written to '
  + '`spreadsheet_permissions.sheet_id`, the SAME table multitable reads as per-sheet grants '
  + '(permission-service loadSheetPermissionScopeMap). Gated only by rbacGuard(\'spreadsheet-permissions\', …): no '
  + 'sheet liveness and no canManageSheetAccess, so it '

const LEGACY_PERMISSION_NOT_FIXED = '. Not fixed here: a meta-sheet liveness refusal would 404 every legacy '
  + 'spreadsheet id this route was written for; the owner has to decide which entity `:id` is.'

const COVERED: Record<string, CoveredFile> = {
  'routes/api-tokens.ts': { minHandlers: 15, minInScope: 6, exempt: {} },
  'routes/approvals.ts': {
    minHandlers: 40,
    minInScope: 1,
    exempt: {
      'GET /api/approvals/record-link-options': {
        reason: 'OWNED BY THE APPROVAL WINDOW — this route file is not edited from here. Liveness is nonetheless '
          + 'established below the route: listApprovalRecordLinkOptions (services/approval-record-link-options.ts) '
          + 'refuses unless resolveRecordLinkTargetAuthOnQuery (services/approval-record-link-txn-auth.ts) finds the '
          + 'pinned sheet `WHERE id = $1 AND deleted_at IS NULL`; both links are asserted below.',
        stillTrue: (h) => /\blistApprovalRecordLinkOptions\(/.test(h.code),
      },
    },
  },
  'routes/automation.ts': {
    minHandlers: 9,
    minInScope: 5,
    exempt: {
      'GET /automation-executions': {
        reason: 'PLATFORM-ADMIN GOVERNANCE READ and the post-mortem path for deleted rules and sheets '
          + '(mounted behind requireAdminRole(), asserted). `sheetId` is only an optional FILTER over the '
          + 'cross-sheet execution history, not an address of sheet data; it is the surface the rule-scoped '
          + '/logs read sends operators to once a rule or sheet is gone, so refusing a deleted sheet here '
          + 'would remove the only way to audit what its automations did.',
        stillTrue: (h) => /\brequireAdminRole\(\)/.test(h.middleware),
      },
    },
  },
  'routes/comments.ts': { minHandlers: 18, minInScope: 10, exempt: {} },
  'routes/dashboard.ts': { minHandlers: 12, minInScope: 12, exempt: {} },
  'routes/federation.ts': {
    minHandlers: 20,
    minInScope: 1,
    exempt: {
      'POST /api/federation/export/athena': {
        reason: 'SIMULATED EXPORT STUB — `spreadsheetId` is echoed into an audit row and the response; the '
          + 'handler touches no pool, query, db or sheet table (asserted), so there is no sheet data to '
          + 'protect. A real export wired here must be guarded, and this entry then stops being true.',
        stillTrue: readsNoSheetData,
      },
    },
  },
  'routes/multitable-ai.ts': {
    minHandlers: 11,
    minInScope: 9,
    exempt: {
      'GET /sheets/:sheetId/ai/shortcut/bulk-job/:jobId': {
        reason: 'THE CALLER’S OWN JOB, not the sheet’s data: resolveBulkJobForActor (same file, asserted) 404s '
          + 'unless the job exists, was started by THIS caller and belongs to THIS :sheetId, so the sheet id '
          + 'is only the job’s cross-sheet filter. The poll returns header counters and reads no record. It '
          + 'stays answerable after a soft delete so the owner can see a still-running job and cancel it.',
        stillTrue: ownJobGate,
      },
      'GET /sheets/:sheetId/ai/shortcut/bulk-job/:jobId/rows': {
        reason: 'THE CALLER’S OWN JOB ROWS — the durable review diff the SAME caller generated while they could '
          + 'read the sheet; owner + cross-sheet gated by resolveBulkJobForActor (asserted), no live record '
          + 'read. Kept readable after a soft delete for the same reason as the poll. The diff does carry '
          + 'record values captured at generation time; if that is judged a disclosure, this becomes a GAP.',
        stillTrue: ownJobGate,
      },
      'POST /sheets/:sheetId/ai/shortcut/bulk-job/:jobId/cancel': {
        reason: 'MUST WORK ON A DELETED SHEET — cancel is the only brake on an in-flight job whose sheet was '
          + 'deleted mid-run (the in-process generate worker, ai-bulk-job-service runGeneratePhase, does not '
          + 're-check liveness). Owner + cross-sheet gated by resolveBulkJobForActor (asserted); it only flips '
          + 'the job state via cancelBulkJob and never touches the sheet.',
        stillTrue: (h) => ownJobGate(h) && /\bcancelBulkJob\(/.test(h.code),
      },
    },
  },
  'routes/multitable-button.ts': { minHandlers: 1, minInScope: 1, exempt: {} },
  'routes/multitable-record-approvals.ts': { minHandlers: 2, minInScope: 2, exempt: {} },
  'routes/recovery-archive-restore-owner.ts': { minHandlers: 9, minInScope: 9, exempt: {} },
  'routes/spreadsheet-permissions.ts': {
    minHandlers: 3,
    minInScope: 3,
    exempt: {
      'GET /api/spreadsheets/:id/permissions': {
        reason: `${LEGACY_PERMISSION_GAP}lists grants on a soft-deleted multitable sheet${LEGACY_PERMISSION_NOT_FIXED}`,
      },
      'POST /api/spreadsheets/:id/permissions/grant': {
        reason: `${LEGACY_PERMISSION_GAP}grants on a soft-deleted multitable sheet (and on a live one without sheet authority)${LEGACY_PERMISSION_NOT_FIXED}`,
      },
      'POST /api/spreadsheets/:id/permissions/revoke': {
        reason: `${LEGACY_PERMISSION_GAP}revokes on a soft-deleted multitable sheet (and on a live one without sheet authority)${LEGACY_PERMISSION_NOT_FIXED}`,
      },
    },
  },
  'routes/spreadsheets.ts': {
    minHandlers: 9,
    minInScope: 3,
    exempt: {
      'PUT /api/spreadsheets/:id/sheets/:sheetId': { reason: `${LEGACY_SHEET_GAP}’s sheet metadata stays writable.` },
      'GET /api/spreadsheets/:id/sheets/:sheetId/cells': { reason: `${LEGACY_SHEET_GAP}’s cells stay readable.` },
      'PUT /api/spreadsheets/:id/sheets/:sheetId/cells': {
        reason: `${LEGACY_SHEET_GAP}’s cells stay writable — and this handler never binds :sheetId to :id at all.`,
      },
    },
  },
}

/** Files whose closed world lives in a sibling guard. */
const SIBLING_GUARDED: Record<string, string> = {
  'routes/univer-meta.ts': 'multitable-sheet-liveness-closure.guard.test.ts',
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('sheet-liveness closure over EVERY route file', () => {
  it('scanner self-test: multi-line/array/one-liner registrations, lexical helpers, comments never count, CRLF', () => {
    const fixture = [
      "import { requireRecordReadable } from './univer-meta'",
      "const listPaths = ['/api/things', '/api/things/alias']",
      'async function gate(req, res, sheetId) {',
      '  const { capabilities, sheetLiveness } = await resolveSheetCapabilities(req, q, sheetId)',
      '  if (!capabilities.canRead) return null',
      "  if (sheetLiveness !== 'live') { sendSheetNotLive(res, sheetLiveness); return null }",
      '  return capabilities',
      '}',
      'function lookalike(req) { return null }',
      'export function build(router) {',
      '  router.get(listPaths, async (req, res) => { res.json({}) })',
      '  router.post(',
      "    '/sheets/:sheetId/a',",
      '    async (req, res) => {',
      '      if (!(await gate(req, res, req.params.sheetId))) return',
      '    },',
      '  )',
      "  router.post('/sheets/:sheetId/b', (req, res) => handleB(req, res))",
      '  async function handleB(req, res) {',
      "    // sendSheetNotLive( — prose only; deleted_at IS NULL",
      '    const { capabilities } = await resolveSheetReadableCapabilities(req, q, req.params.sheetId)',
      '  }',
      "  router.get('/sheets/:sheetId/c', async (req, res) => {",
      '    const gate = (x) => x',
      '    gate(req)',
      '  })',
      "  router.get('/sheets/:sheetId/d', async (req, res) => { await requireRecordReadable(req, q, req.params.sheetId, 'r') })",
      "  router.get('/not-a-sheet', async (req, res) => { lookalike(req) })",
      '}',
    ].join('\n')
    const lf = scanRouteSource('routes/fixture.ts', fixture)
    const crlf = scanRouteSource('routes/fixture.ts', fixture.replace(/\n/g, '\r\n'))
    expect(lf.handlers.map((h) => h.key)).toEqual([
      'GET [listPaths]',
      'POST /sheets/:sheetId/a',
      'POST /sheets/:sheetId/b',
      'GET /sheets/:sheetId/c',
      'GET /sheets/:sheetId/d',
      'GET /not-a-sheet',
    ])
    expect(crlf.handlers.map((h) => h.key)).toEqual(lf.handlers.map((h) => h.key))
    const byKey = (s: ScannedRouteFile, key: string) => s.handlers.find((h) => h.key === key)!
    expect(byKey(lf, 'GET [listPaths]').paths).toEqual(['/api/things', '/api/things/alias'])
    // a — guarded THROUGH the helper, whose body was read.
    expect(livenessRefusalIn([...byKey(lf, 'POST /sheets/:sheetId/a').helpers.values()].join('\n'))).not.toBeNull()
    // b — the refusal words exist only in a comment: not guarded, and its resolver call binds nothing.
    const b = byKey(lf, 'POST /sheets/:sheetId/b')
    expect(b.helpers.has('handleB')).toBe(true)
    expect(livenessRefusalIn([b.code, ...b.helpers.values()].join('\n'))).toBeNull()
    expect(b.units.flatMap((u) => resolverViolations(u, lf.sourceFile, true))).toHaveLength(1)
    // c — a local `gate` shadows the guarded module helper: it must NOT resolve to it.
    expect(byKey(lf, 'GET /sheets/:sheetId/c').helpers.has('gate')).toBe(false)
    // d — the imported vetted guard is a call, not a local helper.
    expect(byKey(lf, 'GET /sheets/:sheetId/d').helpers.has('requireRecordReadable')).toBe(false)
    // The same verdicts on the CRLF copy.
    for (const h of lf.handlers) {
      const twin = byKey(crlf, h.key)
      expect(twin.code).toBe(h.code)
      expect([...twin.helpers.keys()]).toEqual([...h.helpers.keys()])
    }
  })

  it('FILES: every router module that addresses a sheet is covered here or by the sibling guard; no dead file entries', () => {
    const sheetAddressing: string[] = []
    let routerModules = 0
    for (const rel of listSourceFiles()) {
      const raw = readSource(rel)
      if (!/\.(get|post|put|patch|delete|addRoute)\(/.test(raw)) continue
      const scanned = scan(rel)
      if (scanned.handlers.length === 0) continue
      routerModules += 1
      if (scanned.handlers.some(addressesASheet)) sheetAddressing.push(rel)
    }
    const known = new Set([...Object.keys(COVERED), ...Object.keys(SIBLING_GUARDED)])
    const uncovered = sheetAddressing.filter((rel) => !known.has(rel))
    expect(
      uncovered,
      `${uncovered.length} route module(s) address a sheet but are not in this closed world:\n`
      + uncovered.map((r) => `  - src/${r}`).join('\n')
      + '\nAdd each to COVERED (and guard or exempt its handlers).',
    ).toEqual([])
    const dead = [...known].filter((rel) => !sheetAddressing.includes(rel))
    expect(dead, `closed-world entries that no longer address a sheet: ${dead.join(', ')}`).toEqual([])
    // Tripwire for the discovery walk itself.
    expect(routerModules).toBeGreaterThan(40)
    expect(sheetAddressing.length).toBeGreaterThanOrEqual(Object.keys(COVERED).length)
  })

  it('the sibling guard still owns univer-meta.ts', () => {
    for (const [rel, guard] of Object.entries(SIBLING_GUARDED)) {
      const sibling = readFileSync(join(__dirname, guard), 'utf8')
      expect(sibling).toContain(`'../../src/${rel}'`)
    }
  })

  for (const [file, config] of Object.entries(COVERED)) {
    describe(file, () => {
      const handlers = () => scan(file).handlers
      const inScope = () => handlers().filter(addressesASheet)

      it('POPULATION: the scan found the recorded handlers (a file that yields nothing reds)', () => {
        expect(config.minHandlers).toBeGreaterThan(0)
        expect(config.minInScope).toBeGreaterThan(0)
        expect(handlers().length, `${file}: registrations found`).toBeGreaterThanOrEqual(config.minHandlers)
        expect(inScope().length, `${file}: sheet-addressed handlers found`).toBeGreaterThanOrEqual(config.minInScope)
        if (inScope().some((h) => !(h.key in config.exempt))) {
          expect(inScope().filter((h) => guardOf(file, h) !== null).length).toBeGreaterThan(0)
        }
      })

      it('every sheet-addressed handler is GUARDED or EXEMPT BY NAME', () => {
        const unaccounted = inScope()
          .filter((h) => !guardOf(file, h) && !(h.key in config.exempt))
          .map((h) => `${h.key}  (line ${h.line})`)
        expect(
          unaccounted,
          `${file}: ${unaccounted.length} sheet-addressed route(s) establish no sheet liveness and are not exempt:\n`
          + unaccounted.map((r) => `  - ${r}`).join('\n')
          + '\nGuard the handler (capability 403 first, then sendSheetNotLive) or exempt it BY NAME with a reason.',
        ).toEqual([])
      })

      it('every resolver call binds its own liveness and refuses on it, after the capability decision', () => {
        const sf = scan(file).sourceFile
        const problems = inScope()
          .filter((h) => !(h.key in config.exempt))
          .flatMap((h) => h.units.flatMap((u) => resolverViolations(u, sf, true).map((p) => `${h.key} → ${p}`)))
        expect([...new Set(problems)], `${file}:\n${[...new Set(problems)].join('\n')}`).toEqual([])
      })

      it('exemptions are live, necessary, reasoned and still true', () => {
        const all = handlers()
        const problems: string[] = []
        for (const [key, exemption] of Object.entries(config.exempt)) {
          const h = all.find((x) => x.key === key)
          if (!h) { problems.push(`${key}: no such route (dead exemption)`); continue }
          if (!addressesASheet(h)) problems.push(`${key}: not sheet-addressed (unnecessary exemption)`)
          if (guardOf(file, h)) problems.push(`${key}: now guarded (${guardOf(file, h)}) — drop the exemption`)
          const reason = typeof exemption.reason === 'string' ? exemption.reason.trim() : ''
          if (reason.length < 80) problems.push(`${key}: exemption reason missing or too thin`)
          if (reason.startsWith('GAP') && !/^GAP — tracked in #(\d+|TBD-[a-z0-9-]+) — \S/.test(reason)) {
            problems.push(`${key}: a GAP exemption must name its tracker: "GAP — tracked in #<issue> — <why>"`)
          }
          if (exemption.stillTrue && !exemption.stillTrue(h)) problems.push(`${key}: the fact this exemption rests on is no longer true`)
        }
        expect(problems, `${file}:\n${problems.join('\n')}`).toEqual([])
      })
    })
  }

  it('vetted external guards refuse a non-live sheet (their bodies, not their names)', () => {
    for (const [name, vetted] of Object.entries(VETTED_EXTERNAL_GUARDS)) {
      const scanned = scanRouteSource(vetted.file, readSource(vetted.file))
      const defs = findFunctionsNamed(scanned.sourceFile, name)
      expect(defs, `${vetted.file} must define ${name} exactly once`).toHaveLength(1)
      const unit: HandlerUnit = { label: name, node: defs[0]!, code: codeOf(defs[0]!, scanned.sourceFile) }
      expect(resolverCallSites(unit.node, scanned.sourceFile).length, `${name} must resolve the sheet itself`).toBeGreaterThan(0)
      // Liveness is asked before authority in this helper (a pre-existing, record-scoped order), so
      // the order clause is not applied — only bind-and-refuse.
      expect(resolverViolations(unit, scanned.sourceFile, false)).toEqual([])
      expect(unit.code).toMatch(/status:\s*404/)
    }
  })

  it('delegated guards: the route helper hands off to the injected resolver, and every injected resolver filters deleted sheets', () => {
    for (const [file, delegated] of Object.entries(DELEGATED_GUARDS)) {
      const handlersHere = scan(file).handlers.filter(addressesASheet)
      expect(handlersHere.length).toBeGreaterThan(0)
      for (const h of handlersHere) {
        expect(h.helpers.get(delegated.helper) ?? '', `${h.key} must call ${delegated.helper}`).toMatch(delegated.delegation)
      }
      const wiring = scanRouteSource(delegated.wiringFile, readSource(delegated.wiringFile))
      const injected = resolveInjectedFunctions(wiring.sourceFile, delegated.registrar, delegated.property)
      expect(injected.length, `${delegated.wiringFile} must wire ${delegated.registrar}({ ${delegated.property} })`).toBeGreaterThan(0)
      for (const fn of injected) {
        const code = codeOf(fn, wiring.sourceFile)
        // The FIRST sheet lookup — the one whose absence refuses the request — must carry the filter.
        // (A filter on a later lookup, e.g. the fresh re-check, does not gate the initial answer: a
        // probe that dropped only the first filter survived an unanchored version of this assertion.)
        const gate = /const (\w+) = await query\(\s*`([^`]*)`[\s\S]*?const (\w+) = \1\.rows\[0\][\s\S]*?if \(!\3\) \{\s*return[^;]*ok: false/.exec(code)
        expect(gate, `${delegated.wiringFile}: the injected resolver must refuse when its sheet lookup finds no row`).not.toBeNull()
        expect(gate![2]).toMatch(/FROM public\.meta_sheets sheet_row[\s\S]*WHERE sheet_row\.id = \$1 AND sheet_row\.deleted_at IS NULL/)
        // Authority before existence: the 401/403 answers precede the liveness lookup.
        const authorityAt = code.indexOf('canManageSheetAccess')
        expect(authorityAt).toBeGreaterThanOrEqual(0)
        expect(authorityAt).toBeLessThan(gate!.index)
      }
    }
  })

  it('the approval-window exemption rests on a service-level liveness filter that still exists', () => {
    const service = scanRouteSource('services/approval-record-link-options.ts', readSource('services/approval-record-link-options.ts'))
    const list = findFunctionsNamed(service.sourceFile, 'listApprovalRecordLinkOptions')
    expect(list).toHaveLength(1)
    const listCode = codeOf(list[0]!, service.sourceFile)
    expect(listCode).toMatch(/await resolveRecordLinkTargetAuthOnQuery\(/)
    expect(listCode).toMatch(/if \(!targetAuth\.ok\) \{\s*return/)
    const auth = scanRouteSource('services/approval-record-link-txn-auth.ts', readSource('services/approval-record-link-txn-auth.ts'))
    const resolver = findFunctionsNamed(auth.sourceFile, 'resolveRecordLinkTargetAuthOnQuery')
    expect(resolver).toHaveLength(1)
    const resolverCode = codeOf(resolver[0]!, auth.sourceFile)
    expect(resolverCode).toMatch(/FROM meta_sheets WHERE id = \$1 AND deleted_at IS NULL/)
    expect(resolverCode).toMatch(/membershipOk/)
  })
})

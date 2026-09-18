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
 * files (comments.ts, dashboard.ts, and four multitable-ai.ts routes) plus the four socket / Yjs
 * authorization checkers in index.ts, fixed in the same change.
 *
 * ── What is closed ────────────────────────────────────────────────────────────
 *  1. FILES. Every module under src/ is parsed — no text pre-filter decides which ones — and every
 *     registration shape is read (`x.get(…)`, `x['get'](…)`, `x[CONST_VERB](…)`, `x.route(p).get(…)`,
 *     `x.use(p, inlineFn)`, `x.addRoute(…)`). A file with at least one sheet-addressed handler must be
 *     listed in COVERED below (or be univer-meta.ts, which the sibling guard owns). A new route file that
 *     addresses a sheet reds here until someone decides about it. A registration whose handler, path or
 *     verb cannot be read (imported handler, `controller.method`, a spread handler list,
 *     `app[method](path, fn)`) is OPAQUE and must be named — nothing is skipped silently.
 *  2. HANDLERS. In a covered file every sheet-addressed handler is GUARDED or EXEMPT BY NAME with a
 *     reason. Exemption by omission is not possible; an exemption whose route disappeared, or whose
 *     route became guarded, reds too. Exemptions that rest on a checkable fact carry a `stillTrue`
 *     check over the handler AND its same-file helpers, so the reason cannot quietly rot.
 *  3. GUARDED MEANS PROVEN ON THE TREE (tests/utils/sheet-liveness-route-scan.ts `analyzeHandler`):
 *     - every capability-resolver call binds the liveness IT returned, and an `if (<that> !== 'live')`
 *       whose branch always leaves follows on the same path (no extra condition, no wrapping branch);
 *     - a capability 403 sits between the resolver call and that refusal (403 first, then the liveness
 *       404 — no liveness oracle), and NOTHING ELSE runs in that window but exiting 401/403 checks and
 *       await-free declarations (a write there lands on a deleted sheet);
 *     - the refusal really refuses: it answers 403/404/410, awaits nothing and reads nothing;
 *     - the result of every gate (a same-file gate helper, a vetted imported guard, the injected
 *       resolver) is acted on by the very next statement, or the gate is the last thing the function
 *       does — a gate whose `null` is ignored does not count;
 *     - the gate runs first: nothing but the named pre-gate calls is awaited before it;
 *     - a per-row refusal (`continue`) or a helper that answers with a value does not stop the handler
 *       and does not count as its guard (the AI bulk routes once looked guarded that way).
 *  4. POPULATION. Each covered file must yield at least its recorded number of handlers and of
 *     sheet-addressed handlers; the behaviour tests of comments.ts, dashboard.ts and multitable-ai.ts
 *     pin their route tables to the SAME scan (`sheetAddressedRouteKeys`), so a new route reds there
 *     until it gets a behaviour row.
 *  5. COLLAB CHECKERS. The `set…Checker(fn)` seams (socket sheet/comment rooms, comment-mention
 *     notify, Yjs subscribe) are sheet-addressed request surfaces without being routes: each one that
 *     resolves sheet capabilities must also refuse a non-live sheet, with EXACTLY the value it uses for
 *     "not permitted" (CHECKER_REFUSALS) — `return true` is not a refusal, and a Yjs `null` would read
 *     as NOT_FOUND where a caller without read gets FORBIDDEN (a liveness oracle).
 *  6. GAPS. A known hole stays visible as a named exemption whose reason says
 *     "GAP — tracked in #<issue> — …"; a placeholder tracker (TBD) is refused.
 *
 * A handler is SHEET-ADDRESSED if its path has a sheet-id param (`:sheetId`, `:spreadsheetId`,
 * `:…SheetId`, `:tableId`), or it (or a same-file helper it calls) reads such an id from the request
 * (dot or bracket access), declares one in a request schema, calls a sheet capability/liveness
 * resolver, or filters rows by `sheet_id` (`= $n`, `= ANY(`, `IN (`, query-builder `where…('sheet_id'`).
 *
 * CRLF: sources are normalized before scanning, and a self-test re-scans a file forced to CRLF and
 * demands the identical verdict (the #3365 tripwire once found zero routes on a CRLF tree).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  addressesASheet,
  analyzeHandler,
  callSitesNamed,
  checkerRegistrations,
  codeOf,
  findFunctionsNamed,
  namedImports,
  resolveInjectedFunctions,
  scanRouteSource,
  sheetTableLivenessFilter,
  type AnalyzeOptions,
  type HandlerAnalysis,
  type HandlerUnit,
  type OpaqueRegistration,
  type RouteHandler,
  type ScannedRouteFile,
} from '../utils/sheet-liveness-route-scan'

const SRC_ROOT = join(__dirname, '../../src')
const REPO_ROOT = join(__dirname, '../../../..')

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

const scanCache = new Map<string, ScannedRouteFile>()
function scan(rel: string): ScannedRouteFile {
  let scanned = scanCache.get(rel)
  if (!scanned) {
    scanned = scanRouteSource(rel, readSource(rel))
    scanCache.set(rel, scanned)
  }
  return scanned
}

/** The handler, its same-file helpers and the non-function declarations it references. */
const everything = (h: RouteHandler): string => [h.code, ...h.helpers.values(), h.referenced].join('\n')

function functionCode(rel: string, name: string): string {
  const s = scan(rel)
  const defs = findFunctionsNamed(s.sourceFile, name)
  return defs.map((d) => codeOf(d, s.sourceFile)).join('\n')
}

// ── Mechanisms ──────────────────────────────────────────────────────────────

/**
 * Imported guards, trusted ONLY because their definitions are proven below ('vetted external guards
 * refuse a non-live sheet'), and only when the handler really imports them from that file. Their call
 * sites must still act on the result (rule 3).
 */
const VETTED_EXTERNAL_GUARDS: Record<string, { file: string }> = {
  requireRecordReadable: { file: 'routes/univer-meta.ts' },
  loadSheetRow: { file: 'multitable/loaders.ts' },
}

/**
 * Guards injected through dependency injection. The route file's helper must hand the request to the
 * injected resolver (`delegated`), and every registrar call site must inject a function that filters
 * `deleted_at IS NULL` — both proven below.
 */
const DELEGATED_GUARDS: Record<string, { helper: string; delegated: string; wiringFile: string; registrar: string; property: string }> = {
  'routes/recovery-archive-restore-owner.ts': {
    helper: 'resolveContext',
    delegated: 'dependencies.resolveContext',
    wiringFile: 'routes/univer-meta.ts',
    registrar: 'registerRecoveryArchiveRestoreOwnerRoutes',
    property: 'resolveContext',
  },
}

/** The only calls a route may await BEFORE its sheet gate. */
const PRE_GATE_CALLS: Record<string, string> = {
  applyBurstLimiter: 'per-caller AI rate limiting (multitable-ai.ts) — consumes a burst token, touches no sheet data',
  resolveBulkJobForActor: 'the caller’s OWN job header (multitable-ai.ts; owner + cross-sheet 404) — reads no record',
}

function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  return `${posix.normalize(posix.join(posix.dirname(fromFile), specifier))}.ts`
}

/**
 * The vetted guards `file` really imports: same local name, same EXPORTED name (`import { x as
 * requireRecordReadable }` is not the guard), from the vetted module, as a value import.
 */
function vettedGuardsFor(file: string, sf: ScannedRouteFile['sourceFile']): Map<string, string> {
  const imports = namedImports(sf)
  const vetted = new Map<string, string>()
  for (const [name, guard] of Object.entries(VETTED_EXTERNAL_GUARDS)) {
    const imported = imports.get(name)
    if (imported && imported.imported === name && resolveImport(file, imported.module) === guard.file) {
      vetted.set(name, `${name} (${guard.file})`)
    }
  }
  return vetted
}

function optionsFor(file: string): AnalyzeOptions {
  const vetted = vettedGuardsFor(file, scan(file).sourceFile)
  return {
    vetted,
    delegated: DELEGATED_GUARDS[file]?.delegated ?? null,
    preGateCalls: new Set(Object.keys(PRE_GATE_CALLS)),
    requireOrder: true,
    gateFirst: true,
  }
}

const analysisCache = new Map<RouteHandler, HandlerAnalysis>()
function analysisOf(file: string, h: RouteHandler): HandlerAnalysis {
  let analysis = analysisCache.get(h)
  if (!analysis) {
    analysis = analyzeHandler(h, scan(file).sourceFile, optionsFor(file))
    analysisCache.set(h, analysis)
  }
  return analysis
}

function guardOf(file: string, h: RouteHandler): string | null {
  const { sources } = analysisOf(file, h)
  return sources.length > 0 ? [...new Set(sources)].join(' + ') : null
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
  /**
   * Handlers that touch sheet-keyed data WITHOUT naming a sheet (cross-sheet listings, child-id routes).
   * They are outside "sheet-addressed", so each one is named here instead of being invisible.
   */
  unaddressed?: { touches: RegExp; named: Record<string, Exemption> }
  /** Behaviour test (same directory) whose route table is pinned to `sheetAddressedRouteKeys(<file>)`. */
  behaviourTest?: string
}

/**
 * Every "GAP" in a reason must be followed by a REAL issue number (optionally with the design note it
 * refers to): `GAP — tracked in #5830 — why` or `GAP — tracked in #5831 (see docs/….md §Section) — why`.
 * A placeholder (`#TBD-…`) is not a tracker: nobody is ever notified by it.
 */
const GAP_TRACKER = /^GAP — tracked in #([1-9]\d*)(?: \(see (docs\/[\w./-]+\.md)(?: §[\w-]+)?\))? — \S/

function reasonProblems(key: string, exemption: { reason: string }): string[] {
  const problems: string[] = []
  const reason = typeof exemption.reason === 'string' ? exemption.reason.trim() : ''
  if (reason.length < 80) problems.push(`${key}: exemption reason missing or too thin`)
  if (/\bTBD\b/i.test(reason)) problems.push(`${key}: "TBD" is not a tracker — open the issue and name it`)
  for (const occurrence of reason.matchAll(/\bGAP\b/g)) {
    const m = GAP_TRACKER.exec(reason.slice(occurrence.index))
    if (!m) {
      problems.push(`${key}: every GAP must name its issue: "GAP — tracked in #<issue> [(see docs/<file>.md §<section>)] — <why>"`)
    } else if (m[2] && !existsSync(join(REPO_ROOT, ...m[2].split('/')))) {
      problems.push(`${key}: tracker document ${m[2]} does not exist`)
    }
  }
  return problems
}

const NO_SHEET_DATA = /\b(pool|poolManager|db|query|selectFrom|insertInto|updateTable|meta_records|meta_fields)\b/
const readsNoSheetData = (h: RouteHandler) => !NO_SHEET_DATA.test(everything(h))
/**
 * Weaker than readsNoSheetData for handlers that legitimately write their OWN table through a service
 * (the token service is constructed with `db` in a referenced declaration): no sheet table, no sheet
 * resolver anywhere, and no raw query in the handler itself.
 */
const touchesNoSheetTable = (h: RouteHandler) => !/\b(meta_(records|fields|sheets|views)|sheet_id|resolveSheet\w*Capabilities\w*|loadSheet\w*|requireRecordReadable)\b/.test(everything(h))
  && !/\b(pool|poolManager|db|query)\b/.test(h.code)

/** #5832: the in-process bulk generate loop calls the model per row and never asks whether the sheet is live. */
const bulkWorkerStillLivenessBlind = () => {
  const code = functionCode('services/ai-bulk-job-service.ts', 'runGeneratePhase')
  return /\brunShortcutCore\(/.test(code)
    && !/\b(loadSheetLiveness|assertSheetLive|sheetLiveness|loadSheetRow|resolveSheet\w*Capabilities\w*)\b|deleted_at/.test(code)
}

const ownJobGate = (h: RouteHandler) => {
  const gate = h.helpers.get('resolveBulkJobForActor') ?? ''
  return /\bheader\.actorId !== userId\b/.test(gate)
    && /\bheader\.sheetId !== sheetId\b/.test(gate)
    && !/\b(meta_records|meta_fields|requireRecordReadable|readRecordOnce|resolveSheet\w*Capabilities)\b/.test(everything(h))
}

const LEGACY_SHEET_GAP = 'GAP — tracked in #5828 — LEGACY spreadsheet API: `:sheetId` names a row of '
  + 'the legacy `sheets` table (kysely `selectFrom(\'sheets\')`), not `meta_sheets`, so multitable/sheet-liveness.ts '
  + 'does not apply. But DELETE /api/spreadsheets/:id soft-deletes the parent (`spreadsheets.deleted_at`) and this '
  + 'handler never checks it, so a soft-deleted spreadsheet'

const LEGACY_PERMISSION_GAP = 'GAP — tracked in #5829 — `:id` is read from / written to '
  + '`spreadsheet_permissions.sheet_id`, the SAME table multitable reads as per-sheet grants '
  + '(permission-service loadSheetPermissionScopeMap). Gated only by rbacGuard(\'spreadsheet-permissions\', …): no '
  + 'sheet liveness and no canManageSheetAccess, so it '

const LEGACY_PERMISSION_NOT_FIXED = '. `:id` IS a meta_sheets id on the kysely schema: grant/revoke already lock '
  + '`meta_sheets` by it, and src/db/migrations/zzzz20260405190000_create_spreadsheet_permissions.ts declares '
  + '`sheet_id … REFERENCES meta_sheets(id)` (relied on by tests/integration/'
  + 'multitable-legacy-permission-route-lock-realdb.test.ts). The one open question is which schema production '
  + 'databases came from: the legacy migrations/036_create_spreadsheet_permissions.sql creates the same table '
  + '`REFERENCES spreadsheets(id)`, and both use CREATE TABLE IF NOT EXISTS, so on a 036-first database `:id` '
  + 'names a legacy spreadsheet and a meta-sheet liveness refusal would break it. Proposed once production is '
  + 'confirmed: canManageSheetAccess + a liveness refusal on grant/revoke.'

const COMMENT_RESIDUAL = 'GAP — tracked in #5831 (see docs/development/multitable-g8-comments-sheet-read-gate-verification-20260706.md '
  + '§Residual) — '

/** A service method whose body still selects without a liveness or readable-sheet filter. */
const commentServiceUnfiltered = (method: string) => {
  const code = functionCode('services/CommentService.ts', method)
  return code.length > 0 && !/deleted_at|resolveReadableSheetIds|readableSheetIds|resolveSheet\w*Capabilities/.test(code)
}

const noSheetGate = (h: RouteHandler) => !/\b(resolveCommentReadContext|resolveSheet\w*Capabilities|loadSheetLiveness)\b/.test(everything(h))

const COVERED: Record<string, CoveredFile> = {
  'routes/api-tokens.ts': {
    minHandlers: 15,
    minInScope: 7,
    exempt: {
      'POST [tokenListPaths]': {
        reason: 'TOKEN RESTRICTION LIST, not a sheet address: `sheetIds` is the OAPI-4a per-sheet WHITELIST stored on '
          + 'the minted token (multitable/api-tokens.ts; AND-composed by oapiScopeGuard), so it only NARROWS what the '
          + 'token can reach. Every data path the token later uses re-resolves the sheet, liveness included; a token '
          + 'restricted to a deleted sheet reaches nothing. The handler reads no sheet data (asserted).',
        stillTrue: (h) => /\bsheetIds: input\.sheetIds\b/.test(h.code)
          && /\bapiTokenService\.createToken\(/.test(h.code)
          && touchesNoSheetTable(h),
      },
    },
  },
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
  'routes/comments.ts': {
    minHandlers: 18,
    minInScope: 10,
    exempt: {},
    behaviourTest: 'comment-routes-sheet-liveness.test.ts',
    unaddressed: {
      touches: /\bcommentService\.\w+\(/,
      named: {
        'GET /api/comments/inbox': {
          reason: `${COMMENT_RESIDUAL}CROSS-SHEET LISTING (pre-existing): CommentService.getInbox selects every unread `
            + 'or @-mentioning comment by another author across ALL sheets — content, sheet/base/field names — with no '
            + 'per-sheet read filter and no deleted-sheet filter. A single-sheet gate cannot fix it; it needs the '
            + 'readable, live sheet set applied in SQL before LIMIT/OFFSET (asserted still unfiltered).',
          stillTrue: (h) => /\bcommentService\.getInbox\(/.test(h.code) && commentServiceUnfiltered('getInbox'),
        },
        'GET /api/comments/unread-count': {
          reason: `${COMMENT_RESIDUAL}CROSS-SHEET COUNT (pre-existing): CommentService.getUnreadSummary counts unread `
            + 'comments across ALL sheets with no per-sheet read filter and no deleted-sheet filter — the same '
            + 'residual as the inbox (asserted still unfiltered).',
          stillTrue: (h) => /\bcommentService\.getUnreadSummary\(/.test(h.code) && commentServiceUnfiltered('getUnreadSummary'),
        },
        'PATCH /api/comments/:commentId': {
          reason: `${COMMENT_RESIDUAL}COMMENT-ID ADDRESSED (pre-existing): the service finds the comment by id and checks `
            + 'only authorship, never the comment’s sheet — no per-sheet read gate and no liveness, so an author can '
            + 'still edit a comment on a soft-deleted sheet.',
          stillTrue: noSheetGate,
        },
        'DELETE /api/comments/:commentId': {
          reason: `${COMMENT_RESIDUAL}COMMENT-ID ADDRESSED (pre-existing): authorship only, never the comment’s sheet — `
            + 'an author can still delete a comment on a soft-deleted sheet.',
          stillTrue: noSheetGate,
        },
        'POST /api/comments/:commentId/read': {
          reason: `${COMMENT_RESIDUAL}COMMENT-ID ADDRESSED (pre-existing): marks a read receipt by comment id for any `
            + 'comments:read holder, without resolving the comment’s sheet (no read gate, no liveness).',
          stillTrue: noSheetGate,
        },
        'POST /api/comments/:commentId/reactions': {
          reason: `${COMMENT_RESIDUAL}COMMENT-ID ADDRESSED (pre-existing): adds a reaction by comment id for any `
            + 'comments:write holder, without resolving the comment’s sheet (no read gate, no liveness).',
          stillTrue: noSheetGate,
        },
        'DELETE /api/comments/:commentId/reactions': {
          reason: `${COMMENT_RESIDUAL}COMMENT-ID ADDRESSED (pre-existing): removes the caller’s reaction by comment id `
            + 'without resolving the comment’s sheet (no read gate, no liveness).',
          stillTrue: noSheetGate,
        },
        'POST /api/comments/:commentId/resolve': {
          reason: `${COMMENT_RESIDUAL}COMMENT-ID ADDRESSED (pre-existing): resolves ANY comment by id for any `
            + 'comments:write holder — no authorship check, no read gate, no liveness.',
          stillTrue: noSheetGate,
        },
      },
    },
  },
  'routes/dashboard.ts': {
    minHandlers: 12,
    minInScope: 12,
    exempt: {},
    behaviourTest: 'dashboard-routes-sheet-liveness.test.ts',
    // Charts and dashboards are sheet-keyed rows: a route that reaches them by chart/dashboard id alone
    // (`/charts/:chartId/…`) is not sheet-addressed, so it must be named here instead of being invisible.
    unaddressed: {
      touches: /\bdashboardService\.\w+\(|\bmeta_(?:records|fields|views|sheets)\b|\b(?:pool|db)\.query\(/,
      named: {},
    },
  },
  'routes/federation.ts': {
    minHandlers: 20,
    minInScope: 1,
    exempt: {
      'POST /api/federation/export/athena': {
        reason: 'SIMULATED EXPORT STUB — `spreadsheetId` is echoed into an audit row and the response; the '
          + 'handler and its same-file helpers touch no pool, query, db or sheet table (asserted), so there is no '
          + 'sheet data to protect. A real export wired here must be guarded, and this entry then stops being true.',
        stillTrue: readsNoSheetData,
      },
    },
  },
  'routes/multitable-ai.ts': {
    minHandlers: 11,
    minInScope: 9,
    behaviourTest: 'multitable-ai-sheet-liveness.test.ts',
    exempt: {
      'GET /sheets/:sheetId/ai/shortcut/bulk-job/:jobId': {
        reason: 'THE CALLER’S OWN JOB, not the sheet’s data: resolveBulkJobForActor (same file, asserted) 404s '
          + 'unless the job exists, was started by THIS caller and belongs to THIS :sheetId, so the sheet id '
          + 'is only the job’s cross-sheet filter. The poll returns header counters and neither it nor a '
          + 'same-file helper reads a record (asserted). It stays answerable after a soft delete so the owner '
          + 'can see a still-running job and cancel it.',
        stillTrue: ownJobGate,
      },
      'GET /sheets/:sheetId/ai/shortcut/bulk-job/:jobId/rows': {
        reason: 'THE CALLER’S OWN JOB ROWS — the durable review diff the SAME caller generated while they could '
          + 'read the sheet; owner + cross-sheet gated by resolveBulkJobForActor (asserted), no live record '
          + 'read in the handler or a same-file helper (asserted). Kept readable after a soft delete for the '
          + 'same reason as the poll. The diff does carry record values captured at generation time; if that '
          + 'is judged a disclosure, this exemption turns into a tracked gap.',
        stillTrue: ownJobGate,
      },
      'POST /sheets/:sheetId/ai/shortcut/bulk-job/:jobId/cancel': {
        reason: 'MUST WORK ON A DELETED SHEET — cancel is the only brake on an in-flight job whose sheet was '
          + 'deleted mid-run. Owner + cross-sheet gated by resolveBulkJobForActor (asserted); it only flips '
          + 'the job state via cancelBulkJob and never touches the sheet. The worker it brakes is itself a '
          + 'GAP — tracked in #5832 — services/ai-bulk-job-service.ts runGeneratePhase keeps sending the '
          + 'deleted sheet’s rows to the model (runShortcutCore, row by row, only re-reading the JOB status) and '
          + 'never re-checks sheet liveness (asserted still true); until that is fixed, cancel is the only stop.',
        stillTrue: (h) => ownJobGate(h) && /\bcancelBulkJob\(/.test(h.code) && bulkWorkerStillLivenessBlind(),
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
        stillTrue: (h) => /SELECT 1 FROM meta_sheets WHERE id = \$1 FOR UPDATE/.test(h.code),
      },
      'POST /api/spreadsheets/:id/permissions/revoke': {
        reason: `${LEGACY_PERMISSION_GAP}revokes on a soft-deleted multitable sheet (and on a live one without sheet authority)${LEGACY_PERMISSION_NOT_FIXED}`,
        stillTrue: (h) => /SELECT 1 FROM meta_sheets WHERE id = \$1 FOR UPDATE/.test(h.code),
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

const PLUGIN_ROUTE_BRIDGE = 'PLUGIN ROUTE BRIDGE — out of scope by design: method, path and handler are handed in at '
  + 'runtime by a plugin (plugins/**), whose code this closed world does not read (it scans src/ only). The bridge '
  + 'function itself only wraps the plugin handler with error handling and metrics and reads no sheet and no request '
  + 'params/query/body (asserted on its body). Known GAP — tracked in #5833 — the plugin SDK getRecord path reads a '
  + 'record without asking whether its sheet is live.'

/** The bridge wrapper forwards to the plugin handler and does nothing sheet-shaped itself. */
const pluginBridgeStillTrue = (o: OpaqueRegistration) => /\bawait handler\(req, res, next\)/.test(o.code)
  && !/sheet|req\.(params|query|body)|\bquery\(/i.test(o.code)

/** Callees that mount an APIGateway endpoint. */
const GATEWAY_REGISTRARS = new Set(['registerEndpoint', 'registerEndpoints', 'registerVersionedEndpoint', 'registerBulkEndpoints'])

/** Registrations whose handler cannot be read, each named with the fact that makes it harmless. */
const OPAQUE_REGISTRATIONS: Record<string, Record<string, { handler: string; reason: string; stillTrue: (o: OpaqueRegistration) => boolean }>> = {
  'gateway/APIGateway.ts': {
    '<dynamic method> <path endpoint.path> in registerEndpoint': {
      handler: '...middlewares',
      reason: 'DORMANT GATEWAY — APIGateway.registerEndpoint mounts an APIEndpoint config (auth, rate-limit, validation '
        + 'and cache middlewares, then endpoint.handler or a proxy) under a runtime method and path. index.ts builds the '
        + 'gateway only for its circuit-breaker store; nothing under src/ outside gateway/ mounts an endpoint through it '
        + '(asserted on every call site; data-adapters/HTTPAdapter.ts has an unrelated registerEndpoint of its own). An '
        + 'endpoint mounted through it would be invisible here — the first one makes this entry untrue.',
      stillTrue: () => allFacts().every((f) => f.rel.startsWith('gateway/') || f.gatewayCalls.every((c) => (
        f.rel === 'data-adapters/HTTPAdapter.ts' && c.name === 'registerEndpoint' && c.receiver === 'this'
      ))),
    },
  },
  'index.ts': {
    '<dynamic methodLower> <path path> in addRoute': {
      handler: 'async (req: Request, res: Response, next',
      reason: `${PLUGIN_ROUTE_BRIDGE} (CoreAPI http.addRoute, the unscoped variant.)`,
      stillTrue: pluginBridgeStillTrue,
    },
    '<dynamic methodLower> <path path> in registerPluginRoute': {
      handler: 'async (req: Request, res: Response, next',
      reason: `${PLUGIN_ROUTE_BRIDGE} (registerPluginRoute, the per-plugin variant that can be switched off.)`,
      stillTrue: (o) => pluginBridgeStillTrue(o) && /\bregistration\.active\b/.test(o.code),
    },
    'POST /api/approval/attachments/refs': {
      handler: 'approvalAttachmentRefsJsonParser',
      reason: 'BODY-PARSER MOUNT, not a handler: the 64 KB JSON parser (routes/approval-attachments.ts, owned by the '
        + 'approval window) mounted ahead of the global parser; the approval router’s own /refs handler is scanned '
        + 'in routes/approval-attachments.ts. The parser reads no sheet (asserted).',
      stillTrue: () => {
        const code = functionCode('routes/approval-attachments.ts', 'approvalAttachmentRefsJsonParser')
        return code.length > 0 && !/sheet/i.test(code)
      },
    },
  },
  'routes/admin-routes.ts': {
    'GET /safety/status': {
      handler: 'createSafetyStatusEndpoint()',
      reason: 'IMPORTED HANDLER FACTORY (guards/middleware.ts): reports the operation-safety switch (enabled + pending '
        + 'confirmation count); it reads no request input and no sheet (asserted on its body).',
      stillTrue: () => {
        const code = functionCode('guards/middleware.ts', 'createSafetyStatusEndpoint')
        return code.length > 0 && !/sheet|req\.(params|query|body)/i.test(code)
      },
    },
  },
  'routes/metrics-demo.ts': {
    'GET /metrics': {
      handler: 'PermissionMetricsMiddleware.metricsEndpoint',
      reason: 'DEAD DEMO ROUTER — routes/metrics-demo.ts is imported by no module under src/ (asserted); the handler '
        + 'is a static Prometheus dump of permission metrics that reads no request input and no sheet (asserted).',
      stillTrue: () => {
        const code = functionCode('middleware/permission-metrics-middleware.ts', 'metricsEndpoint')
        const imported = listSourceFiles().some((rel) => rel !== 'routes/metrics-demo.ts' && /['"][^'"\n]*metrics-demo(?:\.[jt]s)?['"]/.test(readSource(rel)))
        return code.length > 0 && !/sheet|req\.(params|query|body)/i.test(code) && !imported
      },
    },
  },
}

/**
 * The vetted record gate is held to the SAME rule 3 as a route (#5830): the capability lookup runs
 * first, its 401/403 precede the liveness 404, nothing — no record read — runs between, and the
 * liveness it refuses is the one of the sheet it was given. Routes that rely on it alone (AI shortcut
 * preview/run, button run, record approvals POST/GET) are GUARDED on the strength of that proof; their
 * behaviour is pinned in multitable-record-gate-capability-before-liveness.test.ts.
 */
const VETTED_RECORD_GATE_OPTIONS: AnalyzeOptions = {
  vetted: new Map(),
  delegated: null,
  preGateCalls: new Set(),
  requireOrder: true,
  gateFirst: true,
}

const CHECKER_OPTIONS: AnalyzeOptions = {
  vetted: new Map(),
  delegated: null,
  preGateCalls: new Set(),
  requireOrder: false,
  gateFirst: false,
}

/**
 * What each collab checker returns to REFUSE — the same value it already uses for "may not read", so a
 * deleted sheet is indistinguishable from a forbidden one. Key: `<file under src/> <receiver.setter>`.
 */
const CHECKER_REFUSALS: Record<string, { refusal: string; why: string }> = {
  'index.ts collabService.setSheetRoomAuthChecker': { refusal: 'false', why: 'boolean: false = may not join the sheet room' },
  'index.ts collabService.setCommentRoomAuthChecker': { refusal: 'false', why: 'boolean: false = may not join the comment room' },
  'index.ts commentService.setCommentTargetReadChecker': { refusal: 'false', why: 'boolean: false = no mention notification' },
  'index.ts yjsWsAdapter.setAuthChecker': {
    refusal: '{ canRead: false, canWrite: false }',
    why: 'null means "record not found" (NOT_FOUND) to the adapter; a caller without read gets this object (FORBIDDEN)',
  },
}

function checkerFindings(rel: string, sf: ScannedRouteFile['sourceFile'], refusals = CHECKER_REFUSALS): { found: string[]; keys: string[]; problems: string[] } {
  const found: string[] = []
  const keys: string[] = []
  const problems: string[] = []
  for (const reg of checkerRegistrations(sf)) {
    const code = codeOf(reg.fn, sf)
    if (!/\bresolveSheet\w*Capabilities\w*\(/.test(code)) continue
    const where = `src/${rel}:${reg.line} ${reg.name}`
    found.push(where)
    keys.push(`${rel} ${reg.name}`)
    const entry = refusals[`${rel} ${reg.name}`]
    if (!entry) {
      problems.push(`${where}: resolves sheet capabilities but has no CHECKER_REFUSALS entry — what does it return to refuse?`)
      continue
    }
    const analysis = analyzeHandler({ units: [{ label: 'handler', node: reg.fn, code }] }, sf, { ...CHECKER_OPTIONS, refusalReturn: entry.refusal })
    for (const v of analysis.violations) problems.push(`${where}: ${v}`)
    if (!analysis.sources.some((x) => /^(resolver|blind-resolver|liveness-load) /.test(x))) {
      problems.push(`${where}: resolves sheet capabilities but never refuses a non-live sheet`)
    }
  }
  return { found, keys, problems }
}

// ── Discovery over every source file (no text pre-filter) ───────────────────

interface FileFacts {
  rel: string
  handlers: number
  sheetAddressing: boolean
  opaque: OpaqueRegistration[]
  checkers: ReturnType<typeof checkerFindings>
  gatewayCalls: ReturnType<typeof callSitesNamed>
}

/** Everything the closed world needs from one file, read from its syntax tree (the tree is not kept). */
function factsOf(rel: string, source: string, refusals = CHECKER_REFUSALS): FileFacts {
  const scanned = scanRouteSource(rel, source)
  return {
    rel,
    handlers: scanned.handlers.length,
    sheetAddressing: scanned.handlers.some(addressesASheet),
    opaque: scanned.opaque,
    checkers: checkerFindings(rel, scanned.sourceFile, refusals),
    gatewayCalls: callSitesNamed(scanned.sourceFile, GATEWAY_REGISTRARS),
  }
}

/** Route modules that address a sheet but belong to no closed world. */
function uncoveredSheetModules(facts: FileFacts[]): string[] {
  const known = new Set([...Object.keys(COVERED), ...Object.keys(SIBLING_GUARDED)])
  return facts.filter((f) => f.sheetAddressing && !known.has(f.rel)).map((f) => f.rel)
}

let factsMemo: FileFacts[] | null = null
function allFacts(): FileFacts[] {
  if (!factsMemo) factsMemo = listSourceFiles().map((rel) => factsOf(rel, readSource(rel)))
  return factsMemo
}

/** Handlers of a covered file that touch sheet-keyed data without naming a sheet, against the file's ledger. */
function unaddressedProblems(all: RouteHandler[], ledger: NonNullable<CoveredFile['unaddressed']>): { touching: RouteHandler[]; problems: string[] } {
  const touching = all.filter((h) => !addressesASheet(h) && ledger.touches.test(everything(h)))
  const problems: string[] = []
  for (const h of touching) {
    if (!(h.key in ledger.named)) problems.push(`${h.key} (line ${h.line}) touches sheet-keyed data without a sheet id and is not named`)
  }
  for (const [key, entry] of Object.entries(ledger.named)) {
    const h = touching.find((x) => x.key === key)
    if (!h) { problems.push(`${key}: no such unaddressed route (dead entry)`); continue }
    problems.push(...reasonProblems(key, entry))
    if (entry.stillTrue && !entry.stillTrue(h)) problems.push(`${key}: the fact this entry rests on is no longer true`)
  }
  return { touching, problems }
}

// ── Tests ───────────────────────────────────────────────────────────────────

const ROUTE_TEST_OPTIONS: AnalyzeOptions = {
  vetted: new Map([['requireRecordReadable', 'requireRecordReadable (vetted)']]),
  delegated: null,
  preGateCalls: new Set(['applyBurstLimiter']),
  requireOrder: true,
  gateFirst: true,
}

function fixtureHandler(body: string[], key = 'POST /sheets/:sheetId/x'): { h: RouteHandler; s: ScannedRouteFile } {
  const source = [
    "import { requireRecordReadable } from './univer-meta'",
    ...body,
  ].join('\n')
  const s = scanRouteSource('routes/fixture.ts', source)
  const h = s.handlers.find((x) => x.key === key)
  if (!h) throw new Error(`fixture: no handler ${key} in ${s.handlers.map((x) => x.key).join(', ')}`)
  return { h, s }
}

const GATE_HELPER = [
  'async function gate(req, res, sheetId) {',
  '  const { capabilities, sheetLiveness } = await resolveSheetCapabilities(req, q, sheetId)',
  "  if (!capabilities.canRead) { res.status(403).json({ code: 'FORBIDDEN' }); return null }",
  "  if (sheetLiveness !== 'live') { sendSheetNotLive(res, sheetLiveness); return null }",
  '  return capabilities',
  '}',
]

describe('sheet-liveness closure over EVERY route file', () => {
  it('scanner self-test: registrations of every shape, lexical helpers, opaque handlers, comments never count, CRLF', () => {
    const fixture = [
      "import { requireRecordReadable } from './univer-meta'",
      "import { importedHandler } from './elsewhere'",
      "const listPaths = ['/api/things', '/api/things/alias']",
      "const onePath = '/api/one'",
      'async function gate(req, res, sheetId) {',
      '  const { capabilities, sheetLiveness } = await resolveSheetCapabilities(req, q, sheetId)',
      '  if (!capabilities.canRead) return null',
      "  if (sheetLiveness !== 'live') { sendSheetNotLive(res, sheetLiveness); return null }",
      '  return capabilities',
      '}',
      'function lookalike(req) { return null }',
      'export function build(router, client) {',
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
      "  router.get('/sheets/:sheetId/d', async (req, res) => { const r = await requireRecordReadable(req, q, req.params.sheetId, 'r'); if ('status' in r) return res.status(r.status).json(r.body) })",
      "  router.get('/not-a-sheet', async (req, res) => { lookalike(req) })",
      '  router.get(`/tables/${ID}/rows`, asyncHandler(async (req, res) => { res.json(req.params) }))',
      '  router.put(onePath, wallet(true))',
      '  const wallet = (admin) => run(async (req, res) => { res.json({ admin }) })',
      "  router.delete('/api/imported', importedHandler)",
      "  router.patch('/api/member', controller.update)",
      "  client.post('/api/remote', { body: 1 })",
      "  router.get('/api/raw', async (req, res) => { const q2 = req.query; res.json(await load(q2['sheetId'])) })",
      "  router.get('/tables/:tableId/export', async (req, res) => { res.json(await q('SELECT data FROM meta_records WHERE sheet_id = ANY($1)', [[req.params.tableId]])) })",
      "  router['post']('/sheets/:sheetId/e', async (req, res) => { res.json({}) })",
      "  router.get(buildPath('x'), async (req, res) => { res.json({}) })",
      "  cache.get(cacheKey, () => compute())",
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
      'GET /tables/${ID}/rows',
      'PUT [onePath]',
      'GET /api/raw',
      'GET /tables/:tableId/export',
      'POST /sheets/:sheetId/e',
    ])
    // Unreadable handlers and unreadable paths are RECORDED, not dropped; the HTTP client call is neither.
    // (`cache.get(cacheKey, loader)`: the key is a parameter-free identifier that resolves to nothing, but
    // the loader reads as a handler, so it is recorded too — a false positive costs a name, not a hole.)
    expect(lf.opaque.map((o) => `${o.key} <- ${o.handler}`)).toEqual([
      'DELETE /api/imported <- importedHandler',
      'PATCH /api/member <- controller.update',
      "GET <path buildPath('x')> in build <- async (req, res) => { res.json({}); }",
      'GET <path cacheKey> in build <- () => compute()',
    ])
    expect(crlf.handlers.map((h) => h.key)).toEqual(lf.handlers.map((h) => h.key))
    expect(crlf.opaque).toEqual(lf.opaque)
    const byKey = (s: ScannedRouteFile, key: string) => s.handlers.find((h) => h.key === key)!
    expect(byKey(lf, 'GET [listPaths]').paths).toEqual(['/api/things', '/api/things/alias'])
    expect(byKey(lf, 'PUT [onePath]').paths).toEqual(['/api/one'])
    // Wrapped handler and handler factory: the function bodies are read.
    expect(byKey(lf, 'GET /tables/${ID}/rows').code).toContain('req.params')
    expect(byKey(lf, 'PUT [onePath]').code).toContain('admin')
    // Population: bracket access and `:tableId` + `= ANY(` are sheet-addressed.
    expect(addressesASheet(byKey(lf, 'GET /api/raw'))).toBe(true)
    expect(addressesASheet(byKey(lf, 'GET /tables/:tableId/export'))).toBe(true)
    expect(addressesASheet(byKey(lf, 'GET /not-a-sheet'))).toBe(false)
    const analyze = (key: string) => analyzeHandler(byKey(lf, key), lf.sourceFile, ROUTE_TEST_OPTIONS)
    // a — guarded THROUGH the helper, whose body was read, and whose null is acted on.
    expect(analyze('POST /sheets/:sheetId/a').sources).toEqual(['gate-helper gate'])
    // a's helper refuses before any 403 — the order rule reds even though a refusal exists.
    expect(analyze('POST /sheets/:sheetId/a').violations.join('\n')).toMatch(/BEFORE any capability 403/)
    // b — the refusal words exist only in a comment: not guarded, and its resolver call binds nothing.
    const b = byKey(lf, 'POST /sheets/:sheetId/b')
    expect(b.helpers.has('handleB')).toBe(true)
    expect(analyze('POST /sheets/:sheetId/b').sources).toEqual([])
    expect(analyze('POST /sheets/:sheetId/b').violations.join('\n')).toMatch(/does not bind the sheetLiveness/)
    // c — a local `gate` shadows the guarded module helper: it must NOT resolve to it.
    expect(byKey(lf, 'GET /sheets/:sheetId/c').helpers.has('gate')).toBe(false)
    expect(analyze('GET /sheets/:sheetId/c').sources).toEqual([])
    // d — the imported vetted guard is a call, not a local helper, and its result is acted on.
    expect(byKey(lf, 'GET /sheets/:sheetId/d').helpers.has('requireRecordReadable')).toBe(false)
    expect(analyze('GET /sheets/:sheetId/d').sources).toEqual(['vetted requireRecordReadable'])
    // The same verdicts on the CRLF copy.
    for (const h of lf.handlers) {
      const twin = byKey(crlf, h.key)
      expect(twin.code).toBe(h.code)
      expect([...twin.helpers.keys()]).toEqual([...h.helpers.keys()])
      const a = analyzeHandler(h, lf.sourceFile, ROUTE_TEST_OPTIONS)
      const b2 = analyzeHandler(twin, crlf.sourceFile, ROUTE_TEST_OPTIONS)
      expect(b2.sources).toEqual(a.sources)
      expect(b2.violations.length).toBe(a.violations.length)
    }
  })

  it('tree rules self-test: each rule reds on its own counter-example and passes its positive twin', () => {
    const route = (lines: string[]) => fixtureHandler([
      ...GATE_HELPER,
      'export function build(router) {',
      "  router.post('/sheets/:sheetId/x', async (req, res) => {",
      ...lines,
      '  })',
      '}',
    ])
    const run = (lines: string[]) => {
      const { h, s } = route(lines)
      return analyzeHandler(h, s.sourceFile, ROUTE_TEST_OPTIONS)
    }
    // Positive: gate acted on, then the write.
    const ok = run(['    const auth = await gate(req, res, req.params.sheetId)', '    if (!auth) return', '    await svc.write()'])
    expect(ok.sources).toEqual(['gate-helper gate'])
    expect(ok.violations).toEqual([])
    // HONOUR: the gate's null is ignored.
    const ignored = run(['    const auth = await gate(req, res, req.params.sheetId)', '    await svc.write()'])
    expect(ignored.sources).toEqual([])
    expect(ignored.violations.join('\n')).toMatch(/not checked by the very next statement/)
    // HONOUR: the check is weakened by an extra condition.
    const weakened = run(['    const auth = await gate(req, res, req.params.sheetId)', '    if (!auth && req.query.strict) return', '    await svc.write()'])
    expect(weakened.violations.join('\n')).toMatch(/does not refuse on `auth`/)
    // HONOUR: bare call, result dropped.
    const dropped = run(['    await gate(req, res, req.params.sheetId)', '    await svc.write()'])
    expect(dropped.violations.join('\n')).toMatch(/is ignored/)
    // GATE FIRST: a service write before the gate.
    const late = run(['    await commentService.createComment({})', '    const auth = await gate(req, res, req.params.sheetId)', '    if (!auth) return'])
    expect(late.violations.join('\n')).toMatch(/runs before the sheet gate/)
    // GATE FIRST: a named pre-gate call is allowed.
    const limited = run(['    if (!(await applyBurstLimiter(l, req, res))) return', '    const auth = await gate(req, res, req.params.sheetId)', '    if (!auth) return'])
    expect(limited.violations).toEqual([])
    // Negated form with a scope condition.
    const negated = run(['    if (req.params.sheetId && !(await gate(req, res, req.params.sheetId))) return', '    await svc.write()'])
    expect(negated.sources).toEqual(['gate-helper gate'])
    // LOOP: a per-row refusal does not guard the handler.
    const perRow = run([
      '    for (const id of ids) {',
      '      const r = await requireRecordReadable(req, q, req.params.sheetId, id)',
      "      if ('status' in r) continue",
      '    }',
    ])
    expect(perRow.sources).toEqual([])
    // DIRECT resolver: conditional refusal, missing refusal, refusal before the 403, alias-only mention.
    const direct = (lines: string[]) => run([
      '    const { access, capabilities, sheetLiveness } = await resolveSheetReadableCapabilities(req, q, req.params.sheetId)',
      ...lines,
    ])
    const good = direct(["    if (!capabilities.canRead) return res.status(403).json({ code: 'FORBIDDEN' })", "    if (sheetLiveness !== 'live') return sendSheetNotLive(res, sheetLiveness)"])
    expect(good.sources).toEqual(['resolver resolveSheetReadableCapabilities'])
    expect(good.violations).toEqual([])
    const conditional = direct(["    if (!capabilities.canRead) return res.status(403).json({ code: 'FORBIDDEN' })", "    if (sheetLiveness !== 'live' && req.query.strict === '1') return sendSheetNotLive(res, sheetLiveness)"])
    expect(conditional.violations.join('\n')).toMatch(/never refuses on the liveness it binds/)
    const wrapped = direct(["    if (!capabilities.canRead) return res.status(403).json({ code: 'FORBIDDEN' })", '    if (req.query.strict) {', "      if (sheetLiveness !== 'live') return sendSheetNotLive(res, sheetLiveness)", '    }'])
    expect(wrapped.violations.join('\n')).toMatch(/never refuses on the liveness it binds/)
    const oracle = direct([
      '    const allowed = capabilities.canRead',
      "    if (sheetLiveness !== 'live') return sendSheetNotLive(res, sheetLiveness)",
      "    if (!allowed) return res.status(403).json({ code: 'FORBIDDEN' })",
    ])
    expect(oracle.violations.join('\n')).toMatch(/BEFORE any capability 403/)
    const aliasOk = direct([
      '    const allowed = capabilities.canRead',
      "    if (!allowed) return res.status(403).json({ code: 'FORBIDDEN' })",
      "    if (sheetLiveness !== 'live') return sendSheetNotLive(res, sheetLiveness)",
    ])
    expect(aliasOk.violations).toEqual([])
    // INLINE filter: anchored to meta_sheets, and acted on.
    const inline = (sql: string, check: string) => run([
      `    const found = await pool.query('${sql}', [req.params.sheetId])`,
      check,
      '    await svc.write()',
    ])
    expect(inline('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', '    if (found.rows.length === 0) return res.status(404).end()').sources)
      .toEqual(['inline-sheet-query meta_sheets … deleted_at IS NULL'])
    expect(inline('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', '    if (found.rows.length === 0) return res.status(404).end()').sources).toEqual([])
    expect(inline('SELECT id FROM meta_sheets s JOIN users u ON u.id = s.owner WHERE s.id = $1 AND u.deleted_at IS NULL', '    if (!found.rows[0]) return').sources).toEqual([])
    expect(inline('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', '    console.log(found)').sources).toEqual([])
    expect(sheetTableLivenessFilter('FROM public.meta_sheets sheet_row WHERE sheet_row.id = $1 AND sheet_row.deleted_at IS NULL')).toBe(true)
    // DECISION helper: answers with a value, so it does not stop the handler.
    const decision = fixtureHandler([
      'async function perRow(req, id) {',
      '  const r = await requireRecordReadable(req, q, id, id)',
      "  if ('status' in r) return 'skipped_no_perm'",
      "  return 'ok'",
      '}',
      'export function build(router) {',
      "  router.post('/sheets/:sheetId/x', async (req, res) => { const v = await perRow(req, req.params.sheetId); res.json(v) })",
      '}',
    ])
    const decided = analyzeHandler(decision.h, decision.s.sourceFile, ROUTE_TEST_OPTIONS)
    expect(decided.sources).toEqual([])
    expect(decided.roles.get('perRow')).toBe('decision')
  })

  it('checker refusals self-test: a liveness refusal returns EXACTLY the checker’s refusal value (J1, J1b, J2, J3)', () => {
    const rel = 'collab-fixture.ts'
    const refusals = Object.fromEntries(Object.entries(CHECKER_REFUSALS).map(([key, entry]) => [key.replace(/^index\.ts /, `${rel} `), entry]))
    const run = (parts: { sheetRoom?: string; commentRoom?: string; commentRoomWindow?: string; target?: string; yjs?: string }, map = refusals) => {
      const source = [
        "import { loadSheetLiveness } from './multitable/sheet-liveness'",
        'export function wire(collabService, commentService, yjsWsAdapter, pool, query) {',
        '  collabService.setSheetRoomAuthChecker(async ({ sheetId, userId }) => {',
        '    try {',
        '      const { capabilities } = await resolveSheetCapabilitiesForUser(pool.query.bind(pool), sheetId, userId)',
        '      if (!capabilities.canRead) return false',
        '      const liveness = await loadSheetLiveness(pool.query.bind(pool), sheetId)',
        `      if (liveness !== 'live') return ${parts.sheetRoom ?? 'false'}`,
        '      return true',
        '    } catch {',
        '      return false',
        '    }',
        '  })',
        '  collabService.setCommentRoomAuthChecker(async ({ spreadsheetId, rowId, userId }) => {',
        '    try {',
        '      const { capabilities, isAdminRole } = await resolveSheetCapabilitiesForUser(query, spreadsheetId, userId)',
        '      if (!capabilities.canRead) return false',
        ...(parts.commentRoomWindow ? [parts.commentRoomWindow] : []),
        '      const liveness = await loadSheetLiveness(query, spreadsheetId)',
        `      if (liveness !== 'live') return ${parts.commentRoom ?? 'false'}`,
        '      if (isAdminRole) return true',
        '      return !(await isRecordReadDeniedForUser(query, spreadsheetId, rowId, userId))',
        '    } catch {',
        '      return false',
        '    }',
        '  })',
        '  commentService.setCommentTargetReadChecker(async ({ spreadsheetId, rowId, userId }) => {',
        '    try {',
        '      const { capabilities, isAdminRole } = await resolveSheetCapabilitiesForUser(query, spreadsheetId, userId)',
        '      if (!capabilities.canRead) return false',
        '      const liveness = await loadSheetLiveness(query, spreadsheetId)',
        `      if (liveness !== 'live') return ${parts.target ?? 'false'}`,
        '      if (isAdminRole) return true',
        '      return !(await isRecordReadDeniedForUser(query, spreadsheetId, rowId, userId))',
        '    } catch {',
        '      return false',
        '    }',
        '  })',
        '  yjsWsAdapter.setAuthChecker(async (userId, recordId) => {',
        '    try {',
        "      const rec = await pool.query('SELECT id, sheet_id FROM meta_records WHERE id = $1', [recordId])",
        '      if (rec.rows.length === 0) return null',
        '      const sheetId = String(rec.rows[0].sheet_id)',
        '      const { capabilities } = await resolveSheetCapabilitiesForUser(pool.query.bind(pool), sheetId, userId)',
        '      const liveness = await loadSheetLiveness(pool.query.bind(pool), sheetId)',
        `      if (liveness !== 'live') return ${parts.yjs ?? '{ canRead: false, canWrite: false }'}`,
        '      return { canRead: capabilities.canRead, canWrite: false }',
        '    } catch {',
        '      return null',
        '    }',
        '  })',
        '}',
      ].join('\n')
      return checkerFindings(rel, scanRouteSource(rel, source).sourceFile, map)
    }
    const base = run({})
    expect(base.found.map((f) => f.replace(/^src\/collab-fixture\.ts:\d+ /, ''))).toEqual([
      'collabService.setSheetRoomAuthChecker',
      'collabService.setCommentRoomAuthChecker',
      'commentService.setCommentTargetReadChecker',
      'yjsWsAdapter.setAuthChecker',
    ])
    expect(base.problems).toEqual([])
    // J1 / J1b: a boolean checker whose liveness branch says "allowed".
    expect(run({ sheetRoom: 'true' }).problems.join('\n')).toMatch(/setSheetRoomAuthChecker: .*must be exactly `return false`/)
    expect(run({ commentRoom: 'true' }).problems.join('\n')).toMatch(/setCommentRoomAuthChecker: .*must be exactly `return false`/)
    expect(run({ target: 'undefined' }).problems.join('\n')).toMatch(/setCommentTargetReadChecker: .*must be exactly `return false`/)
    // J2: Yjs full access on a deleted sheet. J3: Yjs `null` — NOT_FOUND where a forbidden caller gets FORBIDDEN.
    expect(run({ yjs: '{ canRead: true, canWrite: true, canReadAllFields: true }' }).problems.join('\n'))
      .toMatch(/setAuthChecker: .*must be exactly `return \{ canRead: false, canWrite: false \}`/)
    expect(run({ yjs: 'null' }).problems.join('\n')).toMatch(/setAuthChecker: .*does `return null;`/)
    // WINDOW: an admin short-circuit (or any work) between the capability lookup and the liveness refusal.
    expect(run({ commentRoomWindow: '      if (isAdminRole) return true' }).problems.join('\n'))
      .toMatch(/setCommentRoomAuthChecker: .*`if \(isAdminRole\) return true;` runs between the binding and its liveness refusal/)
    expect(run({ commentRoomWindow: "      await query('UPDATE meta_comments SET read = true WHERE spreadsheet_id = $1', [spreadsheetId])" }).problems.join('\n'))
      .toMatch(/setCommentRoomAuthChecker: .*runs between the binding and its liveness refusal/)
    // A checker nobody declared a refusal value for is itself a finding.
    expect(run({}, {}).problems.join('\n')).toMatch(/no CHECKER_REFUSALS entry/)
  })

  it('window and refusal self-test: nothing but a 401/403 check or an inert declaration runs between binding and refusal (J4, J5), and the refusal only refuses (J11)', () => {
    const analyzeRoute = (lines: string[], helper = GATE_HELPER) => {
      const { h, s } = fixtureHandler([
        ...helper,
        'export function build(router) {',
        "  router.post('/sheets/:sheetId/x', async (req, res) => {",
        ...lines,
        '  })',
        '}',
      ])
      return analyzeHandler(h, s.sourceFile, ROUTE_TEST_OPTIONS)
    }
    const RESOLVE = '    const { access, capabilities, sheetLiveness } = await resolveSheetReadableCapabilities(req, query, req.params.sheetId)'
    const FORBID = "    if (!capabilities.canRead) return res.status(403).json({ code: 'FORBIDDEN' })"
    const REFUSE = "    if (sheetLiveness !== 'live') return sendSheetNotLive(res, sheetLiveness)"
    const BETWEEN = /runs between the binding and its liveness refusal/
    // Positive twins.
    expect(analyzeRoute([RESOLVE, FORBID, REFUSE, '    await svc.write()']).violations).toEqual([])
    expect(analyzeRoute([
      RESOLVE,
      "    if (!access.userId) return res.status(401).json({ code: 'UNAUTHENTICATED' })",
      FORBID,
      '    const userId = access.userId',
      '    let label',
      '    label = `sheet ${req.params.sheetId}`',
      REFUSE,
    ]).violations).toEqual([])
    // J4: a write between the 403 and the liveness refusal (awaited, fired, assigned, or sent).
    for (const write of [
      "    await query('DELETE FROM meta_fields WHERE sheet_id = $1', [req.params.sheetId])",
      "    query('DELETE FROM meta_fields WHERE sheet_id = $1', [req.params.sheetId])",
      "    const pending = pool.query('DELETE FROM meta_fields WHERE sheet_id = $1', [req.params.sheetId])",
      '    const sent = res.json({ fields: [] })',
      '    const fields = await loadFieldsForSheet(query, req.params.sheetId)',
      "    if (req.query.dryRun) return res.json({ ok: true })",
      '    if (!capabilities.canWrite) { res.status(403).end(); return } else { await svc.write() }',
      '    for (const id of ids) await svc.write(id)',
    ]) {
      expect(analyzeRoute([RESOLVE, FORBID, write, REFUSE]).violations.join('\n'), write).toMatch(BETWEEN)
    }
    // A second declarator in the resolver's own statement.
    expect(analyzeRoute([
      '    const { capabilities, sheetLiveness } = await resolveSheetReadableCapabilities(req, query, req.params.sheetId), later = await svc.write()',
      FORBID,
      REFUSE,
    ]).violations.join('\n')).toMatch(/shares a declaration/)
    // The gate's own arguments run before it.
    expect(analyzeRoute([
      '    const { capabilities, sheetLiveness } = await resolveSheetReadableCapabilities(req, query, await svc.touch(req.params.sheetId))',
      FORBID,
      REFUSE,
    ]).violations.join('\n')).toMatch(/runs before the sheet gate/)
    // J5: the write sits in the gate HELPER's window.
    const helperWithWrite = [
      ...GATE_HELPER.slice(0, 3),
      "  await query('UPDATE meta_comments SET resolved = true WHERE spreadsheet_id = $1', [sheetId])",
      ...GATE_HELPER.slice(3),
    ]
    const j5 = analyzeRoute(['    const auth = await gate(req, res, req.params.sheetId)', '    if (!auth) return', '    await svc.write()'], helperWithWrite)
    expect(j5.violations.join('\n')).toMatch(/^gate: .*runs between the binding and its liveness refusal/m)
    // J11: the refusal branch serves data (awaited), or answers 200 without awaiting.
    const j11 = analyzeRoute([RESOLVE, FORBID, "    if (sheetLiveness !== 'live') { return res.json({ ok: true, data: { fields: await loadFieldsForSheet(query, req.params.sheetId) } }) }"])
    expect(j11.violations.join('\n')).toMatch(/refusal branch awaits or calls a data source/)
    const cached = analyzeRoute([RESOLVE, FORBID, "    if (sheetLiveness !== 'live') return res.json({ ok: true, data: cachedSchema })"])
    expect(cached.violations.join('\n')).toMatch(/refusal branch does not answer 403\/404\/410/)
    const quiet = analyzeRoute([RESOLVE, FORBID, "    if (sheetLiveness !== 'live') { return }"])
    expect(quiet.violations.join('\n')).toMatch(/refusal branch does not answer 403\/404\/410/)
    const thrown = analyzeRoute([RESOLVE, FORBID, "    if (sheetLiveness !== 'live') throw new SheetNotLiveError(sheetLiveness)"])
    expect(thrown.violations).toEqual([])
  })

  it('route collection self-test: fails closed on every registration shape (J7 route chains, J8 mounts, J9d no text filter, J10 dynamic verbs, J12 child-id routes)', () => {
    const s = scanRouteSource('routes/zz-fixture.ts', [
      "import { Router } from 'express'",
      "const VERB = 'get' as const",
      "let mutableVerb = 'get'",
      'export function judgeRouter(pool, pickVerb, mws, subRouter, routeArgs) {',
      '  const router = Router()',
      "  router.route('/sheets/:sheetId/judge-export').get(async (req, res) => { res.json(await pool.query('SELECT data FROM meta_records WHERE sheet_id = $1', [req.params.sheetId])) })",
      "  router.route('/sheets/:sheetId/chain').get(async (req, res) => { res.json({}) }).post(async (req, res) => { res.json({}) })",
      "  router.use('/sheets/:sheetId/judge-raw', async (req, res) => { res.json(await pool.query('SELECT data FROM meta_records WHERE sheet_id = $1', [req.params.sheetId])) })",
      "  router.use('/sheets/:sheetId/spread', ...mws, async (req, res, next) => next())",
      "  router.use('/api/sub', subRouter)",
      "  router[VERB]('/sheets/:sheetId/judge-rows', async (req, res) => { res.json(await pool.query('SELECT data FROM meta_records WHERE sheet_id = $1', [req.params.sheetId])) })",
      "  router[pickVerb('x')]('/sheets/:sheetId/dyn', async (req, res) => { res.json({}) })",
      "  router[mutableVerb]('/sheets/:sheetId/mutable', async (req, res) => { res.json({}) })",
      "  router[pickVerb('y')](...routeArgs)",
      '  return router',
      '}',
      'export class Bridge {',
      '  addRoute(method, path, handler) {',
      '    const methodLower = method.toLowerCase()',
      '    this.app[methodLower](path, async (req, res, next) => { await handler(req, res, next) })',
      '  }',
      '}',
    ].join('\n'))
    expect(s.handlers.map((h) => h.key)).toEqual([
      'GET /sheets/:sheetId/judge-export',
      'POST /sheets/:sheetId/chain',
      'GET /sheets/:sheetId/chain',
      'USE /sheets/:sheetId/judge-raw',
      'GET /sheets/:sheetId/judge-rows',
    ])
    expect(s.opaque.map((o) => `${o.key} <- ${o.handler}`)).toEqual([
      'USE /sheets/:sheetId/spread <- ...mws',
      "<dynamic pickVerb('x')> /sheets/:sheetId/dyn in judgeRouter <- async (req, res) => { res.json({}); }",
      '<dynamic mutableVerb> /sheets/:sheetId/mutable in judgeRouter <- async (req, res) => { res.json({}); }',
      "<dynamic pickVerb('y')> <path ...routeArgs> in judgeRouter <- ...routeArgs",
      '<dynamic methodLower> <path path> in addRoute <- async (req, res, next) => { await handle',
    ])
    // The readable ones are sheet-addressed and, having no gate, unguarded.
    for (const key of ['GET /sheets/:sheetId/judge-export', 'USE /sheets/:sheetId/judge-raw', 'GET /sheets/:sheetId/judge-rows']) {
      const h = s.handlers.find((x) => x.key === key)!
      expect(addressesASheet(h), key).toBe(true)
      expect(analyzeHandler(h, s.sourceFile, ROUTE_TEST_OPTIONS).sources, key).toEqual([])
    }
    // J9d: a module whose ONLY registration is `router['get'](` — none of the text an old pre-filter looked
    // for — is still discovered as an uncovered sheet-addressing module.
    const bracketOnly = [
      "import { Router } from 'express'",
      'declare const pool: { query: (sql: string, params: unknown[]) => Promise<unknown> }',
      'export function judgeRouter() {',
      '  const router = Router()',
      "  router['get']('/sheets/:sheetId/judge-rows', async (req: any, res: any) => { res.json(await pool.query('SELECT data FROM meta_records WHERE sheet_id = $1', [req.params.sheetId])) })",
      '  return router',
      '}',
    ].join('\n')
    expect(/\.(get|post|put|patch|delete|all|addRoute)\(/.test(bracketOnly)).toBe(false)
    expect(uncoveredSheetModules([factsOf('routes/zz-judge-bracket2.ts', bracketOnly)])).toEqual(['routes/zz-judge-bracket2.ts'])
    // J10: a constant verb is read like a literal one; a computed verb is opaque (and so must be named).
    const constVerb = bracketOnly.replace("router['get']", 'router[VERB]').replace('export function', "const VERB = 'get' as const\nexport function")
    expect(uncoveredSheetModules([factsOf('routes/zz-judge-dyn.ts', constVerb)])).toEqual(['routes/zz-judge-dyn.ts'])
    const computedVerb = bracketOnly.replace("router['get']", 'router[pickVerb()]')
    expect(factsOf('routes/zz-judge-dyn2.ts', computedVerb).opaque.map((o) => o.key)).toEqual(['<dynamic pickVerb()> /sheets/:sheetId/judge-rows in judgeRouter'])
    expect(OPAQUE_REGISTRATIONS['routes/zz-judge-dyn2.ts']).toBeUndefined()
    // J12: a chart-id route in dashboard.ts reaches sheet-keyed rows without naming the sheet — the
    // file's ledger (kept on COVERED, asserted present) names every such route.
    const ledger = COVERED['routes/dashboard.ts']?.unaddressed
    expect(ledger, 'routes/dashboard.ts must keep its unaddressed-route ledger').toBeDefined()
    const dash = scanRouteSource('routes/dashboard.ts', [
      'export function dashboardRouter() {',
      '  const router = Router()',
      "  router.get('/sheets/:sheetId/charts', async (req, res) => { const auth = await requireSheetRead(req, res, req.params.sheetId); if (!auth) return; res.json(await dashboardService.listCharts(req.params.sheetId)) })",
      "  router.get('/charts/:chartId/judge-data', async (req, res) => {",
      '    const chart = await dashboardService.getChart(req.params.chartId)',
      '    if (!chart) return res.status(404).end()',
      '    res.json(await dashboardService.getChartData(chart.id))',
      '  })',
      '  return router',
      '}',
    ].join('\n'))
    const j12 = unaddressedProblems(dash.handlers, ledger!)
    expect(j12.touching.map((h) => h.key)).toEqual(['GET /charts/:chartId/judge-data'])
    expect(j12.problems.join('\n')).toMatch(/GET \/charts\/:chartId\/judge-data \(line \d+\) touches sheet-keyed data without a sheet id and is not named/)
  })

  it('GAP trackers self-test: every GAP names a real issue; TBD placeholders and untracked GAPs red', () => {
    const why = ` — ${'x'.repeat(90)}`
    const doc = 'docs/development/multitable-g8-comments-sheet-read-gate-verification-20260706.md'
    expect(reasonProblems('k', { reason: `GAP — tracked in #5830${why}` })).toEqual([])
    expect(reasonProblems('k', { reason: `GAP — tracked in #5831 (see ${doc} §Residual)${why}` })).toEqual([])
    expect(reasonProblems('k', { reason: `MUST WORK${why}. The worker is a GAP — tracked in #5832${why}` })).toEqual([])
    expect(reasonProblems('k', { reason: `GAP — tracked in #TBD-record-gate-liveness-order${why}` }).join('\n')).toMatch(/TBD/)
    expect(reasonProblems('k', { reason: `GAP — tracked in ${doc} §Residual${why}` }).join('\n')).toMatch(/every GAP must name its issue/)
    expect(reasonProblems('k', { reason: `NOT A HOLE${why}, but the worker is a GAP nobody tracks` }).join('\n')).toMatch(/every GAP must name its issue/)
    expect(reasonProblems('k', { reason: `GAP — tracked in #5831 (see docs/development/no-such-doc.md)${why}` }).join('\n')).toMatch(/does not exist/)
    // Every reason in this file passes — including the ones nested in ledgers and the OPAQUE list.
    const reasons: Array<[string, { reason: string }]> = [
      ...Object.entries(COVERED).flatMap(([file, c]) => [
        ...Object.entries(c.exempt).map(([k, e]): [string, { reason: string }] => [`${file} ${k}`, e]),
        ...Object.entries(c.unaddressed?.named ?? {}).map(([k, e]): [string, { reason: string }] => [`${file} ${k}`, e]),
      ]),
      ...Object.entries(OPAQUE_REGISTRATIONS).flatMap(([file, entries]) => Object.entries(entries).map(([k, e]): [string, { reason: string }] => [`${file} ${k}`, e])),
    ]
    expect(reasons.flatMap(([key, entry]) => reasonProblems(key, entry))).toEqual([])
    expect(reasons.filter(([, e]) => /\bGAP — tracked in #\d+/.test(e.reason)).length).toBeGreaterThanOrEqual(15)
  })

  it('vetted guards count only under their real exported name; an inline sheet filter must bind the sheet id', () => {
    const vettedOf = (line: string) => [...vettedGuardsFor('routes/fixture.ts', scanRouteSource('routes/fixture.ts', `${line}\nexport const x = 1\n`).sourceFile).keys()]
    expect(vettedOf("import { requireRecordReadable } from './univer-meta'")).toEqual(['requireRecordReadable'])
    expect(vettedOf("import { requireRecordWritable as requireRecordReadable } from './univer-meta'")).toEqual([])
    expect(vettedOf("import { requireRecordReadable } from './univer-meta-copy'")).toEqual([])
    expect(vettedOf("import type { requireRecordReadable } from './univer-meta'")).toEqual([])
    expect(vettedOf("import { loadSheetRow } from '../multitable/loaders'")).toEqual(['loadSheetRow'])
    const aliased = scanRouteSource('routes/fixture.ts', [
      "import { requireRecordWritable as requireRecordReadable } from './univer-meta'",
      'export function build(router) {',
      "  router.get('/sheets/:sheetId/d', async (req, res) => { const r = await requireRecordReadable(req, q, req.params.sheetId, 'r'); if ('status' in r) return res.status(r.status).json(r.body); res.json(r) })",
      '}',
    ].join('\n'))
    const options = { ...ROUTE_TEST_OPTIONS, vetted: vettedGuardsFor('routes/fixture.ts', aliased.sourceFile) }
    expect(analyzeHandler(aliased.handlers[0]!, aliased.sourceFile, options).sources).toEqual([])
    // Inline sheet filters: one sheet, by id.
    expect(sheetTableLivenessFilter('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')).toBe(true)
    expect(sheetTableLivenessFilter('SELECT id FROM meta_sheets WHERE deleted_at IS NULL LIMIT 1')).toBe(false)
    expect(sheetTableLivenessFilter('SELECT s.id FROM meta_sheets s WHERE s.base_id = $1 AND s.deleted_at IS NULL')).toBe(false)
    expect(sheetTableLivenessFilter('SELECT 1 FROM meta_sheets s JOIN meta_records r ON r.sheet_id = s.id WHERE r.id = $1 AND s.deleted_at IS NULL')).toBe(false)
  })

  it('FILES: every router module that addresses a sheet is covered here or by the sibling guard; no dead file entries', () => {
    const facts = allFacts()
    const routerModules = facts.filter((f) => f.handlers > 0 || f.opaque.length > 0)
    const sheetAddressing = facts.filter((f) => f.sheetAddressing).map((f) => f.rel)
    const uncovered = uncoveredSheetModules(facts)
    expect(
      uncovered,
      `${uncovered.length} route module(s) address a sheet but are not in this closed world:\n`
      + uncovered.map((r) => `  - src/${r}`).join('\n')
      + '\nAdd each to COVERED (and guard or exempt its handlers).',
    ).toEqual([])
    const known = new Set([...Object.keys(COVERED), ...Object.keys(SIBLING_GUARDED)])
    const dead = [...known].filter((rel) => !sheetAddressing.includes(rel))
    expect(dead, `closed-world entries that no longer address a sheet: ${dead.join(', ')}`).toEqual([])
    // Tripwires for the discovery walk itself: every source file was parsed, and the walk found routers.
    expect(facts.length).toBe(listSourceFiles().length)
    expect(facts.length).toBeGreaterThan(500)
    expect(routerModules.length).toBeGreaterThan(40)
    expect(sheetAddressing.length).toBeGreaterThanOrEqual(Object.keys(COVERED).length)
  })

  it('OPAQUE: every registration whose handler, path or verb cannot be read is named, with a fact that still holds', () => {
    const found = allFacts().flatMap((f) => f.opaque)
    const problems: string[] = []
    const seen = new Set<string>()
    for (const o of found) {
      const id = `${o.file} ${o.key}`
      if (seen.has(id)) problems.push(`src/${o.file}:${o.line} ${o.key}: a second opaque registration under the same key — the entry would name both`)
      seen.add(id)
      const named = OPAQUE_REGISTRATIONS[o.file]?.[o.key]
      if (!named) { problems.push(`src/${o.file}:${o.line} ${o.key} <- ${o.handler} is not named (read its handler and add a reason)`); continue }
      if (named.handler !== o.handler) problems.push(`${o.file} ${o.key}: handler is now \`${o.handler}\`, entry says \`${named.handler}\``)
      if (!named.stillTrue(o)) problems.push(`${o.file} ${o.key}: the fact this entry rests on is no longer true`)
    }
    for (const [file, entries] of Object.entries(OPAQUE_REGISTRATIONS)) {
      for (const [key, entry] of Object.entries(entries)) {
        if (!found.some((o) => o.file === file && o.key === key)) problems.push(`${file} ${key}: no such opaque registration (dead entry)`)
        problems.push(...reasonProblems(`${file} ${key}`, entry))
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
    // The dynamic registrations that exist today are among them (a scanner that stops seeing
    // `app[method](…)` would otherwise pass by finding nothing).
    expect(found.filter((o) => o.verb.startsWith('<dynamic ')).map((o) => `${o.file} ${o.key}`).sort()).toEqual([
      'gateway/APIGateway.ts <dynamic method> <path endpoint.path> in registerEndpoint',
      'index.ts <dynamic methodLower> <path path> in addRoute',
      'index.ts <dynamic methodLower> <path path> in registerPluginRoute',
    ])
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

      it('every sheet-addressed handler is GUARDED (proven on the tree) or EXEMPT BY NAME', () => {
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

      it('tree rules: each liveness binding is refused on its own path after the 403, every gate result is acted on, the gate runs first', () => {
        const problems = inScope()
          .filter((h) => !(h.key in config.exempt))
          .flatMap((h) => analysisOf(file, h).violations.map((p) => `${h.key} → ${p}`))
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
          problems.push(...reasonProblems(key, exemption))
          if (exemption.stillTrue && !exemption.stillTrue(h)) problems.push(`${key}: the fact this exemption rests on is no longer true`)
        }
        expect(problems, `${file}:\n${problems.join('\n')}`).toEqual([])
      })

      if (config.unaddressed) {
        const ledger = config.unaddressed
        it('handlers that touch sheet-keyed data WITHOUT naming a sheet are each named (cross-sheet listings, child-id routes)', () => {
          const { touching, problems } = unaddressedProblems(handlers(), ledger)
          expect(problems, `${file}:\n${problems.join('\n')}`).toEqual([])
          expect(touching.length).toBe(Object.keys(ledger.named).length)
        })
      }
    })
  }

  it('BEHAVIOUR TIE: the per-file behaviour tests pin their route tables to this same scan', () => {
    const tied = Object.entries(COVERED).filter(([, c]) => c.behaviourTest)
    expect(tied.map(([file]) => file).sort()).toEqual(['routes/comments.ts', 'routes/dashboard.ts', 'routes/multitable-ai.ts'])
    for (const [file, config] of tied) {
      const text = readFileSync(join(__dirname, config.behaviourTest!), 'utf8')
      expect(text, `${config.behaviourTest} must assert its route table against the scan`).toContain(`sheetAddressedRouteKeys('${file}')`)
    }
  })

  it('vetted external guards refuse a non-live sheet (their bodies, not their names)', () => {
    // requireRecordReadable: resolves the sheet itself, binds and refuses its liveness on the same path —
    // under the full route rules (VETTED_RECORD_GATE_OPTIONS): the resolver is the first thing awaited,
    // its 401/403 come before the liveness 404, and no record read (or anything else) runs in between.
    const meta = scanRouteSource('routes/univer-meta.ts', readSource('routes/univer-meta.ts'))
    const defs = findFunctionsNamed(meta.sourceFile, 'requireRecordReadable')
    expect(defs, 'routes/univer-meta.ts must define requireRecordReadable exactly once').toHaveLength(1)
    const def = defs[0]!
    const unit: HandlerUnit = { label: 'handler', node: def, code: codeOf(def, meta.sourceFile) }
    const analysis = analyzeHandler({ units: [unit] }, meta.sourceFile, VETTED_RECORD_GATE_OPTIONS)
    expect(analysis.violations).toEqual([])
    expect(analysis.sources).toEqual(['resolver resolveSheetReadableCapabilities'])
    // The liveness it refuses is that of the sheet it was GIVEN: the resolver takes the helper's own
    // `sheetId` parameter, which the body never reassigns.
    expect(def.parameters.map((p) => p.name.getText(meta.sourceFile))).toEqual(['req', 'query', 'sheetId', 'recordId'])
    expect(unit.code).toMatch(/= await resolveSheetReadableCapabilities\(req, query, sheetId\)/)
    expect(unit.code.match(/\bresolveSheet\w*Capabilities\w*\(/g)).toHaveLength(1)
    expect(unit.code).not.toMatch(/\bsheetId\s*(?:[-+*\/]?=(?!=)|\+\+|--)/)
    expect(unit.code).toMatch(/status:\s*401/)
    expect(unit.code).toMatch(/status:\s*403/)
    expect(unit.code).toMatch(/status:\s*404/)
    // loadSheetRow: filters the SHEET table's deleted_at and answers null when the row is gone.
    const loader = functionCode('multitable/loaders.ts', 'loadSheetRow')
    expect(sheetTableLivenessFilter(loader)).toBe(true)
    expect(loader).toMatch(/const row = \(result\.rows as any\[\]\)\[0\];?\s*if \(!row\)\s*return null/)
    expect(Object.keys(VETTED_EXTERNAL_GUARDS).sort()).toEqual(['loadSheetRow', 'requireRecordReadable'])
  })

  it(`RECORD GATE ORDER (#5830): in requireRecordReadable, authority (401, 403) precedes liveness, which precedes the record read`, () => {
    // Independent of the tree analysis above: the steps appear in this order in the helper's code.
    const code = functionCode('routes/univer-meta.ts', 'requireRecordReadable')
    const order = [
      code.indexOf('await resolveSheetReadableCapabilities('),
      code.indexOf('!access.userId'),
      code.indexOf('!capabilities.canRead'),
      code.indexOf("sheetLiveness !== 'live'"),
      code.indexOf('FROM meta_records'),
    ]
    expect(order.every((at) => at > -1), `missing step: ${JSON.stringify(order)}`).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(code.indexOf('FROM meta_records')).toBe(code.lastIndexOf('FROM meta_records'))
  })

  it('delegated guards: the route helper hands off to the injected resolver, and every injected resolver filters deleted sheets', () => {
    for (const [file, delegated] of Object.entries(DELEGATED_GUARDS)) {
      const handlersHere = scan(file).handlers.filter(addressesASheet)
      expect(handlersHere.length).toBeGreaterThan(0)
      for (const h of handlersHere) {
        expect(h.helpers.get(delegated.helper) ?? '', `${h.key} must call ${delegated.helper}`).toContain(`${delegated.delegated}(`)
        expect(guardOf(file, h), `${h.key}`).toBe(`gate-helper ${delegated.helper}`)
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
        expect(sheetTableLivenessFilter(gate![2]!)).toBe(true)
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

  it('COLLAB CHECKERS: every set…Checker seam that resolves sheet capabilities refuses a non-live sheet with its own refusal value', () => {
    const facts = allFacts()
    const found = facts.flatMap((f) => f.checkers.found)
    const problems = facts.flatMap((f) => f.checkers.problems)
    const keys = new Set(facts.flatMap((f) => f.checkers.keys))
    for (const key of Object.keys(CHECKER_REFUSALS)) {
      if (!keys.has(key)) problems.push(`CHECKER_REFUSALS ${key}: no such checker (dead entry)`)
    }
    expect(problems, problems.join('\n')).toEqual([])
    // Population: the four index.ts seams (sheet room, comment room, comment-mention notify, Yjs subscribe).
    expect(found.filter((f) => f.startsWith('src/index.ts:')).map((f) => f.replace(/^src\/index\.ts:\d+ /, ''))).toEqual([
      'collabService.setSheetRoomAuthChecker',
      'collabService.setCommentRoomAuthChecker',
      'commentService.setCommentTargetReadChecker',
      'yjsWsAdapter.setAuthChecker',
    ])
  })
})

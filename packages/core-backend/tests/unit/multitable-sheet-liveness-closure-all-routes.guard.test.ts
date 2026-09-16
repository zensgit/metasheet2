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
 *  1. FILES. Every module under src/ that registers a route is scanned. A file with at least one
 *     sheet-addressed handler must be listed in COVERED below (or be univer-meta.ts, which the sibling
 *     guard owns). A new route file that addresses a sheet reds here until someone decides about it.
 *     A registration whose handler cannot be read (imported handler, `controller.method`) is OPAQUE and
 *     must be named — nothing is skipped silently.
 *  2. HANDLERS. In a covered file every sheet-addressed handler is GUARDED or EXEMPT BY NAME with a
 *     reason. Exemption by omission is not possible; an exemption whose route disappeared, or whose
 *     route became guarded, reds too. Exemptions that rest on a checkable fact carry a `stillTrue`
 *     check over the handler AND its same-file helpers, so the reason cannot quietly rot.
 *  3. GUARDED MEANS PROVEN ON THE TREE (tests/utils/sheet-liveness-route-scan.ts `analyzeHandler`):
 *     - every capability-resolver call binds the liveness IT returned, and an `if (<that> !== 'live')`
 *       whose branch always leaves follows on the same path (no extra condition, no wrapping branch);
 *     - a capability 403 sits between the resolver call and that refusal (403 first, then the liveness
 *       404 — no liveness oracle);
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
 *     resolves sheet capabilities must also refuse a non-live sheet.
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

function optionsFor(file: string): AnalyzeOptions {
  const imports = namedImports(scan(file).sourceFile)
  const vetted = new Map<string, string>()
  for (const [name, guard] of Object.entries(VETTED_EXTERNAL_GUARDS)) {
    const spec = imports.get(name)
    if (spec && resolveImport(file, spec) === guard.file) vetted.set(name, `${name} (${guard.file})`)
  }
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

const GAP_TRACKER = /^GAP — tracked in (?:#(?:\d+|TBD-[a-z0-9-]+)|(docs\/[\w./-]+\.md)(?: §[\w-]+)?) — \S/

function reasonProblems(key: string, exemption: Exemption): string[] {
  const problems: string[] = []
  const reason = typeof exemption.reason === 'string' ? exemption.reason.trim() : ''
  if (reason.length < 80) problems.push(`${key}: exemption reason missing or too thin`)
  if (reason.startsWith('GAP')) {
    const m = GAP_TRACKER.exec(reason)
    if (!m) problems.push(`${key}: a GAP exemption must name its tracker: "GAP — tracked in #<issue> | docs/<file>.md — <why>"`)
    else if (m[1] && !existsSync(join(REPO_ROOT, ...m[1].split('/')))) problems.push(`${key}: tracker document ${m[1]} does not exist`)
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

const ownJobGate = (h: RouteHandler) => {
  const gate = h.helpers.get('resolveBulkJobForActor') ?? ''
  return /\bheader\.actorId !== userId\b/.test(gate)
    && /\bheader\.sheetId !== sheetId\b/.test(gate)
    && !/\b(meta_records|meta_fields|requireRecordReadable|readRecordOnce|resolveSheet\w*Capabilities)\b/.test(everything(h))
}

const LEGACY_SHEET_GAP = 'GAP — tracked in #TBD-legacy-sheet-parent-liveness — LEGACY spreadsheet API: `:sheetId` names a row of '
  + 'the legacy `sheets` table (kysely `selectFrom(\'sheets\')`), not `meta_sheets`, so multitable/sheet-liveness.ts '
  + 'does not apply. But DELETE /api/spreadsheets/:id soft-deletes the parent (`spreadsheets.deleted_at`) and this '
  + 'handler never checks it, so a soft-deleted spreadsheet'

const LEGACY_PERMISSION_GAP = 'GAP — tracked in #TBD-legacy-spreadsheet-permissions — `:id` is read from / written to '
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

const COMMENT_RESIDUAL = 'GAP — tracked in docs/development/multitable-g8-comments-sheet-read-gate-verification-20260706.md '
  + '§Residual — '

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
          + 'is judged a disclosure, this becomes a GAP.',
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

/** Registrations whose handler cannot be read, each named with the fact that makes it harmless. */
const OPAQUE_REGISTRATIONS: Record<string, Record<string, { handler: string; reason: string; stillTrue: () => boolean }>> = {
  'index.ts': {
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
 * GAP — the vetted record gate asks liveness BEFORE authority. Every handler that relies on it alone
 * inherits a liveness oracle; they are enumerated here so the list cannot grow unnoticed.
 */
const RECORD_GATE_ORDER_GAP = {
  reason: 'GAP — tracked in #TBD-record-gate-liveness-order — OWNED BY THE univer-meta.ts BRANCH (not edited from here): '
    + 'requireRecordReadable answers 404 (record missing, SHEET_DELETED, `Sheet not found`) BEFORE its 401/403, so a '
    + 'caller without read access can tell a live sheet from a deleted one through each route below. The '
    + '"same 403 for live and deleted" property of this closed world holds only where the route’s own gate is '
    + 'order-checked (rule 3), not for these.',
  handlers: [
    'routes/multitable-ai.ts POST /sheets/:sheetId/ai/shortcut/preview',
    'routes/multitable-ai.ts POST /sheets/:sheetId/ai/shortcut/run',
    'routes/multitable-button.ts POST /sheets/:sheetId/records/:recordId/fields/:fieldId/button/run',
    'routes/multitable-record-approvals.ts POST /sheets/:sheetId/records/:recordId/approvals',
    'routes/multitable-record-approvals.ts GET /sheets/:sheetId/records/:recordId/approvals',
  ],
}

const CHECKER_OPTIONS: AnalyzeOptions = {
  vetted: new Map(),
  delegated: null,
  preGateCalls: new Set(),
  requireOrder: false,
  gateFirst: false,
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
      "GET <path buildPath('x')> <- async (req, res) => { res.json({}); }",
      'GET <path cacheKey> <- () => compute()',
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

  it('FILES: every router module that addresses a sheet is covered here or by the sibling guard; no dead file entries', () => {
    const sheetAddressing: string[] = []
    let routerModules = 0
    for (const rel of listSourceFiles()) {
      const raw = readSource(rel)
      if (!/\.(get|post|put|patch|delete|all|addRoute)\(/.test(raw)) continue
      const scanned = scan(rel)
      if (scanned.handlers.length === 0 && scanned.opaque.length === 0) continue
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

  it('OPAQUE: every registration whose handler cannot be read is named, with a fact that still holds', () => {
    const found: OpaqueRegistration[] = []
    for (const rel of listSourceFiles()) {
      const raw = readSource(rel)
      if (!/\.(get|post|put|patch|delete|all|addRoute)\(/.test(raw)) continue
      found.push(...scan(rel).opaque)
    }
    const problems: string[] = []
    for (const o of found) {
      const named = OPAQUE_REGISTRATIONS[o.file]?.[o.key]
      if (!named) { problems.push(`src/${o.file}:${o.line} ${o.key} <- ${o.handler} is not named (read its handler and add a reason)`); continue }
      if (named.handler !== o.handler) problems.push(`${o.file} ${o.key}: handler is now \`${o.handler}\`, entry says \`${named.handler}\``)
    }
    for (const [file, entries] of Object.entries(OPAQUE_REGISTRATIONS)) {
      for (const [key, entry] of Object.entries(entries)) {
        if (!found.some((o) => o.file === file && o.key === key)) problems.push(`${file} ${key}: no such opaque registration (dead entry)`)
        problems.push(...reasonProblems(`${file} ${key}`, entry))
        if (!entry.stillTrue()) problems.push(`${file} ${key}: the fact this entry rests on is no longer true`)
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
    expect(found.length).toBeGreaterThan(0)
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
          const touching = handlers().filter((h) => !addressesASheet(h) && ledger.touches.test(everything(h)))
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
    // requireRecordReadable: resolves the sheet itself, binds and refuses its liveness on the same path.
    const meta = scanRouteSource('routes/univer-meta.ts', readSource('routes/univer-meta.ts'))
    const defs = findFunctionsNamed(meta.sourceFile, 'requireRecordReadable')
    expect(defs, 'routes/univer-meta.ts must define requireRecordReadable exactly once').toHaveLength(1)
    const unit: HandlerUnit = { label: 'handler', node: defs[0]!, code: codeOf(defs[0]!, meta.sourceFile) }
    // Liveness is asked before authority in this helper — see RECORD_GATE_ORDER_GAP — so only
    // bind-and-refuse is required here, not the order clause.
    const analysis = analyzeHandler({ units: [unit] }, meta.sourceFile, CHECKER_OPTIONS)
    expect(analysis.violations).toEqual([])
    expect(analysis.sources.some((s) => s.startsWith('resolver '))).toBe(true)
    expect(unit.code).toMatch(/status:\s*404/)
    // loadSheetRow: filters the SHEET table's deleted_at and answers null when the row is gone.
    const loader = functionCode('multitable/loaders.ts', 'loadSheetRow')
    expect(sheetTableLivenessFilter(loader)).toBe(true)
    expect(loader).toMatch(/const row = \(result\.rows as any\[\]\)\[0\];?\s*if \(!row\)\s*return null/)
    expect(Object.keys(VETTED_EXTERNAL_GUARDS).sort()).toEqual(['loadSheetRow', 'requireRecordReadable'])
  })

  it(`GAP ledger: the routes that inherit requireRecordReadable's liveness-before-403 order are exactly the named ones`, () => {
    expect(RECORD_GATE_ORDER_GAP.reason).toMatch(GAP_TRACKER)
    const inheriting: string[] = []
    for (const [file, config] of Object.entries(COVERED)) {
      for (const h of scan(file).handlers.filter(addressesASheet)) {
        if (h.key in config.exempt) continue
        const sources = [...new Set(analysisOf(file, h).sources)]
        if (sources.length > 0 && sources.every((s) => s === 'vetted requireRecordReadable')) inheriting.push(`${file} ${h.key}`)
      }
    }
    expect(inheriting.sort()).toEqual([...RECORD_GATE_ORDER_GAP.handlers].sort())
    // Still true: in the helper the liveness refusal precedes the 403. When that is fixed, drop the ledger.
    const code = functionCode('routes/univer-meta.ts', 'requireRecordReadable')
    const liveAt = code.indexOf("sheetLiveness !== 'live'")
    const forbiddenAt = code.indexOf('!capabilities.canRead')
    expect(liveAt).toBeGreaterThan(-1)
    expect(forbiddenAt).toBeGreaterThan(liveAt)
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

  it('COLLAB CHECKERS: every set…Checker seam that resolves sheet capabilities also refuses a non-live sheet', () => {
    const found: string[] = []
    const problems: string[] = []
    for (const rel of listSourceFiles()) {
      const raw = readSource(rel)
      if (!/\bset\w*Checker\(/.test(raw)) continue
      const s = scan(rel)
      for (const reg of checkerRegistrations(s.sourceFile)) {
        const code = codeOf(reg.fn, s.sourceFile)
        if (!/\bresolveSheet\w*Capabilities\w*\(/.test(code)) continue
        const where = `src/${rel}:${reg.line} ${reg.name}`
        found.push(where)
        const analysis = analyzeHandler({ units: [{ label: 'handler', node: reg.fn, code }] }, s.sourceFile, CHECKER_OPTIONS)
        for (const v of analysis.violations) problems.push(`${where}: ${v}`)
        if (!analysis.sources.some((x) => /^(resolver|blind-resolver|liveness-load) /.test(x))) {
          problems.push(`${where}: resolves sheet capabilities but never refuses a non-live sheet`)
        }
      }
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

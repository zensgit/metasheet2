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

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  addressesASheet,
  analyzeHandler,
  callSitesNamed,
  checkerRegistrations,
  codeOf,
  findFunctionsNamed,
  isFnNode,
  LIVENESS_CARRYING_RESOLVERS,
  namedImports,
  normalizeEol,
  resolveInjectedFunctions,
  scanRouteSource,
  sheetTableLivenessFilter,
  type AnalyzeOptions,
  type FnNode,
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
  getCommentAddress: 'WHICH sheet a comment-id route must gate on (#5831; comments.ts resolveCommentIdContext only) — '
    + 'CommentService.getCommentAddress reads the two addressing columns of one meta_comments row by id, no content, no '
    + 'author and no sheet data (both asserted in "COMMENT-ID ROUTES")',
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

/**
 * Helpers whose liveness refusal stops an in-request EGRESS LOOP instead of answering the request —
 * BY NAME, never by omission. Each one is asked between two outbound provider calls whether the request
 * may keep sending, so its refusal reports `false` to its caller (fail-closed) rather than a status;
 * that the caller then leaves the loop, uncharged, is proven separately (here: inlineBulkLivenessProblems
 * pins the `break`, and the tied behaviour test shows the provider is called exactly once).
 */
const EGRESS_STOP_HELPERS: Record<string, { helpers: string[]; reason: string }> = {
  'routes/multitable-ai.ts': {
    helpers: ['bulkPreviewSheetIsLive'],
    reason: '#5838 — the INLINE bulk-preview loop sends one row of record content per provider call for as '
      + 'long as the request lives; this helper is its per-row liveness question. Answering 404 from inside it '
      + 'would be wrong: the rows already generated are CHARGED and cached, so the request answers 200 with '
      + 'that partial (capped) and refuses only the remainder.',
  },
}

function optionsFor(file: string): AnalyzeOptions {
  const vetted = vettedGuardsFor(file, scan(file).sourceFile)
  return {
    vetted,
    delegated: DELEGATED_GUARDS[file]?.delegated ?? null,
    preGateCalls: new Set(Object.keys(PRE_GATE_CALLS)),
    requireOrder: true,
    gateFirst: true,
    egressStops: new Set(EGRESS_STOP_HELPERS[file]?.helpers ?? []),
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

/**
 * #5832 (fixed): the in-process bulk generate loop sends prompts built from the sheet's records row by
 * row, long after the start route's own liveness check. It must ask the shared helper about the JOB'S
 * OWN sheet before EVERY provider call and stop on anything but proof of a live sheet. Proven on the
 * tree (not by name), so the cancel exemption that relies on it cannot outlive the fix:
 *  · `loadSheetLiveness` is imported from multitable/sheet-liveness.ts;
 *  · the `for (… of plan.rows)` body has, as a direct statement AFTER the per-row cancel (job status)
 *    check and BEFORE the one that calls runShortcutCore,
 *    `if (!(await jobSheetIsLive(query, jobId, plan.sheetId))) { …; return }`, whose branch marks the
 *    remainder not generated and the job errored;
 *  · `jobSheetIsLive` is ONE top-level function `(query, jobId, sheetId)` whose body is exactly, in
 *    order and adjacent: `let liveness: SheetLiveness`; a try whose only statement is
 *    `liveness = await loadSheetLiveness(query, sheetId)` and whose catch answers false (fail-closed);
 *    `if (liveness !== 'live') { …; return false }` (so `absent` stops too); `return true` — its only
 *    non-false answer;
 *  · nothing rebinds what the check reads: in jobSheetIsLive nothing writes `query` / `jobId` /
 *    `sheetId` / `liveness` except that one lookup, and nothing re-declares them; in runGeneratePhase
 *    nothing writes `query` / `jobId` / `plan` (or a property of `plan`), and `plan` is declared once, as
 *    `const plan = this.plans.get(jobId)`; module-wide, `loadSheetLiveness` and `jobSheetIsLive` are
 *    bound once and never written.
 * The behaviour those lines produce is pinned separately (bulkWorkerBehaviourProblems): the tree check
 * cannot see what a call evaluates to at run time.
 */
const BULK_WORKER_FILE = 'services/ai-bulk-job-service.ts'
const BULK_WORKER_GATE = '!(await jobSheetIsLive(query, jobId, plan.sheetId))'
const BULK_WORKER_LOOKUP = 'liveness = await loadSheetLiveness(query, sheetId)'

const unwrapParens = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unwrapParens(node.expression) : node)

/** Identifiers declared (variable, parameter, binding element, function, class, import) under `root`. */
function declaredNames(root: ts.Node): Array<{ name: string; decl: ts.Node }> {
  const out: Array<{ name: string; decl: ts.Node }> = []
  const visit = (node: ts.Node): void => {
    const p = node.parent
    if (ts.isIdentifier(node) && p && (
      ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === node)
      || ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === node)
      || ((ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p)) && p.name === node)
    )) {
      out.push({ name: node.text, decl: p })
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return out
}

/**
 * Writes under `root`: `=` / compound assignments and `++` / `--`, including destructuring targets and
 * `for (x of …)` heads. `name` is the target's ROOT identifier (`plan.sheetId = …` writes `plan`).
 */
function writtenNames(root: ts.Node): Array<{ name: string; node: ts.Node }> {
  const out: Array<{ name: string; node: ts.Node }> = []
  const targetRoots = (target: ts.Node, at: ts.Node): void => {
    const t = ts.isExpression(target) ? unwrapParens(target) : target
    if (ts.isIdentifier(t)) out.push({ name: t.text, node: at })
    else if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) targetRoots(t.expression, at)
    else if (ts.isNonNullExpression(t) || ts.isAsExpression(t) || ts.isTypeAssertionExpression(t) || ts.isSatisfiesExpression(t)) targetRoots(t.expression, at)
    else if (ts.isArrayLiteralExpression(t)) t.elements.forEach((e) => targetRoots(e, at))
    else if (ts.isObjectLiteralExpression(t)) {
      for (const prop of t.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) out.push({ name: prop.name.text, node: at })
        else if (ts.isPropertyAssignment(prop)) targetRoots(prop.initializer, at)
        else if (ts.isSpreadAssignment(prop)) targetRoots(prop.expression, at)
      }
    } else if (ts.isSpreadElement(t)) targetRoots(t.expression, at)
    else if (ts.isBinaryExpression(t) && t.operatorToken.kind === ts.SyntaxKind.EqualsToken) targetRoots(t.left, at)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      targetRoots(node.left, node)
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      targetRoots(node.operand, node)
    } else if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      targetRoots(node.initializer, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return out
}

const paramNames = (fn: FnNode) => fn.parameters
  .map((p) => (ts.isIdentifier(p.name) && !p.initializer && !p.dotDotDotToken && !p.questionToken ? p.name.text : '<not a plain parameter>'))
  .join(', ')

function bulkWorkerLivenessProblems(source: string): string[] {
  const sf = scanRouteSource(BULK_WORKER_FILE, source).sourceFile
  const text = (node: ts.Node) => codeOf(node, sf)
  const lastIs = (node: ts.Statement | undefined, expected: string) => !!node && ts.isBlock(node)
    && node.statements.length > 0 && text(node.statements[node.statements.length - 1]!) === expected
  const problems: string[] = []

  const imported = namedImports(sf).get('loadSheetLiveness')
  if (!imported || imported.imported !== 'loadSheetLiveness' || resolveImport(BULK_WORKER_FILE, imported.module) !== 'multitable/sheet-liveness.ts') {
    problems.push('loadSheetLiveness must be imported from multitable/sheet-liveness')
  }
  // Module-wide: the helper and the gate are each bound exactly once and never reassigned.
  const moduleDecls = declaredNames(sf)
  for (const name of ['loadSheetLiveness', 'jobSheetIsLive']) {
    const count = moduleDecls.filter((d) => d.name === name).length
    if (count !== 1) problems.push(`module: \`${name}\` must be bound exactly once (found ${count}) — a second binding can shadow it`)
  }
  for (const w of writtenNames(sf).filter((x) => x.name === 'loadSheetLiveness' || x.name === 'jobSheetIsLive')) {
    problems.push(`module: \`${w.name}\` must never be written (\`${text(w.node)}\`)`)
  }

  const phases = findFunctionsNamed(sf, 'runGeneratePhase')
  if (phases.length !== 1) return [...problems, `runGeneratePhase: expected 1 definition, found ${phases.length}`]
  const phase = phases[0]!
  if (paramNames(phase) !== 'query, jobId') problems.push(`runGeneratePhase: parameters must be exactly (query, jobId), found (${paramNames(phase)})`)
  const phaseDecls = declaredNames(phase).filter((d) => ['query', 'jobId', 'plan', 'jobSheetIsLive', 'loadSheetLiveness'].includes(d.name)
    && !(ts.isParameter(d.decl) && d.decl.parent === phase))
  const planDecl = phaseDecls.length === 1 && ts.isVariableDeclaration(phaseDecls[0]!.decl) ? phaseDecls[0]!.decl : null
  if (!planDecl || text(planDecl) !== 'plan = this.plans.get(jobId)'
    || !ts.isVariableDeclarationList(planDecl.parent) || !(planDecl.parent.flags & ts.NodeFlags.Const)) {
    problems.push(`runGeneratePhase: \`plan\` must be declared once, as \`const plan = this.plans.get(jobId)\`, and nothing may re-declare query / jobId / plan / jobSheetIsLive (found: ${phaseDecls.map((d) => text(d.decl)).join(' | ') || 'none'})`)
  }
  for (const w of writtenNames(phase).filter((x) => ['query', 'jobId', 'plan'].includes(x.name))) {
    problems.push(`runGeneratePhase: \`${w.name}\` must never be written (\`${text(w.node)}\`)`)
  }
  const loops: ts.ForOfStatement[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && text(node.expression) === 'plan.rows') loops.push(node)
    ts.forEachChild(node, visit)
  }
  visit(phases[0]!)
  const loopBody = loops.length === 1 && ts.isBlock(loops[0]!.statement) ? loops[0]!.statement.statements : null
  if (!loopBody) return [...problems, `runGeneratePhase: expected exactly one \`for (… of plan.rows) { … }\`, found ${loops.length}`]
  const sendAt = loopBody.findIndex((st) => /\brunShortcutCore\(/.test(text(st)))
  if (sendAt < 0) problems.push('the plan.rows loop no longer calls runShortcutCore — re-derive what this check protects')
  const gateAt = loopBody.findIndex((st) => ts.isIfStatement(st) && text(st.expression) === BULK_WORKER_GATE)
  if (gateAt < 0) {
    problems.push(`the plan.rows loop must stop on \`if (${BULK_WORKER_GATE})\` as a direct statement of its body`)
  } else {
    const stop = loopBody[gateAt] as ts.IfStatement
    if (stop.elseStatement || !lastIs(stop.thenStatement, 'return;')) problems.push('the liveness stop must end in `return` (and have no else)')
    const stopCode = text(stop.thenStatement)
    if (!/\bmarkRemainingPendingNotGenerated\(query, jobId\)/.test(stopCode)) problems.push('the liveness stop must mark the remainder pending_not_generated')
    if (!/\bmarkErroredIfRunning\(query, jobId\)/.test(stopCode)) problems.push('the liveness stop must mark the job errored (guarded on running)')
    if (sendAt >= 0 && gateAt > sendAt) problems.push('the liveness stop must come BEFORE the provider call in the loop body')
    // After the cancel check, so a cancelled job stays `rejected` and is not asked about its sheet again.
    const cancelAt = loopBody.findIndex((st) => ts.isIfStatement(st) && /\breadJobStatus\(query, jobId\)/.test(text(st.expression)))
    if (cancelAt < 0 || cancelAt > gateAt) problems.push('the liveness stop must follow the per-row cancel (job status) check')
  }

  const gates = findFunctionsNamed(sf, 'jobSheetIsLive')
  const gate = gates.length === 1 && ts.isFunctionDeclaration(gates[0]!) && gates[0]!.parent === sf ? gates[0]! : null
  const gateBody = gate?.body && ts.isBlock(gate.body) ? gate.body.statements : null
  if (!gate || !gateBody) return [...problems, `jobSheetIsLive: expected 1 top-level function declaration with a block body, found ${gates.length} definition(s)`]
  // The loop passes plan.sheetId THIRD: the third parameter is what the lookup asks about.
  if (paramNames(gate) !== 'query, jobId, sheetId') problems.push(`jobSheetIsLive: parameters must be exactly (query, jobId, sheetId), found (${paramNames(gate)})`)
  // Exactly four statements, in this order, adjacent: nothing can run between the lookup and the refusal.
  const [declSt, trySt, refuseSt, finalSt] = gateBody
  if (gateBody.length !== 4 || !declSt || text(declSt) !== 'let liveness: SheetLiveness;') {
    problems.push(`jobSheetIsLive: the body must be exactly \`let liveness: SheetLiveness\`, the guarded lookup, the refusal, \`return true\` — adjacent, nothing in between (found ${gateBody.length} statements)`)
  }
  const lookup = trySt && ts.isTryStatement(trySt) && trySt.tryBlock.statements.length === 1 ? trySt.tryBlock.statements[0]! : null
  if (!trySt || !ts.isTryStatement(trySt) || !lookup || text(lookup) !== `${BULK_WORKER_LOOKUP};`
    || !trySt.catchClause || !lastIs(trySt.catchClause.block, 'return false;') || trySt.finallyBlock) {
    problems.push('jobSheetIsLive: `loadSheetLiveness(query, sheetId)` must run in a try whose catch answers false (fail-closed), as the second statement')
  }
  if (!refuseSt || !ts.isIfStatement(refuseSt) || text(refuseSt.expression) !== 'liveness !== \'live\''
    || refuseSt.elseStatement || !lastIs(refuseSt.thenStatement, 'return false;')) {
    problems.push('jobSheetIsLive: `if (liveness !== \'live\') { …; return false }` must follow the lookup, as the third statement')
  }
  // Nothing rebinds what the lookup reads or what the refusal tests.
  const gateNames = ['query', 'jobId', 'sheetId', 'liveness', 'loadSheetLiveness']
  const redeclared = declaredNames(gate).filter((d) => gateNames.includes(d.name)
    && !(ts.isParameter(d.decl) && d.decl.parent === gate) && !(declSt && d.decl.parent?.parent === declSt))
  for (const d of redeclared) problems.push(`jobSheetIsLive: \`${d.name}\` must not be re-declared (\`${text(d.decl)}\`)`)
  const lookupWrite = lookup && ts.isExpressionStatement(lookup) ? unwrapParens(lookup.expression) : null
  for (const w of writtenNames(gate).filter((x) => gateNames.includes(x.name) && x.node !== lookupWrite)) {
    problems.push(`jobSheetIsLive: \`${w.name}\` may only be written by the lookup (\`${text(w.node)}\`)`)
  }
  const returnsTrue: ts.ReturnStatement[] = []
  const collect = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression && text(node.expression) !== 'false') returnsTrue.push(node)
    if (node === gate || !isFnNode(node)) ts.forEachChild(node, collect)
  }
  collect(gate)
  if (returnsTrue.length !== 1 || returnsTrue[0] !== gateBody[gateBody.length - 1] || text(returnsTrue[0]!) !== 'return true;') {
    problems.push('jobSheetIsLive: the only non-false answer must be its final `return true`')
  }
  return problems
}

/**
 * #5832 BEHAVIOUR TIE. The tree check above proves the shape of the stop; what the stop DOES (the
 * provider is not called again, `absent` and a failed lookup stop too, a cancel still wins) is proven
 * by running the real worker in tests/unit/ai-bulk-job-sheet-liveness.test.ts. That file must exist, run
 * the real service (import it, mock nothing, stay out of the vitest exclude list) and keep each case,
 * none skipped or focused.
 */
const BULK_WORKER_BEHAVIOUR_TEST = 'ai-bulk-job-sheet-liveness.test.ts'
const BULK_WORKER_BEHAVIOUR_CASES = [
  'LIVE sheet:',
  'sheet DELETED while row 1 is generating:',
  'sheet deleted BEFORE the worker starts:',
  'sheet row GONE (absent) mid-run:',
  'liveness LOOKUP FAILS before row 2:',
  'CANCEL still wins:',
]
const TEST_CALLEES = new Set(['it', 'test', 'describe', 'suite'])
const TEST_MODIFIERS = new Set(['skip', 'only', 'todo', 'skipIf', 'runIf', 'fails', 'each', 'for'])
const TEST_SKIP_ALIASES = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe'])

function bulkWorkerBehaviourProblems(testSource: string | null, vitestConfig: string): string[] {
  if (testSource === null) return [`tests/unit/${BULK_WORKER_BEHAVIOUR_TEST} is missing`]
  const sf = ts.createSourceFile(BULK_WORKER_BEHAVIOUR_TEST, normalizeEol(testSource), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const problems: string[] = []
  const titles: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const first = node.arguments[0]
      if (ts.isIdentifier(callee) && (callee.text === 'it' || callee.text === 'test') && first && ts.isStringLiteralLike(first)) titles.push(first.text)
      if (ts.isIdentifier(callee) && TEST_SKIP_ALIASES.has(callee.text)) problems.push(`${callee.text}(…) skips or focuses a case`)
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        if (TEST_CALLEES.has(callee.expression.text) && TEST_MODIFIERS.has(callee.name.text)) {
          problems.push(`${callee.expression.text}.${callee.name.text}(…) is not allowed here — every case runs, unconditionally`)
        }
        if (callee.expression.text === 'vi' && /^(do)?(un)?mock$/i.test(callee.name.text)) {
          problems.push(`vi.${callee.name.text}(…) — the behaviour test drives the real worker and the real provider choke`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  const service = namedImports(sf).get('BulkFillJobService')
  if (!service || service.imported !== 'BulkFillJobService' || service.module !== '../../src/services/ai-bulk-job-service') {
    problems.push('BulkFillJobService must be imported from ../../src/services/ai-bulk-job-service')
  }
  for (const prefix of BULK_WORKER_BEHAVIOUR_CASES) {
    const n = titles.filter((t) => t.startsWith(prefix)).length
    if (n !== 1) problems.push(`case "${prefix}…": expected exactly one it(…), found ${n}`)
  }
  if (vitestConfig.includes(BULK_WORKER_BEHAVIOUR_TEST.replace(/\.test\.ts$/, ''))) {
    problems.push(`vitest.config.ts mentions ${BULK_WORKER_BEHAVIOUR_TEST} — it must run in the unit job`)
  }
  return problems
}

/**
 * Self-test seam for the two #5832 proofs that the cancel exemption and the worker's PROVIDER_LOOPS entry
 * rest on: left empty, both read the tree; the self-test swaps in a mutated worker source or behaviour
 * test (in memory) to show each `stillTrue` falls with either proof.
 */
const bulkWorkerInputs: { worker?: string; behaviour?: string | null } = {}

function bulkWorkerSourceProblems(): string[] {
  return bulkWorkerLivenessProblems(bulkWorkerInputs.worker ?? readSource(BULK_WORKER_FILE))
}

function readBulkWorkerBehaviour(): string[] {
  const path = join(__dirname, BULK_WORKER_BEHAVIOUR_TEST)
  const onDisk = () => (existsSync(path) ? readFileSync(path, 'utf8') : null)
  return bulkWorkerBehaviourProblems(
    bulkWorkerInputs.behaviour !== undefined ? bulkWorkerInputs.behaviour : onDisk(),
    readFileSync(join(__dirname, '../../vitest.config.ts'), 'utf8'),
  )
}

// ── Provider loops (#5832, #5838) ───────────────────────────────────────────

/**
 * A loop that sends record content to the model row by row outlives any liveness check made before it
 * starts. Every such loop under src/ is named in PROVIDER_LOOPS: fixed (with a proof), or a tracked GAP.
 *
 * What is discovered (scope of the claim): a call to the provider choke `runShortcutCore`, or to a
 * SAME-FILE function whose body calls it directly, that sits inside a loop statement (for, for…of,
 * for…in, while, do) or inside a callback passed to an array iteration method (map, forEach, …), within
 * one function. A call reached through a cross-file helper, a deeper same-file chain or a queue is not
 * seen here.
 */
const PROVIDER_CHOKE = 'runShortcutCore'
const ITERATION_METHODS = new Set(['map', 'forEach', 'flatMap', 'reduce', 'reduceRight', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex'])
/** Calls that re-establish sheet liveness (any of them inside the loop flips a GAP entry to "no longer true"). */
const LIVENESS_CALLS = new Set(['loadSheetLiveness', 'assertSheetLive', 'jobSheetIsLive', 'bulkPreviewSheetIsLive', 'loadSheetRow', 'requireRecordReadable', ...LIVENESS_CARRYING_RESOLVERS])

interface ProviderLoop {
  /** `<file under src/> <route key>` for a route handler, else `<file> <enclosing function name>`. */
  key: string
  line: number
  /** The loop (head and body) calls something that re-establishes sheet liveness. */
  asksLiveness: boolean
}

const calledName = (call: ts.CallExpression): string | null => {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text
  return null
}

/** Whether `root` calls one of `names`; `direct` stops at nested functions (their calls are theirs). */
function callsAny(root: ts.Node, names: Set<string>, direct = false): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) && names.has(calledName(node) ?? '')) { found = true; return }
    if (direct && node !== root && isFnNode(node)) return
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function fnNameOf(fn: FnNode): string | null {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isPrivateIdentifier(fn.name))) return fn.name.text
  const p = fn.parent
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (p && (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && ts.isIdentifier(p.name)) return p.name.text
  return null
}

function providerLoopsOf(rel: string, scanned: ScannedRouteFile): ProviderLoop[] {
  const sf = scanned.sourceFile
  const senders = new Set([PROVIDER_CHOKE])
  const collectSenders = (node: ts.Node): void => {
    if (isFnNode(node)) {
      const name = fnNameOf(node)
      if (name && name !== PROVIDER_CHOKE && callsAny(node, new Set([PROVIDER_CHOKE]), true)) senders.add(name)
    }
    ts.forEachChild(node, collectSenders)
  }
  collectSenders(sf)

  const loops = new Map<ts.Node, ProviderLoop>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && senders.has(calledName(node) ?? '')) {
      let loop: ts.Node | null = null
      let current: ts.Node = node
      while (!loop && current.parent && !ts.isSourceFile(current.parent)) {
        const parent: ts.Node = current.parent
        if (ts.isIterationStatement(parent, false)) {
          loop = parent
        } else if (isFnNode(parent)) {
          const outer = parent.parent
          const iterates = !!outer && ts.isCallExpression(outer) && outer.arguments.some((a) => a === parent)
            && ts.isPropertyAccessExpression(outer.expression) && ITERATION_METHODS.has(outer.expression.name.text)
          if (!iterates) break
          loop = outer
        }
        current = parent
      }
      if (loop && !loops.has(loop)) {
        let fn: ts.Node | undefined = loop.parent
        while (fn && !isFnNode(fn)) fn = fn.parent
        const handler = fn ? scanned.handlers.find((h) => h.units.some((u) => u.label === 'handler' && u.node === fn)) : undefined
        const owner = handler ? handler.key : (fn && isFnNode(fn) ? fnNameOf(fn) : null) ?? '<module>'
        loops.set(loop, {
          key: `${rel} ${owner}`,
          line: sf.getLineAndCharacterOfPosition(loop.getStart(sf)).line + 1,
          asksLiveness: callsAny(loop, LIVENESS_CALLS),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...loops.values()]
}

// ── The inline bulk-preview loop (#5838) ────────────────────────────────────

/**
 * #5838 — the SAME class as #5832 on the OTHER lane. `POST …/ai/shortcut/bulk-preview` refuses a
 * non-live sheet once at entry, then (at or below the inline cap) loops over the gated rows calling the
 * provider choke inside that one request, for minutes; nothing downstream of the loop reads
 * `meta_sheets` again. The loop must therefore ask the shared helper (multitable/sheet-liveness.ts
 * `loadSheetLiveness`) about THIS sheet before EVERY provider call, and stop on anything but proof that
 * it is live.
 *
 * What is pinned, mirroring the worker's check above (same reasons, same failure modes):
 *  · the helper is the SHARED one, imported from multitable/sheet-liveness, bound once, never written;
 *  · the stop sits in the ONE loop that feeds the choke, BEFORE the call, and ends the loop (`break`)
 *    after recording the row it stopped on as UNCHARGED (`skipped`) and marking the run partial;
 *  · `bulkPreviewSheetIsLive` asks (query, sheetId), fails CLOSED on a throw, refuses everything that is
 *    not `'live'` (so `absent` stops too), and has exactly one way to answer true;
 *  · nothing rebinds what the lookup reads or what the refusal tests.
 * The behaviour those lines produce is pinned separately (inlineBulkBehaviourProblems).
 */
const INLINE_BULK_FILE = 'routes/multitable-ai.ts'
const INLINE_BULK_GATE = '!(await bulkPreviewSheetIsLive(query, sheetId))'
const INLINE_BULK_LOOKUP = 'liveness = await loadSheetLiveness(query, sheetId)'
const INLINE_BULK_LOOP = 'generationCandidates'

function inlineBulkLivenessProblems(source: string): string[] {
  const sf = scanRouteSource(INLINE_BULK_FILE, source).sourceFile
  const text = (node: ts.Node) => codeOf(node, sf)
  const lastIs = (node: ts.Statement | undefined, expected: string) => !!node && ts.isBlock(node)
    && node.statements.length > 0 && text(node.statements[node.statements.length - 1]!) === expected
  const problems: string[] = []

  const imported = namedImports(sf).get('loadSheetLiveness')
  if (!imported || imported.imported !== 'loadSheetLiveness' || resolveImport(INLINE_BULK_FILE, imported.module) !== 'multitable/sheet-liveness.ts') {
    problems.push('loadSheetLiveness must be imported from multitable/sheet-liveness')
  }
  // Module-wide: the helper and the gate are each bound exactly once and never reassigned.
  const moduleDecls = declaredNames(sf)
  for (const name of ['loadSheetLiveness', 'bulkPreviewSheetIsLive']) {
    const count = moduleDecls.filter((d) => d.name === name).length
    if (count !== 1) problems.push(`module: \`${name}\` must be bound exactly once (found ${count}) — a second binding can shadow it`)
  }
  for (const w of writtenNames(sf).filter((x) => x.name === 'loadSheetLiveness' || x.name === 'bulkPreviewSheetIsLive')) {
    problems.push(`module: \`${w.name}\` must never be written (\`${text(w.node)}\`)`)
  }

  // The ONE loop that feeds the provider choke row by row (the route has a second loop over the same
  // candidates — the async job's seeding loop — which sends nothing, so the choke is the discriminator).
  const loops: ts.ForOfStatement[] = []
  const findLoops = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && text(node.expression) === INLINE_BULK_LOOP && callsAny(node, new Set([PROVIDER_CHOKE]))) loops.push(node)
    ts.forEachChild(node, findLoops)
  }
  findLoops(sf)
  const loop = loops.length === 1 ? loops[0]! : null
  const loopBody = loop && ts.isBlock(loop.statement) ? loop.statement.statements : null
  if (!loopBody) return [...problems, `bulk-preview: expected exactly one \`for (… of ${INLINE_BULK_LOOP}) { … }\` that calls ${PROVIDER_CHOKE}, found ${loops.length}`]

  const sendAt = loopBody.findIndex((st) => /\brunShortcutCore\(/.test(text(st)))
  if (sendAt < 0) problems.push('the generation loop no longer calls runShortcutCore — re-derive what this check protects')
  const gateAt = loopBody.findIndex((st) => ts.isIfStatement(st) && text(st.expression) === INLINE_BULK_GATE)
  if (gateAt < 0) {
    problems.push(`the generation loop must stop on \`if (${INLINE_BULK_GATE})\` as a direct statement of its body`)
  } else {
    const stop = loopBody[gateAt] as ts.IfStatement
    if (stop.elseStatement || !lastIs(stop.thenStatement, 'break;')) problems.push('the liveness stop must end in `break` (and have no else)')
    const stopCode = text(stop.thenStatement)
    if (!/\bskipped\.push\(\{ recordId, reason: 'sheet_not_live' \}\)/.test(stopCode)) {
      problems.push("the liveness stop must record the row it stopped on as skipped (UNCHARGED): `skipped.push({ recordId, reason: 'sheet_not_live' })`")
    }
    if (!/\bpaused = true\b/.test(stopCode)) problems.push('the liveness stop must mark the run partial (`paused = true` → the response’s `capped`)')
    if (sendAt >= 0 && gateAt > sendAt) problems.push('the liveness stop must come BEFORE the provider call in the loop body')
  }

  // Inside the handler that owns the loop: what the check reads is bound once and never rewritten.
  let handler: ts.Node | undefined = loop!.parent
  while (handler && !isFnNode(handler)) handler = handler.parent
  if (!handler) return [...problems, 'bulk-preview: the generation loop has no enclosing function']
  const handlerNames = ['query', 'sheetId', 'bulkPreviewSheetIsLive', 'loadSheetLiveness']
  for (const name of ['query', 'sheetId']) {
    const count = declaredNames(handler).filter((d) => d.name === name).length
    if (count !== 1) problems.push(`the bulk-preview handler: \`${name}\` must be declared exactly once (found ${count})`)
  }
  for (const d of declaredNames(handler).filter((x) => handlerNames.includes(x.name) && x.name !== 'query' && x.name !== 'sheetId')) {
    problems.push(`the bulk-preview handler: \`${d.name}\` must not be re-declared (\`${text(d.decl)}\`)`)
  }
  for (const w of writtenNames(handler).filter((x) => handlerNames.includes(x.name))) {
    problems.push(`the bulk-preview handler: \`${w.name}\` must never be written (\`${text(w.node)}\`)`)
  }

  const gates = findFunctionsNamed(sf, 'bulkPreviewSheetIsLive')
  const gate = gates.length === 1 && ts.isFunctionDeclaration(gates[0]!) && gates[0]!.parent === sf ? gates[0]! : null
  const gateBody = gate?.body && ts.isBlock(gate.body) ? gate.body.statements : null
  if (!gate || !gateBody) return [...problems, `bulkPreviewSheetIsLive: expected 1 top-level function declaration with a block body, found ${gates.length} definition(s)`]
  // The loop passes sheetId SECOND: the second parameter is what the lookup asks about.
  if (paramNames(gate) !== 'query, sheetId') problems.push(`bulkPreviewSheetIsLive: parameters must be exactly (query, sheetId), found (${paramNames(gate)})`)
  // Exactly four statements, in this order, adjacent: nothing can run between the lookup and the refusal.
  const [declSt, trySt, refuseSt] = gateBody
  if (gateBody.length !== 4 || !declSt || text(declSt) !== 'let liveness: SheetLiveness;') {
    problems.push(`bulkPreviewSheetIsLive: the body must be exactly \`let liveness: SheetLiveness\`, the guarded lookup, the refusal, \`return true\` — adjacent, nothing in between (found ${gateBody.length} statements)`)
  }
  const lookup = trySt && ts.isTryStatement(trySt) && trySt.tryBlock.statements.length === 1 ? trySt.tryBlock.statements[0]! : null
  if (!trySt || !ts.isTryStatement(trySt) || !lookup || text(lookup) !== `${INLINE_BULK_LOOKUP};`
    || !trySt.catchClause || !lastIs(trySt.catchClause.block, 'return false;') || trySt.finallyBlock) {
    problems.push('bulkPreviewSheetIsLive: `loadSheetLiveness(query, sheetId)` must run in a try whose catch answers false (fail-closed), as the second statement')
  }
  if (!refuseSt || !ts.isIfStatement(refuseSt) || text(refuseSt.expression) !== 'liveness !== \'live\''
    || refuseSt.elseStatement || !lastIs(refuseSt.thenStatement, 'return false;')) {
    problems.push('bulkPreviewSheetIsLive: `if (liveness !== \'live\') { …; return false }` must follow the lookup, as the third statement')
  }
  // Nothing rebinds what the lookup reads or what the refusal tests.
  const gateNames = ['query', 'sheetId', 'liveness', 'loadSheetLiveness']
  const redeclared = declaredNames(gate).filter((d) => gateNames.includes(d.name)
    && !(ts.isParameter(d.decl) && d.decl.parent === gate) && !(declSt && d.decl.parent?.parent === declSt))
  for (const d of redeclared) problems.push(`bulkPreviewSheetIsLive: \`${d.name}\` must not be re-declared (\`${text(d.decl)}\`)`)
  const lookupWrite = lookup && ts.isExpressionStatement(lookup) ? unwrapParens(lookup.expression) : null
  for (const w of writtenNames(gate).filter((x) => gateNames.includes(x.name) && x.node !== lookupWrite)) {
    problems.push(`bulkPreviewSheetIsLive: \`${w.name}\` may only be written by the lookup (\`${text(w.node)}\`)`)
  }
  const returnsTrue: ts.ReturnStatement[] = []
  const collect = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression && text(node.expression) !== 'false') returnsTrue.push(node)
    if (node === gate || !isFnNode(node)) ts.forEachChild(node, collect)
  }
  collect(gate)
  if (returnsTrue.length !== 1 || returnsTrue[0] !== gateBody[gateBody.length - 1] || text(returnsTrue[0]!) !== 'return true;') {
    problems.push('bulkPreviewSheetIsLive: the only non-false answer must be its final `return true`')
  }
  return problems
}

/**
 * #5838 BEHAVIOUR TIE — the twin of the worker's. The tree check above proves the shape of the stop;
 * what the stop DOES (the provider is called exactly once when the sheet is deleted mid-request,
 * `absent` and a failed lookup stop too, the already-generated partial is still returned) is proven by
 * driving the REAL router over HTTP in tests/unit/multitable-ai-bulk-preview-sheet-liveness.test.ts.
 * That file must exist, build the real route module (never a stand-in, never a mocked liveness module),
 * go through the pinned server (#4154: `request(app)` is banned in tests/unit), run in the unit job and
 * keep every case, none skipped or focused.
 */
const INLINE_BULK_BEHAVIOUR_TEST = 'multitable-ai-bulk-preview-sheet-liveness.test.ts'
const INLINE_BULK_BEHAVIOUR_CASES = [
  'LIVE sheet:',
  'sheet DELETED while row 1 is generating:',
  'sheet row GONE (absent) mid-run:',
  'liveness LOOKUP FAILS before row 2:',
  'sheet deleted BEFORE the request:',
]

function inlineBulkBehaviourProblems(testSource: string | null, vitestConfig: string): string[] {
  if (testSource === null) return [`tests/unit/${INLINE_BULK_BEHAVIOUR_TEST} is missing`]
  const normalized = normalizeEol(testSource)
  const sf = ts.createSourceFile(INLINE_BULK_BEHAVIOUR_TEST, normalized, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const problems: string[] = []
  const titles: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const first = node.arguments[0]
      if (ts.isIdentifier(callee) && (callee.text === 'it' || callee.text === 'test') && first && ts.isStringLiteralLike(first)) titles.push(first.text)
      if (ts.isIdentifier(callee) && TEST_SKIP_ALIASES.has(callee.text)) problems.push(`${callee.text}(…) skips or focuses a case`)
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        if (TEST_CALLEES.has(callee.expression.text) && TEST_MODIFIERS.has(callee.name.text)) {
          problems.push(`${callee.expression.text}.${callee.name.text}(…) is not allowed here — every case runs, unconditionally`)
        }
        if (callee.expression.text === 'vi' && /^(do)?(un)?mock$/i.test(callee.name.text)) {
          problems.push(`vi.${callee.name.text}(…) — the behaviour test drives the real route and the real provider choke`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!/\bcreateMultitableAiRoutes\b/.test(normalized) || !/['"]\.\.\/\.\.\/src\/routes\/multitable-ai['"]/.test(normalized)) {
    problems.push('the real router must be built here: createMultitableAiRoutes from ../../src/routes/multitable-ai')
  }
  if (!/\busePinnedServer\(\)/.test(normalized) || !/\brequest\(pinned\.url\(\)\)/.test(normalized) || /\brequest\(app\)/.test(normalized)) {
    problems.push('the route must be driven over the pinned server (#4154): usePinnedServer() + request(pinned.url()), never request(app)')
  }
  for (const prefix of INLINE_BULK_BEHAVIOUR_CASES) {
    const n = titles.filter((t) => t.startsWith(prefix)).length
    if (n !== 1) problems.push(`case "${prefix}…": expected exactly one it(…), found ${n}`)
  }
  if (vitestConfig.includes(INLINE_BULK_BEHAVIOUR_TEST.replace(/\.test\.ts$/, ''))) {
    problems.push(`vitest.config.ts mentions ${INLINE_BULK_BEHAVIOUR_TEST} — it must run in the unit job`)
  }
  return problems
}

/** Self-test seam for the two #5838 proofs, exactly as `bulkWorkerInputs` is for #5832. */
const inlineBulkInputs: { route?: string; behaviour?: string | null } = {}

function inlineBulkSourceProblems(): string[] {
  return inlineBulkLivenessProblems(inlineBulkInputs.route ?? readSource(INLINE_BULK_FILE))
}

function readInlineBulkBehaviour(): string[] {
  const path = join(__dirname, INLINE_BULK_BEHAVIOUR_TEST)
  const onDisk = () => (existsSync(path) ? readFileSync(path, 'utf8') : null)
  return inlineBulkBehaviourProblems(
    inlineBulkInputs.behaviour !== undefined ? inlineBulkInputs.behaviour : onDisk(),
    readFileSync(join(__dirname, '../../vitest.config.ts'), 'utf8'),
  )
}

const PROVIDER_LOOPS: Record<string, { reason: string; stillTrue: (loop: ProviderLoop) => boolean }> = {
  'services/ai-bulk-job-service.ts runGeneratePhase': {
    reason: 'FIXED (#5832) — the async bulk-fill job worker sends one prompt per row long after the start route’s '
      + 'liveness check; it now asks loadSheetLiveness about the job’s own sheet before every provider call and '
      + 'stops the job on anything but proof of a live sheet (shape proven by bulkWorkerLivenessProblems, behaviour '
      + 'by the tied behaviour test, bulkWorkerBehaviourProblems).',
    stillTrue: (loop) => loop.asksLiveness
      && bulkWorkerSourceProblems().length === 0
      && readBulkWorkerBehaviour().length === 0,
  },
  'routes/multitable-ai.ts POST /sheets/:sheetId/ai/shortcut/bulk-preview': {
    reason: 'FIXED (#5838) — the INLINE bulk-preview path (at most MULTITABLE_AI_BULK_MAX_ROWS generatable rows) '
      + 'refused a non-live sheet once at entry and then looped over the rows calling runShortcutCore without asking '
      + 'again, so a sheet soft-deleted during the request kept sending its remaining rows’ record content to the '
      + 'provider — the same class as #5832 on the synchronous lane. It now asks loadSheetLiveness about THIS sheet '
      + 'before every provider call (bulkPreviewSheetIsLive) and stops on anything but proof of a live sheet, '
      + 'returning the already-generated partial as capped (shape proven by inlineBulkLivenessProblems, behaviour by '
      + 'the tied behaviour test, inlineBulkBehaviourProblems).',
    stillTrue: (loop) => loop.asksLiveness
      && inlineBulkSourceProblems().length === 0
      && readInlineBulkBehaviour().length === 0,
  },
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

/**
 * #5831 part B — the user-scoped cross-sheet aggregates of CommentService and how each must apply the
 * route's CommentInboxScope: admit it first (a missing or empty scope answers empty WITHOUT a query), then
 * put `inboxScopePredicate` in the WHERE of every query that counts or lists (`wheres` = how many).
 */
const COMMENT_SCOPED_AGGREGATES: Record<string, { wheres: number }> = {
  getInbox: { wheres: 2 },
  getUnreadCount: { wheres: 1 },
  getUnreadSummary: { wheres: 1 },
}
/** #5831 part B — the id-only candidate listers the route turns into that scope (called by it alone). */
const COMMENT_INBOX_CANDIDATE_LISTERS = ['listInboxCandidateSheetIds', 'listInboxCandidateRowIds']

/**
 * A scoped aggregate really filters: it admits the scope and returns before querying when nothing is
 * admitted, and each of its `.where(…)` scope filters sits on a query BEFORE that query executes (for the
 * page query: before `.limit(`), so COUNT and pages see the same rows.
 */
const commentServiceScoped = (method: string) => {
  const code = functionCode('services/CommentService.ts', method)
  const spec = COMMENT_SCOPED_AGGREGATES[method]
  if (!spec || code.length === 0) return false
  if (!/const admitted = admitInboxScope\(scope\);\s*if \(!admitted \|\| userId\.trim\(\)\.length === 0\)\s*return [^;]*;/.test(code)) return false
  const queries = code.split(/\bawait db\b/).slice(1)
  const scoped = queries.filter((q) => /\.where\((?:scopePredicate|inboxScopePredicate\(admitted\))\)/.test(q))
  if (queries.length !== spec.wheres || scoped.length !== spec.wheres) return false
  return scoped.every((q) => {
    const at = q.search(/\.where\((?:scopePredicate|inboxScopePredicate\(admitted\))\)/)
    const end = q.search(/\.(?:limit|execute|executeTakeFirst)\(/)
    return end > at
  })
}

/** The route half of an inbox entry: the handler asks resolveCommentInboxScope and hands the scope on. */
const inboxRouteScoped = (h: RouteHandler, call: RegExp) => /const inbox = await resolveCommentInboxScope\(req, commentService\);/.test(h.code)
  && call.test(h.code)
  && h.helpers.has('resolveCommentInboxScope')
  && !/\bgetUserId\(/.test(h.code)

const INBOX_SCOPE_REASON = 'CROSS-SHEET AGGREGATE, FILTERED (#5831 part B): it names no sheet, so it cannot answer with the '
  + 'single-sheet 403/404. Instead resolveCommentInboxScope (same file) keeps only comments on LIVE sheets the caller may READ '
  + '(loadSheetLivenessBatch + filterReadableSheetRowsForAccess, the gate’s rules for a set) and, on a row-deny sheet '
  + '(loadInboxRowDenySheetIds, one batched flag lookup), only on the candidate rows it CHECKED and found allowed (non-admins; '
  + 'an allow list, so a row it never checked is left out), and CommentService applies that scope in the WHERE of '
  + 'every count and page query (all asserted in "INBOX SCOPE").'

/** #5831 part A: the `:commentId` routes of comments.ts, each gated on the comment's own sheet. */
const COMMENT_ID_ROUTES = [
  'PATCH /api/comments/:commentId',
  'DELETE /api/comments/:commentId',
  'POST /api/comments/:commentId/read',
  'POST /api/comments/:commentId/reactions',
  'DELETE /api/comments/:commentId/reactions',
  'POST /api/comments/:commentId/resolve',
]

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
    // 10 sheet-addressed + the 6 comment-id routes, which gate on the comment's own sheet (#5831 part A).
    minInScope: 16,
    exempt: {},
    behaviourTest: 'comment-routes-sheet-liveness.test.ts',
    unaddressed: {
      // Any reference to the service counts (a cast such as `(commentService as any).x(` included).
      touches: /\bcommentService\b/,
      named: {
        'GET /api/comments/inbox': {
          reason: INBOX_SCOPE_REASON,
          stillTrue: (h) => inboxRouteScoped(h, /\bcommentService\.getInbox\(inbox\.userId, \{ limit, offset \}, inbox\.scope\)/)
            && commentServiceScoped('getInbox'),
        },
        'GET /api/comments/unread-count': {
          reason: `${INBOX_SCOPE_REASON} It counts with the SAME scope the inbox lists with.`,
          stillTrue: (h) => inboxRouteScoped(h, /\bcommentService\.getUnreadSummary\(inbox\.userId, inbox\.scope\)/)
            && commentServiceScoped('getUnreadSummary'),
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
        reason: 'MUST WORK ON A DELETED SHEET — the owner must still be able to stop and release their own job '
          + 'after the sheet is deleted: a SUSPENDED job (generation done, awaiting review) holds the active-job '
          + 'slot until it is cancelled or committed, and commit is refused on a deleted sheet. Owner + '
          + 'cross-sheet gated by resolveBulkJobForActor (asserted); it only flips the job state via '
          + 'cancelBulkJob and never touches the sheet. Cancel is no longer the only brake on generation: since '
          + '#5832 the worker (services/ai-bulk-job-service.ts runGeneratePhase) asks loadSheetLiveness about '
          + 'the job’s own sheet before every provider call and stops the job as errored once the sheet is not '
          + 'live (shape asserted on the tree, bulkWorkerLivenessProblems; behaviour asserted by the tied worker '
          + 'test, bulkWorkerBehaviourProblems).',
        stillTrue: (h) => ownJobGate(h) && /\bcancelBulkJob\(/.test(h.code)
          && bulkWorkerSourceProblems().length === 0
          && readBulkWorkerBehaviour().length === 0,
      },
    },
  },
  'routes/multitable-button.ts': { minHandlers: 1, minInScope: 1, exempt: {} },
  'routes/multitable-record-approvals.ts': { minHandlers: 2, minInScope: 2, exempt: {} },
  'routes/recovery-archive-restore-owner.ts': { minHandlers: 11, minInScope: 11, exempt: {} },
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
  providerLoops: ProviderLoop[]
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
    providerLoops: providerLoopsOf(rel, scanned),
  }
}

/** Provider loops found in `facts` against the PROVIDER_LOOPS ledger. */
function providerLoopProblems(facts: FileFacts[], ledger = PROVIDER_LOOPS): string[] {
  const found = facts.flatMap((f) => f.providerLoops)
  const problems: string[] = []
  for (const loop of found) {
    if (!(loop.key in ledger)) problems.push(`${loop.key} (line ${loop.line}): a loop sends rows to the model and is not named in PROVIDER_LOOPS`)
  }
  for (const [key, entry] of Object.entries(ledger)) {
    const loops = found.filter((l) => l.key === key)
    if (loops.length !== 1) { problems.push(`${key}: expected exactly one provider loop, found ${loops.length}`); continue }
    problems.push(...reasonProblems(key, entry))
    if (!entry.stillTrue(loops[0]!)) problems.push(`${key}: the fact this entry rests on is no longer true`)
  }
  return problems
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

  it('EGRESS-STOP self-test (#5838): a per-row liveness helper may answer `false` instead of a status — only when it is NAMED, and only fail-closed', () => {
    const helperWith = (refusal: string) => [
      'async function sheetStillLive(query, sheetId) {',
      '  let liveness',
      '  try { liveness = await loadSheetLiveness(query, sheetId) } catch (err) { console.error("lookup failed", describeIt(err)); return false }',
      `  ${refusal}`,
      '  return true',
      '}',
    ]
    const FALSE_REFUSAL = "if (liveness !== 'live') { console.warn('not live', { reason: 'sheet_deleted' }); return false }"
    const loop = [
      '    const { access, capabilities, sheetLiveness } = await resolveSheetReadableCapabilities(req, query, req.params.sheetId)',
      "    if (!capabilities.canRead) return res.status(403).json({ code: 'FORBIDDEN' })",
      "    if (sheetLiveness !== 'live') return sendSheetNotLive(res, sheetLiveness)",
      '    for (const row of rows) {',
      '      if (!(await sheetStillLive(query, req.params.sheetId))) { skipped.push(row.id); paused = true; break }',
      '      await runShortcutCore(client, ctx, row.prompt)',
      '    }',
      '    return res.json({ rows, capped: paused })',
    ]
    const analyze = (refusal: string, named = true) => {
      const { h, s } = fixtureHandler([
        ...helperWith(refusal),
        'export function build(router) {',
        "  router.post('/sheets/:sheetId/x', async (req, res) => {",
        ...loop,
        '  })',
        '}',
      ])
      return analyzeHandler(h, s.sourceFile, named
        ? { ...ROUTE_TEST_OPTIONS, egressStops: new Set(['sheetStillLive']) }
        : ROUTE_TEST_OPTIONS)
    }
    // Named: a log line then `return false` is a refusal — the caller's `break` is what stops the sending.
    expect(analyze(FALSE_REFUSAL).violations).toEqual([])
    // NOT named: the loosening is not available by default — every other route refusal still answers.
    expect(analyze(FALSE_REFUSAL, false).violations.join('\n')).toMatch(/refusal branch does not answer 403\/404\/410/)
    // Named but fail-OPEN, or silent, or refusing with a value the caller reads as "keep going".
    expect(analyze("if (liveness !== 'live') { console.warn('not live'); return true }").violations.join('\n'))
      .toMatch(/must end in `return false`/)
    expect(analyze("if (liveness !== 'live') { console.warn('not live') }").violations.join('\n'))
      .toMatch(/never refuses on the liveness it binds|must end in `return false`/)
    // Named but the refusal itself goes back to the database (a refusal only answers).
    expect(analyze("if (liveness !== 'live') { await query('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]); return false }").violations.join('\n'))
      .toMatch(/refusal branch awaits or calls a data source/)
    // The naming is per helper, not per file: a second helper in the same file still must answer.
    const { h, s } = fixtureHandler([
      ...helperWith(FALSE_REFUSAL),
      'async function otherGate(req, res, sheetId) {',
      '  const { capabilities, sheetLiveness } = await resolveSheetCapabilities(req, q, sheetId)',
      "  if (!capabilities.canRead) { res.status(403).json({ code: 'FORBIDDEN' }); return null }",
      "  if (sheetLiveness !== 'live') { console.warn('not live'); return null }",
      '  return capabilities',
      '}',
      'export function build(router) {',
      "  router.post('/sheets/:sheetId/x', async (req, res) => {",
      '    const auth = await otherGate(req, res, req.params.sheetId)',
      '    if (!auth) return',
      ...loop,
      '  })',
      '}',
    ])
    expect(analyzeHandler(h, s.sourceFile, { ...ROUTE_TEST_OPTIONS, egressStops: new Set(['sheetStillLive']) }).violations.join('\n'))
      .toMatch(/^otherGate: .*refusal branch does not answer 403\/404\/410/m)
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
      ...Object.entries(PROVIDER_LOOPS).map(([k, e]): [string, { reason: string }] => [`PROVIDER_LOOPS ${k}`, e]),
      ...Object.entries(COVERED).flatMap(([file, c]) => [
        ...Object.entries(c.exempt).map(([k, e]): [string, { reason: string }] => [`${file} ${k}`, e]),
        ...Object.entries(c.unaddressed?.named ?? {}).map(([k, e]): [string, { reason: string }] => [`${file} ${k}`, e]),
      ]),
      ...Object.entries(OPAQUE_REGISTRATIONS).flatMap(([file, entries]) => Object.entries(entries).map(([k, e]): [string, { reason: string }] => [`${file} ${k}`, e])),
    ]
    expect(reasons.flatMap(([key, entry]) => reasonProblems(key, entry))).toEqual([])
    // 12 after #5831 part A closed the six comment-id GAPs (GUARDED now, see COMMENT-ID ROUTES); 10 after
    // part B closed the inbox and unread-count GAPs (FILTERED now, see INBOX SCOPE); 9 after #5844 closed the
    // requireRecordReadable order GAP on main; 8 after this branch closed the #5838 inline bulk-preview GAP
    // (FIXED now, see PROVIDER_LOOPS). A branch that closes another GAP lowers this floor by the number it
    // removes.
    expect(reasons.filter(([, e]) => /\bGAP — tracked in #\d+/.test(e.reason)).length).toBeGreaterThanOrEqual(8)
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

  it('COMMENT-ID ROUTES (#5831): gated on the comment’s OWN sheet, through one pre-gate lookup that reads only the comment’s address', () => {
    const file = 'routes/comments.ts'
    const s = scan(file)
    // Population: exactly these routes are addressed by comment id, and each one is GUARDED by the id gate.
    const idRoutes = s.handlers.filter((h) => h.paths.some((p) => p.includes(':commentId')))
    expect(idRoutes.map((h) => h.key).sort()).toEqual([...COMMENT_ID_ROUTES].sort())
    for (const h of idRoutes) {
      expect(addressesASheet(h), h.key).toBe(true)
      expect(guardOf(file, h), h.key).toBe('gate-helper resolveCommentIdContext')
      expect(analysisOf(file, h).violations, h.key).toEqual([])
      // The gate is asked about the very id the service then acts on.
      expect(h.code, h.key).toMatch(/const commentId = req\.params\.commentId;/)
      expect(h.code, h.key).toMatch(/await resolveCommentIdContext\(req, res, commentService, commentId\)/)
    }

    // The gate: the comment's stored sheet, never a sheet id from the request; one refusal body for
    // "no such comment", "may not read its sheet" and "may not read its row".
    const gate = functionCode(file, 'resolveCommentIdContext')
    expect(gate).toMatch(/^async function resolveCommentIdContext\([^)]*\)[^{]*\{\s*const address = await commentService\.getCommentAddress\(commentId\);/)
    expect(gate).toMatch(/await resolveCommentReadContext\(req, res, address\.spreadsheetId, \[address\.rowId\]\)/)
    expect(gate).toMatch(/if \(isRowDenied\(context, address\.rowId\)\)/)
    expect(gate).not.toMatch(/\breq\.(query|body|params)\b|\bsheetId\b/)
    const readGate = functionCode(file, 'resolveCommentReadContext')

    // Row deny bound (#5831 fix round): only the id gate bounds the deny lookup, to the comment's own row;
    // every sheet-addressed caller still loads the complete set its filters rely on; and an id route never
    // treats its (bounded) deny set as a sheet-wide one.
    expect(readGate.match(/\bloadDeniedRecordIds\(/g)).toHaveLength(1)
    expect(readGate).toMatch(/await loadDeniedRecordIds\(query, spreadsheetId, access\.userId, denyScopeRowIds\)/)
    const readGateCalls = [...codeOf(s.sourceFile, s.sourceFile).matchAll(/await resolveCommentReadContext\(([^()]*)\)/g)].map((m) => m[1]!)
    expect(readGateCalls.length).toBeGreaterThanOrEqual(10)
    for (const args of readGateCalls) expect(args, args).toMatch(/^req, res, [^,]+$|^req, res, address\.spreadsheetId, \[address\.rowId\]$/)
    expect(readGateCalls.filter((args) => args.split(',').length !== 3)).toEqual(['req, res, address.spreadsheetId, [address.rowId]'])
    for (const h of idRoutes) expect(h.code, h.key).not.toMatch(/\b(deniedRows|filterDeniedRows|deniedRowIds)\b/)
    const refusals = [...`${gate}\n${readGate}`.matchAll(/res\.status\(403\)\.json\(([^\n]*)\);/g)].map((m) => m[1])
    expect(refusals).toHaveLength(3)
    expect(new Set(refusals).size).toBe(1)

    // The pre-gate lookup (PRE_GATE_CALLS.getCommentAddress) is called from that gate only, and reads the
    // three addressing columns of one meta_comments row by id — nothing else.
    const callers: string[] = []
    for (const rel of listSourceFiles()) {
      const source = readSource(rel)
      if (!source.includes('getCommentAddress')) continue
      const sf = scanRouteSource(rel, source).sourceFile
      for (const call of callSitesNamed(sf, new Set(['getCommentAddress']))) {
        const owner = findFunctionsNamed(sf, 'resolveCommentIdContext').find((fn) => {
          const from = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1
          const to = sf.getLineAndCharacterOfPosition(fn.getEnd()).line + 1
          return call.line >= from && call.line <= to
        })
        callers.push(`${rel} ${owner ? 'resolveCommentIdContext' : `line ${call.line}`}`)
      }
    }
    expect(callers).toEqual(['routes/comments.ts resolveCommentIdContext'])
    const lookup = functionCode('services/CommentService.ts', 'getCommentAddress')
    expect(lookup).toMatch(/\.selectFrom\('meta_comments'\)\s*\.select\(\['spreadsheet_id', 'row_id'\]\)\s*\.where\('id', '=', commentId\)\s*\.executeTakeFirst\(\)/)
    expect(lookup.match(/\bselectFrom\(/g)).toHaveLength(1)
    expect(lookup).not.toMatch(/\b(selectAll|join|leftJoin|innerJoin|sql|query|insertInto|updateTable|deleteFrom|content|author_id)\b/)

    // Resolve (#5831 coordinator decision; stricter rule deferred to #5841): the sheet gate — read access to
    // the comment's live sheet and row — plus comments:write, and nothing in between: the service runs on
    // the very next statement after the gate's null check.
    const resolve = idRoutes.find((h) => h.key === 'POST /api/comments/:commentId/resolve')!
    expect(resolve.middleware).toMatch(/^rbacGuard\('comments', 'write'\)$/)
    expect(resolve.code).toMatch(/const context = await resolveCommentIdContext\(req, res, commentService, commentId\);\s*if \(!context\)\s*return;\s*await commentService\.resolveComment\(commentId\);/)
    expect(resolve.code.match(/\bcommentService\.\w+\(/g)).toEqual(['commentService.resolveComment('])
  })

  it('INBOX SCOPE (#5831 part B): the cross-sheet aggregates list and count only readable, live, non-denied comments, filtered in SQL', () => {
    const file = 'routes/comments.ts'
    const s = scan(file)
    const inboxRoutes = s.handlers.filter((h) => /resolveCommentInboxScope/.test(h.code))
    expect(inboxRoutes.map((h) => h.key).sort()).toEqual(['GET /api/comments/inbox', 'GET /api/comments/unread-count'])
    for (const h of inboxRoutes) {
      // Unaddressed by construction (a sheet-addressed route would owe the single-sheet 403/404 instead).
      expect(addressesASheet(h), h.key).toBe(false)
      expect(h.middleware, h.key).toMatch(/^rbacGuard\('comments', 'read'\)$/)
    }

    // The scope: authenticated identity only; liveness for everyone; the read rule for the set; row deny
    // for non-admins, bounded to the candidate rows (a 3-argument loadDeniedRecordIds would scan the sheet),
    // carried as an ALLOW list per row-deny sheet (a deny list would admit a row nobody checked).
    const scope = functionCode(file, 'resolveCommentInboxScope')
    expect(scope).toMatch(/const access = await resolveRequestAccess\(req\);\s*const userId = access\.userId;\s*if \(userId\.trim\(\)\.length === 0\)\s*return \{ userId: '', scope: \{ sheetIds: \[\], rowDenySheets: \[\] \} \};/)
    expect(scope).not.toMatch(/\bgetUserId\(|x-user-id|req\.(headers|query|body|params)/)
    expect(scope).toMatch(/const candidateSheetIds = await commentService\.listInboxCandidateSheetIds\(userId\);/)
    expect(scope).toMatch(/const liveness = await loadSheetLivenessBatch\(query, candidateSheetIds\);\s*const liveSheetIds = candidateSheetIds\.filter\(\(sheetId\) => liveness\.get\(sheetId\) === 'live'\);/)
    expect(scope).toMatch(/const readableSheetIds = await resolveInboxReadableSheetIds\(query, access, liveSheetIds\);/)
    expect(scope).toMatch(/if \(!access\.isAdminRole\) \{/)
    // The flag: ONE batched lookup over the readable set (never a per-sheet loadRowLevelReadDenyEnabled loop),
    // by the single-sheet helper's own rule (approval-projection base ⇒ on, else the column).
    expect(scope).toMatch(/const rowDenySheetIds = await loadInboxRowDenySheetIds\(query, readableSheetIds\);/)
    expect(scope).not.toMatch(/\bloadRowLevelReadDenyEnabled\b/)
    const flagBatch = functionCode(file, 'loadInboxRowDenySheetIds')
    expect(flagBatch).toMatch(/'SELECT id, row_level_read_permissions_enabled AS enabled, base_id FROM meta_sheets WHERE id = ANY\(\$1::text\[\]\)'/)
    expect(flagBatch).toMatch(/isApprovalProjectionBaseId\([^)]*\) \|\| row\.enabled === true/)
    expect(flagBatch).toMatch(/throw err;/)
    expect(scope).toMatch(/await commentService\.listInboxCandidateRowIds\(userId, rowDenySheetIds\)/)
    expect(scope.match(/\bloadDeniedRecordIds\(/g)).toHaveLength(1)
    expect(scope).toMatch(/await loadDeniedRecordIds\(query, sheetId, userId, rowIds\)/)
    // Every row-deny sheet is pushed (even with no candidate row), with its checked-and-allowed rows only.
    expect(scope).toMatch(/for \(const sheetId of rowDenySheetIds\) \{(?:(?!continue)[\s\S])*rowDenySheets\.push\(\{ spreadsheetId: sheetId, allowedRowIds: rowIds\.filter\(\(rowId\) => !denied\.has\(rowId\)\) \}\);\s*\}/)
    expect(scope).toMatch(/return \{ userId, scope: \{ sheetIds: readableSheetIds, rowDenySheets \} \};\s*\}$/)
    const readable = functionCode(file, 'resolveInboxReadableSheetIds')
    expect(readable).toMatch(/await filterReadableSheetRowsForAccess\(query, liveSheetIds\.map\(\(id\) => \(\{ id \}\)\), access\)/)
    // The admin half of the gate's e-learning restriction (filterReadableSheetRowsForAccess skips it for admins).
    expect(readable).toMatch(/if \(!access\.isAdminRole \|\| readable\.length === 0\)\s*return readable;/)
    expect(readable).toMatch(/canAccessElearningProjectionSheet\(access, id, /)

    // The service: the scope is applied by every aggregate, before COUNT and LIMIT.
    for (const method of Object.keys(COMMENT_SCOPED_AGGREGATES)) {
      expect(commentServiceScoped(method), `CommentService.${method} must admit and apply the inbox scope`).toBe(true)
    }
    const predicate = functionCode('services/CommentService.ts', 'inboxScopePredicate')
    expect(predicate).toMatch(/c\.spreadsheet_id = any\(\$\{scope\.sheetIds\}::text\[\]\)/)
    // Allow list on row-deny sheets: (not a row-deny sheet) OR (an allowed pair) — never `not exists (denied)`.
    expect(predicate).toMatch(/and \(c\.spreadsheet_id <> all\(\$\{scope\.rowDenySheetIds\}::text\[\]\) or exists \(/)
    expect(predicate).toMatch(/where allowed\.spreadsheet_id = c\.spreadsheet_id\s+and allowed\.row_id = btrim\(c\.row_id, \$\{JS_TRIM_WHITESPACE\}\)/)
    expect(predicate).not.toMatch(/not exists|denied/)
    const admit = functionCode('services/CommentService.ts', 'admitInboxScope')
    expect(admit).toMatch(/if \(sheetIds\.length === 0\)\s*return null;/)
    // A row-deny sheet is kept even when its allow list is empty (a malformed allow list can only narrow).
    expect(admit).toMatch(/if \(sheetId\.length === 0\)\s*continue;\s*rowDenySheetIds\.add\(sheetId\);/)
    // Kysely ANDs `.where()` calls without parentheses, so an `or` predicate must carry its own — or its
    // branches escape the filters around it (the scope included).
    expect(functionCode('services/CommentService.ts', 'inboxCandidatePredicate'))
      .toMatch(/return sql<boolean> `\(\(\$\{inboxMentionPredicate\(userId\)\}\) or r\.comment_id is null\)`;/)
    expect(predicate).toMatch(/return sql<boolean> `\(c\.spreadsheet_id = any\(\$\{scope\.sheetIds\}::text\[\]\) \$\{rowDenyPredicate\}\)`;/)

    // CLOSED WORLD over CommentService: every method that reads meta_comments neither by id nor for ONE
    // sheet is one of the scoped aggregates or an id-only candidate lister.
    const service = scan('services/CommentService.ts')
    const crossSheet: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
        const code = codeOf(node, service.sourceFile)
        const readsComments = /\bselectFrom\('meta_comments\b|\bfrom meta_comments\b/.test(code)
        const bySheetOrId = /\.where\('(?:c\.)?(?:spreadsheet_id|id|parent_id)', '=',|\bc\.spreadsheet_id = \$\{(?!scope\b)/.test(code)
        if (readsComments && !bySheetOrId) crossSheet.push(node.name.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(service.sourceFile)
    expect(crossSheet.sort()).toEqual([...Object.keys(COMMENT_SCOPED_AGGREGATES), ...COMMENT_INBOX_CANDIDATE_LISTERS].sort())
    for (const lister of COMMENT_INBOX_CANDIDATE_LISTERS) {
      const code = functionCode('services/CommentService.ts', lister)
      // Ids only — no content, author, mentions or names leave these.
      expect(code, lister).toMatch(/\.select\((?:'c\.spreadsheet_id'|\['c\.spreadsheet_id', 'c\.row_id'\])\)/)
      expect(code.match(/\.select(?:All)?\(/g), lister).toHaveLength(1)
      expect(code.match(/\.selectFrom\(/g), lister).toHaveLength(1)
    }
    // …and only the scope helper calls them (nothing else may list candidates unfiltered).
    const callers: string[] = []
    for (const rel of listSourceFiles()) {
      const source = readSource(rel)
      if (!COMMENT_INBOX_CANDIDATE_LISTERS.some((name) => source.includes(name))) continue
      const sf = scanRouteSource(rel, source).sourceFile
      const owner = findFunctionsNamed(sf, 'resolveCommentInboxScope')[0]
      for (const call of callSitesNamed(sf, new Set(COMMENT_INBOX_CANDIDATE_LISTERS))) {
        const inside = owner !== undefined
          && call.line >= sf.getLineAndCharacterOfPosition(owner.getStart(sf)).line + 1
          && call.line <= sf.getLineAndCharacterOfPosition(owner.getEnd()).line + 1
        callers.push(`${rel} ${call.name} ${inside ? 'resolveCommentInboxScope' : `line ${call.line}`}`)
      }
    }
    expect(callers.sort()).toEqual([
      'routes/comments.ts listInboxCandidateRowIds resolveCommentInboxScope',
      'routes/comments.ts listInboxCandidateSheetIds resolveCommentInboxScope',
    ])
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

  it('#5832: the bulk generate worker stops on a non-live sheet before every provider call (the cancel exemption rests on it)', () => {
    const source = normalizeEol(readSource(BULK_WORKER_FILE))
    expect(bulkWorkerLivenessProblems(source)).toEqual([])

    // Sharpness: each way the fix could quietly rot is caught (mutated in memory, never on disk).
    const stop = /\n( *)if \(!\(await jobSheetIsLive\(query, jobId, plan\.sheetId\)\)\) \{\n[\s\S]*?\n\1\}\n/.exec(source)
    expect(stop, 'the stop block must be locatable for the self-test').not.toBeNull()
    const withoutStop = source.replace(stop![0], '\n')
    const send = 'const outcome = await runShortcutCore(this.aiClient, ctx, row.prompt)\n'
    expect(source).toContain(send)
    expect(source).toContain('for (const row of plan.rows) {\n')
    const redFor = (mutated: string) => bulkWorkerLivenessProblems(mutated).join('\n')
    // no check at all
    expect(redFor(withoutStop)).toMatch(/must stop on/)
    // checked once, before the loop
    expect(redFor(withoutStop.replace('for (const row of plan.rows) {\n', `${stop![0].slice(1)}for (const row of plan.rows) {\n`))).toMatch(/must stop on/)
    // checked after the provider call
    expect(redFor(withoutStop.replace(send, `${send}${stop![0].slice(1)}`))).toMatch(/BEFORE the provider call/)
    // checked ahead of the cancel check
    const cancelCheck = "      if ((await readJobStatus(query, jobId)) !== 'running') {\n"
    expect(source).toContain(cancelCheck)
    expect(redFor(withoutStop.replace(cancelCheck, `${stop![0].slice(1)}${cancelCheck}`))).toMatch(/follow the per-row cancel/)
    // asks about another id
    expect(redFor(source.replace('jobSheetIsLive(query, jobId, plan.sheetId)', 'jobSheetIsLive(query, jobId, plan.fieldId)'))).toMatch(/must stop on/)
    // stops without leaving the active state
    expect(redFor(source.replace(stop![0], stop![0].replace('markErroredIfRunning(query, jobId)', 'suspendIfRunning(query, jobId)')))).toMatch(/mark the job errored/)
    // fail-open on a lookup error
    expect(redFor(source.replace(/(\} catch \(err\) \{[\s\S]*?)return false\n/, '$1return true\n'))).toMatch(/catch answers false/)
    // only `deleted` refused (`absent` would keep sending)
    expect(redFor(source.replace("if (liveness !== 'live') {", "if (liveness === 'deleted') {"))).toMatch(/must follow the lookup/)
    // a second way to answer true
    expect(redFor(source.replace("liveness = await loadSheetLiveness(query, sheetId)\n", "liveness = await loadSheetLiveness(query, sheetId)\n    if (liveness === 'absent') return true\n"))).toMatch(/must run in a try|only non-false answer/)
    // a different liveness helper spelling
    expect(redFor(source.replace("from '../multitable/sheet-liveness'", "from '../multitable/sheet-liveness-copy'"))).toMatch(/must be imported from multitable\/sheet-liveness/)

    // Rebinding what the check reads, or asking about the wrong id, while the shape above still holds
    // (#5832 refuter, state lens: M1–M3 once passed this check). `swap` refuses a needle that is absent.
    const swap = (from: string, to: string, src = source) => {
      expect(src.split(from).length - 1, `self-test needle must occur exactly once: ${JSON.stringify(from)}`).toBe(1)
      return src.replace(from, () => to)
    }
    const decl = '  let liveness: SheetLiveness\n'
    const refusal = "  if (liveness !== 'live') {\n"
    const signature = 'async function jobSheetIsLive(query: AiUsageQueryFn, jobId: string, sheetId: string)'
    const catchReturn = /(\} catch \(err\) \{\n[\s\S]*?\n)(    return false\n  \}\n  if \(liveness !== 'live'\))/
    expect(source).toMatch(catchReturn)
    // M1: a statement between the lookup and the refusal overrides the verdict
    expect(redFor(swap(refusal, `  liveness = 'live'\n${refusal}`))).toMatch(/nothing in between/)
    expect(redFor(swap(refusal, `  liveness = 'live'\n${refusal}`))).toMatch(/`liveness` may only be written by the lookup/)
    // M2: the lookup is pointed at an always-live stub
    expect(redFor(swap(decl, `${decl}  query = async () => ({ rows: [{ deleted_at: null }] })\n`))).toMatch(/`query` may only be written by the lookup/)
    // M3: parameters swapped — the loop's plan.sheetId lands in `jobId`, the lookup asks about the job id
    expect(redFor(swap(signature, 'async function jobSheetIsLive(query: AiUsageQueryFn, sheetId: string, jobId: string)'))).toMatch(/parameters must be exactly \(query, jobId, sheetId\)/)
    // M3b: a default or optional parameter is not a plain parameter
    expect(redFor(swap(signature, "async function jobSheetIsLive(query: AiUsageQueryFn, jobId: string, sheetId: string = 'sheet')"))).toMatch(/parameters must be exactly/)
    // M4: `deleted` downgraded to live before the refusal
    expect(redFor(swap(refusal, `  if (liveness === 'deleted') liveness = 'live'\n${refusal}`))).toMatch(/nothing in between/)
    // M5: a write hidden in a branch that still answers false (shape intact; the write rule alone reds)
    const inCatch = source.replace(catchReturn, (_m, head: string, tail: string) => `${head}    sheetId ??= jobId\n${tail}`)
    expect(inCatch).not.toBe(source)
    expect(redFor(inCatch)).toBe('jobSheetIsLive: `sheetId` may only be written by the lookup (`sheetId ??= jobId`)')
    // M6: a shadowing re-declaration in the gate (shape intact; the declaration rule alone reds) or in the loop
    const shadowed = source.replace(catchReturn, (_m, head: string, tail: string) => `${head}    const query = 1\n${tail}`)
    expect(shadowed).not.toBe(source)
    expect(redFor(shadowed)).toBe('jobSheetIsLive: `query` must not be re-declared (`query = 1`)')
    const gateComment = '      // #5832: re-check the job'
    expect(redFor(swap(gateComment, `      const query = async () => ({ rows: [{ deleted_at: null }] })\n${gateComment}`))).toMatch(/nothing may re-declare query/)
    // M7: the plan's sheet id is rewritten before the check
    expect(redFor(swap(gateComment, `      plan.sheetId = row.recordId\n${gateComment}`))).toMatch(/`plan` must never be written/)
    expect(redFor(swap(gateComment, `      ;({ sheetId: plan['sheetId'] } = row as any)\n${gateComment}`))).toMatch(/`plan` must never be written/)
    // M8: the phase's own query rebound (destructuring counts too)
    const planLine = '    const plan = this.plans.get(jobId)\n'
    expect(redFor(swap(planLine, `    ;[query] = [async () => ({ rows: [] })] as any\n${planLine}`))).toMatch(/`query` must never be written/)
    expect(redFor(swap(planLine, '    const plan = this.plans.get(`${jobId}`)\n'))).toMatch(/`plan` must be declared once/)
    // M9: a second binding of the helper or of the gate
    expect(redFor(`${source}\nfunction loadSheetLiveness() { return 'live' }\n`)).toMatch(/`loadSheetLiveness` must be bound exactly once/)
    const asArrow = source.replace(/async function jobSheetIsLive\(([^)]*)\): Promise<boolean> \{/, 'const jobSheetIsLive = async ($1): Promise<boolean> => {')
    expect(asArrow).not.toBe(source)
    expect(redFor(asArrow)).toMatch(/expected 1 top-level function declaration/)
    // M10: the gate is reassigned elsewhere in the module
    expect(redFor(`${source}\nexport function hijack() { (jobSheetIsLive as any) = async () => true }\n`)).toMatch(/`jobSheetIsLive` must never be written/)
  })

  it('#5832 BEHAVIOUR TIE: the worker behaviour test exists, runs the real worker, and keeps every case (the cancel exemption rests on it)', () => {
    expect(readBulkWorkerBehaviour()).toEqual([])
    const path = join(__dirname, BULK_WORKER_BEHAVIOUR_TEST)
    const text = normalizeEol(readFileSync(path, 'utf8'))
    const config = normalizeEol(readFileSync(join(__dirname, '../../vitest.config.ts'), 'utf8'))
    const red = (src: string | null, cfg = config) => bulkWorkerBehaviourProblems(src, cfg).join('\n')
    const swap = (from: string, to: string) => {
      expect(text.split(from).length - 1, `self-test needle must occur exactly once: ${JSON.stringify(from)}`).toBe(1)
      return text.replace(from, () => to)
    }
    const deletedCase = "  it('sheet DELETED while row 1 is generating:"
    expect(red(null)).toMatch(/is missing/)
    expect(red(swap(deletedCase, "  it.skip('sheet DELETED while row 1 is generating:"))).toMatch(/it\.skip\(…\) is not allowed/)
    expect(red(swap(deletedCase, "  it.skipIf(true)('sheet DELETED while row 1 is generating:"))).toMatch(/it\.skipIf\(…\) is not allowed/)
    expect(red(swap(deletedCase, "  xit('sheet DELETED while row 1 is generating:"))).toMatch(/xit\(…\) skips or focuses/)
    expect(red(swap("  it('LIVE sheet:", "  it.only('LIVE sheet:"))).toMatch(/it\.only\(…\) is not allowed/)
    expect(red(swap("describe('AI bulk job worker", "describe.skip('AI bulk job worker"))).toMatch(/describe\.skip\(…\) is not allowed/)
    expect(red(swap("  it('sheet row GONE (absent) mid-run:", "  it('sheet row GONE mid-run:"))).toMatch(/case "sheet row GONE \(absent\) mid-run:…": expected exactly one it\(…\), found 0/)
    expect(red(swap("  it('liveness LOOKUP FAILS before row 2:", "  it('LIVE sheet: twice"))).toMatch(/case "LIVE sheet:…": expected exactly one it\(…\), found 2/)
    expect(red(swap("import { afterEach,", "vi.mock('../../src/multitable/sheet-liveness')\nimport { afterEach,"))).toMatch(/vi\.mock\(…\)/)
    expect(red(swap("} from '../../src/services/ai-bulk-job-service'", "} from './fake-ai-bulk-job-service'"))).toMatch(/BulkFillJobService must be imported/)
    expect(red(text, config.replace("exclude: [\n", "exclude: [\n      'tests/unit/ai-bulk-job-sheet-liveness.test.ts',\n"))).toMatch(/vitest\.config\.ts mentions/)
    expect(config).toContain('exclude: [\n')
  })

  it('#5832: the cancel exemption and the worker ledger entry each fall when EITHER proof falls (shape or behaviour)', () => {
    const file = 'routes/multitable-ai.ts'
    const key = 'POST /sheets/:sheetId/ai/shortcut/bulk-job/:jobId/cancel'
    const cancel = scan(file).handlers.find((h) => h.key === key)
    expect(cancel, `${file} ${key} must exist`).toBeDefined()
    const exemptionD = COVERED[file]!.exempt[key]!
    const workerKey = 'services/ai-bulk-job-service.ts runGeneratePhase'
    const workerLoop = allFacts().flatMap((f) => f.providerLoops).find((l) => l.key === workerKey)
    expect(workerLoop, `${workerKey} must be discovered`).toBeDefined()
    const verdicts = () => [exemptionD.stillTrue!(cancel!), PROVIDER_LOOPS[workerKey]!.stillTrue(workerLoop!)]
    expect(verdicts()).toEqual([true, true])

    const worker = normalizeEol(readSource(BULK_WORKER_FILE))
    const behaviour = normalizeEol(readFileSync(join(__dirname, BULK_WORKER_BEHAVIOUR_TEST), 'utf8'))
    const rebound = worker.replace('  let liveness: SheetLiveness\n', "  let liveness: SheetLiveness\n  liveness = 'live'\n")
    const skipped = behaviour.replace("  it('sheet row GONE (absent) mid-run:", "  it.skip('sheet row GONE (absent) mid-run:")
    expect(rebound).not.toBe(worker)
    expect(skipped).not.toBe(behaviour)
    try {
      bulkWorkerInputs.worker = rebound
      expect(verdicts(), 'worker shape broken').toEqual([false, false])
      delete bulkWorkerInputs.worker
      bulkWorkerInputs.behaviour = skipped
      expect(verdicts(), 'behaviour case skipped').toEqual([false, false])
      bulkWorkerInputs.behaviour = null
      expect(verdicts(), 'behaviour test missing').toEqual([false, false])
    } finally {
      delete bulkWorkerInputs.worker
      delete bulkWorkerInputs.behaviour
    }
    expect(verdicts()).toEqual([true, true])
  })

  it('#5838: the inline bulk-preview loop stops on a non-live sheet before every provider call', () => {
    const source = normalizeEol(readSource(INLINE_BULK_FILE))
    expect(inlineBulkLivenessProblems(source)).toEqual([])

    // Sharpness: each way the fix could quietly rot is caught (mutated in memory, never on disk).
    const stop = /\n( *)if \(!\(await bulkPreviewSheetIsLive\(query, sheetId\)\)\) \{\n[\s\S]*?\n\1\}\n/.exec(source)
    expect(stop, 'the stop block must be locatable for the self-test').not.toBeNull()
    const withoutStop = source.replace(stop![0], '\n')
    const send = '        const outcome = await runShortcutCore(\n'
    expect(source.split(send).length - 1).toBe(1)
    expect(source).toContain('      for (const cand of generationCandidates) {\n')
    const redFor = (mutated: string) => inlineBulkLivenessProblems(mutated).join('\n')
    const swap = (from: string, to: string, src = source) => {
      expect(src.split(from).length - 1, `self-test needle must occur exactly once: ${JSON.stringify(from)}`).toBe(1)
      return src.replace(from, () => to)
    }
    // no check at all (the #5838 bug itself)
    expect(redFor(withoutStop)).toMatch(/must stop on/)
    // checked once, before the loop
    const loopHead = '      for (const cand of generationCandidates) {\n        const recordId = cand.recordId\n'
    expect(redFor(swap(loopHead, `${stop![0].slice(1)}${loopHead}`, withoutStop))).toMatch(/must stop on/)
    // checked AFTER the provider call (the row that pays for the delete is the one already sent)
    const afterSend = "        if (outcome.kind === 'charged') {\n"
    expect(redFor(swap(afterSend, `${stop![0].slice(1)}${afterSend}`, withoutStop))).toMatch(/BEFORE the provider call/)
    // the stop stops being a stop: the remaining rows are still sent / the row is silently dropped /
    // the caller is told the run was complete
    const stopBody = "          skipped.push({ recordId, reason: 'sheet_not_live' })\n          paused = true\n          break\n"
    expect(redFor(swap(stopBody, stopBody.replace('          break\n', '          continue\n')))).toMatch(/must end in `break`/)
    expect(redFor(swap(stopBody, stopBody.replace("          skipped.push({ recordId, reason: 'sheet_not_live' })\n", '')))).toMatch(/must record the row it stopped on/)
    expect(redFor(swap(stopBody, stopBody.replace('          paused = true\n', '')))).toMatch(/must mark the run partial/)
    // asks about another id
    expect(redFor(swap('bulkPreviewSheetIsLive(query, sheetId)', 'bulkPreviewSheetIsLive(query, fieldId)'))).toMatch(/must stop on/)
    // fail-open on a lookup error
    expect(redFor(source.replace(/(\} catch \(err\) \{[\s\S]*?)return false\n/, '$1return true\n'))).toMatch(/catch answers false/)
    // only `deleted` refused (`absent` would keep sending)
    expect(redFor(swap("  if (liveness !== 'live') {", "  if (liveness === 'deleted') {"))).toMatch(/must follow the lookup/)
    // a second way to answer true
    expect(redFor(swap('    liveness = await loadSheetLiveness(query, sheetId)\n', "    liveness = await loadSheetLiveness(query, sheetId)\n    if (liveness === 'absent') return true\n")))
      .toMatch(/must run in a try|only non-false answer/)
    // a different liveness helper spelling
    expect(redFor(swap("import { describeLivenessLookupError, loadSheetLiveness, type SheetLiveness } from '../multitable/sheet-liveness'", "import { describeLivenessLookupError, loadSheetLiveness, type SheetLiveness } from '../multitable/sheet-liveness-copy'")))
      .toMatch(/must be imported from multitable\/sheet-liveness/)
    // a statement between the lookup and the refusal overrides the verdict
    const refusal = "  if (liveness !== 'live') {\n"
    expect(redFor(swap(refusal, `  liveness = 'live'\n${refusal}`))).toMatch(/nothing in between/)
    expect(redFor(swap(refusal, `  liveness = 'live'\n${refusal}`))).toMatch(/`liveness` may only be written by the lookup/)
    // the lookup is pointed at an always-live stub, in the gate and in the handler
    expect(redFor(swap('  let liveness: SheetLiveness\n', '  let liveness: SheetLiveness\n  query = async () => ({ rows: [{ deleted_at: null }] })\n')))
      .toMatch(/`query` may only be written by the lookup/)
    expect(redFor(swap(loopHead, `      query = (async () => ({ rows: [{ deleted_at: null }] })) as any\n${loopHead}`)))
      .toMatch(/the bulk-preview handler: `query` must never be written/)
    // the sheet the loop asks about is rewritten before the check
    expect(redFor(swap(loopHead, `      sheetId = cand.recordId\n${loopHead}`))).toMatch(/the bulk-preview handler: `sheetId` must never be written/)
    // a shadowing re-declaration in the handler
    expect(redFor(swap(loopHead, `      const sheetId = 'other'\n${loopHead}`))).toMatch(/`sheetId` must be declared exactly once/)
    // parameters swapped / not plain
    const signature = 'async function bulkPreviewSheetIsLive(query: QueryFn, sheetId: string)'
    expect(redFor(swap(signature, 'async function bulkPreviewSheetIsLive(sheetId: string, query: QueryFn)'))).toMatch(/parameters must be exactly \(query, sheetId\)/)
    expect(redFor(swap(signature, "async function bulkPreviewSheetIsLive(query: QueryFn, sheetId: string = 'sheet')"))).toMatch(/parameters must be exactly/)
    // a second binding of the helper, or the helper reassigned elsewhere in the module
    expect(redFor(`${source}\nfunction loadSheetLiveness() { return 'live' }\n`)).toMatch(/`loadSheetLiveness` must be bound exactly once/)
    expect(redFor(`${source}\nexport function hijack() { (bulkPreviewSheetIsLive as any) = async () => true }\n`)).toMatch(/`bulkPreviewSheetIsLive` must never be written/)
    const asArrow = source.replace(/async function bulkPreviewSheetIsLive\(([^)]*)\): Promise<boolean> \{/, 'const bulkPreviewSheetIsLive = async ($1): Promise<boolean> => {')
    expect(asArrow).not.toBe(source)
    expect(redFor(asArrow)).toMatch(/expected 1 top-level function declaration/)
    // the send leaves the loop entirely → there is no loop to guard, and the ledger says so
    expect(redFor(swap(send, '        const outcome = await runShortcutCoreRenamed(\n'))).toMatch(/expected exactly one `for \(… of generationCandidates\)/)
  })

  it('#5838 BEHAVIOUR TIE: the inline behaviour test exists, drives the real route over the pinned server, and keeps every case', () => {
    expect(readInlineBulkBehaviour()).toEqual([])
    const path = join(__dirname, INLINE_BULK_BEHAVIOUR_TEST)
    const text = normalizeEol(readFileSync(path, 'utf8'))
    const config = normalizeEol(readFileSync(join(__dirname, '../../vitest.config.ts'), 'utf8'))
    const red = (src: string | null, cfg = config) => inlineBulkBehaviourProblems(src, cfg).join('\n')
    const swap = (from: string, to: string) => {
      expect(text.split(from).length - 1, `self-test needle must occur exactly once: ${JSON.stringify(from)}`).toBe(1)
      return text.replace(from, () => to)
    }
    const deletedCase = "  it('sheet DELETED while row 1 is generating:"
    expect(red(null)).toMatch(/is missing/)
    expect(red(swap(deletedCase, "  it.skip('sheet DELETED while row 1 is generating:"))).toMatch(/it\.skip\(…\) is not allowed/)
    expect(red(swap(deletedCase, "  xit('sheet DELETED while row 1 is generating:"))).toMatch(/xit\(…\) skips or focuses/)
    expect(red(swap("  it('LIVE sheet:", "  it.only('LIVE sheet:"))).toMatch(/it\.only\(…\) is not allowed/)
    expect(red(swap("describe('AI inline bulk-preview", "describe.skip('AI inline bulk-preview"))).toMatch(/describe\.skip\(…\) is not allowed/)
    expect(red(swap("  it('sheet row GONE (absent) mid-run:", "  it('sheet row GONE mid-run:"))).toMatch(/case "sheet row GONE \(absent\) mid-run:…": expected exactly one it\(…\), found 0/)
    expect(red(swap("  it('liveness LOOKUP FAILS before row 2:", "  it('LIVE sheet: twice"))).toMatch(/case "LIVE sheet:…": expected exactly one it\(…\), found 2/)
    expect(red(swap("import { afterEach,", "vi.mock('../../src/multitable/sheet-liveness')\nimport { afterEach,"))).toMatch(/vi\.mock\(…\)/)
    expect(red(swap("await import('../../src/routes/multitable-ai')", "await import('./fake-multitable-ai')"))).toMatch(/the real router must be built here/)
    expect(red(swap('request(pinned.url())', 'request(app)'))).toMatch(/pinned server/)
    expect(red(text, config.replace("exclude: [\n", `exclude: [\n      'tests/unit/${INLINE_BULK_BEHAVIOUR_TEST}',\n`))).toMatch(/vitest\.config\.ts mentions/)
  })

  it('#5838: the inline bulk-preview ledger entry falls when EITHER proof falls (shape or behaviour)', () => {
    const inlineKey = 'routes/multitable-ai.ts POST /sheets/:sheetId/ai/shortcut/bulk-preview'
    const inlineLoop = allFacts().flatMap((f) => f.providerLoops).find((l) => l.key === inlineKey)
    expect(inlineLoop, `${inlineKey} must be discovered`).toBeDefined()
    const verdict = () => PROVIDER_LOOPS[inlineKey]!.stillTrue(inlineLoop!)
    expect(verdict()).toBe(true)

    const route = normalizeEol(readSource(INLINE_BULK_FILE))
    const behaviour = normalizeEol(readFileSync(join(__dirname, INLINE_BULK_BEHAVIOUR_TEST), 'utf8'))
    // Shape: the verdict is overridden between the lookup and the refusal (the loop still "asks").
    const rebound = route.replace('  let liveness: SheetLiveness\n', "  let liveness: SheetLiveness\n  liveness = 'live'\n")
    // Behaviour: the case that proves the provider is called exactly once stops running.
    const skipped = behaviour.replace("  it('sheet DELETED while row 1 is generating:", "  it.skip('sheet DELETED while row 1 is generating:")
    expect(rebound).not.toBe(route)
    expect(skipped).not.toBe(behaviour)
    try {
      inlineBulkInputs.route = rebound
      expect(verdict(), 'route shape broken').toBe(false)
      delete inlineBulkInputs.route
      inlineBulkInputs.behaviour = skipped
      expect(verdict(), 'behaviour case skipped').toBe(false)
      inlineBulkInputs.behaviour = null
      expect(verdict(), 'behaviour test missing').toBe(false)
    } finally {
      delete inlineBulkInputs.route
      delete inlineBulkInputs.behaviour
    }
    expect(verdict()).toBe(true)
  })

  it('PROVIDER LOOPS: every loop under src/ that sends rows to the model is named — fixed with a proof, or a tracked GAP (#5832, #5838)', () => {
    const facts = allFacts()
    const found = facts.flatMap((f) => f.providerLoops)
    expect(providerLoopProblems(facts)).toEqual([])
    expect(found.map((l) => l.key).sort()).toEqual(Object.keys(PROVIDER_LOOPS).sort())
    // Still true today: BOTH lanes ask before every provider call (#5832 async, #5838 inline).
    expect(Object.fromEntries(found.map((l) => [l.key, l.asksLiveness]))).toEqual({
      'services/ai-bulk-job-service.ts runGeneratePhase': true,
      'routes/multitable-ai.ts POST /sheets/:sheetId/ai/shortcut/bulk-preview': true,
    })

    // Sharpness, in memory: the ledger reds when a loop loses its check, is added, unnamed or dead.
    const withSource = (rel: string, mutated: string) => facts.map((f) => (f.rel === rel ? factsOf(rel, mutated) : f))
    const inline = normalizeEol(readSource('routes/multitable-ai.ts'))
    const inlineSend = '        const outcome = await runShortcutCore(\n'
    expect(inline.split(inlineSend).length - 1).toBe(1)
    // the inline loop loses its per-row check → its entry reds (as the worker's does below)
    const inlineBlind = inline.replace(/\n( *)if \(!\(await bulkPreviewSheetIsLive\(query, sheetId\)\)\) \{\n[\s\S]*?\n\1\}\n/, '\n')
    expect(inlineBlind).not.toBe(inline)
    expect(providerLoopProblems(withSource('routes/multitable-ai.ts', inlineBlind)).join('\n'))
      .toMatch(/bulk-preview: the fact this entry rests on is no longer true/)
    // a second provider loop appears in a route → not named
    const doubled = inline.replace("  router.post('/sheets/:sheetId/ai/shortcut/bulk-commit',", () => [
      "  router.post('/sheets/:sheetId/ai/shortcut/bulk-again', async (req: Request, res: Response) => {",
      '    for (const id of [] as string[]) { await executeShortcut(req, res, {} as any, id, async () => {}) }',
      '  })',
      "  router.post('/sheets/:sheetId/ai/shortcut/bulk-commit',",
    ].join('\n'))
    expect(doubled).not.toBe(inline)
    expect(providerLoopProblems(withSource('routes/multitable-ai.ts', doubled)).join('\n'))
      .toMatch(/routes\/multitable-ai\.ts POST \/sheets\/:sheetId\/ai\/shortcut\/bulk-again \(line \d+\): a loop sends rows to the model and is not named/)
    // the worker loses its per-row check → its entry reds (and bulkWorkerLivenessProblems with it)
    const worker = normalizeEol(readSource(BULK_WORKER_FILE))
    const blind = worker.replace(/\n( *)if \(!\(await jobSheetIsLive\(query, jobId, plan\.sheetId\)\)\) \{\n[\s\S]*?\n\1\}\n/, '\n')
    expect(blind).not.toBe(worker)
    expect(providerLoopProblems(withSource(BULK_WORKER_FILE, blind)).join('\n'))
      .toMatch(/runGeneratePhase: the fact this entry rests on is no longer true/)
    // a ledger entry is dropped → the loop is unnamed; an entry whose loop is gone → dead entry
    const rest = { ...PROVIDER_LOOPS }
    delete rest['routes/multitable-ai.ts POST /sheets/:sheetId/ai/shortcut/bulk-preview']
    expect(providerLoopProblems(facts, rest).join('\n')).toMatch(/bulk-preview \(line \d+\): a loop sends rows to the model and is not named/)
    const unlooped = inline.replace(inlineSend, () => '        const outcome = await runShortcutCoreRenamed(\n')
    expect(providerLoopProblems(withSource('routes/multitable-ai.ts', unlooped)).join('\n'))
      .toMatch(/bulk-preview: expected exactly one provider loop, found 0/)
    // a future GAP entry must name its tracker (no entry is a GAP today — the rule is pinned anyway)
    const inlineKey = 'routes/multitable-ai.ts POST /sheets/:sheetId/ai/shortcut/bulk-preview'
    expect(Object.values(PROVIDER_LOOPS).some((e) => /\bGAP\b/.test(e.reason))).toBe(false)
    const asGap = (tracker: string) => providerLoopProblems(facts, {
      ...PROVIDER_LOOPS,
      [inlineKey]: {
        ...PROVIDER_LOOPS[inlineKey]!,
        reason: `GAP — tracked in ${tracker} — the inline bulk-preview loop sends each row's record content to the `
          + 'provider and would not ask again if this check were ever removed; this is the shape such an entry takes.',
      },
    }).join('\n')
    expect(asGap('#TBD')).toMatch(/TBD/)
    expect(asGap('nobody')).toMatch(/every GAP must name its issue/)
    expect(asGap('#5838')).toEqual('')
  })

  it('PROVIDER LOOPS self-test: every loop shape around the choke or a same-file sender is found; a liveness call inside the loop is seen', () => {
    const fixture = [
      "import { runShortcutCore } from '../services/ai-bulk-shared'",
      "import { loadSheetLiveness } from '../multitable/sheet-liveness'",
      'async function sendOne(p) { return runShortcutCore(client, ctx, p) }',
      'const sendArrow = async (p) => runShortcutCore(client, ctx, p)',
      'export function build(router) {',
      "  router.post('/sheets/:sheetId/for-of', async (req, res) => { for (const p of ps) { await runShortcutCore(client, ctx, p) } })",
      "  router.post('/sheets/:sheetId/while', async (req, res) => { while (next()) { await sendOne(req.body) } })",
      "  router.post('/sheets/:sheetId/do', async (req, res) => { do { await sendArrow(req.body) } while (more()) })",
      "  router.post('/sheets/:sheetId/for-in', async (req, res) => { for (const k in ps) await runShortcutCore(client, ctx, ps[k]) })",
      "  router.post('/sheets/:sheetId/classic', async (req, res) => { for (let i = 0; i < n; i++) { await runShortcutCore(client, ctx, ps[i]) } })",
      "  router.post('/sheets/:sheetId/fan-out', async (req, res) => { await Promise.all(ps.map((p) => runShortcutCore(client, ctx, p))) })",
      "  router.post('/sheets/:sheetId/checked', async (req, res) => { for (const p of ps) { if ((await loadSheetLiveness(q, req.params.sheetId)) !== 'live') break; await runShortcutCore(client, ctx, p) } })",
      "  router.post('/sheets/:sheetId/once', async (req, res) => { await runShortcutCore(client, ctx, req.body.p) })",
      "  router.post('/sheets/:sheetId/not-iteration', async (req, res) => { await retry(() => runShortcutCore(client, ctx, req.body.p)) })",
      '}',
      'class Worker {',
      '  async drain() { for (const p of ps) await this.sendOne(p) }',
      '}',
      // A registrar whose NESTED handler calls the choke is not itself a sender: mounting it on several
      // routers in a loop sends nothing per iteration (senders are direct callers only).
      "function mount(router) { router.post('/sheets/:sheetId/nested', async (req, res) => { await runShortcutCore(client, ctx, req.body.p) }) }",
      'for (const r of routers) mount(r)',
    ].join('\n')
    const loops = factsOf('routes/fixture.ts', fixture).providerLoops
    expect(Object.fromEntries(loops.map((l) => [l.key, l.asksLiveness]))).toEqual({
      'routes/fixture.ts POST /sheets/:sheetId/for-of': false,
      'routes/fixture.ts POST /sheets/:sheetId/while': false,
      'routes/fixture.ts POST /sheets/:sheetId/do': false,
      'routes/fixture.ts POST /sheets/:sheetId/for-in': false,
      'routes/fixture.ts POST /sheets/:sheetId/classic': false,
      'routes/fixture.ts POST /sheets/:sheetId/fan-out': false,
      'routes/fixture.ts POST /sheets/:sheetId/checked': true,
      'routes/fixture.ts drain': false,
    })
    expect(factsOf('routes/fixture.ts', fixture.replace(/\n/g, '\r\n')).providerLoops).toEqual(loops)
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

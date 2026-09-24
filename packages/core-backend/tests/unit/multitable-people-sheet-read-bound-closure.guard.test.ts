/**
 * #5807 — CLOSED WORLD over the People-sheet read bound in the two route files that read sheet records
 * under a bare `canRead`: `routes/univer-meta.ts` and `routes/dashboard.ts`.
 *
 * The bound itself lives in ONE helper (`multitable/people-sheet-read-bound.ts`), but a helper only
 * binds the routes that call it. The leak #5807 reports is not "this route is wrong", it is "this
 * SHEET is readable by quantity through whichever route happens to enumerate it" — so a reader added
 * tomorrow re-opens it silently.
 *
 * WHAT IS CLOSED: every route handler registered in those files that can ENUMERATE rows of a
 * caller-addressed sheet must either
 *   (a) name the resolver `resolvePeopleSheetReadBound` in its own body OR in a same-file helper it
 *       reaches (dashboard.ts resolves it once inside its shared `requireSheetRead` gate) — and name it
 *       AFTER that unit's `sendForbidden`, so the bound can never precede the authority refusal, or
 *   (b) appear in EXEMPT below with a reason.
 * Exemption by omission is impossible: an entry whose route no longer exists, or which has since
 * started calling the resolver, reds too — so the list cannot rot into a rubber stamp.
 *
 * ENUMERATING means either of two shapes, because the first cut's guard only had the first one and a
 * refuter showed that deleting the bound from `GET /records` left it GREEN:
 *   (1) INLINE SQL — the handler, or a same-file helper it reaches transitively, issues SQL that reads
 *       `meta_records` scoped by `sheet_id` and NOT narrowed to caller-supplied record ids (`id = $n` /
 *       `id = ANY($n)` / `record_id = $n`). A pure `COUNT(*)` is deliberately NOT enumeration — it
 *       yields no row identity — which is why `view-aggregate` is caught by its record read, not its count.
 *   (2) CROSS-FILE LOADER — the handler (or such a helper) CALLS an imported function that reaches that
 *       same SQL shape, across as many hops as it takes. `GET /records` pages the sheet through
 *       `queryRecordsWithCursor`, which is a one-line delegation in `multitable/records.ts` into
 *       `multitable/query-service.ts`, where the SQL actually lives: two hops, no SQL literal anywhere
 *       in the route file. The classifier walks that graph from the route file's own imports, so the
 *       ergonomic way to add a reader tomorrow (call the existing loader) is classified, and a loader
 *       that appears tomorrow is classified by what it DOES, not by a hand-kept list of names that
 *       would rot exactly the way the SQL-literal-only scan did.
 *
 * WHAT THE SCAN STILL CANNOT SEE (say it plainly rather than claim a closure this does not have):
 *   - a read reached through a METHOD (`service.loadRows(…)`): callee resolution follows identifiers,
 *     not property accesses, so a records-reading class method is invisible here. `loadChartRecords`
 *     in dashboard.ts is a plain function and IS seen; `dashboardService.getChartData` takes its
 *     records as an argument and reads none.
 *   - a loader imported from a NON-relative specifier (another package): module resolution follows
 *     relative paths inside `src/` only.
 *   - a registration whose handler the scanner cannot read at all (`scanned.opaque`): recorded by the
 *     shared scanner, asserted by the sheet-liveness closed world, not re-judged here.
 *   - routes OUTSIDE these files. The population is asserted below so a silent narrowing reds.
 *
 * #5960 widened the population to `routes/approvals.ts`: `GET /api/approvals/record-link-options` is the
 * same-shape person picker, reached through `listApprovalRecordLinkOptions` in a SERVICE module. That
 * loader resolves the bound INSIDE itself (the route has no `sendForbidden`; its authority refusal is the
 * service's own `APPROVAL_RECORD_LINK_TARGET_UNAVAILABLE` return), so it is classified `boundInside` below
 * and the guard verifies - from the syntax tree, never from comments - that the loader CALLS the resolver
 * (after that refusal) AND the three window helpers, every one of them IMPORTED from
 * `people-sheet-read-bound` (a same-named local function does not count). Remove any of those calls and
 * the route reads as unbound again. This is a structural backstop; the behavioural tests in
 * `approval-record-link-options.test.ts` are what pin the actual window.
 *
 * The registration scan is AST-based and shared with the sheet-liveness closed world
 * (tests/utils/sheet-liveness-route-scan.ts): registrations, handler resolution (wrappers, consts,
 * factories) and transitive same-file helper bodies all come from there, with comments stripped — so
 * prose can never satisfy a pattern. The cross-file classifier here is AST-only too: it reads string
 * and template LITERALS out of the syntax tree, never raw text, so a SQL-looking comment is not SQL.
 *
 * CRLF: the scanner normalizes to LF before parsing (the #3365 tripwire defect).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  findFunctionsNamed,
  namedImports,
  normalizeEol,
  scanRouteSource,
  type FnNode,
  type RouteHandler,
} from '../utils/sheet-liveness-route-scan'

/** The route files that answer sheet records under a bare `canRead` (approvals.ts: #5960). */
const FILES = ['routes/univer-meta.ts', 'routes/dashboard.ts', 'routes/approvals.ts'] as const
const SRC_ROOT = join(__dirname, '../../src')

/** The resolver every bound reader must name (in its own body or in a same-file gate helper). */
const RESOLVER = 'resolvePeopleSheetReadBound'
/** The refusal that must precede the resolver in whichever unit names it (no oracle). */
const GATE = 'sendForbidden(res)'

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

/**
 * The same question asked of ONE function's whole literal set, because a loader ASSEMBLES its SQL:
 * `query-service.ts` pushes `'sheet_id = $1'` into a `where[]` array and interpolates it into a
 * separate `FROM meta_records …` template, so no single literal carries both halves and the per-literal
 * test above answers false for the very loader `GET /records` pages the sheet with. Evidence, not one
 * string: some literal reads `meta_records`, some literal scopes by `sheet_id` — UNLESS every
 * `meta_records` literal is itself narrowed to named record ids, which is the by-id reader shape.
 *
 * Applied ONLY to cross-file callee classification. A route handler's literals belong to DIFFERENT
 * queries, so unioning them there would conflate unrelated statements; inline handler SQL keeps the
 * per-literal rule.
 */
function literalsEnumerate(literals: string[]): boolean {
  if (literals.some(isEnumeratingSql)) return true
  const normalized = literals.map((sql) => sql.replace(/\s+/g, ' '))
  const recordReads = normalized.filter((sql) => /FROM meta_records\b/i.test(sql))
  if (recordReads.length === 0) return false
  if (!normalized.some((sql) => /\bsheet_id\s*=\s*(\$\d|ANY\s*\()/i.test(sql))) return false
  const narrowed = (sql: string) => /\bid\s*=\s*(\$\d|ANY\s*\()/i.test(sql) || /\brecord_id\s*=\s*\$\d/i.test(sql)
  return !recordReads.every(narrowed)
}

/** SQL string / template literals appearing anywhere in a chunk of code-only text. */
function sqlLiteralsIn(code: string): string[] {
  const out: string[] = []
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) out.push(match[2])
  return out
}

// ── Cross-file callee classifier ────────────────────────────────────────────

interface ModuleIndex {
  sf: ts.SourceFile
  /** Every function-like declaration in the file, by name. */
  fns: Map<string, FnNode[]>
  /** `const a = b` (a plain re-binding, e.g. `const loadFieldsForSheet = loadFieldsForSheetShared`). */
  aliases: Map<string, string>
  /** Local binding name → { module, imported }. */
  imports: Map<string, { module: string; imported: string }>
  /** `export { a as b } from './m'` → b → { module: './m', imported: 'a' }. */
  reexports: Map<string, { module: string; imported: string }>
}

const moduleCache = new Map<string, ModuleIndex | null>()

function indexModule(file: string): ModuleIndex | null {
  if (moduleCache.has(file)) return moduleCache.get(file) ?? null
  if (!existsSync(file)) {
    moduleCache.set(file, null)
    return null
  }
  const sf = ts.createSourceFile(file, normalizeEol(readFileSync(file, 'utf8')), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const fns = new Map<string, FnNode[]>()
  const aliases = new Map<string, string>()
  const reexports = new Map<string, { module: string; imported: string }>()
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      const list = fns.get(node.name.text) ?? []
      list.push(node)
      fns.set(node.name.text, list)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const list = fns.get(node.name.text) ?? []
        list.push(init)
        fns.set(node.name.text, list)
      } else if (ts.isIdentifier(init)) {
        aliases.set(node.name.text, init.text)
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        reexports.set(element.name.text, {
          module: node.moduleSpecifier.text,
          imported: element.propertyName ? element.propertyName.text : element.name.text,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  const index: ModuleIndex = { sf, fns, aliases, imports: namedImports(sf), reexports }
  moduleCache.set(file, index)
  return index
}

/** Relative specifier → the `.ts` file it names (`./x`, `./x/index.ts`). Non-relative → null. */
function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolvePath(dirname(fromFile), specifier)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** String + template literals under a node, taken from the SYNTAX TREE (never from comments). */
function literalsUnder(node: ts.Node): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text)
    else if (ts.isTemplateExpression(n)) {
      out.push([n.head.text, ...n.templateSpans.map((span) => span.literal.text)].join(' $x '))
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/** Identifiers called as functions under a node (`f(…)`, not `obj.f(…)`). */
function calleeNamesUnder(node: ts.Node): string[] {
  const out = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.add(n.expression.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return [...out]
}

/** The declared return type of `name` in `file`, whitespace-normalized ('' when undeclared). */
function declaredReturnType(file: string, name: string): string {
  const index = indexModule(file)
  if (!index) return ''
  for (const fn of index.fns.get(name) ?? []) {
    if (fn.type) return fn.type.getText(index.sf).replace(/\s+/g, ' ').trim()
  }
  return ''
}

const fnVerdicts = new Map<string, boolean>()

/**
 * Does `name`, as defined in `file`, reach a sheet-scoped `meta_records` enumeration? Follows same-file
 * calls, plain re-bindings, named re-exports and RELATIVE imports, memoized per (file, name).
 */
function functionEnumerates(file: string, name: string, stack: Set<string> = new Set()): boolean {
  const key = `${file}#${name}`
  if (fnVerdicts.has(key)) return fnVerdicts.get(key)!
  if (stack.has(key) || stack.size > 8) return false
  const index = indexModule(file)
  if (!index) return false
  stack.add(key)
  let verdict = false
  const reexport = index.reexports.get(name)
  if (reexport) {
    const target = resolveModule(file, reexport.module)
    if (target) verdict = functionEnumerates(target, reexport.imported, stack)
  }
  const alias = index.aliases.get(name)
  if (!verdict && alias) verdict = functionEnumerates(file, alias, stack)
  if (!verdict && index.aliases.has(name)) {
    const importedAlias = index.imports.get(index.aliases.get(name)!)
    if (importedAlias) {
      const target = resolveModule(file, importedAlias.module)
      if (target) verdict = functionEnumerates(target, importedAlias.imported, stack)
    }
  }
  for (const fn of index.fns.get(name) ?? []) {
    if (verdict) break
    if (literalsEnumerate(literalsUnder(fn))) {
      verdict = true
      break
    }
    for (const callee of calleeNamesUnder(fn)) {
      if (verdict) break
      if (index.fns.has(callee) || index.aliases.has(callee) || index.reexports.has(callee)) {
        verdict = functionEnumerates(file, callee, stack)
        continue
      }
      const imported = index.imports.get(callee)
      if (!imported) continue
      const target = resolveModule(file, imported.module)
      if (target) verdict = functionEnumerates(target, imported.imported, stack)
    }
  }
  stack.delete(key)
  fnVerdicts.set(key, verdict)
  return verdict
}

/** `C:/.../src/multitable/records.ts` -> `multitable/records.ts` (stable across platforms). */
function underSrc(file: string): string {
  return file.slice(SRC_ROOT.length).split(sep).join('/').replace(/^\//, '')
}

interface ScannedFile {
  rel: string
  abs: string
  raw: string
  scanned: ReturnType<typeof scanRouteSource>
  imports: Map<string, { module: string; imported: string }>
}

function loadFile(rel: string): ScannedFile {
  const abs = join(SRC_ROOT, ...rel.split('/'))
  const raw = readFileSync(abs, 'utf8')
  const scanned = scanRouteSource(rel, raw)
  return { rel, abs, raw, scanned, imports: namedImports(scanned.sourceFile) }
}

/** The imported loaders this handler calls that reach a sheet enumeration (shape (2)). */
function crossFileEnumeratorCalls(file: ScannedFile, handler: RouteHandler): string[] {
  const hits: string[] = []
  for (const unit of handler.units) {
    for (const callee of calleeNamesUnder(unit.node)) {
      const imported = file.imports.get(callee)
      if (!imported) continue
      const target = resolveModule(file.abs, imported.module)
      if (!target) continue
      if (functionEnumerates(target, imported.imported)) hits.push(callee)
    }
  }
  return [...new Set(hits)]
}

function enumeratesInline(handler: RouteHandler): boolean {
  const chunks = [handler.code, ...handler.helpers.values()]
  return chunks.some((chunk) => sqlLiteralsIn(chunk).some(isEnumeratingSql))
}

/**
 * CLASSIFIED cross-file enumerators. Every imported function that reaches a sheet-scoped
 * `meta_records` enumeration AND is called by a handler in the scanned files must appear here, with
 * what it returns (pinned, so a loader that starts handing back ROWS tomorrow reds instead of
 * inheriting today's verdict) and why calling it does or does not make the caller a roster reader.
 *
 * `binds: true`  -- calling it IS paging the sheet; the caller must resolve the bound.
 * `binds: false` -- it reads records to DECIDE something (a deny set, a scope map, a count, a plan)
 *                   or to WRITE them; the rows are not the answer. Calling it does not, by itself,
 *                   make a handler a reader of the roster.
 *
 * The assertions below red on an UNCLASSIFIED name (a loader that appears tomorrow), on a stale one
 * (no longer reached, or no longer enumerating) and on a changed return type. That is the property the
 * first cut's guard did not have: it judged SQL literals only, so `GET /records` -- which pages the
 * sheet through `queryRecordsWithCursor` -- was invisible, and deleting its bound left the guard green.
 */
const CROSS_FILE_ENUMERATORS: Record<string, {
  module: string
  returns: string
  binds: boolean
  reason: string
  /**
   * The loader resolves the bound ITSELF. `gate` names the identifier of its authority refusal; the
   * guard requires (AST) a call to the resolver inside the loader, positioned after that identifier.
   */
  boundInside?: { gate: string }
}> = {
  listApprovalRecordLinkOptions: {
    module: 'services/approval-record-link-options.ts',
    returns: 'Promise<ApprovalRecordLinkOptionsResult>',
    binds: true,
    boundInside: { gate: 'APPROVAL_RECORD_LINK_TARGET_UNAVAILABLE' },
    reason:
      '#5960: the approvals record-link picker. It pages a caller-addressed sheet (limit/offset, id + display '
      + 'label, exact COUNT) under approvals:write + base/sheet canRead, so with the People sheet as target it '
      + 'is a roster reader. It resolves the People read window itself, after its own authority refusal.',
  },
  queryRecordsWithCursor: {
    module: 'multitable/records.ts',
    returns: 'Promise<CursorPaginatedResult<LoadedMultitableRecord>>',
    binds: true,
    reason:
      'THE record pager: a caller-supplied limit/cursor/sort/filter over the sheet, answering rows with '
      + 'their data. It is the ergonomic way to add a reader, and it carries no SQL literal in the route '
      + 'file (records.ts delegates into query-service.ts), which is exactly how the first guard missed it.',
  },
  loadDeniedRecordIds: {
    module: 'multitable/permission-service.ts',
    returns: 'Promise<Set<string>>',
    binds: false,
    reason:
      'Reads the sheet to compute which records the actor may NOT see (grant-deny union conditional-rule '
      + 'deny). It answers a set of ids to SUBTRACT; its result can only shrink a page, never extend one, '
      + 'and no cell value leaves it.',
  },
  loadRecordPermissionScopeMap: {
    module: 'multitable/permission-service.ts',
    returns: 'Promise<Map<string, RecordPermissionScope>>',
    binds: false,
    reason:
      'Per-record access LEVELS for record ids the caller already named (read/write/admin/none). The '
      + 'values are authority, not cell data, and the ids are inputs rather than outputs.',
  },
  loadHistoryBatchSummaries: {
    module: 'multitable/history-projection.ts',
    returns: 'Promise<{ batches: HistoryBatchSummary[]; total: number; nextCursor: string | null; searchTruncated: boolean }>',
    binds: false,
    reason:
      'GAP, named not excused: the global-history CHANGE LOG, scoped to batches over sheets the actor may '
      + 'read. It publishes changes rather than a sheet page, and the history model (reveal, field mask, '
      + 'batch paging) is its own decision surface -- this read-window cut deliberately does not extend '
      + 'into it. A People sheet materialized in one batch is therefore still describable through history.',
  },
  estimateHistoryHasMore: {
    module: 'multitable/history-projection.ts',
    returns: 'Promise<{ batches: HistoryBatchSummary[]; hasMore: boolean; nextCursor: string | null }>',
    binds: false,
    reason:
      'The same history projection as above, used to answer "is there another page of BATCHES" without a '
      + 'second count. Same surface, same named gap, same reason.',
  },
  loadHistoryBatchDetail: {
    module: 'multitable/history-projection.ts',
    returns: 'Promise<HistoryBatchDetail | null>',
    binds: false,
    reason:
      'One history BATCH expanded (its changes, field-masked by the history chain, 404 for a batch outside '
      + 'the readable sheet ids). Batch-scoped, not sheet-page-scoped; same named history gap.',
  },
  enforceSheetRecoverySizeCeiling: {
    module: 'multitable/exact-anchor-recovery-route.ts',
    returns: 'Promise<SizeCeilingVerdict>',
    binds: false,
    reason:
      'Counts the sheet to refuse a recovery that is too large. Its answer is a verdict; the recovery '
      + 'routes are gated on recovery authority, which the #5807 actor (a bare global multitable:read) '
      + 'does not hold.',
  },
  previewExactAnchorRecovery: {
    module: 'multitable/exact-anchor-recovery-route.ts',
    returns: "Promise< | ExactAnchorPreviewSuccess | { ok: false; reason: ResolveAnchorRefusal } | { ok: false; reason: 'too-large'; recordCount: number; maxRecords: number } | { ok: false; reason: 'history-incomplete' } | { ok: false; reason: 'recovery-trust-required' } >",
    binds: false,
    reason:
      'Builds the PLAN for a revert/reset (what would change), under recovery authority plus a full-read '
      + 'evaluation of its own. It is a restore surface, not a read surface, and it is not reachable with '
      + 'canRead alone.',
  },
  executeExactAnchorRecoveryApply: {
    module: 'multitable/exact-anchor-recovery-route.ts',
    returns: 'Promise<ExactAnchorApplyResult>',
    binds: false,
    reason:
      'APPLIES that plan -- a write path under the same recovery authority. A read window here would clamp '
      + 'a restore, which is not what the bound means.',
  },
  createRecoveryPlanAuthorization: {
    module: 'multitable/recovery-plan-authorization.ts',
    returns: '',
    binds: false,
    reason:
      'A factory that wires the recovery authority checks (return type inferred, hence the empty pin). It '
      + 'answers authority decisions for the recovery routes above, never rows.',
  },
  activateCheckpoint: {
    module: 'multitable/history-trust-checkpoint.ts',
    returns: 'Promise<ActivateCheckpointResult>',
    binds: false,
    reason:
      'WRITE: stamps a trust checkpoint for the sheet, reading records to hash/count them. Its response is '
      + 'the checkpoint, and its gate is not canRead.',
  },
  backfillAutoNumberField: {
    module: 'multitable/auto-number-service.ts',
    returns: 'Promise<BackfillAutoNumberFieldResult>',
    binds: false,
    reason:
      'WRITE under canManageFields: numbers the existing rows when an auto-number field is created. It '
      + 'returns how many rows it filled; the rows themselves never reach the caller.',
  },
  countFieldDeleteCaptureRows: {
    module: 'multitable/tombstone-capture.ts',
    returns: 'Promise<number>',
    binds: false,
    reason:
      'A COUNT for the field-delete flow (how many stored cells a delete would tombstone). A number, not '
      + 'row identity -- the same reason a pure COUNT(*) is not enumeration in the inline rule above.',
  },
  insertFieldValueTombstones: {
    module: 'multitable/tombstone-capture.ts',
    returns: 'Promise<void>',
    binds: false,
    reason: 'WRITE under canManageFields: captures the deleted field values as tombstones. Returns nothing.',
  },
  assertRichLongTextToggleAllowed: {
    module: 'multitable/field-codecs.ts',
    returns: 'Promise<void>',
    binds: false,
    reason:
      'A field-config PRECONDITION (may this long-text field become rich text given the stored values). It '
      + 'throws or returns nothing, under field-schema authority.',
  },
}

/** The helpers a `boundInside` loader must call besides the resolver (pre-clamp, post-truncate, page meta). */
const BOUND_HELPERS = ['boundReadWindow', 'boundEnumeratedRows', 'boundPageMeta'] as const
/** The one module those names (and the resolver) must be imported from. */
const BOUND_MODULE_RE = /(^|\/)people-sheet-read-bound(\.ts)?$/

/** Top-level-or-nested local declarations of `name` in the file (function / variable / class). */
function declaresLocally(sf: ts.SourceFile, name: string): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name?.text === name) found = true
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = true
    else ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

/**
 * Pure verdict for a `boundInside` loader, from the SYNTAX TREE only (comments cannot satisfy it):
 *   - the resolver and every BOUND_HELPERS name is CALLED inside `fn`;
 *   - each of those names is a named import from `people-sheet-read-bound` (same imported name), and
 *     is not shadowed by a same-named local declaration;
 *   - the resolver call sits after the first reference to the gate identifier.
 */
function boundInsideVerdict(fn: ts.Node, gate: string, sf: ts.SourceFile = fn.getSourceFile()): boolean {
  let gateAt = -1
  const firstCall = new Map<string, number>()
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === gate && gateAt < 0) gateAt = n.getStart()
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && !firstCall.has(n.expression.text)) {
      firstCall.set(n.expression.text, n.getStart())
    }
    ts.forEachChild(n, visit)
  }
  visit(fn)
  const imports = namedImports(sf)
  for (const name of [RESOLVER, ...BOUND_HELPERS]) {
    if (!firstCall.has(name)) return false
    const imported = imports.get(name)
    if (!imported || imported.imported !== name || !BOUND_MODULE_RE.test(imported.module)) return false
    if (declaresLocally(sf, name)) return false
  }
  const resolverAt = firstCall.get(RESOLVER)!
  return gateAt >= 0 && resolverAt > gateAt
}

/** The real loader's function node, for a classified `boundInside` enumerator. */
function boundInsideFunction(name: string): FnNode | null {
  const entry = CROSS_FILE_ENUMERATORS[name]
  if (!entry?.boundInside) return null
  const index = indexModule(join(SRC_ROOT, ...entry.module.split('/')))
  return index?.fns.get(name)?.[0] ?? null
}

function calleeBoundInside(name: string): boolean {
  const entry = CROSS_FILE_ENUMERATORS[name]
  const fn = boundInsideFunction(name)
  return Boolean(entry?.boundInside && fn && boundInsideVerdict(fn, entry.boundInside.gate))
}

/** Cross-file enumerators this handler calls whose use IS paging the sheet (unclassified counts too). */
function bindingEnumeratorCalls(file: ScannedFile, handler: RouteHandler): string[] {
  return crossFileEnumeratorCalls(file, handler).filter((name) => CROSS_FILE_ENUMERATORS[name]?.binds !== false)
}

function enumeratesRecords(file: ScannedFile, handler: RouteHandler): boolean {
  return enumeratesInline(handler) || bindingEnumeratorCalls(file, handler).length > 0
}

/**
 * Bound EITHER by naming the resolver in the handler / a same-file helper, OR (no inline enumeration,
 * and every binding loader it calls verifiably resolves the bound inside itself).
 */
function isBound(file: ScannedFile, handler: RouteHandler): boolean {
  if (resolverUnitCode(handler) !== null) return true
  if (enumeratesInline(handler)) return false
  const via = bindingEnumeratorCalls(file, handler)
  return via.length > 0 && via.every(calleeBoundInside)
}

/** The unit (handler body or same-file helper) that names the resolver, if any. */
function resolverUnitCode(handler: RouteHandler): string | null {
  if (handler.code.includes(RESOLVER)) return handler.code
  for (const helper of handler.helpers.values()) if (helper.includes(RESOLVER)) return helper
  return null
}

/**
 * Enumerating readers that deliberately do NOT resolve the bound, each with the reason it is safe.
 * Keyed by `<file> <VERB> <path>`.
 */
const EXEMPT: Record<string, string> = {
  'routes/univer-meta.ts POST /sheets/:sheetId/config-restore-preview':
    'CONFIG restore, not a record reader: its gate is canManageFields / canManageViews / ' +
    'canManageSheetAccess — schema authority the #5807 actor (a bare global multitable:read) does not ' +
    'hold — and the meta_records read is a per-FIELD probe (`WHERE sheet_id = $1 AND data ? $2`) used to ' +
    'decide whether restoring a field would strand stored cells. Its response carries the config diff, ' +
    'never a page of roster rows.',
  'routes/univer-meta.ts POST /sheets/:sheetId/config-restore-execute':
    'Same as the preview above: canManageFields / canManageViews / canManageSheetAccess authority, a ' +
    'per-FIELD `data ? $2` probe rather than a roster page, and a response that reports what was ' +
    'restored. A bound here would clamp a WRITE path, which is not what the read window means.',
  'routes/univer-meta.ts POST /person-fields/prepare':
    'This is the MATERIALIZER the issue is about, not a reader of it: gate canManageFields, it reads the ' +
    'sheet to find which active users already have a row and answers `{ targetSheet, fieldProperty }` — ' +
    'no records at all. Bounding it would break the sync (it must see every existing row to avoid ' +
    'duplicating people); the write side is a separate question from this read-side quantity cut.',
  'routes/univer-meta.ts GET /people-search':
    'Deliberately untouched by this cut and already the narrow surface: it is clamped to 20 items and ' +
    'returns DISPLAY values only (id + display), never the row. It is also the one path the person chip ' +
    'and MetaLinkPicker use on first open, so adding a mandatory search term here would empty them — ' +
    'the summary-display-field-mask suites call it with no term on purpose.',
  'routes/univer-meta.ts PATCH /fields/:fieldId':
    'Field-schema write gated on canManageFields, not canRead: it enumerates the sheet only to rewrite ' +
    'stored cells for a type conversion, and its response is the updated FIELD. The rows never reach the ' +
    'caller, so a read window would bound nothing that is returned.',
}

const files = FILES.map(loadFile)
const population = files.flatMap((file) => file.scanned.handlers.map((handler) => ({ file, handler, key: `${file.rel} ${handler.key}` })))
const enumerating = population.filter((entry) => enumeratesRecords(entry.file, entry.handler))
const byKey = new Map(population.map((entry) => [entry.key, entry]))

describe('#5807 — every enumerating reader of a sheet is bound or named', () => {
  it('the scan finds both files and a non-trivial population (a scanner that reads nothing proves nothing)', () => {
    expect(files.map((f) => f.rel)).toEqual([...FILES])
    for (const file of files) expect(file.scanned.handlers.length, file.rel).toBeGreaterThan(5)
    expect(population.length).toBeGreaterThan(50)
    expect(enumerating.length).toBeGreaterThan(3)
  })

  it('every enumerating reader either resolves the bound or is EXEMPT with a reason', () => {
    const unaccounted = enumerating
      .filter((entry) => !isBound(entry.file, entry.handler))
      .filter((entry) => !(entry.key in EXEMPT))
      .map((entry) => {
        const via = bindingEnumeratorCalls(entry.file, entry.handler)
        // Name the loader in the failure, so the fix (bind it, or exempt it with a reason) is obvious.
        return `${entry.key} (line ${entry.handler.line})${via.length > 0 ? ` via ${via.join(', ')}` : ' via inline SQL'}`
      })
    expect(unaccounted).toEqual([])
  })

  it('no EXEMPT entry is stale — its route still exists and still does not resolve the bound', () => {
    const stale: string[] = []
    for (const key of Object.keys(EXEMPT)) {
      const entry = byKey.get(key)
      if (!entry) stale.push(`${key}: route no longer exists`)
      else if (!enumeratesRecords(entry.file, entry.handler)) stale.push(`${key}: no longer enumerates — drop the exemption`)
      else if (isBound(entry.file, entry.handler)) stale.push(`${key}: now resolves the bound — drop the exemption`)
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
    for (const file of files) {
      const crlf = scanRouteSource(file.rel, file.raw.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'))
      expect(crlf.handlers.length, file.rel).toBe(file.scanned.handlers.length)
      const crlfFile: ScannedFile = { ...file, scanned: crlf, imports: namedImports(crlf.sourceFile) }
      expect(crlf.handlers.filter((h) => enumeratesRecords(crlfFile, h)).map((h) => h.key))
        .toEqual(file.scanned.handlers.filter((h) => enumeratesRecords(file, h)).map((h) => h.key))
      expect(crlf.handlers.filter((h) => resolverUnitCode(h) !== null).map((h) => h.key))
        .toEqual(file.scanned.handlers.filter((h) => resolverUnitCode(h) !== null).map((h) => h.key))
    }
  })

  it('the bound routes resolve it AFTER the gate — the resolver never precedes a canRead refusal', () => {
    const bound = population.filter((entry) => resolverUnitCode(entry.handler) !== null)
    expect(bound.length).toBeGreaterThan(3)
    for (const entry of bound) {
      const unit = resolverUnitCode(entry.handler)!
      const gateAt = unit.indexOf(GATE)
      const resolverAt = unit.indexOf(RESOLVER)
      expect(gateAt, entry.key).toBeGreaterThanOrEqual(0)
      // A bound resolved before the authority refusal would make the People sheet an oracle for a
      // caller that may not read it at all.
      expect(resolverAt, entry.key).toBeGreaterThan(gateAt)
    }
  })


  it('every cross-file enumerator a handler reaches is CLASSIFIED, still reached, and still the shape it was judged in', () => {
    const reached = new Map<string, { module: string; returns: string }>()
    for (const entry of population) {
      for (const callee of crossFileEnumeratorCalls(entry.file, entry.handler)) {
        const imported = entry.file.imports.get(callee)!
        const target = resolveModule(entry.file.abs, imported.module)!
        reached.set(callee, { module: underSrc(target), returns: declaredReturnType(target, imported.imported) })
      }
    }
    // A loader that appears tomorrow is UNCLASSIFIED and reds here, whether or not its caller happens to
    // be bound - which is the "new reader cannot slip in quietly" property, stated as an assertion.
    expect([...reached.keys()].filter((name) => !(name in CROSS_FILE_ENUMERATORS)).sort()).toEqual([])
    // A classification nobody reaches any more is a rubber stamp waiting to happen.
    expect(Object.keys(CROSS_FILE_ENUMERATORS).filter((name) => !reached.has(name)).sort()).toEqual([])
    // The verdicts above were reached BECAUSE of what these return. If that changes, re-judge it.
    const drifted = [...reached.entries()]
      .filter(([name, seen]) => {
        const pinned = CROSS_FILE_ENUMERATORS[name]
        return pinned && (pinned.module !== seen.module || pinned.returns !== seen.returns)
      })
      .map(([name, seen]) => `${name}: now ${seen.module} returning ${seen.returns || '<inferred>'}`)
    expect(drifted).toEqual([])
  })

  it('every cross-file classification carries a real reason, not a placeholder', () => {
    for (const [name, entry] of Object.entries(CROSS_FILE_ENUMERATORS)) {
      expect(entry.reason.length, name).toBeGreaterThan(60)
      expect(entry.reason, name).not.toMatch(/\b(TBD|TODO|FIXME|\?\?\?)\b/i)
    }
  })

  // ── Self-tests: the classifier is what the assertions above assume ────────

  it('SELF-TEST — the cross-file dimension classifies `GET /records`, which has NO SQL literal of its own', () => {
    const records = byKey.get('routes/univer-meta.ts GET /records')
    expect(records, 'GET /records is gone — re-point this self-test').toBeTruthy()
    // The first cut's guard missed exactly this: inline-SQL-only, so deleting the bound here left it green.
    expect(enumeratesInline(records!.handler)).toBe(false)
    expect(crossFileEnumeratorCalls(records!.file, records!.handler)).toContain('queryRecordsWithCursor')
    expect(enumeratesRecords(records!.file, records!.handler)).toBe(true)
    expect(resolverUnitCode(records!.handler)).not.toBeNull()
  })

  it('SELF-TEST — the classifier follows a DELEGATION across two modules, and is not a rubber stamp', () => {
    const recordsModule = join(SRC_ROOT, 'multitable', 'records.ts')
    // `queryRecordsWithCursor` is a one-line delegation; the SQL lives in query-service.ts.
    expect(functionEnumerates(recordsModule, 'queryRecordsWithCursor')).toBe(true)
    expect(literalsUnder(findFunctionsNamed(indexModule(recordsModule)!.sf, 'queryRecordsWithCursor')[0]).some(isEnumeratingSql)).toBe(false)
    // Negative control — a loader that reads FIELDS, not records, must NOT be classified as enumerating,
    // or "enumerating" would mean nothing and every handler would need an exemption.
    expect(functionEnumerates(join(SRC_ROOT, 'multitable', 'loaders.ts'), 'loadFieldsForSheet')).toBe(false)
  })

  it('SELF-TEST — dashboard.ts is in the population and its chart data routes are bound through the shared gate', () => {
    for (const key of [
      'routes/dashboard.ts POST /sheets/:sheetId/charts/preview-data',
      'routes/dashboard.ts GET /sheets/:sheetId/charts/:id/data',
    ]) {
      const entry = byKey.get(key)
      expect(entry, `${key} is gone — re-point this self-test`).toBeTruthy()
      expect(enumeratesRecords(entry!.file, entry!.handler), key).toBe(true)
      // The resolver is in the shared `requireSheetRead` helper, not in the handler body.
      expect(entry!.handler.code.includes(RESOLVER), key).toBe(false)
      expect(resolverUnitCode(entry!.handler), key).not.toBeNull()
    }
  })

  it('every boundInside loader CALLS the resolver after its own authority refusal (#5960)', () => {
    const inside = Object.entries(CROSS_FILE_ENUMERATORS).filter(([, entry]) => entry.boundInside)
    expect(inside.length).toBeGreaterThan(0)
    for (const [name] of inside) {
      expect(boundInsideFunction(name), `${name} not found in its pinned module`).not.toBeNull()
      expect(calleeBoundInside(name), name).toBe(true)
    }
  })

  it('SELF-TEST — approvals record-link-options is in the population, enumerates via its service, and is bound there', () => {
    const entry = byKey.get('routes/approvals.ts GET /api/approvals/record-link-options')
    expect(entry, 'record-link-options is gone — re-point this self-test').toBeTruthy()
    expect(enumeratesInline(entry!.handler)).toBe(false)
    expect(bindingEnumeratorCalls(entry!.file, entry!.handler)).toEqual(['listApprovalRecordLinkOptions'])
    expect(resolverUnitCode(entry!.handler)).toBeNull()
    expect(isBound(entry!.file, entry!.handler)).toBe(true)
    expect(Object.keys(EXEMPT)).not.toContain('routes/approvals.ts GET /api/approvals/record-link-options')
  })

  it('SELF-TEST — boundInsideVerdict is not a rubber stamp (each missing piece / local fake / wrong order reds)', () => {
    const NL = String.fromCharCode(10)
    const IMPORT = "import { boundEnumeratedRows, boundPageMeta, boundReadWindow, resolvePeopleSheetReadBound } from '../multitable/people-sheet-read-bound'"
    const GOOD_BODY = [
      'if (!a) return { ...GATE_X }',
      'const b = await resolvePeopleSheetReadBound(q, s)',
      'const w = boundReadWindow(b, { limit, offset })',
      'rows = boundEnumeratedRows(b, rows, offset)',
      'return boundPageMeta(b, page)',
    ]
    const probe = (body: string[], opts: { imports?: string; extra?: string } = {}): boolean => {
      const src = [opts.imports ?? IMPORT, opts.extra ?? '', `async function target() {${NL}${body.join(NL)}${NL}}`].join(NL)
      const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      return boundInsideVerdict(findFunctionsNamed(sf, 'target')[0], 'GATE_X', sf)
    }
    const without = (needle: string) => GOOD_BODY.filter((line) => !line.includes(needle))
    expect(probe(GOOD_BODY)).toBe(true)
    // resolver removed / before the gate / only in a comment
    expect(probe(without('resolvePeopleSheetReadBound'))).toBe(false)
    expect(probe([GOOD_BODY[1], GOOD_BODY[0], ...GOOD_BODY.slice(2)])).toBe(false)
    expect(probe([...without('resolvePeopleSheetReadBound'), '/* resolvePeopleSheetReadBound(q, s) */'])).toBe(false)
    // each window helper is required
    expect(probe(without('boundReadWindow'))).toBe(false)
    expect(probe(without('boundEnumeratedRows'))).toBe(false)
    expect(probe(without('boundPageMeta'))).toBe(false)
    // a hand-written local fake with the right name does not count, imported or not
    const fake = 'async function resolvePeopleSheetReadBound(_q: unknown, _s: unknown) { return { bounded: false, maxItems: 50 } }'
    expect(probe(GOOD_BODY, {
      imports: "import { boundEnumeratedRows, boundPageMeta, boundReadWindow } from '../multitable/people-sheet-read-bound'",
      extra: fake,
    })).toBe(false)
    expect(probe(GOOD_BODY, { extra: fake })).toBe(false)
    // imported from the wrong module, or aliased from a different export
    expect(probe(GOOD_BODY, { imports: IMPORT.replace('people-sheet-read-bound', 'fake-bound') })).toBe(false)
    expect(probe(GOOD_BODY, {
      imports: "import { boundEnumeratedRows, boundPageMeta, boundReadWindow, boundReadWindow as resolvePeopleSheetReadBound } from '../multitable/people-sheet-read-bound'",
    })).toBe(false)
  })

  it('SELF-TEST — `GET /sheets/:sheetId/point-in-time` is bound (it was the first cut’s named GAP)', () => {
    const entry = byKey.get('routes/univer-meta.ts GET /sheets/:sheetId/point-in-time')
    expect(entry, 'point-in-time is gone — re-point this self-test').toBeTruthy()
    expect(enumeratesRecords(entry!.file, entry!.handler)).toBe(true)
    expect(resolverUnitCode(entry!.handler)).not.toBeNull()
    expect(Object.keys(EXEMPT)).not.toContain('routes/univer-meta.ts GET /sheets/:sheetId/point-in-time')
  })
})

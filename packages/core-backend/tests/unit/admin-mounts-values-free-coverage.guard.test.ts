/**
 * Coverage guard — every /api/admin mount in src/index.ts is held to a values-free 5xx scan, or is allowlisted
 * below with a reason, a date, an echo claim the scanner re-checks (h), and a follow-up.
 *
 * WHY. tests/unit/admin-tree-5xx-values-free.test.ts keeps caught-error text out of 5xx bodies only in the files it
 * reaches: the tree it DISCOVERS from routes/admin-routes.ts (mounted at /api/admin) and routes/admin-users.ts, scanned
 * BY NAME because index.ts mounts it path-less. The /api/admin/directory family, /api/admin/canary and the path-less
 * routes/permissions.ts (/api/admin/permission-templates) were reached by no scan, and nothing would have flagged the
 * next router mounted under /api/admin (docs/development/autonomous-run-20260928-29-integration-outcome.md §12,
 * '挂在 /api/admin 下的根级路由'). This guard enumerates the mounts and makes each one an explicit decision.
 *
 * HOW. index.ts is parsed with the TypeScript compiler API (no type checker). A mount is `use(…)` or
 * `get|post|put|patch|delete|all|options|head(path, …)` called on `this.app`, on the `const app = this.app` alias, or
 * on a chain of calls rooted there (Express returns the app from use(), set() and the verbs, so
 * `this.app.use(a).use('/api/admin/x', r)` mounts too); parentheses and type assertions are looked through. Paths are
 * compared segment-wise and case-insensitively (Express routes case-insensitively unless 'case sensitive routing' is
 * set; index.ts does not set it). Literal paths are recorded (each literal of an array; a local `const` literal is
 * read; 'root' when path-less) and each handler is traced to a module through imports, calls / `new` / members of
 * them, enclosing-block `const`s (also destructured from `await import('./x')`), `?:`, `await`, parentheses and type
 * assertions. It FAILS CLOSED, naming the index.ts line, when
 *   1. a mount under /api/admin has a handler that does not trace to a module under src/routes/ (an inline function,
 *      an unknown identifier, a parameter, package or local middleware — a middleware next to the router fails too;
 *      extend the guard when one is needed — or a module elsewhere);
 *   2. a path-less mount, or one at '/' or '/api', reaches a module outside src/routes/ — or is an inline closure —
 *      with a string literal landing under /api/admin once appended to the mount path (a src/routes/ module with one
 *      puts the mount in scope; a closure is also followed into the src/routes/ modules it names; the arguments of a
 *      handler call are traced too, so `withAudit(adminRouter())` reaches the router; a module outside src/routes/ is
 *      followed one import hop into the src/routes/ modules it composes); a handler there that cannot be traced at
 *      all is listed in `untraced`, which must stay empty;
 *   3. a path is not a literal the guard can place: a template or concatenation whose static head may still reach
 *      /api/admin, a RegExp, a verb route whose path is anything but a literal or a local `const` literal, or a
 *      literal with a parameter, wildcard or pattern character in its first two segments ('/api/:area', '/api/*').
 * Two backstops close the forms the walk cannot see: (f) every string literal in index.ts starting with /api/admin
 * (any case) must be the path argument of a recognized mount — so a Router built in index.ts, a helper handed the
 * app, `this.app.route(…)` or an alias form the walk does not know cannot register an admin path unseen; (g) every
 * place index.ts hands `this.app` to something else (a call or constructor argument, a return, an object) is pinned
 * in APP_HANDOFFS, so a new hand-off that could mount routes elsewhere is a reviewed decision, not a drift.
 *
 * NOT COVERED, deliberately: `router.use(…)` inside route files (the tree under admin-routes.ts is the AST scanner's
 * own discovery; composition inside other src/routes/ modules is not followed) and composition deeper than one hop
 * in a module outside src/routes/; what the pinned hand-offs mount (src/gateway/APIGateway.ts mounts its own router
 * at its basePath, '/api' by default); plugin routes, which index.ts registers itself through `this.app[method](path,
 * …)` with paths from manifests (no literal for (f) to see); path-less package middleware and a `use()` path held in
 * an imported constant (read as a handler: it fails or lands in scope when its module carries /api/admin literals,
 * and is silent otherwise); alias forms other than `const app = this.app` (`let`, destructuring — their literal
 * mounts are still caught by (f)); what a closure reaches through `this` or a parameter. SCANNED is backed by the
 * scanner suite handing the file to the scanner outside its own `it(…)` bodies and a live `it(…)` reaching the
 * declaration that does so (d) — not by that suite being green; it runs in the same lane.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { scanResponseErrorEcho } from '../utils/response-error-echo-scan'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../src')
const SCANNER_SUITE = path.join(HERE, 'admin-tree-5xx-values-free.test.ts')
const ADMIN = '/api/admin'
/** A string literal (or template head) that is, or starts under, /api/admin — Express matches paths case-insensitively. */
const ADMIN_LITERAL = /^\/api\/admin(?=\/|$)/i

/** Routers whose 5xx branches an existing values-free scanner covers — each one backed by check (d). */
const SCANNED: readonly string[] = ['admin-routes.ts', 'admin-users.ts']

/** `echo` is what the scanner must find in the file today (h): 'none' = zero offenders, 'known' = at least one (a recorded gap). */
interface AllowlistEntry { reason: string; since: string; followUp: string; echo: 'none' | 'known' }
const SINCE = '2026-10-09'
const OUTCOME_S12 = 'docs/development/autonomous-run-20260928-29-integration-outcome.md §12'
const ADD_TO_SCAN = `add the file to the values-free AST scan in tests/unit/admin-tree-5xx-values-free.test.ts, then move it to SCANNED (${OUTCOME_S12}, '挂在 /api/admin 下的根级路由')`
const UNSCANNED = 'Not reached by any values-free AST scan yet.'
const FIXED_500S = 'each jsonError with a literal sentence, the error text going to logger.error only; the scanner finds no echo (h).'

/** Mounted under /api/admin but not scanned: why, since when, what the scanner finds today, and what closes it. */
const ALLOWLIST: Readonly<Record<string, AllowlistEntry>> = {
  'admin-directory.ts': { since: SINCE, echo: 'none', followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Since #6163 S6 (2026-10-09) every 5xx body is a fixed sentence and the status comes from the error type: sendDirectoryFailure answers DirectoryValidationError 400 / DirectoryNotFoundError 404 / DirectoryConflictError 409 and anything else 500 with the route's literal fallback, logging the text; the lease / freeze 409s and the deprovision coded refusals use literal statuses. The scanner finds no echo (h), down from 33 offenders. Since R-41 (2026-10-10) the five literal-400 sites that used to surface provider, transport and database-driver text (DINGTALK_WORK_NOTIFICATION_TEST_FAILED, DINGTALK_WORK_NOTIFICATION_SAVE_FAILED, APPROVAL_CARD_SECRET_GENERATE_FAILED, APPROVAL_CARD_CONFIG_SAVE_FAILED, DIRECTORY_TEST_FAILED) answer through sendDirectoryConfigFailure: a typed developer sentence, the route's fixed sentence plus DingTalk's numeric errcode / HTTP status, or the fixed sentence alone; 4xx is outside the scanner's scope, so the runtime probes in admin-directory-5xx-values-free.test.ts pin them.` },
  'admin-directory-local.ts': { since: SINCE, echo: 'none', followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Its one 500 (handleLocalDirectoryError) sends the fixed fallbackMessage and logs the text; 4xx carry typed, developer-authored messages; the scanner finds no echo (h).` },
  'admin-directory-department-bindings.ts': { since: SINCE, echo: 'none', followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Three 500s, ${FIXED_500S}` },
  'admin-directory-routing-policy.ts': { since: SINCE, echo: 'none', followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Three 500s, ${FIXED_500S}` },
  'admin-directory-org-transfers.ts': { since: SINCE, echo: 'none', followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Its one 500 (handleOrgTransferError) sends the fixed fallbackMessage and logs fixed metadata only; 4xx carry typed messages; the scanner finds no echo (h).` },
  'canary-routes.ts': { since: SINCE, echo: 'none', followUp: ADD_TO_SCAN, reason: `${UNSCANNED} 6 fixed-status 5xx branches with literal bodies; the scanner finds no echo (h).` },
  'permissions.ts': { since: SINCE, echo: 'none', followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Mounted path-less; defines /api/admin/permission-templates and …/apply. 12 fixed-status 5xx branches with literal bodies; the scanner finds no echo (h).` },
}

/** Today's in-scope mounts, `<path> -> <file under src/routes/>`, pinned so an extraction regression cannot pass (e). */
const EXPECTED_IN_SCOPE: readonly string[] = [
  '/api/admin -> admin-routes.ts', 'root -> admin-users.ts', 'root -> permissions.ts', '/api/admin/canary -> canary-routes.ts',
  '/api/admin/directory -> admin-directory.ts', '/api/admin/directory/local -> admin-directory-local.ts',
  '/api/admin/directory/org-transfers -> admin-directory-org-transfers.ts',
  '/api/admin/directory/department-bindings -> admin-directory-department-bindings.ts',
  '/api/admin/directory/routing-policy -> admin-directory-routing-policy.ts',
]

/** Where index.ts hands `this.app` to something else (g): the HTTP server, metrics, and the API gateway (which mounts its own router at '/api'). */
const APP_HANDOFFS: readonly string[] = ['createServer', 'installMetrics', 'new APIGateway']

// ── extraction: pure functions of (index.ts text, src reader), shared by the real and the synthetic checks ──

interface InScopeMount { line: number; prefix: string; file: string }
interface AppHandoff { line: number; callee: string }
interface MountScan { inScope: InScopeMount[]; failures: string[]; untraced: string[]; strayLiterals: string[]; handoffs: AppHandoff[] }
type ModuleTrace = { kind: 'module'; src: string }
type Trace = ModuleTrace | { kind: 'package' } | { kind: 'none' } | { kind: 'unresolved'; why: string }
/** How a path relates to /api/admin: under it; an ancestor ('', '/', '/api'); a pattern that may match it; unrelated. */
type Relation = 'admin' | 'ancestor' | 'maybe' | 'none'
/** Reads a file by its path relative to src/ ('routes/x.ts'); undefined when there is none. */
type ReadSrcFile = (srcRelative: string) => string | undefined

const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head'])
const routesFileOf = (t: Trace): string | undefined => (t.kind === 'module' && t.src.startsWith('routes/') ? t.src.slice('routes/'.length) : undefined)
const trimSlash = (p: string): string => p.replace(/\/+$/, '')
/**
 * Segment-wise, case-insensitive. A parameter, wildcard or pattern character in the first two segments may match
 * 'api'/'admin' and is 'maybe'. With `partialTail` the text is the static head of a template or concatenation: its
 * last segment is unfinished and may still grow into the expected one.
 */
const relationToAdmin = (p: string, partialTail = false): Relation => {
  const segs = (partialTail ? p : trimSlash(p)).split('/').slice(1)
  for (const [i, want] of ['api', 'admin'].entries()) {
    const seg = segs[i]
    if (seg === undefined) return partialTail ? 'maybe' : 'ancestor'
    if (partialTail && i === segs.length - 1) return want.startsWith(seg.toLowerCase()) ? 'maybe' : 'none'
    if (/[:*?+()[\]{}\\]/.test(seg)) return 'maybe'
    if (seg.toLowerCase() !== want) return 'none'
  }
  return 'admin'
}
/** `lit`, appended to the mount path `base` ('' = path-less), is a path under /api/admin. */
const landsUnderAdmin = (base: string, lit: string): boolean =>
  relationToAdmin(trimSlash(base) === '' ? lit : lit.startsWith('/') ? trimSlash(base) + lit : '') === 'admin'
const describeTrace = (t: Trace): string => (t.kind === 'unresolved' ? t.why : t.kind === 'module' ? `src/${t.src}` : t.kind)

/** Every string-literal text (and template head) under `node`. */
function literalsIn(node: ts.Node, out: string[] = []): string[] {
  if (ts.isStringLiteralLike(node)) out.push(node.text)
  else if (ts.isTemplateExpression(node)) out.push(node.head.text)
  ts.forEachChild(node, (child) => void literalsIn(child, out))
  return out
}

/** The literal text a template / `+` concatenation starts with ('' when it starts with something else). */
function staticHead(e: ts.Expression): string | undefined {
  if (ts.isTemplateExpression(e)) return e.head.text
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined
  return ts.isStringLiteralLike(e.left) ? e.left.text : staticHead(e.left) ?? ''
}

/** Parentheses, `as`, `!`, `satisfies` and `<T>` around an expression. */
const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) ? unwrap(e.expression) : e

function scanIndexMounts(indexText: string, readSrcFile: ReadSrcFile): MountScan {
  const sf = ts.createSourceFile('index.ts', indexText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const snippet = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, ' ').slice(0, 70)
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const imports = new Map<string, string>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause || st.importClause.isTypeOnly) continue
    const { name, namedBindings: nb } = st.importClause
    const names = [name, nb && ts.isNamespaceImport(nb) ? nb.name : undefined, ...(nb && ts.isNamedImports(nb) ? nb.elements.filter((el) => !el.isTypeOnly).map((el) => el.name) : [])]
    for (const id of names) if (id) imports.set(id.text, st.moduleSpecifier.text)
  }
  /** A relative import specifier, resolved from the module `from` (a src/-relative path) to a src/ file. */
  const resolveSpecifier = (from: string, spec: string): Trace => {
    if (!spec.startsWith('.')) return { kind: 'package' }
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\.(js|ts)$/, '')
    const src = [`${base}.ts`, `${base}/index.ts`].find((candidate) => readSrcFile(candidate) !== undefined)
    return src ? { kind: 'module', src } : { kind: 'unresolved', why: `'${spec}' resolves to no file` }
  }
  const fromSpecifier = (spec: string): Trace => resolveSpecifier('index.ts', spec)
  /** The `const` declaration (or binding destructured by one) named `name` in a block enclosing `from`. */
  const localConst = (name: string, from: ts.Node): ts.VariableDeclaration | ts.BindingElement | undefined => {
    for (let n: ts.Node | undefined = from.parent; n; n = n.parent) {
      for (const st of ts.isBlock(n) || ts.isSourceFile(n) ? n.statements : []) {
        if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return d
          const el = ts.isObjectBindingPattern(d.name) ? d.name.elements.find((b) => ts.isIdentifier(b.name) && b.name.text === name) : undefined
          if (el) return el
        }
      }
    }
    return undefined
  }
  const resolve = (e: ts.Expression, depth = 0): Trace[] => {
    const next = (x: ts.Expression): Trace[] => (depth > 8 ? [{ kind: 'unresolved', why: 'alias chain deeper than 8' }] : resolve(x, depth + 1))
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e)
      || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) return next(e.expression)
    if (ts.isConditionalExpression(e)) return [...next(e.whenTrue), ...next(e.whenFalse)]
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((el) => next(el))
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return [{ kind: 'none' }]
    if (ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [spec] = e.arguments
      return [spec && ts.isStringLiteralLike(spec) ? fromSpecifier(spec.text) : { kind: 'unresolved', why: 'import() of a non-literal' }]
    }
    if (ts.isCallExpression(e) || ts.isNewExpression(e) || ts.isPropertyAccessExpression(e)) return next(e.expression)
    if (!ts.isIdentifier(e)) return [{ kind: 'unresolved', why: `${ts.SyntaxKind[e.kind]} is not traced` }]
    const d = localConst(e.text, e)
    const init = d && (ts.isVariableDeclaration(d) ? d.initializer : (d.parent.parent as ts.VariableDeclaration).initializer)
    if (d) return init ? next(init) : [{ kind: 'unresolved', why: `const ${e.text} has no initializer` }]
    const spec = imports.get(e.text)
    return [spec !== undefined ? fromSpecifier(spec) : { kind: 'unresolved', why: `'${e.text}' is neither imported nor a local const` }]
  }
  /** Module traces of the ARGUMENTS of a handler call (`withAudit(adminRouter())`), calls inside them included, 3 deep — modules only, so an options object or a package adds no noise. */
  const argumentTraces = (e: ts.Expression, depth = 0): Trace[] => {
    const c = unwrap(e)
    if (depth > 3 || !(ts.isCallExpression(c) || ts.isNewExpression(c))) return []
    return [...(c.arguments ?? [])].flatMap((a) => [...resolve(a), ...argumentTraces(a, depth + 1)]).filter((t) => t.kind === 'module')
  }
  /** The path argument: literal path(s), `unknown` when a non-literal path could be under /api/admin; undefined = not a path the guard can place. */
  const pathOf = (raw: ts.Expression, depth = 0): { paths: string[]; unknown: boolean } | undefined => {
    const e = unwrap(raw)
    if (ts.isStringLiteralLike(e)) return { paths: [e.text], unknown: false }
    const head = staticHead(e)
    if (head !== undefined) {
      const rel = relationToAdmin(head, true)
      return rel === 'admin' ? { paths: [`${head}…`], unknown: false } : { paths: [], unknown: rel === 'maybe' }
    }
    if (ts.isRegularExpressionLiteral(e)) return { paths: [], unknown: true }
    if (ts.isArrayLiteralExpression(e)) {
      const parts = e.elements.map((el) => pathOf(el, depth + 1))
      if (parts.every((p) => p === undefined)) return undefined
      return { paths: parts.flatMap((p) => p?.paths ?? []), unknown: parts.some((p) => p === undefined || p.unknown) }
    }
    const d = ts.isIdentifier(e) && depth <= 8 ? localConst(e.text, e) : undefined
    return d && ts.isVariableDeclaration(d) && d.initializer ? pathOf(d.initializer, depth + 1) : undefined
  }
  const isThisApp = (e: ts.Node | undefined): boolean =>
    !!e && ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword && e.name.text === 'app'
  const aliasNames = new Set<string>()
  const collectAliases = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isThisApp(n.initializer)) aliasNames.add(n.name.text)
    ts.forEachChild(n, collectAliases)
  }
  collectAliases(sf)
  /** An identifier that names a member, property, parameter or binding rather than referring to a value. */
  const isDeclaredName = (n: ts.Identifier): boolean =>
    (ts.isPropertyAccessExpression(n.parent) || ts.isPropertyAssignment(n.parent) || ts.isPropertyDeclaration(n.parent)
      || ts.isMethodDeclaration(n.parent) || ts.isParameter(n.parent) || ts.isBindingElement(n.parent)) && n.parent.name === n
  /** `this.app`, or an identifier bound by `const <name> = this.app` in an enclosing block. */
  const isAppNode = (n: ts.Node): boolean => {
    if (isThisApp(n)) return true
    if (!ts.isIdentifier(n) || !aliasNames.has(n.text) || isDeclaredName(n)) return false
    const d = localConst(n.text, n)
    return !!d && ts.isVariableDeclaration(d) && isThisApp(d.initializer)
  }
  const isAppReceiver = (raw: ts.Expression): boolean => {
    const e = unwrap(raw)
    // Express returns the app from use(), set() and the verbs: the receiver of a chained call is the app too.
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) return isAppReceiver(e.expression.expression)
    return isAppNode(e)
  }
  const isReceiverUse = (n: ts.Node): boolean => (ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent)) && n.parent.expression === n
  const isAssigned = (n: ts.Node): boolean => ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.parent.left === n
  const isAliasDeclaration = (n: ts.Node): boolean => ts.isVariableDeclaration(n.parent) && (n.parent.initializer === n || n.parent.name === n)
  /** What `this.app` is handed to: the callee of the call / `new` it is an argument of, else the statement. */
  const handoffLabel = (n: ts.Node): string => {
    for (let child: ts.Node = n, p: ts.Node | undefined = n.parent; p; child = p, p = p.parent) {
      if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && (p.arguments ?? []).some((a) => a === child)) return `${ts.isNewExpression(p) ? 'new ' : ''}${snippet(p.expression)}`
      if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isExpressionStatement(p) || ts.isReturnStatement(p) || ts.isVariableStatement(p)) return snippet(p)
    }
    return snippet(n)
  }
  const literalCache = new Map<string, string[]>()
  const moduleLiterals = (src: string): string[] => {
    let lits = literalCache.get(src)
    if (!lits) literalCache.set(src, (lits = literalsIn(ts.createSourceFile(src, readSrcFile(src) ?? '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS))))
    return lits
  }
  const hopCache = new Map<string, ModuleTrace[]>()
  /** One import hop: the src/routes/ modules a module outside src/routes/ imports (relative value imports only). */
  const importedRoutes = (src: string): ModuleTrace[] => {
    let hops = hopCache.get(src)
    if (!hops) {
      const mod = ts.createSourceFile(src, readSrcFile(src) ?? '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
      hops = mod.statements.flatMap((st): ModuleTrace[] => {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.importClause?.isTypeOnly) return []
        const t = resolveSpecifier(src, st.moduleSpecifier.text)
        return t.kind === 'module' && routesFileOf(t) !== undefined ? [t] : []
      })
      hopCache.set(src, hops)
    }
    return hops
  }
  /** src/routes/ modules an inline closure names: identifiers in it (property names excluded) that trace to one. */
  const routesNamedBy = (fn: ts.Node): Trace[] => {
    const out: Trace[] = []
    const walk = (n: ts.Node): void => {
      const isName = (ts.isPropertyAccessExpression(n.parent) || ts.isPropertyAssignment(n.parent)) && n.parent.name === n
      if (ts.isIdentifier(n) && !isName) out.push(...resolve(n).filter((t) => routesFileOf(t) !== undefined))
      ts.forEachChild(n, walk)
    }
    ts.forEachChild(fn, walk)
    return out
  }

  const scan: MountScan = { inScope: [], failures: [], untraced: [], strayLiterals: [], handoffs: [] }
  /** Start positions of every node under a recognized mount's path argument (and the local consts it reads) — for (f). */
  const recognized = new Set<number>()
  const markRecognized = (n: ts.Node, depth = 0): void => {
    recognized.add(n.getStart(sf))
    if (ts.isIdentifier(n) && depth <= 8) {
      const d = localConst(n.text, n)
      if (d && ts.isVariableDeclaration(d) && d.initializer) markRecognized(d.initializer, depth + 1)
    }
    ts.forEachChild(n, (c) => markRecognized(c, depth))
  }
  const mount = (call: ts.CallExpression, name: ts.Node, method: string): void => {
    const line = lineOf(name)
    const where = `index.ts:${line}`
    const [first, ...rest] = call.arguments
    const p = first ? pathOf(first) : undefined
    if (p === undefined && method !== 'use') {
      scan.failures.push(`${where}: the path of this ${method}() is not a string literal or a local const literal and could be under ${ADMIN} — write it as a literal or extend this guard`)
      return
    }
    if (p !== undefined && first) markRecognized(first)
    if (p?.unknown) scan.failures.push(`${where}: the path of this ${method}() is not a string literal and could be under ${ADMIN} — write it as a literal or extend this guard`)
    const handlers = p === undefined ? [...call.arguments] : rest
    for (const prefix of p === undefined ? [''] : p.paths) {
      const shown = prefix === '' ? 'root' : prefix
      const rel = relationToAdmin(prefix)
      if (rel === 'maybe') {
        scan.failures.push(`${where}: ${method}('${prefix}', …) is a pattern that may serve ${ADMIN} — write a literal path under or outside ${ADMIN}, or extend this guard`)
        continue
      }
      if (rel === 'admin') {
        if (handlers.length === 0) scan.failures.push(`${where}: ${method}('${prefix}') has no handler`)
        for (const h of handlers) {
          const traces = resolve(h)
          const files = traces.map(routesFileOf)
          for (const file of files) if (file) scan.inScope.push({ line, prefix: shown, file })
          const stray = traces.filter((t, i) => t.kind !== 'none' && files[i] === undefined)
          if (stray.length > 0 || !files.some((f) => f !== undefined)) {
            scan.failures.push(`${where}: ${method}('${prefix}', …) handler \`${snippet(h)}\` does not resolve to a module under src/routes/ (${stray.map(describeTrace).join('; ') || 'no module'}) — mount a src/routes/ router or extend this guard; it is never skipped`)
          }
        }
      } else if (rel === 'ancestor' && method === 'use') {
        for (const h of handlers) {
          const inline = ts.isArrowFunction(h) || ts.isFunctionExpression(h)
          if (inline && literalsIn(h).some((lit) => landsUnderAdmin(prefix, lit))) scan.failures.push(`${where}: an inline ${shown} handler carries an ${ADMIN} path — move it into a router under src/routes/`)
          const traces = inline ? routesNamedBy(h) : [...resolve(h), ...argumentTraces(h)]
          for (const t of traces) {
            if (t.kind !== 'module') continue
            for (const m of [t, ...(routesFileOf(t) === undefined ? importedRoutes(t.src) : [])]) {
              if (!moduleLiterals(m.src).some((lit) => landsUnderAdmin(prefix, lit))) continue
              const file = routesFileOf(m)
              if (file) scan.inScope.push({ line, prefix: shown, file })
              else scan.failures.push(`${where}: the ${shown} handler \`${snippet(h)}\` comes from src/${m.src}, which carries ${ADMIN} paths outside src/routes/ — this guard classifies src/routes/ modules only: move it there or extend the guard`)
            }
          }
          if (!inline && traces.some((t) => t.kind === 'unresolved')) scan.untraced.push(`${where}: ${shown} handler \`${snippet(h)}\``)
        }
      }
    }
  }
  const literals: (ts.StringLiteralLike | ts.TemplateExpression)[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text
      if ((method === 'use' || (ROUTE_VERBS.has(method) && n.arguments.length >= 2)) && isAppReceiver(n.expression.expression)) mount(n, n.expression.name, method)
    }
    if (isAppNode(n) && !isReceiverUse(n) && !isAssigned(n) && !isAliasDeclaration(n)) scan.handoffs.push({ line: lineOf(n), callee: handoffLabel(n) })
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) literals.push(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  for (const lit of literals) {
    const text = ts.isTemplateExpression(lit) ? lit.head.text : lit.text
    if (ADMIN_LITERAL.test(text) && !recognized.has(lit.getStart(sf))) {
      scan.strayLiterals.push(`index.ts:${lineOf(lit)}: the literal '${text}' is not the path argument of a recognized mount — if it mounts routes, write \`this.app.use('${ADMIN}/…', router)\`; if it does not, extend backstop (f) deliberately`)
    }
  }
  return scan
}

/**
 * What the scanner suite hands to the scanner outside `it`/`test` bodies — discovery roots and files scanned by name
 * (a literal or a module-level const) — and, per file, whether a live test reaches the declaration that does it: the
 * suite's real scans run through helpers (`routerTree()`, `adminUsersOffenderKeys(…)`) consumed inside `it(…)`, so a
 * helper nobody calls, a skipped test or a deleted assertion must not count as coverage.
 */
function scannerTargets(text: string): { importsScanner: boolean; roots: string[]; byName: string[]; unconsumed: string[] } {
  const sf = ts.createSourceFile('scanner-suite.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const consts = new Map<string, string>()
  const out = { importsScanner: false, roots: [] as string[], byName: [] as string[], unconsumed: [] as string[] }
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === '../utils/response-error-echo-scan') {
      const nb = st.importClause?.namedBindings
      const names = nb && ts.isNamedImports(nb) ? nb.elements.map((el) => el.name.text) : []
      out.importsScanner = names.includes('discoverMountedRouterTree') && names.includes('scanResponseErrorEcho')
    }
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteralLike(d.initializer)) consts.set(d.name.text, d.initializer.text)
  }
  /** `it`, `test`, `describe` — also behind `.skip`, `.only`, `.each(…)(…)`: the base name and the modifier. */
  const testCallOf = (c: ts.CallExpression): { base: string; modifier: string | undefined } => {
    const callee = ts.isCallExpression(c.expression) ? c.expression.expression : c.expression
    return ts.isPropertyAccessExpression(callee) ? { base: callee.expression.getText(sf), modifier: callee.name.text } : { base: callee.getText(sf), modifier: undefined }
  }
  const isTestCall = (c: ts.CallExpression): boolean => ['it', 'test'].includes(testCallOf(c).base)
  const isLive = (c: ts.CallExpression): boolean => !['skip', 'todo', 'fails'].includes(testCallOf(c).modifier ?? '')
  const isSkippedDescribe = (c: ts.CallExpression): boolean => testCallOf(c).base === 'describe' && !isLive(c)
  const targets: { file: string; decl: string | undefined }[] = []
  const declarations = new Map<string, ts.Node>() // name → function or variable declaration outside test bodies
  const liveRefs = new Set<string>() // identifiers a live test mentions
  const enclosingDecl = (n: ts.Node): string | undefined => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) return p.name.text
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    }
    return undefined
  }
  const collectRefs = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) liveRefs.add(n.text)
    ts.forEachChild(n, collectRefs)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && isSkippedDescribe(n)) return
    // A call inside a test body is an assertion or the suite's own self-check, not its scan — but it says what the suite consumes.
    if (ts.isCallExpression(n) && isTestCall(n)) {
      if (isLive(n)) collectRefs(n)
      return
    }
    if (ts.isFunctionDeclaration(n) && n.name) declarations.set(n.name.text, n)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) declarations.set(n.name.text, n)
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments.length > 0) {
      const a = n.arguments[0]
      const file = ts.isStringLiteralLike(a) ? a.text : ts.isIdentifier(a) ? consts.get(a.text) : undefined
      if (file !== undefined && n.expression.text === 'discoverMountedRouterTree') { out.roots.push(file); targets.push({ file, decl: enclosingDecl(n) }) }
      if (file !== undefined && n.expression.text === 'scanResponseErrorEcho') { out.byName.push(file); targets.push({ file, decl: enclosingDecl(n) }) }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  // A declaration is consumed when a live test mentions it, directly or through other declarations it mentions.
  const reached = new Set<string>()
  const queue = [...liveRefs]
  while (queue.length > 0) {
    const name = queue.pop() as string
    if (reached.has(name)) continue
    reached.add(name)
    const decl = declarations.get(name)
    if (decl) {
      const walk = (x: ts.Node): void => { if (ts.isIdentifier(x)) queue.push(x.text); ts.forEachChild(x, walk) }
      walk(decl)
    }
  }
  const files = [...new Set(targets.map((t) => t.file))]
  out.unconsumed = files.filter((file) => !targets.some((t) => t.file === file && t.decl !== undefined && reached.has(t.decl)))
  return out
}

const keysOf = (s: MountScan): string[] => s.inScope.map((m) => `${m.prefix} -> ${m.file}`)
const isListed = (file: string): boolean => SCANNED.includes(file) || Object.keys(ALLOWLIST).includes(file)
const uncovered = (inScope: readonly InScopeMount[]): string[] => inScope.filter((m) => !isListed(m.file)).map((m) =>
  `${m.file} (index.ts:${m.line}, ${m.prefix}) is not covered by a values-free 5xx scan — extend the scanner in tests/unit/admin-tree-5xx-values-free.test.ts to it and list it in SCANNED, or add an ALLOWLIST entry with a reason, a date, an echo claim and a follow-up`)
const staleEntries = (inScope: readonly InScopeMount[]): string[] => [...SCANNED, ...Object.keys(ALLOWLIST)]
  .filter((file) => !inScope.some((m) => m.file === file))
  .map((file) => `${file} is listed but no in-scope index.ts mount reaches it — remove the stale entry`)

const srcCache = new Map<string, string | undefined>()
const readSrcFile: ReadSrcFile = (rel) => {
  const abs = path.join(SRC, rel)
  if (!srcCache.has(rel)) srcCache.set(rel, fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : undefined)
  return srcCache.get(rel)
}
let realCache: MountScan | undefined
const realScan = (): MountScan => (realCache ??= scanIndexMounts(fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8'), readSrcFile))

describe('every /api/admin mount in src/index.ts is covered by a values-free 5xx scan or allowlisted with a reason', () => {
  it('(a) every in-scope mount is in SCANNED or ALLOWLIST, and no mount failed closed', () => {
    expect({ failures: realScan().failures, uncovered: uncovered(realScan().inScope) }).toEqual({ failures: [], uncovered: [] })
  })
  it('(b) no file is in both SCANNED and ALLOWLIST', () => {
    expect(SCANNED.filter((file) => Object.keys(ALLOWLIST).includes(file))).toEqual([])
  })
  it('(c) every SCANNED and ALLOWLIST entry still has an in-scope mount (stale entries must be removed)', () => {
    expect(staleEntries(realScan().inScope)).toEqual([])
  })
  it('(d) every SCANNED file is handed to the scanner by admin-tree-5xx-values-free.test.ts outside its own tests, and a live test reaches that declaration', () => {
    const targets = scannerTargets(fs.readFileSync(SCANNER_SUITE, 'utf8'))
    expect(targets.importsScanner).toBe(true)
    expect(SCANNED.filter((file) => !targets.roots.includes(file) && !targets.byName.includes(file))).toEqual([])
    expect(targets.unconsumed.filter((file) => SCANNED.includes(file))).toEqual([])
    expect(targets.roots).toContain('admin-routes.ts') // the discovery root
    expect(targets.byName).toContain('admin-users.ts') // the ADMIN_USERS constant
  })
  it('(e) extraction is not vacuous: the pinned in-scope mounts are all found on the real index.ts', () => {
    const found = keysOf(realScan())
    expect(found.length).toBeGreaterThan(0)
    expect(EXPECTED_IN_SCOPE.filter((key) => !found.includes(key))).toEqual([])
  })
  it('(f) no /api/admin literal in index.ts is outside a recognized mount (backstop for the forms the mount walk cannot see)', () => {
    expect(realScan().strayLiterals).toEqual([])
  })
  it('(g) this.app is handed to exactly the pinned callees — a new hand-off may mount routes this guard cannot see', () => {
    const handoffs = realScan().handoffs
    expect({
      unexpected: handoffs.filter((h) => !APP_HANDOFFS.includes(h.callee)).map((h) => `index.ts:${h.line}: this.app is handed to \`${h.callee}\` — review what it mounts, then extend APP_HANDOFFS deliberately`),
      stale: APP_HANDOFFS.filter((callee) => !handoffs.some((h) => h.callee === callee)),
    }).toEqual({ unexpected: [], stale: [] })
  })
  it('(h) every ALLOWLIST echo claim holds against the scanner today: none = zero offenders, known = at least one', () => {
    const checked = Object.entries(ALLOWLIST).map(([file, e]) => {
      const text = readSrcFile(`routes/${file}`)
      const offenders = text === undefined ? -1 : scanResponseErrorEcho(file, text).offenders.length
      return { file, echo: e.echo, offenders, holds: e.echo === 'none' ? offenders === 0 : offenders > 0 }
    })
    expect(checked.filter((c) => !c.holds)).toEqual([])
  })
  it('every ALLOWLIST entry carries a reason, an ISO date and a follow-up', () => {
    for (const [file, e] of Object.entries(ALLOWLIST)) {
      expect({ file, reason: e.reason.length > 40, since: /^\d{4}-\d{2}-\d{2}$/.test(e.since), followUp: e.followUp.length > 20 })
        .toEqual({ file, reason: true, since: true, followUp: true })
    }
  })
  it('no path-less handler in index.ts is left untraced (an untraceable one could serve /api/admin unseen)', () => {
    expect(realScan().untraced).toEqual([])
  })
})

// ── self-checks: synthetic index.ts text through the same scanIndexMounts (nothing is written to src/) ──

const SYNTH_FILES: Readonly<Record<string, string>> = {
  'routes/foo.ts': "router.get('/list', h)", 'routes/bar.ts': "router.get('/api/admin/bar', h)", 'routes/r.ts': "router.get('/', h)",
  'routes/views.ts': "router.get('/api/admin/not-under-views', h)", 'routes/api.ts': "router.get('/admin/z', h)",
  'services/runtime.ts': "router.get('/api/admin/rt', h)",
  'services/runtime2.ts': "import { barRouter } from '../routes/bar'\nexport const runtime2 = { router: barRouter() }",
  'services/runtime3.ts': "import { fooRouter } from '../routes/foo'\nexport const runtime3 = { router: fooRouter() }",
  'middleware/audit.ts': 'export const withAudit = (r: unknown) => r',
}
const SYNTH_IMPORTS = [
  "import express from 'express'",
  "import { fooRouter } from './routes/foo'", "import { barRouter } from './routes/bar'", "import { viewsRouter } from './routes/views'",
  "import r from './routes/r'", "import * as api from './routes/api'", "import { runtime } from './services/runtime'",
  "import { runtime2 } from './services/runtime2'", "import { runtime3 } from './services/runtime3'", "import { withAudit } from './middleware/audit'",
].join('\n')
const EMPTY: MountScan = { inScope: [], failures: [], untraced: [], strayLiterals: [], handoffs: [] }
/** index.ts-shaped text: the ten imports, then `body` inside a method — its first line is index.ts:13. */
const synth = (body: string): MountScan =>
  scanIndexMounts(`${SYNTH_IMPORTS}\nclass Server {\n  setup(param: any) {\n${body}\n  }\n}\n`, (rel) => SYNTH_FILES[rel])
const L = 13

describe('self-checks on synthetic index.ts text (same extraction code path as the real check)', () => {
  it('(i) an /api/admin mount of an unlisted router is in scope and classified as uncovered', () => {
    const s = synth("    this.app.use('/api/admin/foo', fooRouter())")
    expect({ keys: keysOf(s), failures: s.failures }).toEqual({ keys: ['/api/admin/foo -> foo.ts'], failures: [] })
    expect(uncovered(s.inScope)).toEqual([expect.stringContaining(`foo.ts (index.ts:${L}, /api/admin/foo) is not covered`)])
    expect(staleEntries(s.inScope)).toHaveLength(SCANNED.length + Object.keys(ALLOWLIST).length)
  })
  it('(ii) a path-less mount whose router defines an /api/admin path is in scope; one that does not is not', () => {
    expect(keysOf(synth('    this.app.use(barRouter())\n    this.app.use(fooRouter())'))).toEqual(['root -> bar.ts'])
  })
  it('(iii) a /api/views mount is ignored, even when its router mentions /api/admin', () => {
    expect(synth("    this.app.use('/api/views', viewsRouter())")).toEqual(EMPTY)
  })
  it('(iv) an /api/admin mount whose handler does not trace to src/routes/ fails closed naming the line — never dropped', () => {
    const s = synth("    this.app.use('/api/admin/x', wrap(x))\n    this.app.use('/api/admin/y', (req, res) => res.end())\n    this.app.use('/api/admin/z', runtime.router)")
    expect(s.inScope).toEqual([])
    expect(s.failures).toEqual([
      expect.stringMatching(new RegExp(`^index\\.ts:${L}: use\\('/api/admin/x'.*'wrap' is neither imported`)),
      expect.stringMatching(new RegExp(`^index\\.ts:${L + 1}: .*ArrowFunction is not traced`)),
      expect.stringMatching(new RegExp(`^index\\.ts:${L + 2}: .*src/services/runtime\\.ts`)),
    ])
  })
  it('(v) an array path is recorded per element and its /api/admin element is in scope', () => {
    expect(keysOf(synth("    this.app.use(['/api/admin/a', '/api/other'], r())"))).toEqual(['/api/admin/a -> r.ts'])
  })
  it('(vi) a /api mount whose router defines /admin/… lands under /api/admin and is in scope (namespace member)', () => {
    expect(keysOf(synth("    this.app.use('/api', api.router)"))).toEqual(['/api -> api.ts'])
  })
  it('(vii) `const app = this.app` and a conditional const router are followed; the alias is not a hand-off', () => {
    const s = synth("    const app = this.app\n    const q = param ? fooRouter() : null\n    app.use('/api/admin/q', q)")
    expect({ keys: keysOf(s), failures: s.failures, handoffs: s.handoffs }).toEqual({ keys: ['/api/admin/q -> foo.ts'], failures: [], handoffs: [] })
  })
  it('(viii) a non-literal path that could be under /api/admin fails closed; one that cannot is ignored', () => {
    const s = synth('    this.app.use(`/api/${param}`, fooRouter())\n    this.app.use(`/api/v2/${param}`, fooRouter())\n    this.app.use(`/api/admin/${param}`, fooRouter())')
    expect({ keys: keysOf(s), failures: s.failures }).toEqual({ keys: ['/api/admin/… -> foo.ts'], failures: [expect.stringMatching(new RegExp(`^index\\.ts:${L}: the path`))] })
  })
  it('(ix) path-less: an /api/admin path in a module outside src/routes/ or in an inline closure fails, an untraceable handler is listed, a closure is followed', () => {
    const s = synth('    this.app.use(runtime.router)\n    this.app.use(param)\n    this.app.use((req, res, next) => barRouter()(req, res, next))\n    this.app.use((req, res, next) => (req.path === "/api/admin/legacy" ? res.end() : next()))')
    expect(s.failures).toEqual([expect.stringMatching(new RegExp(`^index\\.ts:${L}: .*src/services/runtime\\.ts`)), expect.stringMatching(new RegExp(`^index\\.ts:${L + 3}: an inline root handler carries`))])
    expect(s.untraced).toEqual([expect.stringMatching(new RegExp(`^index\\.ts:${L + 1}: root handler \`param\``))])
    expect(keysOf(s)).toEqual(['root -> bar.ts'])
    expect(s.strayLiterals).toEqual([expect.stringMatching(new RegExp(`^index\\.ts:${L + 3}: the literal '/api/admin/legacy'`))])
  })
  it('(x) an inline /api/admin route registered with this.app.get fails closed; a non-admin one is ignored', () => {
    const s = synth("    this.app.get('/api/admin/ping', (req, res) => res.end())\n    this.app.get('/health', (req, res) => res.end())")
    expect(s.failures).toEqual([expect.stringMatching(new RegExp(`^index\\.ts:${L}: get\\('/api/admin/ping'`))])
  })
  it('(xi) a chained mount is a mount: Express returns the app from use() and the verbs', () => {
    const s = synth("    this.app.use(fooRouter()).use('/api/admin/chain', barRouter())\n    this.app\n      .use(fooRouter())\n      .get('/api/admin/ping', (req, res) => res.status(500).json({ error: String(req) }))")
    expect({ keys: keysOf(s), stray: s.strayLiterals }).toEqual({ keys: ['/api/admin/chain -> bar.ts'], stray: [] })
    expect(s.failures).toEqual([expect.stringMatching(new RegExp(`^index\\.ts:${L + 3}: get\\('/api/admin/ping'`))])
  })
  it('(xii) a verb route whose path is not a literal fails closed; a local const literal, parentheses and `as const` are read', () => {
    const s = synth("    this.app.get(param.adminPing, fooRouter())\n    let q = '/api/admin/q'\n    this.app.get(q, fooRouter())\n    const P = '/api/admin/p'\n    this.app.get(P, fooRouter())\n    this.app.get(('/api/admin/c' as const), fooRouter())\n    this.app.get(`/api/v2/${param}`, fooRouter())")
    expect(s.failures).toEqual([expect.stringMatching(new RegExp(`^index\\.ts:${L}: the path of this get\\(\\)`)), expect.stringMatching(new RegExp(`^index\\.ts:${L + 2}: the path of this get\\(\\)`))])
    expect(keysOf(s)).toEqual(['/api/admin/p -> foo.ts', '/api/admin/c -> foo.ts'])
    expect(s.strayLiterals).toEqual([expect.stringMatching(new RegExp(`^index\\.ts:${L + 1}: the literal '/api/admin/q'`))])
  })
  it('(xiii) handing this.app to a call, a constructor, an object or a return is recorded with its callee; receiver use is not', () => {
    const s = synth('    mountAdminExports(this.app)\n    const gw = new Gateway(this.app, {})\n    this.app.use(fooRouter())\n    const app = this.app\n    app.use(fooRouter())\n    helper({ app })\n    return this.app')
    expect(s.handoffs).toEqual([{ line: L, callee: 'mountAdminExports' }, { line: L + 1, callee: 'new Gateway' }, { line: L + 5, callee: 'helper' }, { line: L + 6, callee: 'return this.app' }])
  })
  it('(xiv) backstop (f): an /api/admin literal (any case) that is not the path of a recognized mount is reported — a Router built in index.ts, for one', () => {
    const s = synth("    const extra = express.Router()\n    extra.get('/api/Admin/extra', (req, res) => res.end())\n    this.app.use(extra)\n    this.app.use('/api/admin/ok', fooRouter())\n    this.app.use(['/api/admin/arr', '/other'], fooRouter())")
    expect(s.strayLiterals).toEqual([expect.stringMatching(new RegExp(`^index\\.ts:${L + 1}: the literal '/api/Admin/extra'`))])
    expect({ keys: keysOf(s), failures: s.failures, untraced: s.untraced }).toEqual({ keys: ['/api/admin/ok -> foo.ts', '/api/admin/arr -> foo.ts'], failures: [], untraced: [] })
  })
  it("(xv) a parameter, wildcard or pattern in the first two segments may serve /api/admin and fails closed; '/api/admin-x' and '/api/v2/:x' do not; case does not matter", () => {
    const s = synth("    this.app.use('/api/:area/exports', fooRouter())\n    this.app.use('/api/*', fooRouter())\n    this.app.use('/api/admin-x', fooRouter())\n    this.app.use('/api/v2/:x', fooRouter())\n    this.app.use('/API/ADMIN/caps', fooRouter())")
    expect(s.failures).toEqual([expect.stringMatching(new RegExp(`^index\\.ts:${L}: use\\('/api/:area/exports', …\\) is a pattern`)), expect.stringMatching(new RegExp(`^index\\.ts:${L + 1}: use\\('/api/\\*', …\\) is a pattern`))])
    expect({ keys: keysOf(s), stray: s.strayLiterals }).toEqual({ keys: ['/API/ADMIN/caps -> foo.ts'], stray: [] })
  })
  it('(xvi) the arguments of a path-less or /api handler call are traced: a wrapped admin router is in scope, an options object or a plain router adds nothing', () => {
    const s = synth("    this.app.use(withAudit(barRouter()))\n    this.app.use('/api', withAudit(api.router))\n    this.app.use(withAudit({ level: 1 }))\n    this.app.use(withAudit(fooRouter()))")
    expect(s).toEqual({ ...EMPTY, inScope: [{ line: L, prefix: 'root', file: 'bar.ts' }, { line: L + 1, prefix: '/api', file: 'api.ts' }] })
  })
  it('(xvii) a module outside src/routes/ is followed one import hop into the src/routes/ routers it composes', () => {
    expect(synth('    this.app.use(runtime2.router)\n    this.app.use(runtime3.router)')).toEqual({ ...EMPTY, inScope: [{ line: L, prefix: 'root', file: 'bar.ts' }] })
  })
  const SUITE_HEAD = [
    "import { discoverMountedRouterTree, scanResponseErrorEcho } from '../utils/response-error-echo-scan'",
    "const ADMIN_USERS = 'admin-users.ts'",
    "function routerTree() { return discoverMountedRouterTree('admin-routes.ts', read, rel) }",
    'function treeFiles() { return routerTree().files }',
    'function userKeys(s: string) { return scanResponseErrorEcho(ADMIN_USERS, s).offenders }',
  ].join('\n')
  const suite = (tests: string) => scannerTargets(`${SUITE_HEAD}\ndescribe('suite', () => {\n${tests}\n})\n`)
  it('(xviii) check (d) sees what the suite hands to the scanner outside tests, and whether a live test reaches it', () => {
    expect(suite("  it('a', () => { expect(treeFiles()).toEqual([]) })\n  it('b', () => { expect(userKeys('')).toEqual([]) })"))
      .toEqual({ importsScanner: true, roots: ['admin-routes.ts'], byName: ['admin-users.ts'], unconsumed: [] })
    expect(suite("  it('a', () => { expect(treeFiles()).toEqual([]) })\n  it.skip('b', () => { expect(userKeys('')).toEqual([]) })").unconsumed).toEqual(['admin-users.ts'])
    expect(suite("  it('a', () => { expect(treeFiles()).toEqual([]) })").unconsumed).toEqual(['admin-users.ts'])
    expect(suite("  it('c', () => { scanResponseErrorEcho('foo.ts', '') })").byName).toEqual(['admin-users.ts']) // a call inside a test body is not a scan
  })
})

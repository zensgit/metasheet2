/**
 * Coverage guard — every /api/admin mount in src/index.ts is held to a values-free 5xx scan, or is allowlisted
 * below with a reason, a date and a follow-up.
 *
 * WHY. tests/unit/admin-tree-5xx-values-free.test.ts keeps caught-error text out of 5xx bodies only in the files it
 * reaches: the tree it DISCOVERS from routes/admin-routes.ts (mounted at /api/admin) and routes/admin-users.ts, scanned
 * BY NAME because index.ts mounts it path-less. The /api/admin/directory family, /api/admin/canary and the path-less
 * routes/permissions.ts (/api/admin/permission-templates) were reached by no scan, and nothing would have flagged the
 * next router mounted under /api/admin (docs/development/autonomous-run-20260928-29-integration-outcome.md §12,
 * '挂在 /api/admin 下的根级路由'). This guard enumerates the mounts and makes each one an explicit decision.
 *
 * HOW. index.ts is parsed with the TypeScript compiler API (no type checker). Mounts are `this.app.use(…)` and
 * `this.app.get|post|put|patch|delete|all(path, …)`, also through `const app = this.app` (only that alias form).
 * Literal paths are recorded (each literal of an array; 'root' when path-less) and each handler is traced to a module
 * through imports, calls / `new` / members of them, enclosing-block `const`s (also destructured from
 * `await import('./x')`), `?:`, `await`, parentheses and type assertions. It FAILS CLOSED, naming the index.ts line, when
 *   1. a mount under /api/admin has a handler that does not trace to a module under src/routes/ (an inline function,
 *      an unknown identifier, a parameter, package middleware, a module elsewhere);
 *   2. a path-less mount, or one at '/' or '/api', reaches a module outside src/routes/ — or is an inline closure —
 *      with a string literal landing under /api/admin once appended to the mount path (a src/routes/ module with one
 *      puts the mount in scope; a closure is also followed into the src/routes/ modules it names); a handler there
 *      that cannot be traced at all is listed in `untraced`, which must stay empty;
 *   3. a non-literal path could be under /api/admin (a template or concatenation with such a static head, a RegExp).
 * Everything else is ignored.
 *
 * NOT COVERED, deliberately: `router.use(…)` inside route files (the tree under admin-routes.ts is the AST scanner's
 * own discovery); mounts made outside index.ts (plugin routes, installMetrics(this.app), a module mounting on an app it
 * is handed); a path held in an imported constant (read as a handler); path-less package middleware;
 * `this.app.route(…)`; what a closure reaches through `this` or a parameter. SCANNED is backed by the scanner suite
 * handing the file to the scanner outside its own `it(…)` self-tests (d), not by that suite being green — it runs in
 * the same lane.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../src')
const SCANNER_SUITE = path.join(HERE, 'admin-tree-5xx-values-free.test.ts')
const ADMIN = '/api/admin'

/** Routers whose 5xx branches an existing values-free scanner covers — each one backed by check (d). */
const SCANNED: readonly string[] = ['admin-routes.ts', 'admin-users.ts']

interface AllowlistEntry { reason: string; since: string; followUp: string }
const SINCE = '2026-10-09'
const OUTCOME_S12 = 'docs/development/autonomous-run-20260928-29-integration-outcome.md §12'
const ADD_TO_SCAN = `add the file to the values-free AST scan in tests/unit/admin-tree-5xx-values-free.test.ts, then move it to SCANNED (${OUTCOME_S12}, '挂在 /api/admin 下的根级路由')`
const UNSCANNED = 'Not reached by any values-free AST scan yet.'
const FIXED_500S = 'each jsonError with a literal sentence, the error text going to logger.error only. The scanner, run on the file on 2026-10-09, found no echo.'

/** Mounted under /api/admin but not scanned: why, since when, and what closes it. */
const ALLOWLIST: Readonly<Record<string, AllowlistEntry>> = {
  'admin-directory.ts': { since: SINCE, followUp: `${OUTCOME_S12}, 'admin-directory.ts 的 500 回显' (#6163 S6)`, reason: 'KNOWN ECHO: 500 branches answer jsonError(res, 500, CODE, readErrorMessage(error, fallback)), i.e. the caught text, and the sync start picks 404 vs 500 by a regex over that text (the scanner, run on the file on 2026-10-09, reports 33 offenders). The fix needs typed validation errors first.' },
  'admin-directory-local.ts': { since: SINCE, followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Its one 500 (handleLocalDirectoryError) sends the fixed fallbackMessage and logs the text; 4xx carry typed, developer-authored messages. The scanner, run on the file on 2026-10-09, found no echo.` },
  'admin-directory-department-bindings.ts': { since: SINCE, followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Three 500s, ${FIXED_500S}` },
  'admin-directory-routing-policy.ts': { since: SINCE, followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Three 500s, ${FIXED_500S}` },
  'admin-directory-org-transfers.ts': { since: SINCE, followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Its one 500 (handleOrgTransferError) sends the fixed fallbackMessage and logs fixed metadata only; 4xx carry typed messages. The scanner, run on the file on 2026-10-09, found no echo.` },
  'canary-routes.ts': { since: SINCE, followUp: ADD_TO_SCAN, reason: `${UNSCANNED} 6 fixed-status 5xx branches with literal bodies; no error-text echo found on 2026-10-09.` },
  'permissions.ts': { since: SINCE, followUp: ADD_TO_SCAN, reason: `${UNSCANNED} Mounted path-less; defines /api/admin/permission-templates and …/apply. 12 fixed-status 5xx branches with literal bodies; no error-text echo found on 2026-10-09.` },
}

/** Today's in-scope mounts, `<path> -> <file under src/routes/>`, pinned so an extraction regression cannot pass (e). */
const EXPECTED_IN_SCOPE: readonly string[] = [
  '/api/admin -> admin-routes.ts', 'root -> admin-users.ts', 'root -> permissions.ts', '/api/admin/canary -> canary-routes.ts',
  '/api/admin/directory -> admin-directory.ts', '/api/admin/directory/local -> admin-directory-local.ts',
  '/api/admin/directory/org-transfers -> admin-directory-org-transfers.ts',
  '/api/admin/directory/department-bindings -> admin-directory-department-bindings.ts',
  '/api/admin/directory/routing-policy -> admin-directory-routing-policy.ts',
]

// ── extraction: pure functions of (index.ts text, src reader), shared by the real and the synthetic checks ──

interface InScopeMount { line: number; prefix: string; file: string }
interface MountScan { inScope: InScopeMount[]; failures: string[]; untraced: string[] }
type Trace = { kind: 'module'; src: string } | { kind: 'package' } | { kind: 'none' } | { kind: 'unresolved'; why: string }
/** Reads a file by its path relative to src/ ('routes/x.ts'); undefined when there is none. */
type ReadSrcFile = (srcRelative: string) => string | undefined

const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all'])
const routesFileOf = (t: Trace): string | undefined => (t.kind === 'module' && t.src.startsWith('routes/') ? t.src.slice('routes/'.length) : undefined)
const trimSlash = (p: string): string => p.replace(/\/+$/, '')
/** `lit`, appended to the mount path `base` ('' = path-less), is a path under /api/admin. */
const landsUnderAdmin = (base: string, lit: string): boolean =>
  (trimSlash(base) === '' ? lit : lit.startsWith('/') ? trimSlash(base) + lit : '').startsWith(ADMIN)
const isAdminAncestor = (p: string): boolean => trimSlash(p) === '' || ADMIN.startsWith(`${trimSlash(p)}/`)
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

function scanIndexMounts(indexText: string, readSrcFile: ReadSrcFile): MountScan {
  const sf = ts.createSourceFile('index.ts', indexText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const snippet = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, ' ').slice(0, 70)
  const imports = new Map<string, string>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause || st.importClause.isTypeOnly) continue
    const { name, namedBindings: nb } = st.importClause
    const names = [name, nb && ts.isNamespaceImport(nb) ? nb.name : undefined, ...(nb && ts.isNamedImports(nb) ? nb.elements.filter((el) => !el.isTypeOnly).map((el) => el.name) : [])]
    for (const id of names) if (id) imports.set(id.text, st.moduleSpecifier.text)
  }
  const fromSpecifier = (spec: string): Trace => {
    if (!spec.startsWith('.')) return { kind: 'package' }
    const base = path.posix.normalize(spec).replace(/\.(js|ts)$/, '')
    const src = [`${base}.ts`, `${base}/index.ts`].find((candidate) => readSrcFile(candidate) !== undefined)
    return src ? { kind: 'module', src } : { kind: 'unresolved', why: `'${spec}' resolves to no file` }
  }
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
  /** The path argument: literal path(s), `unknown` when a non-literal path could be under /api/admin; undefined = path-less. */
  const pathOf = (e: ts.Expression, depth = 0): { paths: string[]; unknown: boolean } | undefined => {
    if (ts.isStringLiteralLike(e)) return { paths: [e.text], unknown: false }
    const head = staticHead(e)
    if (head !== undefined) return head.startsWith(ADMIN) ? { paths: [`${head}…`], unknown: false } : { paths: [], unknown: ADMIN.startsWith(head) }
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
  const isAppReceiver = (e: ts.Expression): boolean => {
    const d = ts.isIdentifier(e) ? localConst(e.text, e) : undefined
    return isThisApp(e) || (!!d && ts.isVariableDeclaration(d) && isThisApp(d.initializer))
  }
  const literalCache = new Map<string, string[]>()
  const moduleLiterals = (src: string): string[] => {
    let lits = literalCache.get(src)
    if (!lits) literalCache.set(src, (lits = literalsIn(ts.createSourceFile(src, readSrcFile(src) ?? '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS))))
    return lits
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

  const scan: MountScan = { inScope: [], failures: [], untraced: [] }
  const mount = (call: ts.CallExpression, method: string): void => {
    const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1
    const where = `index.ts:${line}`
    const [first, ...rest] = call.arguments
    const p = first ? pathOf(first) : undefined
    if (p === undefined && method !== 'use') return
    if (p?.unknown) scan.failures.push(`${where}: the path of this ${method}() is not a string literal and could be under ${ADMIN} — write it as a literal or extend this guard`)
    const handlers = p === undefined ? [...call.arguments] : rest
    for (const prefix of p === undefined ? [''] : p.paths) {
      const shown = prefix === '' ? 'root' : prefix
      if (prefix.startsWith(ADMIN)) {
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
      } else if (method === 'use' && isAdminAncestor(prefix)) {
        for (const h of handlers) {
          const inline = ts.isArrowFunction(h) || ts.isFunctionExpression(h)
          if (inline && literalsIn(h).some((lit) => landsUnderAdmin(prefix, lit))) scan.failures.push(`${where}: an inline ${shown} handler carries an ${ADMIN} path — move it into a router under src/routes/`)
          const traces = inline ? routesNamedBy(h) : resolve(h)
          for (const t of traces) {
            if (t.kind !== 'module' || !moduleLiterals(t.src).some((lit) => landsUnderAdmin(prefix, lit))) continue
            const file = routesFileOf(t)
            if (file) scan.inScope.push({ line, prefix: shown, file })
            else scan.failures.push(`${where}: the ${shown} handler \`${snippet(h)}\` comes from src/${t.src}, which carries ${ADMIN} paths outside src/routes/ — this guard classifies src/routes/ modules only: move it there or extend the guard`)
          }
          if (!inline && traces.some((t) => t.kind === 'unresolved')) scan.untraced.push(`${where}: ${shown} handler \`${snippet(h)}\``)
        }
      }
    }
  }
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text
      if ((method === 'use' || (ROUTE_VERBS.has(method) && n.arguments.length >= 2)) && isAppReceiver(n.expression.expression)) mount(n, method)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return scan
}

/** What the scanner suite hands to the scanner outside `it`/`test` bodies: discovery roots, files scanned by name (literal or module-level const). */
function scannerTargets(text: string): { importsScanner: boolean; roots: string[]; byName: string[] } {
  const sf = ts.createSourceFile('scanner-suite.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const consts = new Map<string, string>()
  const out = { importsScanner: false, roots: [] as string[], byName: [] as string[] }
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === '../utils/response-error-echo-scan') {
      const nb = st.importClause?.namedBindings
      const names = nb && ts.isNamedImports(nb) ? nb.elements.map((el) => el.name.text) : []
      out.importsScanner = names.includes('discoverMountedRouterTree') && names.includes('scanResponseErrorEcho')
    }
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteralLike(d.initializer)) consts.set(d.name.text, d.initializer.text)
  }
  const isTestCall = (c: ts.CallExpression): boolean => ['it', 'test'].includes((ts.isPropertyAccessExpression(c.expression) ? c.expression.expression : c.expression).getText(sf))
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && isTestCall(n)) return // a call inside a test body is the suite's own self-check, not its scan
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments.length > 0) {
      const a = n.arguments[0]
      const file = ts.isStringLiteralLike(a) ? a.text : ts.isIdentifier(a) ? consts.get(a.text) : undefined
      if (file !== undefined && n.expression.text === 'discoverMountedRouterTree') out.roots.push(file)
      if (file !== undefined && n.expression.text === 'scanResponseErrorEcho') out.byName.push(file)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

const keysOf = (s: MountScan): string[] => s.inScope.map((m) => `${m.prefix} -> ${m.file}`)
const isListed = (file: string): boolean => SCANNED.includes(file) || Object.keys(ALLOWLIST).includes(file)
const uncovered = (inScope: readonly InScopeMount[]): string[] => inScope.filter((m) => !isListed(m.file)).map((m) =>
  `${m.file} (index.ts:${m.line}, ${m.prefix}) is not covered by a values-free 5xx scan — extend the scanner in tests/unit/admin-tree-5xx-values-free.test.ts to it and list it in SCANNED, or add an ALLOWLIST entry with a reason, a date and a follow-up`)
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
  it('(d) every SCANNED file is handed to the scanner by admin-tree-5xx-values-free.test.ts, outside its own self-tests', () => {
    const targets = scannerTargets(fs.readFileSync(SCANNER_SUITE, 'utf8'))
    expect(targets.importsScanner).toBe(true)
    expect(SCANNED.filter((file) => !targets.roots.includes(file) && !targets.byName.includes(file))).toEqual([])
    expect(targets.roots).toContain('admin-routes.ts') // the discovery root
    expect(targets.byName).toContain('admin-users.ts') // the ADMIN_USERS constant
  })
  it('(e) extraction is not vacuous: the pinned in-scope mounts are all found on the real index.ts', () => {
    const found = keysOf(realScan())
    expect(found.length).toBeGreaterThan(0)
    expect(EXPECTED_IN_SCOPE.filter((key) => !found.includes(key))).toEqual([])
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
}
const SYNTH_IMPORTS = [
  "import { fooRouter } from './routes/foo'", "import { barRouter } from './routes/bar'", "import { viewsRouter } from './routes/views'",
  "import r from './routes/r'", "import * as api from './routes/api'", "import { runtime } from './services/runtime'",
].join('\n')
/** index.ts-shaped text: the six imports, then `body` inside a method — its first line is index.ts:9. */
const synth = (body: string): MountScan =>
  scanIndexMounts(`${SYNTH_IMPORTS}\nclass Server {\n  setup(param: unknown) {\n${body}\n  }\n}\n`, (rel) => SYNTH_FILES[rel])

describe('self-checks on synthetic index.ts text (same extraction code path as the real check)', () => {
  it('(i) an /api/admin mount of an unlisted router is in scope and classified as uncovered', () => {
    const s = synth("    this.app.use('/api/admin/foo', fooRouter())")
    expect({ keys: keysOf(s), failures: s.failures }).toEqual({ keys: ['/api/admin/foo -> foo.ts'], failures: [] })
    expect(uncovered(s.inScope)).toEqual([expect.stringContaining('foo.ts (index.ts:9, /api/admin/foo) is not covered')])
    expect(staleEntries(s.inScope)).toHaveLength(SCANNED.length + Object.keys(ALLOWLIST).length)
  })
  it('(ii) a path-less mount whose router defines an /api/admin path is in scope; one that does not is not', () => {
    expect(keysOf(synth('    this.app.use(barRouter())\n    this.app.use(fooRouter())'))).toEqual(['root -> bar.ts'])
  })
  it('(iii) a /api/views mount is ignored, even when its router mentions /api/admin', () => {
    expect(synth("    this.app.use('/api/views', viewsRouter())")).toEqual({ inScope: [], failures: [], untraced: [] })
  })
  it('(iv) an /api/admin mount whose handler does not trace to src/routes/ fails closed naming the line — never dropped', () => {
    const s = synth("    this.app.use('/api/admin/x', wrap(x))\n    this.app.use('/api/admin/y', (req, res) => res.end())\n    this.app.use('/api/admin/z', runtime.router)")
    expect(s.inScope).toEqual([])
    expect(s.failures).toEqual([expect.stringMatching(/^index\.ts:9: use\('\/api\/admin\/x'.*'wrap' is neither imported/), expect.stringMatching(/^index\.ts:10: .*ArrowFunction is not traced/), expect.stringMatching(/^index\.ts:11: .*src\/services\/runtime\.ts/)])
  })
  it('(v) an array path is recorded per element and its /api/admin element is in scope', () => {
    expect(keysOf(synth("    this.app.use(['/api/admin/a', '/api/other'], r())"))).toEqual(['/api/admin/a -> r.ts'])
  })
  it('(vi) a /api mount whose router defines /admin/… lands under /api/admin and is in scope (namespace member)', () => {
    expect(keysOf(synth("    this.app.use('/api', api.router)"))).toEqual(['/api -> api.ts'])
  })
  it('(vii) `const app = this.app` and a conditional const router are followed', () => {
    const s = synth("    const app = this.app\n    const q = param ? fooRouter() : null\n    app.use('/api/admin/q', q)")
    expect({ keys: keysOf(s), failures: s.failures }).toEqual({ keys: ['/api/admin/q -> foo.ts'], failures: [] })
  })
  it('(viii) a non-literal path that could be under /api/admin fails closed; one that cannot is ignored', () => {
    const s = synth('    this.app.use(`/api/${param}`, fooRouter())\n    this.app.use(`/api/v2/${param}`, fooRouter())')
    expect({ keys: keysOf(s), failures: s.failures }).toEqual({ keys: [], failures: [expect.stringMatching(/^index\.ts:9: the path/)] })
  })
  it('(ix) path-less: an /api/admin path in a module outside src/routes/ or in an inline closure fails, an untraceable handler is listed, a closure is followed', () => {
    const s = synth('    this.app.use(runtime.router)\n    this.app.use(param)\n    this.app.use((req, res, next) => barRouter()(req, res, next))\n    this.app.use((req, res, next) => (req.path === "/api/admin/legacy" ? res.end() : next()))')
    expect(s.failures).toEqual([expect.stringMatching(/^index\.ts:9: .*src\/services\/runtime\.ts/), expect.stringMatching(/^index\.ts:12: an inline root handler carries/)])
    expect(s.untraced).toEqual([expect.stringMatching(/^index\.ts:10: root handler `param`/)])
    expect(keysOf(s)).toEqual(['root -> bar.ts'])
  })
  it('(x) an inline /api/admin route registered with this.app.get fails closed; a non-admin one is ignored', () => {
    const s = synth("    this.app.get('/api/admin/ping', (req, res) => res.end())\n    this.app.get('/health', (req, res) => res.end())")
    expect(s.failures).toEqual([expect.stringMatching(/^index\.ts:9: get\('\/api\/admin\/ping'/)])
  })
})

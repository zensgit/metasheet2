import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'

/**
 * Derived call-path closure for the W6-1 `/effective-policy` aggregate.
 *
 * W6-R1's static DML sweep needs the true set of declarations the route
 * handler can reach, not a hand-maintained file list: a hand-listed domain
 * silently stops covering a helper the handler calls once that helper is
 * declared outside the listed files, or once the handler starts loading a
 * `.cjs` module through `requirePluginAttendanceLib`. This module computes
 * that set instead of naming it.
 *
 * Shape. Start from the route registration block (itself derived — anchored on
 * the route's own path literal, balanced-paren scanned), then expand
 * transitively over declarations, not whole files:
 *
 *   - an identifier that resolves to a declaration in the same file enqueues
 *     that declaration;
 *   - an identifier that resolves to an `import` from a RELATIVE specifier
 *     enqueues the imported declaration in the target file;
 *   - a `requirePluginAttendanceLib(__dirname, '<file>')` literal binds a
 *     local name to `plugins/plugin-attendance/lib/<file>`, and every
 *     `<binding>.<prop>` read anywhere in the closure enqueues THAT
 *     declaration inside the CJS module, expanded transitively there too.
 *
 * Declaration-level rather than file-level is deliberate and is the honest
 * scope: `attendance-admin.ts` contains legitimate writers for OTHER routes,
 * and `attendance-shift-service.cjs` — which this route touches only to read
 * the constant `SEGMENT_CALCULATION_IMPLEMENTED` — contains real
 * `INSERT INTO attendance_shift_segments` / `DELETE FROM …` writers on paths
 * the aggregate never executes. Whole-file expansion would make this guard red
 * on code that is not on the call path, and a guard that cries wolf gets
 * deleted. What is claimed here is exactly what is computed: the declarations
 * reachable from this route's handler.
 *
 * Limits, stated rather than implied:
 *   - dynamic dispatch (a function passed as a value through a variable this
 *     walker cannot follow) is not resolved; the injected `fser` service is
 *     covered because its module is reached through the `requirePluginAttendanceLib`
 *     literal, not because the walker followed the injection;
 *   - non-relative (package) imports are recorded as EXTERNAL and not swept.
 */

export interface CallPathClosure {
  /** Repo-relative paths of every file contributing at least one reachable declaration. */
  readonly files: readonly string[]
  /** One entry per reachable declaration: where it came from and its source text. */
  readonly units: ReadonlyArray<{ file: string; name: string; text: string }>
  /** Package (non-relative) specifiers encountered and deliberately not swept. */
  readonly externals: readonly string[]
}

const ROUTE_ENTRY_FILE = 'packages/core-backend/src/routes/attendance-admin.ts'
const ROUTE_ENTRY_PATH = '/api/attendance/groups/:groupId/effective-policy'
const PLUGIN_LIB_DIR = 'plugins/plugin-attendance/lib'

export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'packages/core-backend/package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`repo root not found from ${startDir}`)
    dir = parent
  }
}

/**
 * Extracts the full source text of the `r.<method>('<routePath>', ...)` call.
 * Anchored on the route's own path string (a stable anchor that moves with the
 * code) rather than a hand-picked line range, and string/template-aware so a
 * `)` inside a literal cannot end the scan early.
 */
export function extractRouteHandlerSource(text: string, method: string, routePath: string): string {
  const marker = `r.${method}(`
  const pathNeedle = `'${routePath}'`
  const pathIdx = text.indexOf(pathNeedle)
  if (pathIdx === -1) throw new Error(`route path literal not found: ${routePath}`)
  const callStart = text.lastIndexOf(marker, pathIdx)
  if (callStart === -1) throw new Error(`no preceding "${marker}" found before route path ${routePath}`)
  const openParenIdx = callStart + marker.length - 1
  let depth = 0
  let inString: '"' | "'" | '`' | false = false
  let inComment: 'line' | 'block' | false = false
  let i = openParenIdx
  for (; i < text.length; i += 1) {
    const c = text[i]
    // COMMENT-AWARE as well as string-aware. Without this an apostrophe in an
    // ordinary English comment inside the handler ("the lock's own wording")
    // opens a phantom string literal and the scan runs to EOF — which is
    // exactly how this extractor broke the first time a prose comment was
    // added to the handler. Regex literals are NOT handled; the handler
    // contains none, and one would surface as a loud "unbalanced parens"
    // throw rather than a silently wrong block.
    if (inComment === 'line') {
      if (c === '\n') inComment = false
      continue
    }
    if (inComment === 'block') {
      if (c === '*' && text[i + 1] === '/') {
        inComment = false
        i += 1
      }
      continue
    }
    if (inString) {
      if (c === '\\') {
        i += 1
        continue
      }
      if (c === inString) inString = false
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      inComment = 'line'
      i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      inComment = 'block'
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) {
        i += 1
        break
      }
    }
  }
  if (depth !== 0) throw new Error(`unbalanced parens extracting route handler for ${routePath}`)
  return text.slice(callStart, i)
}

interface ParsedFile {
  readonly relative: string
  readonly absolute: string
  readonly source: ts.SourceFile
  /** Local declaration name -> node whose text is the declaration body. */
  readonly declarations: Map<string, ts.Node>
  /** Imported local name -> { specifier, importedName }. */
  readonly imports: Map<string, { specifier: string; importedName: string }>
}

function parseFile(repoRoot: string, relative: string): ParsedFile {
  const absolute = path.join(repoRoot, relative)
  const text = fs.readFileSync(absolute, 'utf8')
  const kind = relative.endsWith('.cjs') || relative.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.ES2022, true, kind)
  const declarations = new Map<string, ts.Node>()
  const imports = new Map<string, { specifier: string; importedName: string }>()

  const visitTop = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const clause = node.importClause
      if (clause) {
        if (clause.name) imports.set(clause.name.text, { specifier, importedName: 'default' })
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              imports.set(element.name.text, {
                specifier,
                importedName: (element.propertyName ?? element.name).text,
              })
            }
          } else if (ts.isNamespaceImport(clause.namedBindings)) {
            imports.set(clause.namedBindings.name.text, { specifier, importedName: '*' })
          }
        }
      }
      return
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      declarations.set(node.name.text, node)
      return
    }
    if (ts.isClassDeclaration(node) && node.name) {
      declarations.set(node.name.text, node)
      return
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) declarations.set(decl.name.text, decl)
      }
      return
    }
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      declarations.set(node.name.text, node)
      return
    }
    if (ts.isInterfaceDeclaration(node) && node.name) {
      declarations.set(node.name.text, node)
    }
  }
  source.forEachChild(visitTop)
  return { relative, absolute, source, declarations, imports }
}

function resolveRelativeModule(repoRoot: string, fromRelative: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = path.join(path.dirname(path.join(repoRoot, fromRelative)), specifier)
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), `${base}.cjs`, base]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) {
      return path.relative(repoRoot, candidate)
    }
  }
  return null
}

/** Every identifier appearing anywhere inside a node. */
function identifiersIn(node: ts.Node): string[] {
  const names: string[] = []
  const walk = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) names.push(child.text)
    // Property access: `lib.foo` — `foo` is not a free identifier, but the
    // OBJECT is, and that is what the closure needs.
    if (ts.isPropertyAccessExpression(child)) {
      walk(child.expression)
      return
    }
    child.forEachChild(walk)
  }
  node.forEachChild(walk)
  if (ts.isIdentifier(node)) names.push(node.text)
  return names
}

function pluginLibTargetFromCall(node: ts.CallExpression): string | null {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'requirePluginAttendanceLib') return null
  const [startDir, target] = node.arguments
  if (!startDir || !ts.isIdentifier(startDir) || startDir.text !== '__dirname' || !target || !ts.isStringLiteral(target)) {
    throw new Error('requirePluginAttendanceLib must use (__dirname, <literal file>)')
  }
  return target.text
}

/** `requirePluginAttendanceLib<...>(__dirname, '<file>')` literal arguments. */
export function pluginLibRequestsIn(text: string): string[] {
  const source = ts.createSourceFile('attendance-w6-plugin-lib-call.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = pluginLibTargetFromCall(node)
      if (target !== null) out.push(target)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/**
 * `const <binding> = requirePluginAttendanceLib<…>(__dirname, '<file>')`
 * bindings declared in a file, so `<binding>.<prop>` reads elsewhere in the
 * closure can be resolved to a DECLARATION inside that CJS module rather than
 * pulling the whole module in.
 */
function pluginLibBindingsIn(text: string): Array<{ binding: string; libFile: string }> {
  const source = ts.createSourceFile('attendance-w6-plugin-lib-binding.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: Array<{ binding: string; libFile: string }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const target = pluginLibTargetFromCall(node.initializer)
      if (target !== null) out.push({ binding: node.name.text, libFile: target })
    }
    // Declaration slices produced by this helper begin at the variable name,
    // not at `const`, so TypeScript parses that isolated text as an assignment
    // expression. Treat both parser shapes identically.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ts.isCallExpression(node.right)
    ) {
      const target = pluginLibTargetFromCall(node.right)
      if (target !== null) out.push({ binding: node.left.text, libFile: target })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Property names read off `<binding>.` anywhere in a source text. */
function propertyReadsOn(text: string, binding: string): string[] {
  const out = new Set<string>()
  const re = new RegExp(`\\b${binding.replace(/[$]/g, '\\$')}\\s*\\.\\s*([A-Za-z0-9_$]+)`, 'g')
  for (const m of text.matchAll(re)) out.add(m[1])
  return [...out]
}

export function buildAggregateCallPathClosure(repoRoot: string): CallPathClosure {
  const parsed = new Map<string, ParsedFile>()
  const getFile = (relative: string): ParsedFile => {
    let file = parsed.get(relative)
    if (!file) {
      file = parseFile(repoRoot, relative)
      parsed.set(relative, file)
    }
    return file
  }

  const units: Array<{ file: string; name: string; text: string }> = []
  const seen = new Set<string>()
  const externals = new Set<string>()
  /** local binding name -> plugin-lib CJS file it was `require`d from. */
  const libBindings = new Map<string, string>()

  const entry = getFile(ROUTE_ENTRY_FILE)
  const routeBlock = extractRouteHandlerSource(entry.source.getFullText(), 'get', ROUTE_ENTRY_PATH)
  units.push({ file: ROUTE_ENTRY_FILE, name: '<route registration block>', text: routeBlock })

  const queue: Array<{ file: string; name: string }> = []
  const enqueueIdentifiers = (fromFile: string, text: string, names: readonly string[]): void => {
    const file = getFile(fromFile)
    for (const name of names) {
      if (file.declarations.has(name)) {
        queue.push({ file: fromFile, name })
        continue
      }
      const imported = file.imports.get(name)
      if (!imported) continue
      const target = resolveRelativeModule(repoRoot, fromFile, imported.specifier)
      if (!target) {
        externals.add(imported.specifier)
        continue
      }
      queue.push({ file: target, name: imported.importedName === '*' ? '*' : imported.importedName })
    }
    for (const { binding, libFile } of pluginLibBindingsIn(text)) {
      libBindings.set(binding, path.join(PLUGIN_LIB_DIR, libFile))
    }
    // A `requirePluginAttendanceLib` call with no binding still names a file
    // the route loads; record it so the closed-set coverage leg can see it.
    for (const libFile of pluginLibRequestsIn(text)) {
      const relative = path.join(PLUGIN_LIB_DIR, libFile)
      if (![...libBindings.values()].includes(relative)) libBindings.set(`<anonymous:${libFile}>`, relative)
    }
  }

  // Seed from the route block AND from the module-scope declarations the block
  // names (the service singletons, the FSER instance, the plugin-lib requires).
  const routeBlockSource = ts.createSourceFile('route.ts', routeBlock, ts.ScriptTarget.ES2022, true)
  enqueueIdentifiers(ROUTE_ENTRY_FILE, routeBlock, identifiersIn(routeBlockSource))

  const drain = (): void => {
    while (queue.length > 0) {
      const next = queue.shift() as { file: string; name: string }
      const key = `${next.file}::${next.name}`
      if (seen.has(key)) continue
      seen.add(key)
      const file = getFile(next.file)
      if (next.name === '*') {
        // Namespace import: the whole module is reachable.
        const text = file.source.getFullText()
        units.push({ file: next.file, name: '*', text })
        enqueueIdentifiers(next.file, text, identifiersIn(file.source))
        continue
      }
      const decl = file.declarations.get(next.name)
      if (!decl) continue
      const text = decl.getFullText(file.source)
      units.push({ file: next.file, name: next.name, text })
      enqueueIdentifiers(next.file, text, identifiersIn(decl))
    }
  }
  drain()

  // Plugin-lib CJS modules enter the closure DECLARATION-BY-DECLARATION, keyed
  // on the properties the closure actually reads off each binding. Repeat until
  // fixpoint, because a CJS declaration can itself read another lib binding.
  for (let round = 0; round < 8; round += 1) {
    const before = units.length
    for (const [binding, libFile] of libBindings) {
      if (!fs.existsSync(path.join(repoRoot, libFile))) continue
      if (binding.startsWith('<anonymous:')) continue
      const props = new Set<string>()
      for (const unit of units) for (const prop of propertyReadsOn(unit.text, binding)) props.add(prop)
      for (const prop of props) queue.push({ file: libFile, name: prop })
    }
    drain()
    if (units.length === before) break
  }

  const files = [...new Set(units.map((unit) => unit.file))].sort()
  return { files, units, externals: [...externals].sort() }
}

/** The plugin-lib CJS files this closure loads, derived from the
 * `requirePluginAttendanceLib` literals it reaches. */
export function pluginLibFilesInClosure(closure: CallPathClosure): string[] {
  return closure.files.filter((file) => file.startsWith(`${PLUGIN_LIB_DIR}/`)).sort()
}

/**
 * Classifies the SQL-bearing argument of every DB-seam call this bounded AST
 * detector recognizes, into exactly three buckets: resolved (a literal SQL
 * string, swept by the DML text detectors), pass-through (forwards an adapter's own
 * formal parameter, never composing it), or finding (anything else — an
 * unclassifiable argument is a refusal, not a pass). No file is exempt as a
 * file; every call site is classified on its own shape.
 *
 * The pass-through definition, as implemented:
 *
 *   A DB-seam call site is pass-through only when it forwards a named
 *   adapter's own formal parameter, and every caller of that adapter inside
 *   the closure passes, at that parameter's position, an argument which is
 *   itself already classified (resolved, or a valid pass-through).
 *
 * Mechanically, all of the following must hold, or the site is a finding:
 *
 *   (1) Provenance. Trace the argument expression through same-unit locals
 *       (depth-capped) and into the argument positions of any call inside it.
 *       At least one leaf identifier must be a formal parameter of the
 *       innermost enclosing function of the call site. `query(factory())`,
 *       `const s = build(); query(s)`, a two-hop helper, an imported helper —
 *       every one of these traces to a call with no parameter-derived leaf,
 *       so every one of them is a finding.
 *   (2) No composition, anywhere in the traced expressions: `+`, a template
 *       with substitutions, `.concat(`, `.join(`. This is a veto that
 *       overrides (1), so `query('IN' + suffixParam)` — which does have
 *       parameter provenance — is still a finding.
 *   (3) A name. The innermost enclosing function must have a resolvable name
 *       (function/method declaration, variable declarator, or object-literal
 *       property — climbing through parens and `as` casts). An anonymous
 *       adapter has no caller set that can be checked, so it is a finding —
 *       which includes the route handler itself, an anonymous arrow passed
 *       to `r.get(...)`.
 *   (4) Every callee in the trace is swept and authors nothing. Each call
 *       appearing in the traced expressions must have its declaration inside
 *       the closure (so the DML legs sweep its text) and must contain no
 *       string-composing expression anywhere in its body — not merely in its
 *       return positions, which a local variable would hide.
 *   (5) A non-empty, fully-classified caller set. Checked separately by
 *       `checkPassThroughCallers`: for each (adapterName, paramIndex) there
 *       must be at least one call to that name inside the closure — a
 *       pass-through with no callers is the empty-read trap, not a proof — and
 *       every such call's argument at that index must itself classify as
 *       resolved or pass-through.
 *
 * Direct DB-seam call sites are matched by callee name ending in `query`
 * (case-insensitive): `query`, `.query`, `runQuery`, `readOnlyQuery`,
 * `wrappedQuery`. Covered indirect forms include local/destructured aliases,
 * assignment and object-property aliases, static/computed element access,
 * conditional/logical aliases, and `.call`/`.apply`/`.bind`; they are refused
 * as findings rather than disappearing from the classification. This is not a
 * whole-JavaScript data-flow proof: opaque higher-order returns, arbitrary
 * identity functions, and object-spread propagation remain outside the
 * bounded grammar.
 *
 * A separate exact-shape leg recognizes pg 8.16.3 Client.prototype.query
 * through Reflect.apply: its third argument is the untouched first formal
 * parameter of a named adapter. Unknown Reflect invocations are findings.
 * Proven ReadyForQuery notifications are recorded separately from SQL sites;
 * their declarations remain swept, including all nested authored SQL calls.
 * The mechanism of record for W6-R1 remains the read-only transaction, which
 * refuses a write that reaches its transaction-bound handle; this sweep is a
 * second, independent leg over the same closure.
 *
 * `src/db/pg.ts` and `src/integration/db/connection-pool.ts` pass for a
 * structural reason (their `sql`/`sqlOrConfig` formal parameters are what
 * reaches the seam, and `buildQueryConfig` composes nothing), not because of
 * the file they live in. If either file ever authors SQL, or routes it
 * through a helper that composes, the guard reds — and so does any other
 * file in the closure, none of which carries a file-level exemption.
 */
export interface SqlArgumentSite {
  readonly file: string
  readonly unit: string
  readonly snippet: string
}
export interface ResolvedSqlArgument extends SqlArgumentSite {
  readonly sql: string
}
export interface PassThroughSqlArgument extends SqlArgumentSite {
  /** The NAMED enclosing function whose formal parameter is forwarded. */
  readonly adapterName: string
  /** Position of that formal parameter in the adapter's signature. */
  readonly paramIndex: number
  /** The parameter identifier the trace actually landed on. */
  readonly provenanceLeaf: string
  /** Native pg rest-array forwarding is distinct from the SQL/config input. */
  readonly carrier?: 'arguments' | 'input'
}
export interface SqlArgumentFinding extends SqlArgumentSite {
  readonly reason: string
}

export interface ProtocolCallbackSite extends SqlArgumentSite {
  readonly target: 'pg.Client.prototype._handleReadyForQuery'
}

export interface SqlArguments {
  /** Proven native protocol notifications; these carry no SQL argument. */
  readonly protocolCallbacks: ReadonlyArray<ProtocolCallbackSite>
  readonly nonSqlReflectCalls: ReadonlyArray<SqlArgumentSite & { readonly role: NonSqlReflectRole }>
  readonly resolved: ReadonlyArray<ResolvedSqlArgument>
  readonly passthrough: ReadonlyArray<PassThroughSqlArgument>
  /** Sites the sweep REFUSES. A non-empty list means the static leg failed. */
  readonly findings: ReadonlyArray<SqlArgumentFinding>
}

/** Callee names that are treated as DB seams. See the header. */
export function isDbSeamCalleeName(name: string): boolean {
  return name.toLowerCase().endsWith('query')
}

function isStringComposing(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return true
  if (ts.isTemplateExpression(node)) return true
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const name = node.expression.name.text
    if (name === 'concat' || name === 'join') return true
  }
  return false
}

function containsComposition(node: ts.Node): boolean {
  let found = false
  const walk = (child: ts.Node): void => {
    if (found) return
    if (isStringComposing(child)) {
      found = true
      return
    }
    child.forEachChild(walk)
  }
  if (isStringComposing(node)) return true
  node.forEachChild(walk)
  return found
}

function calleeNameOf(call: ts.CallExpression): string | null {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text
  return null
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  )
}

function enclosingFunctionOf(node: ts.Node): FunctionLike | null {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (isFunctionLike(current)) return current
    current = current.parent
  }
  return null
}

/**
 * The adapter's NAME. Climbs through parenthesised expressions and `as`/type
 * assertions, because the real read-only seam is written as
 * `const readOnlyQuery = (<T>(sql, params) => client.query(sql, params)) as Fn`
 * — a shape that a naive "is the parent a VariableDeclaration" check reads as
 * anonymous and would have turned into a self-inflicted FINDING.
 */
function adapterNameOf(fn: FunctionLike): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) {
    if (ts.isIdentifier(fn.name)) return fn.name.text
  }
  let node: ts.Node = fn
  let parent: ts.Node | undefined = fn.parent
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent))
  ) {
    node = parent
    parent = parent.parent
  }
  if (!parent) return null
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return parent.name.text
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    if (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) return parent.name.text
  }
  if (ts.isPropertyDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return parent.name.text
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  ) {
    if (ts.isIdentifier(parent.left)) return facadeQueryAdapter(fn) ? 'query' : parent.left.text
    if (ts.isPropertyAccessExpression(parent.left) && ts.isIdentifier(parent.left.name)) return parent.left.name.text
  }
  return null
}

function formalParameterIndex(fn: FunctionLike): Map<string, number> {
  const out = new Map<string, number>()
  fn.parameters.forEach((param, index) => {
    if (ts.isIdentifier(param.name)) out.set(param.name.text, index)
  })
  return out
}

/** EVERY name a parameter list binds, including through destructuring patterns.
 *  Wider than `formalParameterIndex` on purpose: this feeds the SHADOWING test,
 *  where missing a bound name is the dangerous direction. */
function boundParameterNames(fn: FunctionLike): Set<string> {
  const out = new Set<string>()
  const collect = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      out.add(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) collect(element.name)
    }
  }
  for (const param of fn.parameters) collect(param.name)
  return out
}

/**
 * Is `name`, at this position, bound by something NEARER than module scope —
 * a local `const`/`let`, or a formal parameter of ANY enclosing function?
 *
 * This exists because the module-scope literal-constant table is keyed by NAME
 * across every file in the closure, and consulting it first made a formal
 * parameter that merely SHARES a name with some constant come back as a
 * `resolved` literal. Measured, not theorised: with
 * `AttendanceSetupReadinessAggregate.ts` in the closure (it declares
 * `const ATTENDANCE_SETTINGS_KEY = 'attendance.settings'` at module scope), the
 * textbook adapter
 *
 *     async function runSql(ATTENDANCE_SETTINGS_KEY, params) { return query(ATTENDANCE_SETTINGS_KEY, params) }
 *
 * classified as `resolved: ['attendance.settings']` — a string the seam never
 * receives. Two harms, not one: the sweep FABRICATES SQL text that downstream
 * legs then treat as fact (the "every resolved literal is a SELECT" check, and
 * the DB suite's derived `TOUCHED_TABLES` relation set), and the site skips
 * requirement (5) — the caller-set check — altogether, because only
 * pass-throughs are caller-checked. Outer-function parameters and destructured
 * bindings count too: a captured parameter is no less a parameter.
 */
function isShadowedByNearerBinding(name: string, from: ts.Node): boolean {
  if (resolveLocalBinding(name, from) !== null) return true
  let fn = enclosingFunctionOf(from)
  while (fn) {
    if (boundParameterNames(fn).has(name)) return true
    fn = enclosingFunctionOf(fn)
  }
  return false
}

interface ParsedUnit {
  readonly file: string
  readonly name: string
  readonly source: ts.SourceFile
}

function scriptKindFor(file: string): ts.ScriptKind {
  return file.endsWith('.cjs') || file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

function parseUnits(closure: CallPathClosure): ParsedUnit[] {
  return closure.units.map((unit) => ({
    file: unit.file,
    name: unit.name,
    source: ts.createSourceFile(
      `${unit.file}#${unit.name}`,
      unit.text,
      ts.ScriptTarget.ES2022,
      true,
      scriptKindFor(unit.file),
    ),
  }))
}

/**
 * LEXICALLY-SCOPED local lookup, resolved from the node that mentions the
 * name outward. A flat unit-wide `Map<name, initializer>` was the first
 * implementation and it was wrong in a way that only showed up when the
 * transcript was read: `ConnectionPool` declares `queryConfig` THREE times
 * (in `buildQueryConfig`, in `query`, and inside `transaction`'s wrapped
 * client), the whole class arrives as ONE unit, and last-write-wins made the
 * trace for `query`'s site follow `transaction`'s declaration — reporting
 * provenance through the wrong formal parameter (`params`, index 1) while
 * still passing. A pass-through justified by the wrong parameter is not a
 * justification, so the lookup walks the real scope chain instead.
 */
function resolveLocalBinding(name: string, from: ts.Node): ts.Expression | null {
  let current: ts.Node | undefined = from
  while (current) {
    let statements: readonly ts.Statement[] | null = null
    if (ts.isBlock(current)) statements = current.statements
    else if (ts.isSourceFile(current)) statements = current.statements
    else if (ts.isCaseClause(current) || ts.isDefaultClause(current)) statements = current.statements
    if (statements) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
            return declaration.initializer
          }
        }
      }
    }
    current = current.parent
  }
  return null
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function bindingPropertyName(element: ts.BindingElement): string | null {
  const property = element.propertyName ?? element.name
  if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) return property.text
  return null
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression)
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isNumericLiteral(expression)) {
      return expression.text
    }
  }
  return null
}

function staticAccessPath(expression: ts.Expression): string[] | null {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return [current.text]
  if (ts.isPropertyAccessExpression(current)) {
    const parent = staticAccessPath(current.expression)
    return parent ? [...parent, current.name.text] : null
  }
  if (ts.isElementAccessExpression(current)) {
    const parent = staticAccessPath(current.expression)
    const key = current.argumentExpression && unwrapExpression(current.argumentExpression)
    if (!parent || !key || (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key) && !ts.isNumericLiteral(key))) {
      return null
    }
    return [...parent, key.text]
  }
  return null
}

function sameAccessPath(left: ts.Expression, expected: readonly string[]): boolean {
  const actual = staticAccessPath(left)
  return actual !== null && actual.length === expected.length && actual.every((part, index) => part === expected[index])
}

function resolveLocalAssignment(path: readonly string[], from: ts.Node): ts.Expression | null {
  let current: ts.Node | undefined = from
  while (current) {
    let statements: readonly ts.Statement[] | null = null
    if (ts.isBlock(current) || ts.isSourceFile(current)) statements = current.statements
    else if (ts.isCaseClause(current) || ts.isDefaultClause(current)) statements = current.statements
    if (statements) {
      let latest: ts.Expression | null = null
      for (const statement of statements) {
        if (statement.pos >= from.pos || !ts.isExpressionStatement(statement)) continue
        const expression = unwrapExpression(statement.expression)
        if (
          ts.isBinaryExpression(expression) &&
          expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          sameAccessPath(expression.left, path)
        ) {
          latest = expression.right
        }
      }
      if (latest) return latest
    }
    current = current.parent
  }
  return null
}

function objectPropertyInitializer(object: ts.ObjectLiteralExpression, key: string): ts.Expression | null {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === key) return property.initializer
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name
  }
  return null
}

function resolveDestructuredBinding(name: string, from: ts.Node): ts.Expression | null {
  let current: ts.Node | undefined = from
  while (current) {
    let statements: readonly ts.Statement[] | null = null
    if (ts.isBlock(current) || ts.isSourceFile(current)) statements = current.statements
    else if (ts.isCaseClause(current) || ts.isDefaultClause(current)) statements = current.statements
    if (statements) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isObjectBindingPattern(declaration.name)) continue
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name) || element.name.text !== name) continue
            const key = bindingPropertyName(element)
            if (!key) return null
            if (isDbSeamCalleeName(key)) return element.propertyName ?? element.name
            const initializer = declaration.initializer && unwrapExpression(declaration.initializer)
            return initializer && ts.isObjectLiteralExpression(initializer)
              ? objectPropertyInitializer(initializer, key)
              : null
          }
        }
      }
    }
    current = current.parent
  }
  return null
}

function resolveStaticValue(
  expression: ts.Expression,
  from: ts.Node,
  seen: Set<string>,
): ts.Expression {
  const current = unwrapExpression(expression)
  const accessPath = staticAccessPath(current)
  if (!accessPath) return current

  const pathKey = accessPath.join('\u0000')
  if (seen.has(pathKey)) return current
  seen.add(pathKey)

  const assigned = resolveLocalAssignment(accessPath, from)
  if (assigned) return resolveStaticValue(assigned, from, seen)

  if (ts.isIdentifier(current)) {
    const initializer = resolveLocalBinding(current.text, from) ?? resolveDestructuredBinding(current.text, from)
    return initializer ? resolveStaticValue(initializer, from, seen) : current
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const receiver = resolveStaticValue(current.expression, from, seen)
    const key = accessPath[accessPath.length - 1]
    if (ts.isObjectLiteralExpression(receiver)) {
      const initializer = objectPropertyInitializer(receiver, key)
      if (initializer) return resolveStaticValue(initializer, from, seen)
    }
  }
  return current
}

/**
 * Resolves the known indirect spellings that previously made a DB-seam call
 * disappear from all three classification buckets. This is deliberately
 * fail-closed: a computed element-access call cannot prove which method it
 * invokes, so it is refused rather than guessed safe.
 */
function expressionResolvesToDbSeam(
  expression: ts.Expression,
  from: ts.Node,
  seen: Set<string> = new Set(),
): boolean {
  const current = unwrapExpression(expression)
  const resolved = resolveStaticValue(current, from, new Set(seen))
  if (resolved !== current) return expressionResolvesToDbSeam(resolved, from, seen)
  if (ts.isIdentifier(current)) {
    if (isDbSeamCalleeName(current.text)) return true
    if (seen.has(current.text)) return false
    seen.add(current.text)

    let scope: ts.Node | undefined = from
    while (scope) {
      let statements: readonly ts.Statement[] | null = null
      if (ts.isBlock(scope) || ts.isSourceFile(scope)) statements = scope.statements
      else if (ts.isCaseClause(scope) || ts.isDefaultClause(scope)) statements = scope.statements
      if (statements) {
        for (const statement of statements) {
          if (!ts.isVariableStatement(statement)) continue
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === current.text && declaration.initializer) {
              return expressionResolvesToDbSeam(declaration.initializer, declaration, seen)
            }
            if (ts.isObjectBindingPattern(declaration.name)) {
              for (const element of declaration.name.elements) {
                if (ts.isIdentifier(element.name) && element.name.text === current.text) {
                  const property = bindingPropertyName(element)
                  return property !== null && isDbSeamCalleeName(property)
                }
              }
            }
          }
        }
      }
      scope = scope.parent
    }
    return false
  }
  if (ts.isPropertyAccessExpression(current)) {
    if (isDbSeamCalleeName(current.name.text)) return true
    if (current.name.text === 'call' || current.name.text === 'apply' || current.name.text === 'bind') {
      return expressionResolvesToDbSeam(current.expression, current, seen)
    }
    return false
  }
  if (ts.isElementAccessExpression(current)) {
    const key = current.argumentExpression && unwrapExpression(current.argumentExpression)
    if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) {
      return isDbSeamCalleeName(key.text)
    }
    return true
  }
  if (ts.isConditionalExpression(current)) {
    return expressionResolvesToDbSeam(current.whenTrue, current, new Set(seen)) ||
      expressionResolvesToDbSeam(current.whenFalse, current, new Set(seen))
  }
  if (
    ts.isBinaryExpression(current) &&
    (
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      current.operatorToken.kind === ts.SyntaxKind.CommaToken ||
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
  ) {
    return expressionResolvesToDbSeam(current.left, current, new Set(seen)) ||
      expressionResolvesToDbSeam(current.right, current, new Set(seen))
  }
  if (ts.isCallExpression(current)) return expressionResolvesToDbSeam(current.expression, current, seen)
  return false
}

function unsupportedDbSeamReason(call: ts.CallExpression): string | null {
  const directName = calleeNameOf(call)
  if (directName && isDbSeamCalleeName(directName)) return null
  return expressionResolvesToDbSeam(call.expression, call)
    ? 'indirect or computed DB-seam call — refused, not silently omitted'
    : null
}

/** Every function-like declaration the closure carries, indexed by name, so a
 *  callee appearing in a traced expression can be checked for (a) being swept
 *  at all and (b) composing nothing. */
function indexClosureFunctions(units: ParsedUnit[]): Map<string, ts.Node[]> {
  const out = new Map<string, ts.Node[]>()
  const add = (name: string, node: ts.Node): void => {
    const list = out.get(name)
    if (list) list.push(node)
    else out.set(name, [node])
  }
  for (const unit of units) {
    const walk = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const name = adapterNameOf(node)
        if (name) add(name, node)
      }
      node.forEachChild(walk)
    }
    unit.source.forEachChild(walk)
  }
  return out
}

function moduleScopeLiteralConstants(closure: CallPathClosure, repoRoot: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of closure.files) {
    const absolute = path.join(repoRoot, file)
    if (!fs.existsSync(absolute)) continue
    const source = ts.createSourceFile(
      absolute,
      fs.readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
      scriptKindFor(file),
    )
    source.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        if (ts.isStringLiteral(decl.initializer) || ts.isNoSubstitutionTemplateLiteral(decl.initializer)) {
          out.set(decl.name.text, decl.initializer.text)
        }
      }
    })
  }
  return out
}

type Classification =
  | { kind: 'resolved'; sql: string }
  | { kind: 'passthrough'; adapterName: string; paramIndex: number; provenanceLeaf: string; carrier?: 'arguments' | 'input' }
  | { kind: 'finding'; reason: string }

interface ClassifierContext {
  readonly unit: ParsedUnit
  readonly literalConstants: Map<string, string>
  readonly closureFunctions: Map<string, ts.Node[]>
  readonly pgCarriers?: ReadonlyMap<string, 'arguments' | 'input'>
}

/**
 * Classifies ONE argument expression at ONE call site. The call site node is
 * needed (not just the argument) because provenance is defined against the
 * innermost enclosing function's formal parameters.
 */
function classifySqlArgument(arg: ts.Expression, callSite: ts.Node, ctx: ClassifierContext): Classification {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return { kind: 'resolved', sql: arg.text }
  if (ts.isIdentifier(arg) && !isShadowedByNearerBinding(arg.text, arg)) {
    // Module-scope constants are consulted ONLY when nothing nearer binds the
    // name. See `isShadowedByNearerBinding` for the measured failure this
    // ordering fixes — the name table is global to the closure, so without the
    // shadow test a formal parameter can come back as a fabricated literal.
    const constant = ctx.literalConstants.get(arg.text)
    if (constant !== undefined) return { kind: 'resolved', sql: constant }
  }

  // ---- trace ------------------------------------------------------------
  const traced: ts.Node[] = [arg]
  const visitedLocals = new Set<string>()
  for (let depth = 0; depth < 4; depth += 1) {
    const before = traced.length
    for (const node of [...traced]) {
      const collectIdentifiers = (child: ts.Node): void => {
        if (ts.isIdentifier(child) && !visitedLocals.has(child.text)) {
          // Resolved from the mention outward, so a name declared in several
          // sibling scopes of the same unit follows ITS OWN declaration.
          const local = resolveLocalBinding(child.text, child)
          if (local) {
            visitedLocals.add(child.text)
            traced.push(local)
          }
        }
        child.forEachChild(collectIdentifiers)
      }
      if (ts.isIdentifier(node)) collectIdentifiers(node)
      node.forEachChild(collectIdentifiers)
    }
    if (traced.length === before) break
  }

  // ---- (2) composition veto, applied to the WHOLE trace ------------------
  for (const node of traced) {
    if (containsComposition(node)) {
      return { kind: 'finding', reason: 'string-composed SQL in the traced expression — refused, not analysed' }
    }
  }

  // ---- (3) a named adapter ----------------------------------------------
  const enclosing = enclosingFunctionOf(callSite)
  if (!enclosing) {
    return { kind: 'finding', reason: 'call site is not inside any function — no formal parameters to forward' }
  }
  const adapterName = adapterNameOf(enclosing)
  if (!adapterName) {
    return {
      kind: 'finding',
      reason: 'anonymous enclosing function — no adapter name, so no caller set can be checked',
    }
  }

  // ---- (1) formal-parameter provenance ----------------------------------
  const formals = formalParameterIndex(enclosing)
  let provenanceLeaf: string | null = null
  let paramIndex = -1
  const leaves: string[] = []
  for (const node of traced) {
    const collectLeaves = (child: ts.Node): void => {
      if (ts.isPropertyAccessExpression(child)) {
        collectLeaves(child.expression)
        return
      }
      if (ts.isCallExpression(child)) {
        // The callee NAME is not a data leaf; its ARGUMENTS are.
        for (const callArg of child.arguments) collectLeaves(callArg)
        if (ts.isPropertyAccessExpression(child.expression)) collectLeaves(child.expression.expression)
        return
      }
      if (ts.isIdentifier(child)) leaves.push(child.text)
      child.forEachChild(collectLeaves)
    }
    collectLeaves(node)
  }
  for (const leaf of leaves) {
    const index = formals.get(leaf)
    if (index !== undefined) {
      provenanceLeaf = leaf
      paramIndex = index
      break
    }
  }
  if (provenanceLeaf === null) {
    return {
      kind: 'finding',
      reason: `no formal-parameter provenance: the SQL reaching this seam is authored inside the closure (traced leaves: ${
        leaves.length ? [...new Set(leaves)].join(', ') : '<none>'
      })`,
    }
  }

  // ---- (4) every callee in the trace is swept and composes nothing -------
  const calleeNames = new Set<string>()
  for (const node of traced) {
    const collectCallees = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const name = calleeNameOf(child)
        if (name) calleeNames.add(name)
      }
      child.forEachChild(collectCallees)
    }
    if (ts.isCallExpression(node)) {
      const name = calleeNameOf(node)
      if (name) calleeNames.add(name)
    }
    collectCallees(node)
  }
  for (const name of calleeNames) {
    const declarations = ctx.closureFunctions.get(name)
    if (!declarations || declarations.length === 0) {
      return { kind: 'finding', reason: `callee \`${name}\` is not declared inside the swept closure` }
    }
    for (const declaration of declarations) {
      if (containsComposition(declaration)) {
        return { kind: 'finding', reason: `callee \`${name}\` composes strings in its body` }
      }
    }
  }

  return { kind: 'passthrough', adapterName, paramIndex, provenanceLeaf }
}

/** The only native escape understood here is the pinned pg argument-array
 * transport. Names and type assertions alone never establish its provenance.
 * Module sources retain imports/aliases split out of declaration-sized units.
 * Binding lookup deliberately over-refuses duplicate/shadowed bindings, even in
 * sibling scopes; it must not bless a same-spelled local as the package export.
 */
interface NativePgContext {
  readonly unit: ParsedUnit
  readonly module: ts.SourceFile
  readonly pinned: boolean
}

const nativeBindingTables = new WeakMap<ts.SourceFile, Map<string, ts.Node[]>>()

function nativeBinding(name: string, source: ts.SourceFile): ts.Node[] {
  let table = nativeBindingTables.get(source)
  if (!table) {
    table = new Map<string, ts.Node[]>()
    const add = (name: string, node: ts.Node): void => { table!.set(name, [...(table!.get(name) ?? []), node]) }
    const bind = (name: ts.BindingName, node: ts.Node): void => {
      if (ts.isIdentifier(name)) add(name.text, node)
      else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name, node)
    }
    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name, node)
      else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) add(node.name.text, node)
      else if (ts.isImportClause(node) && node.name) add(node.name.text, node)
      else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
        && node.name) add(node.name.text, node)
      node.forEachChild(walk)
    }
    walk(source)
    nativeBindingTables.set(source, table)
  }
  return table.get(name) ?? []
}

function nativePath(expression: ts.Expression, ctx: NativePgContext, depth = 0): string[] | null {
  if (depth >= 4) return null
  const value = unwrapExpression(expression)
  if (ts.isPropertyAccessExpression(value)) {
    const parent = nativePath(value.expression, ctx, depth)
    return parent ? [...parent, value.name.text] : null
  }
  if (ts.isElementAccessExpression(value)) {
    const parent = nativePath(value.expression, ctx, depth)
    const key = value.argumentExpression && unwrapExpression(value.argumentExpression)
    return parent ? [...parent, key && ts.isStringLiteral(key) ? key.text : '<computed>'] : null
  }
  if (!ts.isIdentifier(value)) return null
  const local = nativeBinding(value.text, ctx.unit.source)
  const bindings = local.length ? local : nativeBinding(value.text, ctx.module)
  if (!bindings.length && value.text === 'Reflect') return [value.text]
  if (bindings.length !== 1) return null
  const binding = bindings[0]
  if (ts.isImportSpecifier(binding)) {
    const clause = binding.parent.parent
    const declaration = clause.parent
    return !binding.isTypeOnly && !clause.isTypeOnly && ts.isImportDeclaration(declaration)
      && ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === 'pg'
      && (binding.propertyName ?? binding.name).text === 'Client' ? ['pg.Client'] : null
  }
  if (ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name) && binding.initializer
    && ts.isVariableDeclarationList(binding.parent) && (binding.parent.flags & ts.NodeFlags.Const)) {
    return nativePath(binding.initializer, ctx, depth + 1)
  }
  return null
}

function nativePathIs(path: readonly string[] | null, expected: readonly string[]): boolean {
  return path !== null && path.length === expected.length && path.every((part, i) => part === expected[i])
}

function nativeBindingsStable(ctx: NativePgContext): boolean {
  let stable = true
  const protectedPath = (expression: ts.Expression): boolean => {
    const root = nativePath(expression, ctx)?.[0]
    return root === 'pg.Client' || root === 'Reflect'
  }
  const walk = (node: ts.Node): void => {
    if (!stable) return
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && (protectedPath(node.left) || protectedPath(node.right))) stable = false
    if (ts.isDeleteExpression(node) && protectedPath(node.expression)) stable = false
    if ((ts.isPostfixUnaryExpression(node) || (ts.isPrefixUnaryExpression(node)
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)))
      && protectedPath(node.operand)) stable = false
    // Mutable aliases and object-property escapes cannot establish native identity.
    if (ts.isVariableDeclaration(node) && node.initializer && protectedPath(node.initializer)
      && (!ts.isIdentifier(node.name) || !ts.isVariableDeclarationList(node.parent)
        || !(node.parent.flags & ts.NodeFlags.Const))) stable = false
    if (ts.isPropertyAssignment(node) && protectedPath(node.initializer)) stable = false
    if (ts.isShorthandPropertyAssignment(node) && protectedPath(node.name)) stable = false
    if (ts.isArrayLiteralExpression(node)) {
      const inspect = (child: ts.Node): void => {
        if (ts.isIdentifier(child) && protectedPath(child)) stable = false
        child.forEachChild(inspect)
      }
      node.forEachChild(inspect)
    }
    if (ts.isReturnStatement(node) && node.expression && protectedPath(node.expression)) stable = false
    if (ts.isCallExpression(node)) {
      node.arguments.forEach((arg, index) => {
        if (!protectedPath(arg)) return
        // Only the SQL target in the exact native invocation may escape as an argument.
        if (!(index === 0 && node.arguments.length === 3
          && nativePathIs(nativePath(node.expression, ctx), ['Reflect', 'apply'])
          && nativePathIs(nativePath(arg, ctx), ['pg.Client', 'prototype', 'query']))) stable = false
      })
    }
    node.forEachChild(walk)
  }
  walk(ctx.module)
  if (ctx.module !== ctx.unit.source) walk(ctx.unit.source)
  return stable
}

/** Preserve a Reflect.apply refusal candidate even when a local alias or a
 * counterfeit Reflect binding prevents native provenance from resolving. */
function reflectInvocationPath(expression: ts.Expression, ctx: NativePgContext, depth = 0): string[] | null {
  // Exhausted alias resolution is a refusal candidate, never a silent omission.
  if (depth >= 4) return ['Reflect', '<computed>']
  const value = unwrapExpression(expression)
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const parent = reflectInvocationPath(value.expression, ctx, depth)
    const key = ts.isPropertyAccessExpression(value) ? value.name.text
      : value.argumentExpression && ts.isStringLiteral(value.argumentExpression) ? value.argumentExpression.text : '<computed>'
    return parent ? [...parent, key] : null
  }
  if (!ts.isIdentifier(value)) return null
  if (value.text === 'Reflect') return ['Reflect']
  const local = nativeBinding(value.text, ctx.unit.source)
  const bindings = local.length ? local : nativeBinding(value.text, ctx.module)
  if (bindings.length !== 1) return null
  const binding = bindings[0]
  return ts.isVariableDeclaration(binding) && binding.initializer
    ? reflectInvocationPath(binding.initializer, ctx, depth + 1) : null
}

/** Syntax equality for the three closed facade shapes, ignoring only types,
 * assertions, parentheses and comments. String contents/operators stay exact.
 */
function facadeSyntaxEqual(actual: ts.Node, expected: ts.Node): boolean {
  if (ts.isParenthesizedExpression(actual) || ts.isAsExpression(actual)
    || ts.isTypeAssertionExpression(actual) || ts.isNonNullExpression(actual)) actual = unwrapExpression(actual)
  if (ts.isParenthesizedExpression(expected)) expected = unwrapExpression(expected)
  if (actual.kind !== expected.kind) return false
  if (ts.isIdentifier(actual) && ts.isIdentifier(expected)) return actual.text === expected.text
  if (ts.isStringLiteral(actual) && ts.isStringLiteral(expected)) return actual.text === expected.text
  if (ts.isNumericLiteral(actual) && ts.isNumericLiteral(expected)) return actual.text === expected.text
  if (ts.isVariableDeclarationList(actual) && ts.isVariableDeclarationList(expected)
    && (actual.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== (expected.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) return false
  const children = (node: ts.Node): ts.Node[] => {
    const result: ts.Node[] = []
    node.forEachChild(child => { if (!ts.isTypeNode(child)) result.push(child) })
    return result
  }
  const left = children(actual), right = children(expected)
  return left.length === right.length && left.every((child, i) => facadeSyntaxEqual(child, right[i]))
}

function facadeExpressionMatches(node: ts.Node, expression: string): boolean {
  const source = ts.createSourceFile('facade-shape.ts', `const shape = (${expression})`, ts.ScriptTarget.ES2022, true)
  const statement = source.statements[0]
  return ts.isVariableStatement(statement) && !!statement.declarationList.declarations[0].initializer
    && facadeSyntaxEqual(node, statement.declarationList.declarations[0].initializer!)
}

function facadeStatementMatches(node: ts.Node, statement: string): boolean {
  const source = ts.createSourceFile('facade-shape.ts', statement, ts.ScriptTarget.ES2022, true)
  return source.statements.length === 1 && facadeSyntaxEqual(node, source.statements[0])
}

function facadeGetter(from: ts.Node): ts.MethodDeclaration | null {
  let node: ts.Node | undefined = from
  while (node && !(ts.isMethodDeclaration(node) && propertyNameText(node.name) === 'get')) node = node.parent
  if (!node || !ts.isMethodDeclaration(node) || !node.body || node.parameters.length !== 2
    || !ts.isIdentifier(node.parameters[1].name) || node.parameters[1].name.text !== 'key') return null
  const object = node.parent, construction = object.parent
  if (!ts.isObjectLiteralExpression(object) || !ts.isNewExpression(construction)
    || !ts.isIdentifier(construction.expression) || construction.expression.text !== 'Proxy'
    || construction.arguments?.length !== 2 || construction.arguments[1] !== object
    || !facadeExpressionMatches(construction.arguments[0], 'Object.create(null)')) return null
  const declaration = construction.parent
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || declaration.name.text !== 'facade') return null
  const owner = enclosingFunctionOf(node)
  if (!owner || !owner.body || !ts.isBlock(owner.body) || owner.parameters.length !== 1
    || !ts.isIdentifier(owner.parameters[0].name) || owner.parameters[0].name.text !== 'checkout') return null
  const scope = ts.createSourceFile('facade-scope.ts', owner.getText(), ts.ScriptTarget.ES2022, true)
  for (const name of ['checkout', 'state', 'client', 'facade', 'methods', 'method', 'key', 'listeners', 'requireCurrent']) {
    if (nativeBinding(name, scope).length !== 1) return null
  }
  for (const name of ['Proxy', 'Object', 'Map', 'Reflect', 'Set']) if (nativeBinding(name, scope).length) return null
  for (const shape of ['const { state } = checkout', 'const client = state.client', 'const methods = new Map()',
    'const listeners = []', 'const requireCurrent = () => { if (!current(checkout)) refuse() }']) {
    if (owner.body.statements.filter(statement => facadeStatementMatches(statement, shape)).length !== 1) return null
  }
  const body = node.body.statements
  if (body.length < 2 || !body.some(statement => facadeStatementMatches(statement, 'if (methods.has(key)) return methods.get(key)'))
    || !body.some(statement => facadeStatementMatches(statement, 'let method'))
    || !facadeStatementMatches(body[body.length - 2], 'methods.set(key, method)')
    || !facadeStatementMatches(body[body.length - 1], 'return method')
    || !facadeStatementMatches(owner.body.statements[owner.body.statements.length - 1], 'return facade')) return null
  // The cache has one declaration and exactly has/get/set uses. No alias or
  // prepopulation may sever the returned property's relation to this branch.
  const dispatches = body.filter(statement => ts.isIfStatement(statement)
    && facadeExpressionMatches(statement.expression, "key === 'query'"))
  if (dispatches.length !== 1) return null
  const dispatch = dispatches[0]
  const branchAssignment = (assignment: ts.BinaryExpression): boolean => {
    const statement = assignment.parent, block = statement.parent, branch = block.parent
    if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(assignment.left)
      || !ts.isArrowFunction(unwrapExpression(assignment.right)) || !ts.isExpressionStatement(statement)
      || !ts.isBlock(block) || block.statements.length !== 1 || !ts.isIfStatement(branch)
      || branch.thenStatement !== block) return false
    let top: ts.Node = branch
    while (ts.isIfStatement(top.parent) && top.parent.elseStatement === top) top = top.parent
    return top === dispatch
  }
  let cacheReferences = 0, invalidWrite = false
  const walk = (child: ts.Node): void => {
    if (ts.isIdentifier(child) && child.text === 'methods') cacheReferences += 1
    if (ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const path = staticAccessPath(child.left), root = path?.[0]
      if (root && ['key', 'client', 'facade', 'state', 'checkout'].includes(root)
        && !(path?.length === 2 && root === 'checkout' && path[1] === 'removeApplicationListeners')) invalidWrite = true
      if (root === 'method' && !branchAssignment(child)) invalidWrite = true
    }
    if ((ts.isPostfixUnaryExpression(child) || (ts.isPrefixUnaryExpression(child)
      && (child.operator === ts.SyntaxKind.PlusPlusToken || child.operator === ts.SyntaxKind.MinusMinusToken)))
      && staticAccessPath(child.operand)?.[0] === 'method') invalidWrite = true
    child.forEachChild(walk)
  }
  walk(owner)
  return cacheReferences === 4 && !invalidWrite ? node : null
}

function facadeQueryAdapter(fn: FunctionLike): boolean {
  if (!ts.isArrowFunction(fn) || fn.parameters.length !== 1 || !fn.parameters[0].dotDotDotToken
    || !ts.isIdentifier(fn.parameters[0].name) || fn.parameters[0].name.text !== 'args'
    || !facadeExpressionMatches(fn.body, 'publicQuery(args, state, checkout)')) return false
  const assignment = fn.parent
  const statement = assignment.parent, block = statement.parent, branch = block.parent
  return ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(assignment.left) && assignment.left.text === 'method'
    && ts.isExpressionStatement(statement) && ts.isBlock(block) && block.statements.length === 1
    && ts.isIfStatement(branch) && branch.thenStatement === block
    && facadeExpressionMatches(branch.expression, "key === 'query'") && !!facadeGetter(fn)
}

const FACADE_EVENT_METHOD = `(event, listener) => {
  requireCurrent();
  if (event === 'newListener' || event === 'removeListener') refuse();
  const wrapped = (...args) => {
    if (!current(checkout)) return undefined;
    return Reflect.apply(listener, facade, args.map(value => value === client ? facade : value));
  };
  listeners.push({ event, original: listener, wrapped });
  Reflect.apply(Reflect.get(client, key), client, [event, wrapped]);
  return facade;
}`
const FACADE_PUBLIC_METHOD = `(...args) => {
  requireCurrent();
  if (state.owner) refuse();
  const result = Reflect.apply(Reflect.get(client, key), client, args);
  return result === client ? facade : result;
}`
type NonSqlReflectRole = 'event-registration' | 'event-notification' | 'public-method'

function classifyFacadeReflect(call: ts.CallExpression, ctx: NativePgContext): NonSqlReflectRole | null {
  if (!ctx.pinned || !nativeBindingsStable(ctx) || !facadeGetter(call)) return null
  for (const name of ['Proxy', 'Object', 'Map', 'Set']) {
    if (nativeBinding(name, ctx.unit.source).length || nativeBinding(name, ctx.module).length) return null
  }
  let arrow: ts.Node | undefined = call.parent
  while (arrow && !ts.isMethodDeclaration(arrow)) {
    if (ts.isArrowFunction(arrow) && ts.isBinaryExpression(arrow.parent)
      && ts.isIdentifier(arrow.parent.left) && arrow.parent.left.text === 'method') {
      const statement = arrow.parent.parent, block = statement.parent, branch = block.parent
      if (!ts.isExpressionStatement(statement) || !ts.isBlock(block) || block.statements.length !== 1
        || !ts.isIfStatement(branch) || branch.thenStatement !== block) return null
      const event = facadeExpressionMatches(arrow, FACADE_EVENT_METHOD)
      const ordinary = facadeExpressionMatches(arrow, FACADE_PUBLIC_METHOD)
      const bindingName = event ? 'eventAdders' : ordinary ? 'publicMethods' : null
      if (!bindingName || !facadeExpressionMatches(branch.expression, `typeof key === 'string' && ${bindingName}.has(key)`)) return null
      const local = nativeBinding(bindingName, ctx.unit.source)
      const bindings = local.length ? local : nativeBinding(bindingName, ctx.module)
      if (bindings.length !== 1 || !ts.isVariableDeclaration(bindings[0]) || !bindings[0].initializer
        || !ts.isVariableDeclarationList(bindings[0].parent) || !(bindings[0].parent.flags & ts.NodeFlags.Const)) return null
      const members = event ? ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']
        : ['escapeIdentifier', 'escapeLiteral', 'setTypeParser', 'getTypeParser', 'ref', 'unref',
          'eventNames', 'listenerCount', 'getMaxListeners', 'setMaxListeners']
      if (!facadeExpressionMatches(bindings[0].initializer, `new Set(${JSON.stringify(members)})`)) return null
      let stable = true
      const inspect = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === bindingName && node !== bindings[0].name) {
          const parent = node.parent
          if (!(ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'has'
            && ts.isCallExpression(parent.parent) && parent.parent.expression === parent && parent.parent.arguments.length === 1)) stable = false
        }
        node.forEachChild(inspect)
      }
      inspect(ctx.module)
      if (ctx.module !== ctx.unit.source) inspect(ctx.unit.source)
      if (!stable) return null
      return ordinary ? 'public-method' : ts.isIdentifier(call.arguments[0]) ? 'event-notification' : 'event-registration'
    }
    arrow = arrow.parent
  }
  return null
}

type NativeInvocation = { kind: 'sql'; argument: ts.Expression } | { kind: 'protocol' }
  | { kind: 'nonSql'; role: NonSqlReflectRole }
  | { kind: 'finding'; reason: string }

function classifyNativeInvocation(call: ts.CallExpression, ctx: NativePgContext): NativeInvocation | null {
  const callee = unwrapExpression(call.expression)
  const path = nativePath(callee, ctx)
  // Retain the spelling as a refusal candidate even if Reflect is shadowed or
  // reassigned. Alias invocations are recognized, but only the direct shape passes.
  const spelled = reflectInvocationPath(callee, ctx)
  const reflectApply = nativePathIs(path, ['Reflect', 'apply'])
    || (spelled?.[0] === 'Reflect' && (spelled[spelled.length - 1] === 'apply'
      || spelled[spelled.length - 1] === '<computed>'))
  if (reflectApply) {
    const refusal: NativeInvocation = { kind: 'finding', reason: 'unproven native Reflect.apply SQL transport — refused' }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
      && callee.expression.text === 'Reflect' && nativePathIs(path, ['Reflect', 'apply']) && call.arguments.length === 3) {
      const role = classifyFacadeReflect(call, ctx)
      if (role) return { kind: 'nonSql', role }
    }
    if (!ctx.pinned || !ts.isPropertyAccessExpression(callee)
      || !ts.isIdentifier(callee.expression) || callee.expression.text !== 'Reflect'
      || !nativePathIs(path, ['Reflect', 'apply']) || call.arguments.length !== 3
      || !nativePathIs(nativePath(call.arguments[0], ctx), ['pg.Client', 'prototype', 'query'])
      || !nativeBindingsStable(ctx)) return refusal
    const fn = enclosingFunctionOf(call)
    const carrier = unwrapExpression(call.arguments[2])
    const receiver = unwrapExpression(call.arguments[1])
    if (!fn || fn.parameters.length !== 2 || !ts.isIdentifier(fn.parameters[0].name)
      || !ts.isIdentifier(fn.parameters[1].name) || !ts.isIdentifier(carrier)
      || carrier.text !== fn.parameters[0].name.text || !ts.isPropertyAccessExpression(receiver)
      || receiver.name.text !== 'client' || !ts.isIdentifier(receiver.expression)
      || receiver.expression.text !== fn.parameters[1].name.text) return refusal
    // This exact transport forwards its carrier untouched. Reject parameter
    // mutation, aliases, helper escapes or reads that could replace args[0].
    let untouched = true
    const inspectCarrier = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === carrier.text
        && node !== fn.parameters[0].name && node !== carrier) untouched = false
      node.forEachChild(inspectCarrier)
    }
    inspectCarrier(fn)
    return untouched ? { kind: 'sql', argument: call.arguments[2] } : refusal
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'call'
    && nativePathIs(nativePath(callee.expression, ctx), ['pg.Client', 'prototype', '_handleReadyForQuery'])) {
    const fn = enclosingFunctionOf(call)
    const parent = fn?.parent
    const extendsPg = parent && ts.isClassDeclaration(parent) && parent.heritageClauses?.some(clause =>
      clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some(type =>
        nativePathIs(nativePath(type.expression, ctx), ['pg.Client'])))
    const message = call.arguments[1] && unwrapExpression(call.arguments[1])
    if (ctx.pinned && nativeBindingsStable(ctx) && call.arguments.length === 2
      && call.arguments[0].kind === ts.SyntaxKind.ThisKeyword && fn && ts.isMethodDeclaration(fn)
      && fn.parameters.length === 1 && ts.isIdentifier(fn.parameters[0].name)
      && fn.name && propertyNameText(fn.name) === '_handleReadyForQuery' && extendsPg
      && message && ts.isIdentifier(message) && message.text === fn.parameters[0].name.text) {
      return { kind: 'protocol' }
    }
    return { kind: 'finding', reason: 'unproven native pg ReadyForQuery callback — refused' }
  }
  return null
}

const PG_EXISTING_CONFIG_BUILDER = `{
  const timeoutMs = Number(options?.timeoutMs ?? 0);
  const queryConfig = { text: sql, values: params };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    queryConfig.query_timeout = Math.floor(timeoutMs);
    queryConfig.statement_timeout = Math.floor(timeoutMs);
  }
  return queryConfig;
}`

const PG_REJECTION_DELIVERY = `function rejectedQuery(args, error) {
  const config = args[0];
  const callback = [...args].reverse().find(value => typeof value === 'function') ?? config?.callback;
  if (typeof callback === 'function') { queueMicrotask(() => callback(error)); return undefined; }
  if (typeof config?.submit === 'function') throw error;
  return Promise.reject(error);
}`

/** Root writes and whole-carrier escapes are refused in every forwarding
 * adapter, not just at submit. This is not an alias graph: a new carrier alias
 * is a refusal. The existing args[0]/submit inspection is read-only and closed.
 */
function pgFormalUnchanged(fn: FunctionLike, name: string, ctx: ClassifierContext): boolean {
  let stable = true
  const root = (node: ts.Expression): ts.Expression => {
    let value = unwrapExpression(node)
    while (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) value = unwrapExpression(value.expression)
    return value
  }
  const rooted = (node: ts.Expression): boolean => { const value = root(node); return ts.isIdentifier(value) && value.text === name }
  const readonlyInspection = (declaration: ts.VariableDeclaration): boolean => {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)
      || !facadeExpressionMatches(declaration.initializer, `${name}[0]`)) return false
    const alias = declaration.name.text
    const inspect = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === alias && node !== declaration.name) {
        const parent = node.parent
        const truthTest = ts.isBinaryExpression(parent) && parent.left === node
          && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        const submitType = ts.isPropertyAccessExpression(parent) && parent.expression === node
          && parent.name.text === 'submit' && ts.isTypeOfExpression(parent.parent)
        if (!truthTest && !submitType) stable = false
      }
      node.forEachChild(inspect)
    }
    if (fn.body) inspect(fn.body)
    return stable
  }
  const walk = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && rooted(node.left)) stable = false
    if (ts.isDeleteExpression(node) && rooted(node.expression)) stable = false
    if ((ts.isPostfixUnaryExpression(node) || (ts.isPrefixUnaryExpression(node)
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))) && rooted(node.operand)) stable = false
    if (ts.isVariableDeclaration(node) && node.initializer && rooted(node.initializer)) {
      const value = unwrapExpression(node.initializer)
      if (!(ts.isPropertyAccessExpression(value) && value.name.text === 'text') && !readonlyInspection(node)) stable = false
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const value = unwrapExpression(node.initializer)
      if (ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value)) {
        const inspect = (child: ts.Node): void => {
          if (ts.isIdentifier(child) && child.text === name) stable = false
          child.forEachChild(inspect)
        }
        value.forEachChild(inspect)
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && rooted(node.expression.expression)) stable = false
      node.arguments.forEach(arg => {
        const value = unwrapExpression(arg)
        if (!ts.isIdentifier(value) || value.text !== name) return
        const callee = calleeNameOf(node)
        if (callee && ctx.pgCarriers?.has(callee)) return
        const declarations = callee && ctx.closureFunctions.get(callee)
        if (!declarations || declarations.length !== 1) { stable = false; return }
        const declaration = declarations[0]
        const configBuilder = isFunctionLike(declaration) && declaration.body
          && facadeStatementMatches(declaration.body, PG_EXISTING_CONFIG_BUILDER)
        if (!configBuilder && !facadeStatementMatches(declaration, PG_REJECTION_DELIVERY)) stable = false
      })
    }
    node.forEachChild(walk)
  }
  if (fn.body) walk(fn.body)
  return stable
}

/** Project pg's SQL position before invoking the existing provenance grammar.
 * Values/callbacks never participate. The depth budget counts local aliases;
 * array/conditional syntax does not spend an extra local-provenance hop.
 */
function classifyPgCarrier(
  arg: ts.Expression, call: ts.Node, ctx: ClassifierContext,
  carrier: 'arguments' | 'input', depth = 0, seen = new Set<ts.Node>(),
): Classification {
  const value = unwrapExpression(arg)
  const refuse = (reason: string): Classification => ({ kind: 'finding', reason: `native pg SQL carrier: ${reason}` })
  const fn = enclosingFunctionOf(call)
  const formal = fn && ts.isIdentifier(value) ? formalParameterIndex(fn).get(value.text) : undefined
  if (formal !== undefined && ts.isIdentifier(value)) {
    if (formal !== 0) return refuse('SQL provenance is not the first formal parameter')
    const nativeTransport = ts.isCallExpression(call) && call.arguments[2] === arg
      && facadeExpressionMatches(call.expression, 'Reflect.apply')
    if (!nativeTransport && !pgFormalUnchanged(fn!, value.text, ctx)) return refuse('forwarding formal is written, aliased or escapes')
    const verdict = classifySqlArgument(value, call, ctx)
    return verdict.kind === 'passthrough'
      ? { ...verdict, carrier: carrier === 'arguments' && fn!.parameters[0].dotDotDotToken ? 'input' : carrier }
      : verdict
  }
  if (ts.isIdentifier(value)) {
    const local = resolveLocalBinding(value.text, value)
    if (local) {
      if (depth >= 4 || seen.has(local)) return refuse('local provenance budget exhausted')
      return classifyPgCarrier(local, call, ctx, carrier, depth + 1, new Set([...seen, local]))
    }
  }
  if (ts.isConditionalExpression(value)) {
    const left = classifyPgCarrier(value.whenTrue, call, ctx, carrier, depth, seen)
    const right = classifyPgCarrier(value.whenFalse, call, ctx, carrier, depth, seen)
    if (left.kind === 'finding') return left
    if (right.kind === 'finding') return right
    if (left.kind === 'resolved' && right.kind === 'resolved' && left.sql === right.sql) return left
    if (left.kind === 'passthrough' && right.kind === 'passthrough'
      && left.adapterName === right.adapterName && left.paramIndex === right.paramIndex
      && left.provenanceLeaf === right.provenanceLeaf && left.carrier === right.carrier) return left
    return refuse('conditional SQL inputs do not prove the same source')
  }
  if (carrier === 'arguments') {
    if (!ts.isArrayLiteralExpression(value) || !value.elements.length
      || ts.isSpreadElement(value.elements[0]) || ts.isOmittedExpression(value.elements[0])) {
      return refuse('unproven argument-array first item')
    }
    return classifyPgCarrier(value.elements[0], call, ctx, 'input', depth, seen)
  }
  if (ts.isObjectLiteralExpression(value)) {
    if (value.properties.some(property => property.name && propertyNameText(property.name) === 'submit')) {
      return refuse('custom submit bypasses config.text')
    }
    if (value.properties.some(property => property.name && ts.isComputedPropertyName(property.name))) {
      return refuse('computed config key')
    }
    const text = value.properties.filter(property => property.name && propertyNameText(property.name) === 'text')
    const spreads = value.properties.filter(ts.isSpreadAssignment)
    if (text.length === 1 && !spreads.length && ts.isPropertyAssignment(text[0])) {
      return classifyPgCarrier(text[0].initializer, call, ctx, 'input', depth, seen)
    }
    // Exact COMMIT adapter: the first spread preserves the first formal's text,
    // and the only following overrides are values and query_timeout, never text.
    const first = fn?.parameters[0].name
    const spread = spreads[0] && unwrapExpression(spreads[0].expression)
    if (!text.length && spreads.length === 1 && value.properties.length === 3
      && value.properties[0] === spreads[0] && first && ts.isIdentifier(first)
      && value.properties.slice(1).every(property => ts.isPropertyAssignment(property)
        && (propertyNameText(property.name) === 'values' || propertyNameText(property.name) === 'query_timeout'))
      && spread && ts.isConditionalExpression(spread)
      && facadeExpressionMatches(spread.condition, `typeof ${first.text} === 'string'`)
      && facadeExpressionMatches(spread.whenTrue, `{ text: ${first.text} }`)
      && ts.isIdentifier(spread.whenFalse) && spread.whenFalse.text === first.text) {
      return classifyPgCarrier(spread.whenFalse, call, ctx, 'input', depth, seen)
    }
    return refuse('config.text is unknown, duplicated or hidden by an opaque spread')
  }
  if (ts.isArrayLiteralExpression(value)) return refuse('an array is not a SQL/config input')
  const verdict = classifySqlArgument(value, call, ctx)
  return verdict.kind === 'passthrough' ? { ...verdict, carrier: 'input' } : verdict
}

export function collectQuerySqlArguments(closure: CallPathClosure, repoRoot: string): SqlArguments {
  const units = parseUnits(closure)
  const literalConstants = moduleScopeLiteralConstants(closure, repoRoot)
  const closureFunctions = indexClosureFunctions(units)

  const resolved: ResolvedSqlArgument[] = []
  const passthrough: PassThroughSqlArgument[] = []
  const findings: SqlArgumentFinding[] = []
  const protocolCallbacks: ProtocolCallbackSite[] = []
  const moduleSources = new Map<string, ts.SourceFile>()
  const pgPackage = path.join(repoRoot, 'packages/core-backend/node_modules/pg/package.json')
  const pinned = fs.existsSync(pgPackage) && JSON.parse(fs.readFileSync(pgPackage, 'utf8')).version === '8.16.3'

  const nonSqlReflectCalls: Array<SqlArgumentSite & { role: NonSqlReflectRole }> = []
  const natives = new Map<ParsedUnit, NativePgContext>()
  for (const unit of units) {
    let module = moduleSources.get(unit.file)
    if (!module) {
      module = ts.createSourceFile(unit.file, fs.readFileSync(path.join(repoRoot, unit.file), 'utf8'),
        ts.ScriptTarget.ES2022, true, scriptKindFor(unit.file))
      moduleSources.set(unit.file, module)
    }
    natives.set(unit, { unit, module: unit.source.statements.some(ts.isImportDeclaration) ? unit.source : module, pinned })
  }
  const carriers = new Map<string, 'arguments' | 'input'>()
  const ambiguous = new Set<string>()
  const register = (name: string, carrier: 'arguments' | 'input'): void => {
    const previous = carriers.get(name)
    if (previous && previous !== carrier) ambiguous.add(name)
    else carriers.set(name, carrier)
  }
  for (const unit of units) {
    const seed = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && classifyNativeInvocation(node, natives.get(unit)!)?.kind === 'sql') {
        const fn = enclosingFunctionOf(node), name = fn && adapterNameOf(fn)
        if (name) register(name, 'arguments')
      }
      node.forEachChild(seed)
    }
    seed(unit.source)
  }
  for (let round = 0; round < 4; round += 1) {
    const before = carriers.size
    for (const unit of units) {
      const infer = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const mode = carriers.get(calleeNameOf(node) ?? '')
          const fn = enclosingFunctionOf(node), arg = node.arguments[0] && unwrapExpression(node.arguments[0])
          if (mode && fn && fn.parameters.length > 0 && arg && ts.isIdentifier(arg) && ts.isIdentifier(fn.parameters[0].name)
            && arg.text === fn.parameters[0].name.text) {
            const name = adapterNameOf(fn)
            if (name) register(name, mode === 'arguments' && fn.parameters[0].dotDotDotToken ? 'input' : mode)
          }
        }
        node.forEachChild(infer)
      }
      infer(unit.source)
    }
    if (carriers.size === before) break
  }
  for (const unit of units) {
    const ctx: ClassifierContext = { unit, literalConstants, closureFunctions, pgCarriers: carriers }
    const native = natives.get(unit)!
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const calleeName = calleeNameOf(node)
        const invocation = classifyNativeInvocation(node, native)
        const carrier = invocation?.kind === 'sql' ? 'arguments' : carriers.get(calleeName ?? '')
        if (invocation?.kind === 'finding' || invocation?.kind === 'protocol' || invocation?.kind === 'nonSql') {
          const site = { file: unit.file, unit: unit.name, snippet: node.getText(unit.source).replace(/\s+/g, ' ').slice(0, 200) }
          if (invocation.kind === 'finding') findings.push({ ...site, reason: invocation.reason })
          else if (invocation.kind === 'nonSql') nonSqlReflectCalls.push({ ...site, role: invocation.role })
          else protocolCallbacks.push({ ...site, target: 'pg.Client.prototype._handleReadyForQuery' })
        } else if (carrier || (calleeName && isDbSeamCalleeName(calleeName))) {
          const snippet = node.getText(unit.source).replace(/\s+/g, ' ').slice(0, 200)
          const site = { file: unit.file, unit: unit.name, snippet }
          const arg = invocation?.kind === 'sql' ? invocation.argument : node.arguments[0]
          if (!arg) {
            findings.push({ ...site, reason: 'DB-seam call with no first argument — nothing to classify' })
          } else {
            const verdict: Classification = ambiguous.has(calleeName ?? '')
              ? { kind: 'finding', reason: 'ambiguous native pg carrier signature — refused' }
              : carrier ? classifyPgCarrier(arg, node, ctx, carrier) : classifySqlArgument(arg, node, ctx)
            if (verdict.kind === 'resolved') resolved.push({ ...site, sql: verdict.sql })
            else if (verdict.kind === 'passthrough') {
              passthrough.push({
                ...site,
                adapterName: verdict.adapterName,
                paramIndex: verdict.paramIndex,
                provenanceLeaf: verdict.provenanceLeaf,
                ...(verdict.carrier ? { carrier: verdict.carrier } : {}),
              })
            } else findings.push({ ...site, reason: verdict.reason })
          }
        } else {
          const reason = unsupportedDbSeamReason(node)
          if (reason) {
            findings.push({
              file: unit.file,
              unit: unit.name,
              snippet: node.getText(unit.source).replace(/\s+/g, ' ').slice(0, 200),
              reason,
            })
          }
        }
      }
      node.forEachChild(walk)
    }
    unit.source.forEachChild(walk)
  }
  return { resolved, passthrough, findings, protocolCallbacks, nonSqlReflectCalls }
}

export interface PassThroughCallerReport {
  readonly adapterName: string
  readonly paramIndex: number
  /** Calls to `adapterName` found anywhere in the closure. */
  readonly callerCount: number
  /** Callers whose argument at `paramIndex` is neither resolved nor a valid
   *  pass-through — each one is a hole in the pass-through justification. */
  readonly unclassifiedCallers: ReadonlyArray<{ file: string; snippet: string; reason: string }>
}

/**
 * Requirement (5). For every distinct (adapterName, paramIndex) that
 * `collectQuerySqlArguments` accepted as pass-through, find the calls to that
 * name inside the closure and classify what they pass at that position.
 *
 * Caller matching is by NAME, which is a conservative OVER-approximation: two
 * unrelated functions that share a name are checked as one, so the check can
 * only demand more, never less. Stated because it is a real property of the
 * mechanism, not because it weakens the result.
 */
export function checkPassThroughCallers(
  closure: CallPathClosure,
  repoRoot: string,
  sqlArguments: SqlArguments,
): PassThroughCallerReport[] {
  const units = parseUnits(closure)
  const literalConstants = moduleScopeLiteralConstants(closure, repoRoot)
  const closureFunctions = indexClosureFunctions(units)

  const targets = new Map<string, { adapterName: string; paramIndex: number; carrier?: 'arguments' | 'input' }>()
  for (const entry of sqlArguments.passthrough) {
    targets.set(`${entry.adapterName}#${entry.paramIndex}`, {
      adapterName: entry.adapterName,
      paramIndex: entry.paramIndex,
      carrier: entry.carrier ?? targets.get(`${entry.adapterName}#${entry.paramIndex}`)?.carrier,
    })
  }

  const pgCarriers = new Map<string, 'arguments' | 'input'>()
  for (const target of targets.values()) if (target.carrier) pgCarriers.set(target.adapterName, target.carrier)
  const reports: PassThroughCallerReport[] = []
  for (const { adapterName, paramIndex, carrier } of targets.values()) {
    let callerCount = 0
    const unclassifiedCallers: Array<{ file: string; snippet: string; reason: string }> = []
    for (const unit of units) {
      const ctx: ClassifierContext = { unit, literalConstants, closureFunctions, pgCarriers }
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && calleeNameOf(node) === adapterName) {
          callerCount += 1
          const arg = node.arguments[paramIndex]
          const snippet = node.getText(unit.source).replace(/\s+/g, ' ').slice(0, 160)
          if (!arg) {
            unclassifiedCallers.push({ file: unit.file, snippet, reason: `no argument at index ${paramIndex}` })
          } else {
            const verdict = carrier ? classifyPgCarrier(arg, node, ctx, carrier) : classifySqlArgument(arg, node, ctx)
            if (verdict.kind === 'finding') {
              unclassifiedCallers.push({ file: unit.file, snippet, reason: verdict.reason })
            }
          }
        }
        node.forEachChild(walk)
      }
      unit.source.forEachChild(walk)
    }
    reports.push({ adapterName, paramIndex, callerCount, unclassifiedCallers })
  }
  return reports
}

/** Relation names following FROM / JOIN / INTO / UPDATE in a SQL string. */
export function relationsInSql(sql: string): string[] {
  const out = new Set<string>()
  for (const m of sql.matchAll(/\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)/gi)) {
    const name = m[1].toLowerCase()
    // `FROM (` subquery openers and aliases are not relations.
    if (name !== 'select') out.add(name)
  }
  return [...out]
}

export const AGGREGATE_ROUTE_ENTRY_FILE = ROUTE_ENTRY_FILE
export const AGGREGATE_ROUTE_ENTRY_PATH = ROUTE_ENTRY_PATH

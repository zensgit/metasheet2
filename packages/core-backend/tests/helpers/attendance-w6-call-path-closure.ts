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
 * Classifies the SQL-bearing argument of every DB-seam call the closure can
 * reach, into exactly three buckets: resolved (a literal SQL string, swept
 * by the DML text detectors), pass-through (forwards an adapter's own
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
 * DB-seam call sites are matched by callee name ending in `query`
 * (case-insensitive): `query`, `.query`, `runQuery`, `readOnlyQuery`,
 * `wrappedQuery`. A DB seam reached under a name outside that pattern is not
 * swept by this static leg — a real, measured limit:
 * `attendance-w6-group-effective-policy-dml-sweep.test.ts` carries a
 * measured-residual leg listing the exact shapes that fall outside it
 * (aliasing, destructured aliasing, element access, computed element access,
 * `.call`, `.apply`). The mechanism of record for W6-R1 is not this sweep —
 * it is the read-only transaction, which refuses the write whatever the call
 * site is named; this sweep is a second, independent leg over the same
 * closure.
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
}
export interface SqlArgumentFinding extends SqlArgumentSite {
  readonly reason: string
}

export interface SqlArguments {
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
    if (ts.isIdentifier(parent.left)) return parent.left.text
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
  | { kind: 'passthrough'; adapterName: string; paramIndex: number; provenanceLeaf: string }
  | { kind: 'finding'; reason: string }

interface ClassifierContext {
  readonly unit: ParsedUnit
  readonly literalConstants: Map<string, string>
  readonly closureFunctions: Map<string, ts.Node[]>
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

export function collectQuerySqlArguments(closure: CallPathClosure, repoRoot: string): SqlArguments {
  const units = parseUnits(closure)
  const literalConstants = moduleScopeLiteralConstants(closure, repoRoot)
  const closureFunctions = indexClosureFunctions(units)

  const resolved: ResolvedSqlArgument[] = []
  const passthrough: PassThroughSqlArgument[] = []
  const findings: SqlArgumentFinding[] = []

  for (const unit of units) {
    const ctx: ClassifierContext = { unit, literalConstants, closureFunctions }
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const calleeName = calleeNameOf(node)
        if (calleeName && isDbSeamCalleeName(calleeName)) {
          const snippet = node.getText(unit.source).replace(/\s+/g, ' ').slice(0, 200)
          const site = { file: unit.file, unit: unit.name, snippet }
          const arg = node.arguments[0]
          if (!arg) {
            findings.push({ ...site, reason: 'DB-seam call with no first argument — nothing to classify' })
          } else {
            const verdict = classifySqlArgument(arg, node, ctx)
            if (verdict.kind === 'resolved') resolved.push({ ...site, sql: verdict.sql })
            else if (verdict.kind === 'passthrough') {
              passthrough.push({
                ...site,
                adapterName: verdict.adapterName,
                paramIndex: verdict.paramIndex,
                provenanceLeaf: verdict.provenanceLeaf,
              })
            } else findings.push({ ...site, reason: verdict.reason })
          }
        }
      }
      node.forEachChild(walk)
    }
    unit.source.forEachChild(walk)
  }
  return { resolved, passthrough, findings }
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

  const targets = new Map<string, { adapterName: string; paramIndex: number }>()
  for (const entry of sqlArguments.passthrough) {
    targets.set(`${entry.adapterName}#${entry.paramIndex}`, {
      adapterName: entry.adapterName,
      paramIndex: entry.paramIndex,
    })
  }

  const reports: PassThroughCallerReport[] = []
  for (const { adapterName, paramIndex } of targets.values()) {
    let callerCount = 0
    const unclassifiedCallers: Array<{ file: string; snippet: string; reason: string }> = []
    for (const unit of units) {
      const ctx: ClassifierContext = { unit, literalConstants, closureFunctions }
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && calleeNameOf(node) === adapterName) {
          callerCount += 1
          const arg = node.arguments[paramIndex]
          const snippet = node.getText(unit.source).replace(/\s+/g, ' ').slice(0, 160)
          if (!arg) {
            unclassifiedCallers.push({ file: unit.file, snippet, reason: `no argument at index ${paramIndex}` })
          } else {
            const verdict = classifySqlArgument(arg, node, ctx)
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

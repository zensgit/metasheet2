import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'

/**
 * DERIVED call-path closure for the W6-1 `/effective-policy` aggregate.
 *
 * Why this exists. W6-R1's static leg used to sweep a HAND-LISTED pair of
 * files while its header claimed "the whole aggregate CALL PATH". Two probes
 * walked straight through that gap: DML injected into
 * `canReadAttendanceDirectoryReadiness` (called from inside the route block
 * but DECLARED outside it) wrote 130 rows with the sweep green, and the FSER
 * `.cjs` the route loads through `requirePluginAttendanceLib` was never swept
 * at all. A hand-listed domain cannot be completed by adding names to it; the
 * domain has to be derived.
 *
 * Shape. Start from the route registration block (itself DERIVED — anchored on
 * the route's own path literal, balanced-paren scanned), then expand
 * transitively over DECLARATIONS, not whole files:
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

/** `requirePluginAttendanceLib<...>(__dirname, '<file>')` literal arguments. */
function pluginLibRequestsIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/requirePluginAttendanceLib(?:<[\s\S]*?>)?\(\s*__dirname,\s*'([^']+)'/g)) out.push(m[1])
  return out
}

/**
 * `const <binding> = requirePluginAttendanceLib<…>(__dirname, '<file>')`
 * bindings declared in a file, so `<binding>.<prop>` reads elsewhere in the
 * closure can be resolved to a DECLARATION inside that CJS module rather than
 * pulling the whole module in.
 */
function pluginLibBindingsIn(text: string): Array<{ binding: string; libFile: string }> {
  const out: Array<{ binding: string; libFile: string }> = []
  for (const m of text.matchAll(
    // The `const` keyword is OPTIONAL in this pattern on purpose: a
    // VariableDeclaration node's own text starts at the NAME, so requiring the
    // keyword silently matched nothing once declarations (rather than whole
    // files) became the unit of expansion.
    /(?:(?:const|let|var)\s+)?([A-Za-z0-9_$]+)\s*=\s*requirePluginAttendanceLib(?:<[\s\S]*?>)?\(\s*__dirname,\s*'([^']+)'/g,
  )) {
    out.push({ binding: m[1], libFile: m[2] })
  }
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
 * Classifies the FIRST argument of every `query(...)` / `<x>.query(...)` call
 * the closure can reach.
 *
 *  - `resolved`    — a single string/template literal (or an identifier naming
 *                    a module-scope literal constant). Swept for DML verbs.
 *  - `composed`    — a STRING-COMPOSING expression: `+` concatenation, a
 *                    template with substitutions, `.concat(`/`.join(`. These
 *                    are FINDINGS, not exemptions. This is the class that
 *                    defeated the previous literal-text-only detector INSIDE
 *                    the most-swept file: `deps.query('IN' + "SERT INTO …")`
 *                    wrote rows with every sweep green. Refusing unsweepable
 *                    SQL is strictly stronger than trying to see through it.
 *  - `passthrough` — an identifier that carries SQL authored somewhere else
 *                    (a function parameter, or a local built by a call). These
 *                    are the generic pg adapter layers (`src/db/pg.ts`,
 *                    `src/integration/db/connection-pool.ts`). They author no
 *                    SQL; their callers are themselves in this closure, so the
 *                    literals they forward are swept at the authoring site.
 *                    Stated as a real limit rather than hidden: SQL reaching
 *                    the adapter from OUTSIDE this closure is out of scope by
 *                    construction.
 */
export interface SqlArguments {
  readonly resolved: ReadonlyArray<{ file: string; sql: string }>
  readonly composed: ReadonlyArray<{ file: string; snippet: string }>
  readonly passthrough: ReadonlyArray<{ file: string; snippet: string }>
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

export function collectQuerySqlArguments(closure: CallPathClosure, repoRoot: string): SqlArguments {
  const resolved: Array<{ file: string; sql: string }> = []
  const composed: Array<{ file: string; snippet: string }> = []
  const passthrough: Array<{ file: string; snippet: string }> = []

  // Module-scope literal constants, so `query(SOME_SQL_V1, …)` resolves
  // instead of being written off as unsweepable.
  const literalConstants = new Map<string, string>()
  for (const file of closure.files) {
    const absolute = path.join(repoRoot, file)
    if (!fs.existsSync(absolute)) continue
    const kind = file.endsWith('.cjs') || file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
    const source = ts.createSourceFile(
      absolute,
      fs.readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
      kind,
    )
    source.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        if (ts.isStringLiteral(decl.initializer) || ts.isNoSubstitutionTemplateLiteral(decl.initializer)) {
          literalConstants.set(decl.name.text, decl.initializer.text)
        }
      }
    })
  }

  for (const unit of closure.units) {
    const kind = unit.file.endsWith('.cjs') || unit.file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
    const source = ts.createSourceFile(`${unit.file}#${unit.name}`, unit.text, ts.ScriptTarget.ES2022, true, kind)
    // Locals declared inside this unit, so a one-hop `const sql = <expr>` can
    // be resolved rather than waved through.
    const locals = new Map<string, ts.Expression>()
    const collectLocals = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        locals.set(node.name.text, node.initializer)
      }
      node.forEachChild(collectLocals)
    }
    source.forEachChild(collectLocals)

    const classify = (arg: ts.Expression, snippet: string, depth: number): void => {
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        resolved.push({ file: unit.file, sql: arg.text })
        return
      }
      if (isStringComposing(arg)) {
        composed.push({ file: unit.file, snippet })
        return
      }
      if (ts.isIdentifier(arg)) {
        const constant = literalConstants.get(arg.text)
        if (constant !== undefined) {
          resolved.push({ file: unit.file, sql: constant })
          return
        }
        const local = locals.get(arg.text)
        if (local && depth < 3) {
          classify(local, snippet, depth + 1)
          return
        }
      }
      passthrough.push({ file: unit.file, snippet })
    }

    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const calleeName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
            ? callee.name.text
            : null
        if (calleeName === 'query') {
          const arg = node.arguments[0]
          const snippet = node.getText(source).slice(0, 200)
          if (!arg) passthrough.push({ file: unit.file, snippet })
          else classify(arg, snippet, 0)
        }
      }
      node.forEachChild(walk)
    }
    source.forEachChild(walk)
  }
  return { resolved, composed, passthrough }
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

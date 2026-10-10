/**
 * Field retype slice 3a — the §3.11 canonical-fence HOLDER census, as code.
 *
 * Design lock: docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.11 ("结构守卫") and its
 * appendix `census-r5.sh`. That script is a text grep over a HAND-WRITTEN list of 22 entry names; this module
 * derives the same kind of list from the lock primitive itself, so a new acquirer or a new wrapper cannot
 * hide by having a name nobody wrote down. Pure: it takes `{ rel, text }` sources and never touches the disk,
 * which is what lets the guard test feed it synthetic sources (falsifiability) and the in-memory mutation
 * probes feed it an edited copy of the real tree.
 *
 * THE RULE (ADR §3.11, "键集 = 锁原语判定"):
 *  1. SEEDS — every reference to `canonicalSheetFenceKey` and every string / template literal containing the
 *     literal key prefix `meta:auto-number:sheet:`.
 *  2. FIRST-ORDER ACQUIRERS — the innermost enclosing function of a seed whose subtree also carries an advisory
 *     LOCK primitive (`pg_advisory_xact_lock`, `pg_try_advisory_lock`, `…_shared`; in a literal of its own, or
 *     in a module-level constant it references). A seed with no primitive anywhere up its function chain is a
 *     PROBE (the key constructor itself; `pg_locks` look-ups) and is reported separately, never a holder.
 *     SQL: a `CREATE FUNCTION … AS $tag$ … $tag$` body holding both the key literal and a primitive is a SQL
 *     acquirer; a trigger executing one makes its table a trigger table; SQL functions that call an acquirer or
 *     write a trigger table join the set (closure).
 *  3. ENTRIES — the TS closure. A named function joins when it calls a member at its OWN scope (not inside a
 *     nested callback) handing it a query derived from its own parameters, and writes no `meta_records` row
 *     itself: the fence then outlives the call on the CALLER'S connection, so the caller is the holder.
 *     A SEAM joins too: a named function that takes the fence and then hands the fenced query to a function it
 *     received as a parameter (`withTransaction(sheetId, handler)`), ADR "回调缝规则".
 *  4. HOLDERS — every call to an entry whose innermost enclosing function is not itself an entry (the fence
 *     stops propagating there), every src literal calling a SQL acquirer, every src DML on a trigger table.
 *     Seam call sites are holders whose checked region is the handler LITERAL passed to the seam.
 *
 * Positions come from the AST (comments cannot produce seeds, calls, or writes); sources are LF-normalised
 * before parsing so a CRLF checkout cannot change a verdict.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

import ts from 'typescript'

export type CensusSource = { rel: string; text: string }

export const CANONICAL_KEY_CONSTRUCTOR = 'canonicalSheetFenceKey'
export const CANONICAL_KEY_LITERAL = 'meta:auto-number:sheet:'

const PRIMITIVE_RE = /\bpg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?\s*\(/i
/** A statement that writes `meta_records` (never `meta_records_trash` or any longer name). */
export const RECORDS_WRITE_RE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?public"?\.)?"?meta_records"?(?![\w])/i
/** A statement that writes a VALUE into `meta_records.data`: an INSERT, or an UPDATE whose SET assigns `data`.
 * (A record-lock UPDATE that sets only `locked*` columns, or a DELETE, is not a data write.) */
export const RECORDS_DATA_WRITE_RE =
  /\bINSERT\s+INTO\s+(?:"?public"?\.)?"?meta_records"?(?![\w])|\bUPDATE\s+(?:"?public"?\.)?"?meta_records"?(?![\w])[\s\S]*?\bSET\b[\s\S]*?\bdata\s*=/i
/** A row lock of any exclusive strength. */
export const ROW_LOCK_RE = /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i

export type HolderKind = 'direct' | 'seam-call' | 'sql-function-call' | 'sql-trigger-dml' | 'entry-without-caller'

type Region = {
  source: ts.SourceFile
  /** The function whose body is checked: the caller's function after the fence call, or a handler literal. */
  fn: ts.Node
  /** Only statements positioned after this offset count (the fence call's end; a handler literal's start). */
  after: number
  /** What the helper's first argument must be spelled as ('' = unknown). */
  queryBinding: string
}

export type FenceHolder = {
  key: string
  rel: string
  line: number
  scope: string
  callee: string
  kind: HolderKind
  /**
   * Where the fence is held and statements are checked:
   *  - a call to an entry: the caller's own continuation after the call (the fence was taken on the caller's
   *    connection) plus any function literal handed to the entry;
   *  - a call to a seam that fences on the CALLER'S connection (e.g. recheckManualSource(query, …, authorize)):
   *    the handler literal (if any) AND the caller's continuation;
   *  - a call to a seam that opens its OWN transaction (withTransaction(sheetId, handler)): the handler literal
   *    only — the caller's continuation runs after the seam released the fence. A non-literal handler there
   *    leaves no region (not mechanically checkable; the ledger names it).
   */
  regions: Region[]
  /**
   * Callees (qualified names) called inside a region after the fence, resolved precisely (import binding,
   * same-file declaration, `this.` method, namespace import), whose body — or, one level further down, whose own
   * callees' bodies — contains a `meta_records.data` write statement.
   */
  writesVia: string[]
  /**
   * C2-F1: callees through which the BODY of the entry / seam this holder calls writes `meta_records.data`
   * (`entry>callee`, precise resolution, two levels below the entry). Empty for the SQL kinds and for an entry
   * without a caller, whose own body already is its region.
   */
  entryWritesVia: string[]
}

export type Census = {
  seedCount: number
  /** Declaration labels `file#qualifiedName`. */
  firstOrderAcquirers: string[]
  probes: string[]
  entries: string[]
  seams: string[]
  /** Seams that open their own transaction (a caller's continuation is NOT under the fence). */
  ownTransactionSeams: string[]
  sqlAcquirers: string[]
  triggerTables: string[]
  holders: FenceHolder[]
}

// ── AST utilities ──────────────────────────────────────────────────────────────────────────────────

type FnNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

function isFn(n: ts.Node): n is FnNode {
  return ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n)
    || ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n)
    || ts.isSetAccessorDeclaration(n)
}

function propName(name: ts.Node | undefined): string {
  if (!name) return ''
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return ''
}

function className(cls: ts.Node): string {
  return (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) ? (cls.name?.text ?? '<class>') : ''
}

function unwrapParent(n: ts.Node): ts.Node {
  let p = n.parent
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)
    || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p))) p = p.parent
  return p
}

/** Qualified name of a function-like node ('' when anonymous). Methods are `Class.method`. */
function fnName(fn: FnNode): string {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? ''
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
    const n = propName(fn.name)
    if (!n) return ''
    const cls = className(fn.parent)
    return cls ? `${cls}.${n}` : n
  }
  if (ts.isConstructorDeclaration(fn)) return `${className(fn.parent) || '<class>'}.constructor`
  const p = unwrapParent(fn)
  if (!p) return ''
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (ts.isPropertyAssignment(p)) return propName(p.name)
  if (ts.isPropertyDeclaration(p)) {
    const n = propName(p.name)
    const cls = className(p.parent)
    return n ? (cls ? `${cls}.${n}` : n) : ''
  }
  return ''
}

const bare = (qualified: string): string => qualified.slice(qualified.lastIndexOf('.') + 1)

function enclosingFn(n: ts.Node): FnNode | null {
  for (let p = n.parent; p; p = p.parent) if (isFn(p)) return p
  return null
}

function nearestNamedFn(n: ts.Node): FnNode | null {
  for (let p = n.parent; p; p = p.parent) if (isFn(p) && fnName(p)) return p
  return null
}

function enclosingClassName(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) return className(p)
  return ''
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all'])

/** `router.post('/path', …, handler)` ⇒ `POST /path`. */
function routeLabel(fn: FnNode): string {
  const call = fn.parent
  if (!call || !ts.isCallExpression(call)) return ''
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || !ROUTE_METHODS.has(callee.name.text)) return ''
  const first = call.arguments[0]
  if (!first || !ts.isStringLiteralLike(first)) return ''
  return `${callee.name.text.toUpperCase()} ${first.text}`
}

/** Stable, human-readable scope of a site: the nearest named function, or the route it serves. */
function scopeLabel(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) {
    if (!isFn(p)) continue
    const name = fnName(p)
    if (name) return name
    const route = routeLabel(p)
    if (route) return route
  }
  return '<module>'
}

/** Visit a function's OWN scope: its body without descending into nested function-likes. */
function visitOwn(fn: FnNode, cb: (n: ts.Node) => void): void {
  if (!fn.body) return
  const walk = (n: ts.Node): void => {
    cb(n)
    if (isFn(n)) return
    ts.forEachChild(n, walk)
  }
  walk(fn.body)
}

function visitAll(node: ts.Node, cb: (n: ts.Node) => void): void {
  const walk = (n: ts.Node): void => {
    cb(n)
    ts.forEachChild(n, walk)
  }
  walk(node)
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Every string / template literal (comments are not literals, so prose never counts). */
function literalsIn(node: ts.Node): Array<{ node: ts.Node; text: string }> {
  const out: Array<{ node: ts.Node; text: string }> = []
  visitAll(node, (n) => {
    if (ts.isStringLiteralLike(n) && !ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent)) {
      out.push({ node: n, text: n.text })
    } else if (ts.isTemplateExpression(n)) {
      out.push({ node: n, text: [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' ') })
    }
  })
  return out
}

type CallInfo = { name: string; receiver: 'none' | 'this' | 'other' }

function calleeInfo(call: ts.CallExpression): CallInfo {
  let expr: ts.Expression = call.expression
  while (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression
  if (ts.isIdentifier(expr)) return { name: expr.text, receiver: 'none' }
  if (ts.isPropertyAccessExpression(expr)) {
    return { name: expr.name.text, receiver: expr.expression.kind === ts.SyntaxKind.ThisKeyword ? 'this' : 'other' }
  }
  return { name: '', receiver: 'none' }
}

function unwrapExpr(e: ts.Expression): ts.Expression {
  let x = e
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)
    || ts.isTypeAssertionExpression(x) || ts.isSatisfiesExpression(x) || ts.isAwaitExpression(x)) x = x.expression
  return x
}

/** The identifier a query-ish expression hangs off: `query`, `input.query` ⇒ input, `tx.query.bind(tx)` ⇒ tx,
 * `(sql, p) => client.query(sql, p)` ⇒ client. '' when there is none. */
function rootIdentifier(e: ts.Expression | undefined): string {
  if (!e) return ''
  const x = unwrapExpr(e)
  if (ts.isIdentifier(x)) return x.text
  if (x.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isPropertyAccessExpression(x)) return rootIdentifier(x.expression)
  if (ts.isCallExpression(x)) {
    const callee = x.expression
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') return rootIdentifier(callee.expression)
    return ''
  }
  if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) {
    let found = ''
    visitAll(x.body, (n) => {
      if (!found && ts.isCallExpression(n)) found = rootIdentifier(n.expression)
    })
    return found
  }
  // `ensureFields({ query: input.query, … })` / `ensureSheet({ query, … })`: the connection rides in `query`.
  if (ts.isObjectLiteralExpression(x)) {
    for (const pr of x.properties) {
      if (propName(pr.name) !== 'query') continue
      if (ts.isPropertyAssignment(pr)) return rootIdentifier(pr.initializer)
      if (ts.isShorthandPropertyAssignment(pr)) return pr.name.text
    }
    return ''
  }
  return ''
}

function paramNames(fn: FnNode): Set<string> {
  const out = new Set<string>()
  const add = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) out.add(name.text)
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) add(el.name)
  }
  for (const p of fn.parameters) add(p.name)
  return out
}

/** One hop of local aliasing inside `fn`'s own scope: `const query = input.query`, `const { query } = input`,
 * `const scoped = (s, p) => query(s, p)`. */
function localAliasRoot(fn: FnNode, name: string): string {
  let root = ''
  visitOwn(fn, (n) => {
    if (root || !ts.isVariableDeclaration(n) || !n.initializer) return
    if (ts.isIdentifier(n.name) && n.name.text === name) root = rootIdentifier(n.initializer)
    else if (ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        if (ts.isIdentifier(el.name) && el.name.text === name) root = rootIdentifier(n.initializer)
      }
    }
  })
  return root
}

function resolvedRoot(fn: FnNode, e: ts.Expression | undefined): string {
  const root = rootIdentifier(e)
  if (!root) return ''
  const alias = localAliasRoot(fn, root)
  return alias || root
}

function isParamDerived(fn: FnNode, e: ts.Expression | undefined): boolean {
  const root = resolvedRoot(fn, e)
  return root !== '' && paramNames(fn).has(root)
}

function subtreeWritesRecords(node: ts.Node): boolean {
  return literalsIn(node).some(({ text }) => RECORDS_WRITE_RE.test(collapse(text)))
}

function argText(call: ts.CallExpression, source: ts.SourceFile): string {
  const arg = call.arguments[0]
  return arg ? collapse(arg.getText(source)) : ''
}

/** What a handler literal calls its transaction query: the first parameter, or its destructured `query`. */
function handlerBinding(handler: ts.ArrowFunction | ts.FunctionExpression): string {
  const p = handler.parameters[0]
  if (!p) return ''
  if (ts.isIdentifier(p.name)) return p.name.text
  if (ts.isObjectBindingPattern(p.name)) {
    for (const el of p.name.elements) {
      const src = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : null
      const local = ts.isIdentifier(el.name) ? el.name.text : ''
      if ((src ?? local) === 'query') return local
    }
  }
  return ''
}

// ── SQL (migration-defined functions and triggers) ─────────────────────────────────────────────────

const SQL_FN_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:"?[A-Za-z_]\w*"?\.)?"?[A-Za-z_]\w*"?)\s*\(/gi
const SQL_TRIGGER_RE =
  /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?\w+"?[\s\S]*?\bON\s+((?:"?\w+"?\.)?"?\w+"?)[\s\S]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(/gi

const sqlName = (raw: string): string => raw.replace(/"/g, '').split('.').pop()!.toLowerCase()

type SqlFn = { name: string; body: string; rel: string }

function sqlFunctionsIn(text: string, rel: string): SqlFn[] {
  const out: SqlFn[] = []
  SQL_FN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SQL_FN_RE.exec(text))) {
    const rest = text.slice(m.index + m[0].length)
    const tag = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(rest)
    if (!tag) continue
    const start = tag.index + tag[0].length
    const end = rest.indexOf(tag[1], start)
    if (end < 0) continue
    out.push({ name: sqlName(m[1]), body: rest.slice(start, end), rel })
  }
  return out
}

// ── the census ─────────────────────────────────────────────────────────────────────────────────────

type Parsed = { rel: string; source: ts.SourceFile }

/**
 * A named function-like declaration. Entries, seams and acquirers are keyed by DECLARATION (file + qualified name
 * + position), never by bare name: a host-API property called `ensureObject` in index.ts is not provisioning's
 * `ensureObject`, and a private `lockSource` in one module is not a port of the same name in another (fix round
 * C1-F1 / C1-F5).
 */
type Decl = {
  id: string
  label: string
  rel: string
  name: string
  qualified: string
  kind: 'function' | 'variable' | 'method' | 'property'
  fn: FnNode
  parsed: Parsed
  /** The node whose range is the declaration's lexical scope (for same-file identifier resolution). */
  scope: ts.Node
  topLevel: boolean
}

function declKind(fn: FnNode): Decl['kind'] {
  if (ts.isFunctionDeclaration(fn)) return 'function'
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn) || ts.isConstructorDeclaration(fn)) {
    return 'method'
  }
  const p = unwrapParent(fn)
  if (p && ts.isVariableDeclaration(p)) return 'variable'
  if (p && ts.isPropertyDeclaration(p)) return 'method'
  return 'property'
}

function declScope(fn: FnNode, kind: Decl['kind']): ts.Node {
  if (kind === 'function') return fn.parent
  if (kind === 'variable') {
    let n: ts.Node = unwrapParent(fn)
    while (n && !ts.isVariableStatement(n) && !ts.isSourceFile(n)) n = n.parent
    return n && ts.isVariableStatement(n) ? n.parent : fn.getSourceFile()
  }
  return fn.getSourceFile()
}

function isTopLevel(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isSourceFile(p)) return true
    if (isFn(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isObjectLiteralExpression(p)) return false
  }
  return true
}

function resolveModule(fromRel: string, spec: string, known: ReadonlySet<string>): string | null {
  if (!spec.startsWith('.')) return null
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec))
  const stripped = base.endsWith('.js') ? base.slice(0, -3) : base
  for (const cand of [base, `${stripped}.ts`, `${stripped}/index.ts`]) if (known.has(cand)) return cand
  return null
}

type Binding = { target: string; imported: string } | { target: string; namespace: true }

export function runFenceHolderCensus(sources: readonly CensusSource[]): Census {
  const parsed: Parsed[] = sources.map(({ rel, text }) => ({
    rel,
    source: ts.createSourceFile(rel, text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true),
  }))
  const parsedByRel = new Map(parsed.map((p) => [p.rel, p]))
  const knownRels = new Set(parsed.map((p) => p.rel))

  // ── SQL acquirers, trigger tables, SQL probes ──
  const sqlFns: SqlFn[] = []
  const triggerPairs: Array<{ table: string; fn: string }> = []
  for (const { rel, source } of parsed) {
    for (const { text } of literalsIn(source)) {
      sqlFns.push(...sqlFunctionsIn(text, rel))
      SQL_TRIGGER_RE.lastIndex = 0
      let t: RegExpExecArray | null
      while ((t = SQL_TRIGGER_RE.exec(text))) triggerPairs.push({ table: sqlName(t[1]), fn: sqlName(t[2]) })
    }
  }
  const sqlAcquirers = new Set<string>()
  const probes = new Set<string>()
  for (const f of sqlFns) {
    if (!f.body.includes(CANONICAL_KEY_LITERAL)) continue
    if (PRIMITIVE_RE.test(f.body)) sqlAcquirers.add(f.name)
    else probes.add(`sql:${f.name}`)
  }
  const triggerTables = new Set<string>()
  for (let changed = true; changed;) {
    changed = false
    for (const { table, fn } of triggerPairs) {
      if (sqlAcquirers.has(fn) && !triggerTables.has(table)) {
        triggerTables.add(table)
        changed = true
      }
    }
    for (const f of sqlFns) {
      if (sqlAcquirers.has(f.name)) continue
      const callsAcquirer = [...sqlAcquirers].some((a) => new RegExp(String.raw`\b${a}\s*\(`, 'i').test(f.body))
      const writesTrigger = [...triggerTables].some((t) =>
        new RegExp(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?public"?\.)?"?${t}"?(?![\w])`, 'i').test(f.body))
      if (callsAcquirer || writesTrigger) {
        sqlAcquirers.add(f.name)
        changed = true
      }
    }
  }
  /** Literal nodes that sit inside a SQL function body carrying a seed — handled on the SQL side only. */
  const sqlBodyLiteral = (text: string): boolean =>
    sqlFunctionsIn(text, '').some((f) => f.body.includes(CANONICAL_KEY_LITERAL))

  // ── declarations and the symbol tables that resolve a call to one ──
  const decls: Decl[] = []
  const declByNode = new Map<ts.Node, Decl>()
  const localByName = new Map<string, Map<string, Decl[]>>() // rel → name → function / variable declarations
  const topByName = new Map<string, Map<string, Decl>>() // rel → name → top-level function / variable
  const methodByClassKey = new Map<string, Decl>() // `${rel}#Class.method`
  const memberByName = new Map<string, Decl[]>() // bare name → methods and object-literal properties (any file)
  for (const p of parsed) {
    const locals = new Map<string, Decl[]>()
    const tops = new Map<string, Decl>()
    visitAll(p.source, (n) => {
      if (!isFn(n)) return
      const qualified = fnName(n)
      if (!qualified) return
      const kind = declKind(n)
      const line = p.source.getLineAndCharacterOfPosition(n.getStart(p.source)).line + 1
      const d: Decl = {
        id: `${p.rel}#${qualified}@${n.getStart(p.source)}`,
        label: `${p.rel}#${qualified}`,
        rel: p.rel,
        name: bare(qualified),
        qualified,
        kind,
        fn: n,
        parsed: p,
        scope: declScope(n, kind),
        topLevel: (kind === 'function' || kind === 'variable') && isTopLevel(kind === 'function' ? n : unwrapParent(n)),
      }
      void line
      decls.push(d)
      declByNode.set(n, d)
      if (kind === 'function' || kind === 'variable') {
        locals.set(d.name, [...(locals.get(d.name) ?? []), d])
        if (d.topLevel) tops.set(d.name, d)
      } else {
        memberByName.set(d.name, [...(memberByName.get(d.name) ?? []), d])
        if (qualified.includes('.')) methodByClassKey.set(`${p.rel}#${qualified}`, d)
      }
    })
    localByName.set(p.rel, locals)
    topByName.set(p.rel, tops)
  }

  const bindingsByFile = new Map<string, Map<string, Binding>>()
  const reexportsByFile = new Map<string, { named: Map<string, { target: string; imported: string }>; star: string[] }>()
  for (const p of parsed) {
    const bindings = new Map<string, Binding>()
    const named = new Map<string, { target: string; imported: string }>()
    const star: string[] = []
    for (const stmt of p.source.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const target = resolveModule(p.rel, stmt.moduleSpecifier.text, knownRels)
        const clause = stmt.importClause
        if (!target || !clause || clause.isTypeOnly) continue
        if (clause.name) bindings.set(clause.name.text, { target, imported: 'default' })
        const nb = clause.namedBindings
        if (nb && ts.isNamespaceImport(nb)) bindings.set(nb.name.text, { target, namespace: true })
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) continue
            bindings.set(el.name.text, { target, imported: el.propertyName ? propName(el.propertyName) : el.name.text })
          }
        }
      } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const target = resolveModule(p.rel, stmt.moduleSpecifier.text, knownRels)
        if (!target) continue
        if (!stmt.exportClause) star.push(target)
        else if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            named.set(el.name.text, { target, imported: el.propertyName ? propName(el.propertyName) : el.name.text })
          }
        }
      }
    }
    bindingsByFile.set(p.rel, bindings)
    reexportsByFile.set(p.rel, { named, star })
  }

  const resolveExported = (rel: string, name: string, depth = 0): Decl | null => {
    if (depth > 5) return null
    const top = topByName.get(rel)?.get(name)
    if (top) return top
    const re = reexportsByFile.get(rel)
    const hop = re?.named.get(name)
    if (hop) return resolveExported(hop.target, hop.imported, depth + 1)
    for (const t of re?.star ?? []) {
      const d = resolveExported(t, name, depth + 1)
      if (d) return d
    }
    return null
  }

  const within = (outer: ts.Node, inner: ts.Node) => inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd()

  const resolveIdentifier = (p: Parsed, name: string, at: ts.Node): Decl[] => {
    const b = bindingsByFile.get(p.rel)?.get(name)
    if (b) {
      if ('namespace' in b) return []
      const d = resolveExported(b.target, b.imported)
      return d ? [d] : []
    }
    const locals = localByName.get(p.rel)?.get(name) ?? []
    if (locals.length <= 1) return locals
    const enclosing = locals.filter((d) => within(d.scope, at))
    if (enclosing.length === 0) return locals
    enclosing.sort((a, b) => (a.scope.getEnd() - a.scope.getStart()) - (b.scope.getEnd() - b.scope.getStart()))
    return [enclosing[0]]
  }

  type Resolution = { decls: Decl[]; precise: boolean }
  const resolutionCache = new Map<ts.CallExpression, Resolution>()
  const resolveCall = (call: ts.CallExpression, p: Parsed): Resolution => {
    const cached = resolutionCache.get(call)
    if (cached) return cached
    let out: Resolution = { decls: [], precise: true }
    let expr: ts.Expression = call.expression
    while (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression
    if (ts.isIdentifier(expr)) {
      out = { decls: resolveIdentifier(p, expr.text, call), precise: true }
    } else if (ts.isPropertyAccessExpression(expr)) {
      const member = expr.name.text
      const recv = expr.expression
      if (recv.kind === ts.SyntaxKind.ThisKeyword) {
        const d = methodByClassKey.get(`${p.rel}#${enclosingClassName(call)}.${member}`)
        out = { decls: d ? [d] : [], precise: true }
      } else {
        const ns = ts.isIdentifier(recv) ? bindingsByFile.get(p.rel)?.get(recv.text) : undefined
        if (ns && 'namespace' in ns) {
          const d = resolveExported(ns.target, member)
          out = { decls: d ? [d] : [], precise: true }
        } else {
          // Another receiver (`svc.patchRecords(…)`, `deps.transaction(…)`): statically unknown. Fall back to the
          // methods / object-literal properties of that name — never to free functions — so a receiver call can
          // still reach a method entry (fail-closed: at worst an extra holder to classify).
          out = { decls: memberByName.get(member) ?? [], precise: false }
        }
      }
    }
    resolutionCache.set(call, out)
    return out
  }

  // ── TS seeds → first-order acquirers / probes ──
  const primitiveConstsByFile = new Map<string, Set<string>>()
  for (const p of parsed) {
    const consts = new Set<string>()
    for (const stmt of p.source.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        if (literalsIn(decl.initializer).some(({ text }) => PRIMITIVE_RE.test(text))) consts.add(decl.name.text)
      }
    }
    primitiveConstsByFile.set(p.rel, consts)
  }
  const fnHasPrimitive = (fn: FnNode, p: Parsed): boolean => {
    if (literalsIn(fn).some(({ text }) => PRIMITIVE_RE.test(text))) return true
    const consts = primitiveConstsByFile.get(p.rel)!
    if (consts.size === 0) return false
    let hit = false
    visitAll(fn, (n) => {
      if (!hit && ts.isIdentifier(n) && consts.has(n.text)) hit = true
    })
    return hit
  }

  let seedCount = 0
  const acquirers = new Set<string>() // decl ids
  for (const p of parsed) {
    const seeds: ts.Node[] = []
    visitAll(p.source, (n) => {
      if (ts.isIdentifier(n) && n.text === CANONICAL_KEY_CONSTRUCTOR) {
        const parent = n.parent
        if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return
        if (ts.isFunctionDeclaration(parent) && parent.name === n) return // the constructor's own name
        seeds.push(n)
      }
    })
    for (const { node, text } of literalsIn(p.source)) {
      if (text.includes(CANONICAL_KEY_LITERAL) && !sqlBodyLiteral(text)) seeds.push(node)
    }
    for (const seed of seeds) {
      seedCount += 1
      // Walk out from the seed through anonymous closures up to (and including) the first NAMED function: the
      // key and the primitive must meet inside it. A named function without a primitive is a probe.
      let acquired: Decl | null = null
      let anonymous = false
      for (let f = enclosingFn(seed); f; f = enclosingFn(f)) {
        if (fnHasPrimitive(f, p)) {
          const named = fnName(f) ? f : nearestNamedFn(f)
          acquired = named ? declByNode.get(named) ?? null : null
          anonymous = !named
          break
        }
        if (fnName(f)) break
      }
      if (acquired) acquirers.add(acquired.id)
      else if (anonymous) probes.add(`${p.rel}#<anonymous acquirer>`) // fail-closed: surfaces in the probe ledger
      else {
        const named = nearestNamedFn(seed)
        probes.add(`${p.rel}#${named ? fnName(named) : '<module>'}`)
      }
    }
  }

  // ── closure: entries + seams ──
  const entries = new Set<string>(acquirers)
  const seams = new Set<string>()
  const ownTxnSeams = new Set<string>()
  const allCalls: Array<{ call: ts.CallExpression; parsed: Parsed }> = []
  for (const p of parsed) visitAll(p.source, (n) => { if (ts.isCallExpression(n)) allCalls.push({ call: n, parsed: p }) })
  const parsedOf = (n: ts.Node): Parsed => parsedByRel.get(n.getSourceFile().fileName)!

  const entryTarget = (call: ts.CallExpression): Decl | null =>
    resolveCall(call, parsedOf(call)).decls.find((d) => entries.has(d.id)) ?? null
  const declOf = (fn: ts.Node | null | undefined): Decl | null => (fn ? declByNode.get(fn) ?? null : null)

  const isSeam = (f: FnNode, g: FnNode, fence: ts.CallExpression): boolean => {
    // ADR "回调缝规则": a seam's own closure writes nothing — it only fences and hands over. A function that
    // also writes `meta_records` itself is a holder in its own right and is checked where it writes.
    if (subtreeWritesRecords(f)) return false
    const params = paramNames(f)
    const fenceRoot = resolvedRoot(g, fence.arguments[0]) || resolvedRoot(f, fence.arguments[0])
    if (!fenceRoot) return false
    let seam = false
    visitOwn(g, (n) => {
      if (seam || !ts.isCallExpression(n) || n.getStart() < fence.getEnd()) return
      const calleeRoot = rootIdentifier(n.expression)
      if (!params.has(calleeRoot)) return
      const handsQuery = n.arguments.some((a) => {
        if (ts.isObjectLiteralExpression(a)) {
          return a.properties.some((pr) => {
            const init = ts.isPropertyAssignment(pr) ? pr.initializer : ts.isShorthandPropertyAssignment(pr) ? pr.name : null
            return !!init && (resolvedRoot(g, init) === fenceRoot || resolvedRoot(f, init) === fenceRoot)
          })
        }
        return resolvedRoot(g, a) === fenceRoot || resolvedRoot(f, a) === fenceRoot
      })
      if (handsQuery) seam = true
    })
    return seam
  }

  for (let changed = true; changed;) {
    changed = false
    for (const d of decls) {
      if (entries.has(d.id)) continue
      let joinedVia: ts.CallExpression | null = null
      visitOwn(d.fn, (n) => {
        if (joinedVia || !ts.isCallExpression(n) || !entryTarget(n)) return
        if (isParamDerived(d.fn, n.arguments[0]) && !subtreeWritesRecords(d.fn)) joinedVia = n
      })
      if (joinedVia) {
        entries.add(d.id)
        // An entry that ALSO hands the fenced query to a callback it was given is a seam on the CALLER'S connection.
        if (isSeam(d.fn, d.fn, joinedVia)) seams.add(d.id)
        changed = true
      }
    }
    for (const { call } of allCalls) {
      if (!entryTarget(call)) continue
      const g = enclosingFn(call)
      if (!g || entries.has(declOf(g)?.id ?? '')) continue
      const f = fnName(g) ? g : nearestNamedFn(g)
      const fd = declOf(f)
      if (!f || !fd || entries.has(fd.id)) continue
      if (isSeam(f, g, call)) {
        entries.add(fd.id)
        seams.add(fd.id)
        ownTxnSeams.add(fd.id)
        changed = true
      }
    }
  }

  // ── writes reachable through callees (C1-F4): precise resolution only, two levels ──
  const writesMemo = new Map<string, boolean>()
  const declWritesData = (d: Decl, depth: number): boolean => {
    const memoKey = `${d.id}|${depth}`
    const hit = writesMemo.get(memoKey)
    if (hit !== undefined) return hit
    writesMemo.set(memoKey, false) // cycle guard
    let writes = literalsIn(d.fn).some(({ text }) => RECORDS_DATA_WRITE_RE.test(collapse(text)))
    if (!writes && depth > 1) {
      visitAll(d.fn, (n) => {
        if (writes || !ts.isCallExpression(n)) return
        const r = resolveCall(n, d.parsed)
        if (r.precise && r.decls.some((x) => x !== d && declWritesData(x, depth - 1))) writes = true
      })
    }
    writesMemo.set(memoKey, writes)
    return writes
  }
  const writesViaOf = (regions: Region[]): string[] => {
    const via = new Set<string>()
    for (const region of regions) {
      const p = parsedOf(region.fn)
      visitAll(region.fn, (n) => {
        if (!ts.isCallExpression(n) || n.getStart() < region.after) return
        const r = resolveCall(n, p)
        if (!r.precise) return
        for (const d of r.decls) if (declWritesData(d, 2)) via.add(d.qualified)
      })
    }
    return [...via].sort()
  }
  /**
   * C2-F1 (slice 3b): the writes made INSIDE the body of the entry / seam a holder calls, through a callee. A
   * holder's region starts where the entry call ENDS, so nothing the entry itself does was ever followed — and an
   * entry stays an entry as long as its own literals write no `meta_records` row. Here the entry's own calls are
   * resolved precisely and followed the same two levels as a region's callees (the callee's body, and its callees'
   * bodies). Named `entry>callee` so a reviewer sees on which side of the call the write sits. Every call of the
   * body counts, before or after the fence statement inside it: a write just before the fence is unfenced, which
   * is no better.
   */
  const entryWritesViaOf = (target: Decl): string[] => {
    const via = new Set<string>()
    visitAll(target.fn, (n) => {
      if (!ts.isCallExpression(n)) return
      const r = resolveCall(n, target.parsed)
      if (!r.precise) return
      for (const d of r.decls) if (d !== target && declWritesData(d, 2)) via.add(`${target.qualified}>${d.qualified}`)
    })
    return [...via].sort()
  }

  // ── holders ──
  const holders: FenceHolder[] = []
  const lineOf = (s: ts.SourceFile, pos: number) => s.getLineAndCharacterOfPosition(pos).line + 1
  const fnLiteralArgs = (call: ts.CallExpression, p: Parsed): Region[] =>
    call.arguments
      .filter((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
      .map((a) => ({ source: p.source, fn: a, after: a.getStart(p.source), queryBinding: handlerBinding(a) }))
  for (const { call, parsed: p } of allCalls) {
    const target = entryTarget(call)
    if (!target) continue
    const g = enclosingFn(call)
    if (g && entries.has(declOf(g)?.id ?? '')) continue // delegation inside an entry / seam
    const named = nearestNamedFn(call)
    if (named && entries.has(declOf(named)?.id ?? '')) continue // e.g. the fence inside a seam's own transaction callback
    const scope = scopeLabel(call)
    const continuation: Region[] = g ? [{ source: p.source, fn: g, after: call.getEnd(), queryBinding: argText(call, p.source) }] : []
    let kind: HolderKind = 'direct'
    let regions: Region[]
    if (ownTxnSeams.has(target.id)) {
      kind = 'seam-call'
      regions = fnLiteralArgs(call, p)
    } else if (seams.has(target.id)) {
      kind = 'seam-call'
      regions = [...fnLiteralArgs(call, p), ...continuation] // C1-F2: the caller's own statements are fenced too
    } else {
      regions = [...continuation, ...fnLiteralArgs(call, p)] // C1-F4(b): a handler handed to an entry runs fenced
    }
    holders.push({
      key: `${p.rel} :: ${scope} :: ${target.name}`,
      rel: p.rel,
      line: lineOf(p.source, call.getStart(p.source)),
      scope,
      callee: target.name,
      kind,
      regions,
      writesVia: writesViaOf(regions),
      entryWritesVia: entryWritesViaOf(target),
    })
  }
  if (sqlAcquirers.size > 0 || triggerTables.size > 0) {
    const fnRe = sqlAcquirers.size > 0 ? new RegExp(String.raw`\b(?:"?public"?\.)?(${[...sqlAcquirers].join('|')})\s*\(`, 'i') : null
    const trigRe = triggerTables.size > 0
      ? new RegExp(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?public"?\.)?"?(${[...triggerTables].join('|')})"?(?![\w])`, 'i')
      : null
    for (const p of parsed) {
      if (p.rel.startsWith('db/migrations/')) continue // definitions, not invocations
      for (const { node, text } of literalsIn(p.source)) {
        if (/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i.test(text)) continue
        const g = enclosingFn(node)
        const regions: Region[] = g ? [{ source: p.source, fn: g, after: node.getEnd(), queryBinding: '' }] : []
        const scope = scopeLabel(node)
        const line = lineOf(p.source, node.getStart(p.source))
        const fm = fnRe?.exec(text)
        if (fm) {
          const callee = `sql:${fm[1].toLowerCase()}`
          holders.push({ key: `${p.rel} :: ${scope} :: ${callee}`, rel: p.rel, line, scope, callee, kind: 'sql-function-call', regions, writesVia: writesViaOf(regions), entryWritesVia: [] })
        }
        const tm = trigRe?.exec(text)
        if (tm) {
          const callee = `sql-dml:${tm[1].toLowerCase()}`
          holders.push({ key: `${p.rel} :: ${scope} :: ${callee}`, rel: p.rel, line, scope, callee, kind: 'sql-trigger-dml', regions, writesVia: writesViaOf(regions), entryWritesVia: [] })
        }
      }
    }
  }
  // An entry nobody in this tree calls — a host port a PLUGIN calls with its own transaction (the attendance
  // `cleanupProposal` / `lockSource` ports), or an exported primitive with no caller yet (ADR rows 30 / 31) — would
  // otherwise drop out of the census entirely. Surface it as a holder of its own so it has to be classified.
  const called = new Set<string>()
  for (const { call } of allCalls) for (const d of resolveCall(call, parsedOf(call)).decls) called.add(d.id)
  for (const d of decls) {
    if (!entries.has(d.id) || called.has(d.id)) continue
    const regions: Region[] = [{ source: d.parsed.source, fn: d.fn, after: d.fn.getStart(d.parsed.source), queryBinding: '' }]
    holders.push({
      key: `${d.rel} :: ${d.qualified} :: <no in-tree call>`,
      rel: d.rel,
      line: lineOf(d.parsed.source, d.fn.getStart(d.parsed.source)),
      scope: d.qualified,
      callee: '<no in-tree call>',
      kind: 'entry-without-caller',
      regions,
      writesVia: writesViaOf(regions),
      entryWritesVia: [],
    })
  }
  holders.sort((a, b) => a.key.localeCompare(b.key) || a.line - b.line)

  const labels = (ids: Iterable<string>) =>
    [...new Set([...ids].map((id) => decls.find((d) => d.id === id)!.label))].sort()
  return {
    seedCount,
    firstOrderAcquirers: labels(acquirers),
    probes: [...probes].sort(),
    entries: labels(entries),
    seams: labels(seams),
    ownTransactionSeams: labels(ownTxnSeams),
    sqlAcquirers: [...sqlAcquirers].sort(),
    triggerTables: [...triggerTables].sort(),
    holders,
  }
}

// ── checks on one holder ───────────────────────────────────────────────────────────────────────────

export type HelperCheck = { ok: true } | { ok: false; reason: string }

/**
 * The 必接 rule: in the holder's regions, AFTER the fence, a call to `helper` handed the SAME query the fence
 * was taken on, positioned before the first `meta_records` write or `FOR UPDATE` row lock of that region. Every
 * region with such a statement needs its own helper call before it; at least one region must call the helper.
 * The helper must sit at the region's own scope (a call buried in a nested callback might never run).
 */
export function checkHelperBeforeFirstWrite(holder: FenceHolder, helper: string): HelperCheck {
  if (holder.regions.length === 0) return { ok: false, reason: 'the seam handler is not a literal — nothing to inspect' }
  let anyHelper = false
  for (const region of holder.regions) {
    const fn = region.fn as FnNode
    let helperAt = -1
    const foreign: string[] = []
    visitOwn(fn, (n) => {
      if (!ts.isCallExpression(n) || calleeInfo(n).name !== helper) return
      const at = n.getStart(region.source)
      if (at < region.after) return
      const arg = argText(n, region.source)
      if (region.queryBinding !== '' && arg !== region.queryBinding) {
        foreign.push(arg)
        return
      }
      if (helperAt === -1 || at < helperAt) helperAt = at
    })
    let firstWriteAt = -1
    for (const { node, text } of literalsIn(fn)) {
      const at = node.getStart(region.source)
      if (at < region.after) continue
      const sql = collapse(text)
      if (RECORDS_WRITE_RE.test(sql) || ROW_LOCK_RE.test(sql)) {
        if (firstWriteAt === -1 || at < firstWriteAt) firstWriteAt = at
      }
    }
    if (helperAt !== -1) anyHelper = true
    if (foreign.length > 0 && helperAt === -1) {
      return { ok: false, reason: `${helper} is called with ${foreign.join(', ')} instead of the fenced query ${region.queryBinding}` }
    }
    if (firstWriteAt !== -1 && helperAt === -1) return { ok: false, reason: `${helper} is not called after the fence` }
    if (firstWriteAt !== -1 && firstWriteAt < helperAt) {
      return { ok: false, reason: `${helper} runs after the first meta_records write / row lock` }
    }
  }
  return anyHelper ? { ok: true } : { ok: false, reason: `${helper} is not called after the fence` }
}

/** Statements writing a value into `meta_records.data`, positioned after the fence in the holder's regions —
 * the mechanical half of the 非数据写入者 verdict; writes a callee makes are in `writesVia`. */
export function directRecordDataWritesAfterFence(holder: FenceHolder): string[] {
  const out: string[] = []
  for (const region of holder.regions) {
    for (const { node, text } of literalsIn(region.fn)) {
      if (node.getStart(region.source) < region.after) continue
      const sql = collapse(text)
      if (RECORDS_DATA_WRITE_RE.test(sql)) out.push(sql.slice(0, 80))
    }
  }
  return out
}

/** A `meta_fields` read that takes a row lock on the field row (any strength): a concurrent schema change waits
 * for this transaction, and this transaction reads the committed row. */
export const FIELD_ROW_LOCKED_READ_RE =
  /\bSELECT\b[\s\S]*?\bFROM\s+(?:"?public"?\.)?"?meta_fields"?(?![\w])[\s\S]*?\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|(?:KEY\s+)?SHARE)\b/i

/** `node` is the statement text of a call that is a TOP-LEVEL statement of `fn` — not inside a branch, a loop, a
 * `try`, or a nested callback — so no path from the fence to a later statement of `fn` can skip it. */
function topLevelCallOf(fn: FnNode, node: ts.Node): ts.CallExpression | null {
  const call = node.parent
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== node) return null
  let n: ts.Node = call
  while (n.parent && (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent)
    || ts.isVariableDeclaration(n.parent) || ts.isVariableDeclarationList(n.parent))) n = n.parent
  const statement = n.parent
  if (!statement || !(ts.isVariableStatement(statement) || ts.isExpressionStatement(statement))) return null
  return statement.parent === fn.body ? call : null
}

/**
 * The mechanical half of the 免检 verdict "the field row is read under a lock AFTER the fence" (the field retype
 * conversion's own two transactions). In every region of the holder that writes a value into `meta_records.data`,
 * a locked read of the field row must
 *   - sit after the fence and before the first `meta_records.data` write,
 *   - be issued on the fenced query (the statement's callee is the region's query binding),
 *   - be a top-level statement of the region's function (see `topLevelCallOf`).
 * What this cannot see: whether the values written are derived from rows read under the fence. The ledger reason
 * states that and the behaviour suites pin it (PLAN_DRIFT / UNDO_PRECONDITION_FAILED).
 */
export function checkLockedFieldReadBeforeFirstDataWrite(holder: FenceHolder): HelperCheck {
  if (holder.regions.length === 0) return { ok: false, reason: 'no region to inspect' }
  let anyWrite = false
  for (const region of holder.regions) {
    const fn = region.fn as FnNode
    const literals = literalsIn(fn).map(({ node, text }) => ({ node, sql: collapse(text), at: node.getStart(region.source) }))
    let firstWriteAt = -1
    for (const { sql, at } of literals) {
      if (at < region.after || !RECORDS_DATA_WRITE_RE.test(sql)) continue
      if (firstWriteAt === -1 || at < firstWriteAt) firstWriteAt = at
    }
    if (firstWriteAt === -1) continue
    anyWrite = true
    let accepted = false
    const rejected = new Set<string>()
    for (const { node, sql, at } of literals) {
      if (!FIELD_ROW_LOCKED_READ_RE.test(sql)) continue
      if (at < region.after) { rejected.add('before the fence'); continue }
      if (at > firstWriteAt) { rejected.add('after the first meta_records.data write'); continue }
      const call = topLevelCallOf(fn, node)
      if (!call) { rejected.add('not a top-level statement of the fenced function'); continue }
      const callee = call.expression.getText(region.source)
      if (region.queryBinding !== '' && callee !== region.queryBinding) {
        rejected.add(`issued on ${callee} instead of the fenced query ${region.queryBinding}`)
        continue
      }
      accepted = true
    }
    if (!accepted) {
      return {
        ok: false,
        reason: rejected.size > 0
          ? `the locked meta_fields read is ${[...rejected].sort().join('; ')}`
          : 'no locked meta_fields read (SELECT … FROM meta_fields … FOR UPDATE / FOR SHARE) after the fence',
      }
    }
  }
  return anyWrite
    ? { ok: true }
    : { ok: false, reason: 'the holder writes no meta_records.data value in its own region, so this verdict does not describe it' }
}

// ── the real tree ──────────────────────────────────────────────────────────────────────────────────

/** Every non-test `.ts` file under `srcDir` (tests, `__tests__`, and declaration files excluded). */
export function loadCensusSources(srcDir: string): CensusSource[] {
  const out: CensusSource[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        walk(full)
      } else if (
        entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
        && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')
      ) {
        out.push({ rel: relative(srcDir, full).split(sep).join('/'), text: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(srcDir)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

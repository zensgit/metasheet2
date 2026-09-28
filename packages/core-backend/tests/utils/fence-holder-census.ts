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
import { join, relative, sep } from 'node:path'

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
  /** The function whose body is checked (the handler literal for a seam call, else the innermost function). */
  fn: ts.Node
  /** Only statements positioned after this offset count (the fence call's end; the handler start for seams). */
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
  /** null ⇒ a seam call whose handler is not a literal (a variable / property): not mechanically checkable. */
  region: Region | null
}

export type Census = {
  seedCount: number
  firstOrderAcquirers: string[]
  probes: string[]
  entries: string[]
  seams: string[]
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

export function runFenceHolderCensus(sources: readonly CensusSource[]): Census {
  const parsed: Parsed[] = sources.map(({ rel, text }) => ({
    rel,
    source: ts.createSourceFile(rel, text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true),
  }))

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

  // ── TS seeds → first-order acquirers / probes ──
  type FnEntry = { name: string; fn: FnNode; parsed: Parsed }
  const namedFns: FnEntry[] = []
  for (const p of parsed) {
    visitAll(p.source, (n) => {
      if (isFn(n)) {
        const name = fnName(n)
        if (name) namedFns.push({ name, fn: n, parsed: p })
      }
    })
  }

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
  const acquirers = new Set<string>()
  for (const p of parsed) {
    const seeds: ts.Node[] = []
    visitAll(p.source, (n) => {
      if (ts.isIdentifier(n) && n.text === CANONICAL_KEY_CONSTRUCTOR) {
        const parent = n.parent
        if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return
        if (ts.isFunctionDeclaration(parent) && parent.name === n) {
          // the constructor's own name is not a use; its body's literal is a seed (below)
          return
        }
        seeds.push(n)
      }
    })
    for (const { node, text } of literalsIn(p.source)) {
      if (text.includes(CANONICAL_KEY_LITERAL) && !sqlBodyLiteral(text)) seeds.push(node)
    }
    for (const seed of seeds) {
      seedCount += 1
      // Walk out from the seed through anonymous closures up to (and including) the first NAMED function: the
      // key and the primitive must meet inside it. A named function without a primitive is a probe — never
      // credit the seed to some unrelated outer function that happens to lock something else.
      let acquired = ''
      for (let f = enclosingFn(seed); f; f = enclosingFn(f)) {
        if (fnHasPrimitive(f, p)) {
          const named = fnName(f) ? f : nearestNamedFn(f)
          acquired = named ? fnName(named) : `<anonymous@${p.rel}>`
          break
        }
        if (fnName(f)) break
      }
      if (acquired) acquirers.add(acquired)
      else {
        const named = nearestNamedFn(seed)
        probes.add(`${p.rel}#${named ? fnName(named) : '<module>'}`)
      }
    }
  }

  // ── closure: entries + seams ──
  const entries = new Set<string>(acquirers)
  const seams = new Set<string>()
  const allCalls: Array<{ call: ts.CallExpression; parsed: Parsed }> = []
  for (const p of parsed) visitAll(p.source, (n) => { if (ts.isCallExpression(n)) allCalls.push({ call: n, parsed: p }) })

  // `import { ensureView as ensureMultitableView }` — a call through the alias is a call to the original.
  const aliasesByFile = new WeakMap<ts.SourceFile, Map<string, string>>()
  for (const p of parsed) {
    const aliases = new Map<string, string>()
    visitAll(p.source, (n) => {
      if (ts.isImportSpecifier(n) && n.propertyName) aliases.set(n.name.text, propName(n.propertyName))
    })
    aliasesByFile.set(p.source, aliases)
  }

  const resolve = (call: ts.CallExpression): string => {
    const info = calleeInfo(call)
    const { receiver } = info
    const name = receiver === 'none' ? (aliasesByFile.get(call.getSourceFile())?.get(info.name) ?? info.name) : info.name
    if (!name) return ''
    if (receiver === 'none') return entries.has(name) ? name : ''
    if (receiver === 'this') {
      const q = `${enclosingClassName(call)}.${name}`
      return entries.has(q) ? q : ''
    }
    for (const e of entries) if (bare(e) === name) return e
    return ''
  }

  const isSeam = (f: FnNode, g: FnNode, fence: ts.CallExpression): boolean => {
    // ADR "回调缝规则": a seam's own closure writes nothing — it only fences and hands over. A function that
    // also writes `meta_records` itself (RecordWriteService.patchRecords hands its fenced query to an optional
    // `preWriteGuard`) is a holder in its own right and is checked where it writes.
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
    for (const { name, fn } of namedFns) {
      if (entries.has(name)) continue
      let joinedVia: ts.CallExpression | null = null
      visitOwn(fn, (n) => {
        if (joinedVia || !ts.isCallExpression(n) || !resolve(n)) return
        if (isParamDerived(fn, n.arguments[0]) && !subtreeWritesRecords(fn)) joinedVia = n
      })
      if (joinedVia) {
        entries.add(name)
        // An entry that ALSO hands the fenced query to a callback it was given is a seam: its call sites are
        // checked on the handler literal (e.g. the w4c0 attendance operation transaction and its `body`).
        if (isSeam(fn, fn, joinedVia)) seams.add(name)
        changed = true
      }
    }
    for (const { call } of allCalls) {
      if (!resolve(call)) continue
      const g = enclosingFn(call)
      if (!g || entries.has(fnName(g))) continue
      const f = fnName(g) ? g : nearestNamedFn(g)
      if (!f || entries.has(fnName(f))) continue
      if (isSeam(f, g, call)) {
        entries.add(fnName(f))
        seams.add(fnName(f))
        changed = true
      }
    }
  }

  // ── holders ──
  const holders: FenceHolder[] = []
  const lineOf = (s: ts.SourceFile, pos: number) => s.getLineAndCharacterOfPosition(pos).line + 1
  for (const { call, parsed: p } of allCalls) {
    const target = resolve(call)
    if (!target) continue
    const g = enclosingFn(call)
    if (g && entries.has(fnName(g))) continue // delegation inside an entry / seam
    const named = nearestNamedFn(call)
    if (named && entries.has(fnName(named))) continue // e.g. the fence inside a seam's own transaction callback
    const scope = scopeLabel(call)
    const callee = bare(target)
    let region: Region | null = null
    let kind: HolderKind = 'direct'
    if (seams.has(target)) {
      kind = 'seam-call'
      const handler = [...call.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) as
        | ts.ArrowFunction
        | ts.FunctionExpression
        | undefined
      region = handler
        ? { source: p.source, fn: handler, after: handler.getStart(p.source), queryBinding: handlerBinding(handler) }
        : null
    } else if (g) {
      region = { source: p.source, fn: g, after: call.getEnd(), queryBinding: argText(call, p.source) }
    }
    holders.push({ key: `${p.rel} :: ${scope} :: ${callee}`, rel: p.rel, line: lineOf(p.source, call.getStart(p.source)), scope, callee, kind, region })
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
        const region = g ? { source: p.source, fn: g, after: node.getEnd(), queryBinding: '' } : null
        const scope = scopeLabel(node)
        const fm = fnRe?.exec(text)
        if (fm) {
          holders.push({ key: `${p.rel} :: ${scope} :: sql:${fm[1].toLowerCase()}`, rel: p.rel, line: lineOf(p.source, node.getStart(p.source)), scope, callee: `sql:${fm[1].toLowerCase()}`, kind: 'sql-function-call', region })
        }
        const tm = trigRe?.exec(text)
        if (tm) {
          holders.push({ key: `${p.rel} :: ${scope} :: sql-dml:${tm[1].toLowerCase()}`, rel: p.rel, line: lineOf(p.source, node.getStart(p.source)), scope, callee: `sql-dml:${tm[1].toLowerCase()}`, kind: 'sql-trigger-dml', region })
        }
      }
    }
  }
  // An entry nobody in this tree calls — a host port a PLUGIN calls with its own transaction (the attendance
  // `cleanupProposal` port), or an exported primitive with no caller yet (ADR rows 30 / 31) — would otherwise
  // drop out of the census entirely. Surface it as a holder of its own so it has to be classified.
  const called = new Set<string>()
  for (const { call } of allCalls) {
    const target = resolve(call)
    if (target) called.add(target)
  }
  for (const { name, fn, parsed: p } of namedFns) {
    if (!entries.has(name) || called.has(name)) continue
    holders.push({
      key: `${p.rel} :: ${name} :: <no in-tree call>`,
      rel: p.rel,
      line: lineOf(p.source, fn.getStart(p.source)),
      scope: name,
      callee: '<no in-tree call>',
      kind: 'entry-without-caller',
      region: { source: p.source, fn, after: fn.getStart(p.source), queryBinding: '' },
    })
  }
  holders.sort((a, b) => a.key.localeCompare(b.key) || a.line - b.line)

  return {
    seedCount,
    firstOrderAcquirers: [...acquirers].sort(),
    probes: [...probes].sort(),
    entries: [...entries].sort(),
    seams: [...seams].sort(),
    sqlAcquirers: [...sqlAcquirers].sort(),
    triggerTables: [...triggerTables].sort(),
    holders,
  }
}

// ── checks on one holder ───────────────────────────────────────────────────────────────────────────

export type HelperCheck = { ok: true } | { ok: false; reason: string }

/**
 * The 必接 rule: in the holder's region, AFTER the fence, a call to `helper` handed the SAME query the fence
 * was taken on, positioned before the first `meta_records` write or `FOR UPDATE` row lock that follows the
 * fence. The helper must sit at the region's own scope (a call buried in a nested callback might never run).
 */
export function checkHelperBeforeFirstWrite(holder: FenceHolder, helper: string): HelperCheck {
  const region = holder.region
  if (!region) return { ok: false, reason: 'the seam handler is not a literal — nothing to inspect' }
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
  if (helperAt === -1) {
    return {
      ok: false,
      reason: foreign.length > 0
        ? `${helper} is called with ${foreign.join(', ')} instead of the fenced query ${region.queryBinding}`
        : `${helper} is not called after the fence`,
    }
  }
  if (firstWriteAt !== -1 && firstWriteAt < helperAt) {
    return { ok: false, reason: `${helper} runs after the first meta_records write / row lock` }
  }
  return { ok: true }
}

/** Statements writing a value into `meta_records.data`, positioned after the fence in the holder's region —
 * the mechanical half of the 非数据写入者 verdict (writes a callee makes are the ledger's stated reason). */
export function directRecordDataWritesAfterFence(holder: FenceHolder): string[] {
  const region = holder.region
  if (!region) return []
  const out: string[] = []
  for (const { node, text } of literalsIn(region.fn)) {
    if (node.getStart(region.source) < region.after) continue
    const sql = collapse(text)
    if (RECORDS_DATA_WRITE_RE.test(sql)) out.push(sql.slice(0, 80))
  }
  return out
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

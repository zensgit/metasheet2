import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import ts from 'typescript'
import type { CensusSource } from './fence-holder-census'

export type ViewMutationSite = {
  key: string
  file: string
  owner: string
  kind: 'mutation' | 'caller'
  operation: string
  queryIdentity: 'query-name' | 'kysely-name' | 'ambiguous'
  count: number
  lines: number[]
}
export type ViewMutationDisposition = {
  key: string
  count: number
  disposition: 'direct-admission' | 'inherited-admission' | 'new-sheet' | 'migration' | 'ambiguous'
  reason: string
}

const digest = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
const named = (node: ts.Node): string | undefined => {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
  if (ts.isFunctionExpression(node) && node.name) return node.name.text
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text
    if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text
  }
  return undefined
}
const isFunction = (node: ts.Node): boolean => ts.isFunctionLike(node)
function functionNode(node: ts.Node): ts.Node | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (!isFunction(p)) continue
    // A literal transaction callback runs a named helper's writes; route handlers remain leaves.
    if (!named(p) && ts.isCallExpression(p.parent)
      && ts.isPropertyAccessExpression(p.parent.expression) && p.parent.expression.name.text === 'transaction'
      && p.parent.arguments.some(argument => argument === p)) continue
    return p
  }
  return undefined
}
function owner(node: ts.Node): string {
  for (let p = node.parent; p; p = p.parent) {
    const name = named(p)
    if (name) return name
  }
  return '<module>'
}
function callName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return undefined
}
function lexicalBinding(node: ts.Node, name: string): { initializer?: ts.Expression; functionName?: string } | undefined {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === name)) return {}
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue
    for (const statement of scope.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { functionName: name }
      if (!ts.isVariableStatement(statement)) continue
      for (const d of statement.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name) continue
        return { initializer: statement.declarationList.flags & ts.NodeFlags.Const ? d.initializer : undefined }
      }
    }
  }
  return undefined
}
function strings(expr: ts.Expression, seen = new Set<ts.Node>()): string[] {
  if (seen.has(expr)) return []
  const next = new Set(seen).add(expr)
  if (ts.isStringLiteralLike(expr)) return [expr.text]
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return strings(expr.expression, next)
  if (ts.isIdentifier(expr)) {
    const init = lexicalBinding(expr, expr.text)?.initializer
    return init ? strings(init, next) : []
  }
  if (ts.isConditionalExpression(expr)) return [...strings(expr.whenTrue, next), ...strings(expr.whenFalse, next)]
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return strings(expr.left, next).flatMap(a => strings(expr.right, next).map(b => a + b))
  }
  if (ts.isTemplateExpression(expr)) {
    let result = [expr.head.text]
    for (const span of expr.templateSpans) {
      const choices = strings(span.expression, next)
      result = result.flatMap(a => (choices.length ? choices : ['__value__']).map(b => a + b + span.literal.text))
    }
    return result
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const text = expr.properties.find(p => ts.isPropertyAssignment(p)
      && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'text')
    return text && ts.isPropertyAssignment(text) ? strings(text.initializer, next) : []
  }
  return []
}
type SqlToken = { kind: 'word' | 'identifier' | 'punctuation'; text: string }
function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i]!)) { i += 1; continue }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end + 1; continue
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth += 1; i += 2 }
        else if (sql.startsWith('*/', i)) { depth -= 1; i += 2 }
        else i += 1
      }
      continue
    }
    if (sql[i] === "'") {
      const escapeString = /(?:^|[^A-Za-z_0-9])E$/i.test(sql.slice(0, i))
      i += 1
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i += 1; break }
        if (escapeString && sql[i] === '\\') i += 2
        else i += 1
      }
      continue // SQL values cannot create keywords, comments or statement separators.
    }
    if (sql[i] === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length); i = end < 0 ? sql.length : end + tag.length; continue
      }
    }
    if (sql[i] === '"') {
      let text = ''; i += 1
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { text += '"'; i += 2; continue }
        if (sql[i] === '"') { i += 1; break }
        text += sql[i++]
      }
      tokens.push({ kind: 'identifier', text }); continue
    }
    const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(sql.slice(i))?.[0]
    if (word) { tokens.push({ kind: 'word', text: word }); i += word.length; continue }
    tokens.push({ kind: 'punctuation', text: sql[i++]! })
  }
  return tokens
}
function operation(sql: string): string | undefined {
  const tokens = sqlTokens(sql)
  const keyword = (index: number, value: string): boolean => tokens[index]?.kind === 'word' && tokens[index]?.text.toUpperCase() === value
  const identifier = (index: number, value: string): boolean => {
    const token = tokens[index]
    return token?.kind === 'identifier' ? token.text === value : token?.kind === 'word' && token.text.toLowerCase() === value
  }
  for (let i = 0; i < tokens.length; i += 1) {
    let op: string; let next: number
    if (keyword(i, 'UPDATE')) { op = 'UPDATE'; next = i + 1 }
    else if (keyword(i, 'INSERT') && keyword(i + 1, 'INTO')) { op = 'INSERT INTO'; next = i + 2 }
    else if (keyword(i, 'DELETE') && keyword(i + 1, 'FROM')) { op = 'DELETE FROM'; next = i + 2 }
    else continue
    if (keyword(next, 'ONLY')) next += 1
    if (tokens[next]?.text === '(') next += 1
    if (identifier(next, 'public') && tokens[next + 1]?.text === '.') next += 2
    if (identifier(next, 'meta_views')) return op
  }
  return undefined
}
const excludedCall = (call: ts.CallExpression): boolean => {
  const callee = call.expression.getText()
  return /^(?:console|logger|log)\.(?:log|info|warn|error|debug|trace)$/.test(callee)
}

/** Independent mutation-first candidate inventory; identity tags are syntax, never admission proofs. */
export function collectViewMutationCensus(sources: CensusSource[]): ViewMutationSite[] {
  const files = sources.map(source => ({ source, ast: ts.createSourceFile(source.rel,
    source.text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) }))
  const sites = new Map<string, ViewMutationSite>()
  const mutators = new Set<string>()
  const imports = new Map<string, string>()
  const add = (file: string, node: ts.CallExpression, kind: ViewMutationSite['kind'], op: string,
    identity: ViewMutationSite['queryIdentity']): void => {
    const label = owner(node)
    const shape = node.getText() // Bind receiver and argument expressions too; changing query/sheet plumbing needs review.
    const key = `${file}#${label}#${kind}#${op}#${digest(shape)}`
    const line = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1
    const prior = sites.get(key)
    if (prior) { prior.count += 1; prior.lines.push(line) }
    else sites.set(key, { key, file, owner: label, kind, operation: op, queryIdentity: identity, count: 1, lines: [line] })
  }
  for (const { source, ast } of files) {
    const walk = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node)) {
        const declaration = node.parent.parent.parent
        if (ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier)
          && declaration.moduleSpecifier.text.startsWith('.')) {
          const module = posix.normalize(posix.join(posix.dirname(source.rel), declaration.moduleSpecifier.text)).replace(/\.(?:js|ts)$/, '')
          imports.set(`${source.rel}:${node.name.text}`, `${module}.ts#${(node.propertyName ?? node.name).text}`)
        }
      }
      if (ts.isCallExpression(node) && !excludedCall(node)) {
        const name = callName(node.expression)
        const sql = node.arguments[0] ? strings(node.arguments[0]) : []
        let op = sql.map(operation).find(Boolean)
        let identity: ViewMutationSite['queryIdentity'] = name === 'query' ? 'query-name' : 'ambiguous'
        if (name && ['insertInto', 'updateTable', 'deleteFrom'].includes(name) && sql.includes('meta_views')) {
          op = `KYSELY ${name}`; identity = 'kysely-name'
        }
        if (op) {
          add(source.rel, node, 'mutation', op, identity)
          const fn = functionNode(node)
          const fnName = fn && named(fn)
          if (fnName && !source.rel.startsWith('db/migrations/')) mutators.add(`${source.rel}#${fnName}`)
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)
  }
  const resolve = (file: string, name: string, context: ts.Node, seen = new Set<ts.Node>()): string | undefined => {
    if (seen.has(context)) return undefined
    const binding = lexicalBinding(context, name)
    if (binding) {
      if (binding.functionName) return `${file}#${binding.functionName}`
      if (binding.initializer && ts.isIdentifier(binding.initializer)) {
        return resolve(file, binding.initializer.text, binding.initializer, new Set(seen).add(context))
      }
      if (binding.initializer && isFunction(binding.initializer)) return `${file}#${name}`
      return undefined // A parameter, mutable binding or other initializer shadows outer aliases.
    }
    return imports.get(`${file}:${name}`) ?? `${file}#${name}`
  }
  // Named helper closure only. Anonymous handler calls are exact leaves, not a blanket enclosing route exemption.
  const edges: { file: string; node: ts.CallExpression; target: string; identity: ViewMutationSite['queryIdentity'] }[] = []
  let changed = true
  const visited = new Set<ts.CallExpression>()
  const handoffs = new Set<ts.CallExpression>()
  while (changed) {
    changed = false
    for (const { source, ast } of files) {
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && !visited.has(node)) {
          const name = callName(node.expression)
          const localTarget = name && resolve(source.rel, name, node)
          const target = localTarget && mutators.has(localTarget) ? localTarget
            : ts.isPropertyAccessExpression(node.expression) && name
              ? [...mutators].find(id => id.endsWith(`#${name}`)) : undefined
          if (target) {
            visited.add(node)
            edges.push({ file: source.rel, node, target,
              identity: ts.isIdentifier(node.expression) ? 'query-name' : 'ambiguous' })
            const fn = functionNode(node)
            const fnName = fn && named(fn)
            if (fnName && !mutators.has(`${source.rel}#${fnName}`)) { mutators.add(`${source.rel}#${fnName}`); changed = true }
          }
        }
        if (ts.isCallExpression(node) && !handoffs.has(node)) {
          let callbackTarget: string | undefined
          const inspect = (arg: ts.Node): void => {
            if (ts.isIdentifier(arg)) {
              const id = resolve(source.rel, arg.text, arg)
              if (id && mutators.has(id)) callbackTarget = id
            }
            if (isFunction(arg)) {
              const name = named(arg)
              if (name && mutators.has(`${source.rel}#${name}`)) callbackTarget = `${source.rel}#${name}`
              return // Do not flatten arbitrary nested callback bodies into a caller.
            }
            ts.forEachChild(arg, inspect)
          }
          node.arguments.forEach(inspect)
          if (callbackTarget) {
            handoffs.add(node)
            edges.push({ file: source.rel, node, target: `callback:${callbackTarget}`, identity: 'ambiguous' })
            // A named declaration wrapping the handoff is another caller; anonymous route registrations are leaves.
            for (let p = node.parent; p; p = p.parent) {
              if (isFunction(p) && ts.isCallExpression(p.parent)
                && /^(?:get|post|put|patch|delete|use)$/.test(callName(p.parent.expression) ?? '')) break
              if (ts.isFunctionDeclaration(p) && p.name) {
                const id = `${source.rel}#${p.name.text}`
                if (!mutators.has(id)) { mutators.add(id); changed = true }
                break
              }
            }
          }
        }
        ts.forEachChild(node, walk)
      }
      walk(ast)
    }
  }
  for (const edge of edges) add(edge.file, edge.node, 'caller', edge.target, edge.identity)
  return [...sites.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** Exact count/disposition accounting; no source marker or fence can automatically admit a new candidate. */
export function checkViewMutationLedger(sites: ViewMutationSite[], ledger: ViewMutationDisposition[]): string[] {
  const errors: string[] = []
  const entries = new Map<string, ViewMutationDisposition>()
  const allowed = new Set(['direct-admission', 'inherited-admission', 'new-sheet', 'migration', 'ambiguous'])
  for (const entry of ledger) {
    if (entries.has(entry.key)) errors.push(`DUPLICATE_LEDGER:${entry.key}`)
    if (!allowed.has(entry.disposition) || !entry.reason.trim() || !Number.isInteger(entry.count) || entry.count < 1) {
      errors.push(`INVALID_DISPOSITION:${entry.key}`)
    }
    entries.set(entry.key, entry)
  }
  for (const site of sites) {
    const entry = entries.get(site.key)
    if (!entry) errors.push(`UNKNOWN_SITE:${site.key}`)
    else if (entry.count !== site.count) errors.push(`COUNT_DRIFT:${site.key}`)
    entries.delete(site.key)
  }
  for (const key of entries.keys()) errors.push(`STALE_SITE:${key}`)
  return errors.sort()
}

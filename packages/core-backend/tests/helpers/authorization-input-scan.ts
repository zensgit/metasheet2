/**
 * Static scan of writes to the privilege-classifier inputs and their cascade parents.
 *
 * TypeScript and JavaScript files are read through the TypeScript syntax tree: only string
 * literals, no-substitution templates and the literal chunks of substituted templates are matched,
 * so SQL written inside comments is not matched. A `+` chain is folded into one text before matching:
 * string literals and identifiers that resolve to a same-file `const X = '…'` contribute their text,
 * every other operand is a substitution marker. A write verb followed by a template substitution, a
 * non-literal operand of a `+` chain or a non-literal query-builder table argument is a dynamic
 * target; a verb before a substitution is recognised in its upper-case SQL spelling. SQL, shell,
 * PowerShell and workflow files are matched on their text with comments removed. SQL comments
 * inside a literal are blanked before matching, and a write target is recognised with or without
 * double quotes, in any letter case, and with white space around the dot after its schema. The
 * table argument of a query-builder call is read the same way: its double quotes, its schema and
 * its `as` alias are removed and its case is folded; an argument that is then not a bare name is a
 * dynamic target.
 *
 * A `users` UPDATE counts as an input write only when its SET clause names `role`, `is_admin` or
 * `permissions` (bare, quoted or inside a tuple assignment); a SET clause that contains a
 * substitution is a dynamic target. A `users` INSERT whose `ON CONFLICT … DO UPDATE SET` clause names
 * an input column counts as an additional `users` UPDATE. A multi-table TRUNCATE counts each
 * scanned table it names, wherever the table stands in the list.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const INPUT_TABLES = [
  'users',
  'user_roles',
  'user_permissions',
  'role_permissions',
  'user_namespace_admissions',
  'delegated_role_admin_scopes',
  'delegated_role_admin_member_groups',
] as const

export const CASCADE_PARENT_TABLES = ['roles', 'permissions', 'directory_departments', 'platform_member_groups'] as const

export const SCANNED_TABLES: ReadonlySet<string> = new Set([...INPUT_TABLES, ...CASCADE_PARENT_TABLES])

export const USERS_INPUT_COLUMNS = ['role', 'is_admin', 'permissions'] as const

export type WriteVerb = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'MERGE' | 'COPY'

export type LiteralWrite = Readonly<{
  file: string
  line: number
  /** Character offset of the verb inside the file (inside the literal for syntax-tree scans). */
  position: number
  table: string
  verb: WriteVerb
  /** `upsert`: the UPDATE implied by an INSERT's `ON CONFLICT … DO UPDATE SET` action. */
  form: 'sql' | 'query_builder' | 'folded' | 'upsert'
}>

export type DynamicForm = 'template_substitution' | 'concatenation' | 'query_builder_non_literal' | 'users_update_dynamic_set'

export type DynamicTarget = Readonly<{
  file: string
  line: number
  position: number
  form: DynamicForm
  expression: string
}>

export type ScanResult = Readonly<{ files: readonly string[]; writes: readonly LiteralWrite[]; dynamic: readonly DynamicTarget[] }>

const SUBSTITUTION = '\u0000'
const VERB = '(INSERT\\s+INTO|DELETE\\s+FROM|UPDATE|TRUNCATE(?:\\s+TABLE)?|MERGE\\s+INTO|COPY)'
const SCHEMA = '(?:"?public"?\\s*\\.\\s*)?'
const TABLE = `(?:ONLY\\s+)?${SCHEMA}("?)([A-Za-z_][A-Za-z0-9_]*)\\2`
const LITERAL_WRITE = new RegExp(`\\b${VERB}\\s+${TABLE}(?![A-Za-z0-9_])`, 'gi')
/**
 * The next item of a TRUNCATE list: what is left of the previous item (the name after another
 * schema, a descendant mark), the comma, then an optional schema (groups 1 and 2) and the table
 * (group 4).
 */
const TRUNCATE_LIST_ITEM = new RegExp(`^(?:\\s*\\.\\s*"?[A-Za-z_][A-Za-z0-9_]*"?)?\\s*\\*?\\s*,\\s*(?:ONLY\\s+)?(?:("?)([A-Za-z_][A-Za-z0-9_]*)\\1\\s*\\.\\s*)?("?)([A-Za-z_][A-Za-z0-9_]*)\\3(?![A-Za-z0-9_])`, 'i')
const DYNAMIC_WRITE = new RegExp(`\\b${VERB}\\s+(?:ONLY\\s+)?${SCHEMA}"?${SUBSTITUTION}`, 'g')
export const QUERY_BUILDER_WRITERS: ReadonlyMap<string, WriteVerb> = new Map([['insertInto', 'INSERT'], ['updateTable', 'UPDATE'], ['deleteFrom', 'DELETE'], ['mergeInto', 'MERGE'], ['replaceInto', 'INSERT']])
const INPUT_COLUMN = `(?:${USERS_INPUT_COLUMNS.join('|')})`
/** `role =`, `"role" =`, or a tuple assignment `(…, role, …) =`. */
const USERS_INPUT_SET = new RegExp(`(?:\\b|")${INPUT_COLUMN}(?:\\b|")\\s*=|\\([^)]*\\b${INPUT_COLUMN}\\b[^)]*\\)\\s*=`, 'i')
const UPSERT_UPDATE = /\bON\s+CONFLICT\b[\s\S]{0,200}?\bDO\s+UPDATE\s+SET\b/i

/** The dynamic forms the scan reports. */
export const SCANNED_DYNAMIC_FORMS: readonly DynamicForm[] = ['template_substitution', 'concatenation', 'query_builder_non_literal', 'users_update_dynamic_set']

const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The table a query-builder call names: double quotes removed, an `as <alias>` suffix and a schema
 * prefix dropped, lower-cased. Null when what is left is not a bare identifier.
 */
export function builderTable(argument: string): string | null {
  let name = argument.replace(/"/g, '').trim()
  const aliased = /^([\s\S]*?)\s+as\s+[A-Za-z_][A-Za-z0-9_]*$/i.exec(name)
  if (aliased) name = aliased[1].trim()
  const parts = name.split('.').map((part) => part.trim())
  if (parts.length > 2 || parts.some((part) => !BARE_IDENTIFIER.test(part))) return null
  return parts[parts.length - 1].toLowerCase()
}

function verbOf(keyword: string): WriteVerb {
  const first = keyword.trim().split(/\s+/)[0].toUpperCase()
  return first as WriteVerb
}

/** The text before `index` ends with `FOR`, `FOR NO KEY` or `DO`: the UPDATE is a row-lock clause or an upsert action, not a statement. */
function isUpdateClause(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 24), index)
  return /\b(?:FOR(?:\s+NO\s+KEY)?|DO)\s*$/i.test(before)
}

function isCopyRead(text: string, end: number): boolean {
  return !/^\s*(?:\([^)]*\)\s*)?FROM\b/i.test(text.slice(end, end + 200))
}

function setClause(text: string, end: number): string {
  const rest = text.slice(end)
  const set = /\bSET\b/i.exec(rest)
  if (!set) return ''
  const after = rest.slice(set.index + set[0].length)
  const stop = /\b(?:WHERE|RETURNING|FROM)\b/i.exec(after)
  return stop ? after.slice(0, stop.index) : after
}

/** The SET clause of an `ON CONFLICT … DO UPDATE` action that follows an INSERT at `end`; '' when there is none. */
function upsertSetClause(text: string, end: number): string {
  const rest = text.slice(end)
  const upsert = UPSERT_UPDATE.exec(rest)
  if (!upsert) return ''
  const after = rest.slice(upsert.index + upsert[0].length)
  const stop = /\b(?:WHERE|RETURNING)\b/i.exec(after)
  return stop ? after.slice(0, stop.index) : after
}

/**
 * Matches one text (a literal, a folded template, or a comment-stripped file). `line` is the line of
 * the text's start; line numbers of matches are offset into the text.
 */
export function matchText(file: string, text: string, line: number, basePosition = 0): { writes: LiteralWrite[]; dynamic: DynamicTarget[] } {
  const writes: LiteralWrite[] = []
  const dynamic: DynamicTarget[] = []
  const lineAt = (index: number) => line + text.slice(0, index).split('\n').length - 1
  const positionAt = (index: number) => basePosition + index
  for (const match of text.matchAll(LITERAL_WRITE)) {
    const index = match.index ?? 0
    const verb = verbOf(match[1])
    const table = match[3].toLowerCase()
    const end = index + match[0].length
    if (verb === 'TRUNCATE') {
      // `TRUNCATE a, b, c`: every further table in the list.
      let cursor = end
      for (;;) {
        const item = TRUNCATE_LIST_ITEM.exec(text.slice(cursor))
        if (!item) break
        const listed = item[4].toLowerCase()
        // An item in another schema is passed over: the list goes on after it.
        const inPublic = item[2] === undefined || item[2].toLowerCase() === 'public'
        if (inPublic && SCANNED_TABLES.has(listed)) writes.push({ file, line: lineAt(index), position: positionAt(index), table: listed, verb, form: 'sql' })
        cursor += item[0].length
      }
    }
    if (!SCANNED_TABLES.has(table)) continue
    if (verb === 'UPDATE' && isUpdateClause(text, index)) continue
    if (verb === 'COPY' && isCopyRead(text, end)) continue
    if (verb === 'UPDATE' && table === 'users') {
      const set = setClause(text, end)
      if (set.includes(SUBSTITUTION)) {
        dynamic.push({ file, line: lineAt(index), position: positionAt(index), form: 'users_update_dynamic_set', expression: match[0] })
        continue
      }
      if (!USERS_INPUT_SET.test(set)) continue
    }
    writes.push({ file, line: lineAt(index), position: positionAt(index), table, verb, form: 'sql' })
    if (verb === 'INSERT' && table === 'users') {
      // An upsert action that assigns an input column is a `users` UPDATE as well.
      const set = upsertSetClause(text, end)
      if (set.includes(SUBSTITUTION)) dynamic.push({ file, line: lineAt(index), position: positionAt(index), form: 'users_update_dynamic_set', expression: `${match[0]} … ON CONFLICT DO UPDATE` })
      else if (USERS_INPUT_SET.test(set)) writes.push({ file, line: lineAt(index), position: positionAt(index), table, verb: 'UPDATE', form: 'upsert' })
    }
  }
  for (const match of text.matchAll(DYNAMIC_WRITE)) {
    const index = match.index ?? 0
    if (verbOf(match[1]) === 'UPDATE' && isUpdateClause(text, index)) continue
    dynamic.push({ file, line: lineAt(index), position: positionAt(index), form: 'template_substitution', expression: match[0].replace(SUBSTITUTION, '${…}') })
  }
  return { writes, dynamic }
}

/**
 * Replaces SQL comments (`--` to the end of the line, and nested block comments) with blanks of the
 * same length, so offsets and line numbers are unchanged. Comment marks inside single-quoted,
 * double-quoted and dollar-quoted text are text.
 */
export function blankSqlComments(text: string): string {
  let out = ''
  let i = 0
  const blank = (from: number, to: number) => text.slice(from, to).replace(/[^\n]/g, ' ')
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"') {
      let end = i + 1
      while (end < text.length && !(text[end] === ch && text[end + 1] !== ch)) end += text[end] === ch ? 2 : 1
      end = Math.min(text.length, end + 1)
      out += text.slice(i, end)
      i = end
    } else if (ch === '$' && /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.test(text.slice(i, i + 80))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(text.slice(i, i + 80))![0]
      const close = text.indexOf(tag, i + tag.length)
      const end = close < 0 ? text.length : close + tag.length
      out += text.slice(i, end)
      i = end
    } else if (ch === '-' && text[i + 1] === '-') {
      let end = text.indexOf('\n', i)
      if (end < 0) end = text.length
      out += blank(i, end)
      i = end
    } else if (ch === '/' && text[i + 1] === '*') {
      let depth = 1
      let end = i + 2
      while (end < text.length && depth > 0) {
        if (text[end] === '/' && text[end + 1] === '*') {
          depth += 1
          end += 2
        } else if (text[end] === '*' && text[end + 1] === '/') {
          depth -= 1
          end += 2
        } else end += 1
      }
      out += blank(i, end)
      i = end
    } else {
      out += ch
      i += 1
    }
  }
  return out
}

function stripSqlComments(text: string): string {
  return blankSqlComments(text)
}

function stripHashComments(text: string): string {
  return text.replace(/^\s*#[^\n]*/gm, '')
}

function foldedConstants(file: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>()
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          const init = declaration.initializer
          if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) constants.set(declaration.name.text, init.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return constants
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
}

const isPlus = (node: ts.Node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken

/** The top of a `+` chain: a `+` whose parent is not itself a `+` (the parent folds the whole chain). */
function isPlusChain(node: ts.Node): node is ts.BinaryExpression {
  return isPlus(node) && !(node.parent && isPlus(node.parent))
}

/** The operands of a left-associative `+` chain, in source order. */
function plusOperands(node: ts.BinaryExpression): ts.Expression[] {
  const operands: ts.Expression[] = []
  let current: ts.Expression = node
  while (isPlus(current)) {
    operands.unshift(current.right)
    current = current.left
  }
  operands.unshift(current)
  return operands
}

/** The text a non-TypeScript file is matched on: SQL or hash comments removed by extension. */
export function commentStrippedText(relativePath: string, source: string): string {
  const extension = path.extname(relativePath)
  return extension === '.sql' ? stripSqlComments(source) : extension === '.sh' || extension === '.ps1' || extension === '.yml' || extension === '.yaml' ? stripHashComments(source) : source
}

/** `literalTexts` with the SQL comments inside each literal blanked. */
export function literalSqlTexts(relativePath: string, source: string): string[] {
  return literalTexts(relativePath, source).map((text) => blankSqlComments(text))
}

/** The text of every string literal, no-substitution template and template chunk of a TypeScript or JavaScript source. */
export function literalTexts(relativePath: string, source: string): string[] {
  const kind = /\.[cm]?js$/.test(relativePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, kind)
  const texts: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts.push(node.text)
    else if (ts.isTemplateExpression(node)) texts.push(node.head.text + node.templateSpans.map((span) => SUBSTITUTION + span.literal.text).join(''))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return texts
}

/** Scans one TypeScript or JavaScript source through its syntax tree. */
export function scanSource(relativePath: string, source: string): { writes: LiteralWrite[]; dynamic: DynamicTarget[] } {
  const kind = /\.[cm]?js$/.test(relativePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, kind)
  const constants = foldedConstants(file)
  const writes: LiteralWrite[] = []
  const dynamic: DynamicTarget[] = []
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let inner = expression
    while (ts.isAsExpression(inner) || ts.isParenthesizedExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression
    return inner
  }
  /** A same-file string constant, or a string literal wrapped in a type assertion; otherwise null. */
  const fold = (expression: ts.Expression): string | null => {
    const inner = unwrap(expression)
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text
    if (ts.isIdentifier(inner)) return constants.get(inner.text) ?? null
    return null
  }
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const result = matchText(relativePath, blankSqlComments(node.text), lineOf(file, node), node.getStart(file) + 1)
      writes.push(...result.writes)
      dynamic.push(...result.dynamic)
    } else if (ts.isTemplateExpression(node)) {
      // Substitutions that resolve to a same-file string constant are folded into the text; the
      // others stay as substitution markers and are reported as dynamic targets where a verb
      // precedes them.
      let text = node.head.text
      let folded = false
      for (const span of node.templateSpans) {
        const constant = fold(span.expression)
        if (constant !== null) folded = true
        text += (constant ?? SUBSTITUTION) + span.literal.text
      }
      const result = matchText(relativePath, blankSqlComments(text), lineOf(file, node), node.getStart(file) + 1)
      writes.push(...result.writes.map((write) => (folded ? { ...write, form: 'folded' as const } : write)))
      dynamic.push(...result.dynamic)
      for (const span of node.templateSpans) visit(span.expression)
      return
    } else if (isPlusChain(node)) {
      // The whole left-associative `+` chain is folded into one text: literal operands and
      // same-file constants contribute their text, every other operand is a substitution marker.
      // Inner literal operands are not visited again; the other operands are.
      const operands = plusOperands(node)
      let text = ''
      let folded = false
      for (const operand of operands) {
        const inner = unwrap(operand)
        if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
          text += inner.text
          continue
        }
        const constant = fold(operand)
        if (constant !== null) {
          text += constant
          folded = true
        } else {
          text += SUBSTITUTION
        }
      }
      const result = matchText(relativePath, blankSqlComments(text), lineOf(file, node), node.getStart(file) + 1)
      writes.push(...result.writes.map((write) => (folded ? { ...write, form: 'folded' as const } : write)))
      dynamic.push(...result.dynamic.map((target) => (target.form === 'template_substitution' ? { ...target, form: 'concatenation' as const, expression: target.expression.replace('${…}', '+ …') } : target)))
      for (const operand of operands) {
        const inner = unwrap(operand)
        if (!(ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner))) visit(operand)
      }
      return
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const verb = QUERY_BUILDER_WRITERS.get(method)
      if (verb && node.arguments.length > 0) {
        const first = node.arguments[0]
        const literal = ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)
        const text = literal ? first.text : fold(first)
        const table = text === null ? null : builderTable(text)
        if (table === null) {
          dynamic.push({ file: relativePath, line: lineOf(file, node), position: node.getStart(file), form: 'query_builder_non_literal', expression: `${method}(${first.getText(file).slice(0, 40)})` })
        } else if (SCANNED_TABLES.has(table)) {
          writes.push({ file: relativePath, line: lineOf(file, node), position: node.getStart(file), table, verb, form: literal ? 'query_builder' : 'folded' })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { writes, dynamic }
}

/** Scans a non-TypeScript file on its comment-stripped text. */
export function scanText(relativePath: string, source: string): { writes: LiteralWrite[]; dynamic: DynamicTarget[] } {
  return matchText(relativePath, commentStrippedText(relativePath, source), 1)
}

export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.cjs', '.mjs'])
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.sql', '.sh', '.ps1', '.yml', '.yaml'])

export function isTestPath(relativePath: string): boolean {
  return /(^|\/)(tests?|__tests__|__fixtures__|__mocks__)\//.test(relativePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
}

export type ScanOptions = Readonly<{
  roots: readonly string[]
  /** Directory prefixes (relative to the repository root) that are not read. */
  exclude: readonly string[]
  includeTests?: boolean
}>

export function listFiles(repoRoot: string, options: ScanOptions): string[] {
  const files: string[] = []
  const excluded = (relative: string) => options.exclude.some((dir) => relative === dir || relative.startsWith(`${dir}/`))
  const walk = (absolute: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const child = path.join(absolute, entry.name)
      const relative = path.relative(repoRoot, child).split(path.sep).join('/')
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || excluded(relative)) continue
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) {
        const extension = path.extname(entry.name)
        if (!SOURCE_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) continue
        if (!options.includeTests && isTestPath(relative)) continue
        files.push(relative)
      }
    }
  }
  for (const root of options.roots) walk(path.join(repoRoot, root))
  return files.sort()
}

export function scanFiles(repoRoot: string, files: readonly string[]): ScanResult {
  const writes: LiteralWrite[] = []
  const dynamic: DynamicTarget[] = []
  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    const result = SOURCE_EXTENSIONS.has(path.extname(file)) ? scanSource(file, source) : scanText(file, source)
    writes.push(...result.writes)
    dynamic.push(...result.dynamic)
  }
  return Object.freeze({ files, writes: Object.freeze(writes), dynamic: Object.freeze(dynamic) })
}

export function scanTree(repoRoot: string, options: ScanOptions): ScanResult {
  return scanFiles(repoRoot, listFiles(repoRoot, options))
}

/** `file|table|verb` → count. */
export function tally(writes: readonly LiteralWrite[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const write of writes) {
    const key = `${write.file}|${write.table}|${write.verb}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/* ───────────────────────────── function-level view ───────────────────────────── */

export type EnclosingFunction = Readonly<{
  name: string
  parameters: readonly string[]
  /** Parameters whose type annotation names the contract token type `AuthorizationInputTx`. */
  brandedParameters: readonly string[]
  /** Whether the function body calls `assertAuthorizationInputTx(`. */
  assertsToken: boolean
}>

function functionName(node: ts.Node, file: ts.SourceFile): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.getText(file)
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  const parent = node.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(file)
  if (parent && ts.isCallExpression(parent)) {
    // A callback passed to a call: name it after the callee (`router.post`, `transaction`, …).
    return `callback:${parent.expression.getText(file).replace(/\s+/g, '')}`
  }
  return '<anonymous>'
}

/**
 * The innermost function-like node enclosing the character offset `position` in `source`, with
 * its parameter names; null when the position is outside any function.
 */
export function enclosingFunctionAt(relativePath: string, source: string, position: number): EnclosingFunction | null {
  const kind = /\.[cm]?js$/.test(relativePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, kind)
  let found: ts.SignatureDeclaration | null = null
  const visit = (node: ts.Node) => {
    if (node.getStart(file) <= position && position < node.getEnd()) {
      if (ts.isFunctionLike(node) && !ts.isTypeNode(node)) found = node as ts.SignatureDeclaration
      ts.forEachChild(node, visit)
    }
  }
  visit(file)
  if (!found) return null
  const fn = found as ts.SignatureDeclaration
  const branded = fn.parameters.filter((p) => p.type !== undefined && /\bAuthorizationInputTx\b/.test(p.type.getText(file))).map((p) => p.name.getText(file))
  const body = (fn as { body?: ts.Node }).body
  return Object.freeze({
    name: functionName(fn, file),
    parameters: Object.freeze(fn.parameters.map((p) => p.name.getText(file))),
    brandedParameters: Object.freeze(branded),
    assertsToken: body !== undefined && /\bassertAuthorizationInputTx\s*\(/.test(body.getText(file)),
  })
}

/**
 * For a write statement literal at character offset `position`, the identifier the enclosing
 * `.query(` call is invoked on (`tx` in `tx.query(…)`, `client` in `client.query(…)`), or null when
 * the literal is not an argument of a `.query(` call.
 */
export function queryReceiverAt(relativePath: string, source: string, position: number): string | null {
  const kind = /\.[cm]?js$/.test(relativePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, kind)
  let receiver: string | null = null
  const visit = (node: ts.Node) => {
    if (node.getStart(file) <= position && position < node.getEnd()) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') {
        receiver = node.expression.expression.getText(file)
      }
      ts.forEachChild(node, visit)
    }
  }
  visit(file)
  return receiver
}

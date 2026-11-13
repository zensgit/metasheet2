/**
 * Judgment of the statements of a migration that touch the privilege-classifier inputs.
 *
 * Every statement is judged `safe`, `raising` or `unreadable`. The judgment is total and each of
 * its four layers defaults to `unreadable`: the statement kind, the table and verb, the statement
 * form, and the operand. A write is `safe` only when its table and verb are safe by table rule, or
 * when it matches one of three closed forms completely and every operand written to a judged
 * column is readable and does not raise a class:
 *   F1  INSERT INTO t (c, …) VALUES (…)[, (…)] [ON CONFLICT … DO NOTHING | DO UPDATE SET …] [RETURNING …]
 *   F2  INSERT INTO t (x, permission_code) SELECT <item>, a.code FROM permissions a
 *         WHERE a.code = <operand> | a.code IN (<operand>, …) [ON CONFLICT … DO NOTHING]
 *   F3  UPDATE t SET c = <operand>[, …] [FROM …] [WHERE …]
 * A readable operand is a plain string literal (no prefix, no backslash, not continued by another
 * literal) optionally cast with `::text` or `::varchar`, a template substitution that folds
 * strictly to a string constant, or the keywords TRUE and FALSE where a boolean is judged.
 *
 * SQL text is every string and template literal of a TypeScript source, or the whole text of a
 * `.sql` file. SQL comments are removed first, statements are cut at top-level semicolons with
 * quoted and dollar-quoted text opaque, and a dollar-quoted `DO` body is cut and judged again after
 * its PL/pgSQL control-flow prefixes are removed. A literal in a known argument position of a
 * helper imported by name from the migration helper module is judged as the statement that helper
 * issues; a table or column argument that folds strictly to a string constant of the file is read
 * as that constant.
 *
 * The statement-kind layer applies to every statement that mentions an input table, has a dynamic
 * write target, or writes a cascade parent. The caller decides for which files it is enforced.
 *
 * A write target that cannot be read is a dynamic target: a substituted or concatenated table, a
 * query-builder table argument that is not a plain name, a helper table argument that is neither a
 * literal nor a constant of the file, and a dynamically executed statement that is not one literal.
 * Its verdict carries the form of the target and says nothing else about the statement: the rest of
 * the statement is judged as if the target were another table, so the caller may set that one
 * verdict aside for a registered exemption without setting aside anything else.
 */
import path from 'node:path'
import ts from 'typescript'
import { isClassRaisingPermissionCode, isClassRaisingRoleId } from '../../src/rbac/authorization-input-classes'
import {
  AUTHORIZATION_INPUT_MIGRATION_HELPERS,
  AUTHORIZATION_INPUT_MIGRATION_JUDGED_COLUMNS,
  AUTHORIZATION_INPUT_MIGRATION_PARENT_KEY_COLUMNS,
  AUTHORIZATION_INPUT_MIGRATION_SENSITIVE_COLUMNS,
  AUTHORIZATION_INPUT_MIGRATION_TABLE_RULES,
} from '../../src/rbac/authorization-input-writers'
import type { AuthorizationInputDynamicForm, AuthorizationInputMigrationColumnRule, AuthorizationInputMigrationVerdict } from '../../src/rbac/authorization-input-writers'
import { blankSqlComments, builderTable, CASCADE_PARENT_TABLES, INPUT_TABLES, matchText, QUERY_BUILDER_WRITERS, SCANNED_TABLES, SOURCE_EXTENSIONS } from './authorization-input-scan'
import type { WriteVerb } from './authorization-input-scan'

export type MigrationJudgment = Readonly<{
  line: number
  /** The judged thing: a statement kind (`INSERT`, `ALTER TABLE`, …), `helper:<name>` or `literal`. */
  kind: string
  verdict: AuthorizationInputMigrationVerdict
  detail: string
  /** Whether the judged statement writes an input table. */
  inputWrite: boolean
  table?: string
  /** `raising` only: what raises. */
  raises?: Readonly<{ what: 'code' | 'role' | 'is_admin' | 'delegated_scope'; value: string }>
  /** Set when the verdict comes from the rule that a migration never writes the table. */
  forbiddenTable?: boolean
  /** Set when the verdict stands for dynamic targets and for nothing else: the form of each. */
  dynamic?: readonly AuthorizationInputDynamicForm[]
}>

export type MigrationJudgeResult = Readonly<{
  judgments: readonly MigrationJudgment[]
  /** `table|verb` → number of writes on scanned tables found inside the judged statements. */
  writes: ReadonlyMap<string, number>
  /** Dynamic form → number of dynamic targets found inside the judged statements and calls. */
  dynamic: ReadonlyMap<string, number>
}>

const SUBSTITUTION = '\u0000'
const FOLD = '\u0001'
const INPUTS: ReadonlySet<string> = new Set(INPUT_TABLES)
const PARENTS: ReadonlySet<string> = new Set(CASCADE_PARENT_TABLES)
const INPUT_NAME_IN_TEXT = new RegExp(`(?<![A-Za-z0-9_])(?:${INPUT_TABLES.join('|')})(?![A-Za-z0-9_])`, 'i')
/** The opening of an identifier written with unicode escapes, inside quoted or dollar-quoted text. */
const UNICODE_ESCAPED_IDENTIFIER = /(?<![A-Za-z0-9_])U&"/i

/* ───────────────────────────── statement boundaries ───────────────────────────── */

/** End index (exclusive) of the quoted run that starts at `start` with `quote`; a doubled quote stays inside. */
function quotedEnd(text: string, start: number, quote: string): number {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) i += 2
      else return i + 1
    } else i += 1
  }
  return text.length
}

/** End index (exclusive) of a dollar-quoted run starting at `start`, or -1 when `start` opens none (`$1` is a parameter). */
export function dollarQuotedEnd(text: string, start: number): number {
  const open = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(text.slice(start, start + 80))
  if (!open) return -1
  const close = text.indexOf(open[0], start + open[0].length)
  return close < 0 ? text.length : close + open[0].length
}

/** Cuts SQL text at semicolons outside quoted, double-quoted and dollar-quoted runs. */
export function splitStatements(text: string): Array<{ text: string; offset: number }> {
  const statements: Array<{ text: string; offset: number }> = []
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"') {
      i = quotedEnd(text, i, ch)
      continue
    }
    if (ch === '$') {
      const end = dollarQuotedEnd(text, i)
      if (end > 0) {
        i = end
        continue
      }
    }
    if (ch === ';') {
      statements.push({ text: text.slice(start, i), offset: start })
      start = i + 1
    }
    i += 1
  }
  statements.push({ text: text.slice(start), offset: start })
  return statements.filter((statement) => statement.text.trim().length > 0)
}

/* ───────────────────────────── tokens ───────────────────────────── */

type Token = Readonly<{
  /** `id` bare identifier or keyword, `qid` double-quoted identifier, `uqid` identifier written with unicode escapes (`U&"…"`), `str` plain string literal, `pstr` prefixed string literal, `dollar` dollar-quoted text, `param` `$n`, `num`, `subst` unfolded substitution, `fold` folded substitution, `op` punctuation. */
  type: 'id' | 'qid' | 'uqid' | 'str' | 'pstr' | 'dollar' | 'param' | 'num' | 'subst' | 'fold' | 'op'
  text: string
  /** `id`: upper-cased; `qid`, `str`, `dollar`, `fold`: the value. */
  value: string
  /** `str`: the literal contains a backslash or an unfolded substitution. */
  opaque?: boolean
}>

function tokenize(text: string, folds: readonly string[]): Token[] {
  const tokens: Token[] = []
  let i = 0
  const foldValue = (inner: string): { value: string; opaque: boolean } => {
    let opaque = inner.includes('\\') || inner.includes(SUBSTITUTION)
    const value = inner.replace(new RegExp(`${FOLD}(\\d+)${FOLD}`, 'g'), (_, index: string) => {
      const folded = folds[Number(index)] ?? ''
      if (folded.includes("'") || folded.includes('\\')) opaque = true
      return folded
    })
    return { value, opaque }
  }
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === SUBSTITUTION) {
      tokens.push({ type: 'subst', text: ch, value: '' })
      i += 1
      continue
    }
    if (ch === FOLD) {
      const end = text.indexOf(FOLD, i + 1)
      tokens.push({ type: 'fold', text: text.slice(i, end + 1), value: folds[Number(text.slice(i + 1, end))] ?? '' })
      i = end + 1
      continue
    }
    if (ch === "'") {
      const end = quotedEnd(text, i, "'")
      const inner = text.slice(i + 1, end - 1).replace(/''/g, "'")
      const { value, opaque } = foldValue(inner)
      tokens.push({ type: 'str', text: text.slice(i, end), value, opaque })
      i = end
      continue
    }
    if (ch === '"') {
      const end = quotedEnd(text, i, '"')
      tokens.push({ type: 'qid', text: text.slice(i, end), value: text.slice(i + 1, end - 1).replace(/""/g, '"') })
      i = end
      continue
    }
    if (ch === '$') {
      const end = dollarQuotedEnd(text, i)
      if (end > 0) {
        const tag = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i))![0]
        tokens.push({ type: 'dollar', text: text.slice(i, end), value: text.slice(i + tag.length, Math.max(i + tag.length, end - tag.length)) })
        i = end
        continue
      }
      const param = /^\$\d+/.exec(text.slice(i, i + 12))
      if (param) {
        tokens.push({ type: 'param', text: param[0], value: param[0] })
        i += param[0].length
        continue
      }
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 128))
    if (word) {
      const next = text[i + word[0].length]
      // A prefixed string literal: E'…', N'…', B'…', X'…', U&'…'.
      if (next === "'" && /^[ENBX]$/i.test(word[0])) {
        const end = quotedEnd(text, i + word[0].length, "'")
        tokens.push({ type: 'pstr', text: text.slice(i, end), value: '' })
        i = end
        continue
      }
      if (next === '&' && /^U$/i.test(word[0]) && text[i + 2] === "'") {
        const end = quotedEnd(text, i + 2, "'")
        tokens.push({ type: 'pstr', text: text.slice(i, end), value: '' })
        i = end
        continue
      }
      // An identifier written with unicode escapes names a table the text does not spell.
      if (next === '&' && /^U$/i.test(word[0]) && text[i + 2] === '"') {
        const end = quotedEnd(text, i + 2, '"')
        tokens.push({ type: 'uqid', text: text.slice(i, end), value: '' })
        i = end
        continue
      }
      tokens.push({ type: 'id', text: word[0], value: word[0].toUpperCase() })
      i += word[0].length
      continue
    }
    const number = /^\d+(?:\.\d+)?/.exec(text.slice(i, i + 40))
    if (number) {
      tokens.push({ type: 'num', text: number[0], value: number[0] })
      i += number[0].length
      continue
    }
    if (text.startsWith('::', i)) {
      tokens.push({ type: 'op', text: '::', value: '::' })
      i += 2
      continue
    }
    tokens.push({ type: 'op', text: ch, value: ch })
    i += 1
  }
  return tokens
}

const isKeyword = (token: Token | undefined, ...words: string[]) => token !== undefined && token.type === 'id' && words.includes(token.value)
const isOp = (token: Token | undefined, op: string) => token !== undefined && token.type === 'op' && token.value === op

/** Index just past the parenthesis group opening at `open`. */
function groupEnd(tokens: readonly Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i += 1) {
    if (isOp(tokens[i], '(')) depth += 1
    else if (isOp(tokens[i], ')')) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return tokens.length
}

/** Splits `tokens[from, to)` at top-level commas. */
function splitTopLevel(tokens: readonly Token[], from: number, to: number): Token[][] {
  const parts: Token[][] = [[]]
  let depth = 0
  for (let i = from; i < to; i += 1) {
    const token = tokens[i]
    if (isOp(token, '(')) depth += 1
    else if (isOp(token, ')')) depth -= 1
    if (depth === 0 && isOp(token, ',')) parts.push([])
    else parts[parts.length - 1].push(token)
  }
  return parts
}

/** Index of the first top-level keyword among `words` in `tokens[from, to)`, or -1. */
function topLevelKeyword(tokens: readonly Token[], from: number, to: number, ...words: string[]): number {
  let depth = 0
  for (let i = from; i < to; i += 1) {
    if (isOp(tokens[i], '(')) depth += 1
    else if (isOp(tokens[i], ')')) depth -= 1
    else if (depth === 0 && isKeyword(tokens[i], ...words)) return i
  }
  return -1
}

/** A column or table name token: bare, double-quoted or folded; lower-cased. */
function nameOf(token: Token | undefined): string | null {
  if (!token) return null
  if (token.type === 'id') return token.text.toLowerCase()
  if (token.type === 'qid') return token.value.toLowerCase()
  if (token.type === 'fold' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.value)) return token.value.toLowerCase()
  return null
}

/** A possibly schema-qualified table name at `index` (after an optional ONLY); the schema is dropped. */
function tableAt(tokens: readonly Token[], index: number): { name: string; next: number } | null {
  let i = index
  if (isKeyword(tokens[i], 'ONLY')) i += 1
  const first = nameOf(tokens[i])
  if (first === null) return null
  if (isOp(tokens[i + 1], '.')) {
    const second = nameOf(tokens[i + 2])
    return second === null ? null : { name: second, next: i + 3 }
  }
  return { name: first, next: i + 1 }
}

/** Whether the write target at `index` (after an optional ONLY and an optional schema) is an unfolded substitution. */
function substitutedTargetAt(tokens: readonly Token[], index: number): boolean {
  let i = index
  if (isKeyword(tokens[i], 'ONLY')) i += 1
  if (nameOf(tokens[i]) !== null && isOp(tokens[i + 1], '.')) i += 2
  return tokens[i]?.type === 'subst'
}

type TruncateItem = Readonly<{ name: string | null; substituted: boolean }>

/** The items of the list a TRUNCATE at `verbAt` names: each table with its schema dropped, or null when the item is not a name. */
function truncateTargets(tokens: readonly Token[], verbAt: number): TruncateItem[] {
  const from = verbAt + (isKeyword(tokens[verbAt + 1], 'TABLE') ? 2 : 1)
  return splitTopLevel(tokens, from, tokens.length).map((item) => ({ name: tableAt(item, 0)?.name ?? null, substituted: substitutedTargetAt(item, 0) }))
}

/* ───────────────────────────── operands ───────────────────────────── */

type Operand = { readable: true; value: string; keyword?: boolean } | { readable: false }
const UNREADABLE: Operand = { readable: false }

/** The value of an operand written to a judged column, when it can be read. */
function readOperand(tokens: readonly Token[], rule: AuthorizationInputMigrationColumnRule): Operand {
  if (tokens.length === 0) return UNREADABLE
  const [first, ...rest] = tokens
  if (rule === 'false_only' && tokens.length === 1 && isKeyword(first, 'TRUE', 'FALSE')) return { readable: true, value: first.value, keyword: true }
  let value: string
  if (first.type === 'str' && !first.opaque) value = first.value
  else if (first.type === 'fold') value = first.value
  else return UNREADABLE
  if (rest.length === 0) return { readable: true, value }
  // The only casts that keep the value: `::text`, `::varchar` without a length, and `::jsonb` for a code array.
  if (rest.length === 2 && isOp(rest[0], '::') && (isKeyword(rest[1], 'TEXT', 'VARCHAR') || (rule === 'permission_array' && isKeyword(rest[1], 'JSONB')))) return { readable: true, value }
  return UNREADABLE
}

type ColumnOutcome = { verdict: AuthorizationInputMigrationVerdict; detail: string; raises?: MigrationJudgment['raises'] }
const SAFE: ColumnOutcome = { verdict: 'safe', detail: '' }

function judgeOperand(table: string, column: string, rule: AuthorizationInputMigrationColumnRule, tokens: readonly Token[]): ColumnOutcome {
  if (rule === 'never_in_set') return { verdict: 'unreadable', detail: `assigns ${table}.${column}` }
  const operand = readOperand(tokens, rule)
  if (!operand.readable) return { verdict: 'unreadable', detail: `operand of ${table}.${column} is not a plain literal` }
  if (rule === 'permission_code') {
    return isClassRaisingPermissionCode(operand.value) ? { verdict: 'raising', detail: `grants class-raising code ${operand.value}`, raises: { what: 'code', value: operand.value } } : SAFE
  }
  if (rule === 'role_id') {
    return isClassRaisingRoleId(operand.value) ? { verdict: 'raising', detail: `assigns class-raising role ${operand.value}`, raises: { what: 'role', value: operand.value } } : SAFE
  }
  if (rule === 'false_only') {
    if (!operand.keyword) return { verdict: 'unreadable', detail: `operand of ${table}.${column} is not TRUE or FALSE` }
    return operand.value === 'TRUE' ? { verdict: 'raising', detail: 'sets is_admin', raises: { what: 'is_admin', value: 'TRUE' } } : SAFE
  }
  // A code array: the empty JSON array, the empty text array, or a JSON array of strings.
  if (operand.value === '[]' || operand.value === '{}') return SAFE
  let parsed: unknown
  try {
    parsed = JSON.parse(operand.value)
  } catch {
    return { verdict: 'unreadable', detail: `operand of ${table}.${column} is not a JSON array of codes` }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return { verdict: 'unreadable', detail: `operand of ${table}.${column} is not a JSON array of codes` }
  const raising = (parsed as string[]).find((code) => isClassRaisingPermissionCode(code))
  return raising === undefined ? SAFE : { verdict: 'raising', detail: `grants class-raising code ${raising}`, raises: { what: 'code', value: raising } }
}

function worst(outcomes: readonly ColumnOutcome[]): ColumnOutcome {
  return outcomes.find((outcome) => outcome.verdict === 'unreadable') ?? outcomes.find((outcome) => outcome.verdict === 'raising') ?? SAFE
}

/* ───────────────────────────── the three forms ───────────────────────────── */

const notForm = (form: string): ColumnOutcome => ({ verdict: 'unreadable', detail: `not the ${form} form` })

/** The targets of a SET list in `tokens[from, to)`: each assignment's column names and value tokens. */
function assignments(tokens: readonly Token[], from: number, to: number): Array<{ columns: string[]; tuple: boolean; value: Token[] }> | null {
  const list: Array<{ columns: string[]; tuple: boolean; value: Token[] }> = []
  for (const part of splitTopLevel(tokens, from, to)) {
    if (isOp(part[0], '(')) {
      const close = groupEnd(part, 0)
      if (!isOp(part[close], '=')) return null
      const columns = splitTopLevel(part, 1, close - 1).map((column) => (column.length === 1 ? nameOf(column[0]) : null))
      if (columns.some((column) => column === null)) return null
      list.push({ columns: columns as string[], tuple: true, value: part.slice(close + 1) })
      continue
    }
    const column = nameOf(part[0])
    if (column === null || !isOp(part[1], '=')) return null
    list.push({ columns: [column], tuple: false, value: part.slice(2) })
  }
  return list
}

/** Judges the assignments of an UPDATE or of an upsert action against the judged columns of `table`. */
function judgeAssignments(table: string, tokens: readonly Token[], from: number, to: number): ColumnOutcome {
  const judged = AUTHORIZATION_INPUT_MIGRATION_JUDGED_COLUMNS[table] ?? {}
  const list = assignments(tokens, from, to)
  if (list === null) return { verdict: 'unreadable', detail: 'assignment list is not readable' }
  const outcomes: ColumnOutcome[] = []
  for (const assignment of list) {
    const touched = assignment.columns.filter((column) => Object.hasOwn(judged, column))
    if (touched.length === 0) continue
    // A tuple assignment that names a judged column is never read position by position.
    if (assignment.tuple) outcomes.push({ verdict: 'unreadable', detail: `tuple assignment names ${table}.${touched[0]}` })
    else outcomes.push(judgeOperand(table, touched[0], judged[touched[0]], assignment.value))
  }
  return worst(outcomes)
}

/** After the VALUES tuples or the SELECT of an INSERT: `[ON CONFLICT … DO NOTHING | DO UPDATE SET …] [RETURNING …]` and nothing else. */
function judgeInsertTail(table: string, tokens: readonly Token[], from: number, allowUpdateAction: boolean): ColumnOutcome | null {
  let i = from
  let outcome: ColumnOutcome = SAFE
  if (isKeyword(tokens[i], 'ON') && isKeyword(tokens[i + 1], 'CONFLICT')) {
    const doAt = topLevelKeyword(tokens, i + 2, tokens.length, 'DO')
    if (doAt < 0) return null
    if (isKeyword(tokens[doAt + 1], 'NOTHING')) i = doAt + 2
    else if (allowUpdateAction && isKeyword(tokens[doAt + 1], 'UPDATE') && isKeyword(tokens[doAt + 2], 'SET')) {
      const returning = topLevelKeyword(tokens, doAt + 3, tokens.length, 'RETURNING')
      const end = returning < 0 ? tokens.length : returning
      const where = topLevelKeyword(tokens, doAt + 3, end, 'WHERE')
      outcome = judgeAssignments(table, tokens, doAt + 3, where < 0 ? end : where)
      i = end
    } else return null
  }
  if (isKeyword(tokens[i], 'RETURNING')) i = tokens.length
  return i === tokens.length ? outcome : null
}

/** F1 and F2. `tokens` starts at INSERT. */
function judgeInsert(table: string, tokens: readonly Token[], afterTable: number): ColumnOutcome {
  const judged = AUTHORIZATION_INPUT_MIGRATION_JUDGED_COLUMNS[table] ?? {}
  if (!isOp(tokens[afterTable], '(')) return notForm('INSERT … (columns) VALUES')
  const columnsEnd = groupEnd(tokens, afterTable)
  const columnTokens = splitTopLevel(tokens, afterTable + 1, columnsEnd - 1)
  const columns = columnTokens.map((column) => (column.length === 1 ? nameOf(column[0]) : null))
  if (columns.some((column) => column === null)) return notForm('INSERT … (columns) VALUES')
  const names = columns as string[]
  const valueColumns = Object.keys(judged).filter((column) => judged[column] !== 'never_in_set')
  if (isKeyword(tokens[columnsEnd], 'VALUES')) {
    // Every judged column is written explicitly: a column default can be changed by the same migration.
    const missing = valueColumns.find((column) => !names.includes(column))
    if (missing !== undefined) return { verdict: 'unreadable', detail: `${table}.${missing} is not in the column list` }
    const outcomes: ColumnOutcome[] = []
    let i = columnsEnd + 1
    for (;;) {
      if (!isOp(tokens[i], '(')) return notForm('INSERT … (columns) VALUES')
      const tupleEnd = groupEnd(tokens, i)
      const items = splitTopLevel(tokens, i + 1, tupleEnd - 1)
      if (items.length !== names.length) return { verdict: 'unreadable', detail: 'a VALUES tuple does not match the column list' }
      for (const column of valueColumns.filter((name) => names.includes(name))) outcomes.push(judgeOperand(table, column, judged[column], items[names.indexOf(column)]))
      i = tupleEnd
      if (isOp(tokens[i], ',')) i += 1
      else break
    }
    const tail = judgeInsertTail(table, tokens, i, true)
    if (tail === null) return notForm('INSERT … (columns) VALUES')
    return worst([...outcomes, tail])
  }
  if (isKeyword(tokens[columnsEnd], 'SELECT')) {
    // F2: only for a table whose one judged value column is the permission code.
    if (valueColumns.length !== 1 || valueColumns[0] !== 'permission_code' || names.length !== 2 || !names.includes('permission_code')) return notForm('INSERT … SELECT … FROM permissions')
    const from = topLevelKeyword(tokens, columnsEnd + 1, tokens.length, 'FROM')
    if (from < 0) return notForm('INSERT … SELECT … FROM permissions')
    const items = splitTopLevel(tokens, columnsEnd + 1, from)
    if (items.length !== 2) return notForm('INSERT … SELECT … FROM permissions')
    const codeItem = items[names.indexOf('permission_code')]
    // FROM permissions <alias>, a single table, no join.
    if (nameOf(tokens[from + 1]) !== 'permissions') return notForm('INSERT … SELECT … FROM permissions')
    let i = from + 2
    if (isKeyword(tokens[i], 'AS')) i += 1
    const alias = isKeyword(tokens[i], 'WHERE') ? null : nameOf(tokens[i])
    if (alias === null) return notForm('INSERT … SELECT … FROM permissions')
    i += 1
    const isAliasCode = (part: readonly Token[]) => part.length === 3 && nameOf(part[0]) === alias && isOp(part[1], '.') && nameOf(part[2]) === 'code'
    // The item that lands in permission_code is exactly <alias>.code.
    if (!isAliasCode(codeItem)) return notForm('INSERT … SELECT … FROM permissions')
    if (!isKeyword(tokens[i], 'WHERE') || !isAliasCode(tokens.slice(i + 1, i + 4))) return notForm('INSERT … SELECT … FROM permissions')
    i += 4
    const operands: Token[][] = []
    if (isOp(tokens[i], '=')) {
      // One predicate: the operand ends where the optional ON CONFLICT begins.
      const on = topLevelKeyword(tokens, i + 1, tokens.length, 'ON')
      const end = on < 0 ? tokens.length : on
      operands.push(tokens.slice(i + 1, end))
      i = end
    } else if (isKeyword(tokens[i], 'IN') && isOp(tokens[i + 1], '(')) {
      const end = groupEnd(tokens, i + 1)
      operands.push(...splitTopLevel(tokens, i + 2, end - 1))
      i = end
    } else return notForm('INSERT … SELECT … FROM permissions')
    const tail = judgeInsertTail(table, tokens, i, false)
    if (tail === null || isKeyword(tokens[i], 'RETURNING')) return notForm('INSERT … SELECT … FROM permissions')
    return worst(operands.map((operand) => judgeOperand(table, 'permission_code', 'permission_code', operand)))
  }
  return notForm('INSERT … (columns) VALUES')
}

/** F3. `tokens` starts at UPDATE. */
function judgeUpdate(table: string, tokens: readonly Token[], afterTable: number): ColumnOutcome {
  let i = afterTable
  if (isKeyword(tokens[i], 'AS')) i += 1
  if (!isKeyword(tokens[i], 'SET')) {
    if (nameOf(tokens[i]) === null || !isKeyword(tokens[i + 1], 'SET')) return notForm('UPDATE … SET')
    i += 1
  }
  const end = topLevelKeyword(tokens, i + 1, tokens.length, 'FROM', 'WHERE')
  if (topLevelKeyword(tokens, i + 1, tokens.length, 'RETURNING') >= 0) return notForm('UPDATE … SET')
  return judgeAssignments(table, tokens, i + 1, end < 0 ? tokens.length : end)
}

/**
 * The verdict for one write on an input table: first by table and verb, then by form and operand.
 * `tokens` is the whole statement, or null when there is no SQL text (a query-builder call).
 */
export function judgeInputWrite(table: string, verb: WriteVerb | string, tokens: readonly Token[] | null): ColumnOutcome & { forbiddenTable?: boolean } {
  const rule = AUTHORIZATION_INPUT_MIGRATION_TABLE_RULES[table]?.[verb as WriteVerb] ?? 'unreadable'
  if (rule === 'forbidden') return { verdict: 'unreadable', detail: `writes ${table}: a migration does not change memberships; use the contract entry or the maintenance tool`, forbiddenTable: true }
  if (rule === 'unreadable') return { verdict: 'unreadable', detail: `${verb} on ${table} has no readable form` }
  if (tokens === null) return { verdict: 'unreadable', detail: `${verb} on ${table} through a query builder has no statement text` }
  if (rule === 'safe') return SAFE
  if (rule === 'raising') return { verdict: 'raising', detail: `writes ${table}`, raises: { what: 'delegated_scope', value: table } }
  // by_column: the statement must begin with the write itself.
  const target = verb === 'INSERT' && isKeyword(tokens[0], 'INSERT') && isKeyword(tokens[1], 'INTO') ? tableAt(tokens, 2) : verb === 'UPDATE' && isKeyword(tokens[0], 'UPDATE') ? tableAt(tokens, 1) : null
  if (target === null || target.name !== table) return { verdict: 'unreadable', detail: `${verb} on ${table} is not the outermost statement` }
  return verb === 'INSERT' ? judgeInsert(table, tokens, target.next) : judgeUpdate(table, tokens, target.next)
}

/* ───────────────────────────── statement kinds ───────────────────────────── */

/** `concatenated`: the text was assembled from a `+` chain, so its substitutions are concatenation operands. */
type Folded = Readonly<{ text: string; folds: readonly string[]; concatenated?: boolean }>

/** The text the write scanner reads: folded substitutions spliced in as text. */
function scannerView(sql: Folded): string {
  return sql.text.replace(new RegExp(`${FOLD}(\\d+)${FOLD}`, 'g'), (_, index: string) => sql.folds[Number(index)] ?? '')
}

function isSensitive(table: string, column: string | null): boolean {
  const sensitive = AUTHORIZATION_INPUT_MIGRATION_SENSITIVE_COLUMNS[table]
  if (sensitive === undefined || column === null) return true
  return sensitive === '*' || sensitive.includes(column)
}

/** Whether a foreign-key clause in `tokens` carries an update action, or a SET NULL / SET DEFAULT delete action over a sensitive column. */
function foreignKeyProblem(table: string, tokens: readonly Token[], columns: readonly (string | null)[]): string | null {
  for (let i = 0; i < tokens.length - 2; i += 1) {
    if (!isKeyword(tokens[i], 'ON')) continue
    const action = tokens.slice(i + 2, i + 4).map((token) => token.value).join(' ')
    const keeps = /^(?:RESTRICT\b|NO ACTION\b)/.test(action)
    if (isKeyword(tokens[i + 1], 'UPDATE') && !keeps) return 'foreign key with an update action'
    if (isKeyword(tokens[i + 1], 'DELETE') && /^SET (?:NULL|DEFAULT)\b/.test(action) && columns.some((column) => isSensitive(table, column))) return 'foreign key that clears a sensitive column on delete'
  }
  return null
}

/** One sub-action of `ALTER TABLE <input table>`: null when it is on the safe list, otherwise why not. */
function alterActionProblem(table: string, action: readonly Token[]): string | null {
  const word = (index: number) => (action[index]?.type === 'id' ? action[index].value : '')
  const skipIfExists = (index: number) => (word(index) === 'IF' ? index + (word(index + 1) === 'NOT' ? 3 : 2) : index)
  if (word(0) === 'ADD') {
    if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(word(1))) {
      const foreign = action.findIndex((token) => isKeyword(token, 'FOREIGN'))
      if (foreign < 0) return null
      const open = action.findIndex((token, index) => index > foreign && isOp(token, '('))
      const columns = open < 0 ? [null] : splitTopLevel(action, open + 1, groupEnd(action, open) - 1).map((column) => (column.length === 1 ? nameOf(column[0]) : null))
      return foreignKeyProblem(table, action, columns)
    }
    const at = skipIfExists(word(1) === 'COLUMN' ? 2 : 1)
    const column = nameOf(action[at])
    if (isSensitive(table, column)) return `adds the sensitive column ${column ?? '?'}`
    return action.some((token) => isKeyword(token, 'REFERENCES')) ? foreignKeyProblem(table, action, [column]) : null
  }
  if (word(0) === 'DROP') {
    if (word(1) === 'CONSTRAINT') return null
    const column = nameOf(action[skipIfExists(word(1) === 'COLUMN' ? 2 : 1)])
    return isSensitive(table, column) ? `drops the sensitive column ${column ?? '?'}` : null
  }
  if (word(0) === 'VALIDATE' && word(1) === 'CONSTRAINT') return null
  if (word(0) === 'ALTER') {
    if (word(1) === 'CONSTRAINT') return 'changes a constraint'
    const column = nameOf(action[word(1) === 'COLUMN' ? 2 : 1])
    return isSensitive(table, column) ? `alters the sensitive column ${column ?? '?'}` : null
  }
  if (word(0) === 'RENAME') {
    if (word(1) === 'TO') return 'renames the table'
    if (word(1) === 'CONSTRAINT') return 'renames a constraint'
    const from = word(1) === 'COLUMN' ? 2 : 1
    const oldName = nameOf(action[from])
    const newName = isKeyword(action[from + 1], 'TO') ? nameOf(action[from + 2]) : null
    return isSensitive(table, oldName) || isSensitive(table, newName) ? 'renames a sensitive column' : null
  }
  return `${action.slice(0, 2).map((token) => token.text).join(' ')} is not on the list of safe sub-actions`
}

/** The key-column problem of a write on a cascade parent, or null. `tokens` begins at the write's verb. */
function parentKeyProblem(table: string, verb: string, tokens: readonly Token[]): string | null {
  const keys = AUTHORIZATION_INPUT_MIGRATION_PARENT_KEY_COLUMNS[table] ?? []
  const touchesKey = (from: number, to: number): string | null => {
    const list = assignments(tokens, from, to)
    if (list === null) return `assignment list of ${table} is not readable`
    return list.some((assignment) => assignment.columns.some((column) => keys.includes(column))) ? `assigns a key column of ${table}` : null
  }
  if (verb === 'MERGE') return `MERGE on ${table}`
  if (verb === 'UPDATE') {
    const set = topLevelKeyword(tokens, 0, tokens.length, 'SET')
    if (set < 0) return `assignment list of ${table} is not readable`
    const end = topLevelKeyword(tokens, set + 1, tokens.length, 'FROM', 'WHERE', 'RETURNING')
    return touchesKey(set + 1, end < 0 ? tokens.length : end)
  }
  if (verb === 'INSERT') {
    const doAt = topLevelKeyword(tokens, 0, tokens.length, 'DO')
    if (doAt < 0 || !isKeyword(tokens[doAt + 1], 'UPDATE')) return null
    const end = topLevelKeyword(tokens, doAt + 3, tokens.length, 'WHERE', 'RETURNING')
    return touchesKey(doAt + 3, end < 0 ? tokens.length : end)
  }
  return null
}

const CONTROL_PREFIX_SINGLE = ['BEGIN', 'ELSE', 'LOOP']

/** Removes the PL/pgSQL control-flow words that precede a statement inside a block body. */
function stripControlPrefix(tokens: readonly Token[]): Token[] {
  let rest = [...tokens]
  for (;;) {
    const first = rest[0]
    if (isKeyword(first, ...CONTROL_PREFIX_SINGLE)) rest = rest.slice(1)
    else if (isKeyword(first, 'IF', 'ELSIF', 'ELSEIF')) {
      const then = topLevelKeyword(rest, 1, rest.length, 'THEN')
      if (then < 0) return rest
      rest = rest.slice(then + 1)
    } else if (isKeyword(first, 'FOR', 'WHILE')) {
      const loop = topLevelKeyword(rest, 1, rest.length, 'LOOP')
      if (loop < 0) return rest
      rest = rest.slice(loop + 1)
    } else if (isKeyword(first, 'EXCEPTION') && isKeyword(rest[1], 'WHEN')) {
      const then = topLevelKeyword(rest, 2, rest.length, 'THEN')
      if (then < 0) return rest
      rest = rest.slice(then + 1)
    } else if (isKeyword(first, 'DECLARE')) {
      const begin = topLevelKeyword(rest, 1, rest.length, 'BEGIN')
      if (begin < 0) return rest
      rest = rest.slice(begin + 1)
    } else return rest
  }
}

const READ_KINDS = ['SELECT', 'WITH', 'VALUES', 'TABLE', 'PERFORM', 'EXPLAIN', 'SHOW']

/**
 * A write verb on an input table after the first token of a statement: a data-modifying CTE, the
 * statement an EXPLAIN runs, a write nested in another write. A row-lock clause (`FOR UPDATE`), an
 * upsert action (`DO UPDATE`) and a foreign-key action (`ON UPDATE`, `ON DELETE`) are not writes.
 */
function nestedInputWrite(tokens: readonly Token[]): string | null {
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!isKeyword(token, 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'MERGE', 'COPY')) continue
    if (isKeyword(tokens[i - 1], 'FOR', 'KEY', 'DO', 'ON')) continue
    if (token.value === 'TRUNCATE') {
      const listed = truncateTargets(tokens, i).find((item) => item.name !== null && INPUTS.has(item.name))
      if (listed !== undefined) return `TRUNCATE on ${listed.name} inside another statement`
      continue
    }
    let at = i + 1
    if (isKeyword(tokens[at], 'INTO', 'FROM', 'TABLE')) at += 1
    const target = tableAt(tokens, at)
    if (target !== null && INPUTS.has(target.name)) return `${token.value} on ${target.name} inside another statement`
  }
  return null
}
const DML_VERBS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'MERGE', 'COPY']
const OBJECT_KINDS = ['VIEW', 'RULE', 'TRIGGER', 'FUNCTION', 'PROCEDURE']

type Sink = { judgments: MigrationJudgment[]; writes: Map<string, number>; dynamic: Map<string, number> }

/** `block`: the statement is a piece of a PL/pgSQL body. `count`: its writes are not already counted by an enclosing statement. */
type StatementMode = Readonly<{ block: boolean; count: boolean }>
const TOP_LEVEL: StatementMode = { block: false, count: true }
const IN_BLOCK: StatementMode = { block: true, count: false }

function countWrite(sink: Sink, table: string, verb: string): void {
  sink.writes.set(`${table}|${verb}`, (sink.writes.get(`${table}|${verb}`) ?? 0) + 1)
}

function countDynamic(sink: Sink, form: AuthorizationInputDynamicForm): void {
  sink.dynamic.set(form, (sink.dynamic.get(form) ?? 0) + 1)
}

function judgeStatement(file: string, sql: Folded, line: number, sink: Sink, mode: StatementMode): void {
  const scanned = matchText(file, scannerView(sql), line)
  // A substitution in a text assembled from a `+` chain is a concatenation operand.
  const dynamicForms: AuthorizationInputDynamicForm[] = scanned.dynamic.map((target) => (target.form === 'template_substitution' && sql.concatenated ? 'concatenation' : target.form))
  if (mode.count) {
    for (const write of scanned.writes) countWrite(sink, write.table, write.verb)
    for (const form of dynamicForms) countDynamic(sink, form)
  }
  let tokens = tokenize(sql.text, sql.folds)
  if (mode.block) tokens = stripControlPrefix(tokens)
  if (tokens.length === 0) return
  const inputWrites = scanned.writes.filter((write) => INPUTS.has(write.table))
  const parentWrites = scanned.writes.filter((write) => PARENTS.has(write.table))
  const head = tokens[0].type === 'id' ? tokens[0].value : tokens[0].text
  const push = (kind: string, verdict: AuthorizationInputMigrationVerdict, detail: string, extra: Partial<MigrationJudgment> = {}): void => {
    sink.judgments.push({ line, kind, verdict, detail, inputWrite: inputWrites.length > 0, ...extra })
  }
  const pushDynamicStatement = (): void => {
    countDynamic(sink, 'dynamic_statement')
    sink.judgments.push({ line, kind: 'EXECUTE', verdict: 'unreadable', detail: 'dynamic statement', inputWrite: false, dynamic: ['dynamic_statement'] })
  }

  // An identifier written with unicode escapes is never read, wherever it stands: in the statement
  // itself, or in the text of a block or function body the statement carries.
  if (tokens.some((token) => token.type === 'uqid' || ((token.type === 'dollar' || token.type === 'str' || token.type === 'pstr') && UNICODE_ESCAPED_IDENTIFIER.test(token.text)))) return push(head, 'unreadable', 'identifier written with unicode escapes')

  // A dollar-quoted block body is cut and judged again; its own statements carry the verdicts.
  if (head === 'DO') {
    const body = tokens.find((token) => token.type === 'dollar')
    if (!body || tokens.length > 3) return push('DO', 'unreadable', 'block body is not one dollar-quoted text')
    for (const inner of splitStatements(blankSqlComments(body.value))) judgeStatement(file, { text: inner.text, folds: sql.folds, concatenated: sql.concatenated }, line, sink, IN_BLOCK)
    return
  }
  // Dynamic execution inside a block body: a single literal is judged as a statement, anything else
  // is a dynamic target, and what its text names is judged below like any other statement.
  // `EXECUTE FUNCTION` in a trigger definition is a clause, not a statement.
  if (mode.block && head === 'EXECUTE') {
    const literal = tokens[1]
    if (tokens.length === 2 && literal.type === 'str' && !literal.opaque) {
      for (const inner of splitStatements(blankSqlComments(literal.value))) judgeStatement(file, { text: inner.text, folds: [] }, line, sink, { block: false, count: false })
      return
    }
    pushDynamicStatement()
  }
  // The body of a function or procedure definition is read for dynamic execution as well.
  if (head === 'CREATE' && tokens.some((token) => isKeyword(token, 'FUNCTION', 'PROCEDURE'))) {
    for (const body of tokens.filter((token) => token.type === 'dollar')) {
      for (const inner of splitStatements(blankSqlComments(body.value))) {
        const piece = stripControlPrefix(tokenize(inner.text, sql.folds))
        if (isKeyword(piece[0], 'EXECUTE') && !(piece.length === 2 && piece[1].type === 'str' && !piece[1].opaque)) pushDynamicStatement()
      }
    }
  }
  // A bare word followed by a single colon is the resource part of a permission code, not a table.
  const mentionsInput = tokens.some((token, index) => {
    if (token.type === 'id') return INPUTS.has(nameOf(token) ?? '') && !isOp(tokens[index + 1], ':')
    if (token.type === 'qid' || token.type === 'fold') return INPUTS.has(nameOf(token) ?? '')
    return (token.type === 'str' || token.type === 'dollar' || token.type === 'pstr') && INPUT_NAME_IN_TEXT.test(token.type === 'pstr' ? token.text : token.value)
  })

  // 1. A write on an input table, wherever it sits in the statement, makes the statement an input write.
  if (inputWrites.length > 0) {
    for (const write of inputWrites) {
      const outcome: ColumnOutcome & { forbiddenTable?: boolean } = write.form === 'upsert' ? SAFE : judgeInputWrite(write.table, write.verb, tokens)
      push(write.verb, outcome.verdict, outcome.detail, { table: write.table, raises: outcome.raises, forbiddenTable: outcome.forbiddenTable })
    }
    // A TRUNCATE names a list: an input table the scanner does not report (one written with another schema) is judged as well.
    if (head === 'TRUNCATE') {
      const reported = new Set(inputWrites.filter((write) => write.verb === 'TRUNCATE').map((write) => write.table))
      for (const item of truncateTargets(tokens, 0)) {
        if (item.name === null) push('TRUNCATE', 'unreadable', 'write target is not readable')
        else if (INPUTS.has(item.name) && !reported.has(item.name)) {
          const outcome = judgeInputWrite(item.name, 'TRUNCATE', tokens)
          push('TRUNCATE', outcome.verdict, outcome.detail, { table: item.name, raises: outcome.raises, forbiddenTable: outcome.forbiddenTable })
        }
      }
    }
    return
  }
  // 2. A write whose target cannot be read. A substituted SET clause of a `users` UPDATE targets an
  // input table and carries no form. Any other dynamic target gets a verdict of its own, and the
  // statement is judged further as if that target were another table.
  if (dynamicForms.includes('users_update_dynamic_set')) return push(head, 'unreadable', 'dynamic write target')
  if (dynamicForms.length > 0) push(head, 'unreadable', 'dynamic write target', { dynamic: dynamicForms })
  // 3. A write on a cascade parent that assigns a key column, wherever it sits in the statement.
  for (const write of parentWrites) {
    const at = tokens.findIndex((token, index) => isKeyword(token, write.verb) && tableAt(tokens, index + (write.verb === 'UPDATE' ? 1 : 2))?.name === write.table)
    const problem = at < 0 ? `${write.verb} on ${write.table} is not readable` : parentKeyProblem(write.table, write.verb, tokens.slice(at))
    if (problem !== null) return push(write.verb, 'unreadable', problem, { table: write.table })
  }
  // A TRUNCATE list item that is not a name is a target of its own. Only a substituted first item already has its dynamic verdict.
  if (head === 'TRUNCATE' && truncateTargets(tokens, 0).some((item, index) => item.name === null && !(index === 0 && item.substituted && dynamicForms.length > 0))) return push(head, 'unreadable', 'write target is not readable')
  if (!mentionsInput) return
  // 4. A write on an input table that is not the outermost statement is never read.
  const hidden = nestedInputWrite(tokens)
  if (hidden !== null) return push(head, 'unreadable', hidden)
  // 5. By the kind of the outermost statement.
  if (READ_KINDS.includes(head)) {
    // `SELECT … INTO <table>` creates the table it names.
    const into = topLevelKeyword(tokens, 1, tokens.length, 'INTO')
    if (into >= 0) {
      let at = into + 1
      while (isKeyword(tokens[at], 'TEMP', 'TEMPORARY', 'UNLOGGED', 'TABLE', 'STRICT')) at += 1
      const created = tableAt(tokens, at)
      if (created !== null && INPUTS.has(created.name)) return push('SELECT INTO', 'unreadable', 'creates a table under an input table name', { table: created.name })
    }
    return push(head, 'safe', '')
  }
  if (DML_VERBS.includes(head)) {
    if (head === 'TRUNCATE') {
      // Every input table of the list is judged, whatever schema it is written with.
      const listed = truncateTargets(tokens, 0).flatMap((item) => (item.name !== null && INPUTS.has(item.name) ? [item.name] : []))
      for (const table of listed) {
        const outcome = judgeInputWrite(table, 'TRUNCATE', tokens)
        push(head, outcome.verdict, outcome.detail, { table, raises: outcome.raises, forbiddenTable: outcome.forbiddenTable })
      }
      if (listed.length === 0 && dynamicForms.length === 0) push(head, 'safe', '')
      return
    }
    const targetAt = head === 'UPDATE' || head === 'COPY' ? 1 : 2
    const target = tableAt(tokens, targetAt)
    // A substituted target already has its dynamic verdict; any other unreadable target is refused here.
    if (target === null) return dynamicForms.length > 0 && substitutedTargetAt(tokens, targetAt) ? undefined : push(head, 'unreadable', 'write target is not readable')
    if (!INPUTS.has(target.name)) return push(head, 'safe', '')
    // The scanner counts a `users` UPDATE only when it assigns an input column; the other columns are judged here.
    const outcome = judgeInputWrite(target.name, head, tokens)
    return push(head, outcome.verdict, outcome.detail, { table: target.name, raises: outcome.raises, forbiddenTable: outcome.forbiddenTable })
  }
  if (head === 'ALTER' && isKeyword(tokens[1], 'TABLE')) {
    let i = 2
    if (isKeyword(tokens[i], 'IF')) i += 2
    const target = tableAt(tokens, i)
    if (target === null) return push('ALTER TABLE', 'unreadable', 'table is not readable')
    const actions = splitTopLevel(tokens, target.next, tokens.length)
    if (!INPUTS.has(target.name)) {
      // Another table: only a rename onto an input table's name is not a plain reference.
      const renamed = actions.some((action) => isKeyword(action[0], 'RENAME') && isKeyword(action[1], 'TO') && INPUTS.has(nameOf(action[2]) ?? ''))
      return renamed ? push('ALTER TABLE', 'unreadable', 'renames a table to an input table name') : push('ALTER TABLE', 'safe', '')
    }
    const problem = actions.map((action) => alterActionProblem(target.name, action)).find((found) => found !== null)
    return problem ? push('ALTER TABLE', 'unreadable', problem, { table: target.name }) : push('ALTER TABLE', 'safe', '', { table: target.name })
  }
  if (head === 'CREATE' || head === 'DROP') {
    let i = 1
    while (isKeyword(tokens[i], 'OR', 'REPLACE', 'UNIQUE', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'MATERIALIZED', 'CONSTRAINT', 'RECURSIVE')) i += 1
    const object = tokens[i]?.type === 'id' ? tokens[i].value : ''
    const materialized = tokens.slice(1, i).some((token) => isKeyword(token, 'MATERIALIZED'))
    if (object === 'INDEX') return push(`${head} INDEX`, 'safe', '')
    if (object === 'TABLE') {
      let at = i + 1
      if (isKeyword(tokens[at], 'IF')) at += head === 'CREATE' ? 3 : 2
      const end = head === 'DROP' ? tokens.length : at + 3
      const names = head === 'DROP' ? splitTopLevel(tokens, at, end).map((part) => tableAt(part, 0)?.name ?? null) : [tableAt(tokens, at)?.name ?? null]
      if (names.some((name) => name === null)) return push(`${head} TABLE`, 'unreadable', 'table is not readable')
      return names.some((name) => INPUTS.has(name as string)) ? push(`${head} TABLE`, 'unreadable', `${head === 'CREATE' ? 'creates' : 'drops'} an input table`) : push(`${head} TABLE`, 'safe', '')
    }
    if (head === 'CREATE' && (OBJECT_KINDS.includes(object) || materialized)) return push(`CREATE ${materialized ? 'MATERIALIZED VIEW' : object}`, 'unreadable', 'defines an object over an input table')
    return push(`${head} ${object}`.trim(), 'unreadable', 'statement kind is not on the safe list')
  }
  if (head === 'COMMENT' && isKeyword(tokens[1], 'ON')) return push('COMMENT ON', 'safe', '')
  return push(head, 'unreadable', 'statement kind is not on the safe list')
}

/** Judges one SQL text: comments removed, cut into statements, each judged. */
function judgeSqlText(file: string, sql: Folded, line: number, sink: Sink): void {
  const text = blankSqlComments(sql.text)
  for (const statement of splitStatements(text)) {
    judgeStatement(file, { text: statement.text, folds: sql.folds, concatenated: sql.concatenated }, line + text.slice(0, statement.offset).split('\n').length - 1, sink, TOP_LEVEL)
  }
}

/* ───────────────────────────── TypeScript sources ───────────────────────────── */

const BARE_TABLE = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)$/
const BARE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ARRAY_METHODS = ['map', 'every', 'some', 'forEach']
const HELPER_MODULE_SPECIFIER = './_patterns'

const stringOf = (node: ts.Node | undefined): string | null => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null)

/** The value of an options object literal: every property a plain key with a literal value (or a nested such object); null when anything else appears. */
function readOptions(node: ts.Expression | undefined, known: readonly string[]): Record<string, unknown> | null {
  if (node === undefined) return {}
  if (!ts.isObjectLiteralExpression(node)) return null
  const value: Record<string, unknown> = {}
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return null
    const key = property.name.text
    if (!known.includes(key)) return null
    const init = property.initializer
    if (key === 'references') {
      const nested = readOptions(init, ['table', 'column', 'onDelete', 'onUpdate'])
      if (nested === null || typeof nested.table !== 'string' || typeof nested.column !== 'string') return null
      value[key] = nested
    } else if (key === 'onDelete' || key === 'onUpdate' || key === 'table' || key === 'column') {
      const text = stringOf(init)
      if (text === null) return null
      value[key] = text
    } else value[key] = true
  }
  return value
}

const keepsKey = (action: unknown) => action === undefined || action === 'restrict' || action === 'no action'

type HelperOutcome = { verdict: AuthorizationInputMigrationVerdict; detail: string; table?: string; dynamic?: boolean }

/**
 * The verdict of a call of a mapped migration helper. `resolve` reads a table or column argument: a
 * string literal, or a name that folds strictly to a string constant of the file. A table argument
 * it cannot read is a dynamic target.
 */
function judgeHelperCall(name: string, call: ts.CallExpression, resolve: (node: ts.Expression | undefined) => string | null, tableOverride?: string): HelperOutcome {
  const parameters = AUTHORIZATION_INPUT_MIGRATION_HELPERS[name]
  const argument = (parameter: string) => call.arguments[parameters.indexOf(parameter)] as ts.Expression | undefined
  const unreadable = (detail: string, table?: string): HelperOutcome => ({ verdict: 'unreadable', detail, table })
  const safe = (table?: string): HelperOutcome => ({ verdict: 'safe', detail: '', table })
  if (call.arguments.some((arg) => ts.isSpreadElement(arg))) return unreadable('spread argument')
  let table: string | undefined
  if (parameters.includes('tableName')) {
    const text = tableOverride ?? resolve(argument('tableName'))
    if (text === null && argument('tableName') !== undefined) return { verdict: 'unreadable', detail: 'table argument is not a plain table name', dynamic: true }
    const bare = text === null ? null : BARE_TABLE.exec(text)
    if (!bare) return unreadable('table argument is not a plain table name')
    table = bare[1].toLowerCase()
  }
  const column = (parameter: string): string | null => {
    const text = resolve(argument(parameter))
    return text !== null && BARE_NAME.test(text) ? text.toLowerCase() : null
  }
  const isInput = table !== undefined && INPUTS.has(table)
  switch (name) {
    case 'checkTableExists':
    case 'checkColumnExists':
    case 'createIndexIfNotExists':
    case 'dropIndexIfExists':
      return safe(table)
    case 'addColumnIfNotExists': {
      if (!isInput) return safe(table)
      if (isSensitive(table!, column('columnName'))) return unreadable('adds a sensitive column or a column that is not a plain name', table)
      const options = readOptions(argument('options'), ['notNull', 'unique', 'defaultTo', 'references'])
      if (options === null) return unreadable('options are not a plain object literal', table)
      const references = options.references as Record<string, unknown> | undefined
      return references && !keepsKey(references.onUpdate) ? unreadable('foreign key with an update action', table) : safe(table)
    }
    case 'dropColumnIfExists':
      return isInput && isSensitive(table!, column('columnName')) ? unreadable('drops a sensitive column or a column that is not a plain name', table) : safe(table)
    case 'renameColumnIfExists':
      return isInput && (isSensitive(table!, column('oldColumnName')) || isSensitive(table!, column('newColumnName'))) ? unreadable('renames a sensitive column or a column that is not a plain name', table) : safe(table)
    case 'addForeignKeyIfNotExists': {
      if (!isInput) return safe(table)
      const options = readOptions(argument('options'), ['onDelete', 'onUpdate'])
      if (options === null) return unreadable('options are not a plain object literal', table)
      if (!keepsKey(options.onUpdate)) return unreadable('foreign key with an update action', table)
      return options.onDelete === 'set null' && isSensitive(table!, column('columnName')) ? unreadable('foreign key that clears a sensitive column on delete', table) : safe(table)
    }
    case 'createUpdatedAtTrigger':
      return isInput ? unreadable('creates a trigger on an input table', table) : safe(table)
    case 'createTableWithDefaults':
      return isInput ? unreadable('creates an input table', table) : safe(table)
    case 'migrateDataSafely':
      return isInput || (table !== undefined && PARENTS.has(table)) ? unreadable('rewrites the rows of an input table or a cascade parent', table) : safe(table)
    default:
      return unreadable('helper is not mapped')
  }
}

function judgeSource(file: string, source: string, sink: Sink): void {
  const kind = /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const lineOf = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1

  // Strict folding: a name declared exactly once in the file, as a const whose initializer is
  // directly a string literal or a template without substitutions (optionally `as const`).
  const declarations = new Map<string, number>()
  const constants = new Map<string, string>()
  const helperImports = new Set<string>()
  const declare = (name: ts.Node | undefined) => {
    if (name && ts.isIdentifier(name)) declarations.set(name.text, (declarations.get(name.text) ?? 0) + 1)
  }
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) declare(node.name)
    if (ts.isImportClause(node)) declare(node.name)
    if (ts.isNamespaceImport(node)) declare(node.name)
    if (ts.isImportSpecifier(node)) {
      declare(node.name)
      const declaration = node.parent.parent.parent
      if (node.propertyName === undefined && ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === HELPER_MODULE_SPECIFIER && Object.hasOwn(AUTHORIZATION_INPUT_MIGRATION_HELPERS, node.name.text)) helperImports.add(node.name.text)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
      let init: ts.Expression = node.initializer
      if (ts.isAsExpression(init) && ts.isTypeReferenceNode(init.type) && init.type.getText(tree) === 'const') init = init.expression
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) constants.set(node.name.text, init.text)
    }
    ts.forEachChild(node, collect)
  }
  collect(tree)
  const strictFold = (expression: ts.Expression): string | null =>
    ts.isIdentifier(expression) && declarations.get(expression.text) === 1 && constants.has(expression.text) ? constants.get(expression.text)! : null
  /** A mapped helper: imported by its own name from the helper module, and declared nowhere else in the file. */
  const helperOf = (call: ts.CallExpression): string | null =>
    ts.isIdentifier(call.expression) && helperImports.has(call.expression.text) && declarations.get(call.expression.text) === 1 ? call.expression.text : null

  const consumed = new Set<ts.Node>()
  /** A table or column argument of a helper: a literal, or a name that folds strictly. */
  const resolveArgument = (node: ts.Expression | undefined): string | null => (node === undefined ? null : stringOf(node) ?? strictFold(node))
  const pushHelper = (name: string, call: ts.CallExpression, tableOverride?: string) => {
    const outcome = judgeHelperCall(name, call, resolveArgument, tableOverride)
    if (outcome.dynamic) countDynamic(sink, 'helper_table_argument')
    sink.judgments.push({ line: lineOf(call), kind: `helper:${name}`, verdict: outcome.verdict, detail: outcome.detail, inputWrite: false, table: outcome.table, ...(outcome.dynamic ? { dynamic: ['helper_table_argument'] as const } : {}) })
  }

  /** Every use of `name` inside `scope` is the table argument of a table-existence or column-existence check. */
  const onlyChecksTable = (name: string, scope: ts.Node): ts.CallExpression[] | null => {
    const calls: ts.CallExpression[] = []
    let ok = true
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === name && !(ts.isParameter(node.parent) || ts.isVariableDeclaration(node.parent))) {
        const call = node.parent
        const helper = ts.isCallExpression(call) ? helperOf(call) : null
        if (helper !== null && (helper === 'checkTableExists' || helper === 'checkColumnExists') && (call as ts.CallExpression).arguments[1] === node) calls.push(call as ts.CallExpression)
        else ok = false
      }
      ts.forEachChild(node, visit)
    }
    visit(scope)
    return ok ? calls : null
  }
  /** An array of plain table names that is only walked to check that each table exists. */
  const tryArrayWalk = (array: ts.ArrayLiteralExpression): boolean => {
    const names = array.elements.map((element) => stringOf(element))
    if (names.length === 0 || names.some((name) => name === null || !BARE_TABLE.test(name))) return false
    const parent = array.parent
    let variable: string | null = null
    let scope: ts.Node | null = null
    if (ts.isForOfStatement(parent) && parent.expression === array && ts.isVariableDeclarationList(parent.initializer) && parent.initializer.declarations.length === 1 && ts.isIdentifier(parent.initializer.declarations[0].name)) {
      variable = parent.initializer.declarations[0].name.text
      scope = parent.statement
    } else if (ts.isPropertyAccessExpression(parent) && parent.expression === array && ARRAY_METHODS.includes(parent.name.text) && ts.isCallExpression(parent.parent) && parent.parent.arguments.length === 1) {
      const callback = parent.parent.arguments[0]
      if ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.parameters.length === 1 && ts.isIdentifier(callback.parameters[0].name)) {
        variable = callback.parameters[0].name.text
        scope = callback.body
      }
    }
    if (variable === null || scope === null || declarations.get(variable) !== 1) return false
    const calls = onlyChecksTable(variable, scope)
    if (calls === null) return false
    for (const call of calls) {
      consumed.add(call)
      for (const name of names) pushHelper(helperOf(call)!, call, name as string)
    }
    for (const element of array.elements) consumed.add(element)
    return true
  }

  const isPlus = (node: ts.Node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
  const literalOf = (expression: ts.Expression): string | null => stringOf(expression)
  const judgeText = (text: string, folds: string[], node: ts.Node, concatenated = false) => judgeSqlText(file, { text, folds, concatenated }, lineOf(node), sink)
  const fold = (expression: ts.Expression, folds: string[]): string => {
    const value = strictFold(expression)
    if (value === null) return SUBSTITUTION
    folds.push(value)
    return `${FOLD}${folds.length - 1}${FOLD}`
  }

  const visit = (node: ts.Node) => {
    if (consumed.has(node)) {
      if (ts.isCallExpression(node)) node.arguments.forEach((argument) => (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument) ? visit(argument) : undefined))
      return
    }
    // Module specifiers are not SQL text.
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) return
    if (ts.isArrayLiteralExpression(node) && tryArrayWalk(node)) return
    if (ts.isCallExpression(node)) {
      const helper = helperOf(node)
      if (helper !== null) {
        pushHelper(helper, node)
        // The helper's literal arguments are judged with the call; callbacks are read as code.
        for (const argument of node.arguments) if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) visit(argument)
        return
      }
      // A query-builder write has no statement text: on an input table it is never readable, and
      // on a cascade parent an UPDATE or a MERGE has no assignment list to read.
      if (ts.isPropertyAccessExpression(node.expression) && QUERY_BUILDER_WRITERS.has(node.expression.name.text) && node.arguments.length > 0) {
        const verb = QUERY_BUILDER_WRITERS.get(node.expression.name.text)!
        const first = node.arguments[0]
        const argument = stringOf(first) ?? (ts.isAsExpression(first) ? stringOf(first.expression) : null) ?? strictFold(first)
        // The table is read as the builder reads it: quotes, schema and alias removed, case folded.
        const table = argument === null ? null : builderTable(argument)
        if (table === null) {
          // A dynamic target is not known to be an input write. A literal that names no single table
          // is not consumed: it is judged as text like any other literal.
          countDynamic(sink, 'query_builder_non_literal')
          sink.judgments.push({ line: lineOf(node), kind: verb, verdict: 'unreadable', detail: 'dynamic write target', inputWrite: false, dynamic: ['query_builder_non_literal'] })
        } else {
          if (SCANNED_TABLES.has(table)) {
            countWrite(sink, table, verb)
            if (INPUTS.has(table)) {
              const outcome = judgeInputWrite(table, verb, null)
              sink.judgments.push({ line: lineOf(node), kind: verb, verdict: outcome.verdict, detail: outcome.detail, inputWrite: true, table, forbiddenTable: outcome.forbiddenTable })
            } else if (verb === 'UPDATE' || verb === 'MERGE') {
              sink.judgments.push({ line: lineOf(node), kind: verb, verdict: 'unreadable', detail: `${verb} on ${table} through a query builder has no assignment list`, inputWrite: false, table })
            }
          }
          consumed.add(first)
        }
      }
      // A foreign-key reference built on another table only refers to the input table.
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'references' && node.arguments.length === 1 && stringOf(node.arguments[0]) !== null) {
        visit(node.expression)
        return
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      judgeText(node.text, [], node)
      return
    }
    if (ts.isTemplateExpression(node)) {
      const folds: string[] = []
      let text = node.head.text
      for (const span of node.templateSpans) text += fold(span.expression, folds) + span.literal.text
      judgeText(text, folds, node)
      for (const span of node.templateSpans) visit(span.expression)
      return
    }
    if (isPlus(node) && !(node.parent && isPlus(node.parent))) {
      const operands: ts.Expression[] = []
      let current: ts.Expression = node
      while (isPlus(current)) {
        operands.unshift(current.right)
        current = current.left
      }
      operands.unshift(current)
      const folds: string[] = []
      let text = ''
      for (const operand of operands) text += literalOf(operand) ?? fold(operand, folds)
      judgeText(text, folds, node, true)
      for (const operand of operands) if (literalOf(operand) === null) visit(operand)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
}

/**
 * Judges every statement of a migration that mentions an input table, has a dynamic write target or
 * writes a cascade parent, and counts the scanned-table writes found inside the judged statements.
 */
export function judgeMigrationInputWrites(file: string, source: string): MigrationJudgeResult {
  const sink: Sink = { judgments: [], writes: new Map(), dynamic: new Map() }
  if (SOURCE_EXTENSIONS.has(path.extname(file))) judgeSource(file, source, sink)
  else judgeSqlText(file, { text: source, folds: [] }, 1, sink)
  return Object.freeze({ judgments: Object.freeze(sink.judgments), writes: sink.writes, dynamic: sink.dynamic })
}

/* ───────────────────────────── helper module pin ───────────────────────────── */

/** Exported function names of the helper module with their parameter names, in source order. */
export function exportedHelperSignatures(source: string): Record<string, string[]> {
  const tree = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  const signatures: Record<string, string[]> = {}
  for (const statement of tree.statements) {
    const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (ts.isFunctionDeclaration(statement) && statement.name) signatures[statement.name.text] = statement.parameters.map((parameter) => parameter.name.getText(tree))
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer
        if (ts.isIdentifier(declaration.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) signatures[declaration.name.text] = init.parameters.map((parameter) => parameter.name.getText(tree))
      }
    }
  }
  return signatures
}

/** Differences between the helper map and the helper module's exports: a missing, extra or re-ordered entry. */
export function helperMapProblems(source: string, map: Readonly<Record<string, readonly string[]>> = AUTHORIZATION_INPUT_MIGRATION_HELPERS): string[] {
  const problems: string[] = []
  const signatures = exportedHelperSignatures(source)
  for (const name of Object.keys(signatures)) if (!Object.hasOwn(map, name)) problems.push(`${name}: exported helper without a rule`)
  for (const [name, parameters] of Object.entries(map)) {
    if (!Object.hasOwn(signatures, name)) problems.push(`${name}: rule without an exported helper`)
    else if (signatures[name].join(',') !== parameters.join(',')) problems.push(`${name}: parameters are ${signatures[name].join(',')}, expected ${parameters.join(',')}`)
  }
  return problems
}

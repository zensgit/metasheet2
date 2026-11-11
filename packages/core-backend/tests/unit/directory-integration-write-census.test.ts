/**
 * Census of statements that write `directory_integrations` (no database).
 *
 * Rule: a statement that inserts a row, deletes a row, or updates `status`, `org_id`, `provider` or
 * `corp_id` decides which pull sources an organisation has. Every such statement in production source
 * must either run through the pull-source write gate or belong to the local directory anchor (which is
 * not a pull source). Every other update of the table is listed too, so the census is closed: a write
 * statement that is not classified below, or a classification that matches nothing, fails.
 *
 * The population is every TypeScript and JavaScript source file under `src/**` except the one directory
 * `src/db/migrations`: every string literal, template literal and `+` concatenation of them is read as
 * one text (a `${…}` substitution reads as a marker), and query-builder calls on the table are read from
 * the syntax tree. What a statement writes is decided by the scanner from the statement's own text, never
 * by the classification: declaring a statement as "other columns" while it sets one of the four columns
 * fails.
 *
 * Guards against a wrong population: it is non-empty and has the known size; each spelling the scanner
 * accepts (schema-qualified, quoted, aliased, multi-line, templated, concatenated, tuple assignment,
 * query builder) has a synthetic statement that turns the census red when injected into a source file;
 * a statement the scanner flags exists under `db/migrations`, so that directory is absent from the
 * population because it is excluded and not because the scanner cannot see it; and the file walk itself
 * is run over a directory tree built for the purpose, which shows that the exclusion is that one
 * directory (a directory named `migrations` anywhere else is read) and that every source extension is
 * read.
 *
 * Two further closed censuses use the same population and scanner:
 *  - statements that write `org_directory_routing_policy`: the two inserts of a policy set, and the one
 *    delete, which runs inside a pull-source gate transaction (under the organisation lock, after the
 *    source count). No other statement inserts, updates or deletes a policy row.
 *  - holders of the organisation lock: the lock statement is built in the gate module only, and the two
 *    functions that open a gate transaction are called from the listed call sites only. The modules are
 *    reached through named imports, so a caller cannot be hidden behind a namespace, a re-export or a
 *    runtime `require`.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(__dirname, '../../src')
const TABLE = 'directory_integrations'
const POLICY_TABLE = 'org_directory_routing_policy'
const GATE_FUNCTION = 'runGatedPullSourceWrite'
const GATE_TRANSACTION_FUNCTION = 'runPullSourceGateTransaction'
/** The functions that run their second argument inside a gate transaction, under the organisation lock. */
const GATE_ENTRY_FUNCTIONS = [GATE_FUNCTION, GATE_TRANSACTION_FUNCTION] as const
/** Columns whose value decides whether a row is an active pull source of an organisation, and of which one. */
const SOURCE_COLUMNS = ['status', 'org_id', 'provider', 'corp_id'] as const

type SourceFile = { path: string; text: string }
type WriteKind = 'insert' | 'delete' | 'update-source-columns' | 'update-other-columns' | 'query-builder'
interface WriteStatement {
  path: string
  line: number
  kind: WriteKind
  text: string
  /** Name of the innermost enclosing function declaration, or '<module>'. */
  owner: string
  /** True when the statement sits in a callback that the owner passes to the gate as its write. */
  passedToGate: boolean
  /** The gate entry function the statement's callback is handed to as its second argument, if any. */
  passedTo: string | null
}

type Classification =
  /** Runs as the write callback of the gate, inside the named function. */
  | { path: string; owner: string; kind: WriteKind; contains: string; via: 'gate' }
  /** The local directory anchor: the statement can only touch `provider = 'local'` rows. */
  | { path: string; owner: string; kind: WriteKind; contains: string; via: 'local-anchor'; localOnly: string }
  /** Sets none of the four columns. */
  | { path: string; owner: string; kind: 'update-other-columns'; contains: string; via: 'other-columns' }

const SYNC = 'directory/directory-sync.ts'
const CARD = 'integrations/dingtalk/approval-card-config.ts'

const CLASSIFIED: readonly Classification[] = [
  { path: SYNC, owner: 'createDirectoryIntegration', kind: 'insert', contains: 'VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, NOW(), NOW())', via: 'gate' },
  { path: SYNC, owner: 'updateDirectoryIntegration', kind: 'update-source-columns', contains: 'WHERE id = $1 AND config IS NOT DISTINCT FROM $10::jsonb AND corp_id = $11', via: 'gate' },
  {
    path: SYNC, owner: 'getOrCreateLocalIntegrationInTransaction', kind: 'update-source-columns',
    contains: "SET status = 'active', updated_at = NOW()", via: 'local-anchor',
    localOnly: "WHERE org_id = $1 AND provider = 'local' AND name = $2 AND status <> 'active'",
  },
  {
    path: SYNC, owner: 'getOrCreateLocalIntegrationInTransaction', kind: 'insert',
    contains: 'ON CONFLICT DO NOTHING', via: 'local-anchor',
    localOnly: "VALUES ($1, 'local', $2, 'active', $3, $4::jsonb, false, NULL, NULL, 'mark_inactive', NOW(), NOW())",
  },
  { path: SYNC, owner: 'updateDirectoryIntegrationIdentity', kind: 'update-other-columns', contains: "SET config = COALESCE(config, '{}'::jsonb) || $2::jsonb, updated_at = NOW()", via: 'other-columns' },
  { path: SYNC, owner: 'markSyncFailure', kind: 'update-other-columns', contains: 'SET last_sync_at = NOW(),', via: 'other-columns' },
  { path: SYNC, owner: 'syncDirectoryIntegration', kind: 'update-other-columns', contains: 'SET last_sync_at = NOW(),', via: 'other-columns' },
  { path: 'directory/controlled-handover.ts', owner: 'applyDirectoryHandover', kind: 'update-other-columns', contains: 'SET updated_at=updated_at WHERE id=ANY($1::uuid[])', via: 'other-columns' },
  { path: 'integrations/dingtalk/work-notification-settings.ts', owner: 'saveDingTalkWorkNotificationAgentId', kind: 'update-other-columns', contains: "'{workNotificationAgentId}'", via: 'other-columns' },
  { path: CARD, owner: 'generateApprovalCardLinkSecret', kind: 'update-other-columns', contains: 'WHERE id = $1 AND provider = $4', via: 'other-columns' },
  { path: CARD, owner: 'saveApprovalCardPublicAppUrl', kind: 'update-other-columns', contains: 'WHERE id = $1 AND provider = $4', via: 'other-columns' },
  { path: CARD, owner: 'saveApprovalCardPublicAppUrl', kind: 'update-other-columns', contains: "SET config = COALESCE(config, '{}'::jsonb) - $2::text,", via: 'other-columns' },
]

/** The one directory outside the population, as a path relative to `src`. */
const EXCLUDED_DIRECTORY = 'db/migrations'
/** Every extension TypeScript or JavaScript source is written in. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const

/** Whether a file, given by its path relative to `src`, is production source the census reads. */
function isScanned(path: string): boolean {
  if (path === EXCLUDED_DIRECTORY || path.startsWith(`${EXCLUDED_DIRECTORY}/`)) return false
  if (path.split('/').includes('node_modules')) return false
  // Declaration files carry no statements.
  if (/\.d\.[cm]?ts$/.test(path)) return false
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))
}

function walk(root: string, directory: string = root, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(root, path, out)
    else if (isScanned(relative(root, path).split('\\').join('/'))) out.push(path)
  }
  return out
}

function loadSource(root: string = SRC_ROOT): SourceFile[] {
  return walk(root).map((file) => ({
    path: relative(root, file).split('\\').join('/'),
    text: readFileSync(file, 'utf8'),
  }))
}

// ── statement classifier (text only) ────────────────────────────────────────────────────────────────

interface TablePatterns { insert: RegExp; delete: RegExp; update: RegExp; builderArgument: RegExp }
const patternsByTable = new Map<string, TablePatterns>()
function patternsFor(table: string): TablePatterns {
  let patterns = patternsByTable.get(table)
  if (!patterns) {
    const name = `(?:"?[a-z_][a-z0-9_]*"?\\s*\\.\\s*)?"?${table}"?(?![a-z0-9_])`
    patterns = {
      insert: new RegExp(`\\bINSERT\\s+INTO\\s+${name}`, 'i'),
      delete: new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?${name}`, 'i'),
      update: new RegExp(`\\bUPDATE\\s+(?:ONLY\\s+)?${name}(?:\\s*\\*)?(?:\\s+(?:AS\\s+)?(?!SET\\b)"?[a-z_][a-z0-9_]*"?)?\\s+SET\\b`, 'ig'),
      builderArgument: new RegExp(`(^|[\\s."])${table}($|[\\s"])`),
    }
    patternsByTable.set(table, patterns)
  }
  return patterns
}

/** The SET list of an UPDATE: from `SET` up to the first top-level FROM / WHERE / RETURNING, or the end. */
function setListAfter(text: string, from: number): string {
  let depth = 0
  let quote = false
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "'") quote = !quote
    if (quote) continue
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (depth === 0 && /^(FROM|WHERE|RETURNING)\b/i.test(text.slice(i)) && /[\s)]/.test(text[i - 1] ?? ' ')) {
      return text.slice(from, i)
    }
  }
  return text.slice(from)
}

/** The column names a SET list assigns, with `*` for an item whose target the scanner cannot read. */
function assignedColumns(setList: string): string[] {
  const items: string[] = []
  let depth = 0
  let quote = false
  let start = 0
  for (let i = 0; i < setList.length; i += 1) {
    const ch = setList[i]
    if (ch === "'") quote = !quote
    if (quote) continue
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      items.push(setList.slice(start, i))
      start = i + 1
    }
  }
  items.push(setList.slice(start))
  const columns: string[] = []
  for (const item of items) {
    const eq = item.indexOf('=')
    const target = (eq < 0 ? item : item.slice(0, eq)).trim()
    if (!target) continue
    if (target.startsWith('(')) {
      // Tuple assignment: (a, b) = (…)
      for (const part of target.replace(/^\(|\)$/g, '').split(',')) columns.push(columnName(part))
    } else {
      columns.push(columnName(target))
    }
  }
  return columns
}

function columnName(target: string): string {
  const match = /^(?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?$/i.exec(target.trim())
  // Anything that is not a plain (optionally qualified, optionally quoted) column name — a substitution
  // marker in particular — is unreadable and counts as a source column.
  return match ? match[1].toLowerCase() : '*'
}

/** The write statements on the table that a text contains. */
function writesIn(text: string, table: string = TABLE): WriteKind[] {
  const patterns = patternsFor(table)
  const kinds: WriteKind[] = []
  if (patterns.insert.test(text)) kinds.push('insert')
  if (patterns.delete.test(text)) kinds.push('delete')
  patterns.update.lastIndex = 0
  for (let match = patterns.update.exec(text); match; match = patterns.update.exec(text)) {
    const columns = assignedColumns(setListAfter(text, match.index + match[0].length))
    const touchesSource = columns.some((column) => column === '*' || (SOURCE_COLUMNS as readonly string[]).includes(column))
    kinds.push(touchesSource ? 'update-source-columns' : 'update-other-columns')
  }
  return kinds
}

// ── syntax-tree walk ────────────────────────────────────────────────────────────────────────────────

const isPlus = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken

/** The text of a literal, a template (substitutions read as `${}`) or a `+` chain of them. */
function textOf(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join('')
  if (isPlus(node)) return textOf(node.left) + textOf(node.right)
  if (ts.isParenthesizedExpression(node)) return textOf(node.expression)
  return '${}'
}

function ownerOf(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text
  }
  return '<module>'
}

/**
 * The gate entry function that the statement's innermost enclosing function expression is handed to, by
 * the enclosing function declaration, as its second argument: either written inline in the call, or bound
 * to a `const` whose name is that second argument. Null when there is none.
 */
function gateEntryOf(node: ts.Node): string | null {
  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined
  let declaration: ts.FunctionDeclaration | undefined
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (!callback && (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))) callback = cur
    if (ts.isFunctionDeclaration(cur)) {
      declaration = cur
      break
    }
  }
  if (!callback || !declaration) return null
  const bound = ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name) ? callback.parent.name.text : null
  let passedTo: string | null = null
  const visit = (cur: ts.Node): void => {
    if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && (GATE_ENTRY_FUNCTIONS as readonly string[]).includes(cur.expression.text)) {
      const write = cur.arguments[1]
      if (write === callback) passedTo = cur.expression.text
      if (bound && write && ts.isIdentifier(write) && write.text === bound) passedTo = cur.expression.text
    }
    ts.forEachChild(cur, visit)
  }
  visit(declaration)
  return passedTo
}

const cache = new Map<string, WriteStatement[]>()

function statementsOf(file: SourceFile, table: string = TABLE): WriteStatement[] {
  const key = `${table}\u0000${file.path}\u0000${file.text}`
  const cached = cache.get(key)
  if (cached) return cached
  const found: WriteStatement[] = []
  if (file.text.includes(table)) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
    const add = (node: ts.Node, kind: WriteKind, text: string) => {
      const passedTo = gateEntryOf(node)
      found.push({
        path: file.path,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        kind,
        text,
        owner: ownerOf(node),
        passedToGate: passedTo === GATE_FUNCTION,
        passedTo,
      })
    }
    const visit = (node: ts.Node): void => {
      const isText = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
      if (isPlus(node) || isText) {
        const text = textOf(node)
        for (const kind of writesIn(text, table)) add(node, kind, text)
        // A `+` chain was read as one text; its operands are not read again.
        if (isPlus(node)) return
      }
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ['insertInto', 'updateTable', 'deleteFrom', 'replaceInto', 'mergeInto'].includes(node.expression.name.text)
        && node.arguments.some((argument) => patternsFor(table).builderArgument.test(textOf(argument)))
      ) {
        add(node, 'query-builder', node.getText(source))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  cache.set(key, found)
  return found
}

function population(files: SourceFile[], table: string = TABLE): WriteStatement[] {
  return files.flatMap((file) => statementsOf(file, table))
}

const matches = (entry: Classification, member: WriteStatement): boolean =>
  entry.path === member.path && entry.owner === member.owner && entry.kind === member.kind && member.text.includes(entry.contains)

/** Offences: unclassified or misclassified statements, and classifications that match nothing. */
function census(files: SourceFile[]): string[] {
  const members = population(files)
  const offences: string[] = []
  for (const member of members) {
    const at = `${member.path}:${member.line} (${member.kind} in ${member.owner})`
    const matching = CLASSIFIED.filter((entry) => matches(entry, member))
    if (matching.length !== 1) {
      offences.push(`${at} is not classified exactly once`)
      continue
    }
    const entry = matching[0]
    if (entry.via === 'gate' && !member.passedToGate) offences.push(`${at} is not the write callback of ${GATE_FUNCTION}`)
    if (entry.via === 'local-anchor' && !member.text.includes(entry.localOnly)) offences.push(`${at} is not confined to the local directory anchor`)
    if (entry.via === 'other-columns' && member.kind !== 'update-other-columns') offences.push(`${at} sets a source column`)
  }
  for (const entry of CLASSIFIED) {
    const count = members.filter((member) => matches(entry, member)).length
    if (count !== 1) offences.push(`classification ${entry.path} / ${entry.owner} / ${entry.contains} matches ${count} statements`)
  }
  return offences
}

const SOURCE = loadSource()

function withText(files: SourceFile[], path: string, edit: (text: string) => string): SourceFile[] {
  return files.map((file) => (file.path === path ? { ...file, text: edit(file.text) } : file))
}
function edited(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to)
  expect(out).not.toBe(text)
  return out
}

/** One synthetic statement per spelling the scanner must see, each written the way source would write it. */
const SYNTHETIC: ReadonlyArray<{ spelling: string; code: string; kind: WriteKind }> = [
  { spelling: 'plain update of status', kind: 'update-source-columns', code: "const s = `UPDATE directory_integrations SET status = 'active' WHERE id = $1`" },
  { spelling: 'single-quoted literal', kind: 'update-source-columns', code: "const s = 'UPDATE directory_integrations SET status = $2 WHERE id = $1'" },
  { spelling: 'lower case', kind: 'update-source-columns', code: 'const s = `update directory_integrations set provider = $2 where id = $1`' },
  { spelling: 'schema-qualified', kind: 'update-source-columns', code: 'const s = `UPDATE public.directory_integrations SET org_id = $2 WHERE id = $1`' },
  { spelling: 'quoted identifiers', kind: 'update-source-columns', code: 'const s = `UPDATE "public"."directory_integrations" SET "corp_id" = $2 WHERE id = $1`' },
  { spelling: 'aliased with AS', kind: 'update-source-columns', code: 'const s = `UPDATE directory_integrations AS di SET status = $2 WHERE di.id = $1`' },
  { spelling: 'aliased without AS, qualified target', kind: 'update-source-columns', code: 'const s = `UPDATE directory_integrations di SET name = $3, di.status = $2 WHERE di.id = $1`' },
  { spelling: 'ONLY', kind: 'update-source-columns', code: 'const s = `UPDATE ONLY directory_integrations SET status = $2`' },
  { spelling: 'multi-line, source column last', kind: 'update-source-columns', code: 'const s = `\n  UPDATE directory_integrations\n     SET name = $2,\n         config = jsonb_set(config, $3, $4, true),\n         status = $5\n   WHERE id = $1`' },
  { spelling: 'tuple assignment', kind: 'update-source-columns', code: 'const s = `UPDATE directory_integrations SET (name, status) = ($2, $3) WHERE id = $1`' },
  { spelling: 'templated SET list', kind: 'update-source-columns', code: 'const cols = "x"\nconst s = `UPDATE directory_integrations SET ${cols} WHERE id = $1`' },
  { spelling: 'templated value', kind: 'update-source-columns', code: 'const v = "x"\nconst s = `UPDATE directory_integrations SET status = ${v} WHERE id = $1`' },
  { spelling: 'concatenated literals', kind: 'update-source-columns', code: "const s = 'UPDATE directory_integrations ' + 'SET status = $2 ' + 'WHERE id = $1'" },
  { spelling: 'UPDATE … FROM', kind: 'update-source-columns', code: 'const s = `UPDATE directory_integrations i SET status = s.status FROM staged s WHERE s.id = i.id`' },
  { spelling: 'insert', kind: 'insert', code: 'const s = `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id) VALUES ($1, $2, $3, $4, $5)`' },
  { spelling: 'schema-qualified insert', kind: 'insert', code: 'const s = `insert into public.directory_integrations (org_id) values ($1)`' },
  { spelling: 'insert … select', kind: 'insert', code: 'const s = `INSERT INTO directory_integrations SELECT * FROM staged`' },
  { spelling: 'delete', kind: 'delete', code: 'const s = `DELETE FROM directory_integrations WHERE id = $1`' },
  { spelling: 'delete with ONLY and schema', kind: 'delete', code: 'const s = `DELETE FROM ONLY public.directory_integrations WHERE org_id = $1`' },
  { spelling: 'query-builder insert', kind: 'query-builder', code: "declare const db: any\nconst s = db.insertInto('directory_integrations').values({})" },
  { spelling: 'query-builder update', kind: 'query-builder', code: "declare const db: any\nconst s = db.updateTable('directory_integrations').set({ status: 'active' })" },
  { spelling: 'query-builder delete', kind: 'query-builder', code: "declare const db: any\nconst s = db.deleteFrom('public.directory_integrations')" },
]

describe('census of statements that write directory_integrations', () => {
  it('derives a non-empty population from source and classifies every member', () => {
    const members = population(SOURCE)
    expect(SOURCE.length).toBeGreaterThan(100)
    expect(census(SOURCE)).toEqual([])
    expect(members).toHaveLength(CLASSIFIED.length)
    const byKind = (kind: WriteKind) => members.filter((member) => member.kind === kind).length
    expect({ insert: byKind('insert'), delete: byKind('delete'), source: byKind('update-source-columns'), other: byKind('update-other-columns'), builder: byKind('query-builder') })
      .toEqual({ insert: 2, delete: 0, source: 2, other: 8, builder: 0 })
  })

  it('the statements that decide an organisation\'s pull sources are the two gated writes and the local anchor', () => {
    const deciding = population(SOURCE).filter((member) => member.kind !== 'update-other-columns')
    expect(deciding.map((member) => `${member.owner}:${member.kind}:${member.passedToGate ? 'gate' : 'direct'}`).sort()).toEqual([
      'createDirectoryIntegration:insert:gate',
      'getOrCreateLocalIntegrationInTransaction:insert:direct',
      'getOrCreateLocalIntegrationInTransaction:update-source-columns:direct',
      'updateDirectoryIntegration:update-source-columns:gate',
    ])
    expect(deciding.every((member) => member.path === SYNC)).toBe(true)
  })

  it('the gate module itself writes no statement on the table', () => {
    expect(population(SOURCE).some((member) => member.path === 'directory/pull-source-write-gate.ts')).toBe(false)
    expect(population(SOURCE).some((member) => member.path === 'directory/pull-source-rule.ts')).toBe(false)
  })

  it('reads the SET list only: a source column in WHERE or RETURNING is not an assignment', () => {
    expect(writesIn('UPDATE directory_integrations SET config = $2 WHERE id = $1 AND provider = $3 RETURNING id, name, status, config')).toEqual(['update-other-columns'])
    expect(writesIn("UPDATE directory_integrations SET config = jsonb_set(config, '{status}', $2), updated_at = NOW() WHERE corp_id = $1")).toEqual(['update-other-columns'])
    expect(writesIn('UPDATE directory_integrations SET last_error = CASE WHEN status = $2 THEN NULL ELSE last_error END WHERE id = $1')).toEqual(['update-other-columns'])
    expect(writesIn('SELECT id FROM directory_integrations WHERE id = $1 AND provider = $2 FOR UPDATE')).toEqual([])
    expect(writesIn('UPDATE directory_integration_capabilities SET status = $1')).toEqual([])
    expect(writesIn('INSERT INTO directory_integrations_archive (id) VALUES ($1)')).toEqual([])
    expect(writesIn('UPDATE directory_accounts SET status = $1 FROM directory_integrations i WHERE i.id = $2')).toEqual([])
  })

  for (const { spelling, code, kind } of SYNTHETIC) {
    it(`positive control (${spelling}): the statement is seen as ${kind} and fails the census wherever it is added`, () => {
      const lone = statementsOf({ path: 'synthetic.ts', text: code })
      expect(lone.map((member) => member.kind)).toEqual([kind])
      for (const path of [SYNC, 'directory/pull-source-write-gate.ts', 'routes/admin-directory.ts', 'integrations/feishu/config.ts']) {
        expect(SOURCE.some((file) => file.path === path), path).toBe(true)
        const offences = census(withText(SOURCE, path, (text) => `${text}\nexport function syntheticWriter() {\n${code}\n  return s\n}\n`))
        expect(offences.length, path).toBeGreaterThan(0)
        expect(offences.join('\n')).toContain(`${path}:`)
      }
    })
  }

  it('positive control: a gated write taken out of the gate fails the census', () => {
    const create = withText(SOURCE, SYNC, (text) => edited(
      text,
      /runGatedPullSourceWrite\(\s*\{ orgId: DEFAULT_ORG_ID, provider: DEFAULT_PROVIDER, corpId: normalized\.corpId, enforce: 'flagged' \},\s*insert,\s*\)/,
      'insert({ query }).then((result) => ({ result, ...UNGATED_INTEGRATION_WRITE }))',
    ))
    expect(census(create).join('\n')).toContain(`(insert in createDirectoryIntegration) is not the write callback of ${GATE_FUNCTION}`)
    const update = withText(SOURCE, SYNC, (text) => edited(text, /(enforce: 'flagged' \},\s*)update,/, '$1insert as never,'))
    expect(census(update).join('\n')).toContain(`(update-source-columns in updateDirectoryIntegration) is not the write callback of ${GATE_FUNCTION}`)
  })

  it('positive control: a gated statement moved to another function, or copied, fails the census', () => {
    const copied = withText(SOURCE, SYNC, (text) => `${text}\nexport async function reactivate(id: string) {\n  return query(\`UPDATE directory_integrations SET status = 'active', updated_at = NOW() WHERE id = $1\`, [id])\n}\n`)
    expect(census(copied).join('\n')).toContain('(update-source-columns in reactivate) is not classified exactly once')
    const widened = withText(SOURCE, SYNC, (text) => edited(text, "WHERE org_id = $1 AND provider = 'local' AND name = $2 AND status <> 'active'", "WHERE org_id = $1 AND name = $2 AND status <> 'active'"))
    expect(census(widened).join('\n')).toContain('is not confined to the local directory anchor')
  })

  it('positive control: an update declared as other columns that starts setting a source column fails the census', () => {
    const mutated = withText(SOURCE, CARD, (text) => edited(text, "SET config = COALESCE(config, '{}'::jsonb) - $2::text,", "SET config = COALESCE(config, '{}'::jsonb) - $2::text, status = 'active',"))
    expect(census(mutated).join('\n')).toContain('is not classified exactly once')
  })

  it('positive control: a classification that matches nothing fails the census', () => {
    const without = withText(SOURCE, 'directory/controlled-handover.ts', (text) => edited(text, 'UPDATE directory_integrations SET updated_at=updated_at', 'UPDATE directory_accounts SET updated_at=updated_at'))
    expect(census(without).join('\n')).toContain('classification directory/controlled-handover.ts / applyDirectoryHandover / SET updated_at=updated_at WHERE id=ANY($1::uuid[]) matches 0 statements')
  })

  it('db/migrations is outside the population because it is excluded, not because the scanner is blind to it', () => {
    expect(SOURCE.some((file) => file.path.startsWith('db/migrations/'))).toBe(false)
    const migrations = join(SRC_ROOT, 'db/migrations')
    const flagged = readdirSync(migrations)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => statementsOf({ path: `db/migrations/${name}`, text: readFileSync(join(migrations, name), 'utf8') }))
    expect(flagged.some((member) => member.kind === 'update-source-columns')).toBe(true)
    // The same statement in a scanned directory would fail the census.
    const moved = [...SOURCE, { path: 'directory/copied-migration.ts', text: 'export const s = `UPDATE directory_integrations SET corp_id = BTRIM(corp_id)`' }]
    expect(census(moved).join('\n')).toContain('directory/copied-migration.ts:1 (update-source-columns in <module>) is not classified exactly once')
  })

  it('the file walk leaves out the one directory src/db/migrations and reads every other source file, whatever its directory name or extension', () => {
    const statement = "export const s = `UPDATE directory_integrations SET status = 'active' WHERE id = $1`\n"
    const read = [
      'directory/migrations/backfill-status.ts',
      'migrations/top-level.ts',
      'db/migrations-archive/old.ts',
      'db/other/migrations/nested.ts',
      'services/db/migrations/elsewhere.ts',
      'legacy/writer.js',
      'legacy/writer.jsx',
      'legacy/writer.mjs',
      'legacy/writer.cjs',
      'legacy/view.tsx',
      'legacy/module.mts',
      'legacy/common.cts',
    ]
    const leftOut = [
      'db/migrations/zzzz_migration.ts',
      'db/migrations/nested/deeper.ts',
      'db/migrations/plain.js',
      'types/ambient.d.ts',
      'types/ambient.d.mts',
      'types/ambient.d.cts',
      'vendor/node_modules/pkg/index.ts',
      'notes/readme.md',
      'data/rows.json',
    ]
    const root = mkdtempSync(join(tmpdir(), 'write-census-walk-'))
    try {
      for (const path of [...read, ...leftOut]) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), statement)
      }
      const built = loadSource(root)
      expect(built.map((file) => file.path).sort()).toEqual([...read].sort())
      // Every file that was read is seen by the scanner, and fails the census next to the real source.
      expect(population(built).map((member) => `${member.path}:${member.kind}`).sort()).toEqual(read.map((path) => `${path}:update-source-columns`).sort())
      const offences = census([...SOURCE, ...built]).join('\n')
      for (const path of read) expect(offences).toContain(`${path}:1 (update-source-columns in <module>) is not classified exactly once`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    for (const path of read) expect(isScanned(path), path).toBe(true)
    for (const path of leftOut) expect(isScanned(path), path).toBe(false)
    // In the real tree: the excluded directory exists and holds files, no file of it is in the population,
    // and the JavaScript entry file next to the TypeScript source is.
    expect(readdirSync(join(SRC_ROOT, EXCLUDED_DIRECTORY)).length).toBeGreaterThan(100)
    expect(SOURCE.some((file) => file.path.startsWith('db/'))).toBe(true)
    expect(SOURCE.some((file) => file.path.startsWith(`${EXCLUDED_DIRECTORY}/`))).toBe(false)
    expect(SOURCE.map((file) => file.path)).toContain('server.js')
    expect(SOURCE.every((file) => isScanned(file.path))).toBe(true)
  })

  it('the table name is not held in a constant that a statement could be assembled from', () => {
    const carriers = SOURCE.filter((file) => {
      const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
      let bare = false
      const visit = (node: ts.Node): void => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.trim() === TABLE) bare = true
        ts.forEachChild(node, visit)
      }
      if (file.text.includes(TABLE)) visit(source)
      return bare
    }).map((file) => file.path).sort()
    // Read-only catalogues: the rule module's table list and the encrypted-store probe's store labels.
    expect(carriers).toEqual(['directory/pull-source-rule.ts', 'security/encrypted-store-probe.ts'])
  })
})

// ── statements that write org_directory_routing_policy ─────────────────────────────────────────────

const ROUTING_POLICY_ROUTE = 'routes/admin-directory-routing-policy.ts'
const ROUTING_POLICY_ROUTER = 'adminDirectoryRoutingPolicyRouter'

/**
 * Every statement in source that inserts, updates or deletes a policy row. `inGateTransaction` says
 * whether the statement must sit in the callback handed to the gate transaction function.
 */
const POLICY_CLASSIFIED: ReadonlyArray<{ path: string; owner: string; kind: WriteKind; contains: string; inGateTransaction: boolean }> = [
  { path: ROUTING_POLICY_ROUTE, owner: ROUTING_POLICY_ROUTER, kind: 'delete', contains: 'DELETE FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = $2', inGateTransaction: true },
  { path: ROUTING_POLICY_ROUTE, owner: ROUTING_POLICY_ROUTER, kind: 'insert', contains: 'ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq DO NOTHING', inGateTransaction: false },
  {
    path: ROUTING_POLICY_ROUTE, owner: ROUTING_POLICY_ROUTER, kind: 'insert',
    contains: 'DO UPDATE SET canonical_integration_id = EXCLUDED.canonical_integration_id, updated_at = NOW()', inGateTransaction: false,
  },
]

/** Offences of the policy-table census: unclassified statements, misplaced ones, and classifications that match nothing. */
function policyCensus(files: SourceFile[]): string[] {
  const members = population(files, POLICY_TABLE)
  const offences: string[] = []
  const fits = (entry: (typeof POLICY_CLASSIFIED)[number], member: WriteStatement): boolean =>
    entry.path === member.path && entry.owner === member.owner && entry.kind === member.kind && member.text.includes(entry.contains)
  for (const member of members) {
    const at = `${member.path}:${member.line} (${member.kind} in ${member.owner})`
    const matching = POLICY_CLASSIFIED.filter((entry) => fits(entry, member))
    if (matching.length !== 1) {
      offences.push(`${at} is not classified exactly once`)
      continue
    }
    const inGateTransaction = member.passedTo === GATE_TRANSACTION_FUNCTION
    if (matching[0].inGateTransaction && !inGateTransaction) offences.push(`${at} is not in the callback of ${GATE_TRANSACTION_FUNCTION}`)
    if (!matching[0].inGateTransaction && member.passedTo !== null) offences.push(`${at} is in a gate callback it is not classified for`)
  }
  for (const entry of POLICY_CLASSIFIED) {
    const count = members.filter((member) => fits(entry, member)).length
    if (count !== 1) offences.push(`classification ${entry.path} / ${entry.owner} / ${entry.contains} matches ${count} statements`)
  }
  return offences
}

describe('census of statements that write org_directory_routing_policy', () => {
  it('a policy row is inserted by a set and deleted inside a gate transaction, and by nothing else', () => {
    const members = population(SOURCE, POLICY_TABLE)
    expect(policyCensus(SOURCE)).toEqual([])
    expect(members.map((member) => `${member.path}:${member.owner}:${member.kind}:${member.passedTo ?? 'direct'}`).sort()).toEqual([
      `${ROUTING_POLICY_ROUTE}:${ROUTING_POLICY_ROUTER}:delete:${GATE_TRANSACTION_FUNCTION}`,
      `${ROUTING_POLICY_ROUTE}:${ROUTING_POLICY_ROUTER}:insert:direct`,
      `${ROUTING_POLICY_ROUTE}:${ROUTING_POLICY_ROUTER}:insert:direct`,
    ])
  })

  it('the delete follows the source count and the refusal inside the same callback', () => {
    const route = SOURCE.find((file) => file.path === ROUTING_POLICY_ROUTE)
    expect(route).toBeDefined()
    const source = ts.createSourceFile(ROUTING_POLICY_ROUTE, route!.text, ts.ScriptTarget.Latest, true)
    const bodies: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === GATE_TRANSACTION_FUNCTION) {
        bodies.push(node.arguments[1]?.getText(source) ?? '')
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(bodies).toHaveLength(1)
    const body = bodies[0]
    const count = body.indexOf('countActivePullSources(')
    const refusal = body.indexOf("if (activeSources >= PULL_SOURCE_THRESHOLD) return { kind: 'blocked' }")
    const remove = body.indexOf('DELETE FROM org_directory_routing_policy')
    expect(count).toBeGreaterThan(-1)
    expect(refusal).toBeGreaterThan(count)
    expect(remove).toBeGreaterThan(refusal)
    expect(body.split('DELETE FROM').length - 1).toBe(1)
  })

  const POLICY_SYNTHETIC: ReadonlyArray<{ spelling: string; code: string; kind: WriteKind }> = [
    { spelling: 'delete', kind: 'delete', code: 'const s = `DELETE FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = $2`' },
    { spelling: 'delete of every purpose', kind: 'delete', code: "const s = 'DELETE FROM org_directory_routing_policy WHERE org_id = $1'" },
    { spelling: 'schema-qualified delete with ONLY', kind: 'delete', code: 'const s = `delete from only public.org_directory_routing_policy where canonical_integration_id = $1`' },
    { spelling: 'update that moves a row to another organisation', kind: 'update-source-columns', code: 'const s = `UPDATE org_directory_routing_policy SET org_id = $2 WHERE org_id = $1`' },
    { spelling: 'update of the purpose', kind: 'update-other-columns', code: 'const s = `UPDATE org_directory_routing_policy p SET purpose = $2 WHERE p.org_id = $1`' },
    { spelling: 'update of the canonical', kind: 'update-other-columns', code: 'const s = `UPDATE "org_directory_routing_policy" SET canonical_integration_id = $2 WHERE org_id = $1`' },
    { spelling: 'insert', kind: 'insert', code: 'const s = `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id) VALUES ($1, $2, $3)`' },
    { spelling: 'query-builder delete', kind: 'query-builder', code: "declare const db: any\nconst s = db.deleteFrom('org_directory_routing_policy')" },
    { spelling: 'query-builder update', kind: 'query-builder', code: "declare const db: any\nconst s = db.updateTable('org_directory_routing_policy').set({ purpose: 'x' })" },
  ]
  for (const { spelling, code, kind } of POLICY_SYNTHETIC) {
    it(`positive control (${spelling}): the statement is seen as ${kind} and fails the census wherever it is added`, () => {
      expect(statementsOf({ path: 'synthetic.ts', text: code }, POLICY_TABLE).map((member) => member.kind)).toEqual([kind])
      for (const path of [ROUTING_POLICY_ROUTE, 'directory/pull-source-write-gate.ts', 'directory/controlled-handover.ts', 'services/ApprovalDirectoryOrg.ts']) {
        expect(SOURCE.some((file) => file.path === path), path).toBe(true)
        const offences = policyCensus(withText(SOURCE, path, (text) => `${text}\nexport function syntheticPolicyWriter() {\n${code}\n  return s\n}\n`))
        expect(offences.join('\n'), path).toContain(`${path}:`)
      }
    })
  }

  it('positive control: the delete taken out of the gate transaction, or a second delete inside it, fails the census', () => {
    const outside = withText(SOURCE, ROUTING_POLICY_ROUTE, (text) => edited(
      text,
      'const outcome = await runPullSourceGateTransaction<ClearOutcome>(orgId, async (client) => {',
      'const outcome = await transaction<ClearOutcome>(async (client) => {',
    ))
    expect(policyCensus(outside).join('\n')).toContain(`(delete in ${ROUTING_POLICY_ROUTER}) is not in the callback of ${GATE_TRANSACTION_FUNCTION}`)
    const second = withText(SOURCE, ROUTING_POLICY_ROUTE, (text) => edited(
      text,
      "          if (typeof previous !== 'string') return { kind: 'absent' }\n",
      "          if (typeof previous !== 'string') return { kind: 'absent' }\n          await client.query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = $2`, [orgId, purpose])\n",
    ))
    expect(policyCensus(second).join('\n')).toContain('matches 2 statements')
    const insertInGate = withText(SOURCE, ROUTING_POLICY_ROUTE, (text) => edited(
      text,
      "          if (typeof previous !== 'string') return { kind: 'absent' }\n",
      "          if (typeof previous !== 'string') return { kind: 'absent' }\n          await client.query(`INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id) VALUES ($1, $2, $3) ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq DO NOTHING`, [orgId, purpose, previous])\n",
    ))
    expect(policyCensus(insertInGate).join('\n')).toMatch(/is in a gate callback it is not classified for|matches 2 statements/)
  })

  it('db/migrations holds statements on the table that the scanner sees', () => {
    const migrations = join(SRC_ROOT, EXCLUDED_DIRECTORY)
    const texts = readdirSync(migrations).filter((name) => name.endsWith('.ts')).map((name) => readFileSync(join(migrations, name), 'utf8'))
    expect(texts.some((text) => text.includes(POLICY_TABLE))).toBe(true)
    expect(population(SOURCE, POLICY_TABLE).some((member) => member.path.startsWith(`${EXCLUDED_DIRECTORY}/`))).toBe(false)
  })
})

// ── holders of the organisation lock ───────────────────────────────────────────────────────────────

const RULE_MODULE = 'directory/pull-source-rule.ts'
const GATE_MODULE = 'directory/pull-source-write-gate.ts'
const LOCK_MODULES = [RULE_MODULE, GATE_MODULE] as const

/**
 * The names through which the organisation lock can be taken, the module that defines each, and every
 * call site: file → number of direct calls. A call site in the defining module is listed too.
 */
const LOCK_NAMES: Readonly<Record<string, { definedIn: string; calls: Readonly<Record<string, number>> }>> = {
  directoryOrgLockSql: { definedIn: RULE_MODULE, calls: { [GATE_MODULE]: 1 } },
  directoryOrgLockKey: { definedIn: RULE_MODULE, calls: {} },
  DIRECTORY_ORG_LOCK_KEY_PREFIX: { definedIn: RULE_MODULE, calls: {} },
  [GATE_TRANSACTION_FUNCTION]: { definedIn: GATE_MODULE, calls: { [GATE_MODULE]: 1, [ROUTING_POLICY_ROUTE]: 1 } },
  [GATE_FUNCTION]: { definedIn: GATE_MODULE, calls: { [SYNC]: 2 } },
}

const LOCK_NAME_SET: ReadonlySet<string> = new Set(Object.keys(LOCK_NAMES))

const isLockModuleSpecifier = (specifier: string): boolean => /(^|\/)pull-source-(rule|write-gate)(\.[cm]?[jt]s)?$/.test(specifier)

/** Offences of the lock-holder census. */
function lockHolderCensus(files: SourceFile[]): string[] {
  const offences: string[] = []
  const calls = new Map<string, Map<string, number>>([...LOCK_NAME_SET].map((name) => [name, new Map()]))
  for (const file of files) {
    if (!file.text.includes('pull-source-') && ![...LOCK_NAME_SET].some((name) => file.text.includes(name))) continue
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
    const at = (node: ts.Node): string => `${file.path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
    const visit = (node: ts.Node): void => {
      // How the two modules are reached: named imports and named re-exports only.
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isLockModuleSpecifier(node.moduleSpecifier.text)) {
        const clause = node.importClause
        if (!clause || clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
          offences.push(`${at(node)} reaches ${node.moduleSpecifier.text} without naming what it imports`)
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && isLockModuleSpecifier(node.moduleSpecifier.text)) {
        if (!node.exportClause || !ts.isNamedExports(node.exportClause)) offences.push(`${at(node)} re-exports ${node.moduleSpecifier.text} without naming what it exports`)
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteral(node.moduleReference.expression) && isLockModuleSpecifier(node.moduleReference.expression.text)) {
        offences.push(`${at(node)} reaches ${node.moduleReference.expression.text} without naming what it imports`)
      }
      if (ts.isCallExpression(node)
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        && node.arguments.some((argument) => (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) && isLockModuleSpecifier(argument.text))) {
        offences.push(`${at(node)} loads a pull-source module at run time`)
      }
      // Every occurrence of a lock name outside its defining module is an unrenamed import or a direct call.
      const named = ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null
      if (named !== null && LOCK_NAME_SET.has(named)) {
        const parent = node.parent
        const isCall = ts.isIdentifier(node) && ts.isCallExpression(parent) && parent.expression === node
        const isPlainImport = ts.isIdentifier(node) && ts.isImportSpecifier(parent) && parent.name === node && parent.propertyName === undefined
        if (isCall) {
          const perFile = calls.get(named)!
          perFile.set(file.path, (perFile.get(file.path) ?? 0) + 1)
        } else if (file.path !== LOCK_NAMES[named].definedIn && !isPlainImport) {
          offences.push(`${at(node)} uses ${named} other than by importing it under its own name and calling it`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  for (const [name, { calls: expected }] of Object.entries(LOCK_NAMES)) {
    const found = Object.fromEntries([...calls.get(name)!.entries()].sort())
    const wanted = Object.fromEntries(Object.entries(expected).sort())
    if (JSON.stringify(found) !== JSON.stringify(wanted)) {
      offences.push(`${name} is called from ${JSON.stringify(found)}, expected ${JSON.stringify(wanted)}`)
    }
  }
  return offences
}

describe('census of holders of the organisation lock', () => {
  it('the lock statement is built in the gate module only, and a gate transaction is opened from the listed call sites only', () => {
    for (const path of [...LOCK_MODULES, ROUTING_POLICY_ROUTE, SYNC]) expect(SOURCE.some((file) => file.path === path), path).toBe(true)
    expect(lockHolderCensus(SOURCE)).toEqual([])
  })

  it('the lock key text is written in the rule module only', () => {
    const carriers = SOURCE.filter((file) => file.text.includes('directory:pull-sources')).map((file) => file.path)
    expect(carriers).toEqual([RULE_MODULE])
    const advisory = SOURCE.filter((file) => LOCK_MODULES.includes(file.path as (typeof LOCK_MODULES)[number]) && /pg_(try_)?advisory/i.test(file.text)).map((file) => file.path)
    expect(advisory).toEqual([RULE_MODULE])
  })

  const OTHER_FILES = ['routes/admin-directory.ts', 'directory/controlled-handover.ts', 'integrations/feishu/config.ts', 'services/ApprovalDirectoryOrg.ts'] as const
  const HOLDER_SYNTHETIC: ReadonlyArray<{ form: string; code: string; expected: RegExp }> = [
    {
      form: 'a further caller of the gate transaction function',
      code: "import { runPullSourceGateTransaction as _unused0 } from '../directory/pull-source-write-gate'\nexport const syntheticHolder0 = () => _unused0('org', async () => undefined)",
      expected: /uses runPullSourceGateTransaction other than by importing it under its own name and calling it/,
    },
    {
      form: 'a direct call of the gate transaction function',
      code: "declare function runPullSourceGateTransaction(orgId: string, body: () => Promise<unknown>): Promise<unknown>\nexport const syntheticHolder1 = () => runPullSourceGateTransaction('org', async () => undefined)",
      expected: /runPullSourceGateTransaction is called from /,
    },
    {
      form: 'a direct call of the gated write function',
      code: "declare function runGatedPullSourceWrite(target: unknown, write: () => Promise<unknown>): Promise<unknown>\nexport const syntheticHolder2 = () => runGatedPullSourceWrite({}, async () => undefined)",
      expected: /runGatedPullSourceWrite is called from /,
    },
    {
      form: 'a direct call of the lock statement builder',
      code: "declare function directoryOrgLockSql(param?: string): string\nexport const syntheticHolder3 = (client: { query: (sql: string, params: unknown[]) => unknown }) => client.query(directoryOrgLockSql('$1'), ['org'])",
      expected: /directoryOrgLockSql is called from /,
    },
    {
      form: 'the lock key helper',
      code: "declare function directoryOrgLockKey(orgId: string): string\nexport const syntheticHolder4 = () => directoryOrgLockKey('org')",
      expected: /directoryOrgLockKey is called from /,
    },
    {
      form: 'the lock key prefix read as a value',
      code: "declare const DIRECTORY_ORG_LOCK_KEY_PREFIX: string\nexport const syntheticHolder5 = () => `SELECT pg_advisory_xact_lock(hashtext('${DIRECTORY_ORG_LOCK_KEY_PREFIX}' || $1))`",
      expected: /uses DIRECTORY_ORG_LOCK_KEY_PREFIX other than by importing it under its own name and calling it/,
    },
    {
      form: 'the function bound to another name',
      code: "declare function runPullSourceGateTransaction(orgId: string, body: () => Promise<unknown>): Promise<unknown>\nexport const syntheticHolder6 = runPullSourceGateTransaction",
      expected: /uses runPullSourceGateTransaction other than by importing it under its own name and calling it/,
    },
    {
      form: 'a namespace import of the gate module',
      code: "import * as syntheticGate from '../directory/pull-source-write-gate'\nexport const syntheticHolder7 = syntheticGate",
      expected: /reaches \.\.\/directory\/pull-source-write-gate without naming what it imports/,
    },
    {
      form: 'a namespace import of the rule module',
      code: "import * as syntheticRule from '../directory/pull-source-rule'\nexport const syntheticHolder8 = syntheticRule",
      expected: /reaches \.\.\/directory\/pull-source-rule without naming what it imports/,
    },
    {
      form: 'a wildcard re-export',
      code: "export * from '../directory/pull-source-write-gate'",
      expected: /re-exports \.\.\/directory\/pull-source-write-gate without naming what it exports/,
    },
    {
      form: 'a named re-export of the function',
      code: "export { runPullSourceGateTransaction } from '../directory/pull-source-write-gate'",
      expected: /uses runPullSourceGateTransaction other than by importing it under its own name and calling it/,
    },
    {
      form: 'a runtime require',
      code: "declare function require(id: string): Record<string, unknown>\nexport const syntheticHolder9 = require('../directory/pull-source-write-gate')",
      expected: /loads a pull-source module at run time/,
    },
    {
      form: 'a dynamic import',
      code: "export const syntheticHolder10 = () => import('../directory/pull-source-rule.js')",
      expected: /loads a pull-source module at run time/,
    },
    {
      form: 'the function read by its name as a string',
      code: "declare const syntheticModule: Record<string, unknown>\nexport const syntheticHolder11 = syntheticModule['runGatedPullSourceWrite']",
      expected: /uses runGatedPullSourceWrite other than by importing it under its own name and calling it/,
    },
  ]
  for (const { form, code, expected } of HOLDER_SYNTHETIC) {
    it(`positive control (${form}) fails the census wherever it is added`, () => {
      for (const path of OTHER_FILES) {
        expect(SOURCE.some((file) => file.path === path), path).toBe(true)
        const offences = lockHolderCensus(withText(SOURCE, path, (text) => `${text}\n${code}\n`)).join('\n')
        expect(offences, path).toMatch(expected)
        expect(offences, path).toContain(path)
      }
      // A JavaScript source file is read the same way.
      expect(lockHolderCensus([...SOURCE, { path: 'legacy/holder.js', text: code.replace(/^declare .*\n/, '').replace(/\(client: \{[^)]*\) =>/, '(client) =>') }]).join('\n')).toMatch(expected)
    })
  }

  it('positive control: a call removed from a listed call site fails the census', () => {
    const removed = withText(SOURCE, ROUTING_POLICY_ROUTE, (text) => edited(
      text,
      'const outcome = await runPullSourceGateTransaction<ClearOutcome>(orgId, async (client) => {',
      'const outcome = await transaction<ClearOutcome>(async (client) => {',
    ))
    expect(lockHolderCensus(removed).join('\n')).toContain(`${GATE_TRANSACTION_FUNCTION} is called from {"${GATE_MODULE}":1}`)
  })
})

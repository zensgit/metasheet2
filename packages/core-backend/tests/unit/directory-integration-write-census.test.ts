/**
 * Census of statements that write `directory_integrations` (no database).
 *
 * Rule: a statement that inserts a row, deletes a row, or updates `status`, `org_id`, `provider` or
 * `corp_id` decides which pull sources an organisation has. Every such statement in production source
 * must either run through the pull-source write gate or belong to the local directory anchor (which is
 * not a pull source). Every other update of the table is listed too, so the census is closed: a write
 * statement that is not classified below, or a classification that matches nothing, fails.
 *
 * The population is derived by scanning `src/**` outside `db/migrations`: every string literal,
 * template literal and `+` concatenation of them is read as one text (a `${…}` substitution reads as a
 * marker), and query-builder calls on the table are read from the syntax tree. What a statement writes
 * is decided by the scanner from the statement's own text, never by the classification: declaring a
 * statement as "other columns" while it sets one of the four columns fails.
 *
 * Guards against a wrong population: it is non-empty and has the known size; each spelling the scanner
 * accepts (schema-qualified, quoted, aliased, multi-line, templated, concatenated, tuple assignment,
 * query builder) has a synthetic statement that turns the census red when injected into a source file;
 * a statement the scanner flags exists under `db/migrations`, so that directory is absent from the
 * population because it is excluded and not because the scanner cannot see it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(__dirname, '../../src')
const TABLE = 'directory_integrations'
const GATE_FUNCTION = 'runGatedPullSourceWrite'
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

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'migrations' || entry.name === 'node_modules') continue
      walk(path, out)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

function loadSource(): SourceFile[] {
  return walk(SRC_ROOT).map((file) => ({
    path: relative(SRC_ROOT, file).split('\\').join('/'),
    text: readFileSync(file, 'utf8'),
  }))
}

// ── statement classifier (text only) ────────────────────────────────────────────────────────────────

const NAME = `(?:"?[a-z_][a-z0-9_]*"?\\s*\\.\\s*)?"?${TABLE}"?(?![a-z0-9_])`
const INSERT_RE = new RegExp(`\\bINSERT\\s+INTO\\s+${NAME}`, 'i')
const DELETE_RE = new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?${NAME}`, 'i')
const UPDATE_RE = new RegExp(`\\bUPDATE\\s+(?:ONLY\\s+)?${NAME}(?:\\s*\\*)?(?:\\s+(?:AS\\s+)?(?!SET\\b)"?[a-z_][a-z0-9_]*"?)?\\s+SET\\b`, 'ig')

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
function writesIn(text: string): WriteKind[] {
  const kinds: WriteKind[] = []
  if (INSERT_RE.test(text)) kinds.push('insert')
  if (DELETE_RE.test(text)) kinds.push('delete')
  UPDATE_RE.lastIndex = 0
  for (let match = UPDATE_RE.exec(text); match; match = UPDATE_RE.exec(text)) {
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
 * True when the statement sits in a function expression that the enclosing function declaration hands to
 * the gate as its write callback: either written inline as the gate call's second argument, or bound to a
 * `const` whose name is that second argument.
 */
function isPassedToGate(node: ts.Node): boolean {
  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined
  let declaration: ts.FunctionDeclaration | undefined
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (!callback && (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))) callback = cur
    if (ts.isFunctionDeclaration(cur)) {
      declaration = cur
      break
    }
  }
  if (!callback || !declaration) return false
  const bound = ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name) ? callback.parent.name.text : null
  let passed = false
  const visit = (cur: ts.Node): void => {
    if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === GATE_FUNCTION) {
      const write = cur.arguments[1]
      if (write === callback) passed = true
      if (bound && write && ts.isIdentifier(write) && write.text === bound) passed = true
    }
    ts.forEachChild(cur, visit)
  }
  visit(declaration)
  return passed
}

const cache = new Map<string, WriteStatement[]>()

function statementsOf(file: SourceFile): WriteStatement[] {
  const key = `${file.path}\u0000${file.text}`
  const cached = cache.get(key)
  if (cached) return cached
  const found: WriteStatement[] = []
  if (file.text.includes(TABLE)) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
    const add = (node: ts.Node, kind: WriteKind, text: string) => {
      found.push({
        path: file.path,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        kind,
        text,
        owner: ownerOf(node),
        passedToGate: isPassedToGate(node),
      })
    }
    const visit = (node: ts.Node): void => {
      const isText = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
      if (isPlus(node) || isText) {
        const text = textOf(node)
        for (const kind of writesIn(text)) add(node, kind, text)
        // A `+` chain was read as one text; its operands are not read again.
        if (isPlus(node)) return
      }
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ['insertInto', 'updateTable', 'deleteFrom', 'replaceInto', 'mergeInto'].includes(node.expression.name.text)
        && node.arguments.some((argument) => new RegExp(`(^|[\\s."])${TABLE}($|[\\s"])`).test(textOf(argument)))
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

function population(files: SourceFile[]): WriteStatement[] {
  return files.flatMap(statementsOf)
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

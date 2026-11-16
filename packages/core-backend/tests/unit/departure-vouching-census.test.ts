/**
 * Departure vouching — census of "nobody vouches" statements (no database).
 *
 * The population is derived by scanning production source: every string literal outside
 * `db/migrations` that names `directory_account_links` and contains `NOT EXISTS`. A statement
 * that routes through `departure-vouching.ts` carries neither token in its own text (the
 * builders return the whole expression), so such a statement is outside the population by
 * construction. Every member of the population must be classified below; a member that is not
 * classified, or a classification that matches nothing, fails the census.
 *
 * Guards against a wrong population: the population is non-empty, the known files appear in it,
 * the statements known to route through the builders are outside it, and a synthetic
 * unclassified statement injected into a copy of each routed file makes the scan fail.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(__dirname, '../../src')

type SourceFile = { path: string; text: string }
type Literal = { path: string; line: number; text: string }

/**
 * Statements that name `directory_account_links` and `NOT EXISTS` and are not vouching
 * decisions. `contains` is a fragment of the statement's own text.
 */
const CLASSIFIED: ReadonlyArray<{ path: string; contains: string; category: 'display read' }> = [
  {
    path: 'routes/admin-users.ts',
    contains: "l.local_user_id = users.id AND l.link_status = 'linked'",
    category: 'display read',
  },
  // fetchIneligibleDelegationUsers grey suggestions (admin-users.ts query at the
  // authority_seeds statement). Display read: NOT EXISTS authorized_users, not a vouch.
  {
    path: 'routes/admin-users.ts',
    contains: 'FROM authorized_users auth_user',
    category: 'display read',
  },
  {
    path: 'services/elearning-department-stats.ts',
    contains: 'elearning-department-stats:aggregate',
    category: 'display read',
  },
]

/** Files whose statements route through the builders; each must interpolate these names. */
const ROUTED: ReadonlyArray<{ path: string; builders: string[] }> = [
  { path: 'directory/deprovision-ledger.ts', builders: ['orgVouchExists(', 'globalVouchExists('] },
  { path: 'directory/directory-sync.ts', builders: ['orgVouchExists('] },
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

const literalCache = new Map<string, Literal[]>()

/**
 * Every string literal, no-substitution template and template expression of a file. A template
 * expression reads as its text with each `${…}` replaced by a marker, so a statement that
 * interpolates a builder shows the builder's absence from its own text.
 */
function literals(file: SourceFile): Literal[] {
  const key = `${file.path}\u0000${file.text}`
  const cached = literalCache.get(key)
  if (cached) return cached
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
  const found: Literal[] = []
  const add = (node: ts.Node, text: string) => {
    found.push({
      path: file.path,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      text,
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(node, node.text)
    } else if (ts.isTemplateExpression(node)) {
      add(node, node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join(''))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  literalCache.set(key, found)
  return found
}

function population(files: SourceFile[]): Literal[] {
  return files
    .flatMap(literals)
    .filter((literal) => /directory_account_links/i.test(literal.text) && /NOT\s+EXISTS/i.test(literal.text))
}

/** Offences: unclassified members, and classifications that match nothing. */
function census(files: SourceFile[]): string[] {
  const members = population(files)
  const offences: string[] = []
  for (const member of members) {
    const matching = CLASSIFIED.filter(
      (entry) => entry.path === member.path && member.text.includes(entry.contains),
    )
    if (matching.length !== 1) {
      offences.push(`${member.path}:${member.line} is not classified exactly once`)
    }
  }
  for (const entry of CLASSIFIED) {
    if (!members.some((member) => member.path === entry.path && member.text.includes(entry.contains))) {
      offences.push(`classification for ${entry.path} matches no statement`)
    }
  }
  return offences
}

const SOURCE = loadSource()

function withText(files: SourceFile[], path: string, edit: (text: string) => string): SourceFile[] {
  return files.map((file) => (file.path === path ? { ...file, text: edit(file.text) } : file))
}

const SYNTHETIC = `
const syntheticStatement = \`SELECT 1 FROM users u WHERE NOT EXISTS (
  SELECT 1 FROM directory_account_links x WHERE x.local_user_id = u.id
)\`
`

describe('census of "nobody vouches" statements', () => {
  it('derives a non-empty population from source and classifies every member', () => {
    const members = population(SOURCE)
    expect(SOURCE.length).toBeGreaterThan(100)
    expect(members.length).toBeGreaterThan(0)
    expect(census(SOURCE)).toEqual([])
  })

  it('finds the known statements in the derived population', () => {
    const members = population(SOURCE)
    for (const entry of CLASSIFIED) {
      expect(members.some((member) => member.path === entry.path && member.text.includes(entry.contains))).toBe(true)
    }
  })

  it('keeps the vouching module and the four routed statements outside the population', () => {
    const members = population(SOURCE)
    expect(members.some((member) => member.path === 'directory/departure-vouching.ts')).toBe(false)
    for (const routed of ROUTED) {
      expect(members.some((member) => member.path === routed.path)).toBe(false)
      const file = SOURCE.find((candidate) => candidate.path === routed.path)
      expect(file).toBeDefined()
      for (const builder of routed.builders) expect(file!.text).toContain(builder)
    }
  })

  it('positive control: an unclassified statement in any scanned file fails the census', () => {
    for (const path of [...ROUTED.map((entry) => entry.path), 'directory/departure-vouching.ts', 'routes/admin-users.ts']) {
      const mutated = withText(SOURCE, path, (text) => `${text}\n${SYNTHETIC}`)
      const offences = census(mutated)
      expect(offences.length, path).toBeGreaterThan(0)
      expect(offences.join('\n')).toContain(`${path}:`)
    }
  })

  it('positive control: reinstating the inline predicate at a routed statement fails the census', () => {
    const inline = `NOT EXISTS (
          SELECT 1 FROM directory_account_links sibling_link
           WHERE sibling_link.local_user_id = $1::text AND sibling_link.link_status = 'linked'
        )`
    const ledger = withText(SOURCE, 'directory/deprovision-ledger.ts', (text) => {
      const edited = text.replace(/NOT \$\{orgVouchExists\([^)]*\)\} AS org_candidacy_clear,/, `${inline} AS org_candidacy_clear,`)
      expect(edited).not.toBe(text)
      return edited
    })
    expect(census(ledger).length).toBeGreaterThan(0)
    const sync = withText(SOURCE, 'directory/directory-sync.ts', (text) => {
      const edited = text.replace(/NOT \$\{orgVouchExists\(\{ user: 'l\.local_user_id'[^)]*\)\}/, inline)
      expect(edited).not.toBe(text)
      return edited
    })
    expect(census(sync).length).toBeGreaterThan(0)
  })

  it('positive control: a classification that matches nothing fails the census', () => {
    const without = withText(SOURCE, 'routes/admin-users.ts', (text) => text.replace("l.link_status = 'linked'", "l.link_status = 'x'"))
    expect(census(without).join('\n')).toContain('classification for routes/admin-users.ts matches no statement')
  })
})

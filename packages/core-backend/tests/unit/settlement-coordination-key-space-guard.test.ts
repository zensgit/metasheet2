/**
 * Key-space guard ① for the attendance settlement coordination key: no source file outside the
 * coordination module and its own tests may use 1297297987 / 0x4D533243 (the reserved two-int4
 * key1). The population is the repository's source tree, walked from disk — not a hand-kept list
 * — and the walk asserts it actually reached the module that defines the constant, so a scan that
 * silently covers the wrong tree fails instead of passing.
 * The same walk reserves the user-access namespace to its helper; the shared registry may only
 * reference that constant as metadata. Tests may exercise either namespace.
 *
 * Guard ④, population half: every two-int4 advisory call in production source must be classified by
 * the census (`tests/helpers/settlement-coordination-advisory-census.ts`), every constant site must
 * still be tied to the code that binds its key1, and every registry entry must be named by the
 * census. The value half (each key1 computed in PostgreSQL, pairwise distinct, none but the
 * coordination entry equal to 0x4D533243) is in the real-database key and credential suite.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { USER_ACCESS_LOCK_NAMESPACE } from '../../src/auth/user-access-lock'
import {
  ADVISORY_FIXED_KEY1_REGISTRY,
  SETTLEMENT_COORDINATION_KEY1,
} from '../../src/attendance/coordination/settlement-coordination-key'
import {
  ADVISORY_TWO_INT4_CENSUS_V1,
  STOCK_DELETE_ACTIVITY,
  censusEntryOwns,
  stripCodeComments,
  scanTwoInt4AdvisorySites,
  type AdvisoryTwoInt4CensusEntryV1,
} from '../helpers/settlement-coordination-advisory-census'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const ROOTS = ['packages', 'plugins', 'scripts', 'apps']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo', '.vite', '.next', 'out'])
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.cjs', '.mjs', '.vue', '.sql'])
// Decimal, hexadecimal, octal and binary spellings of 0x4D533243. Digit separators (`1_297_297_987`)
// are removed before matching, so a separated spelling cannot slip past.
const RESERVED = /1297297987|0x4d533243|0o11524631103|0b1001101010100110011001001000011/i
const withoutDigitSeparators = (text: string): string => text.replace(/(?<=[0-9a-fA-F])_(?=[0-9a-fA-F])/g, '')

const DEFINING_MODULE = 'packages/core-backend/src/attendance/coordination/settlement-coordination-key.ts'
const USER_ACCESS_MODULE = 'packages/core-backend/src/auth/user-access-lock.ts'
const USER_ACCESS_RESERVED = new RegExp([
  String(USER_ACCESS_LOCK_NAMESPACE),
  `0x${USER_ACCESS_LOCK_NAMESPACE.toString(16)}`,
  `0o${USER_ACCESS_LOCK_NAMESPACE.toString(8)}`,
  `0b${USER_ACCESS_LOCK_NAMESPACE.toString(2)}`,
  'USER_ACCESS_LOCK_NAMESPACE',
].join('|'), 'i')

function userAccessNamespaceProblems(file: string, source: string): string[] {
  if (file === USER_ACCESS_MODULE || /(?:^|\/)(?:tests|__tests__)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]s$/.test(file)) return []
  let text = withoutDigitSeparators(source)
  if (file === DEFINING_MODULE) {
    // Only these two metadata references are allowed; moving a lock call here must still fail.
    text = text
      .replace("import { USER_ACCESS_LOCK_NAMESPACE } from '../../auth/user-access-lock'", '')
      .replace("fixedKey1('user-access', { literal: USER_ACCESS_LOCK_NAMESPACE }, 'packages/core-backend/src/auth/user-access-lock.ts (bind parameter)')", '')
  }
  return USER_ACCESS_RESERVED.test(text) ? [file] : []
}

const ALLOWED_FILES = new Set([
  DEFINING_MODULE,
  'packages/core-backend/src/attendance/__tests__/settlement-coordination-key.test.ts',
  'packages/core-backend/src/attendance/__tests__/settlement-coordination-statements.test.ts',
  'packages/core-backend/tests/unit/settlement-coordination-key-space-guard.test.ts',
])
const ALLOWED_PREFIXES = [
  'packages/core-backend/tests/integration/attendance-coordination-',
  'packages/core-backend/tests/helpers/settlement-coordination-',
]

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out)
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
}

describe('settlement coordination key space — guard ①', () => {
  it('no source file outside the coordination module uses the reserved key1', () => {
    const files: string[] = []
    for (const root of ROOTS) walk(path.join(REPO_ROOT, root), files)
    const relative = files.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))

    // The walk must cover the real tree: every root, the defining module and a known sibling.
    expect(relative).toContain(DEFINING_MODULE)
    expect(relative).toContain(USER_ACCESS_MODULE)
    expect(relative).toContain('packages/core-backend/src/attendance/w4c0-identity.ts')
    expect(relative).toContain('plugins/plugin-attendance/index.cjs')
    expect(relative).toContain('scripts/ops/attendance-w4c2-ci-wiring.test.mjs')
    expect(relative).toContain('apps/web/src/main.ts')
    expect(relative.length).toBeGreaterThan(1000)

    const offenders: string[] = []
    const userAccessOffenders: string[] = []
    let definingModuleMatched = false
    for (let i = 0; i < files.length; i += 1) {
      const rel = relative[i]
      const text = withoutDigitSeparators(fs.readFileSync(files[i], 'utf8'))
      userAccessOffenders.push(...userAccessNamespaceProblems(rel, text))
      if (!RESERVED.test(text)) continue
      if (rel === DEFINING_MODULE) definingModuleMatched = true
      const allowed = ALLOWED_FILES.has(rel) || ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix))
      if (!allowed) offenders.push(rel)
    }
    expect(definingModuleMatched).toBe(true)
    expect(offenders).toEqual([])
    expect(USER_ACCESS_LOCK_NAMESPACE).toBe(0x4d533241)
    expect(userAccessOffenders).toEqual([])
  })

  it('the same user-access key syntax is accepted only in its helper, regardless of numeric spelling', () => {
    const spellings = [
      'USER_ACCESS_LOCK_NAMESPACE', String(USER_ACCESS_LOCK_NAMESPACE),
      `0x${USER_ACCESS_LOCK_NAMESPACE.toString(16)}`, `0o${USER_ACCESS_LOCK_NAMESPACE.toString(8)}`,
      `0b${USER_ACCESS_LOCK_NAMESPACE.toString(2)}`, '1_297_297_985',
    ]
    for (const key of spellings) {
      const source = `await client.query('SELECT pg_advisory_xact_lock_shared($1::int4, $2::int4)', [${key}, userKey])`
      expect(userAccessNamespaceProblems(USER_ACCESS_MODULE, source)).toEqual([])
      expect(userAccessNamespaceProblems('packages/core-backend/src/auth/other.ts', source)).toEqual(['packages/core-backend/src/auth/other.ts'])
      expect(userAccessNamespaceProblems(DEFINING_MODULE, source)).toEqual([DEFINING_MODULE])
    }
  })
})

const REGISTRY_BY_NAME = new Map(ADVISORY_FIXED_KEY1_REGISTRY.map((entry) => [entry.name, entry]))

function readSource(file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

/** `export const NAME = <number | 'string'>` (the value may sit on the next line, `as const` allowed). */
function exportedConstantValue(text: string, name: string): number | string | null {
  const match = new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*(0x[0-9a-fA-F]+|-?\\d+|'[^']*')`).exec(text)
  if (!match) return null
  const raw = match[1]
  return raw.startsWith("'") ? raw.slice(1, -1) : Number(raw)
}

function registryValue(name: string): number | string | undefined {
  const entry = REGISTRY_BY_NAME.get(name)
  if (!entry) return undefined
  return 'literal' in entry.key1 ? entry.key1.literal : entry.key1.hashtext
}

// The acquire and unlock SQL both receive a local array outside their census windows.
// Account for every use of that array and of its private namespace constant so neither
// reassignment, a different bind, nor a comment standing in for a real bind can pass.
function stockDeleteActivityBindingMatches(source: string): boolean {
  const text = stripCodeComments(source)
  const value = registryValue('stock-preparation-delete-activity')
  return typeof value === 'number'
    && text.split('\n').some(line => line.trim() === `const PROJECT_ACTIVITY_NAMESPACE = ${value}`)
    && text.split('\n').some(line => line.trim() === 'const key = [PROJECT_ACTIVITY_NAMESPACE, JSON.stringify([tenantId, projectNo])]')
    && text.includes('[PROJECT_ACTIVITY_NAMESPACE, JSON.stringify([tenantId, project])]')
    && (text.match(/\bPROJECT_ACTIVITY_NAMESPACE\b/g) ?? []).length === 3
    && (text.match(/\bkey\b/g) ?? []).length === 3
}

/** Arguments of every call `name(` in `text` that is not the function's own definition. */
function helperCallArguments(text: string, name: string): string[][] {
  const calls: string[][] = []
  for (const match of text.matchAll(new RegExp(`(?<!function )\\b${name}\\(`, 'g'))) {
    let depth = 1
    let current = ''
    const args: string[] = []
    for (let i = (match.index ?? 0) + match[0].length; i < text.length; i += 1) {
      const ch = text[i]
      if (ch === '(') depth += 1
      if (ch === ')') depth -= 1
      if (depth === 0) {
        args.push(current.trim())
        break
      }
      if (ch === ',' && depth === 1) {
        args.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    calls.push(args)
  }
  return calls
}

describe('settlement coordination key space — guard ④ population (closed world)', () => {
  const scan = scanTwoInt4AdvisorySites(REPO_ROOT)

  it('every two-int4 advisory call in production source matches exactly one census entry', () => {
    // The scan must cover the real tree and find the known population.
    expect(scan.files).toBeGreaterThan(1000)
    // Every advisory call must be readable: both argument readings agree on 1 or 2 arguments.
    expect(scan.anomalies).toEqual([])
    expect(scan.calls).toBeGreaterThanOrEqual(160)
    expect(scan.sites.filter((site) => site.file === 'packages/core-backend/src/audit/AuditRepository.ts')).toHaveLength(3)
    expect(scan.sites.length).toBeGreaterThanOrEqual(45)

    const matchesOf = (entry: AdvisoryTwoInt4CensusEntryV1) => scan.sites.filter((site) => censusEntryOwns(entry, site))
    const unclassified: string[] = []
    for (const site of scan.sites) {
      const owners = ADVISORY_TWO_INT4_CENSUS_V1.filter((entry) => censusEntryOwns(entry, site))
      if (owners.length !== 1) unclassified.push(`${site.file}:${site.line} key1=${site.key1} matches ${owners.length} census entries`)
    }
    expect(unclassified).toEqual([])
    const miscounted = ADVISORY_TWO_INT4_CENSUS_V1
      .map((entry) => ({ entry, found: matchesOf(entry).length }))
      .filter(({ entry, found }) => entry.count !== 'any' && found !== (entry.count ?? 1))
      .map(({ entry, found }) => `${entry.file} key1=${entry.key1} window=${JSON.stringify(entry.window)}: expected ${entry.count ?? 1}, found ${found}`)
    expect(miscounted).toEqual([])
    // A prefix entry names a directory, a non-empty window and a key1 expression: it never classifies a site by file alone.
    for (const entry of ADVISORY_TWO_INT4_CENSUS_V1.filter((e) => e.fileMatch === 'prefix')) {
      expect(entry.file.endsWith('/')).toBe(true)
      expect(entry.window.length).toBeGreaterThan(0)
      expect(entry.window).toContain(entry.key1)
    }
  })

  it('POSITIVE CONTROL — a prefix entry owns a site under its directory with its key1 and window, and nothing else', () => {
    const prefix = ADVISORY_TWO_INT4_CENSUS_V1.find((e) => e.fileMatch === 'prefix')!
    const site = (file: string, key1: string, code: string) => ({ file, line: 1, fn: 'pg_try_advisory_xact_lock', key1, key2: '1', window: code, code })
    expect(censusEntryOwns(prefix, site(`${prefix.file}zzzz20261107000000_x.ts`, prefix.key1, prefix.window))).toBe(true)
    expect(censusEntryOwns(prefix, site(`${prefix.file}zzzz20261107000000_x.ts`, prefix.key1, 'pg_advisory_xact_lock(20261106, 1)'))).toBe(false)
    expect(censusEntryOwns(prefix, site(`${prefix.file}zzzz20261107000000_x.ts`, '20261107', prefix.window))).toBe(false)
    expect(censusEntryOwns(prefix, site('packages/core-backend/src/rbac/x.ts', prefix.key1, prefix.window))).toBe(false)
  })

  it('binds every project-deletion advisory site to its own key space and argument', () => {
    const source = readSource(STOCK_DELETE_ACTIVITY)
    expect(stockDeleteActivityBindingMatches(source)).toBe(true)
    for (const mutant of [
      source.replace('NAMESPACE = 6991', 'NAMESPACE = 16991'),
      source.replace('NAMESPACE = 6991', 'NAMESPACE = 6991 + 10000'),
      source.replace('const key = [PROJECT_ACTIVITY_NAMESPACE,', 'const key = [16991,'),
      source.replace('return activity.withConnection', 'key[0] = 16991\n  return activity.withConnection'),
    ]) expect(stockDeleteActivityBindingMatches(mutant)).toBe(false)

    const entries = ADVISORY_TWO_INT4_CENSUS_V1.filter(entry =>
      entry.registry?.some(name => name.startsWith('stock-preparation-delete-')))
    expect(entries).toHaveLength(7)
    for (const entry of entries) {
      const sites = scan.sites.filter(site => censusEntryOwns(entry, site))
      expect(sites).toHaveLength(1)
      const [site] = sites
      const changed = entry.key1 === '16991' ? '6991' : '16991'
      const mutations = [
        { ...site, key1: changed, code: site.code.replace(entry.key1, changed) },
        { ...site, code: site.code.replace('hashtext(', 'other_hash(') },
        { ...site, file: 'plugins/plugin-integration-core/lib/other.cjs' },
      ]
      if (entry.file === STOCK_DELETE_ACTIVITY) mutations.push({
        ...site, code: site.code.replace(/, key\)|\[PROJECT_ACTIVITY_NAMESPACE,/, ', wrongBinding)'),
      })
      for (const mutation of mutations) expect(ADVISORY_TWO_INT4_CENSUS_V1.filter(row => censusEntryOwns(row, mutation))).toEqual([])
    }
  })

  it('constant census entries name registry entries and are still tied to the code that binds key1', () => {
    const problems: string[] = []
    for (const entry of ADVISORY_TWO_INT4_CENSUS_V1) {
      if (entry.kind === 'variable') {
        if (entry.registry || entry.boundLiterals || entry.boundConstants) problems.push(`${entry.file}: variable entry carries constant evidence`)
        continue
      }
      if (!entry.registry || entry.registry.length === 0) problems.push(`${entry.file}: ${entry.kind} entry names no registry entry`)
      for (const name of entry.registry ?? []) if (!REGISTRY_BY_NAME.has(name)) problems.push(`${entry.file}: unknown registry entry ${name}`)
      const text = entry.fileMatch === 'prefix' ? '' : readSource(entry.file)
      // A bound literal must sit in the code (comments removed) of every site the entry matches; a
      // helper's literals are checked at its call sites below instead.
      const sites = scan.sites.filter((site) => censusEntryOwns(entry, site))
      for (const literal of entry.boundLiterals ?? []) {
        if (!entry.helper && !sites.every((site) => site.code.includes(`'${literal}'`))) {
          problems.push(`${entry.file}: bound literal '${literal}' is not in the code of every matched site`)
        }
        if (registryValue(literal) !== literal) problems.push(`${entry.file}: registry entry ${literal} does not hash '${literal}'`)
      }
      for (const bound of entry.boundConstants ?? []) {
        const value = exportedConstantValue(text, bound.name)
        if (value === null) problems.push(`${entry.file}: exported constant ${bound.name} not found`)
        else if (registryValue(bound.registry) !== value) problems.push(`${entry.file}: ${bound.name} = ${String(value)} but registry ${bound.registry} = ${String(registryValue(bound.registry))}`)
      }
      if (entry.helper) {
        const passed = helperCallArguments(text, entry.helper.name).map((args) => args[entry.helper!.argIndex] ?? '')
        const literals = passed.map((arg) => /^'([^']*)'$/.exec(arg)?.[1] ?? null)
        if (passed.length === 0) problems.push(`${entry.file}: no calls of ${entry.helper.name}`)
        if (literals.some((value) => value === null)) problems.push(`${entry.file}: a ${entry.helper.name} call passes a non-literal namespace`)
        const set = new Set(literals.filter((value): value is string => value !== null))
        if ([...set].sort().join('|') !== [...(entry.boundLiterals ?? [])].sort().join('|')) problems.push(`${entry.file}: ${entry.helper.name} namespaces ${[...set].join(', ')} differ from the census`)
      }
      // Literal-form key1 must agree with the registry value it names.
      if (/^-?\d+$/.test(entry.key1) && !(entry.registry ?? []).every((name) => registryValue(name) === Number(entry.key1))) {
        problems.push(`${entry.file}: literal key1 ${entry.key1} disagrees with its registry entries`)
      }
      const literalHashtext = /^hashtext\('([^']*)'\)$/.exec(entry.key1)
      if (literalHashtext && !(entry.registry ?? []).every((name) => registryValue(name) === literalHashtext[1])) {
        problems.push(`${entry.file}: key1 ${entry.key1} disagrees with its registry entries`)
      }
      if (entry.key1 === '${KEY1_LITERAL}' && !(entry.registry ?? []).every((name) => registryValue(name) === SETTLEMENT_COORDINATION_KEY1)) {
        problems.push(`${entry.file}: coordination sites must name the coordination entry`)
      }
    }
    expect(problems).toEqual([])
  })

  it('every registry entry is named by the census, and names and values are unique', () => {
    const named = new Set(ADVISORY_TWO_INT4_CENSUS_V1.flatMap((entry) => entry.registry ?? []))
    expect(ADVISORY_FIXED_KEY1_REGISTRY.map((entry) => entry.name).filter((name) => !named.has(name))).toEqual([])
    const names = ADVISORY_FIXED_KEY1_REGISTRY.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    const sources = ADVISORY_FIXED_KEY1_REGISTRY.map((entry) => JSON.stringify(entry.key1))
    expect(new Set(sources).size).toBe(sources.length)
    const literals = ADVISORY_FIXED_KEY1_REGISTRY.flatMap((entry) => ('literal' in entry.key1 ? [entry.key1.literal] : []))
    expect(literals.filter((value) => value === SETTLEMENT_COORDINATION_KEY1)).toHaveLength(1)
  })
})

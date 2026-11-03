/**
 * P1-1 unit lane (S5 G5, A13): the settlement coordination unit suites run in the default (no-DB)
 * vitest job. Nothing else notices when one of them is dropped from that job: the CI wiring guard
 * only follows `tests/integration/attendance-*`. So this reads `packages/core-backend/vitest.config.ts`
 * on the syntax tree and asserts that every lane file is matched by `test.include` (vitest's default
 * when the config sets none) and by no `test.exclude` entry.
 *
 * The lane, walked from disk: every `src/attendance/__tests__/*.test.ts` whose name starts with
 * `settlement-coordinat` (which also takes in `settlement-coordinator.test.ts`) or
 * `w4c0-runner-uncertainty-mark`, every `tests/unit/settlement-coordination-*.test.ts` (this file
 * included) and `tests/unit/attendance-w4-release-wiring-guard.test.ts`.
 *
 * The reader fails loudly instead of passing vacuously: no default export, no `test` object, no
 * `test.exclude` array, a spread, a computed or non-literal entry, or a glob feature it does not
 * implement each throw.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const PACKAGE_ROOT = path.resolve(__dirname, '../..')
const CONFIG_FILE = 'vitest.config.ts'
/** Vitest 1.x's default `test.include`, which applies while the config sets none. */
const VITEST_DEFAULT_INCLUDE: readonly string[] = ['**/*.{test,spec}.?(c|m)[jt]s?(x)']
const UNIT_DIR = 'src/attendance/__tests__'
const GUARD_DIR = 'tests/unit'

function laneFiles(root: string): string[] {
  const units = fs
    .readdirSync(path.join(root, UNIT_DIR))
    .filter((name) => /^(settlement-coordinat|w4c0-runner-uncertainty-mark)[\w.-]*\.test\.ts$/.test(name))
    .map((name) => `${UNIT_DIR}/${name}`)
  const guards = fs
    .readdirSync(path.join(root, GUARD_DIR))
    .filter((name) => /^settlement-coordination-[\w.-]+\.test\.ts$/.test(name) || name === 'attendance-w4-release-wiring-guard.test.ts')
    .map((name) => `${GUARD_DIR}/${name}`)
  return [...units, ...guards].sort()
}

function propertyOf(object: ts.ObjectLiteralExpression, name: string, where: string): ts.Expression | undefined {
  let found: ts.Expression | undefined
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) throw new Error(`vitest config: a spread in ${where} cannot be read`)
    const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null
    if (key === null) throw new Error(`vitest config: a computed key in ${where} cannot be read`)
    if (key !== name) continue
    if (!ts.isPropertyAssignment(property)) throw new Error(`vitest config: ${where}.${name} is not a plain property`)
    if (found) throw new Error(`vitest config: ${where}.${name} is set twice`)
    found = property.initializer
  }
  return found
}

function stringArray(expression: ts.Expression, where: string): string[] {
  if (!ts.isArrayLiteralExpression(expression)) throw new Error(`vitest config: ${where} is not an array literal`)
  return expression.elements.map((element) => {
    if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) throw new Error(`vitest config: ${where} has an entry that is not a string literal`)
    return element.text
  })
}

/** `test.include` (null when the config sets none) and `test.exclude` of `export default defineConfig({ test: { … } })`. */
function readTestGlobs(text: string): { include: string[] | null; exclude: string[] } {
  const sourceFile = ts.createSourceFile(CONFIG_FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const exported = sourceFile.statements.find(ts.isExportAssignment)
  if (!exported) throw new Error('vitest config: no default export')
  let config: ts.Expression = exported.expression
  if (ts.isCallExpression(config) && ts.isIdentifier(config.expression) && config.expression.text === 'defineConfig' && config.arguments.length === 1) config = config.arguments[0]
  if (!ts.isObjectLiteralExpression(config)) throw new Error('vitest config: the default export is not defineConfig({ … })')
  const test = propertyOf(config, 'test', 'config')
  if (!test || !ts.isObjectLiteralExpression(test)) throw new Error('vitest config: no test object')
  const exclude = propertyOf(test, 'exclude', 'test')
  if (!exclude) throw new Error('vitest config: no test.exclude array')
  const include = propertyOf(test, 'include', 'test')
  return { include: include ? stringArray(include, 'test.include') : null, exclude: stringArray(exclude, 'test.exclude') }
}

/** A glob as vitest matches it against a path relative to the package: `**`, `*`, `?`, `[…]`, `{a,b}`, `?(a|b)`. */
function globToRegExp(glob: string): RegExp {
  let source = ''
  let braces = 0
  let groups = 0
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    const next = glob[index + 1]
    if (char === '*' && next === '*') {
      const before = index === 0 || glob[index - 1] === '/'
      const after = glob[index + 2]
      if (!before || (after !== undefined && after !== '/')) throw new Error(`glob ${glob}: ** must be a whole path segment`)
      if (after === '/') {
        source += '(?:[^/]*/)*'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
    } else if ((char === '*' || char === '+' || char === '@' || char === '!') && next === '(') {
      throw new Error(`glob ${glob}: extglob ${char}( is not implemented`)
    } else if (char === '?' && next === '(') {
      source += '(?:'
      groups += 1
      index += 1
    } else if (char === ')' && groups > 0) {
      source += ')?'
      groups -= 1
    } else if (char === '|' && groups > 0) {
      source += '|'
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[') {
      const end = glob.indexOf(']', index)
      if (end < 0 || glob[index + 1] === '!' || glob[index + 1] === '^') throw new Error(`glob ${glob}: character class not implemented`)
      source += glob.slice(index, end + 1)
      index = end
    } else if (char === '{') {
      source += '(?:'
      braces += 1
    } else if (char === '}' && braces > 0) {
      source += ')'
      braces -= 1
    } else if (char === ',' && braces > 0) {
      source += '|'
    } else if (char === '!' && index === 0) {
      throw new Error(`glob ${glob}: negation is not implemented`)
    } else {
      source += char.replace(/[.+^$()|\\]/g, '\\$&')
    }
  }
  if (braces !== 0 || groups !== 0) throw new Error(`glob ${glob}: unbalanced group`)
  return new RegExp(`^${source}$`)
}

/** Lane files the config would leave out of the default job, with the reason. */
function laneViolations(configText: string, files: readonly string[]): string[] {
  const { include, exclude } = readTestGlobs(configText)
  const includes = (include ?? VITEST_DEFAULT_INCLUDE).map((glob) => ({ glob, pattern: globToRegExp(glob) }))
  const excludes = exclude.map((glob) => ({ glob, pattern: globToRegExp(glob) }))
  const violations: string[] = []
  for (const file of files) {
    if (!includes.some(({ pattern }) => pattern.test(file))) violations.push(`${file}: not matched by test.include`)
    for (const { glob, pattern } of excludes) if (pattern.test(file)) violations.push(`${file}: excluded by ${glob}`)
  }
  return violations
}

function thrown(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  return 'did not throw'
}

describe('settlement coordination unit lane (P1-1 S5 G5, A13)', () => {
  const configText = fs.readFileSync(path.join(PACKAGE_ROOT, CONFIG_FILE), 'utf8')
  const files = laneFiles(PACKAGE_ROOT)

  it('every coordination unit suite and static guard is in the default vitest job: included, and excluded by nothing', () => {
    // Floors, not pins: the walk must have found the lane (11 unit suites + 7 static guards today).
    expect(files.filter((file) => file.startsWith(`${UNIT_DIR}/`)).length).toBeGreaterThanOrEqual(11)
    expect(files.filter((file) => file.startsWith(`${GUARD_DIR}/`)).length).toBeGreaterThanOrEqual(7)
    expect(files).toContain(`${UNIT_DIR}/settlement-coordinator.test.ts`)
    expect(files).toContain(`${UNIT_DIR}/w4c0-runner-uncertainty-mark.test.ts`)
    expect(files).toContain(`${GUARD_DIR}/attendance-w4-release-wiring-guard.test.ts`)
    expect(files).toContain(`${GUARD_DIR}/settlement-coordination-unit-lane-guard.test.ts`)
    // The config is really read: the exclude list is long and carries the entries every run has.
    const { exclude } = readTestGlobs(configText)
    expect(exclude.length).toBeGreaterThan(100)
    expect(exclude).toContain('**/node_modules/**')
    expect(exclude).toContain('tests/integration/attendance-coordination-port.db.test.ts')
    expect(laneViolations(configText, files)).toEqual([])
  })

  it('controls: an excluded lane file, an include that misses the lane and an unreadable config each fail', () => {
    const anchor = '\n    exclude: [\n'
    expect(configText.split(anchor)).toHaveLength(2)
    const withExcluded = configText.replace(anchor, `${anchor}      'src/attendance/__tests__/settlement-coordination-port.test.ts',\n`)
    expect(laneViolations(withExcluded, files)).toEqual([
      'src/attendance/__tests__/settlement-coordination-port.test.ts: excluded by src/attendance/__tests__/settlement-coordination-port.test.ts',
    ])
    const withGlob = configText.replace(anchor, `${anchor}      'tests/unit/settlement-coordination-*.test.ts',\n`)
    expect(laneViolations(withGlob, files)).toEqual(
      files.filter((file) => file.startsWith(`${GUARD_DIR}/settlement-coordination-`)).map((file) => `${file}: excluded by tests/unit/settlement-coordination-*.test.ts`),
    )
    const withDirectory = configText.replace(anchor, `${anchor}      'src/attendance/**',\n`)
    expect(laneViolations(withDirectory, files)).toEqual(files.filter((file) => file.startsWith(`${UNIT_DIR}/`)).map((file) => `${file}: excluded by src/attendance/**`))
    const narrowInclude = configText.replace(anchor, `\n    include: ['tests/integration/**/*.test.ts'],${anchor}`)
    expect(laneViolations(narrowInclude, files)).toEqual(files.map((file) => `${file}: not matched by test.include`))
    // Unreadable shapes throw instead of passing.
    expect(thrown(() => readTestGlobs("import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { globals: true } })"))).toBe('vitest config: no test.exclude array')
    expect(thrown(() => readTestGlobs("export default defineConfig({ test: { exclude: [...base, 'x'] } })"))).toBe('vitest config: test.exclude has an entry that is not a string literal')
    expect(thrown(() => readTestGlobs('export default defineConfig({ test: { exclude: EXCLUDED } })'))).toBe('vitest config: test.exclude is not an array literal')
    expect(thrown(() => readTestGlobs('export default defineConfig({ test: { ...shared } })'))).toBe('vitest config: a spread in test cannot be read')
    expect(thrown(() => readTestGlobs('export default defineConfig(build())'))).toBe('vitest config: the default export is not defineConfig({ … })')
    expect(thrown(() => readTestGlobs('export const config = {}'))).toBe('vitest config: no default export')
    expect(thrown(() => globToRegExp('src/+(a|b)/x.test.ts'))).toBe('glob src/+(a|b)/x.test.ts: extglob +( is not implemented')
    // The glob reader against the shapes vitest's default include and the config use.
    const include = globToRegExp(VITEST_DEFAULT_INCLUDE[0])
    expect(['a.test.ts', 'src/x/b.spec.mjs', 'tests/unit/c.test.cts', 'd.test.tsx'].map((file) => include.test(file))).toEqual([true, true, true, true])
    expect(['a.ts', 'src/x/b.test.json', 'tests/unit/c.test.ts.snap'].map((file) => include.test(file))).toEqual([false, false, false])
    const modules = globToRegExp('**/node_modules/**')
    expect(['node_modules/a.test.ts', 'src/node_modules/b/c.test.ts', 'src/my_node_modules/c.test.ts'].map((file) => modules.test(file))).toEqual([true, true, false])
  })
})

/**
 * Gate 20 (task feature design lock §12): `src/tasks/` has no I/O.
 *
 * Behavioural check, not a grep. Every database entry point is replaced BEFORE any module is
 * imported (vi.mock is hoisted): the shared pool manager, its pool's `query` / `connect` /
 * `transaction`, and the `pg` driver's `Pool` / `Client`. Each throws a sentinel error with
 * `code === 'TASK_DB_STUB'`. The test then imports every file under `src/tasks/`, calls every
 * exported function with placeholder arguments (executor-shaped parameters get the stub `query`),
 * and fails if any call reaches the stub. A positive control proves the stub is live.
 *
 * Static companion (the gate's import rule, read from the syntax tree): every module specifier of
 * every file under `src/tasks/`, followed through relative imports, must be a literal relative path
 * that resolves to a `.ts` file outside the DB layer; a package import anywhere in that graph fails.
 * The specifiers come from the TypeScript syntax tree, whatever their quotes (static, side-effect,
 * type-only and re-export declarations, `import x = require()`, `import()` types, dynamic `import()`
 * and `require()` calls, calls through a member named `require`), and `require` used as a value (an
 * alias, an argument, `{ require }`) fails too. Not detected: module names computed at run time
 * (`eval`, `new Function`, a property name built from strings). Control cells feed one in-memory
 * source per form.
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import * as path from 'path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const STUB_CODE = 'TASK_DB_STUB'
function stubError(): Error {
  return Object.assign(new Error(STUB_CODE), { code: STUB_CODE })
}
const thrower = (): never => {
  throw stubError()
}
const asyncThrower = async (): Promise<never> => {
  throw stubError()
}

vi.mock('../../src/integration/db/connection-pool', () => {
  const internalPool = { query: asyncThrower, connect: asyncThrower, end: async () => undefined, on: () => undefined }
  const pool = {
    query: asyncThrower,
    transaction: asyncThrower,
    getInternalPool: () => internalPool,
    healthCheck: asyncThrower,
  }
  return { poolManager: { get: () => pool } }
})

vi.mock('pg', () => {
  class Pool {
    constructor() {
      thrower()
    }
  }
  class Client {
    constructor() {
      thrower()
    }
  }
  return { Pool, Client, default: { Pool, Client } }
})

const TASKS_DIR = path.resolve(__dirname, '../../src/tasks')

function isStubError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === STUB_CODE
}

/** Placeholder argument list: the stub query for executor-looking params, otherwise a harmless scalar. */
function placeholderArgs(fn: (...args: unknown[]) => unknown): unknown[] {
  const src = Function.prototype.toString.call(fn)
  const paramText = src.slice(src.indexOf('(') + 1, src.indexOf(')'))
  const names = paramText.split(',').map((p) => p.trim().split(/[\s=:]/)[0]).filter(Boolean)
  return names.map((name) => (/query|executor|client|db/i.test(name) ? asyncThrower : 'x'))
}

async function callAndClassify(fn: (...args: unknown[]) => unknown): Promise<'stub' | 'ok-or-other'> {
  try {
    const result = fn(...placeholderArgs(fn))
    if (result && typeof (result as Promise<unknown>).then === 'function') await result
    return 'ok-or-other'
  } catch (err) {
    return isStubError(err) ? 'stub' : 'ok-or-other'
  }
}

describe('gate 20 — src/tasks has no I/O (behavioural)', () => {
  const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.ts'))

  it('the scanned population is non-empty', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('positive control: the pg query entry point reaches the stub', async () => {
    const pg = await import('../../src/db/pg')
    await expect(pg.query('SELECT 1')).rejects.toMatchObject({ code: STUB_CODE })
  })

  it('positive control: acquireTaskStructureLock(pg.query) reaches the stub', async () => {
    const pg = await import('../../src/db/pg')
    const { acquireTaskStructureLock } = await import('../../src/db/task-advisory-locks')
    await expect(acquireTaskStructureLock(pg.query, 'org-1')).rejects.toMatchObject({ code: STUB_CODE })
  })

  it('positive control: an executor-taking function fed the stub query reaches the stub', async () => {
    const probe = async (query: (sql: string) => Promise<unknown>) => query('SELECT 1')
    expect(await callAndClassify(probe as (...args: unknown[]) => unknown)).toBe('stub')
  })

  it('no exported function under src/tasks reaches the database stub', async () => {
    const reached: string[] = []
    let called = 0
    for (const file of files) {
      const mod = (await import(path.join(TASKS_DIR, file))) as Record<string, unknown>
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue
        called += 1
        if ((await callAndClassify(value as (...args: unknown[]) => unknown)) === 'stub') {
          reached.push(`${file}:${name}`)
        }
      }
    }
    expect(called).toBeGreaterThan(0)
    expect(reached).toEqual([])
  })
})

// ── Static companion: the import graph of src/tasks ────────────────────────────────────────────────

const SRC_ROOT = path.resolve(__dirname, '../../src')

/** Stands for a specifier that is not a plain literal (a template with `${…}`, a variable). */
const NON_LITERAL = '<non-literal>'

/** Stands for `require` used other than as the callee of a call (an alias, an argument, `{ require }`, `(0, require)`). */
const INDIRECT_REQUIRE = '<indirect require>'

const isRequireName = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === 'require'

/** `X.require` or `X['require']`. */
const isRequireMember = (node: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(node) && node.name.text === 'require') ||
  (ts.isElementAccessExpression(node) &&
    (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
    node.argumentExpression.text === 'require')

/** An identifier that names something (a declaration, a property, a member) rather than reading a value. */
function isNamePosition(node: ts.Node): boolean {
  const parent = node.parent
  if (ts.isShorthandPropertyAssignment(parent)) return false
  if ((parent as { name?: ts.Node }).name === node) return true
  if ((ts.isBindingElement(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) && parent.propertyName === node) return true
  return ts.isQualifiedName(parent) && parent.right === node
}

/** Where the database lives: the pool, the `pg` wrapper and the adapters that hold a pool. */
const DB_LAYER_PREFIXES = ['db/', 'integration/db/', 'data-adapters/']

/**
 * Every module specifier of a TypeScript source, read from its syntax tree (comments and strings never
 * count): declarations, `import x = require()`, `import()` types, and `import()` / `require()` /
 * `X.require()` calls. NON_LITERAL for a specifier that is not a literal; INDIRECT_REQUIRE for
 * `require` used as a value instead of being called.
 */
function moduleSpecifiers(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const literal = (node: ts.Node | undefined): string =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : NON_LITERAL
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      out.push(literal(node.moduleSpecifier))
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      out.push(literal(node.moduleReference.expression))
    } else if (ts.isImportTypeNode(node)) {
      out.push(ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : NON_LITERAL)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequireName(node.expression) || isRequireMember(node.expression))
    ) {
      out.push(literal(node.arguments[0]))
    } else if ((isRequireName(node) && !isNamePosition(node)) || isRequireMember(node)) {
      // `require` reached other than as the callee of a call: an alias, an argument, `(0, require)`, `{ require }`.
      if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) out.push(INDIRECT_REQUIRE)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Source text of a file under `src/` — or of an in-memory file, which the control cells use. */
type SourceReader = (rel: string) => string | undefined

const readSrc: SourceReader = (rel) => (existsSync(path.join(SRC_ROOT, rel)) ? readFileSync(path.join(SRC_ROOT, rel), 'utf8') : undefined)

/** `spec` relative to `from`, resolved to an existing `.ts` file (`x` → `x.ts`, `x.ts`, `x.js` → `x.ts`, `x/index.ts`). */
function resolveRelative(from: string, spec: string, read: SourceReader): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  const candidates = [`${base}.ts`, base.endsWith('.ts') ? base : null, base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : null, `${base}/index.ts`]
  for (const candidate of candidates) {
    if (candidate !== null && read(candidate) !== undefined) return candidate
  }
  return null
}

/** Walks relative imports from `entries` (into any directory except the DB layer); returns every violation. */
function staticImportViolations(entries: readonly string[], read: SourceReader = readSrc): { reached: Set<string>; violations: string[] } {
  const violations: string[] = []
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const rel = queue.shift() as string
    if (seen.has(rel)) continue
    seen.add(rel)
    const text = read(rel)
    if (text === undefined) {
      violations.push(`${rel} cannot be read`)
      continue
    }
    for (const spec of moduleSpecifiers(rel, text)) {
      if (spec === INDIRECT_REQUIRE) {
        violations.push(`${rel} uses require other than as a direct call`)
        continue
      }
      if (spec === NON_LITERAL) {
        violations.push(`${rel} has a non-literal module specifier`)
        continue
      }
      if (!spec.startsWith('.')) {
        violations.push(`${rel} imports package ${spec}`)
        continue
      }
      const target = resolveRelative(rel, spec, read)
      if (target === null) {
        violations.push(`${rel} imports ${spec}, which does not resolve to a .ts file`)
        continue
      }
      if (DB_LAYER_PREFIXES.some((prefix) => target.startsWith(prefix))) {
        violations.push(`${rel} imports the DB layer: ${target}`)
        continue
      }
      queue.push(target)
    }
  }
  return { reached: seen, violations }
}

/** Violations of one in-memory entry `tasks/gate20-entry.ts` with the given source (other files from src/). */
function violationsOfSource(text: string): string[] {
  const entry = 'tasks/gate20-entry.ts'
  return staticImportViolations([entry], (rel) => (rel === entry ? text : readSrc(rel))).violations
}

describe('gate 20 — static companion: the src/tasks import graph has no package or DB-layer import', () => {
  const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.ts'))

  it('every file under src/tasks, followed through its relative imports', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(staticImportViolations(files.map((f) => `tasks/${f}`)).violations).toEqual([])
  })

  it('positive control: the walk is transitive (task-dates reaches the multitable time-zone helper)', () => {
    expect(staticImportViolations(['tasks/task-dates.ts']).reached.has('multitable/automation-timezone.ts')).toBe(true)
  })

  it('positive control: a package pulled in by an imported helper is reported', () => {
    expect(violationsOfSource("import { x } from '../multitable/field-codecs'\n")).toContain('multitable/field-codecs.ts imports package sanitize-html')
  })

  it.each([
    ['static import, single quotes', "import { Pool } from 'pg'\n"],
    ['static import, double quotes', 'import { Pool } from "pg"\n'],
    ['side-effect import, double quotes', 'import "pg"\n'],
    ['type-only import', 'import type { Pool } from "pg"\n'],
    ['re-export, double quotes', 'export { Pool } from "pg"\n'],
    ['star re-export, single quotes', "export * from 'pg'\n"],
    ['import-equals require', 'import pg = require("pg")\n'],
    ['require call, double quotes', 'const pg = require("pg")\n'],
    ['require call, template literal', 'const pg = require(`pg`)\n'],
    ['dynamic import, double quotes', 'export async function f() { return import("pg") }\n'],
    ['dynamic import, template literal', 'export async function f() { return import(`pg`) }\n'],
    ['import() type', 'export type P = typeof import("pg")\n'],
  ])('a package import (%s) is reported', (_label, text) => {
    expect(violationsOfSource(text)).toEqual(['tasks/gate20-entry.ts imports package pg'])
  })

  it.each([
    ['double quotes', 'import { query } from "../db/pg"\n', 'db/pg.ts'],
    ['single quotes', "import { query } from '../db/pg'\n", 'db/pg.ts'],
    ['require, template literal', 'const pg = require(`../db/pg`)\n', 'db/pg.ts'],
    ['dynamic import', 'export const load = () => import("../db/task-advisory-locks")\n', 'db/task-advisory-locks.ts'],
    ['the pool module', "import { poolManager } from '../integration/db/connection-pool'\n", 'integration/db/connection-pool.ts'],
    ['a pool-holding adapter', 'export { PostgresAdapter } from "../data-adapters/PostgresAdapter"\n', 'data-adapters/PostgresAdapter.ts'],
  ])('a DB-layer import (%s) is reported', (_label, text, target) => {
    expect(violationsOfSource(text)).toEqual([`tasks/gate20-entry.ts imports the DB layer: ${target}`])
  })

  it.each([
    ['a template literal with a substitution', 'const name = "pg"\nexport const load = () => import(`${name}`)\n'],
    ['a variable passed to require', 'const name = "pg"\nexport const pg = require(name)\n'],
  ])('%s is reported as non-literal', (_label, text) => {
    expect(violationsOfSource(text)).toEqual(['tasks/gate20-entry.ts has a non-literal module specifier'])
  })

  it.each([
    ['through a member call', 'export const pg = module.require("pg")\n'],
    ['through an element call', 'export const pg = globalThis["require"]("pg")\n'],
  ])('require %s of a package is reported', (_label, text) => {
    expect(violationsOfSource(text)).toEqual(['tasks/gate20-entry.ts imports package pg'])
  })

  it.each([
    ['an alias', 'const r = require\nexport const pg = r("pg")\n'],
    ['a comma callee', 'export const pg = (0, require)("pg")\n'],
    ['a shorthand property', 'export const o = { require }\n'],
    ['an alias of a member', 'export const r = module.require\n'],
  ])('require used as %s is reported', (_label, text) => {
    expect(violationsOfSource(text)).toEqual(['tasks/gate20-entry.ts uses require other than as a direct call'])
  })

  it('negative control: comments and string contents are not imports', () => {
    const text = [
      '// import { Pool } from "pg"',
      '/* const pg = require("../db/pg") */',
      "export const a = 'import { Pool } from \"pg\"'",
      'export const b = `import("pg")`',
      'export const d = { require: true }',
      'export type E = { require: boolean }',
      "import { can } from './task-access'",
      '',
    ].join('\n')
    expect(violationsOfSource(text)).toEqual([])
  })
})

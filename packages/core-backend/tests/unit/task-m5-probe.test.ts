/**
 * Task E (M5 pure layer) — the `'x'` probe, stricter than gate 20.
 *
 * Gate 20 (`task-pure-no-io.test.ts`) only asserts that no call reaches the database stub: any other
 * throw and any return value count as a pass. This file calls every function export of the task E
 * modules with the SAME placeholder rule (a parameter whose name contains query/executor/client/db
 * gets an async thrower, every other parameter gets the string `'x'`) and requires one of:
 *   - a synchronous TypeError or RangeError, or
 *   - a negative result: `false`, `null`, `undefined`, an empty array, or `{ ok: false, … }`.
 * The few exports for which `'x'` is itself a valid input are listed in `POSITIVE_ON_X` with their
 * exact expected output, so nothing slips through as "some value came back".
 *
 * A second block walks the static import graph of the same modules (D16): every file it reaches must
 * be under `src/tasks/` or on a short list of import-free helpers, and no package import (for
 * example a logger or an HTML sanitizer) may appear anywhere in that graph. Specifiers are read from
 * the TypeScript syntax tree: import / export declarations, `import x = require()`, `import()` types,
 * dynamic `import()` and `require()` calls and calls through a member named `require`, with any quote
 * style or a template literal; `require` used as a value (an alias, an argument, `{ require }`) is a
 * violation too. Not detected: module names computed at run time (`eval`, `new Function`, a property
 * name built from strings). Control cells feed the walk one in-memory source per form.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const TASK_E_MODULES = ['task-civil-date', 'task-dependencies', 'task-milestone', 'task-recurrence', 'task-fields', 'task-attachments', 'task-projection', 'task-export'] as const

/** Exports whose `'x'` call legitimately succeeds — pinned to the exact output. */
const POSITIVE_ON_X: Record<string, unknown> = {
  // A one-character file name is a valid display name.
  'task-attachments:normalizeAttachmentDisplayName': { ok: true, name: 'x' },
  // 'x' is a valid task-domain id, so ('x', 'x') is a pair the record-id parser can return.
  'task-projection:deriveTaskProjectionRecordId': 'rec_tsk_x__x',
}

const asyncThrower = async (): Promise<never> => {
  throw new Error('probe: executor-shaped parameter must not be called')
}

function placeholderArgs(fn: (...args: unknown[]) => unknown): unknown[] {
  const src = Function.prototype.toString.call(fn)
  const paramText = src.slice(src.indexOf('(') + 1, src.indexOf(')'))
  const names = paramText.split(',').map((p) => p.trim().split(/[\s=:]/)[0]).filter(Boolean)
  return names.map((name) => (/query|executor|client|db/i.test(name) ? asyncThrower : 'x'))
}

function isNegative(value: unknown): boolean {
  if (value === false || value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object' && (value as { ok?: unknown }).ok === false) return true
  return false
}

describe('task E modules — the x probe', () => {
  for (const mod of TASK_E_MODULES) {
    it(`${mod}: every function export throws TypeError/RangeError or returns a negative result on 'x'`, async () => {
      const exports = (await import(`../../src/tasks/${mod}.ts`)) as Record<string, unknown>
      const functions = Object.entries(exports).filter(([, v]) => typeof v === 'function')
      expect(functions.length).toBeGreaterThan(0)
      for (const [name, value] of functions) {
        const fn = value as (...args: unknown[]) => unknown
        const key = `${mod}:${name}`
        let threw: unknown = undefined
        let result: unknown = undefined
        try {
          result = fn(...placeholderArgs(fn))
        } catch (err) {
          threw = err
        }
        if (Object.prototype.hasOwnProperty.call(POSITIVE_ON_X, key)) {
          expect(threw, key).toBeUndefined()
          expect(result, key).toEqual(POSITIVE_ON_X[key])
          continue
        }
        if (threw !== undefined) {
          expect(threw instanceof TypeError || threw instanceof RangeError, `${key} threw ${String(threw)}`).toBe(true)
        } else {
          expect(result && typeof (result as Promise<unknown>).then === 'function', `${key} returned a promise`).toBe(false)
          expect(isNegative(result), `${key} returned ${JSON.stringify(result)}`).toBe(true)
        }
      }
    })
  }

  it('every POSITIVE_ON_X entry names a real export (no stale allowances)', async () => {
    for (const key of Object.keys(POSITIVE_ON_X)) {
      const [mod, name] = key.split(':')
      expect((TASK_E_MODULES as readonly string[]).includes(mod), key).toBe(true)
      const exports = (await import(`../../src/tasks/${mod}.ts`)) as Record<string, unknown>
      expect(typeof exports[name], key).toBe('function')
    }
  })
})

/** Files outside `src/tasks/` that the task E import graph may reach. Each must import nothing itself
 * except other entries of this list. */
const ALLOWED_OUTSIDE_TASKS = new Set([
  'utils/calendar-date.ts',
  'services/imageMagicBytes.ts',
  'services/csv-cell.ts',
  'multitable/display-name-hygiene.ts',
  // Reached through `task-dates.ts` (on main; lock §4.4 names `isValidIanaTimeZone`).
  'multitable/automation-timezone.ts',
])

const SRC_ROOT = join(__dirname, '../../src')

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

/**
 * Every module specifier of a TypeScript source, read from its syntax tree (so comments and string
 * contents never count and the quote style does not matter): `import … from` and side-effect
 * `import '…'`, `export … from`, `import x = require(…)`, `import('…')` types, and dynamic `import(…)`,
 * `require(…)` and `X.require(…)` / `X['require'](…)` calls — single-quoted, double-quoted or a
 * template literal. A specifier that is not a literal is returned as NON_LITERAL; `require` used as a
 * value instead of being called is returned as INDIRECT_REQUIRE.
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

const readSrc: SourceReader = (rel) => (existsSync(join(SRC_ROOT, rel)) ? readFileSync(join(SRC_ROOT, rel), 'utf8') : undefined)

/** `spec` relative to `from`, resolved to an existing `.ts` file (`x` → `x.ts`, `x.ts`, `x.js` → `x.ts`, `x/index.ts`). */
function resolveRelative(from: string, spec: string, read: SourceReader): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), spec))
  const candidates = [`${base}.ts`, base.endsWith('.ts') ? base : null, base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : null, `${base}/index.ts`]
  for (const candidate of candidates) {
    if (candidate !== null && read(candidate) !== undefined) return candidate
  }
  return null
}

/** Walks the relative-import graph from `entries`; returns the files reached and every rule violation. */
function walkImportGraph(entries: readonly string[], read: SourceReader = readSrc): { reached: Set<string>; violations: string[] } {
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
      if (!target.startsWith('tasks/') && !ALLOWED_OUTSIDE_TASKS.has(target)) {
        violations.push(`${rel} imports ${target}`)
        continue
      }
      queue.push(target)
    }
  }
  return { reached: seen, violations }
}

/** Walk of one in-memory entry `tasks/probe-entry.ts` with the given source (other files from src/). */
function walkSource(text: string): string[] {
  const entry = 'tasks/probe-entry.ts'
  return walkImportGraph([entry], (rel) => (rel === entry ? text : readSrc(rel))).violations
}

describe('task E modules — import graph (D16)', () => {
  it('reaches only src/tasks files and the import-free helper list; no package imports', () => {
    expect(walkImportGraph(TASK_E_MODULES.map((m) => `tasks/${m}.ts`)).violations).toEqual([])
  })

  it('positive control: the walk is transitive (it reaches helpers imported by imported modules)', () => {
    const { reached } = walkImportGraph(['tasks/task-recurrence.ts'])
    expect(reached.has('tasks/task-dates.ts')).toBe(true)
    expect(reached.has('multitable/automation-timezone.ts')).toBe(true)
    expect(reached.has('utils/calendar-date.ts')).toBe(true)
  })

  it('positive control: a module that pulls in packages is reported', () => {
    const { violations } = walkImportGraph(['multitable/field-codecs.ts'])
    expect(violations).toContain('multitable/field-codecs.ts imports package sanitize-html')
  })

  describe('controls: every specifier form is read, whatever the quotes', () => {
    it.each([
      ['static import, single quotes', "import { Pool } from 'pg'\n"],
      ['static import, double quotes', 'import { Pool } from "pg"\n'],
      ['side-effect import, double quotes', 'import "pg"\n'],
      ['namespace import', 'import * as pg from "pg"\n'],
      ['type-only import', 'import type { Pool } from "pg"\n'],
      ['re-export, double quotes', 'export { Pool } from "pg"\n'],
      ['star re-export, single quotes', "export * from 'pg'\n"],
      ['import-equals require', 'import pg = require("pg")\n'],
      ['require call, single quotes', "const pg = require('pg')\n"],
      ['require call, double quotes', 'const pg = require("pg")\n'],
      ['require call, template literal', 'const pg = require(`pg`)\n'],
      ['dynamic import, single quotes', "export async function f() { return import('pg') }\n"],
      ['dynamic import, double quotes', 'export async function f() { return import("pg") }\n'],
      ['dynamic import, template literal', 'export async function f() { return import(`pg`) }\n'],
      ['import() type', 'export type P = typeof import("pg")\n'],
      ['a call nested in an expression', 'export const pool = (0, require("pg")).Pool\n'],
    ])('%s of a package is reported', (_label, text) => {
      expect(walkSource(text)).toEqual(['tasks/probe-entry.ts imports package pg'])
    })
    it.each([
      ['double quotes', 'import * as dbPg from "../db/pg"\n'],
      ['single quotes', "import * as dbPg from '../db/pg'\n"],
      ['require, template literal', 'const dbPg = require(`../db/pg`)\n'],
      ['dynamic import', 'export const load = () => import("../db/pg")\n'],
      ['re-export', 'export { query } from "../db/pg"\n'],
    ])('a relative import outside src/tasks (%s) is reported', (_label, text) => {
      expect(walkSource(text)).toEqual(['tasks/probe-entry.ts imports db/pg.ts'])
    })
    it.each([
      ['a template literal with a substitution', 'const name = "pg"\nexport const load = () => import(`${name}`)\n'],
      ['a variable passed to require', 'const name = "pg"\nexport const pg = require(name)\n'],
    ])('%s is reported as non-literal', (_label, text) => {
      expect(walkSource(text)).toEqual(['tasks/probe-entry.ts has a non-literal module specifier'])
    })
    it.each([
      ['through a member call', 'export const pg = module.require("pg")\n'],
      ['through an element call', 'export const pg = globalThis["require"]("pg")\n'],
    ])('require %s of a package is reported', (_label, text) => {
      expect(walkSource(text)).toEqual(['tasks/probe-entry.ts imports package pg'])
    })
    it.each([
      ['an alias', 'const r = require\nexport const pg = r("pg")\n'],
      ['an argument', 'const pass = (f: unknown) => f\nexport const r = pass(require)\n'],
      ['a comma callee', 'export const pg = (0, require)("pg")\n'],
      ['a shorthand property', 'export const o = { require }\n'],
      ['an alias of a member', 'export const r = module.require\n'],
    ])('require used as %s is reported', (_label, text) => {
      expect(walkSource(text)).toEqual(['tasks/probe-entry.ts uses require other than as a direct call'])
    })
    it('a relative import that resolves nowhere is reported', () => {
      expect(walkSource('import { x } from "./no-such-module"\n')).toEqual([
        'tasks/probe-entry.ts imports ./no-such-module, which does not resolve to a .ts file',
      ])
    })
    it('negative control: comments and string contents are not imports', () => {
      const text = [
        '// import { Pool } from "pg"',
        '/* const pg = require("pg") */',
        '/**',
        ' * export * from "pg"',
        ' */',
        "export const a = 'import { Pool } from \"pg\"'",
        'export const b = "require(\'pg\')"',
        'export const c = `import("pg")`',
        'export const d = { require: true }',
        'export type E = { require: boolean }',
        'export interface F { require(): void }',
        "import { can } from './task-access'",
        '',
      ].join('\n')
      expect(walkSource(text)).toEqual([])
    })
  })
})

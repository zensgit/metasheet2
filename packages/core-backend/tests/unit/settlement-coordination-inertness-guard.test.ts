/**
 * P11-A01 production inertness, static half: in P1-1 the settlement coordination package stays out
 * of every production call path.
 *
 *  - Production files may import from the coordination modules only as `ALLOWED_IMPORTS` says, file
 *    by file and export by export.
 *  - No production file builds a coordinator, opens a coordinated transaction or runs a coordination
 *    context: the identifiers that do so (`ACTIVATION`) appear only inside the coordination modules,
 *    tests and the declaration sites listed with them.
 *  - No production call site passes the handed-over option to the runner, `dispatchAction` or
 *    `createCancelRoundInstance`: that option's identifier appears only where it is declared.
 *
 * "Production" is every source file under the walked roots except the coordination modules and
 * tests. The population is walked from disk, and the walk asserts it reached known files, so a scan
 * of the wrong tree fails instead of passing.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const ROOTS = ['packages', 'plugins', 'scripts', 'apps']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo', '.vite', '.next', 'out'])
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.cjs', '.mjs', '.vue'])
const COORDINATION_DIR = 'packages/core-backend/src/attendance/coordination/'

/** Production file → the coordination exports it may import (dormant hooks; read-only context access). */
const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  // The handed-over runner: refuses outside the context, turns 40001 / 40P01 into the restart signal.
  'packages/core-backend/src/attendance/w4c0-operation-registry.ts': ['SettlementCoordinationRestartSignalV1', 'currentSettlementCoordinationContextV1'],
  // The class-00 helper: re-entrant no-op only inside an active context whose credential covers it.
  'packages/core-backend/src/attendance/w4c0-identity.ts': ['currentSettlementCoordinationContextV1'],
}

/** Identifiers that activate the coordination path → production files allowed to declare them. */
const ACTIVATION: ReadonlyArray<Readonly<{ name: string; pattern: RegExp; declaredIn: readonly string[] }>> = [
  { name: 'createSettlementCoordinatorV1', pattern: /\bcreateSettlementCoordinatorV1\b/, declaredIn: [] },
  { name: 'new SettlementCoordinatorV1', pattern: /\bnew\s+SettlementCoordinatorV1\b/, declaredIn: [] },
  { name: 'coordinated transaction port', pattern: /\bcoordinatedTransaction\w*\b/, declaredIn: [] },
  { name: 'coordination context run', pattern: /\brunInSettlementCoordinationContextV1\b/, declaredIn: [] },
  { name: 'handed-over option', pattern: /\bsettlementCoordinationHandover\b/, declaredIn: [] },
  {
    name: 'handed-over runner',
    pattern: /\brunAttendanceResultOperationHandedOverV1\b/,
    declaredIn: ['packages/core-backend/src/attendance/w4c0-operation-registry.ts'],
  },
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

function isProduction(relative: string): boolean {
  if (relative.startsWith(COORDINATION_DIR)) return false
  if (relative.split('/').includes('__tests__')) return false
  if (relative.startsWith('packages/core-backend/tests/')) return false
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(relative)
}

/** Named imports per coordination module specifier, from `import … from '…/coordination/…'` (and `export … from`). */
function coordinationImports(text: string): Array<{ specifier: string; names: string[] }> {
  const found: Array<{ specifier: string; names: string[] }> = []
  const statement = /\b(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]*coordination\/[^'"]*)['"]/g
  for (const match of text.matchAll(statement)) {
    const clause = match[2]
    const braces = clause.match(/\{([\s\S]*)\}/)
    const names = braces
      ? braces[1].split(',').map((part) => part.replace(/\btype\s+/, '').trim().split(/\s+as\s+/)[0]).filter(Boolean)
      : [clause.trim()]
    found.push({ specifier: match[3], names })
  }
  const required = /\brequire\(\s*['"]([^'"]*coordination\/[^'"]*)['"]\s*\)/g
  for (const match of text.matchAll(required)) found.push({ specifier: match[1], names: ['<require>'] })
  const dynamic = /\bimport\(\s*['"]([^'"]*coordination\/[^'"]*)['"]\s*\)/g
  for (const match of text.matchAll(dynamic)) found.push({ specifier: match[1], names: ['<dynamic import>'] })
  return found
}

function productionFiles(): Array<{ relative: string; text: string }> {
  const files: string[] = []
  for (const root of ROOTS) walk(path.join(REPO_ROOT, root), files)
  const relative = files.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
  // The walk must cover the real tree.
  expect(relative).toContain('packages/core-backend/src/attendance/coordination/settlement-coordinator.ts')
  expect(relative).toContain('packages/core-backend/src/attendance/w4c0-operation-registry.ts')
  expect(relative).toContain('packages/core-backend/src/services/ApprovalProductService.ts')
  expect(relative).toContain('packages/core-backend/src/index.ts')
  expect(relative).toContain('plugins/plugin-attendance/index.cjs')
  expect(relative.length).toBeGreaterThan(1000)
  return relative.filter(isProduction).map((file) => ({ relative: file, text: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }))
}

describe('settlement coordination stays out of production call paths (P11-A01, static)', () => {
  const files = productionFiles()

  it('production files import coordination exports only as allowlisted', () => {
    const seen: Record<string, string[]> = {}
    for (const { relative, text } of files) {
      for (const { names } of coordinationImports(text)) (seen[relative] ??= []).push(...names)
    }
    for (const [file, names] of Object.entries(seen)) {
      const allowed = new Set(ALLOWED_IMPORTS[file] ?? [])
      expect({ file, notAllowed: names.filter((name) => !allowed.has(name)) }).toEqual({ file, notAllowed: [] })
    }
    // Every allowlisted file still imports what it is allowed to (a stale allowlist hides drift).
    for (const [file, names] of Object.entries(ALLOWED_IMPORTS)) {
      expect({ file, imports: [...new Set(seen[file] ?? [])].sort() }).toEqual({ file, imports: [...names].sort() })
    }
  })

  it('no production file builds a coordinator, opens a coordinated transaction, runs a context or passes the handed-over option', () => {
    for (const activation of ACTIVATION) {
      const hits = files.filter(({ text }) => activation.pattern.test(text)).map(({ relative }) => relative)
      expect({ activation: activation.name, hits: hits.filter((file) => !activation.declaredIn.includes(file)) }).toEqual({
        activation: activation.name,
        hits: [],
      })
    }
  })

  it('the import scanner sees named, type-only, aliased, re-exported, required and dynamic imports', () => {
    const sample = [
      "import { a, type B, c as d } from '../attendance/coordination/settlement-coordinator'",
      "import type { E } from './coordination/settlement-coordination-context'",
      "export { f } from './coordination/settlement-coordination-port'",
      "const g = require('../coordination/settlement-coordination-key')",
      "const h = await import('./coordination/settlement-coordination-clock')",
    ].join('\n')
    expect(coordinationImports(sample).flatMap((entry) => entry.names)).toEqual(['a', 'B', 'c', 'E', 'f', '<require>', '<dynamic import>'])
  })
})

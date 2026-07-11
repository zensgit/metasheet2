import { readFileSync, existsSync } from 'fs'
import path from 'path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Production-install startup contract (#3751 corrective-6, entity-machine failureClass=
// RUNTIME_DEPENDENCY_DECLARED_AS_DEV_ONLY / missingRuntimeModule=uuid).
//
// A production install (`pnpm install --prod`) skips devDependencies. Any EXTERNAL module that is
// EAGERLY imported (top-level `import … from 'x'`, non-type) somewhere in the server's startup
// import graph must therefore be declared in a PRODUCTION dependency set — otherwise the backend
// crashes on boot (uuid was declared only in core-backend devDependencies while WorkflowDesigner /
// BPMNWorkflowEngine / DelayService import it at module load).
//
// This guard BFS-walks the startup graph from `src/index.ts` using the TypeScript AST (not regex).
// For each file it collects the HARD-eager module specifiers — the ones whose absence crashes
// module evaluation under a `--prod` install:
//   - `import … from`  /  side-effect `import '…'`  /  `export … from`  (declarations)
//   - a TOP-LEVEL `require('…')` / `import('…')` NOT inside a `try` block
// and skips the non-crashing forms structurally: type-only declarations; require()/import() inside a
// function/class body (lazy); and a top-level require()/import() INSIDE a try block (the captured
// optional-dependency pattern — @opentelemetry/api, js-yaml, express-validator each `try { require }
// catch {}`). Every hard external must resolve to a prod dependency of core-backend or the workspace
// root (hoisting reality). Multi-line, default/named/namespace, and barrel re-export forms are
// handled uniformly by the AST (no line-based blind spot). A file-count floor, a multi-line-edge
// regression test, and a synthetic eager-vs-lazy classification test guard against regressions.

const CORE_BACKEND = path.resolve(__dirname, '..', '..')
const REPO_ROOT = path.resolve(CORE_BACKEND, '..', '..')
const ENTRY = path.join(CORE_BACKEND, 'src', 'index.ts')

const NODE_BUILTINS = new Set([
  'fs', 'path', 'crypto', 'os', 'http', 'https', 'stream', 'util', 'events', 'url', 'zlib',
  'child_process', 'net', 'tls', 'dns', 'buffer', 'querystring', 'assert', 'worker_threads',
  'perf_hooks', 'timers', 'string_decoder', 'readline', 'cluster', 'v8', 'vm', 'module', 'process',
  'async_hooks', 'http2', 'dgram', 'tty', 'constants', 'punycode', 'fs/promises',
  'stream/promises', 'timers/promises', 'crypto/promises',
])

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function prodDependencyNames(): Set<string> {
  const cb = readJson(path.join(CORE_BACKEND, 'package.json'))
  const root = readJson(path.join(REPO_ROOT, 'package.json'))
  const names = new Set<string>()
  for (const pkg of [cb, root]) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys((pkg[field] as Record<string, string>) ?? {})) names.add(name)
    }
  }
  return names
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cts', '/index.ts', '/index.js']) {
    if (existsSync(base + ext)) return base + ext
  }
  if (existsSync(base) && /\.(ts|tsx|js|mjs|cts)$/.test(base)) return base
  return null
}

function rootModule(spec: string): string {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}

// The HARD-eager module specifiers of a file — the ones whose absence crashes module evaluation:
//   - `import … from '…'`   ImportDeclaration (default / named / namespace / side-effect)
//   - `export … from '…'`   ExportDeclaration with a moduleSpecifier (barrel re-export)
//   - a TOP-LEVEL `require('…')` / `import('…')` call NOT inside a try block — executed at module
//     load, unguarded, so a missing module throws and the backend fails to boot.
// Skipped (not hard): type-only forms; require()/import() inside a function/class body (lazy); a
// top-level require()/import() INSIDE a try block (the "captured optional dependency" pattern — the
// catch tolerates absence, e.g. @opentelemetry/api, js-yaml, express-validator). These distinctions
// are read structurally from the AST (function boundaries, try blocks), not by heuristic.
function isFunctionLikeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function dynamicRequireSpecifier(node: ts.Node): string | null {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return null
  const callee = node.expression
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
  const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
  if (!isRequire && !isDynamicImport) return null
  const arg = node.arguments[0]
  return ts.isStringLiteral(arg) ? arg.text : null
}

function hardSpecifiersOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const specs: string[] = []

  // Top-level executable walk: descend through control flow, STOP at function/class boundaries
  // (lazy), and treat requires inside a `try` block as captured-optional (skipped).
  const walkTopLevel = (node: ts.Node, inTry: boolean): void => {
    if (isFunctionLikeBoundary(node)) return
    if (ts.isTryStatement(node)) {
      // The try/catch/finally bodies are all the optional context — a require anywhere in them is
      // gracefully guarded. (Anything in the enclosing scope stays hard.)
      node.forEachChild((child) => walkTopLevel(child, true))
      return
    }
    const spec = dynamicRequireSpecifier(node)
    if (spec !== null && !inTry) specs.push(spec)
    node.forEachChild((child) => walkTopLevel(child, inTry))
  }

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (stmt.importClause?.isTypeOnly) continue // `import type …`
      if (ts.isStringLiteral(stmt.moduleSpecifier)) specs.push(stmt.moduleSpecifier.text)
      continue
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue // `export type … from …`
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        specs.push(stmt.moduleSpecifier.text)
      }
      continue
    }
    walkTopLevel(stmt, false)
  }
  return specs
}

// BFS the eager startup import graph; return external top-level modules mapped to an example file,
// plus the full set of visited (resolved) files.
function walkStartupGraph(): {
  externals: Map<string, string>
  visited: Set<string>
} {
  const visited = new Set<string>()
  const externals = new Map<string, string>()
  const queue: string[] = [ENTRY]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (visited.has(file) || !existsSync(file)) continue
    visited.add(file)
    for (const spec of hardSpecifiersOf(file)) {
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec)
        if (resolved) queue.push(resolved)
        continue
      }
      if (spec.startsWith('node:')) continue
      const mod = rootModule(spec)
      if (NODE_BUILTINS.has(mod)) continue
      if (!externals.has(mod)) externals.set(mod, path.relative(CORE_BACKEND, file))
    }
  }
  return { externals, visited }
}

describe('runtime dependency classification (production-install startup contract)', () => {
  it('every eagerly-imported external module in the startup graph is a production dependency', () => {
    const prod = prodDependencyNames()
    const { externals, visited } = walkStartupGraph()
    // Guard against silent coverage collapse: the eager startup graph is a few hundred files; if a
    // parser/traversal regression makes the walk visit almost nothing the "0 missing" is meaningless.
    expect(visited.size).toBeGreaterThan(150)
    const missing = [...externals.entries()]
      .filter(([mod]) => !prod.has(mod))
      .map(([mod, file]) => `${mod} (eager import e.g. ${file})`)
    expect(
      missing,
      `these modules are imported at startup but are not production dependencies — a --prod install ` +
        `would omit them and crash the backend on boot:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('traverses modules reachable only through a MULTI-LINE import edge (regression: #4126)', () => {
    // src/index.ts:19 imports ./core/workday-calendar-port via a multi-line `import { … } from`.
    // A line-based matcher missed multi-line edges, so a dev-only import hidden behind one passed
    // silently. The AST walk must visit this target — proving multi-line edges are followed.
    const { visited } = walkStartupGraph()
    const target = resolveRelative(ENTRY, './core/workday-calendar-port')
    expect(target, 'the multi-line-imported target must resolve').toBeTruthy()
    expect(
      visited.has(target as string),
      'a module reachable only via a multi-line import edge must be traversed',
    ).toBe(true)
  })

  it('classifies eager vs lazy specifiers structurally (#4126 review: top-level require/import gap)', () => {
    const os = require('os') as typeof import('os')
    const fs = require('fs') as typeof import('fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metasheet2-hardspec-'))
    const file = path.join(dir, 'sample.ts')
    fs.writeFileSync(
      file,
      [
        `import staticDefault from 'eager-static'`,
        `import type { T } from 'type-only-erased'`,
        `export { x } from 'eager-reexport'`,
        `const a = require('eager-toplevel-require')`,
        `void import('eager-toplevel-import')`,
        `let opt; try { opt = require('optional-in-try') } catch { opt = null }`,
        `function later() { const b = require('lazy-in-function'); return b }`,
        `class C { m() { return require('lazy-in-method') } }`,
      ].join('\n'),
    )
    const specs = hardSpecifiersOf(file)
    expect(specs.sort()).toEqual(
      ['eager-static', 'eager-reexport', 'eager-toplevel-require', 'eager-toplevel-import'].sort(),
    )
    // Explicitly: the type-only, try-captured, and in-function forms are NOT hard.
    for (const notHard of ['type-only-erased', 'optional-in-try', 'lazy-in-function', 'lazy-in-method']) {
      expect(specs).not.toContain(notHard)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('uuid specifically is a production dependency (corrective-6 regression lock)', () => {
    const cb = readJson(path.join(CORE_BACKEND, 'package.json'))
    const deps = (cb.dependencies as Record<string, string>) ?? {}
    const dev = (cb.devDependencies as Record<string, string>) ?? {}
    expect(deps.uuid, 'uuid must be a runtime dependency').toBeTruthy()
    expect(dev.uuid, 'uuid must not remain in devDependencies').toBeUndefined()
  })
})

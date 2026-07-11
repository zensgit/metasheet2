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
// and skips only the genuinely non-eager forms: type-only declarations, and require()/import()
// inside a function/class body (lazy). A top-level require()/import() in ANY position — including
// inside try / catch / finally — is treated as hard, because only a `try { require } catch` that
// actually SWALLOWS the missing-module error is safe, and that judgement is fragile to reason about
// structurally (try-finally with no catch propagates; a require in catch/finally is unguarded; a
// rethrowing catch does not swallow). The intentionally-optional soft dependencies are therefore
// exempted by the explicit, auditable OPTIONAL_SOFT_DEPENDENCIES allowlist at the check site, whose
// entries are asserted to stay live-and-non-prod. Every other hard external must resolve to a prod
// dependency of core-backend or the workspace root (hoisting reality). Multi-line, default/named/
// namespace, and barrel re-export forms are handled uniformly by the AST (no line-based blind spot).
// A file-count floor, a multi-line-edge regression test, a synthetic classification test covering
// every try/catch/finally shape, and an allowlist-hygiene test guard against regressions.

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

// Explicit allowlist of intentionally-OPTIONAL soft dependencies: modules a startup file requires at
// module load INSIDE a try/catch that swallows the missing-module error and degrades gracefully, so
// their absence under a --prod install does NOT crash the backend. Each entry below was verified to
// be a `try { require(x) } catch { …fallback… }` (never rethrown) with a functioning degraded path.
// Adding a new optional soft dependency is a deliberate, auditable edit here — anything NOT declared
// prod and NOT on this list is treated as a hard eager dependency and fails the guard.
const OPTIONAL_SOFT_DEPENDENCIES = new Set([
  '@opentelemetry/api', // src/core/logger.ts — try{require}catch{otelApi=null}; trace-id enrichment off
  'js-yaml', // src/services/ConfigService.ts — try{require}catch{}; JSON-only config fallback
  'express-validator', // src/middleware/validation.ts — try{require}catch{}; validation skipped
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

  // Top-level executable walk: descend through ALL control flow — including try / catch / finally —
  // and STOP only at function/class boundaries (those bodies are lazy). Every top-level
  // require('…') / import('…') is collected as hard, regardless of try structure. We deliberately do
  // NOT try to reason about whether a surrounding try/catch "swallows" a missing-module error:
  //   - `try { require(x) } finally {}`   — no catch → the error propagates (crash)
  //   - `try {} catch { require(x) }`      — the require is in the handler, not guarded
  //   - `try { require(x) } catch (e) { throw e }` — catch rethrows → not swallowed
  // are all real boot crashes, so require() anywhere at top level is hard. The intentionally-optional
  // soft dependencies are exempted by the explicit OPTIONAL_SOFT_DEPENDENCIES allowlist at the check
  // site, not by a fragile try-shape heuristic here.
  const walkTopLevel = (node: ts.Node): void => {
    if (isFunctionLikeBoundary(node)) return
    const spec = dynamicRequireSpecifier(node)
    if (spec !== null) specs.push(spec)
    node.forEachChild(walkTopLevel)
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
    walkTopLevel(stmt)
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
      .filter(([mod]) => !prod.has(mod) && !OPTIONAL_SOFT_DEPENDENCIES.has(mod))
      .map(([mod, file]) => `${mod} (eager import e.g. ${file})`)
    expect(
      missing,
      `these modules are imported at startup but are neither a production dependency nor an ` +
        `allowlisted optional soft dependency — a --prod install would omit them and crash the ` +
        `backend on boot:\n  ${missing.join('\n  ')}`,
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

  it('classifies eager vs lazy specifiers structurally, incl. every try/catch/finally shape (#4126 review)', () => {
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
        // ── every top-level require is HARD regardless of try shape (only a swallowing catch would
        //    make it optional, and that judgement is delegated to the explicit allowlist, not here) ──
        `try { require('hard-try-finally') } finally { /* no catch → propagates */ }`,
        `try { /* body */ } catch { require('hard-in-catch') }`,
        `try { /* body */ } finally { require('hard-in-finally') }`,
        `try { require('hard-rethrow') } catch (e) { throw e }`,
        `try { require('hard-try-catch-swallow') } catch { /* swallow */ }`,
        // ── lazy: inside function / method bodies (never eager) ──
        `function later() { const b = require('lazy-in-function'); return b }`,
        `class C { m() { return require('lazy-in-method') } }`,
      ].join('\n'),
    )
    const specs = hardSpecifiersOf(file)
    expect(specs.sort()).toEqual(
      [
        'eager-static',
        'eager-reexport',
        'eager-toplevel-require',
        'eager-toplevel-import',
        'hard-try-finally',
        'hard-in-catch',
        'hard-in-finally',
        'hard-rethrow',
        'hard-try-catch-swallow',
      ].sort(),
    )
    // The type-only and in-function/method forms are the only NON-hard specifiers.
    for (const notHard of ['type-only-erased', 'lazy-in-function', 'lazy-in-method']) {
      expect(specs).not.toContain(notHard)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the optional-soft-dependency allowlist is not stale — every entry is still a startup require and not a prod dep', () => {
    const prod = prodDependencyNames()
    const { externals } = walkStartupGraph()
    for (const soft of OPTIONAL_SOFT_DEPENDENCIES) {
      expect(
        externals.has(soft),
        `${soft} is allowlisted as optional but is no longer eagerly required in the startup graph — remove the stale entry`,
      ).toBe(true)
      expect(
        prod.has(soft),
        `${soft} is now a production dependency — drop it from the optional allowlist so a real regression can be seen`,
      ).toBe(false)
    }
  })

  it('uuid specifically is a production dependency (corrective-6 regression lock)', () => {
    const cb = readJson(path.join(CORE_BACKEND, 'package.json'))
    const deps = (cb.dependencies as Record<string, string>) ?? {}
    const dev = (cb.devDependencies as Record<string, string>) ?? {}
    expect(deps.uuid, 'uuid must be a runtime dependency').toBeTruthy()
    expect(dev.uuid, 'uuid must not remain in devDependencies').toBeUndefined()
  })
})

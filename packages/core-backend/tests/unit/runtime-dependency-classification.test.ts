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
//   - every TOP-LEVEL `require('…')` / `import('…')`, including calls inside `try`
// and skips only the genuinely non-eager forms: type-only declarations, and require()/import()
// inside a function/class body (lazy). A top-level require()/import() in ANY position — including
// inside try / catch / finally — is treated as hard, because only a `try { require } catch` that
// actually SWALLOWS the missing-module error is safe, and that judgement is fragile to reason about
// structurally (try-finally with no catch propagates; a require in catch/finally is unguarded; a
// rethrowing catch does not swallow). The intentionally-optional soft dependencies are therefore
// exempted by the explicit, auditable OPTIONAL_SOFT_DEPENDENCIES allowlist at the check site, whose
// entries are asserted to stay live-and-non-prod, occur exactly once, and remain protected by a
// swallowing top-level try/catch. Every other hard external must resolve to a prod dependency of
// core-backend or the workspace root (hoisting reality). Multi-line, default/named/namespace, and
// barrel re-export forms are handled uniformly by the AST (no line-based blind spot). A file-count
// floor, multi-line-edge regression, synthetic eager/lazy classification, guarded-loader shape
// matrix, and allowlist-hygiene test guard against regressions.

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

// Explicit, OCCURRENCE-PRECISE allowlist of intentionally-OPTIONAL soft dependencies (#4126 review):
// a module-name-only allowlist would mask a NEW hard import of the same module elsewhere (an
// unguarded `import 'js-yaml'` in another startup file would sail through). So each exemption pins
// the module to its exact source file AND requires the total occurrence count across the startup
// graph to match — any additional site, or a change of site, fails the guard.
//
// Each entry is a verified `try { require(x) } catch { …working degraded path… }` (never rethrown)
// whose absence does NOT crash the backend and does NOT disable a security control.
// (express-validator was previously listed here and is NOT eligible: request validation is a
// security control that fail-OPENed when the module was absent — it is now a declared production
// dependency loaded fail-closed.)
interface SoftDependencyExemption {
  module: string
  file: string // repo-relative to packages/core-backend
  reason: string
}
const OPTIONAL_SOFT_DEPENDENCIES: SoftDependencyExemption[] = [
  {
    module: '@opentelemetry/api',
    file: 'src/core/logger.ts',
    reason: 'try{require}catch{otelApi=null} — trace-id enrichment degrades off; no security control',
  },
  {
    module: 'js-yaml',
    file: 'src/services/ConfigService.ts',
    reason: 'try{require}catch{} — JSON-only config fallback; no security control',
  },
]
const SOFT_EXEMPTION_KEY = (module: string, file: string): string => `${module}@@${file}`
const SOFT_EXEMPTION_KEYS = new Set(
  OPTIONAL_SOFT_DEPENDENCIES.map((entry) => SOFT_EXEMPTION_KEY(entry.module, entry.file)),
)

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
//   - every TOP-LEVEL `require('…')` / `import('…')` call — including calls inside try/catch/finally.
// Skipped (not hard): type-only forms and require()/import() inside a function/class body (lazy).
// Intentionally optional top-level loaders are still collected here, then exempted only when their
// exact allowlisted occurrence retains a structurally verified swallowing try/catch.
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

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

function isLiteralFallback(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  )
}

function isSafeFallbackCatch(block: ts.Block): boolean {
  return block.statements.every((statement) => {
    if (ts.isEmptyStatement(statement)) return true
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
      return false
    }
    const assignment = statement.expression
    return (
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(assignment.left) &&
      isLiteralFallback(assignment.right)
    )
  })
}

function isProtectedBySwallowingTry(call: ts.CallExpression): boolean {
  let current: ts.Node | undefined = call.parent
  while (current) {
    if (isFunctionLikeBoundary(current)) return false
    if (
      ts.isTryStatement(current) &&
      isDescendantOf(call, current.tryBlock) &&
      current.catchClause &&
      isSafeFallbackCatch(current.catchClause.block) &&
      (!current.finallyBlock || current.finallyBlock.statements.length === 0)
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

function inspectOptionalLoader(file: string, module: string): {
  topLevelCalls: number
  guardedCalls: number
} {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const calls: ts.CallExpression[] = []
  const walkTopLevel = (node: ts.Node): void => {
    if (isFunctionLikeBoundary(node)) return
    const spec = dynamicRequireSpecifier(node)
    if (spec !== null && rootModule(spec) === module && ts.isCallExpression(node)) calls.push(node)
    node.forEachChild(walkTopLevel)
  }
  for (const stmt of source.statements) walkTopLevel(stmt)
  return {
    topLevelCalls: calls.length,
    guardedCalls: calls.filter(isProtectedBySwallowingTry).length,
  }
}

// One eager external import occurrence. EVERY occurrence is recorded (#4126 review: deduplicating
// by module+file let an exemption mask a second, unguarded import in the same file).
interface EagerOccurrence {
  module: string
  file: string // repo-relative to packages/core-backend
}

// BFS the eager startup import graph; return every eager external occurrence plus the visited files.
function walkStartupGraph(): {
  occurrences: EagerOccurrence[]
  visited: Set<string>
} {
  const visited = new Set<string>()
  const occurrences: EagerOccurrence[] = []
  const queue: string[] = [ENTRY]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (visited.has(file) || !existsSync(file)) continue
    visited.add(file)
    const relFile = path.relative(CORE_BACKEND, file)
    for (const spec of hardSpecifiersOf(file)) {
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec)
        if (resolved) queue.push(resolved)
        continue
      }
      if (spec.startsWith('node:')) continue
      const mod = rootModule(spec)
      if (NODE_BUILTINS.has(mod)) continue
      occurrences.push({ module: mod, file: relFile })
    }
  }
  return { occurrences, visited }
}

describe('runtime dependency classification (production-install startup contract)', () => {
  it('every eager external import site in the startup graph is a production dependency', () => {
    const prod = prodDependencyNames()
    const { occurrences, visited } = walkStartupGraph()
    // Guard against silent coverage collapse: the eager startup graph is a few hundred files; if a
    // parser/traversal regression makes the walk visit almost nothing the "0 missing" is meaningless.
    expect(visited.size).toBeGreaterThan(150)
    // Checked PER OCCURRENCE (module + source file), not per module name: a soft-dependency
    // exemption is bound to its exact site, so an unguarded import of the SAME module in another
    // startup file is still a hard dependency and still fails.
    const missing = occurrences
      .filter(
        ({ module, file }) =>
          !prod.has(module) && !SOFT_EXEMPTION_KEYS.has(SOFT_EXEMPTION_KEY(module, file)),
      )
      .map(({ module, file }) => `${module} (eager import at ${file})`)
    expect(
      missing,
      `these import sites are eager at startup but are neither a production dependency nor an ` +
        `allowlisted optional soft-dependency SITE — a --prod install would omit them and crash the ` +
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

  it('only exempts one top-level loader protected by a swallowing try/catch', () => {
    const os = require('os') as typeof import('os')
    const fs = require('fs') as typeof import('fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metasheet2-soft-loader-'))
    const file = path.join(dir, 'sample.ts')
    const inspect = (source: string) => {
      fs.writeFileSync(file, source)
      return inspectOptionalLoader(file, 'optional-soft')
    }

    expect(inspect(`try { require('optional-soft') } catch { /* degrade */ }`)).toEqual({
      topLevelCalls: 1,
      guardedCalls: 1,
    })
    expect(inspect(`let fallback\ntry { require('optional-soft') } catch { fallback = null }`)).toEqual({
      topLevelCalls: 1,
      guardedCalls: 1,
    })
    expect(inspect(`require('optional-soft')`)).toEqual({ topLevelCalls: 1, guardedCalls: 0 })
    expect(inspect(`try { require('optional-soft') } finally { /* propagates */ }`)).toEqual({
      topLevelCalls: 1,
      guardedCalls: 0,
    })
    expect(inspect(`try {} catch { require('optional-soft') }`)).toEqual({
      topLevelCalls: 1,
      guardedCalls: 0,
    })
    expect(inspect(`try { require('optional-soft') } catch (error) { throw error }`)).toEqual({
      topLevelCalls: 1,
      guardedCalls: 0,
    })
    expect(inspect(`try { require('optional-soft') } catch { process.exit(1) }`)).toEqual({
      topLevelCalls: 1,
      guardedCalls: 0,
    })
    expect(inspect(`try { require('optional-soft') } catch {} finally { cleanup() }`)).toEqual({
      topLevelCalls: 1,
      guardedCalls: 0,
    })
    expect(
      inspect(`try { require('optional-soft') } catch {}\nrequire('optional-soft')`),
    ).toEqual({ topLevelCalls: 2, guardedCalls: 1 })
    expect(inspect(`function later() { require('optional-soft') }`)).toEqual({
      topLevelCalls: 0,
      guardedCalls: 0,
    })

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the soft-dependency exemptions are exact, guarded, live, non-prod, and occurrence-count-locked', () => {
    const prod = prodDependencyNames()
    const { occurrences } = walkStartupGraph()
    for (const entry of OPTIONAL_SOFT_DEPENDENCIES) {
      const sites = occurrences.filter((o) => o.module === entry.module)
      // Live: the exempted site still exists.
      expect(
        sites.some((o) => o.file === entry.file),
        `${entry.module} is exempted at ${entry.file} but is no longer eagerly required there — fix or remove the stale exemption`,
      ).toBe(true)
      // Occurrence-count lock (#4126 review): the module must be eagerly imported at EXACTLY the
      // exempted site and nowhere else. A new unguarded import of the same module in another startup
      // file adds an occurrence and fails here (and in the main check, which is site-keyed).
      expect(
        sites.map((o) => o.file).sort(),
        `${entry.module} has extra eager occurrences — an exemption must not cover a new hard import ` +
          `in the same file or elsewhere. Sites: ${sites.map((o) => o.file).join(', ')}`,
      ).toEqual([entry.file])
      // Shape lock: the sole occurrence must remain inside the try block of a swallowing catch.
      // Moving it outside the try, into catch/finally, or adding a second call fails closed.
      expect(
        inspectOptionalLoader(path.join(CORE_BACKEND, entry.file), entry.module),
        `${entry.module} at ${entry.file} is exempt only while exactly one top-level loader is ` +
          `protected by a swallowing try/catch`,
      ).toEqual({ topLevelCalls: 1, guardedCalls: 1 })
      // Not a prod dep — otherwise the exemption hides a real classification.
      expect(
        prod.has(entry.module),
        `${entry.module} is now a production dependency — drop the exemption so a real regression can be seen`,
      ).toBe(false)
    }
  })

  it('express-validator is a production dependency and its loaders are fail-closed (#4126 review security fix)', () => {
    const cb = readJson(path.join(CORE_BACKEND, 'package.json'))
    const deps = (cb.dependencies as Record<string, string>) ?? {}
    expect(
      deps['express-validator'],
      'express-validator backs declarative request validation (a security control) and must be a production dependency, never an optional soft dependency',
    ).toBeTruthy()
    expect(
      OPTIONAL_SOFT_DEPENDENCIES.some((entry) => entry.module === 'express-validator'),
      'express-validator must not be allowlisted as an optional soft dependency — its absence fail-OPENed validation',
    ).toBe(false)
    // The loaders must throw (fail-closed), never fall back to no-op validators / next().
    const loaderSources = [
      readFileSync(path.join(CORE_BACKEND, 'src/types/validator.ts'), 'utf8'),
      readFileSync(path.join(CORE_BACKEND, 'src/middleware/validation.ts'), 'utf8'),
    ]
    for (const source of loaderSources) {
      expect(source).toMatch(/throw new Error\(/)
      expect(source).not.toMatch(/validation will be skipped|skip validation|use no-op validators/)
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

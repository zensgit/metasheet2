import { readFileSync, existsSync } from 'fs'
import path from 'path'
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
// This guard statically BFS-walks the startup graph from `src/index.ts`, following every STATIC
// edge — `import … from`, side-effect `import '…'`, and `export … from` barrel re-exports, each
// single- or multi-line, with comments stripped — and asserts every external eager import resolves
// to a prod dependency of either core-backend or the workspace root (hoisting reality). Lazy
// `require()` / `await import()` inside functions (the optional adapters: mongodb, aws-sdk,
// @opentelemetry, …) are NOT eager, are NOT in the graph, and are correctly not flagged — so the
// check is precise, not a blanket sweep. A file-count floor guards against a parser regression
// silently shrinking the walk.

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

// Strip block + line comments so commented-out imports never match. (String literals containing
// import-like text are vanishingly rare for module specifiers and not a real false-source here.)
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// Every static module specifier that makes a file part of the EAGER graph:
//   - `import … from '…'`      (default / named / namespace, single- or multi-line)
//   - `import '…'`             (side-effect)
//   - `export … from '…'`      (barrel re-export — pulls the target in at load)
// excluding the type-only forms (`import type …` / `export type …`, erased at compile time) and the
// lazy forms (`import('…')` / `require('…')` — those live inside functions and are NOT eager).
function* staticSpecifiers(source: string): Generator<string> {
  const clean = stripComments(source)
  // `s` flag: the clause may span newlines (multi-line import/export blocks).
  const importFrom = /\bimport\s+(?!type[\s{])[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gs
  const exportFrom = /\bexport\s+(?!type[\s{])[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gs
  const sideEffect = /\bimport\s+['"]([^'"]+)['"]/g
  for (const re of [importFrom, exportFrom, sideEffect]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(clean)) !== null) yield m[1]
  }
}

// BFS the eager startup import graph; return external top-level modules mapped to an example file.
function collectStartupExternals(): { externals: Map<string, string>; filesVisited: number } {
  const seen = new Set<string>()
  const externals = new Map<string, string>()
  const queue: string[] = [ENTRY]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
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
  return { externals, filesVisited: seen.size }
}

describe('runtime dependency classification (production-install startup contract)', () => {
  it('every eagerly-imported external module in the startup graph is a production dependency', () => {
    const prod = prodDependencyNames()
    const { externals, filesVisited } = collectStartupExternals()
    // Guard against silent coverage collapse: the eager startup graph is a few hundred files; if a
    // parser regression makes the walk visit almost nothing the "0 missing" result is meaningless.
    expect(filesVisited).toBeGreaterThan(150)
    const missing = [...externals.entries()]
      .filter(([mod]) => !prod.has(mod))
      .map(([mod, file]) => `${mod} (eager import e.g. ${file})`)
    expect(
      missing,
      `these modules are imported at startup but are not production dependencies — a --prod install ` +
        `would omit them and crash the backend on boot:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('uuid specifically is a production dependency (corrective-6 regression lock)', () => {
    const cb = readJson(path.join(CORE_BACKEND, 'package.json'))
    const deps = (cb.dependencies as Record<string, string>) ?? {}
    const dev = (cb.devDependencies as Record<string, string>) ?? {}
    expect(deps.uuid, 'uuid must be a runtime dependency').toBeTruthy()
    expect(dev.uuid, 'uuid must not remain in devDependencies').toBeUndefined()
  })
})

/** Static module loads only: aliases of require, generated code, Worker/vm and call-level wiring remain outside this graph. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { moduleLoads, NON_LITERAL_SPECIFIER, SOURCE_EXTENSIONS, type ModuleLoad } from './import-edge-allowlist'

export interface ModuleEdge extends ModuleLoad { from: string; to: string }
export interface GraphGap { from: string; specifier: string; kind: string; typeOnly: boolean; sourceHash: string }
export interface ModuleGraph {
  files: string[]
  edges: ModuleEdge[]
  gaps: GraphGap[]
  testEdges: ModuleEdge[]
  requestRoots: string[]
  resolutionInputs: Array<{ path: string; sha256: string }>
}
export const SOURCE_ROOT = 'packages/core-backend/src/'
export const GRAPH_ROOTS = ['packages/core-backend/src', 'packages/core-backend/scripts', 'scripts', 'plugins']
const TEST_FILE = /(?:^|\/)(?:__tests__|tests|test)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/
const sourceFile = (file: string): boolean => SOURCE_EXTENSIONS.includes(path.extname(file)) || file.endsWith('.vue')
const read = (file: string): string => readFileSync(file, 'utf8')
const sha = (source: string): string => createHash('sha256').update(source).digest('hex')
const sorted = <T>(items: T[]): T[] => items.map((item) => ({ item, key: JSON.stringify(item) }))
  .sort((a, b) => a.key.localeCompare(b.key)).map(({ item }) => item)

export function graphFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap((entry) => {
    if (['node_modules', '.git'].includes(entry.name)) return []
    const full = path.join(root, entry.name)
    return (entry.isSymbolicLink() ? statSync(full).isDirectory() : entry.isDirectory()) ? graphFiles(full) : [full]
  })
}

function candidates(base: string): string[] {
  const ext = path.extname(base)
  const replacements: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }
  return [...(replacements[ext] ?? []).map((next) => base.slice(0, -ext.length) + next), base,
    ...(!ext ? SOURCE_EXTENSIONS.map((next) => base + next) : []),
    ...SOURCE_EXTENSIONS.map((next) => path.join(base, 'index' + next))]
}

/** Scans all production roots without token filtering, then follows every resolvable internal dependency, including test helpers. */
export function collectModuleGraph(root: string): ModuleGraph {
  return createModuleGraphCollector(root)()
}

/** One file-scoped disk snapshot; mutations re-resolve the full graph with in-memory source/metadata overrides. */
export function createModuleGraphCollector(root: string): (overrides?: ReadonlyMap<string, string>) => ModuleGraph {
  const initial = GRAPH_ROOTS.flatMap((dir) => graphFiles(path.join(root, dir)))
  const metadata = [...initial, ...['packages', 'plugins'].flatMap((dir) => {
    const full = path.join(root, dir)
    return existsSync(full) ? readdirSync(full).flatMap((name) => ['package.json', 'tsconfig.json'].map((file) => path.join(full, name, file))) : []
  }), path.join(root, 'tsconfig.json')]
  const sources = new Map<string, string>(), files = new Map<string, boolean>()
  const candidateCache = new Map<string, string[]>()
  const resolveCandidates = (base: string): string[] => {
    if (!candidateCache.has(base)) candidateCache.set(base, candidates(base))
    return candidateCache.get(base)!
  }
  const parsedFiles = new Map<string, { original: string; source: string; sourceHash: string; loads: ModuleLoad[]; diagnostics: string[] }>()
  return (overrides = new Map()) => {
    const overlay = new Map([...overrides].map(([file, source]) => [path.join(root, file), source]))
    const isFile = (file: string): boolean => {
      if (overlay.has(file)) return true
      if (!files.has(file)) files.set(file, existsSync(file) && statSync(file).isFile())
      return files.get(file)!
    }
    const readSource = (file: string): string => {
      const override = overlay.get(file)
      if (override !== undefined) return override
      if (!sources.has(file)) sources.set(file, read(file))
      return sources.get(file)!
    }
    const added = [...overrides.keys()].filter((file) => GRAPH_ROOTS.some((dir) => file.startsWith(dir + '/'))).map((file) => path.join(root, file))
    const resolutionInputs = new Map<string, string>()
    const readResolutionInput = (file: string): string => {
      const source = readSource(file)
      resolutionInputs.set(path.relative(root, file), sha(source))
      return source
    }
    const configCache = new Map<string, { base: string; paths: Record<string, string[]> }>()
    function configOptions(file: string): { base: string; paths: Record<string, string[]> } {
      const cached = configCache.get(file)
      if (cached) return cached
      const parsed = ts.parseConfigFileTextToJson(file, readResolutionInput(file))
      if (parsed.error) throw new Error(`Invalid module-resolution configuration: ${path.relative(root, file)}`)
      const data = parsed.config
      let inherited = { base: path.dirname(file), paths: {} as Record<string, string[]> }
      if (data.extends) {
        if (typeof data.extends !== 'string' || !data.extends.startsWith('.')) throw new Error(`Unreviewed configuration inheritance: ${path.relative(root, file)}`)
        let baseFile = path.resolve(path.dirname(file), data.extends)
        if (!path.extname(baseFile)) baseFile += '.json'
        inherited = configOptions(baseFile)
      }
      const own = data.compilerOptions ?? {}
      const resolved = { base: own.baseUrl ? path.resolve(path.dirname(file), own.baseUrl) : inherited.base, paths: own.paths ?? inherited.paths }
      configCache.set(file, resolved)
      return resolved
    }
    const packages: Array<{ dir: string; name: string; main?: string; source?: string }> = []
    const aliases: Array<{ scope: string; base: string; key: string; targets: string[] }> = []
    for (const file of new Set([...metadata, ...added])) {
      if (!isFile(file)) continue
      if (path.basename(file) === 'package.json') {
        const data = JSON.parse(readResolutionInput(file))
        if (data.name) packages.push({ dir: path.dirname(file), ...data })
      } else if (path.basename(file) === 'tsconfig.json') {
        const options = configOptions(file)
        for (const [key, targets] of Object.entries(options.paths)) {
          aliases.push({ scope: path.dirname(file), base: options.base, key, targets })
        }
      }
    }
    const queue = [...initial, ...added].filter((file) => sourceFile(file) && !TEST_FILE.test(path.relative(root, file)))
    const visited = new Set<string>()
    const edges: ModuleEdge[] = [], gaps: GraphGap[] = [], requestRoots: string[] = []
    const nonRouteRoots = ['services/elearning-pilot-runtime.ts', 'services/approval-attachment-runtime.ts',
      'services/elearning-media-runtime.ts', 'gateway/APIGateway.ts'].map((file) => SOURCE_ROOT + file)
    for (let index = 0; index < queue.length; index++) {
      const file = queue[index]
      if (visited.has(file)) continue
      visited.add(file)
      const from = path.relative(root, file), original = readSource(file)
      let facts = parsedFiles.get(file)
      if (!facts || facts.original !== original) {
        const source = file.endsWith('.vue') ? [...original.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n') : original
        // Diagnostics and load discovery only traverse children; no parent-pointer pass is needed.
        const parsed = ts.createSourceFile(file.endsWith('.vue') ? file + '.ts' : file, source, ts.ScriptTarget.Latest, false)
        facts = { original, source, sourceHash: sha(original), loads: moduleLoads(parsed),
          diagnostics: (parsed as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.map((diagnostic) =>
            String(diagnostic.code) + ': ' + ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')) }
        parsedFiles.set(file, facts)
      }
      const { source, sourceHash, loads, diagnostics } = facts
      if (!TEST_FILE.test(from) && (from.startsWith(SOURCE_ROOT + 'routes/') || nonRouteRoots.includes(from)
        || (from !== SOURCE_ROOT + 'index.ts' && /\baddRoute\s*\(/.test(source)))) requestRoots.push(from)
      for (const specifier of diagnostics) {
        gaps.push({ from, specifier, kind: 'parse', typeOnly: false, sourceHash })
      }
      for (const load of loads) {
        if (load.specifier === NON_LITERAL_SPECIFIER) { gaps.push({ from, ...load, sourceHash }); continue }
        const bases: string[] = []
        if (load.specifier.startsWith('.')) bases.push(path.resolve(path.dirname(file), load.specifier))
        else {
          for (const alias of aliases) {
            if (!file.startsWith(alias.scope + path.sep)) continue
            const [prefix, suffix = ''] = alias.key.split('*')
            if (alias.key.includes('*') ? load.specifier.startsWith(prefix) && load.specifier.endsWith(suffix) : load.specifier === alias.key) {
              const middle = alias.key.includes('*') ? load.specifier.slice(prefix.length, suffix ? -suffix.length : undefined) : ''
              bases.push(...alias.targets.map((target) => path.resolve(alias.base, target.replace('*', middle))))
            }
          }
          for (const pkg of packages) {
            if (load.specifier === pkg.name) {
              const sourceEntry = path.join(pkg.dir, 'src/index.ts')
              bases.push(load.typeOnly && isFile(sourceEntry) ? sourceEntry : path.resolve(pkg.dir, pkg.source ?? pkg.main ?? 'index.js'))
            } else if (load.specifier.startsWith(pkg.name + '/')) bases.push(path.join(pkg.dir, load.specifier.slice(pkg.name.length + 1)))
          }
        }
        if (bases.length === 0) continue // Actual external package or built-in.
        const target = bases.flatMap(resolveCandidates).find(isFile)
        if (!target) { gaps.push({ from, ...load, sourceHash }); continue }
        if (!sourceFile(target)) continue // Non-executable asset, e.g. JSON.
        edges.push({ from, to: path.relative(root, target), ...load })
        if (!visited.has(target)) queue.push(target)
      }
    }
    return { files: [...visited].map((file) => path.relative(root, file)).sort(), edges: sorted(edges), gaps: sorted(gaps),
      testEdges: sorted(edges.filter((edge) => TEST_FILE.test(edge.from) || TEST_FILE.test(edge.to))), requestRoots: requestRoots.sort(), resolutionInputs: [...resolutionInputs].map(([file, sha256]) => ({ path: file, sha256 })).sort((a, b) => a.path.localeCompare(b.path)) }
  }
}

/** Breadth-first traversal returns shortest paths and terminates on cycles. */
export function runtimePaths(edges: ModuleEdge[], start: string, reverse = false): Map<string, string[]> {
  const paths = new Map([[start, [start]]]), queue = [start]
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.typeOnly) continue
    const from = reverse ? edge.to : edge.from, to = reverse ? edge.from : edge.to
    adjacency.set(from, [...(adjacency.get(from) ?? []), to])
  }
  for (let index = 0; index < queue.length; index++) {
    for (const next of adjacency.get(queue[index]) ?? []) if (!paths.has(next)) {
      paths.set(next, [...paths.get(queue[index])!, next]); queue.push(next)
    }
  }
  return paths
}

export function reverseRegistry(edges: ModuleEdge[], root: string): { root: string; members: string[]; edges: string[][] } {
  const members = [...runtimePaths(edges, root, true).keys()].sort(), included = new Set(members)
  return { root, members, edges: sorted(edges.filter((edge) => !edge.typeOnly && included.has(edge.from) && included.has(edge.to))
    .map((edge) => [edge.from, edge.to, edge.kind])) }
}

export function forbiddenPaths(edges: ModuleEdge[], roots: string[], targets: string[]): string[][] {
  return roots.flatMap((root) => {
    const paths = runtimePaths(edges, root)
    return targets.flatMap((target) => paths.has(target) ? [paths.get(target)!] : [])
  })
}

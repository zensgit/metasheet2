import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import registry from '../fixtures/integration-capability-runtime-closure.json'
import { moduleLoads, SOURCE_EXTENSIONS } from '../helpers/import-edge-allowlist'
import { collectModuleGraph, createModuleGraphCollector, forbiddenPaths, reverseRegistry, runtimePaths, SOURCE_ROOT, type ModuleGraph } from '../helpers/runtime-module-closure'

const ROOT = path.resolve(__dirname, '../../../..')
// Independent inventory: do not reuse the collector's roots or directory walker.
const PRODUCTION_ROOTS = ['packages/core-backend/src', 'packages/core-backend/scripts', 'packages/core-backend/plugins', 'scripts', 'plugins']
const productionFiles = (root = ROOT) => PRODUCTION_ROOTS.flatMap((dir) => {
  const full = path.join(root, dir), info = lstatSync(full, { throwIfNoEntry: false })
  expect(info?.isSymbolicLink(), `根内存在符号链接: ${dir}`).not.toBe(true)
  if (!info) return []
  const entries = readdirSync(full, { recursive: true, withFileTypes: true })
  expect(entries.filter((entry) => entry.isSymbolicLink()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))),
    `根内存在符号链接: ${dir}`).toEqual([])
  return entries.filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
})
  .filter((file) => !/(?:^|\/)(?:node_modules|\.git)(?:\/|$)/.test(file))
  .filter((file) => [...SOURCE_EXTENSIONS, '.vue'].includes(path.extname(file)))
  .filter((file) => !/(?:^|\/)(?:__tests__|tests|test)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
const BACKGROUND = SOURCE_ROOT + 'integrations/integration-capability-resolve-background.ts'
const REQUEST = SOURCE_ROOT + 'integrations/integration-capability-resolve.ts'
const WORKER = SOURCE_ROOT + 'services/task-notification-delivery-worker.ts'
const SCHEDULER = SOURCE_ROOT + 'services/task-scheduler.ts'
const WITNESS = SOURCE_ROOT + 'integrations/integration-capability-witness.ts'
const PROVIDER_REGISTRY = SOURCE_ROOT + 'integrations/provider-capability-registry.ts'
const NEW_MODULE = /\/integrations\/(?:integration-capability-resolve(?:-background|-core)?|integration-capability-witness)\.ts$/
const directEdges = (graph: ModuleGraph) => graph.edges.filter((edge) => NEW_MODULE.test(edge.to) || (edge.from === WITNESS && edge.to === PROVIDER_REGISTRY)).map((edge) => [edge.from, edge.to, edge.kind, edge.typeOnly])
const gapEntries = registry.reviewedGaps.map(({ review: _review, ...entry }) => entry)
const read = (root: string, file: string): string => readFileSync(path.join(root, file), 'utf8')
function write(root: string, file: string, source: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), source)
}

let graph: ModuleGraph
let collect: ReturnType<typeof createModuleGraphCollector>
const completedTests = new Set<string>()
function checked<T extends unknown[]>(test: (...args: T) => void): (...args: T) => void {
  return (...args) => {
    test(...args)
    // Count completed bodies, not hooks or retry attempts. All callbacks in this file are synchronous.
    completedTests.add(expect.getState().currentTestName!)
  }
}
// Parse the complete production graph once; retain a generous setup budget under full-suite contention.
beforeAll(() => {
  collect = createModuleGraphCollector(ROOT)
  graph = collect()
}, 180_000)
afterAll(() => {
  expect(completedTests.size, 'runtime closure guard must complete all 48 cases (no pending/skipped cases)').toBe(48)
})

describe('capability runtime module boundaries', () => {
  it('registers the complete reverse runtime sets and edge multisets without line-number keys', checked(() => {
    // Include followed dependencies (including test helpers), but never pin an unrelated file count.
    expect(graph.files).toEqual([...new Set([...productionFiles(), ...graph.edges.map((edge) => edge.to)])].sort())
    expect(registry.reverse.map((entry) => entry.root)).toEqual([SCHEDULER, WORKER, BACKGROUND])
    for (const expected of registry.reverse) {
      expect(reverseRegistry(graph.edges, expected.root), expected.root).toEqual(expected)
      expect(graph.files).toContain(expected.root)
    }
    for (const root of registry.absentRoots) expect(existsSync(path.join(ROOT, root)), root).toBe(false)
    expect(registry.absentRoots).toEqual([
      SOURCE_ROOT + 'services/task-routed-reminders.ts', SOURCE_ROOT + 'services/task-routed-delivery-channel.ts',
    ])
    expect(registry.reverse.find((entry) => entry.root === WORKER)?.members).toContain(SOURCE_ROOT + 'index.ts')
  }))

  it('checks resolved direct edges including type-only loads across all production roots', checked(() => {
    expect(directEdges(graph)).toEqual(registry.directEdges)
    expect(graph.edges.filter((edge) => edge.to === BACKGROUND)).toEqual([])
  }))

  it('accepts unrelated source additions in every root without updating the reviewed registry', checked(() => {
    const added = PRODUCTION_ROOTS.map((dir) => dir + '/boundary-control-unrelated.ts')
    const changed = collect(new Map(added.map((file) => [file, 'export const unrelated = 1'])))
    expect(changed.files).toEqual([...graph.files, ...added].sort())
    expect({ ...changed, files: [] }).toEqual({ ...graph, files: [] })
  }))

  it.each(['.hidden/control.mjs', '.control.cjs', 'control.min.js'])('includes %s in both disk inventories across all roots', checked((name) => {
    const isolated = mkdtempSync(path.join(tmpdir(), 'capability-inventory-'))
    const added = PRODUCTION_ROOTS.map((dir) => dir + '/' + name)
    try {
      for (const file of added) write(isolated, file, 'export const unrelated = 1')
      expect(productionFiles(isolated).sort()).toEqual(added.sort())
      expect(collectModuleGraph(isolated).files).toEqual(added.sort())
    } finally { rmSync(isolated, { recursive: true, force: true }) }
  }))

  it.each(PRODUCTION_ROOTS.flatMap((dir) => ['file', 'directory', 'dangling'].map((kind) => [dir, kind])))
  ('rejects a %s root containing a %s symbolic link before following it', checked((dir, kind) => {
    const isolated = mkdtempSync(path.join(tmpdir(), 'capability-symlink-'))
    try {
      write(isolated, 'target/module.ts', 'export const value = 1')
      mkdirSync(path.join(isolated, dir), { recursive: true })
      const target = kind === 'directory' ? 'target' : kind === 'file' ? 'target/module.ts' : 'missing.ts'
      symlinkSync(path.join(isolated, target), path.join(isolated, dir, 'alias.ts'))
      expect(() => productionFiles(isolated)).toThrow('根内存在符号链接')
      expect(() => collectModuleGraph(isolated)).toThrow('根内存在符号链接')
    } finally { rmSync(isolated, { recursive: true, force: true }) }
  }))

  it.each(['packages/core-backend/plugins/plugin-view-kanban', 'plugins/plugin-audit-logger'])
  ('rejects a background alias with shadow dependency stubs in %s', checked((plugin) => {
    const isolated = mkdtempSync(path.join(tmpdir(), 'capability-symlink-stubs-'))
    try {
      write(isolated, BACKGROUND, read(ROOT, BACKGROUND))
      write(isolated, plugin + '/src/index.ts', "import './x/helper'")
      write(isolated, plugin + '/src/x/integration-capability-resolve-core.ts', 'export {}')
      write(isolated, plugin + '/src/multitable/automation-durable-dispatcher.ts', 'export {}')
      symlinkSync(path.join(isolated, BACKGROUND), path.join(isolated, plugin, 'src/x/helper.ts'))
      expect(() => productionFiles(isolated)).toThrow('根内存在符号链接')
      expect(() => collectModuleGraph(isolated)).toThrow('根内存在符号链接')
    } finally { rmSync(isolated, { recursive: true, force: true }) }
  }))

  it('rejects a backend kanban plugin importing the background entry', checked(() => {
    const plugin = 'packages/core-backend/plugins/plugin-view-kanban/src/index.ts'
    expect(graph.requestRoots).toContain(plugin)
    const changed = collect(new Map([[plugin, read(ROOT, plugin)
      + "\nimport '../../../src/integrations/integration-capability-resolve-background'\n"]]))
    expect(changed.edges).toContainEqual(expect.objectContaining({ from: plugin, to: BACKGROUND, typeOnly: false }))
    expect(directEdges(changed)).not.toEqual(registry.directEdges)
    expect(reverseRegistry(changed.edges, BACKGROUND)).not.toEqual(registry.reverse.find((entry) => entry.root === BACKGROUND))
    expect(forbiddenPaths(changed.edges, changed.requestRoots, [BACKGROUND])).toEqual([[plugin, BACKGROUND]])
  }))

  it('registers each missing, non-literal and parse item exactly, and follows test helpers separately', checked(() => {
    expect(graph.gaps, 'Changed, added, removed or resolved loads, or edits to a gap-bearing file, require review: update reviewedGaps in integration-capability-runtime-closure.json from this diff, including sourceHash and a per-item review reason; do not auto-accept gaps.').toEqual(gapEntries)
    expect(graph.resolutionInputs, 'Changed package.json/tsconfig contents or added resolution inputs require resolution review: update resolutionInputs in integration-capability-runtime-closure.json with the paths and full-file SHA256 values from this diff, then rerun this guard.').toEqual(registry.resolutionInputs)
    expect(registry.reviewedGaps.every((entry) => entry.review.length > 30)).toBe(true)
    expect(graph.testEdges).toEqual(registry.testEdges)
    expect(graph.gaps.filter((entry) => entry.from.includes('plugin-view-gantt')).map((entry) => entry.specifier)).toEqual(['./api', './handlers'])
    expect(graph.gaps.some((entry) => entry.specifier.includes('tests/utils/'))).toBe(false)
  }))

  it('checks both directions, including non-route HTTP modules, dynamic routes and plugins', checked(() => {
    expect(graph.requestRoots, 'Added or removed routes, HTTP modules or plugin addRoute entry points require boundary review: update the sorted requestRoots in integration-capability-runtime-closure.json from this diff, merge concurrent additions, then rerun both reachability checks.').toEqual(registry.requestRoots)
    for (const file of ['services/elearning-pilot-runtime.ts', 'services/approval-attachment-runtime.ts',
      'services/elearning-media-runtime.ts', 'gateway/APIGateway.ts', 'routes/fallback-test.ts']) {
      expect(graph.requestRoots).toContain(SOURCE_ROOT + file)
    }
    expect(graph.requestRoots).toContain('plugins/plugin-view-gantt/src/index.ts')
    expect(forbiddenPaths(graph.edges, graph.requestRoots, [BACKGROUND, ...registry.absentRoots])).toEqual([])
    expect(forbiddenPaths(graph.edges, [BACKGROUND, WORKER, SCHEDULER], [REQUEST])).toEqual([])
  }))

  it.each([
    ['import type { T } from "./x"', true], ['import { type T } from "./x"', true],
    ['export type { T } from "./x"', true], ['export { type T } from "./x"', true],
    ['type T = import("./x").T', true], ['import type x = require("./x")', true],
    ['import { type T, value } from "./x"', false], ['export { type T, value } from "./x"', false],
    ['import { T } from "./x"; type U = T', false], ['import "./x"', false],
    ['import {} from "./x"', false], ['export * from "./x"', false],
    ['import x = require("./x")', false], ['const x = require("./x")', false],
    ['const x = import(`./x`)', false],
  ])('classifies %s independently of its eventual use', checked((source, typeOnly) => {
    expect(moduleLoads(source)).toEqual([expect.objectContaining({ specifier: './x', typeOnly })])
  }))

  it('resolves actual workspace subpaths, configured aliases, .js spellings and directory indexes without transmitting type-only edges', checked(() => {
    const isolated = mkdtempSync(path.join(tmpdir(), 'capability-alias-'))
    const packageName = JSON.parse(read(ROOT, 'packages/core-backend/package.json')).name
    const request = 'plugins/control/src/request.ts', barrel = 'plugins/control/src/barrel/index.ts'
    try {
      write(isolated, 'packages/core-backend/package.json', JSON.stringify({ name: packageName, main: 'src/index.ts' }))
      write(isolated, 'plugins/control/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }))
      write(isolated, BACKGROUND, 'export const value = 1')
      write(isolated, request, "import { value } from '@/barrel'; export { value }")
      write(isolated, barrel, `export type { value } from '${packageName}/src/integrations/integration-capability-resolve-background.js'`)
      const typed = collectModuleGraph(isolated)
      expect(typed.gaps).toEqual([])
      expect(typed.edges).toContainEqual(expect.objectContaining({ from: request, to: barrel, typeOnly: false }))
      expect(directEdges(typed)).toEqual([[barrel, BACKGROUND, 'export-from', true]])
      expect(directEdges(typed)).not.toEqual([]) // Direct forbidden type loads cannot disappear with runtime filtering.
      expect(forbiddenPaths(typed.edges, [request], [BACKGROUND])).toEqual([])
      write(isolated, barrel, `export { value } from '${packageName}/src/integrations/integration-capability-resolve-background.js'`)
      expect(forbiddenPaths(collectModuleGraph(isolated).edges, [request], [BACKGROUND])).toEqual([[request, barrel, BACKGROUND]])
    } finally { rmSync(isolated, { recursive: true, force: true }) }
  }))

  it('pins the pure witness leaf and rejects changing its registry type import into a runtime load', checked(() => {
    const original = read(ROOT, WITNESS)
    expect(moduleLoads(original)).toEqual([
      { specifier: 'node:crypto', typeOnly: false, kind: 'import' },
      { specifier: './provider-capability-registry', typeOnly: true, kind: 'import' },
    ])
    const mutated = original.replace('import type {', 'import {')
    expect(mutated).not.toBe(original)
    expect(directEdges(collect(new Map([[WITNESS, mutated]])))).not.toEqual(registry.directEdges)
  }))

  it('resolves inherited aliases before package paths and rejects metadata-only remapping', checked(() => {
    const config = 'tsconfig.base.json', original = read(ROOT, config)
    const importer = 'plugins/plugin-view-gantt/src/index.ts'
    const specifier = moduleLoads(read(ROOT, importer)).find((load) => load.typeOnly)!.specifier
    const changed = JSON.parse(original)
    changed.compilerOptions = { ...changed.compilerOptions, baseUrl: '.', paths: { [specifier]: [BACKGROUND] } }
    const result = collect(new Map([[config, JSON.stringify(changed)]]))
    expect(result.resolutionInputs).not.toEqual(registry.resolutionInputs)
    expect(result.edges).toContainEqual(expect.objectContaining({ from: importer, to: BACKGROUND, typeOnly: true }))
    expect(directEdges(result)).not.toEqual(registry.directEdges)
  }))

  it('rejects a new non-routes request wrapper through a barrel, with a shortest path', checked(() => {
    const request = 'plugins/boundary-control/src/request.ts', barrel = SOURCE_ROOT + 'services/boundary-control.ts'
    const overrides = new Map([
      [request, `import { value } from '../../../${barrel}'; export { value }`],
      [barrel, "export * from '../integrations/integration-capability-resolve-background.js'"],
    ])
    const changed = collect(overrides)
    expect(reverseRegistry(changed.edges, BACKGROUND)).not.toEqual(registry.reverse.find((entry) => entry.root === BACKGROUND))
    expect(forbiddenPaths(changed.edges, [request], [BACKGROUND])).toEqual([[request, barrel, BACKGROUND]])
    expect(directEdges(changed)).not.toEqual(registry.directEdges)
    overrides.set(barrel, "export * from '../integrations/integration-capability-resolve.js'")
    overrides.set(BACKGROUND, read(ROOT, BACKGROUND) + "\nimport '../services/boundary-control'\n")
    expect(forbiddenPaths(collect(overrides).edges, [BACKGROUND], [REQUEST])).toEqual([[BACKGROUND, barrel, REQUEST]])
  }))

  it('keeps the real sender type-only edge non-transitive, then exposes its value mutation in a temporary future-consumer overlay', checked(() => {
    const sender = SOURCE_ROOT + 'services/task-notification-dingtalk.ts'
    const original = read(ROOT, sender), scheduler = read(ROOT, SCHEDULER), worker = read(ROOT, WORKER)
    const [scan, delivery] = registry.absentRoots
    const overrides = new Map([
      [scan, "import '../integrations/integration-capability-resolve-background'"],
      [delivery, "import '../integrations/integration-capability-resolve-background'"],
      [SCHEDULER, scheduler + "\nimport './task-routed-reminders'\n"],
      [WORKER, worker + "\nimport './task-routed-delivery-channel'\n"],
    ])
    const control = collect(overrides)
    expect(forbiddenPaths(control.edges, control.requestRoots, [BACKGROUND, scan, delivery])).toEqual([])
    expect(runtimePaths(control.edges, SOURCE_ROOT + 'index.ts').has(delivery)).toBe(true)
    expect(control.edges.find((edge) => edge.from === sender && edge.to === WORKER)?.typeOnly).toBe(true)
    const mutated = original.replace(/import type (\{[^}]+\} from '\.\/task-notification-delivery-worker')/, 'import $1')
    expect(mutated).not.toBe(original)
    overrides.set(sender, mutated)
    const changed = collect(overrides)
    const paths = forbiddenPaths(changed.edges, changed.requestRoots, [delivery])
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every((entry) => entry.at(-2) === WORKER && entry.at(-1) === delivery)).toBe(true)
    expect(paths.some((entry) => entry.includes(sender))).toBe(true)
  }))

  it('rejects added or removed reverse edges, duplicate loads, roots and missing registry members', checked(() => {
    const file = SOURCE_ROOT + 'index.ts', original = read(ROOT, file)
    const expected = registry.reverse.find((entry) => entry.root === WORKER)!
    expect(expected.members.length).toBeGreaterThan(5)
    expect(expected.edges.length).toBeGreaterThan(5)
    expect(reverseRegistry(graph.edges, WORKER)).not.toEqual({ ...expected, members: expected.members.slice(1) })
    expect(reverseRegistry(graph.edges, WORKER)).not.toEqual({ ...expected, edges: expected.edges.slice(1) })
    expect(reverseRegistry(collect(new Map([[file, original + "\nimport './services/task-scheduler'\n"]])).edges, WORKER)).not.toEqual(expected)
    const removed = original.replace(/import\s*\{[^}]*\}\s*from\s*'\.\/services\/task-scheduler'\s*;?/, '')
    expect(removed).not.toBe(original)
    expect(reverseRegistry(collect(new Map([[file, removed]])).edges, WORKER)).not.toEqual(expected)
  }))

  it('requires re-review when a registered missing target appears or an unknown internal load is added', checked(() => {
    const target = 'plugins/plugin-view-gantt/src/api.ts'
    expect(collect(new Map([[target, 'export class GanttAPIHandler {}']])).gaps).not.toEqual(gapEntries)
    const gaps = collect(new Map([[target, "import './unreviewed-internal-target'"]])).gaps
    expect(gaps).not.toEqual(gapEntries)
    expect(gaps).toContainEqual(expect.objectContaining({ from: target, specifier: './unreviewed-internal-target' }))
    expect(graph.gaps).not.toEqual(gapEntries.slice(1))
    expect(graph.gaps).not.toEqual([...gapEntries, gapEntries[0]])
    // No overlay (including added files or metadata) may leak into the cached baseline.
    expect(collect()).toEqual(graph)
  }))
})

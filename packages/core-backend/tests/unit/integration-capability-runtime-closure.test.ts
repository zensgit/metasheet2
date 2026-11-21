import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import registry from '../fixtures/integration-capability-runtime-closure.json'
import { moduleLoads } from '../helpers/import-edge-allowlist'
import { collectModuleGraph, forbiddenPaths, graphFiles, GRAPH_ROOTS, reverseRegistry, runtimePaths, SOURCE_ROOT, type ModuleGraph } from '../helpers/runtime-module-closure'

const ROOT = path.resolve(__dirname, '../../../..')
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
let mirrorRoot: string | undefined
// Parsing the full production graph can exceed the default hook budget during the full suite.
beforeAll(() => {
  graph = collectModuleGraph(ROOT)
}, 180_000)
afterAll(() => { if (mirrorRoot) rmSync(mirrorRoot, { recursive: true, force: true }) })

// Only mutation tests need a mirror; copy it once and restore each mutation in its own finally.
// Their explicit timeout also covers copying and rescanning under full-suite contention.
function getMirror(): string {
  if (mirrorRoot) return mirrorRoot
  const files = new Set([...graph.files, ...graph.resolutionInputs.map((input) => input.path), ...GRAPH_ROOTS.flatMap((dir) => graphFiles(path.join(ROOT, dir)))
    .filter((file) => file.endsWith('.json')).map((file) => path.relative(ROOT, file)),
  'tsconfig.json', 'packages/core-backend/package.json', 'packages/core-backend/tsconfig.json', 'packages/mssql-readonly-utils/package.json'])
  const mirror = mkdtempSync(path.join(tmpdir(), 'capability-closure-'))
  try {
    for (const directory of new Set([...files].map((file) => path.dirname(file)))) {
      mkdirSync(path.join(mirror, directory), { recursive: true })
    }
    for (const file of files) copyFileSync(path.join(ROOT, file), path.join(mirror, file))
    mirrorRoot = mirror
    return mirror
  } catch (error) {
    rmSync(mirror, { recursive: true, force: true })
    throw error
  }
}

describe('capability runtime module boundaries', () => {
  it('registers the complete reverse runtime sets and edge multisets without line-number keys', () => {
    expect(graph.files.length).toBeGreaterThan(2000)
    expect(graph.files).toHaveLength(registry.fileCount)
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
  })

  it('checks resolved direct edges including type-only loads across all production roots', () => {
    expect(directEdges(graph)).toEqual(registry.directEdges)
    expect(graph.edges.filter((edge) => edge.to === BACKGROUND)).toEqual([])
  })

  it('registers each missing, non-literal and parse item exactly, and follows test helpers separately', () => {
    expect(graph.gaps).toEqual(gapEntries)
    expect(graph.resolutionInputs).toEqual(registry.resolutionInputs)
    expect(registry.reviewedGaps.every((entry) => entry.review.length > 30)).toBe(true)
    expect(graph.testEdges).toEqual(registry.testEdges)
    expect(graph.gaps.filter((entry) => entry.from.includes('plugin-view-gantt')).map((entry) => entry.specifier)).toEqual(['./api', './handlers'])
    expect(graph.gaps.some((entry) => entry.specifier.includes('tests/utils/'))).toBe(false)
  })

  it('checks both directions, including non-route HTTP modules, dynamic routes and plugins', () => {
    expect(graph.requestRoots).toEqual(registry.requestRoots)
    for (const file of ['services/elearning-pilot-runtime.ts', 'services/approval-attachment-runtime.ts',
      'services/elearning-media-runtime.ts', 'gateway/APIGateway.ts', 'routes/fallback-test.ts']) {
      expect(graph.requestRoots).toContain(SOURCE_ROOT + file)
    }
    expect(graph.requestRoots).toContain('plugins/plugin-view-gantt/src/index.ts')
    expect(forbiddenPaths(graph.edges, graph.requestRoots, [BACKGROUND, ...registry.absentRoots])).toEqual([])
    expect(forbiddenPaths(graph.edges, [BACKGROUND, WORKER, SCHEDULER], [REQUEST])).toEqual([])
  })

  it.each([
    ['import type { T } from "./x"', true], ['import { type T } from "./x"', true],
    ['export type { T } from "./x"', true], ['export { type T } from "./x"', true],
    ['type T = import("./x").T', true], ['import type x = require("./x")', true],
    ['import { type T, value } from "./x"', false], ['export { type T, value } from "./x"', false],
    ['import { T } from "./x"; type U = T', false], ['import "./x"', false],
    ['import {} from "./x"', false], ['export * from "./x"', false],
    ['import x = require("./x")', false], ['const x = require("./x")', false],
    ['const x = import(`./x`)', false],
  ])('classifies %s independently of its eventual use', (source, typeOnly) => {
    expect(moduleLoads(source)).toEqual([expect.objectContaining({ specifier: './x', typeOnly })])
  })

  it('resolves actual workspace subpaths, configured aliases, .js spellings and directory indexes without transmitting type-only edges', () => {
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
  })

  it('pins the pure witness leaf and rejects changing its registry type import into a runtime load', () => {
    const mirror = getMirror()
    const original = read(mirror, WITNESS)
    expect(moduleLoads(original)).toEqual([
      { specifier: 'node:crypto', typeOnly: false, kind: 'import' },
      { specifier: './provider-capability-registry', typeOnly: true, kind: 'import' },
    ])
    try {
      write(mirror, WITNESS, original.replace('import type {', 'import {'))
      expect(read(mirror, WITNESS)).not.toBe(original)
      expect(directEdges(collectModuleGraph(mirror))).not.toEqual(registry.directEdges)
    } finally { write(mirror, WITNESS, original) }
  }, 180_000)

  it('resolves inherited aliases before package paths and rejects metadata-only remapping', () => {
    const mirror = getMirror()
    const config = 'tsconfig.base.json', original = read(mirror, config)
    const importer = 'plugins/plugin-view-gantt/src/index.ts'
    const specifier = moduleLoads(read(mirror, importer)).find((load) => load.typeOnly)!.specifier
    try {
      const changed = JSON.parse(original)
      changed.compilerOptions = { ...changed.compilerOptions, baseUrl: '.', paths: { [specifier]: [BACKGROUND] } }
      write(mirror, config, JSON.stringify(changed))
      const result = collectModuleGraph(mirror)
      expect(result.resolutionInputs).not.toEqual(registry.resolutionInputs)
      expect(result.edges).toContainEqual(expect.objectContaining({ from: importer, to: BACKGROUND, typeOnly: true }))
      expect(directEdges(result)).not.toEqual(registry.directEdges)
    } finally { write(mirror, config, original) }
  }, 180_000)

  it('rejects a new non-routes request wrapper through a barrel, with a shortest path', () => {
    const mirror = getMirror()
    const request = 'plugins/boundary-control/src/request.ts', barrel = SOURCE_ROOT + 'services/boundary-control.ts'
    try {
      write(mirror, request, `import { value } from '../../../${barrel}'; export { value }`)
      write(mirror, barrel, "export * from '../integrations/integration-capability-resolve-background.js'")
      const changed = collectModuleGraph(mirror)
      expect(reverseRegistry(changed.edges, BACKGROUND)).not.toEqual(registry.reverse.find((entry) => entry.root === BACKGROUND))
      expect(forbiddenPaths(changed.edges, [request], [BACKGROUND])).toEqual([[request, barrel, BACKGROUND]])
      expect(directEdges(changed)).not.toEqual(registry.directEdges)
      write(mirror, barrel, "export * from '../integrations/integration-capability-resolve.js'")
      write(mirror, BACKGROUND, read(ROOT, BACKGROUND) + "\nimport '../services/boundary-control'\n")
      expect(forbiddenPaths(collectModuleGraph(mirror).edges, [BACKGROUND], [REQUEST])).toEqual([[BACKGROUND, barrel, REQUEST]])
    } finally {
      rmSync(path.join(mirror, request)); rmSync(path.join(mirror, barrel)); write(mirror, BACKGROUND, read(ROOT, BACKGROUND))
    }
  }, 180_000)

  it('keeps the real sender type-only edge non-transitive, then exposes its value mutation in a temporary future-consumer mirror', () => {
    const mirror = getMirror()
    const sender = SOURCE_ROOT + 'services/task-notification-dingtalk.ts'
    const original = read(mirror, sender), scheduler = read(mirror, SCHEDULER), worker = read(mirror, WORKER)
    const [scan, delivery] = registry.absentRoots
    try {
      write(mirror, scan, "import '../integrations/integration-capability-resolve-background'")
      write(mirror, delivery, "import '../integrations/integration-capability-resolve-background'")
      write(mirror, SCHEDULER, scheduler + "\nimport './task-routed-reminders'\n")
      write(mirror, WORKER, worker + "\nimport './task-routed-delivery-channel'\n")
      const control = collectModuleGraph(mirror)
      expect(forbiddenPaths(control.edges, control.requestRoots, [BACKGROUND, scan, delivery])).toEqual([])
      expect(runtimePaths(control.edges, SOURCE_ROOT + 'index.ts').has(delivery)).toBe(true)
      expect(control.edges.find((edge) => edge.from === sender && edge.to === WORKER)?.typeOnly).toBe(true)
      const mutated = original.replace(/import type (\{[^}]+\} from '\.\/task-notification-delivery-worker')/, 'import $1')
      expect(mutated).not.toBe(original)
      write(mirror, sender, mutated)
      const changed = collectModuleGraph(mirror)
      const paths = forbiddenPaths(changed.edges, changed.requestRoots, [delivery])
      expect(paths.length).toBeGreaterThan(0)
      expect(paths.every((entry) => entry.at(-2) === WORKER && entry.at(-1) === delivery)).toBe(true)
      expect(paths.some((entry) => entry.includes(sender))).toBe(true)
    } finally {
      write(mirror, sender, original); write(mirror, SCHEDULER, scheduler); write(mirror, WORKER, worker)
      rmSync(path.join(mirror, scan)); rmSync(path.join(mirror, delivery))
    }
  }, 180_000)

  it('rejects added or removed reverse edges, duplicate loads, roots and missing registry members', () => {
    const mirror = getMirror()
    const file = SOURCE_ROOT + 'index.ts', original = read(mirror, file)
    const expected = registry.reverse.find((entry) => entry.root === WORKER)!
    expect(expected.members.length).toBeGreaterThan(5)
    expect(expected.edges.length).toBeGreaterThan(5)
    expect(reverseRegistry(graph.edges, WORKER)).not.toEqual({ ...expected, members: expected.members.slice(1) })
    expect(reverseRegistry(graph.edges, WORKER)).not.toEqual({ ...expected, edges: expected.edges.slice(1) })
    try {
      write(mirror, file, original + "\nimport './services/task-scheduler'\n")
      expect(reverseRegistry(collectModuleGraph(mirror).edges, WORKER)).not.toEqual(expected)
      write(mirror, file, original.replace(/import\s*\{[^}]*\}\s*from\s*'\.\/services\/task-scheduler'\s*;?/, ''))
      expect(read(mirror, file)).not.toBe(original)
      expect(reverseRegistry(collectModuleGraph(mirror).edges, WORKER)).not.toEqual(expected)
    } finally { write(mirror, file, original) }
  }, 180_000)

  it('requires re-review when a registered missing target appears or an unknown internal load is added', () => {
    const mirror = getMirror()
    const target = 'plugins/plugin-view-gantt/src/api.ts'
    try {
      write(mirror, target, 'export class GanttAPIHandler {}')
      expect(collectModuleGraph(mirror).gaps).not.toEqual(gapEntries)
      write(mirror, target, "import './unreviewed-internal-target'")
      const gaps = collectModuleGraph(mirror).gaps
      expect(gaps).not.toEqual(gapEntries)
      expect(gaps).toContainEqual(expect.objectContaining({ from: target, specifier: './unreviewed-internal-target' }))
      expect(graph.gaps).not.toEqual(gapEntries.slice(1))
      expect(graph.gaps).not.toEqual([...gapEntries, gapEntries[0]])
    } finally { rmSync(path.join(mirror, target)) }
  }, 180_000)
})

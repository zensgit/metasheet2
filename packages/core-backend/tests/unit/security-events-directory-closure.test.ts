import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { entry, entryViolations, eventClosure, eventEdges, eventImportViolations, eventSqlViolations, processStoreViolations, regenerateDirectoryFixture, sourcePopulation, sourcesAt } from '../helpers/security-events-directory-closure'
import { EVENT_REGISTRY } from '../../src/security-events/registry'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const sources = sourcesAt(root)
const fixture = JSON.parse(readFileSync(new URL('../fixtures/security-events/directory-closure.json', import.meta.url), 'utf8'))
const registrationHelp = 'Stage new source paths and run tests/helpers/regenerate-security-events-directory.ts --write; inspect every changed entry. Classify new population as pending_other_source, adapter_ready_callsite_pending or excluded with a reason; pending_contract is incomplete.'
afterEach(() => { expect(expect.getState().assertionCalls).toBeGreaterThan(0) })

describe('directory event source and capability registration', () => {
  it('keeps the complete event implementation and its imports registered', () => {
    expect(eventEdges(sources), registrationHelp).toEqual(fixture.edges)
    expect(eventImportViolations(eventEdges(sources)), 'Production consumers import only directory-observations.').toEqual([])
    expect(eventClosure(sources), registrationHelp).toEqual(fixture.closure)
    expect(entryViolations(sources)).toEqual([])
    expect(processStoreViolations(sources)).toEqual([])
    expect(eventSqlViolations(sources)).toEqual([])
  })
  it('enumerates the production population with per-source coverage status', () => {
    const population = sourcePopulation(sources)
    expect(population.length).toBeGreaterThan(0)
    expect(population, registrationHelp).toEqual(fixture.population.map(({ coverage: _coverage, reason: _reason, ...item }: Record<string, unknown>) => item))
    expect(fixture.population.every((item: { coverage: string }) => ['pending_other_source', 'adapter_ready_callsite_pending', 'excluded'].includes(item.coverage)), registrationHelp).toBe(true)
    expect(population.filter(item => item.category === 'authorization-writer').length).toBeGreaterThan(0)
    expect(fixture.population.filter((item: { coverage: string }) => item.coverage === 'excluded').every((item: { reason?: string }) => !!item.reason)).toBe(true)
    expect(fixture.contracts).toHaveLength(7)
    for (const contract of fixture.contracts) {
      const rule = EVENT_REGISTRY[contract.event_type as keyof typeof EVENT_REGISTRY]
      expect(rule.producer).toBe('directory')
      expect(rule.steps).toContain(contract.step)
      expect(rule.scopes).toEqual(contract.scopes)
      const point = population.find(item => item.file === contract.file && item.sha256 === contract.callHash)
      expect(point).toBeDefined()
      expect(contract.state).toBe('adapter_ready_callsite_pending')
    }
    const diagnostic = fixture.contracts.find((contract: { event_type: string }) => contract.event_type === 'directory.diagnostic_failed')
    expect(diagnostic).toMatchObject({ file: 'packages/core-backend/src/directory/directory-sync.ts', step: 'diagnostic', scopes: ['organization'] })
  })
  it('regenerates deterministically and preserves source annotations', () => {
    expect(JSON.stringify(regenerateDirectoryFixture(sources, fixture), null, 2) + '\n')
      .toBe(readFileSync(new URL('../fixtures/security-events/directory-closure.json', import.meta.url), 'utf8'))
    const file = 'packages/core-backend/src/directory/observation-fixture.ts'
    const added = regenerateDirectoryFixture(new Map(sources).set(file, 'logger.warn("fixture")'), fixture)
    expect(added.population.filter(item => item.file === file)).toEqual([expect.objectContaining({ coverage: 'pending_contract' })])
    expect(added.contracts).toEqual(fixture.contracts)
    const removed = new Map(sources)
    removed.delete('packages/core-backend/src/directory/directory-sync.ts')
    expect(() => regenerateDirectoryFixture(removed, fixture)).toThrow('EVENT_CONTRACT_SOURCE_CHANGED')
  })
  it('pins loader expressions without coupling unrelated statements or source offsets', () => {
    const file = 'packages/core-backend/src/directory/observation-fixture.ts'
    const make = (text: string) => new Map([[file, text]])
    const original = 'function load(name: string) { return import(name) }; const extra = 1'
    expect(eventEdges(make(original))).toEqual(eventEdges(make('\n' + original.replace('extra = 1', 'extra = 2'))))
    expect(eventEdges(make(original))).not.toEqual(eventEdges(make(original.replace('import(name)', 'import(other)'))))
    expect(sourcePopulation(make('logger.warn("fixture"); const extra = 1')))
      .toEqual(sourcePopulation(make('\nlogger.warn("fixture"); const extra = 2')))
  })
  it('requires source paths in the index and excludes ignored files', () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'event-sources-'))
    try {
      const dir = 'packages/core-backend/src/directory'
      mkdirSync(path.join(temporary, dir), { recursive: true })
      writeFileSync(path.join(temporary, '.gitignore'), 'ignored.ts\n')
      for (const name of ['tracked', 'ignored', 'untracked']) writeFileSync(path.join(temporary, dir, name + '.ts'), 'logger.warn("fixture")')
      const env = { ...process.env }
      for (const key of ['GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_DIR', 'GIT_WORK_TREE']) delete env[key]
      execFileSync('git', ['init', '-q', temporary], { env })
      execFileSync('git', ['-C', temporary, 'add', dir + '/tracked.ts'], { env })
      const index = process.env.GIT_INDEX_FILE
      try {
        delete process.env.GIT_INDEX_FILE
        expect(() => sourcesAt(temporary)).toThrow('EVENT_UNINDEXED_SOURCES')
        execFileSync('git', ['-C', temporary, 'add', '-N', dir + '/untracked.ts'], { env })
        expect([...sourcesAt(temporary).keys()]).toEqual([dir + '/tracked.ts', dir + '/untracked.ts'])
      } finally {
        if (index === undefined) delete process.env.GIT_INDEX_FILE
        else process.env.GIT_INDEX_FILE = index
      }
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  })
  it('prints duplicate edge changes and refuses incomplete source indexes through the CLI', () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'event-registration-'))
    const dependencies = path.join(temporary, 'node_modules')
    const env = { ...process.env, TSX_DISABLE_CACHE: '1' }
    for (const key of ['GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_DIR', 'GIT_WORK_TREE']) delete env[key]
    try {
      const helpers = 'packages/core-backend/tests/helpers'
      const fixturePath = path.join(temporary, 'packages/core-backend/tests/fixtures/security-events/directory-closure.json')
      const sourcePath = 'packages/core-backend/src/directory/observation-fixture.ts'
      mkdirSync(path.join(temporary, helpers), { recursive: true })
      mkdirSync(path.dirname(fixturePath), { recursive: true })
      mkdirSync(path.dirname(path.join(temporary, sourcePath)), { recursive: true })
      symlinkSync(path.join(root, 'node_modules'), dependencies, 'dir')
      for (const name of ['regenerate-security-events-directory', 'security-events-directory-closure', 'runtime-module-closure', 'import-edge-allowlist']) {
        copyFileSync(path.join(root, helpers, name + '.ts'), path.join(temporary, helpers, name + '.ts'))
      }
      writeFileSync(fixturePath, JSON.stringify({ version: 2, contracts: [], edges: [], closure: [], population: [] }))
      const source = "import '../security-events/directory-observations'\n"
      writeFileSync(path.join(temporary, sourcePath), source)
      execFileSync('git', ['init', '-q', temporary], { env })
      execFileSync('git', ['-C', temporary, 'add', sourcePath], { env })
      const run = (arg: string) => spawnSync(process.execPath, ['--import', 'tsx', helpers + '/regenerate-security-events-directory.ts', arg],
        { cwd: temporary, env, encoding: 'utf8' })
      expect(run('--write').status).toBe(0)
      expect(run('--check').status).toBe(0)
      for (const [text, action] of [[source + source, 'added'], [source, 'removed']]) {
        writeFileSync(path.join(temporary, sourcePath), text)
        const result = run('--write')
        expect(result.status, result.stderr).toBe(0)
        const changes = result.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(item => item.section === 'edges')
        expect(changes).toEqual([{ section: 'edges', [action]: expect.any(Array) }])
      }
      const registered = readFileSync(fixturePath, 'utf8')
      writeFileSync(path.join(temporary, 'packages/core-backend/src/directory/extra.ts'), source)
      for (const arg of ['--check', '--write']) {
        const result = run(arg)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('EVENT_UNINDEXED_SOURCES')
        expect(readFileSync(fixturePath, 'utf8')).toBe(registered)
      }
    } finally {
      try { unlinkSync(dependencies) } catch { /* Setup may not have created the link. */ }
      rmSync(temporary, { recursive: true, force: true })
    }
  })
  it.each([
    "import { eventRepository } from '../security-events/process-store'",
    "import { SecurityEventRepository } from '../security-events/repository'",
    "import type { DirectoryRunObservation } from '../security-events/repository'",
    "import { EventConnections } from '../security-events/runtime'",
    "export { eventRepository } from '../security-events/process-store'",
    "const store = require('@/security-events/process-store')",
    "import { eventRepository } from '@metasheet/core-backend/src/security-events/process-store'",
    "import type { DirectoryRunObservation } from '@metasheet/core-backend/src/security-events/repository'",
    "import('@metasheet/core-backend/src/security-events/runtime.js')",
    "require('@metasheet/core-backend/dist/security-events/process-store.js')",
    "export * from '@metasheet/core-backend/dist/security-events/repository'",
  ])('requires the public entry point even after registration is regenerated: %s', source => {
    const changed = new Map(sources).set('packages/core-backend/src/directory/observation-fixture.ts', source)
    const regenerated = regenerateDirectoryFixture(changed, fixture)
    expect(regenerated.edges).toEqual(eventEdges(changed))
    expect(eventImportViolations(regenerated.edges)).toHaveLength(1)
  })
  it.each([
    { kind: 'import', typeOnly: false, pattern: "import * as observations from 'PUBLIC_ENTRY'" },
    { kind: 'import', typeOnly: true, pattern: "import type * as observations from 'PUBLIC_ENTRY'" },
    { kind: 'dynamic-import', typeOnly: false, pattern: "import('PUBLIC_ENTRY')" },
  ])('resolves the public entry across import paths ($kind, type-only $typeOnly)', ({ kind, typeOnly, pattern }) => {
    const file = 'packages/core-backend/src/directory/observation-fixture.ts'
    const target = 'packages/core-backend/src/security-events/directory-observations'
    const specifiers = [
      '../security-events/directory-observations',
      '@metasheet/core-backend/src/security-events/directory-observations',
      '@metasheet/core-backend/dist/security-events/directory-observations.js',
    ]
    for (const specifier of specifiers) {
      const source = pattern.replace('PUBLIC_ENTRY', specifier)
      const edges = eventEdges(new Map([[file, source]]))
      const digest = createHash('sha256').update(source).digest('hex')
      expect(edges).toEqual([[file, target, kind, String(typeOnly), '<module>', digest]])
      expect(eventImportViolations(edges)).toEqual([])
    }
  })

  it('accepts the public observation entry point', () => {
    const changed = new Map(sources).set('packages/core-backend/src/directory/observation-fixture.ts', "import { recordDirectoryRunObservation } from '../security-events/directory-observations'")
    expect(eventImportViolations(eventEdges(changed))).toEqual([])
  })
  it.each([
    "db.insertInto('security_events')", "db.deleteFrom('security_event_deliveries')",
    "db.insertInto('public.security_events')", "db.updateTable('public.security_event_deliveries')",
    'db.insertInto(`security_events`)',
    "db.selectFrom('security_events as e')", "db.deleteFrom('security_event_deliveries as d')",
    "query('DELETE FROM ONLY security_events')", "query('COPY security_events TO STDOUT')",
    "query('SELECT * FROM /* fixture */ security_events')",
  ])('keeps literal event tables inside the event implementation: %s', source => {
    expect(eventSqlViolations(new Map([['packages/core-backend/src/directory/observation-fixture.ts', source]]))).toHaveLength(1)
  })
  it('keeps other table identifiers distinct', () => {
    expect(eventSqlViolations(new Map([['packages/core-backend/src/directory/observation-fixture.ts',
      "query('SELECT * FROM audit_security_events'); db.selectFrom('security_events_archive')"]]))).toEqual([])
  })
  it.each(['INSERT INTO public.security_events', 'UPDATE public.security_event_deliveries', 'DELETE FROM "public"."security_events"'])('rejects event-table SQL outside the registered implementation: %s', sql => {
    const changed = new Map(sources).set('packages/core-backend/src/directory/observation-fixture.ts', `query('${sql} fixture')`)
    expect(eventSqlViolations(changed)).not.toEqual([])
  })
  it('rejects a second process budget provider', () => {
    const changed = new Map(sources).set('packages/core-backend/src/directory/observation-fixture.ts', 'new EventRetryBuffer()')
    expect(processStoreViolations(changed)).not.toEqual([])
  })
  it.each([
    "import { EventConnections } from '../security-events/runtime'; new EventConnections({connectionString: 'fixture'}).writeTransaction('foreground', sql => sql.query('SELECT 1'))",
    "import { EventConnections } from '../security-events/runtime'; const pool = new EventConnections({connectionString: 'fixture'}); (pool as unknown as {write: {run: Function}}).write.run(1, () => {})",
    "import { EventConnections } from '../security-events/runtime'; new EventConnections({connectionString: 'fixture'}, config => makeClient(config))",
    "export { EventConnections as Connection } from '../security-events/runtime'",
    "const name = '../security-events/runtime'; import(name)",
    "const load = require; const { EventConnections } = load('../security-events/runtime')",
  ])('detects an additional SQL-capable producer import', source => {
    const changed = new Map(sources).set('packages/core-backend/src/directory/observation-fixture.ts', source)
    expect(eventEdges(changed)).not.toEqual(fixture.edges)
  })
  it('detects callback exports and changes inside the implementation closure', () => {
    const changed = new Map(sources).set(entry, sources.get(entry) + '\nexport function withConnection(work: (value: unknown) => void): void { work(store()) }')
    expect(entryViolations(changed)).toContain('export set')
    expect(eventClosure(changed)).not.toEqual(fixture.closure)
  })
  it.each([
    'logger.warn("fixture")',
    'auditLog({ action: "fixture" })',
    'query("INSERT INTO audit_logs (action) VALUES ($1)", ["fixture"])',
    'import { auditLog as writeAudit } from "../audit/audit"; writeAudit({ action: "fixture" })',
  ])('detects a new unregistered source', source => {
    const changed = new Map(sources).set('packages/core-backend/src/directory/observation-fixture.ts', source)
    expect(sourcePopulation(changed)).not.toEqual(sourcePopulation(sources))
  })
})

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import type { PluginContext } from '../../src/types/plugin'

// #6315 host boundary 1 at the host's own context builder: the private YiDa owner/initialization
// capabilities are created for the exact manifest name plugin-integration-core and for nothing else.
// The real-boot counterpart (a near-miss fixture plugin loaded next to the real core plugin) is
// tests/integration/yida-host-boundaries-realdb.test.ts.
type ContextBuilder = { createPluginContext: (loaded: unknown) => PluginContext }

function servicesFor(name: string): Record<string, unknown> {
  // A fresh host per name: creating the core capability advances that host's runtime generation,
  // so no name below is ever evaluated on a host another name has already touched.
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
  const context = (server as unknown as ContextBuilder).createPluginContext({
    manifest: { name, version: '0.0.0' },
    path: `/nonexistent/${name}`,
  })
  return context.services as unknown as Record<string, unknown>
}

// Every plugin manifest name the repo ships, read the way PluginLoader reads a plugin directory
// (plugin.json first, then manifest.json), from both containers the host may scan. Read-only.
function repoPluginNames(): string[] {
  const root = path.resolve(__dirname, '..', '..', '..', '..')
  const names = new Set<string>()
  for (const container of ['plugins', 'packages/core-backend/plugins']) {
    const dir = path.join(root, container)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifestPath = ['plugin.json', 'manifest.json']
        .map(file => path.join(dir, entry.name, file))
        .find(candidate => existsSync(candidate))
      if (!manifestPath) continue
      const name = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }).name
      if (typeof name === 'string') names.add(name)
    }
  }
  return [...names].sort()
}

describe('YiDa host capability injection scoping', () => {
  it('injects all three YiDa capabilities into plugin-integration-core', () => {
    const services = servicesFor('plugin-integration-core')
    for (const key of ['yidaOwnerRuntime', 'yidaInitializationRuntime', 'yidaConnectionTestRuntime']) {
      const capability = services[key] as { activate?: unknown } | undefined
      expect(capability, key).toBeDefined()
      expect(typeof capability?.activate, key).toBe('function')
    }
  })

  it.each([
    'plugin-integration-core-shadow',
    'plugin-integration-core-x',
    'Plugin-Integration-Core',
    ' plugin-integration-core',
    'plugin-integration-core ',
    'plugin-integration',
    'plugin-some-other',
  ])('withholds all three YiDa capabilities from %j', name => {
    const services = servicesFor(name)
    // Positive control: the same context builder did produce the shared services.
    expect(typeof services.security).toBe('object')
    expect(services.yidaOwnerRuntime).toBeUndefined()
    expect(services.yidaInitializationRuntime).toBeUndefined()
    expect(services.yidaConnectionTestRuntime).toBeUndefined()
  })

  it('withholds all three YiDa capabilities from every other plugin the repo ships', () => {
    const names = repoPluginNames()
    // Not vacuous: the scan found the core plugin and at least one real other plugin.
    expect(names).toContain('plugin-integration-core')
    expect(names.filter(name => name !== 'plugin-integration-core').length).toBeGreaterThan(0)
    const holders = names.filter(name => {
      const services = servicesFor(name)
      expect(typeof services.security, name).toBe('object')
      return services.yidaOwnerRuntime !== undefined || services.yidaInitializationRuntime !== undefined
        || services.yidaConnectionTestRuntime !== undefined
    })
    expect(holders).toEqual(['plugin-integration-core'])
  })
})

it('registers the host-boundary and connection-test real-PG proofs in the EXPECT_DB lane and excludes them from the no-DB runner', () => {
  const root = path.resolve(__dirname, '..', '..', '..', '..')
  const specs = [
    'tests/integration/yida-host-boundaries-realdb.test.ts',
    'tests/integration/yida-host-initialization-barrier-realdb.test.ts',
    'tests/integration/yida-host-connection-test-realdb.test.ts',
    'tests/integration/yida-connection-test-http-realdb.test.ts',
  ]
  const workflow = yaml.load(readFileSync(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8')) as {
    jobs: { test: { steps: Array<{ id?: string; if?: string; env?: Record<string, string>; run?: string; 'continue-on-error'?: unknown }> } }
  }
  const step = workflow.jobs.test.steps.find(entry => entry.id === 'external-system-delete-bind-lock-protocol-real-db')
  expect(step?.env?.EXPECT_DB).toBe('1')
  expect(step?.env?.DATABASE_URL).toBeTruthy()
  expect(step?.if).toBe("matrix.node-version == '20.x'")
  expect(step?.['continue-on-error']).toBeUndefined()
  // The same exact-token rule as plugins/plugin-integration-core/__tests__/yida-delivery-store.test.cjs,
  // which also pins this step's whole file list: the tokens before 'run' are exact and the reporter is
  // the only option after it, so no filter flag in any spelling vitest accepts can skip these DB cases.
  // Same bash-faithful join and split as the plugin guard, with the same printable-ASCII refusal.
  expect(step?.run ?? '').toMatch(/^[\x20-\x7e\n]*$/)
  const lines = (step?.run ?? '').replace(/\\\r?\n/g, '').split(/\r?\n/).filter(line => line.trim())
  expect(lines).toHaveLength(2)
  const tokens = lines[1].trim().split(/[ \t]+/)
  const runAt = tokens.indexOf('run')
  expect(tokens.slice(0, runAt + 1))
    .toEqual(['pnpm', '--filter', '@metasheet/core-backend', 'exec', 'vitest', '--config', 'vitest.integration.config.ts', 'run'])
  const files = tokens.slice(runAt + 1)
  expect(files.filter(token => token.startsWith('-'))).toEqual(['--reporter=verbose'])
  for (const spec of specs) expect(files.filter(token => token === spec), spec).toHaveLength(1)
  const config = ts.createSourceFile('vitest.config.ts', readFileSync(path.join(root, 'packages/core-backend/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const excluded = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const entry of node.initializer.elements) if (ts.isStringLiteral(entry)) excluded.add(entry.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(config)
  for (const spec of specs) expect(excluded.has(spec), spec).toBe(true)
})

it('the host reads its own default-OFF connection-test switch (exact literal), never the send switch', () => {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
  const runtime = (server as unknown as { yidaConnectionTestRuntime: { connectionTestEnabled(): boolean } }).yidaConnectionTestRuntime
  const saved = { test: process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED, send: process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED }
  try {
    delete process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED
    process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED = 'true'
    expect(runtime.connectionTestEnabled()).toBe(false)
    for (const value of ['false', 'TRUE', ' true', 'true ', '1']) {
      process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED = value
      expect(runtime.connectionTestEnabled(), value).toBe(false)
    }
    process.env.INTEGRATION_YIDA_CONNECTION_TEST_ENABLED = 'true'
    delete process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED
    expect(runtime.connectionTestEnabled()).toBe(true)
  } finally {
    for (const [key, value] of [['INTEGRATION_YIDA_CONNECTION_TEST_ENABLED', saved.test], ['INTEGRATION_YIDA_OWNER_SEND_ENABLED', saved.send]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})

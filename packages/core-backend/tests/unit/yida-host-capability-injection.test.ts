import { readFileSync } from 'node:fs'
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

describe('YiDa host capability injection scoping', () => {
  it('injects both YiDa capabilities into plugin-integration-core', () => {
    const services = servicesFor('plugin-integration-core')
    for (const key of ['yidaOwnerRuntime', 'yidaInitializationRuntime']) {
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
  ])('withholds both YiDa capabilities from %j', name => {
    const services = servicesFor(name)
    // Positive control: the same context builder did produce the shared services.
    expect(typeof services.security).toBe('object')
    expect(services.yidaOwnerRuntime).toBeUndefined()
    expect(services.yidaInitializationRuntime).toBeUndefined()
  })
})

it('registers both host-boundary real-PG proofs in the EXPECT_DB lane and excludes them from the no-DB runner', () => {
  const root = path.resolve(__dirname, '..', '..', '..', '..')
  const specs = [
    'tests/integration/yida-host-boundaries-realdb.test.ts',
    'tests/integration/yida-host-initialization-barrier-realdb.test.ts',
  ]
  const workflow = yaml.load(readFileSync(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8')) as {
    jobs: { test: { steps: Array<{ id?: string; if?: string; env?: Record<string, string>; run?: string; 'continue-on-error'?: unknown }> } }
  }
  const step = workflow.jobs.test.steps.find(entry => entry.id === 'external-system-delete-bind-lock-protocol-real-db')
  expect(step?.env?.EXPECT_DB).toBe('1')
  expect(step?.env?.DATABASE_URL).toBeTruthy()
  expect(step?.if).toBe("matrix.node-version == '20.x'")
  expect(step?.['continue-on-error']).toBeUndefined()
  const command = (step?.run ?? '').replace(/\\\r?\n/g, ' ')
  expect(command).toMatch(/vitest --config vitest\.integration\.config\.ts run /)
  for (const spec of specs) expect(command.split(/\s+/).filter(token => token === spec), spec).toHaveLength(1)
  expect(command).not.toMatch(/(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests)(?:\s|=|$)/)
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

import { describe, expect, it } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import type { PluginContext } from '../../src/types/plugin'

type ContextBuilder = { createPluginContext: (loaded: unknown) => PluginContext }

function contextFor(name: string): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
  return (server as unknown as ContextBuilder).createPluginContext({
    manifest: { name, version: '0.0.0' },
    path: `/nonexistent/${name}`,
  })
}

describe('sealed snapshot SQL Server connection capability scoping', () => {
  it('is injected only into plugin-integration-core', () => {
    const services = contextFor('plugin-integration-core').services as Record<string, unknown>
    const capability = services.dataSourceSealedSnapshotConnections as {
      resolveSqlServerConnection?: unknown
    } | undefined
    expect(capability).toBeDefined()
    expect(typeof capability?.resolveSqlServerConnection).toBe('function')
  })

  it('is absent from every other plugin', () => {
    const services = contextFor('plugin-some-other').services as Record<string, unknown>
    expect(services.dataSourceSealedSnapshotConnections).toBeUndefined()
  })
})

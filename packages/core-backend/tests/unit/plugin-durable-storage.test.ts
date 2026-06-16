import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createHostPluginStorage,
  createMemoryPluginStorage,
  createPluginDurableStorage,
  PluginDurableStorageError,
  type PluginStorageQuery,
} from '../../src/plugins/plugin-durable-storage'

function createFakeQuery(): { query: PluginStorageQuery; calls: Array<{ sql: string; params?: unknown[] }> } {
  const rows = new Map<string, unknown>()
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const storageKey = (pluginName: unknown, key: unknown) => `${String(pluginName)}\0${String(key)}`

  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (sql.includes('INSERT INTO plugin_kv')) {
        const [pluginName, key, value] = params ?? []
        rows.set(storageKey(pluginName, key), JSON.parse(String(value)))
        return { rows: [] }
      }
      if (sql.includes('SELECT value')) {
        const [pluginName, key] = params ?? []
        const found = rows.get(storageKey(pluginName, key))
        return { rows: found === undefined ? [] : [{ value: found }] }
      }
      if (sql.includes('DELETE FROM plugin_kv') && sql.includes('RETURNING value')) {
        const [pluginName, key] = params ?? []
        const mapKey = storageKey(pluginName, key)
        const found = rows.get(mapKey)
        rows.delete(mapKey)
        return { rows: found === undefined ? [] : [{ value: found }] }
      }
      if (sql.includes('DELETE FROM plugin_kv')) {
        const [pluginName, key] = params ?? []
        rows.delete(storageKey(pluginName, key))
        return { rows: [] }
      }
      if (sql.includes('SELECT key')) {
        const [pluginName] = params ?? []
        const prefix = `${String(pluginName)}\0`
        const keys = Array.from(rows.keys())
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key: key.slice(prefix.length) }))
          .sort((left, right) => left.key.localeCompare(right.key))
        return { rows: keys }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  }
}

describe('plugin durable storage', () => {
  it('persists plugin-integration-core storage across instances', async () => {
    const db = createFakeQuery()
    const first = createPluginDurableStorage({ pluginName: 'plugin-integration-core', query: db.query })
    const second = createPluginDurableStorage({ pluginName: 'plugin-integration-core', query: db.query })

    expect(first.durable).toBe(true)

    await first.set('tenant-a/workspace-a/action-a/job-1', {
      public: { status: 'running', counts: { rowsExpanded: 44 } },
      private: { rows: [{ sourceCode: 'kept-private' }] },
    })

    await expect(second.get('tenant-a/workspace-a/action-a/job-1')).resolves.toEqual({
      public: { status: 'running', counts: { rowsExpanded: 44 } },
      private: { rows: [{ sourceCode: 'kept-private' }] },
    })

    expect(db.calls[0].params).toEqual([
      'plugin-integration-core',
      'tenant-a/workspace-a/action-a/job-1',
      JSON.stringify({
        public: { status: 'running', counts: { rowsExpanded: 44 } },
        private: { rows: [{ sourceCode: 'kept-private' }] },
      }),
    ])
  })

  it('stores scoped large-BOM keys longer than the legacy varchar(255) limit', async () => {
    const db = createFakeQuery()
    const storage = createPluginDurableStorage({ pluginName: 'plugin-integration-core', query: db.query })
    const longKey = [
      'integration:large-bom:background',
      `tenant-${'t'.repeat(80)}`,
      `workspace-${'w'.repeat(80)}`,
      `action-${'a'.repeat(80)}`,
      `job-${'j'.repeat(80)}`,
    ].join(':')

    expect(longKey.length).toBeGreaterThan(255)

    await storage.set(longKey, { status: 'queued' })
    await expect(storage.get(longKey)).resolves.toEqual({ status: 'queued' })
  })

  it('atomically consumes a stored value via delete returning', async () => {
    const db = createFakeQuery()
    const storage = createPluginDurableStorage({ pluginName: 'plugin-integration-core', query: db.query })

    await storage.set('dry-run-token', { revision: 'rev_1' })

    await expect(storage.consume?.('dry-run-token')).resolves.toEqual({ revision: 'rev_1' })
    await expect(storage.consume?.('dry-run-token')).resolves.toBeNull()
    await expect(storage.get('dry-run-token')).resolves.toBeNull()
    expect(db.calls.some((call) => call.sql.includes('DELETE FROM plugin_kv') && call.sql.includes('RETURNING value'))).toBe(true)
  })

  it('scopes list/get/delete by plugin name', async () => {
    const db = createFakeQuery()
    const integration = createPluginDurableStorage({ pluginName: 'plugin-integration-core', query: db.query })
    const other = createPluginDurableStorage({ pluginName: 'plugin-other', query: db.query })

    await integration.set('same-key', { owner: 'integration' })
    await other.set('same-key', { owner: 'other' })
    await integration.set('b-key', { ok: true })

    await expect(integration.get('same-key')).resolves.toEqual({ owner: 'integration' })
    await expect(other.get('same-key')).resolves.toEqual({ owner: 'other' })
    await expect(integration.list()).resolves.toEqual(['b-key', 'same-key'])

    await integration.delete('same-key')

    await expect(integration.get('same-key')).resolves.toBeNull()
    await expect(other.get('same-key')).resolves.toEqual({ owner: 'other' })
  })

  it('keeps non-integration plugins on non-durable memory storage', async () => {
    const db = createFakeQuery()
    const storage = createHostPluginStorage({ pluginName: 'plugin-attendance', query: db.query })

    expect(storage.durable).toBe(false)

    await storage.set('k', { v: 1 })
    await expect(storage.get('k')).resolves.toEqual({ v: 1 })
    expect(db.calls).toEqual([])
  })

  it('injects durable storage only for plugin-integration-core', async () => {
    const db = createFakeQuery()
    const storage = createHostPluginStorage({ pluginName: 'plugin-integration-core', query: db.query })

    expect(storage.durable).toBe(true)

    await storage.set('large-bom/job', { status: 'queued' })
    await expect(storage.get('large-bom/job')).resolves.toEqual({ status: 'queued' })
    expect(db.calls.length).toBeGreaterThan(0)
  })

  it('keeps memory storage process-local and explicitly non-durable', async () => {
    const first = createMemoryPluginStorage()
    const second = createMemoryPluginStorage()

    expect(first.durable).toBe(false)

    await first.set('k', { v: 1 })
    await expect(first.get('k')).resolves.toEqual({ v: 1 })
    await expect(second.get('k')).resolves.toBeNull()
  })

  it('wraps backing-store failures without exposing key or value details', async () => {
    const storage = createPluginDurableStorage({
      pluginName: 'plugin-integration-core',
      async query() {
        throw new Error('relation "plugin_kv" does not exist for project P-001 and component PART-A')
      },
    })

    await expect(storage.get('tenant/workspace/action/job/P-001/PART-A')).rejects.toMatchObject({
      name: 'PluginDurableStorageError',
      code: 'PLUGIN_DURABLE_STORAGE_UNAVAILABLE',
      status: 501,
      details: {
        pluginName: 'plugin-integration-core',
        operation: 'get',
      },
    } satisfies Partial<PluginDurableStorageError>)
    await expect(storage.get('tenant/workspace/action/job/P-001/PART-A')).rejects.not.toMatchObject({
      details: expect.objectContaining({
        key: expect.anything(),
      }),
    })
  })

  it('widens plugin_kv keys for scoped large-BOM job ids', async () => {
    const currentFile = fileURLToPath(import.meta.url)
    const migrationPath = path.resolve(
      path.dirname(currentFile),
      '../../src/db/migrations/zzzz20260610140000_widen_plugin_kv_key.ts',
    )

    const source = await readFile(migrationPath, 'utf8')

    expect(source).toContain('CREATE TABLE IF NOT EXISTS plugin_kv')
    expect(source).toContain('ALTER TABLE plugin_kv ALTER COLUMN key TYPE text')
    expect(source).toContain('CREATE INDEX IF NOT EXISTS idx_plugin_kv_plugin')
    expect(source).toContain('ALTER TABLE IF EXISTS plugin_kv ALTER COLUMN key TYPE varchar(255)')
  })
})

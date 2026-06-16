import type { QueryResult } from 'pg'
import type { PluginStorage } from '../types/plugin'

export type PluginStorageQuery = (sql: string, params?: unknown[]) => Promise<Pick<QueryResult, 'rows'>>

interface DurableStorageOptions {
  pluginName: string
  query: PluginStorageQuery
}

interface HostPluginStorageOptions {
  pluginName: string
  query: PluginStorageQuery
}

export interface DurablePluginStorage extends PluginStorage {
  durable: true
}

export interface MemoryPluginStorage extends PluginStorage {
  durable: false
}

export class PluginDurableStorageError extends Error {
  code = 'PLUGIN_DURABLE_STORAGE_UNAVAILABLE'
  status = 501
  details: { pluginName: string; operation: string }

  constructor(pluginName: string, operation: string, cause?: unknown) {
    super('plugin durable storage is unavailable')
    this.name = 'PluginDurableStorageError'
    this.details = { pluginName, operation }
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

function normalizeStorageKey(key: string): string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('plugin storage key is required')
  }
  return key
}

function serializeStorageValue(value: unknown): string {
  if (value === undefined) {
    throw new Error('plugin storage value must be JSON-serializable')
  }
  return JSON.stringify(value)
}

async function runStorageQuery(
  pluginName: string,
  operation: string,
  query: PluginStorageQuery,
  sql: string,
  params?: unknown[],
): Promise<Pick<QueryResult, 'rows'>> {
  try {
    return await query(sql, params)
  } catch (error) {
    throw new PluginDurableStorageError(pluginName, operation, error)
  }
}

export function createMemoryPluginStorage(): MemoryPluginStorage {
  const storageCache = new Map<string, unknown>()
  return {
    durable: false,
    async get<T = unknown>(key: string): Promise<T | null> {
      const storageKey = normalizeStorageKey(key)
      if (!storageCache.has(storageKey)) return null
      return storageCache.get(storageKey) as T
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      storageCache.set(normalizeStorageKey(key), value)
    },
    async consume<T = unknown>(key: string): Promise<T | null> {
      const storageKey = normalizeStorageKey(key)
      if (!storageCache.has(storageKey)) return null
      const value = storageCache.get(storageKey) as T
      storageCache.delete(storageKey)
      return value
    },
    async delete(key: string): Promise<void> {
      storageCache.delete(normalizeStorageKey(key))
    },
    async list(): Promise<string[]> {
      return Array.from(storageCache.keys()).sort()
    },
  }
}

export function createPluginDurableStorage(options: DurableStorageOptions): DurablePluginStorage {
  const pluginName = normalizeStorageKey(options.pluginName)
  const query = options.query

  return {
    durable: true,
    async get<T = unknown>(key: string): Promise<T | null> {
      const storageKey = normalizeStorageKey(key)
      const result = await runStorageQuery(
        pluginName,
        'get',
        query,
        `SELECT value
           FROM plugin_kv
          WHERE plugin = $1 AND key = $2`,
        [pluginName, storageKey],
      )
      if (result.rows.length === 0) return null
      return (result.rows[0] as { value: T }).value
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      const storageKey = normalizeStorageKey(key)
      const serialized = serializeStorageValue(value)
      await runStorageQuery(
        pluginName,
        'set',
        query,
        `INSERT INTO plugin_kv (plugin, key, value, updated_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (plugin, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [pluginName, storageKey, serialized],
      )
    },
    async consume<T = unknown>(key: string): Promise<T | null> {
      const result = await runStorageQuery(
        pluginName,
        'consume',
        query,
        `DELETE FROM plugin_kv
          WHERE plugin = $1 AND key = $2
          RETURNING value`,
        [pluginName, normalizeStorageKey(key)],
      )
      if (result.rows.length === 0) return null
      return (result.rows[0] as { value: T }).value
    },
    async delete(key: string): Promise<void> {
      await runStorageQuery(
        pluginName,
        'delete',
        query,
        `DELETE FROM plugin_kv
          WHERE plugin = $1 AND key = $2`,
        [pluginName, normalizeStorageKey(key)],
      )
    },
    async list(): Promise<string[]> {
      const result = await runStorageQuery(
        pluginName,
        'list',
        query,
        `SELECT key
           FROM plugin_kv
          WHERE plugin = $1
          ORDER BY key ASC`,
        [pluginName],
      )
      return result.rows.map((row) => String((row as { key: string }).key))
    },
  }
}

export function createHostPluginStorage(options: HostPluginStorageOptions): PluginStorage {
  if (options.pluginName === 'plugin-integration-core') {
    return createPluginDurableStorage(options)
  }
  return createMemoryPluginStorage()
}

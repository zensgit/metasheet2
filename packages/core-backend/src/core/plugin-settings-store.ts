import { poolManager } from '../integration/db/connection-pool'
import { Logger } from './logger'

const logger = new Logger('PluginSettingsStore')

const ENABLED_KEY = 'enabled'

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
  }
  return undefined
}

export async function getPluginSetting(pluginName: string, key: string): Promise<unknown | null> {
  try {
    const res = await poolManager.get().query(
      'SELECT value FROM plugin_kv WHERE "plugin" = $1 AND "key" = $2 LIMIT 1',
      [pluginName, key]
    )
    if (res.rows.length === 0) return null
    return res.rows[0]?.value ?? null
  } catch (error) {
    logger.warn(`Failed to read plugin setting ${pluginName}.${key}`)
    return null
  }
}

export async function setPluginSetting(pluginName: string, key: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value ?? null)
  await poolManager.get().query(
    `INSERT INTO plugin_kv ("plugin", "key", value, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW(), NOW())
     ON CONFLICT ("plugin", "key")
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [pluginName, key, payload]
  )
}

export async function getPluginEnabledMap(pluginNames: string[]): Promise<Map<string, boolean>> {
  const defaults = new Map(pluginNames.map(name => [name, true]))
  if (pluginNames.length === 0) return defaults

  try {
    const res = await poolManager.get().query(
      'SELECT "plugin", value FROM plugin_kv WHERE "key" = $1 AND "plugin" = ANY($2)',
      [ENABLED_KEY, pluginNames]
    )
    for (const row of res.rows) {
      const parsed = normalizeBoolean(row.value)
      if (parsed !== undefined) {
        defaults.set(row.plugin as string, parsed)
      }
    }
  } catch (error) {
    logger.warn('Failed to read plugin enabled flags')
  }

  return defaults
}

export async function getPluginEnabled(pluginName: string): Promise<boolean> {
  const value = await getPluginSetting(pluginName, ENABLED_KEY)
  const parsed = normalizeBoolean(value)
  return parsed !== undefined ? parsed : true
}

export { ENABLED_KEY }

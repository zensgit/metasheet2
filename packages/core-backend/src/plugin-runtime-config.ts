const INTEGRATION_CORE_PLUGIN_NAME = 'plugin-integration-core'
const INTEGRATION_CORE_STOCK_ACTIONS_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON'
const INTEGRATION_CORE_TABLE_ACTIONS_ENV = 'INTEGRATION_CORE_TABLE_ACTIONS_JSON'

function parsePluginJsonEnv(env: NodeJS.ProcessEnv, key: string): unknown {
  const raw = env[key]
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${key} must be valid JSON`)
  }
}

function assertPluginActionConfigShape(value: unknown, key: string): unknown {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return value
  throw new Error(`${key} must be a JSON array or object`)
}

export function resolvePluginRuntimeConfig(
  manifestName: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  if (manifestName !== INTEGRATION_CORE_PLUGIN_NAME) return {}

  const stockPreparationTableActions = assertPluginActionConfigShape(
    parsePluginJsonEnv(env, INTEGRATION_CORE_STOCK_ACTIONS_ENV),
    INTEGRATION_CORE_STOCK_ACTIONS_ENV
  )
  const tableActions = assertPluginActionConfigShape(
    parsePluginJsonEnv(env, INTEGRATION_CORE_TABLE_ACTIONS_ENV),
    INTEGRATION_CORE_TABLE_ACTIONS_ENV
  )

  return {
    ...(tableActions !== undefined ? { tableActions } : {}),
    ...(stockPreparationTableActions !== undefined ? { stockPreparationTableActions } : {}),
  }
}

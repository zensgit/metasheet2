const INTEGRATION_CORE_PLUGIN_NAME = 'plugin-integration-core'
const INTEGRATION_CORE_STOCK_ACTIONS_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON'
const INTEGRATION_CORE_TABLE_ACTIONS_ENV = 'INTEGRATION_CORE_TABLE_ACTIONS_JSON'
const INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_ENV = 'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON'
const C6_TEST_FAILURE_INJECTION_ENABLED_ENV = 'METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED'

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

function assertPluginObjectConfigShape(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  throw new Error(`${key} must be a JSON object`)
}

function parseBooleanEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = env[key]
  if (typeof raw !== 'string' || raw.trim().length === 0) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === 'true' || normalized === '1'
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
  const c6TestFailureInjection = assertPluginObjectConfigShape(
    parsePluginJsonEnv(env, INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_ENV),
    INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_ENV
  )
  const c6TestFailureInjectionDeployEnabled = parseBooleanEnv(env, C6_TEST_FAILURE_INJECTION_ENABLED_ENV)

  return {
    ...(tableActions !== undefined ? { tableActions } : {}),
    ...(stockPreparationTableActions !== undefined ? { stockPreparationTableActions } : {}),
    ...(c6TestFailureInjection !== undefined || c6TestFailureInjectionDeployEnabled
      ? {
          c6TestFailureInjection: {
            ...(c6TestFailureInjection || {}),
            deployEnabled: c6TestFailureInjectionDeployEnabled,
          },
        }
      : {}),
  }
}

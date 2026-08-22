const INTEGRATION_CORE_PLUGIN_NAME = 'plugin-integration-core'
const INTEGRATION_CORE_STOCK_ACTIONS_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON'
const INTEGRATION_CORE_TABLE_ACTIONS_ENV = 'INTEGRATION_CORE_TABLE_ACTIONS_JSON'
const INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_ENV = 'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON'
const C6_TEST_FAILURE_INJECTION_ENABLED_ENV = 'METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED'
const INTEGRATION_CORE_CUSTOMER_PACKS_PATH_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH'

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

/**
 * Customer packs are deploy-time DATA, not settings: a real pack carries ~20 extension columns and
 * dictionaries running to hundreds of entries, which is why the catalog module takes one whole
 * object off server config and deliberately offers no env fallback ("an environment variable cannot
 * carry a pack"). So the env var names a FILE, and the host reads it into that single config key.
 *
 * Fail-closed at both ends: unset -> the key is omitted -> the catalog is empty -> every packId is
 * refused (there is no "allow everything" state). Set but unreadable/malformed/wrong-shape -> throw
 * at startup rather than silently degrade to an empty catalog, so a typo in the path cannot look
 * exactly like "no packs configured". A half-configured catalog must never become a partial one.
 *
 * The file is expected to be an uncommitted local file on the deployment's own machine — pack
 * contents are customer data and must not live in this repository.
 */
function readCustomerPackCatalogFile(env: NodeJS.ProcessEnv, key: string): Record<string, unknown> | undefined {
  const raw = env[key]
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const filePath = raw.trim()
  let contents: string
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    contents = (require('node:fs') as typeof import('node:fs')).readFileSync(filePath, 'utf8')
  } catch {
    // Values-free: the path itself is deployment topology, so it is named by ENV KEY, never echoed.
    throw new Error(`${key} points at a file that could not be read`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new Error(`${key} must point at a file containing valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must point at a JSON object keyed by packId`)
  }
  return parsed as Record<string, unknown>
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
  const stockPreparationCustomerPacks = readCustomerPackCatalogFile(env, INTEGRATION_CORE_CUSTOMER_PACKS_PATH_ENV)

  return {
    ...(tableActions !== undefined ? { tableActions } : {}),
    ...(stockPreparationTableActions !== undefined ? { stockPreparationTableActions } : {}),
    ...(stockPreparationCustomerPacks !== undefined ? { stockPreparationCustomerPacks } : {}),
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

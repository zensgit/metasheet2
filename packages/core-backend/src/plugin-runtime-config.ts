const INTEGRATION_CORE_PLUGIN_NAME = 'plugin-integration-core'
const INTEGRATION_CORE_STOCK_ACTIONS_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON'
const INTEGRATION_CORE_TABLE_ACTIONS_ENV = 'INTEGRATION_CORE_TABLE_ACTIONS_JSON'
const INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_ENV = 'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON'
const C6_TEST_FAILURE_INJECTION_ENABLED_ENV = 'METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED'
const INTEGRATION_CORE_CUSTOMER_PACKS_PATH_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH'
const INTEGRATION_CORE_EXT_FIELD_MAPPING_PATH_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_EXT_FIELD_MAPPING_PATH'
const INTEGRATION_CORE_B2A_REGISTRY_PATH_ENV = 'INTEGRATION_CORE_B2A_REGISTRY_PATH'

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
 * Deploy-time DATA read out of a file the env var NAMES, as opposed to settings an env var can
 * carry inline.
 *
 * Customer packs were the first of these: a real pack carries ~20 extension columns and
 * dictionaries running to hundreds of entries, which is why the catalog module takes one whole
 * object off server config and deliberately offers no env fallback ("an environment variable cannot
 * carry a pack"). The source->`ext_` field mapping is the second: it is the same kind of artifact
 * (a reviewable object naming a tenant's own legacy column names) read by the same posture, so it
 * shares this reader rather than growing a parallel one that could drift from it.
 *
 * Fail-closed at both ends: unset -> the key is omitted -> the consuming catalog/mapping is empty
 * -> the capability is dormant (there is no "allow everything" state). Set but
 * unreadable/malformed/wrong-shape -> THROW rather than silently degrade to nothing, so a typo in
 * the path cannot look exactly like "nothing configured". A half-configured catalog must never
 * become a partial one.
 *
 * How far that throw travels is NOT this function's to promise, and an earlier version of this note
 * overstated it by saying "throw at startup". `resolvePluginRuntimeConfig` is called from plugin
 * activation, and the caller wraps plugin loading in a try/catch that logs and continues serving
 * (see the plugin-loading block in index.ts). So a bad path here fails the PLUGIN, loudly, in the
 * log — it does not stop the process. Anyone who needs boot to abort has to change that catch, not
 * this file.
 *
 * The file is expected to be an uncommitted local file on the deployment's own machine — pack and
 * mapping contents are customer data and must not live in this repository.
 *
 * `shapeDescription` is spelled by the caller so each key's error names the shape THAT key wants;
 * it is a fixed string per call site, never anything derived from the environment.
 */
function readDeployJsonObjectFile(
  env: NodeJS.ProcessEnv,
  key: string,
  shapeDescription: string
): Record<string, unknown> | undefined {
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
    throw new Error(`${key} must point at ${shapeDescription}`)
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
  const stockPreparationCustomerPacks = readDeployJsonObjectFile(
    env,
    INTEGRATION_CORE_CUSTOMER_PACKS_PATH_ENV,
    'a JSON object keyed by packId'
  )
  // The source->`ext_` mapping half of the same line. A pack says WHICH tenant columns exist; this
  // says WHERE their values come from. Without this key the mapper has no config, produces no
  // mapping, and the refresh path is byte-identical to a deployment that never heard of it.
  const stockPreparationExtFieldMapping = readDeployJsonObjectFile(
    env,
    INTEGRATION_CORE_EXT_FIELD_MAPPING_PATH_ENV,
    'a JSON object'
  )
  // B2a TRIAL REGISTRATION — the third artifact on this reader, and the one that ARMS a gate rather
  // than supplying data to one.
  //
  // The other two are inputs to a capability: without a pack there are no `ext_` columns, without a
  // mapping no `ext_` values. This one is the reverse. Unset -> the key is omitted -> the plugin's
  // registry is `null` -> the B2a gate is DORMANT and every stock-prep source read behaves exactly
  // as it did before this key existed (synthetic fixtures, local demos and the whole existing test
  // corpus are untouched). SET -> the gate is ARMED and every gated stock-prep read must match a
  // live, in-scope, unexpired registration or be refused before the source adapter is invoked.
  //
  // So "unreadable/malformed -> THROW" matters even more here than it does for the other two: a typo
  // in this path must never be indistinguishable from "no registry configured", because that
  // difference is the difference between a gate and no gate. The throw names the ENV KEY and never
  // echoes the path, same as its siblings.
  //
  // A registration file carries owner names, expiry dates and a customer's project numbers. It is a
  // reviewed, signed-off artifact that belongs in a file on the deployment's own machine — never
  // inline in a process environment where it cannot be diffed.
  const b2aTrialRegistry = readDeployJsonObjectFile(
    env,
    INTEGRATION_CORE_B2A_REGISTRY_PATH_ENV,
    'a JSON object with registryId, registryVersion and registrations'
  )

  return {
    ...(tableActions !== undefined ? { tableActions } : {}),
    ...(stockPreparationTableActions !== undefined ? { stockPreparationTableActions } : {}),
    ...(stockPreparationCustomerPacks !== undefined ? { stockPreparationCustomerPacks } : {}),
    ...(stockPreparationExtFieldMapping !== undefined ? { stockPreparationExtFieldMapping } : {}),
    ...(b2aTrialRegistry !== undefined ? { b2aTrialRegistry } : {}),
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

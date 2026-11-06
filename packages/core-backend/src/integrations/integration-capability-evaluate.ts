/**
 * Capability state for display: the pure evaluator and the non-locking reads behind it.
 *
 * NOT AUTHORITATIVE. The evaluator and `peekIntegrationCapabilityState` answer for the display route
 * and for tests only: the integration row and the capability row are read by two statements that may
 * come from different snapshots, and nothing is locked. A path that decides whether something may
 * happen must not call them.
 *
 * This module and the migration are the only source files that name the capability tables.
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import type {
  IntegrationCapability,
  IntegrationScope,
  ProviderCapabilityDescriptor,
} from './provider-capability-registry'

export type CapabilityReason =
  | 'switch_off'
  | 'schema_unavailable'
  | 'org_mismatch'
  | 'state_mismatch'
  | 'provider_not_registered'
  | 'governed_by_legacy_path'
  | 'unsupported'
  | 'implementation_missing'
  | 'not_enabled'
  | 'integration_inactive'
  | 'scope_changed'

/** One row of the capability table. `revision` is a bigint: the driver returns it as a string. */
export interface CapabilityRow {
  integration_id: string
  bound_provider: string
  bound_org_id: string
  directory_enabled: boolean
  directory_bound_tenant: string | null
  directory_bound_app_scope: string | null
  login_enabled: boolean
  login_bound_tenant: string | null
  login_bound_app_scope: string | null
  notification_enabled: boolean
  notification_bound_tenant: string | null
  notification_bound_app_scope: string | null
  revision: string | number
  created_by: string
  updated_by: string
  created_at: Date | string
  updated_at: Date | string
}

/** The integration columns the evaluator reads. */
export interface EvaluatedIntegration {
  id: string
  org_id: string
  provider: string
  status: string
  corp_id: string
  config: unknown
}

/** The integration columns the display route reads. */
export interface PeekedIntegration extends EvaluatedIntegration {
  sync_enabled: boolean
  schedule_cron: string | null
}

export interface EvaluateInput {
  capability: IntegrationCapability
  switchOn: boolean
  schemaAvailable: boolean
  descriptor: ProviderCapabilityDescriptor | null
  implementationAvailable: boolean
  /** Compared with the integration's organization when given. */
  expectedOrgId?: string
  integration: EvaluatedIntegration
  /** The capability row; null when there is none. */
  state: CapabilityRow | null
}

export type CapabilityEvaluation = { effective: boolean; reason: CapabilityReason | null }

export function isCapabilityEnabled(state: CapabilityRow, capability: IntegrationCapability): boolean {
  return state[`${capability}_enabled`] === true
}

export function capabilityAnchor(state: CapabilityRow, capability: IntegrationCapability): IntegrationScope | null {
  const tenant = state[`${capability}_bound_tenant`]
  const appScope = state[`${capability}_bound_app_scope`]
  if (typeof tenant !== 'string' || typeof appScope !== 'string') return null
  return { tenant, appScope }
}

function sameScope(left: IntegrationScope | null, right: IntegrationScope | null): boolean {
  return left !== null && right !== null && left.tenant === right.tenant && left.appScope === right.appScope
}

/**
 * Checks in a fixed order and returns the first failing reason:
 * switch, readable tables, organization, row pairing, provider registered, governance, implementation,
 * stored state, integration status, and finally the capability's own scope anchor.
 */
export function evaluateIntegrationCapability(input: EvaluateInput): CapabilityEvaluation {
  const refuse = (reason: CapabilityReason): CapabilityEvaluation => ({ effective: false, reason })
  if (!input.switchOn) return refuse('switch_off')
  if (!input.schemaAvailable) return refuse('schema_unavailable')
  const { integration, state, descriptor, capability } = input
  if (input.expectedOrgId !== undefined) {
    if (input.expectedOrgId.trim() === '' || input.expectedOrgId !== integration.org_id) return refuse('org_mismatch')
  }
  if (
    state !== null &&
    (state.integration_id !== integration.id ||
      state.bound_provider !== integration.provider ||
      state.bound_org_id !== integration.org_id)
  ) {
    return refuse('state_mismatch')
  }
  if (descriptor === null) return refuse('provider_not_registered')
  const governance = descriptor.governance[capability]
  if (governance === 'legacy') return refuse('governed_by_legacy_path')
  if (governance === 'unsupported') return refuse('unsupported')
  if (!input.implementationAvailable) return refuse('implementation_missing')
  if (state === null || !isCapabilityEnabled(state, capability)) return refuse('not_enabled')
  if (integration.status !== 'active') return refuse('integration_inactive')
  if (!sameScope(capabilityAnchor(state, capability), descriptor.scopeOf(integration))) return refuse('scope_changed')
  return { effective: true, reason: null }
}

const PROBE_SQL = `SELECT to_regclass('directory_integration_capabilities') IS NOT NULL AS capabilities, to_regclass('directory_integration_capability_history') IS NOT NULL AS history`

/**
 * Whether both capability tables exist. The probe cannot raise an undefined-table error, so it leaves
 * an open transaction usable.
 */
export async function probeCapabilityTables(executor: Queryable): Promise<boolean> {
  const result = await executor.query(PROBE_SQL)
  const row = result.rows[0]
  return row?.capabilities === true && row?.history === true
}

const INTEGRATION_SQL = `SELECT id::text AS id, org_id, provider, status, corp_id, config, sync_enabled, schedule_cron
  FROM directory_integrations WHERE id = $1::uuid`

const STATE_SQL = `SELECT integration_id::text AS integration_id, bound_provider, bound_org_id,
    directory_enabled, directory_bound_tenant, directory_bound_app_scope,
    login_enabled, login_bound_tenant, login_bound_app_scope,
    notification_enabled, notification_bound_tenant, notification_bound_app_scope,
    revision::text AS revision, created_by, updated_by, created_at, updated_at
  FROM directory_integration_capabilities WHERE integration_id = $1::uuid`

export interface PeekedState {
  integration: PeekedIntegration
  state: CapabilityRow | null
}

/**
 * Non-locking read of one integration and its capability row (display only; see the module comment).
 * Returns null when the integration does not exist.
 */
export async function peekIntegrationCapabilityState(
  executor: Queryable,
  integrationId: string,
): Promise<PeekedState | null> {
  const integrationResult = await executor.query(INTEGRATION_SQL, [integrationId])
  const integration = integrationResult.rows[0] as unknown as PeekedIntegration | undefined
  if (!integration) return null
  const stateResult = await executor.query(STATE_SQL, [integrationId])
  const state = (stateResult.rows[0] as unknown as CapabilityRow | undefined) ?? null
  return { integration, state }
}


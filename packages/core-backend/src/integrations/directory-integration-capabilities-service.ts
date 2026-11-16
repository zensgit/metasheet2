/**
 * Read side of the directory integration capabilities: builds the display view of one integration's
 * capability state. Display only: the view comes from the non-locking reads of
 * integration-capability-evaluate.ts and is not an authorization input.
 *
 * The view is built field by field and carries no scope value, no corp id, no application key, no
 * environment value and no configuration value.
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import {
  capabilityAnchor,
  evaluateIntegrationCapability,
  isCapabilityEnabled,
  peekIntegrationCapabilityState,
  probeCapabilityTables,
  type CapabilityReason,
  type CapabilityRow,
  type PeekedIntegration,
} from './integration-capability-evaluate'
import {
  INTEGRATION_CAPABILITIES,
  type CapabilityGovernance,
  type IntegrationCapability,
  type ProviderCapabilityDescriptor,
} from './provider-capability-registry'

export const WORK_NOTIFICATION_VERIFY_ROUTE = '/api/admin/directory/dingtalk/work-notification/verify'
export const WORK_NOTIFICATION_VERIFY_LEVELS = ['config', 'token', 'send'] as const

/** The four booleans of the login runtime status that the view shows (and nothing else of it). */
export interface LoginRuntimeBooleans {
  available: boolean
  requireGrant: boolean
  autoLinkEmail: boolean
  autoProvision: boolean
}

export interface CapabilitiesServiceDeps {
  readonly executor: Queryable
  isEnabled(): boolean
  resolveDescriptor(provider: string): ProviderCapabilityDescriptor | null
  isImplementationAvailable(provider: string, capability: IntegrationCapability): boolean
  /** Returns the whole runtime status or only the booleans; the service copies the four booleans. */
  readLoginRuntime(): LoginRuntimeBooleans
  isIntegrationScopedCredentialsEnabled(): boolean
}

export type DirectoryLegacyView = { syncEnabled: boolean; scheduleConfigured: boolean }
export type LoginLegacyView = {
  covers: 'oauth_scan_login_only'
  available: boolean
  requireGrant: boolean
  autoLinkEmail: boolean
  autoProvision: boolean
}
export type NotificationLegacyView = {
  integrationScopedCredentialsSwitch: boolean
  verification: { route: string; levels: readonly string[] }
}

export interface CapabilityView {
  enabled: boolean
  governance: CapabilityGovernance | null
  /** null: the state does not govern this capability (legacy, unsupported or unregistered provider). */
  effective: boolean | null
  reason: CapabilityReason | null
  anchor: { bound: boolean; matchesCurrent: boolean | null }
  legacy?: DirectoryLegacyView | LoginLegacyView | NotificationLegacyView
}

export interface CapabilitiesView {
  integrationId: string
  provider: string
  integrationStatus: string
  revision: number
  updatedAt: string | null
  capabilities: Record<IntegrationCapability, CapabilityView>
}

export type CapabilitiesReadResult =
  | { kind: 'disabled' }
  | { kind: 'schema_unavailable' }
  | { kind: 'not_found' }
  | { kind: 'ok'; view: CapabilitiesView }

export interface DirectoryIntegrationCapabilitiesService {
  isEnabled(): boolean
  read(integrationId: string): Promise<CapabilitiesReadResult>
}

/** A stored value that cannot be shown; the route answers with its fixed internal-error sentence. */
export class CapabilitiesViewError extends Error {
  constructor() {
    super('capability state is not displayable')
    this.name = 'CapabilitiesViewError'
  }
}

function revisionOf(state: CapabilityRow | null): number {
  if (state === null) return 0
  const raw = state.revision
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isSafeInteger(value) || value < 0 || (typeof raw === 'string' && String(value) !== raw)) {
    throw new CapabilitiesViewError()
  }
  return value
}

function updatedAtOf(state: CapabilityRow | null): string | null {
  if (state === null) return null
  const date = state.updated_at instanceof Date ? state.updated_at : new Date(state.updated_at)
  if (Number.isNaN(date.getTime())) throw new CapabilitiesViewError()
  return date.toISOString()
}

function legacyViewOf(
  deps: CapabilitiesServiceDeps,
  integration: PeekedIntegration,
  capability: IntegrationCapability,
): DirectoryLegacyView | LoginLegacyView | NotificationLegacyView | undefined {
  if (integration.provider !== 'dingtalk') return undefined
  if (capability === 'directory') {
    const cron = integration.schedule_cron
    return {
      syncEnabled: integration.sync_enabled === true,
      scheduleConfigured: typeof cron === 'string' && cron.trim() !== '',
    }
  }
  if (capability === 'login') {
    const runtime = deps.readLoginRuntime()
    return {
      covers: 'oauth_scan_login_only',
      available: runtime.available === true,
      requireGrant: runtime.requireGrant === true,
      autoLinkEmail: runtime.autoLinkEmail === true,
      autoProvision: runtime.autoProvision === true,
    }
  }
  return {
    integrationScopedCredentialsSwitch: deps.isIntegrationScopedCredentialsEnabled() === true,
    verification: { route: WORK_NOTIFICATION_VERIFY_ROUTE, levels: WORK_NOTIFICATION_VERIFY_LEVELS },
  }
}

function capabilityViewOf(
  deps: CapabilitiesServiceDeps,
  integration: PeekedIntegration,
  state: CapabilityRow | null,
  descriptor: ProviderCapabilityDescriptor | null,
  capability: IntegrationCapability,
): CapabilityView {
  const evaluation = evaluateIntegrationCapability({
    capability,
    switchOn: true,
    schemaAvailable: true,
    descriptor,
    implementationAvailable: deps.isImplementationAvailable(integration.provider, capability),
    integration,
    state,
  })
  const governance = descriptor === null ? null : descriptor.governance[capability]
  const anchor = state === null ? null : capabilityAnchor(state, capability)
  const current = descriptor === null ? null : descriptor.scopeOf(integration)
  const matchesCurrent =
    anchor === null || descriptor === null
      ? null
      : current !== null && current.tenant === anchor.tenant && current.appScope === anchor.appScope
  const view: CapabilityView = {
    enabled: state !== null && isCapabilityEnabled(state, capability),
    governance,
    effective: governance === 'gated' ? evaluation.effective : null,
    reason: evaluation.reason,
    anchor: { bound: anchor !== null, matchesCurrent },
  }
  if (governance === 'legacy') {
    const legacy = legacyViewOf(deps, integration, capability)
    if (legacy !== undefined) view.legacy = legacy
  }
  return view
}

export function createDirectoryIntegrationCapabilitiesService(
  deps: CapabilitiesServiceDeps,
): DirectoryIntegrationCapabilitiesService {
  return {
    isEnabled: () => deps.isEnabled(),
    async read(integrationId: string): Promise<CapabilitiesReadResult> {
      if (!deps.isEnabled()) return { kind: 'disabled' }
      if (!(await probeCapabilityTables(deps.executor))) return { kind: 'schema_unavailable' }
      const peeked = await peekIntegrationCapabilityState(deps.executor, integrationId)
      if (peeked === null) return { kind: 'not_found' }
      const { integration, state } = peeked
      const descriptor = deps.resolveDescriptor(integration.provider)
      const capabilities = {} as Record<IntegrationCapability, CapabilityView>
      for (const capability of INTEGRATION_CAPABILITIES) {
        capabilities[capability] = capabilityViewOf(deps, integration, state, descriptor, capability)
      }
      return {
        kind: 'ok',
        view: {
          integrationId: integration.id,
          provider: integration.provider,
          integrationStatus: integration.status,
          revision: revisionOf(state),
          updatedAt: updatedAtOf(state),
          capabilities,
        },
      }
    },
  }
}

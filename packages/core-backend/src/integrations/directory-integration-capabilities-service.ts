/**
 * Read side of the directory integration capabilities: builds the display view of one integration's
 * capability state. Display only: the view comes from the non-locking reads of
 * integration-capability-evaluate.ts and is not an authorization input. The write side
 * (directory-integration-capabilities-write-service.ts) answers with the same view, built by
 * `buildCapabilitiesView` from the rows it holds locked. The two differ in one case only: a provider
 * whose scope read throws fails the display read, and is shown as having no current scope in the
 * write answer.
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

/** The view inputs that do not come from the database; the write path builds the same view with them. */
export type CapabilitiesViewDeps = Pick<
  CapabilitiesServiceDeps,
  'resolveDescriptor' | 'isImplementationAvailable' | 'readLoginRuntime' | 'isIntegrationScopedCredentialsEnabled'
>

export interface CapabilitiesViewOptions {
  /**
   * True: a scope read that throws is shown like a scope that is not complete. A capability with a
   * stored anchor then reads as `scope_changed`, not effective and not matching. The display read
   * leaves this off and fails instead; the write answer sets it, because that view is built after the
   * write it reports.
   */
  readonly scopeReadFailureAsNoScope?: boolean
}

/**
 * The descriptor as a view reads it, with a scope read that answers null where the provider's would
 * throw. A view reads the governance and the scope only, so the enable preconditions are not carried.
 */
function withNonThrowingScopeRead(descriptor: ProviderCapabilityDescriptor): ProviderCapabilityDescriptor {
  return {
    provider: descriptor.provider,
    governance: descriptor.governance,
    secretConfigKeys: descriptor.secretConfigKeys,
    scopeOf: (row) => {
      try {
        return descriptor.scopeOf(row)
      } catch {
        return null
      }
    },
  }
}

/** The stored revision as an integer in 0..2^53-1 (0 when there is no row); throws for anything else. */
export function revisionOf(state: CapabilityRow | null): number {
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
  deps: CapabilitiesViewDeps,
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
  deps: CapabilitiesViewDeps,
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
  // The current scope is read only to compare it with a stored anchor. A capability without one (never
  // turned on, or turned off) does not ask the provider for a scope.
  let matchesCurrent: boolean | null = null
  if (anchor !== null && descriptor !== null) {
    const current = descriptor.scopeOf(integration)
    matchesCurrent = current !== null && current.tenant === anchor.tenant && current.appScope === anchor.appScope
  }
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

/**
 * The view of one integration row and its capability row (null when there is none). The read route
 * builds it from a non-locking read and the write route from the rows it holds locked; both answer
 * with this one shape. Both scope reads of a capability's view (its evaluation and the comparison
 * with its anchor) go through the one descriptor chosen here.
 */
export function buildCapabilitiesView(
  deps: CapabilitiesViewDeps,
  integration: PeekedIntegration,
  state: CapabilityRow | null,
  options: CapabilitiesViewOptions = {},
): CapabilitiesView {
  const resolved = deps.resolveDescriptor(integration.provider)
  const descriptor =
    resolved !== null && options.scopeReadFailureAsNoScope === true ? withNonThrowingScopeRead(resolved) : resolved
  const capabilities = {} as Record<IntegrationCapability, CapabilityView>
  for (const capability of INTEGRATION_CAPABILITIES) {
    capabilities[capability] = capabilityViewOf(deps, integration, state, descriptor, capability)
  }
  return {
    integrationId: integration.id,
    provider: integration.provider,
    integrationStatus: integration.status,
    revision: revisionOf(state),
    updatedAt: updatedAtOf(state),
    capabilities,
  }
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
      return { kind: 'ok', view: buildCapabilitiesView(deps, peeked.integration, peeked.state) }
    },
  }
}

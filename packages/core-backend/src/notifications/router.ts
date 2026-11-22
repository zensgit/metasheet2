/** Pure routing decisions. A snapshot contains metadata, never a recipient address. */
import { isWithinQuietHours, type QuietHours } from './quiet-hours'
import type { ResolveFailureCode } from './recipient-resolver'

export const ROUTER_VERSION = 1
export const RESOLVE_EXCLUSIONS = {
  connection_not_found: 'target_connection_not_found',
  connection_inactive: 'target_connection_inactive',
  provider_not_registered: 'target_provider_not_registered',
  proof_kind_unavailable: 'target_proof_kind_unavailable',
  proof_missing: 'target_proof_missing',
  proof_not_linked: 'target_proof_not_linked',
  proof_wrong_user: 'target_proof_wrong_user',
  proof_ambiguous: 'target_proof_ambiguous',
  proof_account_inactive: 'target_proof_account_inactive',
  proof_changed: 'target_proof_changed',
  proof_assurance_insufficient: 'target_proof_assurance_insufficient',
  address_missing: 'target_address_missing',
  address_unusable: 'target_address_unusable',
  address_kind_not_derivable: 'target_address_kind_not_derivable',
  address_bound_on_other_connection: 'target_address_bound_on_other_connection',
  scope_unproven: 'target_scope_unproven',
  scope_changed: 'target_scope_changed',
  user_not_active_member: 'target_user_not_active_member',
  endpoint_not_found: 'target_endpoint_not_found',
} as const satisfies Record<ResolveFailureCode, string>

export type RouteSource = 'user_primary' | 'user_fallback' | 'org_default'
export interface RoutedTarget {
  routeSource: RouteSource
  connectionId: string
  endpointId: string | null
  endpointRevision: number | null
  proofId: string
  capabilityRevision: number
  capabilityWitness: string
  verificationLevel: 'token' | 'send'
  addressKind: string
  addressWitness: string
  proofWitness: string
  boundTenant: string
  boundAppScope: string
}
export type SkipCode = 'recipient_not_permitted' | 'user_opted_out' | 'quiet_hours' | 'no_route' | 'no_valid_target'
export type DeferCode = 'topic_not_active' | 'capability_unreadable' | 'routed_branch_error' | 'routed_branch_stopped' | 'routed_branch_budget'
export type CapabilityRejection = 'provider_not_registered' | 'governed_by_legacy_path' | 'unsupported' | 'implementation_missing'
  | 'integration_inactive' | 'scope_changed' | 'not_enabled' | 'org_mismatch' | 'state_mismatch' | 'integration_missing'
export type ExclusionCode = typeof RESOLVE_EXCLUSIONS[ResolveFailureCode] | `connection_${CapabilityRejection}`
  | 'connection_not_verified' | 'adapter_unavailable' | 'target_endpoint_stale' | 'target_endpoint_revoked'
  | 'target_not_in_topic_profile' | 'target_fallback_same_provider'
export interface ExcludedTarget { rank: 0 | 1 | null; code: ExclusionCode }
export interface RouteCandidate {
  provider: string | null
  rank: 0 | 1 | null
  inProfile: boolean
  resolution: { ok: true; target: Omit<RoutedTarget, 'capabilityRevision' | 'capabilityWitness' | 'verificationLevel'> }
    | { ok: false; code: ExclusionCode }
  capability: { effective: true; revision: number; witness: string }
    | { effective: false; reason: CapabilityRejection | 'switch_off' | 'schema_unavailable' | 'read_failed' | 'transaction_required' | 'input_invalid' }
  verificationLevel: 'token' | 'send' | null
  adapterAvailable: boolean
}
export interface RouteInputs {
  state: 'active' | 'paused' | 'none' | 'unreadable'
  policyRevision: number
  permitted: boolean
  preference: { revision: number; enabled: boolean; quietHours: QuietHours | null } | null
  now: Date
  candidates: readonly RouteCandidate[]
}
export type RouteDecision =
  | { kind: 'route'; targets: RoutedTarget[]; excluded: ExcludedTarget[]; policyRevision: number; preferenceRevision: number | null }
  | { kind: 'skip'; code: SkipCode; excluded: ExcludedTarget[]; policyRevision: number; preferenceRevision: number | null }
  | { kind: 'defer'; code: DeferCode }

export function decideRoute(input: RouteInputs): RouteDecision {
  if (input.state !== 'active') return { kind: 'defer', code: 'topic_not_active' }
  const excluded: ExcludedTarget[] = []
  const common = { excluded, policyRevision: input.policyRevision, preferenceRevision: input.preference?.revision ?? null }
  const skip = (code: SkipCode): RouteDecision => ({ kind: 'skip', code, ...common })
  if (!input.permitted) return skip('recipient_not_permitted')
  if (input.preference?.enabled === false) return skip('user_opted_out')
  if (input.preference?.quietHours && isWithinQuietHours(input.now, input.preference.quietHours)) return skip('quiet_hours')
  if (!input.candidates.length) return skip('no_route')
  const targets: RoutedTarget[] = []
  let defer: DeferCode | undefined
  const primary = input.candidates.find(candidate => candidate.rank === 0)
  for (const candidate of input.candidates) {
    const exclude = (code: ExclusionCode) => excluded.push({ rank: candidate.rank, code })
    if (candidate.rank === 1 && primary?.provider && candidate.provider === primary.provider) {
      exclude('target_fallback_same_provider')
      continue
    }
    if (!candidate.inProfile) { exclude('target_not_in_topic_profile'); continue }
    if (candidate.resolution.ok === false) { exclude(candidate.resolution.code); continue }
    if (candidate.capability.effective === false) {
      const reason = candidate.capability.reason
      if (reason === 'input_invalid') defer = 'routed_branch_error'
      else if (['switch_off', 'schema_unavailable', 'read_failed', 'transaction_required'].includes(reason)) defer ??= 'capability_unreadable'
      else exclude(`connection_${reason}` as ExclusionCode)
      continue
    }
    if (!candidate.verificationLevel) { exclude('connection_not_verified'); continue }
    if (!candidate.adapterAvailable) { exclude('adapter_unavailable'); continue }
    targets.push({ ...candidate.resolution.target, capabilityRevision: candidate.capability.revision,
      capabilityWitness: candidate.capability.witness, verificationLevel: candidate.verificationLevel })
  }
  if (defer === 'routed_branch_error') return { kind: 'defer', code: defer }
  if (targets.length) return { kind: 'route', targets: targets.slice(0, 2), ...common }
  return defer ? { kind: 'defer', code: defer } : skip('no_valid_target')
}

/**
 * Assurance policy for security actions: which verification methods and assurance levels each
 * purpose accepts for each privilege class, the revision that versions this interpretation, and
 * the purpose registry. Unknown or missing values are never sufficient.
 *
 * A purpose is available only when every prerequisite it depends on is delivered. In this revision
 * none is, so no purpose is available. The prerequisites are constants of this module: availability
 * reads no environment variable and accepts no injected argument on the production entry point.
 *
 * This module has no runtime import. It is a closed set of constants and pure functions.
 */

export const SECURITY_ACTION_PURPOSES = [
  'external_identity_bind',
  'external_identity_unbind',
  'login_grant_enable',
  'login_grant_disable',
] as const
export type SecurityActionPurpose = (typeof SECURITY_ACTION_PURPOSES)[number]

export const SECURITY_ACTION_METHODS = ['local_password', 'external_reauth'] as const
export type SecurityActionMethod = (typeof SECURITY_ACTION_METHODS)[number]

export const SECURITY_ACTION_ASSURANCE_LEVELS = ['local_password', 'external_platform_asserted'] as const
export type SecurityActionAssuranceLevel = (typeof SECURITY_ACTION_ASSURANCE_LEVELS)[number]

export const PRIVILEGE_CLASSES = ['standard', 'high'] as const
export type PrivilegeClass = (typeof PRIVILEGE_CLASSES)[number]

/**
 * Versions the interpretation below. Any change to the classification predicates, the witness
 * composition or the policy matrix changes the fingerprint a unit test pins next to this number;
 * that test fails until the revision is incremented and the fingerprint re-pinned.
 */
export const SECURITY_ACTION_POLICY_REVISION = 1

export type SecurityActionPolicyRefusalCode =
  | 'SECURITY_ACTION_PURPOSE_UNAVAILABLE'
  | 'SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED'
  | 'SECURITY_ACTION_ASSURANCE_INSUFFICIENT'

export type SecurityActionPolicyInput = {
  purpose: unknown
  privilegeClass: unknown
  method: unknown
  assurance: unknown
  methodConnectionId?: unknown
  targetConnectionId?: unknown
}

export type SecurityActionPolicyDecision =
  | { allowed: true }
  | { allowed: false; code: SecurityActionPolicyRefusalCode }

const ALLOWED: SecurityActionPolicyDecision = Object.freeze({ allowed: true })
const PURPOSE_UNAVAILABLE: SecurityActionPolicyDecision = Object.freeze({ allowed: false, code: 'SECURITY_ACTION_PURPOSE_UNAVAILABLE' })
const HIGH_PRIVILEGE_SELF_SERVICE_DENIED: SecurityActionPolicyDecision = Object.freeze({ allowed: false, code: 'SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED' })
const ASSURANCE_INSUFFICIENT: SecurityActionPolicyDecision = Object.freeze({ allowed: false, code: 'SECURITY_ACTION_ASSURANCE_INSUFFICIENT' })

/** Purposes a high-privilege user may never complete through self-service, whatever the method. */
const HIGH_PRIVILEGE_SELF_SERVICE_DENIED_PURPOSES: ReadonlySet<SecurityActionPurpose> = new Set<SecurityActionPurpose>([
  'external_identity_bind',
  'login_grant_enable',
])

export function isSecurityActionPurpose(value: unknown): value is SecurityActionPurpose {
  // Membership of a frozen array: a prototype key such as 'constructor' or '__proto__' is not a member.
  return typeof value === 'string' && (SECURITY_ACTION_PURPOSES as readonly string[]).includes(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Connection identifiers are compared after trimming and case folding, so one connection written two ways is one connection. */
function connectionKey(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * The method and the assurance level must be the pair the method establishes. A local password
 * carries no connection; an external re-authentication names the connection it ran on, which
 * must be a different connection from the one the action targets.
 */
function isMethodAssurancePair(
  method: unknown,
  assurance: unknown,
  methodConnectionId: unknown,
  targetConnectionId: unknown,
): method is SecurityActionMethod {
  if (method === 'local_password') {
    return assurance === 'local_password' && (methodConnectionId === null || methodConnectionId === undefined)
  }
  if (method === 'external_reauth') {
    return assurance === 'external_platform_asserted'
      && isNonEmptyString(methodConnectionId)
      && isNonEmptyString(targetConnectionId)
      && connectionKey(methodConnectionId) !== connectionKey(targetConnectionId)
  }
  return false
}

/**
 * Decides whether a verified method with its assurance level satisfies a purpose for a privilege
 * class. Evaluation order, first match wins:
 * 1. an unknown purpose is unavailable;
 * 2. any privilege class other than 'standard' is treated as 'high';
 * 3. a high-privilege user is refused self-service for the purposes listed above;
 * 4. the method and assurance level must pair, with the connection rule for external methods;
 * 5. a high-privilege user is refused every method other than a local password;
 * 6. otherwise allowed.
 * The function is total: any input value, including a non-object, yields a decision and never throws.
 */
export function evaluateSecurityActionPolicy(input: SecurityActionPolicyInput): SecurityActionPolicyDecision {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return PURPOSE_UNAVAILABLE
  const { purpose, privilegeClass, method, assurance, methodConnectionId, targetConnectionId } = input
  if (!isSecurityActionPurpose(purpose)) return PURPOSE_UNAVAILABLE
  const cls: PrivilegeClass = privilegeClass === 'standard' ? 'standard' : 'high'
  if (cls === 'high' && HIGH_PRIVILEGE_SELF_SERVICE_DENIED_PURPOSES.has(purpose)) return HIGH_PRIVILEGE_SELF_SERVICE_DENIED
  if (!isMethodAssurancePair(method, assurance, methodConnectionId, targetConnectionId)) return ASSURANCE_INSUFFICIENT
  if (cls === 'high' && method !== 'local_password') return ASSURANCE_INSUFFICIENT
  return ALLOWED
}

// ---------------------------------------------------------------------------
// Purpose registry and availability
// ---------------------------------------------------------------------------

export type SecurityActionTargetKind = 'empty_slot' | 'identity_revision'

export type SecurityActionPurposeEntry = Readonly<{ targetKind: SecurityActionTargetKind }>

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

export const SECURITY_ACTION_PURPOSE_REGISTRY: Readonly<Record<SecurityActionPurpose, SecurityActionPurposeEntry>> = deepFreeze({
  external_identity_bind: { targetKind: 'empty_slot' },
  external_identity_unbind: { targetKind: 'identity_revision' },
  login_grant_enable: { targetKind: 'identity_revision' },
  login_grant_disable: { targetKind: 'identity_revision' },
})

export type SecurityActionPrerequisites = Readonly<{
  /** One-time action proofs are issued and consumed by a delivered, enabled service. Every purpose depends on it. */
  proofService: boolean
  /** A local credential counts as the local_password method only when its provenance satisfies the
   *  assurance policy for verification methods. Every purpose depends on it. */
  localCredentialProvenanceConstraint: boolean
  /** Every writer of an authorization input serializes with proof consumption under one documented
   *  lock order, with concurrency regressions. Every purpose whose outcome depends on the privilege
   *  class depends on it. */
  authorizationInputSerialization: boolean
  /** The external re-authentication method is delivered. It widens which purposes are privilege-sensitive. */
  externalReauthMethod: boolean
  /** Per purpose: its target resolution and its own feature gate are delivered. */
  purposeTargets: Readonly<Record<SecurityActionPurpose, boolean>>
}>

/** The production prerequisites. Every entry is false in this revision. */
export const SECURITY_ACTION_PREREQUISITES: SecurityActionPrerequisites = deepFreeze({
  proofService: false,
  localCredentialProvenanceConstraint: false,
  authorizationInputSerialization: false,
  externalReauthMethod: false,
  purposeTargets: {
    external_identity_bind: false,
    external_identity_unbind: false,
    login_grant_enable: false,
    login_grant_disable: false,
  },
})

const SENSITIVITY_ASSURANCE_PROBES: readonly unknown[] = [...SECURITY_ACTION_ASSURANCE_LEVELS, 'unknown', null, undefined]

function decisionKey(decision: SecurityActionPolicyDecision): string {
  return 'code' in decision ? decision.code : 'allowed'
}

/**
 * A purpose is privilege-sensitive when, for any delivered method and any assurance level, the
 * policy decides differently for 'standard' than for 'high'. Derived from the matrix, not listed by
 * hand, so the two cannot disagree.
 */
export function isPrivilegeSensitive(purpose: SecurityActionPurpose, prerequisites: SecurityActionPrerequisites): boolean {
  const deliveredMethods: SecurityActionMethod[] = ['local_password']
  if (prerequisites?.externalReauthMethod === true) deliveredMethods.push('external_reauth')
  for (const method of deliveredMethods) {
    const connection = method === 'external_reauth'
      ? { methodConnectionId: 'method-connection', targetConnectionId: 'target-connection' }
      : {}
    for (const assurance of SENSITIVITY_ASSURANCE_PROBES) {
      const standard = evaluateSecurityActionPolicy({ purpose, privilegeClass: 'standard', method, assurance, ...connection })
      const high = evaluateSecurityActionPolicy({ purpose, privilegeClass: 'high', method, assurance, ...connection })
      if (decisionKey(standard) !== decisionKey(high)) return true
    }
  }
  return false
}

/**
 * Availability as a pure function of a prerequisite set. Every check compares against the literal
 * `true`; any other value is unmet. Exported for tests; production code calls
 * `isSecurityActionPurposeAvailable`, which binds the production prerequisites.
 */
export function evaluateSecurityActionPurposeAvailability(purpose: unknown, prerequisites: SecurityActionPrerequisites): boolean {
  if (!isSecurityActionPurpose(purpose)) return false
  if (!prerequisites || typeof prerequisites !== 'object') return false
  if (prerequisites.proofService !== true) return false
  if (prerequisites.localCredentialProvenanceConstraint !== true) return false
  const targets = prerequisites.purposeTargets
  if (!targets || typeof targets !== 'object' || !Object.hasOwn(targets, purpose) || targets[purpose] !== true) return false
  if (isPrivilegeSensitive(purpose, prerequisites) && prerequisites.authorizationInputSerialization !== true) return false
  return true
}

/** Production entry point: one argument, no injection point. */
export function isSecurityActionPurposeAvailable(purpose: unknown): boolean {
  return evaluateSecurityActionPurposeAvailability(purpose, SECURITY_ACTION_PREREQUISITES)
}

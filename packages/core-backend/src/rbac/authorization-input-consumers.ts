/**
 * Registry of every decision point that depends on a user's privilege class.
 *
 * Outside the classifier module, each call of `assessSecurityActionPrivilege`,
 * `readPrivilegeInputs` or `classifyPrivilege` is a consumer and must be registered here as one of:
 *   - `LOCKED_DECISION`: the decision is made inside a contract transaction that holds the world
 *     lock shared and the user's row lock; the enclosing function takes the branded transaction,
 *     or the call sits inside an entry-point work closure;
 *   - `ADVISORY`: the read informs but never grants; it may only refuse, and it carries a reason;
 *   - `PENDING_LOCKED`: a decision point that does not yet run inside a contract transaction. It
 *     names the slice that converts it to `LOCKED_DECISION`, and while one exists
 *     `hasPendingConsumers()` is true, so the contract's prerequisite literal stays `false`.
 * The guard `tests/unit/authorization-input-consumers.guard.test.ts` compares the call sites in
 * production source with this registry and with a literal list of call-site keys: an unregistered
 * call site, a `LOCKED_DECISION` whose function does not take the token, a pending entry without a
 * slice or outside the pinned pending set, or a registered site that no longer exists is a failure.
 */

export const AUTHORIZATION_INPUT_CONSUMER_FUNCTIONS = ['assessSecurityActionPrivilege', 'readPrivilegeInputs', 'classifyPrivilege', 'evaluateAuthorizationOperationAccess', 'readActorOnly'] as const
export type AuthorizationInputConsumerFunction = (typeof AUTHORIZATION_INPUT_CONSUMER_FUNCTIONS)[number]

/** The module that defines the consumer functions; calls inside it are not consumers. */
export const AUTHORIZATION_INPUT_CLASSIFIER_MODULE = 'packages/core-backend/src/auth/security-action-privilege.ts'

export type AuthorizationInputConsumerMode = 'LOCKED_DECISION' | 'ADVISORY' | 'PENDING_LOCKED'

export type AuthorizationInputConsumerEntry = Readonly<{
  id: string
  file: string
  /** The function that makes the call; `callback:<callee>` names a callback passed to that callee. */
  symbol: string
  call: AuthorizationInputConsumerFunction
  count: number
  mode: AuthorizationInputConsumerMode
  /** `ADVISORY` only: why the read cannot grant. */
  reason?: string
  /** `PENDING_LOCKED` only: the slice that moves the decision inside a contract transaction. */
  slice?: string
}>

const PROOF_MODULE = 'packages/core-backend/src/auth/security-action-proof.ts'

/** Registered consumers. */
export const AUTHORIZATION_INPUT_CONSUMERS: readonly AuthorizationInputConsumerEntry[] = Object.freeze([
  Object.freeze({ id: 'K-01', file: PROOF_MODULE, symbol: 'readIssueInputs', call: 'assessSecurityActionPrivilege', count: 1, mode: 'ADVISORY', reason: 'issue-time pre-read; the consuming decision reads the class again' } as const),
  Object.freeze({ id: 'K-02', file: PROOF_MODULE, symbol: 'consume', call: 'assessSecurityActionPrivilege', count: 1, mode: 'PENDING_LOCKED', slice: 'AIS-3b' } as const),
  Object.freeze({ id: 'K-03', file: 'packages/core-backend/src/rbac/authorization-privilege-witness-plan.ts', symbol: 'revalidatePrivilegeRolePlan', call: 'readPrivilegeInputs', count: 1, mode: 'ADVISORY', reason: 'role-plan consistency only; success does not authorize; a complete consumer must reassess inputs' } as const),
  Object.freeze({ id: 'K-04', file: 'packages/core-backend/src/auth/admin-grant-receiving-reader.ts', symbol: 'readPreparedTarget', call: 'assessSecurityActionPrivilege', count: 1, mode: 'ADVISORY', reason: 'unmounted prepared receiver may only refuse; success neither authorizes nor enables a purpose' } as const),
  Object.freeze({ id: 'K-05', file: 'packages/core-backend/src/auth/admin-grant-receiving-reader.ts', symbol: 'resolveAdminGrantTargetSet', call: 'assessSecurityActionPrivilege', count: 1, mode: 'ADVISORY', reason: 'Prepares the actor privilege witness on the same locked receiving transaction; does not authorize a proof or grant' } as const),
  Object.freeze({ id: 'K-06', file: 'packages/core-backend/src/auth/admin-grant-target-ceremony.ts', symbol: 'lockAndRead', call: 'assessSecurityActionPrivilege', count: 1, mode: 'LOCKED_DECISION' } as const),
  Object.freeze({ id: 'K-07', file: 'packages/core-backend/src/auth/admin-grant-proof.ts', symbol: 'readIssueSnapshot', call: 'assessSecurityActionPrivilege', count: 1, mode: 'LOCKED_DECISION' } as const),
  Object.freeze({ id: 'K-08', file: 'packages/core-backend/src/auth/strict-dingtalk-entry.ts', symbol: 'callback:withAuthorizationInputTransaction', call: 'assessSecurityActionPrivilege', count: 1, mode: 'LOCKED_DECISION' } as const),
  Object.freeze({ id: 'K-09', file: 'packages/core-backend/src/auth/strict-dingtalk-entry.ts', symbol: 'currentPrivilegeRemainsEligible', call: 'assessSecurityActionPrivilege', count: 1, mode: 'ADVISORY', reason: 'Current eligibility veto for an existing strict grant/session only; success does not authorize a new grant or initial session' } as const),
  // Operation reads inform preview or receipt retrieval; only the commit closure can write.
  Object.freeze({ id: 'K-10', file: 'packages/core-backend/src/admin/authorization-operation-service.ts', symbol: 'callback:consistentRead', call: 'evaluateAuthorizationOperationAccess', count: 3, mode: 'ADVISORY', reason: 'consistent read-only preview and receipt disclosure; neither writes or grants' } as const),
  Object.freeze({ id: 'K-11', file: 'packages/core-backend/src/admin/authorization-operation-service.ts', symbol: 'callback:consistentRead', call: 'readActorOnly', count: 1, mode: 'ADVISORY', reason: 'consistent read-only receipt lookup; it cannot write or grant' } as const),
  Object.freeze({ id: 'K-12', file: 'packages/core-backend/src/admin/authorization-operation-service.ts', symbol: 'callback:withAuthorizationInputTransaction', call: 'evaluateAuthorizationOperationAccess', count: 2, mode: 'LOCKED_DECISION' } as const),
])

/** Whether any decision point is still outside a contract transaction (while one is, the contract's prerequisite literal stays `false`). */
export function hasPendingConsumers(): boolean {
  return AUTHORIZATION_INPUT_CONSUMERS.some((consumer) => consumer.mode === 'PENDING_LOCKED')
}

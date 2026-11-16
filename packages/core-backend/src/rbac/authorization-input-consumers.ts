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

export const AUTHORIZATION_INPUT_CONSUMER_FUNCTIONS = ['assessSecurityActionPrivilege', 'readPrivilegeInputs', 'classifyPrivilege'] as const
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
])

/** Whether any decision point is still outside a contract transaction (while one is, the contract's prerequisite literal stays `false`). */
export function hasPendingConsumers(): boolean {
  return AUTHORIZATION_INPUT_CONSUMERS.some((consumer) => consumer.mode === 'PENDING_LOCKED')
}

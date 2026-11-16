/**
 * Runtime brand of an authorization-input contract transaction.
 *
 * A contract transaction token is an object that the contract entry points mint and close; nothing
 * else can mint one, because the brand is a registry held inside this module, not a property on the
 * token. A boundary function that receives a token asserts it here before issuing any statement:
 * the target user id must be present, the token must be registered, it must still be open, and it
 * must belong to the connection the caller is about to write on. Each failure is a contract error
 * with a fixed, values-free message.
 *
 * This module is a leaf: it imports nothing from the application, so every boundary module can
 * depend on it without creating an import cycle.
 */

export type AuthorizationInputQueryResult = {
  rows: Array<Record<string, unknown>>
  rowCount?: number | null
}

export type AuthorizationInputQueryable = {
  query: (sql: string, params?: unknown[]) => Promise<AuthorizationInputQueryResult>
}

export type AuthorizationInputContractCode =
  | 'AUTHORIZATION_INPUT_BUSY'
  | 'AUTHORIZATION_INPUT_PLAN_STALE'
  | 'AUTHORIZATION_INPUT_PLAN_INVALID'
  | 'AUTHORIZATION_INPUT_FANOUT_LIMIT'
  | 'AUTHORIZATION_INPUT_HOLDER_UNCLASSIFIABLE'
  | 'AUTHORIZATION_INPUT_ISOLATION'
  | 'AUTHORIZATION_INPUT_UPGRADE_LOOP'
  | 'AUTHORIZATION_INPUT_UPGRADE_IN_TAKEOVER'
  | 'AUTHORIZATION_INPUT_TOKEN_REJECTED'

/**
 * Base class of every error the contract raises. The message is fixed per code and never carries a
 * value; a machine-readable `reason` names the condition for logs and tests.
 */
export class AuthorizationInputContractError extends Error {
  readonly code: AuthorizationInputContractCode
  readonly status: number
  readonly retryable: boolean
  readonly reason: string

  constructor(code: AuthorizationInputContractCode, options: { status: number; retryable: boolean; reason: string; message: string }) {
    super(options.message)
    this.name = 'AuthorizationInputContractError'
    this.code = code
    this.status = options.status
    this.retryable = options.retryable
    this.reason = options.reason
  }
}

export type AuthorizationInputTokenRejection = 'missing_target' | 'unbranded' | 'closed' | 'other_connection'

export const AUTHORIZATION_INPUT_TOKEN_REJECTED_MESSAGE = 'Authorization input transaction token is not acceptable'

export class AuthorizationInputTokenRejectedError extends AuthorizationInputContractError {
  constructor(reason: AuthorizationInputTokenRejection) {
    super('AUTHORIZATION_INPUT_TOKEN_REJECTED', { status: 500, retryable: false, reason, message: AUTHORIZATION_INPUT_TOKEN_REJECTED_MESSAGE })
    this.name = 'AuthorizationInputTokenRejectedError'
  }
}

type BrandState = {
  /** Every object through which the branded transaction may be driven (handler client, raw client, token). */
  readonly clients: Set<object>
  open: boolean
}

const registry = new WeakMap<object, BrandState>()

/**
 * Registers `token` as a live contract transaction bound to `clients`. Returns the handle that closes
 * it; a closed token stays registered but is refused by the assertion. Minting an already-registered
 * token is a contract error.
 */
export function mintAuthorizationInputBrand(token: object, clients: Iterable<object>): { close(): void; isOpen(): boolean } {
  if (registry.has(token)) throw new AuthorizationInputTokenRejectedError('unbranded')
  const state: BrandState = { clients: new Set([token, ...clients]), open: true }
  registry.set(token, state)
  return {
    close: () => {
      state.open = false
    },
    isOpen: () => state.open,
  }
}

/** Whether `candidate` is a registered token that is still open. */
export function isOpenAuthorizationInputTx(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false
  const state = registry.get(candidate)
  return state !== undefined && state.open
}

export type AuthorizationInputTxExpectation = Readonly<{
  /** The connection the caller will write on; the token must have been minted for it. */
  client: object
  /** The user the caller is about to write; required when the key is present. */
  userId?: unknown
}>

/**
 * Asserts, before any statement is issued, that `candidate` is a live contract transaction token for
 * the caller's connection and that the caller named its target user. Checks run in this order:
 * target present, registered, open, same connection. A caller that names no connection cannot be
 * matched to one and is refused as `other_connection`.
 */
export function assertAuthorizationInputTx(candidate: unknown, expectation: AuthorizationInputTxExpectation): void {
  if ('userId' in expectation) {
    const userId = expectation.userId
    if (typeof userId !== 'string' || userId.trim().length === 0) throw new AuthorizationInputTokenRejectedError('missing_target')
  }
  if (typeof candidate !== 'object' || candidate === null) throw new AuthorizationInputTokenRejectedError('unbranded')
  const state = registry.get(candidate)
  if (!state) throw new AuthorizationInputTokenRejectedError('unbranded')
  if (!state.open) throw new AuthorizationInputTokenRejectedError('closed')
  const client = (expectation as { client?: unknown }).client
  if (typeof client !== 'object' || client === null || !state.clients.has(client)) {
    throw new AuthorizationInputTokenRejectedError('other_connection')
  }
}

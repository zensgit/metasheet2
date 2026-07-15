// PLM-COLLAB Discussion Phase-3 write-UI — CHILD half of the child→parent on-demand embed-token
// protocol (contract locked in the ratified taskbook
// docs/development/plm-discussion-c1-read-panel-design-lock-20260711.md §1/§3: "the on-demand
// token protocol is the single unlock for the entire discussion surface").
//
// Why this exists: the BOM-review embed's ORIGINAL handshake (PlmEmbedBomReviewView.vue) is
// LISTEN-only and first-token-wins -- one mount = one token = one authenticated read call. A write
// (create/comment/resolve/reopen a discussion thread) needs its OWN embed token, single-use, minted
// fresh by the parent for that one write. This module is the outbound half of that: it posts a
// `plm-embed:token-request` to the parent and resolves the matching `plm-embed:token-response`.
//
// Sub-slice 4 (2026-07-15): the discussion READ-UI child needs the identical on-demand protocol,
// differing ONLY in the `purpose` field the parent uses to decide what the minted token is good
// for (the ratified sub-slice-3 parent accepts both `discussion-write` and `discussion-read`). The
// security-critical protocol body (origin pin, nonce correlation, timeout, dispose-guard, CSPRNG
// fail-closed) is extracted below into `createTokenClient`, an internal purpose-parameterized
// factory, so it is written and tested ONCE and shared by both
// `createPlmEmbedWriteTokenClient` and `createPlmEmbedReadTokenClient` rather than duplicated.
//
// Wire contract (child <-> parent), exact shape -- do not rename fields, the parent is a separate
// build against this same contract:
//   child -> parent:  { type: 'plm-embed:token-request', nonce: '<crypto-random>', purpose: 'discussion-write' | 'discussion-read' }
//   parent -> child:  { type: 'plm-embed:token-response', nonce: '<echoed>', token: '<fresh JWT>' }
//   parent -> child:  { type: 'plm-embed:token-error',    nonce: '<echoed>', reason: '<opaque>' }
//
// Security invariants (each backed by a test in tests/plm-embed-write-token.spec.ts, and mirrored
// for the read purpose in tests/plm-embed-read-token.spec.ts):
//   1. Pinned origin, not allowlist membership. This module NEVER consults the origin allowlist --
//      it is handed the origin the READ handshake already pinned (the first valid inbound token's
//      origin) via `getParentOrigin()`, and requires an EXACT match plus `event.source ===
//      window.parent` on every token-response/token-error. A different origin that also happens to
//      be allowlisted is still rejected: pinning is a stricter, narrower check than allowlist
//      membership, and this module only ever knows the ONE pinned value.
//   2. Request correlation. Exactly one in-flight request at a time, keyed by a fresh crypto-random
//      nonce; any inbound message whose nonce does not match the in-flight one is dropped silently
//      (covers stale responses to an already-settled/timed-out request, and forged/guessed nonces).
//   3. Fresh token per write, memory-only. The resolved token is handed to the caller as a plain
//      string for that ONE write; this module never persists it (no localStorage/sessionStorage/
//      cookie/URL/logs) and never caches or reuses it -- the caller's local `const` falls out of
//      scope after the single relay call.
//   4. Outbound post is targeted, never '*'. `targetOrigin` is always the pinned `parentOrigin` --
//      this is the FIRST outbound postMessage this embed page family makes, so it is audited with
//      the same care as the read page's inbound gate.
//   5. 5-second timeout. No token-response/token-error for the in-flight nonce within 5s clears the
//      in-flight state and rejects -- callers get a clean retry path, never a hang.
//   6. Re-request, not replay. Every failure path (token-error, timeout, dispose) clears the
//      in-flight nonce. There is no "resend the same request" API -- a retry can only be a brand
//      new `requestWriteToken()` call, which mints a brand new nonce and posts a brand new request.
//      A spent/failed token is never re-sent because there is no code path that re-sends anything.

/** Inbound/outbound message `type` discriminators -- exact strings per the locked contract. */
const TOKEN_REQUEST_TYPE = 'plm-embed:token-request' as const
const TOKEN_RESPONSE_TYPE = 'plm-embed:token-response' as const
const TOKEN_ERROR_TYPE = 'plm-embed:token-error' as const

/** Distinct `purpose` fields per the locked contract, one per token client this module exports.
 * NOT treated as an authorization boundary here (a compromised child could send any value) -- the
 * parent, not this module, is responsible for deciding what `purpose` authorizes. */
const WRITE_TOKEN_PURPOSE = 'discussion-write' as const
const READ_TOKEN_PURPOSE = 'discussion-read' as const

const TOKEN_REQUEST_TIMEOUT_MS = 5000

export class PlmEmbedWriteTokenTimeoutError extends Error {
  constructor() {
    super('timed out waiting for a fresh PLM embed write token')
    this.name = 'PlmEmbedWriteTokenTimeoutError'
  }
}

export class PlmEmbedWriteTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlmEmbedWriteTokenError'
  }
}

/** Read-purpose siblings of the write errors above -- same shape, distinctly named so a caller can
 * tell a read-token failure from a write-token failure by `instanceof` without inspecting message
 * text. Kept as separate classes (rather than reusing the write ones) so neither client's error
 * messages says the wrong word ("write" on a read failure or vice versa). */
export class PlmEmbedReadTokenTimeoutError extends Error {
  constructor() {
    super('timed out waiting for a fresh PLM embed read token')
    this.name = 'PlmEmbedReadTokenTimeoutError'
  }
}

export class PlmEmbedReadTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlmEmbedReadTokenError'
  }
}

interface InFlightRequest {
  nonce: string
  resolve: (token: string) => void
  reject: (err: Error) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

export interface PlmEmbedWriteTokenClient {
  /**
   * Requests ONE fresh, single-use embed token for a write. Resolves with the raw token string
   * (memory-only -- the caller must use it for exactly one relay write and let it fall out of
   * scope; never store it). Rejects on token-error, timeout (5s), or disposal. There is no replay:
   * every call -- including a retry after a rejection -- mints a brand new nonce and posts a brand
   * new `plm-embed:token-request`.
   */
  requestWriteToken(): Promise<string>
  /** Detaches the message listener and rejects any in-flight request. Idempotent. */
  dispose(): void
}

export interface PlmEmbedReadTokenClient {
  /**
   * Requests ONE fresh, single-use embed token for a read. Same lifecycle/security contract as
   * {@link PlmEmbedWriteTokenClient.requestWriteToken} (memory-only, no replay, 5s timeout) -- the
   * only difference is the outbound `purpose: 'discussion-read'`.
   */
  requestReadToken(): Promise<string>
  /** Detaches the message listener and rejects any in-flight request. Idempotent. */
  dispose(): void
}

/** Error-class pair a `createTokenClient(...)` instance uses to reject with, so the shared factory
 * below stays purpose-agnostic while each public wrapper still throws its own named error types. */
interface TokenErrorFactory {
  timeout(): Error
  generic(message: string): Error
}

function randomNonce(): string | null {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string; getRandomValues?: <T extends ArrayBufferView>(a: T) => T } | undefined
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    cryptoApi.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  // FAIL CLOSED (adversarial-verify P2): with no CSPRNG, return null so requestWriteToken() rejects
  // and posts NOTHING. A predictable Date.now()+Math.random() nonce would weaken the correlation
  // lock; a write channel must not silently degrade. Every supported runtime (browser + jsdom test
  // env) provides Web Crypto, so this is a fail-closed guard, not an expected path.
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Internal purpose-parameterized factory: the ENTIRE security-critical protocol body (origin pin,
 * `window.parent` source check, nonce correlation, memory-only settlement, 5s timeout,
 * disposed-guard, CSPRNG fail-closed nonce) lives here ONCE, verbatim from the pre-refactor
 * `createPlmEmbedWriteTokenClient`. `purpose` is the only thing that varies in the outbound
 * `plm-embed:token-request` payload; `tokenLabel` / `errors` only vary the *wording* and *class* of
 * the rejections each public wrapper below produces (never the control flow). Not exported --
 * callers use `createPlmEmbedWriteTokenClient` / `createPlmEmbedReadTokenClient`.
 *
 * `getParentOrigin` MUST return the origin the read handshake pinned (or `null` before it has
 * pinned one) -- read it live on every call/message rather than capturing a snapshot, so this
 * channel tracks the same single source of truth the read page uses. Callers own the returned
 * client's lifetime: create it once per embed mount, call `dispose()` on unmount.
 */
function createTokenClient(
  getParentOrigin: () => string | null,
  purpose: typeof WRITE_TOKEN_PURPOSE | typeof READ_TOKEN_PURPOSE,
  tokenLabel: 'write' | 'read',
  errors: TokenErrorFactory,
): { request(): Promise<string>; dispose(): void } {
  let inFlight: InFlightRequest | null = null
  let disposed = false

  function settleInFlight(): InFlightRequest | null {
    const current = inFlight
    if (current) {
      clearTimeout(current.timeoutHandle)
      inFlight = null
    }
    return current
  }

  function onMessage(event: MessageEvent): void {
    if (!inFlight) return // nothing outstanding: nothing to correlate, drop unconditionally

    // Pinned-origin gate: exact match against the SAME origin the read handshake pinned, plus a
    // real-parent source check. Allowlist membership is irrelevant here on purpose (see module
    // docstring, invariant 1) -- a different allowlisted origin must still fail this check.
    const parentOrigin = getParentOrigin()
    if (!parentOrigin || event.origin !== parentOrigin) return
    // Positive conjunct per the ratified taskbook lock 1: `event.source === window.parent`. A
    // null/absent source is REJECTED (a token-response is write-authorizing — unlike the read
    // page's inbound gate, we do not fall back to origin-only for source-less synthetic events).
    if (event.source !== window.parent) return

    const data = event.data
    if (!isRecord(data)) return
    const type = data.type
    const nonce = data.nonce
    if (typeof nonce !== 'string' || nonce !== inFlight.nonce) return // stale/foreign nonce: drop

    if (type === TOKEN_RESPONSE_TYPE) {
      const token = data.token
      const current = settleInFlight()
      if (typeof token === 'string' && token.length > 0) {
        current?.resolve(token)
      } else {
        current?.reject(errors.generic('malformed token-response'))
      }
      return
    }
    if (type === TOKEN_ERROR_TYPE) {
      const reason = data.reason
      const current = settleInFlight()
      current?.reject(errors.generic(typeof reason === 'string' && reason ? reason : 'token-error'))
      return
    }
    // Any other type sharing our nonce is ignored -- neither resolves nor rejects nor consumes it.
  }

  window.addEventListener('message', onMessage)

  function request(): Promise<string> {
    if (disposed) {
      // Fail fast after teardown: never post a spurious token-request (which the parent could
      // mint + burn a single-use jti for) and never hang the caller on a listener that is gone.
      return Promise.reject(errors.generic(`${tokenLabel}-token client is disposed`))
    }
    if (inFlight) {
      return Promise.reject(errors.generic(`a ${tokenLabel}-token request is already in flight`))
    }
    const parentOrigin = getParentOrigin()
    if (!parentOrigin) {
      return Promise.reject(errors.generic('parent origin is not pinned yet'))
    }

    const nonce = randomNonce()
    if (nonce === null) {
      return Promise.reject(errors.generic('secure randomness (Web Crypto) is unavailable'))
    }
    return new Promise<string>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        settleInFlight()
        reject(errors.timeout())
      }, TOKEN_REQUEST_TIMEOUT_MS)
      inFlight = { nonce, resolve, reject, timeoutHandle }
      // targetOrigin is ALWAYS the pinned parentOrigin -- never '*'. This is the first outbound
      // postMessage this embed page family makes; see module docstring invariant 4.
      window.parent.postMessage({ type: TOKEN_REQUEST_TYPE, nonce, purpose }, parentOrigin)
    })
  }

  function dispose(): void {
    disposed = true
    const current = settleInFlight()
    current?.reject(errors.generic(`${tokenLabel}-token client disposed`))
    window.removeEventListener('message', onMessage)
  }

  return { request, dispose }
}

const writeTokenErrors: TokenErrorFactory = {
  timeout: () => new PlmEmbedWriteTokenTimeoutError(),
  generic: (message: string) => new PlmEmbedWriteTokenError(message),
}

const readTokenErrors: TokenErrorFactory = {
  timeout: () => new PlmEmbedReadTokenTimeoutError(),
  generic: (message: string) => new PlmEmbedReadTokenError(message),
}

/**
 * Creates the child-side write-token channel (`purpose: 'discussion-write'`). Thin wrapper over
 * {@link createTokenClient} -- see that function's docstring for the shared protocol contract.
 * Behavior is unchanged from before the sub-slice-4 refactor: same wire shape, same rejections.
 */
export function createPlmEmbedWriteTokenClient(getParentOrigin: () => string | null): PlmEmbedWriteTokenClient {
  const client = createTokenClient(getParentOrigin, WRITE_TOKEN_PURPOSE, 'write', writeTokenErrors)
  return {
    requestWriteToken: () => client.request(),
    dispose: () => client.dispose(),
  }
}

/**
 * Creates the child-side read-token channel (`purpose: 'discussion-read'`). Thin wrapper over
 * {@link createTokenClient} -- identical protocol/security invariants to the write client, just a
 * different `purpose` and error-class pair. See {@link createPlmEmbedWriteTokenClient}'s docstring
 * and the module header for the shared contract.
 */
export function createPlmEmbedReadTokenClient(getParentOrigin: () => string | null): PlmEmbedReadTokenClient {
  const client = createTokenClient(getParentOrigin, READ_TOKEN_PURPOSE, 'read', readTokenErrors)
  return {
    requestReadToken: () => client.request(),
    dispose: () => client.dispose(),
  }
}

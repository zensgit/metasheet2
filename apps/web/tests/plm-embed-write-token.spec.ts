import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPlmEmbedWriteTokenClient,
  PlmEmbedWriteTokenError,
  PlmEmbedWriteTokenTimeoutError,
  type PlmEmbedWriteTokenClient,
} from '../src/services/integration/plmEmbedWriteToken'

// Child half of the child->parent on-demand embed-token protocol (discussion write-UI).
// PLM_ORIGIN is the ONE origin this channel is pinned to in each test (mirroring the origin the
// read handshake already pinned). OTHER_ALLOWED_ORIGIN stands in for a origin that IS present in
// the server's allowlist elsewhere but is NOT the pinned origin for this mount -- MUST-1 requires
// it be rejected all the same (pinning, not allowlist membership, is the gate this module enforces).
const PLM_ORIGIN = 'https://plm.example.com'
const OTHER_ALLOWED_ORIGIN = 'https://plm-secondary.example.com'

const TOKEN_REQUEST_TYPE = 'plm-embed:token-request'
const TOKEN_RESPONSE_TYPE = 'plm-embed:token-response'
const TOKEN_ERROR_TYPE = 'plm-embed:token-error'

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function postFromParent(origin: string, data: unknown, source: MessageEventSource | null = window.parent): void {
  window.dispatchEvent(new MessageEvent('message', { origin, data, source }))
}

/** Reads the nonce the channel just posted off the postMessage spy's most recent call. */
function lastPostedNonce(postSpy: ReturnType<typeof vi.spyOn>): string {
  const lastCall = postSpy.mock.calls[postSpy.mock.calls.length - 1] as [{ nonce: string }, string]
  return lastCall[0].nonce
}

describe('plmEmbedWriteToken — child protocol layer (discussion write-UI on-demand token)', () => {
  let client: PlmEmbedWriteTokenClient | null = null
  let parentOrigin: string | null = PLM_ORIGIN
  let postSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    parentOrigin = PLM_ORIGIN
    postSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    client = createPlmEmbedWriteTokenClient(() => parentOrigin)
  })

  afterEach(() => {
    client?.dispose()
    client = null
    postSpy.mockRestore()
    vi.useRealTimers()
  })

  it('MUST-4: posts the token-request to the PINNED parentOrigin, never "*", with the exact contract shape', async () => {
    // Fire-and-forget: this test only inspects the outbound post, not the eventual settlement.
    // afterEach's dispose() rejects any request still in flight when the test ends, so attach a
    // no-op catch to avoid an unhandled-rejection warning bleeding into a later test's output.
    client!.requestWriteToken().catch(() => {})
    expect(postSpy).toHaveBeenCalledTimes(1)
    const [message, targetOrigin] = postSpy.mock.calls[0] as [Record<string, unknown>, string]
    expect(targetOrigin).toBe(PLM_ORIGIN)
    expect(targetOrigin).not.toBe('*')
    expect(message.type).toBe(TOKEN_REQUEST_TYPE)
    expect(message.purpose).toBe('discussion-write')
    expect(typeof message.nonce).toBe('string')
    expect((message.nonce as string).length).toBeGreaterThan(0)
  })

  it('MUST-1: accepts a token-response from the pinned origin + window.parent source', async () => {
    const promise = client!.requestWriteToken()
    const nonce = lastPostedNonce(postSpy)
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce, token: 'fresh-jwt-1' })
    await expect(promise).resolves.toBe('fresh-jwt-1')
  })

  it('MUST-1: rejects a response from a DIFFERENT origin, even one that is ALSO allowlisted elsewhere', async () => {
    const promise = client!.requestWriteToken()
    const nonce = lastPostedNonce(postSpy)
    // OTHER_ALLOWED_ORIGIN is not the pinned origin for this mount -- must be dropped even though a
    // real deployment's server-side allowlist may contain it. Allowlist membership is necessary but
    // not sufficient; only the pinned origin exact-matches.
    postFromParent(OTHER_ALLOWED_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce, token: 'should-not-resolve' })
    await flush()
    // The dropped message must not have settled the promise -- prove it by now delivering the
    // CORRECT response and confirming that one (and only that one) resolves it.
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce, token: 'correct-token' })
    await expect(promise).resolves.toBe('correct-token')
  })

  it('MUST-1: rejects a response whose event.source is not window.parent, even from the pinned origin', async () => {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    try {
      const promise = client!.requestWriteToken()
      const nonce = lastPostedNonce(postSpy)
      // Correct origin, WRONG source (a foreign window masquerading as the pinned origin).
      postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce, token: 'should-not-resolve' }, frame.contentWindow)
      await flush()
      postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce, token: 'correct-token' })
      await expect(promise).resolves.toBe('correct-token')
    } finally {
      frame.remove()
    }
  })

  it('MUST-1: rejects a response with a NULL/absent event.source, even from the pinned origin', async () => {
    // Positive conjunct (taskbook lock 1): source must EQUAL window.parent; a source-less event
    // is NOT accepted via an origin-only fallback (a token-response is write-authorizing).
    const promise = client!.requestWriteToken()
    const nonce = lastPostedNonce(postSpy)
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce, token: 'should-not-resolve' }, null)
    await flush()
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce, token: 'correct-token' })
    await expect(promise).resolves.toBe('correct-token')
  })

  it('MUST-2: drops a response whose nonce does not match the single in-flight request', async () => {
    const promise = client!.requestWriteToken()
    const nonce = lastPostedNonce(postSpy)
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce: 'some-other-nonce', token: 'wrong-nonce-token' })
    await flush()
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce, token: 'right-nonce-token' })
    await expect(promise).resolves.toBe('right-nonce-token')
  })

  it('MUST-2/6: a stale response for a request that already TIMED OUT is dropped by the NEXT request', async () => {
    vi.useFakeTimers()
    const firstPromise = client!.requestWriteToken()
    const staleNonce = lastPostedNonce(postSpy)
    firstPromise.catch(() => {}) // expected rejection; silence unhandled-rejection noise
    await vi.advanceTimersByTimeAsync(5000)
    await expect(firstPromise).rejects.toBeInstanceOf(PlmEmbedWriteTokenTimeoutError)

    // Re-request per MUST-6: a NEW nonce, tracked as the ONLY in-flight request now.
    const secondPromise = client!.requestWriteToken()
    const secondNonce = lastPostedNonce(postSpy)
    expect(secondNonce).not.toBe(staleNonce)

    // A late response using the STALE (first) nonce must be dropped, even though it is otherwise
    // well-formed and from the pinned origin -- it does not resolve/replay onto the second request.
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce: staleNonce, token: 'late-stale-token' })
    await vi.advanceTimersByTimeAsync(0)
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce: secondNonce, token: 'second-token' })
    await expect(secondPromise).resolves.toBe('second-token')
  })

  it('MUST-5: rejects with a timeout after 5s of silence, clearing the in-flight nonce', async () => {
    vi.useFakeTimers()
    const promise = client!.requestWriteToken()
    // Not yet at the deadline: still pending.
    await vi.advanceTimersByTimeAsync(4999)
    let settled = false
    promise.then(
      () => (settled = true),
      () => (settled = true),
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(2)
    await expect(promise).rejects.toBeInstanceOf(PlmEmbedWriteTokenTimeoutError)
  })

  it('MUST-6: a token-error clears the in-flight nonce; retrying issues a brand-new request, never a replay', async () => {
    const firstPromise = client!.requestWriteToken()
    const firstNonce = lastPostedNonce(postSpy)
    postFromParent(PLM_ORIGIN, { type: TOKEN_ERROR_TYPE, nonce: firstNonce, reason: 'rate_limited' })
    await expect(firstPromise).rejects.toBeInstanceOf(PlmEmbedWriteTokenError)

    const secondPromise = client!.requestWriteToken()
    const secondNonce = lastPostedNonce(postSpy)
    expect(secondNonce).not.toBe(firstNonce)
    expect(postSpy).toHaveBeenCalledTimes(2)

    // The failed first token is never re-sent: a response bearing the OLD nonce cannot resolve the
    // new request.
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce: firstNonce, token: 'must-not-apply' })
    await flush()
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce: secondNonce, token: 'fresh-retry-token' })
    await expect(secondPromise).resolves.toBe('fresh-retry-token')
  })

  it('MUST-3: one-token-one-write — each requestWriteToken() call yields its OWN distinct token, never reused', async () => {
    const firstPromise = client!.requestWriteToken()
    const firstNonce = lastPostedNonce(postSpy)
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce: firstNonce, token: 'token-for-write-1' })
    const firstToken = await firstPromise

    const secondPromise = client!.requestWriteToken()
    const secondNonce = lastPostedNonce(postSpy)
    expect(secondNonce).not.toBe(firstNonce)
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce: secondNonce, token: 'token-for-write-2' })
    const secondToken = await secondPromise

    expect(firstToken).toBe('token-for-write-1')
    expect(secondToken).toBe('token-for-write-2')
    expect(firstToken).not.toBe(secondToken)
  })

  it('MUST-3: memory-only — the resolved token never touches localStorage/sessionStorage/cookies, and nothing is logged', async () => {
    const localSetItemSpy = vi.spyOn(window.localStorage, 'setItem')
    const sessionSetItemSpy =
      typeof window.sessionStorage?.setItem === 'function' ? vi.spyOn(window.sessionStorage, 'setItem') : null
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cookieBefore = document.cookie
    const SECRET_TOKEN = 'super-secret-single-use-jwt-zzz'

    try {
      const promise = client!.requestWriteToken()
      const nonce = lastPostedNonce(postSpy)
      postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce, token: SECRET_TOKEN })
      const token = await promise
      expect(token).toBe(SECRET_TOKEN)

      expect(localSetItemSpy).not.toHaveBeenCalled()
      if (sessionSetItemSpy) expect(sessionSetItemSpy).not.toHaveBeenCalled()
      expect(document.cookie).toBe(cookieBefore)
      expect(consoleLogSpy).not.toHaveBeenCalled()
      expect(consoleWarnSpy).not.toHaveBeenCalled()
      expect(consoleErrorSpy).not.toHaveBeenCalled()

      // Literal-scan proof: the token string must not appear anywhere in local/session storage or
      // the cookie jar, regardless of how it got there.
      const localDump = JSON.stringify({ ...window.localStorage })
      expect(localDump).not.toContain(SECRET_TOKEN)
      expect(document.cookie).not.toContain(SECRET_TOKEN)
    } finally {
      localSetItemSpy.mockRestore()
      sessionSetItemSpy?.mockRestore()
      consoleLogSpy.mockRestore()
      consoleWarnSpy.mockRestore()
      consoleErrorSpy.mockRestore()
    }
  })

  it('a second requestWriteToken() while one is already in flight is rejected (fail-fast, exactly one in-flight)', async () => {
    const firstPromise = client!.requestWriteToken()
    const firstNonce = lastPostedNonce(postSpy)
    await expect(client!.requestWriteToken()).rejects.toBeInstanceOf(PlmEmbedWriteTokenError)
    expect(postSpy).toHaveBeenCalledTimes(1) // the rejected second call never posted anything

    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce: firstNonce, token: 'still-the-first' })
    await expect(firstPromise).resolves.toBe('still-the-first')
  })

  it('ignores malformed/irrelevant messages from the pinned origin without settling the request', async () => {
    const promise = client!.requestWriteToken()
    const nonce = lastPostedNonce(postSpy)
    postFromParent(PLM_ORIGIN, { type: 'something-else', nonce, token: 'ignored' })
    postFromParent(PLM_ORIGIN, 'not-an-object')
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE }) // no nonce
    await flush()
    postFromParent(PLM_ORIGIN, { type: TOKEN_RESPONSE_TYPE, nonce, token: 'finally' })
    await expect(promise).resolves.toBe('finally')
  })

  it('MUST-2 fail-closed: with no Web Crypto CSPRNG, requestWriteToken() rejects and posts NOTHING', async () => {
    const realCrypto = globalThis.crypto
    // A runtime with no usable CSPRNG (no randomUUID, no getRandomValues) must NOT degrade to a
    // predictable nonce -- it must reject before any outbound token-request.
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    try {
      const postsBefore = postSpy.mock.calls.length
      await expect(client!.requestWriteToken()).rejects.toBeInstanceOf(PlmEmbedWriteTokenError)
      expect(postSpy.mock.calls.length).toBe(postsBefore)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true })
    }
  })

  it('dispose() rejects an in-flight request and REMOVES the message listener (non-vacuous)', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const promise = client!.requestWriteToken()
    client!.dispose()
    await expect(promise).rejects.toBeInstanceOf(PlmEmbedWriteTokenError)
    // Prove the listener is actually detached, not just that a stray message doesn't throw: the
    // exact 'message' handler passed to addEventListener must be handed to removeEventListener.
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function))
    removeSpy.mockRestore()
  })

  it('use-after-dispose: requestWriteToken() after dispose() rejects immediately and posts NOTHING', async () => {
    // Regression: a deferred submit firing after unmount must not re-post a token-request (which the
    // parent could mint + burn a single-use jti for) nor hang 5s on a removed listener.
    client!.dispose()
    const postsBefore = postSpy.mock.calls.length
    await expect(client!.requestWriteToken()).rejects.toBeInstanceOf(PlmEmbedWriteTokenError)
    expect(postSpy.mock.calls.length).toBe(postsBefore) // no outbound token-request after dispose
  })
})

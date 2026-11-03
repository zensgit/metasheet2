// P5 — the one mapping helper that decides WHICH outage sentence the user reads.
//
// FIELD INCIDENT (2026-09-14). The customer's link to the 222 host dropped mid-morning.
// `fetch` rejected with `TypeError: Failed to fetch` on every action, and the copy shown
// was the gateway sentence (「服务暂时不可用，请稍后重试」). The customer
// concluded the DELETE feature was broken. The only signal that separates the two cases is
// whether an HTTP response arrived at all, so that is the only thing this helper keys on.
//
// These assertions pin the LITERALS on purpose: a self-referential expectation
// (`expect(f(x)).toBe(f(x))`) would stay green through any rewrite of either sentence, which
// is exactly how the previous round of copy drifted unnoticed.
import { describe, expect, it } from 'vitest'
import {
  NETWORK_UNREACHABLE_COPY,
  SERVICE_UNAVAILABLE_COPY,
  createNetworkUnavailableError,
  hasHttpResponse,
  networkUnavailableMessage,
  serviceUnavailableMessage,
  unavailableMessageFor,
} from '../src/utils/networkErrors'

/** A `Response` double with the two members the helper inspects. */
function responseLike(status: number, ok: boolean): Response {
  return { status, ok } as unknown as Response
}

describe('unavailableMessageFor (P5 outage copy mapping)', () => {
  it('NO RESPONSE: a rejected fetch (TypeError) maps to the network-unreachable copy', () => {
    const rejection = new TypeError('Failed to fetch')
    expect(hasHttpResponse(rejection)).toBe(false)
    expect(unavailableMessageFor(rejection, true)).toBe('无法连接服务器（未收到任何响应），请检查网络或稍后重试')
    expect(unavailableMessageFor(rejection, false)).toBe('Cannot reach the server (no response received). Check your network connection, or try again later.')
    // The whole point of the change: it must NOT be the gateway sentence.
    expect(unavailableMessageFor(rejection, true)).not.toBe('服务暂时不可用，请稍后重试')
    expect(unavailableMessageFor(rejection, false)).not.toBe('The service is temporarily unavailable. Please try again in a moment.')
  })

  it('NO RESPONSE: other engines\u2019 transport literals and a bare net::ERR_* land the same way', () => {
    // Firefox / WebKit wording, plus the Chromium net::ERR_* shape a stub may throw.
    for (const message of [
      'NetworkError when attempting to fetch resource.',
      'Load failed',
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_NAME_NOT_RESOLVED',
    ]) {
      expect(unavailableMessageFor(new TypeError(message), true)).toBe('无法连接服务器（未收到任何响应），请检查网络或稍后重试')
    }
    // `undefined` (“nothing to inspect”) is the same case, and is how
    // networkUnavailableMessage() reaches the helper.
    expect(unavailableMessageFor(undefined, true)).toBe('无法连接服务器（未收到任何响应），请检查网络或稍后重试')
    expect(networkUnavailableMessage(true)).toBe('无法连接服务器（未收到任何响应），请检查网络或稍后重试')
    expect(networkUnavailableMessage(false)).toBe('Cannot reach the server (no response received). Check your network connection, or try again later.')
  })

  it('RESPONSE 503: a maintenance-page response keeps today\u2019s service-unavailable copy', () => {
    const res = responseLike(503, false)
    expect(hasHttpResponse(res)).toBe(true)
    expect(unavailableMessageFor(res, true)).toBe('服务暂时不可用，请稍后重试')
    expect(unavailableMessageFor(res, false)).toBe('The service is temporarily unavailable. Please try again in a moment.')
    expect(unavailableMessageFor(res, true)).not.toBe('无法连接服务器（未收到任何响应），请检查网络或稍后重试')
    // 502 and 504 are the same class and must not drift apart from 503.
    expect(unavailableMessageFor(responseLike(502, false), true)).toBe('服务暂时不可用，请稍后重试')
    expect(unavailableMessageFor(responseLike(504, false), true)).toBe('服务暂时不可用，请稍后重试')
  })

  it('RESPONSE 200 (non-JSON body): a response still exists, so the copy stays the service one', () => {
    // nginx can answer 200 with an HTML maintenance/login page; the JSON parse fails, but
    // the server DID answer — telling the user “no response received” would be a lie.
    const res = responseLike(200, true)
    expect(hasHttpResponse(res)).toBe(true)
    expect(unavailableMessageFor(res, true)).toBe('服务暂时不可用，请稍后重试')
    expect(unavailableMessageFor(res, false)).toBe('The service is temporarily unavailable. Please try again in a moment.')
    expect(unavailableMessageFor(res, true)).not.toBe('无法连接服务器（未收到任何响应），请检查网络或稍后重试')
  })

  it('RESPONSE: a REAL Response instance classifies identically to the double', () => {
    // Guards against the double being the only thing `hasHttpResponse` understands.
    expect(typeof Response).toBe('function')
    expect(hasHttpResponse(new Response('maintenance', { status: 503 }))).toBe(true)
    expect(unavailableMessageFor(new Response('<html>', { status: 200 }), true))
      .toBe('服务暂时不可用，请稍后重试')
  })

  it('RESPONSE: an error that merely CARRIES a status (parseJson\u2019s MultitableApiError) counts as answered', () => {
    const apiError = Object.assign(new Error('API 503'), { status: 503, code: 'SERVICE_UNAVAILABLE' })
    expect(hasHttpResponse(apiError)).toBe(true)
    expect(unavailableMessageFor(apiError, true)).toBe('服务暂时不可用，请稍后重试')
    // ...and an error that hangs the response off `.response` does too.
    expect(hasHttpResponse(Object.assign(new Error('x'), { response: responseLike(503, false) }))).toBe(true)
  })

  it('BOUNDARY: status 0 is NOT a response — it is the marker for “nothing came back”', () => {
    const thrown = createNetworkUnavailableError(new TypeError('Failed to fetch'))
    expect(thrown.status).toBe(0)
    expect(hasHttpResponse(thrown)).toBe(false)
    expect(unavailableMessageFor(thrown, true)).toBe('无法连接服务器（未收到任何响应），请检查网络或稍后重试')
  })

  it('the factory stamps the network copy on the thrown error and keeps the raw cause', () => {
    const cause = new TypeError('Failed to fetch')
    const thrown = createNetworkUnavailableError(cause)
    expect(thrown.cause).toBe(cause)
    // Default (no stored locale in this spec’s jsdom) resolves EN.
    expect(thrown.message).toBe('Cannot reach the server (no response received). Check your network connection, or try again later.')
    expect(thrown.message).not.toContain('Failed to fetch')
  })

  it('both sentences stay neutral: no “upgrading” announcement in either locale', () => {
    for (const copy of [NETWORK_UNREACHABLE_COPY, SERVICE_UNAVAILABLE_COPY]) {
      expect(copy.zh).not.toContain('升级')
      expect(copy.en.toLowerCase()).not.toContain('upgrad')
      expect(copy.zh).not.toBe(copy.en)
    }
    // The two tables are the whole vocabulary and must never be equal.
    expect(NETWORK_UNREACHABLE_COPY.zh).not.toBe(SERVICE_UNAVAILABLE_COPY.zh)
    expect(NETWORK_UNREACHABLE_COPY.en).not.toBe(SERVICE_UNAVAILABLE_COPY.en)
    expect(serviceUnavailableMessage(true)).toBe('服务暂时不可用，请稍后重试')
    expect(serviceUnavailableMessage(false)).toBe('The service is temporarily unavailable. Please try again in a moment.')
  })
})

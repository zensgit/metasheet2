/// <reference lib="dom" />

import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import { errorMonitor } from 'node:events'
import type { EventEmitter } from 'node:events'
import type { HttpProxy } from '../../../../apps/web/node_modules/vite'

export function automationTransportKey(pathname: string): string | undefined {
  const paths: Record<string, string> = {
    '/api/integration/automation-read/options': 'automationOptions',
    '/api/integration/automation-read/grants': 'automationGrants',
    '/api/integration/automation-read/requests': 'automationRequests',
    '/api/integration/automation-read/schedule-activations': 'automationScheduleActivation',
  }
  if (Object.hasOwn(paths, pathname)) return paths[pathname]
  if (/^\/api\/integration\/automation-read\/grants\/[a-f0-9-]{36}\/revoke$/.test(pathname)) return 'automationRevoke'
  if (/^\/api\/integration\/automation-read\/grants\/[a-f0-9-]{36}$/.test(pathname)) return 'automationGrantDetail'
  if (/^\/api\/integration\/automation-read\/requests\/[a-f0-9-]{36}$/.test(pathname)) return 'automationRequestDetail'
  return undefined
}

/** Closed values-only projection; never forward an exception, request or URL. */
export function transportDiagnostic(input: Record<string, unknown>) {
  const member = (value: unknown, choices: readonly string[], fallback: string): string =>
    typeof value === 'string' && choices.includes(value) ? value : fallback
  const integer = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
  return {
    transport: member(input.transport, ['SDK', 'PROXY', 'PLAYWRIGHT'], 'OTHER'),
    ordinal: integer(input.ordinal),
    requestSequence: integer(input.requestSequence),
    apiKey: member(input.apiKey, ['automationOptions', 'automationGrants', 'automationRequests',
      'automationGrantDetail', 'automationRequestDetail', 'automationRevoke', 'automationScheduleActivation'], 'unknown'),
    method: member(input.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], 'OTHER'),
    event: member(input.event, ['REQUEST', 'HEADERS', 'BODY_DONE', 'SDK_REJECT', 'SIGNAL_ABORT',
      'REQUEST_FINISHED', 'REQUEST_FAILED', 'READER_REJECT', 'UPSTREAM_HEADERS', 'UPSTREAM_END',
      'UPSTREAM_COMPLETE', 'UPSTREAM_EARLY_CLOSE', 'DOWNSTREAM_FINISH', 'DOWNSTREAM_EARLY_CLOSE', 'ERROR'], 'OTHER'),
    operation: member(input.operation, ['FETCH', 'GET_READER', 'READ', 'PROXY', 'MONITOR', 'UPSTREAM_REQUEST', 'UPSTREAM_RESPONSE', 'DOWNSTREAM'], 'OTHER'),
    elapsedMs: integer(input.elapsedMs),
    signalAborted: input.signalAborted === true,
    complete: input.complete === true,
    status: Number.isInteger(input.status) && Number(input.status) >= 100 && Number(input.status) <= 599 ? Number(input.status) : 0,
    failure: member(input.failure, ['ABORT', 'TYPE', 'SYNTAX', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
      'ABORTED', 'FAILED', 'BLOCKED_BY_CLIENT', 'CONNECTION_RESET', 'CONNECTION_CLOSED', 'CONNECTION_REFUSED',
      'EMPTY_RESPONSE', 'TIMED_OUT', 'NETWORK_CHANGED', 'NAME_NOT_RESOLVED', 'INTERNET_DISCONNECTED', 'NONE'], 'OTHER'),
  }
}

export function transportError(error: unknown): string {
  try {
    if (error instanceof Error) {
      if (error.name === 'AbortError') return 'ABORT'
      if (error instanceof TypeError) return 'TYPE'
      if (error instanceof SyntaxError) return 'SYNTAX'
      const code = (error as Error & { code?: unknown }).code
      if (typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(code)) return code
    }
  } catch { /* Exception getters are never allowed to replace an original failure. */ }
  return 'OTHER'
}

/** Serialized by Playwright before app startup. All runtime dependencies are local. */
export function installBrowserSdkDiagnostics() {
  const target = window as unknown as { __plmFullAppTransportDiagnostic?: (value: Record<string, unknown>) => Promise<unknown> }
  const originalFetch = window.fetch
  let ordinal = 0
  // Keep this classifier local: addInitScript serializes this function alone.
  const keyForPath = (pathname: string): string | undefined => {
    const paths: Record<string, string> = {
      '/api/integration/automation-read/options': 'automationOptions',
      '/api/integration/automation-read/grants': 'automationGrants',
      '/api/integration/automation-read/requests': 'automationRequests',
      '/api/integration/automation-read/schedule-activations': 'automationScheduleActivation',
    }
    if (Object.hasOwn(paths, pathname)) return paths[pathname]
    if (/^\/api\/integration\/automation-read\/grants\/[a-f0-9-]{36}\/revoke$/.test(pathname)) return 'automationRevoke'
    if (/^\/api\/integration\/automation-read\/grants\/[a-f0-9-]{36}$/.test(pathname)) return 'automationGrantDetail'
    if (/^\/api\/integration\/automation-read\/requests\/[a-f0-9-]{36}$/.test(pathname)) return 'automationRequestDetail'
    return undefined
  }
  const failureFor = (error: unknown): string => {
    try {
      return error instanceof Error && error.name === 'AbortError' ? 'ABORT'
        : error instanceof TypeError ? 'TYPE' : error instanceof SyntaxError ? 'SYNTAX' : 'OTHER'
    } catch { return 'OTHER' }
  }
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    // The production Automation SDK passes a primitive URL and own-data init.
    // Request/URL/custom objects and accessor init fields pass straight through.
    // Arbitrary Proxy descriptor traps are outside this deliberately bounded domain.
    if (typeof args[0] !== 'string') return Reflect.apply(originalFetch, this, args)
    let apiKey: string | undefined
    let signal: AbortSignal | null | undefined
    let method = 'GET'
    try {
      const url = new URL(args[0], window.location.href)
      if (url.origin === window.location.origin) apiKey = keyForPath(url.pathname)
    } catch { /* Classification must not change the native fetch's result. */ }
    if (!apiKey) return Reflect.apply(originalFetch, this, args)
    let observeInit = true
    try {
      if (args[1] !== undefined) {
        const methodField = Object.getOwnPropertyDescriptor(args[1], 'method')
        const signalField = Object.getOwnPropertyDescriptor(args[1], 'signal')
        if (!methodField || !Object.hasOwn(methodField, 'value') || (signalField && !Object.hasOwn(signalField, 'value')))
          observeInit = false
        else { method = methodField.value; signal = signalField?.value }
      }
    } catch { observeInit = false }
    if (!observeInit) return Reflect.apply(originalFetch, this, args)
    const requestOrdinal = ++ordinal
    const started = performance.now()
    let status = 0
    let bodyDone = false
    const emit = (event: string, operation: string, failure = 'NONE') => {
      try {
        const record = { transport: 'SDK', ordinal: requestOrdinal, apiKey,
          method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'OTHER',
          event, operation, elapsedMs: Math.max(0, Math.floor(performance.now() - started)),
          signalAborted: signal?.aborted === true, complete: bodyDone, status, failure }
        const published = target.__plmFullAppTransportDiagnostic?.(record)
        // A diagnostic channel failure cannot replace the SDK's native result.
        void published?.catch(() => {})
      } catch { /* Only observation failed; the original operation still propagates. */ }
    }
    const aborted = () => emit('SIGNAL_ABORT', 'FETCH')
    // Keep observing after EOF: the SDK may abort during later envelope parsing.
    // The once listener and its signal remain collectable with the original response.
    try { signal?.addEventListener('abort', aborted, { once: true }) } catch { /* Preserve fetch validation. */ }
    const observe = <T>(promise: Promise<T>, fulfilled: (value: T) => void, rejected: (error: unknown) => void) => {
      try {
        void promise.then(value => { try { fulfilled(value) } catch { emit('ERROR', 'MONITOR', 'OTHER') } },
          error => { try { rejected(error) } catch { emit('ERROR', 'MONITOR', 'OTHER') } })
      } catch { emit('ERROR', 'MONITOR', 'OTHER') }
    }
    const instrument = (response: Response) => {
      status = response.status
      emit('HEADERS', 'FETCH')
      const body = response.body
      if (!body) return
      const originalGetReader = body.getReader
      Object.defineProperty(body, 'getReader', { configurable: true, writable: true, value: function (this: unknown, ...readerArgs: unknown[]) {
        let reader: ReadableStreamDefaultReader<Uint8Array>
        try { reader = Reflect.apply(originalGetReader, this, readerArgs) }
        catch (error) { emit('SDK_REJECT', 'GET_READER', failureFor(error)); throw error }
        try {
          const originalRead = reader.read
          Object.defineProperty(reader, 'read', { configurable: true, writable: true, value: function (this: unknown, ...readArgs: unknown[]) {
            let result: ReturnType<typeof originalRead>
            try { result = Reflect.apply(originalRead, this, readArgs) }
            catch (error) { emit('SDK_REJECT', 'READ', failureFor(error)); throw error }
            observe(result, chunk => {
              // EOF is only native stream completion. JSON/envelope/DTO validation
              // runs later in the production SDK, outside this transparent observer.
              if (chunk.done && !bodyDone) { bodyDone = true; emit('BODY_DONE', 'READ') }
              // SDK_REJECT describes only this original fetch/getReader/read stage,
              // never a claim about the complete SDK operation's eventual result.
            }, error => { emit('SDK_REJECT', 'READ', failureFor(error)) })
            return result
          } })
        } catch { emit('ERROR', 'MONITOR', 'OTHER') }
        return reader
      } })
    }
    emit('REQUEST', 'FETCH')
    let result: ReturnType<typeof originalFetch>
    try { result = Reflect.apply(originalFetch, this, args) }
    catch (error) { emit('SDK_REJECT', 'FETCH', failureFor(error)); throw error }
    observe(result, instrument, error => { emit('SDK_REJECT', 'FETCH', failureFor(error)) })
    return result
  }
}

/** tsx/esbuild keepNames adds this helper outside the serialized function. */
export function browserSdkDiagnosticScript(): string {
  return '(() => { function __name(fn, name) { return Object.defineProperty(fn, "name", { value: name, configurable: true }); } ('
    + installBrowserSdkDiagnostics.toString() + ')(); })();'
}

/** Vite's actual http-proxy lifecycle; no flowing/data listener or transport mutation. */
export function observeAutomationProxy(proxy: HttpProxy.Server, publish: (value: ReturnType<typeof transportDiagnostic>) => void) {
  const requests = new WeakMap<IncomingMessage, { ordinal: number; apiKey: string; method: string; started: number; status: number }>()
  let ordinal = 0
  const emit = (request: IncomingMessage, event: string, complete = false, error?: unknown, operation = 'PROXY') => {
    const entry = requests.get(request)
    if (entry) {
      try {
        publish(transportDiagnostic({ ...entry, transport: 'PROXY', event, operation,
          elapsedMs: Math.max(0, Math.floor(performance.now() - entry.started)), complete,
          failure: error === undefined ? 'NONE' : transportError(error) }))
      } catch { /* A diagnostic sink must not replace the proxy's native event behavior. */ }
    }
  }
  proxy.on('proxyReq', (upstream: ClientRequest, request: IncomingMessage, downstream: ServerResponse) => {
    const apiKey = automationTransportKey((request.url ?? '').split('?', 1)[0])
    if (!apiKey) return
    requests.set(request, { ordinal: ++ordinal, apiKey, method: request.method ?? 'OTHER', started: performance.now(), status: 0 })
    emit(request, 'REQUEST')
    ;(upstream as EventEmitter).on(errorMonitor, error => emit(request, 'ERROR', false, error, 'UPSTREAM_REQUEST'))
    ;(downstream as EventEmitter).on(errorMonitor, error => emit(request, 'ERROR', downstream.writableFinished, error, 'DOWNSTREAM'))
    downstream.on('finish', () => emit(request, 'DOWNSTREAM_FINISH', downstream.writableFinished))
    downstream.on('close', () => { if (!downstream.writableFinished) emit(request, 'DOWNSTREAM_EARLY_CLOSE') })
  })
  proxy.on('proxyRes', (upstream: IncomingMessage, request: IncomingMessage) => {
    const entry = requests.get(request)
    if (!entry) return
    entry.status = upstream.statusCode ?? 0
    emit(request, 'UPSTREAM_HEADERS', upstream.complete)
    upstream.on('end', () => {
      emit(request, 'UPSTREAM_END', upstream.complete)
      if (upstream.complete) emit(request, 'UPSTREAM_COMPLETE', true)
    })
    upstream.on('close', () => { if (!upstream.complete) emit(request, 'UPSTREAM_EARLY_CLOSE') })
    ;(upstream as EventEmitter).on(errorMonitor, error => emit(request, 'ERROR', upstream.complete, error, 'UPSTREAM_RESPONSE'))
  })
  ;(proxy as EventEmitter).on(errorMonitor, (error: Error, request: IncomingMessage) => emit(request, 'ERROR', false, error))
}

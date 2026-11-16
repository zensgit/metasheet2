/**
 * Local HTTP server that stands in for the Feishu hosts in tests (the "L2" harness).
 *
 * It binds 127.0.0.1 on an ephemeral port. Responses come from per-route scripts: an ordered list of
 * steps, one consumed per request on that route (a step may be a function of the recorded request).
 * Requests that arrive after a script ran out, or on a route without one, are answered 599 and listed
 * in `unscripted`, so a test can assert that nothing unexpected was asked.
 *
 * Every request is recorded with its method, path, query, headers and body AFTER scrubbing: bearer
 * values, cookies and secret-named form or JSON fields are replaced by placeholders, so a failing
 * assertion that prints the record cannot print a credential.
 *
 * All data used with it is synthetic (tenant `tk_fx_0001`, application `cli_fx_0001`, ...).
 */
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { vi } from 'vitest'

export type MockFeishuRedirectStatus = 301 | 302 | 307 | 308

export type MockFeishuStepSpec =
  /** A JSON answer. */
  | { kind: 'json'; status?: number; body: unknown; headers?: Record<string, string>; delayMs?: number }
  /** A body that is not JSON (or any raw text). */
  | { kind: 'raw'; status?: number; body: string; headers?: Record<string, string>; contentType?: string }
  | { kind: 'redirect'; status: MockFeishuRedirectStatus; location: string }
  /** Headers and the first bytes arrive, then the body stalls until the connection is closed. */
  | { kind: 'stall-body'; status?: number; partial?: string }
  /** A declared length that is never delivered: the connection is cut mid-body. */
  | { kind: 'truncate'; status?: number }
  /** The request is accepted and never answered. */
  | { kind: 'hang' }
  /** The connection is destroyed before any answer. */
  | { kind: 'reset' }

export type MockFeishuStep = MockFeishuStepSpec | ((request: MockFeishuRecordedRequest, index: number) => MockFeishuStepSpec)

export interface MockFeishuRecordedRequest {
  /** `METHOD /path` (no query). */
  route: string
  method: string
  path: string
  query: Record<string, string>
  /** Lower-case header names; credentials replaced by placeholders. */
  headers: Record<string, string>
  /** The body as text; credentials replaced by placeholders. */
  body: string
  /** 0-based index among the requests on the same route. */
  index: number
}

export interface MockFeishuServer {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string
  /** Both roles pointed at this server, for `__feishuEndpointsForTests.replace`. */
  origins(): { openApi: string; accounts: string }
  script(route: string, steps: readonly MockFeishuStep[]): void
  readonly requests: readonly MockFeishuRecordedRequest[]
  /** Number of requests, on one route or on all. */
  count(route?: string): number
  /** Routes (with the request that found no step) for which a request found no scripted answer. */
  readonly unscripted: readonly string[]
  close(): Promise<void>
}

const SECRET_FIELD_RE = /(client_secret|app_secret|access_token|refresh_token|code_verifier|code)/
const SCRUBBED_HEADERS = new Set(['cookie', 'set-cookie', 'proxy-authorization'])

export function scrubMockHeader(name: string, value: string): string {
  const lower = name.toLowerCase()
  if (lower === 'authorization') {
    return /^bearer\s+/i.test(value) ? 'Bearer <token>' : '<credential>'
  }
  if (SCRUBBED_HEADERS.has(lower)) return '<credential>'
  return value
}

export function scrubMockBody(body: string): string {
  let scrubbed = body.replace(
    new RegExp(`(^|&)(${SECRET_FIELD_RE.source})=([^&]*)`, 'g'),
    (_match, lead: string, field: string) => `${lead}${field}=<${field === 'client_secret' || field === 'app_secret' ? 'secret' : 'value'}>`,
  )
  scrubbed = scrubbed.replace(
    new RegExp(`("(?:${SECRET_FIELD_RE.source})"\\s*:\\s*)"[^"]*"`, 'g'),
    (_match, lead: string) => `${lead}"<value>"`,
  )
  return scrubbed
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function startFeishuMockServer(): Promise<MockFeishuServer> {
  const scripts = new Map<string, MockFeishuStep[]>()
  const consumed = new Map<string, number>()
  const requests: MockFeishuRecordedRequest[] = []
  const unscripted: string[] = []
  const sockets = new Set<Socket>()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = `${req.method ?? 'GET'} ${url.pathname}`
    const rawBody = await readBody(req)
    const index = consumed.get(route) ?? 0
    consumed.set(route, index + 1)
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name] = scrubMockHeader(name, Array.isArray(value) ? value.join(', ') : String(value ?? ''))
    }
    const record: MockFeishuRecordedRequest = {
      route,
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: scrubMockBody(rawBody),
      index,
    }
    requests.push(record)

    const steps = scripts.get(route)
    const entry = steps?.[index]
    if (entry === undefined) {
      unscripted.push(route)
      res.writeHead(599, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: -1 }))
      return
    }
    const step = typeof entry === 'function' ? entry(record, index) : entry

    switch (step.kind) {
      case 'json': {
        const respond = () => {
          res.writeHead(step.status ?? 200, { 'content-type': 'application/json', ...step.headers })
          res.end(JSON.stringify(step.body))
        }
        if (step.delayMs && step.delayMs > 0) setTimeout(respond, step.delayMs)
        else respond()
        return
      }
      case 'raw':
        res.writeHead(step.status ?? 200, { 'content-type': step.contentType ?? 'text/html', ...step.headers })
        res.end(step.body)
        return
      case 'redirect':
        res.writeHead(step.status, { location: step.location })
        res.end()
        return
      case 'stall-body':
        res.writeHead(step.status ?? 200, { 'content-type': 'application/json' })
        res.write(step.partial ?? '{"code":0,')
        return
      case 'truncate':
        res.writeHead(step.status ?? 200, { 'content-type': 'application/json', 'content-length': '400' })
        res.write('{"code":0,"da')
        setTimeout(() => req.socket.destroy(), 10)
        return
      case 'hang':
        return
      case 'reset':
        req.socket.destroy()
        return
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    origin,
    origins: () => ({ openApi: origin, accounts: origin }),
    script(route, steps) {
      scripts.set(route, [...steps])
      consumed.set(route, 0)
    },
    requests,
    count: (route) => (route === undefined ? requests.length : requests.filter((request) => request.route === route).length),
    unscripted,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export interface NoExternalFetchGuard {
  /** Host names that a fetch tried to reach outside the loopback; the call itself was refused. */
  readonly violations: readonly string[]
  restore(): void
}

/**
 * Wraps the global fetch so that a target outside the loopback fails the call and is recorded. The
 * transport resolves `fetch` per call, so the wrapper is the function it uses.
 *
 * The suite-wide setup stubs `fetch` with a function that returns nothing; stubs made with
 * `vi.stubGlobal` are lifted first so that the wrapper sits on the runtime's own fetch.
 */
export function installNoExternalFetchGuard(): NoExternalFetchGuard {
  vi.unstubAllGlobals()
  const original = globalThis.fetch
  const violations: string[] = []
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let host = ''
    try {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      host = new URL(target).host
    } catch {
      host = '<unparseable>'
    }
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    if (!LOOPBACK_HOSTS.has(hostname)) {
      violations.push(hostname)
      throw new TypeError('external network is not available in tests')
    }
    return original(input as never, init)
  }) as typeof fetch
  globalThis.fetch = guarded
  return {
    violations,
    restore() {
      globalThis.fetch = original
    },
  }
}

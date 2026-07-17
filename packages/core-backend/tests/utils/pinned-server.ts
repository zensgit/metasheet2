/**
 * Pinned per-suite HTTP server for supertest specs — #4154 root-cause eradication (verification slice).
 *
 * Mechanism being eliminated: `request(app)` makes supertest call `app.listen(0)` for EVERY request,
 * creating a fresh ephemeral-port listener per request. Under full-suite churn the OS recycles a
 * just-closed port to another test's listener and a racing connection lands on the wrong app
 * (the #4169 405-on-/api/approvals proof). `request(baseUrl)` never listens — so a suite that binds
 * ONE server for its whole lifetime and routes every request through it cannot be a cross-talk
 * victim or collider.
 *
 * Usage (preserves per-test app semantics — the listener is pinned, the app stays swappable):
 *
 *   const pinned = usePinnedServer()
 *   beforeEach(() => { pinned.setApp(buildApp()) })
 *   it('...', async () => { await request(pinned.url()).get('/api/...') })
 *
 * Suites whose app varies per test keep exactly their old construction sites; only the transport
 * changes. Do NOT share a PinnedServer across files — call usePinnedServer() once per suite file.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll } from 'vitest'

export type PinnedRequestListener = (req: http.IncomingMessage, res: http.ServerResponse) => void

export interface PinnedServer {
  /** Base URL (http://127.0.0.1:<port>) — stable for the whole suite file. */
  url(): string
  /** Install the app that serves subsequent requests (typically in beforeEach). */
  setApp(app: PinnedRequestListener): void
}

export function usePinnedServer(): PinnedServer {
  let current: PinnedRequestListener | null = null
  let baseUrl = ''

  const server = http.createServer((req, res) => {
    if (!current) {
      // Fail loudly rather than hanging: a suite that forgot setApp gets a diagnosable 500.
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain')
      res.end('pinned-server: no app installed — call setApp() (e.g. in beforeEach) before requests')
      return
    }
    current(req, res)
  })

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    // Node ≥18.2: drop idle keep-alive sockets so close() cannot hang on a lingering agent socket.
    server.closeIdleConnections?.()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  })

  return {
    url() {
      if (!baseUrl) {
        throw new Error('pinned-server: not listening yet — url() is only valid inside tests/hooks after beforeAll')
      }
      return baseUrl
    },
    setApp(app: PinnedRequestListener) {
      current = app
    },
  }
}

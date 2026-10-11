import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Socket } from 'node:net'
import express, { type ErrorRequestHandler } from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import type { Pool } from 'pg'
import type { Database } from '../../src/db/types'
import { vi } from 'vitest'
import type { AutomationReadOwnerPort } from '../../src/routes/integration-automation-read'
import type { AutomationService } from '../../src/multitable/automation-service'

type Identity = { actorId: string; tenantId?: string }
type RequestOptions = { token?: string; body?: unknown; headers?: Record<string, string> }
type HttpResult = { status: number; body: unknown; headers: Record<string, string> }
type Restorable = { mockRestore(): void }
const prefix = '/api/integration/automation-read'
const rulePrefix = '/api/multitable'
const fixtureError = 'AUTOMATION_READ_HTTP_ACCEPTANCE_FAILED'
const authEvidenceError = 'AUTOMATION_READ_HTTP_AUTH_SQL_NOT_OBSERVED'

/**
 * Owned-loopback acceptance harness, not an auth substitute. The caller owns the
 * already-scoped synthetic Pool and all schema/data lifecycle. Only shared DB
 * transport is redirected, including auth queries and actual record transaction
 * connections; JWT, RBAC, record gates and ConnectionPool's transaction control
 * remain production code. Do not run this process-global
 * transport fixture concurrently with another such fixture. No source/credential
 * discovery or DB creation occurs. Drain covers returned handler Promises, not
 * detached background tasks started by production code.
 */
export async function createAutomationReadHttpAcceptance(input: {
  pool: Pool
  port: AutomationReadOwnerPort
  /** Optional actual shared service for the production ordinary rule router. */
  automationService?: AutomationService
  /** Test-only opt-in to one exact sheet's real POST FWB confirmation route. */
  fwbConfirmationSheetId?: string
  /** Test-only opt-in to one exact sheet's existing hot revert preview/execute routes. */
  recoverySheetId?: string
}): Promise<{
  readonly apiOrigin: string
  request(method: string, path: string, options?: RequestOptions): Promise<HttpResult>
  token(identity: Identity): string
  /** Test-only lifecycle observation; neither method closes/restores transport. */
  drainHandlers(): Promise<void>
  pendingHandlerCount(): number
  close(): Promise<void>
}> {
  const restoredEnv = new Map<string, string | undefined>()
  const spies: Restorable[] = []
  const sockets = new Set<Socket>()
  const identities = new Map<string, Identity>()
  const observed = new AsyncLocalStorage<Set<string>>()
  let invalidateUserPerms: ((actorId: string) => void) | undefined
  let server: Server | undefined
  let closed = false
  let closing: Promise<void> | undefined
  let restoreAutomationService: (() => void) | undefined
  const pendingHandlers = new Set<Promise<void>>()
  let handlerRejected = false
  let assertHandlerStructure: (() => void) | undefined
  const setEnv = (key: string, value: string) => {
    restoredEnv.set(key, process.env[key])
    process.env[key] = value
  }

  async function drainHandlers(): Promise<void> {
    // Socket close (including the bounded forced close below) does not cancel
    // an async Express handler. Keep all DB forwarding installed until its real
    // Promise settles, including post-COMMIT formula/echo reads. Deliberately no
    // timeout that could restore the original transport under a live handler.
    while (pendingHandlers.size) await Promise.all([...pendingHandlers])
    assertHandlerStructure?.()
    if (handlerRejected) throw new Error(fixtureError)
  }

  function observeHandlers(root: unknown): void {
    type Handle = (this: unknown, ...args: unknown[]) => unknown
    type Layer = { handle: Handle; route?: unknown }
    const stacks: Array<{ owner: object; stack: unknown[]; entries: unknown[] }> = []
    const handles: Array<{ layer: Layer; wrapper: Handle }> = []
    const visited = new Set<object>()
    const object = (value: unknown): value is object => value !== null
      && (typeof value === 'object' || typeof value === 'function')
    const inspect = (value: unknown, depth: number): void => {
      if (!object(value) || depth > 32) throw new Error(fixtureError)
      if (visited.has(value)) return
      visited.add(value)
      const stack: unknown = Reflect.get(value, 'stack')
      const params: unknown = Reflect.get(value, 'params')
      // This fixture uses factory-created Express 4 routers, not arbitrary
      // callback param hooks or a dynamically extended application. Refuse a
      // changed assembly rather than pretending its unobserved work is drained.
      if (!Array.isArray(stack) || (params !== undefined
        && (!object(params) || Reflect.ownKeys(params).length !== 0))) throw new Error(fixtureError)
      stacks.push({ owner: value, stack, entries: [...stack] })
      for (const entry of stack) {
        if (!object(entry) || typeof Reflect.get(entry, 'handle') !== 'function'
          || handles.length >= 10_000) throw new Error(fixtureError)
        const layer = entry as Layer
        const original = layer.handle
        if (layer.route !== undefined) inspect(layer.route, depth + 1)
        if (Reflect.get(original, 'stack') !== undefined) inspect(original, depth + 1)
        const wrapper: Handle = function (this: unknown, ...args: unknown[]): unknown {
          // Leave these gates on the fixture-owned layers after cleanup. A late
          // parser/next callback must not enter original code after DB restore.
          // Never manufacture next(), change its arguments, or finish a running
          // handler early; only refuse a handler which has not entered yet.
          if (closed) {
            const response = args[original.length === 4 ? 2 : 1] as express.Response
            if (!response.destroyed && !response.writableEnded) {
              if (response.headersSent) response.destroy()
              else {
                response.statusCode = 503
                response.setHeader('Content-Type', 'application/json')
                response.end(JSON.stringify({ ok: false, error: { code: fixtureError } }))
              }
            }
            return
          }
          assertHandlerStructure?.()
          const result: unknown = Reflect.apply(original, this, args)
          if (object(result) && typeof Reflect.get(result, 'then') === 'function') {
            // Observe completion separately and return the original Promise.
            // Unexpected rejection fails fixture cleanup with a fixed code; it
            // is not swallowed into a successful acceptance result.
            const settled: Promise<void> = Promise.resolve(result).then(
              () => { pendingHandlers.delete(settled) },
              () => { handlerRejected = true; pendingHandlers.delete(settled) },
            )
            pendingHandlers.add(settled)
          }
          return result
        }
        // Express 4 distinguishes ordinary and error handlers by arity. Preserve
        // the exact original signature classification, including four arguments.
        Object.defineProperty(wrapper, 'length', { value: original.length })
        layer.handle = wrapper
        handles.push({ layer, wrapper })
      }
    }
    inspect(root, 0)
    assertHandlerStructure = () => {
      if (stacks.some(({ owner, stack, entries }) => Reflect.get(owner, 'stack') !== stack
        || stack.length !== entries.length || stack.some((entry, index) => entry !== entries[index]))
        || handles.some(({ layer, wrapper }) => layer.handle !== wrapper)) throw new Error(fixtureError)
    }
    assertHandlerStructure()
  }

  function close(): Promise<void> {
    if (closing) return closing
    closed = true
    closing = (async () => {
      try {
        if (server?.listening) {
          await new Promise<void>((resolve) => {
            // Requests use Connection: close. The bounded fallback also releases
            // this fixture's own sockets after an interrupted acceptance case.
            const timer = setTimeout(() => {
              for (const socket of sockets) socket.destroy()
            }, 5_000)
            timer.unref()
            server!.close(() => { clearTimeout(timer); resolve() })
            server!.closeIdleConnections()
          })
        }
      } finally {
        try {
          await drainHandlers()
        } finally {
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          for (const identity of identities.values()) invalidateUserPerms?.(identity.actorId)
          identities.clear()
          for (const spy of spies.reverse()) spy.mockRestore()
          restoreAutomationService?.()
          for (const [key, value] of restoredEnv) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
          observed.disable()
        }
      }
    })()
    return closing
  }

  try {
    setEnv('NODE_ENV', 'production')
    setEnv('RBAC_TOKEN_TRUST', 'false')
    setEnv('RBAC_BYPASS', 'false')
    setEnv('RBAC_OPTIONAL', '0')
    // AuthService may backfill attendance roles in platform mode. This fixture
    // exercises the deployed stock-prep mode and never performs that auth write.
    setEnv('PRODUCT_MODE', 'plm-workbench')

    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const infrastructure = poolManager.get()
    // Capture before replacing the getter: transaction() uses this actual Pool
    // directly, so a getter-only redirect would escape the owned schema. Forward
    // its original Promise/callback connect overloads without replacing BEGIN,
    // COMMIT/ROLLBACK, depth tracking, the real client, or its release(). Do not
    // spy when these are already the same Pool (which would recurse).
    const infrastructurePool = infrastructure.getInternalPool()
    if (infrastructurePool !== input.pool) {
      spies.push(vi.spyOn(infrastructurePool, 'connect').mockImplementation(input.pool.connect.bind(input.pool)))
    }
    const originalQuery = input.pool.query.bind(input.pool)
    spies.push(vi.spyOn(input.pool, 'query').mockImplementation(((...args: Parameters<Pool['query']>) => {
      const evidence = observed.getStore()
      const result = originalQuery(...args)
      // All real verifier/RBAC query sites use the Promise overload. Recording
      // only after completion distinguishes actual SQL from a dispatched stub.
      if (evidence && result && typeof (result as PromiseLike<unknown>).then === 'function') {
        return Promise.resolve(result).then(value => {
          if (typeof args[0] === 'string') {
            for (const table of ['users', 'user_roles', 'role_permissions', 'user_permissions',
              'user_orgs', 'user_session_revocations']) {
              if (new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`, 'i').test(args[0])) evidence.add(table)
            }
          }
          return value
        })
      }
      return result
    }) as Pool['query']))
    spies.push(vi.spyOn(infrastructure, 'query').mockImplementation((statement, params) => input.pool.query(statement, params)))
    spies.push(vi.spyOn(infrastructure, 'getInternalPool').mockReturnValue(input.pool))
    const pgModule = await import('../../src/db/pg')
    if (!pgModule.pool) throw new Error(fixtureError)
    if (pgModule.pool !== input.pool) {
      spies.push(vi.spyOn(pgModule.pool, 'query').mockImplementation(input.pool.query.bind(input.pool)))
    }

    const { authService } = await import('../../src/auth/AuthService')
    const { jwtAuthMiddleware } = await import('../../src/auth/jwt-middleware')
    const rbac = await import('../../src/rbac/service')
    invalidateUserPerms = rbac.invalidateUserPerms
    const listPermissions = rbac.listUserPermissions
    spies.push(vi.spyOn(rbac, 'listUserPermissions').mockImplementation(actorId => {
      // Invalidate at the real function's synchronous cache-read boundary, not
      // only at request entry: a parallel metadata request could populate the
      // cache during AuthService's intervening awaited SQL. No permission result
      // is replaced. Every request must still execute and pass the real queries
      // recorded below; otherwise this fixture refuses it with its evidence error.
      if (observed.getStore()) rbac.invalidateUserPerms(actorId)
      return listPermissions(actorId)
    }))
    const { createIntegrationAutomationReadRouter, automationReadNoStoreMiddleware,
      automationReadParseErrorHandler } = await import('../../src/routes/integration-automation-read')
    let ordinaryRules: express.Router | undefined
    let executionReads: express.Router | undefined
    if (input.automationService) {
      const automation = await import('../../src/multitable/automation-service')
      if (!(input.automationService instanceof automation.AutomationService)) throw new Error(fixtureError)
      const previous = automation.getAutomationServiceInstance()
      automation.setAutomationServiceInstance(input.automationService)
      restoreAutomationService = () => automation.setAutomationServiceInstance(previous)
      // Mount the production router, including its own sheet capability, live
      // sheet, parser/preflight and service gates. No handlers are reconstructed.
      const { univerMetaRouter } = await import('../../src/routes/univer-meta')
      ordinaryRules = univerMetaRouter()
      const { createAutomationRoutes } = await import('../../src/routes/automation')
      executionReads = createAutomationRoutes(input.automationService)
      // Redirect only the query-builder transport to the owned schema. The real
      // log service builds/executes its SQL and maps the actual PostgreSQL rows.
      // This client shares caller ownership of the pool; close() must not end it.
      const scopedDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: input.pool }) })
      const { db: logDb } = await import('../../src/db/db')
      spies.push(vi.spyOn(logDb, 'selectFrom').mockImplementation(scopedDb.selectFrom.bind(scopedDb)))
    }
    const app = express()
    app.disable('x-powered-by')
    app.use(prefix, automationReadNoStoreMiddleware)
    app.use(express.json({ limit: '64kb' }))
    app.use((req, _res, next) => {
      const authorization = req.headers.authorization
      const identity = typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? identities.get(authorization.slice(7)) : undefined
      if (identity) rbac.invalidateUserPerms(identity.actorId)
      observed.run(new Set(), next)
    })
    app.use(jwtAuthMiddleware)
    app.use((req, res, next) => {
      const evidence = observed.getStore()
      const required = ['users', 'user_roles', 'role_permissions', 'user_permissions', 'user_session_revocations']
      if (req.authenticatedTenantId) required.push('user_orgs')
      if (!req.user || !evidence || required.some(table => !evidence.has(table))) {
        res.status(500).json({ ok: false, error: { code: authEvidenceError } })
        return
      }
      next()
    })
    app.use(prefix, createIntegrationAutomationReadRouter(input.port))
    app.use(prefix, automationReadParseErrorHandler)
    if (ordinaryRules) app.use(rulePrefix, ordinaryRules)
    if (executionReads) app.use(rulePrefix, executionReads)
    app.use((_req, res) => { res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } }) })
    const onError: ErrorRequestHandler = (_error, _req, res, _next) => {
      res.status(500).json({ ok: false, error: { code: fixtureError } })
    }
    app.use(onError)
    // Snapshot the complete real middleware/router/route graph before serving:
    // this includes JWT promises as well as each route's final async handler.
    observeHandlers(Reflect.get(app, '_router'))
    server = createServer(app)
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new Error(fixtureError))
      server!.once('error', failed)
      server!.listen(0, '127.0.0.1', () => {
        server!.removeListener('error', failed)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error(fixtureError)
    const listeningPort = address.port

    return {
      apiOrigin: `http://127.0.0.1:${listeningPort}`,
      token(identity) {
        if (closed) throw new Error(fixtureError)
        const token = authService.createToken({
          id: identity.actorId, email: null, name: 'Synthetic acceptance user', role: 'user', permissions: [],
          ...(identity.tenantId === undefined ? {} : { tenantId: identity.tenantId }),
          created_at: new Date(), updated_at: new Date(),
        })
        identities.set(token, { ...identity })
        return token
      },
      async request(method, path, options = {}) {
        const ownerPath = path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)
        const ordinaryPath = input.automationService && /^\/api\/multitable\/sheets\/[^/?]+\/automations(?:\/[^/?]+)?(?:\?[^#]*)?$/u.test(path)
        const fwbConfirmationPath = input.automationService && input.fwbConfirmationSheetId && method === 'POST'
          && path === `${rulePrefix}/sheets/${encodeURIComponent(input.fwbConfirmationSheetId)}/automations/fwb/confirm`
        const recordCreatePath = input.automationService && method === 'POST' && path === `${rulePrefix}/records`
        const recoveryPath = input.automationService && input.recoverySheetId && method === 'POST'
          && ['revert-preview', 'revert-execute'].some(action =>
            path === `${rulePrefix}/sheets/${encodeURIComponent(input.recoverySheetId!)}/${action}`)
        const executionPath = input.automationService && method === 'GET' && (
          /^\/api\/multitable\/sheets\/[^/?]+\/automations\/[^/?]+\/logs(?:\?[^#]*)?$/u.test(path)
          || /^\/api\/multitable\/automation-executions(?:\/[^/?]+)?(?:\?[^#]*)?$/u.test(path))
        if (closed || !/^[A-Z]+$/.test(method)
          || !(ownerPath || ordinaryPath || fwbConfirmationPath || recordCreatePath || recoveryPath || executionPath)
          || /[\r\n\\]/.test(path)) throw new Error(fixtureError)
        try {
          const body = options.body === undefined ? undefined : JSON.stringify(options.body)
          const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
          if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
          if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json'
          headers.connection = 'close'
          return await new Promise<HttpResult>((resolve, reject) => {
            const request = httpRequest({ hostname: '127.0.0.1', port: listeningPort, path, method, headers, agent: false }, response => {
              const chunks: Buffer[] = []
              let length = 0
              response.on('data', (chunk: Buffer) => {
                length += chunk.length
                if (length > 1_048_576) request.destroy(new Error(fixtureError))
                else chunks.push(chunk)
              })
              response.once('error', () => reject(new Error(fixtureError)))
              response.once('end', () => {
                try {
                  const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                  const code = (data as { error?: { code?: unknown } } | null)?.error?.code
                  if (code === authEvidenceError || code === fixtureError) throw new Error(fixtureError)
                  resolve({ status: response.statusCode ?? 0, body: data, headers: Object.fromEntries(
                    Object.entries(response.headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
                      .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value]),
                  ) })
                } catch { reject(new Error(fixtureError)) }
              })
            })
            request.setTimeout(10_000, () => request.destroy(new Error(fixtureError)))
            request.once('error', () => reject(new Error(fixtureError)))
            request.end(body)
          })
        } catch { throw new Error(fixtureError) }
      },
      drainHandlers,
      pendingHandlerCount: () => pendingHandlers.size,
      close,
    }
  } catch {
    await close()
    throw new Error(fixtureError)
  }
}

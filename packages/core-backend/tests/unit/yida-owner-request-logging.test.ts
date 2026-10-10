import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import ts from 'typescript'
import winston from 'winston'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enrichRequestContext, getRequestContext, type RequestContext } from '../../src/context/request-context'
import { getLogContext, Logger, runWithLogContext, setLogContext } from '../../src/core/logger'
import { isYidaOwnerHttpObservationPath, YIDA_OWNER_HTTP_PREFIX as PREFIX } from '../../src/integration/yida-owner-http-observation'
import { correlationContextEnrichmentMiddleware, correlationErrorHandler, correlationIdMiddleware } from '../../src/middleware/correlation'
import { methodOverrideMiddleware } from '../../src/middleware/method-override'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sentinels = Object.freeze({
  path: 'd1c94160-4bc8-4c11-95f5-526597a3ab01',
  query: 'YidaQuery_SENTINEL_42',
  body: 'YidaBody_SENTINEL_42',
  authorization: 'YidaAuthorization_SENTINEL_42',
  header: 'YidaHeader_SENTINEL_42',
  correlation: 'YidaCorrelation_SENTINEL_ASCII_42',
  requestId: 'YidaRequestId_SENTINEL_42',
  message: 'YidaMessage_SENTINEL_42',
  meta: 'YidaMeta_SENTINEL_42',
  error: 'YidaError_SENTINEL_42',
  stack: 'YidaStack_SENTINEL_42',
  user: 'YidaUser_SENTINEL_42',
  tenant: 'YidaTenant_SENTINEL_42',
  trace: 'YidaTrace_SENTINEL_42',
  span: 'YidaSpan_SENTINEL_42',
})

/** Load production producers without importing index.ts and booting its graph.
 * Only direct, unconditional one-arrow app.use registrations in setupMiddleware
 * qualify. The evaluated bodies come from the real TypeScript AST, never copies. */
function productionProducers(logger: Logger): { context: RequestHandler; requestLog: RequestHandler } {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const classes = source.statements.filter(ts.isClassDeclaration).filter(node => node.name?.text === 'MetaSheetServer')
  expect(classes).toHaveLength(1)
  const methods = classes[0].members.filter(ts.isMethodDeclaration)
    .filter(node => ts.isIdentifier(node.name) && node.name.text === 'setupMiddleware')
  expect(methods).toHaveLength(1)
  const arrows = methods[0].body!.statements.flatMap(statement => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return []
    const call = statement.expression
    if (call.expression.getText(source) !== 'this.app.use' || call.arguments.length !== 1
      || !ts.isArrowFunction(call.arguments[0])) return []
    return [call.arguments[0]]
  })
  function calls(arrow: ts.ArrowFunction, callee: string): boolean {
    let found = false
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(source) === callee) found = true
      ts.forEachChild(node, visit)
    }
    visit(arrow)
    return found
  }
  function evaluate(callee: string): RequestHandler {
    const selected = arrows.filter(arrow => calls(arrow, callee))
    expect(selected, `unique unconditional production ${callee} arrow`).toHaveLength(1)
    const javascript = ts.transpileModule(`(${selected[0].getText(source)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    return new Function('setLogContext', 'crypto', 'isYidaOwnerHttpObservationPath', `return ${javascript}`)
      .call({ logger }, setLogContext, crypto, isYidaOwnerHttpObservationPath) as RequestHandler
  }
  return { context: evaluate('setLogContext'), requestLog: evaluate('this.logger.info') }
}

function syntheticRequest(method: string, path: string): Request {
  return {
    method, path, url: `${path}?probe=${sentinels.query}`, originalUrl: `${path}?probe=${sentinels.query}`,
    query: { probe: sentinels.query }, body: { private: sentinels.body },
    headers: {
      authorization: `Bearer ${sentinels.authorization}`,
      'x-private-probe': sentinels.header,
      'x-correlation-id': sentinels.correlation,
      'x-request-id': sentinels.requestId,
    },
  } as unknown as Request
}

function exerciseProduction<T = undefined>(req: Request, logger: Logger, work?: (res: Response) => T): {
  header: unknown; correlationId: unknown; context: RequestContext | undefined; downstream: T | undefined
} {
  const producers = productionProducers(logger)
  const headers = new Map<string, unknown>()
  const res = { setHeader: (key: string, value: unknown) => headers.set(key.toLowerCase(), value) } as unknown as Response
  let correlationId: unknown
  let context: RequestContext | undefined
  let downstream: T | undefined
  correlationIdMiddleware(req, res, (() => {
    producers.context(req, res, (() => {
      producers.requestLog(req, res, (() => {
        correlationId = getRequestContext()?.correlationId
        context = getRequestContext()
        downstream = work?.(res)
      }) as NextFunction)
    }) as NextFunction)
  }) as NextFunction)
  return { header: headers.get('x-correlation-id'), correlationId, context, downstream }
}

function consoleOutput(entries: Array<Record<PropertyKey, unknown>>): string {
  // Includes every own Console field AND symbols (not just the formatted line).
  return inspect(entries, { depth: null, colors: false, getters: false })
}

function assertPrivateEntry(entry: Record<PropertyKey, unknown>, level: string, correlationId: unknown): void {
  expect(entry.message).toBe(`YIDA_OWNER_HTTP_${level.toUpperCase()}`)
  expect(entry[Symbol.for('level')]).toBe(level)
  expect(entry.correlation_id).toBe(correlationId)
  expect(entry.requestId).toBe(correlationId)
  expect(entry.service).toBe('metasheet')
  expect(entry.context).toBe('YidaPrivateRequestSynthetic')
  expect(entry.timestamp).toEqual(expect.any(String))
  expect(Object.keys(entry).sort()).toEqual([
    'context', 'correlation_id', 'level', 'message', 'requestId', 'service', 'timestamp',
  ])
  expect(entry[Symbol.for('message')]).toEqual(expect.any(String))
  for (const sentinel of Object.values(sentinels)) expect(consoleOutput([entry])).not.toContain(sentinel)
}

function unchangedRequest(req: Request): () => void {
  const { method, path, url, originalUrl, query, body, headers, user } = req
  const fields = JSON.stringify({ method, path, url, originalUrl, query, body, headers, user })
  return () => {
    expect(JSON.stringify({ method: req.method, path: req.path, url: req.url, originalUrl: req.originalUrl,
      query: req.query, body: req.body, headers: req.headers, user: req.user })).toBe(fields)
    expect(req.query).toBe(query)
    expect(req.body).toBe(body)
    expect(req.headers).toBe(headers)
    expect(req.user).toBe(user)
  }
}

const ownerPaths = [
  ['GET', `${PREFIX}/initialization`],
  ['POST', `${PREFIX}/initialization`],
  ['POST', `${PREFIX}/initialization/%ZZ-${sentinels.path}`],
  ['GET', `${PREFIX}/approvals/${sentinels.path}`],
  ['POST', `${PREFIX}/approvals/${sentinels.path}/revoke`],
  ['GET', PREFIX],
  ['GET', `${PREFIX}/`],
  ['GET', `${PREFIX.toUpperCase()}/APPROVALS/${sentinels.path}/`],
  ['POST', `${PREFIX}/unknown/${sentinels.path}`],
  ['POST', `${PREFIX}/approvals/%ZZ-${sentinels.path}/revoke`],
  ['GET', `${PREFIX}/unknown/%2f${sentinels.path}`],
] as const

const siblingPaths = [
  `${PREFIX}-sibling/${sentinels.path}`,
  `${PREFIX}ish/${sentinels.path}`,
  `${PREFIX}%2fapprovals/${sentinels.path}`,
  '/api/integration/yida-owner%2dsend/approvals/sibling',
  '/api/integration/other-owner-send',
  '/probe',
]

describe('owner private request logging through production producers and Console', () => {
  let logger: Logger
  let entries: Array<Record<PropertyKey, unknown>>

  beforeEach(() => {
    vi.stubEnv('LOG_LEVEL', 'debug')
    entries = []
    vi.spyOn(winston.transports.Console.prototype, 'log').mockImplementation((info: Record<PropertyKey, unknown>, callback: () => void) => {
      entries.push({ ...info })
      callback()
    })
    logger = new Logger('YidaPrivateRequestSynthetic')
  })

  afterEach(() => {
    ;(logger as unknown as { winston: winston.Logger }).winston.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it.each(ownerPaths)('%s %s does not enter actual Console output', (method, path) => {
    const req = syntheticRequest(method, path)
    const assertUnchanged = unchangedRequest(req)
    const result = exerciseProduction(req, logger)
    expect(entries).toHaveLength(1)
    assertPrivateEntry(entries[0], 'info', result.header)
    expect(result.header).toMatch(UUID)
    expect(result.correlationId).toBe(result.header)
    expect(req.correlationId).toBe(result.header)
    expect(result.context?.privateObservationSurface).toBe('yida-owner-http')
    expect(getLogContext()?.requestId).toBe(result.header)
    assertUnchanged()
  })

  it.each(siblingPaths)('preserves ordinary producer output for sibling %s', path => {
    const req = syntheticRequest('GET', path)
    const assertUnchanged = unchangedRequest(req)
    const result = exerciseProduction(req, logger)
    expect(entries).toHaveLength(1)
    expect(entries[0].message).toBe(`GET ${path}`)
    expect(entries[0].correlation_id).toBe(sentinels.correlation)
    expect(entries[0].requestId).toBe(sentinels.requestId)
    expect(result.header).toBe(sentinels.correlation)
    expect(result.context?.privateObservationSurface).toBeUndefined()
    expect(consoleOutput(entries)).toContain(path)
    expect(consoleOutput(entries)).toContain(sentinels.correlation)
    expect(consoleOutput(entries)).toContain(sentinels.requestId)
    assertUnchanged()
  })

  it.each(['path', 'query', 'body', 'authorization', 'header', 'correlation', 'requestId'] as const)(
    'drops the independent synthetic %s sentinel at Console', source => {
      const req = syntheticRequest('GET', `${PREFIX}/approvals/local-synthetic-id`)
      req.headers = {}
      req.query = {}
      req.body = {}
      if (source === 'path') Object.assign(req, { path: `${PREFIX}/approvals/${sentinels.path}` })
      if (source === 'query') {
        req.query = { probe: sentinels.query }
        req.url = `${req.path}?probe=${sentinels.query}`
        req.originalUrl = req.url
      }
      if (source === 'body') req.body = { private: sentinels.body }
      if (source === 'authorization') req.headers.authorization = `Bearer ${sentinels.authorization}`
      if (source === 'header') req.headers['x-private-probe'] = sentinels.header
      if (source === 'correlation') req.headers['x-correlation-id'] = sentinels.correlation
      if (source === 'requestId') req.headers['x-request-id'] = sentinels.requestId
      const assertUnchanged = unchangedRequest(req)
      const result = exerciseProduction(req, logger)
      expect(entries).toHaveLength(1)
      assertPrivateEntry(entries[0], 'info', result.header)
      assertUnchanged()
    },
  )

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'drops raw message/meta/error, identity and trace for actual %s', level => {
      const req = syntheticRequest('POST', `${PREFIX}/approvals/${sentinels.path}/revoke`)
      req.user = { id: sentinels.user, tenantId: sentinels.tenant } as Express.Request['user']
      const result = runWithLogContext({ traceId: sentinels.trace, spanId: sentinels.span }, () =>
        exerciseProduction(req, logger, res => {
          correlationContextEnrichmentMiddleware(req, res, (() => undefined) as NextFunction)
          const context = getRequestContext()
          expect(context?.privateObservationSurface).toBe('yida-owner-http')
          expect(context?.userId).toBe(sentinels.user)
          expect(context?.tenantId).toBe(sentinels.tenant)
          const error = new Error(sentinels.error)
          error.stack = sentinels.stack
          if (level === 'error') logger.error(sentinels.message, error)
          else if (level === 'warn') logger.warn(sentinels.message, error)
          else logger[level](sentinels.message, { private: sentinels.meta, nested: { error } })
        }))
      expect(entries).toHaveLength(2)
      assertPrivateEntry(entries[0], 'info', result.header)
      assertPrivateEntry(entries[1], level, result.header)
    },
  )

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'branches before Proxy message/meta/error traps for actual %s', level => {
      let reads = 0
      const rejectRead = (): never => { reads += 1; throw new Error('synthetic forbidden input read') }
      const handler: ProxyHandler<object> = {
        get: rejectRead, getPrototypeOf: rejectRead, ownKeys: rejectRead, getOwnPropertyDescriptor: rejectRead,
      }
      const message = new Proxy({}, handler) as unknown as string
      const meta = new Proxy(level === 'error' || level === 'warn' ? new Error('synthetic') : {}, handler)
      const result = exerciseProduction(syntheticRequest('GET', `${PREFIX}/unknown/private`), logger, () => {
        expect(() => {
          if (level === 'error') logger.error(message, meta as Error)
          else logger[level](message, meta as Record<string, unknown>)
        }).not.toThrow()
      })
      expect(reads).toBe(0)
      expect(entries).toHaveLength(2)
      assertPrivateEntry(entries[1], level, result.header)
    },
  )

  it.each(['warn', 'error'] as const)('does not read foreign Error getters at actual %s exit', level => {
    let reads = 0
    const error = new Error('synthetic')
    void error.stack // Materialize V8's lazy stack before installing hostile getters.
    const getter = (): never => { reads += 1; throw new Error('synthetic forbidden Error getter') }
    Object.defineProperties(error, { message: { get: getter }, stack: { get: getter } })
    const result = exerciseProduction(syntheticRequest('GET', PREFIX), logger, () => {
      expect(() => logger[level](sentinels.message, error)).not.toThrow()
    })
    expect(reads).toBe(0)
    expect(entries).toHaveLength(2)
    assertPrivateEntry(entries[1], level, result.header)
  })

  it('preserves the marker while enrichment can only set user and tenant', () => {
    const result = exerciseProduction(syntheticRequest('GET', PREFIX), logger, () => {
      enrichRequestContext({ userId: ' user ', tenantId: ' tenant ' })
      return getRequestContext()
    })
    expect(result.downstream).toMatchObject({
      correlationId: result.header, privateObservationSurface: 'yida-owner-http', userId: 'user', tenantId: 'tenant',
    })
  })

  it('ignores a downstream untrusted request-id bridge even after the real producer', () => {
    const result = exerciseProduction(syntheticRequest('GET', `${PREFIX}/approvals/${sentinels.path}`), logger, () => {
      runWithLogContext({ requestId: sentinels.requestId, traceId: sentinels.trace, spanId: sentinels.span }, () => {
        expect(getLogContext()?.requestId).toBe(sentinels.requestId) // Positive control: contamination exists.
        logger.info(sentinels.message, { private: sentinels.meta })
      })
    })
    expect(entries).toHaveLength(2)
    assertPrivateEntry(entries[0], 'info', result.header)
    assertPrivateEntry(entries[1], 'info', result.header)
  })

  it('keeps owner and ordinary ALS separate across interleaved awaits and restores outside logging', async () => {
    let releaseOwner!: () => void
    let releaseOrdinary!: () => void
    const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve })
    const ordinaryGate = new Promise<void>(resolve => { releaseOrdinary = resolve })
    const owner = exerciseProduction(syntheticRequest('GET', `${PREFIX}/approvals/${sentinels.path}`), logger, async () => {
      await ownerGate
      expect(getRequestContext()?.privateObservationSurface).toBe('yida-owner-http')
      logger.info(sentinels.message, { private: sentinels.meta })
    })
    const ordinary = runWithLogContext({}, () => exerciseProduction(syntheticRequest('GET', '/probe'), logger, async () => {
      await ordinaryGate
      expect(getRequestContext()?.privateObservationSurface).toBeUndefined()
      expect(getRequestContext()?.correlationId).toBe(sentinels.correlation)
      logger.info('ordinary-positive', { private: sentinels.meta })
    }))
    releaseOrdinary()
    await ordinary.downstream
    releaseOwner()
    await owner.downstream
    expect(entries).toHaveLength(4)
    assertPrivateEntry(entries[0], 'info', owner.header)
    expect(entries[1].message).toBe('GET /probe')
    expect(entries[2].message).toBe('ordinary-positive')
    expect(entries[2].private).toBe(sentinels.meta)
    expect(entries[2].requestId).toBe(sentinels.requestId)
    assertPrivateEntry(entries[3], 'info', owner.header)
    expect(getRequestContext()).toBeUndefined()
    logger.info('outside-positive', { private: sentinels.meta })
    expect(entries[4].message).toBe('outside-positive')
    expect(entries[4].private).toBe(sentinels.meta)
    expect(entries[4].correlation_id).toBeUndefined()
    expect(consoleOutput([entries[4]])).not.toContain(sentinels.requestId)
  })

  it('preserves ordinary raw message, metadata, errors, identities and trace positive controls', () => {
    const req = syntheticRequest('GET', '/probe')
    runWithLogContext({ traceId: sentinels.trace, spanId: sentinels.span }, () => exerciseProduction(req, logger, () => {
      enrichRequestContext({ userId: sentinels.user, tenantId: sentinels.tenant })
      logger.debug(sentinels.message, { private: sentinels.meta })
      logger.info(sentinels.message, { private: sentinels.meta })
      const error = new Error(sentinels.error)
      error.stack = sentinels.stack
      logger.warn(sentinels.message, error)
      logger.error(sentinels.message, error)
    }))
    expect(entries).toHaveLength(5)
    for (const entry of entries.slice(1)) {
      expect(entry.message).toBe(sentinels.message)
      expect(entry.requestId).toBe(sentinels.requestId)
      expect(entry.correlation_id).toBe(sentinels.correlation)
      expect(entry.user_id).toBe(sentinels.user)
      expect(entry.tenant_id).toBe(sentinels.tenant)
      expect(entry.traceId).toBe(sentinels.trace)
      expect(entry.spanId).toBe(sentinels.span)
    }
    expect(entries[1].private).toBe(sentinels.meta)
    expect(entries[2].private).toBe(sentinels.meta)
    for (const entry of entries.slice(3)) {
      expect(entry.error).toBe(sentinels.error)
      expect(entry.stack).toBe(sentinels.stack)
    }
  })

  it('redacts actual method-override Logger output without changing its decision', () => {
    const req = syntheticRequest('POST', `${PREFIX}/approvals/${sentinels.path}/revoke`)
    req.headers['x-http-method-override'] = 'DELETE'
    req.user = { id: 'synthetic-owner' } as Express.Request['user']
    let nextCount = 0
    const result = exerciseProduction(req, logger, res => {
      methodOverrideMiddleware(req, res, (() => { nextCount += 1 }) as NextFunction)
    })
    expect(req.method).toBe('DELETE')
    expect(req.methodOverride).toBe('DELETE')
    expect(nextCount).toBe(1)
    expect(entries).toHaveLength(2)
    expect(entries[1].context).toBe('MethodOverride')
    expect(entries[1].message).toBe('YIDA_OWNER_HTTP_INFO')
    expect(entries[1].correlation_id).toBe(result.header)
    for (const sentinel of Object.values(sentinels)) expect(consoleOutput(entries)).not.toContain(sentinel)
  })

  it('redacts global error Logger output while keeping its existing response-message read explicit', () => {
    const req = syntheticRequest('GET', `${PREFIX}/unknown/${sentinels.path}`)
    let messageReads = 0
    const error = new Error('synthetic')
    Object.defineProperty(error, 'message', { get: () => { messageReads += 1; return sentinels.error } })
    const response = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response
    const result = exerciseProduction(req, logger, () => {
      correlationErrorHandler(logger, 'test')(error, req, response, (() => undefined) as NextFunction)
    })
    expect(messageReads).toBe(1) // global handler reads for response; Logger must not read again.
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ message: sentinels.error, correlationId: result.header }))
    expect(entries).toHaveLength(2)
    assertPrivateEntry(entries[1], 'error', result.header)
  })
})

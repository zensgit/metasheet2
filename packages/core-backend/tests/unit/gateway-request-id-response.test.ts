import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import express from 'express'
import request from 'supertest'
import ts from 'typescript'
import { describe, expect, test, vi } from 'vitest'

const sourceText = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8')
const source = ts.createSourceFile('index.ts', sourceText, ts.ScriptTarget.Latest, true)
const callbacks: ts.ArrowFunction[] = []
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'this.app.use') {
    const callback = node.arguments[0]
    if (callback && ts.isArrowFunction(callback) && callback.body.getText(source).includes('setLogContext({ requestId })')) callbacks.push(callback)
  }
  ts.forEachChild(node, visit)
}
visit(source)

describe('actual request-context callback response correlation', () => {
  test.each([
    ['generated', undefined, false, '44444444-4444-4444-8444-444444444444'],
    ['safe incoming', 'req-synthetic123', false, 'req-synthetic123'],
    ['unsafe incoming', 'not a safe response id', false, undefined],
    ['oversized incoming', 'a'.repeat(129), false, undefined],
    ['owner observation', 'req-untrusted123', true, '55555555-5555-4555-8555-555555555555'],
  ] as const)('%s preserves log attribution without echoing unsafe headers', async (_label, supplied, ownerPath, expected) => {
    expect(callbacks).toHaveLength(1)
    const logContext = vi.fn()
    const callback = runInNewContext(ts.transpileModule(`(${callbacks[0].getText(source)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText, {
      crypto: { randomUUID: () => '44444444-4444-4444-8444-444444444444' },
      isYidaOwnerHttpObservationPath: () => ownerPath,
      setLogContext: logContext,
    }) as express.RequestHandler
    const app = express()
    app.use((req, _res, next) => {
      req.correlationId = '55555555-5555-4555-8555-555555555555'
      next()
    })
    app.use(callback)
    app.get('/api/synthetic', (_req, res) => res.status(400).json({ ok: false, error: { code: 'SYNTHETIC' } }))
    const response = await request(app).get('/api/synthetic').set(supplied ? { 'X-Request-ID': supplied } : {}).expect(400)
    expect(response.headers['x-request-id']).toBe(expected)
    expect(logContext).toHaveBeenCalledTimes(1)
    expect(logContext).toHaveBeenCalledWith({ requestId: ownerPath ? '55555555-5555-4555-8555-555555555555' : supplied ?? '44444444-4444-4444-8444-444444444444' })
    expect(response.body).toEqual({ ok: false, error: { code: 'SYNTHETIC' } })
  })

  test('CORS exposes request IDs without removing previous response headers', () => {
    expect(sourceText).toContain("exposedHeaders: ['X-Correlation-ID', 'X-Method-Overridden', 'X-Request-ID']")
  })
})

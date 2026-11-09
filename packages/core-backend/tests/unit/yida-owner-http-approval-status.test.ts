// The owner route's status table for the approval service's own fixed codes: the actual Express router with a fake
// owner port whose approve() rejects with a real YidaSendApprovalError. No listener, JWT or PG; the real-DB files
// prove the services, this file only pins the HTTP status each closed code answers with (P1, 2026-11-08: the
// generated-layout seal refusal is 409, never a 503 that would read as "retry"; slice YE, 2026-11-08: the four deterministic
// source-validation refusals of POST /drafts are 422, and the sealed-layout refusal is 409 there too).
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { createIntegrationYidaOwnerRouter, yidaOwnerNoStoreMiddleware, type YidaOwnerHttpPort } from '../../src/routes/integration-yida-owner'
import { YidaSendApprovalError } from '../../src/integration/yida-send-approval-service'

const operationId = '22222222-2222-4222-8222-222222222222'
const rowKey = '44444444-4444-4444-8444-444444444444'
const confirmationId = '55555555-5555-4555-8555-555555555555'
const actor = { actorId: 'synthetic-http-owner', tenantId: 'synthetic-http-tenant' }

function port(refusal: () => unknown): YidaOwnerHttpPort {
  const refuse = async () => { throw refusal() }
  return { prepareDraft: refuse, preview: refuse, approve: refuse, revoke: refuse, observe: refuse, submit: refuse,
    sendEnabled: () => true } as unknown as YidaOwnerHttpPort
}
const draftBody = { config: { version: 2 }, rowsText: '[]', allocation: { mode: 'original' } }
async function approve(owner: YidaOwnerHttpPort) {
  return call(owner, '/approvals', { operationId, rowKey, confirmationId, acknowledgeOnce: true })
}
async function call(owner: YidaOwnerHttpPort, url: string, requestBody: unknown) {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url, originalUrl: '/api/integration/yida-owner-send' + url,
    headers: {}, query: {}, body: requestBody,
    user: { id: actor.actorId }, authenticatedTenantId: actor.tenantId, aborted: false })
  const headers: Record<string, unknown> = {}
  let status = 0
  const router = createIntegrationYidaOwnerRouter(owner)
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
    setHeader(key: string, value: unknown) { headers[key.toLowerCase()] = value },
    status(value: number) { status = value; return this },
    json(_body: unknown) {},
  })
  const body = await new Promise<unknown>((resolve, reject) => {
    res.json = (value: unknown) => { res.writableEnded = true; resolve(value) }
    yidaOwnerNoStoreMiddleware(req as unknown as Request, res as unknown as Response, () => {
      router(req as unknown as Request, res as unknown as Response, reject)
    })
  })
  await Promise.resolve()
  expect(headers['cache-control']).toBe('no-store')
  return { status, body }
}

describe('owner HTTP: the approval service\'s closed codes and their statuses', () => {
  it.each([
    ['GENERATED_LAYOUT_CONFLICT', 409], ['IDENTITY_RESERVED', 409], ['LIMIT', 422], ['CONFLICT', 409],
    ['EXPIRED', 409], ['REVOKED', 409], ['CANCELLED', 409], ['NOT_FOUND', 404], ['INPUT', 400], ['UNAVAILABLE', 503],
  ] as const)('an approval refused with %s answers %i and the fixed code, nothing else', async (suffix, expected) => {
    const result = await approve(port(() => new YidaSendApprovalError(suffix)))
    expect(result.status).toBe(expected)
    expect(result.body).toEqual({ ok: false, error: { code: `YIDA_SEND_APPROVAL_${suffix}` } })
  })

  // Slice YE: POST /drafts refused by the send authority with each deterministic source-validation code answers 422 with
  // exactly that code (never the 503 UNAVAILABLE it was before), and a sealed-layout refusal at draft creation is 409.
  it.each([
    ['SOURCE_UNBOUND', 422], ['SOURCE_PROJECT_MISMATCH', 422], ['SOURCE_KEY_MISMATCH', 422], ['SOURCE_KEY_FIELD_MISMATCH', 422],
    ['GENERATED_LAYOUT_CONFLICT', 409], ['LIMIT', 422], ['UNAVAILABLE', 503],
  ] as const)('a draft refused with %s answers %i and the fixed code, nothing else', async (suffix, expected) => {
    const result = await call(port(() => new YidaSendApprovalError(suffix)), '/drafts', draftBody)
    expect(result.status).toBe(expected)
    expect(result.body).toEqual({ ok: false, error: { code: `YIDA_SEND_APPROVAL_${suffix}` } })
  })

  it('an error that is not one of the route\'s own, the runtime\'s or a service\'s fixed codes is the closed 503, never its message', async () => {
    const result = await approve(port(() => new Error('synthetic unknown failure')))
    expect(result.status).toBe(503)
    expect(result.body).toEqual({ ok: false, error: { code: 'YIDA_OWNER_HTTP_UNAVAILABLE' } })
  })
})

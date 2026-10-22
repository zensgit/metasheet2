import express from 'express'
import { request as httpRequest, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../fixtures/plm-record-event-v1-fixtures.json'
const receive = vi.hoisted(() => vi.fn())
vi.mock('../../src/multitable/plm-record-ingress-service', () => ({
  receivePlmRecordEvent: receive,
}))
vi.mock('../../src/multitable/oapi-write-audit', () => ({
  oapiWriteAuditBoundary: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  buildOapiAuditContext: (req: any) => ({
    tokenId: req.apiTokenId,
    actorId: req.apiTokenUserId,
    scope: 'records:write',
    operation: 'upsert',
  }),
}))
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { poolManager } from '../../src/integration/db/connection-pool'
import {
  createPlmRecordIngressRouter,
  createPlmRecordIngressBodyParser,
} from '../../src/routes/plm-record-ingress'
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'
let server: Server | undefined
let base = ''
let token: any
const query = vi.fn()
beforeEach(async () => {
  vi.stubEnv('PLM_RECORD_INGRESS_ENABLED', 'true')
  token = {
    id: 'token',
    createdBy: 'creator',
    scopes: ['records:write'],
    baseIds: ['base'],
    sheetIds: ['sheet'],
  }
  vi.spyOn(ApiTokenService.prototype, 'validateToken').mockImplementation(async () => ({
    valid: true,
    token,
  }))
  vi.spyOn(poolManager, 'get').mockReturnValue({ query } as any)
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('meta_plm_record_bindings')
      ? [{ sheet_id: 'sheet' }]
      : sql.includes('base_id')
        ? [{ id: 'sheet', base_id: 'base' }]
        : [],
  }))
  receive.mockResolvedValue({ schema: 'yuantus.bom-record-receipt.v1', result: 'applied' })
  const app = express()
  app.use('/api/multitable/plm-record-ingress', createPlmRecordIngressBodyParser()!)
  app.use('/api/multitable', createPlmRecordIngressRouter()!)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server!.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((r) => server?.close(() => r()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
const post = (body: unknown = fixtures.cases[0].event, bearer = 'mst_valid') =>
  new Promise<{ status: number }>((resolve, reject) => {
    const req = httpRequest(
      `${base}/api/multitable/plm-record-ingress`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode! }))
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
describe('actual Express ingress registration and existing token middleware', () => {
  it.each(['jwt-value', ''])(
    'refuses non-mst caller %s despite middleware pass-through',
    async (bearer) => {
      expect((await post(undefined, bearer)).status).toBe(401)
      expect(receive).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
    },
  )
  it('uses existing token scope and server-resolved target before dispatch', async () => {
    expect((await post()).status).toBe(200)
    expect(receive).toHaveBeenCalledOnce()
    expect(receive.mock.calls[0][2]).toMatchObject({ tokenId: 'token', actorId: 'creator' })
  })
  it('rejects valid token without write scope', async () => {
    token.scopes = ['records:read']
    expect((await post()).status).toBe(403)
    expect(receive).not.toHaveBeenCalled()
  })
  it('rejects target outside token scope', async () => {
    token.sheetIds = ['other']
    expect((await post()).status).toBe(403)
    expect(receive).not.toHaveBeenCalled()
  })
  it('rejects forged target, origin and bypass without source query', async () => {
    expect(
      (await post({ ...fixtures.cases[0].event, sheetId: 'other', origin: 'plm_domain_event' }))
        .status,
    ).toBe(400)
    expect(query).not.toHaveBeenCalled()
  })
  it('enforces raw 512 KiB parser limit before the larger application parser', async () => {
    expect((await post({ x: 'x'.repeat(512 * 1024) })).status).toBe(413)
    expect(receive).not.toHaveBeenCalled()
  })
  it('default-off factory and exact method/path allowlist agree', () => {
    for (const flag of ['', 'TRUE', ' true', 'true ']) {
      vi.stubEnv('PLM_RECORD_INGRESS_ENABLED', flag)
      expect(createPlmRecordIngressRouter()).toBeNull()
      expect(createPlmRecordIngressBodyParser()).toBeNull()
      expect(
        isOapiAllowlistRequest('POST', '/api/multitable/plm-record-ingress', 'Bearer mst_ok'),
      ).toBe(false)
    }
    vi.stubEnv('PLM_RECORD_INGRESS_ENABLED', 'true')
    expect(
      isOapiAllowlistRequest('POST', '/api/multitable/plm-record-ingress', 'Bearer mst_ok'),
    ).toBe(true)
    for (const path of [
      '/api/multitable/plm-record-ingress/x',
      '/api/multitable/plm-record-ingress/',
      '/api/multitable/plm-record-ingress\n',
      '/api/multitable/plm-record-ingress\r\n',
      '/api/multitable/plm-record-ingress\u2028',
      '/api/multitable/plm-record-ingress\u2029',
      '/API/multitable/plm-record-ingress',
      '/api/multitable/plm-record-ingress?extra=1',
    ])
      expect(isOapiAllowlistRequest('POST', path, 'Bearer mst_ok')).toBe(false)
    expect(
      isOapiAllowlistRequest('GET', '/api/multitable/plm-record-ingress', 'Bearer mst_ok'),
    ).toBe(false)
  })
})

// Fresh native AuthService/pool import graph; never share a fork with the old
// owner send fixture. Real local JWT/PG; YiDa fetch is an in-process synthetic sink.
import { inspect } from 'node:util'
import winston from 'winston'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createYidaOwnerHttpRealdbFixture, draftInput, principals, syntheticMaterial, tenant,
  type Data, type YidaOwnerHttpRealdbFixture } from '../utils/stock-preparation-yida-owner-http-fixture'

it('sentinel: initialization HTTP proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip
databaseSuite('YiDa initialization HTTP — empty slot, real JWT/live ACL, actual three writers and logger', () => {
  let f: YidaOwnerHttpRealdbFixture
  const logs: unknown[] = []
  let logSpy: ReturnType<typeof vi.spyOn>
  const noExternalWrite = async () => {
    expect([f.tokenPayloads.length, f.formPayloads.length]).toEqual([0, 0])
    expect((await f.proof()).counts).toEqual([0, 0, 0, 0, 0, 0])
  }
  function data(result: Awaited<ReturnType<YidaOwnerHttpRealdbFixture['http']>>, status: number): Data {
    expect(result.status).toBe(status); expect(result.headers['cache-control']).toBe('no-store')
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect(Object.keys(result.body).sort()).toEqual(['data', 'ok']); expect(result.body.ok).toBe(true)
    const view = result.body.data as Data
    expect(Object.keys(view).sort()).toEqual(['canSend', 'commandId', 'draft', 'externalWriteAttempted', 'status', 'tokenIssued'])
    expect(view).toMatchObject({ canSend: false, tokenIssued: false, externalWriteAttempted: false })
    return view
  }
  function denied(result: Awaited<ReturnType<YidaOwnerHttpRealdbFixture['http']>>, status: number, code: string) {
    expect(result.status).toBe(status); expect(result.headers['cache-control']).toBe('no-store')
    expect(Object.keys(result.body).sort()).toEqual(['error', 'ok']); expect(result.body.ok).toBe(false)
    expect((result.body.error as Data).code).toBe(code)
    if (code !== 'UNAUTHORIZED') expect(result.body.error).toEqual({ code })
  }
  function input(commandId: unknown) {
    return { commandId, material: syntheticMaterial(), draft: draftInput(), attestation: {
      kind: 'owner-reviewed-target', reviewRef: 'synthetic-http-review', organizationId: 'synthetic-http-organization',
      executionIdentity: syntheticMaterial().userId,
    } }
  }
  beforeAll(async () => {
    // Exercise real Logger/Winston formatting; intercept only its final console
    // transport. Neither the producer nor Logger is replaced by a fake logger.
    logSpy = vi.spyOn(winston.transports.Console.prototype, 'log').mockImplementation((info: Record<PropertyKey, unknown>, callback: () => void) => {
      logs.push({ ...info }); callback()
    })
    f = await createYidaOwnerHttpRealdbFixture({ initialization: true })
  }, 30000)
  beforeEach(async () => { await f.reset(); logs.length = 0 }, 30000)
  afterAll(async () => { try { await f?.cleanup() } finally { logSpy?.mockRestore() } }, 30000)

  it('OFF initialization writes 090/091/092/result in one host transaction and GET alone recovers closed metadata', async () => {
    expect((await f.initializationProof()).counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
    const ready = data(await f.http('GET', '/initialization'), 200)
    expect(ready).toMatchObject({ status: 'ready', draft: null })
    const anchor = (await f.rows('integration_yida_initialization_anchor'))[0]
    expect(ready.commandId).toBe(anchor.command_id)
    expect(anchor).toMatchObject({ owner_id: principals.owner, tenant_id: tenant, workspace_id: null })
    f.sql.length = 0
    const made = data(await f.http('POST', '/initialization', input(ready.commandId)), 201)
    expect(made.status).toBe('initialized')
    expect(made.draft).toMatchObject({ status: 'unverified', reused: false, rowCount: 1 })
    expect((await f.initializationProof()).counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
    expect(f.sql.filter(sql => /^BEGIN\b/u.test(sql))).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED'])
    expect(f.sql.filter(sql => sql === 'COMMIT')).toHaveLength(1)
    expect(f.sql.filter(sql => /^SET\b/u.test(sql))).toHaveLength(0)
    await noExternalWrite()
    const before = await f.initializationProof(), recovered = data(await f.http('GET', '/initialization'), 200)
    expect(recovered).toEqual({ ...made, draft: { ...(made.draft as Data), reused: true } })
    denied(await f.http('POST', '/initialization', input(ready.commandId)), 409, 'YIDA_INITIALIZATION_CONFLICT')
    expect(await f.initializationProof()).toEqual(before)
    denied(await f.http('POST', '/drafts', draftInput()), 403, 'YIDA_OWNER_RUNTIME_DISABLED')
    await noExternalWrite()
    const output = JSON.stringify([made, recovered])
    for (const value of [...Object.values(syntheticMaterial()), 'synthetic-http-review', 'synthetic-http-organization',
      'synthetic_http_form', 'synthetic HTTP part']) expect(output.includes(value)).toBe(false)
  })
  it('the second actually qualified administrator cannot read ready or initialize the anchor owner slot', async () => {
    const ready = data(await f.http('GET', '/initialization'), 200), before = await f.initializationProof()
    denied(await f.http('GET', '/initialization', undefined, { token: f.tokens.otherOwner }), 403, 'YIDA_INITIALIZATION_DENIED')
    denied(await f.http('POST', '/initialization', input(ready.commandId), { token: f.tokens.otherOwner }), 403, 'YIDA_INITIALIZATION_DENIED')
    expect(await f.initializationProof()).toEqual(before); await noExternalWrite()
  })
  it('actual JWT/session and live permission revocation precede initialization persistence', async () => {
    const ready = data(await f.http('GET', '/initialization'), 200), before = await f.initializationProof()
    denied(await f.http('POST', '/initialization', input(ready.commandId), { token: null }), 401, 'UNAUTHORIZED')
    await f.sqlAdmin('UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [f.sessions[principals.owner]])
    denied(await f.http('GET', '/initialization'), 401, 'UNAUTHORIZED')
    await f.sqlAdmin('UPDATE user_sessions SET revoked_at=NULL WHERE id=$1', [f.sessions[principals.owner]])
    await f.sqlAdmin('DELETE FROM user_permissions WHERE user_id=$1', [principals.owner])
    denied(await f.http('POST', '/initialization', input(ready.commandId)), 403, 'YIDA_INITIALIZATION_DENIED')
    expect(await f.initializationProof()).toEqual(before); await noExternalWrite()
  })
  it('raw identity mismatch, client authority extras, malformed JSON and GET query reject without writer SQL', async () => {
    const ready = data(await f.http('GET', '/initialization'), 200), request = input(ready.commandId), before = await f.initializationProof()
    f.sql.length = 0
    for (const bad of [{ ...request, ownerId: principals.owner },
      { ...request, attestation: { ...request.attestation, executionIdentity: 'synthetic-other-executor' } },
      { ...request, material: { ...request.material, userId: ' ' + request.material.userId + ' ' } }]) {
      denied(await f.http('POST', '/initialization', bad), 400, 'YIDA_OWNER_HTTP_INPUT')
    }
    denied(await f.http('GET', '/initialization?commandId=synthetic-private-query'), 400, 'YIDA_OWNER_HTTP_INPUT')
    denied(await f.http('POST', '/initialization', undefined, { raw: '{"material":' }), 400, 'YIDA_OWNER_HTTP_INPUT')
    denied(await f.http('POST', '/initialization', request, { headers: { 'x-owner-id': principals.owner } }), 400, 'YIDA_OWNER_HTTP_INPUT')
    expect(f.sql).toEqual([]); expect(await f.initializationProof()).toEqual(before); await noExternalWrite()
  })
  it('actual private Logger suppresses malformed path, query, secret body, JWT and caller correlation', async () => {
    const body = { material: { ...syntheticMaterial(), appSecret: 'PRIVATE_INITIALIZATION_BODY_CANARY' } }
    const malformed = '/initialization/PRIVATE_INITIALIZATION_PATH_CANARY?private=PRIVATE_INITIALIZATION_QUERY_CANARY'
    denied(await f.http('POST', malformed, body, { headers: { 'x-correlation-id': 'PRIVATE_INITIALIZATION_CORRELATION_CANARY' } }), 404, 'NOT_FOUND')
    denied(await f.http('POST', '/initialization', body), 400, 'YIDA_OWNER_HTTP_INPUT')
    denied(await f.http('POST', '/initialization', body, { token: null }), 401, 'UNAUTHORIZED')
    await new Promise(resolve => setImmediate(resolve))
    const output = inspect(logs, { depth: null, colors: false, getters: false })
    expect(logs.length).toBeGreaterThanOrEqual(3)
    expect(output.includes('YIDA_OWNER_HTTP_INFO')).toBe(true)
    for (const value of ['PRIVATE_INITIALIZATION_BODY_CANARY', 'PRIVATE_INITIALIZATION_PATH_CANARY',
      'PRIVATE_INITIALIZATION_QUERY_CANARY', 'PRIVATE_INITIALIZATION_CORRELATION_CANARY', f.tokens.owner,
      ...Object.values(syntheticMaterial())]) expect(output.includes(value)).toBe(false)
    await noExternalWrite()
  })
})

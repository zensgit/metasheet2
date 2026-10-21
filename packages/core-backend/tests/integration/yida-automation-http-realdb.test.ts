// Real listener -> native JWT/AuthService/session -> route -> actual SA06D
// management/native material/PG outbox. NOT a global application/host proof.
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { createYidaAutomationHttpFixture } from '../utils/yida-automation-http-fixture'
import { principals, otherTenant } from '../utils/stock-preparation-yida-owner-http-fixture'

type Fixture = Awaited<ReturnType<typeof createYidaAutomationHttpFixture>>
it('sentinel: SA06D JWT proof requires owned PG and exact live loopback listeners', () => {
  expect(process.env.EXPECT_DB).toBe('1'); expect(process.env.PLM_FULL_APP_ALLOW_OWN_HTTP).toBe('1')
})
describe('SA06D owner authorization — actual JWT and PostgreSQL', () => {
  let f: Fixture
  beforeAll(async () => { f = await createYidaAutomationHttpFixture() }, 30000)
  beforeEach(async () => { await f.reset() }, 30000)
  afterAll(async () => { await f?.cleanup() }, 30000)
  const noSender = () => expect([f.owner.tokenPayloads.length, f.owner.formPayloads.length]).toEqual([0, 0])
  async function grant() {
    const result = await f.http('POST', '', f.consent())
    expect(result.status).toBe(201)
    return result.body.data.grantId as string
  }
  it('creates, observes, enqueues and replays only durable metadata through all four real operations', async () => {
    const grantId = await grant()
    const reused = await f.http('POST', '', f.consent())
    expect(reused.status).toBe(200); expect(reused.body.data).toMatchObject({ grantId, reused: true, canSend: false })
    const before = await f.http('GET', '/' + grantId)
    expect(before.status).toBe(200); expect(before.headers['cache-control']).toBe('no-store')
    expect(before.body.data).toMatchObject({ grantId, requests: [], serialBlocked: false })
    const accepted = await f.http('POST', '/' + grantId + '/requests', { requestKey: 'synthetic-first' })
    expect(accepted.status).toBe(202); expect(accepted.body.data).toMatchObject({ rowOrdinal: 0, reused: false, deliveryQueued: true, canSend: false })
    const replay = await f.http('POST', '/' + grantId + '/requests', { requestKey: 'synthetic-first' })
    expect(replay.status).toBe(200); expect(replay.body.data.requestId).toBe(accepted.body.data.requestId)
    expect(await f.counts()).toEqual({ grants: 1, requests: 1, admissions: 0, outbox: 1 })
    const revoked = await f.http('POST', '/' + grantId + '/revoke', {})
    expect(revoked.status).toBe(200); expect(revoked.body.data).toMatchObject({ status: 'revoked', revoked: true })
    expect((await f.http('GET', '/' + grantId)).body.data.status).toBe('revoked')
    expect((await f.http('POST', '/' + grantId + '/requests', { requestKey: 'synthetic-second' })).status).toBe(403)
    noSender()
  })
  it('anonymous and signature-invalid requests never reach the management port', async () => {
    expect((await f.http('POST', '', f.consent(), { token: null })).status).toBe(401)
    expect((await f.http('POST', '', f.consent(), { token: 'synthetic-invalid-jwt' })).status).toBe(401)
    expect(f.calls).toBe(0); expect((await f.counts()).grants).toBe(0); noSender()
  })
  it('a real no-tenant JWT cannot promote the legacy header fallback into authenticated tenant authority', async () => {
    const token = await f.owner.tokenFor(principals.owner, null)
    expect((await f.http('POST', '', f.consent(), { token, headers: { 'x-tenant-id': f.tenant } })).status).toBe(403)
    expect(f.authenticatedTenantPresent).toBe(false); expect(f.legacyHeaderFallback).toBe(true)
    expect(f.calls).toBe(0); noSender()
  })
  it('valid JWTs cannot override actor, tenant, workspace or project scope with headers/body/query', async () => {
    const scopeHeaders: Record<string, string>[] = [{ 'x-tenant-id': otherTenant }, { 'x-workspace-id': 'synthetic-workspace' },
      { 'x-owner-id': principals.otherOwner }, { 'x-project-no': 'synthetic-project' }, { 'x_p-r-i-n-c-i-p-a-l': 'synthetic-actor' }]
    for (const headers of scopeHeaders) {
      expect((await f.http('POST', '', f.consent(), { headers })).status).toBe(400)
    }
    for (const key of ['actorId', 'tenantId', 'workspaceId', 'binding', 'permit', 'fetch', 'maxTotalRows']) {
      expect((await f.http('POST', '', { ...f.consent(), [key]: 'synthetic-forged' })).status).toBe(400)
    }
    expect((await f.http('POST', '?tenantId=synthetic', f.consent())).status).toBe(400)
    expect(f.calls).toBe(0); noSender()
  })
  it('a real foreign-tenant JWT and a different administrator cannot observe the owner grant', async () => {
    const grantId = await grant()
    const foreign = await f.owner.tokenFor(principals.owner, otherTenant)
    expect((await f.http('GET', '/' + grantId, undefined, { token: foreign })).status).toBe(403)
    expect((await f.http('GET', '/' + grantId, undefined, { token: f.owner.tokens.otherOwner })).status).toBe(403)
    expect((await f.counts()).grants).toBe(1); noSender()
  })
  it('a display-only admin token or a real reader cannot create an authorization', async () => {
    for (const token of [f.owner.tokens.fakeRole, f.owner.tokens.reader]) {
      expect((await f.http('POST', '', f.consent(), { token })).status).toBe(403)
    }
    expect((await f.counts()).grants).toBe(0); noSender()
  })
  it('live integration role revocation blocks history even with the same previously valid JWT', async () => {
    const grantId = await grant()
    await f.query('DELETE FROM user_roles WHERE user_id=$1', [principals.owner])
    await f.query('DELETE FROM user_permissions WHERE user_id=$1', [principals.owner])
    expect((await f.http('GET', '/' + grantId)).status).toBe(403)
    noSender()
  })
  it('malformed JSON, unsupported content and oversized consent do not call core', async () => {
    expect((await f.http('POST', '', undefined, { raw: '{', contentType: 'application/json' })).status).toBe(400)
    expect((await f.http('POST', '', undefined, { raw: '{}', contentType: 'text/plain' })).status).toBe(415)
    expect((await f.http('POST', '', undefined, { raw: JSON.stringify({ padding: 'x'.repeat(17000) }) })).status).toBe(413)
    expect(f.calls).toBe(0); noSender()
  })
  it('a real committed result with an extra token field is rejected instead of leaked', async () => {
    f.setFailure('EXTRA_DTO')
    const result = await f.http('POST', '', f.consent())
    expect(result.status).toBe(503); expect(result.body.error?.code).toBe('YIDA_AUTOMATION_HTTP_UNAVAILABLE')
    expect(JSON.stringify(result.body)).not.toContain('synthetic-forbidden-token')
    expect((await f.counts()).grants).toBe(1); noSender()
  })
  it('hostile foreign rejections are closed without reading arbitrary error properties', async () => {
    f.setFailure('FOREIGN')
    const result = await f.http('POST', '', f.consent())
    expect(result.status).toBe(503); expect(result.body.error?.code).toBe('YIDA_AUTOMATION_HTTP_UNAVAILABLE')
    expect(f.foreignReads).toBe(0); expect((await f.counts()).grants).toBe(0); noSender()
  })
  it('an actual owned error constructed by JS with an out-of-union value cannot leak its private code', async () => {
    f.setFailure('OWNED_BAD_CODE')
    const result = await f.http('POST', '', f.consent())
    expect(result.status).toBe(503); expect(result.body.error?.code).toBe('YIDA_AUTOMATION_HTTP_UNAVAILABLE')
    expect(JSON.stringify(result.body)).not.toContain('synthetic-private-provider-code')
    expect((await f.counts()).grants).toBe(0); noSender()
  })
})

// Real HTTP -> JWT/AuthService/session/membership -> owner runtime -> core live
// authority -> actual plugin binding/private readers -> PostgreSQL 088-093.
// Only the YiDa fetch responses are synthesized. No customer/remote HTTP.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createYidaOwnerHttpRealdbFixture, draftInput, otherTenant, principals, syntheticMaterial, tenant,
  type Data, type Draft, type Input, type YidaOwnerHttpRealdbFixture } from '../utils/stock-preparation-yida-owner-http-fixture'

it('sentinel: real owner HTTP proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip
databaseSuite('SA05 owner HTTP — actual JWT, native authority and private PostgreSQL', () => {
  let f: YidaOwnerHttpRealdbFixture
  const noMaterialRead = () => expect(f.sql.some(sql => /integration_yida_(credential_materials|draft_operations|draft_rows)/u.test(sql))).toBe(false)
  const noFetch = () => expect([f.tokenPayloads.length, f.formPayloads.length]).toEqual([0, 0])
  const bodyData = (result: Awaited<ReturnType<YidaOwnerHttpRealdbFixture['http']>>, status: number) => {
    expect(result.status).toBe(status)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect(result.body.ok).toBe(true)
    expect(Object.keys(result.body).sort()).toEqual(['data', 'ok'])
    return result.body.data as Data
  }
  const denial = (result: Awaited<ReturnType<YidaOwnerHttpRealdbFixture['http']>>, status: number, code: string) => {
    expect(result.status).toBe(status)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.body.ok).toBe(false)
    expect((result.body.error as Data).code).toBe(code)
    expect(Object.keys(result.body).sort()).toEqual(['error', 'ok'])
    if (code !== 'UNAUTHORIZED') expect(result.body.error).toEqual({ code })
  }
  async function prepare(input = draftInput()) {
    return bodyData(await f.http('POST', '/drafts', input), 201) as unknown as Draft
  }
  async function preview(draft: Draft, ordinal = 0) {
    return bodyData(await f.http('POST', '/preview', { operationId: draft.operationId, rowKey: draft.rows[ordinal].rowKey }), 200)
  }
  async function approve(draft: Draft, ordinal = 0, extras: Data = {}) {
    return bodyData(await f.http('POST', '/approvals', { operationId: draft.operationId, rowKey: draft.rows[ordinal].rowKey,
      confirmationId: randomUUID(), acknowledgeOnce: true, ...extras }), 201)
  }
  async function confirmed(input = draftInput(), ordinal = 0) {
    f.setEnablement('true')
    const draft = await prepare(input), view = await preview(draft, ordinal), grant = await approve(draft, ordinal)
    return { draft, view, grant, request: { grantId: grant.grantId, submissionId: randomUUID() } }
  }
  beforeAll(async () => { f = await createYidaOwnerHttpRealdbFixture() }, 30000)
  beforeEach(async () => { await f.reset() }, 30000)
  afterAll(async () => { await f?.cleanup() }, 30000)

  it.each(['original', 'equal_integer', 'equal_decimal_exact'])('one real preview/confirm/admission/token/form/ACK and history without IO: %s', async mode => {
    f.setEnablement('true')
    const input = draftInput(mode, mode === 'equal_decimal_exact' ? 0.3 : 6), ordinal = mode === 'original' ? 0 : 2
    expect((await f.proof()).counts).toEqual([0, 0, 0, 0, 0, 0])
    const draft = await prepare(input), view = await preview(draft, ordinal)
    expect(view.payload).toEqual(f.compiledPayload(input, ordinal))
    expect(view).toMatchObject({ operationId: draft.operationId, rowKey: draft.rows[ordinal].rowKey,
      policy: { requiresExplicitConfirmation: true, unknownMustNotRetry: true, maxAttempts: 1, maxTtlMs: 900000 },
      canSend: false, externalWriteAttempted: false })
    expect((view.target as Data).identityKind).toBe('owner-attested-single-target')
    expect((await f.proof()).counts).toEqual([0, 0, 0, 0, 0, 0]); noFetch()
    expect(f.sql.some(sql => sql.includes('integration_yida_credential_materials'))).toBe(true)
    expect(f.sql.some(sql => sql.includes('integration_yida_draft_rows'))).toBe(true)
    const grant = await approve(draft, ordinal)
    expect((await f.proof()).counts).toEqual([1, 0, 0, 1, 0, 0]); noFetch()
    expect(grant).toMatchObject({ operationId: draft.operationId, rowKey: draft.rows[ordinal].rowKey,
      remainingAttempts: 1, maxAttempts: 1, canSend: false, externalWriteAttempted: false, reused: false })
    const persisted = (await f.rows('integration_yida_send_approvals'))[0]
    expect(persisted).toMatchObject({ grant_id: grant.grantId, operation_id: draft.operationId,
      row_key: draft.rows[ordinal].rowKey, owner_id: principals.owner, tenant_id: tenant,
      workspace_id: null, credential_generation: 1, max_attempts: 1 })
    const request = { grantId: grant.grantId, submissionId: randomUUID() }
    const sent = bodyData(await f.http('POST', '/submissions', request), 200)
    expect(sent).toMatchObject({ status: 'acknowledged', reused: false, externalWriteAttempted: true,
      businessVerified: false, durable: true, approval: { remainingAttempts: 0, status: 'admitted' },
      delivery: { status: 'acknowledged', durable: true } })
    expect([f.tokenPayloads.length, f.formPayloads.length, f.tokenCommitted, f.validRequests]).toEqual([1, 1, true, true])
    expect(f.formPayloads[0]).toEqual(view.payload)
    expect(f.formPayloads[0].qty).toBe(mode === 'original' ? 6 : mode === 'equal_integer' ? 2 : 0.1)
    if (ordinal > 0) expect((JSON.parse(input.rowsText) as Data[])[ordinal]).toBeUndefined()
    expect((await f.proof()).counts).toEqual([1, 0, 1, 2, 1, 3])
    const admission = (await f.rows('integration_yida_send_admissions'))[0], delivery = (await f.rows('integration_yida_delivery_ledger'))[0]
    expect(admission).toMatchObject({ grant_id: grant.grantId, actor_id: principals.owner,
      submission_id: request.submissionId, ledger_id: (sent.delivery as Data).id })
    expect(delivery).toMatchObject({ id: admission.ledger_id, status: 'acknowledged', claim_actor_id: principals.owner,
      ack_status_code: 201, ack_instance_id: 'synthetic-http-instance' })
    expect((await f.rows('integration_yida_delivery_audit')).map(row => row.event).sort()).toEqual(['acknowledgement', 'claim', 'prepare'])
    const before = await f.proof()
    f.sql.length = 0
    const replay = bodyData(await f.http('POST', '/submissions', request), 200)
    const history = bodyData(await f.http('GET', '/approvals/' + grant.grantId), 200)
    expect(replay).toMatchObject({ status: 'acknowledged', reused: true, externalWriteAttempted: false })
    expect(history).toMatchObject({ delivery: sent.delivery, approval: sent.approval })
    expect([f.tokenPayloads.length, f.formPayloads.length]).toEqual([1, 1])
    noMaterialRead(); expect(await f.proof()).toEqual(before)
    const projection = JSON.stringify([grant, sent, replay, history])
    for (const hidden of [...Object.values(syntheticMaterial()), 'synthetic-http-access-token',
      'synthetic-http-instance', 'synthetic HTTP part', 'synthetic_http_form']) expect(projection.includes(hidden)).toBe(false)
  })

  it('semantic reverse input reuse returns existing member ordinals and previews the server payload', async () => {
    f.setEnablement('true')
    const input = draftInput(), firstRows = [JSON.parse(input.rowsText)[0],
      { projectNo: 'SYN-P2', lineId: 'SYN-L2', parentCode: '', quantity: 9, description: 'synthetic second HTTP part' }]
    input.rowsText = JSON.stringify(firstRows)
    const first = await prepare(input), reverse: Input = { ...input, rowsText: JSON.stringify([...firstRows].reverse()) }
    const reused = await prepare(reverse)
    expect(reused.reused).toBe(true); expect(reused.operationId).toBe(first.operationId); expect(reused.rows).toEqual(first.rows)
    const view = await preview(reused)
    expect(view.payload).toEqual(f.compiledPayload(input, 0))
    expect(view.payload).not.toEqual(f.compiledPayload(reverse, reused.rows[0].index))
    expect((view.payload as Data).qty).toBe(6)
    noFetch(); expect((await f.proof()).counts).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('the omitted runtime flag defaults OFF before any owner SQL or fetch', async () => {
    await f.startRuntime(true)
    f.sql.length = 0
    const before = await f.proof()
    denial(await f.http('POST', '/drafts', draftInput()), 403, 'YIDA_OWNER_RUNTIME_DISABLED')
    expect(f.sql).toEqual([]); noFetch(); expect(await f.proof()).toEqual(before)
  })
  it.each(['false', 'TRUE', ' true ', true])('non-exact flag %s refuses draft/preview/approval/submission before owner SQL', async enabled => {
    const fixture = await confirmed()
    const before = await f.proof(); f.setEnablement(enabled); f.sql.length = 0
    for (const [route, body] of [['/drafts', draftInput()], ['/preview', { operationId: fixture.draft.operationId, rowKey: fixture.draft.rows[0].rowKey }],
      ['/approvals', { operationId: fixture.draft.operationId, rowKey: fixture.draft.rows[0].rowKey, confirmationId: randomUUID(), acknowledgeOnce: true }],
      ['/submissions', fixture.request]] as const) denial(await f.http('POST', route, body), 403, 'YIDA_OWNER_RUNTIME_DISABLED')
    expect(f.sql).toEqual([]); noFetch(); expect(await f.proof()).toEqual(before)
  })

  it('missing or malformed JWT denies before owner SQL and material', async () => {
    f.setEnablement('true')
    const before = await f.proof(); f.sql.length = 0
    for (const token of [null, 'synthetic.invalid.signature']) denial(await f.http('POST', '/drafts', draftInput(), { token }), 401, 'UNAUTHORIZED')
    expect(f.sql).toEqual([]); noMaterialRead(); noFetch(); expect(await f.proof()).toEqual(before)
  })
  it('JWT without a tenant claim cannot adopt x-tenant-id even for a real member', async () => {
    f.setEnablement('true')
    const token = await f.tokenFor(principals.owner, null), before = await f.proof(); f.sql.length = 0
    denial(await f.http('POST', '/drafts', draftInput(), { token, headers: { 'x-tenant-id': tenant } }), 403, 'YIDA_OWNER_HTTP_DENIED')
    expect(f.sql).toEqual([]); noFetch(); expect(await f.proof()).toEqual(before)
  })
  it('a signed tenant claim without its actual active membership supplies no authenticated tenant', async () => {
    f.setEnablement('true')
    await f.sqlAdmin('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [principals.owner, tenant])
    f.sql.length = 0
    denial(await f.http('POST', '/drafts', draftInput()), 403, 'YIDA_OWNER_HTTP_DENIED')
    expect(f.sql).toEqual([]); noMaterialRead(); noFetch()
  })
  it.each(['reader', 'fakeRole'] as const)('actual live ACL rejects %s despite signed role or users.is_admin', async key => {
    f.setEnablement('true')
    const before = await f.proof(); f.sql.length = 0
    denial(await f.http('POST', '/drafts', draftInput(), { token: f.tokens[key] }), 503, 'YIDA_SEND_APPROVAL_UNAVAILABLE')
    expect(f.sql.some(sql => sql.includes('FROM user_roles'))).toBe(true)
    expect(f.sql.some(sql => sql.includes('integration_yida_approved_target'))).toBe(false)
    noMaterialRead(); noFetch(); expect(await f.proof()).toEqual(before)
  })
  it.each(['session', 'all-sessions'])('actual AuthService rejects %s revocation before owner SQL', async kind => {
    f.setEnablement('true')
    if (kind === 'session') await f.sqlAdmin('UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [f.sessions[principals.owner]])
    else await f.sqlAdmin(`INSERT INTO user_session_revocations VALUES($1,clock_timestamp()+interval '1 second',
      clock_timestamp(),$1,'synthetic revoke')`, [principals.owner])
    f.sql.length = 0
    denial(await f.http('POST', '/drafts', draftInput()), 401, 'UNAUTHORIZED')
    expect(f.sql).toEqual([]); noMaterialRead(); noFetch()
  })

  it.each(['tenantId', 'workspaceId', 'ownerId'])('body scope %s is rejected at the closed HTTP input boundary', async field => {
    f.setEnablement('true')
    const before = await f.proof(); f.sql.length = 0
    denial(await f.http('POST', '/drafts', { ...draftInput(), [field]: 'synthetic-forged-scope' }), 400, 'YIDA_OWNER_HTTP_INPUT')
    expect(f.sql).toEqual([]); noFetch(); expect(await f.proof()).toEqual(before)
  })
  it.each(['x-tenant-id', 'x_workspace_id', 'x-owner-id'])('scope header %s is rejected before owner SQL', async header => {
    f.setEnablement('true')
    const before = await f.proof(); f.sql.length = 0
    denial(await f.http('POST', '/drafts', draftInput(), { headers: { [header]: 'synthetic-forged-scope' } }), 400, 'YIDA_OWNER_HTTP_INPUT')
    expect(f.sql).toEqual([]); noFetch(); expect(await f.proof()).toEqual(before)
  })
  it.each(['url', 'proof', 'credential'])('client extra %s cannot enter preview/approval/submission dependencies', async field => {
    const fixture = await confirmed(), before = await f.proof(); f.sql.length = 0
    for (const [route, body] of [['/drafts', draftInput()], ['/preview', { operationId: fixture.draft.operationId, rowKey: fixture.draft.rows[0].rowKey }],
      ['/approvals', { operationId: fixture.draft.operationId, rowKey: fixture.draft.rows[0].rowKey, confirmationId: randomUUID(), acknowledgeOnce: true }],
      ['/submissions', fixture.request]] as const) {
      denial(await f.http('POST', route, { ...body, [field]: 'synthetic-untrusted-input' }), 400, 'YIDA_OWNER_HTTP_INPUT')
    }
    expect(f.sql).toEqual([]); noFetch(); expect(await f.proof()).toEqual(before)
  })
  it('explicit acknowledgement accepts only boolean true and refuses all false/string literals', async () => {
    f.setEnablement('true')
    const draft = await prepare(), before = await f.proof(); f.sql.length = 0
    for (const acknowledgeOnce of [false, 'true', 1, null]) denial(await f.http('POST', '/approvals', {
      operationId: draft.operationId, rowKey: draft.rows[0].rowKey, confirmationId: randomUUID(), acknowledgeOnce }), 400, 'YIDA_OWNER_HTTP_INPUT')
    expect(f.sql).toEqual([]); noFetch(); expect(await f.proof()).toEqual(before)
  })
  it('TTL and opaque selection identifiers are bounded before owner SQL', async () => {
    f.setEnablement('true')
    const draft = await prepare(); f.sql.length = 0
    for (const ttlMs of [0, 900001, 1.5, '900000']) denial(await f.http('POST', '/approvals', {
      operationId: draft.operationId, rowKey: draft.rows[0].rowKey, confirmationId: randomUUID(), acknowledgeOnce: true, ttlMs }), 400, 'YIDA_OWNER_HTTP_INPUT')
    denial(await f.http('POST', '/preview', { operationId: 'synthetic-non-uuid', rowKey: draft.rows[0].rowKey }), 400, 'YIDA_OWNER_HTTP_INPUT')
    expect(f.sql).toEqual([]); noFetch()
  })
  it('malformed JSON, non-JSON and extra query parameters are closed no-store input failures', async () => {
    f.setEnablement('true'); f.sql.length = 0
    denial(await f.http('POST', '/drafts', undefined, { raw: '{"config":' }), 400, 'YIDA_OWNER_HTTP_INPUT')
    denial(await f.http('POST', '/drafts', undefined, { raw: '{}', contentType: 'text/plain' }), 415, 'YIDA_OWNER_HTTP_INPUT')
    denial(await f.http('POST', '/drafts?workspaceId=synthetic-scope', draftInput()), 400, 'YIDA_OWNER_HTTP_INPUT')
    expect(f.sql).toEqual([]); noFetch()
  })

  it.each(['owner', 'tenant'])('actual administrator/membership cannot cross permanent target %s', async boundary => {
    const fixture = await confirmed(), token = boundary === 'owner' ? f.tokens.otherOwner : await f.tokenFor(principals.owner, otherTenant)
    const before = await f.proof(); f.sql.length = 0
    for (const [method, route, body] of [['POST', '/drafts', draftInput()],
      ['POST', '/preview', { operationId: fixture.draft.operationId, rowKey: fixture.draft.rows[0].rowKey }],
      ['GET', '/approvals/' + fixture.grant.grantId, undefined], ['POST', '/submissions', fixture.request]] as const) {
      // The private send port deliberately seals dependency failures, whereas
      // the local management authority returns its own branded NOT_FOUND.
      const sending = route === '/submissions'
      denial(await f.http(method, route, body, { token }), sending ? 503 : 404,
        sending ? 'YIDA_OWNER_RUNTIME_UNAVAILABLE' : 'YIDA_SEND_APPROVAL_NOT_FOUND')
    }
    expect(f.sql.some(sql => sql.includes('FROM integration_yida_approved_target'))).toBe(true)
    noMaterialRead(); noFetch(); expect(await f.proof()).toEqual(before)
  })
  it('OFF observation and local revocation retain current ACL and produce no token/form', async () => {
    const fixture = await confirmed(); f.setEnablement('false'); f.sql.length = 0
    const observed = bodyData(await f.http('GET', '/approvals/' + fixture.grant.grantId), 200)
    expect(observed).toMatchObject({ approval: { remainingAttempts: 1, status: 'approved' }, delivery: null })
    const revoked = bodyData(await f.http('POST', '/approvals/' + fixture.grant.grantId + '/revoke', {}), 200)
    expect(revoked).toMatchObject({ remainingAttempts: 0, status: 'revoked', revoked: true, reused: false })
    expect(bodyData(await f.http('POST', '/approvals/' + fixture.grant.grantId + '/revoke', {}), 200).reused).toBe(true)
    expect((await f.proof()).counts).toEqual([1, 1, 0, 2, 0, 0]); noMaterialRead(); noFetch()
    f.setEnablement('true')
    denial(await f.http('POST', '/submissions', fixture.request), 503, 'YIDA_OWNER_RUNTIME_UNAVAILABLE')
    noFetch(); expect((await f.proof()).counts).toEqual([1, 1, 0, 2, 0, 0])
  })
  it.each(['permission', 'namespace'])('OFF history/revoke and enabled submission still require live %s', async guard => {
    const fixture = await confirmed(), before = await f.proof()
    if (guard === 'permission') await f.sqlAdmin('DELETE FROM user_permissions WHERE user_id=$1', [principals.owner])
    else await f.sqlAdmin('UPDATE user_namespace_admissions SET enabled=false WHERE user_id=$1', [principals.owner])
    f.setEnablement('false'); f.sql.length = 0
    for (const [method, route, body] of [['GET', '/approvals/' + fixture.grant.grantId, undefined],
      ['POST', '/approvals/' + fixture.grant.grantId + '/revoke', {}]] as const) denial(await f.http(method, route, body), 503, 'YIDA_SEND_APPROVAL_UNAVAILABLE')
    f.setEnablement('true')
    denial(await f.http('POST', '/submissions', fixture.request), 503, 'YIDA_OWNER_RUNTIME_UNAVAILABLE')
    noMaterialRead(); noFetch(); expect(await f.proof()).toEqual(before)
  })
  it('material revocation prevents first admission while authorized OFF history remains readable', async () => {
    const fixture = await confirmed(); await f.revokeMaterial()
    const before = await f.proof(); f.sql.length = 0
    denial(await f.http('POST', '/submissions', fixture.request), 503, 'YIDA_OWNER_RUNTIME_UNAVAILABLE')
    noFetch(); expect(await f.proof()).toEqual(before)
    f.setEnablement('false'); f.sql.length = 0
    expect(bodyData(await f.http('GET', '/approvals/' + fixture.grant.grantId), 200)).toMatchObject({ approval: { remainingAttempts: 1 }, delivery: null })
    noMaterialRead(); noFetch()
  })
  it('unknown form result permanently consumes the attempt; exact replay observes, a new submission ID is denied', async () => {
    const fixture = await confirmed(); f.setFormOutcome('unknown')
    const first = bodyData(await f.http('POST', '/submissions', fixture.request), 200)
    expect(first).toMatchObject({ status: 'outcome_unknown', reused: false, externalWriteAttempted: true,
      businessVerified: false, durable: true, approval: { remainingAttempts: 0 } })
    expect((await f.rows('integration_yida_delivery_ledger'))[0].status).toBe('outcome_unknown')
    const before = await f.proof(); f.sql.length = 0
    expect(bodyData(await f.http('POST', '/submissions', fixture.request), 200)).toMatchObject({
      status: 'outcome_unknown', reused: true, externalWriteAttempted: false,
      approval: { remainingAttempts: 0 }, delivery: first.delivery })
    denial(await f.http('POST', '/submissions', { grantId: fixture.grant.grantId, submissionId: randomUUID() }),
      503, 'YIDA_OWNER_RUNTIME_UNAVAILABLE')
    expect(bodyData(await f.http('GET', '/approvals/' + fixture.grant.grantId), 200)).toMatchObject({
      approval: { remainingAttempts: 0 }, delivery: first.delivery })
    expect([f.tokenPayloads.length, f.formPayloads.length]).toEqual([1, 1]); noMaterialRead(); expect(await f.proof()).toEqual(before)
  })
  it('actual plugin capability becomes stale on deactivate and terminal stop leaves HTTP inactive', async () => {
    f.setEnablement('true')
    const stale = f.runtime.createPluginCapability(), before = await f.proof()
    await f.runtime.deactivate()
    let closed: unknown
    try { await stale.activate({} as never) } catch (error) { closed = error }
    expect(closed).toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' })
    f.sql.length = 0
    denial(await f.http('POST', '/drafts', draftInput()), 503, 'YIDA_OWNER_RUNTIME_INACTIVE')
    await f.runtime.stop()
    denial(await f.http('POST', '/drafts', draftInput()), 503, 'YIDA_OWNER_RUNTIME_INACTIVE')
    expect(f.sql).toEqual([]); noFetch(); expect(await f.proof()).toEqual(before)
  })
})

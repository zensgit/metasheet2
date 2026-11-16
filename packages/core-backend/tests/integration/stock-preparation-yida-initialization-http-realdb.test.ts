// Fresh native AuthService/pool import graph; never share a fork with the old
// owner send fixture. Real local JWT/PG; YiDa fetch is an in-process synthetic sink.
import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import winston from 'winston'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createYidaOwnerHttpRealdbFixture, draftInput, otherTenant, principals, sheetColumns, syntheticMaterial, tenant,
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
    expect(Object.keys(view).sort()).toEqual(['canSend', 'commandId', 'draft', 'externalWriteAttempted', 'sendEnabled', 'status', 'tokenIssued'])
    expect(view).toMatchObject({ canSend: false, tokenIssued: false, externalWriteAttempted: false })
    expect(typeof view.sendEnabled).toBe('boolean')
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
    // Y2: the schema also carries the additive multi-target migration; its switch starts OFF in every test,
    // so every pre-Y2 case below doubles as the switch-OFF / existing-single-target proof.
    f = await createYidaOwnerHttpRealdbFixture({ initialization: true, multiTarget: true })
  }, 30000)
  beforeEach(async () => { await f.reset(); logs.length = 0 }, 30000)
  afterAll(async () => { try { await f?.cleanup() } finally { logSpy?.mockRestore() } }, 30000)

  it('OFF initialization writes 090/091/092/result in one host transaction and GET alone recovers closed metadata', async () => {
    expect((await f.initializationProof()).counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
    const ready = data(await f.http('GET', '/initialization'), 200)
    expect(ready).toMatchObject({ status: 'ready', draft: null, sendEnabled: false })
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
    // The display bit follows the host's exact-literal send switch, only on this owner-authorized reply.
    f.setEnablement('true')
    expect(data(await f.http('GET', '/initialization'), 200)).toEqual({ ...recovered, sendEnabled: true })
    f.setEnablement('TRUE')
    expect(data(await f.http('GET', '/initialization'), 200)).toEqual({ ...recovered, sendEnabled: false })
    f.setEnablement('false')
    expect(await f.initializationProof()).toEqual(before); await noExternalWrite()
    const output = JSON.stringify([made, recovered])
    for (const value of [...Object.values(syntheticMaterial()), 'synthetic-http-review', 'synthetic-http-organization',
      'synthetic_http_form', 'synthetic HTTP part']) expect(output.includes(value)).toBe(false)
  })
  it('encryption material failing the production checks is 503 ENCRYPTION_NOT_READY in every NODE_ENV and writes nothing', async () => {
    const ready = data(await f.http('GET', '/initialization'), 200), before = await f.initializationProof()
    const saved = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'].map(key => [key, process.env[key]] as const)
    const set = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    const salt = process.env.ENCRYPTION_SALT
    try {
      for (const nodeEnv of [undefined, 'development', 'test', 'Production', 'production']) {
        for (const variant of [{ ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined },
          { ENCRYPTION_KEY: 'default-key-change-in-production', ENCRYPTION_SALT: 'default-salt-change-in-production' },
          { ENCRYPTION_KEY: '   ', ENCRYPTION_SALT: salt }]) {
          set('NODE_ENV', nodeEnv); for (const [key, value] of Object.entries(variant)) set(key, value)
          f.sql.length = 0
          denied(await f.http('POST', '/initialization', input(ready.commandId)), 503, 'YIDA_INITIALIZATION_ENCRYPTION_NOT_READY')
          expect(f.sql.some(sql => /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/iu.test(sql))).toBe(false)
          expect(f.sql.at(-1)).toBe('ROLLBACK')
        }
      }
    } finally { for (const [key, value] of saved) set(key, value) }
    expect(await f.initializationProof()).toEqual(before); await noExternalWrite()
    expect(data(await f.http('GET', '/initialization'), 200)).toMatchObject({ commandId: ready.commandId, status: 'ready', draft: null })
  })
  it('a doc placeholder, swapped defaults or KEY equal to SALT is the same 503 and writes nothing; short material seals with one fixed warning', async () => {
    const ready = data(await f.http('GET', '/initialization'), 200), before = await f.initializationProof()
    expect(before.counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
    const saved = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'].map(key => [key, process.env[key]] as const)
    const set = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    const key = process.env.ENCRYPTION_KEY, salt = process.env.ENCRYPTION_SALT
    const warning = 'YiDa initialization sealed credentials under an encryption key or salt shorter than 32 characters. '
      + 'This seal cannot be re-keyed. Securely back up the effective ENCRYPTION_KEY and ENCRYPTION_SALT from the configuration '
      + 'sources used by the running service. Keep those exact values for the life of the deployment.'
    try {
      // Each variant passes the shared production checks; only the L4 seal-material check refuses it.
      for (const nodeEnv of ['development', 'production']) {
        for (const variant of [{ ENCRYPTION_KEY: '<openssl rand -hex 32>', ENCRYPTION_SALT: '<openssl rand -hex 32, generated separately>' },
          { ENCRYPTION_KEY: '<openssl rand -hex 32>', ENCRYPTION_SALT: salt },
          // The dev-doc 32-hex sample pair (printed in lower case), compared ignoring case.
          { ENCRYPTION_KEY: 'ABCDEF0123456789ABCDEF0123456789', ENCRYPTION_SALT: '0123456789ABCDEF0123456789ABCDEF' },
          { ENCRYPTION_KEY: 'default-salt-change-in-production', ENCRYPTION_SALT: 'default-key-change-in-production' },
          { ENCRYPTION_KEY: key, ENCRYPTION_SALT: key }]) {
          set('NODE_ENV', nodeEnv); for (const [name, value] of Object.entries(variant)) set(name, value)
          f.sql.length = 0
          denied(await f.http('POST', '/initialization', input(ready.commandId)), 503, 'YIDA_INITIALIZATION_ENCRYPTION_NOT_READY')
          expect(f.sql.some(sql => /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/iu.test(sql))).toBe(false)
          expect(f.sql.at(-1)).toBe('ROLLBACK')
        }
      }
      expect(await f.initializationProof()).toEqual(before); await noExternalWrite()
      expect(data(await f.http('GET', '/initialization'), 200)).toMatchObject({ commandId: ready.commandId, status: 'ready', draft: null })
      await new Promise(resolve => setImmediate(resolve))
      expect(logs.some(entry => (entry as Data).message === warning)).toBe(false)
      // Short but otherwise valid material is sealed (owner decision: warn, do not block). The one warning keeps
      // its text through the private owner-HTTP Logger and carries no correlation, user or tenant field.
      set('NODE_ENV', 'production'); set('ENCRYPTION_KEY', 'synthetic-short-key'); set('ENCRYPTION_SALT', 'synthetic-short-salt')
      expect(data(await f.http('POST', '/initialization', input(ready.commandId)), 201).status).toBe('initialized')
      await new Promise(resolve => setImmediate(resolve))
      expect((await f.initializationProof()).counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]); await noExternalWrite()
      const warned = logs.filter(entry => (entry as Data).message === warning) as Array<Record<PropertyKey, unknown>>
      expect(warned).toHaveLength(1)
      expect(warned[0][Symbol.for('level')]).toBe('warn')
      expect(Object.keys(warned[0]).sort()).toEqual(['context', 'level', 'message', 'service', 'timestamp'])
      const output = inspect(logs, { depth: null, colors: false, getters: false })
      for (const value of ['synthetic-short-key', 'synthetic-short-salt', ...Object.values(syntheticMaterial()), f.tokens.owner])
        expect(output.includes(value)).toBe(false)
    } finally { for (const [name, value] of saved) set(name, value) }
  })
  it('the second actually qualified administrator cannot read ready or initialize the anchor owner slot', async () => {
    f.setEnablement('true')
    const ready = data(await f.http('GET', '/initialization'), 200), before = await f.initializationProof()
    expect(ready.sendEnabled).toBe(true)
    // A refused caller never learns the switch: the denial body is the closed code only.
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

  // ---- Y2: more than one target + sheet/view source (INTEGRATION_YIDA_MULTI_TARGET_ENABLED). Synthetic only. ----
  function body(result: Awaited<ReturnType<YidaOwnerHttpRealdbFixture['http']>>, status: number): Data {
    expect(result.status).toBe(status); expect(result.headers['cache-control']).toBe('no-store')
    expect(result.body.ok).toBe(true)
    return result.body.data as Data
  }
  function targetInput(commandId: string, formUuid = 'synthetic_http_form_two') {
    const value = input(commandId)
    ;(value.draft.config.target as Data).formUuid = formUuid
    value.attestation.reviewRef = 'synthetic-http-review-two'
    return value
  }
  function formDraft(formUuid?: string) {
    const value = draftInput()
    if (formUuid) (value.config.target as Data).formUuid = formUuid
    return value
  }
  async function initialized() {
    const ready = data(await f.http('GET', '/initialization'), 200)
    data(await f.http('POST', '/initialization', input(ready.commandId)), 201)
    return String((await f.rows('integration_yida_approved_target'))[0].target_ref)
  }
  const approval = (operationId: unknown, rowKey: unknown, extra: Data = {}) =>
    ({ operationId, rowKey, confirmationId: randomUUID(), acknowledgeOnce: true, ...extra })
  const sheetSource = { kind: 'sheet', sheetId: 'sheet_synthetic', columns: sheetColumns }

  it('Y2 switch OFF: no picker key, /targets is the generic 404, targetRef and sheet bodies are 400, slot 1 only', async () => {
    const first = await initialized()
    f.setEnablement('true')
    expect(data(await f.http('GET', '/initialization'), 200).status).toBe('initialized')
    const before = await f.initializationProof()
    for (const off of ['false', 'TRUE', ' true', true, undefined]) {
      f.setMultiTarget(off)
      denied(await f.http('GET', '/targets'), 404, 'NOT_FOUND')
      denied(await f.http('POST', '/targets', targetInput(randomUUID())), 404, 'NOT_FOUND')
      denied(await f.http('POST', '/drafts', { ...draftInput(), targetRef: first }), 400, 'YIDA_OWNER_HTTP_INPUT')
      denied(await f.http('POST', '/drafts', { config: draftInput().config, allocation: { mode: 'original' }, source: sheetSource }),
        400, 'YIDA_OWNER_HTTP_INPUT')
    }
    f.setMultiTarget('false')
    const made = body(await f.http('POST', '/drafts', draftInput()), 201), rowKey = (made.rows as Data[])[0].rowKey
    denied(await f.http('POST', '/preview', { operationId: made.operationId, rowKey, targetRef: first }), 400, 'YIDA_OWNER_HTTP_INPUT')
    denied(await f.http('POST', '/approvals', approval(made.operationId, rowKey, { targetRef: first })), 400, 'YIDA_OWNER_HTTP_INPUT')
    expect(await f.initializationProof()).toEqual(before)
    expect(await f.rows('integration_yida_target_registrations')).toEqual([])
    expect(await f.rows('integration_yida_send_approvals')).toEqual([])
    await noExternalWrite()
  })

  it('Y2 switch ON: a second target has its own attestation and material; drafts, previews, approvals and deliveries stay on one target', async () => {
    const first = await initialized()
    f.setMultiTarget('true'); f.setEnablement('true')
    expect(body(await f.http('GET', '/initialization'), 200).multiTargetEnabled).toBe(true)
    const listed = body(await f.http('GET', '/targets'), 200)
    expect((listed.targets as Data[]).map(target => [target.slot, target.targetRef, target.formUuid])).toEqual([[1, first, 'synthetic_http_form']])
    const commandId = randomUUID()
    const registered = body(await f.http('POST', '/targets', targetInput(commandId)), 201), made = registered.registered as Data
    expect([made.commandId, made.slot]).toEqual([commandId, 2])
    const second = String(made.targetRef)
    expect((registered.targets as Data[]).map(target => [target.slot, target.targetRef, target.appType, target.formUuid])).toEqual([
      [1, first, 'synthetic_http_app', 'synthetic_http_form'], [2, second, 'synthetic_http_app', 'synthetic_http_form_two']])
    expect(await f.rows('integration_yida_target_registrations')).toEqual([expect.objectContaining({ command_id: commandId, slot: 2,
      target_ref: second, owner_id: principals.owner, tenant_id: tenant, workspace_id: null, credential_generation: 1 })])
    const targets = await f.rows('integration_yida_approved_target')
    expect(targets.map(row => row.slot)).toEqual([1, 2])
    expect(new Set(targets.map(row => row.credential_ref)).size).toBe(2)
    // Replay, the same form twice, the first target's form and another administrator: refused, nothing written.
    const proof = await f.initializationProof(), registrations = await f.rows('integration_yida_target_registrations')
    denied(await f.http('POST', '/targets', targetInput(commandId)), 409, 'YIDA_INITIALIZATION_CONFLICT')
    denied(await f.http('POST', '/targets', targetInput(randomUUID())), 503, 'YIDA_INITIALIZATION_UNAVAILABLE')
    denied(await f.http('POST', '/targets', targetInput(randomUUID(), 'synthetic_http_form')), 503, 'YIDA_INITIALIZATION_UNAVAILABLE')
    denied(await f.http('POST', '/targets', targetInput(randomUUID(), 'synthetic_http_form_three'), { token: f.tokens.otherOwner }),
      403, 'YIDA_INITIALIZATION_DENIED')
    denied(await f.http('GET', '/targets', undefined, { token: f.tokens.otherOwner }), 403, 'YIDA_INITIALIZATION_DENIED')
    expect(await f.initializationProof()).toEqual(proof)
    expect(await f.rows('integration_yida_target_registrations')).toEqual(registrations)

    const d2 = body(await f.http('POST', '/drafts', { ...formDraft('synthetic_http_form_two'), targetRef: second }), 201)
    const d1 = body(await f.http('POST', '/drafts', draftInput()), 201)
    expect(body(await f.http('POST', '/drafts', { ...draftInput(), targetRef: first }), 201).operationId).toBe(d1.operationId)
    const row2 = (d2.rows as Data[])[0].rowKey, row1 = (d1.rows as Data[])[0].rowKey
    // Cross-target: a form compiled for target 1 cannot be drafted under target 2, nor previewed/approved there.
    const drafts = await f.initializationProof()
    expect((await f.http('POST', '/drafts', { ...draftInput(), targetRef: second })).status).toBe(503)
    expect(await f.initializationProof()).toEqual(drafts)
    denied(await f.http('POST', '/preview', { operationId: d2.operationId, rowKey: row2, targetRef: first }), 409, 'YIDA_SEND_APPROVAL_CONFLICT')
    denied(await f.http('POST', '/approvals', approval(d2.operationId, row2, { targetRef: first })), 409, 'YIDA_SEND_APPROVAL_CONFLICT')
    denied(await f.http('POST', '/approvals', approval(d1.operationId, row1, { targetRef: second })), 409, 'YIDA_SEND_APPROVAL_CONFLICT')
    expect((await f.http('POST', '/approvals', approval(d2.operationId, row2))).status).toBeGreaterThanOrEqual(400)
    denied(await f.http('POST', '/approvals', approval(d2.operationId, row2, { targetRef: randomUUID() })), 404, 'YIDA_SEND_APPROVAL_NOT_FOUND')
    // D20 (design baseline v2.3 §3.3 / §7.2): the second target is a formal one, so its pasted (unbound) draft is refused at
    // approval — no grant row — until the exact list INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS names it (the runtime parses
    // the string per call). Slot 1, the material TEST copy, never needs the list.
    denied(await f.http('POST', '/approvals', approval(d2.operationId, row2, { targetRef: second })), 409, 'YIDA_SEND_APPROVAL_CONFLICT')
    expect(await f.rows('integration_yida_send_approvals')).toEqual([])
    const preview = body(await f.http('POST', '/preview', { operationId: d2.operationId, rowKey: row2, targetRef: second }), 200)
    expect(preview.target).toMatchObject({ targetRef: second, formUuid: 'synthetic_http_form_two', reviewRef: 'synthetic-http-review-two' })
    // The list is exact and all-or-nothing (flag manifest: byte-exact, no trim, no case folding; an empty or non-UUID entry
    // empties the WHOLE list): none of these values names the target, so the formal target still refuses and nothing is written.
    for (const malformed of [second.toUpperCase(), ' ' + second, second + ',not-a-target', second + ',']) {
      f.setUnboundTestTargetRefs(malformed)
      denied(await f.http('POST', '/approvals', approval(d2.operationId, row2, { targetRef: second })), 409, 'YIDA_SEND_APPROVAL_CONFLICT')
    }
    expect(await f.rows('integration_yida_send_approvals')).toEqual([])
    f.setUnboundTestTargetRefs(second)
    const g2 = body(await f.http('POST', '/approvals', approval(d2.operationId, row2, { targetRef: second })), 201)
    const g1 = body(await f.http('POST', '/approvals', approval(d1.operationId, row1)), 201)
    expect([g2.targetRef, g1.targetRef]).toEqual([second, first])
    // A grant is bound for good. Switch OFF, the slot-1 authority cannot even see the target-2 grant.
    expect((body(await f.http('GET', '/approvals/' + String(g2.grantId)), 200).approval as Data).targetRef).toBe(second)
    f.setMultiTarget('false')
    denied(await f.http('GET', '/approvals/' + String(g2.grantId)), 404, 'YIDA_SEND_APPROVAL_NOT_FOUND')
    expect((await f.http('POST', '/submissions', { grantId: g2.grantId, submissionId: randomUUID() })).status).toBeGreaterThanOrEqual(400)
    expect(await f.rows('integration_yida_send_admissions')).toEqual([])
    expect((body(await f.http('GET', '/approvals/' + String(g1.grantId)), 200).approval as Data).targetRef).toBe(first)
    f.setMultiTarget('true')
    const sent2 = body(await f.http('POST', '/submissions', { grantId: g2.grantId, submissionId: randomUUID() }), 200)
    const sent1 = body(await f.http('POST', '/submissions', { grantId: g1.grantId, submissionId: randomUUID() }), 200)
    expect([sent2.status, sent1.status]).toEqual(['acknowledged', 'acknowledged'])
    const ledger = await f.rows('integration_yida_delivery_ledger'), grants = await f.rows('integration_yida_send_approvals')
    expect(ledger.map(row => row.target_ref).sort()).toEqual([first, second].sort())
    for (const row of ledger) {
      const grant = grants.find(candidate => candidate.operation_id === row.operation_id)!
      expect([row.target_ref, row.credential_ref, row.business_key_digest])
        .toEqual([grant.target_ref, grant.credential_ref, grant.business_key_digest])
    }
    // Per-target CREATE fence: each reservation names its own target; the two business keys are form-scoped.
    expect(new Set(ledger.map(row => `${String(row.target_ref)}:${String(row.business_key_digest)}`)).size).toBe(2)
    expect(f.formPayloads).toHaveLength(2); expect(f.validRequests).toBe(true)
    const output = JSON.stringify([listed, registered, d1, d2, g1, g2, sent1, sent2])
    for (const value of Object.values(syntheticMaterial())) expect(output.includes(value)).toBe(false)
  })

  it('Y2 sheet source: the draft equals the one from the equivalent pasted rowsText; refusals are closed and write nothing', async () => {
    const first = await initialized()
    f.setMultiTarget('true'); f.setEnablement('true')
    const config = draftInput().config, allocation = { mode: 'original' }
    const equivalent = JSON.stringify([{ projectNo: 'SYN-P1', lineId: 'SYN-L1', quantity: 6, description: 'synthetic HTTP part' }])
    const pasted = body(await f.http('POST', '/drafts', { config, allocation, rowsText: equivalent, targetRef: first }), 201)
    const fromSheet = body(await f.http('POST', '/drafts', { config, allocation, source: sheetSource, targetRef: first }), 201)
    // Same plan digest on the same target = the same persisted operation (reused), row for row.
    expect(fromSheet).toEqual({ ...pasted, reused: true })
    const before = await f.initializationProof()
    denied(await f.http('POST', '/drafts', { config, allocation, rowsText: equivalent, source: sheetSource }), 400, 'YIDA_OWNER_HTTP_INPUT')
    denied(await f.http('POST', '/drafts', { config, allocation }), 400, 'YIDA_OWNER_HTTP_INPUT')
    denied(await f.http('POST', '/drafts', { config, allocation, source: { ...sheetSource, kind: 'sql' } }), 400, 'YIDA_SHEET_SOURCE_INPUT')
    for (const [sheet, status, code] of [[{ access: { canRead: false } }, 403, 'YIDA_SHEET_SOURCE_DENIED'],
      [{ access: { canExport: false } }, 403, 'YIDA_SHEET_SOURCE_DENIED'], [{ access: { live: false } }, 404, 'YIDA_SHEET_SOURCE_NOT_FOUND'],
      [{ records: [] }, 400, 'YIDA_SHEET_SOURCE_INPUT'],
      [{ records: Array.from({ length: 101 }, (_, index) => ({ id: 'rec_' + index, data: { fld_project: 'SYN-P1', fld_line: 'L' + index, fld_qty: 1 } })) }, 422, 'YIDA_SHEET_SOURCE_LIMIT'],
      [{ records: [{ id: 'rec_1', data: { fld_project: 'SYN-P1', fld_line: 'L1', fld_qty: [1] } }] }, 422, 'YIDA_SHEET_SOURCE_UNSUPPORTED']] as const) {
      f.setSheet(sheet as Parameters<YidaOwnerHttpRealdbFixture['setSheet']>[0])
      denied(await f.http('POST', '/drafts', { config, allocation, source: sheetSource, targetRef: first }), status, code)
    }
    expect(await f.initializationProof()).toEqual(before)
    // Send switch off: the sheet is not read at all (same refusal the draft itself would get).
    f.setSheet({}); f.setEnablement('false')
    denied(await f.http('POST', '/drafts', { config, allocation, source: sheetSource, targetRef: first }), 403, 'YIDA_OWNER_RUNTIME_DISABLED')
    f.setMultiTarget('false')
    denied(await f.http('POST', '/drafts', { config, allocation, source: sheetSource }), 400, 'YIDA_OWNER_HTTP_INPUT')
    expect(await f.initializationProof()).toEqual(before)
    await new Promise(resolve => setImmediate(resolve))
    const output = inspect(logs, { depth: null, colors: false, getters: false })
    for (const value of ['SYN-L1', 'synthetic HTTP part', 'sheet_synthetic']) expect(output.includes(value)).toBe(false)
  })

  it('Y2 sheet source: the owner/target proof precedes the sheet read; a non-owner gets the pasted-rows refusal with zero sheet reads', async () => {
    const first = await initialized()
    f.setMultiTarget('true'); f.setEnablement('true')
    const config = draftInput().config, allocation = { mode: 'original' }
    const equivalent = JSON.stringify([{ projectNo: 'SYN-P1', lineId: 'SYN-L1', quantity: 6, description: 'synthetic HTTP part' }])
    const before = await f.initializationProof()
    const otherTenantToken = await f.tokenFor(principals.owner, otherTenant)
    for (const token of [f.tokens.otherOwner, f.tokens.reader, f.tokens.fakeRole, otherTenantToken]) {
      for (const target of [{ targetRef: first }, { targetRef: randomUUID() }, {}]) {
        const pasted = await f.http('POST', '/drafts', { config, allocation, rowsText: equivalent, ...target }, { token })
        const fromSheet = await f.http('POST', '/drafts', { config, allocation, source: sheetSource, ...target }, { token })
        expect(pasted.status).toBeGreaterThanOrEqual(400)
        expect({ status: fromSheet.status, body: fromSheet.body }).toEqual({ status: pasted.status, body: pasted.body })
      }
    }
    // Not one call on the sheet read path (access, fields, view, records, record permissions) for any of them.
    expect(f.sheetReads).toBe(0)
    // The owner's own unknown target is refused the same way, also before any read.
    const unknown = { config, allocation, targetRef: randomUUID() }
    const pastedUnknown = await f.http('POST', '/drafts', { ...unknown, rowsText: equivalent })
    const sheetUnknown = await f.http('POST', '/drafts', { ...unknown, source: sheetSource })
    expect(pastedUnknown.status).toBeGreaterThanOrEqual(400)
    expect({ status: sheetUnknown.status, body: sheetUnknown.body }).toEqual({ status: pastedUnknown.status, body: pastedUnknown.body })
    expect(f.sheetReads).toBe(0)
    expect(await f.initializationProof()).toEqual(before)
    // Control: the proven owner on a known target does read the sheet (the counter is live).
    body(await f.http('POST', '/drafts', { config, allocation, source: sheetSource, targetRef: first }), 201)
    expect(f.sheetReads).toBeGreaterThan(0)
    await noExternalWrite()
  })
})

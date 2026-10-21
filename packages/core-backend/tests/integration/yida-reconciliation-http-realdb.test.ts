// Real JWT -> live ACL -> actual management HOST -> real PG. Historical
// admissions are synthetic test seeds, not claims of an actual external send.
import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { createYidaAutomationHttpFixture } from '../utils/yida-automation-http-fixture'
import { principals, otherTenant } from '../utils/stock-preparation-yida-owner-http-fixture'
import { createYidaAutomationAuthorizationStore } from '../../src/integration/yida-automation-authorization-store'

type Fixture = Awaited<ReturnType<typeof createYidaAutomationHttpFixture>>
const command = () => ({ commandKey: randomUUID(), expectedHeadSequence: 0, conclusion: 'observed_match',
  reason: 'OPERATOR_RECORDED_MATCH', evidenceKind: 'operator_comparison', evidenceSha256: 'a'.repeat(64),
  evidenceRef: 'SYNTHETIC_EVIDENCE', claimedObservedAt: null, supersedesObservationId: null })
it('sentinel: reconciliation only runs against owned PG and loopback', () => {
  expect(process.env.EXPECT_DB).toBe('1'); expect(process.env.PLM_FULL_APP_ALLOW_OWN_HTTP).toBe('1')
})
describe('append-only operator facts — real JWT, host, transactions and constraints', () => {
  let f: Fixture, grantId: string, requestId: string, endpoint: string
  beforeAll(async () => { f = await createYidaAutomationHttpFixture() }, 30000)
  beforeEach(async () => {
    await f.reset()
    const grant = await f.http('POST', '', f.consent()); expect(grant.status).toBe(201)
    grantId = grant.body.data.grantId as string
    const request = await f.http('POST', '/' + grantId + '/requests', { requestKey: 'synthetic-history' })
    expect(request.status).toBe(202); requestId = request.body.data.requestId as string
    const store = createYidaAutomationAuthorizationStore({ scope: { tenantId: f.tenant, ownerId: principals.owner, workspaceId: null },
      activationId: '22222222-2222-4222-8222-222222222222' })
    await f.transaction(async trx => {
      const id = randomUUID()
      await trx.query(`INSERT INTO integration_yida_delivery_ledger
        (id,tenant_id,operation_id,row_key,owner_id,target_ref,target_revision,plan_revision,payload_digest,
         business_key_digest,credential_ref,credential_generation,intent,status)
        VALUES ($1,$2,$3,$4,$5,'synthetic-target','synthetic-revision','synthetic-plan',$6,$6,'synthetic-ref',1,'create','prepared')`,
      [id, f.tenant, f.consent().operationId, f.consent().rowKeys[0], principals.owner, 'b'.repeat(64)])
      await store.admitInTransaction(trx, grantId, { requestId, ledgerId: id, workerId: 'synthetic-worker', workerFence: '1' })
      await trx.query(`UPDATE integration_yida_delivery_ledger SET status='dispatching',claim_token=$2,claim_actor_id=$3 WHERE id=$1`,
      [id, 'c'.repeat(64), principals.owner])
      await trx.query(`UPDATE integration_yida_delivery_ledger SET status='outcome_unknown' WHERE id=$1`, [id])
    })
    endpoint = '/' + grantId + '/requests/' + requestId + '/observations'
  }, 30000)
  afterAll(async () => { await f?.cleanup() }, 30000)
  async function immutableSnapshot() {
    const tables = ['integration_yida_auto_grants', 'integration_yida_auto_requests', 'integration_yida_auto_admissions',
      'integration_yida_delivery_ledger', 'integration_yida_delivery_audit', 'meta_automation_outbox']
    return Promise.all(tables.map(async table => (await f.query(`SELECT * FROM ${table}`)).rows))
  }
  function noSend() {
    expect([f.historySourceCalls, f.historyFetchCalls, f.owner.tokenPayloads.length, f.owner.formPayloads.length]).toEqual([0, 0, 0, 0])
  }
  async function counts() { return (await f.query(`SELECT (SELECT count(*)::int FROM integration_yida_reconciliation_observations) AS records,
    (SELECT count(*)::int FROM integration_yida_reconciliation_audit) AS audits`)).rows[0] }
  it('revoked/stale history appends without installation/sending and cannot change unknown, budget or active slot', async () => {
    expect((await f.http('POST', '/' + grantId + '/revoke', {})).status).toBe(200)
    const before = await immutableSnapshot(), body = command()
    const saved = await f.http('POST', endpoint, body)
    expect(saved.status).toBe(201)
    expect(saved.body.data.record).toMatchObject({ sequence: 1, authorId: principals.owner, conclusion: 'observed_match',
      evidenceOrigin: 'operator-supplied', evidenceVerified: false, canSend: false, canRetry: false })
    const page = await f.http('GET', endpoint)
    expect(page.status).toBe(200); expect(page.headers['cache-control']).toBe('no-store')
    expect(page.body.data.records).toEqual([saved.body.data.record]); expect(page.body.data.headSequence).toBe(1)
    expect(await counts()).toEqual({ records: 1, audits: 1 }); expect(await immutableSnapshot()).toEqual(before); noSend()
  })
  it('lost COMMIT response retries the identical command before head check, never a second fact', async () => {
    const body = command(); f.loseNextCommitResponse()
    expect((await f.http('POST', endpoint, body)).status).toBe(503)
    expect(await counts()).toEqual({ records: 1, audits: 1 })
    const replay = await f.http('POST', endpoint, body)
    expect(replay.status).toBe(200); expect(replay.body.data.reused).toBe(true)
    expect((await f.http('POST', endpoint, { ...body, evidenceRef: 'OTHER' })).status).toBe(409)
    expect(await counts()).toEqual({ records: 1, audits: 1 }); noSend()
  })
  it('serializes duplicate commands and rejects stale-head concurrent new commands', async () => {
    const body = command(), duplicate = await Promise.all([f.http('POST', endpoint, body), f.http('POST', endpoint, body)])
    expect(duplicate.map(r => r.status).sort()).toEqual([200, 201])
    const next = await Promise.all([1, 2].map(() => f.http('POST', endpoint, { ...command(), expectedHeadSequence: 1 })))
    expect(next.map(r => r.status).sort()).toEqual([201, 409])
    expect(await counts()).toEqual({ records: 2, audits: 2 }); noSend()
  })
  it('only appends corrections, rejects foreign correction/cursor, and forbids table update/delete/truncate', async () => {
    const first = await f.http('POST', endpoint, command()), id = (first.body.data.record as { id: string }).id
    const corrected = { ...command(), expectedHeadSequence: 1, conclusion: 'observed_mismatch', reason: 'CORRECTION', supersedesObservationId: id }
    expect((await f.http('POST', endpoint, { ...corrected, supersedesObservationId: randomUUID() })).status).toBe(403)
    expect((await f.http('POST', endpoint, corrected)).status).toBe(201)
    expect((await f.http('GET', endpoint + '/' + randomUUID())).status).toBe(403)
    const page = await f.http('GET', endpoint + '/' + id)
    expect(page.status).toBe(200); expect((page.body.data.records as unknown[]).length).toBe(1)
    for (const table of ['integration_yida_reconciliation_observations', 'integration_yida_reconciliation_audit']) {
      for (const sql of [`DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`,
        table.endsWith('_audit') ? `UPDATE ${table} SET action=action` : `UPDATE ${table} SET content=content`]) {
        await expect(f.query(sql)).rejects.toThrow('YIDA_RECONCILIATION_IMMUTABLE')
      }
    }
    expect(await counts()).toEqual({ records: 2, audits: 2 }); noSend()
  })
  it('audit insertion failure rolls back the record before any success response', async () => {
    await f.query(`ALTER TABLE integration_yida_reconciliation_audit ADD CONSTRAINT synthetic_reject CHECK(false) NOT VALID`)
    expect((await f.http('POST', endpoint, command())).status).toBe(503)
    expect(await counts()).toEqual({ records: 0, audits: 0 }); noSend()
  })
  it('rejects unsigned/no-tenant/foreign-owner/foreign-tenant/reader identities through native JWT', async () => {
    const tokens = [null, 'synthetic-invalid', await f.owner.tokenFor(principals.owner, null),
      await f.owner.tokenFor(principals.owner, otherTenant), f.owner.tokens.otherOwner, f.owner.tokens.reader, f.owner.tokens.fakeRole]
    for (const token of tokens) {
      for (const method of ['POST', 'GET']) {
        const result = await f.http(method, endpoint, method === 'POST' ? command() : undefined, { token })
        expect([401, 403]).toContain(result.status)
      }
    }
    expect(await counts()).toEqual({ records: 0, audits: 0 }); noSend()
  })
  it('live role removal blocks both operations with a previously valid JWT', async () => {
    await f.query('DELETE FROM user_roles WHERE user_id=$1', [principals.owner])
    await f.query('DELETE FROM user_permissions WHERE user_id=$1', [principals.owner])
    expect((await f.http('POST', endpoint, command())).status).toBe(403)
    expect((await f.http('GET', endpoint)).status).toBe(403); noSend()
  })
  it('disabled owner and removed tenant membership independently deny historical reads and appends', async () => {
    await f.query('UPDATE users SET is_active=false WHERE id=$1', [principals.owner])
    expect([401, 403]).toContain((await f.http('POST', endpoint, command())).status)
    expect([401, 403]).toContain((await f.http('GET', endpoint)).status)
    await f.query('UPDATE users SET is_active=true WHERE id=$1', [principals.owner])
    await f.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [principals.owner, f.tenant])
    expect((await f.http('POST', endpoint, command())).status).toBe(403)
    expect((await f.http('GET', endpoint)).status).toBe(403)
    expect(await counts()).toEqual({ records: 0, audits: 0 }); noSend()
  })
  it('pages at fifty, scopes the cursor and preserves all history instead of last-write-wins', async () => {
    for (let i = 0; i < 51; i++) {
      expect((await f.http('POST', endpoint, { ...command(), expectedHeadSequence: i, conclusion: 'inconclusive',
        reason: 'NO_OBSERVATION', evidenceKind: null, evidenceRef: null, evidenceSha256: null })).status).toBe(201)
    }
    const first = await f.http('GET', endpoint)
    expect((first.body.data.records as unknown[]).length).toBe(50); expect(first.body.data.headSequence).toBe(51)
    expect(typeof first.body.data.nextAfterId).toBe('string')
    const second = await f.http('GET', endpoint + '/' + first.body.data.nextAfterId)
    expect((second.body.data.records as unknown[]).length).toBe(1); expect(second.body.data.nextAfterId).toBe(null)
    expect((second.body.data.records as { sequence: number }[])[0].sequence).toBe(51)
    expect(await counts()).toEqual({ records: 51, audits: 51 }); noSend()
  })
  it('the database independently rejects a record committed without its private audit', async () => {
    const saved = await f.http('POST', endpoint, command()); expect(saved.status).toBe(201)
    await expect(f.transaction(async trx => {
      await trx.query(`INSERT INTO integration_yida_reconciliation_observations
        (id,tenant_id,owner_id,grant_id,request_id,admission_id,ledger_id,sequence,command_key,content_sha256,content)
        SELECT $1,tenant_id,owner_id,grant_id,request_id,admission_id,ledger_id,2,$2,content_sha256,content
        FROM integration_yida_reconciliation_observations WHERE sequence=1`, [randomUUID(), randomUUID()])
    })).rejects.toThrow('YIDA_RECONCILIATION_AUDIT_REQUIRED')
    expect(await counts()).toEqual({ records: 1, audits: 1 }); noSend()
  })
  it('observed match cannot release the permanent CREATE uniqueness fence', async () => {
    expect((await f.http('POST', endpoint, command())).status).toBe(201)
    await expect(f.query(`INSERT INTO integration_yida_delivery_ledger
      (id,tenant_id,operation_id,row_key,owner_id,target_ref,target_revision,plan_revision,payload_digest,
       business_key_digest,credential_ref,credential_generation,intent,status)
      SELECT $1,tenant_id,$2,row_key,owner_id,target_ref,target_revision,plan_revision,payload_digest,
       business_key_digest,credential_ref,credential_generation,intent,'prepared'
      FROM integration_yida_delivery_ledger`, [randomUUID(), 'another-synthetic-operation'])).rejects.toMatchObject({ code: '23505' })
    expect((await f.http('GET', '/' + grantId)).body.data.serialBlocked).toBe(true); noSend()
  })
  it('rejects scope smuggling, malformed evidence and cross-grant request linkage', async () => {
    for (const patch of [{ tenantId: f.tenant }, { evidenceRef: 'https://invalid.test' }, { evidenceRef: '../file' },
      { evidenceRef: 'x'.repeat(129) }, { reason: 'NO_OBSERVATION' }, { evidenceKind: ['operator_comparison'] },
      { evidenceKind: null, evidenceRef: null, evidenceSha256: null }]) {
      expect((await f.http('POST', endpoint, { ...command(), ...patch })).status).toBe(400)
    }
    expect((await f.http('POST', endpoint, undefined, { raw: ' '.repeat(4096) + JSON.stringify(command()) })).status).toBe(413)
    expect((await f.http('POST', endpoint, command(), { headers: { 'x-workspace-id': 'synthetic' } })).status).toBe(400)
    const other = await f.http('POST', '', { ...f.consent(), confirmationId: randomUUID() })
    expect(other.status).toBe(201)
    expect((await f.http('POST', '/' + other.body.data.grantId + '/requests/' + requestId + '/observations', command())).status).toBe(403)
    expect(await counts()).toEqual({ records: 0, audits: 0 }); noSend()
  })
  it('raw body budget follows case-insensitive routing including optional trailing slash', async () => {
    const before = await immutableSnapshot()
    for (const segment of ['observations', 'OBSERVATIONS', 'ObSeRvAtIoNs/']) {
      const path = endpoint.replace(/observations$/u, segment)
      expect((await f.http('POST', path, undefined, { raw: ' '.repeat(4096) + JSON.stringify(command()) })).status).toBe(413)
    }
    expect(await counts()).toEqual({ records: 0, audits: 0 })
    const positive = endpoint.replace(/observations$/u, 'ObSeRvAtIoNs/')
    expect((await f.http('POST', positive, command())).status).toBe(201)
    expect(await counts()).toEqual({ records: 1, audits: 1 })
    expect(await immutableSnapshot()).toEqual(before); noSend()
  })
  it('actual host.stop joins a blocked history transaction and refuses its late write after the lock settles', async () => {
    let release!: () => void, locked!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { locked = resolve })
    const holding = f.transaction(async trx => {
      await trx.query('SELECT id FROM integration_yida_auto_grants WHERE id=$1 FOR UPDATE', [grantId]); locked(); await held
    })
    let request: ReturnType<Fixture['http']> | undefined, stop: Promise<void> | undefined
    try {
      await ready
      request = f.http('POST', endpoint, command())
      let waiting = false
      for (let i = 0; i < 100; i++) {
        const result = await f.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM integration_yida_auto_grants%tenant_id=%'`)
        if (result.rows[0].n > 0) { waiting = true; break }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      let stopped = false; stop = f.stopHistoryHost().then(() => { stopped = true })
      await new Promise(resolve => setTimeout(resolve, 20)); expect(stopped).toBe(false)
      release(); await holding
      expect((await request).status).toBe(503); await stop; expect(stopped).toBe(true)
      expect(await counts()).toEqual({ records: 0, audits: 0 }); noSend()
    } finally { release(); await holding; await request; await stop }
  })
})

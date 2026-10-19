/** Real persistence/publication and PG locks; native transport is a controlled fixture here. */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Request, Response } from 'express'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { bootstrapPlmBomReviewTestDb } from '../plm-bom-review/bootstrap'
import { shareSnapshot } from '../plm-bom-review/fixture'
import { up as managedUp } from '../../src/db/migrations/zzzz20261018010000_create_plm_managed_companion'
import { up, down } from '../../src/db/migrations/zzzz20261019010000_create_plm_snapshot_share_intents'
import { PlmManagedSnapshotShareFlow } from '../../src/services/plm-managed-snapshot-share-flow'
import { managedRequestContext } from '../../src/services/plm-managed-request-context'
import { setManagedNativeFetchForTests } from '../../src/services/plm-managed-native-http'
import { sourceFingerprint } from '../../src/services/plm-managed-companion'
import { poolManager } from '../../src/integration/db/connection-pool'
import { unlinkManagedSource } from '../../src/services/plm-managed-companion-flow'
import { PlmBomReviewService } from '../../src/multitable/plm-bom-review-service'
import type { BomReviewPool } from '../../src/multitable/plm-bom-review-service'

const url = process.env.PLM_SNAPSHOT_SHARE_TEST_PG_URL
if (!url || url !== process.env.DATABASE_URL || !new URL(url).searchParams.get('host')?.startsWith('/tmp/plm-managed-consumer-pg-')) {
  throw new Error('Explicit owned-socket disposable PostgreSQL DSN required; no skip-green')
}
const pool = new Pool({ connectionString: url, max: 8 })
const tx: BomReviewPool = { query: pool.query.bind(pool), async transaction(fn) {
  const client = await pool.connect()
  try { await client.query('BEGIN'); const result = await fn({ query: client.query.bind(client) }); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
} }
const origin = 'http://127.0.0.1:9'
const reg = { issuer: origin + '/installation', clientId: 'snapshot-client', clientSecret: 'synthetic-confidential-secret',
  callback: origin + '/api/plm/managed-login/callback', origin, nativeTenantId: 'native-tenant', nativeOrgId: 'native-org', nativeBaseUrl: origin }
const native = new Map<string, { id: string; args: any; receipt?: any; cancelled: boolean }>()
let beforeExport: (() => Promise<void>) | null = null
const calls: string[] = []
const flow = new PlmManagedSnapshotShareFlow({ pool: tx, dataSourceManager: { getDataSource() { throw new Error('shared adapter must never be called') } } })

beforeAll(async () => {
  process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
  process.env.PLM_MANAGED_SNAPSHOT_SHARE_ENABLED = 'true'
  process.env.PLM_MANAGED_COMPANION_TEST_HOOKS = 'true'
  process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([reg])
  process.env.PLM_BOM_REVIEW_ENABLED = 'true'
  process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
  process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
  await bootstrapPlmBomReviewTestDb(pool)
  await pool.query('CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean); ALTER TABLE users ADD COLUMN must_change_password boolean DEFAULT false')
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await managedUp(db)
  await up(db)
  setManagedNativeFetchForTests(async (input, options) => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    const args = JSON.parse(String(options?.body))
    expect(args.client_secret).toBe(reg.clientSecret)
    expect(options?.headers).toMatchObject({ 'x-tenant-id': 'native-tenant', 'x-org-id': 'native-org' })
    if (path === '/api/v1/auth/managed-login/revoke') return new Response(null, { status: 204 })
    expect(args.callback).toBe(reg.callback)
    if (path.endsWith('/prepare')) {
      let row = native.get(args.operation_id)
      if (!row) { row = { id: randomUUID(), args, cancelled: false }; native.set(args.operation_id, row) }
      expect(row.args).toEqual(args)
      return new Response(JSON.stringify({ intent_id: row.id, operation_id: args.operation_id,
        policy: 'authorized_snapshot_target_acl.v1', confirmation_path: '/bom-snapshot-share?intent=' + row.id }))
    }
    if (path.endsWith('/export')) {
      const row = [...native.values()].find(value => args.code === 'yus_' + value.id + '.' + 'a'.repeat(64))!
      if (!row || row.cancelled) return new Response('{}', { status: 403 })
      if (beforeExport) await beforeExport()
      if (!row.receipt) {
        const snapshot = shareSnapshot()
        const bytes = Buffer.from(JSON.stringify({ source: { tenant_id: reg.nativeTenantId, org_id: reg.nativeOrgId,
          auth_user_id: '42', part_id: 'P' }, context: snapshot.context }))
        row.receipt = { contract: 'bom_snapshot_share.v1', policy: 'authorized_snapshot_target_acl.v1',
          intent_id: row.id, operation_id: row.args.operation_id, target: row.args.target,
          confirmed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 290_000).toISOString(),
          snapshot_hash: createHash('sha256').update(bytes).digest('hex'), snapshot_base64: bytes.toString('base64') }
      }
      return new Response(JSON.stringify(row.receipt))
    }
    if (path.endsWith('/cancel')) {
      const row = native.get(args.operation_id)
      if (!row || row.id !== args.intent_id) return new Response('{}', { status: 403 })
      row.cancelled = true
      return new Response(JSON.stringify({ revoked: true }))
    }
    throw new Error('Unexpected native path: ' + path)
  })
})
afterAll(async () => {
  setManagedNativeFetchForTests(null)
  await pool.end()
  await poolManager.close()
})

async function prepared(sourceTenant = 'meta-tenant', sessionSeconds = 300) {
  const suffix = randomUUID(), actor = 'actor-' + suffix, source = 'source-' + suffix, base = 'base-' + suffix
  const link = randomUUID(), session = randomUUID(), browserIntent = randomUUID(), operation = randomUUID()
  const fp = sourceFingerprint({ type: 'plm', origin, ownerId: actor, rootPartId: 'P', tenantId: sourceTenant, workspaceId: 'meta-org', scopeKind: 'user' })
  await pool.query("INSERT INTO users(id,is_active,role,activation_status,local_password_set,permissions) VALUES($1,true,'user','activated',true,'{}');", [actor])
  await pool.query("INSERT INTO user_orgs VALUES($1,'meta-tenant',true),($1,'meta-org',true)", [actor])
  await pool.query('INSERT INTO meta_bases(id,name,owner_id) VALUES($1,$2,$3)', [base,'Target base',actor])
  await pool.query(`INSERT INTO data_sources(id,name,type,config,owner_id,is_active,tenant_id,workspace_id,scope_kind)
    VALUES($1,'Source','plm',$2::jsonb,$3,true,$4,'meta-org','user')`,
    [source,JSON.stringify({ connection: { url: origin }, credentials: { token: 'shared-must-never-be-used' } }),actor,sourceTenant])
  await pool.query(`INSERT INTO plm_managed_identity_links(id,installation_issuer,native_auth_user_id,native_tenant_id,native_org_id,
    client_id,callback,meta_user_id,meta_tenant_id,meta_org_id,data_source_id,root_part_id,client_origin,generation,status,owner_user_id,created_by,source_fingerprint)
    VALUES($1,$2,'42','native-tenant','native-org',$3,$4,$5,'meta-tenant','meta-org',$6,'P',$7,1,'active',$5,$5,$8)`,
    [link,reg.issuer,reg.clientId,reg.callback,actor,source,origin,fp])
  await pool.query(`INSERT INTO plm_managed_browser_intents(id,link_id,generation,meta_user_id,meta_tenant_id,meta_org_id,data_source_id,
    root_part_id,client_origin,installation_issuer,native_tenant_id,native_org_id,callback,client_id,state_hash,nonce_hash,code_challenge,
    code_verifier_ciphertext,return_path,status,expires_at,consumed_at,delegation_id,credential_ciphertext)
    VALUES($1,$2,1,$3,'meta-tenant','meta-org',$4,'P',$5,$6,'native-tenant','native-org',$7,$8,$9,$9,$11,'enc:fixture','/plm/bom-review','consumed',
      now()+interval '5 minutes',now(),$10,'enc:read-fixture')`, [browserIntent,link,actor,source,origin,reg.issuer,reg.callback,reg.clientId,'a'.repeat(64),'delegation-'+session,'a'.repeat(43)])
  await pool.query(`INSERT INTO plm_managed_source_bindings(data_source_id,link_id,generation,source_fingerprint,status,frozen_origin,frozen_root_part_id)
    VALUES($1,$2,1,$3,'active',$4,'P')`, [source,link,fp,origin])
  await pool.query(`INSERT INTO plm_managed_sessions(id,intent_id,link_id,data_source_id,generation,delegation_id,credential_ciphertext,expires_at,scope,
    native_subject,native_tenant_id,native_org_id,meta_user_id,meta_tenant_id,meta_org_id,root_part_id,client_origin,installation_issuer,client_id)
    VALUES($1,$2,$3,$4,1,$5,'enc:read-fixture',now()+make_interval(secs => $10),'bom_review_read','42','native-tenant','native-org',$6,'meta-tenant','meta-org','P',$7,$8,$9)`,
    [session,browserIntent,link,source,'delegation-'+session,actor,origin,reg.issuer,reg.clientId,sessionSeconds])
  const headers: Record<string,string> = { origin, 'content-type': 'application/json', 'x-plm-snapshot-share': 'start' }
  const req = { user: { id: actor }, authenticatedTenantId: 'meta-tenant', headers,
    get: (key: string) => headers[key.toLowerCase()], body: { operationId: operation, dataSourceId: source, partId: 'P', baseId: base, name: 'Consented BOM' } } as unknown as Request
  const jar: Record<string,string> = {}
  const res = { cookie(name: string,value: string) { jar[name] = value; return this } } as unknown as Response
  const run = <T>(fn: () => Promise<T>) => managedRequestContext.run({ userId: actor, sessionId: session, conflict: false }, fn)
  await run(() => flow.start(req,res))
  headers.cookie = Object.entries(jar).map(([k,v]) => k + '=' + v).join('; ')
  headers['x-plm-snapshot-share'] = 'complete'
  const n = native.get(operation)!
  req.body = { operationId: operation, state: n.args.state, code: 'yus_' + n.id + '.' + 'a'.repeat(64) }
  return { req,res,run,actor,session,source,base,link,operation,n,headers }
}

describe('independent snapshot consent to existing BOM engine', () => {
  it('publishes real collaboration records/history and replays without new export or duplicate records', async () => {
    const c = await prepared()
    const first = await c.run(() => flow.complete(c.req))
    expect(first.ok).toBe(true)
    const nativeCalls = calls.length
    const again = await c.run(() => flow.complete(c.req))
    expect(again.data.id).toBe(first.data.id)
    expect(calls.length).toBe(nativeCalls)
    const persisted = await pool.query('SELECT native_snapshot_hash,status,target FROM plm_snapshot_share_intents WHERE operation_id=$1', [c.operation])
    expect(persisted.rows[0].status).toBe('published')
    expect(persisted.rows[0].target.user_id).toBe(c.actor)
    expect(persisted.rows[0].target.tenant_id).toBe('meta-tenant')
    expect((await pool.query('SELECT count(*)::int n FROM meta_records WHERE sheet_id=$1', [first.data.sheetId])).rows[0].n).toBeGreaterThan(0)
    expect((await pool.query('SELECT count(*)::int n FROM meta_record_revisions WHERE sheet_id=$1', [first.data.sheetId])).rows[0].n).toBeGreaterThan(0)
    const owned = mkdtempSync(path.join(tmpdir(), 'plm-snapshot-replay-'))
    try {
      const config = path.join(owned, 'synthetic.json')
      writeFileSync(config, JSON.stringify({ actor: c.actor, tenant: 'meta-tenant', session: c.session, body: c.req.body, headers: c.headers }), { mode: 0o600 })
      const require = createRequire(path.join(process.cwd(), 'package.json'))
      const child = execFileSync(process.execPath, ['--require', require.resolve('tsx/cjs'),
        'tests/plm-bom-review/snapshot-share-worker.ts', config], { encoding: 'utf8', timeout: 20000 })
      expect(JSON.parse(child.trim().split('\n').at(-1)!).data.id).toBe(first.data.id)
    } finally { rmSync(owned, { recursive: true }) }
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    await expect(down(db)).rejects.toThrow('Cannot discard')
  })
  it('concurrent completion publishes one binding and one set of rows', async () => {
    const c = await prepared()
    const results = await Promise.all([c.run(() => flow.complete(c.req)),c.run(() => flow.complete(c.req))])
    expect(results[0].data.id).toBe(results[1].data.id)
    expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_review_bindings WHERE data_source_id=$1', [c.source])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM meta_records WHERE sheet_id=$1', [results[0].data.sheetId])).rows[0].n).toBe(3)
    expect((await pool.query('SELECT count(*)::int n FROM meta_record_revisions WHERE sheet_id=$1', [results[0].data.sheetId])).rows[0].n).toBe(3)
  })
  it.each(['meta-tenant','meta-org'])('rechecks separate current Meta membership %s after native export', async org => {
    const c = await prepared()
    beforeExport = async () => { await pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [c.actor,org]) }
    try { await expect(c.run(() => flow.complete(c.req))).rejects.toMatchObject({ code: 'PLM_SNAPSHOT_SHARE_MEMBERSHIP_REFUSED' }) }
    finally { beforeExport = null }
    expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_review_bindings WHERE data_source_id=$1', [c.source])).rows[0].n).toBe(0)
  })
  it('refuses target ownership revocation after export and leaves no imported records', async () => {
    const c = await prepared()
    beforeExport = async () => { await pool.query('UPDATE meta_bases SET owner_id=NULL WHERE id=$1', [c.base]) }
    try { await expect(c.run(() => flow.complete(c.req))).rejects.toMatchObject({ code: 'FORBIDDEN' }) }
    finally { beforeExport = null }
    expect((await pool.query('SELECT count(*)::int n FROM meta_sheets WHERE base_id=$1', [c.base])).rows[0].n).toBe(0)
  })
  it('unlink during an in-flight native response cancels the frozen intent and prevents publication', async () => {
    const c = await prepared()
    beforeExport = async () => {
      expect(await unlinkManagedSource({ id: c.actor, authenticatedTenantId: 'meta-tenant' }, { dataSourceId: c.source }))
        .toEqual({ ok: true, state: 'acked' })
    }
    try { await expect(c.run(() => flow.complete(c.req))).rejects.toMatchObject({ code: 'PLM_SNAPSHOT_SHARE_IDENTITY_CHANGED' }) }
    finally { beforeExport = null }
    expect(c.n.cancelled).toBe(true)
    expect((await pool.query('SELECT status FROM plm_snapshot_share_intents WHERE operation_id=$1', [c.operation])).rows[0].status).toBe('cancelled')
    expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_review_bindings WHERE data_source_id=$1', [c.source])).rows[0].n).toBe(0)
  })
  it('retains an already published copy under target ACL after native unlink', async () => {
    const c = await prepared()
    const published = await c.run(() => flow.complete(c.req))
    await unlinkManagedSource({ id: c.actor, authenticatedTenantId: 'meta-tenant' }, { dataSourceId: c.source })
    const reviews = new PlmBomReviewService({ pool: tx, dataSourceManager: { getDataSource() { throw new Error('no source access after unlink') } } })
    const copy = await tx.transaction(({ query }) => reviews.retainedSnapshotOnQuery(query, c.actor, published.data.id))
    expect(copy.id).toBe(published.data.id)
    expect(copy.canRefresh).toBe(false)
    expect((await pool.query('SELECT count(*)::int n FROM meta_records WHERE sheet_id=$1', [copy.sheetId])).rows[0].n).toBeGreaterThan(0)
    await pool.query('UPDATE users SET is_active=false WHERE id=$1', [c.actor])
    await expect(tx.transaction(({ query }) => reviews.retainedSnapshotOnQuery(query, c.actor, copy.id))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('the database rejects retargeting a prepared operation', async () => {
    const c = await prepared()
    await expect(pool.query("UPDATE plm_snapshot_share_intents SET target=jsonb_set(target,'{user_id}','\"other\"') WHERE operation_id=$1", [c.operation]))
      .rejects.toThrow('snapshot share identity is immutable')
    expect((await c.run(() => flow.complete(c.req))).ok).toBe(true)
  })
  it('observes a real membership writer lock before refusing the newly revoked member', async () => {
    const c = await prepared(), holder = await pool.connect()
    let completion: Promise<{ value?: unknown; error?: any }> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query("UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id='meta-org'", [c.actor])
      completion = c.run(() => flow.complete(c.req)).then(value => ({ value }), error => ({ error }))
      const deadline = Date.now() + 5000
      let blocked = false
      while (Date.now() < deadline) {
        blocked = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT org_id FROM user_orgs%' LIMIT 1")).rows.length > 0
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked).toBe(true)
      await holder.query('COMMIT')
      expect((await completion).error).toMatchObject({ code: 'PLM_SNAPSHOT_SHARE_MEMBERSHIP_REFUSED' })
      expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_review_bindings WHERE data_source_id=$1', [c.source])).rows[0].n).toBe(0)
    } finally {
      await holder.query('ROLLBACK'); holder.release()
      if (completion) await completion
    }
  })
  it('does not equate an owned source in another Meta tenant with the current verified tenant', async () => {
    const before = calls.length
    await expect(prepared('other-meta-tenant')).rejects.toMatchObject({ code: 'PLM_SNAPSHOT_SHARE_IDENTITY_CHANGED' })
    expect(calls.length).toBe(before)
  })
  it('rechecks a forced-password transition that occurs during native export', async () => {
    const c = await prepared()
    beforeExport = async () => { await pool.query('UPDATE users SET must_change_password=true WHERE id=$1', [c.actor]) }
    try { await expect(c.run(() => flow.complete(c.req))).rejects.toMatchObject({ code: 'PLM_SNAPSHOT_SHARE_USER_REFUSED' }) }
    finally { beforeExport = null }
  })
  it.each(['PLM_MANAGED_COMPANION_ENABLED','PLM_MANAGED_SNAPSHOT_SHARE_ENABLED'])('stops new publication with %s off while frozen cleanup remains usable', async flag => {
    const c = await prepared()
    beforeExport = async () => { process.env[flag] = 'false' }
    try {
      await expect(c.run(() => flow.complete(c.req))).rejects.toMatchObject({ code: 'PLM_SNAPSHOT_SHARE_DISABLED' })
      expect(await unlinkManagedSource({ id: c.actor, authenticatedTenantId: 'meta-tenant' }, { dataSourceId: c.source })).toEqual({ ok: true, state: 'acked' })
      expect(c.n.cancelled).toBe(true)
    } finally { beforeExport = null; process.env[flag] = 'true' }
  })
  it('rolls back publication if the frozen Meta session expires while existing record writers run', async () => {
    const c = await prepared('meta-tenant', 2)
    await pool.query(`CREATE TABLE plm_snapshot_test_delay(sheet_id text PRIMARY KEY,entered_at timestamptz);
      CREATE FUNCTION plm_snapshot_test_delay() RETURNS trigger AS $$ BEGIN
        IF EXISTS(SELECT 1 FROM plm_snapshot_test_delay WHERE sheet_id=NEW.sheet_id)
           AND current_setting('plm.snapshot_delay',true) IS DISTINCT FROM 'done' THEN
          UPDATE plm_snapshot_test_delay SET entered_at=clock_timestamp() WHERE sheet_id=NEW.sheet_id;
          PERFORM set_config('plm.snapshot_delay','done',true);
          PERFORM pg_sleep(3.5);
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER plm_snapshot_test_delay BEFORE INSERT ON meta_records FOR EACH ROW EXECUTE FUNCTION plm_snapshot_test_delay();`)
    await pool.query('INSERT INTO plm_snapshot_test_delay(sheet_id) VALUES($1)', [c.n.args.target.sheet_id])
    try {
      await expect(c.run(() => flow.complete(c.req))).rejects.toMatchObject({ code: 'PLM_SNAPSHOT_SHARE_EXPIRED' })
      expect((await pool.query('SELECT count(*)::int n FROM meta_plm_bom_review_bindings WHERE data_source_id=$1', [c.source])).rows[0].n).toBe(0)
      expect((await pool.query('SELECT expires_at<clock_timestamp() AS expired FROM plm_managed_sessions WHERE id=$1', [c.session])).rows[0].expired).toBe(true)
    } finally { await pool.query('DROP TRIGGER plm_snapshot_test_delay ON meta_records; DROP FUNCTION plm_snapshot_test_delay(); DROP TABLE plm_snapshot_test_delay') }
  })
})

import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as crypto from '../../src/security/encrypted-secrets'
const require = createRequire(import.meta.url)
const { createPlan, applyPlan, verifyPlan, verifyBackup } = require('../../../../scripts/ops/repairs/dingtalk-group-credentials-20261030.cjs')
const database = `repair_${randomUUID().replace(/-/g, '')}`
const key = randomBytes(32).toString('hex'), salt = randomBytes(32).toString('hex')
let admin: Client, client: Client
let url: string
let original: Array<{ id: string; webhook_url: string; secret: string | null; name: string; enabled: boolean }>
const rows = async () => (await client.query('SELECT * FROM public.dingtalk_group_destinations ORDER BY id')).rows
const encrypted = async () => Number((await client.query("SELECT count(*) AS n FROM public.dingtalk_group_destinations WHERE webhook_url LIKE 'enc:%'")).rows[0].n)
const proxy = (override: (sql: string, params?: unknown[]) => Promise<unknown>) => ({ query: override })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required, never skip')
  admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect()
  await admin.query(`CREATE DATABASE ${database}`)
  const u = new URL(process.env.DATABASE_URL); u.pathname = `/${database}`; url = u.toString()
  client = new Client({ connectionString: url }); await client.connect()
  await client.query('CREATE TABLE public.dingtalk_group_destinations(id text PRIMARY KEY,webhook_url text NOT NULL,secret text,name text,enabled boolean)')
  await client.query('CREATE TABLE public.directory_integrations(id text PRIMARY KEY,config jsonb)')
  await client.query('CREATE TABLE public.attendance_integrations(id text PRIMARY KEY,config jsonb)')
})
afterAll(async () => { await client?.end(); if (admin) { await admin.query(`DROP DATABASE ${database}`); await admin.end() } })
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('ENCRYPTION_KEY', key); vi.stubEnv('ENCRYPTION_SALT', salt)
  await client.query('DELETE FROM public.dingtalk_group_destinations; DELETE FROM public.directory_integrations; DELETE FROM public.attendance_integrations')
  await client.query('INSERT INTO public.directory_integrations VALUES ($1,$2)', ['synthetic-source', JSON.stringify({ appSecret: crypto.encryptStoredSecretValue('synthetic-app-secret'), workNotificationAgentId: crypto.encryptStoredSecretValue('42'), approvalCardLinkSecret: crypto.encryptStoredSecretValue('synthetic-sign') })])
  await client.query('INSERT INTO public.attendance_integrations VALUES ($1,$2)', ['synthetic-attendance', JSON.stringify({ appSecret: crypto.encryptStoredSecretValue('synthetic-attendance-secret') })])
  for (let i = 0; i < 49; i++) await client.query('INSERT INTO public.dingtalk_group_destinations VALUES ($1,$2,$3,$4,$5)', [`synthetic-${String(i).padStart(2, '0')}`, `https://oapi.dingtalk.com/robot/send?access_token=synthetic-${i}${i === 0 ? ' ' : ''}`, i === 48 ? null : `SECsynthetic-${i}${i === 0 ? ' ' : ''}`, `Synthetic ${i}`, i % 2 === 0])
  original = await rows()
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('owner-reviewed 49-row atomic credential repair on real PostgreSQL', () => {
  it('plans in READ ONLY with zero writes and emits only private digests', async () => {
    const sqls: string[] = []
    const c = proxy(async (s, p) => { sqls.push(s); return client.query(s, p) })
    const plan = await createPlan(c, crypto, process.env)
    expect(sqls[0]).toContain('READ ONLY')
    expect(sqls.some(s => /^(UPDATE|INSERT|DELETE)/.test(s))).toBe(false)
    expect(Object.keys(plan).sort()).toEqual(['canaryDigest', 'databaseIdentityDigest', 'scopeDigest', 'version'])
    expect(JSON.stringify(plan)).not.toContain('synthetic-')
    expect(await rows()).toEqual(original)
  })
  it.each(['', 'default-key-change-in-production', 'short'])('rejects invalid material before SQL (%s)', async bad => {
    const query = vi.fn()
    await expect(createPlan({ query }, crypto, { ...process.env, ENCRYPTION_KEY: bad })).rejects.toMatchObject({ code: 'MATERIAL_REJECTED' })
    expect(query).not.toHaveBeenCalled()
  })
  it('rejects a wrong salt against existing application ciphertext before writes', async () => {
    vi.stubEnv('ENCRYPTION_SALT', randomBytes(32).toString('hex'))
    await expect(createPlan(client, crypto, process.env)).rejects.toMatchObject({ code: 'MATERIAL_CANARY_FAILED' })
    expect(await rows()).toEqual(original)
  })
  it('encrypts all 97 fields byte-exactly including trailing whitespace, preserves metadata and repeats with zero writes', async () => {
    const plan = await createPlan(client, crypto, process.env)
    expect(await applyPlan(client, crypto, process.env, plan)).toEqual({ rows: 49, fields: 97, changed: 49, verified: true })
    expect(await encrypted()).toBe(49)
    expect((await rows()).map(r => ({ ...r, webhook_url: crypto.decryptStoredSecretValue(r.webhook_url), secret: r.secret === null ? null : crypto.decryptStoredSecretValue(r.secret) }))).toEqual(original)
    expect(await verifyPlan(client, crypto, process.env, plan)).toEqual({ rows: 49, fields: 97, verified: true })
    const sqls: string[] = []
    expect(await applyPlan(proxy(async (s, p) => { sqls.push(s); return client.query(s, p) }), crypto, process.env, plan)).toMatchObject({ changed: 0, alreadyApplied: true })
    expect(sqls.filter(s => s.startsWith('UPDATE'))).toHaveLength(0)
  })
  it('rejects a different database identity before writes', async () => {
    const plan = await createPlan(client, crypto, process.env)
    await expect(applyPlan(client, crypto, process.env, { ...plan, databaseIdentityDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'TARGET_DATABASE_CHANGED' })
    expect(await rows()).toEqual(original)
  })
  it('validates backup rows from the restored data and rejects a self-reported plan with wrong contents', async () => {
    const plan = await createPlan(client, crypto, process.env)
    expect(await verifyBackup(client, plan)).toEqual({ rows: 49, fields: 97, backupMatchesPlan: true })
    await client.query("UPDATE public.dingtalk_group_destinations SET secret='SECother' WHERE id='synthetic-00'")
    await expect(verifyBackup(client, plan)).rejects.toMatchObject({ code: 'BACKUP_DATA_MISMATCH' })
  })
  it('rejects changed contents even when row and field counts match', async () => {
    const plan = await createPlan(client, crypto, process.env)
    await client.query('UPDATE public.dingtalk_group_destinations SET secret=$2 WHERE id=$1', ['synthetic-00', 'SECchanged'])
    const changed = await rows()
    await expect(applyPlan(client, crypto, process.env, plan)).rejects.toMatchObject({ code: 'SCOPE_CHANGED' })
    expect(await rows()).toEqual(changed)
    expect(await encrypted()).toBe(0)
  })
  it('rejects an inserted row and leaves every existing field unchanged', async () => {
    const plan = await createPlan(client, crypto, process.env)
    await client.query("INSERT INTO public.dingtalk_group_destinations VALUES ('extra','https://example.invalid','SECextra','Extra',false)")
    const changed = await rows()
    await expect(applyPlan(client, crypto, process.env, plan)).rejects.toMatchObject({ code: 'SCOPE_CHANGED' })
    expect(await rows()).toEqual(changed)
  })
  it('rejects a changed independent canary rather than silently replanning', async () => {
    const plan = await createPlan(client, crypto, process.env)
    await client.query('UPDATE public.attendance_integrations SET config=$1', [JSON.stringify({ appSecret: crypto.encryptStoredSecretValue('synthetic-new-canary') })])
    await expect(applyPlan(client, crypto, process.env, plan)).rejects.toMatchObject({ code: 'CANARY_CHANGED' })
    expect(await rows()).toEqual(original)
  })
  it('rolls back earlier rows after a fault on the 25th update and redacts the underlying message', async () => {
    const plan = await createPlan(client, crypto, process.env); let n = 0
    const c = proxy(async (s, p) => { if (s.startsWith('UPDATE') && ++n === 25) throw new Error('SECRET_CANARY_DO_NOT_EMIT'); return client.query(s, p) })
    const error = await applyPlan(c, crypto, process.env, plan).catch((e: unknown) => e)
    expect(error).toMatchObject({ message: 'DATABASE_OPERATION_FAILED' })
    expect(String(error)).not.toContain('SECRET_CANARY')
    expect(await rows()).toEqual(original)
  })
  it('rolls back all rows when decrypted readback does not match the original digest', async () => {
    const plan = await createPlan(client, crypto, process.env); let n = 0
    const bad = { ...crypto, decryptStoredSecretValue: (s: string) => ++n > 8 ? 'synthetic-corrupt-read' : crypto.decryptStoredSecretValue(s) }
    await expect(applyPlan(client, bad, process.env, plan)).rejects.toMatchObject({ code: 'READBACK_MISMATCH' })
    expect(await rows()).toEqual(original)
  })
  it('refuses a custom trigger before any target row update', async () => {
    const plan = await createPlan(client, crypto, process.env)
    await client.query('CREATE FUNCTION public.repair_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$')
    await client.query('CREATE TRIGGER repair_test BEFORE UPDATE ON public.dingtalk_group_destinations FOR EACH ROW EXECUTE FUNCTION public.repair_test_trigger()')
    try {
      await expect(applyPlan(client, crypto, process.env, plan)).rejects.toMatchObject({ code: 'CUSTOM_TRIGGER_REJECTED' })
      expect(await rows()).toEqual(original)
    } finally { await client.query('DROP TRIGGER repair_test ON public.dingtalk_group_destinations; DROP FUNCTION public.repair_test_trigger()') }
  })
  it('holds a real table lock that blocks a second writer until commit', async () => {
    const plan = await createPlan(client, crypto, process.env); const locked = deferred(), release = deferred()
    const other = new Client({ connectionString: url }); await other.connect()
    const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const c = proxy(async (s, p) => { const r = await client.query(s, p); if (s.startsWith('LOCK TABLE')) { locked.resolve(); await release.promise } return r })
    const apply = applyPlan(c, crypto, process.env, plan); apply.catch(() => {})
    let edit: Promise<unknown> | undefined
    try {
      await locked.promise
      edit = other.query("UPDATE public.dingtalk_group_destinations SET name='Concurrent name' WHERE id='synthetic-00'"); edit.catch(() => {})
      let blocked = false
      for (let i = 0; i < 100; i++) {
        blocked = (await admin.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(r => setTimeout(r, 10))
      }
      expect(blocked).toBe(true)
    } finally { release.resolve(); await apply; await edit; await other.end() }
    expect(await verifyPlan(client, crypto, process.env, plan)).toMatchObject({ verified: true })
    expect((await rows())[0].name).toBe('Concurrent name')
  })
  it('reports an ambiguous successful COMMIT without retrying, then verifies and replays without writes', async () => {
    const plan = await createPlan(client, crypto, process.env)
    const c = proxy(async (s, p) => { const r = await client.query(s, p); if (s === 'COMMIT') throw new Error('synthetic lost commit acknowledgement'); return r })
    await expect(applyPlan(c, crypto, process.env, plan)).rejects.toMatchObject({ code: 'COMMIT_OUTCOME_UNKNOWN_VERIFY_REQUIRED' })
    expect(await verifyPlan(client, crypto, process.env, plan)).toMatchObject({ verified: true })
    expect(await applyPlan(client, crypto, process.env, plan)).toMatchObject({ changed: 0, alreadyApplied: true })
  })
  it('does not count a partially encrypted state as successful verification or repair', async () => {
    const plan = await createPlan(client, crypto, process.env)
    await client.query('UPDATE public.dingtalk_group_destinations SET webhook_url=$2 WHERE id=$1', ['synthetic-00', crypto.encryptStoredSecretValue(original[0].webhook_url)])
    const before = await rows()
    await expect(verifyPlan(client, crypto, process.env, plan)).rejects.toMatchObject({ code: 'NOT_FULLY_ENCRYPTED' })
    await expect(applyPlan(client, crypto, process.env, plan)).rejects.toMatchObject({ code: 'SCOPE_CHANGED' })
    expect(await rows()).toEqual(before)
  })
})

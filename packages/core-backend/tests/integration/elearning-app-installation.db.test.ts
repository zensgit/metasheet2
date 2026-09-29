import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import express, { type RequestHandler } from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ensureCanonicalUserOrgsTable } from '../../src/db/migrations/_ensure-user-orgs'
import { up as installRegistry } from '../../src/db/migrations/zzzz20260413130000_create_platform_app_instances'
import { up as installJobs } from '../../src/db/migrations/zzzz20260826160000_create_elearning_jobs'
import {
  createElearningAppInstallationRouter,
  requireElearningAppInstallation,
  requireElearningEnabled,
} from '../../src/routes/elearning-app-installation'
import { changeElearningAppInstallation, readElearningAppInstallation } from '../../src/services/elearning-app-installation'
import type { ElearningAdminAccessDb, ElearningAdminAccessQueryable } from '../../src/services/elearning-admin-access'
import { dropScratchDatabase } from '../helpers/scratch-database'
import { usePinnedServer } from '../utils/pinned-server'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('installation gate requires DATABASE_URL; refusing skip-shaped green')
const admin = new Pool({ connectionString: DATABASE_URL, max: 1 })
const name = `elearning_app_${randomUUID().replaceAll('-', '')}`
let pool: Pool
let schema: Kysely<unknown>
let created = false
const require = createRequire(import.meta.url)
const { CLAIM_SQL } = require('../../../../plugins/plugin-elearning/lib/jobs.cjs') as { CLAIM_SQL: string }

function database(afterMembership?: () => Promise<void>): ElearningAdminAccessDb {
  return {
    query: (text, args) => pool.query(text, args),
    transaction: async (handler) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const tx: ElearningAdminAccessQueryable = {
          query: async (text, args) => {
            const result = await client.query(text, args)
            if (text.includes('FROM user_orgs') && afterMembership) await afterMembership()
            return result
          },
        }
        const result = await handler(tx)
        await client.query('COMMIT')
        return result
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    },
  }
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`)
  created = true
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  pool = new Pool({ connectionString: url.toString(), max: 6 })
  schema = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await ensureCanonicalUserOrgsTable(schema)
  await installRegistry(schema)
  await installRegistry(schema)
  await installJobs(schema)
}, 30_000)

afterAll(async () => {
  if (schema) await schema.destroy()
  else if (pool) await pool.end()
  try {
    if (created) {
      const outcome = await dropScratchDatabase(admin, name)
      expect(outcome.forced).toBe(false)
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([])
      expect((await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname = $1', [name])).rows).toEqual([])
    }
  } finally { await admin.end() }
}, 30_000)

async function actor(orgId: string) {
  await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', ['admin', orgId])
  return { orgId, actorId: 'admin', isGlobalAdmin: true }
}

test('canonical registry: default absent, concurrent install, explicit enable and retained disable', async () => {
  const input = await actor('install')
  const db = database()
  expect(await readElearningAppInstallation(db, input.orgId)).toEqual({ status: 'not-installed', notificationsEnabled: false })
  expect(await Promise.all([changeElearningAppInstallation(db, input), changeElearningAppInstallation(db, input)]))
    .toEqual(Array(2).fill({ status: 'inactive', notificationsEnabled: false }))
  await changeElearningAppInstallation(db, input, { enabled: true, notificationsEnabled: true })
  expect(await changeElearningAppInstallation(db, input)).toEqual({ status: 'active', notificationsEnabled: true })
  expect(await changeElearningAppInstallation(db, input, { enabled: false, notificationsEnabled: true }))
    .toEqual({ status: 'inactive', notificationsEnabled: false })
  expect((await pool.query('SELECT count(*)::int n FROM platform_app_instances WHERE workspace_id=$1', [input.orgId])).rows).toEqual([{ n: 1 }])
})

test('foreign tenant collision is not adopted or overwritten', async () => {
  const input = await actor('collision')
  await pool.query(`INSERT INTO platform_app_instances
    (tenant_id,workspace_id,app_id,plugin_id,project_id,status,config_json)
    VALUES ('foreign','collision','elearning','plugin-elearning','foreign','active','{"notificationsEnabled":true}')`)
  await expect(changeElearningAppInstallation(database(), input)).rejects.toMatchObject({ code: 'unavailable' })
  expect((await pool.query("SELECT tenant_id FROM platform_app_instances WHERE workspace_id='collision'")).rows).toEqual([{ tenant_id: 'foreign' }])
})

test('worker admission excludes inactive/missing orgs before claiming; notification opt-in is independent', async () => {
  const input = await actor('worker')
  await changeElearningAppInstallation(database(), input)
  await pool.query(`INSERT INTO elearning_jobs(org_id,kind,occurrence_key,ref,payload,due_at)
    VALUES ('worker','assignment_reminder','a','a','{}',now()),
      ('worker','exam_attempt_expiry','b','b','{}',now()),
      ('missing','exam_attempt_expiry','c','c','{}',now())`)
  const args = [['assignment_reminder', 'exam_attempt_expiry'], 16, 60_000, 'test-worker', 8]
  expect((await pool.query(CLAIM_SQL, args)).rows).toEqual([])
  await changeElearningAppInstallation(database(), input, { enabled: true, notificationsEnabled: false })
  const claimed = await pool.query(CLAIM_SQL, args)
  expect(claimed.rows.map((row) => row.kind)).toEqual(['exam_attempt_expiry'])
  await changeElearningAppInstallation(database(), input, { enabled: true, notificationsEnabled: true })
  expect((await pool.query(CLAIM_SQL, args)).rows.map((row) => row.kind)).toEqual(['assignment_reminder'])
})

test('membership revocation waits for admitted installation transaction (not merely KEY SHARE)', async () => {
  const input = await actor('membership')
  let release!: () => void
  let admitted!: () => void
  const admission = new Promise<void>((resolve) => { admitted = resolve })
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const install = changeElearningAppInstallation(database(async () => { admitted(); await barrier }), input)
  await admission
  const revoke = await pool.connect()
  const pid = (await revoke.query('SELECT pg_backend_pid() pid')).rows[0].pid
  const update = revoke.query("UPDATE user_orgs SET is_active=false WHERE org_id='membership'")
  try {
    let blocked = false
    for (let i = 0; i < 100; i++) {
      blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 blocked', [pid])).rows[0].blocked
      if (blocked) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(blocked).toBe(true)
  } finally { release(); await install; await update; revoke.release() }
  await expect(changeElearningAppInstallation(database(), input)).rejects.toMatchObject({ code: 'forbidden' })
})

const pinned = usePinnedServer()

/** The production installation surface over the real table; only authentication is injected. */
function installationSurface(env: NodeJS.ProcessEnv, orgId: string) {
  const auth: RequestHandler = (req, res, next) => {
    if (!req.headers.authorization) { res.status(401).json({ error: 'unauthenticated' }); return }
    req.user = { id: 'admin', role: 'admin' } as typeof req.user
    req.authenticatedTenantId = orgId
    next()
  }
  const app = express()
  app.use(createElearningAppInstallationRouter({ getDb: () => database(), authenticate: auth, featureGate: requireElearningEnabled({ env }) }))
  const business: RequestHandler = (_req, res) => { res.json({ ok: true }) }
  app.use('/api/elearning', auth, requireElearningAppInstallation({ getDb: () => database(), env }), business)
  return app
}

async function snapshotRow(orgId: string) {
  // xmin changes on ANY update of the row, even one that rewrites identical values.
  return (await pool.query(`SELECT xmin::text AS xmin, status, config_json, metadata_json, updated_at
    FROM platform_app_instances WHERE workspace_id = $1 ORDER BY id`, [orgId])).rows
}

test('switch off: an existing ACTIVE installation is neither rewritten nor reachable; switch on: it is active again without a write', async () => {
  const input = await actor('switched-off')
  const PATH = '/api/elearning-app/installation'
  await changeElearningAppInstallation(database(), input)
  await changeElearningAppInstallation(database(), input, { enabled: true, notificationsEnabled: true })
  const before = await snapshotRow(input.orgId)
  expect(before).toHaveLength(1)
  expect(before[0]).toMatchObject({ status: 'active', config_json: { notificationsEnabled: true } })

  pinned.setApp(installationSurface({}, input.orgId))
  const refused = { error: 'feature_disabled' }
  // Soft, so that the row comparison below is evaluated even when an answer is wrong.
  const post = await request(pinned.url()).post(PATH).set('Authorization', 'admin').send({})
  expect.soft([post.status, post.body]).toEqual([404, refused])
  for (const body of [
    { enabled: false, notificationsEnabled: false },
    { enabled: true, notificationsEnabled: false },
  ]) {
    const put = await request(pinned.url()).put(PATH).set('Authorization', 'admin').send(body)
    expect.soft([put.status, put.body]).toEqual([404, refused])
  }
  const get = await request(pinned.url()).get(PATH).set('Authorization', 'admin')
  expect.soft([get.status, get.body]).toEqual([404, refused])
  const business = await request(pinned.url()).get('/api/elearning/me/courses').set('Authorization', 'admin')
  expect.soft([business.status, business.body]).toEqual([404, refused])
  expect(await snapshotRow(input.orgId)).toEqual(before)

  pinned.setApp(installationSurface({ ELEARNING_ENABLED: 'true' }, input.orgId))
  expect((await request(pinned.url()).get(PATH).set('Authorization', 'admin')).body)
    .toEqual({ status: 'active', notificationsEnabled: true, canManage: true })
  expect((await request(pinned.url()).get('/api/elearning/me/courses').set('Authorization', 'admin')).body)
    .toEqual({ ok: true })
  expect(await snapshotRow(input.orgId)).toEqual(before)
})

/** Fresh Meta process against only the restored DB, using production routes and cleanup. */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeSync } from 'node:fs'
import assert from 'node:assert/strict'

const input = JSON.parse(await readFile('/dev/stdin', 'utf8'))
assert(input.pgUrl.includes('/plm_snapshot_restored?host=/tmp/plm-managed-paired-'))
const root = input.metaCheckout + '/packages/core-backend'
const require = createRequire(root + '/package.json')
const registration = { issuer: input.issuer, clientId: 'managed-fixture', clientSecret: input.secret,
  callback: input.callback, origin: input.origin, nativeTenantId: 'default', nativeOrgId: 'fixture-org', nativeBaseUrl: input.nativeOrigin }
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: input.pgUrl, JWT_SECRET: 'paired-managed-secret-abcdefghijklmnopqrstuvwxyz',
  ENCRYPTION_KEY: 'paired-managed-synthetic-key', ENCRYPTION_SALT: 'paired-managed-synthetic-salt',
  RBAC_TOKEN_TRUST: 'true', LOG_LEVEL: 'error', PLM_MANAGED_COMPANION_ENABLED: 'false',
  PLM_MANAGED_SNAPSHOT_SHARE_ENABLED: 'false', PLM_PERSONAL_BOM_WRITE_ENABLED: 'false',
  PLM_APPROVAL_CARD_ENABLED: 'false', PLM_BOM_REVIEW_ENABLED: 'false',
  PLM_API_TOKEN: 'shared-must-not-be-used', PLM_BASE_URL: 'http://127.0.0.1:9',
  PLM_MANAGED_COMPANION_CLIENTS_JSON: JSON.stringify([registration]),
})
const express = require('express'), jwt = require('jsonwebtoken')
const { Pool } = require('pg'), { Kysely, PostgresDialect } = require('kysely')
const pool = new Pool({ connectionString: input.pgUrl, max: 4 })
const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
const ds = await import(root + '/src/routes/data-sources.ts')
await ds.initializeDataSourceManager(db)
const { jwtAuthMiddleware } = await import(root + '/src/auth/jwt-middleware.ts')
const { isGateException } = await import(root + '/src/auth/api-path-policy.ts')
const managed = (await import(root + '/src/routes/plm-managed-companion.ts')).default
const { createPlmBomReviewsRouter } = await import(root + '/src/routes/plm-bom-reviews.ts')
const { univerMetaRouter } = await import(root + '/src/routes/univer-meta.ts')
const { poolManager } = await import(root + '/src/integration/db/connection-pool.ts')
const { drainSnapshotShareCancellation } = await import(root + '/src/services/plm-managed-snapshot-share-flow.ts')
const app = express()
app.use(express.json())
app.use((req, res, next) => isGateException(req.path) ? next() : jwtAuthMiddleware(req, res, next))
app.use('/api/plm/managed-login', managed)
app.use('/api/plm-bom-reviews', createPlmBomReviewsRouter({ pool: poolManager.get(), dataSourceManager: ds.getDataSourceManager() }))
app.use('/api/multitable', univerMetaRouter())
const server = await new Promise<import('node:http').Server>(resolve => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
let passed = false
try {
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const token = (userId: string, perms: string[]) => jwt.sign({ userId, role: 'user', roles: ['user'], perms, tenantId: 'meta-org' }, process.env.JWT_SECRET, { expiresIn: '5m' })
  const headers = { Authorization: 'Bearer ' + token('meta-owner', ['multitable:read']) }
  const binding = (await pool.query(`SELECT b.* FROM meta_plm_bom_review_bindings b JOIN plm_snapshot_share_intents i ON i.binding_id=b.id WHERE i.status='published'`)).rows
  assert.equal(binding.length, 1)
  const exportUrl = base + '/api/multitable/sheets/' + binding[0].sheet_id + '/export-xlsx?format=csv&viewId=' + binding[0].view_id
  const exported = await fetch(exportUrl, { headers })
  assert.equal(exported.status, 200, await exported.clone().text())
  assert((await exported.text()).includes('C-001'))
  const outsider = await fetch(exportUrl, { headers: { Authorization: 'Bearer ' + token('target-outsider', ['attendance:read']) } })
  assert.equal(outsider.status, 403)
  const refused = await fetch(base + '/api/plm-bom-reviews/managed-share/targets?dataSourceId=source-1&partId=' + encodeURIComponent(input.rootPartId), { headers })
  assert([401,403,404].includes(refused.status), await refused.text())
  const waiting = (await pool.query("SELECT id,native_intent_id FROM plm_snapshot_share_intents WHERE status='cancel_pending'")).rows
  assert.equal(waiting.length, 1)
  const id = waiting[0].id
  const frozen = async () => (await pool.query("SELECT (to_jsonb(i)-ARRAY['status','cancelled_at'])::text AS identity FROM plm_snapshot_share_intents i WHERE id=$1", [id])).rows[0].identity
  const before = await frozen()
  const recordsBefore = (await pool.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM meta_records r')).rows[0].rows
  process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([{ ...registration, clientSecret: 'wrong-no-fallback' }])
  assert.equal(await drainSnapshotShareCancellation(id), false)
  assert.equal(await frozen(), before)
  process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([registration])
  assert.equal(await drainSnapshotShareCancellation(id), true)
  const first = (await pool.query('SELECT status,cancelled_at FROM plm_snapshot_share_intents WHERE id=$1', [id])).rows[0]
  assert.equal(first.status, 'cancelled')
  assert.equal(await drainSnapshotShareCancellation(id), true)
  assert.deepEqual((await pool.query('SELECT status,cancelled_at FROM plm_snapshot_share_intents WHERE id=$1', [id])).rows[0], first)
  assert.equal(await frozen(), before)
  const revoke = await fetch(base + '/api/plm/managed-login/revoke-retry', { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ dataSourceId: 'source-1' }) })
  assert.equal(revoke.status, 200, await revoke.clone().text())
  assert.equal((await revoke.json() as { state: string }).state, 'acked')
  assert.deepEqual((await pool.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM meta_records r')).rows[0].rows, recordsBefore)
  const retained = await fetch(exportUrl, { headers })
  assert.equal(retained.status, 200)
  assert((await retained.text()).includes('C-001'))
  writeSync(1, 'SNAPSHOT_RESTORE_PROOF ' + JSON.stringify({ ok: true, fresh_meta_process: true,
    pending_native_intent_id: waiting[0].native_intent_id, retained_target_export: true, outsider_forbidden: true,
    new_share_refused: true, flags_disabled: true, changed_registration_refused: true,
    frozen_identity_sha256: createHash('sha256').update(before).digest('hex'),
    original_cancellation_acked: true, duplicate_idempotent: true, managed_revoke_acked: true,
    published_records_unchanged: true }) + '\n')
  passed = true
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await pool.end()
}
process.exit(passed ? 0 : 1)

'use strict'
// One-shot candidate for the reviewed 49-row/97-field scope. No provider calls or key changes.
const { createHash } = require('node:crypto')
class RepairError extends Error {
  constructor(code) { super(code); this.name = 'RepairError'; this.code = code }
}
const fail = code => { throw new RepairError(code) }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonical = rows => rows.map(r => [r.id, r.webhook_url, r.secret]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
const readRows = async client => (await client.query('SELECT id, webhook_url, secret FROM public.dingtalk_group_destinations ORDER BY id')).rows
const databaseIdentity = async client => digest((await client.query('SELECT current_database() AS database, pg_postmaster_start_time()::text AS server_started')).rows[0])
const nonempty = value => typeof value === 'string' && value.length > 0
function material(env) {
  for (const [key, fallback] of [['ENCRYPTION_KEY', 'default-key-change-in-production'], ['ENCRYPTION_SALT', 'default-salt-change-in-production']]) {
    const value = env[key]
    if (typeof value !== 'string' || value.trim().length < 32 || value.trim() === fallback) fail('MATERIAL_REJECTED')
  }
  if (env.NODE_ENV !== 'production') fail('RUNTIME_MODE_REJECTED')
}
function counts(rows) {
  if (rows.length !== 49 || rows.some(r => typeof r.id !== 'string' || !nonempty(r.webhook_url) || (r.secret !== null && typeof r.secret !== 'string'))) fail('SCOPE_CHANGED')
  const values = rows.flatMap(r => [r.webhook_url, ...(nonempty(r.secret) ? [r.secret] : [])])
  if (values.length !== 97) fail('SCOPE_CHANGED')
  return { fields: values.length, encrypted: values.filter(v => v.startsWith('enc:')).length }
}
async function canaries(client, crypto) {
  // Independent application-written ciphertext; a freshly encrypted sentinel is insufficient.
  const { rows } = await client.query(`SELECT value FROM (
    SELECT config->>'appSecret' AS value FROM public.directory_integrations
    UNION ALL SELECT config->>'workNotificationAgentId' FROM public.directory_integrations
    UNION ALL SELECT config->>'agentId' FROM public.directory_integrations
    UNION ALL SELECT config->>'approvalCardLinkSecret' FROM public.directory_integrations
    UNION ALL SELECT config->>'appSecret' FROM public.attendance_integrations
    UNION ALL SELECT config->>'appsecret' FROM public.attendance_integrations
    UNION ALL SELECT config->>'app_secret' FROM public.attendance_integrations
  ) AS c WHERE btrim(value) LIKE 'enc:%'`)
  if (rows.length !== 4) fail('CANARY_SCOPE_CHANGED')
  const values = rows.map(r => r.value.trim()).sort()
  try { for (const value of values) crypto.decryptStoredSecretValue(value) }
  catch { fail('MATERIAL_CANARY_FAILED') }
  return digest(values)
}
async function transaction(client, write, operation) {
  let commitAttempted = false
  await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '30s'")
    if (write) await client.query('LOCK TABLE public.dingtalk_group_destinations IN SHARE ROW EXCLUSIVE MODE')
    const trigger = await client.query(`SELECT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'public.dingtalk_group_destinations'::regclass AND NOT tgisinternal) AS present`)
    if (trigger.rows[0]?.present !== false) fail('CUSTOM_TRIGGER_REJECTED')
    const value = await operation()
    commitAttempted = true
    await client.query('COMMIT')
    return value
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    if (commitAttempted && write) fail('COMMIT_OUTCOME_UNKNOWN_VERIFY_REQUIRED')
    if (error instanceof RepairError) throw error
    fail('DATABASE_OPERATION_FAILED')
  }
}
function checkPlan(plan) {
  if (!plan || plan.version !== 1 || !/^[a-f0-9]{64}$/.test(plan.scopeDigest) || !/^[a-f0-9]{64}$/.test(plan.canaryDigest) || !/^[a-f0-9]{64}$/.test(plan.databaseIdentityDigest)) fail('PLAN_INVALID')
}
function decoded(rows, crypto) {
  try {
    return rows.map(r => ({ ...r, webhook_url: crypto.decryptStoredSecretValue(r.webhook_url), secret: nonempty(r.secret) ? crypto.decryptStoredSecretValue(r.secret) : r.secret }))
  } catch { fail('READBACK_FAILED') }
}
async function createPlan(client, crypto, env) {
  material(env)
  return transaction(client, false, async () => {
    const rows = await readRows(client)
    if (counts(rows).encrypted !== 0) fail('EXPECTED_PLAINTEXT_SCOPE_CHANGED')
    return { version: 1, scopeDigest: digest(canonical(rows)), canaryDigest: await canaries(client, crypto), databaseIdentityDigest: await databaseIdentity(client) }
  })
}
async function verifyInside(client, crypto, plan) {
  if (await databaseIdentity(client) !== plan.databaseIdentityDigest) fail('TARGET_DATABASE_CHANGED')
  if (await canaries(client, crypto) !== plan.canaryDigest) fail('CANARY_CHANGED')
  const rows = await readRows(client)
  if (counts(rows).encrypted !== 97) fail('NOT_FULLY_ENCRYPTED')
  if (digest(canonical(decoded(rows, crypto))) !== plan.scopeDigest) fail('READBACK_MISMATCH')
  return { rows: 49, fields: 97, verified: true }
}
async function verifyPlan(client, crypto, env, plan) {
  material(env); checkPlan(plan)
  return transaction(client, false, () => verifyInside(client, crypto, plan))
}
async function applyPlan(client, crypto, env, plan) {
  material(env); checkPlan(plan)
  return transaction(client, true, async () => {
    if (await databaseIdentity(client) !== plan.databaseIdentityDigest) fail('TARGET_DATABASE_CHANGED')
    if (await canaries(client, crypto) !== plan.canaryDigest) fail('CANARY_CHANGED')
    const rows = await readRows(client)
    const state = counts(rows)
    if (state.encrypted === 97) {
      await verifyInside(client, crypto, plan)
      return { rows: 49, fields: 97, changed: 0, alreadyApplied: true }
    }
    if (state.encrypted !== 0 || digest(canonical(rows)) !== plan.scopeDigest) fail('SCOPE_CHANGED')
    for (const row of rows) {
      // Encrypt raw bytes. Normalization/trimming would silently change legacy credentials.
      const webhook = crypto.encryptStoredSecretValue(row.webhook_url)
      const secret = nonempty(row.secret) ? crypto.encryptStoredSecretValue(row.secret) : row.secret
      const updated = await client.query(`UPDATE public.dingtalk_group_destinations SET webhook_url=$2, secret=$3
        WHERE id=$1 AND webhook_url=$4 AND secret IS NOT DISTINCT FROM $5 RETURNING id`,
      [row.id, webhook, secret, row.webhook_url, row.secret])
      if (updated.rows.length !== 1) fail('ROW_CHANGED')
    }
    await verifyInside(client, crypto, plan)
    return { rows: 49, fields: 97, changed: 49, verified: true }
  })
}
async function verifyBackup(client, plan) {
  checkPlan(plan)
  return transaction(client, false, async () => {
    const rows = await readRows(client)
    if (counts(rows).encrypted !== 0 || digest(canonical(rows)) !== plan.scopeDigest) fail('BACKUP_DATA_MISMATCH')
    return { rows: 49, fields: 97, backupMatchesPlan: true }
  })
}
module.exports = { createPlan, applyPlan, verifyPlan, verifyBackup, RepairError }

'use strict'

const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { createDb } = require('./db.cjs')
const { PROJECT_OVERVIEW_LOCK_PREFIX } = require('./stock-preparation-project-target-store.cjs')
const { lockProjectActivity, projectBusy } = require('./stock-preparation-project-delete-activity.cjs')
const { planSheets, deleteSheets, existsProjectRoot, SHEET_LOCK_TABLES } = require('./stock-preparation-project-delete-sheets.cjs')
const { planBusiness, deleteBusiness, BUSINESS_LOCK_TABLES } = require('./stock-preparation-project-delete-business.cjs')
const { planRuntime, deleteRuntime } = require('./stock-preparation-project-delete-runtime.cjs')

const CHALLENGES = 'integration_stock_prep_project_delete_challenges'
const TTL_SECONDS = 300
const TRANSACTION_BUDGET_MS = 30000
const ERRORS = Object.freeze({
  invalid: [422, 'STOCK_PREPARATION_PROJECT_DELETE_INVALID'],
  absent: [404, 'STOCK_PREPARATION_PROJECT_ABSENT'],
  stale: [409, 'STOCK_PREPARATION_PROJECT_DELETE_STALE'],
  challenge: [409, 'STOCK_PREPARATION_PROJECT_DELETE_CHALLENGE_INVALID'],
  failed: [500, 'STOCK_PREPARATION_PROJECT_DELETE_FAILED'],
  unavailable: [503, 'STOCK_PREPARATION_PROJECT_DELETE_UNAVAILABLE'],
})

function refusal(kind) {
  const [status, code] = ERRORS[kind]
  return Object.assign(new Error(code), { status, code })
}

function digest(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function requireScope({ tenantId, projectNo, actor, boundTarget } = {}) {
  for (const value of [tenantId, projectNo, actor]) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\u0000')) throw refusal('invalid')
  }
  return { tenantId, projectNo, actor, boundTarget }
}

// Statements from all three planners run on this single client. The host returns arrays directly,
// pg returns { rows }. Reject an unexpected result shape rather than treating it as an empty table.
function transactionHandle(client, deadline) {
  return {
    async query(sql, values = []) {
      if (performance.now() >= deadline) throw projectBusy()
      const result = await client.query(sql, values)
      const rows = Array.isArray(result) ? result : result?.rows
      if (!Array.isArray(rows)) throw refusal('failed')
      return rows
    },
  }
}

async function lockData(tx, scope) {
  await lockProjectActivity(tx, scope, false)
  const [overview] = await tx.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [PROJECT_OVERVIEW_LOCK_PREFIX + scope.tenantId])
  if (overview?.locked !== true) throw projectBusy()
  // Writers through the ordinary grid or older plugin entry points do not acquire our advisory
  // lock. Prevent writes, including phantoms in initially empty tables, for the check/delete window.
  // EXCLUSIVE admits ordinary reads but also refuses locking reads (FOR UPDATE/SHARE) that have
  // not issued their first DML yet. NOWAIT never queues behind an active writer. All names are static.
  const tables = [...new Set([...SHEET_LOCK_TABLES, ...BUSINESS_LOCK_TABLES, 'plugin_kv'])].sort()
  if (!tables.every(t => /^[a-z][a-z0-9_]*$/.test(t))) throw refusal('failed')
  await tx.query(`LOCK TABLE ${tables.map(t => `"${t}"`).join(', ')} IN EXCLUSIVE MODE NOWAIT`)
}

async function planProject(tx, scope) {
  const sheets = await planSheets(tx, scope)
  const business = await planBusiness(tx, scope, sheets)
  if (!sheets.identityPresent && !business.identityPresent) return null
  const runtime = await planRuntime(tx, scope, sheets)
  const counts = {}
  for (const plan of [sheets, business, runtime]) {
    if (typeof plan.fingerprint !== 'string' || !plan.fingerprint) throw refusal('failed')
    for (const [key, count] of Object.entries(plan.counts)) {
      if (Object.hasOwn(counts, key) || !Number.isSafeInteger(count) || count < 0) throw refusal('failed')
      counts[key] = count
    }
  }
  return {
    sheets, business, runtime, counts,
    fingerprint: digest([scope.tenantId, scope.projectNo, sheets.fingerprint, business.fingerprint, runtime.fingerprint]),
    tables: [...sheets.tables, ...(business.tables || [])].map(({ sheetId, name, kind, rowCount }) => ({ sheetId, name, kind, rowCount })),
  }
}

function mapError(error) {
  if (['42501', '42P01', '42703'].includes(error?.code)) return refusal('unavailable')
  if (error?.code === 'STOCK_PREPARATION_PROJECT_DELETE_DEPENDENCY') {
    const reason = error.details?.reason
    if (!['external_binding', 'attachment', 'recovery', 'independent_workflow'].includes(reason)) return refusal('failed')
    return Object.assign(new Error(error.code), { status: 409, code: error.code, details: { reason } })
  }
  if (['55P03', '40P01', '40001', '57014'].includes(error?.code)) return projectBusy()
  if (error?.code === 'FORBIDDEN' && error.status === 403) return Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN', status: 403 })
  if (['STOCK_PREPARATION_PROJECT_DELETE_BUSY', 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS'].includes(error?.code)) {
    return Object.assign(new Error(error.code), { status: 409, code: error.code })
  }
  const kind = Object.keys(ERRORS).find(key => ERRORS[key][1] === error?.code && ERRORS[key][0] === error.status)
  if (kind) return refusal(kind)
  return refusal('failed')
}

function createStockPreparationProjectDelete({ database, auditStore, authorizeWithin } = {}) {
  if (!database?.transaction || !auditStore?.appendWithin || typeof authorizeWithin !== 'function') throw refusal('failed')

  async function transact(scope, operation) {
    try {
      const deadline = performance.now() + TRANSACTION_BUDGET_MS
      return await database.transaction(async (client) => {
        const tx = transactionHandle(client, deadline)
        // READ COMMITTED sees every writer that committed before we acquired the table locks, even
        // when this database normally uses a transaction-wide snapshot.
        await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await tx.query("SET LOCAL lock_timeout = '500ms'")
        await tx.query("SET LOCAL statement_timeout = '15s'")
        // PostgreSQL errors if a policy would filter any query with this setting. A restricted
        // host role must never undercount hidden records before a potentially cascading delete.
        await tx.query('SET LOCAL row_security = off')
        await authorizeWithin(tx, scope)
        const answer = await operation(tx)
        if (performance.now() >= deadline) throw projectBusy()
        return answer
      })
    } catch (error) { throw mapError(error) }
  }

  async function preview(input) {
    const scope = requireScope(input)
    const { tenantId, projectNo, actor } = scope
    return transact(scope, async (tx) => {
      await lockData(tx, scope)
      const plan = await planProject(tx, scope)
      if (!plan) throw refusal('absent')
      const challengeId = randomUUID()
      const verificationCode = randomBytes(4).toString('hex').toUpperCase()
      // A newer preview supersedes this actor's previous code for this project. Expiry and issue
      // time both use the DB clock, regardless of which app instance handles confirmation.
      await tx.query(`DELETE FROM ${CHALLENGES} WHERE id IN (SELECT id FROM ${CHALLENGES}
        WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`)
      const [row] = await tx.query(`INSERT INTO ${CHALLENGES}
        (id, tenant_id, project_no, actor, fingerprint, code_digest, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + $7::int * interval '1 second')
        ON CONFLICT (tenant_id, project_no, actor) DO UPDATE SET id = EXCLUDED.id,
          fingerprint = EXCLUDED.fingerprint, code_digest = EXCLUDED.code_digest, expires_at = EXCLUDED.expires_at
        RETURNING expires_at`, [challengeId, tenantId, projectNo, actor, plan.fingerprint, digest([challengeId, verificationCode]), TTL_SECONDS])
      return { tenantId, projectNo, tables: plan.tables, counts: plan.counts, challengeId, verificationCode, expiresAt: new Date(row.expires_at).toISOString() }
    })
  }

  async function confirm(input) {
    const scope = requireScope(input)
    const { tenantId, projectNo, actor } = scope
    const { challengeId, verificationCode } = input
    if (typeof challengeId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(challengeId)) throw refusal('challenge')
    const answer = await transact(scope, async (tx) => {
      // DELETE ... RETURNING is the atomic claim. A miss discloses nothing about another caller's
      // confirmation. Wrong codes and obsolete previews commit the claim, business/audit failures
      // roll the entire transaction back and can safely be retried.
      const [claim] = await tx.query(`DELETE FROM ${CHALLENGES}
        WHERE id = $1 AND tenant_id = $2 AND project_no = $3 AND actor = $4 AND expires_at > clock_timestamp()
        RETURNING fingerprint, code_digest`, [challengeId, tenantId, projectNo, actor])
      if (!claim || typeof verificationCode !== 'string' || !/^[0-9A-F]{8}$/.test(verificationCode)
        || !timingSafeEqual(Buffer.from(claim.code_digest, 'hex'), Buffer.from(digest([challengeId, verificationCode]), 'hex'))) return { refused: 'challenge' }
      await lockData(tx, scope)
      const plan = await planProject(tx, scope)
      if (!plan || plan.fingerprint !== claim.fingerprint) return { refused: 'stale' }
      await deleteRuntime(tx, scope, plan.runtime)
      await deleteBusiness(tx, scope, plan.business)
      await deleteSheets(tx, scope, plan.sheets)
      const scopedDb = createDb({ database: tx })
      const auditTransaction = {
        async insertOne(table, row) {
          const inserted = await scopedDb.insertOne(table, row)
          if (inserted.length !== 1 || inserted[0].id !== row.id) throw refusal('failed')
          return inserted
        },
      }
      const audit = await auditStore.appendWithin(auditTransaction, {
        tenantId, projectId: projectNo, actor, action: 'project_delete', mode: 'confirmed', detail: { counts: plan.counts },
      })
      if (!audit?.id) throw refusal('failed')
      return { tenantId, projectNo, counts: plan.counts, auditId: audit.id }
    })
    if (answer.refused) throw refusal(answer.refused)
    return answer
  }

  return { preview, confirm, isDeleted: scope => isProjectDeleted(database, scope) }
}

// A scheduled legacy pull used to accept even an unregistered project. Only an actual deletion
// changes that rule. A current registry, project ledger or shared pull root proves recreation.
async function isProjectDeleted(database, { tenantId, projectNo, boundTarget }) {
  try {
    return await database.transaction(async client => {
      const tx = transactionHandle(client, performance.now() + TRANSACTION_BUDGET_MS)
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      await tx.query("SET LOCAL statement_timeout = '15s'")
      await tx.query('SET LOCAL row_security = off')
      // Before the rollout the DB CHECK excludes project_delete and the challenge table does
      // not exist. Catalog discovery avoids reading private tables on those older deployments.
      // If the challenge table alone is lost, a previously widened CHECK still requires a lookup.
      const [schema] = await tx.query(`SELECT to_regclass('${CHALLENGES}') IS NOT NULL OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = to_regclass('integration_stock_prep_audit')
          AND conname = 'integration_stock_prep_audit_action_check'
          AND position('''project_delete''' in pg_catalog.pg_get_constraintdef(oid)) > 0
      ) AS installed`)
      if (schema?.installed === false) return false
      if (schema?.installed !== true) throw refusal('unavailable')
      const [marker] = await tx.query(`SELECT EXISTS (SELECT 1 FROM integration_stock_prep_audit
        WHERE tenant_id = $1 AND project_id = $2 AND action = 'project_delete') AS present`, [tenantId, projectNo])
      if (marker?.present === false) return false
      if (marker?.present !== true) throw refusal('failed')
      return !(await existsProjectRoot(tx, { tenantId, projectNo, boundTarget }))
    })
  } catch (error) { throw mapError(error) }
}

module.exports = { createStockPreparationProjectDelete, isProjectDeleted }

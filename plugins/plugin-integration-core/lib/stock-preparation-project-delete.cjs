'use strict'

const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { createDb } = require('./db.cjs')
const { deriveStockPreparationBaseId } = require('./stock-preparation-own-base.cjs')
const { PROJECT_OVERVIEW_LOCK_PREFIX } = require('./stock-preparation-project-target-store.cjs')
const { lockProjectActivity, projectBusy } = require('./stock-preparation-project-delete-activity.cjs')
const { planSheets, deleteSheets, existsProjectRoot, discoverProjectDeleteSheetScope } = require('./stock-preparation-project-delete-sheets.cjs')
const { planBusiness, deleteBusiness, businessDeleteFenceKeys } = require('./stock-preparation-project-delete-business.cjs')
const { planRuntime, deleteRuntime, runtimeFenceKeys } = require('./stock-preparation-project-delete-runtime.cjs')

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

async function excludeProjectActivities(tx, scope) {
  await lockProjectActivity(tx, scope)
  const [overview] = await tx.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [PROJECT_OVERVIEW_LOCK_PREFIX + scope.tenantId])
  if (overview?.locked !== true) throw projectBusy()
}

async function lockData(tx, scope) {
  await excludeProjectActivities(tx, scope)
  // Registry writes hold the shared stage key. Freeze membership before discovering adopted and
  // empty shared sheets; they must be fenced even if today's targeted row count is zero.
  const fence = 'SELECT public.stock_prep_project_delete_fence($1::text[], false)'
  await tx.query(fence, [['stage:' + scope.tenantId + ':integration-core', 'registry-target:' + JSON.stringify([scope.tenantId, scope.projectNo])]])
  await tx.query('SELECT id FROM meta_bases WHERE id = $1 FOR SHARE NOWAIT', [deriveStockPreparationBaseId(scope.tenantId)])
  const sheets = await discoverProjectDeleteSheetScope(tx, scope)
  await tx.query(fence, [[...sheets.map(id => 'sheet:' + id), ...businessDeleteFenceKeys(scope, sheets), ...runtimeFenceKeys(scope, sheets)]])
  // The following inventory gets a fresh READ COMMITTED snapshot after the writer keys have
  // been acquired. Prior commits are included; in-flight writers refused the try-lock.
}

async function planProject(tx, scope, confirming = false, prepareSheetWrites) {
  let sheets = await planSheets(tx, scope)
  let sheetWrites
  if (confirming) {
    if (typeof prepareSheetWrites !== 'function') throw refusal('unavailable')
    sheetWrites = await prepareSheetWrites(sheets)
    // Yjs persistence and host FK writers pin record incarnations with FOR KEY SHARE. Take their
    // conflicting row locks before the final dependency count, without touching sibling records.
    const liveIds = [...sheets.selected.values()].flatMap(selection => selection.live)
    if (liveIds.length) {
      const held = await tx.query('SELECT id FROM meta_records WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE NOWAIT', [liveIds])
      if (held.length !== liveIds.length) throw refusal('stale')
      sheets = await planSheets(tx, scope)
    }
  }
  const business = await planBusiness(tx, scope, sheets)
  if (!sheets.identityPresent && !business.identityPresent) return null
  const runtime = await planRuntime(tx, scope, sheets, confirming)
  const counts = {}
  for (const plan of [sheets, business, runtime]) {
    if (typeof plan.fingerprint !== 'string' || !plan.fingerprint) throw refusal('failed')
    for (const [key, count] of Object.entries(plan.counts)) {
      if (Object.hasOwn(counts, key) || !Number.isSafeInteger(count) || count < 0) throw refusal('failed')
      counts[key] = count
    }
  }
  return {
    sheets, sheetWrites, business, runtime, counts,
    fingerprint: digest([scope.tenantId, scope.projectNo, sheets.fingerprint, business.fingerprint, runtime.fingerprint]),
    tables: [...sheets.tables, ...(business.tables || [])].map(({ sheetId, name, kind, rowCount }) => ({ sheetId, name, kind, rowCount })),
  }
}

function mapError(error) {
  if (['42501', '42P01', '42703', '42883'].includes(error?.code)) return refusal('unavailable')
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

  async function transact(scope, operation, snapshot = false) {
    try {
      const deadline = performance.now() + TRANSACTION_BUDGET_MS
      return await database.transaction(async (client) => {
        const tx = transactionHandle(client, deadline)
        await tx.query(snapshot ? 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ' : 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await tx.query("SET LOCAL lock_timeout = '500ms'")
        await tx.query("SET LOCAL statement_timeout = '15s'")
        // PostgreSQL errors if a policy would filter any query with this setting. A restricted
        // host role must never undercount hidden records before a potentially cascading delete.
        await tx.query('SET LOCAL row_security = off')
        await tx.query('SET LOCAL search_path = pg_catalog, public, pg_temp')
        // The shared platform-authority helper locks the subject version and user rows. Screen
        // before reading the project, then release those locks (and its tentative subject bump).
        // Confirmation reacquires live authority after taking its sheet versions, in D21 order.
        if (!snapshot) await tx.query('SAVEPOINT project_delete_initial_authority')
        const prepare = await authorizeWithin(tx, scope)
        if (!snapshot) await tx.query('ROLLBACK TO SAVEPOINT project_delete_initial_authority')
        const prepareSheetWrites = async sheets => {
          if (typeof prepare !== 'function') throw refusal('unavailable')
          const writes = await prepare(sheets)
          await authorizeWithin(tx, scope)
          return writes
        }
        // Deployments can roll code and Kysely migrations separately. Every fence migration
        // installs its triggers atomically. A partial rollout cannot issue or consume a challenge.
        const [schema] = await tx.query(`SELECT count(*) = 3 AS ready FROM pg_catalog.pg_trigger
          WHERE tgenabled IN ('O', 'A') AND (tgrelid, tgname) IN (
            (to_regclass('public.meta_records'), 'stock_prep_project_delete_scoped_write'),
            (to_regclass('public.integration_stock_prep_handoff'), 'stock_prep_project_delete_business_write'),
            (to_regclass('public.plugin_kv'), 'stock_prep_project_delete_kv_insert'))`)
        if (!schema?.ready) throw refusal('unavailable')
        const answer = await operation(tx, prepareSheetWrites)
        if (performance.now() >= deadline) throw projectBusy()
        return answer
      })
    } catch (error) { throw mapError(error) }
  }

  async function preview(input) {
    const scope = requireScope(input)
    const { tenantId, projectNo, actor } = scope
    return transact(scope, async (tx) => {
      await excludeProjectActivities(tx, scope)
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
    }, true)
  }

  async function confirm(input) {
    const scope = requireScope(input)
    const { tenantId, projectNo, actor } = scope
    const { challengeId, verificationCode } = input
    if (typeof challengeId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(challengeId)) throw refusal('challenge')
    const answer = await transact(scope, async (tx, prepareSheetWrites) => {
      // DELETE ... RETURNING is the atomic claim. A miss discloses nothing about another caller's
      // confirmation. Wrong codes and obsolete previews commit the claim, business/audit failures
      // roll the entire transaction back and can safely be retried.
      const [claim] = await tx.query(`DELETE FROM ${CHALLENGES}
        WHERE id = $1 AND tenant_id = $2 AND project_no = $3 AND actor = $4 AND expires_at > clock_timestamp()
        RETURNING fingerprint, code_digest`, [challengeId, tenantId, projectNo, actor])
      if (!claim || typeof verificationCode !== 'string' || !/^[0-9A-F]{8}$/.test(verificationCode)
        || !timingSafeEqual(Buffer.from(claim.code_digest, 'hex'), Buffer.from(digest([challengeId, verificationCode]), 'hex'))) return { refused: 'challenge' }
      await lockData(tx, scope)
      // A stale confirmation consumes its challenge, but commits no D21 version bumps.
      await tx.query('SAVEPOINT project_delete_sheet_versions')
      const plan = await planProject(tx, scope, true, prepareSheetWrites)
      if (!plan || plan.fingerprint !== claim.fingerprint) {
        await tx.query('ROLLBACK TO SAVEPOINT project_delete_sheet_versions')
        return { refused: 'stale' }
      }
      await deleteRuntime(tx, scope, plan.runtime, plan.sheets.dedicatedSheetId)
      await deleteBusiness(tx, scope, plan.business)
      await deleteSheets(tx, scope, plan.sheets, plan.sheetWrites)
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

  async function deletionSnapshot({ tenantId, projectNos = [], boundTarget }) {
    return database.transaction(async client => {
      const tx = transactionHandle(client, performance.now() + TRANSACTION_BUDGET_MS)
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      await tx.query("SET LOCAL statement_timeout = '15s'")
      await tx.query('SET LOCAL row_security = off')
      const [snapshot] = await tx.query(`SELECT count(*)::text AS version,
          array_agg(DISTINCT project_id) FILTER (WHERE project_id = ANY($2::text[])) AS candidates
        FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'project_delete'`, [tenantId, projectNos])
      const deleted = []
      for (const projectNo of snapshot.candidates || []) {
        if (!(await existsProjectRoot(tx, { tenantId, projectNo, boundTarget }))) deleted.push(projectNo)
      }
      return { version: snapshot.version, deleted }
    })
  }

  return { preview, confirm, deletionSnapshot, isDeleted: scope => isProjectDeleted(database, scope) }
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

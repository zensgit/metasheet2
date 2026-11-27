'use strict'

const { createHash } = require('node:crypto')
const { createDb } = require('./db.cjs')
const { deriveStockPreparationProjectSheetObjectId } = require('./stock-preparation-own-base.cjs')
const { RECONCILE_LEASE_TABLE, __internals: { stableHash } } = require('./stock-preparation-confirmation-decisions.cjs')
const {
  PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS, PROJECT_WRITE_LOCK_TABLE,
  createStockPreparationProjectWriteLock, sheetWriteScopeKey,
} = require('./stock-preparation-project-write-lock.cjs')

const PREFIX = 'integration_stock_prep_'
const PACK_TABLE = PREFIX + 'pack_installs'
const HANDOFF_TABLE = PREFIX + 'handoff'

// Physical deletion order. Only the two ledger FKs currently enforced in PostgreSQL
// need it, but logical references (repair claim, execution intent, reviewed cell)
// also lose their children first. The per-tenant defaults are intentionally absent.
const projectFilter = 'WHERE tenant_id = $1 AND project_no = $2'
const LEDGERS = [
  {
    table: 'sheet_repair_claim', count: 'sheetRepairClaims', key: 'claim_key',
    remove: `DELETE FROM integration_stock_prep_sheet_repair_claim ${projectFilter}`,
  },
  {
    table: 'sheet_repair_run', count: 'sheetRepairRuns', fence: true, busy: "r.status = 'running'",
    remove: `DELETE FROM integration_stock_prep_sheet_repair_run ${projectFilter}`,
  },
  {
    table: 'refresh_execution_intent', count: 'refreshIntents', fence: true,
    remove: `DELETE FROM integration_stock_prep_refresh_execution_intent ${projectFilter}`,
  },
  {
    table: 'pull_batch_execution', count: 'pullBatchExecutions', busy: 'r.finished_at IS NULL',
    remove: `DELETE FROM integration_stock_prep_pull_batch_execution ${projectFilter}`,
  },
  {
    table: 'pull_batch', count: 'pullBatches',
    remove: `DELETE FROM integration_stock_prep_pull_batch ${projectFilter}`,
  },
  {
    table: 'pull_batch_sheet', count: 'pullBatchSheets', busy: "r.history_status = 'installing'",
    remove: `DELETE FROM integration_stock_prep_pull_batch_sheet ${projectFilter}`,
  },
  {
    table: 'reviewed_cell', count: 'reviewedCells', fence: true,
    remove: `DELETE FROM integration_stock_prep_reviewed_cell ${projectFilter}`,
  },
  {
    table: 'change_plan', count: 'changePlans', fence: true,
    remove: `DELETE FROM integration_stock_prep_change_plan ${projectFilter}`,
  },
  {
    table: 'refresh_hold', count: 'refreshHolds', fence: true,
    remove: `DELETE FROM integration_stock_prep_refresh_hold ${projectFilter}`,
  },
  {
    table: 'refresh_state', count: 'refreshStates', fence: true,
    remove: `DELETE FROM integration_stock_prep_refresh_state ${projectFilter}`,
  },
  {
    table: 'refresh_execution', count: 'refreshExecutions', fence: true, busy: "r.status = 'running'",
    remove: `DELETE FROM integration_stock_prep_refresh_execution ${projectFilter}`,
  },
  {
    table: 'continuation_member', count: 'continuationMembers', fence: true,
    remove: `DELETE FROM integration_stock_prep_continuation_member ${projectFilter}`,
  },
  {
    table: 'continuation', count: 'continuations', fence: true,
    remove: `DELETE FROM integration_stock_prep_continuation ${projectFilter}`,
  },
  {
    table: 'component_ruling', count: 'componentRulings',
    remove: 'DELETE FROM integration_stock_prep_component_ruling WHERE tenant_id = $1 AND project_no = $2',
  },
]
const BUSINESS_LOCK_TABLES = Object.freeze([
  ...LEDGERS.map(({ table }) => PREFIX + table), HANDOFF_TABLE, PACK_TABLE, RECONCILE_LEASE_TABLE, PROJECT_WRITE_LOCK_TABLE,
])

function refuse(reason) {
  const code = 'STOCK_PREPARATION_PROJECT_DELETE_' + reason
  throw Object.assign(new Error(code), { status: 409, code })
}

// Fixed-size digests cross the database boundary, even for a repair backup with a
// large JSONB payload. xmin also detects edits which restore the previous value.
function fingerprintSql(key = 'id') {
  return `encode(sha256(convert_to(coalesce(string_agg(
    encode(sha256(convert_to(jsonb_build_array(r.xmin::text, to_jsonb(r))::text, 'UTF8')), 'hex'),
    '' ORDER BY r.${key} COLLATE "C"), ''), 'UTF8')), 'hex')`
}

function ledgerInventory({ table, count, key, busy, fence }) {
  const sameOwner = '(r.tenant_id = $1 AND r.project_no = $2)'
  // A dedicated sheet cannot have somebody else's ledger, and a tenant's shared
  // sheet cannot belong to another tenant. Rows of other projects on a shared
  // sheet remain outside the inventory.
  const scopeMatches = `${sameOwner} AND r.sheet_id = ANY($3::text[])`
  return `SELECT '${count}' AS category, count(*)::int AS n,
    ${fingerprintSql(key)} AS digest,
    bool_or(NOT (${scopeMatches}) ${fence ? 'OR r.write_scope_key IS DISTINCT FROM targets.scope_key' : ''}) AS ambiguous,
    bool_or(${busy || 'false'}) AS busy,
    array_agg(DISTINCT r.sheet_id) AS sheets
    FROM ${PREFIX}${table} r
    LEFT JOIN targets ON targets.sheet_id = r.sheet_id
    WHERE ${sameOwner} OR r.sheet_id = $4
       OR (r.sheet_id = ANY($3::text[]) AND r.tenant_id <> $1)
       ${fence ? 'OR (r.write_scope_key = ANY($5::text[]) AND r.write_scope_key IS DISTINCT FROM targets.scope_key)' : ''}`
}

// The plugin's ledgers duplicate the ownership triple on child rows. Check both
// directions: a child can claim the target while pointing out of it, or claim
// another owner while pointing into it. No deletion is offered in either case.
const PARENT_REFERENCES = [
  ['continuation_member', 'continuation_id', 'continuation'],
  ['refresh_hold', 'continuation_id', 'continuation'],
  ['refresh_execution_intent', 'execution_id', 'refresh_execution'],
  ['refresh_state', 'settled_execution_id', 'refresh_execution'],
  ['change_plan', 'execution_id', 'refresh_execution'],
  ['change_plan', 'superseded_by', 'change_plan'],
  ['change_plan', 'recovered_from_change_plan_id', 'change_plan'],
  ['reviewed_cell', 'change_plan_id', 'change_plan'],
  ['pull_batch_execution', 'batch_id', 'pull_batch'],
  ['pull_batch_execution', 'refresh_execution_id', 'refresh_execution'],
  ['continuation', 'executed_execution_id', 'refresh_execution'],
  ['sheet_repair_claim', 'run_id', 'sheet_repair_run'],
  ['sheet_repair_run', 'source_run_id', 'sheet_repair_run'],
  ['change_plan', 'absorbed_change_plan_ids', 'change_plan', '$[*]'],
  ['change_plan', 'hold_ids', 'refresh_hold', '$[*]'],
  ['change_plan', 'continuation_ids', 'continuation', '$[*]'],
  ['refresh_execution', 'refresh_binding', 'change_plan', '$.changePlanId'],
  ['refresh_execution', 'refresh_binding', 'continuation', '$.continuations[*].id'],
]
function invalidReferenceSql([child, column, parent, jsonPath]) {
  const link = jsonPath ? `CROSS JOIN LATERAL jsonb_path_query(c.${column}, '${jsonPath}') AS link(value)` : ''
  const parentId = jsonPath ? "(link.value #>> '{}')" : `c.${column}`
  return `SELECT 1 FROM ${PREFIX}${child} c ${link} LEFT JOIN ${PREFIX}${parent} p ON p.id = ${parentId}
    WHERE ${parentId} IS NOT NULL
      AND ((c.tenant_id = $1 AND c.project_no = $2) OR (p.tenant_id = $1 AND p.project_no = $2))
      AND (c.tenant_id, c.project_no, c.sheet_id) IS DISTINCT FROM (p.tenant_id, p.project_no, p.sheet_id)`
}

const INVENTORY_SQL = `WITH targets AS (SELECT * FROM unnest($3::text[], $5::text[]) AS t(sheet_id, scope_key))
  ${LEDGERS.map(ledgerInventory).join('\nUNION ALL\n')}
  UNION ALL SELECT 'handoffs', count(*)::int, ${fingerprintSql()}, false, false, NULL::text[]
    FROM ${HANDOFF_TABLE} r WHERE tenant_id = $1 AND project_no = $2
  UNION ALL SELECT 'packInstalls', count(*)::int, ${fingerprintSql()},
    bool_or(tenant_id <> $1 OR project_id <> $6 OR $4::text IS NULL), false, NULL::text[]
    FROM ${PACK_TABLE} r WHERE object_id = $7
  UNION ALL SELECT 'reconcileLeases', count(*)::int, ${fingerprintSql('scope_key')},
    false, bool_or(expires_at > clock_timestamp()), NULL::text[]
    FROM ${RECONCILE_LEASE_TABLE} r WHERE scope_key = $8`
const INVALID_REFERENCES_SQL = `SELECT EXISTS (${PARENT_REFERENCES.map(invalidReferenceSql).join('\nUNION ALL\n')}) AS invalid`

function identifiers({ tenantId, projectNo }) {
  const staging = tenantId + ':integration-core'
  return {
    staging,
    objectId: deriveStockPreparationProjectSheetObjectId(tenantId, projectNo),
    reconcileKey: stableHash('reconcile-lock', { targetProjectId: staging, projectNo }),
  }
}

function businessDeleteFenceKeys(scope, candidateSheetIds) {
  const { objectId, reconcileKey } = identifiers(scope)
  return [...new Set(candidateSheetIds)].map(id => 'write:' + sheetWriteScopeKey(id))
    .concat('lease:' + reconcileKey, 'pack:' + objectId)
}

async function planBusiness(trx, scope, sheetPlan) {
  const { tenantId, projectNo } = scope
  const targets = [...new Set(sheetPlan.ownedTargetSheetIds)]
  const { staging, objectId, reconcileKey } = identifiers(scope)
  const rows = await trx.query(INVENTORY_SQL, [
    tenantId, projectNo, targets, sheetPlan.dedicatedSheetId, targets.map(sheetWriteScopeKey), staging, objectId, reconcileKey,
  ])
  if (rows.some((row) => row.ambiguous)) refuse('AMBIGUOUS')
  if (rows.some((row) => row.busy)) refuse('BUSY')
  const [links] = await trx.query(INVALID_REFERENCES_SQL, [tenantId, projectNo])
  if (links.invalid) refuse('AMBIGUOUS')

  const counts = {}
  const digests = []
  const sheets = new Set()
  if (sheetPlan.dedicatedSheetId) sheets.add(sheetPlan.dedicatedSheetId)
  for (const table of sheetPlan.tables) if (targets.includes(table.sheetId)) sheets.add(table.sheetId)
  for (const row of rows) {
    counts[row.category] = row.n
    digests.push([row.category, row.digest])
    for (const sheetId of row.sheets || []) sheets.add(sheetId)
  }
  if (!sheetPlan.identityPresent && rows.some((row) => row.n > 0)) refuse('AMBIGUOUS')
  const fenceKeys = [...sheets].map(sheetWriteScopeKey).sort()
  const [locks] = await trx.query(`SELECT ${fingerprintSql('scope_key')} AS digest,
    bool_or(tenant_id IS NOT NULL AND tenant_id <> $2) AS ambiguous,
    bool_or(lease_id IS NOT NULL AND (lease_expires_at IS NULL
      OR lease_expires_at + $3::int * interval '1 millisecond' > clock_timestamp())) AS busy
    FROM ${PROJECT_WRITE_LOCK_TABLE} r WHERE scope_key = ANY($1::text[])`, [fenceKeys, tenantId, PROJECT_WRITE_LEASE_TAKEOVER_GRACE_MS])
  if (locks.ambiguous) refuse('AMBIGUOUS')
  if (locks.busy) refuse('BUSY')
  digests.push(['writeLock', locks.digest])
  digests.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return {
    counts, identityPresent: false, fenceKeys, staging, objectId, reconcileKey,
    fingerprint: createHash('sha256').update(JSON.stringify(digests)).digest('hex'),
  }
}

async function deleteCount(trx, statement, params, expected) {
  if (expected === 0) return
  const [row] = await trx.query(`WITH removed AS (${statement} RETURNING 1)
    SELECT count(*)::int AS n FROM removed`, params)
  if (row.n !== expected) refuse('STALE')
}

async function deleteBusiness(trx, { tenantId, projectNo }, plan) {
  const { counts } = plan
  for (const ledger of LEDGERS) {
    await deleteCount(trx, ledger.remove, [tenantId, projectNo], counts[ledger.count])
  }
  await deleteCount(trx, `DELETE FROM integration_stock_prep_handoff ${projectFilter}`, [tenantId, projectNo], counts.handoffs)
  await deleteCount(trx, 'DELETE FROM integration_stock_prep_pack_installs WHERE tenant_id = $1 AND project_id = $2 AND object_id = $3', [tenantId, plan.staging, plan.objectId], counts.packInstalls)
  await deleteCount(trx, 'DELETE FROM integration_stock_prep_confirmation_reconcile_lease WHERE scope_key = $1 AND expires_at <= clock_timestamp()', [plan.reconcileKey], counts.reconcileLeases)
  // Retain the sheet's monotonic generation across same-number recreation. This
  // also fences old expansion observations taken before the first lock existed.
  if (plan.fenceKeys.length) {
    const db = createDb({ database: { query: trx.query.bind(trx), transaction: (fn) => fn(trx) } })
    const locks = createStockPreparationProjectWriteLock({ db })
    await db.transaction(async (scoped) => {
      for (const key of plan.fenceKeys) await locks.bumpGenerationWithin(scoped, key, { tenantId, reason: 'project_delete' })
    })
  }
}

module.exports = { BUSINESS_LOCK_TABLES, businessDeleteFenceKeys, planBusiness, deleteBusiness }

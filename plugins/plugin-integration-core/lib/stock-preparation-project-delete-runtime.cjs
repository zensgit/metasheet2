'use strict'

const { createHash } = require('node:crypto')
const { sheetWriteScopeKey } = require('./stock-preparation-project-write-lock.cjs')
const { PLM_STOCK_PREPARATION_ACTION_ID } = require('./stock-preparation-table-actions.cjs')
const { READ_RECEIPT_KEY_PREFIX } = require('./stock-preparation-refresh-decisions.cjs')
const { MANUAL_ROWS_LAST_PULL_KEY_PREFIX } = require('./stock-preparation-manual-rows.cjs')
const { __internals: dryJobs } = require('./stock-preparation-dry-run-jobs.cjs')

const PLUGIN = 'plugin-integration-core'
const BACKGROUND = 'stock-preparation:large-bom:background:'
const APPLY = 'stock-preparation:large-bom:apply:'
const TOKEN = 'integration:table-action:dry-run-token:'

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function refused(code) {
  const error = new Error('The project runtime state does not permit deletion')
  error.code = 'STOCK_PREPARATION_PROJECT_DELETE_' + code
  error.status = 409
  return error
}

// Old background trial results have an opaque per-principal key. Recompute the keys the real
// producer used, including its email fallback, only if the installation has such legacy records.
async function legacyTrialKeys(tx, scope) {
  const [row] = await tx.query(
    'SELECT EXISTS (SELECT 1 FROM plugin_kv WHERE plugin = $1 AND starts_with(key, $2) AND NOT (value ? $3)) AS present',
    [PLUGIN, dryJobs.DRY_RUN_JOB_KEY_PREFIX, 'targetKey'],
  )
  if (!row.present) return []
  // The historical hash covers JSON.stringify(['record', tenant, action, project, principal,
  // valueBearing]). PostgreSQL's scalar JSON quoting preserves this encoding, including escaped
  // characters. Neither identities nor business values leave the DB. If a retired identity (or
  // an old ledger-only project) cannot be assigned, refuse rather than silently retaining it.
  const matches = await tx.query(`
    WITH candidates AS (
      SELECT tenant_id, project_no FROM integration_stock_prep_project_target
      UNION SELECT value->>'tenantId', value#>>'{parameters,projectNo}' FROM plugin_kv
        WHERE plugin = $1 AND starts_with(key, $6) AND value->>'tenantId' IS NOT NULL
          AND value#>>'{parameters,projectNo}' IS NOT NULL
      UNION SELECT $2::text, $3::text
    ), principals AS (
      SELECT id::text AS id FROM users UNION SELECT email FROM users WHERE email IS NOT NULL AND btrim(email) <> ''
    ), legacy AS (
      SELECT key FROM plugin_kv WHERE plugin = $1 AND starts_with(key, $4) AND NOT (value ? 'targetKey')
    ), known AS (
      SELECT $4 || encode(sha256(convert_to('["record",' || to_json(c.tenant_id)::text || ','
        || to_json($5::text)::text || ',' || to_json(c.project_no)::text || ','
        || to_json(p.id)::text || ',' || flag::text || ']', 'UTF8')), 'hex') AS key,
        c.tenant_id = $2 AND c.project_no = $3 AS mine
      FROM candidates c CROSS JOIN principals p CROSS JOIN (VALUES (true), (false)) f(flag)
    )
    SELECT l.key, k.mine FROM legacy l LEFT JOIN known k ON k.key = l.key`,
    [PLUGIN, scope.tenantId, scope.projectNo, dryJobs.DRY_RUN_JOB_KEY_PREFIX, PLM_STOCK_PREPARATION_ACTION_ID, BACKGROUND],
  )
  if (matches.some(row => row.mine == null)) throw refused('AMBIGUOUS')
  return matches.filter(row => row.mine).map(row => row.key)
}

async function planRuntime(tx, scope, sheets) {
  const { tenantId, projectNo } = scope
  const dedicated = sheets.dedicatedSheetId ? [sheets.dedicatedSheetId] : []
  const shared = sheets.ownedTargetSheetIds.filter(id => id !== sheets.dedicatedSheetId)
  const legacyKeys = await legacyTrialKeys(tx, scope)
  const targetKey = dryJobs.dryRunJobTargetKey({ ...scope, actionId: PLM_STOCK_PREPARATION_ACTION_ID })
  // Job payloads can contain the entire BOM. Do the ownership join and hash inside PostgreSQL.
  // Checkpoint jobs carry the SOURCE JOB id, not the business project number.
  const rows = await tx.query(`
    WITH background AS (
      SELECT key, value FROM plugin_kv
      WHERE plugin = $1 AND starts_with(key, $4) AND value->>'tenantId' = $2
    ), candidates AS (
      SELECT kv.key, kv.value, kv.xmin::text AS version,
        CASE
          WHEN starts_with(kv.key, $4) THEN 'background'
          WHEN starts_with(kv.key, $5) THEN 'checkpoint'
          WHEN starts_with(kv.key, $6) THEN 'trial'
          WHEN starts_with(kv.key, $7) THEN 'token'
          ELSE 'other'
        END AS kind,
        parent.value AS parent
      FROM plugin_kv kv
      LEFT JOIN background parent ON starts_with(kv.key, $5)
        AND parent.value->>'workspaceId' = kv.value->>'workspaceId'
        AND parent.value->>'actionId' = kv.value->>'actionId'
        AND parent.value->>'jobId' = kv.value->>'sourceJobId'
        AND kv.value->>'tenantId' = $2
      WHERE kv.plugin = $1 AND (
        (starts_with(kv.key, $4) AND (
          (kv.value->>'tenantId' = $2 AND kv.value#>>'{parameters,projectNo}' = $3)
          OR kv.value#>>'{actionSnapshot,target,sheetId}' = ANY($8::text[])))
        OR (starts_with(kv.key, $5) AND (
          parent.value#>>'{parameters,projectNo}' = $3 OR kv.value#>>'{target,sheetId}' = ANY($8::text[])
          OR (parent.key IS NULL AND kv.value->>'tenantId' = $2 AND kv.value#>>'{target,sheetId}' = ANY($9::text[]))))
        OR (starts_with(kv.key, $6) AND (kv.value->>'targetKey' = $10 OR kv.key = ANY($11::text[])))
        OR (starts_with(kv.key, $7) AND (kv.value->>'writeScope' = ANY($12::text[])
          OR (kv.value->>'writeScope' = ANY($13::text[]) AND kv.value->>'parametersHash' = $14)))
        OR (starts_with(kv.key, $15) AND kv.value->>'tenantId' = $2 AND kv.value->>'projectNo' = $3)
        OR kv.key = ANY($16::text[])
      )
    )
    SELECT key, encode(sha256(convert_to(value::text, 'UTF8')), 'hex') AS fingerprint,
      version, kind, value->>'status' AS status,
      CASE WHEN kind = 'background' THEN value->>'tenantId' IS DISTINCT FROM $2
          OR value#>>'{parameters,projectNo}' IS DISTINCT FROM $3
          OR NOT COALESCE(value#>>'{actionSnapshot,target,sheetId}' = ANY($8::text[] || $9::text[]), false)
        WHEN kind = 'checkpoint' THEN value->>'tenantId' IS DISTINCT FROM $2
          OR (parent IS NULL AND NOT COALESCE(value#>>'{target,sheetId}' = ANY($8::text[]), false))
          OR NOT COALESCE(value#>>'{target,sheetId}' = ANY($8::text[] || $9::text[]), false)
          OR (parent IS NOT NULL AND (parent#>>'{parameters,projectNo}' IS DISTINCT FROM $3
            OR parent#>>'{actionSnapshot,target,sheetId}' IS DISTINCT FROM value#>>'{target,sheetId}'))
        WHEN kind = 'token' THEN value->>'parametersHash' IS DISTINCT FROM $14
        ELSE false END AS ambiguous
    FROM candidates ORDER BY key`, [
    PLUGIN, tenantId, projectNo, BACKGROUND, APPLY, dryJobs.DRY_RUN_JOB_KEY_PREFIX, TOKEN,
    dedicated, shared, targetKey, legacyKeys, dedicated.map(sheetWriteScopeKey), shared.map(sheetWriteScopeKey),
    digest({ projectNo }), READ_RECEIPT_KEY_PREFIX, dedicated.map(id => MANUAL_ROWS_LAST_PULL_KEY_PREFIX + id),
  ])
  if (rows.some(row => row.ambiguous)) throw refused('AMBIGUOUS')
  const terminal = {
    background: ['completed', 'failed', 'cancelled', 'expired'],
    checkpoint: ['succeeded', 'partial', 'cancelled', 'expired'],
    trial: ['succeeded', 'failed'],
  }
  if (rows.some(row => terminal[row.kind] && !terminal[row.kind].includes(row.status))) throw refused('BUSY')
  return {
    counts: { runtimeRecords: rows.length },
    fingerprint: digest(rows),
    keys: rows.map(row => row.key),
  }
}

async function deleteRuntime(tx, _scope, plan) {
  if (!plan.keys.length) return
  const removed = await tx.query('DELETE FROM plugin_kv WHERE plugin = $1 AND key = ANY($2::text[]) RETURNING 1', [PLUGIN, plan.keys])
  if (removed.length !== plan.keys.length) throw refused('STALE')
}

module.exports = { planRuntime, deleteRuntime }

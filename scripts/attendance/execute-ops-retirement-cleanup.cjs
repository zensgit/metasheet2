#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * W4C-3c P15 — authenticated operator cleanup via the same HTTP boundary as
 * production (POST /api/attendance/records/:id/ops-retirement).
 *
 * NEVER issues DELETE FROM attendance_records. NEVER imports TypeScript modules
 * or randomizes command identity. Each target requires a stable operator
 * command UUID (derived deterministically from a caller-supplied command seed +
 * record id, or supplied via --operation-id when single-target).
 *
 * Usage:
 *   node scripts/attendance/execute-ops-retirement-cleanup.cjs \
 *     --source dingtalk_csv_test --org <orgId> \
 *     --base-url <url> --token <bearer> \
 *     --command-seed <stable-uuid> \
 *     [--from ISO] [--to ISO] [--dry-run]
 *
 * Requires DATABASE_URL (inventory only) plus BASE_URL + TOKEN for execution.
 */
'use strict'

const crypto = require('crypto')
const http = require('http')
const https = require('https')
const { URL } = require('url')

const argv = process.argv.slice(2)
function getArg(name, fallback) {
  const flag = `--${name}`
  const idx = argv.findIndex((value) => value === flag || value.startsWith(`${flag}=`))
  if (idx === -1) return fallback
  const raw = argv[idx]
  if (raw.includes('=')) return raw.slice(flag.length + 1)
  const next = argv[idx + 1]
  if (!next || next.startsWith('--')) return true
  return next
}

function requireExplicitOrgId(value) {
  const orgId = String(value || '').trim()
  if (!orgId) {
    const error = new Error('Missing --org')
    error.code = 'ATTENDANCE_P15_ORG_REQUIRED'
    throw error
  }
  return orgId
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * P15: a parent is W4-backed when it has a current pointer, non-legacy owner,
 * or any calculation child. Non-W4 rows are tooling classification only and
 * must never be sent to ops-retirement.
 */
function isW4BackedInventoryRow(row) {
  if (!row || typeof row !== 'object') return false
  if (row.current_calculation_id != null && String(row.current_calculation_id).length > 0) return true
  if (row.projection_owner != null && row.projection_owner !== 'legacy_untracked') return true
  if (row.has_calculation_child === true || row.has_calculation_child === 't' || Number(row.has_calculation_child) > 0) {
    return true
  }
  return false
}

/** UUIDv5-style deterministic command id from seed + record (stable, no random). */
function stableOperationId(commandSeed, recordId) {
  const seed = String(commandSeed).toLowerCase()
  const name = `ops_retirement:${seed}:${String(recordId).toLowerCase()}`
  const hash = crypto.createHash('sha1').update(name, 'utf8').digest()
  // RFC 4122 version 5 layout over SHA-1 name space hash.
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function assignStableOperationIds(targets, commandSeed, singleOperationId) {
  const hasSingleOperationId = UUID_RE.test(String(singleOperationId || ''))
  if (hasSingleOperationId && targets.length > 1) {
    const error = new Error('--operation-id is valid only when inventory resolves to one target')
    error.code = 'SINGLE_OPERATION_ID_MULTIPLE_TARGETS'
    throw error
  }
  return targets.map((target) => ({
    ...target,
    operationId: hasSingleOperationId
      ? String(singleOperationId).toLowerCase()
      : UUID_RE.test(commandSeed)
        ? stableOperationId(commandSeed, target.record_id)
        : null,
  }))
}

function requestJson(baseUrl, path, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    const payload = body ? JSON.stringify(body) : null
    const lib = target.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        method,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => {
          raw += String(chunk)
        })
        res.on('end', () => {
          let parsed = null
          try {
            parsed = raw ? JSON.parse(raw) : null
          } catch {
            parsed = null
          }
          resolve({ status: res.statusCode || 0, body: parsed, raw })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function main() {
  const source = getArg('source', '')
  let orgId
  try {
    orgId = requireExplicitOrgId(getArg('org', ''))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  const from = getArg('from', '')
  const to = getArg('to', '')
  const dryRun = getArg('dry-run', false) === true || getArg('dry-run', false) === 'true'
  const baseUrl = String(getArg('base-url', process.env.BASE_URL || '')).replace(/\/$/, '')
  const token = String(getArg('token', process.env.TOKEN || process.env.ADMIN_TOKEN || ''))
  const commandSeed = String(getArg('command-seed', process.env.OPS_RETIREMENT_COMMAND_SEED || ''))
  const singleOperationId = String(getArg('operation-id', '') || '')

  if (!source) {
    console.error('Missing --source')
    process.exit(1)
  }
  if (!dryRun) {
    if (!baseUrl || !token) {
      console.error('Execution requires --base-url and --token (or BASE_URL / TOKEN env)')
      process.exit(1)
    }
    if (!UUID_RE.test(commandSeed) && !UUID_RE.test(singleOperationId)) {
      console.error(
        'Execution requires --command-seed <uuid> (or --operation-id for a single target). Server never randomizes identity.',
      )
      process.exit(1)
    }
  }

  const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('Missing DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL for inventory SELECT')
    process.exit(1)
  }

  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: dbUrl })

  const where = ['e.org_id = $1', 'e.source = $2']
  const params = [orgId, source]
  if (from) {
    params.push(from)
    where.push(`e.occurred_at >= $${params.length}`)
  }
  if (to) {
    params.push(to)
    where.push(`e.occurred_at < $${params.length}`)
  }

  // Inventory all matching parents first, then classify W4-backed vs non-W4 tooling rows.
  // Only W4-backed rows (pointer OR non-legacy owner OR calculation child) are retirement targets.
  const inventory = await pool.query(
    `SELECT DISTINCT r.id::text AS record_id,
            r.user_id::text AS user_id,
            r.work_date::text AS work_date,
            r.current_calculation_id::text AS current_calculation_id,
            current_calc.version AS current_calculation_version,
            latest_calc.id::text AS latest_calculation_id,
            latest_calc.version AS latest_calculation_version,
            r.projection_owner,
            r.visibility_state,
            r.visibility_reason,
            EXISTS (
              SELECT 1 FROM attendance_record_calculations c
               WHERE c.attendance_record_id = r.id
                 AND c.org_id = r.org_id
            ) AS has_calculation_child
       FROM attendance_events e
       JOIN attendance_records r
         ON r.org_id = e.org_id AND r.user_id = e.user_id AND r.work_date = e.work_date
       LEFT JOIN attendance_record_calculations current_calc
         ON current_calc.id = r.current_calculation_id
        AND current_calc.attendance_record_id = r.id
        AND current_calc.org_id = r.org_id
       LEFT JOIN LATERAL (
         SELECT calculation.id, calculation.version
           FROM attendance_record_calculations calculation
          WHERE calculation.attendance_record_id = r.id
            AND calculation.org_id = r.org_id
            AND calculation.outcome = 'completed'
          ORDER BY calculation.version DESC
          LIMIT 1
       ) latest_calc ON TRUE
      WHERE ${where.join(' AND ')}
        AND r.visibility_reason IS DISTINCT FROM 'operator_retirement'`,
    params,
  )

  const skippedNonW4 = []
  const targetRows = []
  for (const row of inventory.rows) {
    if (!isW4BackedInventoryRow(row)) {
      skippedNonW4.push({
        recordId: row.record_id,
        classification: 'tooling_only_non_w4_fixture',
        reason: 'not W4-backed (null current_calculation_id, legacy_untracked owner, no calculation child)',
      })
      continue
    }
    targetRows.push(row)
  }
  let targets
  try {
    targets = assignStableOperationIds(targetRows, commandSeed, singleOperationId)
  } catch (error) {
    await pool.end()
    console.error(error.message)
    process.exit(1)
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    targetCount: targets.length,
    skippedNonW4Count: skippedNonW4.length,
    skippedNonW4,
    targets,
  }, null, 2))
  if (dryRun || targets.length === 0) {
    await pool.end()
    return
  }

  const results = []
  let failed = false
  for (const target of targets) {
    if (!target.operationId) {
      failed = true
      results.push({
        recordId: target.record_id,
        error: { code: 'OPERATION_ID_REQUIRED', message: 'stable operator command UUID missing' },
      })
      continue
    }
    try {
      const response = await requestJson(
        baseUrl,
        `/api/attendance/records/${encodeURIComponent(target.record_id)}/ops-retirement`,
        {
          method: 'POST',
          token,
          body: {
            operationId: target.operationId,
            expectedCalculationId: target.current_calculation_id ?? target.latest_calculation_id ?? null,
            expectedCalculationVersion: target.current_calculation_id != null
              ? (target.current_calculation_version == null ? null : Number(target.current_calculation_version))
              : (target.latest_calculation_version == null ? null : Number(target.latest_calculation_version)),
            reason: `P15 operator cleanup for source=${source}`,
            ticket: `P15-${source}`.slice(0, 128),
          },
        },
      )
      if (response.status >= 200 && response.status < 300 && response.body?.ok !== false) {
        results.push({
          recordId: target.record_id,
          operationId: target.operationId,
          outcome: response.body,
        })
      } else {
        failed = true
        results.push({
          recordId: target.record_id,
          operationId: target.operationId,
          error: {
            code: response.body?.error?.code || `HTTP_${response.status}`,
            message: response.body?.error?.message || response.raw || `status ${response.status}`,
          },
        })
      }
    } catch (error) {
      failed = true
      results.push({
        recordId: target.record_id,
        operationId: target.operationId,
        error: { code: error.code || 'FAILED', message: error.message },
      })
    }
  }

  console.log(JSON.stringify({ ok: !failed, results }, null, 2))
  await pool.end()
  process.exit(failed ? 2 : 0)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

module.exports = {
  isW4BackedInventoryRow,
  stableOperationId,
  assignStableOperationIds,
  requireExplicitOrgId,
  main,
}

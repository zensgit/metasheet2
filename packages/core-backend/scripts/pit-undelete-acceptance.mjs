#!/usr/bin/env node
/**
 * T8-1 PIT Revert undelete — staging/operator acceptance harness.
 *
 * This is NOT a production enablement switch. It creates one or two throwaway DB fixtures, then drives the real
 * /revert-preview and /revert-execute API routes with the supplied admin JWT so flag, permission, preview-identity,
 * typed-confirm, execute, revision, and link-rebuild behavior are all exercised through the product route.
 *
 * Usage:
 *   CONFIRM_PIT_UNDELETE_SMOKE=1 \
 *   BASE_URL=https://staging.example \
 *   ADMIN_TOKEN=<sheet-admin-jwt> \
 *   DATABASE_URL=postgres://... \
 *     node packages/core-backend/scripts/pit-undelete-acceptance.mjs
 *
 * Optional:
 *   PIT_UNDELETE_API_MOUNT=/api/multitable
 *   PIT_UNDELETE_OUTPUT_FILE=/tmp/pit-undelete-acceptance.json
 *
 * Flag handling (#4261 two-gate: undelete-revert needs BOTH MULTITABLE_ENABLE_SHEET_REVERT and _PIT_UNDELETE):
 *   - either gate OFF: undeleteSupported=false and execute is inert (403 REVERT_DISABLED when the SHEET_REVERT
 *     master gate is off — checked first; else 403 UNDELETE_DISABLED). Exits successfully.
 *   - both gates ON: proves happy resurrection and an id-collision/drift 409 without overwriting the occupied record id.
 *
 * Exit:
 *   0 = all run scenarios passed
 *   1 = scenario failure
 *   2 = setup/config/harness error
 */

import { writeFile } from 'node:fs/promises'

const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '')
const ADMIN = process.env.ADMIN_TOKEN || ''
const DATABASE_URL = process.env.DATABASE_URL || ''
const CONFIRMED = process.env.CONFIRM_PIT_UNDELETE_SMOKE === '1'
const MOUNT = process.env.PIT_UNDELETE_API_MOUNT || '/api/multitable'
const OUTPUT_FILE = process.env.PIT_UNDELETE_OUTPUT_FILE || ''

if (!BASE || !ADMIN || !DATABASE_URL) {
  console.error('FATAL: BASE_URL, ADMIN_TOKEN, and DATABASE_URL are required.')
  process.exit(2)
}
if (!CONFIRMED) {
  console.error('FATAL: set CONFIRM_PIT_UNDELETE_SMOKE=1 to acknowledge this creates and deletes throwaway DB fixtures.')
  process.exit(2)
}

const pg = await import('pg')
const { Pool } = pg.default || pg
const pool = new Pool({ connectionString: DATABASE_URL })
const startedAt = new Date().toISOString()
const checks = []
let pass = 0
let fail = 0
let skip = 0

const log = (...args) => console.log(...args)

function recordCheck(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  if (ok) {
    pass += 1
    log(`  ✓ PASS  ${name}`)
  } else {
    fail += 1
    log(`  ✗ FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function recordSkip(name, why) {
  skip += 1
  checks.push({ name, skipped: true, detail: why })
  log(`  ⊘ SKIP  ${name} — ${why}`)
}

function code(res) {
  return res?.body?.error?.code || res?.body?.code || ''
}

function data(res) {
  return res?.body?.data || {}
}

async function query(sql, params = []) {
  return pool.query(sql, params)
}

async function api(method, path, body) {
  let res
  let json = null
  try {
    res = await fetch(`${BASE}${MOUNT}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN}`,
        'content-type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    return { status: 0, body: { error: { code: 'NETWORK', message: String(err?.message || err) } } }
  }
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, body: json }
}

async function maybeHealth() {
  for (const path of ['/health', '/api/health']) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } })
      if (!res.ok) continue
      const body = await res.json().catch(() => null)
      return { path, status: res.status, build: body?.build || null }
    } catch {
      // Health is useful context, not a gate for this harness.
    }
  }
  return null
}

function fixtureIds(label) {
  const safe = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return {
    base: `base_pitu_${label}_${safe}`,
    sheet: `sheet_pitu_${label}_${safe}`,
    nameField: `fld_pitu_name_${label}_${safe}`,
    linkField: `fld_pitu_link_${label}_${safe}`,
    u: `rec_pitu_u_${label}_${safe}`,
    l: `rec_pitu_l_${label}_${safe}`,
    label,
    t0: '2026-01-01T00:00:00.000Z',
    t1: '2026-01-02T00:00:00.000Z',
    t2: '2026-01-03T00:00:00.000Z',
  }
}

function snapshot(ctx) {
  return { [ctx.nameField]: 'u-at-T1', [ctx.linkField]: [ctx.l] }
}

async function insertRevision(ctx, recordId, version, action, snap, at) {
  await query(
    `INSERT INTO meta_record_revisions
       (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4, 'rest', ARRAY[$5]::text[], '{}'::jsonb, $6::jsonb, $7)`,
    [ctx.sheet, recordId, version, action, ctx.nameField, JSON.stringify(snap), at],
  )
}

async function cleanup(ctx) {
  if (!ctx) return
  const recordIds = [ctx.u, ctx.l]
  await query(
    `DELETE FROM meta_links
      WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)
         OR record_id = ANY($2::text[])
         OR foreign_record_id = ANY($2::text[])`,
    [ctx.sheet, recordIds],
  ).catch(() => {})
  await query('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [ctx.sheet]).catch(() => {})
  await query('DELETE FROM meta_records WHERE sheet_id = $1', [ctx.sheet]).catch(() => {})
  await query('DELETE FROM meta_fields WHERE sheet_id = $1', [ctx.sheet]).catch(() => {})
  await query('DELETE FROM meta_sheets WHERE id = $1', [ctx.sheet]).catch(() => {})
  await query('DELETE FROM meta_bases WHERE id = $1', [ctx.base]).catch(() => {})
}

async function seedFixture(label) {
  const ctx = fixtureIds(label)
  try {
    await query('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [ctx.base, `PIT-UNDELETE-ACCEPT ${label}`])
    await query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [ctx.sheet, ctx.base, `PIT-UNDELETE ${label}`])
    await query(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
      [ctx.nameField, ctx.sheet, 'Name', 'string', '{}', 1],
    )
    await query(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
      [ctx.linkField, ctx.sheet, 'Link', 'link', JSON.stringify({ foreignSheetId: ctx.sheet }), 2],
    )

    await insertRevision(ctx, ctx.u, 1, 'create', snapshot(ctx), ctx.t0)
    await insertRevision(ctx, ctx.u, 2, 'delete', snapshot(ctx), ctx.t2)
    await query(
      'INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)',
      [ctx.l, ctx.sheet, JSON.stringify({ [ctx.nameField]: 'L', [ctx.linkField]: [ctx.u] })],
    )
    return ctx
  } catch (err) {
    await cleanup(ctx)
    throw err
  }
}

async function preview(ctx) {
  return api('POST', `/sheets/${ctx.sheet}/revert-preview`, { asOf: ctx.t1 })
}

async function execute(ctx, previewIdentity, confirm) {
  return api('POST', `/sheets/${ctx.sheet}/revert-execute`, { asOf: ctx.t1, previewIdentity, confirm })
}

async function liveRow(ctx, recordId) {
  const res = await query('SELECT data, version FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, ctx.sheet])
  return res.rows[0]
}

async function outboundEdgeCount(ctx, recordId) {
  const res = await query('SELECT count(*)::int AS c FROM meta_links WHERE field_id = $1 AND record_id = $2', [ctx.linkField, recordId])
  return Number(res.rows[0]?.c || 0)
}

async function inboundEdgeCount(recordId) {
  const res = await query('SELECT count(*)::int AS c FROM meta_links WHERE foreign_record_id = $1', [recordId])
  return Number(res.rows[0]?.c || 0)
}

async function latestRestoreRevisionSource(ctx, recordId) {
  const res = await query(
    `SELECT source
       FROM meta_record_revisions
      WHERE sheet_id = $1 AND record_id = $2 AND action = 'create'
      ORDER BY created_at DESC
      LIMIT 1`,
    [ctx.sheet, recordId],
  )
  return res.rows[0]?.source || null
}

async function runFlagOff(ctx, pv) {
  // #4261 two-gate parity: undelete-revert requires BOTH MULTITABLE_ENABLE_SHEET_REVERT (the master gate,
  // checked FIRST) and MULTITABLE_ENABLE_PIT_UNDELETE. undeleteSupported=false covers three states — both
  // off, SHEET_REVERT-on/UNDELETE-off, and SHEET_REVERT-off/UNDELETE-on. So execute is refused with EITHER
  // REVERT_DISABLED (the master gate, when SHEET_REVERT is off) OR UNDELETE_DISABLED (the sub-gate, when
  // SHEET_REVERT is on but UNDELETE is off). Either proves the inert state.
  log('Flag state: undelete not supported (needs BOTH MULTITABLE_ENABLE_SHEET_REVERT and _PIT_UNDELETE). Running inert scenario only.\n')
  recordCheck('flag-off preview still classifies one undelete candidate', data(pv)?.summary?.visibleUndeleteCount === 1, JSON.stringify(data(pv)?.summary || {}))
  recordCheck('flag-off preview reports undeleteSupported=false', data(pv)?.undeleteSupported === false, `got ${String(data(pv)?.undeleteSupported)}`)
  const ex = await execute(ctx, data(pv)?.previewIdentity, 'undelete')
  recordCheck('flag-off execute → 403 REVERT_DISABLED or UNDELETE_DISABLED', ex.status === 403 && (code(ex) === 'REVERT_DISABLED' || code(ex) === 'UNDELETE_DISABLED'), `got ${ex.status}/${code(ex)}`)
  recordCheck('flag-off execute writes no live U row', !(await liveRow(ctx, ctx.u)), 'U unexpectedly exists')
  log('\n→ Inert state is proven. Enable BOTH MULTITABLE_ENABLE_SHEET_REVERT=true and MULTITABLE_ENABLE_PIT_UNDELETE=true and re-run for the flag-on live smoke.')
}

async function runHappy(ctx, pv) {
  log('Flag state: ON. Running happy resurrection scenario.\n')
  recordCheck('preview visibleUndeleteCount=1', data(pv)?.summary?.visibleUndeleteCount === 1, JSON.stringify(data(pv)?.summary || {}))
  recordCheck('preview undeleteSupported=true', data(pv)?.undeleteSupported === true, `got ${String(data(pv)?.undeleteSupported)}`)
  recordCheck('preview returns U in undeleteRecordIds', Array.isArray(data(pv)?.undeleteRecordIds) && data(pv).undeleteRecordIds.includes(ctx.u), JSON.stringify(data(pv)?.undeleteRecordIds || []))
  recordCheck('preview returns executable identity', typeof data(pv)?.previewIdentity === 'string' && data(pv).previewIdentity.length > 20, 'missing previewIdentity')

  const noConfirm = await execute(ctx, data(pv)?.previewIdentity)
  recordCheck('execute without confirm → 400 CONFIRM_REQUIRED', noConfirm.status === 400 && code(noConfirm) === 'CONFIRM_REQUIRED', `got ${noConfirm.status}/${code(noConfirm)}`)
  recordCheck('no-confirm writes no live U row', !(await liveRow(ctx, ctx.u)), 'U unexpectedly exists')

  const ok = await execute(ctx, data(pv)?.previewIdentity, 'undelete')
  recordCheck('execute with confirm:"undelete" → 2xx', ok.status >= 200 && ok.status < 300, `got ${ok.status}/${code(ok)}`)
  recordCheck('execute reports resurrectedCount=1', data(ok)?.resurrectedCount === 1, JSON.stringify(data(ok) || {}))

  const row = await liveRow(ctx, ctx.u)
  recordCheck('U resurrected under original id with T snapshot value', row?.data?.[ctx.nameField] === 'u-at-T1', JSON.stringify(row?.data || null))
  recordCheck('U resurrected at version=1', row?.version === 1, `got ${String(row?.version)}`)
  recordCheck('outbound link U→L rebuilt', (await outboundEdgeCount(ctx, ctx.u)) === 1, 'expected one outbound edge')
  recordCheck('inbound link to U remains absent (L4 A)', (await inboundEdgeCount(ctx.u)) === 0, 'unexpected inbound edge')
  recordCheck("resurrect revision source='restore'", (await latestRestoreRevisionSource(ctx, ctx.u)) === 'restore', 'latest create revision source mismatch')
}

async function runCollision() {
  const ctx = await seedFixture('collision')
  try {
    log('\nRunning id-collision/drift 409 scenario.\n')
    const pv = await preview(ctx)
    recordCheck('collision setup preview returns executable identity', pv.status === 200 && typeof data(pv)?.previewIdentity === 'string', `got ${pv.status}/${code(pv)}`)
    await query(
      'INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 7)',
      [ctx.u, ctx.sheet, JSON.stringify({ [ctx.nameField]: 'squatter' })],
    )
    const ex = await execute(ctx, data(pv)?.previewIdentity, 'undelete')
    recordCheck('occupied original id after preview → 409', ex.status === 409, `got ${ex.status}/${code(ex)}`)
    recordCheck(
      'occupied-id response is generic drift or undelete conflict',
      ['PREVIEW_IDENTITY_INVALID', 'UNDELETE_CONFLICT'].includes(code(ex)),
      `got ${code(ex)}`,
    )
    const row = await liveRow(ctx, ctx.u)
    recordCheck('occupied original id is not overwritten', row?.data?.[ctx.nameField] === 'squatter' && row?.version === 7, JSON.stringify(row || null))
    recordCheck("failed collision writes no restore create revision", (await latestRestoreRevisionSource(ctx, ctx.u)) !== 'restore', 'unexpected restore revision')
  } finally {
    await cleanup(ctx)
  }
}

async function writeReport(health) {
  if (!OUTPUT_FILE) return
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    target: {
      baseUrl: BASE,
      mount: MOUNT,
      health,
    },
    summary: { pass, fail, skip },
    checks,
  }
  await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  log(`\nWrote report: ${OUTPUT_FILE}`)
}

async function finish(health) {
  log(`\n── summary: ${pass} passed, ${fail} failed, ${skip} skipped ──`)
  await writeReport(health)
  await pool.end()
  process.exit(fail > 0 ? 1 : 0)
}

async function run() {
  log(`\nT8-1 PIT undelete acceptance — ${BASE}${MOUNT}\n`)
  const health = await maybeHealth()
  if (health) log(`Health: ${health.path} ${health.status}${health.build ? ` build=${JSON.stringify(health.build)}` : ''}\n`)
  else log('Health: not available from this runner; continuing with API route checks.\n')

  const ctx = await seedFixture('happy')
  try {
    const pv = await preview(ctx)
    recordCheck('preview route reachable', pv.status === 200, `got ${pv.status}/${code(pv)}`)
    if (pv.status !== 200) return health

    if (data(pv)?.undeleteSupported === false) {
      await runFlagOff(ctx, pv)
      return health
    }
    await runHappy(ctx, pv)
  } finally {
    await cleanup(ctx)
  }

  await runCollision()
  return health
}

run()
  .then((health) => finish(health))
  .catch(async (err) => {
    console.error('\nFATAL (setup or harness error):', err?.message || err)
    await pool.end().catch(() => {})
    process.exit(2)
  })

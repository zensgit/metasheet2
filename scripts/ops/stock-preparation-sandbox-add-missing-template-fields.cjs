#!/usr/bin/env node
// Additive repair for a stock-preparation SANDBOX sheet that was provisioned by an older template:
// adds the template fields whose physical id is missing on the sheet, through the host's own
// `ensureMissingObjectFields` (same stable ids, same INSERT path a fresh ensure would take), then
// sets the Chinese template label on the fields it added. Never touches existing fields or rows.
//
// Why it exists: `sandbox-target/ensure` returns `ready` + computed field ids when the sheet already
// exists, even if a newer template added fields the sheet never got. The pull then fails on child
// rows (`target_record_validation_failed`: the host rejects the unknown field id). Seen on 222 on
// 2026-09-04 (sheet created 2026-08-30, r7 template has 8 more fields).
//
// Usage (on the host, with the package installed under ROOT and docker/app.env present):
//   node scripts/ops/stock-preparation-sandbox-add-missing-template-fields.cjs \
//     --root C:\metasheet --object-id plm_stock_preparation_sandbox_r6_trial [--tenant default] [--execute]
// Without --execute it only prints the plan. Values-free: prints ids, names, types — never row data.
'use strict'

const fs = require('fs')
const path = require('path')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const root = path.resolve(arg('--root', process.cwd()))
const objectId = arg('--object-id', '')
const tenantId = arg('--tenant', 'default')
const execute = process.argv.includes('--execute')
if (!objectId) {
  console.error('usage: --root <install root> --object-id <sandbox objectId> [--tenant default] [--execute]')
  process.exit(2)
}

const envPath = path.join(root, 'docker', 'app.env')
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }),
)
for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v

const { Pool } = require(path.join(root, 'packages/core-backend/node_modules/pg'))
const prov = require(path.join(root, 'packages/core-backend/dist/src/multitable/provisioning.js'))
const tp = require(path.join(root, 'plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs'))

// Mirrors resolveIntegrationStagingProjectId(tenantId) in plugin-integration-core/lib/http-routes.cjs.
const projectId = `${tenantId}:integration-core`

;(async () => {
  const pool = new Pool({ connectionString: env.DATABASE_URL })
  const query = (sql, params) => pool.query(sql, params)
  try {
    const sheetId = prov.getObjectSheetId(projectId, objectId)
    const sheet = await query('select id, name from meta_sheets where id = $1', [sheetId])
    if (!sheet.rows.length) {
      console.log(`no sheet ${sheetId} for projectId=${projectId} objectId=${objectId}; nothing to do`)
      return
    }
    console.log(`sheet ${sheetId} (${sheet.rows[0].name}) projectId=${projectId}`)
    const template = tp.sandboxStockPreparationTemplate({ objectId })
    const descriptor = tp.buildStockPreparationTargetDescriptor({ template })
    const have = new Set((await query('select id from meta_fields where sheet_id = $1', [sheetId])).rows.map((r) => r.id))
    const missing = descriptor.fields.filter((f) => !have.has(prov.getObjectFieldId(projectId, objectId, f.id)))
    console.log(`template fields ${descriptor.fields.length}, on sheet ${have.size}, missing ${missing.length}`)
    for (const f of missing) {
      console.log(`  PLAN ${f.id} -> ${prov.getObjectFieldId(projectId, objectId, f.id)} | ${f.name} | ${f.type} | order ${f.order}`)
    }
    if (!missing.length) return
    if (!execute) { console.log('plan only (pass --execute to apply)'); return }
    const res = await prov.ensureMissingObjectFields({ query, projectId, objectId, fields: missing })
    console.log(`added ${res.addedFieldIds.length}, skipped-existing ${res.skippedExistingFieldIds.length}`)
    for (const f of missing) {
      const tf = template.fields.find((x) => x.id === f.id)
      const zh = tf && (tf.labelZh || tf.label)
      if (!zh) continue
      await query('update meta_fields set name = $1, updated_at = now() where id = $2 and sheet_id = $3', [zh, prov.getObjectFieldId(projectId, objectId, f.id), sheetId])
    }
    const count = await query('select count(*)::int as n from meta_fields where sheet_id = $1', [sheetId])
    console.log(`sheet field count now ${count.rows[0].n}`)
  } finally {
    await pool.end()
  }
})().catch((error) => {
  console.error('failed:', error && error.message ? error.message : error)
  process.exit(1)
})

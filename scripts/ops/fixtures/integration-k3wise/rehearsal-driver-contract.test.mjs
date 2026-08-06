#!/usr/bin/env node
// REHEARSAL DRIVER CONTRACT — offline guards for the class of defect that made the source swap
// fail review: strings in the driver that name things which DO NOT EXIST.
//
// Four breaks shipped at once (review 20260805): an adapter kind that was never registered
// (`metasheet:staging-source` vs `metasheet:staging`), a route path that is not mounted
// (`/records` vs `/api/multitable/records`), a request body key the route strips (`fields` vs
// `data`), and field mappings naming the OLD source's columns. Every one is checkable without a
// server, and none was checked — the driver had zero test coverage.
//
// These assertions are deliberately MECHANICAL (compare against the registry / the route table)
// rather than a hand-maintained list, because a hand-maintained list drifts into the same
// fiction the driver did.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const driverPath = path.join(repoRoot, 'scripts/ops/stock-prep-window-rehearsal-driver.mjs')
const driver = fs.readFileSync(driverPath, 'utf8')

test('every adapter kind the driver registers is actually registered by the plugin', () => {
  const pluginIndex = fs.readFileSync(
    path.join(repoRoot, 'plugins/plugin-integration-core/index.cjs'), 'utf8')
  const registered = new Set(
    [...pluginIndex.matchAll(/registerAdapter\('([^']+)'/g)].map((m) => m[1]))
  assert.ok(registered.size >= 3, `registry scan found too little (${registered.size})`)

  const used = [...driver.matchAll(/kind:\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(used.length >= 2, 'the driver must register at least a source and a target')
  for (const kind of used) {
    assert.ok(registered.has(kind),
      `driver uses adapter kind '${kind}', which the plugin never registers. `
      + `Registered: ${[...registered].sort().join(', ')}. `
      + 'external-systems does NOT validate kind, so this passes creation with 201 and only '
      + 'explodes later at createAdapter.')
  }

  // POSITIVE CONTROL — the check must reject a kind that is not in the registry.
  assert.equal(registered.has('metasheet:staging-source'), false,
    'the exact typo this test exists for must still be detectable')
})

test('every API path the driver calls is mounted somewhere in the repo', () => {
  const paths = [...driver.matchAll(/call\('(?:GET|POST|PUT|DELETE)',\s*[`']([^`'$]+)/g)]
    .map((m) => m[1])
    .filter((p) => p.startsWith('/'))
  assert.ok(paths.length >= 4, `path scan found too little (${paths.length})`)

  const routeSources = [
    'plugins/plugin-integration-core/lib/http-routes.cjs',
    'packages/core-backend/src/routes/univer-meta.ts',
  ].map((rel) => {
    try { return fs.readFileSync(path.join(repoRoot, rel), 'utf8') } catch { return '' }
  }).join('\n')
  assert.ok(routeSources.length > 10000, 'route sources did not load — the check would pass vacuously')

  for (const p of paths) {
    // strip the mount prefix the plugin routes carry, and any ${...} segment
    const tail = p.replace(/^\/api\/multitable/, '').replace(/^\/api\/integration/, '')
    const needle = tail.split('/').filter((seg) => seg && !seg.includes('{')).slice(-1)[0]
    if (!needle) continue
    assert.ok(routeSources.includes(needle),
      `driver calls '${p}' but no route source mentions '${needle}'`)
  }

  // POSITIVE CONTROL — a bare '/records' is NOT the mounted path; the real one is prefixed.
  assert.ok(driver.includes('/api/multitable/records'),
    'the record-seeding call must use the mounted path, not a bare /records')
})

test('pipeline fieldMappings name STAGING columns as source, not the K3 target columns', () => {
  const installer = fs.readFileSync(
    path.join(repoRoot, 'plugins/plugin-integration-core/lib/staging-installer.cjs'), 'utf8')
  const stagingBlock = installer.slice(installer.indexOf("id: 'plm_raw_items'"))
  const stagingFields = new Set(
    [...stagingBlock.slice(0, 1200).matchAll(/\{ id: '([A-Za-z_][\w]*)'/g)].map((m) => m[1]))
  assert.ok(stagingFields.has('code') && stagingFields.has('name'),
    'staging field scan failed — the check below would be vacuous')

  const sourceFields = [...driver.matchAll(/sourceField:\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(sourceFields.length >= 2, 'the pipeline must map at least two fields')
  for (const f of sourceFields) {
    assert.ok(stagingFields.has(f),
      `fieldMappings use sourceField '${f}', which is not a column of the staging source `
      + `(plm_raw_items has: ${[...stagingFields].join(', ')}). With the old K3 source these were `
      + 'K3 names; after the swap that yields status=not_applyable with add:0 / failed:N.')
  }
})

test('the seeding call uses the body key the route reads, and fills required columns', () => {
  const seedBlock = driver.slice(driver.indexOf('/api/multitable/records'))
  assert.ok(/\bdata:\s*\{/.test(seedBlock.slice(0, 600)),
    "the record body key must be `data` — the route's zod schema strips unknown keys, so `fields` "
    + 'would have written EMPTY rows and read as a clean pass')
  for (const required of ['sourceSystemId', 'objectType', 'sourceId']) {
    assert.ok(seedBlock.slice(0, 600).includes(required),
      `plm_raw_items marks '${required}' required; omitting it fails the row`)
  }
})

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
  const paths = [...driver.matchAll(/call\('(?:GET|POST|PUT|DELETE)',\s*[`']([^`'$?]+)/g)]
    .map((m) => m[1])
    .filter((p) => p.startsWith('/'))
  assert.ok(paths.length >= 6, `path scan found too little (${paths.length})`)

  const routeSources = [
    'plugins/plugin-integration-core/lib/http-routes.cjs',
    'packages/core-backend/src/routes/univer-meta.ts',
    'packages/core-backend/src/routes/api-tokens.ts',
  ].map((rel) => {
    try { return fs.readFileSync(path.join(repoRoot, rel), 'utf8') } catch { return '' }
  }).join('\n')
  assert.ok(routeSources.length > 10000, 'route sources did not load — the check would be vacuous')

  for (const p of paths) {
    const tail = p.replace(/^\/api\/multitable/, '').replace(/^\/api\/integration/, '')
    const needle = tail.split('/').filter((seg) => seg && !seg.includes('{')).slice(-1)[0]
    if (!needle) continue
    assert.ok(routeSources.includes(needle),
      `driver calls '${p}' but no route source mentions '${needle}'`)
  }

  // The two multitable calls MUST carry the /api/multitable mount — a bare path is not routed.
  for (const bare of ["'/records'", "'/fields'", "'/api-tokens'"]) {
    assert.equal(driver.includes(`call('POST', ${bare}`) || driver.includes(`call('GET', ${bare}`), false,
      `${bare} is not a mounted path; it must be prefixed with /api/multitable`)
  }
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

test('the seeding body is keyed through the RESOLVED PHYSICAL map, not logical names', () => {
  // Owner + review 20260805: the previous version of this test was `includes('sourceSystemId')`,
  // which the BROKEN body satisfied too — it scored 4/4 while the driver sent logical names and
  // the route answered 400 `Unknown fieldId`. `ensureObject` rewrites every field id to
  // `fld_<sha1>`, so logical names are never valid runtime keys.
  const seedBlock = driver.slice(driver.indexOf('/api/multitable/records'))
  const head = seedBlock.slice(0, 900)

  assert.ok(/\bdata:\s*Object\.fromEntries/.test(head),
    'the body must be BUILT from the resolved map, not written as a literal of logical names')
  assert.ok(/physicalByName\[/.test(head),
    'each key must be looked up in the physical map the server returned')

  // And the map must come from the server, not be assumed.
  assert.ok(/\/api\/multitable\/fields\?sheetId=/.test(driver),
    'the physical map must be FETCHED (GET /api/multitable/fields), never inferred')

  // POSITIVE CONTROL — the old, broken shape must NOT satisfy this test.
  const brokenShape = "data: {\n  sourceSystemId: 'x',\n  code: 'y',\n}"
  assert.equal(/\bdata:\s*Object\.fromEntries/.test(brokenShape), false,
    'a literal logical-name body must fail this assertion — otherwise it pins nothing')
})

test("the driver's OWN staging config carries projectId and a provisioned objectId", () => {
  // Mutations M1/M2 exposed this: the behavioural test builds its own config, so the DRIVER's
  // config was unguarded — dropping projectId or renaming the object key left the suite green
  // while reproducing the exact reported failure. Wire-vs-fixture drift, inside the guard added
  // to stop wire-vs-fixture drift.
  const cfgBlock = driver.slice(driver.indexOf("kind: 'metasheet:staging'"))
  const head = cfgBlock.slice(0, 900)

  assert.ok(/projectId:\s*stagingProjectId/.test(head),
    'the staging source config must pass projectId — resolveProvisionedFieldIdMap returns {} '
    + 'without it, and read() then yields raw fld_* keys with code/name empty')
  assert.ok(/stagingProjectId\s*=\s*payload\(stagingInstall\)/.test(driver),
    'projectId must come from the staging/install response, not be hardcoded')

  // The objects KEY must be a descriptor the installer actually provisions.
  const installer = fs.readFileSync(
    path.join(repoRoot, 'plugins/plugin-integration-core/lib/staging-installer.cjs'), 'utf8')
  const provisioned = new Set(
    [...installer.matchAll(/^\s*id: '([a-z_]+)',\s*$/gm)].map((m) => m[1]))
  assert.ok(provisioned.has('plm_raw_items'),
    'descriptor scan failed — the assertion below would be vacuous')

  const objectKey = (head.match(/objects:\s*\{[^]*?([a-z_]+):\s*\{/) || [])[1]
  assert.ok(objectKey, 'could not read the objects key from the driver')
  assert.ok(provisioned.has(objectKey),
    `driver keys its staging object '${objectKey}', which the installer never provisions `
    + `(provisioned: ${[...provisioned].join(', ')}). resolveProvisionedFieldIdMap looks up `
    + '(projectId, objectId), so a wrong key silently yields an EMPTY alias map.')

  // and the pipeline must select that same object
  assert.ok(driver.includes(`sourceObject: '${objectKey}'`),
    `the pipeline's sourceObject must match the staging objects key ('${objectKey}')`)
})

test('BEHAVIOURAL: a bare read yields LOGICAL keys only when projectId + objectId are right', async () => {
  // The source-regex assertions above are necessary but NOT sufficient: they were 4/4 green while
  // a bare read returned raw `fld_*` keys with code/name EMPTY. `ensureObject` rewrites every
  // field id to `fld_<sha1>`, so the alias map is the ONLY thing that makes rows mappable, and it
  // resolves on (projectId, objectId). A grep cannot see that. This exercises the real adapter.
  const { createMetaSheetStagingSourceAdapter } = require(path.join(repoRoot,
    'plugins/plugin-integration-core/lib/adapters/metasheet-staging-source-adapter.cjs'))

  const PHYSICAL = { code: 'fld_code_sha', name: 'fld_name_sha' }
  const rows = [
    { id: 'rec_1', data: { [PHYSICAL.code]: 'MAT-RH-001', [PHYSICAL.name]: 'A' } },
    { id: 'rec_2', data: { [PHYSICAL.code]: 'MAT-RH-002', [PHYSICAL.name]: 'B' } },
  ]
  const context = { api: { multitable: {
    records: { async queryRecords() { return rows } },
    // Mirrors provisioning: it answers ONLY for the object it provisioned.
    provisioning: { async resolveFieldIds({ objectId, fieldIds }) {
      if (objectId !== 'plm_raw_items') return {}
      return Object.fromEntries(fieldIds.filter((f) => PHYSICAL[f]).map((f) => [f, PHYSICAL[f]]))
    } },
  } } }
  const mk = (config) => createMetaSheetStagingSourceAdapter({
    system: { kind: 'metasheet:staging', config }, context })

  const good = await mk({
    projectId: 'proj_1',
    objects: { plm_raw_items: { sheetId: 'sht_1', fields: ['code', 'name'] } },
  }).read({ object: 'plm_raw_items', limit: 10, cursor: null })
  assert.equal(good.records.length, 2, 'the bare read must return the seeded rows')
  assert.equal(good.records[0].code, 'MAT-RH-001', 'logical `code` must resolve')
  assert.equal(good.records[0].name, 'A', 'logical `name` must resolve')

  // POSITIVE CONTROLS — each omission reproduces the reported symptom exactly.
  const noProject = await mk({
    objects: { plm_raw_items: { sheetId: 'sht_1', fields: ['code', 'name'] } },
  }).read({ object: 'plm_raw_items', limit: 10, cursor: null })
  assert.equal(noProject.records[0].code, undefined, 'no projectId -> empty alias map')

  const wrongObject = await mk({
    projectId: 'proj_1',
    objects: { material: { sheetId: 'sht_1', fields: ['code', 'name'] } },
  }).read({ object: 'material', limit: 10, cursor: null })
  assert.equal(wrongObject.records[0].code, undefined,
    'objectId `material` was never provisioned -> empty alias map (the driver\'s original bug)')
  assert.equal(wrongObject.records[0][PHYSICAL.code], 'MAT-RH-001',
    'and the raw physical key is what comes through instead')
})

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

// The plm_raw_items descriptor's field ids, bounded at the END OF ITS fields[] ARRAY.
// A fixed-width slice (the previous `slice(0, 1200)`) runs past the descriptor and swallows
// standard_materials' columns, so `uom`/`category`/`status` scored as valid plm_raw_items fields —
// the scan was wider than the object it claimed to describe, and would have accepted a field id
// that hashes to a phantom on THIS object.
function rawItemsFieldIds(installerSrc) {
  const start = installerSrc.indexOf("id: 'plm_raw_items'")
  if (start < 0) throw new Error('plm_raw_items descriptor not found')
  const fieldsAt = installerSrc.indexOf('fields: [', start)
  const end = installerSrc.indexOf('\n    ],', fieldsAt)
  if (fieldsAt < 0 || end < 0) throw new Error('plm_raw_items fields[] not delimited as expected')
  const block = installerSrc.slice(fieldsAt, end)
  return new Set([...block.matchAll(/\{ id: '([A-Za-z_][\w]*)'/g)].map((m) => m[1]))
}

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
  const stagingFields = rawItemsFieldIds(installer)
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
  // Mutations M1/M2/T5 exposed this: the behavioural test builds its own config, so the DRIVER's
  // config was unguarded — dropping projectId, renaming the object key, or dropping the install
  // assertion all stayed green while reproducing the exact reported failure.
  const installerSrc = fs.readFileSync(
    path.join(repoRoot, 'plugins/plugin-integration-core/lib/staging-installer.cjs'), 'utf8')
  const provisioned = new Set(
    [...installerSrc.matchAll(/^\s*id: '([a-z_]+)',\s*$/gm)].map((m) => m[1]))
  assert.ok(provisioned.has('plm_raw_items'),
    'descriptor scan failed — every assertion below would be vacuous')

  // Scoped to the plm_raw_items block: a bare repo-wide scan would accept a field id borrowed
  // from standard_materials / bom_cleanse, which is a DIFFERENT object and hashes differently.
  const descriptorFieldIds = rawItemsFieldIds(installerSrc)
  assert.ok(descriptorFieldIds.has('code') && descriptorFieldIds.has('sourceSystemId'),
    'plm_raw_items field scan failed — the config.fields check would be vacuous')
  // NEGATIVE control on the SCAN ITSELF: `category` is a standard_materials column. If it appears
  // here, the slice has run past the descriptor and the check below is wider than it claims.
  assert.equal(descriptorFieldIds.has('category'), false,
    'the field scan leaked into a neighbouring descriptor — it no longer describes plm_raw_items')

  const cfgBlock = driver.slice(driver.indexOf("kind: 'metasheet:staging'"))
  const head = cfgBlock.slice(0, 900)

  assert.ok(/projectId:\s*stagingProjectId/.test(head),
    'the staging config must pass projectId — resolveProvisionedFieldIdMap returns {} without it, '
    + 'and read() then yields raw fld_* keys with code/name empty')
  assert.ok(/stagingProjectId\s*=\s*payload\(stagingInstall\)/.test(driver),
    'projectId must come from the staging/install response, not be hardcoded')

  // T5: a null projectId is INVISIBLE downstream (key present, alias map empty, dry-run add:0),
  // so it has to fail at the step that obtains it.
  const installIdx = driver.indexOf("record('staging-install'")
  assert.ok(/Boolean\(stagingProjectId\)/.test(driver.slice(installIdx, installIdx + 400)),
    'staging-install must FAIL when projectId is absent, not merely record sheetId')

  const objectKey = (head.match(/objects:\s*\{[^]*?([a-z_]+):\s*\{/) || [])[1]
  assert.ok(objectKey, 'could not read the objects key from the driver')
  assert.ok(provisioned.has(objectKey),
    `driver keys its staging object '${objectKey}', which the installer never provisions `
    + `(provisioned: ${[...provisioned].join(', ')}). resolveProvisionedFieldIdMap looks up `
    + '(projectId, objectId), so a wrong key silently yields an EMPTY alias map.')
  assert.ok(driver.includes(`sourceObject: '${objectKey}'`),
    `the pipeline's sourceObject must match the staging objects key ('${objectKey}')`)

  // The OTHER leg of the same join, and the one that fails SILENTLY. config.fields feeds
  // logicalFieldNames() -> resolveFieldIds(), and resolveObjectFieldIds is COMPUTE-ONLY:
  // `resolved[fieldId] = stableMetaId('fld', projectId, objectId, fieldId)` for whatever it is
  // handed (provisioning.ts:150-160; core-backend/src/index.ts:599 says so outright — "compute-only
  // and never omits a field"). A logical id that does not exist therefore yields a WELL-FORMED hash
  // for a field that was never provisioned: invertFieldIdMap aliases that phantom id, the real
  // fld_* key in the row matches nothing, and the column simply reads as absent. No error anywhere.
  // Anchored on the object block, not `head` — the config carries long explanatory comments, so a
  // fixed-width window from `kind:` ends before fields[] and the scan reads as absent.
  const objectBlock = cfgBlock.slice(cfgBlock.indexOf(`${objectKey}: {`))
  const configFieldsRaw = (objectBlock.slice(0, 600).match(/fields:\s*\[([^\]]*)\]/) || [])[1]
  assert.ok(configFieldsRaw, "could not read the staging config's fields[] from the driver")
  const configFields = [...configFieldsRaw.matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(configFields.length >= 2, 'staging config must declare at least two logical fields')
  for (const f of configFields) {
    assert.ok(descriptorFieldIds.has(f),
      `staging config declares logical field '${f}', which plm_raw_items does not define `
      + `(has: ${[...descriptorFieldIds].join(', ')}). resolveFieldIds would hash it anyway, so `
      + 'this fails SILENTLY as an empty column rather than as an error.')
  }

  // P2-2 cross-namespace join: the seed resolves by DISPLAY NAME, the adapter by LOGICAL id.
  // They agree only because ensureObject writes both onto one field, so pin the seed's lookup
  // keys to the installer's display names — an i18n/rename then breaks HERE, loudly.
  const seedHead = driver.slice(driver.indexOf('/api/multitable/records'), driver.indexOf('/api/multitable/records') + 900)
  for (const displayName of ['Source System', 'Object Type', 'Source ID', 'Code', 'Name']) {
    assert.ok(installerSrc.includes(`name: '${displayName}'`),
      `installer no longer declares display name '${displayName}' — the seed's lookup key is stale`)
    assert.ok(seedHead.includes(displayName),
      `seed must key on the installer's display name '${displayName}'`)
  }
})

test('credentials are read from the field the route RETURNS, and shape-checked', () => {
  // THE META-FINDING of review r4: switching the driver to the CORRECT `.plaintext` left this
  // suite 6/6 green. The guards caught the previous round's bug and were blind to this one — a
  // test battery that only pins yesterday's defect.
  //
  // `POST /api/multitable/api-tokens` returns `{data:{token:<METADATA OBJECT>, plaintext:'mst_…'}}`.
  // Reading `.token` yields a truthy OBJECT: the mint step reports PASS, then every later request
  // sends `Bearer [object Object]` and 401s. False green, then deterministic failure.
  const routeSrc = fs.readFileSync(
    path.join(repoRoot, 'packages/core-backend/src/routes/api-tokens.ts'), 'utf8')
  assert.ok(/plaintext:\s*result\.plainTextToken/.test(routeSrc),
    'route scan failed — the assertions below would be vacuous')

  const mintBlock = driver.slice(driver.indexOf('/api/multitable/api-tokens'))
  const head = mintBlock.slice(0, 800)
  assert.ok(/payload\(tokenMint\)\?\.plaintext/.test(head),
    'the credential must be read from `.plaintext` — `.token` is the metadata object')
  assert.equal(/payload\(tokenMint\)\?\.token\b/.test(head), false,
    '`.token` is the ApiToken record, not a usable bearer credential')

  // Truthiness is not enough: an object is truthy. Assert the SHAPE the auth layer routes on.
  assert.ok(/startsWith\('mst_'\)/.test(head),
    "apiTokenAuth routes on the `mst_` prefix; anything else falls through to the JWT path, so "
    + 'the mint step must verify the prefix rather than mere truthiness')

  // POSITIVE CONTROL — the old broken read must fail this test.
  const brokenMint = "const T = payload(tokenMint)?.token || ''"
  assert.equal(/\?\.plaintext/.test(brokenMint), false,
    'the previous broken shape must not satisfy this assertion — otherwise it pins nothing')
})

test('no silent credential fallback, and no silent field-map degradation', () => {
  // Review P2-1: `opts.token || TOKEN` fell back to the admin JWT whenever the minted token was
  // empty — and `requireScope` PASSES a request carrying no apiTokenScopes, so the lane could not
  // distinguish "the minted token works" from "the fallback rescued it". A rehearsal that cannot
  // tell those apart is not evidence about the minted token at all.
  assert.equal(/opts\.token \|\| TOKEN/.test(driver), false,
    'the `||` fallback silently swaps identity to admin; use an explicit presence check')
  assert.ok(/hasOwnProperty\.call\(opts, 'token'\)/.test(driver),
    'an explicitly-passed token must be used as-is, even if empty, so failures surface')

  // Same shape one level down: an unmapped field silently became its own label, which the route
  // then rejects as an unknown fieldId — or worse, accepts into the wrong column.
  assert.equal(/physicalByName\[label\] \|\| label/.test(driver), false,
    'a missing physical mapping must not degrade to the literal label')
  assert.ok(/__UNMAPPED__/.test(driver),
    'an unmapped field must produce a loud, unmistakable key rather than a plausible one')
})

test('the mock arms its session gate and its call logger — both are load-bearing', () => {
  // Review P2-6: `requireSession: true` in run-mock-k3-server.mjs is the ONLY thing arming owner
  // HOLD point F, and nothing pinned it. Deleting one word would let the whole lane pass "clean"
  // against a permissive mock — a green that means nothing. Same for the logger: the workflow's
  // save-only allowlist reads mock-k3.log, so a mock that logs nothing makes that check vacuous
  // (which is exactly what owner point E caught the first time).
  const runner = fs.readFileSync(
    path.join(repoRoot, 'scripts/ops/fixtures/integration-k3wise/run-mock-k3-server.mjs'), 'utf8')

  assert.ok(/requireSession:\s*true/.test(runner),
    'the rehearsal mock MUST require a session; without it the lane rehearses against a mock that '
    + 'accepts anything, and owner HOLD point F is unarmed')
  // Must match the EMITTING CALL, not the word anywhere: the file's own header comment says
  // "K3CALL", so a bare /K3CALL/ passed while the logger body had been replaced with `void call`.
  // Third prose-matched-instead-of-code slip in this session.
  assert.ok(/console\.log\([^)]*K3CALL/.test(runner),
    'the mock MUST actually EMIT K3CALL <METHOD> <pathname>; the workflow save-only allowlist greps '
    + 'that stream, and an empty stream passes an absence check vacuously')

  // POSITIVE CONTROL — the assertions must be able to fail.
  assert.equal(/requireSession:\s*true/.test('const server = createMockK3WebApiServer({ seedListRows })'), false,
    'the session assertion must reject a runner that omits the flag')
  assert.equal(/console\.log\([^)]*K3CALL/.test('logger: (call) => { void call }'), false,
    'the logger assertion must reject a runner whose logger emits nothing')
})

// Extract a record() step's pass-predicate by BALANCED SCAN, not by splitting on commas.
// A comma-split reads the wrong span for any predicate containing a call or an index expression --
// the first attempt at this parsed only 8 of the 17 steps and silently exempted the other 9.
function predicateOf(src, step) {
  const key = `record('${step}'`
  const at = src.indexOf(key)
  assert.ok(at >= 0, `step '${step}' is not in the driver`)
  let i = src.indexOf(',', at + key.length) + 1
  const start = i
  let depth = 0
  let quote = null
  for (; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '(' || c === '[' || c === '{') { depth++; continue }
    if (c === ')' || c === ']' || c === '}') { depth--; continue }
    if (c === ',' && depth === 0) break
  }
  return src.slice(start, i).replace(/\s+/g, ' ').trim()
}

// POSITIVE MANIFEST: what each step's predicate MUST assert.
//
// The previous version of this guard was a DENYLIST of four literals
// (/^(true|1|!!1|Boolean\(true\))$/). Independent review broke it in one line: the review
// substituted `dryRunOut !== undefined` for the dry-run predicate and this suite stayed 10/10
// GREEN -- degrading the ONE step that carries the owner's entire P1 (empty code/name would print
// a tick). `1 === 1` passed too. That is the documented failure of trap enumeration: every round
// of blocking known-bad forms leaves a fresh channel, because the complement of a denylist is
// unbounded. The converging form is a positive allowlist, so this is now one.
//
// Weakening any predicate below now requires EDITING THIS TABLE -- a visible, reviewable act --
// rather than quietly satisfying a pattern nobody re-reads.
const REQUIRED_DISCRIMINATORS = {
  'create-source-system': ['ok(sourceSystem)', 'payload(sourceSystem)?.id'],
  'create-target-system': ['ok(targetSystem)', 'payload(targetSystem)?.id'],
  'staging-install': ['ok(stagingInstall)', 'stagingSheetId', 'stagingProjectId'],
  'create-staging-source': ['ok(sourceStagingSystem)', 'payload(sourceStagingSystem)?.id'],
  'mint-seed-token': ['ok(tokenMint)', 'mintedTokenUsable'],
  'resolve-staging-field-map': ['ok(fieldsRes)', 'Object.keys(physicalByName).length > 0'],
  'seed-staging-rows': ['seeded.length === seedRows.length', 'seeded.every(Boolean)'],
  'b4-mint': ['ok(b4Mint)', 'b4Row?.id'],
  'b4-approve': ['ok(b4Approve)', "=== 'approved'"],
  'preflight-list-shape-probe': ['listProbeEvidence.ok === true', "typeof listRowCountKey === 'string'"],
  'preflight-list-read-smoke': [
    'listSmoke.status === 200',
    'listEvidence?.ok === true',
    'listEvidence?.[listRowCountKey] === SOURCE_KEYS.length',
  ],
  'create-pipeline': ['ok(pipeline)', 'payload(pipeline)?.id'],
  // The load-bearing one. This step is the PR's substitute for the owner's discrete "bare read"
  // step AND the sole runtime discriminator for empty code/name, so every conjunct is pinned.
  'dry-run': [
    'ok(dryRun)',
    "dryRunOut?.status === 'ready'",
    "typeof dryRunOut?.dryRunToken === 'string'",
    'dryRunOut?.counts?.sourceRows === SOURCE_KEYS.length',
    'dryRunOut?.counts?.add === SOURCE_KEYS.length',
  ],
  'apply': [
    'ok(apply)',
    'applyOut?.counts?.written === SOURCE_KEYS.length',
    '(applyOut?.counts?.failed ?? 0) === 0',
  ],
  'token-single-use': ['replayToken.status === 409', "'C6_WRITE_DRY_RUN_TOKEN_INVALID'"],
  'read-back-written-key': [
    'readBack.status === 200',
    'readBackEvidence?.ok === true',
    'readBackEvidence?.recordPresent === true',
    'readBackEvidence?.recordCount === 1',
  ],
  'read-back-negative-control': [
    'readBackMiss.status === 200',
    'missEvidence?.ok === false',
    "missEvidence?.errorCode === 'K3_WISE_READ_BUSINESS_ERROR'",
  ],
}

test('every record() step asserts its NAMED discriminators — positive manifest, not a denylist', () => {
  const declared = [...driver.matchAll(/record\('([a-z0-9-]+)'/g)].map((m) => m[1])
  assert.ok(declared.length >= 15, `only ${declared.length} steps found — scan is broken`)

  // The manifest must cover EVERY step, in both directions. A step missing from the table would
  // be silently unguarded; a table entry with no step means the table is describing a driver that
  // no longer exists.
  assert.deepEqual(
    declared.filter((s) => !(s in REQUIRED_DISCRIMINATORS)), [],
    'these driver steps have no manifest entry and are therefore unguarded')
  assert.deepEqual(
    Object.keys(REQUIRED_DISCRIMINATORS).filter((s) => !declared.includes(s)), [],
    'these manifest entries name steps the driver no longer has')

  for (const step of declared) {
    const predicate = predicateOf(driver, step)
    assert.ok(predicate.length > 0, `step '${step}' has an empty predicate`)
    for (const needle of REQUIRED_DISCRIMINATORS[step]) {
      assert.ok(predicate.includes(needle),
        `step '${step}' no longer asserts ${JSON.stringify(needle)}\n    predicate is: ${predicate}`)
    }
  }

  // NEGATIVE CONTROL on the checker itself: the exact degradations that defeated the denylist
  // must now be caught. If these ever stop being rejected, this guard has regressed to a denylist.
  const fakeDriver = "record('dry-run',\n  dryRunOut !== undefined,\n  { a: 1 })"
  assert.equal(predicateOf(fakeDriver, 'dry-run'), 'dryRunOut !== undefined',
    'the balanced scanner must read the whole predicate span')
  for (const needle of REQUIRED_DISCRIMINATORS['dry-run']) {
    assert.equal(predicateOf(fakeDriver, 'dry-run').includes(needle), false,
      `the review's neutering mutation must FAIL the manifest (needle ${needle})`)
  }
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

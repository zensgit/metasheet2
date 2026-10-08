import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  DeriveTargetBindingError,
  META_ID_HASH,
  META_ID_HEX_LENGTH,
  deriveTargetBinding,
  extensionFieldIdsFromPack,
  getObjectFieldId,
  getObjectSheetId,
  integrationCoreProjectId,
  parseArgs,
} from './stock-preparation-derive-target-binding.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(HERE, 'stock-preparation-derive-target-binding.mjs')
const PROVISIONING_TS = path.join(REPO_ROOT, 'packages', 'core-backend', 'src', 'multitable', 'provisioning.ts')

// A REAL, verified binding. These ids were derived offline by this script and
// then confirmed against the `meta_fields` rows of a live locally-provisioned
// sandbox sheet — so the pin proves the script agrees with what the host
// actually allocated, not merely with itself.
const KNOWN = {
  tenantId: 'tenant-dev',
  projectId: 'tenant-dev:integration-core',
  objectId: 'plm_stock_preparation_sandbox_m0',
  sheetId: 'sheet_afd5fedf10cf0bb07b8702f2',
  fields: {
    projectNo: 'fld_754d4b2aae66f61d5afcbe54',
    idempotencyKey: 'fld_1557155ec8d87025848939dc',
    rawQuantity: 'fld_53fc913d8285bbc4c4b78ea2',
    warehouseConfirmation: 'fld_9e5643e07e9525169c1c3d14',
  },
}

test('pins a known-good (projectId, objectId, fieldId) -> physical id triple', () => {
  for (const [fieldId, expected] of Object.entries(KNOWN.fields)) {
    assert.equal(
      getObjectFieldId(KNOWN.projectId, KNOWN.objectId, fieldId),
      expected,
      `${fieldId} must derive to its verified physical id`,
    )
  }
  assert.equal(getObjectSheetId(KNOWN.projectId, KNOWN.objectId), KNOWN.sheetId)
  assert.equal(integrationCoreProjectId(KNOWN.tenantId), KNOWN.projectId)
})

// The algorithm lives in TypeScript and is mirrored here because this script
// must run under plain node. That mirror is the one thing that can silently
// drift, so it is pinned against the source rather than trusted.
test('mirrors the host id algorithm in provisioning.ts', () => {
  const source = fs.readFileSync(PROVISIONING_TS, 'utf8')
  const fn = /function stableMetaId\(prefix: string, \.\.\.parts: string\[\]\): string \{([\s\S]*?)\n\}/.exec(source)
  assert.ok(fn, 'stableMetaId must still exist in provisioning.ts')
  const body = fn[1]

  assert.ok(body.includes(`createHash('${META_ID_HASH}')`), `host must still hash with ${META_ID_HASH}`)
  assert.ok(body.includes(".update(parts.join(':'))"), "host must still join parts with ':'")
  assert.ok(body.includes(`.slice(0, ${META_ID_HEX_LENGTH})`), `host must still take ${META_ID_HEX_LENGTH} hex chars`)
  assert.ok(/return `\$\{prefix\}_\$\{digest\}`\.slice\(0, 50\)/.test(body), 'host must still prefix and cap at 50')

  // ...and the two call shapes this script reproduces.
  assert.ok(
    /getObjectFieldId\(projectId: string, objectId: string, fieldId: string\): string \{\s*return stableMetaId\('fld', projectId, objectId, fieldId\)/.test(source),
    'getObjectFieldId must still be stableMetaId(fld, projectId, objectId, fieldId)',
  )
  assert.ok(
    /getObjectSheetId\(projectId: string, objectId: string\): string \{\s*return stableMetaId\('sheet', projectId, objectId\)/.test(source),
    'getObjectSheetId must still be stableMetaId(sheet, projectId, objectId)',
  )
})

test('binds every frozen template column', () => {
  const derived = deriveTargetBinding({ tenantId: KNOWN.tenantId, objectId: KNOWN.objectId })
  assert.equal(derived.counts.templateFields, 25, 'the frozen template is 25 columns')
  assert.equal(derived.counts.bound, 25)
  assert.equal(derived.target.keyField, 'idempotencyKey')
  assert.equal(derived.target.sheetId, KNOWN.sheetId)
  assert.equal(derived.target.objectId, KNOWN.objectId)
  assert.equal(Object.keys(derived.target.fieldIdMap).length, 25)
  // Every value is a distinct, well-shaped physical id.
  const ids = Object.values(derived.target.fieldIdMap)
  assert.equal(new Set(ids).size, 25, 'physical ids must be distinct')
  for (const id of ids) assert.match(id, /^fld_[0-9a-f]{24}$/)
})

test('a different object yields a different binding for the same field', () => {
  const a = deriveTargetBinding({ tenantId: KNOWN.tenantId, objectId: KNOWN.objectId })
  const b = deriveTargetBinding({ tenantId: KNOWN.tenantId, objectId: 'plm_stock_preparation_sandbox_other' })
  assert.notEqual(a.target.fieldIdMap.projectNo, b.target.fieldIdMap.projectNo)
  assert.notEqual(a.target.sheetId, b.target.sheetId)
  // ...which is exactly why a logical id is not a label: renaming it addresses a
  // different column rather than renaming one.
})

test('an explicit projectId overrides the tenant-derived one', () => {
  const derived = deriveTargetBinding({ projectId: 'other:integration-core', objectId: KNOWN.objectId })
  assert.equal(derived.projectId, 'other:integration-core')
  assert.notEqual(derived.target.fieldIdMap.projectNo, KNOWN.fields.projectNo)
})

test('requires tenantId or projectId, and an objectId', () => {
  assert.throws(() => deriveTargetBinding({ objectId: KNOWN.objectId }), (e) => e.code === 'INPUT_INVALID')
  assert.throws(() => deriveTargetBinding({ tenantId: KNOWN.tenantId }), (e) => e.code === 'INPUT_INVALID')
  assert.throws(() => deriveTargetBinding({ tenantId: '  ', objectId: KNOWN.objectId }), (e) => e.code === 'INPUT_INVALID')
})

// --------------------------------------------------------------------------
// Pack integration
// --------------------------------------------------------------------------
const SANDBOX_PACK = {
  packId: 'derive-probe',
  packVersion: 3,
  targetObjectId: KNOWN.objectId,
  extensionFields: [
    { id: 'ext_deriveOne', label: '派生一', type: 'string', ownership: 'plm_system' },
    { id: 'ext_deriveTwo', label: '派生二', type: 'number', ownership: 'human_preserved' },
  ],
}

test('adds the pack ext_ columns to the map, in both file shapes', () => {
  for (const content of [
    JSON.stringify(SANDBOX_PACK),                                // bare pack
    JSON.stringify({ 'derive-probe': SANDBOX_PACK }),            // catalog file
  ]) {
    const info = extensionFieldIdsFromPack(content, { objectId: KNOWN.objectId })
    assert.deepEqual(info.extensionFieldIds, ['ext_deriveOne', 'ext_deriveTwo'])
    assert.equal(info.packId, 'derive-probe')
    assert.equal(info.packVersion, 3)
    assert.equal(info.targetObjectId, KNOWN.objectId)

    const derived = deriveTargetBinding({
      tenantId: KNOWN.tenantId,
      objectId: KNOWN.objectId,
      extensionFieldIds: info.extensionFieldIds,
    })
    assert.equal(derived.counts.bound, 27, '25 template + 2 pack columns')
    // The canonical half is untouched by the pack half.
    assert.equal(derived.target.fieldIdMap.projectNo, KNOWN.fields.projectNo)
    assert.match(derived.target.fieldIdMap.ext_deriveOne, /^fld_[0-9a-f]{24}$/)
    assert.equal(
      derived.target.fieldIdMap.ext_deriveOne,
      getObjectFieldId(KNOWN.projectId, KNOWN.objectId, 'ext_deriveOne'),
    )
  }
})

test('refuses a pack that installs onto a different object', () => {
  // The disjoint-sets failure in miniature: binding ids for one object while the
  // pack creates columns on another would produce a map addressing nothing.
  assert.throws(
    () => extensionFieldIdsFromPack(JSON.stringify(SANDBOX_PACK), { objectId: 'plm_stock_preparation_sandbox_elsewhere' }),
    (error) => error instanceof DeriveTargetBindingError
      && error.code === 'PACK_TARGET_MISMATCH'
      && error.details.packTargetObjectId === KNOWN.objectId,
  )
})

test('refuses a malformed pack with the normalizer own reason', () => {
  const bad = { ...SANDBOX_PACK, targetObjectId: 'plm_stock_preparation_evil' }
  assert.throws(
    () => extensionFieldIdsFromPack(JSON.stringify(bad), {}),
    (error) => error.code === 'PACK_INVALID' && error.details.reason === 'PACK_TARGET_OBJECT_ID_INVALID',
  )
  assert.throws(() => extensionFieldIdsFromPack('not json', {}), (e) => e.code === 'PACK_FILE_INVALID')
  assert.throws(() => extensionFieldIdsFromPack('[]', {}), (e) => e.code === 'PACK_FILE_INVALID')
  assert.throws(() => extensionFieldIdsFromPack('{}', {}), (e) => e.code === 'PACK_FILE_INVALID')
})

test('needs a --pack-id when the file holds several packs', () => {
  const two = JSON.stringify({
    'derive-probe': SANDBOX_PACK,
    'derive-other': { ...SANDBOX_PACK, packId: 'derive-other' },
  })
  assert.throws(() => extensionFieldIdsFromPack(two, {}), (e) => e.code === 'PACK_ID_REQUIRED')
  assert.equal(extensionFieldIdsFromPack(two, { packId: 'derive-other' }).packId, 'derive-other')
  assert.throws(
    () => extensionFieldIdsFromPack(two, { packId: 'absent' }),
    (e) => e.code === 'PACK_NOT_FOUND',
  )
})

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
test('parses flags and rejects malformed ones', () => {
  assert.deepEqual(
    parseArgs(['--tenant-id', 't', '--object-id', 'o', '--compact']),
    { 'tenant-id': 't', 'object-id': 'o', compact: true },
  )
  assert.throws(() => parseArgs(['--tenant-id']), (e) => e.code === 'INPUT_INVALID')
  assert.throws(() => parseArgs(['--tenant-id', '--object-id']), (e) => e.code === 'INPUT_INVALID')
  assert.throws(() => parseArgs(['loose']), (e) => e.code === 'INPUT_INVALID')
})

test('emits a clean JSON target block on stdout', () => {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, '--tenant-id', KNOWN.tenantId, '--object-id', KNOWN.objectId],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.sheetId, KNOWN.sheetId)
  assert.equal(parsed.keyField, 'idempotencyKey')
  assert.equal(Object.keys(parsed.fieldIdMap).length, 25)
  assert.equal(parsed.fieldIdMap.projectNo, KNOWN.fields.projectNo)
})

test('--action-fragment emits both halves an action config needs', (t) => {
  const packFile = path.join(
    fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '.', 'derive-pack-')),
    'packs.json',
  )
  fs.writeFileSync(packFile, JSON.stringify({ 'derive-probe': SANDBOX_PACK }), 'utf8')
  t.after(() => fs.rmSync(path.dirname(packFile), { recursive: true, force: true }))

  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, '--tenant-id', KNOWN.tenantId, '--object-id', KNOWN.objectId, '--pack', packFile, '--action-fragment'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const parsed = JSON.parse(stdout)
  assert.deepEqual(parsed.extensionFieldIds, ['ext_deriveOne', 'ext_deriveTwo'])
  assert.equal(Object.keys(parsed.target.fieldIdMap).length, 27)
  // The two halves agree: everything declared is bound. This is precisely what
  // assertTargetFieldMapCompleteness checks at dry-run time.
  for (const fieldId of parsed.extensionFieldIds) {
    assert.ok(parsed.target.fieldIdMap[fieldId], `${fieldId} must be bound`)
  }
})

test('--compact emits single-line JSON for an env var', () => {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, '--tenant-id', KNOWN.tenantId, '--object-id', KNOWN.objectId, '--compact'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  assert.equal(stdout.trim().includes('\n'), false, 'compact output must be one line')
  assert.equal(JSON.parse(stdout).sheetId, KNOWN.sheetId)
})

test('reads no database and no network', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8')
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'node:dns', "require('pg')", 'mssql', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, `the script must not reference ${forbidden}`)
  }
})

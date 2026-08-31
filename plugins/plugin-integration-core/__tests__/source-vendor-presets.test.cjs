'use strict'

/**
 * SOURCE VENDOR PRESET CATALOG — schema validation, poison rejection, signature selection.
 *
 * Three guarantees under test (each mutation-witnessed in the PR):
 *   1. VALIDATOR — a well-formed preset passes; every refusal leg fires with its coded reason,
 *      and the reason NAMES the acceptable form (this repo's refusals must state what would be
 *      accepted, not merely that something was not).
 *   2. POISON — a preset carrying a connection string, bare IP, credential path, probe-env
 *      assignment, a value-carrier key, or a CONCRETE member of a declared generic column family
 *      (a discovered per-customer fact) is REJECTED naming the offending path — and without
 *      echoing the offending content into the error.
 *   3. SIGNATURE FAIL-CLOSED — the synthetic fixture's table list selects the dn-pdm preset; a
 *      random table list, and a below-floor near-miss, select NOTHING (no best guess); an
 *      ambiguous tie selects nothing.
 *
 * Hermetic: reads the committed preset + fixture files, writes only under a mkdtemp dir.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  SOURCE_VENDOR_PRESET_SCHEMA_MARKER,
  SUPPORTED_PRESET_VERSIONS,
  SIGNATURE_MATCH_FLOOR,
  VENDOR_PRESET_ERROR_CODES: CODES,
  VendorPresetError,
  findValueShapeViolation,
  stripPatternAnchors,
  validateVendorPreset,
  assertVendorPreset,
  evaluatePresetMatch,
  selectVendorPreset,
  loadVendorPresetsFromDir,
} = require(path.join(__dirname, '..', 'lib', 'source-vendor-presets', 'preset-schema.cjs'))

const PRESETS_DIR = path.join(__dirname, '..', 'lib', 'source-vendor-presets')
const SHIPPED_FILE = path.join(PRESETS_DIR, 'dn-pdm-family.preset.json')
const FIXTURE_SQL = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'fixtures', 'stock-prep-synthetic-plm', 'schema.sql')

const SHIPPED_RAW = fs.readFileSync(SHIPPED_FILE, 'utf8')
const SHIPPED = JSON.parse(SHIPPED_RAW)

function clonePreset() {
  return structuredClone(SHIPPED)
}

/** Refusal helper: the mutated preset must fail with `code` at a path containing `pathFragment`,
 * and the message must contain `acceptableFragment` — the named acceptable form. */
function expectRefusal(mutated, code, pathFragment, acceptableFragment) {
  const result = validateVendorPreset(mutated)
  assert.equal(result.ok, false, `expected refusal ${code} at ${pathFragment}, but the preset passed`)
  const hit = result.errors.find((e) => e.code === code && e.path.includes(pathFragment))
  assert.ok(
    hit,
    `expected ${code} at a path containing '${pathFragment}'; got:\n  ${result.errors.map((e) => e.message).join('\n  ')}`,
  )
  if (acceptableFragment) {
    assert.ok(
      hit.message.includes(acceptableFragment),
      `the ${code} refusal must NAME the acceptable form (expected the message to contain ` +
        `'${acceptableFragment}'):\n  ${hit.message}`,
    )
  }
  return hit
}

// ---------------------------------------------------------------------------
// 1. The shipped preset is valid, discoverable, and self-clean.
// ---------------------------------------------------------------------------

function shippedPresetIsValid() {
  const result = validateVendorPreset(SHIPPED)
  assert.deepEqual(result.errors, [], 'the shipped dn-pdm preset must validate clean')
  assert.equal(result.ok, true)
  assert.equal(SHIPPED.presetSchema, SOURCE_VENDOR_PRESET_SCHEMA_MARKER)
  assert.ok(SUPPORTED_PRESET_VERSIONS.includes(SHIPPED.presetVersion))
  assert.equal(assertVendorPreset(SHIPPED), SHIPPED)

  const loaded = loadVendorPresetsFromDir(PRESETS_DIR)
  assert.equal(loaded.length, 1, 'exactly one preset file is expected in the catalog today')
  assert.equal(loaded[0].file, 'dn-pdm-family.preset.json')
  assert.equal(loaded[0].preset.presetId, 'dn-pdm-family')

  // Independent tripwire, NOT via the validator: the committed artifact itself must never name a
  // concrete generic-family slot (a slot name with a digit is a discovered per-customer fact).
  assert.equal(
    /ExAttr\d/i.test(SHIPPED_RAW),
    false,
    'the shipped preset file names a concrete generic-slot column — that is discovered per-customer data',
  )
}

// ---------------------------------------------------------------------------
// 2. Refusal legs — each coded, each naming the acceptable form.
// ---------------------------------------------------------------------------

function refusalLegs() {
  let p = clonePreset()
  p.presetSchema = 'some.other.marker'
  expectRefusal(p, CODES.PRESET_SCHEMA_MARKER_INVALID, '$.presetSchema', SOURCE_VENDOR_PRESET_SCHEMA_MARKER)

  p = clonePreset()
  p.presetVersion = 99
  expectRefusal(p, CODES.PRESET_VERSION_UNSUPPORTED, '$.presetVersion', `[${SUPPORTED_PRESET_VERSIONS.join(', ')}]`)

  p = clonePreset()
  p.presetId = 'AcmeCorp'
  expectRefusal(p, CODES.PRESET_ID_INVALID, '$.presetId', 'never a vendor brand or customer name')

  p = clonePreset()
  p.futureField = { anything: true }
  expectRefusal(p, CODES.PRESET_KEY_UNKNOWN, '$.futureField', 'new presetVersion')

  p = clonePreset()
  p.matches.minSignatureTablesPresent = 1
  expectRefusal(p, CODES.PRESET_MATCHES_INVALID, '$.matches.minSignatureTablesPresent', 'fail-closed floor')

  p = clonePreset()
  p.matches.minSignatureTablesPresent = p.matches.signatureTables.length + 5
  expectRefusal(p, CODES.PRESET_MATCHES_INVALID, '$.matches.minSignatureTablesPresent', 'signatureTables.length')

  p = clonePreset()
  p.coreTables.part.table = 'DN PDM; DROP TABLE parts'
  expectRefusal(p, CODES.PRESET_IDENTIFIER_INVALID, '$.coreTables.part.table', 'SQL-identifier-shaped')

  p = clonePreset()
  p.genericColumnFamilies.partExAttr.pattern = 'ExAttr[0-9]+'
  expectRefusal(p, CODES.PRESET_PATTERN_INVALID, '$.genericColumnFamilies.partExAttr.pattern', "anchored '^...$'")

  p = clonePreset()
  p.joins[0].fromRole = 'ghostRole'
  expectRefusal(p, CODES.PRESET_ROLE_REF_INVALID, '$.joins[0].fromRole', 'declared coreTables role')

  p = clonePreset()
  p.joins[0].fromColumn = 'Undeclared_Column'
  expectRefusal(p, CODES.PRESET_ROLE_REF_INVALID, '$.joins[0].fromColumn', 'declared columns')

  // A dictionary-assigned semantic must not pin a concrete role/column — that binding IS the
  // per-customer discovery result.
  p = clonePreset()
  assert.equal(p.semanticExpectations[0].locus, 'dictionary-assigned-column')
  p.semanticExpectations[0].role = 'bomDetail'
  p.semanticExpectations[0].roleColumn = 'sort_id'
  expectRefusal(p, CODES.PRESET_FIELD_INVALID, '$.semanticExpectations[0].roleColumn', 'probe discovers')

  console.log('  ✓ refusal legs: 11 coded refusals, each naming the acceptable form')
}

// ---------------------------------------------------------------------------
// 3. Poison legs — value smuggling is rejected naming the offending path.
// ---------------------------------------------------------------------------

function poisonLegs() {
  // Connection string in a note: rejected, path named, content NOT echoed.
  let p = clonePreset()
  p.notes.push('Data Source=192.168.7.13;Initial Catalog=plm;User Id=sa;Password=hunter2')
  let hit = expectRefusal(p, CODES.PRESET_VALUE_SHAPE_REJECTED, `$.notes[${p.notes.length - 1}]`, 'PROBE_MSSQL_*')
  assert.ok(!hit.message.includes('hunter2'), 'the refusal must not echo the credential')
  assert.ok(!hit.message.includes('192.168'), 'the refusal must not echo the address')

  // Bare IP address in prose.
  p = clonePreset()
  p.coreTables.part.note = 'reachable at 10.20.30.40 on the shop-floor LAN'
  expectRefusal(p, CODES.PRESET_VALUE_SHAPE_REJECTED, '$.coreTables.part.note', 'discovery structure only')

  // Credential file path.
  p = clonePreset()
  p.notes.push('client cert lives at C:\\ops\\plm-login.pfx on the bridge host')
  expectRefusal(p, CODES.PRESET_VALUE_SHAPE_REJECTED, `$.notes[${p.notes.length - 1}]`, 'discovery structure only')

  // Probe connection-env assignment (naming the variable is documentation; assigning it is a value).
  p = clonePreset()
  p.notes.push('PROBE_MSSQL_USER=plm_reader')
  expectRefusal(p, CODES.PRESET_VALUE_SHAPE_REJECTED, `$.notes[${p.notes.length - 1}]`, 'discovery structure only')

  // Business-value-shaped default, key form: the key itself is refused with the
  // discover-vs-discovered rule, before any allowlist argument.
  p = clonePreset()
  p.coreTables.bomDetail.defaultQuantityColumn = 'sort_id'
  expectRefusal(p, CODES.PRESET_VALUE_KEY_REJECTED, '$.coreTables.bomDetail.defaultQuantityColumn', 'HOW TO DISCOVER')

  // Business-value-shaped default, concrete-slot form: binding a semantic to a concrete member of
  // a declared generic family is one customer's dictionary row wearing a committable coat.
  p = clonePreset()
  p.coreTables.bomDetail.roles.quantity = 'Bom_ExAttr7'
  expectRefusal(p, CODES.PRESET_CONCRETE_SLOT_REJECTED, '$.coreTables.bomDetail.roles.quantity', 'per-customer dictionary data')

  // ...and the prose form of the same smuggle.
  p = clonePreset()
  p.notes.push('at this site the quantity slot is Bom_ExAttr7')
  expectRefusal(p, CODES.PRESET_CONCRETE_SLOT_REJECTED, `$.notes[${p.notes.length - 1}]`, 'per-customer dictionary data')

  console.log('  ✓ poison legs: connection string / IP / credential path / env assignment / value key / concrete slot all rejected, paths named, content never echoed')
}

// ---------------------------------------------------------------------------
// 4. Controls on the detectors themselves (a scanner that never fires would
//    report every preset clean forever).
// ---------------------------------------------------------------------------

function detectorControls() {
  assert.equal(findValueShapeViolation('Server=db01;Database=plm;Trusted_Connection=yes').shape, 'connection-string')
  assert.equal(findValueShapeViolation('mssql://reader@dbhost/plm').shape, 'database-url')
  assert.equal(findValueShapeViolation('10.0.0.7').shape, 'bare-ip-address')
  assert.equal(findValueShapeViolation('PROBE_MSSQL_PASSWORD=changeit').shape, 'probe-env-assignment')
  assert.equal(findValueShapeViolation('token: abc').shape, 'credential-material')
  assert.equal(findValueShapeViolation('C:\\certs\\bridge.pem').shape, 'credential-file-path')

  // Benign discovery prose must NOT fire.
  for (const benign of [
    'plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs',
    'plan id plm.stock-preparation.bom-read.dn-pdm.v1',
    'orders lines by the sort column; versions pin per level',
    'match the requested number on the match role',
  ]) {
    assert.equal(findValueShapeViolation(benign), null, `benign string misclassified: ${benign}`)
  }

  // Concrete-slot searcher: anchors stripped, members with digits match, the family's own
  // dictionary TABLE names (which contain the family word without a digit) do not.
  const stripped = stripPatternAnchors(SHIPPED.genericColumnFamilies.bomDetailExAttr.pattern)
  const searcher = new RegExp(stripped, 'i')
  assert.equal(searcher.test('bom_exattr12'), true)
  assert.equal(searcher.test('DN_PM_BomExAttrInfo'), false)
  assert.equal(searcher.test('DN_PDM_PathExAttrInfo'), false)

  console.log('  ✓ detector controls: every value-shape class fires; benign prose and dictionary table names do not')
}

// ---------------------------------------------------------------------------
// 5. Signature matching — fixture selects, noise and near-miss select nothing.
// ---------------------------------------------------------------------------

function readFixtureTableList() {
  const sql = fs.readFileSync(FIXTURE_SQL, 'utf8')
  const tables = [...sql.matchAll(/create table if not exists\s+([a-z0-9_]+)/gi)].map((m) => m[1])
  // Walker control: an empty parse would make every matching assertion vacuous.
  assert.equal(tables.length, 7, `expected the synthetic fixture to declare 7 tables, saw ${tables.length}`)
  assert.ok(tables.includes('dn_pdm_partlibraryinfo'), 'fixture parse must see the part table')
  return tables
}

function signatureMatching() {
  const fixtureTables = readFixtureTableList()

  // The synthetic fixture (lower-case PostgreSQL spelling, no dictionary tables exposed) selects
  // the preset: 7 of 10 signature tables present, floor is 6.
  const evaluation = evaluatePresetMatch(SHIPPED, fixtureTables)
  assert.equal(evaluation.selected, true, 'the synthetic fixture table list must select the dn-pdm preset')
  assert.equal(evaluation.matchedCount, 7)
  assert.equal(evaluation.requiredCount, SHIPPED.matches.minSignatureTablesPresent)
  assert.equal(evaluation.missingTables.length, 3)

  const picked = selectVendorPreset([SHIPPED], fixtureTables)
  assert.equal(picked.reason, 'MATCHED')
  assert.equal(picked.selected.presetId, 'dn-pdm-family')

  // Schema-qualified CamelCase names (the probe's `schema.table` keys) also select.
  const qualified = SHIPPED.matches.signatureTables.slice(0, 6).map((t) => `dbo.${t}`)
  assert.equal(evaluatePresetMatch(SHIPPED, qualified).selected, true)

  // A random table list selects NOTHING.
  const noise = ['users', 'user_roles', 'orders', 'order_lines', 'invoices', 'products', 'warehouses', 'audit_log']
  const noiseEvaluation = evaluatePresetMatch(SHIPPED, noise)
  assert.equal(noiseEvaluation.selected, false)
  assert.equal(noiseEvaluation.matchedCount, 0)
  const noisePick = selectVendorPreset([SHIPPED], noise)
  assert.equal(noisePick.selected, null, 'a random catalog must select no preset')
  assert.equal(noisePick.reason, 'NO_PRESET_MATCHED')

  // A below-floor near-miss selects NOTHING — there is no partial credit and no best guess.
  const nearMiss = SHIPPED.matches.signatureTables.slice(0, SHIPPED.matches.minSignatureTablesPresent - 1)
  const nearMissEvaluation = evaluatePresetMatch(SHIPPED, nearMiss)
  assert.equal(nearMissEvaluation.matchedCount, SHIPPED.matches.minSignatureTablesPresent - 1)
  assert.equal(nearMissEvaluation.selected, false, 'one table below the floor must NOT select (fail-closed)')
  assert.equal(selectVendorPreset([SHIPPED], nearMiss).selected, null)

  // An ambiguous tie selects NOTHING.
  const rival = clonePreset()
  rival.presetId = 'dn-pdm-family-rival'
  const tie = selectVendorPreset([SHIPPED, rival], fixtureTables)
  assert.equal(tie.selected, null, 'two presets tied on the same catalog must select neither')
  assert.equal(tie.reason, 'AMBIGUOUS_PRESET_MATCH')

  // An invalid preset in the catalog is a build error, not a skip.
  assert.throws(() => selectVendorPreset([{}], fixtureTables), VendorPresetError)

  // The floor itself is real: the shipped preset's floor sits at or above the schema floor.
  assert.ok(SHIPPED.matches.minSignatureTablesPresent >= SIGNATURE_MATCH_FLOOR)

  console.log('  ✓ signature matching: fixture selects (7/10 >= 6); noise, near-miss and ties select nothing')
}

// ---------------------------------------------------------------------------
// 6. Directory loading is fail-closed: an invalid preset file throws naming the
//    file — it is never silently skipped.
// ---------------------------------------------------------------------------

function loadingIsFailClosed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-presets-'))
  try {
    const bad = clonePreset()
    bad.presetVersion = 99
    fs.writeFileSync(path.join(dir, 'broken.preset.json'), JSON.stringify(bad), 'utf8')
    assert.throws(
      () => loadVendorPresetsFromDir(dir),
      (err) => err instanceof VendorPresetError && err.message.includes('broken.preset.json'),
      'an invalid preset file must throw naming the file',
    )

    fs.writeFileSync(path.join(dir, 'broken.preset.json'), 'not json at all', 'utf8')
    assert.throws(
      () => loadVendorPresetsFromDir(dir),
      (err) => err instanceof VendorPresetError && err.message.includes('broken.preset.json'),
      'an unparseable preset file must throw naming the file',
    )

    // Files without the suffix are not presets and are ignored.
    fs.unlinkSync(path.join(dir, 'broken.preset.json'))
    fs.writeFileSync(path.join(dir, 'README.txt'), 'nothing', 'utf8')
    assert.deepEqual(loadVendorPresetsFromDir(dir), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log('  ✓ loading: invalid/unparseable preset files throw naming the file; non-preset files are ignored')
}

function main() {
  shippedPresetIsValid()
  console.log('  ✓ shipped dn-pdm-family preset validates clean and is the one catalog entry')
  refusalLegs()
  poisonLegs()
  detectorControls()
  signatureMatching()
  loadingIsFailClosed()
  console.log('✓ source-vendor-presets: schema, poison rejection and signature selection all hold')
}

main()

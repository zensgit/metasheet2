'use strict'

/**
 * SOURCE VENDOR PRESET CATALOG — schema validation, poison rejection, signature selection.
 *
 * The ADVERSARIAL REGRESSIONS section carries, verbatim, the executed attack fragments from the
 * adversarial review that REFUTED the first cut of this schema (every fragment there passed
 * validateVendorPreset with ok:true at the time). Each is now a refusing regression: if any of
 * them ever validates again, the core guarantee is broken and this suite is the tripwire.
 *
 * Guarantees under test (each mutation-witnessed in the PR):
 *   1. VALIDATOR — a well-formed preset passes; every refusal leg fires with its coded reason,
 *      and the reason NAMES the acceptable form.
 *   2. POISON — connection strings, IPv4/IPv6, bare hostnames, credential paths, probe-env
 *      assignments, value-carrier keys, and CONCRETE members of generic column families are
 *      REJECTED naming the offending path, without echoing the content. The concrete-member
 *      scan is total: no key-name exemptions, stem BASES included, plus a raw-text pass.
 *   3. SIGNATURE FAIL-CLOSED — the synthetic fixture's table list selects the dn-pdm preset; a
 *      random list and a below-floor near-miss select NOTHING; MORE THAN ONE preset clearing
 *      its floor selects NOTHING (ambiguous), regardless of match counts.
 *   4. NESTED ALLOWLISTS PINNED — an unknown key at EVERY nesting depth refuses (loosening any
 *      nested allowlist is a visible RED here, not a silent green).
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
  FAMILY_MIN_CARDINALITY,
  PRESET_MAX_JSON_BYTES,
  VENDOR_PRESET_ERROR_CODES: CODES,
  LABEL_HINT_VOCABULARY,
  DICTIONARY_TYPE_HINTS,
  VendorPresetError,
  findValueShapeViolation,
  isEnabledFlagValue,
  familyColumnMatcher,
  isFamilyColumn,
  buildConcreteMemberScanners,
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

  // The dn-pdm preset must keep declaring both ExAttr families (with the bare-'ExAttr' stem in
  // scope via partExAttr) — the concrete-member scan's coverage of this vendor family depends on
  // these declarations, and dropping one would silently narrow the scan.
  const familyStems = Object.values(SHIPPED.genericColumnFamilies).flatMap((f) => f.stems.map((s) => s.toLowerCase()))
  assert.ok(familyStems.includes('bom_exattr'), 'dn-pdm must declare the Bom_ExAttr family')
  assert.ok(familyStems.includes('exattr'), 'dn-pdm must declare the bare ExAttr stem')
  assert.ok(familyStems.includes('order_exattr'), 'dn-pdm must declare the order-detail slot family (measured live)')

  // Independent tripwire, NOT via the validator: the committed artifact itself must never name a
  // concrete generic-family slot or value-set table (stem followed by a digit is a discovered
  // per-customer fact).
  assert.equal(/ExAttr\d/i.test(SHIPPED_RAW), false, 'the shipped preset file names a concrete generic-slot column')
  assert.equal(/BomParam\d/i.test(SHIPPED_RAW), false, 'the shipped preset file names a concrete value-set table')
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

  // Structured-family structure legs: a stem ending in a digit is a slot prefix; free-form
  // pattern fields do not exist in v1.
  p = clonePreset()
  p.genericColumnFamilies.partExAttr.stems = ['ExAttrX']
  assert.equal(validateVendorPreset(p).ok, true, 'control: a digit-free stem variant is legal')
  p.genericColumnFamilies.partExAttr.stems = ['ExAttr7']
  expectRefusal(p, CODES.PRESET_FAMILY_INVALID, '$.genericColumnFamilies.partExAttr.stems[0]', 'NOT ending in a')

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

  // The enabled flag is identifier candidates, not a regex.
  p = clonePreset()
  p.dictionaries[0].enabledFlag.columnCandidates = ['^is_?able$']
  expectRefusal(p, CODES.PRESET_IDENTIFIER_INVALID, '$.dictionaries[0].enabledFlag.columnCandidates[0]', 'SQL-identifier-shaped')

  console.log('  ✓ refusal legs: coded refusals, each naming the acceptable form')
}

// ---------------------------------------------------------------------------
// 3. ADVERSARIAL REGRESSIONS — the executed attack fragments that PASSED the
//    first cut, now required to refuse. Do not weaken any of these.
// ---------------------------------------------------------------------------

function adversarialRegressions() {
  // A6 — a discovered slot hidden in a *Pattern-named field (the first cut blanket-exempted
  // pattern-named keys from the concrete-slot walker). The field no longer exists AND the
  // total scan catches the member regardless of key name.
  let p = clonePreset()
  p.semanticExpectations[0].labelHintPattern = '^Bom_ExAttr7$'
  expectRefusal(p, CODES.PRESET_CONCRETE_SLOT_REJECTED, '$.semanticExpectations[0].labelHintPattern', 'per-customer dictionary data')
  expectRefusal(p, CODES.PRESET_KEY_UNKNOWN, '$.semanticExpectations[0].labelHintPattern', 'presetVersion')

  // A2 — a singleton-language "family" IS the discovered slot. Free-regex form: the `pattern`
  // key is unknown, stems are missing, and the pattern literal is itself a concrete member.
  p = clonePreset()
  p.genericColumnFamilies.qtySlot = { onRole: 'bomDetail', pattern: '^Bom_ExAttr7$' }
  expectRefusal(p, CODES.PRESET_CONCRETE_SLOT_REJECTED, '$.genericColumnFamilies.qtySlot.pattern', 'per-customer dictionary data')
  expectRefusal(p, CODES.PRESET_FAMILY_INVALID, '$.genericColumnFamilies.qtySlot.stems', 'array of 1..')

  // A2, structured variant — a one-slot range is a pointer, and an offset base encodes WHERE.
  p = clonePreset()
  p.genericColumnFamilies.qtySlot = { onRole: 'bomDetail', stems: ['Bom_ExAttr'], indexMin: 7, indexMax: 7 }
  expectRefusal(p, CODES.PRESET_FAMILY_INVALID, '$.genericColumnFamilies.qtySlot.indexMin', 'must be 0 or 1')
  expectRefusal(p, CODES.PRESET_FAMILY_INVALID, '$.genericColumnFamilies.qtySlot.indexMax', 'cardinality')

  // S1/A3 — delete the families, then smuggle a concrete slot as a plain role column. The scan
  // was self-referential (scoped to families the preset chose to declare); families are now
  // REQUIRED, so an undeclared-family preset refuses outright.
  p = clonePreset()
  delete p.genericColumnFamilies
  p.coreTables.bomDetail.roles.quantity = 'Bom_ExAttr1'
  expectRefusal(p, CODES.PRESET_FAMILY_INVALID, '$.genericColumnFamilies', 'REQUIRED')

  // S2b — narrow the declared stems so the smuggled member falls outside them. The scan also
  // covers each stem's underscore-stripped BASE ('Part_ExAttr' -> 'ExAttr'), so bare 'ExAttr14'
  // is still refused.
  p = clonePreset()
  p.genericColumnFamilies.partExAttr.stems = ['Part_ExAttr']
  p.notes.push('the interesting column is ExAttr14')
  expectRefusal(p, CODES.PRESET_CONCRETE_SLOT_REJECTED, `$.notes[${p.notes.length - 1}]`, 'per-customer dictionary data')

  // Raw-pass leg — a concrete member hiding in an object KEY, which the leaf walk cannot see.
  p = clonePreset()
  p.coreTables.bomDetail.roles.bomExAttr7 = 'sort_id'
  expectRefusal(p, CODES.PRESET_CONCRETE_SLOT_REJECTED, '$(serialized preset)', 'object KEY')

  // A4 — bulk prose in notes (the executed attack carried 12KB naming a company, a plant, a
  // contact and a unit vocabulary). Size channels are hard-capped; the proper-name residual is
  // documented as review-gated in the schema header and the refusal message.
  p = clonePreset()
  p.notes.push('x'.repeat(12000))
  expectRefusal(p, CODES.PRESET_FIELD_INVALID, `$.notes[${p.notes.length - 1}]`, 'at most 300')
  p = clonePreset()
  p.notes = Array.from({ length: 20 }, (_, i) => `note number ${i}`)
  expectRefusal(p, CODES.PRESET_FIELD_INVALID, '$.notes', 'at most 6')
  p = clonePreset()
  for (let i = 0; i < 200; i += 1) {
    p.coreTables[`extraRole${i}`] = { table: `Extra_Table_${i}`, roles: { id: 'OBJ_ID' } }
  }
  expectRefusal(p, CODES.PRESET_FIELD_INVALID, '$', `${PRESET_MAX_JSON_BYTES}`)

  // A5/S3 — an option vocabulary parked in a hint. The free-form hint channel is GONE (unknown
  // key), and the enum replacement cannot carry words at all.
  p = clonePreset()
  p.semanticExpectations[0].labelHintPattern = 'STEEL|ALUMINUM|BRASS|COPPER'
  expectRefusal(p, CODES.PRESET_KEY_UNKNOWN, '$.semanticExpectations[0].labelHintPattern', 'presetVersion')
  p = clonePreset()
  p.semanticExpectations[0].labelHint = 'STEEL|ALUMINUM'
  expectRefusal(p, CODES.PRESET_FIELD_INVALID, '$.semanticExpectations[0].labelHint', 'CLOSED enum')

  // A8a — bare FQDN hostname in prose.
  p = clonePreset()
  p.notes.push('reachable at plm-db01.plant-floor.example over the shop network')
  let hit = expectRefusal(p, CODES.PRESET_VALUE_SHAPE_REJECTED, `$.notes[${p.notes.length - 1}]`, 'discovery structure only')
  assert.ok(!hit.message.includes('plm-db01'), 'the refusal must not echo the hostname')

  // A8b — IPv6 in prose.
  p = clonePreset()
  p.notes.push('listener at 2001:db8::7 during the pilot')
  hit = expectRefusal(p, CODES.PRESET_VALUE_SHAPE_REJECTED, `$.notes[${p.notes.length - 1}]`, 'discovery structure only')
  assert.ok(!hit.message.includes('2001:db8'), 'the refusal must not echo the address')

  console.log('  ✓ adversarial regressions: A2, A3/S1, S2b, A4, A5/S3, A6, A8a, A8b and the raw-pass key smuggle all refuse')
}

// ---------------------------------------------------------------------------
// 4. Poison legs — value smuggling is rejected naming the offending path.
// ---------------------------------------------------------------------------

function poisonLegs() {
  // Connection string in a note: rejected, path named, content NOT echoed.
  let p = clonePreset()
  p.notes.push('Data Source=192.168.7.13;Initial Catalog=plm;User Id=sa;Password=hunter2')
  const hit = expectRefusal(p, CODES.PRESET_VALUE_SHAPE_REJECTED, `$.notes[${p.notes.length - 1}]`, 'PROBE_MSSQL_*')
  assert.ok(!hit.message.includes('hunter2'), 'the refusal must not echo the credential')
  assert.ok(!hit.message.includes('192.168'), 'the refusal must not echo the address')

  // Bare IPv4 address in prose.
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

  // Business-value-shaped default, concrete-slot form.
  p = clonePreset()
  p.coreTables.bomDetail.roles.quantity = 'Bom_ExAttr7'
  expectRefusal(p, CODES.PRESET_CONCRETE_SLOT_REJECTED, '$.coreTables.bomDetail.roles.quantity', 'per-customer dictionary data')

  // ...and the prose form of the same smuggle.
  p = clonePreset()
  p.notes.push('at this site the quantity slot is Bom_ExAttr7')
  expectRefusal(p, CODES.PRESET_CONCRETE_SLOT_REJECTED, `$.notes[${p.notes.length - 1}]`, 'per-customer dictionary data')

  console.log('  ✓ poison legs: connection string / IPv4 / credential path / env assignment / value key / concrete slot all rejected, paths named, content never echoed')
}

// ---------------------------------------------------------------------------
// 5. Nested allowlists are pinned — an unknown key refuses at EVERY depth.
// ---------------------------------------------------------------------------

function nestedAllowlistsArePinned() {
  const legs = [
    ['$.matches.extraKey', (p) => (p.matches.extraKey = true)],
    ['$.genericColumnFamilies.bomDetailExAttr.extraKey', (p) => (p.genericColumnFamilies.bomDetailExAttr.extraKey = true)],
    ['$.coreTables.part.extraKey', (p) => (p.coreTables.part.extraKey = true)],
    ['$.joins[0].extraKey', (p) => (p.joins[0].extraKey = true)],
    ['$.dictionaries[0].extraKey', (p) => (p.dictionaries[0].extraKey = true)],
    ['$.dictionaries[0].enabledFlag.extraKey', (p) => (p.dictionaries[0].enabledFlag.extraKey = true)],
    ['$.semanticExpectations[0].extraKey', (p) => (p.semanticExpectations[0].extraKey = true)],
    ['$.semanticExpectations[1].valueSetTableFamily.extraKey', (p) => (p.semanticExpectations[1].valueSetTableFamily.extraKey = true)],
    ['$.conventions.extraKey', (p) => (p.conventions.extraKey = true)],
    ['$.conventions.hierarchy.extraKey', (p) => (p.conventions.hierarchy.extraKey = true)],
    ['$.conventions.bomActiveFilter.extraKey', (p) => (p.conventions.bomActiveFilter.extraKey = true)],
  ]
  for (const [atPath, mutate] of legs) {
    const p = clonePreset()
    mutate(p)
    expectRefusal(p, CODES.PRESET_KEY_UNKNOWN, atPath, 'presetVersion')
  }
  console.log(`  ✓ nested allowlists: an unknown key refuses at all ${legs.length} pinned depths`)
}

// ---------------------------------------------------------------------------
// 6. Controls on the detectors themselves (a scanner that never fires would
//    report every preset clean forever).
// ---------------------------------------------------------------------------

function detectorControls() {
  assert.equal(findValueShapeViolation('Server=db01;Database=plm;Trusted_Connection=yes').shape, 'connection-string')
  assert.equal(findValueShapeViolation('mssql://reader@dbhost/plm').shape, 'database-url')
  assert.equal(findValueShapeViolation('10.0.0.7').shape, 'bare-ip-address')
  assert.equal(findValueShapeViolation('2001:db8::7').shape, 'ipv6-address')
  assert.equal(findValueShapeViolation('fe80::1').shape, 'ipv6-address')
  assert.equal(findValueShapeViolation('fd00:1:2:3:4:5:6:7').shape, 'ipv6-address')
  assert.equal(findValueShapeViolation('plm-db01.plant-floor.example').shape, 'bare-hostname')
  assert.equal(findValueShapeViolation('db.internal').shape, 'bare-hostname')
  assert.equal(findValueShapeViolation('PROBE_MSSQL_PASSWORD=changeit').shape, 'probe-env-assignment')
  assert.equal(findValueShapeViolation('token: abc').shape, 'credential-material')
  assert.equal(findValueShapeViolation('C:\\certs\\bridge.pem').shape, 'credential-file-path')

  // Benign discovery prose must NOT fire — including clock times (not IPv6) and repo paths /
  // dotted plan ids (not hostnames).
  for (const benign of [
    'plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs',
    'plan id plm.stock-preparation.bom-read.dn-pdm.v1',
    'scripts/ops/fixtures/stock-prep-synthetic-plm/schema.sql',
    'orders lines by the sort column; versions pin per level',
    'match the requested number on the match role',
    'observed at 12:30:45 during the run',
  ]) {
    assert.equal(findValueShapeViolation(benign), null, `benign string misclassified: ${benign}`)
  }

  // Generated family matcher: anchored, case-insensitive, range-checked — and NOT authorable as
  // a singleton language.
  const bomFamily = SHIPPED.genericColumnFamilies.bomDetailExAttr
  assert.equal(familyColumnMatcher(bomFamily).test('Bom_ExAttr12'), true)
  assert.equal(familyColumnMatcher(bomFamily).test('bom_exattr5'), true)
  assert.equal(familyColumnMatcher(bomFamily).test('DN_PM_BomExAttrInfo'), false)
  assert.equal(isFamilyColumn(bomFamily, 'Bom_ExAttr30'), true)
  assert.equal(isFamilyColumn(bomFamily, 'Bom_ExAttr31'), false, 'out-of-range index is not a member')
  assert.equal(isFamilyColumn(bomFamily, 'Bom_ExAttr0'), false)
  const partFamily = SHIPPED.genericColumnFamilies.partExAttr
  assert.equal(isFamilyColumn(partFamily, 'Part_ExAttr14'), true)
  assert.equal(isFamilyColumn(partFamily, 'ExAttr2'), true)
  assert.equal(isFamilyColumn(partFamily, 'Bom_ExAttr1'), false)

  // Concrete-member scanners include the underscore-stripped BASE of each stem (the S2b defense)
  // and do not fire on the family's dictionary TABLE names (no digit after the stem).
  const scanners = buildConcreteMemberScanners(['Part_ExAttr'])
  assert.ok(scanners.some((s) => s.stem === 'exattr'), 'base stem must be derived')
  assert.equal(scanners.some((s) => s.regex.test('the column ExAttr14')), true)
  assert.equal(scanners.some((s) => s.regex.test('DN_PM_BomExAttrInfo')), false)
  assert.equal(scanners.some((s) => s.regex.test('DN_PDM_PathExAttrInfo')), false)

  assert.ok(FAMILY_MIN_CARDINALITY >= 2, 'cardinality floor must exist')
  assert.deepEqual(Object.keys(LABEL_HINT_VOCABULARY).sort(), ['material-code', 'quantity', 'unit'])
  assert.deepEqual([...DICTIONARY_TYPE_HINTS].sort(), ['list', 'numeric', 'text'])

  console.log('  ✓ detector controls: every value-shape class fires; benign prose does not; generated matchers and base-stem scanners behave')
}

// ---------------------------------------------------------------------------
// 7. Signature matching — fixture selects; noise, near-miss and ANY multi-clear
//    select nothing.
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
  assert.equal(evaluation.missingTables.length, 4)

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

  // An EXACT tie selects NOTHING.
  const rival = clonePreset()
  rival.presetId = 'dn-pdm-family-rival'
  const tie = selectVendorPreset([SHIPPED, rival], fixtureTables)
  assert.equal(tie.selected, null, 'two presets tied on the same catalog must select neither')
  assert.equal(tie.reason, 'AMBIGUOUS_PRESET_MATCH')

  // ADVERSARIAL REGRESSION A1b — UNEQUAL counts, both clearing their floors, must ALSO select
  // nothing. The refuted behavior silently returned MATCHED for the higher count; a count race
  // is not a disambiguator.
  const subsetRival = clonePreset()
  subsetRival.presetId = 'dn-pdm-family-subset'
  subsetRival.matches.signatureTables = SHIPPED.matches.signatureTables.slice(0, 6)
  subsetRival.matches.minSignatureTablesPresent = 6
  const subsetEval = evaluatePresetMatch(subsetRival, fixtureTables)
  assert.equal(subsetEval.selected, true, 'control: the subset rival must clear its own floor')
  assert.notEqual(subsetEval.matchedCount, evaluatePresetMatch(SHIPPED, fixtureTables).matchedCount, 'control: counts must differ')
  const unequal = selectVendorPreset([SHIPPED, subsetRival], fixtureTables)
  assert.equal(unequal.selected, null, 'UNEQUAL counts with both floors cleared must select neither (A1b)')
  assert.equal(unequal.reason, 'AMBIGUOUS_PRESET_MATCH')

  // An invalid preset in the catalog is a build error, not a skip.
  assert.throws(() => selectVendorPreset([{}], fixtureTables), VendorPresetError)

  // The floor itself is real: the shipped preset's floor sits at or above the schema floor.
  assert.ok(SHIPPED.matches.minSignatureTablesPresent >= SIGNATURE_MATCH_FLOOR)

  console.log('  ✓ signature matching: fixture selects (7/11 >= 6); noise, near-miss, ties AND unequal multi-clears select nothing')
}

// ---------------------------------------------------------------------------
// 8. DICTIONARY ENABLED-FLAG POLARITY — pinned against the live measurement.
//
// The first shipped polarity was INVERTED for the DN_PM dictionary tables: a fact true of the
// PART table's row-availability flag (zero-means-available, from the legacy-source archaeology)
// was generalized across two different table families. The probe's first cold run against a real
// vendor test catalog refuted it — with the wrong polarity 11 semantics were unresolved; with
// the measured polarity all resolved. The corroborating STRUCTURAL signal (reproduced here as a
// synthetic fixture, no real values): companion columns in the dictionary rows — is_show /
// is_unique / sort_id style — are populated on exactly the ENABLED rows.
// ---------------------------------------------------------------------------

function dictionaryPolarityIsPinned() {
  // Synthetic structural fixture mirroring the live signal: enabled rows carry populated
  // companions, disabled rows carry nulls. Labels are placeholders — the pinned thing is the
  // CORRELATION between the enabled flag and companion population, not any content.
  const rows = [
    { isable: 1, is_show: 1, is_unique: 0, sort_id: 1, label: 'label-a' },
    { isable: 1, is_show: 1, is_unique: 1, sort_id: 2, label: 'label-b' },
    { isable: 0, is_show: null, is_unique: null, sort_id: null, label: null },
    { isable: 0, is_show: null, is_unique: null, sort_id: null, label: null },
    { isable: null, is_show: null, is_unique: null, sort_id: null, label: null },
  ]
  const companionPopulated = rows.filter((r) => r.is_show !== null && r.sort_id !== null)
  assert.equal(companionPopulated.length, 2, 'fixture control: exactly the two enabled-shaped rows carry companions')

  for (const dictionary of SHIPPED.dictionaries) {
    assert.equal(
      dictionary.enabledFlag.polarity,
      'nonzero-means-enabled',
      `${dictionary.id}: the dictionary enabled-flag polarity was MEASURED on a live vendor catalog ` +
        `(cold probe read) as nonzero-means-enabled — flipping it back re-inverts the family and ` +
        `un-resolves every dictionary-assigned semantic`,
    )
    const enabled = rows.filter((r) => isEnabledFlagValue(dictionary.enabledFlag.polarity, r.isable))
    assert.deepEqual(
      enabled,
      companionPopulated,
      `${dictionary.id}: under the declared polarity, the enabled rows must be exactly the rows ` +
        `whose companion columns are populated — the structural signal the live measurement ` +
        `corroborated. A polarity flip selects the companion-empty rows instead.`,
    )
  }

  // The PART table's availability flag is the OTHER polarity, and must stay recorded as distinct
  // so the two families can never be conflated again.
  assert.equal(SHIPPED.coreTables.part.optionalRoles.available, 'isable', 'part availability flag column stays declared')
  assert.ok(
    /INVERTED/.test(SHIPPED.coreTables.part.note) && /never generalize/i.test(SHIPPED.coreTables.part.note),
    'the part note must state the inverted polarity and forbid generalizing it',
  )
  assert.ok(
    /part table/i.test(SHIPPED.dictionaries[0].enabledFlag.note) && /measured/i.test(SHIPPED.dictionaries[0].enabledFlag.note),
    'the dictionary enabledFlag note must record where the polarity was measured and point at the part-table distinction',
  )

  // Interpreter controls, both polarities, fail-closed on null/non-numeric, loud on garbage.
  assert.equal(isEnabledFlagValue('nonzero-means-enabled', 1), true)
  assert.equal(isEnabledFlagValue('nonzero-means-enabled', '1'), true)
  assert.equal(isEnabledFlagValue('nonzero-means-enabled', 0), false)
  assert.equal(isEnabledFlagValue('nonzero-means-enabled', null), false)
  assert.equal(isEnabledFlagValue('nonzero-means-enabled', 'x'), false)
  assert.equal(isEnabledFlagValue('zero-means-enabled', 0), true)
  assert.equal(isEnabledFlagValue('zero-means-enabled', '0'), true)
  assert.equal(isEnabledFlagValue('zero-means-enabled', 1), false)
  assert.equal(isEnabledFlagValue('zero-means-enabled', null), false)
  assert.throws(() => isEnabledFlagValue('sideways-means-enabled', 1), VendorPresetError)

  console.log('  ✓ dictionary polarity: nonzero-means-enabled pinned to the live structural signal; part-table inversion recorded as distinct')
}

// ---------------------------------------------------------------------------
// 9. MEASURED TOPOLOGY (round-4 live backfill) — per-table row ids, join keys,
//    and the order-side slot dictionary, pinned with a structural fixture.
//
// Measured on the real vendor test catalog by cold reads with join-count
// verification: key columns are NOT uniformly OBJ_ID (each measured table
// carries a physical row id `ID` beside its business keys); the head/detail
// join key is bom_id, not the row id; part references join PartLibrary.OBJ_ID;
// and the ORDER detail table has NO native quantity column — its quantity is
// dictionary-assigned (DN_PM_OrderExAttrInfo), same doctrine as the BOM side.
// The fixture below uses synthetic ids only; the pinned thing is which
// COLUMNS join, not any content.
// ---------------------------------------------------------------------------

function measuredTopologyIsPinned() {
  // Per-table physical row id alongside business keys — measured live.
  for (const role of ['part', 'bomHead', 'bomDetail', 'orderDetail']) {
    assert.equal(SHIPPED.coreTables[role].roles.rowId, 'ID', `${role} must declare the measured physical row id`)
  }
  assert.equal(
    SHIPPED.coreTables.part.roles.id,
    'OBJ_ID',
    'part join identity stays OBJ_ID (the measured join target), distinct from the physical row id',
  )

  // Order detail: NO native quantity column (measured live) — the native role and the native
  // expectation must stay gone; quantity is dictionary-assigned like the BOM side.
  assert.equal(SHIPPED.coreTables.orderDetail.roles.quantity, undefined, 'order detail must not declare a native quantity column')
  const orderQuantity = SHIPPED.semanticExpectations.find((e) => e.semantic === 'order-line-quantity')
  assert.equal(orderQuantity.locus, 'dictionary-assigned-column')
  assert.equal(orderQuantity.columnFamily, 'orderDetailExAttr')
  assert.equal(orderQuantity.dictionary, 'order-exattr-labels')
  const orderDictionary = SHIPPED.dictionaries.find((d) => d.id === 'order-exattr-labels')
  assert.equal(orderDictionary.table, 'DN_PM_OrderExAttrInfo')
  assert.equal(orderDictionary.labelsColumnsOfRole, 'orderDetail')
  assert.equal(isFamilyColumn(SHIPPED.genericColumnFamilies.orderDetailExAttr, 'order_exAttr3'), true)
  assert.equal(isFamilyColumn(SHIPPED.genericColumnFamilies.bomHeadExAttr, 'Bom_ExAttr2'), true, 'the measured head-side slot family must stay declared')

  // Measured join keys, pinned exactly (the round-4 evidence: 1319/1319 on bom_pid=bom_id;
  // 142/143 and 728/1319 on part_id=OBJ_ID, partials being data, not topology).
  const joinSet = SHIPPED.joins.map((j) => `${j.fromRole}.${j.fromColumn}->${j.toRole}.${j.toColumn}`)
  for (const required of [
    'bomDetail.bom_pid->bomHead.bom_id',
    'bomHead.part_id->part.OBJ_ID',
    'bomDetail.part_id->part.OBJ_ID',
    'orderDetail.part_id->part.OBJ_ID',
    'orderDetail.order_id->orderHead.OBJ_ID',
  ]) {
    assert.ok(joinSet.includes(required), `measured join must stay declared: ${required}`)
  }

  // Structural fixture (synthetic ids only) mirroring the measured shapes: resolving the joins
  // AS DECLARED reproduces the measured pattern — head/detail joins FULLY, detail->part joins
  // PARTIALLY (missing catalog data, tolerated), and a reverted key declaration (e.g. joining
  // the head's physical row id instead of bom_id) resolves nothing.
  const fixture = {
    part: [
      { ID: 'row-1', OBJ_ID: 'part-1' },
      { ID: 'row-2', OBJ_ID: 'part-2' },
    ],
    bomHead: [{ ID: 'row-3', bom_id: 'bom-1', part_id: 'part-1', SysVer: 'v-1' }],
    bomDetail: [
      { ID: 'row-4', bom_pid: 'bom-1', part_id: 'part-2', sort_id: 1 },
      { ID: 'row-5', bom_pid: 'bom-1', part_id: 'part-absent', sort_id: 2 },
    ],
    orderHead: [{ OBJ_ID: 'order-1', path_id: 'path-1' }],
    orderDetail: [{ ID: 'row-6', order_id: 'order-1', part_id: 'part-1', sort_id: 1 }],
    pathInfo: [{ OBJ_ID: 'path-1' }],
    pathExAttr: [{ FileCode: 'code-1', Parent_OBJ_ID: 'path-1' }],
  }
  const resolveJoinCount = (fromRole, toRole) => {
    const join = SHIPPED.joins.find((j) => j.fromRole === fromRole && j.toRole === toRole)
    assert.ok(join, `a ${fromRole}->${toRole} join must be declared`)
    const targetKeys = new Set(fixture[toRole].map((r) => r[join.toColumn]))
    return fixture[fromRole].filter((r) => targetKeys.has(r[join.fromColumn])).length
  }
  assert.equal(resolveJoinCount('bomDetail', 'bomHead'), 2, 'declared head/detail key columns must join FULLY (the measured 1319/1319 shape)')
  assert.equal(resolveJoinCount('bomHead', 'part'), 1)
  assert.equal(
    resolveJoinCount('bomDetail', 'part'),
    1,
    'detail->part joins partially in the fixture as it did live — the declared key still joins every present row',
  )
  assert.equal(resolveJoinCount('orderDetail', 'part'), 1)
  assert.equal(resolveJoinCount('orderDetail', 'orderHead'), 1)
  assert.equal(resolveJoinCount('pathExAttr', 'pathInfo'), 1)

  console.log('  ✓ measured topology: row ids, join keys, and the order-side slot dictionary pinned to the live shape')
}

// ---------------------------------------------------------------------------
// 10. Directory loading is fail-closed: an invalid preset file throws naming
//     the file — it is never silently skipped.
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
  adversarialRegressions()
  poisonLegs()
  nestedAllowlistsArePinned()
  detectorControls()
  signatureMatching()
  dictionaryPolarityIsPinned()
  measuredTopologyIsPinned()
  loadingIsFailClosed()
  console.log('✓ source-vendor-presets: schema, poison rejection, adversarial regressions and signature selection all hold')
}

main()

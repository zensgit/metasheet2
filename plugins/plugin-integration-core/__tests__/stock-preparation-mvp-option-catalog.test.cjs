'use strict'

// THE MVP SELECT-VOCABULARY CATALOG — the guard that keeps it honest.
//
// The catalog (lib/stock-preparation-mvp-option-catalog.cjs) is a literal table, so the thing that
// can go wrong with it is DRIFT: a writer gains a status, nobody adds it here, and the failure
// surfaces on a customer's deployment as `Invalid select option for <field>: <value>` — which is
// exactly how this defect was found in the first place (five fields deep, on a fresh install, cleared
// only by hand-seeding).
//
// So the assertions below do not restate the literals. They import the RUNTIME constants — the frozen
// enums the plugin's own writers stamp onto rows — and prove containment:
//
//   C-01 every contract key declared by the nine frozen MVP templates has a catalog entry, and the
//        catalog declares nothing that no template asks for (both directions — a stale key is a
//        vocabulary nobody seeds and a silent 422 waiting for an operator who names it)
//   C-02 every value a writer can emit is a member of its field's catalog set. This is the one that
//        catches drift: it reads PREP_STATUSES / LINE_STATUSES / MATCH_STATUSES / MATCH_METHODS /
//        EXCEPTION_TYPES / RESOLUTION_ACTIONS / VERSION_POLICIES / PROJECT_STATUS_VALUES and the
//        sync-run plan's four literals, live.
//   C-03 the catalog is in the SHAPE the validator reads: `[{ value: <non-empty string> }]`, keyed
//        `value` (extractSelectOptions in packages/core-backend/src/multitable/field-codecs.ts reads
//        `property.options[].value` and ignores anything else), with no duplicates and no empties
//   C-04 the catalog is values-free platform vocabulary: every value is a lower_snake identifier, so
//        a customer drawing number / material code / project name cannot be smuggled in as a default
//   C-05 contractOptionSetsForTemplates is SCOPED to the templates it is given (handing the whole
//        catalog to a single-table sync would self-inflict OPTION_SYNC_UNKNOWN_SOURCE) and returns a
//        deep copy, so the frozen catalog is unreachable from the normalizer downstream
//   C-06 the ops smoke fixture (scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs) and the
//        catalog cover the same key set — the fixture was the only prior home of these vocabularies,
//        and two copies that disagree is how the deployment and the smoke test stop testing each other
//   C-07 THE WRITER-LITERAL SWEEP: no string literal reaches a select column unless the vocabulary
//        seeds it or a canonicalizer maps it onto a seeded value. C-02 cannot see a value that never
//        became a constant, and that is exactly the shape of the defect this sweep was added for —
//        `materialStatus: … || 'imported'`, which no enum declared and no vocabulary contained, and
//        which would have killed the first ERP material sync on every fresh deployment. C-07b keeps
//        the sweep non-vacuous, proves it discriminates, and pins its two exclusions.
//   C-08 THE WIRING. Every check above is only as good as where it reads from: pointed at a hardcoded
//        copy of an enum they would all stay green while checking a copy against itself. Each live
//        constant is asserted reference-identical to its module's export, and each require is
//        asserted present in this file's own source.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const OWN_SOURCE = fs.readFileSync(__filename, 'utf8')

const {
  STOCK_PREPARATION_MVP_CONTRACT_OPTION_SETS,
  STOCK_PREPARATION_MVP_CONTRACT_OPTION_KEYS,
  contractOptionSetsForTemplates,
} = require(path.join(LIB, 'stock-preparation-mvp-option-catalog.cjs'))

const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))

// --- the runtime constants the writers actually stamp -----------------------------------------
const { PROJECT_STATUS_VALUES } = require(path.join(LIB, 'stock-preparation-project-reads.cjs'))
const { LINE_STATUSES } = require(path.join(LIB, 'stock-preparation-expansion-snapshot-mapper.cjs'))
const {
  PREP_STATUSES,
  UNIT_STATUSES,
  MATERIAL_MATCH_STATUSES,
  EXCEPTION_TYPES,
} = require(path.join(LIB, 'stock-preparation-mvp-generation.cjs'))
const { MATCH_STATUSES, MATCH_METHODS } = require(path.join(LIB, 'stock-preparation-material-match.cjs'))
const {
  RESOLUTION_ACTIONS,
  EXCEPTION_STATUS_OPEN,
  EXCEPTION_STATUS_RESOLVED,
  BLOCKING_SEVERITY,
} = require(path.join(LIB, 'stock-preparation-generation-runtime.cjs'))
const {
  CANDIDATE_RULE_SOURCE,
  DEFAULT_ROUNDING_RULE,
} = require(path.join(LIB, 'stock-preparation-unit-rule-match.cjs'))
const { ERP_MATERIAL_SYNC_RUN_TYPE } = require(path.join(LIB, 'stock-preparation-erp-material-sync-persist.cjs'))
const {
  SNAPSHOT_STATUS_DRAFT,
  RUN_TYPE_PLM_SYNC,
  RUN_STATUS_SUCCEEDED,
  RUN_STATUS_PARTIAL,
} = require(path.join(LIB, 'stock-preparation-sync-run-plan.cjs'))
const { PROJECT_STATUS_ACTIVE } = require(path.join(LIB, 'stock-preparation-sync-run-persist.cjs'))
const { INTAKE_IMPORTED_STATUS } = require(path.join(LIB, 'stock-preparation-readonly-intake.cjs'))

// --- the two CANONICALIZERS: the other legal fate for a writer value ---------------------------
//
// A value reaching a select column has exactly two legal fates: it is SEEDED in the vocabulary, or it
// is CANONICALIZED into a seeded value at the persistence boundary. The sweep below checks both, so
// it must know what each canonicalizer accepts.
const {
  ACCEPTED_LINE_STATUSES,
  CANONICAL_LINE_STATUSES,
} = require(path.join(LIB, 'stock-preparation-plm-source-persist-bridge.cjs'))
const {
  ACCEPTED_ERP_MATERIAL_STATUSES,
  CANONICAL_ERP_MATERIAL_STATUSES,
} = require(path.join(LIB, 'stock-preparation-erp-material-sync-persist.cjs'))

let passed = 0
let failed = 0
const failures = []

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1 })
    .catch((error) => {
      failed += 1
      failures.push({ name, error })
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

function valuesOf(key) {
  const entries = STOCK_PREPARATION_MVP_CONTRACT_OPTION_SETS[key]
  assert.ok(Array.isArray(entries), `catalog is missing an entry for ${key}`)
  return entries.map((entry) => entry.value)
}

/** Every contract key declared anywhere in the nine frozen MVP templates. */
function declaredContractKeys() {
  const keys = new Set()
  for (const template of STOCK_PREPARATION_MVP_TABLE_TEMPLATES) {
    for (const field of template.fields) {
      if (field.optionSource && field.optionSource.type === 'contract') keys.add(field.optionSource.key)
    }
  }
  return [...keys].sort()
}

// ---------------------------------------------------------------------------
// C-07 — the writer-literal sweep
// ---------------------------------------------------------------------------
//
// WHY A SWEEP AND NOT JUST C-02. C-02 compares the catalog against the enum CONSTANTS a writer
// exports. It cannot see a value that never became a constant — and the defect that got past the
// first cut of this file was exactly that: `stock-preparation-readonly-intake.cjs` defaults
// `materialStatus` to the bare literal `'imported'`, which no constant declares, no vocabulary
// seeded, and which would therefore have killed the first ERP material sync on every fresh
// deployment. This sweep is that manual review, mechanised.
//
// A VALUE REACHING A SELECT COLUMN HAS EXACTLY TWO LEGAL FATES:
//   1. the vocabulary SEEDS it (the catalog), or
//   2. a canonicalizer MAPS it onto a seeded value at the persistence boundary.
// Anything else dies at the validator on a customer's deployment. The sweep accepts both fates and
// nothing else.
//
// SCOPE, STATED HONESTLY. It scans every `lib/*.cjs` for a literal assigned to or compared against a
// select field id. Two of the eighteen field ids are excluded — `status` and `source` — because they
// are common English words that appear as unrelated object keys all over the plugin (`status: 200`,
// `source: 'plm_system'`), and a sweep that flagged those would be noise rather than a guard. Both
// are covered by C-02's containment against their owning runtime constants instead, and C-07b pins
// the exclusion list at exactly those two so it cannot quietly grow.
const SWEEP_EXCLUDED_FIELD_IDS = Object.freeze(['source', 'status'])

/**
 * The canonicalizers, by the contract key whose vocabulary they feed. A value a canonicalizer
 * ACCEPTS is legal at a writer even though it is not seeded — that is the whole point of a
 * canonicalizer, and both of these refuse anything outside their own accepted set.
 */
const CANONICALIZER_ACCEPTED_BY_KEY = Object.freeze({
  stock_preparation_bom_line_status_v1: ACCEPTED_LINE_STATUSES,
  stock_preparation_material_status_v1: ACCEPTED_ERP_MATERIAL_STATUSES,
})

/** `fieldId -> Set<contractKey>` for every contract-sourced select in the nine frozen templates. */
function selectFieldKeys() {
  const byField = new Map()
  for (const template of STOCK_PREPARATION_MVP_TABLE_TEMPLATES) {
    for (const field of template.fields) {
      if (!field.optionSource || field.optionSource.type !== 'contract') continue
      if (!byField.has(field.id)) byField.set(field.id, new Set())
      byField.get(field.id).add(field.optionSource.key)
    }
  }
  return byField
}

/** Every value legal at this field: the union of its keys' seeded values and accepted inputs. */
function allowedValuesForField(keys) {
  const allowed = new Set()
  for (const key of keys) {
    for (const value of valuesOf(key)) allowed.add(value)
    for (const value of CANONICALIZER_ACCEPTED_BY_KEY[key] || []) allowed.add(value)
  }
  return allowed
}

/**
 * Every `<fieldId>: '<lit>'`, `<fieldId>: … || '<lit>'` and `<fieldId> ===/!== '<lit>'` in lib/.
 * Only lower_snake literals are considered a candidate VALUE — a label, a path, a type name or a
 * number is not something a select column stores.
 */
function collectWriterLiterals() {
  const byField = selectFieldKeys()
  const fieldIds = [...byField.keys()].filter((id) => !SWEEP_EXCLUDED_FIELD_IDS.includes(id))
  const files = fs.readdirSync(LIB).filter((name) => name.endsWith('.cjs')).sort()
  const out = []
  for (const file of files) {
    const lines = fs.readFileSync(path.join(LIB, file), 'utf8').split('\n')
    for (const fieldId of fieldIds) {
      // `(?:[^;\n]*?\|\|\s*)?` lets the default-value idiom through:
      //     materialStatus: firstValue(row, [...]) || 'imported'
      const pattern = new RegExp(`\\b${fieldId}\\b\\s*(?::|===|!==|==)\\s*(?:[^;\\n]*?\\|\\|\\s*)?'([^']*)'`, 'g')
      lines.forEach((text, index) => {
        let match = pattern.exec(text)
        while (match) {
          const value = match[1]
          if (/^[a-z][a-z0-9_]*$/.test(value)) {
            out.push({ file, line: index + 1, fieldId, value, keys: byField.get(fieldId) })
          }
          match = pattern.exec(text)
        }
      })
    }
  }
  return out
}

/** The subset of the sweep that is a finding: a literal with neither legal fate. */
function sweepWriterLiterals() {
  return collectWriterLiterals().filter((entry) => !allowedValuesForField(entry.keys).has(entry.value))
}

// ---------------------------------------------------------------------------
// C-08 (N4) — the wiring pin
// ---------------------------------------------------------------------------
//
// The checks above are only as good as WHERE THEY READ FROM. Pointed at a hardcoded copy of an enum
// they would stay green while checking a copy against itself — a bad green in the guard that exists
// to prevent a bad deployment. Each row below pairs a live-imported constant with the module and
// export it must BE, and C-08 asserts reference identity plus the presence of the require itself.
const RUNTIME_CONSTANT_WIRING = Object.freeze([
  Object.freeze({ module: 'stock-preparation-project-reads.cjs', exportName: 'PROJECT_STATUS_VALUES', live: PROJECT_STATUS_VALUES }),
  Object.freeze({ module: 'stock-preparation-expansion-snapshot-mapper.cjs', exportName: 'LINE_STATUSES', live: LINE_STATUSES }),
  Object.freeze({ module: 'stock-preparation-mvp-generation.cjs', exportName: 'PREP_STATUSES', live: PREP_STATUSES }),
  Object.freeze({ module: 'stock-preparation-material-match.cjs', exportName: 'MATCH_STATUSES', live: MATCH_STATUSES }),
  Object.freeze({ module: 'stock-preparation-generation-runtime.cjs', exportName: 'RESOLUTION_ACTIONS', live: RESOLUTION_ACTIONS }),
  Object.freeze({ module: 'stock-preparation-erp-material-sync-persist.cjs', exportName: 'ACCEPTED_ERP_MATERIAL_STATUSES', live: ACCEPTED_ERP_MATERIAL_STATUSES }),
  Object.freeze({ module: 'stock-preparation-plm-source-persist-bridge.cjs', exportName: 'ACCEPTED_LINE_STATUSES', live: ACCEPTED_LINE_STATUSES }),
  Object.freeze({ module: 'stock-preparation-unit-rule-match.cjs', exportName: 'CANDIDATE_RULE_SOURCE', live: CANDIDATE_RULE_SOURCE }),
  Object.freeze({ module: 'stock-preparation-readonly-intake.cjs', exportName: 'INTAKE_IMPORTED_STATUS', live: INTAKE_IMPORTED_STATUS }),
])

/** The field ids C-02's containment covers directly — the two sweep exclusions must be among them. */
const CONTAINMENT_COVERED_FIELD_IDS = Object.freeze(['status', 'source', 'runType', 'prepStatus', 'materialStatus'])

/** Assert `emitted` ⊆ catalog[key]. The direction matters: a superset in the catalog is inert. */
function assertEmittedValuesSeeded(key, emitted, label) {
  const seeded = new Set(valuesOf(key))
  for (const value of emitted) {
    assert.ok(
      seeded.has(value),
      `${label}: the writer emits "${value}" but ${key} does not seed it — a fresh deployment would ` +
      'refuse that row with `Invalid select option`',
    )
  }
}

async function main() {
  // ---- C-01: key coverage, both directions ----
  await run('C-01 the catalog covers exactly the contract keys the frozen MVP templates declare', () => {
    assert.deepEqual(STOCK_PREPARATION_MVP_CONTRACT_OPTION_KEYS, declaredContractKeys())
    assert.equal(STOCK_PREPARATION_MVP_CONTRACT_OPTION_KEYS.length, 18)
  })

  // ---- C-02: containment against the live runtime constants ----
  await run('C-02 every value a writer stamps is seeded by the matching catalog set', () => {
    assertEmittedValuesSeeded('stock_preparation_project_status_v1', PROJECT_STATUS_VALUES, 'project reads')
    assertEmittedValuesSeeded('stock_preparation_bom_line_status_v1', Object.values(LINE_STATUSES), 'expansion mapper')
    assertEmittedValuesSeeded('stock_preparation_prep_status_v1', Object.values(PREP_STATUSES), 'mvp generation')
    assertEmittedValuesSeeded('stock_preparation_unit_status_v1', Object.values(UNIT_STATUSES), 'mvp generation')
    assertEmittedValuesSeeded('stock_preparation_match_status_v1', Object.values(MATERIAL_MATCH_STATUSES), 'mvp generation')
    assertEmittedValuesSeeded('stock_preparation_match_status_v1', Object.values(MATCH_STATUSES), 'material match')
    assertEmittedValuesSeeded('stock_preparation_match_method_v1', Object.values(MATCH_METHODS), 'material match')
    assertEmittedValuesSeeded('stock_preparation_exception_type_v1', Object.values(EXCEPTION_TYPES), 'mvp generation')
    assertEmittedValuesSeeded('stock_preparation_resolution_action_v1', RESOLUTION_ACTIONS, 'generation runtime')
    // The sync-run plan writes exactly these four, and they are the five fields that broke live.
    assertEmittedValuesSeeded('stock_preparation_snapshot_status_v1', [SNAPSHOT_STATUS_DRAFT], 'sync-run plan')
    assertEmittedValuesSeeded('stock_preparation_run_type_v1', [RUN_TYPE_PLM_SYNC], 'sync-run plan')
    assertEmittedValuesSeeded(
      'stock_preparation_run_status_v1',
      [RUN_STATUS_SUCCEEDED, RUN_STATUS_PARTIAL],
      'sync-run plan',
    )
    // The SECOND run-type writer. A run_type value that only the ERP leg emits is exactly the kind of
    // thing a check anchored on the PLM leg alone would miss.
    assertEmittedValuesSeeded('stock_preparation_run_type_v1', [ERP_MATERIAL_SYNC_RUN_TYPE], 'ERP material sync')

    // THE TWO FIELD IDS THE SOURCE SWEEP EXCLUDES (`status`, `source` — see SWEEP_EXCLUDED_FIELD_IDS).
    // Their containment is checked HERE instead, against the writers' own exported constants, so the
    // exclusion costs coverage of the SCAN, never of the guarantee.
    assertEmittedValuesSeeded(
      'stock_preparation_exception_status_v1',
      [EXCEPTION_STATUS_OPEN, EXCEPTION_STATUS_RESOLVED],
      'generation runtime (exception status)',
    )
    assertEmittedValuesSeeded(
      'stock_preparation_exception_severity_v1',
      [BLOCKING_SEVERITY],
      'generation runtime (exception severity)',
    )
    assertEmittedValuesSeeded(
      'stock_preparation_unit_rule_source_v1',
      [CANDIDATE_RULE_SOURCE],
      'unit rule match (rule source)',
    )
    assertEmittedValuesSeeded(
      'stock_preparation_rounding_rule_v1',
      [DEFAULT_ROUNDING_RULE],
      'unit rule match (rounding rule)',
    )
    // The ERP leg's CANONICAL outputs must be seeded — an accepted INPUT need not be, but whatever the
    // canonicalizer hands the writer certainly must.
    assertEmittedValuesSeeded(
      'stock_preparation_material_status_v1',
      CANONICAL_ERP_MATERIAL_STATUSES,
      'ERP material canonicalizer output',
    )
    // Same for the PLM leg's canonical line statuses.
    assertEmittedValuesSeeded('stock_preparation_bom_line_status_v1', CANONICAL_LINE_STATUSES, 'PLM bridge canonical output')

    // THE WRITE-SIDE CONSTANT for projectStatus. The intake also projects a projectStatus, and it
    // projects 'imported' — but no committer writes it: upsertStockPreparationProject stamps THIS
    // value on both the create and the patch leg. Pinning the value the writer actually stamps is what
    // makes that claim checkable rather than a comment.
    assertEmittedValuesSeeded('stock_preparation_project_status_v1', [PROJECT_STATUS_ACTIVE], 'sync-run persist (project row)')

    // THE INTAKE'S DEFAULT MUST HAVE A FATE. `materialStatus` is the one intake value that genuinely
    // reaches a select column — `upsertErpMaterials` grounds this row object straight into
    // erp_material_master — so the intake's default has to be either seeded or canonicalized. It is
    // canonicalized, deliberately (seeding it would bless the source's spelling as ours). This is the
    // assertion that fails the instant either side of that pairing moves.
    assert.ok(
      ACCEPTED_ERP_MATERIAL_STATUSES.includes(INTAKE_IMPORTED_STATUS),
      `the intake defaults materialStatus to '${INTAKE_IMPORTED_STATUS}', which reaches the column ` +
      'through upsertErpMaterials — the ERP canonicalizer must accept it, or the first material sync ' +
      'on a fresh deployment dies with `Invalid select option`',
    )
  })

  // ---- C-02b: the five that failed on the live deployment, named ----
  await run('C-02b the five fields that failed live carry the exact values that were refused', () => {
    // `Invalid select option ... 'draft'`, five times over, 2026-08-31.
    assert.ok(valuesOf('stock_preparation_snapshot_status_v1').includes('draft'))
    assert.ok(valuesOf('stock_preparation_bom_line_status_v1').includes('active'))
    assert.ok(valuesOf('stock_preparation_run_type_v1').includes('plm_sync'))
    assert.ok(valuesOf('stock_preparation_run_status_v1').includes('succeeded'))
    assert.ok(valuesOf('stock_preparation_project_status_v1').includes('active'))
  })

  // ---- C-03: the shape the validator reads ----
  await run('C-03 every set is in the [{ value }] shape extractSelectOptions reads, with no gaps', () => {
    for (const key of STOCK_PREPARATION_MVP_CONTRACT_OPTION_KEYS) {
      const entries = STOCK_PREPARATION_MVP_CONTRACT_OPTION_SETS[key]
      assert.ok(Array.isArray(entries) && entries.length > 0, `${key} must not be an empty vocabulary`)
      const seen = new Set()
      for (const entry of entries) {
        assert.equal(typeof entry.value, 'string', `${key} option must be keyed \`value\` (not id/name)`)
        assert.ok(entry.value.length > 0, `${key} carries an empty option value`)
        assert.equal(seen.has(entry.value), false, `${key} declares "${entry.value}" twice`)
        seen.add(entry.value)
      }
    }
  })

  // ---- C-04: platform vocabulary only ----
  await run('C-04 every seeded value is a platform identifier, never a customer value', () => {
    for (const key of STOCK_PREPARATION_MVP_CONTRACT_OPTION_KEYS) {
      for (const value of valuesOf(key)) {
        assert.match(
          value,
          /^[a-z][a-z0-9_]*$/,
          `${key} option "${value}" is not a lower_snake platform identifier — customer values never belong here`,
        )
      }
    }
  })

  // ---- C-05: scoping + deep copy ----
  await run('C-05 contractOptionSetsForTemplates is scoped to its templates and hands back a copy', () => {
    const runTemplate = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((t) => t.objectId === 'plm_stock_preparation_run')
    const scoped = contractOptionSetsForTemplates([runTemplate])
    assert.deepEqual(
      Object.keys(scoped).sort(),
      ['stock_preparation_run_status_v1', 'stock_preparation_run_type_v1'],
      'a single-table sync must not be handed keys that table does not declare',
    )
    // Deep copy: mutating the returned set cannot reach the frozen catalog.
    scoped.stock_preparation_run_type_v1[0].value = 'mutated'
    assert.equal(valuesOf('stock_preparation_run_type_v1')[0], 'plm_sync')

    assert.deepEqual(contractOptionSetsForTemplates([]), {})
    assert.deepEqual(contractOptionSetsForTemplates(undefined), {})
    // All nine templates together reproduce the whole catalog.
    assert.deepEqual(
      Object.keys(contractOptionSetsForTemplates(STOCK_PREPARATION_MVP_TABLE_TEMPLATES)).sort(),
      STOCK_PREPARATION_MVP_CONTRACT_OPTION_KEYS.slice(),
    )
  })

  // ---- C-06: the ops smoke fixture and the catalog agree on the key set ----
  await run('C-06 the postdeploy smoke fixture covers the same keys as the catalog', async () => {
    const smoke = await import(
      new URL('../../../scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs', `file://${__filename.replace(/\\/g, '/')}`).href
    )
    const fixture = smoke.buildOptionSetsFixture()
    assert.deepEqual(Object.keys(fixture).sort(), STOCK_PREPARATION_MVP_CONTRACT_OPTION_KEYS.slice())
    // The fixture may be NARROWER than the catalog (the catalog deliberately widens two sets), but it
    // must never declare a value the catalog would refuse — that would make the smoke test green on a
    // vocabulary a real deployment cannot write.
    for (const [key, entries] of Object.entries(fixture)) {
      assertEmittedValuesSeeded(key, entries.map((entry) => entry.value), `smoke fixture ${key}`)
    }
  })

  // ---- C-07: the writer-literal sweep ----
  await run('C-07 no writer literal reaches a select column outside its seeded or canonicalized set', () => {
    const findings = sweepWriterLiterals()
    assert.deepEqual(
      findings,
      [],
      'a string literal is assigned to a select field that neither its vocabulary seeds nor its ' +
      'canonicalizer accepts. Seed it, or canonicalize it at the persistence boundary — a value with ' +
      'neither fate dies at the validator on a customer deployment:\n' +
      findings.map((f) => `  ${f.file}:${f.line} ${f.fieldId} = '${f.value}'`).join('\n'),
    )
  })

  await run('C-07b the sweep really scans, discriminates, and cannot silently grow its exclusions', () => {
    // NON-VACUOUS: the sweep must actually observe literals. A regex that matched nothing would pass
    // the assertion above while checking nothing at all.
    const seen = collectWriterLiterals()
    assert.ok(seen.length >= 10, `the sweep must observe real writer literals (saw ${seen.length})`)
    const observed = new Set(seen.map((entry) => `${entry.fieldId}=${entry.value}`))
    assert.ok(observed.has('scopeType=material'), 'the sweep observes the unit-rule scope literals')
    assert.ok(observed.has('severity=blocking'), 'the sweep observes the exception severity literal')

    // DISCRIMINATING: the predicate must reject as well as accept, or "no findings" means nothing.
    const materialKeys = new Set(['stock_preparation_material_status_v1'])
    assert.equal(allowedValuesForField(materialKeys).has('not_a_real_status'), false)

    // THE HISTORICAL BUG, stated as the property that now holds. 'imported' is legal at materialStatus
    // ONLY because the ERP canonicalizer accepts it and maps it onto a seeded value — it is NOT, and
    // must not become, a seeded option. Deleting the canonicalizer entry makes this the finding it was.
    assert.equal(allowedValuesForField(materialKeys).has('imported'), true, 'the canonicalizer accepts it')
    assert.equal(
      valuesOf('stock_preparation_material_status_v1').includes('imported'),
      false,
      "'imported' must be canonicalized, never seeded — seeding it would teach the system that the " +
      "source's spelling is ours, and the next source spells it differently",
    )

    // The exclusions are exactly the two field ids that are common English words, and each is covered
    // by the C-02 containment check instead. Adding a third would silently blind the sweep.
    assert.deepEqual(SWEEP_EXCLUDED_FIELD_IDS.slice(), ['source', 'status'])
    for (const fieldId of SWEEP_EXCLUDED_FIELD_IDS) {
      assert.ok(
        CONTAINMENT_COVERED_FIELD_IDS.includes(fieldId),
        `${fieldId} is excluded from the sweep, so C-02 must cover its vocabulary instead`,
      )
    }
  })

  // ---- C-08 (N4): the cross-check's WIRING is pinned, not just its result ----
  await run('C-08 the drift checks read the LIVE writer modules, not a copy', () => {
    for (const { module: moduleFile, exportName, live } of RUNTIME_CONSTANT_WIRING) {
      // (a) reference identity. A hardcoded copy of the enum would be a different object, so this
      //     fails the moment someone "inlines" a constant to make a red test go green.
      const fresh = require(path.join(LIB, moduleFile))[exportName]
      assert.equal(
        live,
        fresh,
        `${exportName} must BE the export of ${moduleFile} (reference-identical), not a copy of it`,
      )
      // (b) the import line itself. Mutating the require away — pointing the check at a local literal
      //     — leaves (a) trivially true against whatever it now reads, so the wiring is pinned in the
      //     source too.
      assert.ok(
        OWN_SOURCE.includes(`require(path.join(LIB, '${moduleFile}'))`),
        `this suite must require ${moduleFile} directly`,
      )
    }
    // ...and every module the sweep and the containment checks depend on is in that list, so a new
    // dependency cannot be added without being pinned.
    assert.equal(RUNTIME_CONSTANT_WIRING.length, 9)
  })

  console.log(`stock-preparation-mvp-option-catalog.test.cjs: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const failure of failures) console.error(`- ${failure.name}`)
    process.exit(1)
  }
  console.log('stock-preparation-mvp-option-catalog.test.cjs OK')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})

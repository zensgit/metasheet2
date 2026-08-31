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

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

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
const { RESOLUTION_ACTIONS } = require(path.join(LIB, 'stock-preparation-generation-runtime.cjs'))
const {
  SNAPSHOT_STATUS_DRAFT,
  RUN_TYPE_PLM_SYNC,
  RUN_STATUS_SUCCEEDED,
  RUN_STATUS_PARTIAL,
} = require(path.join(LIB, 'stock-preparation-sync-run-plan.cjs'))

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

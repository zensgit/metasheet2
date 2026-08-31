'use strict'

// `plugins/plugin-integration-core/app.manifest.json` — the BOM 备料 application declaration,
// checked against the RUNNING CODE it describes.
//
// WHY THIS SUITE EXISTS
//
// A manifest is a promise about a system, and a promise no one checks decays into documentation.
// The two production incidents this app already suffered were both identity drift — an operator
// invented a sandbox objectId and was refused, and two operators independently invented DIFFERENT
// ones so the installed pack declared a table that did not exist. A manifest that merely *stated*
// the right ids would have prevented neither, because nothing would have noticed when the manifest
// and the server disagreed.
//
// So every assertion below is a COUPLING, not a transcription. The suite never restates a rule the
// server owns; it imports the server's own function and asks it:
//
//   objectId namespace   -> `assertSandboxObjectId` from stock-preparation-target-provisioning.cjs
//                           (THE one authority; a copied regex is how two modules start disagreeing)
//   ledger objectId      -> `OBJECT_ID` from stock-preparation-confirmation-decisions.cjs
//   permission codes     -> `STOCK_PREP_PERMISSION_CODES` (frozen) from
//                           stock-preparation-workbench-access.cjs
//   route permission     -> `STOCK_PREP_ROUTE_PERMISSION` from the same module
//   posture entries      -> `buildPosture` from stock-preparation-preflight.cjs, called live
//   config env var names -> the preflight module's exported env-key constants
//   pack field name      -> `declaredPackTargets`, driven with a pack built FROM the manifest's own
//                           declared field name, so a wrong name falls back to canonical and fails
//
// A rename on either side therefore fails here, loudly, instead of turning the manifest into a lie.
//
// NOT A RUNTIME PATH. This file reads a JSON declaration and calls pure/inspection helpers. It
// provisions nothing, writes nothing, and touches no network or database.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PLUGIN_DIR = path.join(__dirname, '..')
const REPO_ROOT = path.join(PLUGIN_DIR, '..', '..')
const MANIFEST_PATH = path.join(PLUGIN_DIR, 'app.manifest.json')

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))

const {
  assertSandboxObjectId,
  StockPreparationTargetProvisioningError,
} = require('../lib/stock-preparation-target-provisioning.cjs')
const { OBJECT_ID: CONFIRMATION_LEDGER_OBJECT_ID } = require('../lib/stock-preparation-confirmation-decisions.cjs')
const {
  STOCK_PREP_PERMISSION_CODES,
  STOCK_PREP_ROUTE_PERMISSION,
} = require('../lib/stock-preparation-workbench-access.cjs')
const {
  B2A_REGISTRY_PATH_ENV,
  CUSTOMER_PACKS_PATH_ENV,
  EXT_FIELD_MAPPING_PATH_ENV,
  SANDBOX_MODE_ENV,
  SANDBOX_OBJECT_ID_NAMESPACE_PREFIX,
  SANDBOX_TARGET_OBJECT_IDS_ENV,
  __internals: { buildPosture, declaredPackTargets },
} = require('../lib/stock-preparation-preflight.cjs')

// ---------------------------------------------------------------------------
// 1. It parses, and the three identity layers are three separate things.
// ---------------------------------------------------------------------------

assert.equal(typeof manifest, 'object')
assert.equal(manifest.id, 'stock-preparation')
assert.equal(manifest.pluginId, 'plugin-integration-core')
assert.equal(manifest.pluginId, JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8')).name)
assert.equal(manifest.displayName, 'BOM 备料')
assert.equal(typeof manifest.valueStatement, 'string')
assert.ok(manifest.valueStatement.length > 0, 'the one-line value statement must not be empty')
// The identity is not the display name. If these ever collapse into one field, the "rename for the
// next customer" promise in the design silently becomes "rename and break every route".
assert.notEqual(manifest.id, manifest.displayName)
assert.notEqual(manifest.displayName, manifest.valueStatement)
assert.match(manifest.version, /^\d+\.\d+\.\d+/)

// ---------------------------------------------------------------------------
// 2. Managed objects: multitable-backed, idempotent-ensured, never-invented ids.
// ---------------------------------------------------------------------------

const APP_OBJECT_ID_PREFIX = 'plm_stock_preparation'
const managedObjects = manifest.objects.filter((object) => object.objectIdPolicy !== undefined)
assert.equal(managedObjects.length, 2, 'BOM 备料 declares exactly two managed objects')
assert.equal(
  managedObjects.length,
  manifest.objects.length,
  'every object this app declares is a managed one; an unmanaged entry here would be an object nobody installs',
)

/** Does `assertSandboxObjectId` accept this id? Returns the refusal reason when it does not. */
function sandboxRefusalReason(objectId) {
  try {
    assertSandboxObjectId(objectId)
    return null
  } catch (error) {
    assert.ok(
      error instanceof StockPreparationTargetProvisioningError,
      'the sandbox guard must refuse through its own error type',
    )
    return error.details && error.details.reason
  }
}

for (const object of managedObjects) {
  assert.equal(object.backing, 'multitable', `${object.id} must be multitable-backed`)
  assert.ok(object.name && object.name.length > 0, `${object.id} must carry a display name`)
  assert.ok(object.displayNames && object.displayNames['zh-CN'], `${object.id} must name itself in zh-CN`)
  assert.equal(object.displayNames['zh-CN'], object.name, `${object.id}: name and zh-CN display name must agree`)

  // THE ENSURE MARKER. An installer re-runs every ensure on every install, so an object whose
  // creation is not idempotent may not be declared at all.
  assert.ok(object.ensure, `${object.id} must declare the ensure that creates it`)
  assert.equal(object.ensure.idempotent, true, `${object.id}: ensure must be declared idempotent`)
  assert.equal(object.ensure.method, 'POST')
  assert.match(object.ensure.path, /^\/api\/integration\/stock-preparation\//)
  assert.equal(object.ensure.permission, 'admin', `${object.id}: ensure provisions schema, so it stays admin-gated`)
}

const ledger = managedObjects.find((object) => object.id === 'confirmationDecisionLedger')
assert.ok(ledger, 'the confirmation ledger must be declared')
assert.equal(ledger.objectIdPolicy, 'fixed')
// THE identity check for the ledger: the module that owns the table is asked what it is called.
assert.equal(
  ledger.objectId,
  CONFIRMATION_LEDGER_OBJECT_ID,
  'the declared ledger objectId must be the one the confirmation-decisions module provisions',
)
assert.ok(ledger.objectId.startsWith(`${APP_OBJECT_ID_PREFIX}_`), 'a managed object stays in the app namespace')
// It is emphatically NOT a sandbox id — the two namespaces are distinct and the guard says so.
assert.equal(sandboxRefusalReason(ledger.objectId), 'not_sandbox_namespace')
assert.equal(ledger.columnCount, 16)
assert.deepEqual(ledger.ensure.body, {})

const sandbox = managedObjects.find((object) => object.id === 'sandboxTarget')
assert.ok(sandbox, 'the sandbox target must be declared')
assert.equal(sandbox.objectIdPolicy, 'from-config')
assert.equal(
  sandbox.objectId,
  undefined,
  'the sandbox target must NOT hard-code one deployment\'s objectId — that is the mistake being prevented',
)
// THE namespace check, decided by the server's own authority rather than by a regex copied here.
assert.equal(
  sandbox.objectIdNamespace,
  SANDBOX_OBJECT_ID_NAMESPACE_PREFIX,
  'the declared namespace must be the one the server enforces',
)
assert.equal(
  sandboxRefusalReason(sandbox.objectIdNamespace),
  null,
  'the declared namespace must itself be an acceptable sandbox objectId',
)
assert.equal(
  sandboxRefusalReason(`${sandbox.objectIdNamespace}_trial`),
  null,
  'a concrete id inside the declared namespace must be accepted',
)
// Negative control on the guard itself: without this, a namespace of `''` would "pass" vacuously.
assert.equal(
  sandboxRefusalReason('stock_prep_sandbox_trial'),
  'not_sandbox_namespace',
  'the guard must still refuse an id outside the declared namespace',
)
assert.ok(sandbox.objectIdNamespace.startsWith(APP_OBJECT_ID_PREFIX), 'the sandbox namespace stays in the app namespace')
assert.equal(sandbox.columnCount, 25)

// The dependency is expressed, not hard-coded: the id comes from a named field of a named config
// surface. Proven live — a pack is built using the manifest's OWN field name and handed to the
// server's `declaredPackTargets`; a wrong field name falls through to the canonical target and this
// assertion fails.
assert.ok(sandbox.objectIdFrom, 'the sandbox target must say where its objectId comes from')
const sandboxProbeObjectId = `${sandbox.objectIdNamespace}_manifest_probe`
const declaredFromManifestField = declaredPackTargets({
  list: () => [{ packId: 'manifest-probe', [sandbox.objectIdFrom.field]: sandboxProbeObjectId, extensionFields: [] }],
})
assert.deepEqual(
  declaredFromManifestField.map((entry) => entry.objectId),
  [sandboxProbeObjectId],
  `the server reads a pack's target from '${sandbox.objectIdFrom.field}'; the manifest must name that same field`,
)
assert.equal(declaredFromManifestField[0].isCanonical, false)
assert.equal(
  sandbox.ensure.bodyFrom.objectId,
  `${sandbox.objectIdFrom.configSurface}.${sandbox.objectIdFrom.field}`,
  'the ensure body must be fed from the same config surface the objectId is declared to come from',
)

// ---------------------------------------------------------------------------
// 3. Permissions: exactly the frozen set, and zero automatic holders.
// ---------------------------------------------------------------------------

assert.deepEqual(
  [...manifest.permissions].sort(),
  [...STOCK_PREP_PERMISSION_CODES].sort(),
  'every declared permission code must exist in the workbench-access frozen set (and none may be missing)',
)
for (const code of manifest.permissions) {
  assert.ok(
    STOCK_PREP_PERMISSION_CODES.includes(code),
    `declared permission ${code} is not in the frozen set — the gate would refuse it for everyone, admins included`,
  )
}
assert.ok(manifest.permissionPolicy, 'the manifest must state who holds these codes on install')
assert.deepEqual(
  manifest.permissionPolicy.automaticHolders,
  [],
  'R-11 映射零自动: installing the app grants these codes to NOBODY',
)
assert.ok(fs.existsSync(path.join(REPO_ROOT, manifest.permissionPolicy.source)), 'permissionPolicy.source must exist')

// ---------------------------------------------------------------------------
// 4. Navigation: /stock-prep, gated by the code the route actually requires.
// ---------------------------------------------------------------------------

assert.equal(manifest.navigation.length, 1)
const nav = manifest.navigation[0]
assert.equal(nav.path, '/stock-prep')
assert.equal(nav.location, 'main-nav')
const webRoutes = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'web', 'src', 'router', 'appRoutes.ts'), 'utf8')
assert.ok(webRoutes.includes(`path: '${nav.path}'`), 'the declared navigation path must be a real web route')
assert.ok(
  webRoutes.includes(`permissions: ['${STOCK_PREP_ROUTE_PERMISSION}']`),
  'the workbench route must be gated by the queue READ code the access module names',
)

// ---------------------------------------------------------------------------
// 5. Config surfaces: deployment data, named by env var, never committed.
// ---------------------------------------------------------------------------

const configSurfaces = manifest.configSurfaces || []
const configSurfaceById = new Map(configSurfaces.map((surface) => [surface.id, surface]))
assert.equal(configSurfaces.length, configSurfaceById.size, 'config surface ids must be unique')
for (const surface of configSurfaces) {
  assert.equal(surface.committed, false, `${surface.id} is deployment data and must never be committed`)
  assert.ok(surface.note && surface.note.length > 0, `${surface.id} must say what it is`)
}
// The sandbox target's declared source must be a config surface that exists.
assert.ok(
  configSurfaceById.has(sandbox.objectIdFrom.configSurface),
  `sandbox objectIdFrom names config surface '${sandbox.objectIdFrom.configSurface}', which is not declared`,
)

const customerPack = configSurfaceById.get('customerPack')
assert.ok(customerPack, 'the customer pack config surface must be declared')
assert.equal(customerPack.kind, 'deployment-data-file')
assert.equal(
  customerPack.envVar,
  CUSTOMER_PACKS_PATH_ENV,
  'the customer pack env var must be the key the server reads the pack file from',
)
assert.equal(
  customerPack.serverConfigKey,
  require('../lib/stock-preparation-customer-pack-catalog.cjs').CUSTOMER_PACK_CONFIG_KEY,
)

const extFieldMapping = configSurfaceById.get('extFieldMapping')
assert.ok(extFieldMapping, 'the ext-field mapping config surface must be declared')
assert.equal(extFieldMapping.kind, 'deployment-data-file')
assert.equal(
  extFieldMapping.envVar,
  EXT_FIELD_MAPPING_PATH_ENV,
  'the mapping env var must be the key the server reads the mapping file from',
)
assert.equal(
  extFieldMapping.serverConfigKey,
  require('../lib/stock-preparation-ext-field-mapping-config.cjs').EXT_FIELD_MAPPING_CONFIG_KEY,
)

const sandboxWrite = configSurfaceById.get('sandboxWriteAuthorization')
assert.ok(sandboxWrite, 'installing columns and authorizing row writes are two separate grants; both are declared')
assert.equal(sandboxWrite.kind, 'env-allowlist')
assert.deepEqual([...sandboxWrite.envVars].sort(), [SANDBOX_MODE_ENV, SANDBOX_TARGET_OBJECT_IDS_ENV].sort())

// ---------------------------------------------------------------------------
// 6. Acceptance: two criteria, stated so a harness can check them.
// ---------------------------------------------------------------------------

const acceptance = manifest.acceptance
assert.ok(acceptance, 'the manifest must define what "installed" means')
assert.deepEqual(
  acceptance.criteria.map((criterion) => criterion.id),
  ['ext-columns-written-human-band-untouched', 'second-refresh-all-skip'],
)
for (const criterion of acceptance.criteria) {
  assert.ok(criterion.statement && criterion.statement.length > 0)
  assert.ok(Array.isArray(criterion.assertions) && criterion.assertions.length > 0, `${criterion.id} needs assertions`)
  for (const check of criterion.assertions) {
    assert.ok(['target-rows', 'dry-run-plan'].includes(check.scope), `${criterion.id}: unknown scope ${check.scope}`)
    assert.ok(
      ['some-non-empty', 'all-empty', 'all-actions-skip'].includes(check.predicate),
      `${criterion.id}: unknown predicate ${check.predicate}`,
    )
  }
}
// Criterion 1 is BOTH halves: the ext_ band filled AND the human band untouched. Asserting only the
// first would pass on a run that overwrote a human column, which is the failure the app most fears.
const written = acceptance.criteria[0].assertions
assert.deepEqual(
  written.map((check) => `${check.columns}:${check.predicate}`).sort(),
  ['human-preserved:all-empty', 'mapped-ext:some-non-empty'],
)
assert.equal(acceptance.criteria[1].assertions[0].predicate, 'all-actions-skip')
assert.equal(acceptance.criteria[1].assertions[0].run, 2, 'idempotency is a claim about the SECOND run')

assert.match(acceptance.verifiedBy.script, /^scripts\/ops\/[\w.-]+\.mjs$/)
assert.ok(fs.existsSync(path.join(REPO_ROOT, acceptance.runbook.split('#')[0])), 'the referenced runbook must exist')
// The harness lands on its own branch (feat/stock-prep-acceptance-bootstrap), so its presence is
// not asserted here — a manifest must not be blocked on a sibling merge, and a test that failed
// until an unrelated PR landed would only teach people to delete the assertion. It DOES tighten by
// itself the moment the file arrives: a harness that re-implemented the namespace rule instead of
// importing the server's authority would be the same drift the whole manifest exists to prevent.
const verifierPath = path.join(REPO_ROOT, acceptance.verifiedBy.script)
if (fs.existsSync(verifierPath)) {
  assert.match(
    fs.readFileSync(verifierPath, 'utf8'),
    /assertSandboxObjectId/,
    'the acceptance harness must use the server\'s own sandbox-objectId authority, not a copy of the rule',
  )
}

// ---------------------------------------------------------------------------
// 7. Posture: reported, never installed, and carrying no instruction to arm anything.
// ---------------------------------------------------------------------------

const posture = manifest.posture
assert.ok(posture, 'the four fences must be declared')
assert.equal(posture.mode, 'reported-not-installed')
assert.equal(posture.installerMayModify, false)

// The declared fences must be exactly the fences the server reports — asked live, with the
// dormant/unset inputs a correct deployment has.
const serverPosture = buildPosture({ config: {}, b2aTrialRegistry: null, env: {} })
assert.deepEqual(
  posture.entries.map((entry) => entry.id).sort(),
  Object.keys(serverPosture).sort(),
  'the manifest must declare exactly the fences the preflight reports — no more, no fewer',
)
for (const entry of posture.entries) {
  assert.equal(
    entry.expectedState,
    serverPosture[entry.id].state,
    `posture ${entry.id}: the manifest's expected state must be the state a correct deployment actually reports`,
  )
  if (entry.envVar !== undefined) {
    assert.equal(entry.envVar, serverPosture[entry.id].envVar, `posture ${entry.id}: env var name drifted`)
  }
}
assert.equal(posture.entries.find((entry) => entry.id === 'b2aTrialRegistry').envVar, B2A_REGISTRY_PATH_ENV)

// NO FIX / ENABLE INSTRUCTION OF ANY KIND.
//
// Two independent checks, because either alone has a hole. The key ALLOWLIST catches a key by any
// name (`fix`, `remediation`, `howToArm`, …) — a denylist would only catch the names someone thought
// of. The VALUE scan catches an instruction smuggled into an allowed prose field: an env assignment
// (`KEY=value`) or a mutating HTTP call, which is exactly the shape every `fix` in this codebase
// takes (see `httpFix` / `envFix` in stock-preparation-preflight.cjs).
const POSTURE_ENTRY_KEYS = ['id', 'expectedState', 'what', 'envVar']
for (const entry of posture.entries) {
  for (const key of Object.keys(entry)) {
    assert.ok(
      POSTURE_ENTRY_KEYS.includes(key),
      `posture ${entry.id} carries '${key}'. A posture entry reports a fence; it may never tell anyone how to arm one.`,
    )
  }
}
const ENV_ASSIGNMENT = /[A-Z][A-Z0-9_]{5,}\s*=/
const MUTATING_CALL = /\b(POST|PUT|PATCH|DELETE)\s+\//
function scanForInstructions(value, trail) {
  if (typeof value === 'string') {
    assert.equal(
      ENV_ASSIGNMENT.test(value),
      false,
      `posture${trail} reads as an env assignment — that is an instruction to arm a fence: ${value}`,
    )
    assert.equal(
      MUTATING_CALL.test(value),
      false,
      `posture${trail} names a mutating call — posture reports, it never installs: ${value}`,
    )
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForInstructions(item, `${trail}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) scanForInstructions(item, `${trail}.${key}`)
  }
}
scanForInstructions(posture, '')
// Positive control for the scanner: it must actually recognise the two instruction shapes it bans.
assert.throws(
  () => scanForInstructions({ fix: `${SANDBOX_MODE_ENV}=true` }, ''),
  /env assignment/,
  'the instruction scanner must catch an env assignment',
)
assert.throws(
  () => scanForInstructions({ fix: 'POST /api/integration/stock-preparation/target/ensure {}' }, ''),
  /mutating call/,
  'the instruction scanner must catch a mutating call',
)

console.log(
  `✓ app-manifest: BOM 备料 declared — ${managedObjects.length} managed objects, ` +
    `${manifest.permissions.length} permission codes, ${configSurfaces.length} config surfaces, ` +
    `${acceptance.criteria.length} acceptance criteria, ${posture.entries.length} reported-not-installed fences`,
)

'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  PACKAGE_PROVENANCE_VERSION,
  PINNED_PROFILE_IDENTITY,
  PINNED_MIGRATIONS,
  PINNED_S1_MODULES,
  PINNED_S2_MODULES,
  PINNED_S3_MODULES,
  PINNED_S4_MODULES,
  PINNED_S5_MODULES,
  PINNED_S6_MODULES,
  PINNED_EXTERNAL_MODULES,
  PINNED_RUNTIME_DEPENDENCIES,
  PINNED_RUNTIME_FILES,
  PINNED_EVIDENCE_FILES,
  FROZEN_MANIFEST_RELATIVE,
  verifySealedExportPackageProvenance,
  verifySealedExportRuntimePackageProvenance,
  computePackageProvenancePinSet,
} = require('../lib/sealed-export/sealed-export-package-provenance.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
// The pinned executor of the S6-A Windows PowerShell 5.1 acceptance test (evidence id
// `s6aPowershell51Workflow`), and the high-churn workflow that deliberately is NOT a
// provenance input any more.
const S6A_PS51_WORKFLOW = '.github/workflows/stock-prep-powershell51.yml'
const PLUGIN_TESTS_WORKFLOW = '.github/workflows/plugin-tests.yml'

function expectReason(fn, reason) {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError)
  assert.equal(caught.reason, reason)
  return caught
}

function positivePackagePin() {
  const result = verifySealedExportPackageProvenance({ repoRoot: REPO_ROOT })
  assert.equal(result.verified, true)
  assert.equal(result.candidateTreeVerified, true)
  assert.equal(result.externalPackagePinRequired, true)
  assert.match(result.frozenManifestDigest, /^[0-9a-f]{64}$/)
  assert.equal(result.packageProvenanceVersion, PACKAGE_PROVENANCE_VERSION)
  assert.equal(result.profileIdentity.profileId, 'sqlserver.sealed_snapshot.v1')
  assert.ok(result.migrations['070'])
  assert.ok(result.migrations['071'])
  assert.ok(result.migrations['072'])
  assert.ok(result.migrations['073'])
  assert.equal(PINNED_MIGRATIONS.length, 6)
  assert.equal(
    Object.keys(result.modules.s5).length,
    PINNED_S5_MODULES.length,
  )
  assert.equal(
    Object.keys(result.modules.s6).length,
    PINNED_S6_MODULES.length,
  )
  assert.deepEqual(result.runtimeDependencies, PINNED_RUNTIME_DEPENDENCIES)
  assert.equal(
    Object.keys(result.runtimeFiles).length,
    PINNED_RUNTIME_FILES.length,
  )
  assert.equal(
    Object.keys(result.evidenceFiles).length,
    PINNED_EVIDENCE_FILES.length,
  )
  assert.equal(
    PINNED_RUNTIME_FILES.some(
      (entry) => entry.id === 'multitableOnpremPackageVerify',
    ),
    true,
  )
  assert.equal(
    PINNED_RUNTIME_FILES.some(
      (entry) => entry.id === 'multitableOnpremPackageBuild',
    ),
    false,
  )
  assert.equal(
    PINNED_EVIDENCE_FILES.some(
      (entry) => entry.id === 'multitableOnpremPackageBuild',
    ),
    true,
  )
  // The S6-A PowerShell 5.1 executor is pinned as its own whole file, and it really
  // executes the pinned PS 5.1 test with the exit-code check right after it.
  const ps51Executor = PINNED_EVIDENCE_FILES.find(
    (entry) => entry.id === 's6aPowershell51Workflow',
  )
  assert.equal(ps51Executor && ps51Executor.relativePath, S6A_PS51_WORKFLOW)
  const ps51Test = PINNED_EVIDENCE_FILES.find(
    (entry) => entry.id === 's6aAcceptancePs51Test',
  )
  assert.ok(ps51Test)
  assert.ok(
    fs
      .readFileSync(path.join(REPO_ROOT, S6A_PS51_WORKFLOW), 'utf8')
      .includes(
        `${ps51Test.relativePath}\n          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n`,
      ),
    'the pinned executor must run the pinned S6-A PowerShell 5.1 test and check its exit code',
  )
  assert.equal(PINNED_PROFILE_IDENTITY.connectorKind, 'data-source:sql-readonly')
  assert.deepEqual(Object.keys(result.externalModules), [
    'gipProfileCertificationContracts',
    'gipCanonicalJson',
    'pluginDb',
    'stockPreparationDecoder',
    'stockPreparationReadonlyIntake',
    'stockPreparationPlmSourcePersistBridge',
    'stockPreparationSyncRunPersist',
  ])
  assert.ok(PINNED_S2_MODULES.includes('sqlserver-s2-producer.cjs'))
  assert.ok(PINNED_S3_MODULES.includes('private-ingestion-service.cjs'))
  assert.ok(PINNED_S4_MODULES.includes('generation-kernel.cjs'))
  assert.ok(fs.existsSync(path.join(REPO_ROOT, FROZEN_MANIFEST_RELATIVE)))

  const runtimePackage = verifySealedExportRuntimePackageProvenance({
    repoRoot: REPO_ROOT,
  })
  assert.equal(runtimePackage.verified, true)
  assert.equal(runtimePackage.runtimePackageVerified, true)
  assert.equal(runtimePackage.repositoryEvidenceRequired, true)
  assert.equal(runtimePackage.candidateTreeVerified, undefined)
}

async function clonePinnedTree() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s6a-prov-'),
  )
  const sealedRel = 'plugins/plugin-integration-core/lib/sealed-export'
  const sealedSrc = path.join(REPO_ROOT, sealedRel)
  const sealedDst = path.join(root, sealedRel)
  fs.mkdirSync(sealedDst, { recursive: true })
  fs.mkdirSync(path.join(sealedDst, 'vectors'), { recursive: true })
  for (const name of fs.readdirSync(sealedSrc)) {
    const src = path.join(sealedSrc, name)
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(sealedDst, name))
    }
  }
  fs.copyFileSync(
    path.join(REPO_ROOT, FROZEN_MANIFEST_RELATIVE),
    path.join(root, FROZEN_MANIFEST_RELATIVE),
  )
  for (const migration of PINNED_MIGRATIONS) {
    const dest = path.join(root, migration.relativePath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, migration.relativePath), dest)
  }
  for (const entry of PINNED_RUNTIME_FILES) {
    const dest = path.join(root, entry.relativePath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, entry.relativePath), dest)
  }
  for (const entry of PINNED_EXTERNAL_MODULES) {
    const dest = path.join(root, entry.relativePath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, entry.relativePath), dest)
  }
  for (const entry of PINNED_EVIDENCE_FILES) {
    const dest = path.join(root, entry.relativePath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, entry.relativePath), dest)
  }
  return root
}

async function isolatedModuleMissingFails() {
  const root = await clonePinnedTree()
  try {
    fs.rmSync(
      path.join(
        root,
        'plugins/plugin-integration-core/lib/sealed-export/sqlserver-sealed-snapshot-action.cjs',
      ),
    )
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function sameSizeLogicMutationOfPinnedModuleFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(
      root,
      'plugins/plugin-integration-core/lib/sealed-export/sqlserver-sealed-snapshot-action.cjs',
    )
    const original = fs.readFileSync(target, 'utf8')
    // Same-length logic mutation: flip a stable token without changing size.
    const mutated = original.includes('rowid_payload')
      ? original.replace('rowid_payload', 'rowid_payloax')
      : original.replace(/a/g, 'b')
    assert.equal(mutated.length, original.length)
    assert.notEqual(mutated, original)
    fs.writeFileSync(target, mutated)
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function sameSizeLogicMutationOfPinnedMigrationFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(
      root,
      'packages/core-backend/migrations/071_harden_integration_sealed_export_authority_lifecycle.sql',
    )
    const original = fs.readFileSync(target, 'utf8')
    // Keep both marker strings; mutate the trigger error code at equal length.
    const mutated = original.replace("'55000'", "'55001'")
    assert.ok(mutated.includes('integration_sealed_export_authority_state_guard'))
    assert.ok(mutated.includes('trg_integration_sealed_export_authority_state_guard'))
    assert.equal(mutated.length, original.length)
    assert.notEqual(mutated, original)
    fs.writeFileSync(target, mutated)
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function terminalHistoryMigrationMutationFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(
      root,
      'packages/core-backend/migrations/072_harden_integration_sealed_export_terminal_signer_history.sql',
    )
    const original = fs.readFileSync(target, 'utf8')
    const mutated = original.replace("'55000'", "'55001'")
    assert.notEqual(mutated, original)
    fs.writeFileSync(target, mutated)
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function runtimeAuthorityMigrationMutationFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(
      root,
      'packages/core-backend/migrations/073_create_sealed_export_stock_prep_runtime_authority.sql',
    )
    const original = fs.readFileSync(target, 'utf8')
    const mutated = original.replace(
      "'CAPTURING'",
      "'CAPTUREXX'",
    )
    assert.equal(mutated.length, original.length)
    assert.notEqual(mutated, original)
    fs.writeFileSync(target, mutated)
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function s6RuntimeModuleMutationFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(
      root,
      'plugins/plugin-integration-core/lib/sealed-export/stock-preparation-runtime-core.cjs',
    )
    const original = fs.readFileSync(target, 'utf8')
    const mutated = original.replace(
      "'COMPLETED'",
      "'COMPLETEZ'",
    )
    assert.equal(mutated.length, original.length)
    assert.notEqual(mutated, original)
    fs.writeFileSync(target, mutated)
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function canonicalJsonDependencyMutationFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(
      root,
      'plugins/plugin-integration-core/lib/gip-canonical-json.cjs',
    )
    fs.appendFileSync(target, '\n// provenance mutation\n')
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function evidenceRunnerMutationFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(
      root,
      'scripts/ops/run-sealed-export-s5-sqlserver-evidence.cjs',
    )
    const original = fs.readFileSync(target, 'utf8')
    const mutated = original.replace(
      'runtimeReachable: false,',
      'runtimeReachable: true ,',
    )
    assert.equal(mutated.length, original.length)
    assert.notEqual(mutated, original)
    fs.writeFileSync(target, mutated)
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

// Literal replacement of an anchor that must occur exactly once (split/join: no `$` patterns).
function replaceExactlyOnce(text, anchor, replacement) {
  assert.equal(
    text.split(anchor).length,
    2,
    `mutation anchor must occur exactly once: ${JSON.stringify(anchor)}`,
  )
  const mutated = text.split(anchor).join(replacement)
  assert.notEqual(mutated, text)
  return mutated
}

// One entry per tamper class against the pinned S6-A PowerShell 5.1 executor. Each must move
// the whole-file digest: verification fails closed and the live recompute no longer equals the
// frozen pin, until the pin is recomputed in the same change. The unit is the whole file, not
// the job: keys placed after `jobs:` (T3) still apply to every job in it.
const S6A_PS51_WORKFLOW_TAMPERS = Object.freeze([
  ['same-length edit of the pinned S6-A test path', (text) => {
    const mutated = replaceExactlyOnce(
      text,
      'scripts/ops/__tests__/stock-preparation-s6a-onprem-acceptance.ps51.tests.ps1\n',
      'scripts/ops/__tests__/stock-preparation-s6a-onprem-acceptance.ps52.tests.ps1\n',
    )
    assert.equal(mutated.length, text.length)
    return mutated
  }],
  ['T1 extra run step', (text) => replaceExactlyOnce(
    text,
    '      - name: Setup Node.js 20.x\n',
    '      - name: Extra step\n        run: echo extra\n\n      - name: Setup Node.js 20.x\n',
  )],
  ['T2 action reference', (text) => replaceExactlyOnce(
    text,
    'uses: actions/checkout@v4',
    'uses: actions/checkout@v3',
  )],
  ['T3 top-level permissions placed after jobs:', (text) => {
    const mutated = `${text}permissions: write-all\n`
    assert.ok(mutated.lastIndexOf('\npermissions:') > mutated.indexOf('\njobs:'))
    return mutated
  }],
  ['T4 workflow-level env', (text) => replaceExactlyOnce(
    text,
    "env:\n  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'\n",
    "env:\n  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'\n  EXTRA_ENV: '1'\n",
  )],
  ['T5 toolchain version', (text) => replaceExactlyOnce(
    text,
    'node-version: 20.x',
    'node-version: 18.x',
  )],
  ['T6 exit-code check after the S6-A test dropped', (text) => replaceExactlyOnce(
    text,
    'stock-preparation-s6a-onprem-acceptance.ps51.tests.ps1\n          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n',
    'stock-preparation-s6a-onprem-acceptance.ps51.tests.ps1\n',
  )],
  ['T6 job made non-blocking', (text) => replaceExactlyOnce(
    text,
    '    runs-on: windows-latest\n',
    '    runs-on: windows-latest\n    continue-on-error: true\n',
  )],
  ['T6 job skipped', (text) => replaceExactlyOnce(
    text,
    '    runs-on: windows-latest\n',
    '    if: false\n    runs-on: windows-latest\n',
  )],
  ['T6 pull_request trigger narrowed', (text) => replaceExactlyOnce(
    text,
    '  pull_request:\n    branches: [main, develop]\n',
    '  pull_request:\n    branches: [develop]\n',
  )],
  ['comment-only edit (whole-file bytes, no normalisation)', (text) => `# note\n${text}`],
])

async function s6aPowershell51ExecutorTamperFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(root, S6A_PS51_WORKFLOW)
    const original = fs.readFileSync(target, 'utf8')
    const frozen = JSON.parse(
      fs.readFileSync(path.join(root, FROZEN_MANIFEST_RELATIVE), 'utf8'),
    )
    for (const [label, tamper] of S6A_PS51_WORKFLOW_TAMPERS) {
      fs.writeFileSync(target, tamper(original))
      expectReason(
        () => verifySealedExportPackageProvenance({ repoRoot: root }),
        'SEALED_EXPORT_INTERNAL_ERROR',
      )
      assert.notEqual(
        computePackageProvenancePinSet(root).evidenceFiles.s6aPowershell51Workflow,
        frozen.evidenceFiles.s6aPowershell51Workflow,
        `live recompute must diverge from the frozen pin: ${label}`,
      )
      // Positive control: the red above is this mutation's, not the clone's.
      fs.writeFileSync(target, original)
      assert.equal(
        verifySealedExportPackageProvenance({ repoRoot: root }).verified,
        true,
        `restored executor must verify again: ${label}`,
      )
    }
    fs.rmSync(target)
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

// plugin-tests.yml executes no pinned file and is not a provenance input: editing it (a comment,
// a new run-list step) or deleting it moves no pin and keeps the frozen manifest digest.
async function pluginTestsWorkflowIsNotAProvenanceInput() {
  const everyPinnedPath = [
    ...PINNED_MIGRATIONS,
    ...PINNED_EXTERNAL_MODULES,
    ...PINNED_RUNTIME_FILES,
    ...PINNED_EVIDENCE_FILES,
  ].map((entry) => entry.relativePath)
  assert.equal(everyPinnedPath.includes(PLUGIN_TESTS_WORKFLOW), false)
  const root = await clonePinnedTree()
  try {
    const target = path.join(root, PLUGIN_TESTS_WORKFLOW)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, PLUGIN_TESTS_WORKFLOW), target)
    const frozen = JSON.parse(
      fs.readFileSync(path.join(root, FROZEN_MANIFEST_RELATIVE), 'utf8'),
    )
    const baseline = verifySealedExportPackageProvenance({ repoRoot: root })
    const original = fs.readFileSync(target, 'utf8')
    for (const mutated of [
      `# comment-only edit\n${original}`,
      `${original}      - name: Extra run-list step\n        run: node --test scripts/ops/new-guard.test.mjs\n`,
    ]) {
      fs.writeFileSync(target, mutated)
      const result = verifySealedExportPackageProvenance({ repoRoot: root })
      assert.equal(result.verified, true)
      assert.equal(result.frozenManifestDigest, baseline.frozenManifestDigest)
      assert.deepEqual(
        JSON.parse(JSON.stringify(computePackageProvenancePinSet(root))),
        frozen,
      )
    }
    fs.rmSync(target)
    assert.equal(
      verifySealedExportPackageProvenance({ repoRoot: root }).verified,
      true,
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function packageBuildNoDepsControlMutationFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(
      root,
      'scripts/ops/multitable-onprem-package-build.sh',
    )
    const original = fs.readFileSync(target, 'utf8')
    const mutated = original.replace(
      'install-deps:0^|1',
      'install-deps:1^|1',
    )
    assert.equal(mutated.length, original.length)
    assert.notEqual(mutated, original)
    fs.writeFileSync(target, mutated)
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function isolatedDependencyMutationFails() {
  const root = await clonePinnedTree()
  try {
    fs.writeFileSync(
      path.join(root, 'plugins/plugin-integration-core/package.json'),
      JSON.stringify(
        {
          name: 'plugin-integration-core',
          dependencies: { mssql: '^9.0.0', pg: '^8.11.3' },
        },
        null,
        2,
      ),
    )
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function profileCertificationDependencyMutationFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(
      root,
      'plugins/plugin-integration-core/lib/gip-profile-certification-contracts.cjs',
    )
    const original = fs.readFileSync(target, 'utf8')
    const mutated = original.replace(
      'SOURCE_SNAPSHOT_TXN',
      'SOURCE_SNAPSHOT_TXX',
    )
    assert.equal(mutated.length, original.length)
    assert.notEqual(mutated, original)
    fs.writeFileSync(target, mutated)
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

async function isolatedLockfileMutationFails() {
  const root = await clonePinnedTree()
  try {
    const target = path.join(root, 'pnpm-lock.yaml')
    const original = fs.readFileSync(target, 'utf8')
    const mutated = original.replace(
      'mssql@10.0.4:',
      'mssql@10.0.5:',
    )
    assert.notEqual(mutated, original)
    fs.writeFileSync(target, mutated)
    expectReason(
      () => verifySealedExportPackageProvenance({ repoRoot: root }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

function runPackageShellVerifier(root) {
  return spawnSync(
    'bash',
    [
      '-lc',
      'source "$VERIFY_SCRIPT"; ' +
        'verify_sealed_export_package_provenance "$PACKAGE_ROOT"',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PACKAGE_ROOT: root,
        VERIFY_SCRIPT: path.join(
          REPO_ROOT,
          'scripts/ops/multitable-onprem-package-verify.sh',
        ),
      },
    },
  )
}

async function packageShellVerifierRejectsPinnedMutation() {
  const verifierText = fs.readFileSync(
    path.join(
      REPO_ROOT,
      'scripts/ops/multitable-onprem-package-verify.sh',
    ),
    'utf8',
  )
  assert.match(
    verifierText,
    /verify_sealed_export_package_provenance "\$pkg_root"/,
  )
  const root = await clonePinnedTree()
  try {
    for (const entry of PINNED_EVIDENCE_FILES) {
      fs.rmSync(path.join(root, entry.relativePath), { force: true })
    }
    const clean = runPackageShellVerifier(root)
    assert.equal(clean.status, 0, clean.stderr)
    fs.appendFileSync(
      path.join(
        root,
        'plugins/plugin-integration-core/lib/sealed-export/' +
          'stock-preparation-runtime-core.cjs',
      ),
      '\n',
    )
    const mutated = runPackageShellVerifier(root)
    assert.notEqual(mutated.status, 0)
    assert.match(
      mutated.stderr,
      /S6-A sealed-export package provenance pins did not verify/,
    )
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

function frozenManifestIsIndependentOfWorkingTreeMutation() {
  // The candidate tree and repository-frozen manifest agree. The returned
  // frozenManifestDigest is what a later package gate must pin externally.
  const live = computePackageProvenancePinSet(REPO_ROOT)
  const frozen = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, FROZEN_MANIFEST_RELATIVE), 'utf8'),
  )
  assert.deepEqual(live.migrations, frozen.migrations)
  assert.deepEqual(live.modules, frozen.modules)
  assert.deepEqual(live.externalModules, frozen.externalModules)
  assert.deepEqual(live.dependencies, frozen.dependencies)
  assert.deepEqual(live.runtimeFiles, frozen.runtimeFiles)
  assert.deepEqual(live.evidenceFiles, frozen.evidenceFiles)
}

async function main() {
  positivePackagePin()
  frozenManifestIsIndependentOfWorkingTreeMutation()
  await isolatedModuleMissingFails()
  await sameSizeLogicMutationOfPinnedModuleFails()
  await sameSizeLogicMutationOfPinnedMigrationFails()
  await terminalHistoryMigrationMutationFails()
  await runtimeAuthorityMigrationMutationFails()
  await s6RuntimeModuleMutationFails()
  await profileCertificationDependencyMutationFails()
  await canonicalJsonDependencyMutationFails()
  await evidenceRunnerMutationFails()
  await s6aPowershell51ExecutorTamperFails()
  await pluginTestsWorkflowIsNotAProvenanceInput()
  await packageBuildNoDepsControlMutationFails()
  await isolatedDependencyMutationFails()
  await isolatedLockfileMutationFails()
  await packageShellVerifierRejectsPinnedMutation()
  console.log('sealed-export-package-provenance.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

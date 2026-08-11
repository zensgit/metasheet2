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

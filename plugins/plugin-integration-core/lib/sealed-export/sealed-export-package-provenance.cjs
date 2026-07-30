'use strict'

// Sealed-export S5 — package/provenance verification (issue #4690 deliverable 6).
//
// LATENT: hermetic pin verifier only. No deployment, packaging, or runtime
// wiring.
//
// Expected digests are loaded from a repository-frozen candidate manifest.
// Mutating a pinned module/migration without updating that manifest fails
// closed. The manifest digest is emitted for a later package/release gate to
// pin independently; this module does not claim that the same-tree manifest is
// itself an external trust root.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  SQLSERVER_SEALED_SNAPSHOT_CONNECTOR_KIND,
  SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE,
  SQLSERVER_SEALED_SNAPSHOT_RECOVERY_STRATEGY,
} = require('./sqlserver-sealed-snapshot-profile.cjs')
const digests = require('./digests.cjs')

const PACKAGE_PROVENANCE_VERSION = 'sealed-export/package-provenance/v1'
const FROZEN_MANIFEST_RELATIVE =
  'plugins/plugin-integration-core/lib/sealed-export/vectors/s5-package-provenance-pins.json'

const PINNED_PROFILE_IDENTITY = Object.freeze({
  profileId: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  connectorKind: SQLSERVER_SEALED_SNAPSHOT_CONNECTOR_KIND,
  actionId: SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  implementationVersion: SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
  acquisitionMode: 'SEALED_EXPORT',
  supportedConsistencyProofs: Object.freeze([
    'SOURCE_SNAPSHOT_TXN',
    'IMMUTABLE_SNAPSHOT_TOKEN',
  ]),
  continuationLifetime: 'DURABLE_TOKEN',
  supportedCompletenessProofs: Object.freeze(['SIGNED_MANIFEST']),
  recoveryStrategy: 'CHUNK_RESUME',
  customerScope: 'SINGLE_CUSTOMER',
  sourceMode: 'READ_ONLY',
  externalWrite: false,
  runtimeScaleCertified: false,
  adjudicationBoundedToEvidenceEnvelope: true,
  orderingKeyKind: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
  signatureAlgorithm: 'ED25519',
  durableArtifactToken: 'IMMUTABLE_SNAPSHOT_TOKEN',
  manifestProofClass: 'SOURCE_SNAPSHOT_TXN',
  immutableSnapshotTokenBindsManifestDigest: true,
})

const PINNED_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: '068',
    relativePath:
      'packages/core-backend/migrations/068_create_integration_sealed_export_ingestion.sql',
    requiredMarkers: Object.freeze([
      'integration_sealed_export_ingestion_sessions',
      'integration_sealed_export_ingestion_receipts',
    ]),
  }),
  Object.freeze({
    id: '069',
    relativePath:
      'packages/core-backend/migrations/069_create_integration_sealed_export_generation_kernel.sql',
    requiredMarkers: Object.freeze([
      'integration_sealed_export_generations',
      'integration_sealed_export_active_pointers',
    ]),
  }),
  Object.freeze({
    id: '070',
    relativePath:
      'packages/core-backend/migrations/070_create_integration_sealed_export_signer_authority.sql',
    requiredMarkers: Object.freeze([
      'integration_sealed_export_signer_public_keys',
      'public_key_spki_der',
    ]),
  }),
  Object.freeze({
    id: '071',
    relativePath:
      'packages/core-backend/migrations/071_harden_integration_sealed_export_authority_lifecycle.sql',
    requiredMarkers: Object.freeze([
      'integration_sealed_export_authority_state_guard',
      'trg_integration_sealed_export_authority_state_guard',
    ]),
  }),
  Object.freeze({
    id: '072',
    relativePath:
      'packages/core-backend/migrations/072_harden_integration_sealed_export_terminal_signer_history.sql',
    requiredMarkers: Object.freeze([
      'integration_sealed_export_terminal_signer_keys',
      'trg_integration_sealed_export_terminal_signer_keys_immutable',
      'trg_integration_sealed_export_terminal_signer_keys_no_truncate',
    ]),
  }),
])

const PINNED_S1_MODULES = Object.freeze([
  'canonical-json.cjs',
  'compliance-harness.cjs',
  'contracts.cjs',
  'digests.cjs',
  'failure-vocabulary.cjs',
  'lifecycle.cjs',
])

const PINNED_S2_MODULES = Object.freeze(['sqlserver-s2-producer.cjs'])

const PINNED_S3_MODULES = Object.freeze([
  'private-ingestion-blob-store.cjs',
  'private-ingestion-manifest-verifier.cjs',
  'private-ingestion-metadata-store.cjs',
  'private-ingestion-service.cjs',
])

const PINNED_S4_MODULES = Object.freeze([
  'generation-kernel.cjs',
  'generation-store.cjs',
])

const PINNED_S5_MODULES = Object.freeze([
  'sqlserver-sealed-snapshot-profile.cjs',
  'sqlserver-sealed-snapshot-source-session.cjs',
  'sqlserver-sealed-snapshot-action.cjs',
  'sqlserver-sealed-snapshot-service.cjs',
  'sqlserver-sealed-snapshot-service-core.cjs',
  'sealed-export-binding-qualification.cjs',
  'sealed-export-signer-authority.cjs',
  'sealed-export-signer-authority-store.cjs',
  'sealed-export-package-provenance.cjs',
])

const PINNED_RUNTIME_DEPENDENCIES = Object.freeze({
  mssql: '^10.0.4',
})
const PINNED_EXTERNAL_MODULES = Object.freeze([
  Object.freeze({
    id: 'gipProfileCertificationContracts',
    relativePath:
      'plugins/plugin-integration-core/lib/gip-profile-certification-contracts.cjs',
  }),
  Object.freeze({
    id: 'gipCanonicalJson',
    relativePath:
      'plugins/plugin-integration-core/lib/gip-canonical-json.cjs',
  }),
])
const PINNED_RUNTIME_FILES = Object.freeze([
  Object.freeze({
    id: 'pluginPackageJson',
    relativePath: 'plugins/plugin-integration-core/package.json',
  }),
  Object.freeze({
    id: 'pnpmLock',
    relativePath: 'pnpm-lock.yaml',
  }),
])
const PINNED_EVIDENCE_FILES = Object.freeze([
  Object.freeze({
    id: 's5EvidenceWorkflow',
    relativePath: '.github/workflows/sealed-export-s5-sqlserver.yml',
  }),
  Object.freeze({
    id: 's5ProductEvidenceRunner',
    relativePath: 'scripts/ops/run-sealed-export-s5-sqlserver-evidence.cjs',
  }),
  Object.freeze({
    id: 's5ExactEvidenceVerifier',
    relativePath: 'scripts/ops/verify-sealed-export-s5-sqlserver-evidence.cjs',
  }),
  Object.freeze({
    id: 's5SignerAuthorityMemoryDb',
    relativePath:
      'plugins/plugin-integration-core/__tests__/support/sealed-export-signer-authority-memory-db.cjs',
  }),
  Object.freeze({
    id: 's5SignerLifecycleRealDbTest',
    relativePath:
      'packages/core-backend/tests/integration/sealed-export-signer-authority-lifecycle-migration.db.test.ts',
  }),
])

const PINNED_MODULE_RELATIVE_DIR =
  'plugins/plugin-integration-core/lib/sealed-export'
const PINNED_PACKAGE_JSON = 'plugins/plugin-integration-core/package.json'

function sha256File(filePath) {
  const bytes = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function resolveRepoRoot(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (!path.isAbsolute(repoRoot)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return repoRoot
}

function loadFrozenManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, FROZEN_MANIFEST_RELATIVE)
  if (!fs.existsSync(manifestPath)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.packageProvenanceVersion !== PACKAGE_PROVENANCE_VERSION ||
    !parsed.modules ||
    !parsed.migrations ||
    !parsed.externalModules ||
    !parsed.dependencies ||
    !parsed.runtimeFiles ||
    !parsed.evidenceFiles
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return parsed
}

function frozenManifestDigest(repoRoot) {
  return sha256File(path.join(repoRoot, FROZEN_MANIFEST_RELATIVE))
}

function assertEqualDigest(actual, expected) {
  if (
    typeof actual !== 'string' ||
    typeof expected !== 'string' ||
    !digests.isLowerHexDigest(actual) ||
    !digests.isLowerHexDigest(expected) ||
    !digests.constantTimeEqualDigest(actual, expected)
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
}

function assertProfileIdentityPinned() {
  const profile = SQLSERVER_SEALED_SNAPSHOT_PROFILE
  if (
    profile.profileId !== PINNED_PROFILE_IDENTITY.profileId ||
    profile.connectorKind !== PINNED_PROFILE_IDENTITY.connectorKind ||
    profile.actionId !== PINNED_PROFILE_IDENTITY.actionId ||
    profile.implementationVersion !==
      PINNED_PROFILE_IDENTITY.implementationVersion
  ) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
  }
  if (
    profile.certificate.acquisitionMode !==
      PINNED_PROFILE_IDENTITY.acquisitionMode ||
    profile.certificate.continuationLifetime !==
      PINNED_PROFILE_IDENTITY.continuationLifetime ||
    SQLSERVER_SEALED_SNAPSHOT_RECOVERY_STRATEGY !==
      PINNED_PROFILE_IDENTITY.recoveryStrategy
  ) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
  }
  const proofs = [...profile.certificate.supportedConsistencyProofs].sort()
  const expectedProofs = [
    ...PINNED_PROFILE_IDENTITY.supportedConsistencyProofs,
  ].sort()
  if (
    proofs.length !== expectedProofs.length ||
    proofs.some((value, index) => value !== expectedProofs[index])
  ) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
  }
  const completeness = [
    ...profile.certificate.supportedCompletenessProofs,
  ].sort()
  const expectedCompleteness = [
    ...PINNED_PROFILE_IDENTITY.supportedCompletenessProofs,
  ].sort()
  if (
    completeness.length !== expectedCompleteness.length ||
    completeness.some((value, index) => value !== expectedCompleteness[index])
  ) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
  }
  const envelope = profile.certificate.maxScale?.evidenceEnvelope
  if (
    profile.certificate.maxScale?.runtimeScaleCertified !==
      PINNED_PROFILE_IDENTITY.runtimeScaleCertified ||
    profile.certificate.maxScale?.adjudicationBoundedToEvidenceEnvelope !==
      PINNED_PROFILE_IDENTITY.adjudicationBoundedToEvidenceEnvelope ||
    envelope?.customerScope !== PINNED_PROFILE_IDENTITY.customerScope ||
    envelope?.sourceMode !== PINNED_PROFILE_IDENTITY.sourceMode ||
    envelope?.externalWrite !== PINNED_PROFILE_IDENTITY.externalWrite ||
    profile.certificate.orderingKeyRequirement?.kind !==
      PINNED_PROFILE_IDENTITY.orderingKeyKind ||
    profile.certificate.manifestShape?.signatureAlgorithm !==
      PINNED_PROFILE_IDENTITY.signatureAlgorithm ||
    profile.certificate.manifestShape?.durableArtifactToken !==
      PINNED_PROFILE_IDENTITY.durableArtifactToken ||
    profile.certificate.manifestShape?.sourceCaptureProofClassRequired !==
      PINNED_PROFILE_IDENTITY.manifestProofClass ||
    profile.certificate.tokenShape?.bindsManifestDigest !==
      PINNED_PROFILE_IDENTITY.immutableSnapshotTokenBindsManifestDigest
  ) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
  }
}

function verifyPinnedModules(repoRoot, moduleNames, expectedDigests) {
  if (!expectedDigests || typeof expectedDigests !== 'object') {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const digestsOut = {}
  for (const name of moduleNames) {
    const filePath = path.join(repoRoot, PINNED_MODULE_RELATIVE_DIR, name)
    if (!fs.existsSync(filePath)) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size === 0) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const actual = sha256File(filePath)
    const expected = expectedDigests[name]
    assertEqualDigest(actual, expected)
    digestsOut[name] = actual
  }
  // Frozen manifest must not list extra unexpected modules for this group.
  const expectedNames = Object.keys(expectedDigests).sort()
  const actualNames = [...moduleNames].sort()
  if (
    expectedNames.length !== actualNames.length ||
    expectedNames.some((name, index) => name !== actualNames[index])
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return digestsOut
}

function verifyPinnedMigrations(repoRoot, expectedDigests) {
  if (!expectedDigests || typeof expectedDigests !== 'object') {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const digestsOut = {}
  for (const migration of PINNED_MIGRATIONS) {
    const filePath = path.join(repoRoot, migration.relativePath)
    if (!fs.existsSync(filePath)) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const text = fs.readFileSync(filePath, 'utf8')
    for (const marker of migration.requiredMarkers) {
      if (!text.includes(marker)) {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }
    const actual = crypto.createHash('sha256').update(text, 'utf8').digest('hex')
    assertEqualDigest(actual, expectedDigests[migration.id])
    digestsOut[migration.id] = actual
  }
  return digestsOut
}

function verifyPinnedDependencies(repoRoot, expectedDependencies) {
  const packageJsonPath = path.join(repoRoot, PINNED_PACKAGE_JSON)
  if (!fs.existsSync(packageJsonPath)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  } catch {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const dependencies =
    parsed && typeof parsed === 'object' ? parsed.dependencies : null
  if (!dependencies || typeof dependencies !== 'object') {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  for (const [name, expected] of Object.entries(PINNED_RUNTIME_DEPENDENCIES)) {
    if (!Object.prototype.hasOwnProperty.call(dependencies, name)) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (dependencies[name] !== expected) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (!expectedDependencies || expectedDependencies[name] !== expected) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
  }
  const fixturePath = path.join(
    repoRoot,
    PINNED_MODULE_RELATIVE_DIR,
    'sqlserver-s2-producer.cjs',
  )
  const fixtureText = fs.readFileSync(fixturePath, 'utf8')
  if (
    fixtureText.includes(`'${SQLSERVER_SEALED_SNAPSHOT_ACTION_ID}'`) ||
    fixtureText.includes(SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID)
  ) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
  }
  return Object.freeze({ ...PINNED_RUNTIME_DEPENDENCIES })
}

function verifyPinnedFileEntries(repoRoot, entries, expectedDigests) {
  if (!expectedDigests || typeof expectedDigests !== 'object') {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const expectedIds = entries.map((entry) => entry.id).sort()
  const actualIds = Object.keys(expectedDigests).sort()
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const out = {}
  for (const entry of entries) {
    const filePath = path.join(repoRoot, entry.relativePath)
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const actual = sha256File(filePath)
    assertEqualDigest(actual, expectedDigests[entry.id])
    out[entry.id] = actual
  }
  return out
}

function verifySealedExportPackageProvenance({ repoRoot } = {}) {
  const root = resolveRepoRoot(repoRoot)
  const frozen = loadFrozenManifest(root)
  assertProfileIdentityPinned()
  const migrations = verifyPinnedMigrations(root, frozen.migrations)
  const s1 = verifyPinnedModules(root, PINNED_S1_MODULES, frozen.modules.s1)
  const s2 = verifyPinnedModules(root, PINNED_S2_MODULES, frozen.modules.s2)
  const s3 = verifyPinnedModules(root, PINNED_S3_MODULES, frozen.modules.s3)
  const s4 = verifyPinnedModules(root, PINNED_S4_MODULES, frozen.modules.s4)
  const s5 = verifyPinnedModules(root, PINNED_S5_MODULES, frozen.modules.s5)
  const externalModules = verifyPinnedFileEntries(
    root,
    PINNED_EXTERNAL_MODULES,
    frozen.externalModules,
  )
  const dependencies = verifyPinnedDependencies(root, frozen.dependencies)
  const runtimeFiles = verifyPinnedFileEntries(
    root,
    PINNED_RUNTIME_FILES,
    frozen.runtimeFiles,
  )
  const evidenceFiles = verifyPinnedFileEntries(
    root,
    PINNED_EVIDENCE_FILES,
    frozen.evidenceFiles,
  )

  return Object.freeze({
    candidateTreeVerified: true,
    externalPackagePinRequired: true,
    frozenManifestDigest: frozenManifestDigest(root),
    packageProvenanceVersion: PACKAGE_PROVENANCE_VERSION,
    profileIdentity: PINNED_PROFILE_IDENTITY,
    migrations: Object.freeze(migrations),
    externalModules: Object.freeze(externalModules),
    modules: Object.freeze({
      s1: Object.freeze(s1),
      s2: Object.freeze(s2),
      s3: Object.freeze(s3),
      s4: Object.freeze(s4),
      s5: Object.freeze(s5),
    }),
    runtimeDependencies: dependencies,
    runtimeFiles: Object.freeze(runtimeFiles),
    evidenceFiles: Object.freeze(evidenceFiles),
    verified: true,
  })
}

// Build helper for maintainers / tests to regenerate the frozen pin file from a
// known-good tree. Not used by verifySealedExportPackageProvenance itself.
function computePackageProvenancePinSet(repoRoot) {
  const root = resolveRepoRoot(repoRoot)
  function moduleDigests(names) {
    const out = {}
    for (const name of names) {
      out[name] = sha256File(path.join(root, PINNED_MODULE_RELATIVE_DIR, name))
    }
    return out
  }
  const migrations = {}
  for (const migration of PINNED_MIGRATIONS) {
    migrations[migration.id] = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(root, migration.relativePath)))
      .digest('hex')
  }
  const runtimeFiles = {}
  for (const entry of PINNED_RUNTIME_FILES) {
    runtimeFiles[entry.id] = sha256File(path.join(root, entry.relativePath))
  }
  const externalModules = {}
  for (const entry of PINNED_EXTERNAL_MODULES) {
    externalModules[entry.id] = sha256File(path.join(root, entry.relativePath))
  }
  const evidenceFiles = {}
  for (const entry of PINNED_EVIDENCE_FILES) {
    evidenceFiles[entry.id] = sha256File(path.join(root, entry.relativePath))
  }
  return Object.freeze({
    packageProvenanceVersion: PACKAGE_PROVENANCE_VERSION,
    migrations: Object.freeze(migrations),
    modules: Object.freeze({
      s1: Object.freeze(moduleDigests(PINNED_S1_MODULES)),
      s2: Object.freeze(moduleDigests(PINNED_S2_MODULES)),
      s3: Object.freeze(moduleDigests(PINNED_S3_MODULES)),
      s4: Object.freeze(moduleDigests(PINNED_S4_MODULES)),
      s5: Object.freeze(moduleDigests(PINNED_S5_MODULES)),
    }),
    externalModules: Object.freeze(externalModules),
    dependencies: Object.freeze({ ...PINNED_RUNTIME_DEPENDENCIES }),
    runtimeFiles: Object.freeze(runtimeFiles),
    evidenceFiles: Object.freeze(evidenceFiles),
  })
}

module.exports = Object.freeze({
  PACKAGE_PROVENANCE_VERSION,
  FROZEN_MANIFEST_RELATIVE,
  PINNED_PROFILE_IDENTITY,
  PINNED_MIGRATIONS,
  PINNED_S1_MODULES,
  PINNED_S2_MODULES,
  PINNED_S3_MODULES,
  PINNED_S4_MODULES,
  PINNED_S5_MODULES,
  PINNED_EXTERNAL_MODULES,
  PINNED_RUNTIME_DEPENDENCIES,
  PINNED_RUNTIME_FILES,
  PINNED_EVIDENCE_FILES,
  verifySealedExportPackageProvenance,
  computePackageProvenancePinSet,
})

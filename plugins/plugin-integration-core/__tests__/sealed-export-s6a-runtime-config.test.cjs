'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ENV,
  FEATURE_FLAG,
  WIN32_ARTIFACT_ACL_ATTESTATION,
  loadStockPreparationProvisioningConfig,
  loadStockPreparationRuntimeConfig,
} = require('../lib/sealed-export/stock-preparation-runtime-config.cjs')
const {
  isTrustedSealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')

function write(root, name, bytes) {
  const file = path.join(root, name)
  fs.writeFileSync(file, bytes)
  return file
}

// A copy of `base` with `overrides` applied; an `undefined` override DELETES the key
// rather than setting it to undefined, so an "operator never set this" env is
// expressible.
function envWith(base, overrides) {
  const next = Object.assign({}, base)
  const keys = Object.keys(overrides)
  for (let index = 0; index < keys.length; index += 1) {
    if (overrides[keys[index]] === undefined) delete next[keys[index]]
    else next[keys[index]] = overrides[keys[index]]
  }
  return next
}

function refusal(fn, reason, label) {
  let caught = null
  try { fn() } catch (error) { caught = error }
  assert.ok(caught !== null, 'expected a refusal: ' + label)
  assert.equal(isTrustedSealedExportError(caught), true, label)
  assert.equal(caught.reason, reason, label)
  return caught
}

// The S6-A artifact tree asserts confidentiality with POSIX modes that chmod()
// silently no-ops on win32. The gate under test refuses to boot there unless an
// operator has attested an equivalent NTFS ACL on the artifact root.
function win32ArtifactAclAttestationGate(baseEnv) {
  const attestation = { [ENV.win32ArtifactAclAttested]: undefined }
  const unattested = envWith(baseEnv, attestation)

  // win32 + flag ON + no attestation -> refused, and the refusal NAMES the control.
  const refused = refusal(
    () => loadStockPreparationRuntimeConfig({
      env: unattested,
      platform: 'win32',
    }),
    'SEALED_EXPORT_PROFILE_UNCERTIFIED',
    'win32 boot without an artifact-root ACL attestation',
  )
  assert.deepEqual(
    refused.details,
    { field: 'win32ArtifactAclAttested' },
    'the refusal must name the unmet control, since the §10 reason set is frozen',
  )

  // POSITIVE CONTROL — the SAME env on the SAME platform, differing only in the
  // attestation, boots. Without this the refusal above could be "win32 never boots".
  assert.equal(
    loadStockPreparationRuntimeConfig({
      env: envWith(unattested, {
        [ENV.win32ArtifactAclAttested]: WIN32_ARTIFACT_ACL_ATTESTATION,
      }),
      platform: 'win32',
    }).enabled,
    true,
    'an attested win32 host boots',
  )
  assert.equal(WIN32_ARTIFACT_ACL_ATTESTATION, 'true')

  // The attestation is an exact literal: a near-miss is a refusal, not a pass.
  const nearMisses = ['TRUE', 'True', ' true ', 'true\n', '1', 'yes', 'false', '']
  for (let index = 0; index < nearMisses.length; index += 1) {
    refusal(
      () => loadStockPreparationRuntimeConfig({
        env: envWith(unattested, {
          [ENV.win32ArtifactAclAttested]: nearMisses[index],
        }),
        platform: 'win32',
      }),
      'SEALED_EXPORT_PROFILE_UNCERTIFIED',
      'near-miss attestation: ' + JSON.stringify(nearMisses[index]),
    )
  }

  // Non-win32 hosts enforce the modes for real, so the attestation is neither
  // required nor consulted.
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    assert.equal(
      loadStockPreparationRuntimeConfig({ env: unattested, platform }).enabled,
      true,
      platform + ' boots without an attestation',
    )
    assert.equal(
      loadStockPreparationRuntimeConfig({
        env: envWith(unattested, { [ENV.win32ArtifactAclAttested]: 'false' }),
        platform,
      }).enabled,
      true,
      platform + ' ignores the attestation entirely',
    )
  }

  // The flag is still the outermost gate: a disabled runtime never reaches the
  // attestation, so a win32 host that has not opted in is not asked to attest.
  assert.deepEqual(
    loadStockPreparationRuntimeConfig({
      env: envWith(unattested, { [FEATURE_FLAG]: 'false' }),
      platform: 'win32',
    }),
    { enabled: false },
  )

  // Ordering: a structurally invalid env is still an internal error on win32. The
  // gate must not convert every malformed boot into an attestation-shaped answer.
  refusal(
    () => loadStockPreparationRuntimeConfig({
      env: { [FEATURE_FLAG]: 'true' },
      platform: 'win32',
    }),
    'SEALED_EXPORT_INTERNAL_ERROR',
    'win32 with no artifact root at all',
  )

  // `platform` defaults to the real host, so the gate cannot be bypassed by omitting
  // it. Asserted against process.platform rather than a hard-coded value so the
  // check is meaningful on every host.
  const defaulted = loadStockPreparationRuntimeConfig({
    env: envWith(unattested, {
      [ENV.win32ArtifactAclAttested]: WIN32_ARTIFACT_ACL_ATTESTATION,
    }),
  })
  assert.equal(defaulted.enabled, true)
  if (process.platform === 'win32') {
    refusal(
      () => loadStockPreparationRuntimeConfig({ env: unattested }),
      'SEALED_EXPORT_PROFILE_UNCERTIFIED',
      'the default platform is the real host, not a permissive fallback',
    )
  } else {
    assert.equal(
      loadStockPreparationRuntimeConfig({ env: unattested }).enabled,
      true,
    )
  }

  // A non-string platform is a refusal, not a silent fall-through to process.platform.
  refusal(
    () => loadStockPreparationRuntimeConfig({ env: unattested, platform: null }),
    'SEALED_EXPORT_INTERNAL_ERROR',
    'null platform override',
  )
  refusal(
    () => loadStockPreparationRuntimeConfig({ env: unattested, platform: '' }),
    'SEALED_EXPORT_INTERNAL_ERROR',
    'empty platform override',
  )
}

function main() {
  assert.deepEqual(
    loadStockPreparationRuntimeConfig({
      env: {
        [FEATURE_FLAG]: 'false',
        [ENV.identityKeyFile]: '/does/not/exist',
      },
    }),
    { enabled: false },
  )

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's6a-config-'))
  try {
    const pair = crypto.generateKeyPairSync('ed25519')
    const env = {
      [FEATURE_FLAG]: 'true',
      [ENV.artifactRoot]: path.join(root, 'artifacts'),
      [ENV.evidenceKeyFile]: write(root, 'evidence.key', Buffer.alloc(32, 1)),
      [ENV.identityKeyFile]: write(root, 'identity.key', Buffer.alloc(32, 2)),
      [ENV.qualificationKeyFile]:
        write(root, 'qualification.key', Buffer.alloc(32, 3)),
      [ENV.qualificationKeyId]: 'qualification-key-1',
      [ENV.provisioningDatabaseRole]:
        'metasheet_sealed_export_provisioning',
      [ENV.provisioningDatabaseUrl]:
        'postgres://provisioning:secret@db/runtime',
      [ENV.runtimeDatabaseRole]: 'metasheet_sealed_export_runtime',
      [ENV.runtimeDatabaseUrl]: 'postgres://runtime:secret@db/runtime',
      [ENV.signerPrivateKeyFile]: write(
        root,
        'signer.pem',
        pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      ),
      // Present so this baseline env boots on every host; the win32-only gate that
      // consumes it has its own battery below, including the unattested refusal.
      [ENV.win32ArtifactAclAttested]: WIN32_ARTIFACT_ACL_ATTESTATION,
    }
    env[ENV.provisioningSpecFile] = write(
      root,
      'provisioning.json',
      Buffer.from(JSON.stringify({
        binding: {
          approvedConfigVersionId: 'config-v1',
          bindingExpiresAt: '2026-08-01T00:00:00Z',
          bindingId: 'binding-v1',
          bindingVersion: 'binding-v1',
          externalSystemId: 'system-1',
          signerExpiresAt: '2026-08-02T00:00:00Z',
          tableRef: 'dbo.stock_prep_sealed_rows',
          tenantId: 'tenant-1',
          workspaceId: null,
        },
        externalSystem: {
          config: {
            sealedSnapshotSqlServer: {
              database: 'customer',
              encrypt: true,
              instanceName: null,
              port: 1433,
              server: 'sql.internal',
              trustServerCertificate: false,
            },
          },
          credentials: {
            sealedSnapshotSqlServer: {
              password: 'secret',
              user: 'readonly',
            },
          },
          id: 'system-1',
          kind: 'data-source:sql-readonly',
          role: 'source',
          status: 'active',
          tenantId: 'tenant-1',
          workspaceId: null,
        },
      })),
    )
    const config = loadStockPreparationRuntimeConfig({ env })
    assert.equal(config.enabled, true)
    assert.equal(Object.isFrozen(config), true)
    assert.equal(Object.isFrozen(config.privateSignerMaterials), true)
    assert.equal(config.privateSignerMaterials[0].signerKeyId.length, 64)
    assert.equal(config.privateSignerMaterials[0].privateKey.type, 'private')
    assert.equal(config.identityKey.equals(Buffer.alloc(32, 2)), true)
    fs.writeFileSync(env[ENV.identityKeyFile], Buffer.alloc(32, 9))
    assert.equal(config.identityKey.equals(Buffer.alloc(32, 2)), true)
    win32ArtifactAclAttestationGate(env)
    const provisioning = loadStockPreparationProvisioningConfig({ env })
    assert.equal(
      provisioning.provisioningDatabaseRole,
      'metasheet_sealed_export_provisioning',
    )
    assert.equal(Object.isFrozen(provisioning.spec), true)
    assert.equal(
      provisioning.spec.externalSystem.credentials
        .sealedSnapshotSqlServer.password,
      'secret',
    )
    const workspaceScoped = JSON.parse(
      fs.readFileSync(env[ENV.provisioningSpecFile], 'utf8'),
    )
    workspaceScoped.binding.workspaceId = 'workspace-1'
    workspaceScoped.externalSystem.workspaceId = 'workspace-1'
    fs.writeFileSync(
      env[ENV.provisioningSpecFile],
      JSON.stringify(workspaceScoped),
    )
    assert.throws(
      () => loadStockPreparationProvisioningConfig({ env }),
      (error) => isTrustedSealedExportError(error)
        && error.reason === 'SEALED_EXPORT_INTERNAL_ERROR',
      'the single-customer runtime rejects an unreachable workspace scope',
    )

    assert.throws(
      () => loadStockPreparationRuntimeConfig({
        env: { [FEATURE_FLAG]: 'true' },
      }),
      (error) => isTrustedSealedExportError(error)
        && error.reason === 'SEALED_EXPORT_INTERNAL_ERROR',
    )
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }

  console.log('sealed-export-s6a-runtime-config.test.cjs OK')
}

main()

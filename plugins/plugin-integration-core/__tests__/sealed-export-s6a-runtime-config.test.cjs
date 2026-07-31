'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ENV,
  FEATURE_FLAG,
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

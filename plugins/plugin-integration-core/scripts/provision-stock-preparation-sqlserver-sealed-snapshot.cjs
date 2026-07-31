#!/usr/bin/env node
'use strict'

const {
  isTrustedSealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  loadStockPreparationProvisioningConfig,
} = require('../lib/sealed-export/stock-preparation-runtime-config.cjs')
const {
  createStockPreparationProvisioningDatabase,
} = require('../lib/sealed-export/stock-preparation-runtime-database.cjs')
const {
  createStockPreparationRuntimeProvisioning,
} = require('../lib/sealed-export/stock-preparation-runtime-provisioning.cjs')

async function main() {
  let database
  try {
    const config = loadStockPreparationProvisioningConfig()
    database = createStockPreparationProvisioningDatabase({
      connectionString: config.provisioningDatabaseUrl,
      expectedRole: config.provisioningDatabaseRole,
    })
    const service = createStockPreparationRuntimeProvisioning({
      artifactRoot: config.artifactRoot,
      identityKey: config.identityKey,
      privateSignerMaterial: config.privateSignerMaterial,
      provisioningDatabase: database,
      qualificationKeyring: config.qualificationKeyring,
    })
    const result = await service.provisionInitial(config.spec)
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      code: isTrustedSealedExportError(error)
        ? error.reason
        : 'SEALED_EXPORT_INTERNAL_ERROR',
      ok: false,
      valuesFree: true,
    })}\n`)
    process.exitCode = 1
  } finally {
    if (database) {
      try {
        await database.close()
      } catch {
        process.exitCode = 1
      }
    }
  }
}

main()

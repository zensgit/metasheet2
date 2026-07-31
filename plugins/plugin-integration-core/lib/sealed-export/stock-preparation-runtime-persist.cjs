'use strict'

const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  buildPlmSourcePersistInput,
} = require('../stock-preparation-plm-source-persist-bridge.cjs')
const {
  StockPreparationSyncRunPersistError,
  persistStockPreparationSyncRun,
} = require('../stock-preparation-sync-run-persist.cjs')

const runtimePersistFailures = new WeakSet()

class StockPreparationRuntimePersistFailure extends Error {
  constructor(status, code) {
    super('stock-preparation internal persist was refused')
    this.name = 'StockPreparationRuntimePersistFailure'
    this.status = status
    this.code = code
    this.details = Object.freeze({})
    runtimePersistFailures.add(this)
  }
}

function remintPersistFailure(error) {
  if (!(error instanceof StockPreparationSyncRunPersistError)) return null
  if (error.status === 409) {
    return new StockPreparationRuntimePersistFailure(
      409,
      'STOCK_PREPARATION_PERSIST_CONFLICT',
    )
  }
  if (error.status === 422) {
    return new StockPreparationRuntimePersistFailure(
      422,
      'STOCK_PREPARATION_PERSIST_UNPROCESSABLE',
    )
  }
  return new StockPreparationRuntimePersistFailure(
    503,
    'STOCK_PREPARATION_PERSIST_FAILED',
  )
}

function isStockPreparationRuntimePersistFailure(value) {
  return runtimePersistFailures.has(value)
}

function createStockPreparationRuntimePersist({ context } = {}) {
  const records =
    context
    && context.api
    && context.api.multitable
    && context.api.multitable.records
  const provisioning =
    context
    && context.api
    && context.api.multitable
    && context.api.multitable.provisioning
  if (
    !records
    || typeof records.queryRecords !== 'function'
    || typeof records.createRecord !== 'function'
    || typeof records.patchRecord !== 'function'
    || typeof records.runStockPreparationPersistUnitOfWork !== 'function'
    || !provisioning
    || typeof provisioning.findObjectSheet !== 'function'
    || typeof provisioning.resolveFieldIds !== 'function'
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  return async function persistDecodedStockPreparation({
    decoded,
    scope,
  } = {}) {
    if (
      !decoded
      || typeof decoded !== 'object'
      || !decoded.request
      || !decoded.intake
      || !scope
      || typeof scope !== 'object'
      || typeof scope.tenantId !== 'string'
      || scope.tenantId.length < 1
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const targetProjectId = `${scope.tenantId}:integration-core`
    const persistInput = buildPlmSourcePersistInput({
      intake: decoded.intake,
      request: decoded.request,
    })
    let result
    try {
      result = await persistStockPreparationSyncRun({
        context,
        lockTenantId: scope.tenantId,
        permission: 'admin',
        provisioning,
        recordsApi: records,
        targetProjectId,
        ...persistInput,
      })
    } catch (error) {
      const failure = remintPersistFailure(error)
      return Promise.reject(failure || error)
    }
    return Object.freeze({
      evidence: result.evidence,
      externalWrite: false,
      persisted: result.persisted,
    })
  }
}

module.exports = Object.freeze({
  createStockPreparationRuntimePersist,
  isStockPreparationRuntimePersistFailure,
})

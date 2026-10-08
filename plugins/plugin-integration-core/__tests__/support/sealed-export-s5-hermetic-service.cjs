'use strict'

const {
  createSqlServerSealedSnapshotServiceCore,
} = require('../../lib/sealed-export/sqlserver-sealed-snapshot-service-core.cjs')
const {
  failSealedExport,
} = require('../../lib/sealed-export/failure-vocabulary.cjs')

function openHermeticSnapshotCaptureContext({
  rows,
  streamRows,
  snapshotCapable,
  capture,
}) {
  if (
    typeof snapshotCapable !== 'boolean' ||
    !Array.isArray(rows) ||
    !Array.isArray(streamRows)
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (!snapshotCapable) {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }
  const metaCapture =
    capture && typeof capture === 'object'
      ? capture
      : Object.freeze({
          __databaseId: 7,
          __isolationLevel: 5,
          __productMajor: 16,
          __sessionId: 41,
          __snapshotEnabledState: 1,
          __transactionId: '9001',
        })
  let sourceReadCount = 0
  let closed = false
  let committed = false
  return Object.freeze({
    async queryMetadata(_sqlText) {
      if (closed || committed) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      return metaCapture
    },
    async queryProbe(_sqlText) {
      if (closed || committed) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      let nullKeyRows = 0
      const counts = new Map()
      for (const row of rows) {
        const key = row && row.rowId
        if (key === null || key === undefined) {
          nullKeyRows += 1
          continue
        }
        counts.set(key, (counts.get(key) || 0) + 1)
      }
      let duplicateKeyGroups = 0
      for (const count of counts.values()) {
        if (count > 1) duplicateKeyGroups += 1
      }
      return Object.freeze({
        nullKeyRows: String(nullKeyRows),
        duplicateKeyGroups: String(duplicateKeyGroups),
        sourceRowCount: String(rows.length),
      })
    },
    async startSourceRead(_sourceReadSql) {
      if (closed || committed) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      sourceReadCount += 1
      const stream = {
        async *[Symbol.asyncIterator]() {
          for (const row of streamRows) yield row
        },
      }
      return Object.freeze({
        completion: Promise.resolve(Object.freeze({ ok: true })),
        stream,
      })
    },
    getSourceReadCount() {
      return sourceReadCount
    },
    async commit() {
      if (closed) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      committed = true
    },
    async rollback() {},
    async close() {
      closed = true
    },
  })
}

function createHermeticSqlServerSealedSnapshotServiceForTests(rawConfig) {
  const capture = Object.freeze({
    capture: rawConfig.hermeticCapture.capture || null,
    rows: rawConfig.hermeticCapture.rows,
    streamRows:
      rawConfig.hermeticCapture.streamRows || rawConfig.hermeticCapture.rows,
    snapshotCapable:
      rawConfig.hermeticCapture.snapshotCapable === undefined
        ? true
        : rawConfig.hermeticCapture.snapshotCapable === true,
  })
  // Optional in-memory-compiled core, for negative-control mutation tests that need
  // the SAME hermetic capture wiring as every other caller here but a mutated core.
  // Every existing caller omits this and gets the real, on-disk core, unchanged.
  const coreFactory =
    typeof rawConfig.coreFactory === 'function'
      ? rawConfig.coreFactory
      : createSqlServerSealedSnapshotServiceCore
  return coreFactory({
    approvedBindings: rawConfig.approvedBindings,
    artifactRoot: rawConfig.artifactRoot,
    authorityDb: rawConfig.authorityDb,
    onReaderActive: rawConfig.onReaderActive || null,
    openCaptureContext: () => openHermeticSnapshotCaptureContext(capture),
    privateSignerMaterials: rawConfig.privateSignerMaterials,
    qualificationKeyring: rawConfig.qualificationKeyring,
    stageObserver: rawConfig.stageObserver || null,
    systemContentKey: rawConfig.systemContentKey,
    tenantId: rawConfig.tenantId,
    workspaceId: rawConfig.workspaceId,
  })
}

module.exports = Object.freeze({
  createHermeticSqlServerSealedSnapshotServiceForTests,
})

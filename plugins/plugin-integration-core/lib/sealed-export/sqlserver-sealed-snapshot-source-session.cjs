'use strict'

// Sealed-export S5 — source-session helpers (issue #4690).
//
// LATENT. No createTrusted*/createHarness* factories. This module's named
// first-party MSSQL opener is a declared trust-minting path; the product
// service calls it only with construction-bound connection material.

const canonicalCodec = require('./canonical-json.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')

const mssqlSnapshotCaptureContexts = new WeakSet()

const SNAPSHOT_CAPABILITY_SQL = `
SELECT CAST(snapshot_isolation_state AS int) AS snapshotEnabledState
FROM sys.databases
WHERE database_id = DB_ID()
`

function isStrictObject(value) {
  return canonicalCodec.__internals.isStrictPlainObject(value)
}

function normalizeNonNegativeInteger(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

async function assertSnapshotCapability(pool) {
  let result
  try {
    const request = pool.request()
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.query !== 'function'
    ) {
      failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
    }
    result = await request.query(SNAPSHOT_CAPABILITY_SQL)
  } catch {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }
  const recordset =
    result !== null && typeof result === 'object' ? result.recordset : null
  if (!Array.isArray(recordset) || recordset.length !== 1) {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }
  const row = recordset[0]
  if (
    !isStrictObject(row) ||
    normalizeNonNegativeInteger(row.snapshotEnabledState) !== 1
  ) {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }
}

// Open a real mssql snapshot capture context. Used only by the product service.
async function openMssqlSnapshotCaptureContext(connectionConfig) {
  let sql
  try {
    sql = require('mssql')
  } catch {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }
  if (
    typeof sql.ConnectionPool !== 'function' ||
    typeof sql.Transaction !== 'function' ||
    !isStrictObject(sql.ISOLATION_LEVEL) ||
    !Number.isSafeInteger(sql.ISOLATION_LEVEL.SNAPSHOT)
  ) {
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }

  let pool = null
  try {
    pool = new sql.ConnectionPool(connectionConfig)
    await pool.connect()
  } catch {
    if (pool !== null && typeof pool.close === 'function') {
      try {
        await pool.close()
      } catch {
        // best-effort
      }
    }
    failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
  }

  try {
    await assertSnapshotCapability(pool)
  } catch {
    try {
      await pool.close()
    } catch {
      // best-effort
    }
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }

  let transaction = null
  let begun = false
  try {
    transaction = new sql.Transaction(pool)
    await transaction.begin(sql.ISOLATION_LEVEL.SNAPSHOT)
    begun = true
  } catch {
    try {
      await pool.close()
    } catch {
      // best-effort
    }
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }

  let sourceReadCount = 0
  let closed = false

  async function queryOneRecordset(sqlText) {
    if (closed) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    if (typeof sqlText !== 'string' || sqlText.length === 0) {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    let result
    try {
      const request = transaction.request()
      if (
        request === null ||
        typeof request !== 'object' ||
        typeof request.query !== 'function'
      ) {
        failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      }
      result = await request.query(sqlText)
    } catch {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    const recordset =
      result !== null && typeof result === 'object' ? result.recordset : null
    if (!Array.isArray(recordset)) {
      failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
    }
    return recordset
  }

  const context = Object.freeze({
    // Same-transaction metadata (does not count as the data source read).
    async queryMetadata(sqlText) {
      const recordset = await queryOneRecordset(sqlText)
      if (recordset.length !== 1) {
        failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      }
      return recordset[0]
    },
    async queryProbe(sqlText) {
      const recordset = await queryOneRecordset(sqlText)
      if (recordset.length !== 1) {
        failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
      }
      return recordset[0]
    },
    async startSourceRead(sourceReadSql) {
      if (closed) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      if (typeof sourceReadSql !== 'string' || sourceReadSql.length === 0) {
        failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      }
      let request
      let stream
      let completion
      try {
        request = transaction.request()
        if (
          request === null ||
          typeof request !== 'object' ||
          typeof request.toReadableStream !== 'function' ||
          typeof request.query !== 'function'
        ) {
          failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
        }
        stream = request.toReadableStream({ highWaterMark: 1 })
        sourceReadCount += 1
        const queryResult = request.query(sourceReadSql)
        completion = Promise.resolve(queryResult).then(
          () => Object.freeze({ ok: true }),
          () => Object.freeze({ ok: false }),
        )
      } catch {
        failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      }
      if (
        stream === null ||
        typeof stream !== 'object' ||
        typeof stream[Symbol.asyncIterator] !== 'function'
      ) {
        failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      }
      return Object.freeze({ completion, stream })
    },
    getSourceReadCount() {
      return sourceReadCount
    },
    async commit() {
      if (closed) failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      try {
        await transaction.commit()
        begun = false
      } catch {
        failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      }
    },
    async rollback() {
      if (!begun) return
      try {
        await transaction.rollback()
      } catch {
        // best-effort
      }
      begun = false
    },
    async close() {
      if (closed) return
      closed = true
      if (begun) {
        try {
          await transaction.rollback()
        } catch {
          // best-effort
        }
        begun = false
      }
      try {
        await pool.close()
      } catch {
        // best-effort
      }
    },
  })
  mssqlSnapshotCaptureContexts.add(context)
  return context
}

function isMssqlSnapshotCaptureContext(value) {
  return mssqlSnapshotCaptureContexts.has(value)
}

module.exports = Object.freeze({
  isMssqlSnapshotCaptureContext,
  openMssqlSnapshotCaptureContext,
  SNAPSHOT_CAPABILITY_SQL,
})

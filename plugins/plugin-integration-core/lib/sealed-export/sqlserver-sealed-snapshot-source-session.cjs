'use strict'

// Sealed-export S5 — source-session helpers (issue #4690).
//
// LATENT. No createTrusted*/createHarness* factories. This module's named
// first-party MSSQL opener is a declared trust-minting path; the product
// service calls it only with construction-bound connection material.

const canonicalCodec = require('./canonical-json.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  assertSafeSqlServerRelation,
} = require('./sqlserver-sealed-snapshot-action.cjs')

const mssqlSnapshotCaptureContexts = new WeakSet()

const SNAPSHOT_CAPABILITY_SQL = `
SELECT
  CAST(snapshot_isolation_state AS int) AS snapshotEnabledState,
  CAST(IS_SRVROLEMEMBER('sysadmin') AS int) AS isSysadmin,
  CAST(IS_MEMBER('db_owner') AS int) AS isDbOwner,
  CAST(IS_MEMBER('db_datawriter') AS int) AS isDbDataWriter,
  CAST(HAS_PERMS_BY_NAME(@tableRef, 'OBJECT', 'SELECT') AS int) AS canSelect,
  CAST(HAS_PERMS_BY_NAME(@tableRef, 'OBJECT', 'INSERT') AS int) AS canInsert,
  CAST(HAS_PERMS_BY_NAME(@tableRef, 'OBJECT', 'UPDATE') AS int) AS canUpdate,
  CAST(HAS_PERMS_BY_NAME(@tableRef, 'OBJECT', 'DELETE') AS int) AS canDelete,
  CAST(HAS_PERMS_BY_NAME(@tableRef, 'OBJECT', 'ALTER') AS int) AS canAlter,
  CAST(HAS_PERMS_BY_NAME(@tableRef, 'OBJECT', 'CONTROL') AS int) AS canControl
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

async function assertSnapshotCapability(pool, tableRef) {
  let result
  try {
    const request = pool.request()
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.input !== 'function' ||
      typeof request.query !== 'function'
    ) {
      failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
    }
    request.input('tableRef', tableRef)
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
    normalizeNonNegativeInteger(row.snapshotEnabledState) !== 1 ||
    normalizeNonNegativeInteger(row.isSysadmin) !== 0 ||
    normalizeNonNegativeInteger(row.isDbOwner) !== 0 ||
    normalizeNonNegativeInteger(row.isDbDataWriter) !== 0 ||
    normalizeNonNegativeInteger(row.canSelect) !== 1 ||
    normalizeNonNegativeInteger(row.canInsert) !== 0 ||
    normalizeNonNegativeInteger(row.canUpdate) !== 0 ||
    normalizeNonNegativeInteger(row.canDelete) !== 0 ||
    normalizeNonNegativeInteger(row.canAlter) !== 0 ||
    normalizeNonNegativeInteger(row.canControl) !== 0
  ) {
    failSealedExport('SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE')
  }
}

// Open a real mssql snapshot capture context. Used only by the product service.
async function openMssqlSnapshotCaptureContext(rawInput) {
  const normalized = canonicalCodec.tryFreezeCanonical(rawInput)
  if (
    !normalized.ok ||
    !isStrictObject(normalized.value) ||
    Object.keys(normalized.value).sort().join('\n') !==
      ['connectionConfig', 'tableRef'].sort().join('\n') ||
    !isStrictObject(normalized.value.connectionConfig)
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const connectionConfig = normalized.value.connectionConfig
  const tableRef = assertSafeSqlServerRelation(normalized.value.tableRef)
  if (
    !isStrictObject(connectionConfig.options) ||
    connectionConfig.options.readOnlyIntent !== true
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
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
    await assertSnapshotCapability(pool, tableRef)
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
      if (sourceReadCount !== 0) {
        failSealedExport('SEALED_EXPORT_CAPTURE_FAILED')
      }
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

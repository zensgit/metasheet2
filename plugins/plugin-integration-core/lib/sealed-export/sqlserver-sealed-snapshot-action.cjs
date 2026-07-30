'use strict'

// Sealed-export S5 — product action constants and first-party relation catalog
// (issue #4690).
//
// LATENT. This module does NOT export an executable entry that accepts caller
// trust objects. Execution is only via createSqlServerSealedSnapshotService in
// sqlserver-sealed-snapshot-service.cjs, which binds approved bindings, keyring,
// connection and signer material in its construction closure.
//
// Distinct from S2 fixture action id sealed-export.sqlserver.fixture.v1.

const canonicalCodec = require('./canonical-json.cjs')
const digests = require('./digests.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
} = require('./sqlserver-sealed-snapshot-profile.cjs')

const SEALED_EXPORT_S5_CHUNK_BYTES = 1024 * 1024
const SEALED_EXPORT_S5_SORT_RUN_BYTES = 1024 * 1024
const SEALED_EXPORT_S5_SORT_MERGE_FAN_IN = 16
const SEALED_EXPORT_S5_AGENT_PROTOCOL_VERSION = 'sealed-export-s5-v1'
const SEALED_EXPORT_S5_ENCODING_VERSION = 'canonical-jsonl-v1'

// Generic sealed-export row shape for first-party SQL Server relations that
// project (rowId, payloadVersion, payload).
const SOURCE_FIELDS = Object.freeze([
  Object.freeze({
    fieldId: 'rowId',
    sourceType: 'SAFE_POSITIVE_INTEGER',
    nullable: false,
  }),
  Object.freeze({
    fieldId: 'payloadVersion',
    sourceType: 'SAFE_POSITIVE_INTEGER',
    nullable: false,
  }),
  Object.freeze({
    fieldId: 'payload',
    sourceType: 'STRING',
    nullable: false,
  }),
])

function digestCanonicalConstant(value) {
  const canonical = canonicalCodec.tryCanonicalJson(value)
  if (!canonical.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  const digest = digests.digestBytes(canonical.bytes)
  if (!digest.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  return digest.digest
}

const SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST =
  digestCanonicalConstant(SOURCE_FIELDS)

// Safe SQL Server two-part name: schema.table with simple identifiers only.
const SAFE_SQLSERVER_RELATION =
  /^[A-Za-z_][A-Za-z0-9_]{0,127}\.[A-Za-z_][A-Za-z0-9_]{0,127}$/

function assertSafeSqlServerRelation(tableRef) {
  if (typeof tableRef !== 'string' || !SAFE_SQLSERVER_RELATION.test(tableRef)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return tableRef
}

// Snapshot-session metadata only (no table read). Used for empty-object
// capture identity in the same snapshot transaction as the data read.
const CAPTURE_METADATA_SQL = `
SELECT
  CAST(@@SPID AS int) AS __sessionId,
  CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS __productMajor,
  CAST(DB_ID() AS int) AS __databaseId,
  CAST(CURRENT_TRANSACTION_ID() AS bigint) AS __transactionId,
  CAST((
    SELECT snapshot_isolation_state
    FROM sys.databases
    WHERE database_id = DB_ID()
  ) AS int) AS __snapshotEnabledState,
  CAST((
    SELECT transaction_isolation_level
    FROM sys.dm_exec_sessions
    WHERE session_id = @@SPID
  ) AS int) AS __isolationLevel
`

function buildRowIdPayloadSourceSql(tableRef) {
  const safe = assertSafeSqlServerRelation(tableRef)
  // nvarchar(max): lossless STRING projection. Never CAST to nvarchar(4000).
  return `
SELECT
  CAST(source.row_id AS bigint) AS rowId,
  CAST(source.payload_version AS bigint) AS payloadVersion,
  CAST(source.payload AS nvarchar(max)) AS payload,
  CAST(@@SPID AS int) AS __sessionId,
  CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS __productMajor,
  CAST(DB_ID() AS int) AS __databaseId,
  CAST(CURRENT_TRANSACTION_ID() AS bigint) AS __transactionId,
  CAST((
    SELECT snapshot_isolation_state
    FROM sys.databases
    WHERE database_id = DB_ID()
  ) AS int) AS __snapshotEnabledState,
  CAST((
    SELECT transaction_isolation_level
    FROM sys.dm_exec_sessions
    WHERE session_id = @@SPID
  ) AS int) AS __isolationLevel
FROM ${safe} AS source
ORDER BY source.row_id ASC
`
}

// Proves STABLE_UNIQUE_NON_NULL_TOTAL_ORDER on row_id for the enrolled relation.
function buildOrderingKeyUniquenessProbeSql(tableRef) {
  const safe = assertSafeSqlServerRelation(tableRef)
  return `
SELECT
  CAST((
    SELECT COUNT_BIG(*)
    FROM ${safe} AS source
    WHERE source.row_id IS NULL
  ) AS bigint) AS nullKeyRows,
  CAST((
    SELECT COUNT_BIG(*)
    FROM (
      SELECT source.row_id AS ordering_key
      FROM ${safe} AS source
      GROUP BY source.row_id
      HAVING COUNT_BIG(*) > 1
    ) AS duplicate_groups
  ) AS bigint) AS duplicateKeyGroups
`
}

// First-party certified relation implementations. Callers cannot register new
// SQL; only these relation ids may appear on approved bindings enrolled at
// service construction.
const CERTIFIED_RELATIONS = Object.freeze({
  'sqlserver.relation.rowid_payload.v1': Object.freeze({
    relationId: 'sqlserver.relation.rowid_payload.v1',
    sourceSchemaDigest: SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
    orderingKeyField: 'rowId',
    orderingKeyKind: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
    buildSourceReadSql(tableRef) {
      return buildRowIdPayloadSourceSql(tableRef)
    },
    buildOrderingKeyUniquenessProbeSql(tableRef) {
      return buildOrderingKeyUniquenessProbeSql(tableRef)
    },
  }),
})

function computeQueryBindingDigest({ objectKey, relationId, tableRef }) {
  return digestCanonicalConstant({
    actionId: SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
    filterPolicy: 'NONE',
    objectKey,
    profileId: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
    relationId,
    tableRef,
  })
}

function resolveCertifiedRelation(relationId) {
  const relation = CERTIFIED_RELATIONS[relationId]
  if (!relation) failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  return relation
}

module.exports = Object.freeze({
  SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
  SEALED_EXPORT_S5_CHUNK_BYTES,
  SEALED_EXPORT_S5_SORT_RUN_BYTES,
  SEALED_EXPORT_S5_SORT_MERGE_FAN_IN,
  SEALED_EXPORT_S5_AGENT_PROTOCOL_VERSION,
  SEALED_EXPORT_S5_ENCODING_VERSION,
  CAPTURE_METADATA_SQL,
  SOURCE_FIELDS,
  CERTIFIED_RELATIONS,
  computeQueryBindingDigest,
  resolveCertifiedRelation,
  assertSafeSqlServerRelation,
  buildOrderingKeyUniquenessProbeSql,
  // Intentionally no executeSqlServerSealedSnapshotAction export.
})

'use strict'

const crypto = require('node:crypto')

const canonicalCodec = require('./canonical-json.cjs')
const digests = require('./digests.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  assertSafeSqlServerRelation,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
} = require('./sqlserver-sealed-snapshot-action.cjs')
const {
  OBJECT_KEY,
  RELATION_ID,
} = require('./stock-preparation-runtime-store.cjs')

const CANONICAL_OBJECT_VERSION = 'stock-preparation-bom.v1'
const CONNECTOR_KIND = 'data-source:sql-readonly'
const ROLE_ID = 'stock-preparation-source'
const SOURCE_CONFIG_KEY = 'sealedSnapshotSqlServer'
const SOURCE_CONFIG_FIELDS = Object.freeze([
  'database',
  'encrypt',
  'instanceName',
  'port',
  'server',
  'trustServerCertificate',
])
const SOURCE_CREDENTIAL_FIELDS = Object.freeze(['password', 'user'])
const BINDING_DRAFT_FIELDS = Object.freeze([
  'approvedConfigVersionId',
  'bindingVersion',
  'canonicalObjectVersion',
  'externalSystemId',
  'objectKey',
  'relationId',
  'tableRef',
  'tenantId',
  'workspaceId',
])
const RESOLUTION_FIELDS = Object.freeze([
  ...BINDING_DRAFT_FIELDS,
  'bindingId',
  'configContentKey',
  'expiresAt',
  'roleBindingFingerprint',
  'systemContentKey',
  'tenantDomainBinding',
])
// The CLOSED set of members this module reads off the external-system record, and
// therefore the only members that are canonicalised.
//
// WHY THIS EXISTS. The value handed to normalizeExternalSystem() at request time is
// the ADAPTER-shaped record produced by lib/external-systems.cjs's
// rowToAdapterExternalSystem() (see stock-preparation-runtime-core.cjs's loadSource(),
// which re-fetches it via externalSystemRegistry.getExternalSystemForAdapter()). That
// record carries `createdAt`/`updatedAt` copied straight off the pg row — and, since
// this repository installs no `setTypeParser` anywhere, `pg` hands back native JS
// `Date` objects for TIMESTAMPTZ. canonical-json.cjs's domain refuses a `Date`
// (violation token EXOTIC_OBJECT), so canonicalising the WHOLE record refused every
// production-shaped record before a single field-set or identity check could run —
// SEALED_EXPORT_BINDING_UNQUALIFIED, HTTP 422, a CAPTURE_FAILED run row.
//
// The fix is a projection, not a widened codec: the codec's domain is a
// security-sensitive contract and stays exactly as narrow as it was, and
// rowToAdapterExternalSystem() — a shared adapter contract with other consumers —
// is untouched. Every field-set, identity and shape check below runs unchanged, on
// the projection.
//
// NARROWING DISCLOSED. Members OUTSIDE this list are no longer canonicalised, so a
// value that would previously have refused the whole record (a lone surrogate in
// `name`, an exotic object in `capabilities`) now simply never reaches the codec.
// That is the intended and entire blast radius: nothing in this module reads those
// members, so nothing derived from them can enter an anchor, a digest or a
// connection config.
//
// CLOSED AND PINNED. This list is not a hand-maintained comment: it is mechanically
// held equal to the set of members normalizeExternalSystem() actually reads by
// __tests__/sealed-export-s6a-source-authority-adapter-projection.test.cjs, which
// derives that set from this module's own source and fails on drift in EITHER
// direction (a member added here that nothing reads; a member read that is not here).
const EXTERNAL_SYSTEM_PROJECTION_FIELDS = Object.freeze([
  'config',
  'credentials',
  'id',
  'kind',
  'role',
  'status',
  'tenantId',
  'workspaceId',
])

function refuse() {
  failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
}

function exactObject(value, fields) {
  if (!canonicalCodec.__internals.isStrictPlainObject(value)) refuse()
  let keys
  try {
    keys = Object.keys(value).sort()
  } catch {
    refuse()
  }
  const expected = [...fields].sort()
  if (
    keys.length !== expected.length
    || keys.some((field, index) => field !== expected[index])
  ) {
    refuse()
  }
  return value
}

function requiredText(value, maxLength = 256) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
  ) {
    refuse()
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) refuse()
  }
  return value
}

// Driver credentials are opaque input, not identifiers. Leading/trailing spaces may be part of
// either the login or password and must survive byte-for-byte. Keep the sealed boundary finite
// and control-free, but never normalize a credential before it reaches the SQL Server driver.
function requiredCredentialText(value, maxLength) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
  ) {
    refuse()
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) refuse()
  }
  return value
}

function nullableText(value, maxLength = 256) {
  return value === null ? null : requiredText(value, maxLength)
}

function normalizeWorkspaceId(value) {
  if (value !== null) refuse()
  return null
}

function ownedCanonical(value) {
  const result = canonicalCodec.tryFreezeCanonical(value)
  if (!result.ok) refuse()
  return result.value
}

function canonicalBytes(value) {
  const result = canonicalCodec.tryCanonicalJson(value)
  if (!result.ok) refuse()
  return result.bytes
}

function normalizeIdentityKey(value) {
  if (
    !(value instanceof Uint8Array)
    || value.byteLength < 32
    || value.byteLength > 128
  ) {
    refuse()
  }
  return Buffer.from(value)
}

function domainHmac(key, domain, value) {
  return crypto
    .createHmac('sha256', key)
    .update(`${domain}\u0000`, 'utf8')
    .update(canonicalBytes(value))
    .digest('hex')
}

function domainDigest(domain, value) {
  return crypto
    .createHash('sha256')
    .update(`${domain}\u0000`, 'utf8')
    .update(canonicalBytes(value))
    .digest('hex')
}

function normalizeBindingDraft(raw) {
  const input = exactObject(raw, BINDING_DRAFT_FIELDS)
  const workspaceId = normalizeWorkspaceId(input.workspaceId)
  const tableRef = requiredText(input.tableRef)
  try {
    assertSafeSqlServerRelation(tableRef)
  } catch {
    refuse()
  }
  if (
    input.objectKey !== OBJECT_KEY
    || input.relationId !== RELATION_ID
    || input.canonicalObjectVersion !== CANONICAL_OBJECT_VERSION
  ) {
    refuse()
  }
  return Object.freeze({
    approvedConfigVersionId: requiredText(input.approvedConfigVersionId),
    bindingVersion: requiredText(input.bindingVersion),
    canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    externalSystemId: requiredText(input.externalSystemId),
    objectKey: OBJECT_KEY,
    relationId: RELATION_ID,
    tableRef,
    tenantId: requiredText(input.tenantId),
    workspaceId,
  })
}

// Project the external-system record down to EXTERNAL_SYSTEM_PROJECTION_FIELDS, the
// closed set this module reads, BEFORE anything is canonicalised.
//
// The container itself is still screened by the codec's own strict-plain-object
// predicate first, so the hostile-input guarantees canonicalising the whole record
// used to provide at the top level — no proxy, no accessor properties, no symbol
// keys, no non-enumerable properties, prototype is Object.prototype or null — are
// unchanged; only then is a plain data read of a whitelisted key possible.
//
// A member is copied only when it is an OWN property: an absent `workspaceId` must
// keep reaching the `?? null` comparison below as `undefined`, exactly as it did
// before this projection existed. Writing `undefined` into the projection instead
// would make the codec refuse (UNSUPPORTED_TYPE) a record it previously accepted.
function projectExternalSystem(raw) {
  if (!canonicalCodec.__internals.isStrictPlainObject(raw)) refuse()
  const projected = {}
  for (const field of EXTERNAL_SYSTEM_PROJECTION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      projected[field] = raw[field]
    }
  }
  return projected
}

function normalizeExternalSystem(raw, binding) {
  const system = ownedCanonical(projectExternalSystem(raw))
  if (
    !canonicalCodec.__internals.isStrictPlainObject(system)
    || system.id !== binding.externalSystemId
    || system.tenantId !== binding.tenantId
    || (system.workspaceId ?? null) !== binding.workspaceId
    || system.kind !== CONNECTOR_KIND
    || system.role !== 'source'
    || system.status !== 'active'
    || !canonicalCodec.__internals.isStrictPlainObject(system.config)
    || !canonicalCodec.__internals.isStrictPlainObject(system.credentials)
  ) {
    refuse()
  }
  const config = exactObject(
    system.config[SOURCE_CONFIG_KEY],
    SOURCE_CONFIG_FIELDS,
  )
  const credentialsContainer = exactObject(
    system.credentials,
    [SOURCE_CONFIG_KEY],
  )
  const credentials = exactObject(
    credentialsContainer[SOURCE_CONFIG_KEY],
    SOURCE_CREDENTIAL_FIELDS,
  )
  const port = config.port
  const instanceName = nullableText(config.instanceName)
  if (
    (port !== null && (!Number.isSafeInteger(port) || port < 1 || port > 65535))
    || (port === null) === (instanceName === null)
    || typeof config.encrypt !== 'boolean'
    || typeof config.trustServerCertificate !== 'boolean'
  ) {
    refuse()
  }
  const endpoint = Object.freeze({
    database: requiredText(config.database),
    encrypt: config.encrypt,
    instanceName,
    port,
    server: requiredText(config.server),
    trustServerCertificate: config.trustServerCertificate,
  })
  const principal = Object.freeze({
    user: requiredCredentialText(credentials.user, 256),
  })
  const password = requiredCredentialText(credentials.password, 4096)
  const options = {
    encrypt: endpoint.encrypt,
    readOnlyIntent: true,
    trustServerCertificate: endpoint.trustServerCertificate,
  }
  if (endpoint.instanceName !== null) options.instanceName = endpoint.instanceName
  const connectionConfig = {
    database: endpoint.database,
    options,
    password,
    server: endpoint.server,
    user: principal.user,
  }
  if (endpoint.port !== null) connectionConfig.port = endpoint.port
  return Object.freeze({
    connectionConfig: ownedCanonical(connectionConfig),
    endpoint,
    principal,
  })
}

function deriveStockPreparationSqlServerSourceAnchors({
  binding: rawBinding,
  externalSystem,
  identityKey: rawIdentityKey,
} = {}) {
  const binding = normalizeBindingDraft(rawBinding)
  const source = normalizeExternalSystem(externalSystem, binding)
  const identityKey = normalizeIdentityKey(rawIdentityKey)
  const tenantDomainBinding = domainHmac(
    identityKey,
    'metasheet.s6a.tenant-domain.v1',
    {
      tenantId: binding.tenantId,
      workspaceId: binding.workspaceId,
    },
  )
  const systemContentKey = domainHmac(
    identityKey,
    'metasheet.s6a.system-content.v1',
    {
      connectorKind: CONNECTOR_KIND,
      endpoint: source.endpoint,
      principal: source.principal,
    },
  )
  const configContentKey = domainDigest(
    'metasheet.s6a.config-content.v1',
    {
      canonicalObjectVersion: binding.canonicalObjectVersion,
      externalSystemId: binding.externalSystemId,
      objectKey: binding.objectKey,
      relationId: binding.relationId,
      tableRef: binding.tableRef,
    },
  )
  const roleBindingFingerprint = domainDigest(
    'metasheet.s6a.role-binding.v1',
    {
      actionProfileVersion: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
      approvedConfigVersionId: binding.approvedConfigVersionId,
      bindingVersion: binding.bindingVersion,
      canonicalObjectVersion: binding.canonicalObjectVersion,
      configContentKey,
      roleId: ROLE_ID,
      systemContentKey,
      tenantDomainBinding,
    },
  )
  return Object.freeze({
    binding,
    connectionConfig: source.connectionConfig,
    anchors: Object.freeze({
      configContentKey,
      roleBindingFingerprint,
      systemContentKey,
      tenantDomainBinding,
    }),
  })
}

function resolveStockPreparationSqlServerSource({
  binding: rawBinding,
  externalSystem,
  identityKey,
} = {}) {
  const resolution = exactObject(rawBinding, RESOLUTION_FIELDS)
  requiredText(resolution.bindingId)
  if (
    typeof resolution.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(resolution.expiresAt))
    || new Date(Date.parse(resolution.expiresAt)).toISOString()
      !== resolution.expiresAt
  ) {
    refuse()
  }
  const bindingDraft = {}
  for (const field of BINDING_DRAFT_FIELDS) {
    bindingDraft[field] = resolution[field]
  }
  const derived = deriveStockPreparationSqlServerSourceAnchors({
    binding: bindingDraft,
    externalSystem,
    identityKey,
  })
  for (const field of [
    'configContentKey',
    'roleBindingFingerprint',
    'systemContentKey',
    'tenantDomainBinding',
  ]) {
    const expected = derived.anchors[field]
    const observed = resolution[field]
    if (
      typeof observed !== 'string'
      || !digests.constantTimeEqualDigest(expected, observed)
    ) {
      refuse()
    }
  }
  return Object.freeze({
    ...derived,
    authority: Object.freeze({
      roleBindingFingerprint: derived.anchors.roleBindingFingerprint,
      systemContentKey: derived.anchors.systemContentKey,
      tenantDomainBinding: derived.anchors.tenantDomainBinding,
      tenantId: derived.binding.tenantId,
      workspaceId: derived.binding.workspaceId,
    }),
  })
}

module.exports = Object.freeze({
  BINDING_DRAFT_FIELDS,
  CANONICAL_OBJECT_VERSION,
  CONNECTOR_KIND,
  EXTERNAL_SYSTEM_PROJECTION_FIELDS,
  RESOLUTION_FIELDS,
  ROLE_ID,
  SOURCE_CONFIG_FIELDS,
  SOURCE_CONFIG_KEY,
  SOURCE_CREDENTIAL_FIELDS,
  deriveStockPreparationSqlServerSourceAnchors,
  resolveStockPreparationSqlServerSource,
})

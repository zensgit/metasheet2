// reference-integration-templates.cjs
// S3-3: opt-in reference (example) integration-template definitions.
//
// These are DECLARATIVE, VALUES-FREE catalog constants — no tenant, no credentials, no sheetId,
// no customer rows. An operator discovers them via GET /api/integration/templates/references, then
// registers a chosen one into their OWN tenant by POSTing it (with their scope) to the existing
// POST /api/integration/templates upsert. They are NOT auto-seeded or auto-instantiated (design-lock
// §3 #3: opt-in registration only). Binding to concrete source/target systems happens at instantiate
// time (S3-2). A K3 reference template may be defined, but its runtime write stays S2-gated — the
// `runtimeWriteGate` field flags that for discovery; it is reference metadata, not a write path.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')

class ReferenceIntegrationTemplateError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ReferenceIntegrationTemplateError'
    this.status = 500 // catalog is our own constants; a violation is a server-side bug, not a 4xx
    this.code = 'INTEGRATION_REFERENCE_TEMPLATE_INVALID'
    this.details = details
  }
}

// A reference def is a SCHEMA, never data/secret/scope. These keys must never appear anywhere in it.
const FORBIDDEN_CONTENT_KEYS = Object.freeze([
  'rows', 'records', 'data', 'values', 'content',
  'credentials', 'credentialsEncrypted', 'config', 'sheetId',
  'tenantId', 'workspaceId', 'id', 'createdBy',
])

// The catalog. Each entry is a partial template input (no scope) the operator completes with their
// tenantId/workspaceId when POSTing to /templates. Multitable-first (sandbox-ready).
const REFERENCE_INTEGRATION_TEMPLATES = Object.freeze([
  Object.freeze({
    refId: 'ref.sql-readonly-to-multitable.basic.v1',
    name: 'SQL (read-only) → MetaSheet multitable',
    description: 'Read-only sync from a SQL read-only source object into an own multitable sheet. '
      + 'Bind a concrete data-source:sql-readonly source + a metasheet:multitable target at instantiation.',
    sourceKind: 'data-source:sql-readonly',
    sourceObject: 'dbo.items',
    targetKind: 'metasheet:multitable',
    targetObject: 'imported_items',
    keyFields: Object.freeze(['code']),
    mappingDef: Object.freeze([
      Object.freeze({ sourceField: 'code', targetField: 'code' }),
      Object.freeze({ sourceField: 'name', targetField: 'name' }),
    ]),
    orchestrationConfig: Object.freeze({ schedule: 'manual' }),
    runtimeWriteGate: null, // multitable own-sheet target — no gate beyond the C6 safe-write lifecycle
  }),
  Object.freeze({
    refId: 'ref.k3-material-to-multitable.v1',
    name: 'K3 material → MetaSheet multitable (reference; runtime write S2-gated)',
    description: 'Reference shape for syncing K3 WISE materials into a multitable sheet. Definable and '
      + 'instantiable to a bound system now, but any K3 runtime write requires the S2 (K3 WebAPI) gate '
      + 'plus the operator-run entity-machine smoke. Reference-only until then.',
    sourceKind: 'erp:k3-wise-webapi',
    sourceObject: 'GetMaterialDetail',
    targetKind: 'metasheet:multitable',
    targetObject: 'k3_materials',
    keyFields: Object.freeze(['materialCode']),
    mappingDef: Object.freeze([
      Object.freeze({ sourceField: 'FNumber', targetField: 'materialCode' }),
      Object.freeze({ sourceField: 'FName', targetField: 'materialName' }),
    ]),
    orchestrationConfig: Object.freeze({ schedule: 'manual' }),
    runtimeWriteGate: 's2-k3-webapi', // discovery flag: reference-only for runtime write until S2 unlock
  }),
])

function assertNoForbiddenKeys(obj, at) {
  if (!obj || typeof obj !== 'object') return
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_CONTENT_KEYS.includes(key)) {
      throw new ReferenceIntegrationTemplateError(
        `reference template "${at}" must not carry a "${key}" (schema only — no data/secret/scope)`,
        { field: `${at}.${key}` },
      )
    }
  }
}

// Defense-in-depth: even though the catalog is our own constants, validate before publishing so a
// future edit can never leak a secret-shaped value or smuggle content/scope through GET /references.
function assertReferenceTemplateValuesFree(value, at) {
  if (typeof value === 'string') {
    if (scrubSecretStringValue(value) !== value) {
      throw new ReferenceIntegrationTemplateError(`reference template "${at}" is secret-shaped`, { field: at })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertReferenceTemplateValuesFree(entry, `${at}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    assertNoForbiddenKeys(value, at)
    for (const [key, entry] of Object.entries(value)) {
      assertReferenceTemplateValuesFree(entry, `${at}.${key}`)
    }
  }
}

// Returns a deep, mutable copy of the catalog (so callers/serialization can't mutate the frozen
// constants), after asserting each entry is values-free.
function listReferenceIntegrationTemplates() {
  return REFERENCE_INTEGRATION_TEMPLATES.map((def) => {
    assertReferenceTemplateValuesFree(def, def.refId)
    return {
      refId: def.refId,
      name: def.name,
      description: def.description,
      sourceKind: def.sourceKind,
      sourceObject: def.sourceObject,
      targetKind: def.targetKind,
      targetObject: def.targetObject,
      keyFields: [...def.keyFields],
      mappingDef: def.mappingDef.map((m) => ({ ...m })),
      orchestrationConfig: { ...def.orchestrationConfig },
      runtimeWriteGate: def.runtimeWriteGate,
    }
  })
}

module.exports = {
  REFERENCE_INTEGRATION_TEMPLATES,
  listReferenceIntegrationTemplates,
  assertReferenceTemplateValuesFree,
  ReferenceIntegrationTemplateError,
  FORBIDDEN_CONTENT_KEYS,
}

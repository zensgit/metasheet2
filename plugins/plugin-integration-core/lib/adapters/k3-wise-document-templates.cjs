'use strict'

const K3_WISE_DOCUMENT_TEMPLATE_VERSION = '2026.05.v1'

const K3_REFERENCE_BY_NUMBER = { identifier: 'FNumber' }
const K3_REFERENCE_BY_ID = { identifier: 'FID' }

const MATERIAL_FIELD_MAPPINGS = [
  {
    sourceField: 'code',
    targetField: 'FNumber',
    transform: ['trim', 'upper'],
    validation: [{ type: 'required' }],
  },
  {
    sourceField: 'name',
    targetField: 'FName',
    transform: { fn: 'trim' },
    validation: [{ type: 'required' }],
  },
  {
    sourceField: 'spec',
    targetField: 'FModel',
    transform: { fn: 'trim' },
  },
  {
    sourceField: 'uom',
    targetField: 'FBaseUnitID',
    transform: {
      fn: 'dictMap',
      map: {
        PCS: 'Pcs',
        EA: 'Pcs',
        KG: 'Kg',
      },
    },
  },
  {
    sourceField: 'sourceId',
    targetField: 'sourceId',
    validation: [{ type: 'required' }],
  },
  {
    sourceField: 'revision',
    targetField: 'revision',
    defaultValue: 'A',
  },
]

const BOM_FIELD_MAPPINGS = [
  {
    sourceField: 'parentCode',
    targetField: 'FParentItemNumber',
    transform: ['trim', 'upper'],
    validation: [{ type: 'required' }],
  },
  {
    sourceField: 'childCode',
    targetField: 'FChildItemNumber',
    transform: ['trim', 'upper'],
    validation: [{ type: 'required' }],
  },
  {
    sourceField: 'quantity',
    targetField: 'FQty',
    transform: { fn: 'toNumber' },
    validation: [{ type: 'min', value: 0.000001 }],
  },
  {
    sourceField: 'uom',
    targetField: 'FUnitID',
    transform: { fn: 'trim' },
  },
  {
    sourceField: 'sequence',
    targetField: 'FEntryID',
    transform: { fn: 'toNumber' },
  },
  {
    sourceField: 'sourceId',
    targetField: 'sourceId',
    validation: [{ type: 'required' }],
  },
  {
    sourceField: 'revision',
    targetField: 'revision',
    defaultValue: 'A',
  },
]

const K3_WISE_DOCUMENT_TEMPLATES = {
  material: {
    id: 'k3wise.material.v1',
    version: K3_WISE_DOCUMENT_TEMPLATE_VERSION,
    documentType: 'material',
    targetObject: 'material',
    label: 'K3 WISE Material',
    operations: ['upsert'],
    savePath: '/K3API/Material/Save',
    readPath: '/K3API/Material/GetDetail',
    readMethod: 'POST',
    submitPath: '/K3API/Material/Submit',
    auditPath: '/K3API/Material/Audit',
    bodyKey: 'Data',
    keyField: 'FNumber',
    keyParam: 'Number',
    schema: [
      { name: 'FNumber', label: 'Material code', type: 'string', required: true },
      { name: 'FName', label: 'Material name', type: 'string', required: true },
      { name: 'FModel', label: 'Specification', type: 'string' },
      { name: 'FUnitGroupID', label: 'Unit group', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
      { name: 'FBaseUnitID', label: 'Base unit', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
      { name: 'FOrderUnitID', label: 'Order unit', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
      { name: 'FSaleUnitID', label: 'Sales unit', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
      { name: 'FProductUnitID', label: 'Production unit', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
      { name: 'FStoreUnitID', label: 'Inventory unit', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
      { name: 'FAcctID', label: 'Inventory account', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
      { name: 'FSaleAcctID', label: 'Sales account', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
      { name: 'FCostAcctID', label: 'Cost account', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
      { name: 'FCheckCycle', label: 'Check cycle', type: 'number' },
      { name: 'FTrack', label: 'Track policy', type: 'string' },
      { name: 'FBatChangeEconomy', label: 'Batch change economy', type: 'number' },
      { name: 'FStdBatchQty', label: 'Standard batch quantity', type: 'number' },
      { name: 'FKanBanCapability', label: 'Kanban capability', type: 'number' },
    ],
    sampleSource: {
      code: 'MAT-001',
      name: 'Bolt',
      spec: 'M6 x 20',
      uom: 'PCS',
      sourceId: 'plm-material-001',
      revision: 'A',
    },
    fieldMappings: MATERIAL_FIELD_MAPPINGS,
  },
  bom: {
    id: 'k3wise.bom.v1',
    version: K3_WISE_DOCUMENT_TEMPLATE_VERSION,
    documentType: 'bom',
    targetObject: 'bom',
    label: 'K3 WISE BOM',
    operations: ['upsert'],
    savePath: '/K3API/BOM/Save',
    submitPath: '/K3API/BOM/Submit',
    auditPath: '/K3API/BOM/Audit',
    bodyKey: 'Data',
    keyField: 'FParentItemNumber',
    keyParam: 'Number',
    schema: [
      { name: 'FParentItemNumber', label: 'Parent material code', type: 'string', required: true },
      { name: 'FChildItemNumber', label: 'Child material code', type: 'string', required: true },
      { name: 'FQty', label: 'Quantity', type: 'number', required: true },
      { name: 'FUnitID', label: 'Unit', type: 'string' },
      { name: 'FEntryID', label: 'Line sequence', type: 'number' },
    ],
    sampleSource: {
      parentCode: 'FG-001',
      childCode: 'MAT-001',
      quantity: 2,
      uom: 'PCS',
      sequence: 1,
      sourceId: 'plm-bom-001',
      revision: 'A',
    },
    fieldMappings: BOM_FIELD_MAPPINGS,
  },
}

// Customer-profiled Material Save preset (M1 Save-only fix). Distinct from the generic
// minimal template `k3wise.material.v1`. Applied ONLY when config selects it by id
// (`config.objects.material.profile`); the default template is NEVER silently swapped
// (R-OPTIN). Declares the FULLER field set the customer K3 WISE env requires (G2) with
// per-field reference shape (G3: numbered base data -> {FNumber,FName}; enum/category ->
// {FID,FName}). STRUCTURE ONLY — no customer dictionary values are baked in; operators
// supply values at runtime (no-hardcoded-values rule). Save-only by construction: no
// submitPath/auditPath, so submit/audit cannot fire from this profile.
const MATERIAL_CUSTOMER_PROFILE_ID = 'material-k3wise-customer-profile-v1'
const MATERIAL_CUSTOMER_PROFILE = {
  id: MATERIAL_CUSTOMER_PROFILE_ID,
  version: K3_WISE_DOCUMENT_TEMPLATE_VERSION,
  documentType: 'material',
  targetObject: 'material',
  label: 'K3 WISE Material (customer profile)',
  operations: ['upsert'],
  // Hard Save-only lock (M1): the adapter forces autoSubmit/autoAudit off and strips any
  // submit/audit endpoint when this profile is selected — non-overridable by config/request.
  lifecycle: 'save-only',
  savePath: '/K3API/Material/Save',
  readPath: '/K3API/Material/GetDetail',
  readMethod: 'POST',
  bodyKey: 'Data',
  keyField: 'FNumber',
  keyParam: 'Number',
  schema: [
    { name: 'FNumber', label: 'Material code', type: 'string', required: true },
    { name: 'FName', label: 'Material name', type: 'string', required: true },
    { name: 'FModel', label: 'Specification', type: 'string' },
    // Unit family + accounts + warehouse + manager — numbered base data ({FNumber,FName})
    { name: 'FUnitGroupID', label: 'Unit group', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    { name: 'FUnitID', label: 'Unit', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    // FBaseUnitID intentionally omitted: the customer K3 15.1 Material contract (doAddMaterial)
    // uses FUnitID + the unit family, not FBaseUnitID. Default-projecting it caused the M1 dry-run
    // cross-check mismatch and contributed to the failed Save attempts; M1 one-record Save PASSED
    // 2026-05-28 with it removed. See integration-k3wise-m1-customer-profile-fbaseunitid-alignment-*.
    { name: 'FOrderUnitID', label: 'Order unit', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    { name: 'FSaleUnitID', label: 'Sales unit', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    { name: 'FProductUnitID', label: 'Production unit', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    { name: 'FStoreUnitID', label: 'Inventory unit', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    { name: 'FAcctID', label: 'Inventory account', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    { name: 'FSaleAcctID', label: 'Sales account', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    { name: 'FCostAcctID', label: 'Cost account', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    { name: 'FDefaultLoc', label: 'Default warehouse', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    { name: 'FDSManagerID', label: 'Default stock manager', type: 'reference', reference: K3_REFERENCE_BY_NUMBER },
    // Enum / category — by FID ({FID,FName})
    { name: 'FErpClsID', label: 'ERP material category', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FUseState', label: 'Use state', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FTrack', label: 'Track policy', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FPlanTrategy', label: 'Planning strategy', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FOrderTrategy', label: 'Order strategy', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FInspectionLevel', label: 'Inspection level', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FProChkMde', label: 'Production inspection mode', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FWWChkMde', label: 'Outsourcing inspection mode', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FSOChkMde', label: 'Sales inspection mode', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FWthDrwChkMde', label: 'Receipt inspection mode', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FStkChkMde', label: 'Stock inspection mode', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FOtherChkMde', label: 'Other inspection mode', type: 'reference', reference: K3_REFERENCE_BY_ID },
    { name: 'FPlanPrice', label: 'Plan price', type: 'number' },
  ],
  fieldMappings: MATERIAL_FIELD_MAPPINGS,
}

const K3_WISE_MATERIAL_PROFILES = {
  [MATERIAL_CUSTOMER_PROFILE_ID]: MATERIAL_CUSTOMER_PROFILE,
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function assertRelativeEndpoint(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`)
  }
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    throw new Error(`${field} must be relative to the K3 WISE base URL`)
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function normalizeSchema(schema, field) {
  if (!Array.isArray(schema) || schema.length === 0) {
    throw new Error(`${field}.schema must be a non-empty array`)
  }
  return schema.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`${field}.schema[${index}] must be an object`)
    if (typeof item.name !== 'string' || item.name.trim().length === 0) {
      throw new Error(`${field}.schema[${index}].name is required`)
    }
    return { ...item, name: item.name.trim() }
  })
}

function normalizeTemplate(template, field) {
  if (!isPlainObject(template)) throw new Error(`${field} must be an object`)
  const savePath = assertRelativeEndpoint(template.savePath || template.path, `${field}.savePath`)
  const normalized = {
    ...cloneJson(template),
    savePath,
    bodyKey: typeof template.bodyKey === 'string' && template.bodyKey.trim()
      ? template.bodyKey.trim()
      : 'Data',
    schema: normalizeSchema(template.schema, field),
    operations: Array.isArray(template.operations) && template.operations.length > 0
      ? [...template.operations]
      : ['upsert'],
  }
  if (template.submitPath) normalized.submitPath = assertRelativeEndpoint(template.submitPath, `${field}.submitPath`)
  if (template.auditPath) normalized.auditPath = assertRelativeEndpoint(template.auditPath, `${field}.auditPath`)
  if (template.readPath) normalized.readPath = assertRelativeEndpoint(template.readPath, `${field}.readPath`)
  normalized.k3Template = {
    id: template.id,
    version: template.version,
    documentType: template.documentType,
  }
  return normalized
}

function getK3WiseDocumentTemplate(name) {
  const template = K3_WISE_DOCUMENT_TEMPLATES[name]
  return template ? cloneJson(template) : null
}

function listK3WiseDocumentTemplates() {
  return Object.values(K3_WISE_DOCUMENT_TEMPLATES).map((template) => cloneJson(template))
}

function getK3WiseMaterialProfile(id) {
  const key = typeof id === 'string' ? id.trim() : ''
  const profile = key ? K3_WISE_MATERIAL_PROFILES[key] : null
  return profile ? normalizeTemplate(profile, `materialProfile.${key}`) : null
}

function listK3WiseMaterialProfiles() {
  return Object.keys(K3_WISE_MATERIAL_PROFILES)
}

function getK3WiseDocumentObjectDefaults() {
  const defaults = {}
  for (const [name, template] of Object.entries(K3_WISE_DOCUMENT_TEMPLATES)) {
    defaults[name] = normalizeTemplate(template, `documentTemplates.${name}`)
  }
  return defaults
}

function mergeK3WiseDocumentObject(templateObject, configuredObject, field) {
  const merged = {
    ...cloneJson(templateObject),
    ...(isPlainObject(configuredObject) ? cloneJson(configuredObject) : {}),
  }
  if (templateObject.k3Template) {
    merged.k3Template = {
      ...templateObject.k3Template,
      ...(isPlainObject(configuredObject && configuredObject.k3Template) ? configuredObject.k3Template : {}),
    }
  }
  return normalizeTemplate(merged, field)
}

module.exports = {
  K3_WISE_DOCUMENT_TEMPLATE_VERSION,
  K3_WISE_DOCUMENT_TEMPLATES,
  K3_WISE_MATERIAL_PROFILES,
  MATERIAL_CUSTOMER_PROFILE_ID,
  getK3WiseDocumentObjectDefaults,
  getK3WiseDocumentTemplate,
  getK3WiseMaterialProfile,
  listK3WiseDocumentTemplates,
  listK3WiseMaterialProfiles,
  mergeK3WiseDocumentObject,
  normalizeTemplate,
}

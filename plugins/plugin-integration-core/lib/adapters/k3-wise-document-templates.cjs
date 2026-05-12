'use strict'

const K3_WISE_DOCUMENT_TEMPLATE_VERSION = '2026.05.v1'

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
    submitPath: '/K3API/Material/Submit',
    auditPath: '/K3API/Material/Audit',
    bodyKey: 'Data',
    keyField: 'FNumber',
    keyParam: 'Number',
    schema: [
      { name: 'FNumber', label: 'Material code', type: 'string', required: true },
      { name: 'FName', label: 'Material name', type: 'string', required: true },
      { name: 'FModel', label: 'Specification', type: 'string' },
      { name: 'FBaseUnitID', label: 'Base unit', type: 'string' },
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
  getK3WiseDocumentObjectDefaults,
  getK3WiseDocumentTemplate,
  listK3WiseDocumentTemplates,
  mergeK3WiseDocumentObject,
  normalizeTemplate,
}

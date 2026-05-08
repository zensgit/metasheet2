'use strict'

// ---------------------------------------------------------------------------
// Staging installer — plugin-integration-core
//
// Provisions the multitable "sheets" that pipelines use as staging / audit
// surfaces. These are user-visible sheets inside metasheet2, NOT SQL tables:
// SQL operational state lives in 057_create_integration_core_tables.sql.
//
//   plm_raw_items          — raw records pulled from PLM before cleansing
//   standard_materials     — cleansed, standardized material master
//   bom_cleanse            — cleansed BOM line items
//   integration_exceptions — user-visible exception queue (people fix here)
//   integration_run_log    — human-readable run summary
//
// Field authoring note (fixed after PR #0 review):
//   The multitable provisioning contract
//   (packages/core-backend/src/multitable/contracts.ts:13) only accepts
//   { id, name, type, order?, options?, property? } on a field descriptor.
//   `required: true` at the top level is silently dropped. Validation rules
//   are stored in `property.validation` as a FieldValidationConfig
//   (see packages/core-backend/src/multitable/field-validation.ts:5).
//
//   We keep the authoring ergonomics (`required: true`) local to this file
//   and `materializeDescriptor()` transforms each field before we hand the
//   descriptor to ensureObject().
//
// All sheets are idempotent: re-running install() on an existing project
// must not duplicate sheets or lose data (provisioning.ensureObject enforces
// this at the multitable level).
// ---------------------------------------------------------------------------

const RAW_DESCRIPTORS = [
  {
    id: 'plm_raw_items',
    name: 'PLM Raw Items',
    fields: [
      { id: 'sourceSystemId', name: 'Source System', type: 'string', required: true },
      { id: 'objectType',     name: 'Object Type',   type: 'string', required: true },
      { id: 'sourceId',       name: 'Source ID',     type: 'string', required: true },
      { id: 'revision',       name: 'Revision',      type: 'string' },
      { id: 'code',           name: 'Code',          type: 'string' },
      { id: 'name',           name: 'Name',          type: 'string' },
      { id: 'rawPayload',     name: 'Raw Payload',   type: 'string' },
      { id: 'fetchedAt',      name: 'Fetched At',    type: 'date'   },
      { id: 'pipelineRunId',  name: 'Run ID',        type: 'string' },
    ],
  },
  {
    id: 'standard_materials',
    name: 'Standard Materials',
    fields: [
      { id: 'code',              name: 'Material Code',   type: 'string', required: true },
      { id: 'name',              name: 'Material Name',   type: 'string', required: true },
      { id: 'uom',               name: 'Unit of Measure', type: 'string' },
      { id: 'category',          name: 'Category',        type: 'string' },
      { id: 'status',            name: 'Status',          type: 'select', required: true, options: ['draft', 'active', 'obsolete'] },
      { id: 'erpSyncStatus',     name: 'ERP Sync Status', type: 'select', options: ['pending', 'synced', 'failed'] },
      { id: 'erpExternalId',     name: 'ERP External ID', type: 'string' },
      { id: 'erpBillNo',         name: 'ERP Bill No',     type: 'string' },
      { id: 'erpResponseCode',   name: 'ERP Resp Code',   type: 'string' },
      { id: 'erpResponseMessage',name: 'ERP Resp Msg',    type: 'string' },
      { id: 'lastSyncedAt',      name: 'Last Synced At',  type: 'date'   },
    ],
  },
  {
    id: 'bom_cleanse',
    name: 'BOM Cleanse',
    fields: [
      { id: 'parentCode',   name: 'Parent Code',  type: 'string', required: true },
      { id: 'childCode',    name: 'Child Code',   type: 'string', required: true },
      { id: 'quantity',     name: 'Quantity',     type: 'number', required: true },
      { id: 'uom',          name: 'UoM',          type: 'string' },
      { id: 'sequence',     name: 'Sequence',     type: 'number' },
      { id: 'revision',     name: 'Revision',     type: 'string' },
      { id: 'validFrom',    name: 'Valid From',   type: 'date'   },
      { id: 'validTo',      name: 'Valid To',     type: 'date'   },
      { id: 'status',       name: 'Status',       type: 'select', required: true, options: ['draft', 'active', 'obsolete'] },
    ],
  },
  {
    id: 'integration_exceptions',
    name: 'Integration Exceptions',
    fields: [
      { id: 'pipelineId',       name: 'Pipeline ID',     type: 'string', required: true },
      { id: 'runId',            name: 'Run ID',          type: 'string', required: true },
      { id: 'idempotencyKey',   name: 'Idempotency Key', type: 'string' },
      { id: 'errorCode',        name: 'Error Code',      type: 'string', required: true },
      { id: 'errorMessage',     name: 'Error Message',   type: 'string', required: true },
      { id: 'sourcePayload',    name: 'Source Payload',  type: 'string' },
      { id: 'transformedPayload',name: 'Transformed',    type: 'string' },
      { id: 'status',           name: 'Status',          type: 'select', required: true, options: ['open', 'in_review', 'replayed', 'discarded'] },
      { id: 'assignee',         name: 'Assignee',        type: 'string' },
      { id: 'note',             name: 'Note',            type: 'string' },
    ],
  },
  {
    id: 'integration_run_log',
    name: 'Integration Run Log',
    fields: [
      { id: 'pipelineId',   name: 'Pipeline ID', type: 'string', required: true },
      { id: 'runId',        name: 'Run ID',      type: 'string', required: true },
      { id: 'mode',         name: 'Mode',        type: 'select', required: true, options: ['incremental', 'full', 'manual', 'replay'] },
      { id: 'triggeredBy',  name: 'Triggered By',type: 'string', required: true },
      { id: 'status',       name: 'Status',      type: 'select', required: true, options: ['pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] },
      { id: 'rowsRead',     name: 'Rows Read',   type: 'number' },
      { id: 'rowsCleaned',  name: 'Rows Cleaned',type: 'number' },
      { id: 'rowsWritten',  name: 'Rows Written',type: 'number' },
      { id: 'rowsFailed',   name: 'Rows Failed', type: 'number' },
      { id: 'durationMs',   name: 'Duration ms', type: 'number' },
      { id: 'startedAt',    name: 'Started At',  type: 'date'   },
      { id: 'finishedAt',   name: 'Finished At', type: 'date'   },
      { id: 'errorSummary', name: 'Error Summary',type: 'string'},
    ],
  },
]

// Transform authoring-ergonomic `required: true` fields into the real
// contract shape: { id, name, type, options?, property: { validation: [...] } }.
function materializeField(raw, order) {
  const field = {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    order,
  }
  if (Array.isArray(raw.options) && raw.options.length > 0) {
    field.options = raw.options.slice()
  }
  const existingProperty = raw.property && typeof raw.property === 'object' ? { ...raw.property } : {}
  const validation = Array.isArray(existingProperty.validation) ? existingProperty.validation.slice() : []
  if (raw.required) {
    const alreadyRequired = validation.some((rule) => rule && rule.type === 'required')
    if (!alreadyRequired) validation.push({ type: 'required' })
  }
  if (validation.length > 0) {
    existingProperty.validation = validation
  }
  if (Object.keys(existingProperty).length > 0) {
    field.property = existingProperty
  }
  return field
}

function materializeDescriptor(raw) {
  return {
    id: raw.id,
    name: raw.name,
    // `backing` / `provisioning` are not part of the provisioning field
    // contract but are tolerated by callers that still look at them
    // (plugin-after-sales installer does). Keep them for forward-compat.
    backing: 'multitable',
    provisioning: { multitable: true },
    fields: raw.fields.map((f, i) => materializeField(f, i)),
  }
}

const STAGING_DESCRIPTORS = Object.freeze(RAW_DESCRIPTORS.map(materializeDescriptor))

function isProvisioningAvailable(context) {
  return Boolean(
    context
    && context.api
    && context.api.multitable
    && context.api.multitable.provisioning
    && typeof context.api.multitable.provisioning.ensureObject === 'function',
  )
}

/**
 * Install the full staging sheet set for a given project.
 * Idempotent — re-invoking does not duplicate sheets.
 * Returns a map of `{ [descriptorId]: sheetId }` for downstream modules.
 */
async function installStaging({ context, projectId, baseId = null, logger } = {}) {
  if (!isProvisioningAvailable(context)) {
    throw new Error('staging-installer: context.api.multitable.provisioning.ensureObject not available')
  }
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('staging-installer: projectId is required')
  }

  const log = logger && typeof logger.info === 'function' ? logger : console
  const result = {}
  const warnings = []

  for (const descriptor of STAGING_DESCRIPTORS) {
    try {
      const provisioned = await context.api.multitable.provisioning.ensureObject({
        projectId,
        baseId,
        descriptor,
      })
      if (provisioned && provisioned.sheet && provisioned.sheet.id) {
        result[descriptor.id] = provisioned.sheet.id
      } else {
        warnings.push(`ensureObject returned no sheet id for ${descriptor.id}`)
      }
    } catch (err) {
      warnings.push(`failed to ensure ${descriptor.id}: ${err && err.message ? err.message : err}`)
    }
  }

  log.info(
    `[plugin-integration-core] staging install done. sheets=${Object.keys(result).length}/${STAGING_DESCRIPTORS.length} warnings=${warnings.length}`,
  )
  return { sheetIds: result, warnings }
}

function summarizeField(field) {
  const summary = {
    id: field.id,
    name: field.name,
    type: field.type,
  }
  if (Array.isArray(field.options) && field.options.length > 0) {
    summary.options = field.options.slice()
  }
  if (field.property && typeof field.property === 'object' && !Array.isArray(field.property)) {
    const property = { ...field.property }
    if (Array.isArray(field.property.validation)) {
      property.validation = field.property.validation.map((rule) => (
        rule && typeof rule === 'object' && !Array.isArray(rule) ? { ...rule } : rule
      ))
    }
    if (Object.keys(property).length > 0) summary.property = property
  }
  return summary
}

function listStagingDescriptors() {
  return STAGING_DESCRIPTORS.map((d) => ({
    id: d.id,
    name: d.name,
    fields: d.fields.map((f) => f.id),
    fieldDetails: d.fields.map(summarizeField),
  }))
}

module.exports = {
  installStaging,
  listStagingDescriptors,
  STAGING_DESCRIPTORS,
  __internals: {
    isProvisioningAvailable,
    materializeField,
    materializeDescriptor,
    summarizeField,
    RAW_DESCRIPTORS,
  },
}

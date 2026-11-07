import { createHash } from 'node:crypto'
import { types } from 'node:util'
import canonical from './gip-canonical-json.cjs'
import { buildYidaStaticPlan, parseYidaStaticRows, transformDependencies, validateYidaStaticConfig, YidaStaticPlanError } from './yida-static-plan.mjs'
import { buildYidaProjectAllocationPreview, YidaAllocationError } from './stock-preparation-yida-allocation.mjs'

// Pure, unregistered local draft compilation. Neither a locator nor a digest
// proves remote ownership, grants authority, or creates a delivery reservation.
const { stableCanonicalStringify, deepCloneFrozenCanonical } = canonical
const INPUT_BUDGET = Object.freeze({ bytes: 2 * 1024 * 1024, depth: 12, nodes: 20000 })
const OUTPUT_BUDGET = Object.freeze({ bytes: 4 * 1024 * 1024, depth: 16, nodes: 50000 })
const ERROR_KINDS = new Set(['INPUT', 'CONFIG', 'PLAN', 'LIMIT'])
const ownErrors = new WeakMap()
// Source binding (design baseline v2.3 §7.2, decision D1 a′). The host attaches it ONLY when the rows were
// read by the server from a registered project sheet; a pasted rowsText never carries one. The binding is
// per SOURCE row (before allocation); the compiler attaches the allocated project to every expanded row.
const BINDING_KEYS = ['sheetId', 'keyFieldId', 'fieldBindings', 'records']
const RECORD_KEYS = ['recordId', 'keyValue', 'projectNo']
const PER_ROW_BINDING_KEYS = ['sheetId', 'recordId', 'keyFieldId', 'keyValue', 'projectNo', 'fieldBindings', 'fieldDependencies']
const IDENTIFIER = /^[\p{L}\p{N}_-]{1,128}$/u
const CONTROL = /[\u0000-\u001f\u007f]/u
const MAX_KEY_VALUE_LENGTH = 4096
// Row problems of the persistent send entry (addendum 2026-11-06; v2.3 §7.1). Each refuses the WHOLE draft with the
// closed, values-free kind PLAN (HTTP: the send authority's UNAVAILABLE); the name is documentation, not a new code
// (whether these get a dedicated code is an owner question, baseline §7.2 open item).
//   SOURCE_UNBOUND           - a generated entry on a row the server did not read (no source binding).
//   SOURCE_PROJECT_MISMATCH  - a bound row whose preset projectOf cell is not the project its binding names
//                              (「同码必同身份」 in original mode, Y4-05 option a; in a split it holds by construction).
const ROW_PROBLEM = Object.freeze({ SOURCE_UNBOUND: 'PLAN', SOURCE_PROJECT_MISMATCH: 'PLAN' })

export class YidaDraftPlanError extends Error {
  constructor(kind = 'INPUT') {
    const fixed = ERROR_KINDS.has(kind) ? kind : 'INPUT'
    super(`YIDA_DRAFT_${fixed}`)
    this.name = 'YidaDraftPlanError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}

function fail(kind) { throw new YidaDraftPlanError(kind) }

// Inspect the original domain before the shared codec can normalize -0 or clone
// it. This is a bounded domain check, not a second canonical serializer.
function bounded(value, budget) {
  let nodes = 0
  let textBytes = 0
  const ancestors = new Set()
  const charge = text => {
    textBytes += Buffer.byteLength(text, 'utf8')
    if (textBytes > budget.bytes) fail('LIMIT')
  }
  function visit(entry, depth) {
    if (++nodes > budget.nodes || depth > budget.depth) fail('LIMIT')
    if (entry === null || typeof entry === 'boolean') return
    if (typeof entry === 'string') { charge(entry); return }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) fail('INPUT')
      return
    }
    if (!entry || typeof entry !== 'object' || types.isProxy(entry) || ancestors.has(entry)) fail('INPUT')
    const array = Array.isArray(entry)
    if (Object.getPrototypeOf(entry) !== (array ? Array.prototype : Object.prototype)) fail('INPUT')
    const descriptors = Object.getOwnPropertyDescriptors(entry)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length > budget.nodes + 1) fail('LIMIT')
    const length = array ? descriptors.length?.value : null
    if (array && (!Number.isSafeInteger(length) || keys.length !== length + 1)) fail('INPUT')
    ancestors.add(entry)
    for (const key of keys) {
      if (array && key === 'length') continue
      const property = descriptors[key]
      if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')
        || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) fail('INPUT')
      charge(key)
      visit(property.value, depth + 1)
    }
    ancestors.delete(entry)
  }
  visit(value, 0)
  if (Buffer.byteLength(stableCanonicalStringify(value), 'utf8') > budget.bytes) fail('LIMIT')
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INPUT')
}

function compareCodePoints(left, right) {
  const a = Array.from(left, character => character.codePointAt(0))
  const b = Array.from(right, character => character.codePointAt(0))
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const hashCanonical = value => hash(stableCanonicalStringify(value))

// Returns the plan and, for every planned row, its origin: the source row index and the project the row
// carries (the allocated project, or null when the rows are planned as written).
function compilePlan(config, rowsText, allocation) {
  try {
    if (allocation.mode === 'original') {
      const rows = parseYidaStaticRows(rowsText, config)
      const plan = buildYidaStaticPlan({ config, rows })
      return { plan, sourceRows: rows, origins: rows.map((_, index) => ({ sourceIndex: index, project: null })) }
    }
    const preview = buildYidaProjectAllocationPreview({ config, rowsText, allocation })
    if (preview.issues.some(issue => ['EXPANDED_ROWS_LIMIT', 'EXPANDED_TEXT_LIMIT'].includes(issue.code))) fail('LIMIT')
    if (!preview.plan || preview.issues.length !== 0 || preview.canApply !== false
      || preview.tokenIssued !== false || preview.lookupExecuted !== false
      || preview.externalWriteAttempted !== false) fail('PLAN')
    // The preview associates every expanded row with its source row and allocated project.
    const origins = []
    for (const entry of preview.analysis) {
      for (const candidate of entry.candidates) origins[candidate.expandedIndex] = { sourceIndex: entry.sourceIndex, project: candidate.project }
    }
    if (origins.length !== preview.plan.rows.length || origins.some(origin => !origin)) fail('PLAN')
    return { plan: preview.plan, sourceRows: parseYidaStaticRows(rowsText, config), origins }
  } catch (error) {
    if (ownErrors.has(error)) throw error
    if ((error instanceof YidaStaticPlanError && ['YIDA_STATIC_TEXT_TOO_LARGE', 'YIDA_STATIC_ROWS_LIMIT'].includes(error.code))
      || (error instanceof YidaAllocationError && error.code === 'YIDA_ALLOCATION_ROWS_LIMIT')) fail('LIMIT')
    fail('PLAN')
  }
}

function text(value, max = 128) {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value || CONTROL.test(value)) fail('INPUT')
  return value
}

// Closed shape of the host-supplied binding. Every id is opaque text; aliases are planner identifiers; the
// key column must be one of the bound columns; records align one-to-one with the source rows.
function parseSourceBinding(value, sourceRows) {
  exactRecord(value, BINDING_KEYS)
  const sheetId = text(value.sheetId), keyFieldId = text(value.keyFieldId)
  if (!value.fieldBindings || typeof value.fieldBindings !== 'object' || Array.isArray(value.fieldBindings)) fail('INPUT')
  const fieldBindings = {}
  const fieldIds = new Set()
  for (const [alias, fieldId] of Object.entries(value.fieldBindings)) {
    if (!IDENTIFIER.test(alias) || fieldIds.has(text(fieldId))) fail('INPUT')
    fieldIds.add(fieldId)
    fieldBindings[alias] = fieldId
  }
  const keyAlias = Object.keys(fieldBindings).find(alias => fieldBindings[alias] === keyFieldId)
  if (keyAlias === undefined) fail('INPUT')
  if (!Array.isArray(value.records) || value.records.length !== sourceRows.length) fail('INPUT')
  const recordIds = new Set()
  const records = value.records.map((record, index) => {
    exactRecord(record, RECORD_KEYS)
    const recordId = text(record.recordId), keyValue = text(record.keyValue, MAX_KEY_VALUE_LENGTH), projectNo = text(record.projectNo)
    if (recordIds.has(recordId)) fail('INPUT')
    recordIds.add(recordId)
    // The key that enters the identity is the one the server read: it must be what the planner sees in
    // this row's key column, never a different value smuggled through rowsText.
    if (sourceRows[index][keyAlias] !== keyValue) fail('INPUT')
    return { recordId, keyValue, projectNo }
  })
  // One binding is one registered project sheet, and the registry (087) maps a sheet to exactly one project:
  // every record carries that project, so in `original` mode every row's identity project is the sheet's.
  // A binding whose records name different projects is not something the sheet source can produce.
  if (new Set(records.map(record => record.projectNo)).size !== 1) fail('INPUT')
  return { sheetId, keyFieldId, fieldBindings, records }
}

// Which real field ids each target field depends on: direct sources, copy primaries, concat parts, through
// the alias → field id map the server saved when it read the sheet. Targets that read no bound column are
// omitted (constants, columns outside the read).
function dependenciesByTarget(config, fieldBindings) {
  const result = {}
  for (const entry of config.fieldMap) {
    const ids = transformDependencies(entry, config).filter(column => Object.hasOwn(fieldBindings, column)).map(column => fieldBindings[column])
    if (ids.length) result[entry.target] = [...new Set(ids)].sort(compareCodePoints)
  }
  return result
}

// The two digests of design baseline v2.3 §3.3 / §7.2 for one planned row.
function bindRow(binding, origin, fieldDependencies) {
  const record = binding.records[origin.sourceIndex]
  const projectNo = origin.project === null ? record.projectNo : text(String(origin.project))
  const sourceBinding = { sheetId: binding.sheetId, recordId: record.recordId, keyFieldId: binding.keyFieldId,
    keyValue: record.keyValue, projectNo, fieldBindings: binding.fieldBindings, fieldDependencies }
  return {
    sourceBinding,
    sourceRecordDigest: hashCanonical({ version: 1, kind: 'yida-source-record', ...sourceBinding }),
    creationIdentityDigest: hashCanonical({ version: 1, kind: 'yida-creation-identity', keyValue: record.keyValue, projectNo }),
  }
}

function assertValidPlan(plan, intent) {
  if (plan.kind !== 'static_preview' || plan.status !== 'not_applyable'
    || plan.canApply !== false || plan.tokenIssued !== false || plan.lookupExecuted !== false
    || plan.externalWriteAttempted !== false || !Array.isArray(plan.rows) || plan.rows.length === 0) fail('PLAN')
  if (plan.rows.length > 100) fail('LIMIT')
  if (plan.evidence.rowCount !== plan.rows.length || plan.evidence.invalid !== 0
    || plan.evidence.duplicateKeyCount !== 0
    || plan.evidence.plannedCreate !== (intent === 'create' ? plan.rows.length : 0)
    || plan.evidence.plannedUpdate !== (intent === 'update' ? plan.rows.length : 0)) fail('PLAN')
  for (let index = 0; index < plan.rows.length; index += 1) {
    const row = plan.rows[index]
    // The form transport refuses an empty form after the durable claim; a row
    // with no sendable field must never become a draft that can be approved.
    if (row.index !== index || row.status !== `planned_${intent}` || row.remoteState !== 'unverified'
      || row.issues.length !== 0 || typeof row.localBusinessKey !== 'string' || !row.localBusinessKey
      || !row.payload || Object.keys(row.payload).length === 0
      || !row.protocolPreview || row.protocolPreview.contract !== 'dingtalk-yida-1.0-data-only'
      || row.protocolPreview.completeness !== 'data_fields_only') fail('PLAN')
  }
}

function compile(input, versions, persistent = false) {
  try {
    bounded(input, INPUT_BUDGET)
    const hasBinding = Boolean(input) && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'sourceBinding')
    exactRecord(input, hasBinding ? ['config', 'rowsText', 'allocation', 'sourceBinding'] : ['config', 'rowsText', 'allocation'])
    if (typeof input.rowsText !== 'string') fail('INPUT')
    const owned = deepCloneFrozenCanonical(input)
    if (!versions.includes(owned.config?.version)) fail('CONFIG')
    const checked = validateYidaStaticConfig(owned.config)
    if (!checked.valid) fail('CONFIG')
    const config = checked.normalized
    const allocation = owned.allocation
    if (allocation?.mode === 'original') exactRecord(allocation, ['mode'])
    else {
      exactRecord(allocation, ['mode', 'projects', 'projectField', 'quantityField'])
      if (!['equal_integer', 'equal_decimal_exact'].includes(allocation.mode)) fail('INPUT')
    }
    const { plan, sourceRows, origins } = compilePlan(config, owned.rowsText, allocation)
    assertValidPlan(plan, config.intent)
    const binding = hasBinding ? parseSourceBinding(owned.sourceBinding, sourceRows) : null
    // The persistent send entry refuses a generated field on an unbound row, whatever its template (addendum
    // 2026-11-06; row problem SOURCE_UNBOUND). A binding covers every row of a draft or none, so this is per draft.
    // The local recompute (compileYidaLocalDraft) needs no binding. This is an extra check, not the uniqueness
    // guarantee (v2.3 §3.3: the fences are).
    if (persistent && binding === null && config.fieldMap.some(entry => entry.transform === 'generated')) fail(ROW_PROBLEM.SOURCE_UNBOUND)
    const fieldDependencies = binding ? dependenciesByTarget(config, binding.fieldBindings) : null
    // The preset parts whose projectOf names the project the code is minted for (G1 makes it a key target).
    const presetParts = config.fieldMap.filter(entry => entry.transform === 'generated')
      .flatMap(entry => entry.template.filter(part => Object.hasOwn(part, 'preset')))
    const source = { config, rowsText: owned.rowsText, allocation, ...(hasBinding ? { sourceBinding: owned.sourceBinding } : {}) }
    const locator = config.target
    const locatorDigest = hashCanonical({ version: 1, kind: 'yida-local-locator', ...locator })
    const keyDefinition = {
      algorithm: 'yida-protocol-v2',
      // v2 names key parts by source column (one entry per column); v3 by primary target.
      // Both yield the same definition for the same layout, so the digests stay comparable.
      fields: config.businessKey.map(keyField => {
        const entry = config.version === 3
          ? config.fieldMap.find(field => field.transform === 'direct' && field.target === keyField)
          : config.fieldMap.find(field => field.source === keyField)
        return { target: entry.target, type: entry.type, empty: config.emptyKeyFields.includes(keyField) }
      }).sort((left, right) => compareCodePoints(left.target, right.target)),
    }
    const keyDefinitionDigest = hashCanonical(keyDefinition)
    // A bound row adds its two digests and its per-row binding (§7.2); an unbound row's spec is byte-identical
    // to the pre-binding shape, so every stored unbound plan_digest and every v2 golden stays as it was.
    const rowSpecs = plan.rows.map(row => {
      const bound = binding ? bindRow(binding, origins[row.index], fieldDependencies) : null
      // 「同码必同身份」: a bound row's material code is minted from its own project cell, so that cell must be the
      // project of the row's creation identity (the registry's project in original mode, the allocated one in a
      // split). Otherwise one identity could carry another project's code. Compared verbatim: both sides refuse
      // padding and control characters (the compiler's text(), the planner's identity text).
      if (bound && presetParts.some(part => row.payload[part.projectOf] !== bound.sourceBinding.projectNo)) {
        fail(ROW_PROBLEM.SOURCE_PROJECT_MISMATCH)
      }
      return {
        index: row.index,
        businessKeyDigest: hash(row.localBusinessKey),
        payloadDigest: hashCanonical({
          intent: config.intent, formUuid: locator.formUuid,
          data: { ...row.protocolPreview.data,
            [config.intent === 'create' ? 'formDataJson' : 'updateFormDataJson']: stableCanonicalStringify(row.payload) },
        }),
        ...(bound ?? {}),
      }
    })
    // R-71 ⑦.3 (B2): only a v3 plan carries the mapping marker, so the digest covers the mapping
    // version while every v2 digest input (and so every stored v2 plan_digest) stays byte-identical.
    // The key definition and row specs stay version-independent: a v3 draft of a v2 layout keeps
    // the slot's key definition and each row's business key digest (the create fence).
    // A bound row's entry also carries its two binding digests, so a re-read of the same records under
    // the same mapping reuses the operation while a changed binding is a new operation.
    const planDigest = hashCanonical({
      version: 1, kind: 'yida-local-plan', locator, keyDefinition, intent: config.intent,
      ...(config.version === 3 ? { mapping: 3 } : {}),
      rows: rowSpecs.map(({ businessKeyDigest, payloadDigest, sourceRecordDigest, creationIdentityDigest }) => ({
        businessKeyDigest, payloadDigest,
        ...(sourceRecordDigest === undefined ? {} : { sourceRecordDigest, creationIdentityDigest }),
      })).sort((left, right) => compareCodePoints(left.businessKeyDigest, right.businessKeyDigest)),
    })
    const result = { source, locator, locatorDigest, keyDefinition, keyDefinitionDigest, planDigest, plan, rowSpecs }
    bounded(result, OUTPUT_BUDGET)
    return deepCloneFrozenCanonical(result)
  } catch (error) {
    // Never preserve dependency errors, caller objects, or arbitrary messages.
    throw new YidaDraftPlanError(ownErrors.get(error) || 'INPUT')
  }
}

// Initialization (and target registration) compiles v2 only (R-71 ⑦.3 decision E1): the slot's
// sealed initialization draft is always a v2 layout.
export function compileYidaDraft(input) {
  return compile(input, [2])
}

// R-71 ⑦.3: the persistent send path (draft store, send authority, owner send port) compiles v2
// or v3. A v3 draft can only go to a target whose sealed key definition it matches exactly.
// It is the one entry that refuses a generated field on an unbound row (SOURCE_UNBOUND → PLAN).
export function compileYidaSendDraft(input) {
  return compile(input, [2, 3], true)
}

// The closed per-row binding shape a bound row spec carries (host re-authorization and write-back read it).
export const YIDA_SOURCE_BINDING_ROW_KEYS = Object.freeze([...PER_ROW_BINDING_KEYS])

// Same compiler for a local recompute that is never persisted: v2 or v3. It returns the
// identical shape (plan, key definition, row and plan digests) but nothing may store,
// approve or send it; it exists so host and browser results can be compared for one input.
export function compileYidaLocalDraft(input) {
  return compile(input, [2, 3])
}

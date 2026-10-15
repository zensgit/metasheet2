import { createHash } from 'node:crypto'
import { types } from 'node:util'
import canonical from './gip-canonical-json.cjs'
import { buildYidaStaticPlan, parseYidaStaticRows, validateYidaStaticConfig, YidaStaticPlanError } from './yida-static-plan.mjs'
import { buildYidaProjectAllocationPreview, YidaAllocationError } from './stock-preparation-yida-allocation.mjs'

// Pure, unregistered local draft compilation. Neither a locator nor a digest
// proves remote ownership, grants authority, or creates a delivery reservation.
const { stableCanonicalStringify, deepCloneFrozenCanonical } = canonical
const INPUT_BUDGET = Object.freeze({ bytes: 2 * 1024 * 1024, depth: 12, nodes: 20000 })
const OUTPUT_BUDGET = Object.freeze({ bytes: 4 * 1024 * 1024, depth: 16, nodes: 50000 })
const ERROR_KINDS = new Set(['INPUT', 'CONFIG', 'PLAN', 'LIMIT'])
const ownErrors = new WeakMap()

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

function compilePlan(config, rowsText, allocation) {
  try {
    if (allocation.mode === 'original') {
      return buildYidaStaticPlan({ config, rows: parseYidaStaticRows(rowsText, config) })
    }
    const preview = buildYidaProjectAllocationPreview({ config, rowsText, allocation })
    if (preview.issues.some(issue => ['EXPANDED_ROWS_LIMIT', 'EXPANDED_TEXT_LIMIT'].includes(issue.code))) fail('LIMIT')
    if (!preview.plan || preview.issues.length !== 0 || preview.canApply !== false
      || preview.tokenIssued !== false || preview.lookupExecuted !== false
      || preview.externalWriteAttempted !== false) fail('PLAN')
    return preview.plan
  } catch (error) {
    if (ownErrors.has(error)) throw error
    if ((error instanceof YidaStaticPlanError && ['YIDA_STATIC_TEXT_TOO_LARGE', 'YIDA_STATIC_ROWS_LIMIT'].includes(error.code))
      || (error instanceof YidaAllocationError && error.code === 'YIDA_ALLOCATION_ROWS_LIMIT')) fail('LIMIT')
    fail('PLAN')
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
    if (row.index !== index || row.status !== `planned_${intent}` || row.remoteState !== 'unverified'
      || row.issues.length !== 0 || typeof row.localBusinessKey !== 'string' || !row.localBusinessKey
      || !row.payload || !row.protocolPreview || row.protocolPreview.contract !== 'dingtalk-yida-1.0-data-only'
      || row.protocolPreview.completeness !== 'data_fields_only') fail('PLAN')
  }
}

export function compileYidaDraft(input) {
  try {
    bounded(input, INPUT_BUDGET)
    exactRecord(input, ['config', 'rowsText', 'allocation'])
    if (typeof input.rowsText !== 'string') fail('INPUT')
    const owned = deepCloneFrozenCanonical(input)
    if (owned.config?.version !== 2) fail('CONFIG')
    const checked = validateYidaStaticConfig(owned.config)
    if (!checked.valid) fail('CONFIG')
    const config = checked.normalized
    const allocation = owned.allocation
    if (allocation?.mode === 'original') exactRecord(allocation, ['mode'])
    else {
      exactRecord(allocation, ['mode', 'projects', 'projectField', 'quantityField'])
      if (!['equal_integer', 'equal_decimal_exact'].includes(allocation.mode)) fail('INPUT')
    }
    const plan = compilePlan(config, owned.rowsText, allocation)
    assertValidPlan(plan, config.intent)
    const source = { config, rowsText: owned.rowsText, allocation }
    const locator = config.target
    const locatorDigest = hashCanonical({ version: 1, kind: 'yida-local-locator', ...locator })
    const keyDefinition = {
      algorithm: 'yida-protocol-v2',
      fields: config.businessKey.map(sourceField => {
        const entry = config.fieldMap.find(field => field.source === sourceField)
        return { target: entry.target, type: entry.type, empty: config.emptyKeyFields.includes(sourceField) }
      }).sort((left, right) => compareCodePoints(left.target, right.target)),
    }
    const keyDefinitionDigest = hashCanonical(keyDefinition)
    const rowSpecs = plan.rows.map(row => ({
      index: row.index,
      businessKeyDigest: hash(row.localBusinessKey),
      payloadDigest: hashCanonical({
        intent: config.intent, formUuid: locator.formUuid,
        data: { ...row.protocolPreview.data,
          [config.intent === 'create' ? 'formDataJson' : 'updateFormDataJson']: stableCanonicalStringify(row.payload) },
      }),
    }))
    const planDigest = hashCanonical({
      version: 1, kind: 'yida-local-plan', locator, keyDefinition, intent: config.intent,
      rows: rowSpecs.map(({ businessKeyDigest, payloadDigest }) => ({ businessKeyDigest, payloadDigest }))
        .sort((left, right) => compareCodePoints(left.businessKeyDigest, right.businessKeyDigest)),
    })
    const result = { source, locator, locatorDigest, keyDefinition, keyDefinitionDigest, planDigest, plan, rowSpecs }
    bounded(result, OUTPUT_BUDGET)
    return deepCloneFrozenCanonical(result)
  } catch (error) {
    // Never preserve dependency errors, caller objects, or arbitrary messages.
    throw new YidaDraftPlanError(ownErrors.get(error) || 'INPUT')
  }
}

// Local YiDa form planning only. No transport, clock, persistence, or sender. The one import is the
// pure, import-free material-code leaf (pinned by __tests__/yida-static-plan.test.cjs).
// Target IDs and target field names are fictional/local metadata, not verified remote schema.
import { generateYidaMaterialCode, yidaMaterialCodeUuidV5 } from './yida-material-code.mjs'

const MAX_TEXT_BYTES = 128 * 1024
const MAX_ROWS = 100
const MAX_ROW_FIELDS = 64
const MAX_VALUE_LENGTH = 4096
const IDENTIFIER = /^[\p{L}\p{N}_-]{1,128}$/u
const FORBIDDEN_IDENTIFIER = /(?:__proto__|prototype|constructor|password|token|appkey|appsecret|systemtoken|authoritycode|credential|secret)/i
const CONFIG_KEYS = new Set(['version', 'kind', 'target', 'intent', 'businessKey', 'instanceIdField', 'fieldMap'])
const PROTOCOL_CONFIG_KEYS = new Set([...CONFIG_KEYS, 'fieldCatalog', 'emptyKeyFields'])
const TARGET_KEYS = new Set(['appType', 'formUuid'])
const MAP_KEYS = new Set(['source', 'target', 'type', 'required'])
const CATALOG_KEYS = new Set(['id', 'control', 'required', 'options'])
const TYPES = new Set(['string', 'number', 'boolean'])
const CONTROLS = new Set(['text', 'number', 'select', 'radio'])
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
// Same C0/DEL/C1 range the form transport refuses in every identifier it sends.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

export class YidaStaticPlanError extends Error {
  constructor(code) {
    super(code)
    this.name = 'YidaStaticPlanError'
    this.code = code
  }
}

// Descriptor reads avoid invoking unknown getters while validating caller-owned objects.
function dataObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !descriptors[key].enumerable
      || !Object.prototype.hasOwnProperty.call(descriptors[key], 'value')) return null
  }
  return descriptors
}

function dataArray(value, maxLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
  if (!Number.isInteger(length) || length > maxLength) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== length + 1) return null
  const result = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
    result.push(descriptor.value)
  }
  return result
}

function allowedKeys(descriptors, allowed) {
  return Object.keys(descriptors).every((key) => allowed.has(key))
}

function validIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !FORBIDDEN_IDENTIFIER.test(value)
}

// Targets are sent trimmed; the trimmed value must pass the transport's own
// identifier check, or an approved row would only fail after its claim.
function validTargetId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
    && !CONTROL.test(value.trim())
}

function configIssue(code, field) { return { code, field } }

function validateV1Config(input) {
  const issues = []
  const root = dataObject(input)
  if (!root) return { valid: false, issues: [configIssue('CONFIG_SHAPE_INVALID', '(root)')] }
  if (!allowedKeys(root, CONFIG_KEYS)) issues.push(configIssue('CONFIG_UNEXPECTED_FIELD', '(root)'))
  if (root.version?.value !== 1 || root.kind?.value !== 'yida-form-static') {
    issues.push(configIssue('CONFIG_KIND_INVALID', '(root)'))
  }
  const target = dataObject(root.target?.value)
  if (!target || !allowedKeys(target, TARGET_KEYS) || Object.keys(target).length !== 2
    || !validTargetId(target.appType?.value) || !validTargetId(target.formUuid?.value)) {
    issues.push(configIssue('CONFIG_TARGET_INVALID', 'target'))
  }
  const intent = root.intent?.value
  if (intent !== 'create' && intent !== 'update') issues.push(configIssue('CONFIG_INTENT_INVALID', 'intent'))
  const hasInstanceField = Object.prototype.hasOwnProperty.call(root, 'instanceIdField')
  if ((intent === 'update' && (!hasInstanceField || !validIdentifier(root.instanceIdField.value)))
    || (intent === 'create' && hasInstanceField)) {
    issues.push(configIssue('CONFIG_INSTANCE_ID_INVALID', 'instanceIdField'))
  }
  const rawMap = dataArray(root.fieldMap?.value, 32)
  const map = []
  if (!rawMap || rawMap.length < 1) {
    issues.push(configIssue('CONFIG_FIELD_MAP_INVALID', 'fieldMap'))
  } else {
    const targets = new Set()
    for (const entry of rawMap) {
      const fields = dataObject(entry)
      if (!fields || !allowedKeys(fields, MAP_KEYS) || Object.keys(fields).length !== 4
        || !validIdentifier(fields.source?.value) || !validIdentifier(fields.target?.value)
        || !TYPES.has(fields.type?.value) || typeof fields.required?.value !== 'boolean'
        || targets.has(fields.target?.value)) {
        issues.push(configIssue('CONFIG_FIELD_MAP_INVALID', 'fieldMap'))
        break
      }
      targets.add(fields.target.value)
      map.push({ source: fields.source.value, target: fields.target.value,
        type: fields.type.value, required: fields.required.value })
    }
  }
  const rawKeys = dataArray(root.businessKey?.value, 5)
  if (!rawKeys || rawKeys.length < 1 || new Set(rawKeys).size !== rawKeys.length
    || rawKeys.some((key) => !validIdentifier(key) || !map.some((entry) => entry.source === key))) {
    issues.push(configIssue('CONFIG_KEY_INVALID', 'businessKey'))
  }
  if (issues.length > 0) return { valid: false, issues }
  return { valid: true, normalized: {
    version: 1, kind: 'yida-form-static',
    target: { appType: target.appType.value.trim(), formUuid: target.formUuid.value.trim() },
    intent, businessKey: [...rawKeys],
    ...(intent === 'update' ? { instanceIdField: root.instanceIdField.value } : {}),
    fieldMap: map,
  } }
}

// Shared by v2 and v3: unknown root keys, target, intent and instance id, in this issue order.
function protocolHead(root, issues, version) {
  if (!allowedKeys(root, PROTOCOL_CONFIG_KEYS)) issues.push(configIssue('CONFIG_UNEXPECTED_FIELD', '(root)'))
  if (root.version?.value !== version || root.kind?.value !== 'yida-form-protocol-static') {
    issues.push(configIssue('CONFIG_KIND_INVALID', '(root)'))
  }
  const target = dataObject(root.target?.value)
  if (!target || !allowedKeys(target, TARGET_KEYS) || Object.keys(target).length !== 2
    || !validTargetId(target.appType?.value) || !validTargetId(target.formUuid?.value)) {
    issues.push(configIssue('CONFIG_TARGET_INVALID', 'target'))
  }
  const intent = root.intent?.value
  if (intent !== 'create' && intent !== 'update') issues.push(configIssue('CONFIG_INTENT_INVALID', 'intent'))
  const hasInstanceField = Object.prototype.hasOwnProperty.call(root, 'instanceIdField')
  if ((intent === 'update' && (!hasInstanceField || !validIdentifier(root.instanceIdField.value)))
    || (intent === 'create' && hasInstanceField)) {
    issues.push(configIssue('CONFIG_INSTANCE_ID_INVALID', 'instanceIdField'))
  }
  return { target, intent }
}

// Shared by v2 and v3: the explicit local field catalog.
function protocolCatalog(root, issues) {
  const rawCatalog = dataArray(root.fieldCatalog?.value, 32)
  const catalog = []
  if (!rawCatalog || rawCatalog.length < 1) {
    issues.push(configIssue('CONFIG_FIELD_CATALOG_INVALID', 'fieldCatalog'))
  } else {
    const ids = new Set()
    for (const item of rawCatalog) {
      const fields = dataObject(item)
      const id = fields?.id?.value
      const control = fields?.control?.value
      const required = fields?.required?.value
      const hasOptions = fields && Object.prototype.hasOwnProperty.call(fields, 'options')
      const rawOptions = hasOptions ? dataArray(fields.options.value, 64) : null
      const optionsValid = control === 'select' || control === 'radio'
        ? rawOptions && rawOptions.length >= 1 && new Set(rawOptions).size === rawOptions.length
          && rawOptions.every((option) => typeof option === 'string'
            && option.length <= 128 && option.trim().length > 0)
        : !hasOptions
      if (!fields || !allowedKeys(fields, CATALOG_KEYS)
        || Object.keys(fields).length !== (hasOptions ? 4 : 3)
        || !validIdentifier(id) || ids.has(id) || !CONTROLS.has(control)
        || typeof required !== 'boolean' || !optionsValid) {
        issues.push(configIssue('CONFIG_FIELD_CATALOG_INVALID', 'fieldCatalog'))
        break
      }
      ids.add(id)
      catalog.push({ id, control, required,
        ...((control === 'select' || control === 'radio') ? { options: [...rawOptions] } : {}) })
    }
  }
  return catalog
}

function validateProtocolConfig(root) {
  const issues = []
  const { target, intent } = protocolHead(root, issues, 2)
  const catalog = protocolCatalog(root, issues)

  const rawMap = dataArray(root.fieldMap?.value, 32)
  const map = []
  if (!rawMap || rawMap.length < 1) {
    issues.push(configIssue('CONFIG_FIELD_MAP_INVALID', 'fieldMap'))
  } else {
    const targets = new Set()
    const sources = new Set()
    for (const entry of rawMap) {
      const fields = dataObject(entry)
      const source = fields?.source?.value
      const mappedTarget = fields?.target?.value
      const type = fields?.type?.value
      const required = fields?.required?.value
      const control = catalog.find((item) => item.id === mappedTarget)
      if (!fields || !allowedKeys(fields, MAP_KEYS) || Object.keys(fields).length !== 4
        || !validIdentifier(source) || !validIdentifier(mappedTarget)
        || !TYPES.has(type) || typeof required !== 'boolean'
        || targets.has(mappedTarget) || sources.has(source) || !control
        || type !== (control.control === 'number' ? 'number' : 'string')) {
        issues.push(configIssue('CONFIG_FIELD_MAP_INVALID', 'fieldMap'))
        break
      }
      targets.add(mappedTarget)
      sources.add(source)
      map.push({ source, target: mappedTarget, type, required })
    }
  }
  if (catalog.some((item) => item.required
    && !map.some((entry) => entry.target === item.id && entry.required))) {
    issues.push(configIssue('CONFIG_FIELD_CATALOG_INVALID', 'fieldCatalog'))
  }

  const rawKeys = dataArray(root.businessKey?.value, 8)
  if (!rawKeys || rawKeys.length < 1 || new Set(rawKeys).size !== rawKeys.length
    || rawKeys.some((key) => !validIdentifier(key) || !map.some((entry) => entry.source === key))) {
    issues.push(configIssue('CONFIG_KEY_INVALID', 'businessKey'))
  }
  const rawEmptyKeys = dataArray(root.emptyKeyFields?.value, 8)
  if (!rawEmptyKeys || new Set(rawEmptyKeys).size !== rawEmptyKeys.length
    || rawEmptyKeys.some((key) => !rawKeys?.includes(key)
      || !map.some((entry) => entry.source === key && entry.type === 'string'
        && !entry.required && !catalog.find((item) => item.id === entry.target)?.required))) {
    issues.push(configIssue('CONFIG_EMPTY_KEY_FIELDS_INVALID', 'emptyKeyFields'))
  }
  if (issues.length > 0) return { valid: false, issues }
  return { valid: true, normalized: {
    version: 2, kind: 'yida-form-protocol-static',
    target: { appType: target.appType.value.trim(), formUuid: target.formUuid.value.trim() },
    intent, businessKey: [...rawKeys], emptyKeyFields: [...rawEmptyKeys],
    ...(intent === 'update' ? { instanceIdField: root.instanceIdField.value } : {}),
    fieldMap: map, fieldCatalog: catalog,
  } }
}

// v3: an explicit, closed set of mapping transforms. Lookups are not part of it: a value
// that needs another table is prepared upstream by an approved read and arrives as a column.
//   direct   - the one entry that binds a row column to a target (a column has at most one);
//   copy     - the value of a direct entry's column, written to a second target;
//   constant - a fixed value, checked against its own control when the config is validated;
//   concat   - parts in listed order (columns and literals) joined by one separator;
//   generated - a template of closed parts (literal / field / hash / preset), see below.
// The business key and emptyKeyFields name direct TARGETS, so each key part is bound to its
// primary entry by name; a derived target can never enter the key, and fieldMap order cannot
// change which entry a key part reads. Rows are evaluated and payloads built in field-catalog
// order, so reordering fieldMap changes neither the plan nor its data DTOs.
const TRANSFORM_ENTRY_KEYS = new Map([
  ['direct', ['transform', 'source', 'target', 'type', 'required']],
  ['copy', ['transform', 'copyOf', 'target', 'type', 'required']],
  ['constant', ['transform', 'value', 'target', 'type', 'required']],
  ['concat', ['transform', 'parts', 'separator', 'blank', 'target', 'type', 'required']],
  ['generated', ['transform', 'template', 'target', 'type', 'required']],
])
const CONCAT_BLANK_RULES = new Set(['skip', 'refuse'])
const MAX_CONCAT_PARTS = 8
const MAX_LITERAL_LENGTH = 128
const MAX_SEPARATOR_LENGTH = 16

// generated (R-71 ⑦.4 PR-2, owner addendum 2026-11-06 decision 1): a value composed after the
// project split from closed parts, each with an exact key list:
//   { literal }                          - plain text, 1..128 characters, no control characters;
//   { field: <direct target> }           - that column: text verbatim, a number as String(n);
//   { hash: [<direct targets>], form }   - UUIDv5 of the listed columns, upper case, 'uuid-36' or 'uuid-32';
//   { preset: 'material-code-v1', rowIdOf, projectOf } - the frozen WLBH- material code, byte for byte.
// Rule G1: exactly one identity part, a hash over every business-key target or the preset (whose
// projectOf is a key target), so one code always means one key tuple (hash) or one creation identity
// (preset); literal and field parts are decoration. A blank part is always refused; inside a hash a
// blank emptyKeyFields member counts as ''. Hash members and preset inputs are string-typed direct
// targets read verbatim. The value is evaluated per planned row, so split rows get their own codes,
// and two rows of one batch with one value are both refused (DUPLICATE_GENERATED_VALUE).
// FROZEN: the namespace, label, version and forms are part of every code; a change is a new version.
const MAX_TEMPLATE_PARTS = 8
const MAX_HASH_MEMBERS = 16
const HASH_FORMS = new Set(['uuid-36', 'uuid-32'])
const GENERATED_PRESET = 'material-code-v1'
// A random v4 UUID chosen once for this hash; not a secret. It keeps these codes apart from WLBH codes.
const GENERATED_HASH_NAMESPACE_V1 = 'de2dfbd7-8b3f-41a4-9322-8487ec85637f'
const GENERATED_HASH_LABEL = 'metasheet.stock-prep.yida-generated-hash'
const GENERATED_HASH_VERSION = 'v1'
const LONE_SURROGATE = /\p{Cs}/u
const encoder = new TextEncoder()

const hasPart = (part, key) => Object.prototype.hasOwnProperty.call(part, key)

function exactKeys(descriptors, keys) {
  return Object.keys(descriptors).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(descriptors, key))
}

function plainText(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength && value.trim().length > 0 && !CONTROL.test(value)
}

function concatParts(value) {
  const rawParts = dataArray(value, MAX_CONCAT_PARTS)
  if (!rawParts || rawParts.length < 2) return null
  const parts = []
  for (const rawPart of rawParts) {
    const part = dataObject(rawPart)
    if (part && exactKeys(part, ['source']) && validIdentifier(part.source.value)) parts.push({ source: part.source.value })
    else if (part && exactKeys(part, ['literal']) && plainText(part.literal.value, MAX_LITERAL_LENGTH)) {
      parts.push({ literal: part.literal.value })
    } else return null
  }
  return parts.some((part) => Object.prototype.hasOwnProperty.call(part, 'source')) ? parts : null
}

// Shape only; which targets the parts name, and G1, are checked once the whole map is known.
function generatedTemplate(value) {
  const rawParts = dataArray(value, MAX_TEMPLATE_PARTS)
  if (!rawParts || rawParts.length < 1) return null
  const parts = []
  for (const rawPart of rawParts) {
    const part = dataObject(rawPart)
    if (part && exactKeys(part, ['literal']) && plainText(part.literal.value, MAX_LITERAL_LENGTH)) {
      parts.push({ literal: part.literal.value })
    } else if (part && exactKeys(part, ['field']) && validIdentifier(part.field.value)) {
      parts.push({ field: part.field.value })
    } else if (part && exactKeys(part, ['hash', 'form']) && HASH_FORMS.has(part.form.value)) {
      const members = dataArray(part.hash.value, MAX_HASH_MEMBERS)
      if (!members || members.length < 1 || new Set(members).size !== members.length
        || !members.every((member) => validIdentifier(member))) return null
      parts.push({ hash: [...members], form: part.form.value })
    } else if (part && exactKeys(part, ['preset', 'rowIdOf', 'projectOf']) && part.preset.value === GENERATED_PRESET
      && validIdentifier(part.rowIdOf.value) && validIdentifier(part.projectOf.value)) {
      parts.push({ preset: GENERATED_PRESET, rowIdOf: part.rowIdOf.value, projectOf: part.projectOf.value })
    } else return null
  }
  return parts.some((part) => !hasPart(part, 'literal')) ? parts : null
}

// The direct targets a generated template reads, in part order (duplicates kept).
function generatedInputs(entry) {
  return entry.template.flatMap((part) => hasPart(part, 'field') ? [part.field]
    : hasPart(part, 'hash') ? part.hash : hasPart(part, 'preset') ? [part.rowIdOf, part.projectOf] : [])
}

// Every part names a direct primary (hash members and preset inputs a string one), and G1 holds.
function generatedTemplateValid(entry, primaries, businessKey) {
  const stringPrimary = (target) => primaries.get(target)?.type === 'string'
  let identities = 0
  for (const part of entry.template) {
    if (hasPart(part, 'field') && !primaries.has(part.field)) return false
    if (hasPart(part, 'hash')) {
      identities += 1
      if (!part.hash.every(stringPrimary) || !businessKey.every((key) => part.hash.includes(key))) return false
    }
    if (hasPart(part, 'preset')) {
      identities += 1
      if (!stringPrimary(part.rowIdOf) || !stringPrimary(part.projectOf) || !businessKey.includes(part.projectOf)) return false
    }
  }
  return identities === 1
}

function transformEntry(value, catalog) {
  const fields = dataObject(value)
  const keys = TRANSFORM_ENTRY_KEYS.get(fields?.transform?.value)
  if (!fields || !keys || !exactKeys(fields, keys)) return null
  const transform = fields.transform.value
  const target = fields.target.value
  const type = fields.type.value
  const required = fields.required.value
  const control = catalog.find((item) => item.id === target)
  if (!validIdentifier(target) || !control || typeof required !== 'boolean'
    || type !== (control.control === 'number' ? 'number' : 'string')) return null
  const options = control.control === 'select' || control.control === 'radio' ? control.options : null
  if (transform === 'direct') {
    return validIdentifier(fields.source.value)
      ? { transform, source: fields.source.value, target, type, required } : null
  }
  if (transform === 'copy') {
    return validIdentifier(fields.copyOf.value)
      ? { transform, copyOf: fields.copyOf.value, target, type, required } : null
  }
  if (transform === 'constant') {
    const constant = fields.value.value
    if (type === 'number' ? !validProtocolNumber(constant) : !plainText(constant, MAX_VALUE_LENGTH)) return null
    if (options && options.indexOf(constant) < 0) return null
    return { transform, value: constant, target, type, required }
  }
  if (transform === 'generated') {
    const template = generatedTemplate(fields.template.value)
    return control.control === 'text' && template ? { transform, template, target, type, required } : null
  }
  const parts = concatParts(fields.parts.value)
  const separator = fields.separator.value
  if (control.control !== 'text' || !parts || typeof separator !== 'string'
    || separator.length > MAX_SEPARATOR_LENGTH || CONTROL.test(separator)
    || !CONCAT_BLANK_RULES.has(fields.blank.value)) return null
  return { transform, parts, separator, blank: fields.blank.value, target, type, required }
}

function validateTransformConfig(root) {
  const issues = []
  const { target, intent } = protocolHead(root, issues, 3)
  const catalog = protocolCatalog(root, issues)

  const rawMap = dataArray(root.fieldMap?.value, 32)
  const map = []
  if (!rawMap || rawMap.length < 1) {
    issues.push(configIssue('CONFIG_FIELD_MAP_INVALID', 'fieldMap'))
  } else {
    const targets = new Set()
    const sources = new Set()
    for (const raw of rawMap) {
      const entry = transformEntry(raw, catalog)
      if (!entry || targets.has(entry.target) || (entry.transform === 'direct' && sources.has(entry.source))) {
        issues.push(configIssue('CONFIG_FIELD_MAP_INVALID', 'fieldMap'))
        break
      }
      targets.add(entry.target)
      if (entry.transform === 'direct') sources.add(entry.source)
      map.push(entry)
    }
    // A copy names a direct primary of the same type: no chains, no self-reference.
    if (map.length === rawMap.length && map.some((entry) => entry.transform === 'copy'
      && map.find((primary) => primary.transform === 'direct' && primary.target === entry.copyOf)?.type !== entry.type)) {
      issues.push(configIssue('CONFIG_FIELD_MAP_INVALID', 'fieldMap'))
    }
  }
  if (catalog.some((item) => item.required
    && !map.some((entry) => entry.target === item.id && entry.required))) {
    issues.push(configIssue('CONFIG_FIELD_CATALOG_INVALID', 'fieldCatalog'))
  }

  const primaries = new Map(map.filter((entry) => entry.transform === 'direct').map((entry) => [entry.target, entry]))
  const rawKeys = dataArray(root.businessKey?.value, 8)
  const keysValid = !(!rawKeys || rawKeys.length < 1 || new Set(rawKeys).size !== rawKeys.length
    || rawKeys.some((key) => !validIdentifier(key) || !primaries.has(key)))
  if (!keysValid) {
    issues.push(configIssue('CONFIG_KEY_INVALID', 'businessKey'))
  }
  const rawEmptyKeys = dataArray(root.emptyKeyFields?.value, 8)
  if (!rawEmptyKeys || new Set(rawEmptyKeys).size !== rawEmptyKeys.length
    || rawEmptyKeys.some((key) => !rawKeys?.includes(key) || primaries.get(key)?.type !== 'string'
      || primaries.get(key).required || catalog.find((item) => item.id === key)?.required)) {
    issues.push(configIssue('CONFIG_EMPTY_KEY_FIELDS_INVALID', 'emptyKeyFields'))
  }
  // generated needs the whole map and a valid key list: part targets and rule G1 (see above).
  if (rawMap && map.length === rawMap.length && keysValid && map.some((entry) => entry.transform === 'generated'
    && !generatedTemplateValid(entry, primaries, rawKeys))) {
    issues.push(configIssue('CONFIG_FIELD_MAP_INVALID', 'fieldMap'))
  }
  if (issues.length > 0) return { valid: false, issues }
  return { valid: true, normalized: {
    version: 3, kind: 'yida-form-protocol-static',
    target: { appType: target.appType.value.trim(), formUuid: target.formUuid.value.trim() },
    intent, businessKey: [...rawKeys], emptyKeyFields: [...rawEmptyKeys],
    ...(intent === 'update' ? { instanceIdField: root.instanceIdField.value } : {}),
    fieldMap: map, fieldCatalog: catalog,
  } }
}

export function validateYidaStaticConfig(input) {
  const root = dataObject(input)
  if (root?.version?.value === 3) return validateTransformConfig(root)
  return root?.version?.value === 2 ? validateProtocolConfig(root) : validateV1Config(input)
}

// R-71 ⑦.3: the closed v3 transform names, and for each one the row columns it reads. This is the
// ONE answer to "which columns does a v3 mapping read": the send path projects a selected row onto
// it (so unmapped source columns never enter a grant, a snapshot or the budget), and the owner panel
// lists it. A copy reads its direct primary's column, which that direct entry already declares.
// Adding a transform to TRANSFORM_ENTRY_KEYS without a reader here makes every v3 config refused
// below, and the transform-name tripwire test fails.
export const YIDA_TRANSFORM_NAMES = Object.freeze([...TRANSFORM_ENTRY_KEYS.keys()])
const TRANSFORM_SOURCE_COLUMNS = new Map([
  ['direct', (entry) => [entry.source]],
  ['copy', () => []],
  ['constant', () => []],
  ['concat', (entry) => entry.parts.filter((part) => Object.prototype.hasOwnProperty.call(part, 'source'))
    .map((part) => part.source)],
  ['generated', (entry, config) => generatedTemplateDependencies(entry, config)],
])

// R-71 ⑦.4: the row columns one generated entry of a valid v3 config reads: its field parts, hash
// members and preset inputs, each resolved through its direct target to that entry's source column.
// Sorted, de-duplicated, frozen. The entry must be the config's own generated entry for its target.
export function generatedTemplateDependencies(entry, config) {
  const validation = validateYidaStaticConfig(config)
  if (!validation.valid || validation.normalized.version !== 3) throw new YidaStaticPlanError('YIDA_STATIC_CONFIG_INVALID')
  const normalized = validation.normalized
  const parsed = transformEntry(entry, normalized.fieldCatalog)
  const own = parsed?.transform === 'generated'
    ? normalized.fieldMap.find((item) => item.target === parsed.target) : undefined
  if (!own || JSON.stringify(own) !== JSON.stringify(parsed)) throw new YidaStaticPlanError('YIDA_STATIC_CONFIG_INVALID')
  const columns = new Set(generatedInputs(own).map((target) => primaryEntry(normalized, target).source))
  return Object.freeze([...columns].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
}

export function yidaTransformSourceColumns(input) {
  const validation = validateYidaStaticConfig(input)
  if (!validation.valid || validation.normalized.version !== 3) throw new YidaStaticPlanError('YIDA_STATIC_CONFIG_INVALID')
  const columns = new Set()
  for (const entry of validation.normalized.fieldMap) {
    const reader = TRANSFORM_SOURCE_COLUMNS.get(entry.transform)
    if (!reader) throw new YidaStaticPlanError('YIDA_STATIC_CONFIG_INVALID')
    for (const column of reader(entry, validation.normalized)) columns.add(column)
  }
  return Object.freeze([...columns].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
}

function sanitizeRows(input) {
  if (!Array.isArray(input)) throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
  if (Object.getOwnPropertyDescriptor(input, 'length')?.value > MAX_ROWS) {
    throw new YidaStaticPlanError('YIDA_STATIC_ROWS_LIMIT')
  }
  const rowList = dataArray(input, MAX_ROWS)
  if (!rowList) throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
  const rows = []
  for (const inputRow of rowList) {
    const descriptors = dataObject(inputRow)
    if (!descriptors || Object.keys(descriptors).length > MAX_ROW_FIELDS) {
      throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
    }
    const row = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const value = descriptor.value
      if (!validIdentifier(key)
        || !(value === null || typeof value === 'boolean'
          || (typeof value === 'number' && Number.isFinite(value))
          || (typeof value === 'string' && value.length <= MAX_VALUE_LENGTH))) {
        throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
      }
      row[key] = value
    }
    rows.push(row)
  }
  // Only newly created records with primitive values reach serialization; no caller getter/toJSON runs.
  if (new TextEncoder().encode(JSON.stringify(rows)).length > MAX_TEXT_BYTES) {
    throw new YidaStaticPlanError('YIDA_STATIC_ROWS_LIMIT')
  }
  return rows
}

function decimalIdentity(token) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)
  if (!match) return null
  let digits = `${match[2]}${match[3] || ''}`.replace(/^0+/, '')
  if (!digits) return { negative: match[1] === '-', coefficient: '0', exponent: 0 }
  const exponentText = match[4] || '0'
  const exponentDigits = exponentText.replace(/^[+-]?0*/, '') || '0'
  if (exponentDigits.length > 6) return null
  const exponent = Number(exponentText)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > token.length + 400) return null
  let trailing = 0
  while (trailing < digits.length && digits[digits.length - trailing - 1] === '0') trailing += 1
  if (trailing) digits = digits.slice(0, -trailing)
  return { negative: match[1] === '-', coefficient: digits,
    exponent: exponent - (match[3]?.length || 0) + trailing }
}

function validProtocolNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && !Object.is(value, -0)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))
}

// JSON.parse and sanitizeRows own syntax/shape validation. This second scan is
// for every explicit config: decoded keys must be unique and numeric text must
// retain its decimal identity. Only v2 and v3 add their narrower protocol number domain.
function validateRowTokens(text, rows, version) {
  let offset = 0
  const whitespace = () => { while (offset < text.length && /\s/.test(text[offset])) offset += 1 }
  const expect = (character) => {
    whitespace()
    if (text[offset] !== character) throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
    offset += 1
  }
  const quoted = () => {
    whitespace()
    if (text[offset] !== '"') throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
    const start = offset++
    while (offset < text.length) {
      if (text[offset] === '\\') { offset += 2; continue }
      if (text[offset++] === '"') return text.slice(start, offset)
    }
    throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
  }
  const scalar = () => {
    whitespace()
    if (text[offset] === '"') return quoted()
    const start = offset
    while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset += 1
    if (start === offset) throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
    return text.slice(start, offset)
  }
  expect('[')
  whitespace()
  let rowIndex = 0
  while (text[offset] !== ']') {
    if (rowIndex > 0) expect(',')
    expect('{')
    whitespace()
    const seen = new Set()
    let first = true
    while (text[offset] !== '}') {
      if (!first) expect(',')
      const key = JSON.parse(quoted())
      if (seen.has(key)) throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
      seen.add(key)
      expect(':')
      const token = scalar()
      if (JSON_NUMBER.test(token)) {
        const raw = decimalIdentity(token)
        const value = rows[rowIndex]?.[key]
        const parsed = decimalIdentity(version === 1 && Object.is(value, -0) ? '-0' : String(value))
        if (!raw || !parsed || raw.negative !== parsed.negative
          || raw.coefficient !== parsed.coefficient || raw.exponent !== parsed.exponent
          || (version !== 1 && !validProtocolNumber(value))) {
          throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
        }
      }
      whitespace()
      first = false
    }
    expect('}')
    rowIndex += 1
    whitespace()
  }
  expect(']')
  whitespace()
  if (offset !== text.length || rowIndex !== rows.length) {
    throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')
  }
}

export function parseYidaStaticRows(text, config) {
  if (typeof text !== 'string') throw new YidaStaticPlanError('YIDA_STATIC_TEXT_INVALID')
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    throw new YidaStaticPlanError('YIDA_STATIC_TEXT_TOO_LARGE')
  }
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new YidaStaticPlanError('YIDA_STATIC_TEXT_INVALID') }
  const rows = sanitizeRows(parsed)
  if (config !== undefined) {
    const validation = validateYidaStaticConfig(config)
    if (!validation.valid) throw new YidaStaticPlanError('YIDA_STATIC_CONFIG_INVALID')
    validateRowTokens(text, rows, validation.normalized.version)
  }
  return rows
}

function missing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function rowIssue(index, code, entries) {
  return { index, code, ...(entries ? { fields: entries.map((entry) => ({
    source: entry.source, target: entry.target, type: entry.type,
  })) } : {}) }
}

function ownValue(row, field) {
  return Object.prototype.hasOwnProperty.call(row, field) ? row[field] : undefined
}

// v3 rows. A copy reads its primary's column; constants are already validated values.
function primaryEntry(config, target) {
  return config.fieldMap.find((entry) => entry.transform === 'direct' && entry.target === target)
}

function catalogOrderedEntries(config) {
  const byTarget = new Map(config.fieldMap.map((entry) => [entry.target, entry]))
  return config.fieldCatalog.map((item) => byTarget.get(item.id)).filter((entry) => entry !== undefined)
}

function transformIssue(config, index, code, entries) {
  return { index, code, fields: entries.map((entry) => {
    const source = entry.transform === 'direct' ? entry.source
      : entry.transform === 'copy' ? primaryEntry(config, entry.copyOf).source : undefined
    return { ...(source !== undefined ? { source } : {}), target: entry.target, type: entry.type, transform: entry.transform }
  }) }
}

// Explicit concat: parts in listed order; a column part that is absent, null or blank text
// is a blank part; text is used verbatim, a number as String(number), a boolean is refused.
// 'skip' drops blank parts (and so their separators); 'refuse' refuses a partly blank value.
// When every column part is blank the value is missing: literals alone never make one.
function concatValue(entry, row) {
  const pieces = []
  let columns = 0
  let blanks = 0
  for (const part of entry.parts) {
    if (!Object.prototype.hasOwnProperty.call(part, 'source')) { pieces.push(part.literal); continue }
    columns += 1
    const raw = ownValue(row, part.source)
    if (missing(raw)) { blanks += 1; continue }
    if (typeof raw === 'string') pieces.push(raw)
    else if (typeof raw === 'number') pieces.push(String(raw))
    else return { code: 'FIELD_TYPE' }
  }
  if (blanks === columns) return { value: undefined }
  if (blanks > 0 && entry.blank === 'refuse') return { code: 'FIELD_PART_MISSING' }
  const value = pieces.join(entry.separator)
  return value.length > MAX_VALUE_LENGTH ? { code: 'FIELD_VALUE_TOO_LONG' } : { value }
}

// Identity text (hash members, preset inputs) is used verbatim: no trim, no normalization. Text a
// UTF-8 name cannot carry exactly (a lone surrogate) or that reads as another value (padding,
// control characters) is refused instead.
function identityText(value) {
  return typeof value === 'string' && value.trim() === value && !CONTROL.test(value) && !LONE_SURROGATE.test(value)
}

// Parts in listed order, no implicit separator. Every input is read from the row through its direct
// target (never from the payload), so catalog order cannot change a value. A blank required key part
// is already KEY_MISSING, so a template reading one adds no issue of its own.
function generatedValue(config, entry, row) {
  const read = (target) => ownValue(row, primaryEntry(config, target).source)
  const keyTargets = new Set(config.businessKey)
  if (generatedInputs(entry).some((target) => keyTargets.has(target) && keyMissing(config, row, target))) {
    return { keyMissing: true }
  }
  const emptyKeys = new Set(config.emptyKeyFields)
  const pieces = []
  for (const part of entry.template) {
    if (hasPart(part, 'literal')) { pieces.push(part.literal); continue }
    if (hasPart(part, 'field')) {
      const raw = read(part.field)
      if (missing(raw)) return { code: 'FIELD_PART_MISSING' }
      if (typeof raw === 'string') pieces.push(raw)
      else if (typeof raw === 'number') pieces.push(String(raw))
      else return { code: 'FIELD_TYPE' }
      continue
    }
    if (hasPart(part, 'hash')) {
      const values = []
      for (const target of part.hash) {
        const raw = read(target)
        if (emptyKeys.has(target) && (raw === undefined || raw === null || raw === '')) { values.push(''); continue }
        if (missing(raw)) return { code: 'FIELD_PART_MISSING' }
        if (!identityText(raw)) return { code: 'FIELD_TYPE' }
        values.push(raw)
      }
      const name = encoder.encode(JSON.stringify([GENERATED_HASH_LABEL, GENERATED_HASH_VERSION, ...values]))
      const uuid = yidaMaterialCodeUuidV5(GENERATED_HASH_NAMESPACE_V1, name).toUpperCase()
      pieces.push(part.form === 'uuid-32' ? uuid.replaceAll('-', '') : uuid)
      continue
    }
    const keyValue = read(part.rowIdOf)
    const projectNo = read(part.projectOf)
    if (missing(keyValue) || missing(projectNo)) return { code: 'FIELD_PART_MISSING' }
    if (!identityText(keyValue) || !identityText(projectNo)) return { code: 'FIELD_TYPE' }
    try {
      pieces.push(generateYidaMaterialCode({ keyValue, projectNo }))
    } catch (error) {
      if (error?.name === 'YidaMaterialCodeError') return { code: 'FIELD_TYPE' }
      throw error
    }
  }
  const value = pieces.join('')
  return value.length > MAX_VALUE_LENGTH ? { code: 'FIELD_VALUE_TOO_LONG' } : { value }
}

function transformValue(config, entry, row) {
  if (entry.transform === 'direct') return { value: ownValue(row, entry.source) }
  if (entry.transform === 'copy') return { value: ownValue(row, primaryEntry(config, entry.copyOf).source) }
  if (entry.transform === 'constant') return { value: entry.value }
  if (entry.transform === 'generated') return generatedValue(config, entry, row)
  return concatValue(entry, row)
}

function planTransformFields(config, row, index, issues, payload, generated) {
  const keyTargets = new Set(config.businessKey)
  for (const entry of catalogOrderedEntries(config)) {
    const result = transformValue(config, entry, row)
    if (result.keyMissing) continue
    if (result.code) {
      issues.push(transformIssue(config, index, result.code, [entry]))
      continue
    }
    const value = result.value
    if (missing(value)) {
      // A missing key part is already KEY_MISSING; a copy of it is its own required field.
      if (entry.required && !(entry.transform === 'direct' && keyTargets.has(entry.target))) {
        issues.push(transformIssue(config, index, 'FIELD_REQUIRED', [entry]))
      }
      continue
    }
    if (entry.type !== typeof value) {
      issues.push(transformIssue(config, index, 'FIELD_TYPE', [entry]))
      continue
    }
    const control = config.fieldCatalog.find((item) => item.id === entry.target)
    if (control.control === 'number' && !validProtocolNumber(value)) {
      issues.push(transformIssue(config, index, 'FIELD_NUMBER_INVALID', [entry]))
      continue
    }
    if ((control.control === 'select' || control.control === 'radio') && control.options.indexOf(value) < 0) {
      issues.push(transformIssue(config, index, 'FIELD_OPTION_INVALID', [entry]))
      continue
    }
    payload[entry.target] = value
    if (entry.transform === 'generated') generated.push([entry, value])
  }
}

const byFirstElement = (left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)

// Same key algorithm and label as v2, so a v2 layout restated as v3 keeps every row identity
// already reserved by the delivery fence. Only the binding differs: by primary target name.
function transformBusinessKey(config, row) {
  const emptyKeys = new Set(config.emptyKeyFields)
  const pairs = config.businessKey.map((target) => {
    const raw = ownValue(row, primaryEntry(config, target).source)
    const value = emptyKeys.has(target) && (raw === undefined || raw === null || raw === '') ? '' : raw
    return [target, typeof value, value]
  })
  pairs.sort(byFirstElement)
  return JSON.stringify(['yida-protocol-v2', config.target.appType, config.target.formUuid, pairs])
}

function localBusinessKey(config, row) {
  if (config.version === 3) return transformBusinessKey(config, row)
  if (config.version === 2) {
    const emptyKeys = new Set(config.emptyKeyFields)
    const pairs = config.businessKey.map((source) => {
      const target = config.fieldMap.find((entry) => entry.source === source).target
      const raw = ownValue(row, source)
      const value = emptyKeys.has(source) && (raw === undefined || raw === null || raw === '') ? '' : raw
      return [target, typeof value, value]
    }).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
    return JSON.stringify(['yida-protocol-v2', config.target.appType, config.target.formUuid, pairs])
  }
  const pairs = [...config.businessKey].sort().map((key) => [key, typeof ownValue(row, key), ownValue(row, key)])
  return JSON.stringify([config.target.appType, config.target.formUuid, pairs])
}

function keyMissing(config, row, key) {
  if (config.version === 3) {
    const keyValue = ownValue(row, primaryEntry(config, key).source)
    return config.emptyKeyFields.includes(key)
      ? typeof keyValue === 'string' && keyValue !== '' && keyValue.trim() === ''
      : missing(keyValue)
  }
  const value = ownValue(row, key)
  if (config.version === 2 && config.emptyKeyFields.includes(key)) {
    return typeof value === 'string' && value !== '' && value.trim() === ''
  }
  return missing(value)
}

function protocolPreview(config, planned) {
  const formDataJson = JSON.stringify(planned.payload)
  return {
    contract: 'dingtalk-yida-1.0-data-only', completeness: 'data_fields_only',
    data: config.intent === 'create'
      ? { appType: config.target.appType, formUuid: config.target.formUuid, formDataJson }
      : { appType: config.target.appType, formInstanceId: planned.instanceId,
        updateFormDataJson: formDataJson },
  }
}

export function buildYidaStaticPlan(input) {
  const top = dataObject(input)
  if (!top || !allowedKeys(top, new Set(['config', 'rows'])) || Object.keys(top).length !== 2) {
    throw new YidaStaticPlanError('YIDA_STATIC_INPUT_INVALID')
  }
  const validation = validateYidaStaticConfig(top.config.value)
  if (!validation.valid) throw new YidaStaticPlanError('YIDA_STATIC_CONFIG_INVALID')
  const config = validation.normalized
  const inputRows = sanitizeRows(top.rows.value)
  const plannedRows = []
  const keyGroups = new Map()
  const generatedGroups = new Map()
  const keyFields = new Set(config.businessKey)
  for (let index = 0; index < inputRows.length; index += 1) {
    const row = inputRows[index]
    const issues = []
    const missingKeys = new Set(config.businessKey.filter((key) => keyMissing(config, row, key)))
    const hasMissingKey = missingKeys.size > 0
    if (hasMissingKey) issues.push(config.version === 3
      ? transformIssue(config, index, 'KEY_MISSING', catalogOrderedEntries(config)
        .filter((entry) => entry.transform === 'direct' && missingKeys.has(entry.target)))
      : rowIssue(index, 'KEY_MISSING',
        config.fieldMap.filter((entry) => missingKeys.has(entry.source))))
    const key = hasMissingKey ? undefined : localBusinessKey(config, row)
    if (key !== undefined) {
      const group = keyGroups.get(key) || []
      group.push(index)
      keyGroups.set(key, group)
    }
    const payload = {}
    if (config.version === 3) {
      const generated = []
      planTransformFields(config, row, index, issues, payload, generated)
      for (const [entry, value] of generated) {
        const groupKey = JSON.stringify([entry.target, value])
        const group = generatedGroups.get(groupKey) || { entry, indexes: [] }
        group.indexes.push(index)
        generatedGroups.set(groupKey, group)
      }
    } else for (const entry of config.fieldMap) {
      const value = ownValue(row, entry.source)
      if (missing(value)) {
        if (entry.required && !keyFields.has(entry.source)) issues.push(rowIssue(index, 'FIELD_REQUIRED', [entry]))
        continue
      }
      if (typeof value !== entry.type) {
        issues.push(rowIssue(index, 'FIELD_TYPE', [entry]))
        continue
      }
      if (config.version === 2) {
        const control = config.fieldCatalog.find((item) => item.id === entry.target)
        if (control.control === 'number' && !validProtocolNumber(value)) {
          issues.push(rowIssue(index, 'FIELD_NUMBER_INVALID', [entry]))
          continue
        }
        if ((control.control === 'select' || control.control === 'radio')
          && !control.options.includes(value)) {
          issues.push(rowIssue(index, 'FIELD_OPTION_INVALID', [entry]))
          continue
        }
      }
      payload[entry.target] = value
    }
    let instanceId
    if (config.intent === 'update') {
      const supplied = ownValue(row, config.instanceIdField)
      // Instance IDs are sent untrimmed, so padding is refused like the transport does.
      if (typeof supplied !== 'string' || !validTargetId(supplied) || supplied.trim() !== supplied) {
        issues.push(rowIssue(index, 'INSTANCE_ID_MISSING'))
      } else instanceId = supplied
    }
    plannedRows.push({
      index, status: issues.length ? 'invalid' : config.intent === 'create' ? 'planned_create' : 'planned_update',
      remoteState: 'unverified',
      ...(key !== undefined ? { localBusinessKey: key } : {}),
      ...(issues.length ? {} : { payload, ...(instanceId !== undefined ? { instanceId } : {}) }),
      issues,
    })
  }
  let duplicateKeyCount = 0
  for (const group of keyGroups.values()) {
    if (group.length < 2) continue
    duplicateKeyCount += group.length
    for (const index of group) {
      const planned = plannedRows[index]
      planned.issues.push(rowIssue(index, 'DUPLICATE_LOCAL_KEY'))
      planned.status = 'invalid'
      delete planned.payload
      delete planned.instanceId
    }
  }
  // Like the key groups (every row that produced the value, whatever its other issues): one
  // generated value on two rows of one batch refuses both, so a draft never sends one code twice.
  for (const { entry, indexes } of generatedGroups.values()) {
    if (indexes.length < 2) continue
    for (const index of indexes) {
      const planned = plannedRows[index]
      planned.issues.push(transformIssue(config, index, 'DUPLICATE_GENERATED_VALUE', [entry]))
      planned.status = 'invalid'
      delete planned.payload
      delete planned.instanceId
    }
  }
  if (config.version !== 1) {
    for (const planned of plannedRows) {
      if (planned.status !== 'invalid') planned.protocolPreview = protocolPreview(config, planned)
    }
  }
  const plannedCreate = plannedRows.filter((row) => row.status === 'planned_create').length
  const plannedUpdate = plannedRows.filter((row) => row.status === 'planned_update').length
  return {
    kind: 'static_preview', status: 'not_applyable', canApply: false, tokenIssued: false,
    lookupExecuted: false, externalWriteAttempted: false, rows: plannedRows,
    evidence: { rowCount: plannedRows.length, plannedCreate, plannedUpdate,
      invalid: plannedRows.length - plannedCreate - plannedUpdate, duplicateKeyCount },
  }
}

export function createYidaStaticExample(variant = 'primary') {
  if (variant !== 'primary' && variant !== 'renamed') {
    throw new YidaStaticPlanError('YIDA_STATIC_EXAMPLE_INVALID')
  }
  const target = { appType: 'synthetic_stock_app', formUuid: 'synthetic_stock_form' }
  // Target field IDs are fictional placeholders, not verified YiDa controls.
  const config = variant === 'primary'
    ? {
      version: 1, kind: 'yida-form-static', target, intent: 'create',
      businessKey: ['projectNo', 'sourceRowId'],
      fieldMap: [
        { source: 'projectNo', target: 'project', type: 'string', required: true },
        { source: 'sourceRowId', target: 'line', type: 'string', required: true },
        { source: 'componentCode', target: 'component', type: 'string', required: true },
        { source: 'quantity', target: 'qty', type: 'number', required: false },
        { source: 'active', target: 'enabled', type: 'boolean', required: true },
      ],
    }
    : {
      version: 1, kind: 'yida-form-static', target, intent: 'create',
      businessKey: ['项目号', '明细标识'],
      fieldMap: [
        { source: '项目号', target: 'project', type: 'string', required: true },
        { source: '明细标识', target: 'line', type: 'string', required: true },
        { source: '物料编号', target: 'component', type: 'string', required: true },
        { source: '件数', target: 'qty', type: 'number', required: false },
        { source: '启用', target: 'enabled', type: 'boolean', required: true },
      ],
    }
  const rows = variant === 'primary'
    ? [
      { projectNo: 'DEMO-P1', sourceRowId: 'LINE-1', componentCode: 'DEMO-PART-A', quantity: 2, active: true },
      { projectNo: 'DEMO-P1', sourceRowId: 'LINE-2', componentCode: 'DEMO-PART-A', quantity: 0, active: false },
    ]
    : [
      { 项目号: 'DEMO-P1', 明细标识: 'LINE-1', 物料编号: 'DEMO-PART-A', 件数: 2, 启用: true },
      { 项目号: 'DEMO-P1', 明细标识: 'LINE-2', 物料编号: 'DEMO-PART-A', 件数: 0, 启用: false },
    ]
  return { config, rows, text: JSON.stringify(rows, null, 2) }
}

export function createYidaProtocolExample(variant = 'primary') {
  if (variant !== 'primary' && variant !== 'renamed') {
    throw new YidaStaticPlanError('YIDA_STATIC_EXAMPLE_INVALID')
  }
  const sources = variant === 'primary'
    ? ['projectNo', 'componentCode', 'componentName', 'specification', 'material',
      'version', 'parentCode', 'quantity', 'priority']
    : ['项目号', '物料编号', '物料名称', '规格', '材质', '版本', '父图号', '件数', '优先级']
  const targets = ['project', 'componentCode', 'componentName', 'specification',
    'material', 'version', 'parentCode', 'qty', 'priority']
  const fieldCatalog = targets.map((id, index) => ({ id,
    control: index === 7 ? 'number' : index === 8 ? 'select' : 'text',
    required: index < 6 || index === 7,
    ...(index === 8 ? { options: ['normal', 'rush'] } : {}),
  }))
  const config = {
    version: 2, kind: 'yida-form-protocol-static',
    target: { appType: 'synthetic_stock_app', formUuid: 'synthetic_stock_form' },
    intent: 'create', businessKey: sources.slice(0, 7), emptyKeyFields: [sources[6]],
    fieldCatalog,
    fieldMap: sources.map((source, index) => ({ source, target: targets[index],
      type: index === 7 ? 'number' : 'string',
      required: index < 6 || index === 7 })),
  }
  const common = ['DEMO-P1', 'DEMO-PART-A', '示例物料', 'SPEC-1', 'MAT-1', 'V1']
  const values = [
    [...common, null, 0, 'normal'],
    [...common, 'PARENT-1', 3, 'rush'],
  ]
  const rows = values.map((row) => Object.fromEntries(sources.map((source, index) => [source, row[index]])))
  return { config, rows, text: JSON.stringify(rows, null, 2) }
}

// Synthetic v3 layout shaped like the legacy stock-prep material form (see the 2026-11-03
// normalization doc): neutral placeholder field IDs, placeholder constants, no real values.
// Lookup-derived fields (the project-level spec) are left out: they come from an approved read.
export function createYidaTransformExample() {
  const text = (id, required = false) => ({ id, control: 'text', required })
  const direct = (source, target, required, type = 'string') => ({ transform: 'direct', source, target, type, required })
  const config = {
    version: 3, kind: 'yida-form-protocol-static',
    target: { appType: 'synthetic_stock_app', formUuid: 'synthetic_material_form' },
    intent: 'create',
    businessKey: ['project', 'drawingNo', 'partName', 'specification', 'materialGrade', 'versionNo', 'parentDrawingNo'],
    emptyKeyFields: ['specification', 'parentDrawingNo'],
    fieldCatalog: [
      text('project', true), text('drawingNo', true), text('partName', true), text('specification'),
      text('materialGrade', true), text('versionNo', true), text('parentDrawingNo'), text('parentPartName'),
      text('partCategory'), { id: 'totalQty', control: 'number', required: true }, text('blankSize'),
      text('materialTypeText'),
      { id: 'processRule', control: 'select', required: true, options: ['SYN-RULE-A', 'SYN-RULE-B'] },
      { id: 'allowNegativeStock', control: 'radio', required: true, options: ['SYN-YES', 'SYN-NO'] },
      text('defaultText'), text('sourceLineId', true), text('materialCodeText'),
    ],
    fieldMap: [
      direct('projectNo', 'project', true),
      direct('componentCode', 'drawingNo', true),
      direct('componentName', 'partName', true),
      direct('componentSpec', 'specification', false),
      direct('material', 'materialGrade', true),
      direct('sourceVersion', 'versionNo', true),
      direct('parentComponentCode', 'parentDrawingNo', false),
      direct('parentComponentName', 'parentPartName', false),
      { transform: 'copy', copyOf: 'parentPartName', target: 'partCategory', type: 'string', required: false },
      direct('totalQuantity', 'totalQty', true, 'number'),
      { transform: 'concat', parts: [{ source: 'ext_blankLength' }, { source: 'ext_blankWidth' }, { source: 'ext_blankThickness' }],
        separator: '*', blank: 'refuse', target: 'blankSize', type: 'string', required: false },
      direct('blankType', 'materialTypeText', false),
      { transform: 'constant', value: 'SYN-RULE-A', target: 'processRule', type: 'string', required: true },
      { transform: 'constant', value: 'SYN-NO', target: 'allowNegativeStock', type: 'string', required: true },
      { transform: 'constant', value: 'SYN-DEFAULT', target: 'defaultText', type: 'string', required: false },
      direct('idempotencyKey', 'sourceLineId', true),
      // R-71 ②: the default material template, one preset part. Never on a target named materialCode.
      { transform: 'generated', template: [{ preset: 'material-code-v1', rowIdOf: 'sourceLineId', projectOf: 'project' }],
        target: 'materialCodeText', type: 'string', required: true },
    ],
  }
  const rows = [
    { projectNo: 'DEMO-P1', componentCode: 'DEMO-DRW-1', componentName: '示例部件', componentSpec: 'SPEC-1',
      material: 'MAT-1', sourceVersion: 'V1', parentComponentCode: null, parentComponentName: null,
      totalQuantity: 4, ext_blankLength: 1200, ext_blankWidth: 600, ext_blankThickness: 20,
      blankType: 'SYN-BLANK', idempotencyKey: 'SYN-LINE-1' },
    { projectNo: 'DEMO-P1', componentCode: 'DEMO-DRW-2', componentName: '示例子件', componentSpec: '',
      material: 'MAT-2', sourceVersion: 'V1', parentComponentCode: 'DEMO-DRW-1', parentComponentName: '示例部件',
      totalQuantity: 6, ext_blankLength: null, ext_blankWidth: null, ext_blankThickness: null,
      blankType: null, idempotencyKey: 'SYN-LINE-2' },
  ]
  const allocation = { mode: 'equal_integer', projectField: 'projectNo', quantityField: 'totalQuantity' }
  return { config, rows, text: JSON.stringify(rows, null, 2), allocation }
}

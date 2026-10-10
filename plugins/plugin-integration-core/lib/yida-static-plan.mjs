// Local YiDa form planning only. No imports, transport, clock, persistence, or sender.
// Target IDs and target field names are fictional/local metadata, not verified remote schema.
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

function validTargetId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
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

function validateProtocolConfig(root) {
  const issues = []
  if (!allowedKeys(root, PROTOCOL_CONFIG_KEYS)) issues.push(configIssue('CONFIG_UNEXPECTED_FIELD', '(root)'))
  if (root.version?.value !== 2 || root.kind?.value !== 'yida-form-protocol-static') {
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

export function validateYidaStaticConfig(input) {
  const root = dataObject(input)
  return root?.version?.value === 2 ? validateProtocolConfig(root) : validateV1Config(input)
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
// retain its decimal identity. Only v2 adds its narrower protocol number domain.
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
          || (version === 2 && !validProtocolNumber(value))) {
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

function localBusinessKey(config, row) {
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
  const keyFields = new Set(config.businessKey)
  for (let index = 0; index < inputRows.length; index += 1) {
    const row = inputRows[index]
    const issues = []
    const missingKeys = new Set(config.businessKey.filter((key) => keyMissing(config, row, key)))
    const hasMissingKey = missingKeys.size > 0
    if (hasMissingKey) issues.push(rowIssue(index, 'KEY_MISSING',
      config.fieldMap.filter((entry) => missingKeys.has(entry.source))))
    const key = hasMissingKey ? undefined : localBusinessKey(config, row)
    if (key !== undefined) {
      const group = keyGroups.get(key) || []
      group.push(index)
      keyGroups.set(key, group)
    }
    const payload = {}
    for (const entry of config.fieldMap) {
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
      if (typeof supplied !== 'string' || !validTargetId(supplied)) {
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
  if (config.version === 2) {
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

// Local, structure-only compiler for the seven order-module source roles. Its output is a
// reviewable draft; no connection, approval, execution, or persistence capability lives here.

export const SOURCE_PLAN_DRAFT_SECTIONS = [
  {
    key: 'pathExAttr', zh: '项目路径关联', en: 'Project path link', fields: [
      { key: 'object', zh: '来源表', en: 'Source object', required: true, kind: 'object' },
      { key: 'matchField', zh: '项目号列', en: 'Project number field', required: true, kind: 'field' },
      { key: 'pathIdField', zh: '路径 ID 列', en: 'Path ID field', required: true, kind: 'field' },
    ],
  },
  {
    key: 'pathInfo', zh: '路径信息', en: 'Path information', fields: [
      { key: 'object', zh: '来源表', en: 'Source object', required: true, kind: 'object' },
      { key: 'idField', zh: '路径 ID 列', en: 'Path ID field', required: true, kind: 'field' },
    ],
  },
  {
    key: 'orderHead', zh: '订单头', en: 'Order header', fields: [
      { key: 'object', zh: '来源表', en: 'Source object', required: true, kind: 'object' },
      { key: 'idField', zh: '订单 ID 列', en: 'Order ID field', required: true, kind: 'field' },
      { key: 'pathIdField', zh: '路径 ID 列', en: 'Path ID field', required: true, kind: 'field' },
    ],
  },
  {
    key: 'orderDetail', zh: '订单明细', en: 'Order detail', fields: [
      { key: 'object', zh: '来源表', en: 'Source object', required: true, kind: 'object' },
      { key: 'orderIdField', zh: '订单 ID 列', en: 'Order ID field', required: true, kind: 'field' },
      { key: 'componentIdField', zh: '部件 ID 列', en: 'Component ID field', required: true, kind: 'field' },
      { key: 'quantityField', zh: '数量列', en: 'Quantity field', required: true, kind: 'field' },
      { key: 'sortField', zh: '排序列', en: 'Sort field', required: false, kind: 'field' },
      { key: 'versionField', zh: '订单指定 BOM 版本列', en: 'Order BOM version field', required: false, kind: 'field' },
    ],
  },
  {
    key: 'part', zh: '物料', en: 'Part', fields: [
      { key: 'object', zh: '来源表', en: 'Source object', required: true, kind: 'object' },
      { key: 'idField', zh: '物料 ID 列', en: 'Part ID field', required: true, kind: 'field' },
      { key: 'codeField', zh: '图号列', en: 'Part code field', required: false, kind: 'field' },
      { key: 'nameField', zh: '名称列', en: 'Part name field', required: false, kind: 'field' },
      { key: 'materialField', zh: '材质列', en: 'Material field', required: false, kind: 'field' },
      { key: 'versionField', zh: '物料版本列', en: 'Part version field', required: false, kind: 'field' },
      { key: 'specField', zh: '规格列', en: 'Specification field', required: false, kind: 'field' },
      { key: 'createTimeField', zh: '创建时间列', en: 'Created time field', required: false, kind: 'field' },
    ],
  },
  {
    key: 'bomHead', zh: 'BOM 头', en: 'BOM header', fields: [
      { key: 'object', zh: '来源表', en: 'Source object', required: true, kind: 'object' },
      { key: 'parentPartField', zh: '父物料列', en: 'Parent part field', required: true, kind: 'field' },
      { key: 'bomIdField', zh: 'BOM ID 列', en: 'BOM ID field', required: true, kind: 'field' },
      { key: 'versionField', zh: 'BOM 版本列', en: 'BOM version field', required: false, kind: 'field' },
      { key: 'activeField', zh: '启用状态列', en: 'Active state field', required: false, kind: 'field' },
    ],
  },
  {
    key: 'bomDetail', zh: 'BOM 明细', en: 'BOM detail', fields: [
      { key: 'object', zh: '来源表', en: 'Source object', required: true, kind: 'object' },
      { key: 'bomParentField', zh: 'BOM 归属列', en: 'BOM parent field', required: true, kind: 'field' },
      { key: 'componentIdField', zh: '子件 ID 列', en: 'Component ID field', required: true, kind: 'field' },
      { key: 'quantityField', zh: '用量列', en: 'Quantity field', required: true, kind: 'field' },
      { key: 'sortField', zh: '排序列', en: 'Sort field', required: false, kind: 'field' },
    ],
  },
] as const

export type SourcePlanDraftSectionKey = (typeof SOURCE_PLAN_DRAFT_SECTIONS)[number]['key']
export type SourcePlanDraft = {
  roles: Record<SourcePlanDraftSectionKey, Record<string, string>>
  maxReadCount: number
}
export type SourcePlanDraftIssue = { path: string; code: string; zh: string; en: string }
export type SourcePlanReadPlan = {
  id: 'plm.stock-preparation.bom-read.user-draft.v1'
  sourceKind: 'data-source:sql-readonly'
  matchField: string
  maxReadCount: number
} & Record<SourcePlanDraftSectionKey, Record<string, string>>
export type SourcePlanDraftCompileResult = {
  ok: boolean
  issues: SourcePlanDraftIssue[]
  envelope: null | {
    schemaVersion: 1
    kind: 'stock-preparation-plm-role-draft'
    status: 'confirm-required'
    validation: 'structure-only'
    readPlan: SourcePlanReadPlan
  }
}

export type SourcePlanDraftParseResult = {
  ok: boolean
  issues: SourcePlanDraftIssue[]
  draft: SourcePlanDraft | null
}

const DRAFT_PLAN_ID = 'plm.stock-preparation.bom-read.user-draft.v1'
const DRAFT_ENVELOPE_KIND = 'stock-preparation-plm-role-draft'
export const SOURCE_PLAN_DRAFT_MAX_JSON_BYTES = 128 * 1024
const FIELD_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const DISALLOWED_SEGMENT = /^(?:select|from|where|join|union|drop|delete|insert|update|exec|execute|script|javascript|http|https|url|password|passwd|pwd|secret|token|credential|credentials|apikey|appkey|authoritycode|tenant|identity|principal|constructor|prototype|proto)$/i

// One or two nonempty ASCII SQL identifier segments. A third part is an
// explicit strict SA02 interoperability limit.
function isObjectIdentifier(value: string): boolean {
  const segments = value.split('.')
  return segments.length >= 1 && segments.length <= 2
    && segments.every((segment) => FIELD_IDENTIFIER.test(segment))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function issue(path: string, code: string): SourcePlanDraftIssue {
  const messages: Record<string, { zh: string; en: string }> = {
    'invalid-shape': { zh: '草稿结构无效', en: 'Invalid draft structure' },
    'unknown-key': { zh: '草稿含未支持的配置', en: 'Draft contains unsupported configuration' },
    required: { zh: '请填写必填角色', en: 'Fill in the required role' },
    'invalid-identifier': { zh: '只能填写安全的表或列标识', en: 'Use a safe object or field identifier' },
    'invalid-budget': { zh: '读取预算须为 1 至 1000 的整数', en: 'Read budget must be an integer from 1 to 1000' },
    'version-dependency': { zh: '订单版本列要求同时填写 BOM 头版本列', en: 'Order version field requires a BOM header version field' },
    'invalid-json': { zh: '待审 JSON 无法读取', en: 'Review JSON cannot be read' },
    'payload-too-large': { zh: '待审 JSON 超过 128 KiB 限制', en: 'Review JSON exceeds the 128 KiB limit' },
    'invalid-envelope': { zh: '不是本工具导出的待审草稿', en: 'Not a review draft exported by this tool' },
    'unexpected-value': { zh: '待审草稿的固定标识不匹配', en: 'Review draft fixed identifier does not match' },
    'invalid-status': { zh: '待审草稿状态必须是待确认', en: 'Review draft status must be confirm-required' },
    'inconsistent-read-plan': { zh: '待审草稿的字段角色不一致', en: 'Review draft field roles are inconsistent' },
  }
  return { path, code, ...messages[code] }
}

function isSafeIdentifier(value: string, kind: 'object' | 'field'): boolean {
  if (value.length > 128 || !(kind === 'object' ? isObjectIdentifier(value) : FIELD_IDENTIFIER.test(value))) return false
  return !value.split(/[._]/).some((segment) => DISALLOWED_SEGMENT.test(segment))
}

export function createEmptySourcePlanDraft(): SourcePlanDraft {
  const roles = {} as SourcePlanDraft['roles']
  for (const section of SOURCE_PLAN_DRAFT_SECTIONS) {
    const fields: Record<string, string> = {}
    for (const field of section.fields) fields[field.key] = ''
    roles[section.key] = fields
  }
  return { roles, maxReadCount: 200 }
}

export function createSyntheticSourcePlanDraft(): SourcePlanDraft {
  const draft = createEmptySourcePlanDraft()
  for (const section of SOURCE_PLAN_DRAFT_SECTIONS) {
    for (const field of section.fields) {
      draft.roles[section.key][field.key] = field.kind === 'object'
        ? `SYN_${section.key}`
        : `syn_${section.key}_${field.key}`
    }
  }
  return draft
}

export function compileSourcePlanDraft(input: unknown): SourcePlanDraftCompileResult {
  const issues: SourcePlanDraftIssue[] = []
  if (!isRecord(input)) return { ok: false, issues: [issue('draft', 'invalid-shape')], envelope: null }
  if (Object.keys(input).some((key) => key !== 'roles' && key !== 'maxReadCount')) {
    issues.push(issue('draft', 'unknown-key'))
  }
  if (!Number.isInteger(input.maxReadCount) || (input.maxReadCount as number) < 1 || (input.maxReadCount as number) > 1000) {
    issues.push(issue('maxReadCount', 'invalid-budget'))
  }
  if (!isRecord(input.roles)) {
    issues.push(issue('roles', 'invalid-shape'))
    return { ok: false, issues, envelope: null }
  }
  const rolesInput = input.roles
  if (Object.keys(rolesInput).some((key) => !SOURCE_PLAN_DRAFT_SECTIONS.some((section) => section.key === key))) {
    issues.push(issue('roles', 'unknown-key'))
  }

  const roles = {} as Record<SourcePlanDraftSectionKey, Record<string, string>>
  for (const section of SOURCE_PLAN_DRAFT_SECTIONS) {
    const sectionInput = rolesInput[section.key]
    const path = `roles.${section.key}`
    if (!isRecord(sectionInput)) {
      issues.push(issue(path, 'invalid-shape'))
      continue
    }
    if (Object.keys(sectionInput).some((key) => !section.fields.some((field) => field.key === key))) {
      issues.push(issue(path, 'unknown-key'))
    }
    const fields: Record<string, string> = {}
    for (const field of section.fields) {
      const fieldPath = `${path}.${field.key}`
      const raw = sectionInput[field.key]
      if (typeof raw !== 'string') {
        issues.push(issue(fieldPath, raw === undefined && field.required ? 'required' : 'invalid-identifier'))
        continue
      }
      const value = raw.trim()
      if (value === '') {
        if (field.required) issues.push(issue(fieldPath, 'required'))
      } else if (!isSafeIdentifier(value, field.kind)) {
        issues.push(issue(fieldPath, 'invalid-identifier'))
      } else {
        fields[field.key] = value
      }
    }
    roles[section.key] = fields
  }
  if (roles.orderDetail?.versionField && !roles.bomHead?.versionField) {
    issues.push(issue('roles.bomHead.versionField', 'version-dependency'))
  }
  if (issues.length > 0) return { ok: false, issues, envelope: null }

  const readPlan: SourcePlanReadPlan = {
    id: DRAFT_PLAN_ID,
    sourceKind: 'data-source:sql-readonly',
    matchField: roles.pathExAttr.matchField,
    maxReadCount: input.maxReadCount as number,
    ...roles,
  }
  return {
    ok: true,
    issues: [],
    envelope: {
      schemaVersion: 1,
      kind: DRAFT_ENVELOPE_KIND,
      status: 'confirm-required',
      validation: 'structure-only',
      readPlan,
    },
  }
}

/**
 * Re-import only the exact review envelope emitted above. This accepts no connection identity,
 * tenant, principal, permission, SQL, approval, or installation input. It rebuilds the editable
 * draft through the same compiler rather than trusting a serialized read plan.
 */
export function parseSourcePlanDraftJson(text: string): SourcePlanDraftParseResult {
  if (new TextEncoder().encode(text).byteLength > SOURCE_PLAN_DRAFT_MAX_JSON_BYTES) {
    return { ok: false, issues: [issue('draft', 'payload-too-large')], draft: null }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, issues: [issue('draft', 'invalid-json')], draft: null }
  }
  if (!isRecord(parsed)) return invalidEnvelope('draft')

  const envelopeKeys = ['schemaVersion', 'kind', 'status', 'validation', 'readPlan']
  if (Object.keys(parsed).length !== envelopeKeys.length || Object.keys(parsed).some((key) => !envelopeKeys.includes(key))) {
    return invalidEnvelope('draft')
  }
  if (parsed.schemaVersion !== 1 || parsed.kind !== DRAFT_ENVELOPE_KIND || parsed.validation !== 'structure-only') {
    return invalidEnvelope('draft')
  }
  if (parsed.status !== 'confirm-required') {
    return { ok: false, issues: [issue('status', 'invalid-status')], draft: null }
  }
  if (!isRecord(parsed.readPlan)) return invalidEnvelope('readPlan')

  const readPlan = parsed.readPlan
  const allowedReadPlanKeys = ['id', 'sourceKind', 'matchField', 'maxReadCount', ...SOURCE_PLAN_DRAFT_SECTIONS.map((section) => section.key)]
  if (Object.keys(readPlan).some((key) => !allowedReadPlanKeys.includes(key))) {
    return { ok: false, issues: [issue('readPlan', 'unknown-key')], draft: null }
  }
  if (readPlan.id !== DRAFT_PLAN_ID || readPlan.sourceKind !== 'data-source:sql-readonly') {
    return { ok: false, issues: [issue('readPlan', 'unexpected-value')], draft: null }
  }
  if (typeof readPlan.matchField !== 'string') {
    return invalidEnvelope('readPlan')
  }

  const draft = createEmptySourcePlanDraft()
  for (const section of SOURCE_PLAN_DRAFT_SECTIONS) {
    const sectionInput = readPlan[section.key]
    if (!isRecord(sectionInput)) return invalidEnvelope(`readPlan.${section.key}`)
    if (Object.keys(sectionInput).some((key) => !section.fields.some((field) => field.key === key))) {
      return { ok: false, issues: [issue(`readPlan.${section.key}`, 'unknown-key')], draft: null }
    }
    for (const field of section.fields) {
      const raw = sectionInput[field.key]
      if (raw === undefined && !field.required) continue
      if (typeof raw !== 'string') return invalidEnvelope(`readPlan.${section.key}.${field.key}`)
      draft.roles[section.key][field.key] = raw
    }
  }
  if (readPlan.matchField !== draft.roles.pathExAttr.matchField) {
    return { ok: false, issues: [issue('readPlan.matchField', 'inconsistent-read-plan')], draft: null }
  }

  const compiled = compileSourcePlanDraft({ roles: draft.roles, maxReadCount: readPlan.maxReadCount })
  if (!compiled.ok || !compiled.envelope) {
    return { ok: false, issues: compiled.issues, draft: null }
  }
  // Require the serialized plan to be exactly the compiler's output (apart from object key order),
  // so a caller cannot smuggle a different role interpretation past the editable draft.
  if (!sameRecord(compiled.envelope.readPlan, readPlan)) {
    return { ok: false, issues: [issue('readPlan', 'inconsistent-read-plan')], draft: null }
  }
  draft.maxReadCount = compiled.envelope.readPlan.maxReadCount
  return { ok: true, issues: [], draft }
}

function invalidEnvelope(path: string): SourcePlanDraftParseResult {
  return { ok: false, issues: [issue(path, 'invalid-envelope')], draft: null }
}

function sameRecord(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !Object.prototype.hasOwnProperty.call(right, key))) return false
  return leftKeys.every((key) => sameRecordValue(left[key], right[key]))
}

function sameRecordValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (isRecord(left) && isRecord(right)) return sameRecord(left, right)
  return false
}

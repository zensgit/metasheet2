import type { YidaProtocolCatalogEntry, YidaProtocolConfig, YidaStaticFieldMapEntry } from '../../../../../plugins/plugin-integration-core/lib/yida-static-plan.mjs'
import type { YidaFormFieldDefinition } from './yidaInitialization'

/**
 * 宜搭配置面板（四步）: the stock-prep side of the field mapping and the one place that turns the operator's
 * choices into the v2 contract. Pure and values-free: no IO, no credential, no row value.
 *
 * The contract version is not the operator's choice any more: local initialization accepts v2 only, so this
 * module always builds a v2 `create` config. The seven identity fields of the stock-prep material form
 * (R-71 ⑤: 项目号、图号、名称、规格、材质、版本、父组件图号) are the business key, in this order, and the
 * optional parent field is the one empty-key field, exactly the layout a later v3 draft must match.
 */
export interface StockPrepYidaSourceField {
  /** The column name in the preview rows (the synthetic sample uses the same names). */
  readonly source: string
  readonly label: string
  readonly type: 'string' | 'number'
  readonly required: boolean
  readonly identity: boolean
  /** Labels that auto-match a YiDa field label exactly (first is the canonical one). */
  readonly aliases: readonly string[]
}
export const STOCK_PREP_YIDA_SOURCE_FIELDS: readonly StockPrepYidaSourceField[] = Object.freeze(([
  { source: 'projectNo', label: '项目号', type: 'string', required: true, identity: true, aliases: ['项目号', '项目编号'] },
  { source: 'componentCode', label: '图号', type: 'string', required: true, identity: true, aliases: ['图号', '物料编号', '物料图号'] },
  { source: 'componentName', label: '名称', type: 'string', required: true, identity: true, aliases: ['名称', '物料名称'] },
  { source: 'specification', label: '规格', type: 'string', required: true, identity: true, aliases: ['规格', '规格型号'] },
  { source: 'material', label: '材质', type: 'string', required: true, identity: true, aliases: ['材质'] },
  { source: 'version', label: '版本', type: 'string', required: true, identity: true, aliases: ['版本', '版本号'] },
  { source: 'parentCode', label: '父组件图号', type: 'string', required: false, identity: true, aliases: ['父组件图号', '父图号'] },
  { source: 'quantity', label: '数量', type: 'number', required: true, identity: false, aliases: ['数量', '件数'] },
  { source: 'priority', label: '优先级', type: 'string', required: false, identity: false, aliases: ['优先级'] },
] satisfies StockPrepYidaSourceField[]).map((field): StockPrepYidaSourceField => Object.freeze({ ...field, aliases: Object.freeze([...field.aliases]) })))
const SOURCE_BY_NAME = new Map(STOCK_PREP_YIDA_SOURCE_FIELDS.map((field) => [field.source, field]))
export function stockPrepYidaSourceField(source: string): StockPrepYidaSourceField | undefined { return SOURCE_BY_NAME.get(source) }

export type YidaSetupControl = YidaProtocolCatalogEntry['control']
/** YiDa component names this contract can write; anything else (date, member, attachment, sub-table…) is not offered. */
const CONTROL_BY_COMPONENT: Readonly<Record<string, YidaSetupControl>> = Object.freeze({
  TextField: 'text', TextareaField: 'text', NumberField: 'number', SelectField: 'select', RadioField: 'radio',
})
export function yidaControlOf(componentName: string): YidaSetupControl | null {
  return Object.prototype.hasOwnProperty.call(CONTROL_BY_COMPONENT, componentName) ? CONTROL_BY_COMPONENT[componentName] : null
}
const COMPONENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  TextField: '单行文本', TextareaField: '多行文本', NumberField: '数字', SelectField: '下拉单选', RadioField: '单选',
})
export function yidaComponentLabel(componentName: string): string { return COMPONENT_LABELS[componentName] ?? componentName }
/** Fields of the form that this contract can map to: supported control, not inside a sub-table. */
export function mappableYidaFields(fields: readonly YidaFormFieldDefinition[]): YidaFormFieldDefinition[] {
  return fields.filter((field) => field.parentId === null && yidaControlOf(field.componentName) !== null)
}

export interface YidaSetupMappingRow {
  source: string
  /** YiDa field ID (组件 ID). */
  target: string
  control: YidaSetupControl
  /** select / radio only: one option per line, exact text. */
  optionsText: string
  /** The YiDa field is required on the form (unknown from the definition API; the operator confirms it). */
  yidaRequired: boolean
}
export function blankMappingRow(source = ''): YidaSetupMappingRow {
  const field = stockPrepYidaSourceField(source)
  return { source, target: '', control: field?.type === 'number' ? 'number' : 'text', optionsText: '', yidaRequired: field?.required ?? false }
}
/** One row per stock-prep field, each auto-matched to the YiDa field whose label equals one of its aliases. */
export function defaultMappingRows(fields: readonly YidaFormFieldDefinition[]): YidaSetupMappingRow[] {
  const candidates = mappableYidaFields(fields)
  const taken = new Set<string>()
  return STOCK_PREP_YIDA_SOURCE_FIELDS.map((source) => {
    const row = blankMappingRow(source.source)
    const matches = candidates.filter((field) => source.aliases.includes(field.label) && !taken.has(field.fieldId))
    // Only an unambiguous match is filled in; two fields with the same label stay for the operator.
    if (matches.length === 1) {
      const control = yidaControlOf(matches[0].componentName)
      if (control && (control === 'number') === (source.type === 'number')) {
        row.target = matches[0].fieldId; row.control = control; taken.add(matches[0].fieldId)
      }
    }
    return row
  })
}

export interface YidaSetupIssue { readonly row: number | null; readonly message: string }
export type YidaSetupBuildResult =
  | { readonly ok: true; readonly config: YidaProtocolConfig; readonly issues: readonly [] }
  | { readonly ok: false; readonly issues: readonly YidaSetupIssue[] }
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u

/**
 * The v2 `create` config for these rows. Every refusal is named in plain words; the shared validator in
 * yida-static-plan.mjs still owns the final word when the preview runs.
 */
export function buildYidaSetupConfig(input: { appType: string; formUuid: string; rows: readonly YidaSetupMappingRow[] }): YidaSetupBuildResult {
  const issues: YidaSetupIssue[] = []
  const appType = input.appType.trim(), formUuid = input.formUuid.trim()
  if (!IDENTIFIER.test(appType)) issues.push({ row: null, message: 'appType 须为 1–128 位字母、数字、下划线或连字符。' })
  if (!IDENTIFIER.test(formUuid)) issues.push({ row: null, message: 'formUuid 须为 1–128 位字母、数字、下划线或连字符。' })
  const sources = new Set<string>(), targets = new Set<string>()
  const fieldMap: YidaStaticFieldMapEntry[] = []
  const fieldCatalog: YidaProtocolCatalogEntry[] = []
  input.rows.forEach((row, index) => {
    const source = stockPrepYidaSourceField(row.source)
    if (!source) { issues.push({ row: index, message: '请选择备料字段。' }); return }
    if (sources.has(source.source)) { issues.push({ row: index, message: `「${source.label}」映射了两次。` }); return }
    sources.add(source.source)
    const target = row.target.trim()
    if (!IDENTIFIER.test(target)) { issues.push({ row: index, message: `「${source.label}」还没有选宜搭字段。` }); return }
    if (targets.has(target)) { issues.push({ row: index, message: `宜搭字段 ${target} 被两个备料字段使用。` }); return }
    targets.add(target)
    if ((row.control === 'number') !== (source.type === 'number')) {
      issues.push({ row: index, message: source.type === 'number' ? `「${source.label}」是数字，须映射到数字字段。` : `「${source.label}」是文本，不能映射到数字字段。` })
      return
    }
    const required = source.required || row.yidaRequired
    if (row.control === 'select' || row.control === 'radio') {
      const options = row.optionsText.split(/\r?\n/u).map((option) => option.trim()).filter((option) => option.length > 0)
      if (options.length === 0 || new Set(options).size !== options.length) {
        issues.push({ row: index, message: `「${source.label}」是选项字段：请逐行填写宜搭里的选项（不能为空或重复）。` })
        return
      }
      fieldCatalog.push({ id: target, control: row.control, required: row.yidaRequired, options })
    } else {
      fieldCatalog.push({ id: target, control: row.control, required: row.yidaRequired })
    }
    fieldMap.push({ source: source.source, target, type: source.type, required })
  })
  const missing = STOCK_PREP_YIDA_SOURCE_FIELDS.filter((field) => (field.identity || field.required) && !sources.has(field.source))
  if (missing.length > 0) issues.push({ row: null, message: `还没有映射：${missing.map((field) => field.label).join('、')}（七项身份字段和数量必须映射）。` })
  if (issues.length > 0) return { ok: false, issues }
  const businessKey = STOCK_PREP_YIDA_SOURCE_FIELDS.filter((field) => field.identity).map((field) => field.source)
  // 父组件图号 may be blank on a top-level part: an empty-key field, unless the YiDa form itself requires it.
  const parent = fieldMap.find((entry) => entry.source === 'parentCode')
  const emptyKeyFields = parent && !parent.required ? ['parentCode'] : []
  return { ok: true, issues: [], config: { version: 2, kind: 'yida-form-protocol-static', target: { appType, formUuid },
    intent: 'create', businessKey, emptyKeyFields, fieldMap, fieldCatalog } }
}

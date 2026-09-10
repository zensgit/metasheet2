// G27 — data-factory cleaning rules: UI ⇄ engine transform/validation parity.
//
// WHY THIS FILE EXISTS
// The cleaning-rules editor used to expose HALF of the transform engine (trim/upper/lower/
// toNumber/dictMap) and half of the validator (required/min/max), while
// plugins/plugin-integration-core/lib/transform-engine.cjs:10-19 has supported toDate,
// defaultValue and concat (plus multi-step CHAINS) and lib/validator.cjs:12 has supported
// pattern and enum all along. This module holds the pure, testable half of closing that gap:
// the payload builders (EditableMapping -> wire shape) and their inverse. The view keeps the
// state, the section component keeps the markup, and everything shape-related lives HERE so a
// plain `.ts` unit test can assert the exact bytes we send — and can `require()` the engine's
// own `SUPPORTED_TRANSFORMS` / `SUPPORTED_RULES` to prove the two lists still agree.
//
// PAYLOAD SHAPES (all verified against the engine sources, not guessed — see the design doc
// docs/development/integration-mapping-transform-ui-parity-design-20260910.md §3):
//   trim|upper|lower|toNumber  -> { fn }
//   toDate                     -> { fn: 'toDate', format: 'iso' | 'date' }   (engine only
//                                 branches on format === 'date'; anything else = full ISO)
//   defaultValue               -> { fn: 'defaultValue', value }              (engine reads
//                                 args.value ?? args.defaultValue, transform-engine.cjs:169)
//   concat                     -> { fn: 'concat', fields: string[], separator }
//   dictMap                    -> { fn: 'dictMap', map }                     (UNCHANGED)
//   chain (>= 2 steps)         -> [ step, step, ... ]  (normalizeTransformList accepts an
//                                 array or { steps: [...] }; we write the array form)
//   mapping-level default      -> mapping.defaultValue (pipelines.cjs normalizeFieldMappings,
//                                 applied by transformRecord BEFORE the transform chain)
//   pattern                    -> { type: 'pattern', params: { regex } }
//   enum                       -> { type: 'enum', params: { values: string[] } }
//   min|max                    -> { type, value }                            (UNCHANGED flat
//                                 form; normalizeRule folds stray keys into params anyway)
//
// BYTE COMPATIBILITY: a row with one transform step, no pattern/enum and no mapping-level
// default produces the SAME object (same keys, same order) the pre-G27 view produced. That is
// what keeps IntegrationWorkbenchView.spec.ts's payload assertions green without edits.
import type { IntegrationFieldMapping } from '../../services/integration/workbench'
import type {
  EditableMapping,
  MappingDateFormat,
  MappingTransformArgs,
  MappingTransformStep,
  TransformFn,
} from './integrationWorkbenchSectionTypes'

// The single UI list of transforms. MUST equal the engine's SUPPORTED_TRANSFORMS (plus the ''
// "no transform" sentinel, which is a UI-only idea: it means "omit `transform` entirely").
export const TRANSFORM_OPTIONS: Array<{ value: TransformFn, label: string }> = [
  { value: '', label: '无转换' },
  { value: 'trim', label: 'trim 去空格' },
  { value: 'upper', label: 'upper 转大写' },
  { value: 'lower', label: 'lower 转小写' },
  { value: 'toNumber', label: 'toNumber 转数字' },
  { value: 'toDate', label: 'toDate 转日期' },
  { value: 'defaultValue', label: 'defaultValue 缺值兜底' },
  { value: 'concat', label: 'concat 字段拼接' },
  { value: 'dictMap', label: 'dictMap 字典映射' },
]

// The engine-facing subset (no '' sentinel) — this is the list the parity tripwire compares
// against `SUPPORTED_TRANSFORMS`.
export const UI_TRANSFORM_FNS: string[] = TRANSFORM_OPTIONS
  .map((option) => option.value)
  .filter((value): value is Exclude<TransformFn, ''> => value !== '')

// The validation rule types this editor can author. MUST be a subset of the validator's
// SUPPORTED_RULES; the parity test asserts equality (we now expose all five).
export const UI_VALIDATION_RULES: string[] = ['required', 'pattern', 'enum', 'min', 'max']

export const DATE_FORMAT_OPTIONS: Array<{ value: MappingDateFormat, label: string }> = [
  { value: 'iso', label: 'ISO 日期时间 (2024-01-31T00:00:00.000Z)' },
  { value: 'date', label: '仅日期 (2024-01-31)' },
]

export function createTransformArgs(overrides: Partial<MappingTransformArgs> = {}): MappingTransformArgs {
  return {
    dateFormat: 'iso',
    defaultValueText: '',
    concatFields: [],
    concatSeparator: '',
    ...overrides,
  }
}

export function createTransformStep(id: string, overrides: Partial<MappingTransformStep> = {}): MappingTransformStep {
  return {
    id,
    fn: '',
    dictMapText: '',
    args: createTransformArgs(),
    ...overrides,
  }
}

export function createEditableMapping(overrides: Partial<EditableMapping> = {}): EditableMapping {
  return {
    id: '',
    sourceField: '',
    targetField: '',
    transformFn: '',
    dictMapText: '',
    transformArgs: createTransformArgs(),
    extraSteps: [],
    required: false,
    minValueText: '',
    maxValueText: '',
    patternText: '',
    enumText: '',
    defaultValueText: '',
    ...overrides,
  }
}

// Moved verbatim from IntegrationWorkbenchView.vue (same messages, same accepted inputs) so the
// builders can live in a plain module. Behavior is unchanged.
export function parseDictionaryMap(text: string): Record<string, string> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('dictMap 字典映射不能为空')
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('dictMap JSON 必须是对象')
    }
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]))
  }
  const entries = trimmed.split(/\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) throw new Error('dictMap 每行必须使用 source=target 格式')
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (!key || !value) throw new Error('dictMap 每行必须同时包含 source 和 target')
    return [key, value] as const
  })
  return Object.fromEntries(entries)
}

export function parseOptionalNumber(value: string, label: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) throw new Error(`${label} 必须是数字`)
  return numeric
}

// Comma / full-width-comma / newline separated, trimmed, de-duplicated, empties dropped — the
// same shape as the view's existing `parseList()` for idempotency key fields.
export function parseCommaSeparatedList(text: string): string[] {
  return Array.from(new Set(String(text || '').split(/[\n,，]/).map((item) => item.trim()).filter(Boolean)))
}

// enum values are authored as a comma- (or newline-) separated list. They stay STRINGS: the
// validator's includesEnumValue() already compares a numeric value against a string candidate
// (validator.cjs:108-114), so '10' matches both 10 and '10'.
export function parseEnumValues(text: string): string[] {
  return parseCommaSeparatedList(text)
}

export function formatEnumValues(values: unknown[]): string {
  return values.map((value) => (value === null || value === undefined ? '' : String(value))).join(', ')
}

// Fail HERE, at build time, on a regex the engine could only reject at row time (it would emit
// one INVALID_RULE error per row). buildMappings() runs inside the save/preview try-block, so the
// operator sees the message instead of a pipeline full of identical dead letters.
export function assertValidPattern(pattern: string): string {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern)
  } catch (error) {
    throw new Error(`pattern 正则无效: ${error instanceof Error ? error.message : String(error)}`)
  }
  return pattern
}

// Step 1 lives on the mapping itself; steps 2..n live in extraSteps. Empty-fn steps are dropped
// (an empty select = "this step does nothing"), which is what makes '' + extraSteps behave the
// same as a shorter chain.
export function mappingTransformSteps(mapping: EditableMapping): MappingTransformStep[] {
  const firstStep: MappingTransformStep = {
    id: `${mapping.id}:0`,
    fn: mapping.transformFn,
    dictMapText: mapping.dictMapText,
    args: mapping.transformArgs || createTransformArgs(),
  }
  return [firstStep, ...(mapping.extraSteps || [])].filter((step) => step && step.fn !== '')
}

export function buildTransformStepPayload(step: MappingTransformStep): Record<string, unknown> {
  const args = step.args || createTransformArgs()
  switch (step.fn) {
    case 'dictMap':
      return { fn: 'dictMap', map: parseDictionaryMap(step.dictMapText) }
    case 'toDate':
      return { fn: 'toDate', format: args.dateFormat === 'date' ? 'date' : 'iso' }
    case 'defaultValue': {
      // The engine treats '' as blank, so an empty fallback would be a silent no-op.
      if (!args.defaultValueText.trim()) throw new Error('defaultValue 兜底值不能为空')
      return { fn: 'defaultValue', value: args.defaultValueText }
    }
    case 'concat': {
      const fields = (args.concatFields || []).map((field) => field.trim()).filter(Boolean)
      if (fields.length === 0) throw new Error('concat 至少需要选择一个拼接字段')
      return { fn: 'concat', fields, separator: args.concatSeparator }
    }
    default:
      return { fn: step.fn }
  }
}

export function buildTransformPayload(mapping: EditableMapping): unknown {
  const steps = mappingTransformSteps(mapping)
  if (steps.length === 0) return undefined
  const payloads = steps.map(buildTransformStepPayload)
  // ONE step keeps the legacy single-object shape (byte-compatible); two or more become the
  // array chain normalizeTransformList() reduces left-to-right.
  return payloads.length === 1 ? payloads[0] : payloads
}

export function buildValidationPayload(mapping: EditableMapping): Array<Record<string, unknown>> | undefined {
  const validation: Array<Record<string, unknown>> = []
  if (mapping.required) validation.push({ type: 'required' })
  const pattern = (mapping.patternText || '').trim()
  if (pattern) validation.push({ type: 'pattern', params: { regex: assertValidPattern(pattern) } })
  const enumValues = parseEnumValues(mapping.enumText || '')
  if (enumValues.length > 0) validation.push({ type: 'enum', params: { values: enumValues } })
  const min = parseOptionalNumber(mapping.minValueText, 'min')
  const max = parseOptionalNumber(mapping.maxValueText, 'max')
  if (min !== undefined) validation.push({ type: 'min', value: min })
  if (max !== undefined) validation.push({ type: 'max', value: max })
  return validation.length > 0 ? validation : undefined
}

// F07: build errors name the ROW. buildMappings() maps over every row inside one try-block, so a
// bare `concat 至少需要选择一个拼接字段` used to leave the operator hunting for which of a dozen
// rows it came from. The original message is kept verbatim after the prefix (tests and humans
// both match on it).
export function buildFieldMappingPayload(mapping: EditableMapping, index: number): IntegrationFieldMapping {
  try {
    const payload: IntegrationFieldMapping = {
      sourceField: mapping.sourceField.trim(),
      targetField: mapping.targetField.trim(),
      transform: buildTransformPayload(mapping),
      validation: buildValidationPayload(mapping),
      sortOrder: index,
    }
    // Mapping-level default: substituted by transformRecord() when the SOURCE value is blank, i.e.
    // BEFORE the chain runs (transform-engine.cjs:232-235). Only emitted when authored, so an
    // untouched row is byte-identical to the pre-G27 payload.
    if ((mapping.defaultValueText || '').trim()) payload.defaultValue = mapping.defaultValueText
    return payload
  } catch (error) {
    const label = mapping.targetField.trim() || mapping.sourceField.trim() || '未命名字段'
    throw new Error(`第 ${index + 1} 条清洗规则（${label}）：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// Inverse (wire -> editor). G08: the workbench does not re-read a saved pipeline yet, so this is
// deliberately scoped to an EDITOR round trip: everything buildFieldMappingPayload() can emit
// must come back unchanged. It is also liberal about shapes the ENGINE accepts but the UI never
// writes (string steps, { steps: [...] }, flat `regex`/`values`, `type` instead of `fn`), so a
// hand-written or older pipeline still loads.
// KNOWN LOSS (documented, not silent — every item below has a parity test asserting the loss):
//   1. dictMap's optional `defaultValue` arg;
//   2. concat's `values` / `includeCurrent` args;
//   3. F01 — a pattern rule's `params.flags` (the validator compiles `new RegExp(pattern, flags)`,
//      validator.cjs:85-97), so a case-insensitive `flags: 'i'` rule comes back case-SENSITIVE;
//   4. F11 — any rule's custom `message` (the validator prefers it over its own text,
//      validator.cjs:59), so a re-saved rule falls back to the engine's default message.
// None of these has an editor control. They are dropped on READ, which is the safe direction: the
// editor never claims to hold something it cannot show, and it never re-emits a half-understood
// rule. Authoring them stays a hand-written-payload capability until they get controls.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readString(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

export function normalizeTransformPayloadSteps(transform: unknown): Array<Record<string, unknown> | string> {
  if (transform === undefined || transform === null) return []
  if (Array.isArray(transform)) return transform as Array<Record<string, unknown> | string>
  if (isPlainObject(transform) && Array.isArray(transform.steps)) {
    return transform.steps as Array<Record<string, unknown> | string>
  }
  return [transform as Record<string, unknown> | string]
}

function formatDictionaryMap(map: unknown): string {
  if (!isPlainObject(map)) return ''
  return Object.entries(map).map(([key, value]) => `${key}=${readString(value)}`).join('\n')
}

function transformStepFromPayload(raw: Record<string, unknown> | string, id: string): MappingTransformStep | null {
  const step = typeof raw === 'string' ? { fn: raw } : raw
  if (!isPlainObject(step)) return null
  // F02: EXACTLY the engine's rule (normalizeTransformStep, transform-engine.cjs:131) — a plain
  // `args` object REPLACES the top level, it does not merge with it. Merging made us read a
  // top-level `format` that the engine would have ignored, i.e. the editor would have shown an
  // argument the pipeline never used.
  const args: Record<string, unknown> = isPlainObject(step.args) ? step.args : step
  const fnRaw = readString(step.fn || step.type).trim()
  if (!UI_TRANSFORM_FNS.includes(fnRaw)) return null
  const fn = fnRaw as TransformFn
  const editable = createTransformStep(id, { fn })
  if (fn === 'dictMap') editable.dictMapText = formatDictionaryMap(args.map)
  if (fn === 'toDate') editable.args.dateFormat = args.format === 'date' ? 'date' : 'iso'
  if (fn === 'defaultValue') {
    const value = Object.prototype.hasOwnProperty.call(args, 'value') ? args.value : args.defaultValue
    editable.args.defaultValueText = readString(value)
  }
  if (fn === 'concat') {
    editable.args.concatFields = Array.isArray(args.fields) ? args.fields.map(readString).filter(Boolean) : []
    editable.args.concatSeparator = readString(args.separator)
  }
  return editable
}

// F02: the validator folds stray TOP-LEVEL keys into params AFTER copying `rule.params`
// (validator.cjs:42-46), so on a collision the top level wins. Read in that same order, or the
// editor would show the losing value.
function ruleParam(rule: Record<string, unknown>, names: string[]): unknown {
  const params = isPlainObject(rule.params) ? rule.params : {}
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(rule, name)) return rule[name]
    if (Object.prototype.hasOwnProperty.call(params, name)) return params[name]
  }
  return undefined
}

export function editableMappingFromPayload(payload: IntegrationFieldMapping, id: string): EditableMapping {
  const mapping = createEditableMapping({
    id,
    sourceField: readString(payload?.sourceField),
    targetField: readString(payload?.targetField),
  })

  const steps = normalizeTransformPayloadSteps(payload?.transform)
    .map((raw, index) => transformStepFromPayload(raw, `${id}:${index}`))
    .filter((step): step is MappingTransformStep => step !== null)
  const [firstStep, ...rest] = steps
  if (firstStep) {
    mapping.transformFn = firstStep.fn
    mapping.dictMapText = firstStep.dictMapText
    mapping.transformArgs = firstStep.args
  }
  mapping.extraSteps = rest

  const rules = Array.isArray(payload?.validation) ? payload.validation : []
  for (const rawRule of rules) {
    const rule = typeof rawRule === 'string' ? { type: rawRule } : rawRule
    if (!isPlainObject(rule)) continue
    const type = readString(rule.type || rule.kind).trim()
    if (type === 'required') mapping.required = true
    if (type === 'pattern') mapping.patternText = readString(ruleParam(rule, ['regex', 'pattern', 'value']))
    if (type === 'enum') {
      const values = ruleParam(rule, ['values', 'enum', 'allowedValues'])
      mapping.enumText = Array.isArray(values) ? formatEnumValues(values) : ''
    }
    if (type === 'min') mapping.minValueText = readString(ruleParam(rule, ['value', 'min']))
    if (type === 'max') mapping.maxValueText = readString(ruleParam(rule, ['value', 'max']))
  }

  if (payload?.defaultValue !== undefined && payload?.defaultValue !== null) {
    mapping.defaultValueText = readString(payload.defaultValue)
  }

  return mapping
}

export type YidaStaticPrimitive = string | number | boolean | null
export type YidaStaticRow = Record<string, YidaStaticPrimitive>
export type YidaStaticFieldType = 'string' | 'number' | 'boolean'
export interface YidaStaticFieldMapEntry {
  source: string
  target: string
  type: YidaStaticFieldType
  required: boolean
}
export interface YidaStaticTarget {
  appType: string
  formUuid: string
}
export interface YidaStaticBaseConfig {
  version: 1
  kind: 'yida-form-static'
  target: YidaStaticTarget
  businessKey: string[]
  fieldMap: YidaStaticFieldMapEntry[]
}
export type YidaStaticV1Config =
  | (YidaStaticBaseConfig & { intent: 'create'; instanceIdField?: never })
  | (YidaStaticBaseConfig & { intent: 'update'; instanceIdField: string })
export type YidaProtocolControl = 'text' | 'number' | 'select' | 'radio'
export type YidaProtocolCatalogEntry =
  | { id: string; control: 'text' | 'number'; required: boolean; options?: never }
  | { id: string; control: 'select' | 'radio'; required: boolean; options: string[] }
export interface YidaProtocolBaseConfig {
  version: 2
  kind: 'yida-form-protocol-static'
  target: YidaStaticTarget
  businessKey: string[]
  emptyKeyFields: string[]
  fieldMap: YidaStaticFieldMapEntry[]
  fieldCatalog: YidaProtocolCatalogEntry[]
}
export type YidaProtocolConfig =
  | (YidaProtocolBaseConfig & { intent: 'create'; instanceIdField?: never })
  | (YidaProtocolBaseConfig & { intent: 'update'; instanceIdField: string })
export type YidaStaticConfig = YidaStaticV1Config | YidaProtocolConfig

export type YidaStaticConfigIssueCode =
  | 'CONFIG_SHAPE_INVALID'
  | 'CONFIG_UNEXPECTED_FIELD'
  | 'CONFIG_KIND_INVALID'
  | 'CONFIG_TARGET_INVALID'
  | 'CONFIG_INTENT_INVALID'
  | 'CONFIG_INSTANCE_ID_INVALID'
  | 'CONFIG_FIELD_MAP_INVALID'
  | 'CONFIG_KEY_INVALID'
  | 'CONFIG_FIELD_CATALOG_INVALID'
  | 'CONFIG_EMPTY_KEY_FIELDS_INVALID'
export interface YidaStaticConfigIssue {
  code: YidaStaticConfigIssueCode
  field: string
}
export type YidaStaticValidationResult =
  | { valid: true; normalized: YidaStaticConfig; issues?: never }
  | { valid: false; issues: YidaStaticConfigIssue[]; normalized?: never }

export type YidaStaticPlanErrorCode =
  | 'YIDA_STATIC_CONFIG_INVALID'
  | 'YIDA_STATIC_INPUT_INVALID'
  | 'YIDA_STATIC_TEXT_INVALID'
  | 'YIDA_STATIC_TEXT_TOO_LARGE'
  | 'YIDA_STATIC_ROWS_INVALID'
  | 'YIDA_STATIC_ROWS_LIMIT'
  | 'YIDA_STATIC_EXAMPLE_INVALID'
export class YidaStaticPlanError extends Error {
  constructor(code: YidaStaticPlanErrorCode)
  code: YidaStaticPlanErrorCode
}

export type YidaStaticRowIssueCode =
  | 'KEY_MISSING'
  | 'FIELD_REQUIRED'
  | 'FIELD_TYPE'
  | 'INSTANCE_ID_MISSING'
  | 'DUPLICATE_LOCAL_KEY'
  | 'FIELD_OPTION_INVALID'
  | 'FIELD_NUMBER_INVALID'
export interface YidaStaticRowIssue {
  index: number
  code: YidaStaticRowIssueCode
  /** Fixed metadata projected from the validated mapping; no row values or catalog options. */
  fields?: Array<Pick<YidaStaticFieldMapEntry, 'source' | 'target' | 'type'>>
}
export interface YidaStaticPlanRow {
  index: number
  status: 'planned_create' | 'planned_update' | 'invalid'
  remoteState: 'unverified'
  localBusinessKey?: string
  payload?: Record<string, string | number | boolean>
  instanceId?: string
  protocolPreview?: {
    contract: 'dingtalk-yida-1.0-data-only'
    completeness: 'data_fields_only'
    data:
      | { appType: string; formUuid: string; formDataJson: string }
      | { appType: string; formInstanceId: string; updateFormDataJson: string }
  }
  issues: YidaStaticRowIssue[]
}
export interface YidaStaticPlan {
  kind: 'static_preview'
  status: 'not_applyable'
  canApply: false
  tokenIssued: false
  lookupExecuted: false
  externalWriteAttempted: false
  rows: YidaStaticPlanRow[]
  evidence: {
    rowCount: number
    plannedCreate: number
    plannedUpdate: number
    invalid: number
    duplicateKeyCount: number
  }
}
export interface YidaStaticExample {
  config: YidaStaticV1Config
  rows: YidaStaticRow[]
  text: string
}
export interface YidaProtocolExample {
  config: YidaProtocolConfig
  rows: YidaStaticRow[]
  text: string
}

export function validateYidaStaticConfig(input: unknown): YidaStaticValidationResult
/** Explicit configs require unique decoded JSON keys and raw decimal fidelity; v1 keeps its finite Number domain. Omitted config retains legacy parsing. */
export function parseYidaStaticRows(text: string, config?: YidaStaticConfig): YidaStaticRow[]
export function buildYidaStaticPlan(input: { config: unknown; rows: unknown }): YidaStaticPlan
export function createYidaStaticExample(variant?: 'primary' | 'renamed'): YidaStaticExample
export function createYidaProtocolExample(variant?: 'primary' | 'renamed'): YidaProtocolExample

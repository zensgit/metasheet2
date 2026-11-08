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
/** One part of a generated template (closed kinds, exact keys). */
export type YidaGeneratedTemplatePart =
  | { literal: string }
  /** A direct target; text verbatim, a number as String(n). */
  | { field: string }
  /** 1..16 string-typed direct targets covering every business-key target (rule G1); hashed as (target, value) pairs sorted by target, so the listed order is not part of the code. */
  | { hash: string[]; form: 'uuid-36' | 'uuid-32' }
  /** The frozen material-code-v1 generator; projectOf is a business-key target. */
  | { preset: 'material-code-v1'; rowIdOf: string; projectOf: string }
/** v3: one direct entry per source column; copy/constant/concat/generated are derived and never key parts. */
export type YidaTransformFieldMapEntry =
  | { transform: 'direct'; source: string; target: string; type: 'string' | 'number'; required: boolean }
  | { transform: 'copy'; copyOf: string; target: string; type: 'string' | 'number'; required: boolean }
  | { transform: 'constant'; value: string | number; target: string; type: 'string' | 'number'; required: boolean }
  | {
    transform: 'concat'
    parts: Array<{ source: string; literal?: never } | { literal: string; source?: never }>
    separator: string
    blank: 'skip' | 'refuse'
    target: string
    type: 'string'
    required: boolean
  }
  | {
    transform: 'generated'
    /** 1..8 parts, at least one not a literal, exactly one hash or preset (G1), field parts on at most one side of it. */
    template: YidaGeneratedTemplatePart[]
    target: string
    type: 'string'
    required: boolean
  }
export type YidaTransformName = YidaTransformFieldMapEntry['transform']
export interface YidaTransformBaseConfig {
  version: 3
  kind: 'yida-form-protocol-static'
  target: YidaStaticTarget
  /** Direct entry TARGET ids, bound by name to their primary entry. */
  businessKey: string[]
  /** Subset of businessKey (target ids) whose blank values share one identity. */
  emptyKeyFields: string[]
  fieldMap: YidaTransformFieldMapEntry[]
  fieldCatalog: YidaProtocolCatalogEntry[]
}
export type YidaTransformConfig =
  | (YidaTransformBaseConfig & { intent: 'create'; instanceIdField?: never })
  | (YidaTransformBaseConfig & { intent: 'update'; instanceIdField: string })
export type YidaStaticConfig = YidaStaticV1Config | YidaProtocolConfig | YidaTransformConfig

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
  | 'FIELD_PART_MISSING'
  | 'FIELD_VALUE_TOO_LONG'
  | 'DUPLICATE_GENERATED_VALUE'
export interface YidaStaticRowIssue {
  index: number
  code: YidaStaticRowIssueCode
  /**
   * Fixed metadata projected from the validated mapping; no row values or catalog options.
   * v3 adds the transform; constant, concat and generated fields have no single source column.
   */
  fields?: Array<{ source?: string; target: string; type: YidaStaticFieldType; transform?: YidaTransformName }>
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
/** The closed set of v3 transform names (R-71 ⑦.3). */
export const YIDA_TRANSFORM_NAMES: readonly YidaTransformName[]
/** Every row column a valid v3 config reads (direct sources and concat column parts), sorted. Throws YIDA_STATIC_CONFIG_INVALID otherwise. */
export function yidaTransformSourceColumns(config: unknown): readonly string[]
/**
 * The source columns ONE normalized field-map entry depends on, sorted and de-duplicated: direct → its source;
 * copy → its direct primary's source (needs the normalized config); concat → its column parts; constant → none;
 * generated → the sources of its field parts, hash members and preset inputs (needs the config, see generatedTemplateDependencies).
 * A v2 entry (no `transform`) binds exactly its `source`. Throws YIDA_STATIC_CONFIG_INVALID for an unknown kind.
 */
export function transformDependencies(entry: unknown, config?: unknown): readonly string[]
/** The source columns one generated entry of a valid v3 config reads (field parts, hash members, preset inputs), sorted. Throws YIDA_STATIC_CONFIG_INVALID otherwise. */
export function generatedTemplateDependencies(entry: unknown, config: unknown): readonly string[]
/**
 * P1 (2026-11-08): the canonical, values-free generated layout of a v3 config — every generated entry's target and whole
 * template (hash members sorted), entries sorted by target — which the send authority seals once per approved target.
 * null for a v1 / v2 config or a v3 config without a generated entry; throws YIDA_STATIC_CONFIG_INVALID otherwise.
 */
export interface YidaGeneratedLayout {
  version: 1
  kind: 'yida-generated-layout'
  entries: ReadonlyArray<{ target: string; template: readonly YidaGeneratedTemplatePart[] }>
}
export function yidaGeneratedLayout(config: unknown): YidaGeneratedLayout | null
/** Explicit configs require unique decoded JSON keys and raw decimal fidelity; v1 keeps its finite Number domain. Omitted config retains legacy parsing. */
export function parseYidaStaticRows(text: string, config?: YidaStaticConfig): YidaStaticRow[]
export function buildYidaStaticPlan(input: { config: unknown; rows: unknown }): YidaStaticPlan
export function createYidaStaticExample(variant?: 'primary' | 'renamed'): YidaStaticExample
export function createYidaProtocolExample(variant?: 'primary' | 'renamed'): YidaProtocolExample
export interface YidaTransformExample {
  config: YidaTransformConfig
  rows: YidaStaticRow[]
  text: string
  allocation: { mode: 'equal_integer'; projectField: string; quantityField: string }
}
export function createYidaTransformExample(): YidaTransformExample

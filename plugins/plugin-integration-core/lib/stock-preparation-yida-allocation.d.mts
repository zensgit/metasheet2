import type { YidaStaticConfig, YidaStaticPlan, YidaStaticPlanRow, YidaStaticRowIssueCode } from './yida-static-plan.mjs'

export type YidaAllocationMode = 'equal_integer' | 'equal_decimal_exact'
export interface YidaAllocationRules {
  mode: YidaAllocationMode
  projectField: string
  quantityField: string
}
export interface YidaAllocationSettings extends YidaAllocationRules {
  projects: string[]
}
export function validateYidaProjectAllocationRules(config: unknown, rules: unknown): YidaAllocationRules
export type YidaAllocationErrorCode =
  | 'YIDA_ALLOCATION_INPUT_INVALID'
  | 'YIDA_ALLOCATION_CONFIG_INVALID'
  | 'YIDA_ALLOCATION_INTENT_INVALID'
  | 'YIDA_ALLOCATION_SETTINGS_INVALID'
  | 'YIDA_ALLOCATION_PROJECTS_INVALID'
  | 'YIDA_ALLOCATION_FIELDS_INVALID'
  | 'YIDA_ALLOCATION_ROWS_INVALID'
  | 'YIDA_ALLOCATION_ROWS_LIMIT'
export class YidaAllocationError extends Error {
  constructor(code: YidaAllocationErrorCode)
  code: YidaAllocationErrorCode
}
export type YidaAllocationIssueCode =
  | 'QUANTITY_INVALID'
  | 'QUANTITY_PRECISION'
  | 'QUANTITY_RANGE'
  | 'QUANTITY_NOT_DIVISIBLE'
  | 'EXPANDED_ROWS_LIMIT'
  | 'EXPANDED_TEXT_LIMIT'
export interface YidaAllocationIssue {
  index: number | null
  code: YidaAllocationIssueCode
}
export interface YidaAllocationCandidate {
  expandedIndex: number
  project: string
  status: YidaStaticPlanRow['status']
  issues: YidaStaticRowIssueCode[]
}
export interface YidaAllocationAnalysis {
  sourceIndex: number
  sourceTotal: number | null
  projectCount: number
  perProjectQuantity?: number
  allocatedTotal?: number
  difference?: number
  /** Allocation arithmetic only; a conserved quantity does not imply a valid candidate. */
  issues: YidaAllocationIssueCode[]
  /** Actual planner results for this source, empty when allocation refuses before planning. */
  candidates: YidaAllocationCandidate[]
}
export interface YidaProjectAllocationPreview {
  kind: 'project_allocation_preview'
  status: 'not_applyable'
  canApply: false
  tokenIssued: false
  lookupExecuted: false
  externalWriteAttempted: false
  plan: YidaStaticPlan | null
  analysis: YidaAllocationAnalysis[]
  issues: YidaAllocationIssue[]
  evidence: {
    sourceRows: number
    projectCount: number
    expandedRows: number
    /** Distinct invalid candidate origins, or arithmetic-invalid sources when plan is null. */
    invalidSourceRows: number
  }
}
export function buildYidaProjectAllocationPreview(input: {
  config: YidaStaticConfig
  rowsText: string
  allocation: YidaAllocationSettings
}): YidaProjectAllocationPreview

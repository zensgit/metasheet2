import type { YidaStaticV1Config, YidaProtocolConfig } from './yida-static-plan.mjs'
import type { YidaAllocationRules } from './stock-preparation-yida-allocation.mjs'

type WithoutTarget<T> = T extends unknown ? Omit<T, 'target'> : never
export type YidaRuleTemplateRules = WithoutTarget<YidaStaticV1Config> | WithoutTarget<YidaProtocolConfig>
export type YidaRuleTemplateAllocation = { mode: 'original' } | YidaAllocationRules
export interface YidaRuleTemplateEnvelope {
  readonly formatVersion: 1
  readonly kind: 'stock-preparation-yida-rule-template'
  readonly status: 'local-unverified'
  readonly rules: YidaRuleTemplateRules
  readonly allocation: YidaRuleTemplateAllocation
}
export type YidaRuleTemplateErrorCode =
  | 'YIDA_RULE_TEMPLATE_INPUT'
  | 'YIDA_RULE_TEMPLATE_TEXT'
  | 'YIDA_RULE_TEMPLATE_LIMIT'
  | 'YIDA_RULE_TEMPLATE_CONFIG'
  | 'YIDA_RULE_TEMPLATE_ALLOCATION'
export class YidaRuleTemplateError extends Error {
  constructor(kind?: 'INPUT' | 'TEXT' | 'LIMIT' | 'CONFIG' | 'ALLOCATION')
  code: YidaRuleTemplateErrorCode
}
export function exportYidaRuleTemplate(input: { rules: unknown; allocation: unknown }): string
export function parseYidaRuleTemplate(text: string): YidaRuleTemplateEnvelope

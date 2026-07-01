import { normalizeBpmnHttpTaskEgressPolicyConfig } from '../guards/egress-policy-normalizer'
import type { EgressPolicyNormalizationResult } from '../guards/egress-policy-normalizer'
import type { BPMNWorkflowEngineOptions } from './BPMNWorkflowEngine'

export const BPMN_HTTP_TASK_EGRESS_POLICY_ENV = 'BPMN_HTTP_TASK_EGRESS_POLICY'

type BpmnHttpTaskEgressPolicyEnv = Readonly<Record<string, string | undefined>>

export function loadBpmnHttpTaskEgressPolicyFromServerConfig(
  env: BpmnHttpTaskEgressPolicyEnv = process.env,
): EgressPolicyNormalizationResult {
  return normalizeBpmnHttpTaskEgressPolicyConfig(env[BPMN_HTTP_TASK_EGRESS_POLICY_ENV])
}

export function buildBpmnWorkflowEngineOptionsFromServerConfig(
  env: BpmnHttpTaskEgressPolicyEnv = process.env,
): BPMNWorkflowEngineOptions {
  const loaded = loadBpmnHttpTaskEgressPolicyFromServerConfig(env)
  return {
    httpTaskEgress: {
      policy: loaded.policy,
    },
  }
}

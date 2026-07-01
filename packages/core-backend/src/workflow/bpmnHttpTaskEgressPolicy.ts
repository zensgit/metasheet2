import { normalizeBpmnHttpTaskEgressPolicyConfig } from '../guards/egress-policy-normalizer'
import type { EgressPolicyNormalizationResult } from '../guards/egress-policy-normalizer'
import type { EgressPolicy } from '../guards/egress-guard'

export const BPMN_HTTP_TASK_EGRESS_POLICY_ENV = 'BPMN_HTTP_TASK_EGRESS_POLICY'

type BpmnHttpTaskEgressPolicyEnv = Readonly<Record<string, string | undefined>>

export interface BpmnWorkflowEngineEgressPolicyOptions {
  httpTaskEgress: {
    policy: EgressPolicy
  }
}

export function loadBpmnHttpTaskEgressPolicyFromServerConfig(
  env: BpmnHttpTaskEgressPolicyEnv = process.env,
): EgressPolicyNormalizationResult {
  return normalizeBpmnHttpTaskEgressPolicyConfig(env[BPMN_HTTP_TASK_EGRESS_POLICY_ENV])
}

export function buildBpmnWorkflowEngineOptionsFromServerConfig(
  env: BpmnHttpTaskEgressPolicyEnv = process.env,
): BpmnWorkflowEngineEgressPolicyOptions {
  const loaded = loadBpmnHttpTaskEgressPolicyFromServerConfig(env)
  return {
    httpTaskEgress: {
      policy: loaded.policy,
    },
  }
}

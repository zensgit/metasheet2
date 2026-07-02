import { describe, expect, test } from 'vitest'

import {
  BPMN_HTTP_TASK_EGRESS_POLICY_ENV,
  buildBpmnWorkflowEngineOptionsFromServerConfig,
  loadBpmnHttpTaskEgressPolicyFromServerConfig,
} from '../bpmnHttpTaskEgressPolicy'

describe('BPMN HTTP-task egress policy server config', () => {
  test('missing config builds a fail-closed default policy', () => {
    const result = loadBpmnHttpTaskEgressPolicyFromServerConfig({})

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'EGRESS_POLICY_MISSING', field: 'config' },
      policy: { allowedHosts: [] },
      metadata: {
        policyPresent: false,
        allowedHostCount: 0,
        nat64PrefixCount: 0,
        policyFingerprint: null,
      },
    })
    expect(buildBpmnWorkflowEngineOptionsFromServerConfig({})).toEqual({
      httpTaskEgress: {
        policy: {
          allowedHosts: [],
          nat64Prefixes: [],
        },
      },
    })
  })

  test('malformed config remains fail-closed and does not echo raw config in metadata', () => {
    const raw = 'not-json-with-secret-host.example.com'
    const result = loadBpmnHttpTaskEgressPolicyFromServerConfig({
      [BPMN_HTTP_TASK_EGRESS_POLICY_ENV]: raw,
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'EGRESS_POLICY_MALFORMED', field: 'config' },
      policy: { allowedHosts: [] },
    })
    expect(JSON.stringify(result.metadata)).not.toContain('secret-host')
  })

  test('valid server config becomes the shared engine egress policy', () => {
    const options = buildBpmnWorkflowEngineOptionsFromServerConfig({
      [BPMN_HTTP_TASK_EGRESS_POLICY_ENV]: JSON.stringify({
        allowedHosts: ['API.Example.com.'],
        nat64Prefixes: ['2A00:1098:2C::/96'],
      }),
    })

    expect(options).toEqual({
      httpTaskEgress: {
        policy: {
          allowedHosts: ['api.example.com'],
          nat64Prefixes: ['2a00:1098:2c:0:0:0:0:0/96'],
        },
      },
    })
  })
})

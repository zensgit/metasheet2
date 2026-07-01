import { describe, expect, test } from 'vitest'

import {
  BPMNWorkflowEngine,
  type ProcessInstance,
} from '../BPMNWorkflowEngine'
import type { PinnedEgressRequest, PinnedEgressTransport } from '../../guards/egress-dispatcher'
import type { EgressPolicy } from '../../guards/egress-guard'
import {
  BPMN_HTTP_TASK_EGRESS_POLICY_ENV,
  buildBpmnWorkflowEngineOptionsFromServerConfig,
} from '../bpmnHttpTaskEgressPolicy'

function testInstance(id = 'inst_1'): ProcessInstance {
  return {
    id,
    processDefinitionId: 'proc_def_1',
    processDefinitionKey: 'test_process',
    state: 'ACTIVE',
    variables: {},
    startTime: new Date('2026-07-01T00:00:00Z'),
  }
}

function makeEngine(options: {
  policy?: EgressPolicy
  resolvedAddress?: string
  transport?: PinnedEgressTransport
} = {}) {
  const calls: PinnedEgressRequest[] = []
  let resolved = false
  let transported = false
  const transport = options.transport ?? (async (request: PinnedEgressRequest) => {
    transported = true
    calls.push(request)
    return { status: 200, body: { ok: true } }
  })
  const engine = new BPMNWorkflowEngine({
    httpTaskEgress: {
      policy: options.policy,
      resolveAddresses: async () => {
        resolved = true
        return [{ address: options.resolvedAddress ?? '8.8.8.8', family: 4 }]
      },
      transport,
    },
  })
  return {
    engine,
    calls,
    resolved: () => resolved,
    transported: () => transported,
  }
}

function installInstance(engine: BPMNWorkflowEngine, instance: ProcessInstance) {
  const anyEngine = engine as any
  anyEngine.runningInstances.set(instance.id, instance)
  anyEngine.updateProcessVariables = async (_instanceId: string, variables: Record<string, unknown>) => {
    instance.variables = { ...instance.variables, ...variables }
  }
}

async function executeHttpTask(
  engine: BPMNWorkflowEngine,
  instanceId: string,
  props: Record<string, unknown>,
) {
  await (engine as any).executeHttpTask(instanceId, props)
}

describe('BPMN HTTP task egress wiring', () => {
  test('routes HTTP tasks through the pinned egress dispatcher and stores the JSON body', async () => {
    const { engine, calls } = makeEngine({ policy: { allowedHosts: ['api.example.com'] } })
    const instance = testInstance()
    installInstance(engine, instance)

    await executeHttpTask(engine, instance.id, {
      url: 'https://api.example.com/hook',
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: { hello: 'world' },
      responseVariable: 'httpResult',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      normalizedUrl: 'https://api.example.com/hook',
      hostname: 'api.example.com',
      pinnedAddress: '8.8.8.8',
      family: 4,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{"hello":"world"}',
      redirect: 'manual',
    })
    expect(instance.variables.httpResult).toEqual({ ok: true })
  })

  test('server-owned A3 policy enables an allowlisted host through mocked DNS and transport', async () => {
    const calls: PinnedEgressRequest[] = []
    const engineOptions = buildBpmnWorkflowEngineOptionsFromServerConfig({
      [BPMN_HTTP_TASK_EGRESS_POLICY_ENV]: JSON.stringify({
        allowedHosts: ['api.example.com'],
      }),
    })
    const engine = new BPMNWorkflowEngine({
      httpTaskEgress: {
        ...engineOptions.httpTaskEgress,
        resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
        transport: async (request) => {
          calls.push(request)
          return { status: 200, body: { ok: true } }
        },
      },
    })
    const instance = testInstance()
    installInstance(engine, instance)

    await executeHttpTask(engine, instance.id, {
      url: 'https://api.example.com/hook',
      responseVariable: 'httpResult',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      normalizedUrl: 'https://api.example.com/hook',
      hostname: 'api.example.com',
      pinnedAddress: '8.8.8.8',
    })
    expect(instance.variables.httpResult).toEqual({ ok: true })
  })

  test('server-owned A3 policy denies off-allowlist hosts before DNS or transport', async () => {
    const engineOptions = buildBpmnWorkflowEngineOptionsFromServerConfig({
      [BPMN_HTTP_TASK_EGRESS_POLICY_ENV]: JSON.stringify({
        allowedHosts: ['api.example.com'],
      }),
    })
    const engine = new BPMNWorkflowEngine({
      httpTaskEgress: {
        ...engineOptions.httpTaskEgress,
        resolveAddresses: async () => {
          throw new Error('DNS should not run')
        },
        transport: async () => {
          throw new Error('transport should not run')
        },
      },
    })
    const instance = testInstance()
    installInstance(engine, instance)

    await expect(executeHttpTask(engine, instance.id, {
      url: 'https://evil.example.com/hook',
      responseVariable: 'httpResult',
    })).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: HOST_NOT_ALLOWLISTED')
    expect(instance.variables.httpResult).toBeUndefined()
  })

  test('malformed server-owned A3 policy remains fail-closed before DNS or transport', async () => {
    const engineOptions = buildBpmnWorkflowEngineOptionsFromServerConfig({
      [BPMN_HTTP_TASK_EGRESS_POLICY_ENV]: '{not json',
    })
    const engine = new BPMNWorkflowEngine({
      httpTaskEgress: {
        ...engineOptions.httpTaskEgress,
        resolveAddresses: async () => {
          throw new Error('DNS should not run')
        },
        transport: async () => {
          throw new Error('transport should not run')
        },
      },
    })
    const instance = testInstance()
    installInstance(engine, instance)

    await expect(executeHttpTask(engine, instance.id, {
      url: 'https://api.example.com/hook',
      responseVariable: 'httpResult',
    })).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: ALLOWLIST_REQUIRED')
    expect(instance.variables.httpResult).toBeUndefined()
  })

  test('fails closed by default before DNS or transport when no allowlist policy is configured', async () => {
    const { engine, resolved, transported } = makeEngine()
    const instance = testInstance()
    installInstance(engine, instance)

    await expect(executeHttpTask(engine, instance.id, {
      url: 'https://api.example.com/hook',
      responseVariable: 'httpResult',
    })).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: ALLOWLIST_REQUIRED')

    expect(resolved()).toBe(false)
    expect(transported()).toBe(false)
    expect(instance.variables.httpResult).toBeUndefined()
  })

  test('does not treat workflow variables as egress policy configuration', async () => {
    const { engine, resolved, transported } = makeEngine()
    const instance = testInstance()
    instance.variables = {
      allowedHosts: ['api.example.com'],
      nat64Prefixes: ['2a00:1098:2c::/96'],
      httpTaskEgress: {
        policy: {
          allowedHosts: ['api.example.com'],
          nat64Prefixes: ['2a00:1098:2c::/96'],
        },
      },
    }
    installInstance(engine, instance)

    await expect(executeHttpTask(engine, instance.id, {
      url: 'https://api.example.com/hook',
      responseVariable: 'httpResult',
    })).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: ALLOWLIST_REQUIRED')

    expect(resolved()).toBe(false)
    expect(transported()).toBe(false)
    expect(instance.variables.httpResult).toBeUndefined()
  })

  test('blocks private DNS answers before transport', async () => {
    const { engine, transported } = makeEngine({
      policy: { allowedHosts: ['api.example.com'] },
      resolvedAddress: '169.254.169.254',
    })
    const instance = testInstance()
    installInstance(engine, instance)

    await expect(executeHttpTask(engine, instance.id, {
      url: 'https://api.example.com/hook',
      responseVariable: 'httpResult',
    })).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: DNS_IP_BLOCKED')

    expect(transported()).toBe(false)
    expect(instance.variables.httpResult).toBeUndefined()
  })

  test('rejects unsafe methods and credential/forwarding headers before dispatch', async () => {
    const { engine, resolved, transported } = makeEngine({ policy: { allowedHosts: ['api.example.com'] } })
    const instance = testInstance()
    installInstance(engine, instance)

    await expect(executeHttpTask(engine, instance.id, {
      url: 'https://api.example.com/hook',
      method: 'DELETE',
    })).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: METHOD_NOT_ALLOWED')

    for (const headers of [
      { Host: 'evil.example.com' },
      { Authorization: 'Bearer SECRET_TOKEN' },
      { Cookie: 'session=SECRET' },
      { Forwarded: 'for=127.0.0.1' },
      { 'X-Forwarded-Host': 'internal.local' },
      { 'Proxy-Authorization': 'Basic SECRET' },
    ]) {
      await expect(executeHttpTask(engine, instance.id, {
        url: 'https://api.example.com/hook',
        headers,
      })).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: HEADER_NOT_ALLOWED')
    }

    expect(resolved()).toBe(false)
    expect(transported()).toBe(false)
  })

  test('rejects oversized header sets before dispatch', async () => {
    const { engine, resolved, transported } = makeEngine({ policy: { allowedHosts: ['api.example.com'] } })
    const instance = testInstance()
    installInstance(engine, instance)

    await expect(executeHttpTask(engine, instance.id, {
      url: 'https://api.example.com/hook',
      headers: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`X-Test-${index}`, 'ok'])),
    })).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: HEADER_NOT_ALLOWED')

    await expect(executeHttpTask(engine, instance.id, {
      url: 'https://api.example.com/hook',
      headers: { 'X-Large': 'x'.repeat(8 * 1024) },
    })).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: HEADER_NOT_ALLOWED')

    expect(resolved()).toBe(false)
    expect(transported()).toBe(false)
  })
})

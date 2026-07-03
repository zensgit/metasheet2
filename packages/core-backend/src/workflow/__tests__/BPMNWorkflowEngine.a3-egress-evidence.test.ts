import { describe, expect, test } from 'vitest'

import {
  BPMNWorkflowEngine,
  type ProcessInstance,
} from '../BPMNWorkflowEngine'
import type {
  EgressAddressResolver,
  PinnedEgressResponse,
  PinnedEgressTransport,
} from '../../guards/egress-dispatcher'
import {
  BPMN_HTTP_TASK_EGRESS_POLICY_ENV,
  buildBpmnWorkflowEngineOptionsFromServerConfig,
} from '../bpmnHttpTaskEgressPolicy'

/**
 * A3 — BPMN HTTP-task egress destination authorization: values-free evidence smoke.
 *
 * This is decision A3's proof artifact for the third-batch ballot, not a new runtime.
 * The egress runtime (egress-guard / egress-dispatcher / egress-pinned-transport +
 * the server-owned BPMN_HTTP_TASK_EGRESS_POLICY normalizer, wired into
 * BPMNWorkflowEngine.executeHttpTask) is already shipped (#3455/#3457/#3460).
 *
 * Every case here builds the engine's policy through the ALREADY-SHIPPED normalized
 * env path — `buildBpmnWorkflowEngineOptionsFromServerConfig(env)` — per the ballot's
 * build/ops contract ("must use the already-shipped normalized policy path, not a
 * local bypass"). Only DNS resolution and the outbound transport are injected as
 * mocks so the smoke never performs live outbound I/O.
 *
 * A2 (host entry shape): exactly one exact ASCII DNS host is authorized.
 * A3 (evidence/smoke): an allowed host reaches the mocked transport; a disallowed
 *   host, a host that resolves to a private/internal address, and a redirect toward a
 *   private/disallowed destination are all DENIED.
 * A4 (rollback): blanking or removing the env policy returns the engine to deny-all,
 *   proven purely through the env-string -> normalizer -> policy-object path (no DB
 *   handle, no migration, no tenant rewrite is present anywhere in this file).
 *
 * VALUES-FREE GUARANTEE. Assertions touch ONLY: the allow/deny outcome (throw or not),
 * the `BPMN_HTTP_EGRESS_DENIED: <REASON>` reason code (full prefixed string so
 * `IP_BLOCKED` never aliases `DNS_IP_BLOCKED` under substring matching), and whether
 * DNS/transport were reached (call counts). No request/response body, no header value,
 * no secret, and no real destination URL/host is asserted or embedded. The only DNS
 * names are the synthetic `allowed.example` / `blocked.example`. The IP literals are
 * structural range fixtures for the guard's address classifier — a routable public
 * unicast stand-in and a link-local/internal address the guard must block — never a
 * business destination and never a secret.
 */

// A2: a single exact ASCII DNS host, authorized only through the server-owned env policy.
const ALLOWED_HOST = 'allowed.example'
const DISALLOWED_HOST = 'blocked.example'
const POLICY_ENV_VALUE = JSON.stringify({ allowedHosts: [ALLOWED_HOST] })

// Structural IP-range classifier fixtures (NOT destinations, NOT secrets):
// `11.22.33.44` classifies as `unicast` (a routable public stand-in the guard permits);
// `169.254.169.254` is link-local/internal metadata space the guard must always block.
const PUBLIC_UNICAST_ADDRESS = '11.22.33.44'
const PRIVATE_INTERNAL_ADDRESS = '169.254.169.254'

const ALLOWED_URL = `https://${ALLOWED_HOST}/hook`
const DISALLOWED_URL = `https://${DISALLOWED_HOST}/hook`

/** Minimal typed seam onto the engine's private HTTP-task surface — honours "no `any`". */
interface EngineTestSeam {
  runningInstances: Map<string, ProcessInstance>
  updateProcessVariables(instanceId: string, variables: Record<string, unknown>): Promise<void>
  executeHttpTask(instanceId: string, props: Record<string, unknown>): Promise<void>
}

function testInstance(id = 'inst_a3'): ProcessInstance {
  return {
    id,
    processDefinitionId: 'proc_def_a3',
    processDefinitionKey: 'a3_evidence_process',
    state: 'ACTIVE',
    variables: {},
    startTime: new Date('2026-07-03T00:00:00Z'),
  }
}

interface EgressSpyState {
  resolveCount: number
  transportCount: number
}

interface EgressSpies {
  resolveAddresses: EgressAddressResolver
  transport: PinnedEgressTransport
  state: EgressSpyState
}

/**
 * DNS + transport spies. Both only count invocations and return the minimal shape the
 * dispatcher needs; neither reads or emits any request/response payload, so the harness
 * itself carries no values to leak.
 */
function egressSpies(params: {
  resolvedAddress?: string
  transportResponse?: PinnedEgressResponse
} = {}): EgressSpies {
  const state: EgressSpyState = { resolveCount: 0, transportCount: 0 }
  const resolveAddresses: EgressAddressResolver = async () => {
    state.resolveCount += 1
    return [{ address: params.resolvedAddress ?? PUBLIC_UNICAST_ADDRESS, family: 4 }]
  }
  const transport: PinnedEgressTransport = async () => {
    state.transportCount += 1
    return params.transportResponse ?? { status: 200 }
  }
  return { resolveAddresses, transport, state }
}

/**
 * Build an engine whose egress policy comes from the shipped env normalizer.
 * `policyEnvValue === undefined` models the env var being absent; `''` models it blanked.
 */
function makeEngineFromEnv(params: {
  policyEnvValue: string | undefined
  spies: EgressSpies
}): { seam: EngineTestSeam; instance: ProcessInstance } {
  const env: Record<string, string | undefined> =
    params.policyEnvValue === undefined
      ? {}
      : { [BPMN_HTTP_TASK_EGRESS_POLICY_ENV]: params.policyEnvValue }
  const options = buildBpmnWorkflowEngineOptionsFromServerConfig(env)

  const engine = new BPMNWorkflowEngine({
    httpTaskEgress: {
      ...options.httpTaskEgress,
      resolveAddresses: params.spies.resolveAddresses,
      transport: params.spies.transport,
    },
  })

  const instance = testInstance()
  const seam = engine as unknown as EngineTestSeam
  seam.runningInstances.set(instance.id, instance)
  seam.updateProcessVariables = async (_instanceId, variables) => {
    instance.variables = { ...instance.variables, ...variables }
  }
  return { seam, instance }
}

describe('A3 BPMN HTTP-task egress destination authorization (values-free evidence)', () => {
  test('ALLOW: an allowlisted host resolves to the mocked transport and is permitted', async () => {
    const spies = egressSpies()
    const { seam } = makeEngineFromEnv({ policyEnvValue: POLICY_ENV_VALUE, spies })

    await expect(
      seam.executeHttpTask('inst_a3', { url: ALLOWED_URL, responseVariable: 'httpResult' }),
    ).resolves.toBeUndefined()

    // Allow is proven by the transport being reached exactly once with no denial thrown.
    expect(spies.state.resolveCount).toBe(1)
    expect(spies.state.transportCount).toBe(1)
  })

  test('DENY: a disallowed host is refused before DNS or transport', async () => {
    const spies = egressSpies()
    const { seam } = makeEngineFromEnv({ policyEnvValue: POLICY_ENV_VALUE, spies })

    await expect(
      seam.executeHttpTask('inst_a3', { url: DISALLOWED_URL, responseVariable: 'httpResult' }),
    ).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: HOST_NOT_ALLOWLISTED')

    expect(spies.state.resolveCount).toBe(0)
    expect(spies.state.transportCount).toBe(0)
  })

  test('DENY: an allowlisted host that resolves to a private/internal address is refused before transport', async () => {
    const spies = egressSpies({ resolvedAddress: PRIVATE_INTERNAL_ADDRESS })
    const { seam } = makeEngineFromEnv({ policyEnvValue: POLICY_ENV_VALUE, spies })

    await expect(
      seam.executeHttpTask('inst_a3', { url: ALLOWED_URL, responseVariable: 'httpResult' }),
    ).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: DNS_IP_BLOCKED')

    // DNS ran (that is how the private answer was caught); transport never dispatched.
    expect(spies.state.resolveCount).toBe(1)
    expect(spies.state.transportCount).toBe(0)
  })

  test('DENY: a redirect from the allowed host toward a private/internal address is re-authorized and refused', async () => {
    const spies = egressSpies({
      transportResponse: {
        status: 302,
        headers: { location: `https://${PRIVATE_INTERNAL_ADDRESS}/next` },
      },
    })
    const { seam } = makeEngineFromEnv({ policyEnvValue: POLICY_ENV_VALUE, spies })

    await expect(
      seam.executeHttpTask('inst_a3', { url: ALLOWED_URL, responseVariable: 'httpResult' }),
    ).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: IP_BLOCKED')

    // The first hop reached the transport (the allowed host); the redirect target was
    // re-validated and blocked, so it was never dispatched (transportCount stays 1).
    expect(spies.state.transportCount).toBe(1)
  })

  test('DENY: a redirect from the allowed host toward an off-allowlist host is re-authorized and refused', async () => {
    const spies = egressSpies({
      transportResponse: {
        status: 302,
        headers: { location: DISALLOWED_URL },
      },
    })
    const { seam } = makeEngineFromEnv({ policyEnvValue: POLICY_ENV_VALUE, spies })

    await expect(
      seam.executeHttpTask('inst_a3', { url: ALLOWED_URL, responseVariable: 'httpResult' }),
    ).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: HOST_NOT_ALLOWLISTED')

    // First hop dispatched to the allowed host; the redirect target was denied at
    // re-validation and never dispatched.
    expect(spies.state.transportCount).toBe(1)
  })

  test('A4 ROLLBACK: blanking the env policy returns the engine to deny-all for the previously allowed host (no DB, no migration)', async () => {
    // Before: the exact host is authorized purely through the env policy and reaches transport.
    const beforeSpies = egressSpies()
    const before = makeEngineFromEnv({ policyEnvValue: POLICY_ENV_VALUE, spies: beforeSpies })
    await expect(
      before.seam.executeHttpTask('inst_a3', { url: ALLOWED_URL, responseVariable: 'httpResult' }),
    ).resolves.toBeUndefined()
    expect(beforeSpies.state.transportCount).toBe(1)

    // After: blank the env policy. The rollback is a pure env-string -> normalizer -> policy
    // change; no database handle, migration, or tenant rewrite exists in this path. The same
    // host that was allowed above is now denied deny-all.
    const afterSpies = egressSpies()
    const after = makeEngineFromEnv({ policyEnvValue: '', spies: afterSpies })
    await expect(
      after.seam.executeHttpTask('inst_a3', { url: ALLOWED_URL, responseVariable: 'httpResult' }),
    ).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: ALLOWLIST_REQUIRED')
    expect(afterSpies.state.resolveCount).toBe(0)
    expect(afterSpies.state.transportCount).toBe(0)
  })

  test('A4 ROLLBACK: removing the env policy key returns the engine to deny-all (no DB, no migration)', async () => {
    const spies = egressSpies()
    const { seam } = makeEngineFromEnv({ policyEnvValue: undefined, spies })

    await expect(
      seam.executeHttpTask('inst_a3', { url: ALLOWED_URL, responseVariable: 'httpResult' }),
    ).rejects.toThrow('BPMN_HTTP_EGRESS_DENIED: ALLOWLIST_REQUIRED')

    expect(spies.state.resolveCount).toBe(0)
    expect(spies.state.transportCount).toBe(0)
  })
})

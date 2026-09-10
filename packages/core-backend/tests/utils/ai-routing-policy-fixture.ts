/**
 * Synthetic COMPLIANT routing-policy fixture for the multitable-AI suites.
 *
 * The shipped shortcut / bulk-fill path is now data-class governed: its prompts
 * carry customer record content, so `runShortcutCore` refuses to call a provider
 * unless the deployment's routing policy resolves to a LOCAL (self-hosted)
 * provider. A suite that simulates a WORKING AI deployment must therefore also
 * simulate a COMPLIANT one — otherwise it is asserting behaviour no correctly
 * governed deployment can produce.
 *
 * This mirrors the outbound-http-write gate's #5247 precedent: when a default-deny
 * capability gate landed, the one suite exercising it was pointed at a synthetic
 * allowlist fixture rather than deleted or watered down. Same move here — three
 * lines per suite, and the suites keep asserting exactly what they asserted before.
 *
 * The policy declares `local` and the base URL is an RFC1918 address, so it passes
 * the POSITIVE local check (a declaration alone is not enough).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const AI_ROUTING_POLICY_ENV = 'MULTITABLE_AI_ROUTING_POLICY'

/** Env keys a suite must save/restore when it arms this fixture. */
export const AI_ROUTING_FIXTURE_ENV_KEYS = [AI_ROUTING_POLICY_ENV, 'MULTITABLE_AI_BASE_URL'] as const

/** A private, self-hosted-looking endpoint that passes the positive local check. */
export const LOCAL_AI_BASE_URL = 'http://10.77.0.5:8000'

let cachedPolicyPath: string | null = null

/** Write (once per process) a compliant local routing policy and return its path. */
export function localAiRoutingPolicyPath(): string {
  if (cachedPolicyPath) return cachedPolicyPath
  const dir = mkdtempSync(join(tmpdir(), 'ai-policy-fixture-'))
  const path = join(dir, 'routing-policy.json')
  writeFileSync(
    path,
    JSON.stringify({
      policyId: 'test-fixture-local',
      policyVersion: 1,
      activeProvider: { tier: 'local' },
    }),
    'utf8',
  )
  cachedPolicyPath = path
  return path
}

/**
 * Arm a compliant LOCAL routing policy on `process.env`. Call inside the same
 * `beforeEach` that sets the other MULTITABLE_AI_* vars, and include
 * AI_ROUTING_FIXTURE_ENV_KEYS in the suite's save/restore list.
 *
 * `baseUrl` is overridable for suites that need a specific host — it must still
 * pass the positive local check (a private address or a private DNS suffix).
 */
export function armLocalAiRoutingPolicy(baseUrl: string = LOCAL_AI_BASE_URL): void {
  process.env[AI_ROUTING_POLICY_ENV] = localAiRoutingPolicyPath()
  process.env.MULTITABLE_AI_BASE_URL = baseUrl
}

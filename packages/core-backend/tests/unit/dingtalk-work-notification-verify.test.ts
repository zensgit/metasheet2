/**
 * Explicit verification of a DingTalk integration's work-notification credentials
 * (integrations/dingtalk/work-notification-verify.ts).
 *
 * What is pinned, and how each pin can go red:
 *  - SAME RESOLVER (parity): the verification calls the exported readDingTalkIntegrationScopedMessageTuple
 *    exactly once (module spy), and the switch-ON branch of readDingTalkMessageConfigFromRuntime calls the
 *    injected reader exactly once (dependency injection) — an inline copy of the reader on either side is red.
 *    The default reader of that branch is pinned by source text to be the shared export itself (a private
 *    copy as the default, drift-free or not, is red). Fixture parity over the decision table: switch ON
 *    through the predicate mock → the send path's config or typed failure; switch OFF → the verification
 *    report; the config VALUES the send path resolved must deep-equal the tuple the verification resolved
 *    (compared inside the test, through the spy's return value — the report itself stays values-free), the
 *    typed failure codes must match, and both must read the row with the same query and parameters.
 *  - SWITCH INDEPENDENCE: the switch predicate is a mock; the verification never calls it (0 calls, with a
 *    positive control that the mock is live), its report is identical with the predicate answering false or
 *    true, the module's source names neither the switch module nor process.env, and the process.env key set
 *    is unchanged by a verification. No test here writes the switch key into process.env.
 *  - LEVEL SEPARATION: config makes no fetch; token makes one gettoken and nothing else, bypassing the
 *    shared token cache (a pre-seeded entry is neither used, overwritten nor evicted, and another caller's
 *    in-flight gettoken is not joined); send makes gettoken + asyncsend_v2 with the resolved Agent ID and
 *    the one recipient; a failure at a level never reports a higher one. The report's scope sentences are
 *    pinned word for word per REACHED level (none / config / token / send): the config pair never mentions
 *    DingTalk accepting anything, and a run that failed above the level it reached carries the reached
 *    level's pair. Token and send level are also exercised with a same-app env override, so the request
 *    that goes out is pinned to the env side of the tuple, not only to the row side.
 *  - VALUES-FREE: every credential is a synthetic label; the report, the audit meta and every string handed
 *    to the logger are checked to carry none of them — including the token failure whose own text carries
 *    the gettoken URL with the secret (stored baseUrl without a scheme).
 *
 * Nothing here talks to DingTalk: fetch is a stub, db/pg a mock. The flag module is mocked so the switch
 * state is a test input, not an environment variable.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

const flag = vi.hoisted(() => {
  const state = { on: false }
  return { state, predicate: vi.fn(() => state.on) }
})

vi.mock('../../src/db/pg', () => ({
  query: dbMocks.query,
}))

vi.mock('../../src/integrations/dingtalk/integration-scoped-credentials-flag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/dingtalk/integration-scoped-credentials-flag')>()
  return { ...actual, isDingTalkIntegrationScopedCredentialsEnabled: flag.predicate }
})

vi.mock('../../src/integrations/dingtalk/work-notification-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/dingtalk/work-notification-settings')>()
  // A pass-through spy on the one export the send path and the verification share.
  const readDingTalkIntegrationScopedMessageTuple = vi.fn(actual.readDingTalkIntegrationScopedMessageTuple)
  return { ...actual, readDingTalkIntegrationScopedMessageTuple }
})

import { Logger } from '../../src/core/logger'
import {
  __resetDingTalkAppAccessTokenCacheForTests,
  fetchDingTalkAppAccessToken,
} from '../../src/integrations/dingtalk/client'
import {
  DingTalkConfigValidationError,
  DingTalkMessageConfigError,
} from '../../src/integrations/dingtalk/config-validation-error'
import { DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED } from '../../src/integrations/dingtalk/integration-scoped-credentials-flag'
import {
  readDingTalkIntegrationScopedMessageTuple,
  readDingTalkMessageConfigFromRuntime,
  type DingTalkIntegrationScopedMessageTuple,
} from '../../src/integrations/dingtalk/work-notification-settings'
import {
  buildDingTalkWorkNotificationVerifyAuditMeta,
  verifyDingTalkWorkNotificationIntegration,
  type DingTalkWorkNotificationVerifyResult,
} from '../../src/integrations/dingtalk/work-notification-verify'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERIFY_SOURCE = fs.readFileSync(path.resolve(HERE, '../../src/integrations/dingtalk/work-notification-verify.ts'), 'utf8')
const SETTINGS_SOURCE = fs.readFileSync(path.resolve(HERE, '../../src/integrations/dingtalk/work-notification-settings.ts'), 'utf8')
const SWITCH = DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED

// Synthetic labels — every surface is asserted to carry none of them. The env-side and row-side labels of
// one field differ in LENGTH as well as value, so even the report's length fields tell the two sides apart.
const ENV_KEY = 'env-app-key-label'
const ENV_SECRET = 'env-app-secret-label'
const ENV_AGENT = '111111'
const ROW_KEY = 'row-side-app-key-label'
const ROW_SECRET = 'row-side-app-secret-label'
const ROW_AGENT = '2222222'
const ENV_BASE = 'https://env.example.test'
const ROW_BASE = 'https://row-side.example.test'
const PLACEHOLDER_AGENT = 'placeholder-agent-label'
const TOKEN_LABEL = 'access-token-label'
const FRESH_TOKEN_LABEL = 'fresh-token-label'
const PROVIDER_TEXT = 'provider-errmsg-label egress 203.0.113.7:443'
const CREDENTIAL_LABELS = [ENV_KEY, ENV_SECRET, ENV_AGENT, ROW_KEY, ROW_SECRET, ROW_AGENT, PLACEHOLDER_AGENT, TOKEN_LABEL, FRESH_TOKEN_LABEL, 'provider-errmsg-label', '203.0.113']
const INTEGRATION_ID = 'd1000000-0000-4000-8000-000000000001'
const RECIPIENT = 'manager001'

const scopedSpy = vi.mocked(readDingTalkIntegrationScopedMessageTuple)

// The scope sentences, word for word, as literals here on purpose (not imported from the module): a change
// to any sentence in the module is red here, and so is a report that carries another level's pair.
const NO_LEVEL_PROVES =
  'That any recipient routes to this integration (each sender maps recipient to integration by its own rule); anything about senders that resolve credentials by their own rule (task and e-learning notifications) or about the todo-mirror API.'
const SCOPE = {
  none: {
    proves: 'Nothing: the integration-scoped resolution did not yield a credential tuple for this integration (see failure). No request was made to DingTalk.',
    doesNotProve: `Anything about DingTalk accepting credentials or an Agent ID for this integration; delivery of any message to a device. ${NO_LEVEL_PROVES}`,
  },
  config: {
    proves: 'The integration-scoped resolution yields a complete credential tuple for this integration, from the side resolution.source names.',
    doesNotProve: `That DingTalk issues a token for these credentials (level token); that DingTalk takes a work notification with this Agent ID (level send); delivery of any message to a device. ${NO_LEVEL_PROVES}`,
  },
  token: {
    proves: 'DingTalk issued an access token, minted now with the shared token cache bypassed, for the appKey and appSecret the integration-scoped resolution chooses for this integration, at the resolved baseUrl.',
    doesNotProve: `That DingTalk takes a work notification with this Agent ID (level send); delivery of any message to a device. ${NO_LEVEL_PROVES}`,
  },
  send: {
    proves: 'DingTalk accepted one work notification sent with the resolved Agent ID to the one explicit recipient (errcode 0 with a task id).',
    doesNotProve: `Delivery of the test message to the device (only acceptance is observed). ${NO_LEVEL_PROVES}`,
  },
} as const

function storedRow(config: Record<string, unknown> = {}, status = 'active') {
  return {
    id: INTEGRATION_ID,
    name: 'DingTalk CN',
    status,
    updated_at: '2026-05-08T00:00:00.000Z',
    config: {
      appKey: ROW_KEY,
      appSecret: normalizeStoredSecretValue(ROW_SECRET),
      workNotificationAgentId: normalizeStoredSecretValue(ROW_AGENT),
      ...config,
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type FetchCall = { url: string; init: RequestInit | undefined }
let fetchMock: ReturnType<typeof vi.fn>
let warnSpy: ReturnType<typeof vi.spyOn>
let infoSpy: ReturnType<typeof vi.spyOn>

function fetchCalls(): FetchCall[] {
  return fetchMock.mock.calls.map((call) => ({ url: String(call[0]), init: call[1] as RequestInit | undefined }))
}

/** fetch answers gettoken with a token and asyncsend_v2 with `sendBody` (default: accepted with a task id). */
function stubProvider(options: { token?: () => Response | Error; send?: () => Response | Error } = {}): void {
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    const make = url.includes('/gettoken')
      ? options.token ?? (() => jsonResponse({ errcode: 0, access_token: TOKEN_LABEL, expires_in: 7200 }))
      : options.send ?? (() => jsonResponse({ errcode: 0, errmsg: 'ok', task_id: 987654321, request_id: 'req-label-1' }))
    const answer = make()
    if (answer instanceof Error) throw answer
    return answer
  })
  vi.stubGlobal('fetch', fetchMock)
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out)
  return out
}
const loggedTexts = (): string => [...collectStrings(warnSpy.mock.calls), ...collectStrings(infoSpy.mock.calls)].join('\n')

function expectValuesFree(result: DingTalkWorkNotificationVerifyResult, recipient: unknown = undefined): void {
  const surfaces = {
    report: JSON.stringify(result),
    audit: JSON.stringify(buildDingTalkWorkNotificationVerifyAuditMeta(result, recipient)),
    logs: loggedTexts(),
  }
  for (const [name, text] of Object.entries(surfaces)) {
    for (const label of CREDENTIAL_LABELS) expect(text, `${name} carries ${label}`).not.toContain(label)
  }
}

beforeEach(() => {
  vi.unstubAllEnvs()
  dbMocks.query.mockReset()
  flag.state.on = false
  flag.predicate.mockClear()
  scopedSpy.mockClear()
  __resetDingTalkAppAccessTokenCacheForTests()
  // Read-tier retries stay at the default 3 attempts; only the backoff sleeps are shortened.
  vi.stubEnv('DINGTALK_TRANSPORT_BACKOFF_BASE_MS', '1')
  vi.stubEnv('DINGTALK_TRANSPORT_BACKOFF_CAP_MS', '2')
  stubProvider()
  warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  infoSpy = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  warnSpy.mockRestore()
  infoSpy.mockRestore()
  flag.state.on = false
})

const verify = (level: unknown, recipientUserId?: unknown) =>
  verifyDingTalkWorkNotificationIntegration({ integrationId: INTEGRATION_ID, level, recipientUserId })

// ── same resolver ──────────────────────────────────────────────────────────────────────────────────────────

describe('same resolver as the integration-scoped send path', () => {
  it('the verification module names neither the switch module nor process.env', () => {
    expect(VERIFY_SOURCE).not.toContain('integration-scoped-credentials-flag')
    expect(VERIFY_SOURCE).not.toContain('process.env')
    expect(VERIFY_SOURCE).not.toContain(SWITCH.slice(0, 'DINGTALK_INTEGRATION_SCOPED'.length))
    // Positive control: the source does import the shared reader by name.
    expect(VERIFY_SOURCE).toContain('readDingTalkIntegrationScopedMessageTuple')
  })

  it('the send path\'s default reader IS the shared export, by source text (a private copy as the default is red)', () => {
    // The default parameter is a module-internal binding the spy cannot see, so it is pinned by text:
    // exactly this default, and the export it names is defined in the same file.
    const defaultReader = SETTINGS_SOURCE.match(/^\s*deps: DingTalkMessageConfigRuntimeDeps = \{ readScoped: (\w+) \},$/gm) ?? []
    expect(defaultReader).toHaveLength(1)
    expect(defaultReader[0]).toMatch(/\{ readScoped: readDingTalkIntegrationScopedMessageTuple \}/)
    expect(SETTINGS_SOURCE).toContain('export async function readDingTalkIntegrationScopedMessageTuple(')
    // And the ON branch goes through the seam, not a sibling binding.
    expect(SETTINGS_SOURCE).toContain('return (await deps.readScoped(scopedIntegrationId)).config')
  })

  it('level config calls the exported scoped reader exactly once, with the integration id', async () => {
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    const result = await verify('config')
    expect(result.passed).toBe(true)
    expect(scopedSpy).toHaveBeenCalledTimes(1)
    expect(scopedSpy).toHaveBeenCalledWith(INTEGRATION_ID)
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['not a string', 7],
  ])('integration id %s is refused typed before any read: no "preferred integration" fallback at module level', async (_label, integrationId) => {
    await expect(verifyDingTalkWorkNotificationIntegration({ integrationId: integrationId as string, level: 'config' })).rejects.toThrow(
      'integrationId is required',
    )
    await expect(verifyDingTalkWorkNotificationIntegration({ integrationId: integrationId as string, level: 'config' })).rejects.toBeInstanceOf(
      DingTalkConfigValidationError,
    )
    expect(dbMocks.query).not.toHaveBeenCalled()
    expect(scopedSpy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the switch-ON branch of readDingTalkMessageConfigFromRuntime calls the injected scoped reader exactly once (dependency injection)', async () => {
    flag.state.on = true
    const injectedTuple: DingTalkIntegrationScopedMessageTuple = {
      config: { appKey: 'k', appSecret: 's', agentId: '1', baseUrl: undefined },
      source: 'integration',
      integration: { id: INTEGRATION_ID, name: 'n', status: 'active', updatedAt: 'u' },
      environment: { appKey: false, appSecret: false, agentId: false, baseUrl: false },
    }
    const injected = vi.fn(async () => injectedTuple)

    await expect(readDingTalkMessageConfigFromRuntime(INTEGRATION_ID, { readScoped: injected })).resolves.toEqual(injectedTuple.config)
    expect(injected).toHaveBeenCalledTimes(1)
    expect(injected).toHaveBeenCalledWith(INTEGRATION_ID)
    // The injected reader was the resolution: no row read of its own.
    expect(dbMocks.query).not.toHaveBeenCalled()

    // Switch OFF: the seam is not consulted at all (the pre-switch path).
    flag.state.on = false
    injected.mockClear()
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    await readDingTalkMessageConfigFromRuntime(INTEGRATION_ID, { readScoped: injected })
    expect(injected).not.toHaveBeenCalled()
  })

  describe('fixture parity: switch ON send-path resolution ≡ switch-independent verification report', () => {
    type Row = {
      label: string
      env: Record<string, string>
      row: ReturnType<typeof storedRow> | null
      expect: { source: 'env_override' | 'integration'; agentIdLength: number; baseUrlConfigured: boolean } | { code: DingTalkMessageConfigError['code'] }
    }
    const ROWS: Row[] = [
      {
        label: 'same app, complete env triple → env values, env baseUrl first',
        env: { DINGTALK_APP_KEY: ROW_KEY, DINGTALK_APP_SECRET: ENV_SECRET, DINGTALK_AGENT_ID: ENV_AGENT, DINGTALK_BASE_URL: ENV_BASE },
        row: storedRow({ baseUrl: ROW_BASE }),
        expect: { source: 'env_override', agentIdLength: ENV_AGENT.length, baseUrlConfigured: true },
      },
      {
        label: 'same app, env key only → secret and Agent ID from the row',
        env: { DINGTALK_APP_KEY: ROW_KEY },
        row: storedRow(),
        expect: { source: 'env_override', agentIdLength: ROW_AGENT.length, baseUrlConfigured: false },
      },
      {
        label: 'another app in env → the row as a whole, row baseUrl first',
        env: { DINGTALK_APP_KEY: ENV_KEY, DINGTALK_APP_SECRET: ENV_SECRET, DINGTALK_AGENT_ID: ENV_AGENT, DINGTALK_BASE_URL: ENV_BASE },
        row: storedRow({ baseUrl: ROW_BASE }),
        expect: { source: 'integration', agentIdLength: ROW_AGENT.length, baseUrlConfigured: true },
      },
      {
        label: 'another app in env, row without baseUrl → env baseUrl',
        env: { DINGTALK_CLIENT_ID: ENV_KEY, DINGTALK_CLIENT_SECRET: ENV_SECRET, DINGTALK_BASE_URL: ENV_BASE },
        row: storedRow(),
        expect: { source: 'integration', agentIdLength: ROW_AGENT.length, baseUrlConfigured: true },
      },
      {
        label: 'alias order: DINGTALK_APP_KEY wins over DINGTALK_CLIENT_ID (CLIENT_ID equal to the row is not the same app)',
        env: { DINGTALK_APP_KEY: ENV_KEY, DINGTALK_CLIENT_ID: ROW_KEY, DINGTALK_APP_SECRET: ENV_SECRET },
        row: storedRow(),
        expect: { source: 'integration', agentIdLength: ROW_AGENT.length, baseUrlConfigured: false },
      },
      {
        label: 'missing row, complete env triple → integration_not_found',
        env: { DINGTALK_APP_KEY: ENV_KEY, DINGTALK_APP_SECRET: ENV_SECRET, DINGTALK_AGENT_ID: ENV_AGENT },
        row: null,
        expect: { code: 'integration_not_found' },
      },
      {
        label: 'row not active (same app) → integration_inactive',
        env: { DINGTALK_APP_KEY: ROW_KEY, DINGTALK_APP_SECRET: ENV_SECRET, DINGTALK_AGENT_ID: ENV_AGENT },
        row: storedRow({}, 'paused'),
        expect: { code: 'integration_inactive' },
      },
      {
        label: 'another app, row without Agent ID → integration_tuple_incomplete (nothing borrowed from env)',
        env: { DINGTALK_APP_KEY: ENV_KEY, DINGTALK_APP_SECRET: ENV_SECRET, DINGTALK_AGENT_ID: ENV_AGENT },
        row: storedRow({ workNotificationAgentId: '' }),
        expect: { code: 'integration_tuple_incomplete' },
      },
      {
        label: 'same app, neither side has a secret → integration_tuple_incomplete (same-app override)',
        env: { DINGTALK_APP_KEY: ROW_KEY, DINGTALK_AGENT_ID: ENV_AGENT },
        row: storedRow({ appSecret: '' }),
        expect: { code: 'integration_tuple_incomplete' },
      },
      {
        label: 'same app, env Agent ID placeholder → env_agent_id_invalid',
        env: { DINGTALK_APP_KEY: ROW_KEY, DINGTALK_AGENT_ID: PLACEHOLDER_AGENT },
        row: storedRow(),
        expect: { code: 'env_agent_id_invalid' },
      },
    ]

    it.each(ROWS.map((r) => [r.label, r] as const))('%s', async (_label, row) => {
      for (const [key, value] of Object.entries(row.env)) vi.stubEnv(key, value)

      // Send path, switch ON (predicate mock), no injection: the default seam.
      flag.state.on = true
      dbMocks.query.mockResolvedValueOnce({ rows: row.row ? [row.row] : [] })
      const sendPath = await readDingTalkMessageConfigFromRuntime(INTEGRATION_ID).then(
        (config) => ({ config, error: null as DingTalkMessageConfigError | null }),
        (error: unknown) => ({ config: null, error: error as DingTalkMessageConfigError }),
      )
      const sendPathQuery = dbMocks.query.mock.calls[0]

      // Verification, switch OFF.
      flag.state.on = false
      dbMocks.query.mockReset()
      dbMocks.query.mockResolvedValueOnce({ rows: row.row ? [row.row] : [] })
      scopedSpy.mockClear()
      const report = await verify('config')
      const verifyQuery = dbMocks.query.mock.calls[0]

      expect(verifyQuery).toEqual(sendPathQuery)
      expect(String(verifyQuery[0])).toContain('WHERE id = $1 AND provider = $2')
      expect(verifyQuery[1]).toEqual([INTEGRATION_ID, 'dingtalk'])
      expect(scopedSpy).toHaveBeenCalledTimes(1)

      if ('code' in row.expect) {
        expect(sendPath.error).toBeInstanceOf(DingTalkMessageConfigError)
        expect(report).toMatchObject({ passed: false, reachedLevel: 'none', integration: null, resolution: null })
        expect(report.failure).toEqual({ level: 'config', code: sendPath.error!.code, message: sendPath.error!.message })
        expect(report.failure!.code).toBe(row.expect.code)
        expect(report.scope).toEqual(SCOPE.none)
        expect(report.accessToken).toEqual({ verified: false, cacheBypassed: null, valuePrinted: false })
      } else {
        expect(sendPath.error).toBeNull()
        const config = sendPath.config!
        // By VALUE, inside the test only: what the verification resolved (the spy's return) is exactly the
        // config the switch-ON send path resolved — every field, from the same side. A default reader that
        // drifts on any one field (which side's baseUrl, secret or Agent ID wins for the same app) is red here.
        const verified = (await scopedSpy.mock.results[0].value) as DingTalkIntegrationScopedMessageTuple
        expect(config).toEqual(verified.config)
        expect(verified.source).toBe(row.expect.source)
        expect(report).toMatchObject({ passed: true, reachedLevel: 'config', failure: null, scope: SCOPE.config })
        expect(report.resolution).toMatchObject({
          source: row.expect.source,
          appKey: { configured: true, length: config.appKey.length, valuePrinted: false },
          appSecret: { configured: true, valuePrinted: false },
          agentId: { configured: true, length: config.agentId.length, valuePrinted: false },
          baseUrl: { configured: Boolean(config.baseUrl), parseable: config.baseUrl ? true : null },
        })
        expect(report.resolution!.agentId.length).toBe(row.expect.agentIdLength)
        expect(report.resolution!.baseUrl.configured).toBe(row.expect.baseUrlConfigured)
        expect(report.integration).toEqual({ id: INTEGRATION_ID, name: 'DingTalk CN', status: 'active', updatedAt: '2026-05-08T00:00:00.000Z' })
      }
      expectValuesFree(report)
    })
  })
})

// ── switch independence ────────────────────────────────────────────────────────────────────────────────────

describe('independent of the switch, and does not touch it', () => {
  it('never consults the switch predicate; the report is identical whether it would answer false or true', async () => {
    vi.stubEnv('DINGTALK_APP_KEY', ROW_KEY)
    vi.stubEnv('DINGTALK_APP_SECRET', ENV_SECRET)
    const keysBefore = Object.keys(process.env).sort()
    const switchBefore = process.env[SWITCH]

    flag.state.on = false
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    const off = await verify('config')
    flag.state.on = true
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    const on = await verify('config')

    expect(on).toEqual(off)
    expect(off.passed).toBe(true)
    expect(flag.predicate).not.toHaveBeenCalled()
    expect(Object.keys(process.env).sort()).toEqual(keysBefore)
    expect(process.env[SWITCH]).toBe(switchBefore)

    // Positive control: the predicate mock is live — the send path does consult it.
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    await readDingTalkMessageConfigFromRuntime(INTEGRATION_ID)
    expect(flag.predicate).toHaveBeenCalledTimes(1)
  })

  it('the switch is not set at the moment of the row read nor at the moment of the gettoken (observed inside the stubs, not only before and after)', async () => {
    // A verification that set the switch around its own row read and restored it afterwards would be
    // invisible to a before/after snapshot, and visible to every concurrent sender in the same process.
    const switchBefore = process.env[SWITCH]
    const observed: Array<{ at: string; value: string | undefined }> = []
    dbMocks.query.mockImplementationOnce(async () => {
      observed.push({ at: 'row read', value: process.env[SWITCH] })
      return { rows: [storedRow()] }
    })
    fetchMock = vi.fn(async (input: unknown) => {
      observed.push({ at: String(input).includes('/gettoken') ? 'gettoken' : 'other', value: process.env[SWITCH] })
      return jsonResponse({ errcode: 0, access_token: TOKEN_LABEL, expires_in: 7200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await verify('token')
    expect(result).toMatchObject({ passed: true, reachedLevel: 'token' })
    expect(observed.map((o) => o.at)).toEqual(['row read', 'gettoken'])
    for (const o of observed) expect(o.value, `switch value at ${o.at}`).toBe(switchBefore)
    expect(switchBefore).toBeUndefined()
    expect(flag.predicate).not.toHaveBeenCalled()
  })
})

// ── level separation ───────────────────────────────────────────────────────────────────────────────────────

describe('three levels of evidence, each reported as itself', () => {
  it('config: one row read, no fetch, no token, no send', async () => {
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ baseUrl: ROW_BASE })] })
    const result = await verify('config', RECIPIENT)
    expect(result).toMatchObject({
      requestedLevel: 'config',
      reachedLevel: 'config',
      passed: true,
      failure: null,
      // No token was requested: cacheBypassed is null, not true.
      accessToken: { verified: false, cacheBypassed: null, valuePrinted: false },
      // A recipient at a level below send is ignored, and reported as not attempted.
      notification: { attempted: false, accepted: false, recipientUserIdLength: null, verificationRunId: null },
    })
    expect(result.resolution).toEqual({
      source: 'integration',
      appKey: { configured: true, length: ROW_KEY.length, valuePrinted: false },
      appSecret: { configured: true, valuePrinted: false },
      agentId: { configured: true, length: ROW_AGENT.length, valuePrinted: false },
      baseUrl: { configured: true, parseable: true },
      environment: { appKey: false, appSecret: false, agentId: false, baseUrl: false },
    })
    // The config pair, word for word; it says nothing about DingTalk accepting anything.
    expect(result.scope).toEqual(SCOPE.config)
    expect(result.scope.proves).not.toMatch(/accept|token|DingTalk/i)
    expect(result.scope.doesNotProve).toMatch(/routes to this integration/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(dbMocks.query).toHaveBeenCalledTimes(1)
    expectValuesFree(result, RECIPIENT)
  })

  it('token: exactly one gettoken, no send; the shared token cache is neither used, overwritten nor evicted', async () => {
    // Seed the shared cache for the same appKey|baseUrl, as a delivery path would have.
    await fetchDingTalkAppAccessToken({ appKey: ROW_KEY, appSecret: ROW_SECRET, baseUrl: undefined })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // From here DingTalk mints a DIFFERENT token, so "the cache still holds the seeded one" is observable.
    stubProvider({ token: () => jsonResponse({ errcode: 0, access_token: FRESH_TOKEN_LABEL, expires_in: 7200 }) })

    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    const result = await verify('token')
    expect(result).toMatchObject({
      requestedLevel: 'token',
      reachedLevel: 'token',
      passed: true,
      failure: null,
      accessToken: { verified: true, cacheBypassed: true, valuePrinted: false },
      notification: { attempted: false, accepted: false, recipientUserIdLength: null },
      scope: SCOPE.token,
    })
    // The cache hit was not taken: a gettoken went out although an entry was cached.
    expect(fetchCalls().map((c) => c.url)).toHaveLength(1)
    expect(fetchCalls()[0].url).toContain('/gettoken')
    expect(fetchCalls()[0].url).not.toContain('asyncsend_v2')
    // And the entry is still there, unchanged: the delivery path's next call is answered from the cache
    // with the SEEDED token, not the one the verification minted (neither evicted nor overwritten).
    fetchMock.mockClear()
    await expect(fetchDingTalkAppAccessToken({ appKey: ROW_KEY, appSecret: ROW_SECRET, baseUrl: undefined })).resolves.toBe(TOKEN_LABEL)
    expect(fetchMock).not.toHaveBeenCalled()
    expectValuesFree(result)
  })

  it('token: another caller\'s in-flight gettoken for the same appKey|baseUrl is not joined — the verification mints its own', async () => {
    // A delivery path's gettoken is in flight and will not answer until released.
    let release: (response: Response) => void = () => undefined
    const pending = new Promise<Response>((resolve) => { release = resolve })
    let gettokenCalls = 0
    fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (!url.includes('/gettoken')) throw new Error('unexpected call')
      gettokenCalls += 1
      // First caller (the delivery path) hangs; the verification's own request answers at once.
      return gettokenCalls === 1 ? pending : jsonResponse({ errcode: 0, access_token: FRESH_TOKEN_LABEL, expires_in: 7200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const config = { appKey: ROW_KEY, appSecret: ROW_SECRET, baseUrl: undefined }
    const inFlight = fetchDingTalkAppAccessToken(config)
    expect(gettokenCalls).toBe(1)

    // The verification completes while the delivery path's request is still unanswered: not joined.
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    const result = await verify('token')
    expect(result).toMatchObject({ reachedLevel: 'token', passed: true, accessToken: { verified: true, cacheBypassed: true } })
    expect(gettokenCalls).toBe(2)

    // Releasing the delivery path's request: it gets ITS token, and that is what the cache keeps.
    release(jsonResponse({ errcode: 0, access_token: TOKEN_LABEL, expires_in: 7200 }))
    await expect(inFlight).resolves.toBe(TOKEN_LABEL)
    await expect(fetchDingTalkAppAccessToken(config)).resolves.toBe(TOKEN_LABEL)
    expect(gettokenCalls).toBe(2)
    expectValuesFree(result)
  })

  it('send: gettoken then asyncsend_v2 with the resolved Agent ID, the one recipient and the run marker; accepted with a task id', async () => {
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ baseUrl: ROW_BASE })] })
    const result = await verify('send', ` ${RECIPIENT} `)
    expect(result).toMatchObject({
      requestedLevel: 'send',
      reachedLevel: 'send',
      passed: true,
      failure: null,
      accessToken: { verified: true, cacheBypassed: true },
      notification: { attempted: true, accepted: true, recipientUserIdLength: RECIPIENT.length, taskId: '987654321', requestId: 'req-label-1' },
      scope: SCOPE.send,
    })
    expect(result.notification.verificationRunId).toMatch(/^[0-9a-f]{8}$/)
    const calls = fetchCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe(`${ROW_BASE}/gettoken?appkey=${ROW_KEY}&appsecret=${ROW_SECRET}`)
    expect(calls[1].url).toBe(`${ROW_BASE}/topapi/message/corpconversation/asyncsend_v2?access_token=${TOKEN_LABEL}`)
    const body = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>
    expect(body.agent_id).toBe(Number(ROW_AGENT))
    expect(body.userid_list).toBe(RECIPIENT)
    expect(body.to_all_user).toBe(false)
    const text = String((body.msg as { markdown: { text: string } }).markdown.text)
    expect(text).toContain(INTEGRATION_ID)
    expect(text).toContain(result.notification.verificationRunId!)
    for (const label of CREDENTIAL_LABELS) expect(text).not.toContain(label)
    expectValuesFree(result, RECIPIENT)
    // The recipient is an identifier the audit may carry, once a send was attempted.
    expect(buildDingTalkWorkNotificationVerifyAuditMeta(result, ` ${RECIPIENT} `)).toMatchObject({ recipientUserId: RECIPIENT, notificationAccepted: true })
  })

  it('send with a same-app env override: the gettoken and the asyncsend go out with the env side of the tuple (secret, Agent ID, baseUrl), as resolved', async () => {
    // Same app in env (env appKey equals the row's), env overriding every field; the row holds another baseUrl.
    vi.stubEnv('DINGTALK_APP_KEY', ROW_KEY)
    vi.stubEnv('DINGTALK_APP_SECRET', ENV_SECRET)
    vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)
    vi.stubEnv('DINGTALK_BASE_URL', ENV_BASE)
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ baseUrl: ROW_BASE })] })
    const result = await verify('send', RECIPIENT)
    expect(result).toMatchObject({ reachedLevel: 'send', passed: true, scope: SCOPE.send })
    expect(result.resolution).toMatchObject({
      source: 'env_override',
      agentId: { length: ENV_AGENT.length },
      environment: { appKey: true, appSecret: true, agentId: true, baseUrl: true },
    })
    // What was resolved is what was used — on the env side, field by field.
    const calls = fetchCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe(`${ENV_BASE}/gettoken?appkey=${ROW_KEY}&appsecret=${ENV_SECRET}`)
    expect(calls[1].url).toBe(`${ENV_BASE}/topapi/message/corpconversation/asyncsend_v2?access_token=${TOKEN_LABEL}`)
    const body = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>
    expect(body.agent_id).toBe(Number(ENV_AGENT))
    expect(body.userid_list).toBe(RECIPIENT)
    expect(flag.predicate).not.toHaveBeenCalled()
    expectValuesFree(result, RECIPIENT)
  })

  // The env shape where the pre-switch env-first reader and the integration-scoped rule DISAGREE: env holds
  // ANOTHER app's complete tuple. The env-first reader would answer with the env app without reading the row;
  // the integration-scoped rule uses the row whole. The requests must go out with what was resolved (the row).
  it('send with ANOTHER app complete in env: the gettoken and the asyncsend go out with the row-side tuple (source integration), not the env app', async () => {
    vi.stubEnv('DINGTALK_APP_KEY', ENV_KEY)
    vi.stubEnv('DINGTALK_APP_SECRET', ENV_SECRET)
    vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)
    vi.stubEnv('DINGTALK_BASE_URL', ENV_BASE)
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ baseUrl: ROW_BASE })] })
    const result = await verify('send', RECIPIENT)
    expect(result).toMatchObject({ reachedLevel: 'send', passed: true, scope: SCOPE.send })
    expect(result.resolution!.source).toBe('integration')
    const calls = fetchCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe(`${ROW_BASE}/gettoken?appkey=${ROW_KEY}&appsecret=${ROW_SECRET}`)
    expect(calls[1].url).toBe(`${ROW_BASE}/topapi/message/corpconversation/asyncsend_v2?access_token=${TOKEN_LABEL}`)
    const body = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>
    expect(body.agent_id).toBe(Number(ROW_AGENT))
    expect(flag.predicate).not.toHaveBeenCalled()
    expectValuesFree(result, RECIPIENT)
  })

  it('token with ANOTHER app complete in env: the gettoken goes out with the row-side app, not the env app', async () => {
    vi.stubEnv('DINGTALK_APP_KEY', ENV_KEY)
    vi.stubEnv('DINGTALK_APP_SECRET', ENV_SECRET)
    vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)
    vi.stubEnv('DINGTALK_BASE_URL', ENV_BASE)
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ baseUrl: ROW_BASE })] })
    const result = await verify('token')
    expect(result).toMatchObject({ reachedLevel: 'token', passed: true, scope: SCOPE.token })
    expect(result.resolution!.source).toBe('integration')
    const calls = fetchCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${ROW_BASE}/gettoken?appkey=${ROW_KEY}&appsecret=${ROW_SECRET}`)
    expect(flag.predicate).not.toHaveBeenCalled()
    expectValuesFree(result)
  })

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['with a comma (would address several people)', 'a,b'],
    ['with whitespace inside', 'a b'],
    ['longer than 64 characters', 'x'.repeat(65)],
  ])('send without a usable recipient (%s) is refused typed, before any read or fetch', async (_label, recipient) => {
    await expect(verify('send', recipient)).rejects.toBeInstanceOf(DingTalkConfigValidationError)
    expect(dbMocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(scopedSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['SEND (case)', 'SEND'],
    [' send (leading space)', ' send'],
    ['all', 'all'],
    ['not a string', 1],
  ])('level %s is refused typed, before any read or fetch', async (_label, level) => {
    await expect(verify(level, RECIPIENT)).rejects.toThrow('level must be one of config, token, send')
    expect(dbMocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failure to read the row that is not the resolver\'s verdict is thrown, not reported', async () => {
    dbMocks.query.mockRejectedValueOnce(new Error('relation "directory_integrations" does not exist'))
    await expect(verify('config')).rejects.toThrow('does not exist')
  })

  it('token rejected by DingTalk: reached config only, fixed sentence + errcode, nothing higher implied', async () => {
    stubProvider({ token: () => jsonResponse({ errcode: 40001, errmsg: PROVIDER_TEXT, request_id: PROVIDER_TEXT }) })
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    const result = await verify('send', RECIPIENT)
    expect(result).toMatchObject({
      requestedLevel: 'send',
      reachedLevel: 'config',
      passed: false,
      // A gettoken was requested (cache bypassed) and refused: not verified.
      accessToken: { verified: false, cacheBypassed: true },
      notification: { attempted: false, accepted: false, recipientUserIdLength: RECIPIENT.length },
      // The REACHED level's sentences: a send-level request that failed at the token step carries the
      // config pair, not the token or send pair.
      scope: SCOPE.config,
      failure: {
        level: 'token',
        code: 'token_rejected',
        message: 'Access token was not obtained: DingTalk rejected the request (errcode 40001)',
        providerCode: 40001,
        providerCodeKind: 'errcode',
      },
    })
    expect(result.resolution).not.toBeNull()
    expect(fetchCalls().every((c) => c.url.includes('/gettoken'))).toBe(true)
    expectValuesFree(result, RECIPIENT)
    expect(warnSpy).toHaveBeenCalledWith('DingTalk work-notification verification provider failure', {
      integrationId: INTEGRATION_ID,
      level: 'token',
      errorName: 'DingTalkBusinessError',
      providerCode: 40001,
      providerCodeKind: 'errcode',
    })
  })

  it('gettoken timeout (read tier, no outcome marker): a token failure, never "may still have been delivered"', async () => {
    stubProvider({ token: () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }) })
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    const result = await verify('token')
    expect(result).toMatchObject({
      reachedLevel: 'config',
      passed: false,
      failure: { level: 'token', code: 'token_timeout', message: 'Access token was not obtained: DingTalk did not answer in time' },
    })
    expect(JSON.stringify(result)).not.toContain('may still have been delivered')
    expectValuesFree(result)
  })

  it('send outcome unknown (transport marker): reached token, accepted unknown, the fixed sentence', async () => {
    stubProvider({ send: () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ECONNREFUSED ${PROVIDER_TEXT}`), { code: 'ECONNREFUSED' }) }) })
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    const result = await verify('send', RECIPIENT)
    expect(result).toMatchObject({
      reachedLevel: 'token',
      passed: false,
      accessToken: { verified: true, cacheBypassed: true },
      notification: { attempted: true, accepted: 'unknown' },
      // Reached token: the token pair, not the send pair.
      scope: SCOPE.token,
      failure: {
        level: 'send',
        code: 'send_outcome_unknown',
        message: 'DingTalk did not confirm the outcome. The test message may still have been delivered — check the test message on the device before retrying.',
      },
    })
    // Send tier is never resent: one asyncsend attempt.
    expect(fetchCalls().filter((c) => c.url.includes('asyncsend_v2'))).toHaveLength(1)
    expectValuesFree(result, RECIPIENT)
  })

  it('send rejected by DingTalk (definite): reached token, accepted false, fixed sentence + errcode', async () => {
    stubProvider({ send: () => jsonResponse({ errcode: 40035, errmsg: PROVIDER_TEXT }) })
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    const result = await verify('send', RECIPIENT)
    expect(result).toMatchObject({
      reachedLevel: 'token',
      passed: false,
      notification: { attempted: true, accepted: false },
      failure: { level: 'send', code: 'send_rejected', message: 'Test work notification was not accepted: DingTalk rejected the request (errcode 40035)', providerCode: 40035 },
    })
    expectValuesFree(result, RECIPIENT)
  })

  it('send answered errcode 0 without a task id: not confirmed — accepted unknown, not passed', async () => {
    stubProvider({ send: () => jsonResponse({ errcode: 0, errmsg: 'ok', request_id: 'req-label-2' }) })
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })
    const result = await verify('send', RECIPIENT)
    expect(result).toMatchObject({
      reachedLevel: 'token',
      passed: false,
      notification: { attempted: true, accepted: 'unknown', requestId: 'req-label-2' },
      failure: { level: 'send', code: 'send_not_confirmed' },
    })
    expect(result.notification.taskId).toBeUndefined()
    expect(result.scope).toEqual(SCOPE.token)
    expectValuesFree(result, RECIPIENT)
  })

  it('the four scope pairs are distinct, each level\'s proves names only what that level observed, and nothing below send mentions acceptance of a notification', () => {
    const proves = Object.values(SCOPE).map((s) => s.proves)
    expect(new Set(proves).size).toBe(4)
    expect(new Set(Object.values(SCOPE).map((s) => s.doesNotProve)).size).toBe(4)
    expect(SCOPE.none.proves).toMatch(/^Nothing:/)
    expect(SCOPE.config.proves).not.toMatch(/accept|token|DingTalk/i)
    expect(SCOPE.token.proves).not.toMatch(/accept|notification|recipient|device/i)
    expect(SCOPE.send.proves).toMatch(/accepted one work notification/)
    expect(SCOPE.send.proves).not.toMatch(/deliver|device/i)
    for (const level of ['none', 'config', 'token', 'send'] as const) expect(SCOPE[level].doesNotProve).toMatch(/routes to this integration/)
    for (const level of ['none', 'config', 'token', 'send'] as const) expect(SCOPE[level].doesNotProve).toMatch(/device/)
  })
})

// ── values-free under the failure that carries the secret in its own text ───────────────────────────────

describe('a token failure whose text carries the gettoken URL (stored baseUrl without a scheme)', () => {
  it('reports token_network_error with the fixed sentence, flags the baseUrl as not parseable, and no surface carries a label', async () => {
    stubProvider({
      token: () => {
        // What undici raises for a relative URL: the message AND the cause carry the full input, secret included.
        const input = `oapi.example.invalid/gettoken?appkey=${ROW_KEY}&appsecret=${ROW_SECRET}`
        return Object.assign(new TypeError(`Failed to parse URL from ${input}`), { cause: Object.assign(new TypeError('Invalid URL'), { input }) })
      },
    })
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ baseUrl: 'oapi.example.invalid' })] })
    const result = await verify('token')
    expect(result).toMatchObject({
      reachedLevel: 'config',
      passed: false,
      failure: { level: 'token', code: 'token_network_error', message: 'Access token was not obtained' },
    })
    expect(result.resolution!.baseUrl).toEqual({ configured: true, parseable: false })
    // Read tier: the transport retried the deterministic failure to the attempt budget.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expectValuesFree(result)
    expect(warnSpy).toHaveBeenCalledWith('DingTalk work-notification verification provider failure', {
      integrationId: INTEGRATION_ID,
      level: 'token',
      errorName: 'TypeError',
    })
  })

  it('config level already shows the row as resolved and the baseUrl as not parseable, without changing the verdict', async () => {
    dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ baseUrl: 'oapi.example.invalid' })] })
    const result = await verify('config')
    expect(result.passed).toBe(true)
    expect(result.resolution!.baseUrl).toEqual({ configured: true, parseable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

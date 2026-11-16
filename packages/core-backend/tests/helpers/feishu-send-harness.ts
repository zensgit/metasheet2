/**
 * Shared harness of the Feishu send tests: a local mock server standing in for the Feishu hosts, a token
 * service with injected time and waits, a sender built over it, and synthetic connection rows and
 * endpoints. All values are synthetic; nothing leaves the loopback.
 */
import { vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import { feishuIdRef } from '../../src/integrations/feishu/config'
import { __feishuEndpointsForTests } from '../../src/integrations/feishu/endpoints'
import { createFeishuTenantTokenService, type FeishuTenantTokenService } from '../../src/integrations/feishu/token'
import {
  createFeishuMessageSender,
  type FeishuCapabilityDecision,
  type FeishuMessageSender,
  type FeishuSendEndpoint,
  type FeishuSendInput,
  type FeishuSenderConnectionRow,
} from '../../src/services/feishu-message-sender'
import {
  installNoExternalFetchGuard,
  startFeishuMockServer,
  type MockFeishuRecordedRequest,
  type MockFeishuServer,
  type MockFeishuStep,
  type NoExternalFetchGuard,
} from './feishu-mock-server'

export const MINT_ROUTE = 'POST /oauth/v3/token'
export const SEND_ROUTE = 'POST /open-apis/im/v1/messages'

export const CONNECTION_ID = 'conn-fx-0001'
export const OTHER_CONNECTION_ID = 'conn-fx-0002'
export const TENANT = 'tk_fx_0001'
export const APP_ID = 'cli_fx_0001'
export const APP_SECRET_PLAIN = 'fx-app-secret-plain-0001-not-real'
export const STORED_SECRET = `enc:${APP_SECRET_PLAIN}`
export const OPEN_ID = 'ou_fx_open_id_0001'
export const OPEN_ID_2 = 'ou_fx_open_id_0002'
export const OPEN_ID_3 = 'ou_fx_open_id_0003'
export const MESSAGE_ID = 'om_fx_message_id_0001'
export const EFFECTIVE: FeishuCapabilityDecision = Object.freeze({ effective: true, reason: null })

export const decodeFakeSecret = (stored: string): string => {
  if (!stored.startsWith('enc:')) throw new Error('not an encrypted value')
  return stored.slice('enc:'.length)
}

export function connectionRow(overrides: Partial<FeishuSenderConnectionRow> & { config?: unknown } = {}): FeishuSenderConnectionRow {
  return {
    provider: 'feishu',
    corp_id: TENANT,
    config: { appId: APP_ID, appSecret: STORED_SECRET },
    ...overrides,
  }
}

export function endpointFor(
  openId: string,
  options: { connectionId?: string; anchor?: { tenant: string; appScope: string }; evidence?: readonly string[] } = {},
): FeishuSendEndpoint {
  return {
    ref: feishuIdRef({ connectionId: options.connectionId ?? CONNECTION_ID, idType: 'open_id', value: openId }),
    anchor: options.anchor ?? { tenant: TENANT, appScope: APP_ID },
    evidence: options.evidence,
  }
}

/** One token per mint, in order. */
export function tokenSteps(count = 20): MockFeishuStep[] {
  return Array.from({ length: count }, (_unused, index): MockFeishuStep => ({
    kind: 'json',
    body: { access_token: `t-fx-token-${index + 1}-abcdefghij`, expires_in: 7200, token_type: 'Bearer' },
  }))
}

export const acceptedStep = (messageId = MESSAGE_ID): MockFeishuStep => ({
  kind: 'json',
  body: { code: 0, msg: 'success', data: { message_id: messageId } },
})

export const refusedStep = (code: number, status = 400): MockFeishuStep => ({
  kind: 'json',
  status,
  body: { code, msg: 'refused' },
})

export interface SendHarness {
  server: MockFeishuServer
  guard: NoExternalFetchGuard
  tokens: FeishuTenantTokenService
  sender: FeishuMessageSender
  rows: Map<string, FeishuSenderConnectionRow | null>
  flag: { value: string | undefined }
  /** Every argument list handed to any logger method while the harness was open. */
  logs: unknown[][]
  /** Waits requested of the token service (injected, instantaneous). */
  tokenSleeps: number[]
  /** Waits requested of the transport (injected, instantaneous). */
  transportSleeps: number[]
  sendRequests(): MockFeishuRecordedRequest[]
  parsedBody(index: number): { receive_id: string; msg_type: string; content: string; uuid: string }
  input(overrides?: Partial<FeishuSendInput>): FeishuSendInput
  close(): Promise<void>
}

export async function createSendHarness(options: { transportTimeoutMs?: number } = {}): Promise<SendHarness> {
  const logs: unknown[][] = []
  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
      logs.push(args)
    })
  }
  const server = await startFeishuMockServer()
  __feishuEndpointsForTests.replace(server.origins())
  const guard = installNoExternalFetchGuard()
  let clock = 1_000_000
  const tokenSleeps: number[] = []
  const transportSleeps: number[] = []
  const transport = {
    timeoutMs: options.transportTimeoutMs ?? 400,
    sleep: async (ms: number) => {
      transportSleeps.push(ms)
      return false
    },
    random: () => 0,
  }
  const tokens = createFeishuTenantTokenService({
    now: () => clock,
    sleep: async (ms: number) => {
      tokenSleeps.push(ms)
      clock += ms
    },
    random: () => 0.5,
    transport,
  })
  const rows = new Map<string, FeishuSenderConnectionRow | null>([
    [CONNECTION_ID, connectionRow()],
    [OTHER_CONNECTION_ID, connectionRow({ config: { appId: 'cli_fx_0002', appSecret: STORED_SECRET } })],
  ])
  const flag: { value: string | undefined } = { value: 'true' }
  const sender = createFeishuMessageSender({
    loadConnection: async (connectionId) => rows.get(connectionId) ?? null,
    decodeSecret: decodeFakeSecret,
    tokens,
    deliveryFlag: () => flag.value,
    transport,
  })
  server.script(MINT_ROUTE, tokenSteps())
  return {
    server,
    guard,
    tokens,
    sender,
    rows,
    flag,
    logs,
    tokenSleeps,
    transportSleeps,
    sendRequests: () => server.requests.filter((request) => request.route === SEND_ROUTE),
    parsedBody: (index) => JSON.parse(server.requests.filter((request) => request.route === SEND_ROUTE)[index].body),
    input: (overrides = {}) => ({
      connectionId: CONNECTION_ID,
      endpoint: endpointFor(OPEN_ID),
      text: 'Hello from a test',
      dedupeKey: 'notification-fx-0001',
      capabilityDecision: EFFECTIVE,
      ...overrides,
    }),
    async close() {
      guard.restore()
      __feishuEndpointsForTests.restore()
      await server.close()
      vi.restoreAllMocks()
    },
  }
}

/**
 * Decision table for the integration-scoped work-notification credential tuple, with the switch
 * DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED as an input.
 *
 *  - OFF rows prove the pre-switch path byte for byte (results, error text, and no row read when the
 *    env triple is complete). The cross-source row in dingtalk-work-notification-settings.test.ts
 *    ("lets environment app credentials use the directory Agent ID fallback") stays as the OFF pin.
 *  - ON rows cover: same app → per-field env override; different app → the row as a whole; inactive
 *    row (either source); missing row; incomplete source; an env Agent ID that would be sent must be
 *    1-32 digits; baseUrl following the chosen source; no integration named → unchanged path apart from
 *    the env Agent ID shape check.
 *  - The pure resolver is tested directly with synthetic labels, and every failure text is checked to
 *    carry none of them (values-free).
 *
 * Nothing here talks to DingTalk: no fetch, no token request, only the resolver and a db/pg mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: dbMocks.query,
}))

import {
  DingTalkConfigValidationError,
  DingTalkMessageConfigError,
} from '../../src/integrations/dingtalk/config-validation-error'
import {
  DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED,
  isDingTalkIntegrationScopedCredentialsEnabled,
} from '../../src/integrations/dingtalk/integration-scoped-credentials-flag'
import {
  readDingTalkMessageConfigFromRuntime,
  resolveDingTalkMessageTuple,
  type DingTalkMessageEnvSnapshot,
  type DingTalkMessageTupleRow,
} from '../../src/integrations/dingtalk/work-notification-settings'

const SWITCH = DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED

// Synthetic labels. Every failure message is asserted to contain none of the credential labels.
const ENV_KEY = 'env-app-key-label'
const ENV_SECRET = 'env-app-secret-label'
const ENV_AGENT = '111111'
const ROW_KEY = 'row-app-key-label'
const ROW_SECRET = 'row-app-secret-label'
const ROW_AGENT = '222222'
const ENV_BASE = 'https://env.example.test'
const ROW_BASE = 'https://row.example.test'
const PLACEHOLDER_AGENT = 'placeholder-agent-label'
const CREDENTIAL_LABELS = [ENV_KEY, ENV_SECRET, ENV_AGENT, ROW_KEY, ROW_SECRET, ROW_AGENT, PLACEHOLDER_AGENT]
// The attendance delivery worker keeps the first 240 characters of the error message (normalizeErrorText).
const ATTENDANCE_LEDGER_TEXT_LIMIT = 240
const UUID_LIKE_ID = '00000000-0000-4000-8000-000000000000'

function env(overrides: Partial<DingTalkMessageEnvSnapshot> = {}): DingTalkMessageEnvSnapshot {
  return { appKey: '', appSecret: '', agentId: '', baseUrl: undefined, ...overrides }
}

function row(overrides: Partial<DingTalkMessageTupleRow> = {}): DingTalkMessageTupleRow {
  return {
    integrationId: 'dir-1',
    integrationStatus: 'active',
    appKey: ROW_KEY,
    appSecret: ROW_SECRET,
    agentId: ROW_AGENT,
    baseUrl: undefined,
    ...overrides,
  }
}

function expectTypedFailure(fn: () => unknown, code: DingTalkMessageConfigError['code']): DingTalkMessageConfigError {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(DingTalkMessageConfigError)
  const typed = caught as DingTalkMessageConfigError
  expect(typed.code).toBe(code)
  for (const label of CREDENTIAL_LABELS) {
    expect(typed.message).not.toContain(label)
    expect(JSON.stringify({ ...typed, message: typed.message })).not.toContain(label)
  }
  return typed
}

describe('isDingTalkIntegrationScopedCredentialsEnabled', () => {
  it("is ON only for the exact literal 'true'", () => {
    expect(isDingTalkIntegrationScopedCredentialsEnabled({ [SWITCH]: 'true' })).toBe(true)
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['0', '0'],
    ['TRUE', 'TRUE'],
    ['True', 'True'],
    ['leading space', ' true'],
    ['trailing space', 'true '],
    ['1', '1'],
    ['yes', 'yes'],
    ['on', 'on'],
  ])('is OFF for %s', (_label, value) => {
    expect(isDingTalkIntegrationScopedCredentialsEnabled({ [SWITCH]: value })).toBe(false)
  })

  it('reads the env it is given, defaulting to process.env per call', () => {
    vi.stubEnv(SWITCH, 'true')
    expect(isDingTalkIntegrationScopedCredentialsEnabled()).toBe(true)
    vi.stubEnv(SWITCH, 'TRUE')
    expect(isDingTalkIntegrationScopedCredentialsEnabled()).toBe(false)
    vi.unstubAllEnvs()
  })
})

describe('resolveDingTalkMessageTuple (pure decision table)', () => {
  it('missing row: typed integration_not_found even when the env triple is complete', () => {
    const typed = expectTypedFailure(
      () => resolveDingTalkMessageTuple(env({ appKey: ENV_KEY, appSecret: ENV_SECRET, agentId: ENV_AGENT }), null, 'dir-missing'),
      'integration_not_found',
    )
    expect(typed.message).toContain('dir-missing')
  })

  describe('same app (env appKey equals the row appKey): env overrides field by field', () => {
    it('complete env triple → env values, env baseUrl first', () => {
      const resolved = resolveDingTalkMessageTuple(
        env({ appKey: ROW_KEY, appSecret: ENV_SECRET, agentId: ENV_AGENT, baseUrl: ENV_BASE }),
        row({ baseUrl: ROW_BASE }),
        'dir-1',
      )
      expect(resolved).toEqual({
        source: 'env_override',
        config: { appKey: ROW_KEY, appSecret: ENV_SECRET, agentId: ENV_AGENT, baseUrl: ENV_BASE },
      })
    })

    it('env key/secret only → agentId from the row, baseUrl from the row when env has none', () => {
      const resolved = resolveDingTalkMessageTuple(
        env({ appKey: ROW_KEY, appSecret: ENV_SECRET }),
        row({ baseUrl: ROW_BASE }),
        'dir-1',
      )
      expect(resolved).toEqual({
        source: 'env_override',
        config: { appKey: ROW_KEY, appSecret: ENV_SECRET, agentId: ROW_AGENT, baseUrl: ROW_BASE },
      })
    })

    it('neither side has an agentId → typed integration_tuple_incomplete naming the field', () => {
      const typed = expectTypedFailure(
        () => resolveDingTalkMessageTuple(env({ appKey: ROW_KEY, appSecret: ENV_SECRET }), row({ agentId: '' }), 'dir-1'),
        'integration_tuple_incomplete',
      )
      expect(typed.message).toContain('missing: agentId')
      expect(typed.message).toContain('dir-1')
    })

    it('requires the row to be active too: a paused integration of the same app is typed integration_inactive', () => {
      const typed = expectTypedFailure(
        () => resolveDingTalkMessageTuple(
          env({ appKey: ROW_KEY, appSecret: ENV_SECRET, agentId: ENV_AGENT }),
          row({ integrationStatus: 'paused' }),
          'dir-1',
        ),
        'integration_inactive',
      )
      expect(typed.message).toContain('dir-1')
    })

    it('an env Agent ID that is used must be 1-32 digits: a placeholder is typed env_agent_id_invalid, values-free', () => {
      const typed = expectTypedFailure(
        () => resolveDingTalkMessageTuple(env({ appKey: ROW_KEY, appSecret: ENV_SECRET, agentId: PLACEHOLDER_AGENT }), row(), 'dir-1'),
        'env_agent_id_invalid',
      )
      expect(typed.message).toContain('DINGTALK_AGENT_ID or DINGTALK_NOTIFY_AGENT_ID')
      expect(resolveDingTalkMessageTuple(
        env({ appKey: ROW_KEY, appSecret: ENV_SECRET, agentId: '0012345' }),
        row(),
        'dir-1',
      ).config.agentId).toBe('0012345')
    })
  })

  describe('different app (or no env appKey): the row as a whole, nothing borrowed from env', () => {
    it('complete env triple of another app + complete row → the row tuple', () => {
      const resolved = resolveDingTalkMessageTuple(
        env({ appKey: ENV_KEY, appSecret: ENV_SECRET, agentId: ENV_AGENT }),
        row(),
        'dir-1',
      )
      expect(resolved).toEqual({
        source: 'integration',
        config: { appKey: ROW_KEY, appSecret: ROW_SECRET, agentId: ROW_AGENT, baseUrl: undefined },
      })
    })

    it('env key/secret of another app + complete row → the row tuple (no env secret with a row agentId)', () => {
      const resolved = resolveDingTalkMessageTuple(env({ appKey: ENV_KEY, appSecret: ENV_SECRET }), row(), 'dir-1')
      expect(resolved.config).toEqual({ appKey: ROW_KEY, appSecret: ROW_SECRET, agentId: ROW_AGENT, baseUrl: undefined })
    })

    it('no env at all + complete row → the row tuple', () => {
      const resolved = resolveDingTalkMessageTuple(env(), row(), 'dir-1')
      expect(resolved).toEqual({
        source: 'integration',
        config: { appKey: ROW_KEY, appSecret: ROW_SECRET, agentId: ROW_AGENT, baseUrl: undefined },
      })
    })

    it('env agentId only + row without agentId → typed incomplete (the env agentId is not borrowed)', () => {
      const typed = expectTypedFailure(
        () => resolveDingTalkMessageTuple(env({ agentId: ENV_AGENT }), row({ agentId: '' }), 'dir-1'),
        'integration_tuple_incomplete',
      )
      expect(typed.message).toContain('missing: agentId')
    })

    it('another app in env + row without agentId → typed incomplete, not the env tuple', () => {
      expectTypedFailure(
        () => resolveDingTalkMessageTuple(env({ appKey: ENV_KEY, appSecret: ENV_SECRET, agentId: ENV_AGENT }), row({ agentId: '' }), 'dir-1'),
        'integration_tuple_incomplete',
      )
    })

    it('row missing several fields → every missing field is named', () => {
      const typed = expectTypedFailure(
        () => resolveDingTalkMessageTuple(env(), row({ appSecret: '', agentId: '' }), 'dir-1'),
        'integration_tuple_incomplete',
      )
      expect(typed.message).toContain('missing: appSecret, agentId')
    })

    it('inactive row → typed integration_inactive before completeness is judged', () => {
      const typed = expectTypedFailure(
        () => resolveDingTalkMessageTuple(env({ appKey: ENV_KEY, appSecret: ENV_SECRET, agentId: ENV_AGENT }), row({ integrationStatus: 'paused', agentId: '' }), 'dir-1'),
        'integration_inactive',
      )
      expect(typed.message).toContain('dir-1')
      expect(typed.message).not.toMatch(/not configured|required|not found|Agent ID/i)
    })

    it('an env Agent ID placeholder of another app is not used, so it is not judged (the row tuple)', () => {
      const resolved = resolveDingTalkMessageTuple(env({ appKey: ENV_KEY, appSecret: ENV_SECRET, agentId: PLACEHOLDER_AGENT }), row(), 'dir-1')
      expect(resolved).toEqual({
        source: 'integration',
        config: { appKey: ROW_KEY, appSecret: ROW_SECRET, agentId: ROW_AGENT, baseUrl: undefined },
      })
    })

    it('baseUrl follows the row: stored first, env as the fallback, else undefined', () => {
      expect(resolveDingTalkMessageTuple(env({ baseUrl: ENV_BASE }), row({ baseUrl: ROW_BASE }), 'dir-1').config.baseUrl).toBe(ROW_BASE)
      expect(resolveDingTalkMessageTuple(env({ baseUrl: ENV_BASE }), row(), 'dir-1').config.baseUrl).toBe(ENV_BASE)
      expect(resolveDingTalkMessageTuple(env(), row(), 'dir-1').config.baseUrl).toBeUndefined()
    })
  })
})

describe('typed failure shape', () => {
  it('is a plain Error subclass, not the admin fixed-sentence class', () => {
    const typed = expectTypedFailure(() => resolveDingTalkMessageTuple(env(), null, 'dir-1'), 'integration_not_found')
    expect(typed).toBeInstanceOf(Error)
    expect(typed).not.toBeInstanceOf(DingTalkConfigValidationError)
    expect(typed.name).toBe('DingTalkMessageConfigError')
  })

  it('every failure sentence fits the attendance ledger text without truncation (36-character integration id)', () => {
    const cases: Array<[() => unknown, DingTalkMessageConfigError['code']]> = [
      [() => resolveDingTalkMessageTuple(env(), null, UUID_LIKE_ID), 'integration_not_found'],
      [() => resolveDingTalkMessageTuple(env(), row({ integrationId: UUID_LIKE_ID, integrationStatus: 'paused' }), UUID_LIKE_ID), 'integration_inactive'],
      [() => resolveDingTalkMessageTuple(env(), row({ integrationId: UUID_LIKE_ID, appKey: '', appSecret: '', agentId: '' }), UUID_LIKE_ID), 'integration_tuple_incomplete'],
      [() => resolveDingTalkMessageTuple(env({ appKey: ROW_KEY }), row({ integrationId: UUID_LIKE_ID, appSecret: '', agentId: '' }), UUID_LIKE_ID), 'integration_tuple_incomplete'],
      [() => resolveDingTalkMessageTuple(env({ appKey: ROW_KEY, agentId: PLACEHOLDER_AGENT }), row({ integrationId: UUID_LIKE_ID }), UUID_LIKE_ID), 'env_agent_id_invalid'],
    ]
    for (const [fn, code] of cases) {
      const typed = expectTypedFailure(fn, code)
      expect(typed.message.length).toBeLessThanOrEqual(ATTENDANCE_LEDGER_TEXT_LIMIT)
    }
  })
})

describe('readDingTalkMessageConfigFromRuntime with the switch as an input', () => {
  function storedRow(config: Record<string, unknown> = {}, status = 'active') {
    return {
      id: 'dir-1',
      name: 'Directory A',
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

  beforeEach(() => {
    vi.unstubAllEnvs()
    dbMocks.query.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe.each([
    ['unset', undefined],
    ['TRUE', 'TRUE'],
    ['leading space', ' true'],
    ['1', '1'],
    ['false', 'false'],
  ])('switch OFF (%s): pre-switch behaviour', (_label, value) => {
    beforeEach(() => {
      if (value !== undefined) vi.stubEnv(SWITCH, value)
    })

    it('complete env triple of another app + integration named → env tuple, no row read', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)

      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toEqual({
        appKey: ENV_KEY,
        appSecret: ENV_SECRET,
        agentId: ENV_AGENT,
        baseUrl: undefined,
      })
      expect(dbMocks.query).not.toHaveBeenCalled()
    })

    it('env key/secret of another app + row agentId → cross-source per-field tuple with the row baseUrl', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ baseUrl: ROW_BASE })] })

      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toEqual({
        appKey: ENV_KEY,
        appSecret: ENV_SECRET,
        agentId: ROW_AGENT,
        baseUrl: ROW_BASE,
      })
      expect(dbMocks.query).toHaveBeenCalledTimes(1)
    })

    it('inactive row is still used (no status rule before the switch)', async () => {
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({}, 'paused')] })

      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toEqual({
        appKey: ROW_KEY,
        appSecret: ROW_SECRET,
        agentId: ROW_AGENT,
        baseUrl: undefined,
      })
    })

    it('missing row with a partial env → the pre-switch plain Error text', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      dbMocks.query.mockResolvedValueOnce({ rows: [] })

      const failure = await readDingTalkMessageConfigFromRuntime('dir-1').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(DingTalkMessageConfigError)
      expect((failure as Error).message).toBe('DINGTALK_APP_SECRET or DINGTALK_CLIENT_SECRET is not configured')
    })

    it('an env Agent ID placeholder is passed through as it is (no shape check before the switch)', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_AGENT_ID', PLACEHOLDER_AGENT)

      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toMatchObject({ agentId: PLACEHOLDER_AGENT })
      await expect(readDingTalkMessageConfigFromRuntime()).resolves.toMatchObject({ agentId: PLACEHOLDER_AGENT })
      expect(dbMocks.query).not.toHaveBeenCalled()
    })

    it('row without agentId and no env agentId → the pre-switch plain Error text', async () => {
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ workNotificationAgentId: '' })] })

      const failure = await readDingTalkMessageConfigFromRuntime('dir-1').catch((error: unknown) => error)
      expect(failure).not.toBeInstanceOf(DingTalkMessageConfigError)
      expect((failure as Error).message).toBe('DINGTALK_AGENT_ID, DINGTALK_NOTIFY_AGENT_ID, or directory workNotificationAgentId is not configured')
    })
  })

  describe("switch ON ('true')", () => {
    beforeEach(() => {
      vi.stubEnv(SWITCH, 'true')
    })

    it('complete env triple of the SAME app + integration named → env tuple, and the row IS read once', async () => {
      vi.stubEnv('DINGTALK_APP_KEY', ROW_KEY)
      vi.stubEnv('DINGTALK_APP_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })

      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toEqual({
        appKey: ROW_KEY,
        appSecret: ENV_SECRET,
        agentId: ENV_AGENT,
        baseUrl: undefined,
      })
      expect(dbMocks.query).toHaveBeenCalledTimes(1)
      expect(String(dbMocks.query.mock.calls[0][0])).toContain('FROM directory_integrations')
      expect(dbMocks.query.mock.calls[0][1]).toEqual(['dir-1', 'dingtalk'])
    })

    it('same app, env key/secret only → row agentId (the per-field case kept)', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ROW_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ baseUrl: ROW_BASE })] })

      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toEqual({
        appKey: ROW_KEY,
        appSecret: ENV_SECRET,
        agentId: ROW_AGENT,
        baseUrl: ROW_BASE,
      })
    })

    it('complete env triple of ANOTHER app + integration named → the row tuple instead of env', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })

      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toEqual({
        appKey: ROW_KEY,
        appSecret: ROW_SECRET,
        agentId: ROW_AGENT,
        baseUrl: undefined,
      })
      expect(dbMocks.query).toHaveBeenCalledTimes(1)
    })

    it('env key/secret of another app + row agentId (the OFF pin fixture) → the row tuple, no cross-source mix', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ baseUrl: ROW_BASE })] })

      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toEqual({
        appKey: ROW_KEY,
        appSecret: ROW_SECRET,
        agentId: ROW_AGENT,
        baseUrl: ROW_BASE,
      })
    })

    it('message-side alias order: DINGTALK_APP_KEY decides "same app" before DINGTALK_CLIENT_ID', async () => {
      vi.stubEnv('DINGTALK_APP_KEY', ROW_KEY)
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_APP_SECRET', ENV_SECRET)
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })

      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toMatchObject({
        appKey: ROW_KEY,
        appSecret: ENV_SECRET,
        agentId: ROW_AGENT,
      })
    })

    it('another app in env + row without agentId → typed incomplete, no send on env credentials', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({ workNotificationAgentId: '' })] })

      const failure = await readDingTalkMessageConfigFromRuntime('dir-1').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DingTalkMessageConfigError)
      expect((failure as DingTalkMessageConfigError).code).toBe('integration_tuple_incomplete')
      for (const label of CREDENTIAL_LABELS) expect((failure as Error).message).not.toContain(label)
    })

    it('inactive row of another app → typed integration_inactive', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({}, 'paused')] })

      const failure = await readDingTalkMessageConfigFromRuntime('dir-1').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DingTalkMessageConfigError)
      expect((failure as DingTalkMessageConfigError).code).toBe('integration_inactive')
    })

    it('missing row + complete env triple → typed integration_not_found (no env send for an unknown integration)', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)
      dbMocks.query.mockResolvedValueOnce({ rows: [] })

      const failure = await readDingTalkMessageConfigFromRuntime('dir-1').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DingTalkMessageConfigError)
      expect((failure as DingTalkMessageConfigError).code).toBe('integration_not_found')
      expect((failure as Error).message).toContain('dir-1')
    })

    it('paused row of the SAME app → typed integration_inactive (no env send for a paused integration)', async () => {
      vi.stubEnv('DINGTALK_APP_KEY', ROW_KEY)
      vi.stubEnv('DINGTALK_APP_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow({}, 'paused')] })

      const failure = await readDingTalkMessageConfigFromRuntime('dir-1').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DingTalkMessageConfigError)
      expect((failure as DingTalkMessageConfigError).code).toBe('integration_inactive')
    })

    it('same app with an env Agent ID placeholder → typed env_agent_id_invalid, values-free', async () => {
      vi.stubEnv('DINGTALK_APP_KEY', ROW_KEY)
      vi.stubEnv('DINGTALK_APP_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_NOTIFY_AGENT_ID', PLACEHOLDER_AGENT)
      dbMocks.query.mockResolvedValueOnce({ rows: [storedRow()] })

      const failure = await readDingTalkMessageConfigFromRuntime('dir-1').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DingTalkMessageConfigError)
      expect((failure as DingTalkMessageConfigError).code).toBe('env_agent_id_invalid')
      for (const label of CREDENTIAL_LABELS) expect((failure as Error).message).not.toContain(label)
    })

    it('baseUrl follows the row source: stored first, env DINGTALK_BASE_URL as the fallback', async () => {
      vi.stubEnv('DINGTALK_BASE_URL', ENV_BASE)
      dbMocks.query
        .mockResolvedValueOnce({ rows: [storedRow({ baseUrl: ROW_BASE })] })
        .mockResolvedValueOnce({ rows: [storedRow()] })

      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toMatchObject({ baseUrl: ROW_BASE })
      await expect(readDingTalkMessageConfigFromRuntime('dir-1')).resolves.toMatchObject({ baseUrl: ENV_BASE })
    })

    it('no integration named → the pre-switch path unchanged (complete env triple, no row read)', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_AGENT_ID', ENV_AGENT)

      await expect(readDingTalkMessageConfigFromRuntime()).resolves.toEqual({
        appKey: ENV_KEY,
        appSecret: ENV_SECRET,
        agentId: ENV_AGENT,
        baseUrl: undefined,
      })
      await expect(readDingTalkMessageConfigFromRuntime('   ')).resolves.toMatchObject({ appKey: ENV_KEY })
      expect(dbMocks.query).not.toHaveBeenCalled()
    })

    it('no integration named + env Agent ID placeholder → typed env_agent_id_invalid before any row read', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      vi.stubEnv('DINGTALK_CLIENT_SECRET', ENV_SECRET)
      vi.stubEnv('DINGTALK_AGENT_ID', PLACEHOLDER_AGENT)

      const failure = await readDingTalkMessageConfigFromRuntime().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DingTalkMessageConfigError)
      expect((failure as DingTalkMessageConfigError).code).toBe('env_agent_id_invalid')
      for (const label of CREDENTIAL_LABELS) expect((failure as Error).message).not.toContain(label)
      expect(dbMocks.query).not.toHaveBeenCalled()
    })

    it('no integration named, partial env → the pre-switch latest-active fallback and plain Error text', async () => {
      vi.stubEnv('DINGTALK_CLIENT_ID', ENV_KEY)
      dbMocks.query.mockResolvedValueOnce({ rows: [] })

      const failure = await readDingTalkMessageConfigFromRuntime().catch((error: unknown) => error)
      expect(failure).not.toBeInstanceOf(DingTalkMessageConfigError)
      expect((failure as Error).message).toBe('DINGTALK_APP_SECRET or DINGTALK_CLIENT_SECRET is not configured')
      expect(String(dbMocks.query.mock.calls[0][0])).toContain('ORDER BY CASE WHEN status')
    })
  })
})

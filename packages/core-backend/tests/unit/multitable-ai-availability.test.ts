/**
 * A11 (customer feedback 2026-09-24 #7c) — GET /api/multitable/ai/availability.
 *
 * The web client hides every multitable AI surface unless this answers
 * `{ available: true }`. What is pinned here:
 *   - any authenticated caller may ask (NOT admin-gated, unlike /ai/readiness);
 *     no user → 401;
 *   - the default deployment (no AI env) answers false;
 *   - true needs ALL of: readiness ready, MULTITABLE_AI_CONFIRM_LIVE_REQUESTS === '1'
 *     (exact), AND the data-class routing gate allowing BUSINESS data — each one
 *     missing flips it back to false;
 *   - the body is exactly `{ available }`: no provider, model, host, env name or
 *     env value, whatever the env holds;
 *   - no provider call is ever made;
 *   - the predicate agrees with the live choke (`runShortcutCore`): for every env
 *     in the matrix, available === "runShortcutCore did not answer `blocked`".
 *
 * Transport: one pinned server per file (tests/utils/pinned-server.ts), never
 * `request(app)` (#4154).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAdmin } from '../../src/rbac/service'
import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../src/db/pg', () => ({
  pool: null,
}))

import { createMultitableAiRoutes } from '../../src/routes/multitable-ai'
import { AiProviderClient } from '../../src/services/ai-provider-client'
import { runShortcutCore, type ShortcutRequestContext } from '../../src/services/ai-bulk-shared'
import { resolveShortcutAvailability } from '../../src/services/ai-shortcut-availability'
import { AI_ROUTING_POLICY_PATH_ENV } from '../../src/services/ai-routing-policy'

const AI_ENV_KEYS = [
  'MULTITABLE_AI_ENABLED',
  'MULTITABLE_AI_PROVIDER',
  'MULTITABLE_AI_API_KEY',
  'MULTITABLE_AI_BASE_URL',
  'MULTITABLE_AI_MODEL',
  'MULTITABLE_AI_REQUEST_TIMEOUT_MS',
  'MULTITABLE_AI_MAX_OUTPUT_TOKENS',
  'MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP',
  'MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP',
  'MULTITABLE_AI_TENANT_BURST_RPM',
  'MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP',
  'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS',
  AI_ROUTING_POLICY_PATH_ENV,
] as const

const scratch = mkdtempSync(join(tmpdir(), 'ai-availability-'))
let policyCounter = 0
function policyFile(json: unknown): string {
  const path = join(scratch, `policy-${policyCounter++}.json`)
  writeFileSync(path, JSON.stringify(json), 'utf8')
  return path
}
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Every condition met: local lane, loopback endpoint, model named, enabled, live requests confirmed. */
const FULL_LOCAL_ENV: Record<string, string> = {
  MULTITABLE_AI_ENABLED: '1',
  MULTITABLE_AI_PROVIDER: 'local-openai-compat',
  MULTITABLE_AI_BASE_URL: 'http://127.0.0.1:8000',
  MULTITABLE_AI_MODEL: 'qwen2.5:14b-instruct',
  MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: '1',
}

/**
 * The env matrix shared by the route cases and the live-choke agreement case.
 * `expected` is the availability each env must produce.
 */
function envMatrix(): Array<{ name: string; env: Record<string, string>; expected: boolean }> {
  return [
    { name: 'default deployment (no AI env at all)', env: {}, expected: false },
    { name: 'all conditions met (local lane, loopback, confirmed)', env: { ...FULL_LOCAL_ENV }, expected: true },
    {
      name: 'all conditions met on an RFC1918 host',
      env: { ...FULL_LOCAL_ENV, MULTITABLE_AI_BASE_URL: 'http://10.77.0.5:8000' },
      expected: true,
    },
    { name: 'enable flag missing', env: omit(FULL_LOCAL_ENV, 'MULTITABLE_AI_ENABLED'), expected: false },
    { name: 'enable flag not exactly 1', env: { ...FULL_LOCAL_ENV, MULTITABLE_AI_ENABLED: 'true' }, expected: false },
    { name: 'live-request confirmation missing', env: omit(FULL_LOCAL_ENV, 'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS'), expected: false },
    {
      name: "live-request confirmation 'true' (exact '1' only)",
      env: { ...FULL_LOCAL_ENV, MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: 'true' },
      expected: false,
    },
    { name: 'model missing on the local lane', env: omit(FULL_LOCAL_ENV, 'MULTITABLE_AI_MODEL'), expected: false },
    {
      name: 'local lane pointed at a public host',
      env: { ...FULL_LOCAL_ENV, MULTITABLE_AI_BASE_URL: 'https://llm.example.com' },
      expected: false,
    },
    {
      // Readiness READY, confirmation SET, model PRICED — only the routing gate says no:
      // business data never goes to a cloud provider.
      name: 'cloud provider (anthropic) fully configured — routing refuses business data',
      env: {
        MULTITABLE_AI_ENABLED: '1',
        MULTITABLE_AI_PROVIDER: 'anthropic',
        MULTITABLE_AI_API_KEY: 'test-key-placeholder',
        MULTITABLE_AI_MODEL: 'claude-sonnet-4-6',
        MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: '1',
      },
      expected: false,
    },
    {
      name: 'cloud provider (openai) with a policy that allowlists non-sensitive data for cloud — still refused',
      env: {
        MULTITABLE_AI_ENABLED: '1',
        MULTITABLE_AI_PROVIDER: 'openai',
        MULTITABLE_AI_API_KEY: 'test-key-placeholder',
        MULTITABLE_AI_MODEL: 'gpt-4o-mini',
        MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: '1',
        [AI_ROUTING_POLICY_PATH_ENV]: policyFile({
          policyId: 'cloud-nonsensitive',
          policyVersion: 1,
          activeProvider: { tier: 'cloud' },
          cloudDataClasses: ['non-sensitive'],
        }),
      },
      expected: false,
    },
    {
      name: 'local lane on a public-looking DNS name listed in the policy localHosts — allowed',
      env: {
        ...FULL_LOCAL_ENV,
        MULTITABLE_AI_BASE_URL: 'http://llm.corp.example.com:8000',
        [AI_ROUTING_POLICY_PATH_ENV]: policyFile({
          policyId: 'onprem-allowlist',
          policyVersion: 1,
          activeProvider: { tier: 'local' },
          localHosts: ['llm.corp.example.com'],
        }),
      },
      expected: true,
    },
    {
      name: 'openai provider declared local by policy AND pointed at a private host — allowed',
      env: {
        MULTITABLE_AI_ENABLED: '1',
        MULTITABLE_AI_PROVIDER: 'openai',
        MULTITABLE_AI_API_KEY: 'test-key-placeholder',
        MULTITABLE_AI_MODEL: 'gpt-4o-mini',
        MULTITABLE_AI_BASE_URL: 'http://10.77.0.5:8000',
        MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: '1',
        [AI_ROUTING_POLICY_PATH_ENV]: policyFile({ policyId: 'declared-local', policyVersion: 1, activeProvider: { tier: 'local' } }),
      },
      expected: true,
    },
    {
      name: 'openai provider declared local by policy but on the public default endpoint — downgraded, refused',
      env: {
        MULTITABLE_AI_ENABLED: '1',
        MULTITABLE_AI_PROVIDER: 'openai',
        MULTITABLE_AI_API_KEY: 'test-key-placeholder',
        MULTITABLE_AI_MODEL: 'gpt-4o-mini',
        MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: '1',
        [AI_ROUTING_POLICY_PATH_ENV]: policyFile({ policyId: 'declared-local-public', policyVersion: 1, activeProvider: { tier: 'local' } }),
      },
      expected: false,
    },
    {
      name: 'routing policy file unusable — fails closed',
      env: { ...FULL_LOCAL_ENV, [AI_ROUTING_POLICY_PATH_ENV]: join(scratch, 'does-not-exist.json') },
      expected: false,
    },
  ]
}

function omit(env: Record<string, string>, key: string): Record<string, string> {
  const next = { ...env }
  delete next[key]
  return next
}

function applyEnv(env: Record<string, string>): void {
  for (const key of AI_ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
}

function buildApp(user: { id: string } | undefined, fetchFn: typeof fetch) {
  const app = express()
  if (user) {
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string } }).user = user
      next()
    })
  }
  app.use('/api/multitable', createMultitableAiRoutes({ fetchFn }))
  return app
}

const pinned = usePinnedServer()
const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of AI_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  vi.mocked(isAdmin).mockReset()
  vi.mocked(isAdmin).mockResolvedValue(false)
})

afterEach(() => {
  for (const key of AI_ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('GET /api/multitable/ai/availability (A11, any authenticated caller)', () => {
  it('default deployment: a plain (non-admin) user gets 200 { available: false } and nothing else', async () => {
    const fetchFn = vi.fn()
    pinned.setApp(buildApp({ id: 'user-1' }, fetchFn as unknown as typeof fetch))
    const res = await request(pinned.url()).get('/api/multitable/ai/availability').expect(200)

    expect(res.body).toEqual({ available: false })
    expect(Object.keys(res.body)).toEqual(['available'])
    // Not admin-gated: the RBAC admin check is never consulted.
    expect(vi.mocked(isAdmin)).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('no authenticated user → 401, and no availability bit leaks', async () => {
    applyEnv(FULL_LOCAL_ENV)
    const fetchFn = vi.fn()
    pinned.setApp(buildApp(undefined, fetchFn as unknown as typeof fetch))
    const res = await request(pinned.url()).get('/api/multitable/ai/availability').expect(401)

    expect(res.body.error?.code).toBe('UNAUTHORIZED')
    expect(res.body.available).toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  for (const row of envMatrix()) {
    it(`${row.name} → available: ${row.expected}`, async () => {
      applyEnv(row.env)
      const fetchFn = vi.fn()
      pinned.setApp(buildApp({ id: 'user-1' }, fetchFn as unknown as typeof fetch))
      const res = await request(pinned.url()).get('/api/multitable/ai/availability').expect(200)

      expect(res.body).toEqual({ available: row.expected })
      expect(fetchFn).not.toHaveBeenCalled()
    })
  }

  it('values-free: sentinel env values never reach the body, in either state', async () => {
    const PASSWORD = 'AvailS3cretPw'
    const KEY = `sk-${'avail123'.repeat(4)}`
    const MODEL = 'sentinel-model-zq7'
    const HOST = 'sentinel-host-zq7.internal'
    const fetchFn = vi.fn()

    // Available state (local lane on a private DNS suffix, credentialed URL, a key set).
    applyEnv({
      ...FULL_LOCAL_ENV,
      MULTITABLE_AI_BASE_URL: `http://ops:${PASSWORD}@${HOST}:8000`,
      MULTITABLE_AI_API_KEY: KEY,
      MULTITABLE_AI_MODEL: MODEL,
    })
    pinned.setApp(buildApp({ id: 'user-1' }, fetchFn as unknown as typeof fetch))
    const on = await request(pinned.url()).get('/api/multitable/ai/availability').expect(200)
    expect(on.body).toEqual({ available: true })

    // Blocked state (same values, confirmation withdrawn).
    delete process.env.MULTITABLE_AI_CONFIRM_LIVE_REQUESTS
    const off = await request(pinned.url()).get('/api/multitable/ai/availability').expect(200)
    expect(off.body).toEqual({ available: false })

    for (const res of [on, off]) {
      const raw = res.text
      for (const secret of [PASSWORD, KEY, MODEL, HOST, 'local-openai-compat', 'MULTITABLE_AI', '127.0.0.1', 'qwen']) {
        expect(raw).not.toContain(secret)
      }
      expect(Object.keys(res.body)).toEqual(['available'])
    }
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('resolveShortcutAvailability agrees with the live choke (runShortcutCore)', () => {
  function fakePool() {
    const query = vi.fn(async () => ({ rows: [] as unknown[], rowCount: 0 }))
    return {
      query,
      transaction: async <T>(handler: (c: { query: typeof query }) => Promise<T>): Promise<T> => handler({ query }),
    } as unknown as ShortcutRequestContext['pool']
  }

  for (const row of envMatrix()) {
    it(`${row.name}: available === (runShortcutCore did not answer 'blocked')`, async () => {
      applyEnv(row.env)
      const fetchFn = vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      const client = new AiProviderClient({ fetchFn: fetchFn as unknown as typeof fetch })

      const available = resolveShortcutAvailability(client)
      expect(available).toBe(row.expected)

      const outcome = await runShortcutCore(
        client,
        { pool: fakePool(), sheetId: 'sheet_1', recordId: 'rec_1', fieldId: 'fld_1', action: 'preview', userId: 'user-1' },
        'Summarize: plain text',
      )
      expect(outcome.kind === 'blocked').toBe(!available)
    })
  }
})

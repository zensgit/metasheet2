/**
 * PLM-COLLAB Discussion read-auth line — sub-slice 6: LOCAL DUAL-SERVICE E2E (build-then-HOLD).
 *
 * Traverses the FULL chain with NO mocked middle in the security path:
 *   mint (real Ed25519) -> supertest -> REAL ms2 read relay (embedTokenAuth + runEmbedReadGuards +
 *   REAL consumeEmbedJti/embedJtiKey) -> REAL PLMAdapter over REAL HTTP -> REAL temp Yuantus
 *   provider (read-session exchange + the two /discussions read-gate routes).
 *
 * What is REAL vs substituted (honest — see the reality table in the task report):
 *   - REAL: the mint signature; the relay app + embedTokenAuth + guards; the jti single-use LOGIC
 *     (consumeEmbedJti/embedJtiKey run unmodified); the PLMAdapter; the Node->Yuantus HTTP hop; the
 *     Yuantus read exchange + read gate; the provider's AuthEmbedExchangeJti single-use.
 *   - SUBSTITUTED (labeled): the Redis BACKEND behind getRedisClient is an in-process NX-semantics
 *     Map (no redis binary / ioredis-mock in this env) — NOT "real Redis"; the DataSourceManager
 *     REGISTRY lookup returns the real adapter directly; the driver->relay transport is supertest
 *     (which still runs the real relay middleware in-process). The global session-JWT gate is
 *     inlined (a stand-in, per the unit test) so no infra module graph is pulled in.
 *
 * Gated behind RUN_PLM_READ_E2E; CI wiring DEFERRED (owner wires it as the final merge gate).
 */
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EMBED_AUDIENCE,
  EMBED_KEY_ID,
  PREAUTH_BURST,
  SERVED_TENANT,
  generateEmbedKeys,
  httpLogin,
  httpMint,
  makeTempDir,
  mintTokens,
  queryMintAudit,
  rmTempDir,
  seed,
  startProvider,
  stopProvider,
  type EmbedKeys,
  type Provider,
} from './harness'

// ---- in-process Redis BACKEND substitute (NX single-use semantics; NOT real Redis) -------------
// The REAL consumeEmbedJti/embedJtiKey run on top of this — only the storage backend is in-memory,
// because this env has no redis binary and no ioredis-mock. The NX branch is what makes a replay
// return null (a regression that dropped NX would flip the replay assertions), so single-use is
// genuinely exercised, not asserted against a stub.
const redisSub = vi.hoisted(() => {
  const store = new Map<string, string>()
  const client = {
    set: async (key: string, val: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return null
      store.set(key, val)
      return 'OK'
    },
  }
  return { client, store }
})
vi.mock('../../src/db/redis', () => ({
  getRedisClient: async () => redisSub.client,
  closeRedisClient: async () => {},
}))

// ---- DataSourceManager registry lookup -> the REAL PLMAdapter (mutable so we can point the relay
// at the main provider or the dark-flag provider per case). The ADAPTER is real; only the registry
// indirection is stubbed. -----------------------------------------------------------------------
const dsState = vi.hoisted(() => ({ adapter: null as unknown }))
vi.mock('../../src/routes/data-sources', () => ({
  getDataSourceManager: () => ({ getDataSource: () => dsState.adapter }),
}))

import plmEmbedDiscussionReadRouter from '../../src/routes/plm-embed-discussion-read'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
// The REAL scoped-jti key fn (NOT mocked — only db/redis is). Used to prove the relay did not
// consume the cross-tenant token's jti.
import { embedJtiKey } from '../../src/auth/embed-jti-store'

/** Decode an embed JWT's claims (unverified — only to derive the scoped jti key for assertions). */
function decodeClaims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
}

const DS_ID = 'plm-ds'
const USER = 42
const PART = 'item-1'
const THREADS_URL = '/api/plm-embed/discussion/threads'
const THREAD_URL = (id: string) => `/api/plm-embed/discussion/threads/${id}`

const RUN = !!process.env.RUN_PLM_READ_E2E

let keys: EmbedKeys
let tmpDir: string
let main: Provider | null = null
let dark: Provider | null = null
let tokens: Record<string, string>
let mintJti: Record<string, string> // jti of each HTTP-minted token (for the audit-log assertion)
let app: express.Express
let mainAdapter: PLMAdapter
let darkAdapter: PLMAdapter

/** Build the REAL read relay app. The pre-router gate is an inlined stand-in for the global
 * session-JWT gate (identical intent to the unit test's buildApp): embed routes pass through, any
 * other /api/* would 401. */
function buildApp(): express.Express {
  const a = express()
  a.use(express.json())
  a.use((req, res, next) => {
    if (req.path.startsWith('/api/plm-embed/')) return next()
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } })
    return next()
  })
  a.use(plmEmbedDiscussionReadRouter())
  return a
}

/** A real PLMAdapter bound to `url`, apiMode 'yuantus', serving tenant 'default' (so the relay's
 * tenant cross-check matches a token minted for 'default'). No username/password -> no service
 * login; the discussion read methods authenticate with the exchanged read credential, not a
 * service token. */
async function makeAdapter(url: string): Promise<PLMAdapter> {
  const cfgMap: Record<string, unknown> = {
    'plm.url': url,
    'plm.apiMode': 'yuantus',
    'plm.tenantId': SERVED_TENANT,
    'plm.mock': false,
  }
  const configService = { get: async (k: string) => cfgMap[k] }
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const adapter = new PLMAdapter(configService as never, logger as never, {
    id: DS_ID,
    name: 'temp PLM',
    type: 'plm',
    connection: { url },
    options: { apiMode: 'yuantus', tenantId: SERVED_TENANT },
  } as never)
  await adapter.connect()
  return adapter
}

async function boot(): Promise<void> {
  keys = generateEmbedKeys()
  tmpDir = makeTempDir()
  seed(keys, `${tmpDir}/main.db`)
  // allSettled (not Promise.all): if one provider fails health, the sibling that DID start is still
  // assigned to a module var so afterAll tears it down — Promise.all destructuring would leak it.
  const [mRes, dRes] = await Promise.allSettled([
    startProvider(keys, `${tmpDir}/main.db`, { readSessionEnabled: true }),
    startProvider(keys, `${tmpDir}/dark.db`, { readSessionEnabled: false }),
  ])
  if (mRes.status === 'fulfilled') main = mRes.value
  if (dRes.status === 'fulfilled') dark = dRes.value
  if (mRes.status === 'rejected') throw mRes.reason
  if (dRes.status === 'rejected') throw dRes.reason

  // The relay verifies embed tokens OFFLINE with the provider's PUBLIC key.
  process.env.YUANTUS_EMBED_PUBLIC_KEY = keys.publicB64
  process.env.YUANTUS_EMBED_KEY_ID = EMBED_KEY_ID
  process.env.PLM_EMBED_AUDIENCE = EMBED_AUDIENCE
  process.env.PLM_EMBED_ALLOWED_ORIGINS = 'https://plm.example.com'
  process.env.PLM_EMBED_DATA_SOURCE_ID = DS_ID

  mainAdapter = await makeAdapter(main.url)
  darkAdapter = await makeAdapter(dark.url)
  expect(mainAdapter.isConnected()).toBe(true)
  expect(mainAdapter.getEffectiveTenantId()).toBe(SERVED_TENANT)
  dsState.adapter = mainAdapter
  app = buildApp()

  // Tokens the REAL HTTP mint route CAN issue (tenant 'default'/part item-1) are obtained through
  // it: one genuine login, then the real POST .../embed-token per token. This exercises the mint
  // route's auth/entitlement/permission/part-binding/audit — no direct mint-service bypass here.
  const bearer = await httpLogin(main.url)
  tokens = {}
  mintJti = {}
  for (const name of ['list', 'detail', 'smoke', 'replay', 'provConsume', 'provCtrl', 'missingDetail', 'crossPartDetail', 'dark']) {
    const m = await httpMint(main.url, bearer, PART)
    tokens[name] = m.embed_token
    mintJti[name] = m.jti
  }
  // ONLY the cross-tenant token uses the direct mint service: the HTTP route binds tenant_id to the
  // authenticated request context (always the served tenant), so it CANNOT issue a token bound to a
  // different tenant by design. The provider still verifies its real Ed25519 signature.
  Object.assign(
    tokens,
    mintTokens(keys, [
      { name: 'crossTenant', user_id: USER, tenant_id: 'tenant-a', org_id: 'org-1', part_id: PART },
    ]),
  )
}

describe.skipIf(!RUN)('PLM discussion read-auth — dual-service E2E (sub-slice 6, build-then-HOLD)', () => {
  beforeAll(boot)
  afterAll(() => {
    stopProvider(main)
    stopProvider(dark)
    rmTempDir(tmpDir)
  })

  describe('provider HTTP smoke (no relay) — mint sig + read exchange + read gate are real', () => {
    it('mint -> exchange -> list returns the seeded open + resolved threads', async () => {
      const exchange = await fetch(`${main!.url}/api/v1/auth/embed/discussion-read-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embed_token: tokens.smoke }),
      })
      expect(exchange.status).toBe(200)
      const cred = (await exchange.json()) as { access_token: string; aud: string }
      expect(cred.aud).toBe('discussion')
      const list = await fetch(
        `${main!.url}/api/v1/discussions?target_type=item&target_id=${PART}&include_resolved=true`,
        { headers: { Authorization: `Bearer ${cred.access_token}` } },
      )
      expect(list.status).toBe(200)
      const ids = ((await list.json()) as { threads: Array<{ id: string }> }).threads.map((t) => t.id)
      expect(ids).toEqual(expect.arrayContaining(['T-open-1', 'T-resolved-1']))
    })
  })

  describe('happy path through the REAL relay', () => {
    it('GET threads: relay -> exchange -> read gate returns the seeded threads (incl. resolved), no cred leak', async () => {
      dsState.adapter = mainAdapter
      const res = await request(app).get(THREADS_URL).set('X-PLM-Embed-Token', tokens.list)
      expect(res.status).toBe(200)
      const ids = (res.body.data.threads as Array<{ id: string }>).map((t) => t.id)
      expect(ids).toEqual(expect.arrayContaining(['T-open-1', 'T-resolved-1']))
      // no read credential / access_token ever leaks to the client
      const serialized = JSON.stringify(res.body) + JSON.stringify(res.headers)
      expect(serialized).not.toContain('access_token')
    })

    it('GET threads/:id: relay returns the bound-part thread detail', async () => {
      dsState.adapter = mainAdapter
      const res = await request(app).get(THREAD_URL('T-open-1')).set('X-PLM-Embed-Token', tokens.detail)
      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe('T-open-1')
    })

    it('the HTTP mint route audited each issuance by jti WITHOUT persisting the raw JWT (P2-1)', () => {
      const rows = queryMintAudit(main!.dbPath)
      expect(rows.length).toBeGreaterThanOrEqual(9) // one MINT row per HTTP-minted token
      const paths = rows.map((r) => String(r.path))
      // the happy-path 'list' token's jti is tracked in an issuance audit row...
      expect(paths.some((p) => p.includes(mintJti.list))).toBe(true)
      // ...but the raw embed JWT is NEVER written to any audit column (no token plaintext at rest).
      const dump = JSON.stringify(rows)
      for (const name of ['list', 'detail']) {
        expect(dump).not.toContain(tokens[name])
      }
      // every MINT row is jti-shaped (…?jti=<uuid>), never a token blob.
      for (const p of paths) expect(p).toMatch(/\/embed-token\?jti=[0-9a-f-]{36}$/)
    })
  })

  // =============================================================================================
  // Owner acceptance coverage — all REAL except the honestly-labeled Redis backend substitute.
  // =============================================================================================

  describe('single-use — TWO independent jti stores, asserted separately', () => {
    it('(a) RELAY layer: replaying the SAME embed token on a 2nd relay call -> 401 (relay Redis substitute burned the jti before the exchange)', async () => {
      dsState.adapter = mainAdapter
      const first = await request(app).get(THREADS_URL).set('X-PLM-Embed-Token', tokens.replay)
      expect(first.status).toBe(200) // first use: real consumeEmbedJti stored it
      const second = await request(app).get(THREADS_URL).set('X-PLM-Embed-Token', tokens.replay)
      expect(second.status).toBe(401)
      expect(second.body.error.code).toBe('EMBED_TOKEN_REPLAYED')
    })

    it('(b) YUANTUS layer: after a real relay FLOW, a DIRECT 2nd call to the provider read exchange with the SAME embed token -> 401 (AuthEmbedExchangeJti already consumed during the flow)', async () => {
      dsState.adapter = mainAdapter
      // Control first: a FRESH token exchanges directly -> 200, proving the exchange path works and
      // the read flag is on (so the 401 below is specifically the provider-side single-use, not a
      // blanket failure).
      const control = await fetch(`${main!.url}/api/v1/auth/embed/discussion-read-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embed_token: tokens.provCtrl }),
      })
      expect(control.status).toBe(200)

      // The relay flow really runs the exchange (a 200 with threads REQUIRES the exchange to have
      // minted the read credential), so provConsume's jti is now burned in the provider's store.
      const flow = await request(app).get(THREADS_URL).set('X-PLM-Embed-Token', tokens.provConsume)
      expect(flow.status).toBe(200)
      const direct = await fetch(`${main!.url}/api/v1/auth/embed/discussion-read-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embed_token: tokens.provConsume }),
      })
      expect(direct.status).toBe(401) // provider AuthEmbedExchangeJti collision -> uniform 401
    })
  })

  describe('error mapping + no-existence-oracle', () => {
    it('provider 404 (nonexistent thread) and a cross-Part thread both surface as the relay uniform 404 with a BYTE-IDENTICAL body, no raw provider detail leaked', async () => {
      dsState.adapter = mainAdapter
      const missing = await request(app).get(THREAD_URL('does-not-exist')).set('X-PLM-Embed-Token', tokens.missingDetail)
      // T-otherpart-1 is a real thread bound to item-ro; this token is bound to item-1 -> provider 404.
      const crossPart = await request(app).get(THREAD_URL('T-otherpart-1')).set('X-PLM-Embed-Token', tokens.crossPartDetail)

      expect(missing.status).toBe(404)
      expect(crossPart.status).toBe(404)
      // no-existence-oracle: same status AND byte-identical body (a cross-part hit is indistinguishable
      // from a plain miss at the relay boundary).
      expect(JSON.stringify(crossPart.body)).toBe(JSON.stringify(missing.body))
      // the relay never echoes the provider's own wording
      const body = JSON.stringify(missing.body)
      expect(body).not.toContain('discussion target not found')
      expect(body).not.toContain('discussion thread not found')
      expect(missing.body.ok).toBe(false)
    })
  })

  describe('approved flag-on posture: pre-auth rate limiter enforcing on the read exchange (P2-3)', () => {
    it('the read-exchange path returns X-RateLimit headers set to the configured burst (limiter genuinely ON, not a silent no-op)', async () => {
      // A bad token still traverses the pre-auth limiter before the endpoint 401s — the limiter
      // stamps X-RateLimit-Limit on the (allowed) response, proving PREAUTH_RATE_LIMIT is enabled
      // AND matches the read-exchange path with THIS config (no token consumed, no throttle).
      const probe = await fetch(`${main!.url}/api/v1/auth/embed/discussion-read-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embed_token: 'not-a-valid-embed-token' }),
      })
      expect(probe.status).toBe(401) // invalid token, past the limiter
      expect(probe.headers.get('x-ratelimit-limit')).toBe(PREAUTH_BURST)
      expect(probe.headers.get('x-ratelimit-remaining')).not.toBeNull()
    })
  })

  describe('dark-flag 401 (provider read exchange disabled on a separate temp Yuantus)', () => {
    it('relay pointed at the dark provider (DISCUSSION_READ_SESSION_ENABLED off) -> uniform 401 EMBED_SESSION_EXCHANGE_FAILED', async () => {
      dsState.adapter = darkAdapter
      const res = await request(app).get(THREADS_URL).set('X-PLM-Embed-Token', tokens.dark)
      dsState.adapter = mainAdapter
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('EMBED_SESSION_EXCHANGE_FAILED')
    })
  })

  describe('cross-tenant pre-rejection (relay guard, before the exchange)', () => {
    it('an embed token bound to tenant-a -> 403 EMBED_TENANT_MISMATCH; the RELAY Redis jti is NOT consumed (rejected before the consume) (P2-2)', async () => {
      dsState.adapter = mainAdapter
      const c = decodeClaims(tokens.crossTenant)
      const scopedKey = embedJtiKey({
        aud: String(c.aud ?? ''),
        feature_key: String(c.feature_key ?? ''),
        tenant_id: String(c.tenant_id ?? ''),
        part_id: String(c.part_id ?? ''),
        jti: String(c.jti ?? ''),
      })
      const sizeBefore = redisSub.store.size
      expect(redisSub.store.has(scopedKey)).toBe(false) // not present going in

      const res = await request(app).get(THREADS_URL).set('X-PLM-Embed-Token', tokens.crossTenant)
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('EMBED_TENANT_MISMATCH')

      // P2-2 core: the relay tenant cross-check fires BEFORE the single-use consume, so the relay's
      // Redis store gained NO entry for this token (distinct from the provider's AuthEmbedExchangeJti,
      // which is a SEPARATE store — this asserts the RELAY layer specifically).
      expect(redisSub.store.has(scopedKey)).toBe(false)
      expect(redisSub.store.size).toBe(sizeBefore)

      // Corroborating: the provider-side jti is untouched too (the token still exchanges directly).
      const stillExchangeable = await fetch(`${main!.url}/api/v1/auth/embed/discussion-read-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embed_token: tokens.crossTenant }),
      })
      expect(stillExchangeable.status).toBe(200)
    })
  })
})

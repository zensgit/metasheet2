// SA05C1: actual runner/planner/db/store/token/exchange/form transport over an
// isolated PostgreSQL schema. Authority and both fetches are SYNTHETIC. This is
// neither a real customer send nor proof that a runtime authorization port exists.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
// This real CJS helper receives Node's native dynamic-import callback, unlike
// Function/eval inside Vitest's VM, and keeps production class identity intact.
const nativeImport = requireCjs('../utils/yida-native-module-import.cjs') as
  (specifier: string) => Promise<Record<string, unknown>>
const root = path.resolve(__dirname, '..', '..', '..', '..')
const lib = path.join(root, 'plugins/plugin-integration-core/lib')
const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
type Value = Record<string, unknown>
type Data = { query(sql: string, params?: unknown[]): Promise<Value[]>; transaction<T>(body: (trx: Pick<Data, 'query'>) => Promise<T>): Promise<T> }
type Result = { status: string; externalWriteAttempted: boolean; businessVerified: false; durable: boolean; record: Value | null }
type Runner = { run(input: Value, options?: { signal: AbortSignal }): Promise<Result> }
type TokenClient = { activate(binding: Value): void; getAccessToken(binding: Value): Promise<string>; dispose(): void }
type HostSecurity = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
type MaterialStore = {
  create(input: Value): Promise<Value>
  rotate(input: Value): Promise<Value>
  revoke(input: Value): Promise<Value>
  loadTokenCredential(binding: Value, options?: Value): Promise<Value>
}
type Deferred = { promise: Promise<void>; resolve(): void }
type Gate = { reached: Promise<void>; release(): void }
type Session = {
  client: PoolClient; pid: number; db: unknown; statements: string[]
  beforeCommit(event: string): Gate
  loseCommitResponse(event: string): void
  releaseGates(): void
}
type Harness = {
  session: Session; snapshot: Value; enabled: unknown; now: number; resolves: number
  tokenCalls: number; businessCalls: { url: string; options: RequestInit }[]
  resolveSnapshot(input: Value): Promise<Value>
  tokenFetch(): Promise<Response>
  businessFetch(url: string, options: RequestInit): Promise<Response>
  runner: Runner; tokenClient: TokenClient; restart(): Runner
}
const copy = <T>(value: T): T => structuredClone(value)
const request = (): Value => ({ operationId: 'synthetic-operation', rowKey: 'synthetic-row' })
const context = (): Value => ({ tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner', actorId: 'synthetic-owner' })
const deferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

it('native Node graph shares production protocol error identity without a database', async () => {
  const protocol = requireCjs(path.join(lib, 'yida-form-transport.cjs'))
  const nativeProtocol = await nativeImport(pathToFileURL(path.join(lib, 'yida-form-transport.cjs')).href)
  expect((nativeProtocol.default as { YidaFormTransportError: unknown }).YidaFormTransportError).toBe(protocol.YidaFormTransportError)
  const runner = await nativeImport(pathToFileURL(path.join(lib, 'yida-delivery-runner.mjs')).href)
  expect(typeof runner.createYidaDeliveryRunner).toBe('function')
})

// Deliberately outside describe.skip: the whole-file PG lane must fail, not
// silently succeed with skipped proof, if either explicit DB gate is absent.
it('sentinel: EXPECT_DB=1 and dedicated DATABASE_URL are both required', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const describeDatabase = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

describeDatabase('SA05C1 single-row delivery composition — real PG, synthetic authority and fetch', () => {
  let pool: Pool
  let owner: PoolClient
  let schema = ''
  let migrationSql = ''
  let materialMigrationSql = ''
  let security: HostSecurity
  let first: Session
  let second: Session
  let createDb: (options: { database: Data }) => unknown
  let createRunner: (options: Value) => Runner
  let createToken: (options: Value) => TokenClient
  let createExchange: (options: Value) => (material: Value, options: Value) => Promise<Value>
  let createTransport: (options: Value) => unknown
  let createMaterialStore: (options: Value) => MaterialStore
  let createDeliveryStore: (options: Value) => { cancelPrepared(input: Value): Promise<Value> }
  let example: () => { config: Value; rows: Value[] }
  let buildPlan: (input: Value) => { rows: { payload: Value; localBusinessKey: string }[] }
  let canonical: (input: unknown) => string
  const sessions: Session[] = []
  const clients: TokenClient[] = []
  const activeRuns: Promise<unknown>[] = []
  const releases: (() => void)[] = []
  const envKeys = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const
  let savedEnv: Array<[typeof envKeys[number], string | undefined]> = []

  function ident(value: string): string {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Invalid synthetic identifier')
    return `"${value}"`
  }
  async function wait(promise: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Synthetic synchronization gate not reached')), 5000)
      })])
    } finally { clearTimeout(timer) }
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    activeRuns.push(promise.catch(() => {}))
    return promise
  }
  function fixed(error: unknown, code: string): boolean {
    const observed = error as { code?: unknown; message?: unknown }
    expect(observed?.code === `YIDA_RUN_${code}` && observed?.message === `YIDA_RUN_${code}`).toBe(true)
    expect(Object.keys(error as object).sort()).toEqual(['code', 'name'])
    expect(JSON.stringify(error).includes('synthetic-private')).toBe(false)
    return true
  }
  async function rejected(promise: Promise<unknown>, code: string): Promise<void> {
    try { await promise } catch (error) { fixed(error, code); return }
    throw new Error(`Expected fixed YIDA_RUN_${code} rejection`)
  }
  function safe(result: Result, status: string, attempted: boolean, durable = true): void {
    expect(Object.keys(result).sort()).toEqual(['businessVerified', 'durable', 'externalWriteAttempted', 'record', 'status'])
    expect(result.status === status && result.externalWriteAttempted === attempted && result.businessVerified === false && result.durable === durable).toBe(true)
    expect(/synthetic-private|claimToken|claim_token|grantRef|payload|succeeded|delivered/.test(JSON.stringify(result))).toBe(false)
    if (result.record) expect(Object.keys(result.record).sort()).toEqual([
      'createdAt', 'id', 'intent', 'operationId', 'ownerId', 'rowKey', 'status', 'tenantId', 'updatedAt', 'workspaceId',
    ])
  }
  async function rows(table = LEDGER): Promise<Value[]> {
    return (await owner.query(`SELECT * FROM ${ident(table)} ORDER BY created_at, id`)).rows as Value[]
  }
  async function evidence() {
    const ledger = await rows(), audit = await rows(AUDIT)
    return { ledger: ledger.length, audit: audit.length, digest: hash(JSON.stringify([ledger, audit])) }
  }
  async function blocked(blockedSession: Session, blocker: Session): Promise<void> {
    expect(blockedSession.pid).not.toBe(blocker.pid)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const result = await owner.query(
        "SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1",
        [blockedSession.pid, blocker.pid],
      )
      if (result.rows[0]?.blocked === true) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('Actual PostgreSQL blocking relation was not observed')
  }
  async function openSession(): Promise<Session> {
    const client = await pool.connect()
    // Pool release retains session-local fault settings; every new test owns
    // clean fault controls without resetting unrelated transaction policy.
    await client.query("SET synthetic.reject_event = ''")
    await client.query("SET synthetic.reject_completions = ''")
    await client.query(`SET search_path TO ${ident(schema)}`)
    await client.query("SET statement_timeout = '10s'")
    // Make omission of the store's explicit READ COMMITTED pin meaningful.
    await client.query("SET SESSION default_transaction_isolation = 'repeatable read'")
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const statements: string[] = []
    const gates = new Map<string, { arrive(): void; open: Promise<void>; release(): void; reached: Promise<void> }>()
    let lostEvent: string | undefined
    let transactionEvent: string | undefined
    const query = async (sql: string, params?: unknown[]): Promise<Value[]> => {
      statements.push(sql) // SQL shapes only; no customer/credential parameter logging.
      if (sql.startsWith(`INSERT INTO "${AUDIT}"`)) {
        const columns = [...sql.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]).slice(1)
        transactionEvent = String(params?.[columns.indexOf('event')])
      }
      return (await client.query(sql, params)).rows as Value[]
    }
    const database: Data = {
      query,
      async transaction(body) {
        transactionEvent = undefined
        await query('BEGIN')
        try {
          const value = await body({ query })
          const gate = gates.get(transactionEvent || '')
          if (gate) {
            gates.delete(transactionEvent || '')
            gate.arrive()
            await gate.open
          }
          await query('COMMIT')
          if (lostEvent !== undefined && transactionEvent === lostEvent) {
            lostEvent = undefined
            throw new Error('synthetic-private-committed-response-lost')
          }
          return value
        } catch (error) {
          await query('ROLLBACK')
          throw error
        }
      },
    }
    const session: Session = {
      client, pid, statements, db: createDb({ database }),
      beforeCommit(event) {
        const reached = deferred(); const opened = deferred()
        const gate = { reached: reached.promise, arrive: reached.resolve, open: opened.promise, release: opened.resolve }
        gates.set(event, gate)
        releases.push(gate.release)
        return { reached: gate.reached, release: gate.release }
      },
      loseCommitResponse(event) { lostEvent = event },
      releaseGates() { for (const gate of gates.values()) gate.release(); gates.clear() },
    }
    sessions.push(session)
    return session
  }

  function harness(session: Session = first, options: Value = {}, durable?: { store: MaterialStore; binding: Value }): Harness {
    const fixture = example()
    const h: Harness = {
      session, snapshot: { ...context(), ...request(), grantRef: 'synthetic-grant', expiresAt: 100000,
        targetRef: 'synthetic-target', targetRevision: 'synthetic-target-version', planRevision: 'synthetic-plan-version',
        credentialRef: 'synthetic-credential', credentialGeneration: 1,
        config: fixture.config, row: fixture.rows[0], systemToken: 'synthetic-private-system', userId: 'synthetic-private-user' },
      enabled: 'true', now: 1000, resolves: 0, tokenCalls: 0, businessCalls: [],
      resolveSnapshot: async () => copy(h.snapshot),
      tokenFetch: async () => new Response('{"accessToken":"synthetic-private-access","expireIn":60}'),
      businessFetch: async () => new Response('{"result":"synthetic-private-instance"}', { status: 201 }),
      runner: undefined as unknown as Runner, tokenClient: undefined as unknown as TokenClient, restart: () => undefined as unknown as Runner,
    }
    if (durable) Object.assign(h.snapshot, durable.binding)
    const token = createToken({
      // Legacy cases retain the explicit synthetic loader. The material cases
      // below use actual 090 persistence and actual host decryption instead.
      loadCredential: durable ? durable.store.loadTokenCredential
        : async (binding: Value) => ({ ...binding, appKey: 'synthetic-private-key', appSecret: 'synthetic-private-secret' }),
      exchangeToken: createExchange({ fetch: async () => { h.tokenCalls++; return h.tokenFetch() } }),
      monotonicNow: () => 0, safetySkewMs: 0,
    })
    clients.push(token)
    h.tokenClient = token
    token.activate(Object.fromEntries(['tenantId', 'workspaceId', 'ownerId', 'credentialRef', 'credentialGeneration'].map((key) => [key, h.snapshot[key]])))
    const transport = createTransport({ readEnablement: () => h.enabled,
      fetch: async (url: string, fetchOptions: RequestInit) => {
        // Observer is a DIFFERENT connection: an uncommitted claim cannot pass.
        const observed = await rows()
        expect(observed.find((row) => row.operation_id === h.snapshot.operationId)?.status).toBe('dispatching')
        h.businessCalls.push({ url, options: fetchOptions })
        return h.businessFetch(url, fetchOptions)
      },
    })
    const runnerOptions = {
      db: session.db, context: context(), tokenClient: token, formTransport: transport,
      resolveExecutionSnapshot: async (input: Value, signalOptions: { signal: AbortSignal }) => {
        expect(signalOptions.signal).toBeInstanceOf(AbortSignal)
        h.resolves++
        return h.resolveSnapshot(input)
      }, readEnablement: () => h.enabled, wallClock: () => h.now, timeoutMs: 60000, ...options,
    }
    h.restart = () => createRunner(runnerOptions)
    h.runner = h.restart()
    return h
  }

  beforeAll(async () => {
    createDb = requireCjs(path.join(lib, 'db.cjs')).createDb
    createToken = requireCjs(path.join(lib, 'yida-token-client.cjs')).createYidaTokenClient
    createExchange = requireCjs(path.join(lib, 'yida-token-exchange.cjs')).createDingTalkAppTokenExchange
    createMaterialStore = requireCjs(path.join(lib, 'yida-credential-material-store.cjs')).createYidaCredentialMaterialStore
    createDeliveryStore = requireCjs(path.join(lib, 'yida-delivery-store.cjs')).createYidaDeliveryStore
    const transportModule = requireCjs(path.join(lib, 'yida-form-transport.cjs'))
    createTransport = transportModule.createYidaFormTransport
    const nativeProtocol = await nativeImport(pathToFileURL(path.join(lib, 'yida-form-transport.cjs')).href)
    expect((nativeProtocol.default as { YidaFormTransportError: unknown }).YidaFormTransportError).toBe(transportModule.YidaFormTransportError)
    canonical = requireCjs(path.join(lib, 'gip-canonical-json.cjs')).stableCanonicalStringify
    const planner = await nativeImport(pathToFileURL(path.join(lib, 'yida-static-plan.mjs')).href)
    example = planner.createYidaProtocolExample as typeof example
    buildPlan = planner.buildYidaStaticPlan as typeof buildPlan
    createRunner = (await nativeImport(pathToFileURL(path.join(lib, 'yida-delivery-runner.mjs')).href)).createYidaDeliveryRunner as typeof createRunner
    migrationSql = ['090_create_integration_yida_delivery_ledger.sql', '091_create_integration_yida_create_fence.sql']
      .map(file => readFileSync(path.join(root, 'packages/core-backend/migrations', file), 'utf8')).join('\n')
    materialMigrationSql = readFileSync(path.join(root, 'packages/core-backend/migrations/092_create_integration_yida_credential_materials.sql'), 'utf8')
    savedEnv = envKeys.map(key => [key, process.env[key]])
    process.env.NODE_ENV = 'production'
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex')
    process.env.ENCRYPTION_SALT = randomBytes(32).toString('hex')
    // Same actual TS host as the material suite; no substitute crypto. The
    // fixed variable import avoids unrelated type-only plugin graph expansion.
    const securityModule = pathToFileURL(path.join(root, 'packages/core-backend/src/security/plugin-runtime-security-service.ts')).href
    const { PluginRuntimeSecurityService } = await import(securityModule) as { PluginRuntimeSecurityService: new () => HostSecurity }
    security = new PluginRuntimeSecurityService()
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000 })
    owner = await pool.connect()
    await owner.query("SET statement_timeout = '10s'")
  }, 30000)

  beforeEach(async () => {
    schema = `yida_runner_${randomUUID().replaceAll('-', '')}`
    await owner.query(`CREATE SCHEMA ${ident(schema)}`)
    await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(migrationSql)
    // Real DB CHECK faults target only the named completion event. Other writes,
    // including the runner's subsequent unknown quarantine, remain real SQL.
    await owner.query(`ALTER TABLE "${AUDIT}" ADD CONSTRAINT synthetic_reject_event CHECK (
      event IS DISTINCT FROM current_setting('synthetic.reject_event', true)
      AND (current_setting('synthetic.reject_completions', true) IS DISTINCT FROM 'true'
        OR event NOT IN ('acknowledgement', 'unknown'))
    ) NOT VALID`)
    first = await openSession()
    second = await openSession()
  }, 30000)

  afterEach(async () => {
    for (const release of releases) release()
    releases.length = 0
    for (const session of sessions) session.releaseGates()
    await Promise.allSettled(activeRuns)
    activeRuns.length = 0
    for (const client of clients) client.dispose()
    clients.length = 0
    for (const session of sessions) {
      await session.client.query('ROLLBACK').catch(() => {})
      session.client.release()
    }
    sessions.length = 0
    if (schema) { await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schema = '' }
  }, 30000)
  afterAll(async () => {
    try { owner?.release(); await pool?.end() }
    finally { for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  })

  it('real migration, independent sessions and exact body-bound digest positive control', async () => {
    const h = harness()
    safe(await h.runner.run(request()), 'acknowledged', true)
    expect(first.pid).not.toBe(second.pid)
    expect((await owner.query('SHOW search_path')).rows[0].search_path).toBe(schema)
    const body = JSON.parse(String(h.businessCalls[0].options.body))
    const data = { appType: body.appType, formUuid: body.formUuid, formDataJson: body.formDataJson }
    const planned = buildPlan({ config: h.snapshot.config, rows: [h.snapshot.row] }).rows[0]
    expect(body.formDataJson === canonical(planned.payload)).toBe(true)
    const ledger = (await rows())[0]
    expect(ledger.payload_digest === hash(canonical({ version: 1, grantRef: h.snapshot.grantRef,
      expiresAt: h.snapshot.expiresAt, actorId: h.snapshot.actorId, targetRef: h.snapshot.targetRef,
      targetRevision: h.snapshot.targetRevision, planRevision: h.snapshot.planRevision, intent: 'create', data,
      formUuid: (h.snapshot.config as { target: { formUuid: string } }).target.formUuid }))).toBe(true)
    expect(ledger.business_key_digest === hash(planned.localBusinessKey)).toBe(true)
    expect((await rows(AUDIT)).map((row) => row.event)).toEqual(['prepare', 'claim', 'acknowledgement'])
    for (let index = 0; index < first.statements.length; index++) {
      if (first.statements[index] === 'BEGIN') expect(first.statements[index + 1]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    }
  })

  it('update keeps the separately admitted instance and HTTP-only acknowledgement semantics', async () => {
    const h = harness()
    Object.assign(h.snapshot.config as Value, { intent: 'update', instanceIdField: 'instance' })
    Object.assign(h.snapshot.row as Value, { instance: 'synthetic-instance' })
    h.snapshot.instanceId = 'synthetic-instance'
    h.businessFetch = async () => new Response('{"errorCode":"synthetic-application-failure"}')
    safe(await h.runner.run(request()), 'acknowledged', true)
    expect(h.businessCalls[0].options.method).toBe('PUT')
    const persisted = (await rows())[0]
    expect(persisted.instance_id === 'synthetic-instance' && persisted.ack_instance_id === 'synthetic-instance').toBe(true)
  })

  it('default OFF makes no resolver, SQL, token or business call', async () => {
    const h = harness(first, { readEnablement: undefined })
    await rejected(h.runner.run(request()), 'DISABLED')
    expect(h.resolves + h.tokenCalls + h.businessCalls.length + first.statements.length).toBe(0)
    expect((await rows()).length).toBe(0)
  })

  it('two independent runners contend on the actual claim lock and send exactly one request', async () => {
    const a = harness(first); const b = harness(second)
    const readyA = deferred(); const readyB = deferred(); const goA = deferred(); const goB = deferred()
    releases.push(goA.resolve, goB.resolve)
    a.resolveSnapshot = async () => {
      if (a.resolves === 2) { readyA.resolve(); await goA.promise }
      return copy(a.snapshot)
    }
    b.resolveSnapshot = async () => {
      if (b.resolves === 2) { readyB.resolve(); await goB.promise }
      return copy(b.snapshot)
    }
    const aRun = track(a.runner.run(request()))
    await wait(readyA.promise)
    const bRun = track(b.runner.run(request()).then((value) => ({ value }), (error: unknown) => ({ error })))
    await wait(readyB.promise)
    const gate = first.beforeCommit('claim')
    goA.resolve(); await wait(gate.reached)
    goB.resolve(); await blocked(second, first)
    gate.release()
    safe(await aRun, 'acknowledged', true)
    const loser = await bRun
    expect('error' in loser).toBe(true)
    if ('error' in loser) fixed(loser.error, 'CLAIM_UNCONFIRMED')
    expect(a.businessCalls.length + b.businessCalls.length).toBe(1)
    expect((await rows()).length).toBe(1)
    expect((await rows(AUDIT)).filter((row) => row.event === 'claim').length).toBe(1)
  })

  it('committed claim with lost host response never sends; a new instance observes dispatching', async () => {
    const h = harness()
    first.loseCommitResponse('claim')
    await rejected(h.runner.run(request()), 'CLAIM_UNCONFIRMED')
    expect((await rows())[0].status).toBe('dispatching')
    const restarted = harness(second)
    safe(await restarted.runner.run(request()), 'dispatching', false)
    expect(h.businessCalls.length + restarted.businessCalls.length + restarted.tokenCalls).toBe(0)
    expect((await rows(AUDIT)).map((row) => row.event)).toEqual(['prepare', 'claim'])
  })

  it('a real claim-audit SQL failure rolls back both claim fields and status before any fetch', async () => {
    const h = harness()
    await first.client.query("SET synthetic.reject_event = 'claim'")
    await rejected(h.runner.run(request()), 'CLAIM_UNCONFIRMED')
    const persisted = (await rows())[0]
    expect(persisted.status === 'prepared' && persisted.claim_token === null && persisted.claim_actor_id === null).toBe(true)
    expect((await rows(AUDIT)).map((row) => row.event)).toEqual(['prepare'])
    expect(h.businessCalls.length).toBe(0)
    expect(first.statements).toContain('ROLLBACK')
  })

  it('late claim after cancellation stays BUSY and is durably quarantined', async () => {
    const h = harness()
    const controller = new AbortController()
    const gate = first.beforeCommit('claim')
    let settled = false
    const pending = track(h.runner.run(request(), { signal: controller.signal }).finally(() => { settled = true }))
    await wait(gate.reached)
    expect((await rows())[0].status).toBe('prepared')
    controller.abort('synthetic-private-abort')
    await new Promise(setImmediate)
    expect(settled).toBe(false)
    await rejected(h.runner.run(request()), 'BUSY')
    gate.release()
    safe(await pending, 'outcome_unknown', false)
    expect(h.businessCalls.length).toBe(0)
    expect((await rows(AUDIT)).map((row) => row.event)).toEqual(['prepare', 'claim', 'unknown'])
    expect((await rows(AUDIT)).at(-1)?.reason).toBe('manual_recovery')
  })

  it.each(['revoke', 'changed-secret', 'disabled'])('post-claim %s causes unknown without external request', async (mode) => {
    const h = harness()
    h.resolveSnapshot = async () => {
      if (h.resolves === 3) {
        if (mode === 'revoke') throw new Error('synthetic-private-revocation')
        if (mode === 'disabled') h.enabled = false
        if (mode === 'changed-secret') return { ...copy(h.snapshot), systemToken: 'synthetic-private-changed' }
      }
      return copy(h.snapshot)
    }
    safe(await h.runner.run(request()), 'outcome_unknown', false)
    expect(h.businessCalls.length).toBe(0)
    expect((await rows(AUDIT)).at(-1)?.reason).toBe('manual_recovery')
  })

  it('lost ACK commit response is observed as durable ACK without another write or send', async () => {
    const h = harness()
    first.loseCommitResponse('acknowledgement')
    safe(await h.runner.run(request()), 'acknowledged', true)
    expect((await rows(AUDIT)).map((row) => row.event)).toEqual(['prepare', 'claim', 'acknowledgement'])
    expect(h.businessCalls.length).toBe(1)
    expect(first.statements.filter((sql) => sql.startsWith(`SELECT * FROM "${LEDGER}"`) && !sql.includes('FOR UPDATE'))).toHaveLength(1)
  })

  it('a successful ACK commit remains acknowledged when cancellation arrives during its transaction', async () => {
    const h = harness()
    const controller = new AbortController()
    const gate = first.beforeCommit('acknowledgement')
    const pending = track(h.runner.run(request(), { signal: controller.signal }))
    await wait(gate.reached)
    // The remote receipt is already received; observer still sees dispatching
    // until the genuine ACK transaction commits. Cancellation cannot erase it.
    expect((await rows())[0].status).toBe('dispatching')
    controller.abort('synthetic-private-late-cancel')
    gate.release()
    safe(await pending, 'acknowledged', true)
    expect((await rows())[0].status).toBe('acknowledged')
    expect(h.businessCalls.length).toBe(1)
    expect((await rows(AUDIT)).some((row) => row.event === 'unknown')).toBe(false)
  })

  it('actual ACK-audit rollback leaves no ACK fields and then persists commit_unknown', async () => {
    const h = harness()
    await first.client.query("SET synthetic.reject_event = 'acknowledgement'")
    safe(await h.runner.run(request()), 'outcome_unknown', true)
    const persisted = (await rows())[0]
    expect(persisted.status === 'outcome_unknown' && persisted.ack_status_code === null && persisted.ack_instance_id === null).toBe(true)
    expect((await rows(AUDIT)).map((row) => row.event)).toEqual(['prepare', 'claim', 'unknown'])
    expect((await rows(AUDIT)).at(-1)?.reason).toBe('commit_unknown')
    expect(first.statements).toContain('ROLLBACK')
    expect(h.businessCalls.length).toBe(1)
  })

  it('ACK and unknown SQL failures report unconfirmed/non-durable rather than fake quarantine', async () => {
    const h = harness()
    await first.client.query("SET synthetic.reject_completions = 'true'")
    const result = await h.runner.run(request())
    safe(result, 'state_unconfirmed', true, false)
    expect(result.record).toBeNull()
    expect((await rows())[0].status).toBe('dispatching')
    expect((await rows(AUDIT)).map((row) => row.event)).toEqual(['prepare', 'claim'])
    expect(h.businessCalls.length).toBe(1)
  })

  it.each(['network', 'receipt'])('%s failure stays unknown across a new runner and connection', async (mode) => {
    const h = harness()
    h.businessFetch = async () => {
      if (mode === 'network') throw new Error('synthetic-private-network-detail')
      return new Response('{not-json')
    }
    safe(await h.runner.run(request()), 'outcome_unknown', true)
    expect((await rows(AUDIT)).at(-1)?.reason).toBe(mode === 'network' ? 'transport_unknown' : 'receipt_invalid')
    const restarted = harness(second)
    safe(await restarted.runner.run(request()), 'outcome_unknown', false)
    expect(h.businessCalls.length + restarted.businessCalls.length).toBe(1)
    expect(restarted.tokenCalls).toBe(0)
  })

  it('late business response after cancellation is never acknowledged or automatically resent', async () => {
    const h = harness()
    const reached = deferred(); const release = deferred(); const controller = new AbortController()
    releases.push(release.resolve)
    h.businessFetch = async () => { reached.resolve(); await release.promise; return new Response('{"result":"synthetic-private-late"}') }
    const pending = track(h.runner.run(request(), { signal: controller.signal }))
    await wait(reached.promise); controller.abort()
    await rejected(h.runner.run(request()), 'BUSY')
    release.resolve()
    safe(await pending, 'outcome_unknown', true)
    expect((await rows())[0].ack_status_code).toBeNull()
    expect(h.businessCalls.length).toBe(1)
  })

  it('expired or changed-generation snapshots cannot claim the prepared row', async () => {
    const h = harness()
    h.snapshot.expiresAt = 1000
    await rejected(h.runner.run(request()), 'SNAPSHOT_EXPIRED')
    expect((await rows()).length).toBe(0)
    h.snapshot.expiresAt = 100000
    h.resolveSnapshot = async () => ({ ...copy(h.snapshot), ...(h.resolves === 3 ? { credentialGeneration: 2 } : {}) })
    // First failed attempt used one resolver call; second attempt's preclaim
    // resolver is call three. No token rotation is silently activated by runner.
    await rejected(h.runner.run(request()), 'SNAPSHOT_CHANGED')
    expect((await rows())[0].status).toBe('prepared')
    expect(h.businessCalls.length).toBe(0)
  })

  it('a completed identity is reusable evidence after process-local instances are recreated', async () => {
    const h = harness()
    safe(await h.runner.run(request()), 'acknowledged', true)
    const restarted = harness(second)
    safe(await restarted.runner.run(request()), 'acknowledged', false)
    expect(restarted.tokenCalls + restarted.businessCalls.length).toBe(0)
    expect((await rows()).length).toBe(1)
  })

  it('089 rejects a new operation laundering an unresolved same-target CREATE before token or send', async () => {
    const h = harness()
    h.businessFetch = async () => { throw new Error('synthetic-private-uncertain') }
    safe(await h.runner.run(request()), 'outcome_unknown', true)
    // Still dishonest synthetic authority. The local same-target/key fence now
    // blocks it; this is NOT cross-namespace or remote business exactly-once.
    h.snapshot.operationId = 'synthetic-operation-new'
    const before = await evidence(), tokens = h.tokenCalls
    await rejected(h.runner.run({ ...request(), operationId: h.snapshot.operationId }), 'PREPARE_FAILED')
    expect(h.businessCalls.length).toBe(1)
    expect(h.tokenCalls).toBe(tokens)
    expect(await evidence()).toEqual(before)
    expect((await rows()).length).toBe(1)
  })

  for (const status of ['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent']) {
    it.each(['identity-only', 'target-revision', 'credential-generation'])('089 retains ' + status + ' reservation across new operation/row and %s', async change => {
      const a = harness()
      if (status === 'prepared' || status === 'not_sent') {
        a.tokenFetch = async () => { throw new Error('synthetic-private-token-unavailable') }
        await rejected(a.runner.run(request()), 'TOKEN_FAILED')
        if (status === 'not_sent') await createDeliveryStore({ db: first.db }).cancelPrepared({ ...context(), ...request() })
      } else if (status === 'dispatching') {
        first.loseCommitResponse('claim')
        await rejected(a.runner.run(request()), 'CLAIM_UNCONFIRMED')
      } else {
        if (status === 'outcome_unknown') a.businessFetch = async () => { throw new Error('synthetic-private-uncertain') }
        safe(await a.runner.run(request()), status, true)
      }
      expect((await rows())[0].status === status).toBe(true)
      const b = harness(second)
      b.snapshot.operationId = 'synthetic-other-operation'; b.snapshot.rowKey = 'synthetic-other-row'
      if (change === 'target-revision') b.snapshot.targetRevision = 'synthetic-other-revision'
      if (change === 'credential-generation') b.snapshot.credentialGeneration = 2
      const before = await evidence(), attempts = a.businessCalls.length
      await rejected(b.runner.run({ operationId: b.snapshot.operationId, rowKey: b.snapshot.rowKey }), 'PREPARE_FAILED')
      expect(b.tokenCalls + b.businessCalls.length).toBe(0)
      expect(a.businessCalls.length).toBe(attempts)
      expect(await evidence()).toEqual(before)
      // Replaying both migrations retains even a not_sent tombstone. Restart
      // does not erase or reissue the original CREATE business reservation.
      await owner.query(migrationSql)
      await rejected(b.restart().run({ operationId: b.snapshot.operationId, rowKey: b.snapshot.rowKey }), 'PREPARE_FAILED')
      expect(b.tokenCalls + b.businessCalls.length).toBe(0)
      expect(await evidence()).toEqual(before)
    })
  }

  it('different-operation same-key CREATE contends on actual PG uniqueness and never reaches the losing token or transport', async () => {
    const a = harness(first), b = harness(second)
    b.snapshot.operationId = 'synthetic-racing-operation'; b.snapshot.rowKey = 'synthetic-racing-row'
    const gate = first.beforeCommit('prepare'), winner = track(a.runner.run(request()))
    await wait(gate.reached)
    const loser = track(rejected(b.runner.run({ operationId: b.snapshot.operationId, rowKey: b.snapshot.rowKey }), 'PREPARE_FAILED'))
    try { await blocked(second, first) } finally { gate.release() }
    safe(await winner, 'acknowledged', true); await loser
    expect(a.businessCalls.length).toBe(1)
    expect(b.businessCalls.length + b.tokenCalls).toBe(0)
    expect((await rows()).length).toBe(1)
    expect((await rows(AUDIT)).map(row => row.event)).toEqual(['prepare', 'claim', 'acknowledgement'])
    const rollback = second.statements.indexOf('ROLLBACK')
    expect(rollback >= 0 && second.statements[rollback + 1] === 'BEGIN'
      && second.statements[rollback + 2] === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED').toBe(true)
  })

  it('a genuinely different business key on the same target can take a separate synthetic single-row attempt', async () => {
    const a = harness(first), b = harness(second)
    b.snapshot.operationId = 'synthetic-other-operation'; b.snapshot.rowKey = 'synthetic-other-row'
    ;(b.snapshot.row as Value).componentCode = 'SYNTHETIC-DIFFERENT-COMPONENT'
    safe(await a.runner.run(request()), 'acknowledged', true)
    safe(await b.runner.run({ operationId: b.snapshot.operationId, rowKey: b.snapshot.rowKey }), 'acknowledged', true)
    const persisted = await rows()
    expect(persisted.length).toBe(2)
    expect(persisted[0].target_ref === persisted[1].target_ref && persisted[0].business_key_digest !== persisted[1].business_key_digest).toBe(true)
    expect(a.businessCalls.length + b.businessCalls.length).toBe(2)
  })

  async function durableHarness() {
    await owner.query(materialMigrationSql)
    const { actorId: _actorId, ...materialContext } = context()
    const material = { appKey: 'synthetic-private-key', appSecret: 'synthetic-private-secret',
      systemToken: 'synthetic-private-system', userId: 'synthetic-private-user' }
    const firstStore = createMaterialStore({ db: first.db, security, context: materialContext })
    const secondStore = createMaterialStore({ db: second.db, security, context: materialContext })
    const { status: _status, ...binding } = await firstStore.create({ material })
    // The resolver still uses explicitly synthetic grant/target authority and
    // fixture-held systemToken/userId. This does NOT add a full-material loader
    // or upgrade 091 drafts, and cannot establish socket-linearized authority.
    const h = harness(first, {}, { store: firstStore, binding })
    return { h, secondStore, material, binding,
      cas: { credentialRef: binding.credentialRef, expectedGeneration: binding.credentialGeneration } }
  }

  it('actual current 090 material admits the synthetic token/exchange/runner path without publishing private material', async () => {
    const { h, binding } = await durableHarness()
    safe(await h.runner.run(request()), 'acknowledged', true)
    expect(h.tokenCalls).toBe(1)
    expect(h.businessCalls.length).toBe(1)
    const persisted = (await rows())[0]
    expect(persisted.credential_ref === binding.credentialRef && persisted.credential_generation === binding.credentialGeneration).toBe(true)
    expect((await rows(AUDIT)).map(row => row.event)).toEqual(['prepare', 'claim', 'acknowledgement'])
  })

  it.each(['rotate', 'revoke'])('actual 090 %s on another session invalidates cached token admission for an existing prepared runner row', async change => {
    const { h, secondStore, material, binding, cas } = await durableHarness()
    await h.tokenClient.getAccessToken(binding)
    // Establish a durable prepared row with a real successful cached token but
    // explicit synthetic authority refusal before claim. No business fetch.
    h.resolveSnapshot = async () => {
      if (h.resolves === 2) throw new Error('synthetic-private-authority-refusal')
      return copy(h.snapshot)
    }
    await rejected(h.runner.run(request()), 'SNAPSHOT_INVALID')
    expect((await rows())[0].status === 'prepared').toBe(true)
    expect(h.tokenCalls).toBe(1)
    h.resolveSnapshot = async () => copy(h.snapshot)
    if (change === 'rotate') await secondStore.rotate({ ...cas, material: { ...material, appSecret: 'synthetic-private-rotated' } })
    else await secondStore.revoke(cas)
    const before = await evidence()
    await rejected(h.runner.run(request()), 'TOKEN_FAILED')
    expect(h.tokenCalls).toBe(1)
    expect(h.businessCalls.length).toBe(0)
    expect(await evidence()).toEqual(before)
    expect((await rows(AUDIT)).map(row => row.event)).toEqual(['prepare'])
  })

  it.each(['rotate', 'revoke'])('actual 090 %s committed during exchange prevents token publication and runner claim', async change => {
    const { h, secondStore, material, cas } = await durableHarness()
    const entered = deferred(), open = deferred(); releases.push(open.resolve)
    h.tokenFetch = async () => {
      entered.resolve(); await open.promise
      return new Response('{"accessToken":"synthetic-private-late-token","expireIn":60}')
    }
    const pending = track(rejected(h.runner.run(request()), 'TOKEN_FAILED'))
    await wait(entered.promise)
    expect((await rows())[0].status === 'prepared').toBe(true)
    try {
      if (change === 'rotate') await secondStore.rotate({ ...cas, material: { ...material, appSecret: 'synthetic-private-rotated' } })
      else await secondStore.revoke(cas)
    } finally { open.resolve() }
    await pending
    expect(h.tokenCalls).toBe(1)
    expect(h.businessCalls.length).toBe(0)
    expect((await rows())[0].status === 'prepared').toBe(true)
    expect((await rows(AUDIT)).map(row => row.event)).toEqual(['prepare'])
  })
})

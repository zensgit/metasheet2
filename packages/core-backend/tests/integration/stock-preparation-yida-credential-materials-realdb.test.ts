// Private material persistence only: actual 090, db.cjs, material store, host
// encryption and token lifecycle. The exchange is synthetic; no transport,
// runtime registration, customer credentials or remote service is involved.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
const root = path.resolve(__dirname, '..', '..', '..', '..')
const MATERIALS = 'integration_yida_credential_materials'
const AUDIT = 'integration_yida_credential_audit'
const PIN = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
type Row = Record<string, unknown>
type Context = { tenantId: string; workspaceId: string | null; ownerId: string }
type Material = { appKey: string; appSecret: string; systemToken: string; userId: string }
type HostSecurity = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
type Binding = Context & { credentialRef: string; credentialGeneration: number }
type Metadata = Binding & { status: 'current' | 'revoked' }
type Store = {
  create(input: { material: Material }): Promise<Metadata>
  rotate(input: { credentialRef: string; expectedGeneration: number; material: Material }): Promise<Metadata>
  revoke(input: { credentialRef: string; expectedGeneration: number }): Promise<Metadata>
  inspect(input: { credentialRef: string }): Promise<Metadata>
  loadTokenCredential(input: Binding, options?: { signal?: AbortSignal }): Promise<Binding & { appKey: string; appSecret: string }>
}
type Database = {
  query(sql: string, params?: unknown[]): Promise<Row[]>
  transaction<T>(callback: (trx: Pick<Database, 'query'>) => Promise<T>): Promise<T>
}
type Gate = { reached: Promise<void>; release(): void }
type Session = {
  client: PoolClient; pid: number; store: Store; statements: string[]
  gateAudit(): Gate; release(): void; loseCommitResponse(): void
}
type TokenClient = {
  activate(binding: Binding): void
  getAccessToken(binding: Binding): Promise<string>
  dispose(): void
}

// Outside describe.skip: a whole-file invocation without an owned DB must fail.
it('sentinel: material proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

databaseSuite('SA05 private durable Yida materials — real PG and host encryption, no network', () => {
  let pool: Pool, owner: PoolClient, first: Session, second: Session
  let schema = '', ddl = ''
  let security: HostSecurity
  let createDb: (input: { database: Database }) => unknown
  let createStore: (input: { db: unknown; security: HostSecurity; context: Context }) => Store
  let createTokenClient: (input: {
    loadCredential: Store['loadTokenCredential']
    exchangeToken: (material: { appKey: string; appSecret: string }) => Promise<{ accessToken: string; expireIn: number }>
  }) => TokenClient
  const sessions: Session[] = [], tokens: TokenClient[] = []
  const envKeys = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const
  let originalEnv: Array<[typeof envKeys[number], string | undefined]> = []
  const context = (patch: Partial<Context> = {}): Context => ({
    tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner', ...patch,
  })
  const material = (patch: Partial<Material> = {}): Material => ({
    appKey: ' synthetic-app-key ', appSecret: ' synthetic-app-secret ',
    systemToken: ' synthetic-system-token ', userId: ' synthetic-user ', ...patch,
  })
  const binding = ({ status: _status, ...value }: Metadata): Binding => value
  const cas = (value: Binding) => ({ credentialRef: value.credentialRef, expectedGeneration: value.credentialGeneration })
  const ident = (value: string) => {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('SYNTHETIC_IDENTIFIER_REQUIRED')
    return `"${value}"`
  }
  const codeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : 'NO_FIXED_CODE'
  const outcome = async <T>(promise: Promise<T>) => {
    // A failing negative assertion must not print a successful secret/token
    // result. Only the observed success/fixed-error classification is evidence.
    try { await promise; return { ok: true as const } }
    catch (error) { return { ok: false as const, code: codeOf(error) } }
  }
  async function rejected(promise: Promise<unknown>, code: string) {
    let caught: unknown
    try { await promise } catch (error) { caught = error }
    expect(codeOf(caught)).toBe(code)
    expect((caught as Error)?.message).toBe(code)
    expect(Object.keys(caught as object).sort()).toEqual(['code', 'name'])
    expect('cause' in (caught as object)).toBe(false)
  }
  const rows = async (table: string) => (await owner.query(`SELECT * FROM ${ident(table)} ORDER BY ${table === MATERIALS ? 'credential_ref' : 'id'}`)).rows as Row[]
  async function evidence() {
    const heads = await rows(MATERIALS), audit = await rows(AUDIT)
    // Assertions never print raw rows, identifiers, ciphertext or private values.
    return { materials: heads.length, audit: audit.length,
      digest: createHash('sha256').update(JSON.stringify([heads, audit])).digest('hex') }
  }
  async function envelope(value: Metadata, bundle = material(), patch: Row = {}) {
    return security.encrypt(JSON.stringify({ purpose: 'yida-credential-material', schemaVersion: 1,
      ...binding(value), material: bundle, ...patch }))
  }
  async function directInsert(patch: Row = {}) {
    const data = { credential_ref: randomUUID(), tenant_id: context().tenantId, workspace_id: null,
      owner_id: context().ownerId, generation: 1, status: 'current', material_encrypted: 'enc:synthetic-invalid-body', ...patch }
    const keys = Object.keys(data)
    return owner.query(`INSERT INTO ${ident(MATERIALS)} (${keys.map(ident).join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
      keys.map(key => (data as Row)[key]))
  }

  async function session(scope = context()): Promise<Session> {
    const client = await pool.connect()
    await client.query(`SET search_path TO ${ident(schema)}`)
    await client.query("SET statement_timeout = '10s'")
    // The production store must override even an inherited stronger isolation.
    await client.query("SET default_transaction_isolation = 'repeatable read'")
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const statements: string[] = []
    let gate: (Gate & { enter(): void; open: Promise<void> }) | undefined
    let lostCommit = false
    const query = async (sql: string, params?: unknown[]): Promise<Row[]> => {
      statements.push(sql) // Shapes only, never parameters or database error text.
      if (gate && sql.startsWith(`INSERT INTO "${AUDIT}"`)) {
        const waiting = gate
        waiting.enter(); await waiting.open
        if (gate === waiting) gate = undefined
      }
      return (await client.query(sql, params)).rows as Row[]
    }
    const database: Database = { query, async transaction(callback) {
      await query('BEGIN')
      try {
        const result = await callback({ query })
        await query('COMMIT')
        if (lostCommit) { lostCommit = false; throw new Error('SYNTHETIC_COMMIT_RESPONSE_LOST') }
        return result
      } catch (error) { await query('ROLLBACK'); throw error }
    } }
    const result: Session = { client, pid, statements, store: createStore({ db: createDb({ database }), security, context: scope }),
      gateAudit() {
        let enter!: () => void, release!: () => void
        const reached = new Promise<void>(resolve => { enter = resolve })
        const open = new Promise<void>(resolve => { release = resolve })
        gate = { reached, open, enter, release }
        return gate
      },
      release() { gate?.release() },
      loseCommitResponse() { lostCommit = true },
    }
    sessions.push(result)
    return result
  }
  async function reached(gate: { reached: Promise<void> }) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([gate.reached, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('SYNTHETIC_GATE_TIMEOUT')), 5000)
    })]) } finally { clearTimeout(timer) }
  }
  async function blocked(waiter: Session, holder: Session) {
    expect(waiter.pid).not.toBe(holder.pid)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const result = await owner.query("SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1", [waiter.pid, holder.pid])
      if (result.rows[0]?.blocked === true) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('SYNTHETIC_PG_LOCK_NOT_OBSERVED')
  }
  function tokenClient(store: Store, exchange?: () => Promise<void>) {
    let loads = 0, exchanges = 0
    const client = createTokenClient({
      loadCredential: async (value, options) => { loads++; return store.loadTokenCredential(value, options) },
      exchangeToken: async () => { exchanges++; await exchange?.(); return { accessToken: 'synthetic-token', expireIn: 3600 } },
    })
    tokens.push(client)
    return { client, counts: () => ({ loads, exchanges }) }
  }

  beforeAll(async () => {
    const lib = path.join(root, 'plugins/plugin-integration-core/lib')
    createDb = requireCjs(path.join(lib, 'db.cjs')).createDb
    createStore = requireCjs(path.join(lib, 'yida-credential-material-store.cjs')).createYidaCredentialMaterialStore
    createTokenClient = requireCjs(path.join(lib, 'yida-token-client.cjs')).createYidaTokenClient
    ddl = readFileSync(path.join(root, 'packages/core-backend/migrations/092_create_integration_yida_credential_materials.sql'), 'utf8')
    originalEnv = envKeys.map(key => [key, process.env[key]])
    process.env.NODE_ENV = 'production'
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex')
    process.env.ENCRYPTION_SALT = randomBytes(32).toString('hex')
    // Fixed production module, not an injected crypto substitute. The local
    // structural type keeps this standalone test's strict check independent of
    // plugin.ts's unrelated attendance/approval type-only dependency graph.
    const securityModule = pathToFileURL(path.join(root, 'packages/core-backend/src/security/plugin-runtime-security-service.ts')).href
    const { PluginRuntimeSecurityService } = await import(securityModule) as {
      PluginRuntimeSecurityService: new () => HostSecurity
    }
    security = new PluginRuntimeSecurityService()
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 9, connectionTimeoutMillis: 5000 })
    owner = await pool.connect()
    await owner.query("SET statement_timeout = '10s'")
  }, 30000)
  beforeEach(async () => {
    schema = 'yida_materials_' + randomUUID().replaceAll('-', '')
    await owner.query(`CREATE SCHEMA ${ident(schema)}`)
    await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(ddl)
    first = await session(); second = await session()
  }, 30000)
  afterEach(async () => {
    for (const client of tokens) client.dispose()
    tokens.length = 0
    for (const entry of sessions) {
      entry.release()
      await entry.client.query('ROLLBACK').catch(() => {})
      entry.client.release()
    }
    sessions.length = 0
    if (schema) { await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schema = '' }
  })
  afterAll(async () => {
    try {
      if (owner) { if (schema) await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); owner.release() }
      await pool?.end()
    } finally {
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('stores real host ciphertext, exposes metadata only, and reloads through a fresh store', async () => {
    const created = await first.store.create({ material: material() })
    expect(Object.keys(created).sort()).toEqual(['credentialGeneration', 'credentialRef', 'ownerId', 'status', 'tenantId', 'workspaceId'])
    expect(created.credentialRef).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.credentialGeneration).toBe(1)
    expect(created.status).toBe('current')
    expect(Object.keys(first.store).sort()).toEqual(['create', 'inspect', 'loadTokenCredential', 'revoke', 'rotate'])
    const head = (await rows(MATERIALS))[0], audit = (await rows(AUDIT))[0]
    expect(String(head.material_encrypted).startsWith('enc:')).toBe(true)
    const stored = JSON.stringify([head, audit])
    expect(Object.values(material()).every(value => !stored.includes(value))).toBe(true)
    const decrypted = JSON.parse(await security.decrypt(String(head.material_encrypted))) as Row
    expect(JSON.stringify(decrypted) === JSON.stringify({ purpose: 'yida-credential-material', schemaVersion: 1, ...binding(created), material: material() })).toBe(true)
    expect(Object.keys(audit).sort()).toEqual(['actor_id', 'created_at', 'credential_ref', 'event', 'generation', 'id', 'status'])
    const restarted = await session()
    expect(await restarted.store.inspect({ credentialRef: created.credentialRef })).toEqual(created)
    const loaded = await restarted.store.loadTokenCredential(binding(created))
    expect(Object.keys(loaded).sort()).toEqual(['appKey', 'appSecret', 'credentialGeneration', 'credentialRef', 'ownerId', 'tenantId', 'workspaceId'])
    expect(loaded.appKey === material().appKey && loaded.appSecret === material().appSecret).toBe(true)
    for (const active of [first, restarted]) {
      const starts = active.statements.flatMap((sql, i) => sql === 'BEGIN' ? [i] : [])
      expect(starts.length > 0).toBe(true)
      expect(starts.every(i => active.statements[i + 1] === PIN)).toBe(true)
    }
    expect(restarted.statements.some(sql => sql.includes('FOR UPDATE'))).toBe(true)
  })

  it.each(['current', 'revoked'] as const)('migration replay preserves %s material and audit without recovering old secrets', async status => {
    let value = await first.store.create({ material: material() })
    value = await first.store.rotate({ ...cas(value), material: material({ appSecret: 'synthetic-rotated' }) })
    if (status === 'revoked') value = await first.store.revoke(cas(value))
    const before = await evidence()
    await owner.query(ddl); await owner.query(ddl)
    expect(await evidence()).toEqual(before)
    expect(await second.store.inspect({ credentialRef: value.credentialRef })).toEqual(value)
    expect((await rows(MATERIALS)).length).toBe(1)
    if (status === 'revoked') expect((await rows(MATERIALS))[0].material_encrypted === null).toBe(true)
  })

  it('secret bytes resembling ciphertext stay private plaintext input, not an import or passthrough', async () => {
    const bundle = material({ appKey: 'enc:literal-private-input', appSecret: 'v1:literal-private-input', userId: ' synthetic-user\t ' })
    const one = await first.store.create({ material: bundle })
    const loaded = await second.store.loadTokenCredential(binding(one))
    expect(loaded.appKey === bundle.appKey && loaded.appSecret === bundle.appSecret).toBe(true)
    const head = (await rows(MATERIALS))[0]
    const actual = JSON.parse(await security.decrypt(String(head.material_encrypted))) as { material: Material }
    expect(JSON.stringify(actual.material) === JSON.stringify(bundle)).toBe(true)
    expect(String(head.material_encrypted).includes(bundle.appKey)).toBe(false)
  })

  it.each(['appKey', 'appSecret', 'systemToken', 'userId'] as const)('changing %s installs a complete new encrypted generation, not a metadata version', async key => {
    const one = await first.store.create({ material: material() })
    const oldCiphertext = (await rows(MATERIALS))[0].material_encrypted
    const next = material({ [key]: 'synthetic-changed-material' })
    const two = await second.store.rotate({ ...cas(one), material: next })
    expect(two.credentialGeneration).toBe(2)
    const head = (await rows(MATERIALS))[0]
    expect(head.material_encrypted !== oldCiphertext).toBe(true)
    expect(JSON.stringify((JSON.parse(await security.decrypt(String(head.material_encrypted))) as { material: Material }).material) === JSON.stringify(next)).toBe(true)
    await rejected(first.store.loadTokenCredential(binding(one)), 'YIDA_CREDENTIAL_CONFLICT')
    const loaded = await first.store.loadTokenCredential(binding(two))
    expect(loaded.appKey === next.appKey && loaded.appSecret === next.appSecret).toBe(true)
    expect((await evidence()).audit).toBe(2)
  })

  it('ABA and revoked restoration always advance; repeated revoke is metadata-only idempotent', async () => {
    const one = await first.store.create({ material: material() })
    const two = await second.store.rotate({ ...cas(one), material: material({ appSecret: 'synthetic-B' }) })
    const three = await first.store.rotate({ ...cas(two), material: material() })
    expect(three.credentialGeneration).toBe(3)
    const revoked = await second.store.revoke(cas(three))
    const before = await evidence()
    expect(await first.store.revoke(cas(revoked))).toEqual(revoked)
    expect(await evidence()).toEqual(before)
    await rejected(first.store.loadTokenCredential(binding(revoked)), 'YIDA_CREDENTIAL_REVOKED')
    await rejected(first.store.revoke(cas(one)), 'YIDA_CREDENTIAL_CONFLICT')
    const restored = await first.store.rotate({ ...cas(revoked), material: material() })
    expect(restored.credentialGeneration).toBe(4)
    expect(restored.status).toBe('current')
    await rejected(second.store.loadTokenCredential(binding(three)), 'YIDA_CREDENTIAL_CONFLICT')
    expect((await rows(AUDIT)).map(row => [row.generation, row.event]).sort()).toEqual(
      [[1, 'create'], [2, 'rotate'], [3, 'revoke'], [3, 'rotate'], [4, 'rotate']].sort())
  })

  it.each(['tenantId', 'workspaceId', 'ownerId'] as const)('wrong %s cannot inspect, mutate or load; no workspace fallback', async field => {
    const one = await first.store.create({ material: material() })
    const foreign = await session(context({ [field]: 'synthetic-other-scope' }))
    const before = await evidence()
    await rejected(foreign.store.inspect({ credentialRef: one.credentialRef }), 'YIDA_CREDENTIAL_NOT_FOUND')
    await rejected(foreign.store.rotate({ ...cas(one), material: material() }), 'YIDA_CREDENTIAL_NOT_FOUND')
    await rejected(foreign.store.revoke(cas(one)), 'YIDA_CREDENTIAL_NOT_FOUND')
    await rejected(foreign.store.loadTokenCredential(binding(one)), 'YIDA_CREDENTIAL_NOT_FOUND')
    await rejected(foreign.store.loadTokenCredential({ ...binding(one), [field]: 'synthetic-other-scope' }), 'YIDA_CREDENTIAL_NOT_FOUND')
    expect(await evidence()).toEqual(before)
    const independent = await foreign.store.create({ material: material() })
    await rejected(first.store.loadTokenCredential(binding(independent)), 'YIDA_CREDENTIAL_NOT_FOUND')
    expect(independent.credentialRef !== one.credentialRef).toBe(true)
  })

  it.each(['rotate', 'revoke'] as const)('concurrent rotate versus %s is serialized by a real distinct-PID row lock', async competitor => {
    const one = await first.store.create({ material: material() })
    const gate = first.gateAudit()
    const winner = outcome(first.store.rotate({ ...cas(one), material: material({ appSecret: 'synthetic-next' }) }))
    await reached(gate)
    const loser = outcome(competitor === 'rotate'
      ? second.store.rotate({ ...cas(one), material: material({ appSecret: 'synthetic-loser' }) })
      : second.store.revoke(cas(one)))
    try { await blocked(second, first) } finally { gate.release() }
    expect((await winner).ok).toBe(true)
    expect(await loser).toEqual({ ok: false, code: 'YIDA_CREDENTIAL_CONFLICT' })
    expect((await second.store.inspect({ credentialRef: one.credentialRef })).credentialGeneration).toBe(2)
    expect((await evidence()).audit).toBe(2)
  })

  it('a loader blocked behind rotation sees the committed new generation, not its earlier snapshot', async () => {
    const one = await first.store.create({ material: material() })
    const gate = first.gateAudit()
    const rotation = outcome(first.store.rotate({ ...cas(one), material: material({ appSecret: 'synthetic-next' }) }))
    await reached(gate)
    const load = outcome(second.store.loadTokenCredential(binding(one)))
    try { await blocked(second, first) } finally { gate.release() }
    expect((await rotation).ok).toBe(true)
    expect(await load).toEqual({ ok: false, code: 'YIDA_CREDENTIAL_CONFLICT' })
  })

  it.each(['create', 'rotate', 'revoke'] as const)('%s and its actual failing audit INSERT roll back together', async operation => {
    const one = operation === 'create' ? undefined : await first.store.create({ material: material() })
    const before = await evidence()
    await owner.query(`ALTER TABLE ${ident(AUDIT)} ADD CONSTRAINT synthetic_audit_failure CHECK (false) NOT VALID`)
    const action = operation === 'create' ? first.store.create({ material: material() })
      : operation === 'rotate' ? first.store.rotate({ ...cas(one!), material: material({ appSecret: 'synthetic-next' }) })
        : first.store.revoke(cas(one!))
    await rejected(action, 'YIDA_CREDENTIAL_UNAVAILABLE')
    expect(await evidence()).toEqual(before)
    expect(first.statements.at(-1)).toBe('ROLLBACK')
  })

  it.each(['create', 'rotate', 'revoke'] as const)('%s lost COMMIT response is unavailable while fresh inspection sees actual durable state', async operation => {
    const one = operation === 'create' ? undefined : await first.store.create({ material: material() })
    first.loseCommitResponse()
    const action = operation === 'create' ? first.store.create({ material: material() })
      : operation === 'rotate' ? first.store.rotate({ ...cas(one!), material: material({ appSecret: 'synthetic-next' }) })
        : first.store.revoke(cas(one!))
    await rejected(action, 'YIDA_CREDENTIAL_UNAVAILABLE')
    const head = (await rows(MATERIALS))[0]
    const restarted = await session()
    const observed = await restarted.store.inspect({ credentialRef: String(head.credential_ref) })
    expect(observed.credentialGeneration).toBe(operation === 'rotate' ? 2 : 1)
    expect(observed.status).toBe(operation === 'revoke' ? 'revoked' : 'current')
    expect((await evidence()).audit).toBe(operation === 'create' ? 1 : 2)
    if (operation === 'rotate') await rejected(restarted.store.rotate({ ...cas(one!), material: material() }), 'YIDA_CREDENTIAL_CONFLICT')
  })

  it.each(['tenantId', 'workspaceId', 'ownerId', 'credentialRef', 'credentialGeneration', 'purpose', 'schemaVersion'])('actual decrypt rejects ciphertext whose sealed %s does not match the durable row', async field => {
    const one = await first.store.create({ material: material() })
    const two = { ...one, credentialGeneration: 2 }
    const wrong = field === 'credentialGeneration' ? 1 : field === 'schemaVersion' ? 2 : 'synthetic-wrong-binding'
    const ciphertext = await envelope(two, material(), { [field]: wrong })
    // This is an actual allowed +1 SQL transition with genuine host encryption,
    // not a fake SELECT result. The production loader must detect the mismatch.
    await owner.query(`UPDATE ${ident(MATERIALS)} SET generation = 2, material_encrypted = $1 WHERE credential_ref = $2`, [ciphertext, one.credentialRef])
    await rejected(second.store.loadTokenCredential(binding(two)), 'YIDA_CREDENTIAL_UNAVAILABLE')
  })

  it('moving another real credential ciphertext to a row or replaying an old generation is refused', async () => {
    const one = await first.store.create({ material: material() })
    const other = await second.store.create({ material: material({ appSecret: 'synthetic-other-secret' }) })
    const heads = await rows(MATERIALS)
    const donor = heads.find(row => row.credential_ref === other.credentialRef)!
    await owner.query(`UPDATE ${ident(MATERIALS)} SET generation = 2, material_encrypted = $1 WHERE credential_ref = $2`, [donor.material_encrypted, one.credentialRef])
    await rejected(first.store.loadTokenCredential({ ...binding(one), credentialGeneration: 2 }), 'YIDA_CREDENTIAL_UNAVAILABLE')
    await owner.query(`UPDATE ${ident(MATERIALS)} SET generation = 2 WHERE credential_ref = $1`, [other.credentialRef])
    await rejected(second.store.loadTokenCredential({ ...binding(other), credentialGeneration: 2 }), 'YIDA_CREDENTIAL_UNAVAILABLE')
  })

  it('authenticated encryption tampering fails closed with a fixed values-free error', async () => {
    const one = await first.store.create({ material: material() })
    const ciphertext = await envelope({ ...one, credentialGeneration: 2 })
    const bytes = Buffer.from(ciphertext.slice(4), 'base64')
    bytes[bytes.length - 1] ^= 1
    await owner.query(`UPDATE ${ident(MATERIALS)} SET generation = 2, material_encrypted = $1`, ['enc:' + bytes.toString('base64')])
    await rejected(first.store.loadTokenCredential({ ...binding(one), credentialGeneration: 2 }), 'YIDA_CREDENTIAL_UNAVAILABLE')
  })

  it.each(['ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const)('missing production %s cannot create or decrypt materials', async key => {
    const one = await first.store.create({ material: material() })
    const before = await evidence(), previous = process.env[key]
    delete process.env[key]
    try {
      await rejected(first.store.create({ material: material() }), 'YIDA_CREDENTIAL_UNAVAILABLE')
      await rejected(second.store.loadTokenCredential(binding(one)), 'YIDA_CREDENTIAL_UNAVAILABLE')
      expect(await evidence()).toEqual(before)
    } finally { process.env[key] = previous }
  })

  it.each(['rotate', 'revoke'] as const)('a second durable store %s invalidates an existing real token-client cache without local lifecycle notification', async change => {
    const one = await first.store.create({ material: material() })
    const a = tokenClient(first.store), b = tokenClient(second.store)
    a.client.activate(binding(one)); b.client.activate(binding(one))
    await a.client.getAccessToken(binding(one)); await b.client.getAccessToken(binding(one))
    await a.client.getAccessToken(binding(one))
    expect(a.counts().exchanges).toBe(1)
    const next = change === 'rotate'
      ? await second.store.rotate({ ...cas(one), material: material({ appSecret: 'synthetic-next' }) })
      : await second.store.revoke(cas(one))
    await rejected(a.client.getAccessToken(binding(one)), 'YIDA_TOKEN_CREDENTIAL_FAILED')
    await rejected(b.client.getAccessToken(binding(one)), 'YIDA_TOKEN_CREDENTIAL_FAILED')
    expect(a.counts()).toEqual({ loads: 4, exchanges: 1 })
    expect(b.counts()).toEqual({ loads: 3, exchanges: 1 })
    const restarted = tokenClient((await session()).store)
    restarted.client.activate(binding(one))
    await rejected(restarted.client.getAccessToken(binding(one)), 'YIDA_TOKEN_CREDENTIAL_FAILED')
    expect(restarted.counts()).toEqual({ loads: 1, exchanges: 0 })
    if (change === 'rotate') {
      a.client.activate(binding(next))
      await a.client.getAccessToken(binding(next))
      expect(a.counts()).toEqual({ loads: 6, exchanges: 2 })
    }
  })

  it('rotation committed by another session during exchange prevents the late token publication', async () => {
    const one = await first.store.create({ material: material() })
    let enter!: () => void, release!: () => void
    const arrived = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const token = tokenClient(first.store, async () => { enter(); await gate })
    token.client.activate(binding(one))
    const pending = outcome(token.client.getAccessToken(binding(one)))
    let next: Metadata
    try {
      await reached({ reached: arrived })
      next = await second.store.rotate({ ...cas(one), material: material({ appSecret: 'synthetic-next' }) })
    } finally { release() }
    expect(await pending).toEqual({ ok: false, code: 'YIDA_TOKEN_CREDENTIAL_FAILED' })
    expect(token.counts()).toEqual({ loads: 2, exchanges: 1 })
    token.client.activate(binding(next!))
    await token.client.getAccessToken(binding(next!))
    expect(token.counts()).toEqual({ loads: 4, exchanges: 2 })
  })

  it('an aborted loader fails before opening a transaction and cannot return material', async () => {
    const one = await first.store.create({ material: material() })
    const abort = new AbortController(); abort.abort('synthetic-private-cancellation')
    const statements = first.statements.length
    await rejected(first.store.loadTokenCredential(binding(one), { signal: abort.signal }), 'YIDA_CREDENTIAL_CANCELLED')
    expect(first.statements.length).toBe(statements)
  })

  it.each([
    { generation: 2 }, { generation: 0 }, { status: 'revoked', material_encrypted: null },
    { material_encrypted: null }, { material_encrypted: 'plaintext-must-not-persist' },
    { material_encrypted: 'v1:legacy-must-not-persist' }, { material_encrypted: 'enc:' },
  ])('initial DML cannot install an unearned generation or non-current/non-enc shape %#', async patch => {
    const before = await evidence()
    expect(await outcome(directInsert(patch))).toEqual({ ok: false, code: 'P0001' })
    expect(await evidence()).toEqual(before)
  })

  it.each(['credential_ref', 'tenant_id', 'workspace_id', 'owner_id', 'created_at'])('ordinary DML cannot rewrite immutable %s even with a plausible rotation', async column => {
    await first.store.create({ material: material() })
    const before = await evidence()
    const value = column === 'credential_ref' ? randomUUID() : column === 'created_at' ? new Date(0) : 'synthetic-other'
    expect(await outcome(owner.query(`UPDATE ${ident(MATERIALS)} SET ${ident(column)} = $1, generation = 2`, [value])))
      .toEqual({ ok: false, code: 'P0001' })
    expect(await evidence()).toEqual(before)
  })

  it.each([
    'generation = generation', 'generation = 3', 'generation = 0',
    "status = 'revoked'", "generation = 2, status = 'revoked', material_encrypted = NULL",
    "generation = 2, material_encrypted = 'plaintext'", "generation = 2, material_encrypted = 'v1:legacy'",
  ])('ordinary DML rejects forbidden transition %# without changing audit or material', async assignment => {
    await first.store.create({ material: material() })
    const before = await evidence()
    expect(await outcome(owner.query(`UPDATE ${ident(MATERIALS)} SET ${assignment}`))).toEqual({ ok: false, code: 'P0001' })
    expect(await evidence()).toEqual(before)
  })

  it('ordinary DML cannot revive a revoked generation or erase its retained identity', async () => {
    const one = await first.store.create({ material: material() })
    await first.store.revoke(cas(one))
    const before = await evidence()
    expect(await outcome(owner.query(`UPDATE ${ident(MATERIALS)} SET status = 'current', material_encrypted = $1`, [await envelope(one)])))
      .toEqual({ ok: false, code: 'P0001' })
    expect(await evidence()).toEqual(before)
  })

  it.each([
    `DELETE FROM ${MATERIALS}`, `TRUNCATE ${MATERIALS} CASCADE`,
    `UPDATE ${AUDIT} SET actor_id = 'synthetic-other'`, `DELETE FROM ${AUDIT}`, `TRUNCATE ${AUDIT}`,
  ])('ordinary DML cannot remove a material tombstone or rewrite audit %#', async sql => {
    const one = await first.store.create({ material: material() })
    await first.store.revoke(cas(one))
    const before = await evidence()
    expect(await outcome(owner.query(sql))).toEqual({ ok: false, code: 'P0001' })
    expect(await evidence()).toEqual(before)
  })

  it('max-generation rotation refuses but revocation still erases the current ciphertext', async () => {
    const one = await first.store.create({ material: material() })
    // Privileged fixture setup in this owned schema only, not a reachable normal
    // transition: avoids billions of rotations while exercising the real boundary.
    await owner.query('BEGIN')
    try {
      await owner.query(`ALTER TABLE ${ident(MATERIALS)} DISABLE TRIGGER trg_integration_yida_credential_material_guard`)
      await owner.query(`UPDATE ${ident(MATERIALS)} SET generation = 2147483647, material_encrypted = $1`,
        [await envelope({ ...one, credentialGeneration: 2147483647 })])
      await owner.query(`ALTER TABLE ${ident(MATERIALS)} ENABLE TRIGGER trg_integration_yida_credential_material_guard`)
      await owner.query('COMMIT')
    } catch (error) { await owner.query('ROLLBACK'); throw error }
    const highest = { ...one, credentialGeneration: 2147483647 }
    await rejected(first.store.rotate({ ...cas(highest), material: material() }), 'YIDA_CREDENTIAL_CONFLICT')
    expect((await second.store.revoke(cas(highest))).status).toBe('revoked')
    expect((await rows(MATERIALS))[0].material_encrypted === null).toBe(true)
  })
})

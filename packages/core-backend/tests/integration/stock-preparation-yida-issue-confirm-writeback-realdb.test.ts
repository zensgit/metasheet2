// YiDa 发料确认日期回写 — the WIRING on a real PostgreSQL (design baseline v2.3 §7.3 and B.4, frozen ⑦.4 plan §2.2;
// slice Y9 on top of the Y9a core). Everything below is the production composition, driven in-process:
//   host owner runtime (yida-owner-runtime.ts) + the REAL plugin runtime factory, send port, runner, token client and form
//   transport + the real core authority with the real D21 re-authorization + the Y9 wiring (the post-ACK hook in the host
//   owner runtime, the owner recovery entry, the plugin ports of yida-issue-confirm-writeback-ports.mjs, the host live re-check)
//   + the real plugin stores (draft, target, material, delivery ledger, project registry, sheet write lease, trace)
//   + the host's own multitable records functions (queryRecords / patchRecord + the plugin write fence), wired exactly as
//   packages/core-backend/src/index.ts wires `records` for a plugin (plugin-scope's ownership wall is not part of it).
// The YiDa side is a synthetic fetch double that cannot reach any network; it counts token requests and form POSTs.
// The YiDa tables, the ACL rows, the registry and the lease live in a private schema; the multitable sheet, its fields
// and records, and the D21 version rows live in the migrated PUBLIC schema (the send-approvals real-DB precedent).
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const requireCjs = createRequire(import.meta.url)
const importNative = requireCjs('../utils/yida-native-module-import.cjs')
const LEDGER = 'integration_yida_delivery_ledger', LEDGER_AUDIT = 'integration_yida_delivery_audit'
const APPROVAL = 'integration_yida_send_approvals', ADMISSION = 'integration_yida_send_admissions'
const APPROVAL_AUDIT = 'integration_yida_send_approval_audit', TRACE = 'integration_yida_issue_confirm_writeback'
const REGISTRY = 'integration_stock_prep_project_target', LOCK = 'integration_stock_prep_project_write_lock'
const OP = 'integration_yida_draft_operations'
const proofTables = [APPROVAL, ADMISSION, APPROVAL_AUDIT, LEDGER, LEDGER_AUDIT]
const TENANT = 'synthetic-tenant', OWNER = 'synthetic-owner'
const LINES = ['SYN-LINE-1', 'SYN-LINE-2', 'SYN-LINE-3']
const HUMAN_NOTE = 'synthetic human note'
// 2026-03-01T16:30Z is 2026-03-02 00:30 in Asia/Shanghai: neither the UTC day nor "today" can produce this day.
const PAST_ACK = '2026-03-01T16:30:00.000Z', PAST_DAY = '2026-03-02'
type Row = Record<string, unknown>
type HostSecurity = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
type Actor = { actorId: string; tenantId: string; workspaceId: null }
type Result = { enabled: boolean; results: Row[]; next?: string | null; stopped?: string }
type Runtime = {
  createPluginCapability(): { activate(binding: unknown): Promise<{ stop(): Promise<void> }> }
  approve(actor: Actor, input: unknown): Promise<Row & { grantId: string; ledgerId: string | null }>
  submit(actor: Actor, input: unknown): Promise<Row & { status: string; reused: boolean; delivery: { id: string } | null }>
  issueConfirmWriteback(actor: Actor, input: unknown): Promise<Result>
  issueConfirmWritebackEnabled(): boolean
  stop(): Promise<void>
}
type Capability = { enabled(): boolean; create(input: unknown): { run(input?: unknown): Promise<Result> } }
type FetchDouble = { fetch(url: string, init: RequestInit): Promise<Response>; token: number; form: number }
type Gate = { reached: Promise<void>; release(): void; enter(): void; open: Promise<void> }

it('sentinel: the issue-confirm write-back proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

databaseSuite('Y9 issue-confirm write-back wiring — real host runtime, send port, stores and multitable records', () => {
  let admin: Pool, owner: PoolClient, pool: Pool | undefined, security: HostSecurity
  let schema = '', ddl = ''
  // Per test: the project-sheet objectId (and so every physical field id) derives from (tenant, project).
  let PROJECT = ''
  let createDb: (options: { database: unknown }) => Row
  let createMaterial: (options: Row) => { create(input: unknown): Promise<{ credentialRef: string; credentialGeneration: number }> }
  let createDraft: (options: Row) => { createDraft(input: unknown): Promise<{ operationId: string; rows: Array<{ rowKey: string }> }> }
  let createTarget: (options: Row) => { register(input: unknown): Promise<{ targetRef: string }> }
  let createLedger: (options: Row) => Row & { prepare(input: unknown): Promise<{ record: Row }>; claim(input: unknown): Promise<{ claimToken: string }>
    recordAcknowledgement(input: unknown): Promise<unknown>; markUnknown(input: unknown): Promise<unknown>; cancelPrepared(input: unknown): Promise<unknown> }
  let createBinding: (options: Row) => unknown
  let createCapability: (options: Row) => Capability
  let createRegistryStore: (options: Row) => unknown
  let createWriteLock: (options: Row) => unknown
  let deriveObjectId: (tenantId: string, projectNo: string) => string
  let createRuntime: (dependencies: Row) => Runtime
  let reauthorizer: () => unknown
  let resolveFieldIds: (projectId: string, objectId: string, fieldIds: string[]) => Record<string, string>
  let queryRecords: (input: Row) => Promise<Row[]>
  let patchRecord: (input: Row) => Promise<Row>
  let resolveFence: (pluginName: string, fence: unknown) => unknown
  let assertFence: (query: unknown, fence: unknown) => Promise<void>
  const envKeys = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const
  let savedEnv: Array<[typeof envKeys[number], string | undefined]> = []
  // Every statement of every connection of the test, in order (SQL shapes only, never values).
  const statements: string[] = []
  // ... and the subset issued by the write-back's own ports (its plugin db and the records surface it is handed).
  const wbStatements: string[] = []
  let failOnce: { pattern: RegExp; error: Error } | undefined
  let gateOnce: (Gate & { pattern: RegExp }) | undefined
  const parkedGates: Gate[] = []
  const actor: Actor = Object.freeze({ actorId: OWNER, tenantId: TENANT, workspaceId: null })
  const ident = (value: string) => {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('SYNTHETIC_IDENTIFIER_REQUIRED')
    return `"${value}"`
  }
  const material = () => ({ appKey: 'synthetic-issue-app', appSecret: 'synthetic-issue-secret',
    systemToken: 'synthetic-issue-system-token', userId: 'synthetic-executor' })
  const objectId = () => deriveObjectId(TENANT, PROJECT)
  const sheetId = () => `${schema}_sheet`
  const recordId = (index: number) => `${schema}_rec_${index}`
  const FIELD_IDS = ['idempotencyKey', 'projectNo', 'issueConfirmDate', 'warehouseConfirmation']
  const fld = () => resolveFieldIds(`${TENANT}:integration-core`, objectId(), FIELD_IDS)
  const tableRows = async (table: string) => (await owner.query(`SELECT * FROM ${ident(table)} ORDER BY 1`)).rows as Row[]
  async function evidence() {
    const rows = await Promise.all(proofTables.map(tableRows))
    return { counts: rows.map(value => value.length), digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
  }
  const businessDay = (instant: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(instant)
  function latch(): Gate {
    let enter!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { enter = resolve }), open = new Promise<void>(resolve => { release = resolve })
    return { reached, open, enter, release }
  }
  async function waitFor(gate: Gate) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([gate.reached, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('SYNTHETIC_GATE_TIMEOUT')), 8000)
    })]) } finally { clearTimeout(timer) }
  }
  async function run(client: PoolClient, sql: string, params?: unknown[], tag?: 'wb') {
    statements.push(sql)
    if (tag === 'wb') wbStatements.push(sql)
    if (gateOnce && gateOnce.pattern.test(sql)) { const held = gateOnce; gateOnce = undefined; parkedGates.push(held); held.enter(); await held.open }
    if (failOnce && failOnce.pattern.test(sql)) { const failure = failOnce; failOnce = undefined; throw failure.error }
    return client.query(sql, params)
  }
  async function inTransaction<T>(callback: (query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>) => Promise<T>,
    tag?: 'wb') {
    const client = await pool!.connect()
    try {
      await run(client, 'BEGIN', undefined, tag)
      const result = await callback(async (sql, params) => {
        const done = await run(client, sql, params, tag)
        return { rows: done.rows as Row[], rowCount: done.rowCount }
      })
      await run(client, 'COMMIT', undefined, tag)
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
  }
  async function autocommit(sql: string, params?: unknown[], tag?: 'wb') {
    const client = await pool!.connect()
    try { const done = await run(client, sql, params, tag); return { rows: done.rows as Row[], rowCount: done.rowCount } } finally { client.release() }
  }
  // The host's transaction port (index.ts yidaOwnerTransaction shape) and the plugin's structured db over the same pool.
  const hostDatabase = { transaction: <T>(callback: (trx: Queryable) => Promise<T>) => inTransaction(query => callback({ query } as Queryable)) }
  const pluginDatabaseOf = (tag?: 'wb') => ({
    query: async (sql: string, params?: unknown[]) => (await autocommit(sql, params, tag)).rows,
    transaction: <T>(callback: (trx: { query(sql: string, params?: unknown[]): Promise<Row[]> }) => Promise<T>) =>
      inTransaction(query => callback({ query: async (sql, params) => (await query(sql, params)).rows }), tag),
  })
  const pluginDatabase = pluginDatabaseOf()
  // The host records surface for a plugin, exactly as index.ts builds it (multitable.records), plus plugin-scope's
  // fence resolution for the calling plugin.
  const patches: Row[] = []
  let creates = 0
  function hostRecords() {
    const query = async (sql: string, params?: unknown[]) => autocommit(sql, params, 'wb')
    return {
      supportsFilterValueLists: true,
      supportsWriteFence: true,
      queryRecords: async ({ sheetId, filters, search, orderBy, limit, offset }: Row) =>
        queryRecords({ query, sheetId, filters, search, orderBy, limit, offset }),
      // Present on the host surface; the write-back never creates a record (counted, and it would fail loudly).
      createRecord: async () => { creates++; throw new Error('SYNTHETIC_CREATE_MUST_NOT_RUN') },
      patchRecord: async ({ sheetId, recordId, changes, expectedVersion, writeFence }: Row) => {
        const resolved = resolveFence('plugin-integration-core', writeFence)
        patches.push({ recordId, expectedVersion, fenced: resolved !== undefined })
        return inTransaction(async txQuery => {
          await assertFence(txQuery, resolved)
          return patchRecord({ query: txQuery, sheetId, recordId, changes, expectedVersion })
        }, 'wb')
      },
    }
  }
  function http(): FetchDouble {
    const value: FetchDouble = { token: 0, form: 0,
      async fetch(url, init) {
        // Fixed synthetic implementation; never calls global fetch or opens a socket.
        if (init.method !== 'POST' || init.redirect !== 'error') throw new Error('SYNTHETIC_UNEXPECTED_REQUEST')
        if (url.endsWith('/v1.0/oauth2/accessToken')) {
          value.token++
          return new Response(JSON.stringify({ accessToken: 'synthetic-token', expireIn: 3600 }), { status: 200 })
        }
        if (url.endsWith('/v1.0/yida/forms/instances')) {
          value.form++
          return new Response(JSON.stringify({ result: 'synthetic-instance' }), { status: 201 })
        }
        throw new Error('SYNTHETIC_UNEXPECTED_FETCH')
      } }
    return value
  }
  type World = { runtime: Runtime; fake: FetchDouble; env: Record<string, string | undefined>; targetRef: string
    crashHookOnce: boolean; capability: Capability; runs: Promise<Result>[]; warnings: string[]; stop(): Promise<void> }
  let world: World | undefined
  async function compose(options: { crashHookOnce?: boolean; env?: Record<string, string | undefined> } = {}): Promise<World> {
    const db = createDb({ database: pluginDatabase })
    // The same createDb over the same pool; a separate wrapper only so the write-back's statements can be told apart.
    const wbDb = createDb({ database: pluginDatabaseOf('wb') })
    const env: Record<string, string | undefined> = { INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: 'true',
      MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED: 'true', ...options.env }
    const capability = createCapability({ db: wbDb, security, env,
      projectTargetStore: createRegistryStore({ db: wbDb }), projectWriteLock: createWriteLock({ db: wbDb }),
      multitable: () => ({ records: hostRecords(), provisioning: { resolveFieldIds: async ({ projectId, objectId, fieldIds }: Row) =>
        resolveFieldIds(String(projectId), String(objectId), fieldIds as string[]) } }) })
    const state = { crashed: false }
    // Every write-back run (the post-ACK run the host schedules after submit returned, and the recovery entry's) is
    // recorded so a test can wait for the detached post-ACK run to settle before it asserts (D5 a: the send result no
    // longer waits for it). Crash test (a): with crashHookOnce, the FIRST run (the post-ACK one — the crash point after
    // the send settled and before the write-back) throws; every later call is the real one.
    const wrapped: Capability = {
      enabled: () => capability.enabled(),
      create: (input: unknown) => {
        const real = capability.create(input)
        return { run: (request?: unknown) => {
          const pending = (async () => {
            if (options.crashHookOnce && !state.crashed) { state.crashed = true; throw new Error('SYNTHETIC_CRASH_BEFORE_WRITEBACK') }
            return real.run(request)
          })()
          runs.push(pending)
          return pending
        } }
      },
    }
    const runs: Promise<Result>[] = []
    const fake = http()
    const warnings: string[] = []
    const runtime = createRuntime({ database: hostDatabase, security, fetch: fake.fetch, readEnablement: () => 'true',
      reauthorizeSourceBinding: reauthorizer(), timeoutMs: 10000, warn: (code: string) => { warnings.push(code) } })
    // index.cjs hands the binding a frozen, bound security pair (own data properties only).
    const bound = Object.freeze({ encrypt: security.encrypt.bind(security), decrypt: security.decrypt.bind(security) })
    const binding = createBinding({ db, security: bound, issueConfirmWriteback: wrapped })
    const handle = await runtime.createPluginCapability().activate(binding)
    world = { runtime, fake, env, targetRef: '', crashHookOnce: Boolean(options.crashHookOnce), capability, runs, warnings,
      async stop() { await handle.stop(); await runtime.stop() } }
    return world
  }
  async function seedSheet() {
    const f = fld()
    await owner.query('INSERT INTO public.meta_sheets (id, name) VALUES ($1, $2)', [sheetId(), 'synthetic issue-confirm project sheet'])
    const columns: Array<[string, string, Row]> = [['idempotencyKey', 'text', { stockPreparation: { key: true } }], ['projectNo', 'text', {}],
      ['issueConfirmDate', 'date', {}], ['warehouseConfirmation', 'text', {}]]
    for (const [order, [logical, type, property]] of columns.entries()) {
      await owner.query('INSERT INTO public.meta_fields (id, sheet_id, name, type, "order", property) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
        [f[logical], sheetId(), logical, type, order, JSON.stringify(property)])
    }
    for (const [index, line] of LINES.entries()) {
      await owner.query('INSERT INTO public.meta_records (id, sheet_id, data) VALUES ($1, $2, $3::jsonb)', [recordId(index), sheetId(),
        JSON.stringify({ [f.idempotencyKey]: line, [f.projectNo]: PROJECT, [f.warehouseConfirmation]: HUMAN_NOTE })])
    }
    await owner.query('INSERT INTO public.sheet_permission_versions (sheet_id) VALUES ($1) ON CONFLICT (sheet_id) DO NOTHING', [sheetId()])
    await owner.query(`INSERT INTO ${ident(REGISTRY)} (id, tenant_id, project_no, sheet_id, object_id, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
      [randomUUID(), TENANT, PROJECT, sheetId(), objectId()])
  }
  async function cleanSheet() {
    const prefix = `${schema}%`
    await owner.query('DELETE FROM public.meta_record_revisions WHERE sheet_id LIKE $1', [prefix]).catch(() => {})
    await owner.query('DELETE FROM public.meta_sheets WHERE id LIKE $1', [prefix])
    await owner.query('DELETE FROM public.sheet_permission_versions WHERE sheet_id LIKE $1', [prefix])
  }
  const cell = async (index = 0) => {
    const row = (await owner.query('SELECT data, version FROM public.meta_records WHERE id = $1', [recordId(index)])).rows[0] as Row
    return { data: row.data as Row, version: Number(row.version), date: (row.data as Row)[fld().issueConfirmDate] ?? null }
  }
  // The issue-confirm v2 rule (docs/.../yida-legacy-templates/issue-confirm.json), bound to project-sheet record `index`.
  function boundInput(index: number) {
    const f = fld()
    return {
      config: { version: 2, kind: 'yida-form-protocol-static', intent: 'create',
        target: { appType: 'synthetic_issue_app', formUuid: 'synthetic_issue_form' },
        businessKey: ['idempotencyKey', 'projectNo'], emptyKeyFields: [],
        fieldCatalog: [{ id: 'sourceLineId', control: 'text', required: true }, { id: 'project', control: 'text', required: true }],
        fieldMap: [{ source: 'idempotencyKey', target: 'sourceLineId', type: 'string', required: true },
          { source: 'projectNo', target: 'project', type: 'string', required: true }] },
      rowsText: JSON.stringify([{ idempotencyKey: LINES[index], projectNo: PROJECT }]),
      allocation: { mode: 'original' },
      sourceBinding: { sheetId: sheetId(), keyFieldId: f.idempotencyKey,
        fieldBindings: { idempotencyKey: f.idempotencyKey, projectNo: f.projectNo },
        records: [{ recordId: recordId(index), keyValue: LINES[index], projectNo: PROJECT }] },
    }
  }
  function unboundInput(line: string) {
    const { sourceBinding: _binding, ...rest } = boundInput(0)
    return { ...rest, rowsText: JSON.stringify([{ idempotencyKey: line, projectNo: PROJECT }]) }
  }
  const pluginStores = () => {
    const db = createDb({ database: pluginDatabase }), context = { tenantId: TENANT, workspaceId: null, ownerId: OWNER }
    return { db, draft: createDraft({ db, security, context }), material: createMaterial({ db, security, context }),
      target: createTarget({ db, security, context }), ledger: createLedger({ db }) }
  }
  // One draft per call; the first call also registers slot 1 for that draft's locator and lists it for the write-back.
  async function draft(input: unknown) {
    const stores = pluginStores(), made = await stores.draft.createDraft(input)
    if (!world!.targetRef) {
      const secret = await stores.material.create({ material: material() })
      const target = await stores.target.register({ operationId: made.operationId, credentialRef: secret.credentialRef,
        credentialGeneration: secret.credentialGeneration, attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-review',
          organizationId: 'synthetic-organization', executionIdentity: 'synthetic-executor' } })
      world!.targetRef = target.targetRef
      if (!Object.hasOwn(world!.env, 'INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS')) world!.env.INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS = target.targetRef
    }
    return made
  }
  // D5 a: an acknowledged send answers BEFORE its post-ACK write-back starts; by default sendOne then waits for that
  // detached run to start and settle, so the assertions that follow see its effects (settle: false leaves it running).
  async function sendOne(input: unknown, submissionId = 'synthetic-submission', options: { settle?: boolean } = {}) {
    const made = await draft(input)
    const grant = await world!.runtime.approve(actor, { operationId: made.operationId, rowKey: made.rows[0].rowKey, confirmationId: 'synthetic-confirmation' })
    const started = world!.runs.length
    const result = await world!.runtime.submit(actor, { grantId: grant.grantId, submissionId })
    if (options.settle !== false && result.status === 'acknowledged' && result.reused === false) await settleAfterAck(started)
    return { made, grant, result, request: { grantId: grant.grantId, submissionId } }
  }
  async function settleAfterAck(started: number) {
    const deadline = Date.now() + 8000
    while (world!.runs.length <= started) {
      if (Date.now() > deadline) throw new Error('SYNTHETIC_POST_ACK_RUN_NEVER_STARTED')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    await Promise.allSettled(world!.runs)
    // The host run retires after the plugin run settled (its own checkpoint and dependency drain).
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const ledgerRow = async (id: string) => (await tableRows(LEDGER)).find(row => row.id === id)!
  const auditsOf = async (id: string) => (await tableRows(LEDGER_AUDIT)).filter(row => row.ledger_id === id).map(row => String(row.event)).sort()
  const ackAt = async (id: string) => (await owner.query(`SELECT created_at FROM ${ident(LEDGER_AUDIT)} WHERE ledger_id = $1 AND event = 'acknowledgement'`, [id])).rows[0].created_at as Date
  // Privileged fixture edit of our synthetic schema (the guard is the subject of other tests): move the ack audit's time.
  async function backdateAck(id: string, at: string) {
    await owner.query('BEGIN')
    try {
      await owner.query(`ALTER TABLE ${ident(LEDGER_AUDIT)} DISABLE TRIGGER trg_integration_yida_delivery_audit_guard`)
      await owner.query(`UPDATE ${ident(LEDGER_AUDIT)} SET created_at = $1 WHERE ledger_id = $2 AND event = 'acknowledgement'`, [at, id])
      await owner.query(`ALTER TABLE ${ident(LEDGER_AUDIT)} ENABLE TRIGGER trg_integration_yida_delivery_audit_guard`)
      await owner.query('COMMIT')
    } catch (error) { await owner.query('ROLLBACK'); throw error }
  }
  const outcomeOf = (result: Result) => result.results.map(entry => entry.kind === 'outcome' ? entry.outcome : `${entry.kind}:${entry.reason ?? entry.code}`)
  // The host's two fixed post-ACK log codes (yida-owner-runtime.ts): a failed run, and (stock-prep C2) a run that finished
  // normally with a retryable row. A code arrives after the host run retired, so a test that expects one waits for it.
  const HOOK_FAILED = 'YIDA_ISSUE_CONFIRM_WRITEBACK_AFTER_ACK_FAILED'
  const DEFERRED = 'YIDA_ISSUE_CONFIRM_WRITEBACK_DEFERRED'
  async function warned(count = 1) {
    const deadline = Date.now() + 4000
    while (world!.warnings.length < count) {
      if (Date.now() > deadline) throw new Error('SYNTHETIC_WARNING_NEVER_LOGGED')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    // Long enough for a second code of the same run to show up if one were ever logged.
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  beforeAll(async () => {
    const lib = path.join(root, 'plugins/plugin-integration-core/lib')
    const native = (name: string) => importNative(pathToFileURL(path.join(lib, name)).href)
    createDb = requireCjs(path.join(lib, 'db.cjs')).createDb
    createMaterial = requireCjs(path.join(lib, 'yida-credential-material-store.cjs')).createYidaCredentialMaterialStore
    createLedger = requireCjs(path.join(lib, 'yida-delivery-store.cjs')).createYidaDeliveryStore
    createRegistryStore = requireCjs(path.join(lib, 'stock-preparation-project-target-store.cjs')).createStockPreparationProjectTargetStore
    createWriteLock = requireCjs(path.join(lib, 'stock-preparation-project-write-lock.cjs')).createStockPreparationProjectWriteLock
    deriveObjectId = requireCjs(path.join(lib, 'stock-preparation-project-targets.cjs')).deriveProjectSheetObjectId
    createDraft = (await native('yida-draft-plan-store.mjs')).createYidaDraftPlanStore
    createTarget = (await native('yida-approved-target-store.mjs')).createYidaApprovedTargetStore
    createBinding = (await native('yida-owner-runtime-factory.mjs')).createYidaOwnerRuntimeBinding
    createCapability = (await native('yida-issue-confirm-writeback-ports.mjs')).createIssueConfirmWritebackCapability
    const src = (relative: string) => import(pathToFileURL(path.join(root, 'packages/core-backend/src', relative)).href)
    createRuntime = (await src('integration/yida-owner-runtime.ts')).createYidaOwnerRuntime
    reauthorizer = (await src('integration/yida-source-reauthorization-host.ts')).createYidaSourceBindingReauthorizer
    resolveFieldIds = (await src('multitable/provisioning.ts')).resolveObjectFieldIds
    const records = await src('multitable/records.ts')
    queryRecords = records.queryRecords; patchRecord = records.patchRecord
    const fence = await src('multitable/plugin-write-fence.ts')
    resolveFence = fence.resolvePluginWriteFence; assertFence = fence.assertPluginWriteFence
    const migrations = path.join(root, 'packages/core-backend/migrations')
    const migrationSql = async (name: string, key: string) => ((await src(`db/migrations/${name}.ts`)) as Record<string, string>)[key]
    ddl = ['090_create_integration_yida_delivery_ledger.sql', '091_create_integration_yida_create_fence.sql',
      '092_create_integration_yida_credential_materials.sql', '093_create_integration_yida_draft_plans.sql',
      '094_create_integration_yida_approved_target.sql', '095_create_integration_yida_send_approvals.sql']
      .map(name => readFileSync(path.join(migrations, name), 'utf8')).join('\n')
      + '\n' + await migrationSql('zzzz20261106110300_add_integration_yida_source_binding', 'YIDA_SOURCE_BINDING_UP_SQL')
      + '\n' + readFileSync(path.join(migrations, '087_create_integration_stock_prep_project_target.sql'), 'utf8')
      + '\n' + readFileSync(path.join(migrations, '100_create_integration_stock_prep_project_write_lock.sql'), 'utf8')
      // Slice Y9a's trace table exactly as its up() executes.
      + '\n' + await migrationSql('zzzz20261106093100_create_integration_yida_issue_confirm_writeback', 'YIDA_ISSUE_CONFIRM_WRITEBACK_UP_SQL')
    savedEnv = envKeys.map(key => [key, process.env[key]])
    process.env.NODE_ENV = 'production'
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex')
    process.env.ENCRYPTION_SALT = randomBytes(32).toString('hex')
    const { PluginRuntimeSecurityService } = await src('security/plugin-runtime-security-service.ts') as { PluginRuntimeSecurityService: new () => HostSecurity }
    security = new PluginRuntimeSecurityService()
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 })
    owner = await admin.connect(); await owner.query("SET statement_timeout = '10s'")
  }, 60000)
  beforeEach(async () => {
    schema = 'yida_issue_confirm_' + randomUUID().replaceAll('-', '')
    PROJECT = 'DEMO-' + schema.slice(-10).toUpperCase()
    // The private DDL runs with ONLY the private schema on the path (a migration's own existence probe must not find the
    // migrated PUBLIC copy); afterwards the path falls back to PUBLIC for meta_* and the D21 version rows.
    await owner.query(`CREATE SCHEMA ${ident(schema)}`); await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(ddl)
    await owner.query(`
      CREATE TABLE users (id text PRIMARY KEY, role text, permissions jsonb, is_active boolean,
        activation_status text, local_password_set boolean, is_admin boolean);
      CREATE TABLE user_roles (user_id varchar(255), role_id varchar(255), PRIMARY KEY(user_id,role_id));
      CREATE TABLE role_permissions (role_id varchar(255), permission_code varchar(255), PRIMARY KEY(role_id,permission_code));
      CREATE TABLE user_permissions (user_id varchar(255), permission_code varchar(255), PRIMARY KEY(user_id,permission_code));
      CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean NOT NULL, PRIMARY KEY(user_id,org_id));
      CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean NOT NULL DEFAULT false, UNIQUE(user_id,namespace));
      INSERT INTO users VALUES ('synthetic-owner','user','[]',true,'activated',false,false);
      INSERT INTO user_roles VALUES ('synthetic-owner','integration_admin');
      -- D13 a: the write-back's operator tier reaches the owner THROUGH A ROLE (operate AND read).
      INSERT INTO role_permissions VALUES ('integration_admin','multitable:read'),
        ('integration_admin','stock-prep:operate'),('integration_admin','stock-prep:read');
      INSERT INTO user_permissions VALUES ('synthetic-owner','integration:admin');
      INSERT INTO user_orgs VALUES ('synthetic-owner','synthetic-tenant',true);
      INSERT INTO user_namespace_admissions VALUES ('synthetic-owner','integration',true);
    `)
    await owner.query(`SET search_path TO ${ident(schema)}, public`)
    await seedSheet()
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},public -c statement_timeout=10000` })
    statements.length = 0; wbStatements.length = 0; patches.length = 0; failOnce = undefined; gateOnce = undefined
  }, 60000)
  afterEach(async () => {
    gateOnce?.release(); gateOnce = undefined; failOnce = undefined
    for (const gate of parkedGates.splice(0)) gate.release()
    expect(creates).toBe(0); creates = 0
    if (world) { await world.stop().catch(() => {}); world = undefined }
    if (pool) { await pool.end(); pool = undefined }
    if (schema) { await cleanSheet(); await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schema = '' }
  })
  afterAll(async () => {
    try {
      if (owner) { if (schema) await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); owner.release() }
      await admin?.end()
    } finally { for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  })

  it('an acknowledged bound issue-confirm CREATE fills ONLY issueConfirmDate with the acknowledgement audit\'s business day, through the post-ACK hook; one written trace; ledger and audits untouched', async () => {
    await compose()
    const before = await cell()
    const { grant, result } = await sendOne(boundInput(0))
    expect([result.status, result.reused]).toEqual(['acknowledged', false])
    expect([world!.fake.token, world!.fake.form]).toEqual([1, 1])
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    expect((await ledgerRow(ledgerId)).status).toBe('acknowledged')
    const after = await cell()
    expect(after.date).toBe(businessDay(await ackAt(ledgerId)))
    // Only the machine column moved; the human column and every other cell are byte-identical; one version bump.
    expect({ ...after.data, [fld().issueConfirmDate]: undefined }).toEqual({ ...before.data, [fld().issueConfirmDate]: undefined })
    expect(after.data[fld().warehouseConfirmation]).toBe(HUMAN_NOTE)
    expect(after.version).toBe(before.version + 1)
    expect(patches).toEqual([{ recordId: recordId(0), expectedVersion: before.version, fenced: true }])
    const trace = await tableRows(TRACE)
    expect(trace.map(row => [row.ledger_id, row.outcome, row.sheet_id, row.time_zone])).toEqual([[ledgerId, 'written', sheetId(), 'Asia/Shanghai']])
    expect(await auditsOf(ledgerId)).toEqual(['acknowledgement', 'claim', 'prepare'])
    // The lease was released and the generation never moved (register R-96, Plan A: no bump after the write). The lock
    // row is the one the write-back's own acquire created (there is no pre-write snapshot to compare with), so a bump of
    // any reason would leave generation_reason / generation_bumped_at set.
    const lock = (await tableRows(LOCK))[0]
    expect([lock.lease_id ?? null, lock.generation_reason, lock.generation_bumped_at]).toEqual([null, null, null])
    // values-free trace: no project number, key or human value.
    const text = JSON.stringify(trace)
    for (const value of [PROJECT, ...LINES, HUMAN_NOTE]) expect(text.includes(value)).toBe(false)
    // A written row logs nothing (C2: only a retryable row is DEFERRED; only a failed run is HOOK_FAILED).
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(world!.warnings).toEqual([])
  })

  it('ack persisted, crash before write-back: recovery fills only the local date; ledger, audits and the single form submission are untouched', async () => {
    await compose({ crashHookOnce: true })
    const before = await cell()
    const { grant, result, request } = await sendOne(boundInput(0))
    // The hook's executor threw: the send's answer is still the acknowledged one; the host logged one fixed code.
    expect([result.status, result.reused, result.durable]).toEqual(['acknowledged', false, true])
    await warned()
    expect(world!.warnings).toEqual([HOOK_FAILED])
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    expect((await ledgerRow(ledgerId)).status).toBe('acknowledged')
    expect(await auditsOf(ledgerId)).toEqual(['acknowledgement', 'claim', 'prepare'])
    expect(await tableRows(TRACE)).toEqual([])
    expect((await cell()).date).toBe(null)
    expect([world!.fake.token, world!.fake.form]).toEqual([1, 1])
    const proof = await evidence()
    statements.length = 0
    // Recovery: ONE call of the owner entry.
    const recovered = await world!.runtime.issueConfirmWriteback(actor, {})
    expect(outcomeOf(recovered)).toEqual(['written'])
    const recoveryStatements = [...statements]
    const after = await cell()
    expect(after.date).toBe(businessDay(await ackAt(ledgerId)))
    expect(after.version).toBe(before.version + 1)
    expect(after.data[fld().warehouseConfirmation]).toBe(HUMAN_NOTE)
    const trace = await tableRows(TRACE)
    expect(trace.map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, 'written']])
    // Ledger, the three delivery audits and the grant / admission / approval audits are byte-identical.
    expect(await evidence()).toEqual(proof)
    // The recovery entry wrote nothing but the trace row and the one cell (plus the lease and D21 version-row ensures).
    const writes = recoveryStatements.filter(sql => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))
    expect(writes.some(sql => [LEDGER, LEDGER_AUDIT, APPROVAL, ADMISSION, APPROVAL_AUDIT].some(table => new RegExp(`\\b"?${table}"?\\b`).test(sql)
      && !sql.includes(TRACE)))).toBe(false)
    // The single form submission: still one POST, no new token request.
    expect([world!.fake.token, world!.fake.form]).toEqual([1, 1])
    // Submitting the same grant again only observes history: reused, nothing sent.
    const again = await world!.runtime.submit(actor, request)
    expect([again.status, again.reused]).toEqual(['acknowledged', true])
    expect([world!.fake.token, world!.fake.form]).toEqual([1, 1])
    // And a second recovery has nothing left to do for this row (it is traced).
    expect((await world!.runtime.issueConfirmWriteback(actor, {})).results).toEqual([])
    expect(await tableRows(TRACE)).toHaveLength(1)
  })

  it('date committed, confirmation lost: a retry neither changes the date nor writes a second success record; the form submission count stays 1', async () => {
    await compose({ crashHookOnce: true })
    const before = await cell()
    const { grant, result } = await sendOne(boundInput(0))
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    // The acknowledgement happened on a PAST business day; the recovery runs "the next day" (today).
    await backdateAck(ledgerId, PAST_ACK)
    const proof = await evidence()
    // Crash point: after the patch transaction committed, before the trace INSERT.
    failOnce = { pattern: new RegExp(`^INSERT INTO "${TRACE}"`), error: new Error('SYNTHETIC_CRASH_AFTER_PATCH') }
    await expect(world!.runtime.issueConfirmWriteback(actor, {})).rejects.toBeTruthy()
    expect((await cell()).date).toBe(PAST_DAY)
    expect(await tableRows(TRACE)).toEqual([])
    // The retry COMPLETES NORMALLY (no throw) and converges on exactly one trace row.
    const retried = await world!.runtime.issueConfirmWriteback(actor, {})
    expect(outcomeOf(retried)).toEqual(['already_set'])
    const after = await cell()
    expect(after.date).toBe(PAST_DAY) // the audit's day, not today's
    expect(after.version).toBe(before.version + 1) // no second patch
    expect(patches).toHaveLength(1)
    const trace = await tableRows(TRACE)
    expect(trace.map(row => [row.ledger_id, row.outcome, String(row.time_zone)])).toEqual([[ledgerId, 'already_set', 'Asia/Shanghai']])
    expect((await owner.query(`SELECT written_date::text AS day FROM ${ident(TRACE)}`)).rows[0].day).toBe(PAST_DAY)
    expect(await auditsOf(ledgerId)).toEqual(['acknowledgement', 'claim', 'prepare'])
    expect((await tableRows(APPROVAL_AUDIT)).map(row => String(row.event)).sort()).toEqual(['admit', 'approve'])
    expect(await evidence()).toEqual(proof)
    expect([world!.fake.token, world!.fake.form]).toEqual([1, 1])
  })

  it('date committed, confirmation lost (concurrent): two recovery runs that both decided the row converge on ONE trace and both complete normally', async () => {
    await compose({ crashHookOnce: true })
    const before = await cell()
    const { grant, result } = await sendOne(boundInput(0))
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    await backdateAck(ledgerId, PAST_ACK)
    // Run 2 is parked right after it read the ledger and found the row untraced (its first lease statement) ...
    const parked = { ...latch(), pattern: new RegExp(`\\b${LOCK}\\b`) }
    gateOnce = parked
    const second = world!.runtime.issueConfirmWriteback(actor, {})
    await waitFor(parked)
    // ... while run 1 decides the same row completely: patch, trace, release.
    const firstRun = await world!.runtime.issueConfirmWriteback(actor, {})
    expect(outcomeOf(firstRun)).toEqual(['written'])
    parked.release()
    // Run 2 now finds the date set and INSERTs a trace for a ledger row that already has one: ON CONFLICT DO NOTHING
    // lets it complete normally (recorded: false) instead of failing with 23505.
    const secondRun = await second
    expect(outcomeOf(secondRun)).toEqual(['already_set'])
    expect(secondRun.results[0].recorded).toBe(false)
    const trace = await tableRows(TRACE)
    expect(trace.map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, 'written']])
    const after = await cell()
    expect([after.date, after.version]).toEqual([PAST_DAY, before.version + 1])
    expect([world!.fake.token, world!.fake.form]).toEqual([1, 1])
  })

  it.each([
    ['not_acknowledged (outcome_unknown)', 'outcome_unknown'],
    ['not_acknowledged (prepared)', 'prepared'],
    ['not_acknowledged (not_sent)', 'not_sent'],
    ['not_create (update intent)', 'update'],
    ['target_not_listed', 'unlisted'],
    ['source_unbound (NULL digest)', 'unbound'],
  ])('selector counter-example %s: never written, never read beyond the ledger, nothing traced in a batch', async (_name, mode) => {
    await compose()
    const stores = pluginStores()
    // A listed slot-1 target first (the list must name a real target_ref for "unlisted" to mean something).
    await draft(boundInput(1))
    const listed = world!.targetRef
    const identity = { tenantId: TENANT, workspaceId: null, ownerId: OWNER, operationId: `synthetic-operation-${mode}`,
      rowKey: `synthetic-row-${mode}`, targetRef: mode === 'unlisted' ? randomUUID() : listed, targetRevision: 'synthetic-target-revision',
      planRevision: 'synthetic-plan-revision', payloadDigest: 'a'.repeat(64), businessKeyDigest: 'b'.repeat(64),
      credentialRef: 'synthetic-credential', credentialGeneration: 1, intent: mode === 'update' ? 'update' : 'create',
      ...(mode === 'update' ? { instanceId: 'synthetic-instance-existing' } : {}),
      ...(mode === 'unbound' ? {} : { sourceRecordDigest: 'c'.repeat(64), creationIdentityDigest: 'd'.repeat(64) }) }
    const prepared = await stores.ledger.prepare(identity)
    const ledgerId = String(prepared.record.id)
    const actorOf = { tenantId: TENANT, workspaceId: null, operationId: identity.operationId, rowKey: identity.rowKey, ownerId: OWNER, actorId: OWNER }
    if (mode === 'not_sent') await stores.ledger.cancelPrepared(actorOf)
    else if (mode !== 'prepared') {
      const { claimToken } = await stores.ledger.claim(actorOf)
      if (mode === 'outcome_unknown') await stores.ledger.markUnknown({ ...actorOf, claimToken, reason: 'transport_unknown' })
      else await stores.ledger.recordAcknowledgement({ ...actorOf, claimToken, ack: { statusCode: 201,
        instanceId: mode === 'update' ? 'synthetic-instance-existing' : 'synthetic-instance' } })
    }
    wbStatements.length = 0
    const batch = await world!.runtime.issueConfirmWriteback(actor, {})
    expect(batch).toEqual({ enabled: true, results: [], next: null })
    // No row source, registry, lease, trace or sheet read for it: the write-back read the ledger page (the trace table
    // only inside that query's NOT EXISTS) and nothing else.
    expect(wbStatements.length > 0 && wbStatements.every(sql => /^SELECT \*, to_char\("integration_yida_delivery_ledger"\."created_at" AT TIME ZONE 'UTC', '[^']*'\) AS "keyset_at" FROM "integration_yida_delivery_ledger" WHERE/.test(sql))).toBe(true)
    wbStatements.length = 0
    expect(await tableRows(TRACE)).toEqual([])
    // Named explicitly, the first three conditions skip (no trace); a NULL digest is the terminal source_unbound.
    const named = await world!.runtime.issueConfirmWriteback(actor, { ledgerIds: [ledgerId] })
    const expected = mode === 'unbound' ? ['source_unbound'] : mode === 'update' ? ['skip:not_create']
      : mode === 'unlisted' ? ['skip:target_not_listed'] : ['skip:not_acknowledged']
    expect(outcomeOf(named)).toEqual(expected)
    expect((await tableRows(TRACE)).map(row => row.outcome)).toEqual(mode === 'unbound' ? ['source_unbound'] : [])
    // Named: the ledger row, its trace probe and (only for a row the first three conditions admit) its ack audit — never
    // the draft, the registry, the lease or the sheet.
    expect(wbStatements.some(sql => sql.includes(OP) || sql.includes(REGISTRY) || sql.includes(LOCK) || sql.includes('meta_records'))).toBe(false)
    expect((await cell(0)).date).toBe(null)
    expect(patches).toEqual([])
    expect([world!.fake.token, world!.fake.form]).toEqual([0, 0])
  })

  it('reconciled_existing (Y10) rows are never selected: NULL binding, never acknowledged — zero reads, zero writes', async () => {
    await compose()
    await draft(boundInput(1))
    // Y10's migration relaxes the 090 status CHECK; on this branch the private schema is relaxed the same way by hand.
    await owner.query(`ALTER TABLE ${ident(LEDGER)} DROP CONSTRAINT IF EXISTS integration_yida_delivery_ledger_status_check`)
    await owner.query(`ALTER TABLE ${ident(LEDGER)} DROP CONSTRAINT IF EXISTS integration_yida_delivery_status_shape`)
    const id = randomUUID()
    await owner.query(`INSERT INTO ${ident(LEDGER)} (id, tenant_id, workspace_id, operation_id, row_key, owner_id, target_ref, target_revision,
      plan_revision, payload_digest, business_key_digest, credential_ref, credential_generation, intent, status)
      VALUES ($1, $2, NULL, 'synthetic-reconciled-op', 'synthetic-reconciled-row', $3, $4, 'synthetic-target-revision', 'synthetic-plan-revision',
      $5, $6, 'synthetic-credential', 1, 'create', 'reconciled_existing')`, [id, TENANT, OWNER, world!.targetRef, 'e'.repeat(64), 'f'.repeat(64)])
    wbStatements.length = 0
    expect(await world!.runtime.issueConfirmWriteback(actor, {})).toEqual({ enabled: true, results: [], next: null })
    expect(wbStatements.every(sql => /^SELECT \*, to_char\("integration_yida_delivery_ledger"\."created_at" AT TIME ZONE 'UTC', '[^']*'\) AS "keyset_at" FROM "integration_yida_delivery_ledger" WHERE/.test(sql))).toBe(true)
    wbStatements.length = 0
    expect(outcomeOf(await world!.runtime.issueConfirmWriteback(actor, { ledgerIds: [id] }))).toEqual(['skip:not_acknowledged'])
    expect(wbStatements.some(sql => sql.includes(OP) || sql.includes(REGISTRY) || sql.includes(LOCK) || sql.includes('meta_records')
      || sql.includes(LEDGER_AUDIT))).toBe(false)
    expect(await tableRows(TRACE)).toEqual([])
    expect(patches).toEqual([])
  })

  it.each([
    ['unset', { INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: undefined }],
    ['false', { INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: 'false' }],
    ['TRUE', { INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: 'TRUE' }],
    ['padded', { INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: ' true' }],
    ['one', { INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: '1' }],
    ['empty target list', { INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS: '' }],
    ['malformed target list', { INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS: 'not-a-target-ref' }],
  ])('flag matrix %s: the send is acknowledged and the hook reads and writes nothing', async (name, env) => {
    await compose({ env })
    const switchOff = !name.includes('target list')
    expect(world!.runtime.issueConfirmWritebackEnabled()).toBe(!switchOff)
    const { result } = await sendOne(boundInput(0))
    expect(result.status).toBe('acknowledged')
    // Zero write-back reads or writes: the hook ran (the send settled acknowledged) and its ports issued no statement.
    expect(wbStatements).toEqual([])
    expect(await tableRows(TRACE)).toEqual([])
    expect((await cell()).date).toBe(null)
    if (switchOff) {
      await expect(world!.runtime.issueConfirmWriteback(actor, {})).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' })
    } else {
      expect(await world!.runtime.issueConfirmWriteback(actor, {})).toEqual({ enabled: true, results: [], next: null })
    }
    expect(await tableRows(TRACE)).toEqual([])
    // Nothing was retryable: no C2 signal (and the run did not fail).
    expect(world!.warnings).toEqual([])
  })

  it('D13 live re-check: an owner who lost the role-granted stock-prep code is recorded permission_revoked and nothing is patched', async () => {
    await compose({ crashHookOnce: true })
    const { grant, result } = await sendOne(boundInput(0))
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    await owner.query(`DELETE FROM role_permissions WHERE permission_code = 'stock-prep:operate'`)
    expect(outcomeOf(await world!.runtime.issueConfirmWriteback(actor, {}))).toEqual(['permission_revoked'])
    expect((await tableRows(TRACE)).map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, 'permission_revoked']])
    expect(patches).toEqual([])
    expect((await cell()).date).toBe(null)
  })

  it('retryable (B.4): while another holder (purpose small_apply) holds the sheet write lease, the write-back is retryable STOCK_PREP_PROJECT_WRITE_LOCKED — no patch, NO trace row; after release a retry writes the date once', async () => {
    await compose({ crashHookOnce: true })
    const before = await cell()
    const { grant, result } = await sendOne(boundInput(0))
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    const lock = createWriteLock({ db: createDb({ database: pluginDatabase }) }) as {
      scopeKeyFor(sheetId: string): string
      withProjectWriteLease(scopeKey: string, options: Row, fn: () => Promise<unknown>): Promise<unknown>
    }
    let busy: Result | undefined
    await lock.withProjectWriteLease(lock.scopeKeyFor(sheetId()), { purpose: 'small_apply', runId: randomUUID(), tenantId: TENANT }, async () => {
      busy = await world!.runtime.issueConfirmWriteback(actor, {})
    })
    expect(busy!.results.map(entry => [entry.ledgerId, entry.kind, entry.code])).toEqual([[ledgerId, 'retryable', 'STOCK_PREP_PROJECT_WRITE_LOCKED']])
    expect(patches).toEqual([])
    expect(await tableRows(TRACE)).toEqual([])
    // The recovery entry's caller sees its rows: a retryable row there is never the C2 log line (the one code is the
    // crashed post-ACK run's).
    expect(world!.warnings).toEqual([HOOK_FAILED])
    expect([(await cell()).date, (await cell()).version]).toEqual([null, before.version])
    // The holder released: a retry writes the date once, with one written trace; a further retry has nothing to do.
    expect(outcomeOf(await world!.runtime.issueConfirmWriteback(actor, {}))).toEqual(['written'])
    const after = await cell()
    expect([after.date, after.version]).toEqual([businessDay(await ackAt(ledgerId)), before.version + 1])
    expect(after.data[fld().warehouseConfirmation]).toBe(HUMAN_NOTE)
    expect(patches).toHaveLength(1)
    expect((await tableRows(TRACE)).map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, 'written']])
    expect((await world!.runtime.issueConfirmWriteback(actor, {})).results).toEqual([])
    expect(patches).toHaveLength(1)
    expect([world!.fake.token, world!.fake.form]).toEqual([1, 1])
  })

  it('C2 on real PostgreSQL: a post-ACK run that meets the held sheet lease is retryable WRITE_LOCKED and logs YIDA_ISSUE_CONFIRM_WRITEBACK_DEFERRED once — no patch, no trace; the recovery entry then writes the date and logs nothing more', async () => {
    await compose()
    const before = await cell()
    const lock = createWriteLock({ db: createDb({ database: pluginDatabase }) }) as {
      scopeKeyFor(sheetId: string): string
      withProjectWriteLease(scopeKey: string, options: Row, fn: () => Promise<unknown>): Promise<unknown>
    }
    let sent: Awaited<ReturnType<typeof sendOne>> | undefined
    // Another holder (purpose small_apply) holds the sheet's lease while the send is acknowledged and its post-ACK run
    // settles; the send itself never touches the lease table.
    await lock.withProjectWriteLease(lock.scopeKeyFor(sheetId()), { purpose: 'small_apply', runId: randomUUID(), tenantId: TENANT }, async () => {
      sent = await sendOne(boundInput(0))
      await warned()
    })
    const ledgerId = String(sent!.grant.ledgerId ?? sent!.result.delivery!.id)
    expect([sent!.result.status, sent!.result.reused]).toEqual(['acknowledged', false])
    const answers = await Promise.all(world!.runs)
    expect(answers.map(answer => answer.results.map(entry => [entry.ledgerId, entry.kind, entry.code]))).toEqual([[[ledgerId, 'retryable', 'STOCK_PREP_PROJECT_WRITE_LOCKED']]])
    // Exactly one fixed code: no id, no value, no count.
    expect(world!.warnings).toEqual([DEFERRED])
    expect(patches).toEqual([])
    expect(await tableRows(TRACE)).toEqual([])
    expect([(await cell()).date, (await cell()).version]).toEqual([null, before.version])
    // The holder released: the recovery entry writes the date once; it logs nothing (its caller sees the rows).
    expect(outcomeOf(await world!.runtime.issueConfirmWriteback(actor, {}))).toEqual(['written'])
    expect((await cell()).date).toBe(businessDay(await ackAt(ledgerId)))
    expect((await tableRows(TRACE)).map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, 'written']])
    expect(world!.warnings).toEqual([DEFERRED])
    expect([world!.fake.token, world!.fake.form]).toEqual([1, 1])
  })

  it('C2 on real PostgreSQL, D14: with the project-sheets switch off the post-ACK run only skips project_sheets_disabled — no log line, no trace, no patch', async () => {
    await compose({ env: { MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED: 'false' } })
    const { result } = await sendOne(boundInput(0))
    expect([result.status, result.reused]).toEqual(['acknowledged', false])
    const answers = await Promise.all(world!.runs)
    expect(answers.map(answer => outcomeOf(answer))).toEqual([['skip:project_sheets_disabled']])
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(world!.warnings).toEqual([])
    expect(await tableRows(TRACE)).toEqual([])
    expect(patches).toEqual([])
    expect((await cell()).date).toBe(null)
  })

  it('D5 a on real PostgreSQL: the send answers while its post-ACK write-back is parked; stop() waits for that in-flight run within the barrier; the stopped run writes nothing and recovery fills the date once', async () => {
    await compose()
    // Park the post-ACK run at its first sheet-lease statement (the send itself never touches the lease table).
    const parked = { ...latch(), pattern: new RegExp(`\\b${LOCK}\\b`) }
    gateOnce = parked
    const { grant, result } = await sendOne(boundInput(0), 'synthetic-submission', { settle: false })
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    expect([result.status, result.reused, result.durable]).toEqual(['acknowledged', false, true])
    await waitFor(parked)
    expect((await cell()).date).toBe(null)
    expect(await tableRows(TRACE)).toEqual([])
    let stopped = false
    const stopping = world!.stop().then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(stopped).toBe(false)
    parked.release()
    await stopping
    expect(stopped).toBe(true)
    await Promise.allSettled(world!.runs)
    // Cancelled by the stop barrier: no patch, no trace (retryable inserts none), the lease is free again. The run did
    // not finish normally, so its one log line is the failure code, never DEFERRED.
    await warned()
    expect(world!.warnings).toEqual([HOOK_FAILED])
    expect(patches).toEqual([])
    expect(await tableRows(TRACE)).toEqual([])
    expect((await cell()).date).toBe(null)
    expect((await tableRows(LOCK)).map(row => row.lease_id ?? null)).toEqual([null])
    // The next process: the owner recovery entry fills the acknowledgement audit's day once.
    const targetRef = world!.targetRef
    world = undefined
    await compose({ env: { INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS: targetRef } })
    world!.targetRef = targetRef
    expect(outcomeOf(await world!.runtime.issueConfirmWriteback(actor, {}))).toEqual(['written'])
    expect((await cell()).date).toBe(businessDay(await ackAt(ledgerId)))
    expect((await tableRows(TRACE)).map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, 'written']])
    expect(world!.fake.form).toBe(0)
  })

  it('the trace table is append-only on real PostgreSQL: UPDATE, DELETE and TRUNCATE are refused, the row stays', async () => {
    await compose()
    const { grant, result } = await sendOne(boundInput(0))
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    const before = await tableRows(TRACE)
    expect(before.map(row => row.ledger_id)).toEqual([ledgerId])
    for (const sql of [`UPDATE ${ident(TRACE)} SET outcome = 'kept_existing'`, `DELETE FROM ${ident(TRACE)}`, `TRUNCATE ${ident(TRACE)}`]) {
      const failure = await owner.query(sql).then(() => null, (error: { code?: string; message?: string }) => error)
      expect([failure?.code, failure?.message]).toEqual(['55000', 'YIDA_ISSUE_CONFIRM_WRITEBACK_IMMUTABLE'])
    }
    expect(await tableRows(TRACE)).toEqual(before)
  })

  // The sweep (owner recovery entry, batch mode) end to end on real PostgreSQL: rows that never get a trace (row values
  // unreadable → retryable; no acknowledgement audit → acknowledgement_missing) no longer hold the batch forever: one
  // page reports them, its `next` starts the following page right after them, and the pending row behind is written.
  async function seedStuck(prefix: string, count: number, targetRef: string) {
    await owner.query(`INSERT INTO ${ident(LEDGER)} (id, tenant_id, workspace_id, operation_id, row_key, owner_id, target_ref,
      target_revision, plan_revision, payload_digest, business_key_digest, credential_ref, credential_generation, intent, status,
      claim_token, claim_actor_id, ack_status_code, ack_instance_id, source_record_digest, created_at)
      SELECT $1 || lpad(i::text, 3, '0'), $2, NULL, 'synthetic-stuck-op-' || $1 || i, 'row-' || i, $3, $4, 'synthetic-rev', 'synthetic-plan',
        repeat('a', 64), md5($1 || i::text) || md5('k' || $1 || i::text), 'synthetic-credential', 1, 'create', 'acknowledged',
        repeat('c', 64), $3, 201, 'synthetic-instance-' || i, repeat('d', 64),
        timestamptz '2026-03-01T00:00:00Z' + (i * interval '1 second')
      FROM generate_series(0, $5::int - 1) AS i`, [prefix, TENANT, OWNER, targetRef, count])
    // The even rows have their acknowledgement audit (so the row source is asked, and finds no draft: retryable); the odd
    // rows have none (skip acknowledgement_missing). Neither outcome records a trace.
    await owner.query(`INSERT INTO ${ident(LEDGER_AUDIT)} (id, ledger_id, event, status)
      SELECT 'syn-stuck-audit-' || l.id, l.id, 'acknowledgement', 'acknowledged' FROM ${ident(LEDGER)} l
      WHERE l.id LIKE $1 || '%' AND right(l.id, 1) IN ('0', '2', '4', '6', '8')`, [prefix])
  }
  const cursorText = (shape: Row) => Buffer.from(JSON.stringify(shape), 'utf8').toString('base64url')

  it('the sweep gets past a stuck front on real PostgreSQL: 100 rows that stay retryable or acknowledgement_missing, the pending row behind them is written by following next', async () => {
    await compose({ crashHookOnce: true })
    const { grant, result } = await sendOne(boundInput(0))
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    expect(await tableRows(TRACE)).toEqual([])
    await seedStuck('syn-stuck-', 100, world!.targetRef)
    const front = Array.from({ length: 100 }, (_, i) => `syn-stuck-${String(i).padStart(3, '0')}`)
    // Without the cursor, every page is the same stuck front (nothing of it is traced) and the pending row is not reached.
    for (let again = 0; again < 2; again++) {
      const page = await world!.runtime.issueConfirmWriteback(actor, {})
      expect(page.results.map(entry => entry.ledgerId)).toEqual(front)
      expect(page.results.filter(entry => entry.kind === 'retryable')).toHaveLength(50)
      expect(page.results.filter(entry => entry.kind === 'skip' && entry.reason === 'acknowledgement_missing')).toHaveLength(50)
      expect(typeof page.next).toBe('string')
    }
    expect(patches).toEqual([])
    expect(await tableRows(TRACE)).toEqual([])
    // Following next: the very next page writes it, and the sweep is exhausted.
    const first = await world!.runtime.issueConfirmWriteback(actor, {})
    const second = await world!.runtime.issueConfirmWriteback(actor, { after: first.next })
    expect(second.results.map(entry => [entry.ledgerId, entry.outcome])).toEqual([[ledgerId, 'written']])
    expect(second.next).toBeNull()
    expect((await cell()).date).toBe(businessDay(await ackAt(ledgerId)))
    expect((await tableRows(TRACE)).map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, 'written']])
    // A retryable row gets another try only on a LATER sweep from the start: the same front, and (the written row now
    // traced, exactly `limit` candidates left in the one listed target) that sweep is exhausted on its first page.
    const again = await world!.runtime.issueConfirmWriteback(actor, {})
    expect([again.results.map(entry => entry.ledgerId), again.next]).toEqual([front, null])
    // Through the real runtime a cursor the core refuses is INPUT (the route's 400), before the plugin reads anything.
    const decoded = JSON.parse(Buffer.from(String(first.next), 'base64url').toString('utf8')) as Row
    expect(Object.keys(decoded)).toEqual(['v', 's', 't', 'c', 'i'])
    expect([decoded.v, decoded.t, decoded.i]).toEqual([2, world!.targetRef, 'syn-stuck-099'])
    expect(decoded.s).toMatch(/^[0-9a-f]{32}$/)
    expect(decoded.c).toBe('2026-03-01T00:01:39.000000Z')
    // Year 0000 (refuter finding [0]): a JS Date round trip accepts it, PostgreSQL's timestamptz does not (22008). It is
    // the closed INPUT refusal (the route's 400) with ZERO write-back statements, never a database error (503).
    wbStatements.length = 0
    for (const c of ['0000-01-01T00:00:00.000000Z', '0000-12-31T23:59:59.999999Z']) {
      await expect(world!.runtime.issueConfirmWriteback(actor, { after: cursorText({ ...decoded, c }) })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    }
    expect(wbStatements).toEqual([])
    for (const after of [cursorText({ ...decoded, v: 3 }), cursorText({ v: 1, t: decoded.t, c: decoded.c, i: decoded.i }),
      cursorText({ ...decoded, t: randomUUID() }), cursorText({ ...decoded, o: 'synthetic-other' }),
      String(first.next).slice(0, -2), `${String(first.next)}A`]) {
      await expect(world!.runtime.issueConfirmWriteback(actor, { after })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    }
    await expect(world!.runtime.issueConfirmWriteback(actor, { ledgerIds: [ledgerId], after: String(first.next) }))
      .rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    expect(wbStatements).toEqual([])
  })

  it('a traced row is never re-patched on real PostgreSQL, limit path and ledgerIds path: its cell emptied again, zero patches, version unchanged', async () => {
    await compose()
    const { grant, result } = await sendOne(boundInput(0))
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    expect((await tableRows(TRACE)).map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, 'written']])
    // Only the trace now stands between the row and a patch: the date is removed again (privileged fixture edit).
    await owner.query('UPDATE public.meta_records SET data = data - $1::text WHERE id = $2', [fld().issueConfirmDate, recordId(0)])
    const before = await cell()
    expect(before.date).toBe(null)
    patches.length = 0
    expect(await world!.runtime.issueConfirmWriteback(actor, {})).toEqual({ enabled: true, results: [], next: null })
    expect(await world!.runtime.issueConfirmWriteback(actor, { limit: 1 })).toEqual({ enabled: true, results: [], next: null })
    expect(await world!.runtime.issueConfirmWriteback(actor, { ledgerIds: [ledgerId] })).toEqual({ enabled: true, results: [] })
    expect(patches).toEqual([])
    const after = await cell()
    expect([after.version, after.date]).toEqual([before.version, null])
    expect(await tableRows(TRACE)).toHaveLength(1)
  })

  // The trace race (Y9 r3, refuter finding [1]): a run that read the row as untraced before another run traced it.
  it.each([['limit path', 'limit'], ['ledgerIds path', 'named']])('the trace race on real PostgreSQL (%s): B read the row before A traced it; A writes and traces; the cell is emptied; B leases after A released — the re-check under the lease stops B, no second patch', async (_name, mode) => {
    await compose({ crashHookOnce: true })
    const before = await cell()
    const { grant, result } = await sendOne(boundInput(0))
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    expect(await tableRows(TRACE)).toEqual([])
    const input = mode === 'limit' ? {} : { ledgerIds: [ledgerId] }
    // Run B is parked at its first sheet-lease statement, after it read the row as untraced ...
    const parked = { ...latch(), pattern: new RegExp(`\\b${LOCK}\\b`) }
    gateOnce = parked
    const second = world!.runtime.issueConfirmWriteback(actor, input)
    await waitFor(parked)
    // ... while run A decides the same row completely: patch, trace, release.
    expect(outcomeOf(await world!.runtime.issueConfirmWriteback(actor, input))).toEqual(['written'])
    const written = await cell()
    expect([written.date, written.version]).toEqual([businessDay(await ackAt(ledgerId)), before.version + 1])
    // The cell is emptied without a version bump (an unversioned plugin patch; privileged fixture edit).
    await owner.query('UPDATE public.meta_records SET data = data - $1::text WHERE id = $2', [fld().issueConfirmDate, recordId(0)])
    parked.release()
    const secondRun = await second
    expect(patches).toHaveLength(1)
    expect(secondRun.results).toEqual([{ ledgerId, kind: 'skip', reason: 'already_traced' }])
    const after = await cell()
    expect([after.date, after.version]).toEqual([null, before.version + 1])
    expect((await tableRows(TRACE)).map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, 'written']])
    expect([world!.fake.token, world!.fake.form]).toEqual([1, 1])
  })

  it('trace before release on real PostgreSQL: while A\'s trace INSERT is in flight A still holds the sheet lease — a run that read the row then is STOCK_PREP_PROJECT_WRITE_LOCKED and patches nothing, even with the cell emptied', async () => {
    await compose({ crashHookOnce: true })
    const before = await cell()
    const { grant, result } = await sendOne(boundInput(0))
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    // Run A is parked at its trace INSERT, after its patch committed.
    const parked = { ...latch(), pattern: new RegExp(`^INSERT INTO "${TRACE}"`) }
    gateOnce = parked
    const first = world!.runtime.issueConfirmWriteback(actor, {})
    await waitFor(parked)
    expect(patches).toHaveLength(1)
    expect((await tableRows(LOCK)).map(row => row.lease_id !== null && row.lease_id !== undefined)).toEqual([true])
    await owner.query('UPDATE public.meta_records SET data = data - $1::text WHERE id = $2', [fld().issueConfirmDate, recordId(0)])
    // Run B reads the row as untraced (A's trace is not written yet) and meets A's live lease.
    const busy = await world!.runtime.issueConfirmWriteback(actor, {})
    expect(patches).toHaveLength(1)
    expect(busy.results).toEqual([{ ledgerId, kind: 'retryable', code: 'STOCK_PREP_PROJECT_WRITE_LOCKED' }])
    parked.release()
    expect(outcomeOf(await first)).toEqual(['written'])
    expect((await tableRows(TRACE)).map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, 'written']])
    expect((await tableRows(LOCK)).map(row => row.lease_id ?? null)).toEqual([null])
    // Traced now: the next run selects nothing, and the emptied cell stays empty.
    expect((await world!.runtime.issueConfirmWriteback(actor, {})).results).toEqual([])
    expect(patches).toHaveLength(1)
    const after = await cell()
    expect([after.date, after.version]).toEqual([null, before.version + 1])
  })

  // Round-3 refuter F2: the same pin for outcomes that are NOT `written`, at both under-lease decision points — the
  // authority step (permission_revoked) and the records step (already_set). While A is parked at that trace INSERT the
  // fact flips (the permission granted again / the cell emptied), so a run that held the lease then would patch.
  it.each([['permission_revoked'], ['already_set']])('trace before release on real PostgreSQL (%s): while A\'s trace INSERT of a non-written outcome is in flight A still holds the sheet lease — a run that read the row then is STOCK_PREP_PROJECT_WRITE_LOCKED and patches nothing, though the fact has flipped', async (outcome) => {
    await compose({ crashHookOnce: true })
    const { grant, result } = await sendOne(boundInput(0))
    const ledgerId = String(grant.ledgerId ?? result.delivery!.id)
    if (outcome === 'permission_revoked') {
      await owner.query(`DELETE FROM role_permissions WHERE permission_code = 'stock-prep:operate'`)
    } else {
      // The acknowledgement day is already in the cell (privileged fixture edit): A decides already_set, no patch.
      await owner.query('UPDATE public.meta_records SET data = jsonb_set(data, ARRAY[$1::text], to_jsonb($2::text)) WHERE id = $3',
        [fld().issueConfirmDate, businessDay(await ackAt(ledgerId)), recordId(0)])
    }
    const before = await cell()
    // Run A is parked at its trace INSERT, decided under its lease.
    const parked = { ...latch(), pattern: new RegExp(`^INSERT INTO "${TRACE}"`) }
    gateOnce = parked
    const first = world!.runtime.issueConfirmWriteback(actor, {})
    await waitFor(parked)
    expect((await tableRows(LOCK)).map(row => row.lease_id !== null && row.lease_id !== undefined)).toEqual([true])
    // The fact flips while A is parked.
    if (outcome === 'permission_revoked') {
      await owner.query(`INSERT INTO role_permissions VALUES ('integration_admin','stock-prep:operate')`)
    } else {
      await owner.query('UPDATE public.meta_records SET data = data - $1::text WHERE id = $2', [fld().issueConfirmDate, recordId(0)])
    }
    // Run B reads the row as untraced (A's trace is not written yet) and meets A's live lease.
    const busy = await world!.runtime.issueConfirmWriteback(actor, {})
    expect(busy.results).toEqual([{ ledgerId, kind: 'retryable', code: 'STOCK_PREP_PROJECT_WRITE_LOCKED' }])
    expect(patches).toEqual([])
    parked.release()
    expect(outcomeOf(await first)).toEqual([outcome])
    expect((await tableRows(TRACE)).map(row => [row.ledger_id, row.outcome])).toEqual([[ledgerId, outcome]])
    expect((await tableRows(LOCK)).map(row => row.lease_id ?? null)).toEqual([null])
    // Traced now: the next run selects nothing, and the row is never patched.
    expect((await world!.runtime.issueConfirmWriteback(actor, {})).results).toEqual([])
    expect(patches).toEqual([])
    const after = await cell()
    expect([after.date, after.version]).toEqual([null, before.version])
    expect([world!.fake.token, world!.fake.form]).toEqual([1, 1])
  })

  it('target-set stability on real PostgreSQL: a cursor issued under another listed set (added, removed — another or its own target — reordered) is YIDA_ISSUE_CONFIRM_CURSOR_STALE with zero write-back statements; a fresh sweep then answers every row once', async () => {
    await compose()
    await draft(boundInput(1))
    const t1 = world!.targetRef, t2 = randomUUID(), t3 = randomUUID()
    const seeded = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)
    await seedStuck('syn-st-a-', 3, t1)
    await seedStuck('syn-st-b-', 2, t2)
    await seedStuck('syn-st-c-', 2, t3)
    const of: Record<string, string[]> = { [t1]: seeded('syn-st-a-', 3), [t2]: seeded('syn-st-b-', 2), [t3]: seeded('syn-st-c-', 2) }
    async function sweepIds() {
      const seen: string[] = []
      let after: string | undefined
      for (let guard = 0; guard < 50; guard++) {
        const page = await world!.runtime.issueConfirmWriteback(actor, { limit: 2, ...(after === undefined ? {} : { after }) })
        seen.push(...page.results.map(entry => String(entry.ledgerId)))
        if (page.next === null) return seen
        after = String(page.next)
      }
      throw new Error('SYNTHETIC_SWEEP_DID_NOT_TERMINATE')
    }
    for (const [name, changed] of [['added', [t1, t2, t3]], ['removed (another target)', [t1]], ['removed (its own target)', [t2]],
      ['reordered', [t2, t1]]] as Array<[string, string[]]>) {
      world!.env.INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS = [t1, t2].join(',')
      const first = await world!.runtime.issueConfirmWriteback(actor, { limit: 2 })
      expect(first.results.map(entry => entry.ledgerId), name).toEqual(of[t1].slice(0, 2))
      expect(typeof first.next).toBe('string')
      world!.env.INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS = changed.join(',')
      wbStatements.length = 0
      await expect(world!.runtime.issueConfirmWriteback(actor, { limit: 2, after: first.next })).rejects
        .toMatchObject({ code: 'YIDA_ISSUE_CONFIRM_CURSOR_STALE' })
      expect(wbStatements, name).toEqual([])
      expect(await sweepIds(), name).toEqual(changed.flatMap(targetRef => of[targetRef]))
    }
    // The control: the set unchanged, the cursor goes on (and a forged cursor with the current digest on an unlisted
    // target is the 400, not the 409).
    world!.env.INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS = [t1, t2].join(',')
    const first = await world!.runtime.issueConfirmWriteback(actor, { limit: 2 })
    const rest = await world!.runtime.issueConfirmWriteback(actor, { limit: 2, after: first.next })
    expect(rest.results.map(entry => entry.ledgerId)).toEqual([of[t1][2], of[t2][0]])
    const decoded = JSON.parse(Buffer.from(String(first.next), 'base64url').toString('utf8')) as Row
    await expect(world!.runtime.issueConfirmWriteback(actor, { after: cursorText({ ...decoded, t: t3 }) })).rejects
      .toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    expect(await tableRows(TRACE)).toEqual([])
    expect(patches).toEqual([])
  })

  // The recovery scan's progress on real PostgreSQL (Codex, Y9 review): traced and unbound rows are excluded by the
  // ledger query itself (createDb.selectUnmatched — IS NOT NULL + NOT EXISTS on the trace table, before ORDER BY /
  // LIMIT), so however many of them a target holds, the next pending row is in the very next batch.
  describe('ledger reader progress (SQL judged by PostgreSQL)', () => {
    const SCAN_TARGET = 'synthetic-scan-target', OTHER_SCAN_TARGET = 'synthetic-scan-target-b'
    // `count` acknowledged CREATE rows in ONE statement, one second apart from `from`. NULL digest (unbound): every row
    // when unboundModulo < 0, the rows with i % unboundModulo = 3 when it is > 0, none when it is 0.
    async function seedLedger(prefix: string, count: number, options: { target?: string; from?: number; unboundModulo?: number } = {}) {
      await owner.query(`INSERT INTO ${ident(LEDGER)} (id, tenant_id, workspace_id, operation_id, row_key, owner_id, target_ref,
        target_revision, plan_revision, payload_digest, business_key_digest, credential_ref, credential_generation, intent, status,
        claim_token, claim_actor_id, ack_status_code, ack_instance_id, source_record_digest, created_at)
        SELECT $1 || lpad(i::text, 5, '0'), $2, NULL, 'synthetic-scan-op-' || $1, 'row-' || i, $3, $4, 'synthetic-rev', 'synthetic-plan',
          repeat('a', 64), md5($1 || i::text) || md5('k' || $1 || i::text), 'synthetic-credential', 1, 'create', 'acknowledged',
          repeat('c', 64), $3, 201, 'synthetic-instance-' || i,
          CASE WHEN $5::int < 0 OR ($5::int > 0 AND i % $5::int = 3) THEN NULL ELSE repeat('d', 64) END,
          timestamptz '2026-03-01T00:00:00Z' + (($6::int + i) * interval '1 second')
        FROM generate_series(0, $7::int - 1) AS i`,
      [prefix, TENANT, OWNER, options.target ?? SCAN_TARGET, options.unboundModulo ?? 0, options.from ?? 0, count])
    }
    // Trace rows (non-dated outcome) for the given ledger ids, exactly the columns the write-back records.
    async function seedTrace(ids: string[]) {
      await owner.query(`INSERT INTO ${ident(TRACE)} (ledger_id, tenant_id, owner_id, target_ref, sheet_id, outcome)
        SELECT l.id, l.tenant_id, l.owner_id, l.target_ref, NULL, 'project_absent' FROM ${ident(LEDGER)} l WHERE l.id = ANY($1::text[])`, [ids])
    }
    const ids = (prefix: string, from: number, to: number) => Array.from({ length: to - from }, (_, i) => `${prefix}${String(from + i).padStart(5, '0')}`)
    type SweepRow = { id: string; sourceRecordDigest: string | null }
    let createReader: (options: Row) => { list(input: Row): Promise<SweepRow[]>
      sweep(input: Row): Promise<{ rows: SweepRow[]; next: { targetRef: string; at: string; id: string } | null }> }
    beforeAll(async () => {
      createReader = (await importNative(pathToFileURL(path.join(root, 'plugins/plugin-integration-core/lib/yida-issue-confirm-writeback-ports.mjs')).href))
        .createIssueConfirmLedgerReader
    })
    const batch = async (targetRefs: string[], limit = 100) => (await createReader({ db: createDb({ database: pluginDatabaseOf('wb') }) })
      .sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs, after: null, limit })).rows

    it('2001 acknowledged rows, the oldest 2000 traced: every run returns the last one, in ONE anti-join ledger query', async () => {
      await seedLedger('syn-scan-', 2001)
      await seedTrace(ids('syn-scan-', 0, 2000))
      for (let run = 0; run < 3; run++) {
        wbStatements.length = 0
        expect((await batch([SCAN_TARGET])).map(row => row.id)).toEqual(['syn-scan-02000'])
        expect(wbStatements.filter(sql => sql.includes(`"${LEDGER}"`))).toHaveLength(1)
        expect(wbStatements[0]).toMatch(/^SELECT \*, to_char\("integration_yida_delivery_ledger"\."created_at" AT TIME ZONE 'UTC', '[^']*'\) AS "keyset_at" FROM "integration_yida_delivery_ledger" WHERE .* AND "source_record_digest" IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM "integration_yida_issue_confirm_writeback" WHERE "integration_yida_issue_confirm_writeback"\."ledger_id" = "integration_yida_delivery_ledger"\."id"\) ORDER BY "integration_yida_delivery_ledger"\."created_at" ASC, "integration_yida_delivery_ledger"\."id" ASC LIMIT 101 OFFSET 0$/)
      }
      // Named, the same row is read directly (the ledgerIds path is unchanged); a named traced row is omitted.
      const named = await createReader({ db: createDb({ database: pluginDatabaseOf('wb') }) }).list({ tenantId: TENANT, ownerId: OWNER,
        targetRefs: [SCAN_TARGET], ledgerIds: ['syn-scan-00000', 'syn-scan-02000'], limit: 100 })
      expect(named.map(row => row.id)).toEqual(['syn-scan-02000'])
    })

    it('2000 unbound acknowledged rows then ONE bound row: the bound row is returned', async () => {
      await seedLedger('syn-unb-', 2000, { unboundModulo: -1 })
      expect(Number((await owner.query(`SELECT count(*) AS n FROM ${ident(LEDGER)} WHERE source_record_digest IS NULL`)).rows[0].n)).toBe(2000)
      await seedLedger('syn-bnd-', 1, { from: 5000 })
      expect((await batch([SCAN_TARGET])).map(row => [row.id, row.sourceRecordDigest])).toEqual([['syn-bnd-00000', 'd'.repeat(64)]])
    })

    it('order and limit hold across a mix on PostgreSQL: listed targets in turn, oldest first, at most `limit`', async () => {
      await seedLedger('syn-mix-', 2400, { unboundModulo: 7 })
      const bound = (await owner.query(`SELECT id FROM ${ident(LEDGER)} WHERE id LIKE 'syn-mix-%' AND source_record_digest IS NOT NULL
        ORDER BY created_at`)).rows.map(row => String(row.id))
      expect(bound).toHaveLength(2400 - 343)
      await seedTrace(bound.slice(0, 1990))
      await seedLedger('syn-mxb-', 3, { target: OTHER_SCAN_TARGET, from: 9000 })
      const pending = bound.slice(1990)
      expect((await batch([SCAN_TARGET, OTHER_SCAN_TARGET])).map(row => row.id)).toEqual([...pending, ...ids('syn-mxb-', 0, 3)])
      expect((await batch([SCAN_TARGET, OTHER_SCAN_TARGET], pending.length + 1)).map(row => row.id)).toEqual([...pending, 'syn-mxb-00000'])
      expect((await batch([OTHER_SCAN_TARGET, SCAN_TARGET], 4)).map(row => row.id)).toEqual([...ids('syn-mxb-', 0, 3), pending[0]])
    })

    // Follow `next` from the start until it is null (guarded); the pages in order.
    const sweepOf = (targetRefs: string[], limit: number, after: Row | null = null) => createReader({ db: createDb({ database: pluginDatabaseOf('wb') }) })
      .sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs, after, limit })
    async function follow(targetRefs: string[], limit: number) {
      const pages: Array<Awaited<ReturnType<typeof sweepOf>>> = []
      let after: Row | null = null
      for (let guard = 0; guard < 200; guard++) {
        const page = await sweepOf(targetRefs, limit, after)
        pages.push(page)
        if (page.next === null) return pages
        after = page.next
      }
      throw new Error('SYNTHETIC_SWEEP_DID_NOT_TERMINATE')
    }

    it('sub-millisecond and equal created_at on PostgreSQL: following next pages every row exactly once, in the database\'s (created_at, id) order', async () => {
      // 12 rows inside ONE millisecond: 4 instants one microsecond apart, 3 ids on each (ties), ids inserted out of order.
      await owner.query(`INSERT INTO ${ident(LEDGER)} (id, tenant_id, workspace_id, operation_id, row_key, owner_id, target_ref,
        target_revision, plan_revision, payload_digest, business_key_digest, credential_ref, credential_generation, intent, status,
        claim_token, claim_actor_id, ack_status_code, ack_instance_id, source_record_digest, created_at)
        SELECT 'syn-us-' || lpad(((i * 7) % 12)::text, 2, '0'), $1, NULL, 'synthetic-us-op', 'row-' || i, $2, $3, 'synthetic-rev', 'synthetic-plan',
          repeat('a', 64), md5('us' || i::text) || md5('kus' || i::text), 'synthetic-credential', 1, 'create', 'acknowledged',
          repeat('c', 64), $2, 201, 'synthetic-instance-' || i, repeat('d', 64),
          timestamptz '2026-03-01T00:00:00.123Z' + ((i % 4) * interval '1 microsecond')
        FROM generate_series(0, 11) AS i`, [TENANT, OWNER, SCAN_TARGET])
      const truth = (await owner.query(`SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM ${ident(LEDGER)} WHERE id LIKE 'syn-us-%' ORDER BY created_at, id`)).rows.map(row => [String(row.id), String(row.at)])
      expect(new Set(truth.map(([, at]) => at))).toEqual(new Set(['2026-03-01T00:00:00.123000Z', '2026-03-01T00:00:00.123001Z',
        '2026-03-01T00:00:00.123002Z', '2026-03-01T00:00:00.123003Z']))
      for (const limit of [1, 2, 5, 12]) {
        const pages = await follow([SCAN_TARGET], limit)
        expect(pages.flatMap(page => page.rows.map(row => row.id)), `limit ${limit}`).toEqual(truth.map(([id]) => id))
        // Each cursor is its page's last row with the database's exact microsecond text.
        for (const page of pages.filter(entry => entry.next !== null)) {
          const last = page.rows[page.rows.length - 1].id
          expect([page.next!.id, page.next!.at]).toEqual(truth.find(([id]) => id === last))
        }
      }
    })

    it('per-target guard on PostgreSQL: a first target holding exactly `limit` costs ONE ledger statement; its cursor then moves on to the next target', async () => {
      await seedLedger('syn-pt-', 100)
      await seedLedger('syn-pu-', 2, { target: OTHER_SCAN_TARGET, from: 50 })
      wbStatements.length = 0
      const first = await sweepOf([SCAN_TARGET, OTHER_SCAN_TARGET], 100)
      expect(first.rows.map(row => row.id)).toEqual(ids('syn-pt-', 0, 100))
      expect(wbStatements.filter(sql => sql.includes(`"${LEDGER}"`))).toHaveLength(1)
      expect([first.next?.targetRef, first.next?.id]).toEqual([SCAN_TARGET, 'syn-pt-00099'])
      wbStatements.length = 0
      const second = await sweepOf([SCAN_TARGET, OTHER_SCAN_TARGET], 100, first.next)
      expect([second.rows.map(row => row.id), second.next]).toEqual([ids('syn-pu-', 0, 2), null])
      expect(wbStatements.filter(sql => sql.includes(`"${LEDGER}"`))).toHaveLength(2)
      // Exhaustion, the converse (option 1): exactly `limit` at the end of a NON-last target whose later targets are empty
      // gives a cursor after ONE statement, then one empty page with next null (one statement per remaining target).
      const empties = [SCAN_TARGET, 'synthetic-scan-target-empty-1', 'synthetic-scan-target-empty-2']
      wbStatements.length = 0
      const filled = await sweepOf(empties, 100)
      expect([filled.rows.length, filled.next?.id]).toEqual([100, 'syn-pt-00099'])
      expect(wbStatements.filter(sql => sql.includes(`"${LEDGER}"`))).toHaveLength(1)
      wbStatements.length = 0
      const tail = await sweepOf(empties, 100, filled.next)
      expect([tail.rows, tail.next]).toEqual([[], null])
      expect(wbStatements.filter(sql => sql.includes(`"${LEDGER}"`))).toHaveLength(3)
      // More than `limit` in the first target: still one statement (the look-ahead row says the target goes on).
      await seedLedger('syn-pt-x-', 1, { from: 4000 })
      wbStatements.length = 0
      const over = await sweepOf([SCAN_TARGET, OTHER_SCAN_TARGET], 100)
      expect(over.rows).toHaveLength(100)
      expect(wbStatements.filter(sql => sql.includes(`"${LEDGER}"`))).toHaveLength(1)
    })

    it('exhaustion on PostgreSQL: next null means no candidate remains — at every limit the pages up to the first null hold every candidate, every page before it is full', async () => {
      await seedLedger('syn-ex-a-', 4)
      await seedLedger('syn-ex-c-', 3, { target: OTHER_SCAN_TARGET })
      // Target sizes 4, 0, 3, 0: pages fill at every kind of boundary, empty targets in the middle and at the end.
      const targets = [SCAN_TARGET, 'synthetic-scan-target-empty-1', OTHER_SCAN_TARGET, 'synthetic-scan-target-empty-2']
      const truth = (await owner.query(`SELECT id FROM ${ident(LEDGER)} WHERE id LIKE 'syn-ex-%'
        ORDER BY CASE target_ref WHEN $1 THEN 0 ELSE 1 END, created_at, id`, [SCAN_TARGET])).rows.map(row => String(row.id))
      expect(truth).toEqual([...ids('syn-ex-a-', 0, 4), ...ids('syn-ex-c-', 0, 3)])
      for (const limit of [1, 2, 3, 4, 5, 7, 8]) {
        const pages = await follow(targets, limit)
        expect(pages.flatMap(page => page.rows.map(row => row.id)), `limit ${limit}`).toEqual(truth)
        expect(pages.map(page => page.next === null), `limit ${limit}`).toEqual(pages.map((_, index) => index === pages.length - 1))
        expect(pages.slice(0, -1).every(page => page.rows.length === limit), `limit ${limit}`).toBe(true)
      }
    })
  })
})

// External-system delete × pointer write — the LOCK PROTOCOL against real PostgreSQL.
//
// Owner review of #5923 (docs/development/autonomous-run-20260921-outcome.md "Q2/#5923（订正）"):
// `deleteExternalSystem` counted the pointer tables and then deleted, in two autocommit statements
// with no row lock in between, so a pointer committed between count and DELETE dangled — and the
// pointer tables (079 / 062 / 073) deliberately carry no foreign key. "Making the delete
// transactional is not enough; the writers must participate in a lock protocol."
//
// This file drives the REAL plugin modules (`lib/db.cjs`, `lib/external-systems.cjs`, the 079 / 062
// stores, `lib/pipelines.cjs`) through the host's own database seam (a `{ query, transaction }`
// adapter over a dedicated pg client per session, the shape `packages/core-backend/src/index.ts`
// hands plugins) against the REAL migrations, in an isolated schema, with TWO SESSIONS competing:
//
//   NEC      necessity: the unlocked count-then-delete shape (raw SQL, what #5923 shipped) DOES
//            dangle on this schema — the hole is real, not argued
//   P-079-A  delete counted zero, then a stock-prep bind starts → the bind WAITS on the FOR UPDATE
//            (pg_stat_activity wait_event_type = 'Lock'), resumes after COMMIT, refuses 409
//            SOURCE_BINDING_SOURCE_NOT_LIVE; zero pointer rows
//   P-079-B  bind holds KEY SHARE, then the delete starts → the delete WAITS, resumes, counts the
//            bind, refuses 409 ExternalSystemConflictError; system and bind both kept
//   P-079-C  same as A for a REBIND (update path): the old binding keeps pointing at the live system
//   P-062-A/B the read-source config mint, both interleavings
//   P-PIPE-A/B the pipeline endpoint check, both interleavings (source endpoint)
//   P-MIX    a bind and a pipeline write hold KEY SHARE on the same system concurrently (KEY SHARE is
//            compatible with KEY SHARE: neither waits), the delete waits for both, then refuses with
//            BOTH counted — and no 40P01 deadlock anywhere
//   R-073    the REGISTERED RESIDUAL: sealed-export provisioning (frozen S6-A module, provisioning
//            role with no privilege on integration_external_systems) takes no lock and DANGLES —
//            asserted so fixing it must retire this arm with the design doc's residual entry
//   P-ABSENT a schema that ran ONLY 057 (no 079 / 062 / 073): the delete still goes through, because
//            the absence is learned by the autocommit probe BEFORE the transaction. A mutant that
//            counts the missing tables inside the FOR UPDATE transaction (external-systems.cjs
//            `if (absentTables.has(table)) return 0` → `if (false) return 0`) fails this arm with
//            25P02 and leaves the row — the 42P01 aborts the transaction (design doc §2.3 / §7.2)
//   P-062-REUSE-A/B the REGISTERED reuse-path outcomes of saveVersion: identical content that already
//            exists as a RETIRED version at a since-deleted system → ReadSourceConfigConflictError
//            content_retired with ZERO `FOR KEY SHARE` statements (the reuse lookup runs before the
//            lock); a pre-protocol LIVE row at a system that does not exist → reused, reuse_version
//            audit, again no lock. New content at the same missing system → the lock's not_found
//            tuple. Registered so the guarantee stays scoped to the MINT path (design doc §2.6)
//   I-RR-* / I-SER-*  THE ISOLATION PIN (#6076 third-round independent verification). Every protocol
//            participant — delete, 079 bind, 062 mint, pipeline upsert, TEMPLATE instantiation — in
//            BOTH interleavings, driven through a second and third pair of sessions whose
//            `default_transaction_isolation` is 'repeatable read' / 'serializable' (SET SESSION on the
//            connection — a bare BEGIN there inherits it, which the I-*-SENTINEL arms prove first).
//            Before the pin, the writer-first interleaving DANGLED at repeatable read: the delete's
//            FOR UPDATE waited correctly, but its statement had taken the transaction snapshot BEFORE
//            the wait, so the counts after it could not see the pointer. Each arm asserts no dangle,
//            the refusal in the path's own shape (never a bare 40001), `transaction_isolation` =
//            'read committed' observed INSIDE the parked transaction, and that the statement right
//            after every BEGIN is `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`. The same arms
//            (and every arm above) are what an `ALTER DATABASE ... SET default_transaction_isolation
//            = 'repeatable read'` run exercises: on that database the whole file runs at a hostile
//            default (verification record: design doc §7.5).
//
// PLUGIN ROOT OVERRIDE (test-only, documented in the design doc): the modules are loaded from
// `EXTERNAL_SYSTEM_LOCK_PROTOCOL_PLUGIN_ROOT` when set, else from this repository. That is how the
// verification record shows the same scenarios RED against an origin/main copy of the plugin
// ("old red") and against single-lock-removed mutant copies, without touching the working tree.
//
// Values-free: assertions are over SQLSTATEs, error names/codes, wait states and counts. No system
// row value is read into an assertion.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const PLUGIN_ROOT = process.env.EXTERNAL_SYSTEM_LOCK_PROTOCOL_PLUGIN_ROOT
  ? path.resolve(process.env.EXTERNAL_SYSTEM_LOCK_PROTOCOL_PLUGIN_ROOT)
  : path.join(repoRoot, 'plugins', 'plugin-integration-core')
const PLUGIN_LIB = path.join(PLUGIN_ROOT, 'lib')

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Anti-skip-green sentinel — deliberately OUTSIDE `describeIfDatabase`. Inside it, the sentinel
// would be skipped together with every other case exactly when DATABASE_URL is missing, so it could
// never fire (that was the shape as first shipped). Lanes that export EXPECT_DB=1 (the real-DB step
// this suite is written for) must be RED when DATABASE_URL is missing; the default no-DB job, which
// does not set EXPECT_DB, skips it visibly. Same shape as approval-can-decide-current-node.db.test.ts.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const MIGRATIONS = [
  '057_create_integration_core_tables.sql',
  // 061: integration_templates — the I-*-TPL arms instantiate a template (the pipeline writer whose
  // transaction READS its name clash before the KEY SHARE, so it must pin the level itself).
  '061_create_integration_templates.sql',
  '062_create_integration_read_source_configs.sql',
  '068_create_integration_sealed_export_ingestion.sql',
  '069_create_integration_sealed_export_generation_kernel.sql',
  '070_create_integration_sealed_export_signer_authority.sql',
  '071_harden_integration_sealed_export_authority_lifecycle.sql',
  '072_harden_integration_sealed_export_terminal_signer_history.sql',
  '073_create_sealed_export_stock_prep_runtime_authority.sql',
  '079_create_integration_stock_prep_source_binding.sql',
]

const EXTERNAL_SYSTEMS = 'integration_external_systems'
const STOCK_PREP_BINDINGS = 'integration_stock_prep_source_binding'
const READ_SOURCE_CONFIGS = 'integration_read_source_configs'
const READ_SOURCE_AUDIT = 'integration_read_source_config_audit'
const PIPELINES = 'integration_pipelines'
const SEALED_EXPORT_BINDINGS = 'integration_sealed_export_stock_prep_bindings'
const TEMPLATES = 'integration_templates'
const PIN_STATEMENT = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
// The hostile server defaults the I-* arms run under, set per CONNECTION with SET SESSION (a value
// from this fixed table only — never interpolated from elsewhere).
const HOSTILE_DEFAULTS = [
  { tag: 'RR', level: 'repeatable read' },
  { tag: 'SER', level: 'serializable' },
] as const
type HostileLevel = (typeof HOSTILE_DEFAULTS)[number]['level']
const ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const NOW = Date.parse('2026-07-31T00:00:00Z')

type QueryRows = Record<string, unknown>[]
type Gate = { reached: Promise<void>; release: () => void }
type Session = {
  client: PoolClient
  pid: number
  database: {
    query: (sql: string, params?: unknown[]) => Promise<QueryRows>
    transaction: <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<QueryRows>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>) => Promise<T>
  }
  gateBefore: (sqlPrefix: string) => Gate
  // Every statement text this session issued through the plugin seam, in order (shape only: the
  // parameters are not recorded). Lets an arm assert "no FOR KEY SHARE was issued on this path".
  statements: string[]
  db: any
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function settle<T>(promise: Promise<T>): Promise<{ value: T | null; error: any }> {
  return promise.then((value) => ({ value, error: null }), (error) => ({ value: null, error }))
}

function credentialStore() {
  return {
    async encrypt(value: string) { return `enc:${Buffer.from(value, 'utf8').toString('base64')}` },
    async decrypt(value: string) { return Buffer.from(value.slice(4), 'base64').toString('utf8') },
    async fingerprint(value: string) { return `fp_${Buffer.from(value).toString('hex').slice(0, 8)}` },
  }
}

function readSourceConfig(systemId = 'sys_1') {
  return {
    version: 1,
    systemId,
    requiredKind: 'erp:k3-wise-webapi',
    object: 'material',
    mode: 'single_record',
    readPath: '/K3API/Material/GetDetail',
    readMethod: 'POST',
    operations: ['read'],
    keyField: 'FNumber',
    containerPaths: ['Data'],
    fieldMap: [{ source: 'FName', target: 'name' }],
  }
}

function sealedExportProvisionInput(publicKey: unknown) {
  const scope = {
    roleBindingFingerprint: '4'.repeat(64),
    systemContentKey: '3'.repeat(64),
    tenantDomainBinding: '2'.repeat(64),
    tenantId: 't1',
    workspaceId: null,
  }
  return {
    authority: {
      bindingExpiresAt: '2026-08-01T00:00:00Z',
      publicKey,
      qualificationDigest: '5'.repeat(64),
      qualificationExpiresAt: '2026-08-01T00:00:00Z',
      scope,
      signerExpiresAt: '2026-08-02T00:00:00Z',
    },
    binding: {
      approvedConfigVersionId: 'config-s6a-v1',
      bindingId: 'binding-s6a-v1',
      bindingVersion: 'binding-s6a-v1',
      canonicalObjectVersion: 'stock-preparation-bom.v1',
      configContentKey: '1'.repeat(64),
      expiresAt: '2026-08-01T00:00:00Z',
      externalSystemId: 'sys_1',
      objectKey: 'stock-preparation-bom',
      relationId: 'sqlserver.relation.rowid_payload.v1',
      roleBindingFingerprint: scope.roleBindingFingerprint,
      systemContentKey: scope.systemContentKey,
      tableRef: 'dbo.stock_prep_sealed_rows',
      tenantDomainBinding: scope.tenantDomainBinding,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
    },
  }
}

describeIfDatabase('external-system delete × bind lock protocol (real Postgres, two sessions)', () => {
  let ownerPool: Pool
  let owner: PoolClient
  let observer: PoolClient
  let schema: string
  let deleter: Session
  let writer: Session
  let secondWriter: Session
  // A schema that ran ONLY 057 — a deployment without 079 / 062 / 073 — and a session on it.
  let schema057: string
  let deleter057: Session
  // One deleter/writer pair per hostile default (I-* arms).
  const hostile = {} as Record<string, { deleter: Session; writer: Session }>
  let plugin: {
    createDb: (args: { database: Session['database'] }) => any
    createExternalSystemRegistry: (args: any) => any
    createStockPreparationSourceBindingStore: (args: any) => any
    createReadSourceConfigStore: (args: any) => any
    createPipelineRegistry: (args: any) => any
    createIntegrationTemplateRegistry: (args: any) => any
    createSealedExportLifecycleProvisioning: (args: any) => any
    createEd25519SignerMaterial: () => { publicKey: unknown }
    contentKeyFor: (normalized: unknown) => string
    validateReadSourceConfig: (config: unknown) => { valid: boolean; normalized: any }
  }

  function loadPlugin() {
    const readSourceConfigStore = requireCjs(path.join(PLUGIN_LIB, 'read-source-config-store.cjs'))
    return {
      createDb: requireCjs(path.join(PLUGIN_LIB, 'db.cjs')).createDb,
      createExternalSystemRegistry: requireCjs(path.join(PLUGIN_LIB, 'external-systems.cjs')).createExternalSystemRegistry,
      createStockPreparationSourceBindingStore: requireCjs(path.join(PLUGIN_LIB, 'stock-preparation-source-binding-store.cjs')).createStockPreparationSourceBindingStore,
      createReadSourceConfigStore: readSourceConfigStore.createReadSourceConfigStore,
      createPipelineRegistry: requireCjs(path.join(PLUGIN_LIB, 'pipelines.cjs')).createPipelineRegistry,
      createIntegrationTemplateRegistry: requireCjs(path.join(PLUGIN_LIB, 'integration-templates.cjs')).createIntegrationTemplateRegistry,
      createSealedExportLifecycleProvisioning: requireCjs(path.join(PLUGIN_LIB, 'sealed-export', 'sealed-export-lifecycle-provisioning.cjs')).createSealedExportLifecycleProvisioning,
      createEd25519SignerMaterial: requireCjs(path.join(PLUGIN_LIB, 'sealed-export', 'sealed-export-signer-authority.cjs')).createEd25519SignerMaterial,
      // `contentKeyFor` is a public export of the store (the C6 gate binds to it); the pre-#6076
      // plugin copy used for the "old red" runs has it too. `__internals.contentKeyFor` is the same
      // function under its older alias.
      contentKeyFor: readSourceConfigStore.contentKeyFor ?? readSourceConfigStore.__internals.contentKeyFor,
      validateReadSourceConfig: requireCjs(path.join(PLUGIN_LIB, 'read-source-config.cjs')).validateReadSourceConfig,
    }
  }

  // The host's plugin database seam (src/index.ts `context.api.database`): `query` returns rows,
  // `transaction` runs the callback on ONE client inside BEGIN/COMMIT (ROLLBACK on throw). The gate
  // is the test's scheduling seam: the next statement whose text starts with `sqlPrefix` parks
  // until released, and `reached` resolves when it parks.
  async function openSession(targetSchema: string = schema, defaultIsolation?: HostileLevel): Promise<Session> {
    const client = await ownerPool.connect()
    await client.query(`SET search_path TO ${quotedIdentifier(targetSchema)}, public`)
    if (defaultIsolation) {
      if (!HOSTILE_DEFAULTS.some((entry) => entry.level === defaultIsolation)) throw new Error('openSession: level outside HOSTILE_DEFAULTS')
      await client.query(`SET SESSION default_transaction_isolation = '${defaultIsolation}'`)
    }
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const gates = new Map<string, Gate & { arrived: () => void; open: Promise<void> }>()
    const statements: string[] = []
    async function beforeStatement(sql: string) {
      statements.push(sql)
      for (const [prefix, gate] of gates) {
        if (sql.startsWith(prefix)) {
          gates.delete(prefix)
          gate.arrived()
          await gate.open
          return
        }
      }
    }
    const database: Session['database'] = {
      query: async (sql, params) => {
        await beforeStatement(sql)
        return (await client.query(sql, params)).rows
      },
      transaction: async (callback) => {
        statements.push('BEGIN')
        await client.query('BEGIN')
        try {
          const result = await callback({
            query: async (sql, params) => {
              await beforeStatement(sql)
              return (await client.query(sql, params)).rows
            },
            commit: async () => {},
            rollback: async () => {},
          })
          statements.push('COMMIT')
          await client.query('COMMIT')
          return result
        } catch (error) {
          statements.push('ROLLBACK')
          await client.query('ROLLBACK').catch(() => {})
          throw error
        }
      },
    }
    const session: Session = {
      client,
      pid,
      database,
      statements,
      db: null,
      gateBefore(sqlPrefix) {
        let arrived!: () => void
        let release!: () => void
        const reached = new Promise<void>((resolve) => { arrived = resolve })
        const open = new Promise<void>((resolve) => { release = resolve })
        gates.set(sqlPrefix, { reached, release, arrived, open })
        return { reached, release }
      },
    }
    session.db = plugin.createDb({ database })
    return session
  }

  // Lock-wait observation is the load-bearing evidence that a lock is being TAKEN, not merely that
  // an outcome happened to be right: `true` once the backend reports a Lock wait, `false` after the
  // window with no wait observed (the signature of a side that skipped its lock).
  async function waitsOnLock(pid: number, windowMs = 5000): Promise<boolean> {
    const deadline = Date.now() + windowMs
    while (Date.now() < deadline) {
      const { rows } = await observer.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
        [pid],
      )
      if (Number(rows[0].n) > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  }

  async function count(table: string, where: string, params: unknown[] = []): Promise<number> {
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM ${quotedIdentifier(table)} WHERE ${where}`, params)
    return Number(rows[0].n)
  }

  async function seedSystem(id: string, role: 'source' | 'target' = 'source') {
    await owner.query(
      `INSERT INTO ${quotedIdentifier(EXTERNAL_SYSTEMS)} (id, tenant_id, workspace_id, name, kind, role, config, status)
       VALUES ($1, 't1', NULL, $1, 'erp:k3-wise-webapi', $2, '{"baseUrl":"https://plm.example.test"}'::jsonb, 'active')`,
      [id, role],
    )
  }

  function registryOn(session: Session) {
    return plugin.createExternalSystemRegistry({ db: session.db, credentialStore: credentialStore(), idGenerator: () => 'generated' })
  }
  function stockPrepBind(session: Session, externalSystemId = 'sys_1') {
    const store = plugin.createStockPreparationSourceBindingStore({ db: session.db })
    return () => store.set({ tenantId: 't1', workspaceId: null, actionId: ACTION_ID, externalSystemId, actor: 'admin' })
  }
  function readSourceMint(session: Session) {
    const store = plugin.createReadSourceConfigStore({ db: session.db })
    return () => store.saveVersion({ tenantId: 't1', workspaceId: null, actor: 'consultant', config: readSourceConfig() })
  }
  function pipelineWrite(session: Session, name = 'material sync') {
    const pipelines = plugin.createPipelineRegistry({ db: session.db })
    return () => pipelines.upsertPipeline({
      tenantId: 't1', workspaceId: null, name,
      sourceSystemId: 'sys_1', sourceObject: 'materials', targetSystemId: 'sys_target', targetObject: 't_material',
    })
  }
  // Template instantiation: same pointer (integration_pipelines) through the same writePipelineRow,
  // but its transaction READS the name clash before the KEY SHARE (integration-templates.cjs step 6).
  function templateInstantiate(session: Session) {
    const templates = plugin.createIntegrationTemplateRegistry({
      db: session.db,
      idGenerator: () => 'pipe_from_template',
      externalSystemRegistry: registryOn(session),
    })
    return () => templates.instantiateTemplate({
      tenantId: 't1', workspaceId: null, templateId: 'tpl_1', sourceSystemId: 'sys_1', targetSystemId: 'sys_target', pipelineName: 'from template',
    })
  }
  const deleteInput = { tenantId: 't1', workspaceId: null, id: 'sys_1' }

  // `transaction_isolation` INSIDE a transaction that is parked at a gate: the session's client is
  // idle-in-transaction (the plugin's next statement is held in JS before it is sent), so a query on
  // the same client runs inside that very transaction.
  async function isolationInside(session: Session): Promise<string> {
    const { rows } = await session.client.query("SELECT current_setting('transaction_isolation') AS iso")
    return String(rows[0].iso)
  }

  // Interleaving A — the owner's: delete side has taken FOR UPDATE and counted ZERO; the writer
  // starts while the delete is parked between its count and its DELETE.
  async function deleteFirst(
    write: () => Promise<unknown>,
    waitWindowMs?: number,
    pair: { deleter: Session; writer: Session } = { deleter, writer },
  ) {
    const beforeDelete = pair.deleter.gateBefore(`DELETE FROM ${quotedIdentifier(EXTERNAL_SYSTEMS)}`)
    const deletion = settle(registryOn(pair.deleter).deleteExternalSystem(deleteInput))
    await beforeDelete.reached
    const parkedIsolation = await isolationInside(pair.deleter)
    const writing = settle(write())
    const writerWaited = await waitsOnLock(pair.writer.pid, waitWindowMs)
    beforeDelete.release()
    const [deleted, written] = await Promise.all([deletion, writing])
    return { deleted, written, writerWaited, parkedIsolation }
  }

  // Interleaving B — writer holds KEY SHARE and is parked before its pointer INSERT; the delete
  // starts and must wait for it.
  async function writeFirst(
    write: () => Promise<unknown>,
    insertPrefix: string,
    pair: { deleter: Session; writer: Session } = { deleter, writer },
  ) {
    const beforeInsert = pair.writer.gateBefore(insertPrefix)
    const writing = settle(write())
    await beforeInsert.reached
    const parkedIsolation = await isolationInside(pair.writer)
    const deletion = settle(registryOn(pair.deleter).deleteExternalSystem(deleteInput))
    const deleterWaited = await waitsOnLock(pair.deleter.pid)
    beforeInsert.release()
    const [written, deleted] = await Promise.all([writing, deletion])
    return { deleted, written, deleterWaited, parkedIsolation }
  }

  // Every BEGIN a session issued in [from, end) is immediately followed by the pin.
  function pinnedAfterEveryBegin(session: Session, from: number): { begins: number; pinned: number } {
    const slice = session.statements.slice(from)
    let begins = 0
    let pinned = 0
    slice.forEach((statement, index) => {
      if (statement !== 'BEGIN') return
      begins += 1
      if (slice[index + 1] === PIN_STATEMENT) pinned += 1
    })
    return { begins, pinned }
  }

  beforeAll(async () => {
    plugin = loadPlugin()
    ownerPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 + HOSTILE_DEFAULTS.length * 2 })
    owner = await ownerPool.connect()
    observer = await ownerPool.connect()
    schema = `es_lock_${process.pid}_${Date.now().toString(36)}`
    await owner.query(`CREATE SCHEMA ${quotedIdentifier(schema)}`)
    await owner.query(`SET search_path TO ${quotedIdentifier(schema)}, public`)
    for (const name of MIGRATIONS) {
      await owner.query(readFileSync(path.join(repoRoot, 'packages', 'core-backend', 'migrations', name), 'utf8'))
    }
    // 057 only — the "never ran 079 / 062 / 073" deployment P-ABSENT drives.
    schema057 = `${schema}_057only`
    await owner.query(`CREATE SCHEMA ${quotedIdentifier(schema057)}`)
    await owner.query(`SET search_path TO ${quotedIdentifier(schema057)}, public`)
    await owner.query(readFileSync(path.join(repoRoot, 'packages', 'core-backend', 'migrations', MIGRATIONS[0]), 'utf8'))
    await owner.query(`SET search_path TO ${quotedIdentifier(schema)}, public`)
    deleter = await openSession()
    writer = await openSession()
    secondWriter = await openSession()
    deleter057 = await openSession(schema057)
    for (const { tag, level } of HOSTILE_DEFAULTS) {
      hostile[tag] = { deleter: await openSession(schema, level), writer: await openSession(schema, level) }
    }
  })

  afterAll(async () => {
    for (const session of [deleter, writer, secondWriter, deleter057, ...Object.values(hostile).flatMap((pair) => [pair.deleter, pair.writer])]) {
      if (session) {
        await session.client.query('ROLLBACK').catch(() => {})
        session.client.release()
      }
    }
    if (observer) observer.release()
    if (owner) {
      await owner.query('SET search_path TO public').catch(() => {})
      if (schema057) await owner.query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(schema057)} CASCADE`).catch(() => {})
      if (schema) await owner.query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(schema)} CASCADE`).catch(() => {})
      owner.release()
    }
    if (ownerPool) await ownerPool.end()
  })

  beforeEach(async () => {
    for (const table of [PIPELINES, STOCK_PREP_BINDINGS, READ_SOURCE_AUDIT, READ_SOURCE_CONFIGS, SEALED_EXPORT_BINDINGS,
      'integration_sealed_export_authority_state', 'integration_sealed_export_signer_public_keys', TEMPLATES, EXTERNAL_SYSTEMS]) {
      await owner.query(`DELETE FROM ${quotedIdentifier(table)}`)
    }
    await seedSystem('sys_1')
    await seedSystem('sys_target', 'target')
    await owner.query(
      `INSERT INTO ${quotedIdentifier(TEMPLATES)} (id, tenant_id, workspace_id, name, source_kind, source_object, target_kind, target_object, key_fields, mapping_def, status)
       VALUES ('tpl_1', 't1', NULL, 'material sync template', 'erp:k3-wise-webapi', 'materials', 'erp:k3-wise-webapi', 't_material', '["code"]'::jsonb, '[]'::jsonb, 'active')`,
    )
  })

  it('NEC: the unlocked count-then-delete shape (#5923 as shipped) dangles on this schema', async () => {
    // Raw SQL, no FOR UPDATE, no KEY SHARE — the exact two-statement shape the guard had. The
    // writer's INSERT takes no lock on the system row, so nothing orders it against the DELETE.
    await deleter.client.query('BEGIN')
    await deleter.client.query(`SELECT * FROM ${quotedIdentifier(EXTERNAL_SYSTEMS)} WHERE tenant_id = 't1' AND id = 'sys_1'`)
    const before = await deleter.client.query(
      `SELECT count(*)::int AS n FROM ${quotedIdentifier(STOCK_PREP_BINDINGS)} WHERE tenant_id = 't1' AND external_system_id = 'sys_1'`,
    )
    expect(Number(before.rows[0].n)).toBe(0)
    // Concurrent writer commits a pointer between the count and the DELETE.
    await writer.client.query(
      `INSERT INTO ${quotedIdentifier(STOCK_PREP_BINDINGS)} (id, tenant_id, workspace_id, action_id, external_system_id)
       VALUES ('bind_nec', 't1', NULL, $1, 'sys_1')`,
      [ACTION_ID],
    )
    await deleter.client.query(`DELETE FROM ${quotedIdentifier(EXTERNAL_SYSTEMS)} WHERE tenant_id = 't1' AND id = 'sys_1'`)
    await deleter.client.query('COMMIT')
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(0)
    expect(await count(STOCK_PREP_BINDINGS, "external_system_id = 'sys_1'")).toBe(1) // the dangle
  })

  it('P-079-A: bind after the delete counted zero → bind waits on FOR UPDATE, then refuses SOURCE_BINDING_SOURCE_NOT_LIVE; no dangle', async () => {
    const { deleted, written, writerWaited } = await deleteFirst(stockPrepBind(writer))
    expect(writerWaited).toBe(true)
    expect(deleted.error).toBeNull()
    expect(deleted.value.deleted).toBe(true)
    expect(written.error?.name).toBe('StockPreparationSourceBindingStoreError')
    expect(written.error?.code).toBe('SOURCE_BINDING_SOURCE_NOT_LIVE')
    expect(written.error?.status).toBe(409)
    expect(JSON.stringify(written.error?.details ?? {})).not.toContain('sys_1')
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(0)
    expect(await count(STOCK_PREP_BINDINGS, "external_system_id = 'sys_1'")).toBe(0)
  })

  it('P-079-B: delete after the bind holds KEY SHARE → delete waits, then 409 with the bind counted; system and bind kept', async () => {
    const { deleted, written, deleterWaited } = await writeFirst(stockPrepBind(writer), `INSERT INTO ${quotedIdentifier(STOCK_PREP_BINDINGS)}`)
    expect(deleterWaited).toBe(true)
    expect(written.error).toBeNull()
    expect(deleted.error?.name).toBe('ExternalSystemConflictError')
    expect(deleted.error?.details?.stockPrepSourceBindingCount).toBe(1)
    expect(deleted.error?.details?.referencedBindingCount).toBe(1)
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(1)
    expect(await count(STOCK_PREP_BINDINGS, "external_system_id = 'sys_1'")).toBe(1)
  })

  it('P-079-C: a REBIND (update path) after the delete counted zero is refused and the old binding stays on the live system', async () => {
    await seedSystem('sys_0')
    await owner.query(
      `INSERT INTO ${quotedIdentifier(STOCK_PREP_BINDINGS)} (id, tenant_id, workspace_id, action_id, external_system_id)
       VALUES ('bind_0', 't1', NULL, $1, 'sys_0')`,
      [ACTION_ID],
    )
    const { deleted, written, writerWaited } = await deleteFirst(stockPrepBind(writer))
    expect(writerWaited).toBe(true)
    expect(deleted.error).toBeNull()
    expect(written.error?.code).toBe('SOURCE_BINDING_SOURCE_NOT_LIVE')
    expect(await count(STOCK_PREP_BINDINGS, "external_system_id = 'sys_0'")).toBe(1)
    expect(await count(STOCK_PREP_BINDINGS, "external_system_id = 'sys_1'")).toBe(0)
  })

  it('P-062-A: mint after the delete counted zero → mint waits, then refuses READ_SOURCE_SYSTEM_NOT_FOUND; no row, no audit', async () => {
    const { deleted, written, writerWaited } = await deleteFirst(readSourceMint(writer))
    expect(writerWaited).toBe(true)
    expect(deleted.error).toBeNull()
    expect(written.error?.name).toBe('ReadSourceConfigValidationError')
    expect(written.error?.details?.errors).toEqual([{ code: 'READ_SOURCE_SYSTEM_NOT_FOUND', field: 'systemId', reason: 'not_found' }])
    expect(await count(READ_SOURCE_CONFIGS, "system_id = 'sys_1'")).toBe(0)
    expect(await count(READ_SOURCE_AUDIT, 'TRUE')).toBe(0)
  })

  it('P-062-B: delete after the mint holds KEY SHARE → delete waits, then 409 with the draft counted', async () => {
    const { deleted, written, deleterWaited } = await writeFirst(readSourceMint(writer), `INSERT INTO ${quotedIdentifier(READ_SOURCE_CONFIGS)}`)
    expect(deleterWaited).toBe(true)
    expect(written.error).toBeNull()
    expect(written.value.status).toBe('draft')
    expect(deleted.error?.name).toBe('ExternalSystemConflictError')
    expect(deleted.error?.details?.readSourceConfigCount).toBe(1)
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(1)
    expect(await count(READ_SOURCE_CONFIGS, "system_id = 'sys_1'")).toBe(1)
  })

  it('P-PIPE-A: pipeline write after the delete counted zero → waits, then refuses as PipelineValidationError (not a bare 23503)', async () => {
    const { deleted, written, writerWaited } = await deleteFirst(pipelineWrite(writer))
    expect(writerWaited).toBe(true)
    expect(deleted.error).toBeNull()
    expect(written.error?.name).toBe('PipelineValidationError')
    expect(written.error?.message).toBe('sourceSystemId does not exist in this tenant/workspace')
    expect(written.error?.code).toBeUndefined() // never a SQLSTATE: the refusal came from the re-read, not from 057's FK
    expect(await count(PIPELINES, "source_system_id = 'sys_1'")).toBe(0)
  })

  it('P-PIPE-B: delete after the pipeline write holds KEY SHARE → waits, then 409 "used by pipelines" (wording unchanged)', async () => {
    const { deleted, written, deleterWaited } = await writeFirst(pipelineWrite(writer), `INSERT INTO ${quotedIdentifier(PIPELINES)}`)
    expect(deleterWaited).toBe(true)
    expect(written.error).toBeNull()
    expect(deleted.error?.name).toBe('ExternalSystemConflictError')
    expect(deleted.error?.message).toBe('external system is used by pipelines')
    expect(deleted.error?.details?.sourcePipelineCount).toBe(1)
    expect(await count(PIPELINES, "source_system_id = 'sys_1'")).toBe(1)
  })

  it('P-MIX: two writers hold KEY SHARE on the same system without waiting on each other; the delete waits for both; no deadlock', async () => {
    const beforeBindInsert = writer.gateBefore(`INSERT INTO ${quotedIdentifier(STOCK_PREP_BINDINGS)}`)
    const binding = settle(stockPrepBind(writer)())
    await beforeBindInsert.reached // writer holds KEY SHARE on sys_1
    const beforePipelineInsert = secondWriter.gateBefore(`INSERT INTO ${quotedIdentifier(PIPELINES)}`)
    const pipeline = settle(pipelineWrite(secondWriter)())
    await beforePipelineInsert.reached // secondWriter holds KEY SHARE on sys_1 AND sys_target — did NOT wait on writer
    expect(await waitsOnLock(secondWriter.pid, 200)).toBe(false)
    const deletion = settle(registryOn(deleter).deleteExternalSystem(deleteInput))
    expect(await waitsOnLock(deleter.pid)).toBe(true)
    beforePipelineInsert.release()
    const pipelineResult = await pipeline
    expect(pipelineResult.error).toBeNull()
    expect(await waitsOnLock(deleter.pid, 300)).toBe(true) // still waiting on writer's KEY SHARE
    beforeBindInsert.release()
    const [bindResult, deleted] = await Promise.all([binding, deletion])
    expect(bindResult.error).toBeNull()
    expect(deleted.error?.name).toBe('ExternalSystemConflictError')
    expect(deleted.error?.code).not.toBe('40P01')
    expect(deleted.error?.details?.referencedPipelineCount).toBe(1)
    expect(deleted.error?.details?.referencedBindingCount).toBe(1)
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(1)
  })

  it('R-073 (registered residual): sealed-export provisioning takes no lock on the system row and the delete-first interleaving dangles', async () => {
    const material = plugin.createEd25519SignerMaterial()
    const provisioning = plugin.createSealedExportLifecycleProvisioning({ db: writer.db, clock: () => NOW })
    const { deleted, written, writerWaited } = await deleteFirst(
      () => provisioning.provisionInitialStockPreparationBinding(sealedExportProvisionInput(material.publicKey)),
      // A writer that takes no lock never waits; a short window is enough to say so (the positive
      // arms above keep the full window, because there a wait is what is being proven).
      500,
    )
    expect(writerWaited).toBe(false)
    expect(written.error).toBeNull()
    expect(deleted.error).toBeNull()
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(0)
    expect(await count(SEALED_EXPORT_BINDINGS, "external_system_id = 'sys_1' AND status = 'ACTIVE'")).toBe(1)
  })

  it('P-ABSENT: a deployment that ran only 057 (no 079 / 062 / 073) still deletes — the absence is learned by the autocommit probe, never inside the FOR UPDATE transaction', async () => {
    const table057 = (name: string) => `${quotedIdentifier(schema057)}.${quotedIdentifier(name)}`
    for (const missing of [STOCK_PREP_BINDINGS, READ_SOURCE_CONFIGS, SEALED_EXPORT_BINDINGS]) {
      const { rows } = await owner.query('SELECT to_regclass($1) AS rel', [`${schema057}.${missing}`])
      expect(rows[0].rel).toBeNull() // the schema really lacks the three dependent tables
    }
    await owner.query(
      `INSERT INTO ${table057(EXTERNAL_SYSTEMS)} (id, tenant_id, workspace_id, name, kind, role, config, status)
       VALUES ('sys_1', 't1', NULL, 'sys_1', 'erp:k3-wise-webapi', 'source', '{"baseUrl":"https://plm.example.test"}'::jsonb, 'active')`,
    )
    const issuedBefore = deleter057.statements.length
    const deleted = await settle(registryOn(deleter057).deleteExternalSystem(deleteInput))
    expect(deleted.error).toBeNull() // the X4 mutant fails here with SQLSTATE 25P02 (the 42P01 aborted its transaction)
    expect(deleted.value.deleted).toBe(true)
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM ${table057(EXTERNAL_SYSTEMS)} WHERE id = 'sys_1'`)
    expect(Number(rows[0].n)).toBe(0)
    // Shape of the run: the probe's three dependent COUNTs (four statements: 062 is counted per live
    // status) came BEFORE `BEGIN`, and inside the transaction only the pipeline counts ran.
    const issued = deleter057.statements.slice(issuedBefore)
    const begin = issued.indexOf('BEGIN')
    expect(begin).toBeGreaterThan(0)
    const dependentCount = (sql: string) => /^SELECT COUNT\(\*\)::int AS count FROM "integration_(stock_prep_source_binding|sealed_export_stock_prep_bindings|read_source_configs)"/.test(sql)
    expect(issued.slice(0, begin).filter(dependentCount)).toHaveLength(4)
    expect(issued.slice(begin).filter(dependentCount)).toHaveLength(0)
  })

  it('P-062-REUSE-A (registered): identical content that exists as a RETIRED version at a since-deleted system is refused 409 content_retired by the pre-lock reuse path, with no FOR KEY SHARE issued — not the 400 not_found tuple', async () => {
    const store = plugin.createReadSourceConfigStore({ db: writer.db })
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const minted = await store.saveVersion({ ...scope, config: readSourceConfig() })
    await store.approve({ ...scope, id: minted.id })
    await store.retire({ ...scope, id: minted.id })
    const deleted = await settle(registryOn(deleter).deleteExternalSystem(deleteInput))
    expect(deleted.error).toBeNull() // retired is not a live pointer: the delete goes through
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(0)

    const rowsBefore = await count(READ_SOURCE_CONFIGS, 'TRUE')
    const auditBefore = await count(READ_SOURCE_AUDIT, 'TRUE')
    const issuedBefore = writer.statements.length
    const same = await settle(store.saveVersion({ ...scope, config: readSourceConfig() }))
    expect(same.error?.name).toBe('ReadSourceConfigConflictError')
    expect(same.error?.details).toEqual({ id: minted.id, reason: 'content_retired' })
    expect(writer.statements.slice(issuedBefore).filter((sql) => sql.includes('FOR KEY SHARE'))).toHaveLength(0)
    expect(writer.statements.slice(issuedBefore)).not.toContain('BEGIN')
    expect(await count(READ_SOURCE_CONFIGS, 'TRUE')).toBe(rowsBefore)
    expect(await count(READ_SOURCE_AUDIT, 'TRUE')).toBe(auditBefore)
    // New content at the same deleted system takes the MINT path and gets the lock's tuple.
    const different = await settle(store.saveVersion({ ...scope, config: { ...readSourceConfig(), object: 'bom' } }))
    expect(different.error?.name).toBe('ReadSourceConfigValidationError')
    expect(different.error?.details?.errors).toEqual([{ code: 'READ_SOURCE_SYSTEM_NOT_FOUND', field: 'systemId', reason: 'not_found' }])
    expect(await count(READ_SOURCE_CONFIGS, 'TRUE')).toBe(rowsBefore)
  })

  it('P-062-REUSE-B (registered): a pre-protocol LIVE row at a system that does not exist is reused by identical content — reuse_version audit written, no FOR KEY SHARE; new content is refused by the lock', async () => {
    const ghost = readSourceConfig('sys_ghost')
    const normalized = plugin.validateReadSourceConfig(ghost).normalized
    const stored = { ...normalized, version: 1 }
    await owner.query(
      `INSERT INTO ${quotedIdentifier(READ_SOURCE_CONFIGS)} (id, tenant_id, workspace_id, system_id, object, mode, config, content_key, version, status)
       VALUES ('legacy_1', 't1', NULL, 'sys_ghost', $1, $2, $3::jsonb, $4, 1, 'draft')`,
      [normalized.object, normalized.mode, JSON.stringify(stored), plugin.contentKeyFor(normalized)],
    )
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_ghost'")).toBe(0)
    const store = plugin.createReadSourceConfigStore({ db: writer.db })
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const issuedBefore = writer.statements.length
    const reused = await settle(store.saveVersion({ ...scope, config: ghost }))
    expect(reused.error).toBeNull()
    expect(reused.value.reused).toBe(true)
    expect(reused.value.id).toBe('legacy_1')
    expect(writer.statements.slice(issuedBefore).filter((sql) => sql.includes('FOR KEY SHARE'))).toHaveLength(0)
    expect(await count(READ_SOURCE_CONFIGS, "system_id = 'sys_ghost'")).toBe(1)
    expect(await count(READ_SOURCE_AUDIT, "config_id = 'legacy_1' AND action = 'reuse_version'")).toBe(1)
    const different = await settle(store.saveVersion({ ...scope, config: { ...ghost, object: 'bom' } }))
    expect(different.error?.name).toBe('ReadSourceConfigValidationError')
    expect(different.error?.details?.errors).toEqual([{ code: 'READ_SOURCE_SYSTEM_NOT_FOUND', field: 'systemId', reason: 'not_found' }])
    expect(await count(READ_SOURCE_CONFIGS, "system_id = 'sys_ghost'")).toBe(1)
  })

  // ------------------------------------------------------------------------------------------------
  // I-RR-* / I-SER-* — the isolation pin under hostile server defaults (see the header).
  // ------------------------------------------------------------------------------------------------
  const PROTOCOL_WRITERS = [
    {
      tag: '079',
      label: '079 bind',
      write: (session: Session) => stockPrepBind(session),
      insertPrefix: `INSERT INTO ${quotedIdentifier(STOCK_PREP_BINDINGS)}`,
      pointerTable: STOCK_PREP_BINDINGS,
      pointerWhere: "external_system_id = 'sys_1'",
      countKey: 'stockPrepSourceBindingCount',
      assertOwnRefusal: (error: any) => {
        expect(error?.code).toBe('SOURCE_BINDING_SOURCE_NOT_LIVE')
        expect(error?.name).toBe('StockPreparationSourceBindingStoreError')
        expect(error?.status).toBe(409)
      },
    },
    {
      tag: '062',
      label: '062 mint',
      write: (session: Session) => readSourceMint(session),
      insertPrefix: `INSERT INTO ${quotedIdentifier(READ_SOURCE_CONFIGS)}`,
      pointerTable: READ_SOURCE_CONFIGS,
      pointerWhere: "system_id = 'sys_1'",
      countKey: 'readSourceConfigCount',
      assertOwnRefusal: (error: any) => {
        expect(error?.code).toBeUndefined()
        expect(error?.name).toBe('ReadSourceConfigValidationError')
        expect(error?.details?.errors).toEqual([{ code: 'READ_SOURCE_SYSTEM_NOT_FOUND', field: 'systemId', reason: 'not_found' }])
      },
    },
    {
      tag: 'PIPE',
      label: 'pipeline upsert',
      write: (session: Session) => pipelineWrite(session),
      insertPrefix: `INSERT INTO ${quotedIdentifier(PIPELINES)}`,
      pointerTable: PIPELINES,
      pointerWhere: "source_system_id = 'sys_1'",
      countKey: 'sourcePipelineCount',
      assertOwnRefusal: (error: any) => {
        expect(error?.code).toBeUndefined() // never a SQLSTATE (40001 / 23503)
        expect(error?.name).toBe('PipelineValidationError')
        expect(error?.message).toBe('sourceSystemId does not exist in this tenant/workspace')
      },
    },
    {
      tag: 'TPL',
      label: 'template instantiation',
      write: (session: Session) => templateInstantiate(session),
      insertPrefix: `INSERT INTO ${quotedIdentifier(PIPELINES)}`,
      pointerTable: PIPELINES,
      pointerWhere: "source_system_id = 'sys_1'",
      countKey: 'sourcePipelineCount',
      assertOwnRefusal: (error: any) => {
        expect(error?.code).toBeUndefined()
        expect(error?.name).toBe('PipelineValidationError')
        expect(error?.message).toBe('sourceSystemId does not exist in this tenant/workspace')
      },
    },
  ]

  for (const { tag, level } of HOSTILE_DEFAULTS) {
    it(`I-${tag}-SENTINEL: the ${level} sessions really default to ${level} — a bare BEGIN inherits it (the harness is hostile, not merely labelled)`, async () => {
      for (const session of [hostile[tag].deleter, hostile[tag].writer]) {
        await session.client.query('BEGIN')
        const { rows } = await session.client.query("SELECT current_setting('transaction_isolation') AS iso")
        await session.client.query('ROLLBACK')
        expect(rows[0].iso).toBe(level)
      }
    })

    for (const spec of PROTOCOL_WRITERS) {
      it(`I-${tag}-${spec.tag}-A: ${level} default, delete first → the ${spec.label} waits on the FOR UPDATE, then refuses in its own shape (never a bare 40001); no dangle; both sides ran at read committed`, async () => {
        const pair = hostile[tag]
        const deleterFrom = pair.deleter.statements.length
        const writerFrom = pair.writer.statements.length
        const { deleted, written, writerWaited, parkedIsolation } = await deleteFirst(spec.write(pair.writer), undefined, pair)
        // The outcome FIRST, so a regression reports the dangle itself, not a downstream symptom.
        expect({
          systemRows: await count(EXTERNAL_SYSTEMS, "id = 'sys_1'"),
          pointerRows: await count(spec.pointerTable, spec.pointerWhere),
        }).toEqual({ systemRows: 0, pointerRows: 0 })
        expect(writerWaited).toBe(true)
        expect(deleted.error).toBeNull()
        spec.assertOwnRefusal(written.error)
        expect(parkedIsolation).toBe('read committed') // observed INSIDE the parked delete transaction
        expect(pinnedAfterEveryBegin(pair.deleter, deleterFrom)).toEqual({ begins: 1, pinned: 1 })
        expect(pinnedAfterEveryBegin(pair.writer, writerFrom)).toEqual({ begins: 1, pinned: 1 })
      })

      it(`I-${tag}-${spec.tag}-B: ${level} default, ${spec.label} first → the delete waits on the KEY SHARE, then COUNTS the pointer and refuses 409; system and pointer kept`, async () => {
        const pair = hostile[tag]
        const deleterFrom = pair.deleter.statements.length
        const writerFrom = pair.writer.statements.length
        const { deleted, written, deleterWaited, parkedIsolation } = await writeFirst(spec.write(pair.writer), spec.insertPrefix, pair)
        // Before the pin this was { systemRows: 0, pointerRows: 1 } at repeatable read — the dangle.
        expect({
          systemRows: await count(EXTERNAL_SYSTEMS, "id = 'sys_1'"),
          pointerRows: await count(spec.pointerTable, spec.pointerWhere),
        }).toEqual({ systemRows: 1, pointerRows: 1 })
        expect(deleterWaited).toBe(true)
        expect(written.error).toBeNull()
        expect(deleted.error?.name).toBe('ExternalSystemConflictError')
        expect(deleted.error?.details?.[spec.countKey]).toBe(1)
        expect(parkedIsolation).toBe('read committed') // observed INSIDE the parked writer transaction
        expect(pinnedAfterEveryBegin(pair.deleter, deleterFrom)).toEqual({ begins: 1, pinned: 1 })
        expect(pinnedAfterEveryBegin(pair.writer, writerFrom)).toEqual({ begins: 1, pinned: 1 })
      })
    }
  }
})

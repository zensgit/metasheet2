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

const MIGRATIONS = [
  '057_create_integration_core_tables.sql',
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
  let plugin: {
    createDb: (args: { database: Session['database'] }) => any
    createExternalSystemRegistry: (args: any) => any
    createStockPreparationSourceBindingStore: (args: any) => any
    createReadSourceConfigStore: (args: any) => any
    createPipelineRegistry: (args: any) => any
    createSealedExportLifecycleProvisioning: (args: any) => any
    createEd25519SignerMaterial: () => { publicKey: unknown }
  }

  function loadPlugin() {
    return {
      createDb: requireCjs(path.join(PLUGIN_LIB, 'db.cjs')).createDb,
      createExternalSystemRegistry: requireCjs(path.join(PLUGIN_LIB, 'external-systems.cjs')).createExternalSystemRegistry,
      createStockPreparationSourceBindingStore: requireCjs(path.join(PLUGIN_LIB, 'stock-preparation-source-binding-store.cjs')).createStockPreparationSourceBindingStore,
      createReadSourceConfigStore: requireCjs(path.join(PLUGIN_LIB, 'read-source-config-store.cjs')).createReadSourceConfigStore,
      createPipelineRegistry: requireCjs(path.join(PLUGIN_LIB, 'pipelines.cjs')).createPipelineRegistry,
      createSealedExportLifecycleProvisioning: requireCjs(path.join(PLUGIN_LIB, 'sealed-export', 'sealed-export-lifecycle-provisioning.cjs')).createSealedExportLifecycleProvisioning,
      createEd25519SignerMaterial: requireCjs(path.join(PLUGIN_LIB, 'sealed-export', 'sealed-export-signer-authority.cjs')).createEd25519SignerMaterial,
    }
  }

  // The host's plugin database seam (src/index.ts `context.api.database`): `query` returns rows,
  // `transaction` runs the callback on ONE client inside BEGIN/COMMIT (ROLLBACK on throw). The gate
  // is the test's scheduling seam: the next statement whose text starts with `sqlPrefix` parks
  // until released, and `reached` resolves when it parks.
  async function openSession(): Promise<Session> {
    const client = await ownerPool.connect()
    await client.query(`SET search_path TO ${quotedIdentifier(schema)}, public`)
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const gates = new Map<string, Gate & { arrived: () => void; open: Promise<void> }>()
    async function beforeStatement(sql: string) {
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
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        }
      },
    }
    const session: Session = {
      client,
      pid,
      database,
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
  const deleteInput = { tenantId: 't1', workspaceId: null, id: 'sys_1' }

  // Interleaving A — the owner's: delete side has taken FOR UPDATE and counted ZERO; the writer
  // starts while the delete is parked between its count and its DELETE.
  async function deleteFirst(write: () => Promise<unknown>, waitWindowMs?: number) {
    const beforeDelete = deleter.gateBefore(`DELETE FROM ${quotedIdentifier(EXTERNAL_SYSTEMS)}`)
    const deletion = settle(registryOn(deleter).deleteExternalSystem(deleteInput))
    await beforeDelete.reached
    const writing = settle(write())
    const writerWaited = await waitsOnLock(writer.pid, waitWindowMs)
    beforeDelete.release()
    const [deleted, written] = await Promise.all([deletion, writing])
    return { deleted, written, writerWaited }
  }

  // Interleaving B — writer holds KEY SHARE and is parked before its pointer INSERT; the delete
  // starts and must wait for it.
  async function writeFirst(write: () => Promise<unknown>, insertPrefix: string) {
    const beforeInsert = writer.gateBefore(insertPrefix)
    const writing = settle(write())
    await beforeInsert.reached
    const deletion = settle(registryOn(deleter).deleteExternalSystem(deleteInput))
    const deleterWaited = await waitsOnLock(deleter.pid)
    beforeInsert.release()
    const [written, deleted] = await Promise.all([writing, deletion])
    return { deleted, written, deleterWaited }
  }

  beforeAll(async () => {
    plugin = loadPlugin()
    ownerPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
    owner = await ownerPool.connect()
    observer = await ownerPool.connect()
    schema = `es_lock_${process.pid}_${Date.now().toString(36)}`
    await owner.query(`CREATE SCHEMA ${quotedIdentifier(schema)}`)
    await owner.query(`SET search_path TO ${quotedIdentifier(schema)}, public`)
    for (const name of MIGRATIONS) {
      await owner.query(readFileSync(path.join(repoRoot, 'packages', 'core-backend', 'migrations', name), 'utf8'))
    }
    deleter = await openSession()
    writer = await openSession()
    secondWriter = await openSession()
  })

  afterAll(async () => {
    for (const session of [deleter, writer, secondWriter]) {
      if (session) {
        await session.client.query('ROLLBACK').catch(() => {})
        session.client.release()
      }
    }
    if (observer) observer.release()
    if (owner) {
      await owner.query('SET search_path TO public').catch(() => {})
      if (schema) await owner.query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(schema)} CASCADE`).catch(() => {})
      owner.release()
    }
    if (ownerPool) await ownerPool.end()
  })

  beforeEach(async () => {
    for (const table of [PIPELINES, STOCK_PREP_BINDINGS, READ_SOURCE_AUDIT, READ_SOURCE_CONFIGS, SEALED_EXPORT_BINDINGS,
      'integration_sealed_export_authority_state', 'integration_sealed_export_signer_public_keys', EXTERNAL_SYSTEMS]) {
      await owner.query(`DELETE FROM ${quotedIdentifier(table)}`)
    }
    await seedSystem('sys_1')
    await seedSystem('sys_target', 'target')
  })

  it('sentinel: DATABASE_URL set', () => {
    // Armed by lanes that export EXPECT_DB=1: a missing DATABASE_URL must be RED there, never a
    // skip-green. In the default no-DB job this whole describe is skipped, not passed.
    expect(process.env.DATABASE_URL).toBeTruthy()
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
})

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
//   P-087-A/B the BOM read-plan version mint, both interleavings, including a dependent in another
//            workspace. Mint still takes KEY SHARE. Approval and activation take FOR UPDATE on the
//            external system, then the canonical private owner mirror, then the version.
//   P-087-C  approval WAITS on that source FOR UPDATE while delete holds it, so it cannot commit
//            between the draft and approved counts. The delete refuses the one draft; approval
//            commits only after that refusal releases the source. The old double-count is unreachable.
//   P-087-D  content unique-index retries for same/different mint (KEY SHARE; not the activation pointer)
//   P-087-E  runtime scope/status and retirement, after explicit begin/finish/confirm. Finish records
//            FIXTURE counts only; this suite does not run the HTTP+SQL source read.
//   P-087-F  audit insertion failure rolls back a new version and an approval status change; the
//            already confirmed ledger rows stay
//   P-087-G  two approvals serialize on the source FOR UPDATE; one success, one status conflict
//   P-087-ACT-* activation generation CAS. Same-source activations serialize on the source FOR UPDATE
//            before either pointer insert, so ACT-10 waits on that row and then conflicts on generation.
//            It never reaches the activation-scope unique index. Retire and deactivate still lock the
//            version before the pointer and do not take the source row.
//   P-PIPE-A/B the pipeline endpoint check, both interleavings (source endpoint)
//   P-MIX    a bind and a pipeline write hold KEY SHARE on the same system concurrently (KEY SHARE is
//            compatible with KEY SHARE: neither waits), the delete waits for both, then refuses with
//            BOTH counted — and no 40P01 deadlock anywhere
//   R-073    the REGISTERED RESIDUAL: sealed-export provisioning (frozen S6-A module, provisioning
//            role with no privilege on integration_external_systems) takes no lock and DANGLES —
//            asserted so fixing it must retire this arm with the design doc's residual entry
//   P-ABSENT a schema that ran ONLY 057 (no 079 / 062 / 073 / 087): the delete still goes through, because
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
//   P-062-APPROVE-BETWEEN a 062 APPROVE (draft -> approved; takes NO lock on the system row — it mints
//            no new live pointer) commits while the delete is parked right before its SECOND 062
//            COUNT (#6076 fourth-round final review). The delete still refuses 409 and counts the
//            one row TWICE (as draft, then as approved — the proof the approve landed between the
//            counts); system and config kept. This holds only because external-systems.cjs counts
//            062 in lifecycle order (draft THEN approved) one statement at a time: with the order
//            reversed (M-ORDER, `LIVE_READ_SOURCE_CONFIG_STATUSES` = approved, draft) the approve
//            slips past both counts and the delete commits under an approved pointer (design doc §2.8)
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

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { up as createDataSourcesTable } from '../../src/db/migrations/20251206000001_create_data_sources_table'
import { up as addConnectionBinding } from '../../src/db/migrations/zzzz20260902120000_add_integration_connection_binding'
import { up as addLiveIdBindingLock } from '../../src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock'
import { up as addSourceValidationRevisions } from '../../src/db/migrations/zzzz20261001120001_stock_prep_validation_source_revisions'
import { up as addValidationLedger } from '../../src/db/migrations/zzzz20261001121000_stock_prep_read_plan_validation_ledger'

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
  '089_create_integration_stock_prep_read_plan_versions.sql',
]

const EXTERNAL_SYSTEMS = 'integration_external_systems'
const STOCK_PREP_BINDINGS = 'integration_stock_prep_source_binding'
const READ_SOURCE_CONFIGS = 'integration_read_source_configs'
const READ_SOURCE_AUDIT = 'integration_read_source_config_audit'
const PIPELINES = 'integration_pipelines'
const SEALED_EXPORT_BINDINGS = 'integration_sealed_export_stock_prep_bindings'
const TEMPLATES = 'integration_templates'
const STOCK_PREP_READ_PLANS = 'integration_stock_prep_read_plan_versions'
const STOCK_PREP_READ_PLAN_ACTIVATION = 'integration_stock_prep_read_plan_activation'
const STOCK_PREP_READ_PLAN_AUDIT = 'integration_stock_prep_read_plan_audit'
const DATA_SOURCES = 'data_sources'
// Names are rebound from the real ledger module in loadPlugin. The suite does not create this table.
let sourceRevisionTable = 'integration_data_source_validation_revisions'
let validationTable = 'integration_stock_prep_read_plan_validations'
// The private Connection the real mirror trigger publishes. Its owner_id is the same actor the
// ledger compares; the suite does not write the revision table itself.
const LEDGER_FIXTURE_CONNECTION_ID = 'ds_sys_1'
// FIXTURE COUNTS ONLY. finishValidation must receive counts, and this ledger suite does not open a
// source connection or run the HTTP+SQL read. That chain belongs to the root-owned host suite.
const FIXTURE_LEDGER_COUNTS = Object.freeze({ sampleCount: 2, readCount: 10, objectCount: 7 })
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
// Local contracts for the new CJS read-plan store boundary. Invalid command
// inputs stay representable so the real store still owns validation/refusal.
type ReadPlanVersion = { id: string; version: number; status: string }
type ReadPlanActivation = { id: string; versionId: string; generation: number; status: string }
type ReadPlanValidation = {
  validationId: string
  status: string
  counts: { sampleCount: number; readCount: number; objectCount: number }
}
type ReadPlanAudit = { action: string; detail: Record<string, unknown> & { generation?: number } }
type ReadPlanStore = {
  saveVersion(input: Record<string, unknown>): Promise<ReadPlanVersion>
  get(input: Record<string, unknown>): Promise<ReadPlanVersion | null>
  list(input: Record<string, unknown>): Promise<ReadPlanVersion[]>
  approve(input: Record<string, unknown>): Promise<ReadPlanVersion>
  retire(input: Record<string, unknown>): Promise<ReadPlanVersion>
  getForRuntime(input: Record<string, unknown>): Promise<ReadPlanVersion>
  activate(input: Record<string, unknown>): Promise<ReadPlanActivation>
  deactivate(input: Record<string, unknown>): Promise<ReadPlanActivation>
  getActivation(input: Record<string, unknown>): Promise<ReadPlanActivation | null>
  getActiveForRuntime(input: Record<string, unknown>): Promise<{ version: ReadPlanVersion } | null>
  listAudit(input: Record<string, unknown>): Promise<ReadPlanAudit[]>
  beginValidation(input: Record<string, unknown>): Promise<ReadPlanValidation>
  finishValidation(input: Record<string, unknown>): Promise<ReadPlanValidation>
  confirmValidation(input: Record<string, unknown>): Promise<ReadPlanValidation>
}
type Gate = { reached: Promise<void>; release: () => void }
// `inTransaction`: only statements issued inside the plugin's `transaction` callback match (the
// delete side's autocommit 42P01 probe issues the same COUNT texts first). `skip`: let the first n
// matching statements through and park the next one.
type GateOptions = { inTransaction?: boolean; skip?: number }
type Session = {
  client: PoolClient
  pid: number
  database: {
    query: (sql: string, params?: unknown[]) => Promise<QueryRows>
    transaction: <T>(callback: (trx: { query: (sql: string, params?: unknown[]) => Promise<QueryRows>; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>) => Promise<T>
  }
  gateBefore: (sqlPrefix: string, options?: GateOptions) => Gate
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
  // A schema that ran ONLY 057 — a deployment without 079 / 062 / 073 / 087 — and a session on it.
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
    createStockPreparationReadPlanStore: (args: { db: unknown }) => ReadPlanStore
    defaultStockPreparationBomReadPlan: Record<string, unknown>
    createEd25519SignerMaterial: () => { publicKey: unknown }
    contentKeyFor: (normalized: unknown) => string
    validateReadSourceConfig: (config: unknown) => { valid: boolean; normalized: any }
  }

  function loadPlugin() {
    const readSourceConfigStore = requireCjs(path.join(PLUGIN_LIB, 'read-source-config-store.cjs'))
    const ledger = requireCjs(path.join(PLUGIN_LIB, 'stock-preparation-read-plan-validation-ledger.cjs'))
    sourceRevisionTable = ledger.SOURCE_REVISION_TABLE
    validationTable = ledger.VALIDATION_TABLE
    return {
      createDb: requireCjs(path.join(PLUGIN_LIB, 'db.cjs')).createDb,
      createExternalSystemRegistry: requireCjs(path.join(PLUGIN_LIB, 'external-systems.cjs')).createExternalSystemRegistry,
      createStockPreparationSourceBindingStore: requireCjs(path.join(PLUGIN_LIB, 'stock-preparation-source-binding-store.cjs')).createStockPreparationSourceBindingStore,
      createReadSourceConfigStore: readSourceConfigStore.createReadSourceConfigStore,
      createPipelineRegistry: requireCjs(path.join(PLUGIN_LIB, 'pipelines.cjs')).createPipelineRegistry,
      createIntegrationTemplateRegistry: requireCjs(path.join(PLUGIN_LIB, 'integration-templates.cjs')).createIntegrationTemplateRegistry,
      createSealedExportLifecycleProvisioning: requireCjs(path.join(PLUGIN_LIB, 'sealed-export', 'sealed-export-lifecycle-provisioning.cjs')).createSealedExportLifecycleProvisioning,
      createStockPreparationReadPlanStore: requireCjs(path.join(PLUGIN_LIB, 'stock-preparation-read-plan-store.cjs')).createStockPreparationReadPlanStore,
      defaultStockPreparationBomReadPlan: requireCjs(path.join(PLUGIN_LIB, 'stock-preparation-bom-expansion.cjs')).PLM_STOCK_PREPARATION_BOM_READ_PLAN,
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
  async function openSession(targetSchema: string = schema, defaultIsolation?: HostileLevel, { withPublic = true }: { withPublic?: boolean } = {}): Promise<Session> {
    const client = await ownerPool.connect()
    // The 057-only session must NOT see `public`: on a shared database whose `public` already ran
    // 079 / 062 / 073 (CI's metasheet_test after "Run DB migrations"), an unqualified
    // `FROM "integration_stock_prep_source_binding"` would resolve to public's table, the probe would
    // learn nothing is absent, and P-ABSENT would observe the dependent counts inside the
    // transaction. With `public` off the path the missing tables raise 42P01 as on a real 057-only
    // deployment. (pg_catalog stays implicitly searched.)
    await client.query(withPublic
      ? `SET search_path TO ${quotedIdentifier(targetSchema)}, public`
      : `SET search_path TO ${quotedIdentifier(targetSchema)}`)
    if (defaultIsolation) {
      if (!HOSTILE_DEFAULTS.some((entry) => entry.level === defaultIsolation)) throw new Error('openSession: level outside HOSTILE_DEFAULTS')
      await client.query(`SET SESSION default_transaction_isolation = '${defaultIsolation}'`)
    }
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const gates = new Map<string, Gate & { arrived: () => void; open: Promise<void>; inTransaction: boolean; skip: number }>()
    const statements: string[] = []
    async function beforeStatement(sql: string, inTransaction = false) {
      statements.push(sql)
      for (const [prefix, gate] of gates) {
        if (sql.startsWith(prefix)) {
          if (gate.inTransaction && !inTransaction) continue
          if (gate.skip > 0) {
            gate.skip -= 1
            continue
          }
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
              await beforeStatement(sql, true)
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
      gateBefore(sqlPrefix, { inTransaction = false, skip = 0 } = {}) {
        let arrived!: () => void
        let release!: () => void
        const reached = new Promise<void>((resolve) => { arrived = resolve })
        const open = new Promise<void>((resolve) => { release = resolve })
        gates.set(sqlPrefix, { reached, release, arrived, open, inTransaction, skip })
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

  // Held row locks live on the tuple, not in pg_locks. A waiter shows up as a Lock wait whose
  // current statement is the blocked FOR UPDATE, and pg_blocking_pids names the session holding it.
  // A unique-index wait would instead be blocked inside the pointer INSERT.
  async function lockWait(pid: number, windowMs = 5000): Promise<{ query: string; blockedBy: number[] }> {
    const deadline = Date.now() + windowMs
    let query = ''
    let blockedBy: number[] = []
    while (Date.now() < deadline) {
      const { rows } = await observer.query(
        `SELECT wait_event_type, query, pg_blocking_pids(pid) AS blocked_by
         FROM pg_stat_activity WHERE pid = $1`,
        [pid],
      )
      query = String(rows[0]?.query ?? '')
      const raw = rows[0]?.blocked_by
      blockedBy = Array.isArray(raw) ? raw.map((value: unknown) => Number(value)) : []
      if (rows[0]?.wait_event_type === 'Lock' && blockedBy.length > 0) return { query, blockedBy }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return { query, blockedBy }
  }

  function expectBlockedForUpdate(wait: { query: string; blockedBy: number[] }, holderPid: number, table: string) {
    expect(wait.blockedBy).toContain(holderPid)
    expect(wait.query.startsWith(`SELECT * FROM ${quotedIdentifier(table)} `)).toBe(true)
    expect(wait.query.endsWith(' FOR UPDATE')).toBe(true)
  }

  function latestTransaction(session: Session): string[] {
    const begin = session.statements.lastIndexOf('BEGIN')
    if (begin < 0) return []
    const commit = session.statements.indexOf('COMMIT', begin)
    const rollback = session.statements.indexOf('ROLLBACK', begin)
    const ends = [commit, rollback].filter((index) => index >= 0)
    const end = ends.length > 0 ? Math.min(...ends) + 1 : session.statements.length
    return session.statements.slice(begin, end)
  }

  function forUpdateTables(statements: string[]): string[] {
    return statements.flatMap((statement) => {
      const match = /^SELECT \* FROM "([^"]+)".* FOR UPDATE$/.exec(statement)
      return match ? [match[1]] : []
    })
  }

  function approveLockOrder(): string[] {
    return [EXTERNAL_SYSTEMS, sourceRevisionTable, STOCK_PREP_READ_PLANS, validationTable]
  }

  function activateLockOrder(): string[] {
    return [...approveLockOrder(), STOCK_PREP_READ_PLAN_ACTIVATION]
  }

  // Release the parked statement even when the observation throws, then wait until the racers leave
  // their transactions. Otherwise the next test's DELETE sits behind a lock this case abandoned.
  async function observeThenRelease<T>(release: () => void, parked: Promise<unknown>[], observe: () => Promise<T>): Promise<T> {
    let value!: T
    let failure: unknown
    try {
      value = await observe()
    } catch (error) {
      failure = error
    } finally {
      release()
    }
    await Promise.all(parked)
    if (failure) throw failure
    return value
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
  function stockPrepReadPlanConfig(systemId = 'sys_1', maxReadCount = 200) {
    return {
      schemaVersion: 1,
      actionId: ACTION_ID,
      systemId,
      readPlan: {
        ...plugin.defaultStockPreparationBomReadPlan,
        id: 'plm.stock-preparation.bom-read.user-draft.v1',
        maxReadCount,
      },
    }
  }
  function stockPrepReadPlanStore(session: Session) {
    return plugin.createStockPreparationReadPlanStore({ db: session.db })
  }
  function stockPrepReadPlanMint(session: Session, config = stockPrepReadPlanConfig()) {
    return () => stockPrepReadPlanStore(session).saveVersion({
      tenantId: 't1', workspaceId: null, actor: 'consultant', config,
    })
  }
  async function canonicalPrivateSource(): Promise<{ connectionId: string; connectionRevision: string }> {
    const { rows } = await owner.query(
      `SELECT validation_revision::text AS revision, owner_id, scope_kind, type, is_active, deleted_at IS NULL AS live
       FROM ${quotedIdentifier(sourceRevisionTable)}
       WHERE data_source_id = $1`,
      [LEDGER_FIXTURE_CONNECTION_ID],
    )
    const row = rows[0]
    if (rows.length !== 1 || row?.owner_id !== 'consultant' || row?.scope_kind !== 'private'
      || row?.type !== 'postgres' || row?.is_active !== true || row?.live !== true) {
      throw new Error('canonical private owner mirror missing')
    }
    return { connectionId: LEDGER_FIXTURE_CONNECTION_ID, connectionRevision: String(row.revision) }
  }
  async function confirmFixtureLedger(store: ReturnType<typeof stockPrepReadPlanStore>, scope: { tenantId: string; workspaceId: string | null; actor: string }, versionId: string) {
    const source = await canonicalPrivateSource()
    const begun = await store.beginValidation({ ...scope, id: versionId, source })
    expect(begun.status).toBe('pending')
    const finished = await store.finishValidation({
      ...scope, id: versionId, validationId: begun.validationId, source, counts: { ...FIXTURE_LEDGER_COUNTS },
    })
    expect(finished.status).toBe('passed')
    expect(finished.counts).toEqual({ ...FIXTURE_LEDGER_COUNTS })
    const confirmed = await store.confirmValidation({ ...scope, id: versionId, validationId: begun.validationId, source })
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.counts).toEqual({ ...FIXTURE_LEDGER_COUNTS })
    return confirmed
  }
  async function approvedStockPrepReadPlan(session: Session, maxReadCount = 200, workspaceId: string | null = null) {
    const store = stockPrepReadPlanStore(session)
    const scope = { tenantId: 't1', workspaceId, actor: 'consultant' }
    const version = await store.saveVersion({ ...scope, config: stockPrepReadPlanConfig('sys_1', maxReadCount) })
    await confirmFixtureLedger(store, scope, version.id)
    return store.approve({ ...scope, id: version.id })
  }
  async function makeStockPrepReadPlanSource() {
    // Real data_sources insert. zzzz20261001120000's triggers publish the private owner mirror;
    // this suite does not create or seed integration_data_source_validation_revisions itself.
    await owner.query(
      `INSERT INTO ${quotedIdentifier(DATA_SOURCES)}
         (id, name, type, config, owner_id, tenant_id, workspace_id, scope_kind, is_active, auto_connect)
       VALUES ($1, 'ledger fixture source', 'postgres', '{"ledgerFixture":true}'::jsonb, 'consultant', 't1', NULL, 'private', true, false)`,
      [LEDGER_FIXTURE_CONNECTION_ID],
    )
    await owner.query(
      `UPDATE ${quotedIdentifier(EXTERNAL_SYSTEMS)}
       SET kind = 'data-source:sql-readonly',
           connection_id = $1,
           config = jsonb_set(config, '{dataSourceId}', to_jsonb($1::text))
       WHERE id = 'sys_1'`,
      [LEDGER_FIXTURE_CONNECTION_ID],
    )
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
    whileParked?: () => Promise<void>,
  ) {
    const beforeInsert = pair.writer.gateBefore(insertPrefix)
    const writing = settle(write())
    await beforeInsert.reached
    const parkedIsolation = await isolationInside(pair.writer)
    const deletion = settle(registryOn(pair.deleter).deleteExternalSystem(deleteInput))
    const deleterWaited = await observeThenRelease(() => beforeInsert.release(), [writing, deletion], async () => {
      const waited = await waitsOnLock(pair.deleter.pid)
      if (whileParked) await whileParked()
      return waited
    })
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
    // 057 only — the "never ran 079 / 062 / 073 / 087" deployment P-ABSENT drives.
    schema057 = `${schema}_057only`
    await owner.query(`CREATE SCHEMA ${quotedIdentifier(schema057)}`)
    await owner.query(`SET search_path TO ${quotedIdentifier(schema057)}, public`)
    await owner.query(readFileSync(path.join(repoRoot, 'packages', 'core-backend', 'migrations', MIGRATIONS[0]), 'utf8'))
    await owner.query(`SET search_path TO ${quotedIdentifier(schema)}, public`)
    // Prerequisite tables and the ledger live only in this owned schema. 057-only stays without them.
    // The revision table comes from the real migration; this suite does not invent one.
    const scopedUrl = new URL(process.env.DATABASE_URL!)
    scopedUrl.searchParams.set('options', `-c search_path=${schema},public`)
    const migrationDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: scopedUrl.toString(), max: 1 }) }),
    })
    try {
      await createDataSourcesTable(migrationDb)
      await addConnectionBinding(migrationDb)
      await addLiveIdBindingLock(migrationDb)
      await addSourceValidationRevisions(migrationDb)
      await addValidationLedger(migrationDb)
    } finally {
      await migrationDb.destroy()
    }
    deleter = await openSession()
    writer = await openSession()
    secondWriter = await openSession()
    deleter057 = await openSession(schema057, undefined, { withPublic: false })
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
    // versions and activation both reference validations, and validations reference versions.
    await owner.query(`UPDATE ${quotedIdentifier(STOCK_PREP_READ_PLANS)} SET validation_id = NULL`)
    await owner.query(`DELETE FROM ${quotedIdentifier(STOCK_PREP_READ_PLAN_ACTIVATION)}`)
    await owner.query(`DELETE FROM ${quotedIdentifier(validationTable)}`)
    for (const table of [STOCK_PREP_READ_PLAN_AUDIT, STOCK_PREP_READ_PLAN_ACTIVATION, STOCK_PREP_READ_PLANS, PIPELINES, STOCK_PREP_BINDINGS, READ_SOURCE_AUDIT, READ_SOURCE_CONFIGS, SEALED_EXPORT_BINDINGS,
      'integration_sealed_export_authority_state', 'integration_sealed_export_signer_public_keys', TEMPLATES, EXTERNAL_SYSTEMS]) {
      await owner.query(`DELETE FROM ${quotedIdentifier(table)}`)
    }
    // External systems reference data_sources(live_id). Delete the Connection after the bindings.
    // The mirror trigger writes a tombstone; drop that too so the next insert republishes a live row.
    await owner.query(`DELETE FROM ${quotedIdentifier(DATA_SOURCES)}`)
    await owner.query(`DELETE FROM ${quotedIdentifier(sourceRevisionTable)}`)
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

  for (const entryPoint of ['pipeline', 'template'] as const) {
    it(`P-PIPE-ORDER-${entryPoint}: reverse endpoints wait on A before locking B, allowing the FOR UPDATE holder to acquire B NOWAIT`, async () => {
      await makeStockPrepReadPlanSource()
      // Both endpoint roles are legal. Share the real synthetic Connection published by the
      // fixture's migration trigger, as two read-plan bindings may do in production.
      await owner.query(
        `UPDATE ${quotedIdentifier(EXTERNAL_SYSTEMS)}
         SET role = 'bidirectional', kind = 'data-source:sql-readonly', connection_id = $1,
             config = jsonb_set(config, '{dataSourceId}', to_jsonb($1::text))
         WHERE id IN ('sys_1', 'sys_target')`,
        [LEDGER_FIXTURE_CONNECTION_ID],
      )
      await owner.query(
        `UPDATE ${quotedIdentifier(TEMPLATES)}
         SET source_kind = 'data-source:sql-readonly', target_kind = 'data-source:sql-readonly'
         WHERE id = 'tpl_1'`,
      )
      const reverseEndpoints = {
        tenantId: 't1', workspaceId: null, sourceSystemId: 'sys_target', targetSystemId: 'sys_1',
      }
      const write = entryPoint === 'pipeline'
        ? () => plugin.createPipelineRegistry({ db: writer.db }).upsertPipeline({
          ...reverseEndpoints, name: 'reverse endpoints', sourceObject: 'materials', targetObject: 't_material',
        })
        : () => plugin.createIntegrationTemplateRegistry({
          db: writer.db, externalSystemRegistry: registryOn(writer),
        }).instantiateTemplate({ ...reverseEndpoints, templateId: 'tpl_1', pipelineName: 'reverse endpoints' })

      await deleter.client.query('BEGIN')
      let writing: Promise<{ value: unknown; error: unknown }> | undefined
      try {
        // Model activation's sorted external-system lock prefix: A, then B. The real shared
        // writePipelineRow must wait at A even though this pipeline's source endpoint is B.
        await deleter.client.query(
          `SELECT id FROM ${quotedIdentifier(EXTERNAL_SYSTEMS)} WHERE id = 'sys_1' FOR UPDATE`,
        )
        writing = settle(write())
        const wait = await lockWait(writer.pid)
        expect(wait.blockedBy).toContain(deleter.pid)
        expect(wait.query.startsWith(`SELECT * FROM ${quotedIdentifier(EXTERNAL_SYSTEMS)} `)).toBe(true)
        expect(wait.query.endsWith(' FOR KEY SHARE')).toBe(true)

        // Mutation witness: source-first order already owns KEY SHARE(B), so this actual
        // PostgreSQL FOR UPDATE NOWAIT raises 55P03. Sorted order leaves B available.
        const acquired = await deleter.client.query(
          `SELECT id FROM ${quotedIdentifier(EXTERNAL_SYSTEMS)} WHERE id = 'sys_target' FOR UPDATE NOWAIT`,
        )
        expect(acquired.rows).toEqual([{ id: 'sys_target' }])
        expect(latestTransaction(writer).filter(statement => statement.endsWith(' FOR KEY SHARE'))).toHaveLength(1)
      } finally {
        await deleter.client.query('ROLLBACK')
        // Drain even a failed assertion/mutant so subsequent cases do not inherit transactions.
        if (writing) await writing
      }
      expect((await writing)?.error).toBeNull()
      expect(await count(PIPELINES, "source_system_id = 'sys_target' AND target_system_id = 'sys_1'")).toBe(1)
    })
  }

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

  it('P-ABSENT: a deployment that ran only 057 (no 079 / 062 / 073 / 087) still deletes — the absence is learned by the autocommit probe, never inside the FOR UPDATE transaction', async () => {
    const table057 = (name: string) => `${quotedIdentifier(schema057)}.${quotedIdentifier(name)}`
    for (const missing of [STOCK_PREP_BINDINGS, READ_SOURCE_CONFIGS, SEALED_EXPORT_BINDINGS, STOCK_PREP_READ_PLANS]) {
      const { rows } = await owner.query('SELECT to_regclass($1) AS rel', [`${schema057}.${missing}`])
      expect(rows[0].rel).toBeNull()
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
    // Shape of the run: the probe's four dependent tables (six status-specific statements) were
    // checked BEFORE `BEGIN`; inside the transaction only the pipeline counts ran.
    const issued = deleter057.statements.slice(issuedBefore)
    const begin = issued.indexOf('BEGIN')
    expect(begin).toBeGreaterThan(0)
    const dependentCount = (sql: string) => /^SELECT COUNT\(\*\)::int AS count FROM "integration_(stock_prep_source_binding|sealed_export_stock_prep_bindings|read_source_configs|stock_prep_read_plan_versions)"/.test(sql)
    expect(issued.slice(0, begin).filter(dependentCount)).toHaveLength(6)
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

  it('P-062-APPROVE-BETWEEN: a 062 approve (no system lock) commits between the delete side\'s two 062 COUNTs → the delete still refuses 409 with the row counted as draft AND as approved; system and config kept', async () => {
    const store = plugin.createReadSourceConfigStore({ db: writer.db })
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const minted = await store.saveVersion({ ...scope, config: readSourceConfig() })
    expect(minted.status).toBe('draft')
    const count062 = `SELECT COUNT(*)::int AS count FROM ${quotedIdentifier(READ_SOURCE_CONFIGS)}`
    const deleterFrom = deleter.statements.length
    // The SECOND 062 COUNT inside the delete transaction (the autocommit probe's two do not match).
    const beforeSecondCount = deleter.gateBefore(count062, { inTransaction: true, skip: 1 })
    const deletion = settle(registryOn(deleter).deleteExternalSystem(deleteInput))
    await beforeSecondCount.reached
    // The approve runs to COMMIT on another session while the delete holds FOR UPDATE and is parked.
    const approved = await settle(store.approve({ ...scope, id: minted.id }))
    beforeSecondCount.release()
    const deleted = await deletion
    // The outcome FIRST: M-ORDER (the two counts reversed) reports { systemRows: 0, approvedRows: 1 } here.
    expect({
      systemRows: await count(EXTERNAL_SYSTEMS, "id = 'sys_1'"),
      approvedRows: await count(READ_SOURCE_CONFIGS, "system_id = 'sys_1' AND status = 'approved'"),
    }).toEqual({ systemRows: 1, approvedRows: 1 })
    expect(approved.error).toBeNull()
    expect(approved.value.status).toBe('approved')
    expect({ name: deleted.error?.name, code: deleted.error?.code }).toEqual({ name: 'ExternalSystemConflictError', code: undefined })
    // Counted twice — as draft by the first COUNT, as approved by the second: the approve really
    // committed between them (before both: 1; after both: 1). An over-count only ever refuses.
    expect(deleted.error?.details?.readSourceConfigCount).toBe(2)
    const issued = deleter.statements.slice(deleterFrom)
    const begin = issued.indexOf('BEGIN')
    expect(begin).toBeGreaterThan(0)
    expect(issued.slice(begin).filter((sql) => sql.startsWith(count062))).toHaveLength(2)
  })

  it('P-087-A: delete first → real read-plan mint waits for the system row, refuses after delete, and leaves no version or audit', async () => {
    await makeStockPrepReadPlanSource()
    const { deleted, written, writerWaited } = await deleteFirst(stockPrepReadPlanMint(writer))
    expect(writerWaited).toBe(true)
    expect(deleted.error).toBeNull()
    expect({ name: written.error?.name, code: written.error?.code, status: written.error?.status })
      .toEqual({ name: 'StockPreparationReadPlanStoreError', code: 'READ_PLAN_SOURCE_INELIGIBLE', status: 409 })
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(0)
    expect(await count(STOCK_PREP_READ_PLANS, 'TRUE')).toBe(0)
    expect(await count(STOCK_PREP_READ_PLAN_AUDIT, 'TRUE')).toBe(0)
  })

  it('P-087-B: read-plan mint first → delete waits on KEY SHARE, counts the draft in another workspace, and refuses', async () => {
    await makeStockPrepReadPlanSource()
    const write = () => stockPrepReadPlanStore(writer).saveVersion({
      tenantId: 't1', workspaceId: 'other_workspace', actor: 'consultant', config: stockPrepReadPlanConfig(),
    })
    const { deleted, written, deleterWaited } = await writeFirst(write, `INSERT INTO ${quotedIdentifier(STOCK_PREP_READ_PLANS)}`)
    expect(deleterWaited).toBe(true)
    expect(written.error).toBeNull()
    expect({ name: deleted.error?.name, code: deleted.error?.code })
      .toEqual({ name: 'ExternalSystemConflictError', code: undefined })
    expect(deleted.error?.details?.stockPrepReadPlanCount).toBe(1)
    expect(deleted.error?.details?.readSourceConfigCount).toBe(0)
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(1)
    expect(await count(STOCK_PREP_READ_PLANS, "workspace_id = 'other_workspace' AND system_id = 'sys_1' AND status = 'draft'")).toBe(1)
  })

  it('P-087-C: approval waits on the source FOR UPDATE while delete holds it, so it cannot land between the draft and approved counts', async () => {
    await makeStockPrepReadPlanSource()
    const store = stockPrepReadPlanStore(writer)
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const version = await store.saveVersion({ ...scope, config: stockPrepReadPlanConfig() })
    await confirmFixtureLedger(store, scope, version.id)
    const count087 = `SELECT COUNT(*)::int AS count FROM ${quotedIdentifier(STOCK_PREP_READ_PLANS)}`
    const beforeApprovedCount = deleter.gateBefore(count087, { inTransaction: true, skip: 1 })
    const deletion = settle(registryOn(deleter).deleteExternalSystem(deleteInput))
    await beforeApprovedCount.reached
    const approved = settle(store.approve({ ...scope, id: version.id }))
    await observeThenRelease(() => beforeApprovedCount.release(), [approved, deletion], async () => {
      const wait = await lockWait(writer.pid)
      expectBlockedForUpdate(wait, deleter.pid, EXTERNAL_SYSTEMS)
      // The approve transaction has issued only the source lock. Mirror and version come after it.
      expect(forUpdateTables(latestTransaction(writer))).toEqual([EXTERNAL_SYSTEMS])
      expect(await count(STOCK_PREP_READ_PLANS, "id = $1 AND status = 'draft'", [version.id])).toBe(1)
      expect(await count(STOCK_PREP_READ_PLANS, "id = $1 AND status = 'approved'", [version.id])).toBe(0)
    })
    const [approvedResult, deleted] = await Promise.all([approved, deletion])
    expect(approvedResult.error).toBeNull()
    expect(approvedResult.value.status).toBe('approved')
    expect(forUpdateTables(latestTransaction(writer))).toEqual(approveLockOrder())
    expect(deleted.error?.name).toBe('ExternalSystemConflictError')
    // Draft was counted once. Approval did not commit while delete held the source, so the approved
    // count is 0 and the sum stays 1. The old double-count required an approval with no source lock.
    expect(deleted.error?.details?.stockPrepReadPlanCount).toBe(1)
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(1)
    expect(await count(STOCK_PREP_READ_PLANS, "system_id = 'sys_1' AND status = 'approved'")).toBe(1)
  })

  it('P-087-D: same content races reuse one version; different content races mint two distinct sequential versions', async () => {
    await makeStockPrepReadPlanSource()
    const prefix = `INSERT INTO ${quotedIdentifier(STOCK_PREP_READ_PLANS)}`
    async function mintRace(firstConfig: ReturnType<typeof stockPrepReadPlanConfig>, secondConfig: ReturnType<typeof stockPrepReadPlanConfig>) {
      const beforeInsert = writer.gateBefore(prefix, { inTransaction: true })
      const first = settle(stockPrepReadPlanMint(writer, firstConfig)())
      let second: typeof first | undefined
      try {
        // saveVersion takes FOR UPDATE on the source. Only the first writer can reach its
        // INSERT; the second must wait at that real lock before deciding reuse or next version.
        await Promise.race([
          beforeInsert.reached,
          first.then(() => { throw new Error('first mint finished before the insertion gate') }),
        ])
        second = settle(stockPrepReadPlanMint(secondWriter, secondConfig)())
        expectBlockedForUpdate(await lockWait(secondWriter.pid), writer.pid, EXTERNAL_SYSTEMS)
        expect(forUpdateTables(latestTransaction(secondWriter))).toEqual([EXTERNAL_SYSTEMS])
      } finally {
        beforeInsert.release()
        await Promise.all([first, ...(second ? [second] : [])])
      }
      if (!second) throw new Error('second mint was not started')
      return Promise.all([first, second])
    }
    const [first, second] = await mintRace(stockPrepReadPlanConfig(), stockPrepReadPlanConfig())
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect(first.value.id).toBe(second.value.id)
    expect(await count(STOCK_PREP_READ_PLANS, "system_id = 'sys_1'")).toBe(1)
    expect(await count(STOCK_PREP_READ_PLAN_AUDIT, "version_id = $1", [first.value.id])).toBe(2)

    const [third, fourth] = await mintRace(stockPrepReadPlanConfig('sys_1', 201), stockPrepReadPlanConfig('sys_1', 202))
    expect(third.error).toBeNull()
    expect(fourth.error).toBeNull()
    expect(new Set([third.value.version, fourth.value.version])).toEqual(new Set([2, 3]))
    expect(await count(STOCK_PREP_READ_PLANS, "system_id = 'sys_1'")).toBe(3)
  })

  it('P-087-E: exact scope/action/system and approval govern reads; a retired content key cannot be revived', async () => {
    await makeStockPrepReadPlanSource()
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const store = stockPrepReadPlanStore(writer)
    const version = await store.saveVersion({ ...scope, config: stockPrepReadPlanConfig() })
    expect(version.status).toBe('draft')
    expect(await store.get({ tenantId: 't2', workspaceId: null, id: version.id })).toBeNull()
    expect(await store.get({ tenantId: 't1', workspaceId: 'other_workspace', id: version.id })).toBeNull()
    expect(await store.list({ scope: { tenantId: 't1', workspaceId: 'other_workspace' } })).toEqual([])
    await expect(store.get({ tenantId: 't1', id: version.id })).rejects.toMatchObject({ code: 'READ_PLAN_SCOPE_INVALID' })
    await expect(store.saveVersion({ tenantId: 't1', actor: 'consultant', config: stockPrepReadPlanConfig() }))
      .rejects.toMatchObject({ code: 'READ_PLAN_SCOPE_INVALID' })
    await expect(store.approve({ ...scope, actor: '', id: version.id })).rejects.toMatchObject({ code: 'READ_PLAN_ACTOR_INVALID' })
    const runtime = (overrides: Record<string, unknown> = {}) => store.getForRuntime({
      tenantId: 't1', workspaceId: null, id: version.id, actionId: ACTION_ID, systemId: 'sys_1', ...overrides,
    })
    await expect(runtime()).rejects.toMatchObject({ code: 'READ_PLAN_NOT_APPROVED' })
    await expect(store.approve({ ...scope, id: version.id })).rejects.toMatchObject({ code: 'READ_PLAN_VALIDATION_REQUIRED' })
    await confirmFixtureLedger(store, scope, version.id)
    await store.approve({ ...scope, id: version.id })
    expect((await runtime()).status).toBe('approved')
    await expect(runtime({ tenantId: 't2' })).rejects.toMatchObject({ code: 'READ_PLAN_NOT_FOUND' })
    await expect(runtime({ workspaceId: 'other_workspace' })).rejects.toMatchObject({ code: 'READ_PLAN_NOT_FOUND' })
    await expect(runtime({ actionId: 'other.action' })).rejects.toMatchObject({ code: 'READ_PLAN_NOT_FOUND' })
    await expect(runtime({ systemId: 'other_system' })).rejects.toMatchObject({ code: 'READ_PLAN_NOT_FOUND' })
    await store.retire({ ...scope, id: version.id })
    await expect(runtime()).rejects.toMatchObject({ code: 'READ_PLAN_NOT_APPROVED' })
    await expect(store.saveVersion({ ...scope, config: stockPrepReadPlanConfig() }))
      .rejects.toMatchObject({ code: 'READ_PLAN_CONTENT_RETIRED' })
    expect((await store.listAudit({ tenantId: 't1', workspaceId: null, id: version.id })).map((row) => row.action).sort())
      .toEqual(['save_version', 'status_change', 'status_change', 'validation_begin', 'validation_confirm', 'validation_finish'])
    expect(await count(STOCK_PREP_READ_PLANS, "system_id = 'sys_1'")).toBe(1)
  })

  it('P-087-F: audit insertion failure rolls back both a new version and an approval status change', async () => {
    await makeStockPrepReadPlanSource()
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const store = stockPrepReadPlanStore(writer)
    const version = await store.saveVersion({ ...scope, config: stockPrepReadPlanConfig() })
    await confirmFixtureLedger(store, scope, version.id)
    await owner.query(`ALTER TABLE ${quotedIdentifier(STOCK_PREP_READ_PLAN_AUDIT)} ADD CONSTRAINT reject_087_audit CHECK (false) NOT VALID`)
    try {
      await expect(store.saveVersion({ ...scope, config: stockPrepReadPlanConfig('sys_1', 201) })).rejects.toBeTruthy()
      expect(await count(STOCK_PREP_READ_PLANS, "system_id = 'sys_1'")).toBe(1)
      await expect(store.approve({ ...scope, id: version.id })).rejects.toBeTruthy()
      expect((await store.get({ tenantId: 't1', workspaceId: null, id: version.id })).status).toBe('draft')
      expect(await count(STOCK_PREP_READ_PLAN_AUDIT, 'TRUE')).toBe(4)
      expect(await count(STOCK_PREP_READ_PLAN_AUDIT, "action = 'status_change'")).toBe(0)
      expect(await count(validationTable, "version_id = $1 AND status = 'confirmed'", [version.id])).toBe(1)
    } finally {
      await owner.query(`ALTER TABLE ${quotedIdentifier(STOCK_PREP_READ_PLAN_AUDIT)} DROP CONSTRAINT reject_087_audit`)
    }
  })

  it('P-087-G: two approvals serialize on the source FOR UPDATE; one success, one status conflict, one transition audit', async () => {
    await makeStockPrepReadPlanSource()
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const store = stockPrepReadPlanStore(writer)
    const version = await store.saveVersion({ ...scope, config: stockPrepReadPlanConfig() })
    await confirmFixtureLedger(store, scope, version.id)
    // The first approval already holds source, mirror, version, and receipt, and parks before the
    // status UPDATE. The second blocks on the source FOR UPDATE, which is taken before the version.
    const beforeUpdate = writer.gateBefore(`UPDATE ${quotedIdentifier(STOCK_PREP_READ_PLANS)}`, { inTransaction: true })
    const a = settle(stockPrepReadPlanStore(writer).approve({ ...scope, id: version.id }))
    await beforeUpdate.reached
    const b = settle(stockPrepReadPlanStore(secondWriter).approve({ ...scope, id: version.id }))
    await observeThenRelease(() => beforeUpdate.release(), [a, b], async () => {
      expectBlockedForUpdate(await lockWait(secondWriter.pid), writer.pid, EXTERNAL_SYSTEMS)
      expect(forUpdateTables(latestTransaction(writer))).toEqual(approveLockOrder())
      expect(forUpdateTables(latestTransaction(secondWriter))).toEqual([EXTERNAL_SYSTEMS])
    })
    const results = await Promise.all([a, b])
    expect(results.filter((result) => result.error === null)).toHaveLength(1)
    expect(results.filter((result) => result.error?.code === 'READ_PLAN_STATUS_CONFLICT')).toHaveLength(1)
    expect(await count(STOCK_PREP_READ_PLANS, "id = $1 AND status = 'approved'", [version.id])).toBe(1)
    expect(await count(STOCK_PREP_READ_PLAN_AUDIT, "version_id = $1 AND action = 'status_change'", [version.id])).toBe(1)
  })

  it('P-087-ACT-1: activation is exact-scoped and generation-fenced through disable/reactivate; retirement closes runtime and reactivation', async () => {
    await makeStockPrepReadPlanSource()
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const store = stockPrepReadPlanStore(writer)
    expect(await store.getActivation({ ...scope, actionId: ACTION_ID })).toBeNull()
    expect(await store.getActiveForRuntime({ ...scope, actionId: ACTION_ID, systemId: 'sys_1' })).toBeNull()
    const version = await approvedStockPrepReadPlan(writer)
    await expect(store.activate({ ...scope, id: version.id, expectedGeneration: 1 }))
      .rejects.toMatchObject({ code: 'READ_PLAN_GENERATION_CONFLICT' })
    const active = await store.activate({ ...scope, id: version.id, expectedGeneration: 0 })
    expect({ versionId: active.versionId, status: active.status, generation: active.generation })
      .toEqual({ versionId: version.id, status: 'active', generation: 1 })
    expect((await store.getActiveForRuntime({ ...scope, actionId: ACTION_ID, systemId: 'sys_1', expectedGeneration: 1 })).version.id)
      .toBe(version.id)
    expect(await store.getActivation({ tenantId: 't2', workspaceId: null, actionId: ACTION_ID })).toBeNull()
    expect(await store.getActivation({ tenantId: 't1', workspaceId: 'other_workspace', actionId: ACTION_ID })).toBeNull()
    expect(await store.getActiveForRuntime({ tenantId: 't1', workspaceId: 'other_workspace', actionId: ACTION_ID, systemId: 'sys_1' }))
      .toBeNull()
    await expect(store.getActiveForRuntime({ ...scope, actionId: ACTION_ID, systemId: 'other_system' }))
      .rejects.toMatchObject({ code: 'READ_PLAN_ACTIVATION_SOURCE_MISMATCH' })
    await expect(store.getActiveForRuntime({ ...scope, actionId: ACTION_ID, systemId: 'sys_1', expectedGeneration: 0 }))
      .rejects.toMatchObject({ code: 'READ_PLAN_GENERATION_CONFLICT' })
    await expect(store.deactivate({ ...scope, actionId: ACTION_ID, expectedGeneration: 0 }))
      .rejects.toMatchObject({ code: 'READ_PLAN_GENERATION_CONFLICT' })
    const disabled = await store.deactivate({ ...scope, actionId: ACTION_ID, expectedGeneration: 1 })
    expect({ id: disabled.id, versionId: disabled.versionId, generation: disabled.generation, status: disabled.status })
      .toEqual({ id: active.id, versionId: version.id, generation: 2, status: 'disabled' })
    await expect(store.getActiveForRuntime({ ...scope, actionId: ACTION_ID, systemId: 'sys_1' }))
      .rejects.toMatchObject({ code: 'READ_PLAN_ACTIVATION_DISABLED' })
    const again = await store.activate({ ...scope, id: version.id, expectedGeneration: 2 })
    expect({ id: again.id, generation: again.generation, status: again.status })
      .toEqual({ id: active.id, generation: 3, status: 'active' })
    const audit = await store.listAudit({ ...scope, id: version.id })
    expect(audit.filter((row) => row.action === 'activate' || row.action === 'deactivate')
      .map((row) => ({ action: row.action, detail: row.detail })).sort((a, b) => a.detail.generation - b.detail.generation))
      .toEqual([
        { action: 'activate', detail: { previousGeneration: 0, generation: 1 } },
        { action: 'deactivate', detail: { previousGeneration: 1, generation: 2 } },
        { action: 'activate', detail: { previousGeneration: 2, generation: 3 } },
      ])
    await store.retire({ ...scope, id: version.id })
    await expect(store.getActiveForRuntime({ ...scope, actionId: ACTION_ID, systemId: 'sys_1' }))
      .rejects.toMatchObject({ code: 'READ_PLAN_NOT_APPROVED' })
    await expect(store.activate({ ...scope, id: version.id, expectedGeneration: 3 }))
      .rejects.toMatchObject({ code: 'READ_PLAN_NOT_APPROVED' })
    expect((await store.getActivation({ ...scope, actionId: ACTION_ID })).generation).toBe(3)
  })

  it('P-087-ACT-2: two first activations serialize on the source FOR UPDATE; only one inserts a generation-1 pointer and audit', async () => {
    await makeStockPrepReadPlanSource()
    const version = await approvedStockPrepReadPlan(writer)
    const input = { tenantId: 't1', workspaceId: null, id: version.id, actor: 'consultant', expectedGeneration: 0 }
    const beforeInsert = writer.gateBefore(`INSERT INTO ${quotedIdentifier(STOCK_PREP_READ_PLAN_ACTIVATION)}`, { inTransaction: true })
    const first = settle(stockPrepReadPlanStore(writer).activate(input))
    await beforeInsert.reached
    const second = settle(stockPrepReadPlanStore(secondWriter).activate(input))
    await observeThenRelease(() => beforeInsert.release(), [first, second], async () => {
      expectBlockedForUpdate(await lockWait(secondWriter.pid), writer.pid, EXTERNAL_SYSTEMS)
      expect(forUpdateTables(latestTransaction(writer))).toEqual(activateLockOrder())
      expect(forUpdateTables(latestTransaction(secondWriter))).toEqual([EXTERNAL_SYSTEMS])
    })
    const results = await Promise.all([first, second])
    expect(results.filter((result) => result.error === null)).toHaveLength(1)
    expect(results.filter((result) => result.error?.code === 'READ_PLAN_GENERATION_CONFLICT')).toHaveLength(1)
    expect(await count(STOCK_PREP_READ_PLAN_ACTIVATION, "action_id = $1 AND generation = 1 AND status = 'active'", [ACTION_ID])).toBe(1)
    expect(await count(STOCK_PREP_READ_PLAN_AUDIT, "version_id = $1 AND action = 'activate'", [version.id])).toBe(1)
  })

  it('P-087-ACT-3: concurrent reactivations with the same old generation have one winner, one conflict and one increment audit', async () => {
    await makeStockPrepReadPlanSource()
    const version = await approvedStockPrepReadPlan(writer)
    const input = { tenantId: 't1', workspaceId: null, id: version.id, actor: 'consultant' }
    await stockPrepReadPlanStore(writer).activate({ ...input, expectedGeneration: 0 })
    const beforeUpdate = writer.gateBefore(`UPDATE ${quotedIdentifier(STOCK_PREP_READ_PLAN_ACTIVATION)}`, { inTransaction: true })
    const first = settle(stockPrepReadPlanStore(writer).activate({ ...input, expectedGeneration: 1 }))
    await beforeUpdate.reached
    const second = settle(stockPrepReadPlanStore(secondWriter).activate({ ...input, expectedGeneration: 1 }))
    await observeThenRelease(() => beforeUpdate.release(), [first, second], async () => {
      expectBlockedForUpdate(await lockWait(secondWriter.pid), writer.pid, EXTERNAL_SYSTEMS)
      expect(forUpdateTables(latestTransaction(secondWriter))).toEqual([EXTERNAL_SYSTEMS])
    })
    const results = await Promise.all([first, second])
    expect(results.filter((result) => result.error === null)).toHaveLength(1)
    expect(results.filter((result) => result.error?.code === 'READ_PLAN_GENERATION_CONFLICT')).toHaveLength(1)
    expect((await stockPrepReadPlanStore(writer).getActivation({ ...input, actionId: ACTION_ID })).generation).toBe(2)
    expect(await count(STOCK_PREP_READ_PLAN_AUDIT, "version_id = $1 AND action = 'activate'", [version.id])).toBe(2)
  })

  it('P-087-ACT-4: retire holds source then version; activation waits on the source and refuses the retired version', async () => {
    await makeStockPrepReadPlanSource()
    const version = await approvedStockPrepReadPlan(writer)
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    // Retirement cleanup takes source, mirror, then version. Activation must wait on the source
    // before it can lock the mirror or version and observe the committed retired status.
    const beforeRetireUpdate = writer.gateBefore(`UPDATE ${quotedIdentifier(STOCK_PREP_READ_PLANS)}`, { inTransaction: true })
    const retiring = settle(stockPrepReadPlanStore(writer).retire({ ...scope, id: version.id }))
    await beforeRetireUpdate.reached
    const activating = settle(stockPrepReadPlanStore(secondWriter).activate({ ...scope, id: version.id, expectedGeneration: 0 }))
    await observeThenRelease(() => beforeRetireUpdate.release(), [retiring, activating], async () => {
      expectBlockedForUpdate(await lockWait(secondWriter.pid), writer.pid, EXTERNAL_SYSTEMS)
      expect(forUpdateTables(latestTransaction(secondWriter))).toEqual([EXTERNAL_SYSTEMS])
      expect(forUpdateTables(latestTransaction(writer))).toEqual([EXTERNAL_SYSTEMS, sourceRevisionTable, STOCK_PREP_READ_PLANS])
    })
    const [retired, active] = await Promise.all([retiring, activating])
    expect(retired.error).toBeNull()
    expect(active.error?.code).toBe('READ_PLAN_NOT_APPROVED')
    expect(await count(STOCK_PREP_READ_PLAN_ACTIVATION, 'TRUE')).toBe(0)
  })

  it('P-087-ACT-5: activation holds source then version; retirement waits on the source, then runtime refuses the retired active version', async () => {
    await makeStockPrepReadPlanSource()
    const version = await approvedStockPrepReadPlan(writer)
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const beforeInsert = writer.gateBefore(`INSERT INTO ${quotedIdentifier(STOCK_PREP_READ_PLAN_ACTIVATION)}`, { inTransaction: true })
    const activating = settle(stockPrepReadPlanStore(writer).activate({ ...scope, id: version.id, expectedGeneration: 0 }))
    await beforeInsert.reached
    const retiring = settle(stockPrepReadPlanStore(secondWriter).retire({ ...scope, id: version.id }))
    await observeThenRelease(() => beforeInsert.release(), [activating, retiring], async () => {
      expectBlockedForUpdate(await lockWait(secondWriter.pid), writer.pid, EXTERNAL_SYSTEMS)
      expect(forUpdateTables(latestTransaction(writer))).toEqual(activateLockOrder())
      expect(forUpdateTables(latestTransaction(secondWriter))).toEqual([EXTERNAL_SYSTEMS])
    })
    const [active, retired] = await Promise.all([activating, retiring])
    expect(active.error).toBeNull()
    expect(retired.error).toBeNull()
    expect((await stockPrepReadPlanStore(writer).getActivation({ ...scope, actionId: ACTION_ID })).generation).toBe(1)
    await expect(stockPrepReadPlanStore(writer).getActiveForRuntime({ ...scope, actionId: ACTION_ID, systemId: 'sys_1' }))
      .rejects.toMatchObject({ code: 'READ_PLAN_NOT_APPROVED' })
  })

  it('P-087-ACT-6: audit insert failure rolls back first pointer insertion and a later generation update', async () => {
    await makeStockPrepReadPlanSource()
    const version = await approvedStockPrepReadPlan(writer)
    const input = { tenantId: 't1', workspaceId: null, id: version.id, actor: 'consultant' }
    const store = stockPrepReadPlanStore(writer)
    const rejectAudit = `ALTER TABLE ${quotedIdentifier(STOCK_PREP_READ_PLAN_AUDIT)} ADD CONSTRAINT reject_087_activation_audit CHECK (false) NOT VALID`
    const acceptAudit = `ALTER TABLE ${quotedIdentifier(STOCK_PREP_READ_PLAN_AUDIT)} DROP CONSTRAINT reject_087_activation_audit`
    await owner.query(rejectAudit)
    try {
      await expect(store.activate({ ...input, expectedGeneration: 0 })).rejects.toBeTruthy()
      expect(await count(STOCK_PREP_READ_PLAN_ACTIVATION, 'TRUE')).toBe(0)
    } finally {
      await owner.query(acceptAudit)
    }
    const active = await store.activate({ ...input, expectedGeneration: 0 })
    await owner.query(rejectAudit)
    try {
      await expect(store.deactivate({ ...input, actionId: ACTION_ID, expectedGeneration: 1 })).rejects.toBeTruthy()
      await expect(store.activate({ ...input, expectedGeneration: 1 })).rejects.toBeTruthy()
      expect((await store.getActivation({ ...input, actionId: ACTION_ID })).generation).toBe(1)
      expect((await store.getActivation({ ...input, actionId: ACTION_ID })).status).toBe('active')
      expect(await count(STOCK_PREP_READ_PLAN_AUDIT, "version_id = $1 AND action = 'activate'", [version.id])).toBe(1)
      expect(await count(STOCK_PREP_READ_PLAN_AUDIT, "version_id = $1 AND action = 'deactivate'", [version.id])).toBe(0)
      expect(active.generation).toBe(1)
    } finally {
      await owner.query(acceptAudit)
    }
  })

  it('P-087-ACT-7: source delete waits for activation source FOR UPDATE, then still refuses the approved version', async () => {
    await makeStockPrepReadPlanSource()
    const version = await approvedStockPrepReadPlan(writer)
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const { deleted, written, deleterWaited } = await writeFirst(
      () => stockPrepReadPlanStore(writer).activate({ ...scope, id: version.id, expectedGeneration: 0 }),
      `INSERT INTO ${quotedIdentifier(STOCK_PREP_READ_PLAN_ACTIVATION)}`,
      { deleter, writer },
      async () => {
        expectBlockedForUpdate(await lockWait(deleter.pid), writer.pid, EXTERNAL_SYSTEMS)
      },
    )
    expect(deleterWaited).toBe(true)
    expect(written.error).toBeNull()
    expect(deleted.error?.name).toBe('ExternalSystemConflictError')
    expect(deleted.error?.details?.stockPrepReadPlanCount).toBe(1)
    expect(await count(EXTERNAL_SYSTEMS, "id = 'sys_1'")).toBe(1)
    expect(await count(STOCK_PREP_READ_PLAN_ACTIVATION, "version_id = $1 AND status = 'active'", [version.id])).toBe(1)
  })

  it('P-087-ACT-8: deactivate first holds source through pointer, cross-version activate waits on source and conflicts without deadlock', async () => {
    await makeStockPrepReadPlanSource()
    const firstVersion = await approvedStockPrepReadPlan(writer)
    const secondVersion = await approvedStockPrepReadPlan(writer, 201)
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const store = stockPrepReadPlanStore(writer)
    await store.activate({ ...scope, id: firstVersion.id, expectedGeneration: 0 })
    // Both versions share a source. Deactivate holds source -> mirror -> version -> pointer;
    // cross-version activation must wait at the source before reading the advanced generation.
    const beforeDisableUpdate = writer.gateBefore(`UPDATE ${quotedIdentifier(STOCK_PREP_READ_PLAN_ACTIVATION)}`, { inTransaction: true })
    const disabling = settle(store.deactivate({ ...scope, actionId: ACTION_ID, expectedGeneration: 1 }))
    await beforeDisableUpdate.reached
    const activating = settle(stockPrepReadPlanStore(secondWriter).activate({
      ...scope, id: secondVersion.id, expectedGeneration: 1,
    }))
    await observeThenRelease(() => beforeDisableUpdate.release(), [disabling, activating], async () => {
      expectBlockedForUpdate(await lockWait(secondWriter.pid), writer.pid, EXTERNAL_SYSTEMS)
      expect(forUpdateTables(latestTransaction(secondWriter))).toEqual([EXTERNAL_SYSTEMS])
      expect(forUpdateTables(latestTransaction(writer))).toEqual([EXTERNAL_SYSTEMS, sourceRevisionTable, STOCK_PREP_READ_PLANS, STOCK_PREP_READ_PLAN_ACTIVATION])
    })
    const [disabled, active] = await Promise.all([disabling, activating])
    expect(disabled.error).toBeNull()
    expect(active.error?.code).toBe('READ_PLAN_GENERATION_CONFLICT')
    expect((await store.getActivation({ ...scope, actionId: ACTION_ID })).status).toBe('disabled')
    expect((await store.getActivation({ ...scope, actionId: ACTION_ID })).generation).toBe(2)
    expect(await count(STOCK_PREP_READ_PLAN_AUDIT, "version_id = $1 AND action = 'activate'", [secondVersion.id])).toBe(0)
  })

  it('P-087-ACT-9: cross-version activate first holds source through pointer, deactivate waits on source and conflicts without deadlock', async () => {
    await makeStockPrepReadPlanSource()
    const firstVersion = await approvedStockPrepReadPlan(writer)
    const secondVersion = await approvedStockPrepReadPlan(writer, 201)
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    const store = stockPrepReadPlanStore(writer)
    await store.activate({ ...scope, id: firstVersion.id, expectedGeneration: 0 })
    const beforeActivateUpdate = writer.gateBefore(`UPDATE ${quotedIdentifier(STOCK_PREP_READ_PLAN_ACTIVATION)}`, { inTransaction: true })
    const activating = settle(store.activate({ ...scope, id: secondVersion.id, expectedGeneration: 1 }))
    await beforeActivateUpdate.reached
    const disabling = settle(stockPrepReadPlanStore(secondWriter).deactivate({
      ...scope, actionId: ACTION_ID, expectedGeneration: 1,
    }))
    // Activation holds source -> mirror -> version -> receipt -> pointer. Deactivate's cleanup
    // waits on the same source before it can lock the previous version and recheck the pointer.
    await observeThenRelease(() => beforeActivateUpdate.release(), [activating, disabling], async () => {
      expectBlockedForUpdate(await lockWait(secondWriter.pid), writer.pid, EXTERNAL_SYSTEMS)
      expect(forUpdateTables(latestTransaction(writer))).toEqual(activateLockOrder())
      expect(forUpdateTables(latestTransaction(secondWriter))).toEqual([EXTERNAL_SYSTEMS])
    })
    const [active, disabled] = await Promise.all([activating, disabling])
    expect(active.error).toBeNull()
    expect(disabled.error?.code).toBe('READ_PLAN_GENERATION_CONFLICT')
    const pointer = await store.getActivation({ ...scope, actionId: ACTION_ID })
    expect({ versionId: pointer.versionId, generation: pointer.generation, status: pointer.status })
      .toEqual({ versionId: secondVersion.id, generation: 2, status: 'active' })
    expect(await count(STOCK_PREP_READ_PLAN_AUDIT, "version_id = $1 AND action = 'deactivate'", [firstVersion.id])).toBe(0)
  })

  it('P-087-ACT-10: same-source activations serialize on the source FOR UPDATE before either pointer insert; the waiter then conflicts on generation', async () => {
    await makeStockPrepReadPlanSource()
    const firstVersion = await approvedStockPrepReadPlan(writer)
    const secondVersion = await approvedStockPrepReadPlan(secondWriter, 201)
    const scope = { tenantId: 't1', workspaceId: null, actor: 'consultant' }
    // Both versions name sys_1. The first has inserted the scope pointer and holds the source
    // FOR UPDATE through its audit insert. The second cannot reach its own pointer insert, so this
    // is not the activation-scope unique-index race. After the first commits, the second reads the
    // generation-1 pointer and conflicts.
    const activationInsert = `INSERT INTO ${quotedIdentifier(STOCK_PREP_READ_PLAN_ACTIVATION)}`
    const beforeFirstAudit = writer.gateBefore(`INSERT INTO ${quotedIdentifier(STOCK_PREP_READ_PLAN_AUDIT)}`, { inTransaction: true })
    const first = settle(stockPrepReadPlanStore(writer).activate({ ...scope, id: firstVersion.id, expectedGeneration: 0 }))
    await beforeFirstAudit.reached
    const second = settle(stockPrepReadPlanStore(secondWriter).activate({ ...scope, id: secondVersion.id, expectedGeneration: 0 }))
    await observeThenRelease(() => beforeFirstAudit.release(), [first, second], async () => {
      expectBlockedForUpdate(await lockWait(secondWriter.pid), writer.pid, EXTERNAL_SYSTEMS)
      expect(forUpdateTables(latestTransaction(writer))).toEqual(activateLockOrder())
      expect(latestTransaction(writer).some((statement) => statement.startsWith(activationInsert))).toBe(true)
      expect(forUpdateTables(latestTransaction(secondWriter))).toEqual([EXTERNAL_SYSTEMS])
      expect(secondWriter.statements.some((statement) => statement.startsWith(activationInsert))).toBe(false)
    })
    const results = await Promise.all([first, second])
    expect(results[0].error).toBeNull()
    expect(results[1].error?.code).toBe('READ_PLAN_GENERATION_CONFLICT')
    expect(forUpdateTables(latestTransaction(secondWriter))).toEqual(activateLockOrder())
    expect(latestTransaction(secondWriter).some((statement) => statement.startsWith(activationInsert))).toBe(false)
    expect(await count(STOCK_PREP_READ_PLAN_ACTIVATION, "action_id = $1 AND generation = 1", [ACTION_ID])).toBe(1)
    expect(await count(STOCK_PREP_READ_PLAN_AUDIT, "action = 'activate'")).toBe(1)
    expect((await stockPrepReadPlanStore(writer).getActivation({ ...scope, actionId: ACTION_ID })).versionId).toBe(firstVersion.id)
  })

  // ------------------------------------------------------------------------------------------------
  // I-RR-* / I-SER-* — the isolation pin under hostile server defaults (see the header).
  // ------------------------------------------------------------------------------------------------
  const PROTOCOL_WRITERS = [
    {
      tag: '087',
      label: 'stock-prep read-plan mint',
      prepare: makeStockPrepReadPlanSource,
      write: (session: Session) => stockPrepReadPlanMint(session),
      insertPrefix: `INSERT INTO ${quotedIdentifier(STOCK_PREP_READ_PLANS)}`,
      pointerTable: STOCK_PREP_READ_PLANS,
      pointerWhere: "system_id = 'sys_1'",
      countKey: 'stockPrepReadPlanCount',
      assertOwnRefusal: (error: { name?: string; code?: string; status?: number } | null) => {
        expect(error?.name).toBe('StockPreparationReadPlanStoreError')
        expect(error?.code).toBe('READ_PLAN_SOURCE_INELIGIBLE')
        expect(error?.status).toBe(409)
      },
    },
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
        if ('prepare' in spec) await spec.prepare()
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
        if ('prepare' in spec) await spec.prepare()
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
        // name AND code, so a regression reports the SQLSTATE it surfaced (e.g. SSI's 40001), not just "error"
        expect({ name: deleted.error?.name, code: deleted.error?.code }).toEqual({ name: 'ExternalSystemConflictError', code: undefined })
        expect(deleted.error?.details?.[spec.countKey]).toBe(1)
        expect(parkedIsolation).toBe('read committed') // observed INSIDE the parked writer transaction
        expect(pinnedAfterEveryBegin(pair.deleter, deleterFrom)).toEqual({ begins: 1, pinned: 1 })
        expect(pinnedAfterEveryBegin(pair.writer, writerFrom)).toEqual({ begins: 1, pinned: 1 })
      })
    }
  }
})

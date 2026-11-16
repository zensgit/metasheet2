/**
 * C1/S2 first slice — the synthetic integration preview admission protocol against a REAL PostgreSQL
 * (evidence D §7 C03, C04, S02 and the runtime half of C01). Every subject, rule, sheet and grant is
 * synthetic and confined to a new random schema that this file creates and drops. The provider is the
 * host-registered synthetic provider (wrapped only to count calls); the compiler is the production loader
 * of compileYidaLocalDraft; the summary writer is AutomationLogService.recordSyntheticPreviewSummary.
 *
 * Interleavings use barriers (a hook that awaits a promise the test resolves, and a pg_stat_activity
 * wait-state condition), never a fixed sleep.
 */
import { randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createAutomationSyntheticPreviewRuntime,
  syntheticPreviewErrorCode,
  type SyntheticPreviewRuntimeDependencies,
} from '../../src/integration/automation-synthetic-preview'
import { createSyntheticMaterialProvider, SYNTHETIC_MATERIAL_PROVIDER_ID, type SyntheticProviderPageRequest } from '../../src/integration/automation-operation-catalog'
import { loadYidaLocalDraftCompiler } from '../../src/integration/yida-automation-preview'
import { AutomationLogService } from '../../src/multitable/automation-log-service'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECT_DB must actually provide a database', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const ACTOR = 'synthetic-preview-actor'
const OTHER = 'synthetic-preview-other'
const TENANT = 'synthetic-preview-tenant'
const SHEET = 'synthetic-preview-sheet'
const OTHER_SHEET = 'synthetic-preview-sheet-2'
const RULE = 'synthetic-preview-rule'
const scope = { actorId: ACTOR, tenantId: TENANT, sheetId: SHEET, ruleId: RULE }
const BODY = { planId: 'plm-material-to-yida-preview.v1', fixtureId: 'synthetic-materials.two-page.v1', mappingPresetId: 'yida-material-v3.original.v1' }
// Values that exist only in the synthetic fixture rows.
const VALUE_MARKERS = /SYN-DRW|SYN-LINE|SYN-SPEC|合成部件|SYN-MAT/

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise } catch (error) { return syntheticPreviewErrorCode(error) ?? 'FOREIGN' }
  return 'RESOLVED'
}

describeDatabase('synthetic integration preview: real PostgreSQL admission, revocation and isolation', () => {
  const schema = `automation_preview_${randomBytes(8).toString('hex')}`
  let pool: Pool
  let admin: PoolClient
  let revoker: PoolClient
  let blocker: PoolClient
  let observer: PoolClient
  let revokerPid: number
  const logService = new AutomationLogService()
  let beforeCommit: ((index: number, client: PoolClient) => Promise<void>) | undefined
  let lockTimeout = '5s'
  let transactionIndex = 0
  const providerCalls: SyntheticProviderPageRequest[] = []

  const database: SyntheticPreviewRuntimeDependencies['database'] = {
    async transaction(work) {
      const index = ++transactionIndex
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await client.query(`SET LOCAL search_path TO "${schema}"`)
        await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`)
        const trx: Queryable = { query: (sql: string, params?: unknown[]) => client.query(sql, params) as never }
        const result = await work(trx)
        if (beforeCommit) await beforeCommit(index, client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  }

  function runtime(hooks?: SyntheticPreviewRuntimeDependencies['hooks']) {
    const real = createSyntheticMaterialProvider()
    return createAutomationSyntheticPreviewRuntime({
      database,
      readEnablement: () => 'true',
      loadCompiler: loadYidaLocalDraftCompiler,
      recordSummary: (trx, entry) => logService.recordSyntheticPreviewSummary((sql, params) => trx.query(sql, params), entry),
      provider: Object.freeze({
        id: SYNTHETIC_MATERIAL_PROVIDER_ID,
        readPage: (request: SyntheticProviderPageRequest) => {
          providerCalls.push(request)
          return real.readPage(request)
        },
      }),
      hooks,
    })
  }

  async function executions() {
    return (await admin.query('SELECT * FROM multitable_automation_executions ORDER BY triggered_at')).rows as Array<Record<string, unknown>>
  }

  async function tableCounts(): Promise<Record<string, number>> {
    const tables = (await admin.query(
      'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name', [schema],
    )).rows as Array<{ name: string }>
    const counts: Record<string, number> = {}
    for (const { name } of tables) {
      if (!/^[a-z_]+$/u.test(name)) throw new Error('unexpected table name')
      counts[name] = Number((await admin.query(`SELECT count(*)::int AS n FROM "${name}"`)).rows[0].n)
    }
    return counts
  }

  async function waitUntilBlocked(pid: number): Promise<void> {
    // Condition barrier: the revoker's statement is waiting on a row lock held by the admission.
    // Bounded by wall time (5 s, polled every 5 ms), not by an iteration count.
    const deadline = Date.now() + 5_000
    for (;;) {
      const state = (await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0]
      if (state?.wait_event_type === 'Lock') return
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('revoker never waited on the admission lock')
  }

  beforeAll(async () => {
    if (!/^automation_preview_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid owned schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    // Columns/keys mirror the relations the admission and the summary writer actually touch.
    // platform_member_group_members is deliberately absent: the optional-relation path is exercised.
    await admin.query(`
      CREATE TABLE users (id text PRIMARY KEY, role text, permissions jsonb, is_active boolean, activation_status text);
      CREATE TABLE user_roles (user_id varchar(255), role_id varchar(255), PRIMARY KEY(user_id, role_id));
      CREATE TABLE role_permissions (role_id varchar(255), permission_code varchar(255), PRIMARY KEY(role_id, permission_code));
      CREATE TABLE user_permissions (user_id varchar(255), permission_code varchar(255), PRIMARY KEY(user_id, permission_code));
      CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean NOT NULL, PRIMARY KEY(user_id, org_id));
      CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean NOT NULL DEFAULT false, UNIQUE(user_id, namespace));
      CREATE TABLE meta_sheets (id text PRIMARY KEY, name text, deleted_at timestamptz);
      CREATE TABLE automation_rules (id text PRIMARY KEY, sheet_id text NOT NULL, created_by text);
      CREATE TABLE spreadsheet_permissions (sheet_id text, perm_code text, subject_type text, subject_id text);
      CREATE TABLE meta_records (id text PRIMARY KEY, sheet_id text, data jsonb);
      CREATE TABLE multitable_automation_executions (
        id text PRIMARY KEY, rule_id text NOT NULL, triggered_by text NOT NULL, triggered_at timestamptz NOT NULL,
        status text NOT NULL, steps jsonb NOT NULL, error text, duration integer, sheet_id text,
        trigger_event jsonb, rule_snapshot jsonb, finished_at timestamptz, schema_version integer, initiated_by text,
        created_at timestamptz NOT NULL DEFAULT now());
    `)
    revoker = await pool.connect()
    blocker = await pool.connect()
    observer = await pool.connect()
    for (const client of [revoker, blocker, observer]) {
      await client.query(`SET search_path TO "${schema}"`)
      await client.query("SET statement_timeout = '20s'")
    }
    revokerPid = Number((await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  })

  afterAll(async () => {
    for (const client of [revoker, blocker, observer]) {
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }
    if (admin) {
      // The exact random schema was created above by this test; never public.
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      admin.release()
    }
    await pool?.end()
  })

  beforeEach(async () => {
    beforeCommit = undefined
    lockTimeout = '5s'
    transactionIndex = 0
    providerCalls.length = 0
    await admin.query(`TRUNCATE users, user_roles, role_permissions, user_permissions, user_orgs, user_namespace_admissions,
      meta_sheets, automation_rules, spreadsheet_permissions, meta_records, multitable_automation_executions`)
    for (const id of [ACTOR, OTHER]) {
      await admin.query(`INSERT INTO users VALUES ($1, 'user', '[]', true, 'activated')`, [id])
      await admin.query('INSERT INTO user_orgs VALUES ($1, $2, true)', [id, TENANT])
    }
    await admin.query("INSERT INTO user_roles VALUES ($1, 'admin')", [ACTOR])
    // Unrelated positive authority: an omitted WHERE must not pass because the database is small.
    await admin.query("INSERT INTO user_roles VALUES ($1, 'admin')", [OTHER])
    await admin.query('INSERT INTO meta_sheets (id, name) VALUES ($1, $3), ($2, $3)', [SHEET, OTHER_SHEET, 'synthetic sheet'])
    await admin.query('INSERT INTO automation_rules VALUES ($1, $2, $3)', [RULE, SHEET, ACTOR])
    await admin.query("INSERT INTO meta_records VALUES ('synthetic-record', $1, '{}')", [SHEET])
  })

  it('C01 (runtime half): a two-page synthetic read becomes a YiDa preview; only the summary row is new', async () => {
    const before = await tableCounts()
    const result = await runtime().run(scope, BODY)
    expect(result).toMatchObject({ ok: true, canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false })
    expect(result.summary).toMatchObject({ outcome: 'OK', counts: { pages: 2, rows: 3 } })
    expect(providerCalls.map((call) => call.cursor)).toEqual([null, 'synthetic-cursor-2'])
    const after = await tableCounts()
    expect(after).toEqual({ ...before, multitable_automation_executions: before.multitable_automation_executions + 1 })
  })

  it('S02: the persisted row carries fixed ids and counts only; values exist only in the response view', async () => {
    const result = await runtime().run(scope, BODY)
    expect(JSON.stringify(result.preview.rows)).toMatch(VALUE_MARKERS)
    const [row] = await executions()
    expect(row).toMatchObject({ rule_id: RULE, sheet_id: SHEET, triggered_by: 'integration_preview', status: 'success',
      error: null, trigger_event: null, rule_snapshot: null, initiated_by: ACTOR })
    expect(JSON.stringify(row)).not.toMatch(VALUE_MARKERS)
    expect(row.steps).toEqual([
      expect.objectContaining({ actionType: 'integration_preview_read', status: 'success', output: expect.objectContaining({ pages: 2, rows: 3 }) }),
      expect.objectContaining({ actionType: 'integration_preview_yida', status: 'success' }),
    ])
  })

  describe('C03 — every admission input is re-proved from the database', () => {
    it.each([
      ['the actor is not the rule owner', async () => { await admin.query('UPDATE automation_rules SET created_by = $1', [OTHER]) }, 'DENIED'],
      ['the rule belongs to another sheet', async () => { await admin.query('UPDATE automation_rules SET sheet_id = $1', [OTHER_SHEET]) }, 'NOT_FOUND'],
      ['the rule does not exist', async () => { await admin.query('DELETE FROM automation_rules') }, 'NOT_FOUND'],
      ['the sheet is soft-deleted', async () => { await admin.query('UPDATE meta_sheets SET deleted_at = now() WHERE id = $1', [SHEET]) }, 'NOT_FOUND'],
      ['no live membership in the authenticated tenant', async () => { await admin.query('UPDATE user_orgs SET is_active = false WHERE user_id = $1', [ACTOR]) }, 'DENIED'],
      ['the integration identity is gone', async () => { await admin.query('DELETE FROM user_roles WHERE user_id = $1', [ACTOR]) }, 'DENIED'],
      ['workflow:write + integration:admin, but the sheet grant is read-only', async () => {
        await admin.query('DELETE FROM user_roles WHERE user_id = $1', [ACTOR])
        await admin.query("INSERT INTO user_roles VALUES ($1, 'synthetic-integrator')", [ACTOR])
        await admin.query("INSERT INTO role_permissions VALUES ('synthetic-integrator', 'integration:admin'), ('synthetic-integrator', 'workflow:write')")
        await admin.query("INSERT INTO user_namespace_admissions VALUES ($1, 'integration', true)", [ACTOR])
        await admin.query("INSERT INTO spreadsheet_permissions VALUES ($1, 'spreadsheet:read', 'user', $2)", [SHEET, ACTOR])
      }, 'DENIED'],
      ['a permission relation is missing', async () => { await admin.query('ALTER TABLE spreadsheet_permissions RENAME TO spreadsheet_permissions_hidden') }, 'UNAVAILABLE'],
    ] as const)('%s -> %s, with no provider call and no summary row', async (_label, arrange, code) => {
      await arrange()
      try {
        expect(await refusal(runtime().run(scope, BODY))).toBe(code)
        expect(providerCalls).toHaveLength(0)
        expect(await executions()).toHaveLength(0)
      } finally {
        await admin.query(`DO $$ BEGIN IF to_regclass('spreadsheet_permissions_hidden') IS NOT NULL THEN
          ALTER TABLE spreadsheet_permissions_hidden RENAME TO spreadsheet_permissions; END IF; END $$`)
      }
    })

    it('a forged tenant scope is refused even though the actor is a member of another tenant', async () => {
      expect(await refusal(runtime().run({ ...scope, tenantId: 'synthetic-forged-tenant' }, BODY))).toBe('DENIED')
      expect(providerCalls).toHaveLength(0)
    })

    it('the same integrator with a WRITE sheet grant is admitted (the scope narrows, it does not replace)', async () => {
      await admin.query('DELETE FROM user_roles WHERE user_id = $1', [ACTOR])
      await admin.query("INSERT INTO user_roles VALUES ($1, 'synthetic-integrator')", [ACTOR])
      await admin.query("INSERT INTO role_permissions VALUES ('synthetic-integrator', 'integration:admin'), ('synthetic-integrator', 'workflow:write')")
      await admin.query("INSERT INTO user_namespace_admissions VALUES ($1, 'integration', true)", [ACTOR])
      await admin.query("INSERT INTO spreadsheet_permissions VALUES ($1, 'spreadsheet:write', 'user', $2)", [SHEET, ACTOR])
      await expect(runtime().run(scope, BODY)).resolves.toMatchObject({ ok: true })
    })

    it('a lock error on an authority row is UNAVAILABLE (fail closed), with no provider call', async () => {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [ACTOR])
      lockTimeout = '200ms'
      try {
        expect(await refusal(runtime().run(scope, BODY))).toBe('UNAVAILABLE')
        expect(providerCalls).toHaveLength(0)
      } finally {
        await blocker.query('ROLLBACK')
      }
    })
  })

  describe('C04 — revocation between checkpoints, with two connections and barriers', () => {
    it('revoked after page 1: the page-2 checkpoint refuses and the provider is not called again', async () => {
      const result = refusal(runtime({
        beforeAdmission: async (phase, ordinal) => {
          // ordinal 3 = the checkpoint before provider page 2 (1 = start, 2 = page 1).
          if (phase === 'page' && ordinal === 3) {
            await revoker.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [ACTOR])
          }
        },
      }).run(scope, BODY))
      expect(await result).toBe('DENIED')
      expect(providerCalls).toHaveLength(1)
      const [row] = await executions()
      expect(row).toMatchObject({ status: 'failed', error: 'INTEGRATION_PREVIEW_DENIED' })
      expect((row.steps as Array<{ output?: { pages?: number } }>)[0].output?.pages).toBe(1)
    })

    async function arrangeWriteGrantIntegrator() {
      await admin.query('DELETE FROM user_roles WHERE user_id = $1', [ACTOR])
      await admin.query("INSERT INTO user_roles VALUES ($1, 'synthetic-integrator')", [ACTOR])
      await admin.query("INSERT INTO role_permissions VALUES ('synthetic-integrator', 'integration:admin'), ('synthetic-integrator', 'workflow:write')")
      await admin.query("INSERT INTO user_namespace_admissions VALUES ($1, 'integration', true)", [ACTOR])
      await admin.query("INSERT INTO spreadsheet_permissions VALUES ($1, 'spreadsheet:write', 'user', $2)", [SHEET, ACTOR])
    }

    // One case per authority relation whose row the admission holds FOR SHARE (L1 rule owner, L3 tenant
    // membership, L3/L4 role binding, L5 sheet grant — the linearization point). Each revocation must
    // block on the admission's row lock until COMMIT and be seen by the NEXT checkpoint.
    it.each([
      { relation: 'automation_rules', arrange: async () => undefined,
        revoke: { sql: 'UPDATE automation_rules SET created_by = $1 WHERE id = $2', params: [OTHER, RULE] }, code: 'DENIED' },
      { relation: 'user_orgs', arrange: async () => undefined,
        revoke: { sql: 'UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', params: [ACTOR, TENANT] }, code: 'DENIED' },
      { relation: 'spreadsheet_permissions', arrange: arrangeWriteGrantIntegrator,
        revoke: { sql: "UPDATE spreadsheet_permissions SET perm_code = 'spreadsheet:read' WHERE sheet_id = $1 AND subject_id = $2", params: [SHEET, ACTOR] }, code: 'DENIED' },
      { relation: 'user_roles', arrange: async () => undefined,
        revoke: { sql: "DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", params: [ACTOR] }, code: 'DENIED' },
    ] as const)('lock order ($relation): a revoker blocks on the admission row lock until COMMIT; the NEXT checkpoint refuses $code', async ({ relation, arrange, revoke, code }) => {
      await arrange()
      let revocationDone = false
      let revocation: Promise<unknown> | undefined
      let waitedOn: string[] = []
      let blockedBy: number[] = []
      let admissionPid = -1
      beforeCommit = async (index, client) => {
        // Transaction 3 = the page-2 checkpoint, locks held, not yet committed.
        if (index !== 3) return
        admissionPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        revocation = revoker.query(revoke.sql, [...revoke.params]).then(() => { revocationDone = true })
        await waitUntilBlocked(revokerPid)
        expect(revocationDone).toBe(false)
        // A row-lock waiter holds the tuple lock on the contended relation and waits (ungranted) on the
        // admission transaction; read both so the relation and the blocker are asserted, not inferred.
        const locks = (await observer.query(
          `SELECT l.locktype, l.granted, c.relname FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid = $1 AND (NOT l.granted OR l.locktype = 'tuple')`, [revokerPid])).rows as Array<{ locktype: string, granted: boolean, relname: string | null }>
        waitedOn = [...new Set(locks.map((row) => row.relname).filter((name): name is string => typeof name === 'string'))]
        expect(locks.some((row) => !row.granted)).toBe(true)
        blockedBy = ((await observer.query('SELECT pg_blocking_pids($1) AS pids', [revokerPid])).rows[0].pids as number[]).map(Number)
      }
      const result = await refusal(runtime().run(scope, BODY))
      await revocation
      expect(revocationDone).toBe(true)
      expect(waitedOn).toEqual([relation])
      expect(blockedBy).toEqual([admissionPid])
      // Page 2 was admitted before the revocation committed and ran (the disclosed gap); the consumer
      // checkpoint after it refused, so no preview was compiled or returned.
      expect(result).toBe(code)
      expect(providerCalls).toHaveLength(2)
      const [row] = await executions()
      expect((row.steps as Array<{ status: string }>).map((step) => step.status)).toEqual(['success', 'failed'])
    })

    it('revoked right before the result is returned: the terminal preview is not published', async () => {
      const result = await refusal(runtime({
        beforeAdmission: async (phase) => {
          if (phase === 'publish') await revoker.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [ACTOR])
        },
      }).run(scope, BODY))
      expect(result).toBe('DENIED')
      expect(providerCalls).toHaveLength(2)
      const [row] = await executions()
      expect(row).toMatchObject({ status: 'failed', error: 'INTEGRATION_PREVIEW_DENIED' })
      expect(JSON.stringify(row)).not.toMatch(VALUE_MARKERS)
    })

    it('a sheet grant revoked between checkpoints is seen too (scope, not only roles)', async () => {
      await admin.query('DELETE FROM user_roles WHERE user_id = $1', [ACTOR])
      await admin.query("INSERT INTO user_roles VALUES ($1, 'synthetic-integrator')", [ACTOR])
      await admin.query("INSERT INTO role_permissions VALUES ('synthetic-integrator', 'integration:admin'), ('synthetic-integrator', 'workflow:write')")
      await admin.query("INSERT INTO user_namespace_admissions VALUES ($1, 'integration', true)", [ACTOR])
      await admin.query("INSERT INTO spreadsheet_permissions VALUES ($1, 'spreadsheet:write', 'user', $2)", [SHEET, ACTOR])
      const result = await refusal(runtime({
        beforeAdmission: async (phase) => {
          if (phase === 'consume') {
            await revoker.query("UPDATE spreadsheet_permissions SET perm_code = 'spreadsheet:read' WHERE subject_id = $1", [ACTOR])
          }
        },
      }).run(scope, BODY))
      expect(result).toBe('DENIED')
      expect(providerCalls).toHaveLength(2)
    })
  })
})

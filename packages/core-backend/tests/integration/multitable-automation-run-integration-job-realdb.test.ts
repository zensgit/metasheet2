/**
 * R-69 1b-ii — `run_integration_job` on the REAL executor with REAL ledgers (design baseline v2.3 §10.2.5 T3, T10;
 * ADR adr-automation-pipeline-bridge-20261103 §6.4). The port is a fake that reads "pages" behind barriers;
 * the lease, the intent row, the heartbeat transactions and the live-authority read all go to Postgres. Short
 * synthetic leases (seconds) expire on the DATABASE clock; the system clock is never changed.
 *
 *   - T10 (local loss): holder A (root exec_A) is PAUSED inside the port after page 1 and its heartbeat cannot
 *     reach the database; with safetyMs 0 its LOCAL deadline passes and marks the heartbeat lost; the lease
 *     expires on the DB clock; B (a DIFFERENT execution root, same project) claims fence+1, runs and finalizes;
 *     A resumes: its next checkpoint() is refused by that local loss (the executor's checkpoint throws before any
 *     SELECT) so NO further page is read, its renewal and its fenced Tx B are void although its intent token is
 *     still valid; only B's Tx B landed; A's step is outcome_unknown(lease_lost).
 *   - T10 (frozen clock): the same takeover, but A's heartbeat clock is FROZEN and its renewal hangs, so A's
 *     local deadline can never pass and nothing in-process marks its lease lost (its signal stays un-aborted).
 *     The DATABASE-side admission guard (`assertJobLeaseCurrent` in the executor's checkpoint: fence = mine AND
 *     not expired, a plain pool read) is then the ONLY thing that can refuse page 2 — and it does; A's step ends
 *     outcome_unknown(lease_lost) through Tx B's lock-verify (I-6 step 1), with no terminal write of its own.
 *   - T3: A "crashes" mid-run (never settles, never renews): B is busy within the TTL and runs after it; a
 *     same-identity replay skips in-flight while A's intent lease is live and flips the row to outcome_unknown
 *     once that lease is in the past (never a second run of A's identity).
 *   - live authority (§6.4) on real auth tables: a bound principal with a single active membership and a
 *     workflow:* code resolves to the request-path permission codes (listUserPermissions parity); deactivation,
 *     a missing membership and a missing automation capability are each principal_unauthorized.
 *   - production authority path (§6.4): the REAL executor with NO resolver seam runs its own committed READ
 *     COMMITTED authority transaction over the production transaction seam — a seeded principal runs to success
 *     with the request-path permission codes in the port context; deactivated ⇒ skipped(principal_unauthorized)
 *     before anything is leased.
 *   - ADR §11 permission equivalence matrix: four fixtures (role-granted PULL ladder + admission; the same
 *     stock-prep codes granted directly; the PULL-ladder role WITHOUT admission; legacy integration:write) — the
 *     port principal's codes equal the request-time profile's (AuthService.verifyToken → resolveRbacProfile, the
 *     claim-trusting fast path off) code for code, and the plugin-visible role set is the same on both sides.
 *
 *   - R-69 I6a (ADR §3.1 + §6.5): every executor here runs on a rule sheet registered (migration 087, real table) to
 *     TENANT / PROJECT, because the executor re-checks the rule sheet on every trigger; the I6a case proves the save
 *     refuses another tenant's registered sheet (nothing written) and a trigger after ARCHIVE is skipped with 0 port
 *     calls and no lease / intent row.
 *     I6a fix (re-review M1): the sheet id is EXACT on the real registry read — the registered id plus one whitespace
 *     code point is another sheet: refused at save (no rule row) and at every trigger (0 port calls, no intent row,
 *     no lease), while the registered id itself saves and runs (the positive control of the same lookups).
 *   - R-69 I6d fix round 2 (F1): `updateRule` against a CONCURRENT PATCH on the real table — two AutomationService
 *     instances, each over its own one-connection pool (two backends), the first request's UPDATE held at the moment
 *     its statement would be sent. A write whose stored row changed since it was read updates nothing and is
 *     re-validated against the row as it now is (action type × action config; trigger × action, both orders), and
 *     two saves stamped in the same millisecond are still two row versions.
 *
 * Two-point wired (plugin-tests.yml multitable real-DB step + vitest.config.ts exclude); EXPECT_DB sentinel.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { Kysely, PostgresDialect } from 'kysely'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, test, vi } from 'vitest'

import { authService } from '../../src/auth/AuthService'
import { db } from '../../src/db/db'
import type { Database } from '../../src/db/types'
import { poolManager } from '../../src/integration/db/connection-pool'
import { up as leasesUp } from '../../src/db/migrations/zzzz20261106111100_create_automation_job_leases'
import { down as runFinishedTriggerDown, up as runFinishedTriggerUp } from '../../src/db/migrations/zzzz20261106111500_add_integration_run_finished_trigger_type'
import { AutomationRuleValidationError, AutomationService, parseCreateRuleInput, parseUpdateRuleInput, toExecutorRule } from '../../src/multitable/automation-service'
import { RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES } from '../../src/multitable/automation-run-integration-job-rule-sheet'
import { STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV } from '../../src/multitable/stock-preparation-manual-rows-gate'
import { clearIntegrationRunFinishedSinkForTest, registerIntegrationRunFinishedSink } from '../../src/core/integration-run-events'
import { EventBus } from '../../src/integration/events/event-bus'
import { listUserPermissions } from '../../src/rbac/service'
import { resolveIntegrationRunPrincipalOnTransaction } from '../../src/integration/automation-run-authority'
import type { IntegrationRunInput, IntegrationRunPort, IntegrationRunSummary } from '../../src/core/integration-run-port'
import { deriveActionKey } from '../../src/multitable/automation-action-idempotency'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationStepResult,
  type ClassAActionIdentity,
  type ExecutionContext,
} from '../../src/multitable/automation-executor'
import {
  finalizeJobWithFencedOutcome,
  jobLeaseScopeKey,
  renewJobAndIntentLeases,
  type JobLeaseHandle,
  type JobLeaseQueryFn,
  type JobLeaseTransaction,
} from '../../src/multitable/automation-job-lease'
import { deriveOutboundTargetKey, type OutboundIntentIdentity } from '../../src/multitable/automation-outbound-intent'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const RUN = randomUUID().slice(0, 8)
const TENANT = `tenant_${RUN}`
const PRINCIPAL_ID = `svc_${RUN}`
const PROJECT = `P-${RUN}`
const FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
const SCOPE = jobLeaseScopeKey({ kind: 'stock_prep_pull', tenantId: TENANT, projectNo: PROJECT })
const CONFIG = { job: { kind: 'stock_prep_pull', projectNos: [PROJECT], applyMode: 'dry_run_only' }, timeoutMs: 60_000, binding: { principalId: PRINCIPAL_ID, tenantId: TENANT } }
const PRINCIPAL = { id: PRINCIPAL_ID, permissions: ['workflow:write'], roles: [], role: 'user', tenantId: TENANT }
const q: JobLeaseQueryFn = (s, p) => poolManager.get().query(s, p)
/** R-69 I6a: the rule sheet every executor here runs on — registered (087) to TENANT / PROJECT, active. */
const SHEET = `sheet_${RUN}`

/**
 * R-69 I6a: the project-sheet registry (087) on the real database. The CI database carries it (plugin migrations);
 * a bare database gets the REAL 087 SQL, verbatim, only when the table is missing (never re-run on an existing one).
 * Then the rule sheet's row (idempotent; cleaned by RUN).
 */
async function registerRuleSheet(sheetId: string = SHEET, tenantId: string = TENANT, projectNo: string = PROJECT): Promise<void> {
  const { rows } = await q(`SELECT to_regclass('integration_stock_prep_project_target') IS NOT NULL AS present`)
  if (!(rows[0] as { present: boolean }).present) {
    await q(readFileSync(path.join(__dirname, '..', '..', 'migrations', '087_create_integration_stock_prep_project_target.sql'), 'utf8'))
  }
  await q(
    `INSERT INTO integration_stock_prep_project_target (id, tenant_id, project_no, sheet_id, object_id, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'active', 'syn') ON CONFLICT DO NOTHING`,
    [`pt_${sheetId}`, tenantId, projectNo, sheetId, `obj_${sheetId}`],
  )
}
const unregisterRuleSheets = () => q(`DELETE FROM integration_stock_prep_project_target WHERE tenant_id LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The production transaction seam shape (AutomationService wires poolManager.transaction the same way). */
const poolTransaction: JobLeaseTransaction = async (handler) => poolManager.get().transaction(async ({ query }) => {
  const txQuery: JobLeaseQueryFn = async (sqlText, params) => {
    const result = await query(sqlText, params)
    return { rows: Array.isArray(result.rows) ? result.rows : [], rowCount: typeof result.rowCount === 'number' ? result.rowCount : undefined }
  }
  return handler({ query: txQuery })
})
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { opened, open }
}
function intentOf(root: string, config: typeof CONFIG = CONFIG): OutboundIntentIdentity {
  return {
    kind: 'execution',
    rootExecutionId: root,
    actionKey: deriveActionKey({ structuralPath: '0', actionType: 'run_integration_job', canonicalConfig: config }),
    targetKey: deriveOutboundTargetKey(['stock_prep_pull', TENANT, PROJECT]),
  }
}
async function intentRow(id: OutboundIntentIdentity) {
  const { rows } = await q(
    `SELECT status, attempt_token AS token, last_error, lease_expires_at AS expires FROM meta_automation_outbound_intent
      WHERE kind=$1 AND root_execution_id=$2 AND action_key=$3 AND target_key=$4`,
    [id.kind, id.rootExecutionId, id.actionKey, id.targetKey ?? ''],
  )
  return rows[0] as { status: string; token: string | null; last_error: string | null; expires: Date | null } | undefined
}
async function leaseRow() {
  const { rows } = await q(`SELECT holder, fence::text AS fence, (lease_expires_at > now()) AS live FROM meta_automation_job_leases WHERE scope_key = $1`, [SCOPE])
  return rows[0] as { holder: string | null; fence: string; live: boolean } | undefined
}
async function untilLeaseExpired(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const row = await leaseRow()
    if (row && row.live === false) return
    await sleep(50)
  }
  throw new Error('lease did not expire on the database clock')
}

/**
 * A port that reads pages behind per-page barriers ("the holder is paused" between pages) and admits every page
 * through `await checkpoint()` ALONE — deliberately without consulting the signal — so what this file proves is
 * the executor's checkpoint() (I-5), never an in-process abort. That checkpoint has two halves: the heartbeat's
 * LOCAL loss (T10: the local deadline passed ⇒ it throws before any SELECT) and the DATABASE-side admission guard
 * `assertJobLeaseCurrent` (fence = mine AND not expired) — which only the frozen-clock T10 isolates, because there
 * the local half can never fire. Every port input is kept so a test can read the signal / context the executor built.
 */
function pagedPort(pageGates: Array<ReturnType<typeof gate>>) {
  const state = { pagesRead: 0, calls: 0, inputs: [] as IntegrationRunInput[] }
  const port: IntegrationRunPort = {
    async run(input: IntegrationRunInput): Promise<IntegrationRunSummary> {
      state.calls += 1
      state.inputs.push(input)
      for (let page = 0; page < pageGates.length; page += 1) {
        await pageGates[page].opened
        await input.checkpoint()
        state.pagesRead += 1
      }
      return { status: 'succeeded', reason: 'ready', canApply: true, counts: { add: state.pagesRead } }
    },
  }
  return { port, state }
}
const immediatePort: IntegrationRunPort = { run: async () => ({ status: 'succeeded', reason: 'ready', canApply: true, counts: { add: 1 } }) }

/**
 * The REAL executor over the given transaction seam. By default the principal resolver is a seam (the lease /
 * takeover cases are about the ledgers, not authority); `extra: { resolveIntegrationRunPrincipal: undefined }`
 * removes it, so the executor runs its OWN live-authority transaction — the production path.
 */
function executorWith(port: IntegrationRunPort, transaction: JobLeaseTransaction, seams: NonNullable<AutomationDeps['integrationJobRuntime']>, extra: Partial<AutomationDeps> = {}) {
  const tracked: Promise<void>[] = []
  const exec = new AutomationExecutor({
    eventBus: new EventBus(),
    queryFn: q,
    transaction: transaction as unknown as AutomationDeps['transaction'],
    integrationRunPort: () => port,
    trackIntegrationJobTask: (task) => { tracked.push(task) },
    resolveIntegrationRunPrincipal: async () => ({ ok: true, user: PRINCIPAL }),
    integrationJobRuntime: seams,
    ...extra,
  })
  const run = (executionId: string, config: typeof CONFIG = CONFIG, sheetId: string = SHEET): Promise<AutomationStepResult> => {
    const context: ExecutionContext = { executionId, ruleId: `rule_${RUN}`, sheetId, recordId: '', recordData: {}, ruleCreatedBy: config.binding.principalId, triggerEvent: {}, rootExecutionId: executionId }
    const identity: ClassAActionIdentity = { structuralPath: '0', rootExecutionId: executionId }
    return (exec as unknown as { executeSingleAction(a: unknown, c: ExecutionContext, i: ClassAActionIdentity): Promise<AutomationStepResult> })
      .executeSingleAction({ type: 'run_integration_job', config }, context, identity)
  }
  return { exec, run, tracked }
}
const unitOf = (step: AutomationStepResult) => ((step.output as { units: Array<Record<string, unknown>> }).units[0])

describeIfDatabase('R-69 1b-ii run_integration_job on the real executor + real ledgers', () => {
  let a: Client
  const savedFlag = process.env[FLAG]
  const savedProjectSheets = process.env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV]

  beforeAll(async () => {
    await leasesUp(db as never)
    process.env[FLAG] = 'true'
    process.env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV] = 'true'
    await registerRuleSheet()
    a = new Client({ connectionString: process.env.DATABASE_URL })
    await a.connect()
  })
  afterAll(async () => {
    if (savedFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = savedFlag
    if (savedProjectSheets === undefined) delete process.env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV]
    else process.env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV] = savedProjectSheets
    await unregisterRuleSheets()
    await q(`DELETE FROM meta_automation_outbound_intent WHERE root_execution_id LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    await q(`DELETE FROM meta_automation_job_leases WHERE scope_key LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    for (const [table, column] of [['user_namespace_admissions', 'user_id'], ['user_roles', 'user_id'], ['user_permissions', 'user_id'], ['user_orgs', 'user_id'], ['users', 'id']]) {
      await q(`DELETE FROM ${table} WHERE ${column} LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    }
    await q(`DELETE FROM role_permissions WHERE role_id LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    await q(`DELETE FROM roles WHERE id LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    await a?.end().catch(() => undefined)
  })

  test('T10: a paused holder loses the scope to a different execution root on the DB clock; on resume it admits no new call and its renewal / fenced Tx B are void despite a valid intent token; only B’s result lands', async () => {
    const txGate = gate() // A's database transactions (heartbeat renewals) hang here: A is "paused"
    const pageTwo = gate()
    const { port: portA, state } = pagedPort([{ opened: Promise.resolve(), open: () => undefined }, pageTwo, { opened: Promise.resolve(), open: () => undefined }])
    const gatedTransaction: JobLeaseTransaction = async (handler) => { await txGate.opened; return poolTransaction(handler) }
    const A = executorWith(portA, gatedTransaction, { leaseTtlMs: 2_000, settleGraceMs: 200, heartbeat: { intervalMs: 1_000, renewTimeoutMs: 60_000, safetyMs: 0 } })
    const stepA = A.run(`exec_A_${RUN}`)
    // A read page 1 (its first checkpoint passed) and is now blocked before page 2.
    for (let i = 0; i < 100 && state.pagesRead < 1; i++) await sleep(20)
    expect(state.pagesRead).toBe(1)
    const leaseA = (await leaseRow())!
    expect(leaseA).toMatchObject({ fence: '1', live: true })
    const handleA: JobLeaseHandle = { scopeKey: SCOPE, holder: leaseA.holder!, fence: '1' }
    const intentA = intentOf(`exec_A_${RUN}`)
    const rowA = (await intentRow(intentA))!
    expect(rowA.status).toBe('pending')

    // The lease expires on the database clock (A renews nothing while paused); B — another execution root — takes over.
    await untilLeaseExpired()
    const B = executorWith(immediatePort, poolTransaction, { leaseTtlMs: 2_000 })
    const stepB = await B.run(`exec_B_${RUN}`)
    expect(stepB.status).toBe('success')
    expect(unitOf(stepB)).toMatchObject({ outcome: 'succeeded', confirmed: true })
    expect(await leaseRow()).toMatchObject({ fence: '2', holder: null })
    expect((await intentRow(intentOf(`exec_B_${RUN}`)))!.status).toBe('sent')

    // A's step: its local deadline passed while paused ⇒ lease_lost (no Tx B, no release by A).
    const resultA = await stepA
    expect(resultA).toMatchObject({ status: 'failed', output: { outcome: 'outcome_unknown', reason: 'lease_lost' } })
    // A resumes: the next checkpoint() is refused ⇒ page 2 is never read.
    pageTwo.open()
    await sleep(100)
    expect(state.pagesRead).toBe(1)
    expect(state.calls).toBe(1)
    // A's renewal (its hung tick, released now) and its fenced Tx B are void — while A's intent token is STILL valid.
    txGate.open()
    await Promise.all(A.tracked)
    await expect(renewJobAndIntentLeases(poolTransaction, handleA, { id: intentA, attemptToken: rowA.token!, leaseMs: 60_000 }, 2_000))
      .rejects.toMatchObject({ name: 'JobLeaseLostError', stage: 'verify' })
    expect(await finalizeJobWithFencedOutcome(poolTransaction, handleA, { id: intentA, attemptToken: rowA.token! }, 'sent', 'ready'))
      .toEqual({ confirmed: false, reason: 'lease_lost', stage: 'verify' })
    expect(await intentRow(intentA)).toMatchObject({ status: 'pending', token: rowA.token })
    expect(await leaseRow()).toMatchObject({ fence: '2', holder: null })
    // the page gate stays open for the dangling call so nothing leaks between tests
  }, 20_000)

  test('T3: a crashed holder (never settles, never renews) makes the scope busy within the TTL and claimable after it; a same-identity replay skips in-flight while its intent lease is live and flips the row once it is past', async () => {
    await q(`DELETE FROM meta_automation_job_leases WHERE scope_key = $1`, [SCOPE])
    const never = gate()
    const { port: crashedPort } = pagedPort([never])
    const deadTransaction: JobLeaseTransaction = async () => { throw new Error('process is dead') }
    const dead = executorWith(crashedPort, deadTransaction, { leaseTtlMs: 2_000, settleGraceMs: 100, heartbeat: { intervalMs: 1_000, renewTimeoutMs: 60_000, safetyMs: 0 } })
    const stepDead = dead.run(`exec_dead_${RUN}`)
    for (let i = 0; i < 100 && !(await leaseRow()); i++) await sleep(20)
    expect(await leaseRow()).toMatchObject({ fence: '1', live: true })
    const intentDead = intentOf(`exec_dead_${RUN}`)
    expect((await intentRow(intentDead))!.status).toBe('pending')

    const B = executorWith(immediatePort, poolTransaction, { leaseTtlMs: 2_000 })
    const busy = await B.run(`exec_B2_${RUN}`)
    expect(busy).toMatchObject({ status: 'skipped', output: { reason: 'busy' } })
    expect((await intentRow(intentOf(`exec_B2_${RUN}`)))).toMatchObject({ status: 'failed', last_error: 'busy' })
    await untilLeaseExpired()
    const after = await B.run(`exec_B3_${RUN}`)
    expect(after.status).toBe('success')
    expect(await leaseRow()).toMatchObject({ fence: '2', holder: null })
    expect(await stepDead).toMatchObject({ output: { outcome: 'outcome_unknown', reason: 'lease_lost' } })

    // Same-identity replay (a restart re-delivering the dead execution): the intent row is pending with a LIVE lease.
    const replayWithin = await B.run(`exec_dead_${RUN}`)
    expect(replayWithin).toMatchObject({ status: 'failed', output: { outcome: 'outcome_unknown', reason: 'inflight_lease' } })
    expect((await intentRow(intentDead))!.status).toBe('pending')
    // Time-travel the dead attempt's intent lease into the past (the DB clock decides): the replay flips it — once — and never re-runs it.
    await q(`UPDATE meta_automation_outbound_intent SET lease_expires_at = now() - interval '1 second' WHERE kind=$1 AND root_execution_id=$2 AND action_key=$3 AND target_key=$4`, [intentDead.kind, intentDead.rootExecutionId, intentDead.actionKey, intentDead.targetKey ?? ''])
    const replayAfter = await B.run(`exec_dead_${RUN}`)
    expect(replayAfter).toMatchObject({ status: 'failed', output: { outcome: 'outcome_unknown', reason: 'prior_outcome_unknown' } })
    expect(await intentRow(intentDead)).toMatchObject({ status: 'outcome_unknown', last_error: 'lease_expired' })
    const again = await B.run(`exec_dead_${RUN}`)
    expect(again).toMatchObject({ output: { reason: 'prior_outcome_unknown' } })
    expect(await leaseRow()).toMatchObject({ fence: '2', holder: null }) // the dead identity never claimed again
    never.open()
  }, 20_000)

  test('live authority (§6.4): membership + canManageAutomation on real tables, permission codes equal to the request-path resolver; deactivation / no membership / no capability are principal_unauthorized', async () => {
    const roleId = `role_${RUN}`
    // role_permissions.permission_code references the permissions vocabulary; seed the two codes if the CI
    // database does not carry them (left in place: vocabulary rows, not test data).
    for (const code of ['workflow:write', 'integration:read']) {
      await q(`INSERT INTO permissions (code, name) SELECT $1::varchar, $1::varchar WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE code = $1::varchar)`, [code])
    }
    await q(`INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1, $2, $3, 'x', 'user', true)`, [PRINCIPAL_ID, `${PRINCIPAL_ID}@example.test`, 'svc'])
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [PRINCIPAL_ID, TENANT])
    await q(`INSERT INTO roles (id, name) VALUES ($1, $2)`, [roleId, roleId])
    await q(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'workflow:write'), ($1, 'integration:read')`, [roleId])
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [PRINCIPAL_ID, roleId])
    const onTx = <T>(work: (trx: { query: (s: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> }) => Promise<T>) =>
      poolTransaction(async ({ query }) => work({ query: async (s, p) => { const r = await query(s, p); return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? null } } }))

    const ok = await onTx((trx) => resolveIntegrationRunPrincipalOnTransaction(trx, { principalId: PRINCIPAL_ID, tenantId: TENANT }))
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.user).toMatchObject({ id: PRINCIPAL_ID, role: 'user', roles: [], tenantId: TENANT })
      expect(ok.user.permissions).toContain('workflow:write')
      // request-path parity: the SAME resolver, pool variant (what the HTTP path's profile carries)
      expect([...ok.user.permissions].sort()).toEqual([...(await listUserPermissions(PRINCIPAL_ID))].sort())
    }
    // wrong tenant in the binding ⇒ no single active membership ⇒ unauthorized (never derived from a header)
    expect(await onTx((trx) => resolveIntegrationRunPrincipalOnTransaction(trx, { principalId: PRINCIPAL_ID, tenantId: `other_${RUN}` }))).toEqual({ ok: false, reason: 'principal_unauthorized' })
    // capability revoked ⇒ unauthorized
    await q(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = 'workflow:write'`, [roleId])
    expect(await onTx((trx) => resolveIntegrationRunPrincipalOnTransaction(trx, { principalId: PRINCIPAL_ID, tenantId: TENANT }))).toEqual({ ok: false, reason: 'principal_unauthorized' })
    await q(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'workflow:write')`, [roleId])
    // membership deactivated ⇒ unauthorized; reactivated ⇒ ok again (it is read live, every time)
    await q(`UPDATE user_orgs SET is_active = false WHERE user_id = $1`, [PRINCIPAL_ID])
    expect(await onTx((trx) => resolveIntegrationRunPrincipalOnTransaction(trx, { principalId: PRINCIPAL_ID, tenantId: TENANT }))).toEqual({ ok: false, reason: 'principal_unauthorized' })
    await q(`UPDATE user_orgs SET is_active = true WHERE user_id = $1`, [PRINCIPAL_ID])
    expect((await onTx((trx) => resolveIntegrationRunPrincipalOnTransaction(trx, { principalId: PRINCIPAL_ID, tenantId: TENANT }))).ok).toBe(true)
    // user deactivated ⇒ unauthorized
    await q(`UPDATE users SET is_active = false WHERE id = $1`, [PRINCIPAL_ID])
    expect(await onTx((trx) => resolveIntegrationRunPrincipalOnTransaction(trx, { principalId: PRINCIPAL_ID, tenantId: TENANT }))).toEqual({ ok: false, reason: 'principal_unauthorized' })
    // unknown principal ⇒ unauthorized, not an error
    expect(await onTx((trx) => resolveIntegrationRunPrincipalOnTransaction(trx, { principalId: `nobody_${RUN}`, tenantId: TENANT }))).toEqual({ ok: false, reason: 'principal_unauthorized' })
  }, 20_000)

  test('production authority path (§6.4): NO resolver seam — the real executor runs its own committed READ COMMITTED authority transaction over the production transaction seam; a seeded principal runs to success with the request-path codes in the port context; deactivated ⇒ skipped(principal_unauthorized) before anything is leased', async () => {
    await q(`DELETE FROM meta_automation_job_leases WHERE scope_key = $1`, [SCOPE])
    // Its own principal and role (the live-authority case above owns PRINCIPAL_ID and leaves it deactivated).
    const principalId = `svc2_${RUN}`
    const roleId = `role2_${RUN}`
    const config = { ...CONFIG, binding: { principalId, tenantId: TENANT } }
    for (const code of ['workflow:write', 'integration:read']) {
      await q(`INSERT INTO permissions (code, name) SELECT $1::varchar, $1::varchar WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE code = $1::varchar)`, [code])
    }
    await q(`INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1, $2, $3, 'x', 'user', true)`, [principalId, `${principalId}@example.test`, 'svc2'])
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [principalId, TENANT])
    await q(`INSERT INTO roles (id, name) VALUES ($1, $2)`, [roleId, roleId])
    await q(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'workflow:write'), ($1, 'integration:read')`, [roleId])
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [principalId, roleId])

    const { port, state } = pagedPort([{ opened: Promise.resolve(), open: () => undefined }])
    // the production shape: poolManager.transaction (poolTransaction) and NO resolveIntegrationRunPrincipal seam
    const A = executorWith(port, poolTransaction, { leaseTtlMs: 5_000 }, { resolveIntegrationRunPrincipal: undefined })
    const step = await A.run(`exec_prod_${RUN}`, config)
    expect(step).toMatchObject({ status: 'success', output: { outcome: 'succeeded' } })
    expect(unitOf(step)).toMatchObject({ outcome: 'succeeded', confirmed: true })
    expect(state.calls).toBe(1)
    const context = state.inputs[0].context
    expect(context.user).toMatchObject({ id: principalId, tenantId: TENANT, role: 'user', roles: [] })
    expect(context.user.permissions).toContain('workflow:write')
    expect([...context.user.permissions].sort()).toEqual([...(await listUserPermissions(principalId))].sort())
    expect(context.authenticatedTenantId).toBe(TENANT)
    expect((await intentRow(intentOf(`exec_prod_${RUN}`, config)))!.status).toBe('sent')
    expect(await leaseRow()).toMatchObject({ fence: '1', holder: null })
    // deactivated ⇒ unauthorized: no lease claimed, no intent row, no port call (read live, every trigger)
    await q(`UPDATE users SET is_active = false WHERE id = $1`, [principalId])
    const refused = await A.run(`exec_prod2_${RUN}`, config)
    expect(refused).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized' } })
    // I6a fix (L3): this is LIVE AUTHORITY's refusal (step 1) — the rule-sheet re-check passed, so no cause is named
    // (the rule-sheet step and the binding check always name one).
    expect(refused.output).not.toHaveProperty('cause')
    expect(state.calls).toBe(1)
    expect(await intentRow(intentOf(`exec_prod2_${RUN}`, config))).toBeUndefined()
    expect(await leaseRow()).toMatchObject({ fence: '1', holder: null })
  }, 20_000)

  test('T10 (frozen clock): A’s local deadline can never pass and its renewal hangs, so after a different root took the scope the DATABASE-side admission guard is the ONLY thing that can refuse page 2 — and it does; A ends lease_lost with no Tx B of its own', async () => {
    await q(`DELETE FROM meta_automation_job_leases WHERE scope_key = $1`, [SCOPE])
    const txGate = gate() // A's heartbeat renewals hang here (never a renew_error, never a renew_timeout within the test)
    const pageTwo = gate()
    const { port: portA, state } = pagedPort([{ opened: Promise.resolve(), open: () => undefined }, pageTwo, { opened: Promise.resolve(), open: () => undefined }])
    const gatedTransaction: JobLeaseTransaction = async (handler) => { await txGate.opened; return poolTransaction(handler) }
    const frozen = Date.now() // the heartbeat's clock never advances ⇒ its local deadline never passes
    const A = executorWith(portA, gatedTransaction, { leaseTtlMs: 2_000, settleGraceMs: 200, heartbeat: { intervalMs: 1_000, renewTimeoutMs: 60_000, safetyMs: 0, now: () => frozen } })
    const stepA = A.run(`exec_frozen_A_${RUN}`)
    for (let i = 0; i < 100 && state.pagesRead < 1; i++) await sleep(20)
    expect(state.pagesRead).toBe(1)
    expect(await leaseRow()).toMatchObject({ fence: '1', live: true })

    // The lease expires on the DATABASE clock only; B — another execution root — takes the scope at fence 2.
    await untilLeaseExpired()
    const B = executorWith(immediatePort, poolTransaction, { leaseTtlMs: 2_000 })
    const stepB = await B.run(`exec_frozen_B_${RUN}`)
    expect(stepB.status).toBe('success')
    expect(await leaseRow()).toMatchObject({ fence: '2', holder: null })
    expect((await intentRow(intentOf(`exec_frozen_B_${RUN}`)))!.status).toBe('sent')

    // A is still running and nothing in-process marked its lease lost: its signal is NOT aborted. Page 2 is
    // admitted through checkpoint() alone ⇒ only the SELECT (fence = mine AND not expired) can refuse it.
    expect(state.inputs[0].signal.aborted).toBe(false)
    pageTwo.open()
    await sleep(300)
    expect(state.pagesRead).toBe(1)
    expect(state.inputs[0].signal.aborted).toBe(false)

    // Release A's hung renewal so its heartbeat.stop() can return: A's step ends lease_lost (Tx B's lock-verify),
    // its intent row stays pending (no terminal write by A), the scope stays B's released fence 2.
    txGate.open()
    const resultA = await stepA
    expect(resultA).toMatchObject({ status: 'failed', output: { outcome: 'outcome_unknown', reason: 'lease_lost' } })
    expect(state.pagesRead).toBe(1)
    expect(state.calls).toBe(1)
    expect(await intentRow(intentOf(`exec_frozen_A_${RUN}`))).toMatchObject({ status: 'pending' })
    expect(await leaseRow()).toMatchObject({ fence: '2', holder: null })
    await Promise.all(A.tracked)
  }, 30_000)

  // ── R-69 I6d: the EDITOR's wire shape on the real tables ─────────────────────────────────────────────────────
  //
  // The rule editor posts the job in `actions[]` and mirrors `actions[0]` into the legacy pair. The save gate used to
  // refuse that shape as "nested" (it compared object identity against a list the service had already copied), so no
  // case before this one put an `actions[]` occurrence through a real INSERT / UPDATE. Here the wire body (JSON
  // round-tripped: no shared object) goes through the route's own parsers into the real createRule / updateRule.
  test('R-69 I6d: the editor wire shape (actions[] + its mirrored pair) saves on the real tables with BOTH JSONB columns stamped, is re-stamped from the stored creator on edit, refuses nested and wrong-project occurrences without a row or a change, and its stored actions[0] runs once', async () => {
    const principalId = `svc6d_${RUN}`
    const editorId = `editor6d_${RUN}`
    const project = `P6D-${RUN}`
    const sheet = `sheet6d_${RUN}`
    await q(`INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1, $2, $3, 'x', 'user', true)`, [principalId, `${principalId}@example.test`, 'svc6d'])
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [principalId, TENANT])
    await registerRuleSheet(sheet, TENANT, project)
    const service = new AutomationService(new EventBus(), db as never, q as never)

    type WireAction = { type: string; config: Record<string, unknown> }
    const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const jobConfig = (projectNo: string, extra: Record<string, unknown> = {}) => ({ job: { kind: 'stock_prep_pull', projectNos: [projectNo], applyMode: 'dry_run_only' }, timeoutMs: 60_000, ...extra })
    const job = (projectNo: string, extra: Record<string, unknown> = {}): WireAction => ({ type: 'run_integration_job', config: jobConfig(projectNo, extra) })
    const other: WireAction = { type: 'update_record', config: { fields: { fld_syn: 'x' } } }
    /** MetaAutomationRuleEditor.vue buildPayload: the action list, the pair mirrored from actions[0], the trigger twice. */
    const editorBody = (actions: WireAction[], overrides: Record<string, unknown> = {}) => {
      const triggerConfig = { cron: '0 6 * * *', timezone: 'Asia/Shanghai' }
      const jobMode = actions.some((action) => action.type === 'condition_branch')
      return wire({
        name: `i6d_${RUN}`, triggerType: 'schedule.cron', triggerConfig, trigger: { type: 'schedule.cron', config: triggerConfig },
        actions, actionType: actions[0].type, actionConfig: actions[0].config, executionMode: jobMode ? 'workflow_job_v1' : null, ...overrides,
      })
    }
    const nestedIn = (nested: WireAction): WireAction => ({
      type: 'condition_branch',
      config: { branches: [{ key: 'b1', conditions: { conjunction: 'AND', conditions: [] }, actions: [other] }], defaultBranch: { key: 'otherwise', actions: [nested] } },
    })
    const foreignBinding = { principalId, tenantId: `${TENANT}_other` }
    const NESTED = 'run_integration_job must be a top-level action (not inside a condition_branch / parallel_branch)'
    const storedRow = async (ruleId: string) => (await q(`SELECT name, action_type, action_config, actions, created_by FROM automation_rules WHERE id = $1`, [ruleId])).rows[0] as
      { name: string; action_type: string; action_config: Record<string, unknown>; actions: WireAction[]; created_by: string }
    const rulesOnSheet = async () => (await q(`SELECT 1 FROM automation_rules WHERE sheet_id = $1`, [sheet])).rows.length
    const refusalOf = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error as Error)

    // a NESTED occurrence that brings its own binding (another tenant): refused, nothing inserted
    const nestedRefusal = await refusalOf(service.createRule(sheet, parseCreateRuleInput(editorBody([other, nestedIn(job(project, { binding: foreignBinding }))]), principalId)))
    expect(nestedRefusal).toBeInstanceOf(AutomationRuleValidationError)
    expect(nestedRefusal!.message).toBe(NESTED)
    // an actions[] occurrence that names a project the sheet is not registered to: refused by the real registry
    const projectRefusal = await refusalOf(service.createRule(sheet, parseCreateRuleInput(editorBody([other, job(`${project}-x`)]), principalId)))
    expect(projectRefusal).toBeInstanceOf(AutomationRuleValidationError)
    expect(projectRefusal!.message).toBe(RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES.project_mismatch)
    expect(await rulesOnSheet()).toBe(0)

    // the editor shape itself: saved, BOTH columns carry the server binding, the client one is gone
    const rule = await service.createRule(sheet, parseCreateRuleInput(editorBody([job(project, { binding: foreignBinding })]), principalId))
    try {
      const stamped = { ...jobConfig(project), binding: { principalId, tenantId: TENANT } }
      const inserted = await storedRow(rule.id)
      expect(inserted.action_type).toBe('run_integration_job')
      expect(inserted.action_config).toEqual(stamped)
      expect(inserted.actions).toEqual([{ type: 'run_integration_job', config: stamped }])
      expect(inserted.created_by).toBe(principalId)

      // an edit by someone else, through the real UPDATE … RETURNING: re-stamped from the STORED creator
      const updated = await service.updateRule(
        rule.id, sheet,
        parseUpdateRuleInput(editorBody([job(project, { timeoutMs: 120_000, binding: { principalId: editorId, tenantId: `${TENANT}_other` } })], { name: `i6d_${RUN}_renamed` }))!,
        editorId,
      )
      expect(updated).not.toBeNull()
      const restamped = { ...stamped, timeoutMs: 120_000 }
      const afterEdit = await storedRow(rule.id)
      expect(afterEdit.name).toBe(`i6d_${RUN}_renamed`)
      expect(afterEdit.action_config).toEqual(restamped)
      expect(afterEdit.actions).toEqual([{ type: 'run_integration_job', config: restamped }])
      expect(afterEdit.created_by).toBe(principalId)
      expect(JSON.stringify(afterEdit)).not.toContain(editorId)

      // an edit that moves the job into a branch, or names another project in actions[]: refused, the row is unchanged
      const moved = await refusalOf(service.updateRule(rule.id, sheet, parseUpdateRuleInput(editorBody([other, nestedIn(job(project))]))!, editorId))
      expect(moved).toBeInstanceOf(AutomationRuleValidationError)
      expect(moved!.message).toBe(NESTED)
      const renamedProject = await refusalOf(service.updateRule(rule.id, sheet, parseUpdateRuleInput(wire({ actions: [job(`${project}-x`)] }))!, editorId))
      expect(renamedProject).toBeInstanceOf(AutomationRuleValidationError)
      expect(renamedProject!.message).toBe(RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES.project_mismatch)
      expect(await storedRow(rule.id)).toEqual(afterEdit)

      // what the executor runs is the stored actions[0]: once, to the port, for the one project
      const runnable = toExecutorRule(updated!).actions
      expect(runnable).toHaveLength(1)
      const { port, state } = pagedPort([{ opened: Promise.resolve(), open: () => undefined }])
      const X = executorWith(port, poolTransaction, { leaseTtlMs: 2_000 }, { resolveIntegrationRunPrincipal: async () => ({ ok: true, user: { ...PRINCIPAL, id: principalId } }) })
      const step = await X.run(`exec_i6d_${RUN}`, runnable[0].config as unknown as typeof CONFIG, sheet)
      expect(step).toMatchObject({ status: 'success', output: { outcome: 'succeeded' } })
      expect(state.calls).toBe(1)
      expect(state.inputs[0].job).toEqual({ kind: 'stock_prep_pull', projectNo: project })
      expect(state.inputs[0].context.authenticatedTenantId).toBe(TENANT)
    } finally {
      service.unregisterSchedule(rule.id)
      await q(`DELETE FROM automation_rules WHERE id = $1`, [rule.id]).catch(() => undefined)
    }
  }, 30_000)

  test("R-69 I6a (ADR §3.1 + §6.5): the save refuses ANOTHER tenant's registered sheet (nothing written); a trigger after the rule sheet is ARCHIVED is skipped(rule_sheet_unregistered) with 0 port calls, no intent row, no lease", async () => {
    // Its own principal (one active membership in TENANT), its own registered sheet + project, its own scope.
    const principalId = `svc6_${RUN}`
    const project = `P6-${RUN}`
    const sheet = `sheet6_${RUN}`
    const foreignSheet = `sheet6x_${RUN}`
    const scope = jobLeaseScopeKey({ kind: 'stock_prep_pull', tenantId: TENANT, projectNo: project })
    await q(`INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1, $2, $3, 'x', 'user', true)`, [principalId, `${principalId}@example.test`, 'svc6'])
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [principalId, TENANT])
    await registerRuleSheet(sheet, TENANT, project)
    await registerRuleSheet(foreignSheet, `${TENANT}_other`, project)
    const service = new AutomationService(new EventBus(), db as never, q as never)
    const ruleInput = {
      triggerType: 'schedule.cron', triggerConfig: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
      actionType: 'run_integration_job', actionConfig: { job: { kind: 'stock_prep_pull', projectNos: [project], applyMode: 'dry_run_only' } },
      createdBy: principalId, name: `i6a_${RUN}`,
    }
    // save on another tenant's registered sheet: a 400-class refusal, and no rule row on that sheet
    const refusal = await service.createRule(foreignSheet, ruleInput as never).then(() => null, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect((refusal as Error).message).toBe(RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES.tenant_mismatch)
    expect((await q(`SELECT 1 FROM automation_rules WHERE sheet_id = $1`, [foreignSheet])).rows).toHaveLength(0)
    // save on its own registered sheet succeeds and stamps the binding
    const rule = await service.createRule(sheet, ruleInput as never)
    try {
      expect(rule.sheet_id).toBe(sheet)
      const config = rule.action_config as unknown as typeof CONFIG
      expect(config.binding).toEqual({ principalId, tenantId: TENANT })
      // control: the registered sheet runs once
      const { port, state } = pagedPort([{ opened: Promise.resolve(), open: () => undefined }])
      const X = executorWith(port, poolTransaction, { leaseTtlMs: 2_000 }, { resolveIntegrationRunPrincipal: async () => ({ ok: true, user: { ...PRINCIPAL, id: principalId } }) })
      expect((await X.run(`exec_i6a_ok_${RUN}`, config, sheet)).status).toBe('success')
      expect(state.calls).toBe(1)
      // I6a fix (L3) — the POSITIVE CONTROL of the two "nothing was claimed" lookups below: the SAME intent lookup
      // finds the ok run's row, and the SAME lease read finds its lease. An undefined intent / an unchanged lease
      // after the archive is therefore a real absence, not a mis-keyed read.
      const i6aIntent = (root: string): OutboundIntentIdentity => ({ ...intentOf(root, config), targetKey: deriveOutboundTargetKey(['stock_prep_pull', TENANT, project]) })
      expect(await intentRow(i6aIntent(`exec_i6a_ok_${RUN}`))).toMatchObject({ status: 'sent' })
      // archive (the S4 shape: status + archived_at together, the CHECK holds) ⇒ the next trigger never reaches the port
      await q(`UPDATE integration_stock_prep_project_target SET status = 'archived', archived_at = now(), archived_by = 'syn' WHERE sheet_id = $1`, [sheet])
      const leaseBefore = (await q(`SELECT fence::text AS fence FROM meta_automation_job_leases WHERE scope_key = $1`, [scope])).rows
      expect(leaseBefore).toEqual([{ fence: '1' }])
      const skipped = await X.run(`exec_i6a_archived_${RUN}`, config, sheet)
      expect(skipped).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized', cause: 'rule_sheet_unregistered' } })
      expect(state.calls).toBe(1)
      expect(await intentRow(i6aIntent(`exec_i6a_archived_${RUN}`))).toBeUndefined()
      expect((await q(`SELECT fence::text AS fence FROM meta_automation_job_leases WHERE scope_key = $1`, [scope])).rows).toEqual(leaseBefore)
    } finally {
      await q(`DELETE FROM automation_rules WHERE id = $1`, [rule.id]).catch(() => undefined)
    }
  }, 20_000)

  test('R-69 I6a fix (re-review M1): the rule sheet id is EXACT on the real registry read — the registered id plus one whitespace code point is refused at save (no rule row) and at every trigger (0 port calls, no intent row, no lease); the registered id itself saves and runs', async () => {
    // Its own principal, registered sheet + project and scope. A look-alike is the registered id plus ONE code point
    // String.prototype.trim() strips, on either side: the sheet-create route takes such text as a client id, so each
    // names a different, ordinary sheet — and a read with a TRIMMED id would find the registered row.
    const principalId = `svc7_${RUN}`
    const project = `P7-${RUN}`
    const sheet = `sheet7_${RUN}`
    const lookalikes = [`${sheet} `, ` ${sheet}`, `${sheet}\t`, `\u00a0${sheet}`]
    const scope = jobLeaseScopeKey({ kind: 'stock_prep_pull', tenantId: TENANT, projectNo: project })
    await q(`INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1, $2, $3, 'x', 'user', true)`, [principalId, `${principalId}@example.test`, 'svc7'])
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [principalId, TENANT])
    await registerRuleSheet(sheet, TENANT, project)
    const service = new AutomationService(new EventBus(), db as never, q as never)
    const ruleInput = {
      triggerType: 'schedule.cron', triggerConfig: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
      actionType: 'run_integration_job', actionConfig: { job: { kind: 'stock_prep_pull', projectNos: [project], applyMode: 'dry_run_only' } },
      createdBy: principalId, name: `i6a_m1_${RUN}`,
    }
    try {
      // the premise on the real table: ONE registry row answers these ids — the registered id's own
      expect((await q(`SELECT sheet_id FROM integration_stock_prep_project_target WHERE sheet_id = ANY($1::text[])`, [[sheet, ...lookalikes]])).rows).toEqual([{ sheet_id: sheet }])
      // SAVE: every look-alike is refused as unregistered, and no rule row lands under any of them
      for (const lookalike of lookalikes) {
        expect(lookalike.trim()).toBe(sheet)
        const saved = await service.createRule(lookalike, ruleInput as never).then((rule) => rule, (error: unknown) => error)
        expect(saved).toBeInstanceOf(AutomationRuleValidationError)
        expect((saved as Error).message).toBe(RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES.unregistered)
      }
      expect((await q(`SELECT sheet_id FROM automation_rules WHERE sheet_id = ANY($1::text[])`, [lookalikes])).rows).toHaveLength(0)
      // control: the registered id itself saves, under exactly that id
      const rule = await service.createRule(sheet, ruleInput as never)
      expect(rule.sheet_id).toBe(sheet)
      const config = rule.action_config as unknown as typeof CONFIG
      const m1Intent = (root: string): OutboundIntentIdentity => ({ ...intentOf(root, config), targetKey: deriveOutboundTargetKey(['stock_prep_pull', TENANT, project]) })
      const leaseRows = async () => (await q(`SELECT fence::text AS fence FROM meta_automation_job_leases WHERE scope_key = $1`, [scope])).rows
      const { port, state } = pagedPort([{ opened: Promise.resolve(), open: () => undefined }])
      const X = executorWith(port, poolTransaction, { leaseTtlMs: 2_000 }, { resolveIntegrationRunPrincipal: async () => ({ ok: true, user: { ...PRINCIPAL, id: principalId } }) })
      // TRIGGER: the saved rule's own config on each look-alike sheet id never reaches the port and claims nothing
      for (const [index, lookalike] of lookalikes.entries()) {
        const root = `exec_m1_lookalike${index}_${RUN}`
        expect(await X.run(root, config, lookalike)).toMatchObject({ status: 'skipped', output: { outcome: 'skipped', reason: 'principal_unauthorized', cause: 'rule_sheet_unregistered' } })
        expect(await intentRow(m1Intent(root))).toBeUndefined()
      }
      expect(state.calls).toBe(0)
      expect(await leaseRows()).toEqual([])
      // control: the registered id runs once — and the SAME lookups find its intent row and its lease
      expect((await X.run(`exec_m1_ok_${RUN}`, config, sheet)).status).toBe('success')
      expect(state.calls).toBe(1)
      expect(await intentRow(m1Intent(`exec_m1_ok_${RUN}`))).toMatchObject({ status: 'sent' })
      expect(await leaseRows()).toEqual([{ fence: '1' }])
    } finally {
      // by sheet id: a look-alike rule row exists only if the guard regressed — never leave one (or the control's) behind
      await q(`DELETE FROM automation_rules WHERE sheet_id = ANY($1::text[])`, [[sheet, ...lookalikes]]).catch(() => undefined)
    }
  }, 20_000)
})

// ── R-69 I6d fix round 2 (F1): updateRule against a CONCURRENT PATCH, on the real table ───────────────────────
//
// updateRule validates the MERGED rule (request ?? stored) and writes only the columns the request sent. Without a
// row-version predicate on that write, two PATCHes that each validated against the same stored row can leave a
// combination NEITHER of them validated: the job type over a config no gate ever saw (a client `binding` that names
// another tenant), or the job on a trigger that is not schedule.cron.
//
// HOW THE INTERLEAVING IS MADE DETERMINISTIC. Each request runs in its OWN AutomationService over its OWN
// one-connection pool — two backends, the shape of two app processes, so nothing held in one process's memory could
// pass these cases — and ONE statement of the first request is HELD at the moment it would be sent: a wrapper around
// the Kysely handle the test hands to that service makes the terminal call of its next
// `updateTable('automation_rules')` (or of a chosen `selectFrom('automation_rules')`) wait for the test. No
// production seam is involved, so this block runs unchanged on the source as it was before the fix.
//
// Order in every case: the HELD request runs up to the held statement (built, not sent) → the OTHER request runs to
// completion on the second backend → the held statement is sent.

/** Which automation_rules statement of a request to hold: its UPDATE, or its n-th SELECT (1 = the next one). */
type HeldStatement = 'update' | { read: number }

/** A handle on `real` that holds ONE automation_rules statement at its terminal call once `holdNext()` armed it. */
function heldRuleStatements<T extends object>(real: T) {
  type Hold = { reach: () => void; released: Promise<void> }
  let armed: { hold: Hold; verb: 'updateTable' | 'selectFrom'; skip: number } | null = null
  // Kysely's builders are immutable and keep their state in private fields: every call goes to the real object
  // (never with the proxy as `this`), and every builder a call returns is wrapped again, down to the terminal call.
  const holdBuilder = (builder: object, hold: Hold): object => new Proxy(builder, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => unknown
      return (...args: unknown[]) => {
        if (prop === 'execute' || prop === 'executeTakeFirst') {
          hold.reach()
          return hold.released.then(() => method.apply(target, args))
        }
        const next = method.apply(target, args)
        return next !== null && typeof next === 'object' && typeof (next as { execute?: unknown }).execute === 'function'
          ? holdBuilder(next as object, hold)
          : next
      }
    },
  })
  const handle = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => unknown
      return (...args: unknown[]) => {
        const out = method.apply(target, args)
        if (!armed || prop !== armed.verb || args[0] !== 'automation_rules') return out
        if (armed.skip > 0) {
          armed.skip -= 1
          return out
        }
        const { hold } = armed
        armed = null // one statement only: a later statement of the same request (its re-validated write) is not held
        return holdBuilder(out as object, hold)
      }
    },
  })
  const holdNext = (statement: HeldStatement = 'update') => {
    let reach!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => { reach = resolve })
    const released = new Promise<void>((resolve) => { release = resolve })
    armed = statement === 'update'
      ? { hold: { reach, released }, verb: 'updateTable', skip: 0 }
      : { hold: { reach, released }, verb: 'selectFrom', skip: statement.read - 1 }
    return { reached, release }
  }
  return { handle, holdNext }
}

/** One AutomationService whose every automation_rules statement runs on ONE backend of its own. */
function ownBackendService() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  const kysely = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  const held = heldRuleStatements(kysely)
  const query = (text: string, params?: unknown[]) => pool.query(text, params)
  const service = new AutomationService(new EventBus(), held.handle as never, query as never)
  const backendPid = async () => Number(((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
  return { service, holdNext: held.holdNext, backendPid, close: () => kysely.destroy() }
}

describeIfDatabase('R-69 I6d fix round 2 (F1): a PATCH whose stored row changed under it is re-validated, never written as it was (two backends, the first UPDATE held)', () => {
  const principalId = `svcf1_${RUN}`
  const project = `PF1-${RUN}`
  const sheet = `sheetf1_${RUN}`
  const serverBinding = { principalId, tenantId: TENANT }
  const forgedBinding = { principalId, tenantId: `${TENANT}_other` }
  // 1 January only: the cron this file registers on its schedulers does not fire while the file runs.
  const cron = { cron: '0 6 1 1 *', timezone: 'Asia/Shanghai' }
  const jobConfig = (projectNo: string = project, extra: Record<string, unknown> = {}) => ({ job: { kind: 'stock_prep_pull', projectNos: [projectNo], applyMode: 'dry_run_only' }, timeoutMs: 60_000, ...extra })
  const jobPatch = { actionType: 'run_integration_job', actionConfig: jobConfig() }
  const recordTriggerPatch = { triggerType: 'record.created', triggerConfig: {} }
  const COUPLING = 'run_integration_job (stock_prep_pull) is only allowed on a schedule.cron trigger (got record.created)'
  const savedFlag = process.env[FLAG]
  const savedProjectSheets = process.env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV]
  let A: ReturnType<typeof ownBackendService>
  let B: ReturnType<typeof ownBackendService>

  beforeAll(async () => {
    process.env[FLAG] = 'true'
    process.env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV] = 'true'
    await q(`INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1, $2, $3, 'x', 'user', true)`, [principalId, `${principalId}@example.test`, 'svcf1'])
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [principalId, TENANT])
    await registerRuleSheet(sheet, TENANT, project)
    A = ownBackendService()
    B = ownBackendService()
  })
  afterAll(async () => {
    if (savedFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = savedFlag
    if (savedProjectSheets === undefined) delete process.env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV]
    else process.env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV] = savedProjectSheets
    await q(`DELETE FROM automation_rules WHERE sheet_id = $1`, [sheet]).catch(() => undefined)
    await q(`DELETE FROM integration_stock_prep_project_target WHERE sheet_id = $1`, [sheet]).catch(() => undefined)
    await q(`DELETE FROM user_orgs WHERE user_id = $1`, [principalId]).catch(() => undefined)
    await q(`DELETE FROM users WHERE id = $1`, [principalId]).catch(() => undefined)
    await A?.close().catch(() => undefined)
    await B?.close().catch(() => undefined)
  })

  type StoredRule = { trigger_type: string; action_type: string; action_config: Record<string, unknown>; actions: unknown; version_ms: string }
  const storedRule = async (ruleId: string) => (await q(
    `SELECT trigger_type, action_type, action_config, actions, (extract(epoch FROM date_trunc('milliseconds', updated_at)) * 1000)::bigint::text AS version_ms
       FROM automation_rules WHERE id = $1`,
    [ruleId],
  )).rows[0] as StoredRule
  /** A stored rule that carries NO job: schedule.cron with a timezone, and an action no save gate looks at. */
  const seedPlainCronRule = (name: string) => A.service.createRule(sheet, { name, triggerType: 'schedule.cron', triggerConfig: cron, actionType: 'record_click', actionConfig: {}, createdBy: principalId } as never)
  const dropRule = async (ruleId: string) => {
    A.service.unregisterSchedule(ruleId)
    B.service.unregisterSchedule(ruleId)
    await q(`DELETE FROM automation_rules WHERE id = $1`, [ruleId]).catch(() => undefined)
  }
  type Settled = { ok: true; value: unknown } | { ok: false; error: Error }
  const settle = (work: Promise<unknown>): Promise<Settled> => work.then(
    (value): Settled => ({ ok: true, value }),
    (error: unknown): Settled => ({ ok: false, error: error as Error }),
  )
  /** HELD (backend A) runs up to its held statement and waits; OTHER (backend B) runs to completion; then it is sent. */
  const interleave = async (ruleId: string, heldPatch: Record<string, unknown>, otherPatch: Record<string, unknown>, statement: HeldStatement = 'update') => {
    const hold = A.holdNext(statement)
    const held = settle(A.service.updateRule(ruleId, sheet, heldPatch as never, principalId))
    await Promise.race([
      hold.reached,
      held.then(() => { throw new Error('the held PATCH settled before it reached the statement to hold') }),
    ])
    const other = await settle(B.service.updateRule(ruleId, sheet, otherPatch as never, principalId))
    hold.release()
    return { held: await held, other }
  }

  test('the two requests are two backends', async () => {
    expect(await A.backendPid()).not.toBe(await B.backendPid())
  })

  test('action type × action config: the config PATCH that lost the race is re-validated as the JOB config it has become — stored with the SERVER binding, its own (another tenant) dropped', async () => {
    const rule = await seedPlainCronRule(`f1_u_same_${RUN}`)
    try {
      const { held, other } = await interleave(
        rule.id,
        // read while the action is record_click: no gate looks at this config, binding included
        { actionConfig: jobConfig(project, { timeoutMs: 120_000, binding: forgedBinding }) },
        // read while the config is {}: the job gate validates and stamps ITS config
        jobPatch,
      )
      expect(other.ok).toBe(true)
      const row = await storedRule(rule.id)
      expect(row.action_type).toBe('run_integration_job')
      // what every save validated: a stored job config carries the SERVER binding
      expect(row.action_config.binding).toEqual(serverBinding)
      // the loser was not dropped either: validated again against the winner's row, it is the stored config
      expect(held).toMatchObject({ ok: true })
      expect(row.action_config).toEqual({ ...jobConfig(project, { timeoutMs: 120_000 }), binding: serverBinding })
      expect(row.trigger_type).toBe('schedule.cron')
    } finally {
      await dropRule(rule.id)
    }
  }, 30_000)

  test('action type × action config: a loser that names ANOTHER project is refused by the rule-sheet guard when re-validated; the row is the winner\'s', async () => {
    const rule = await seedPlainCronRule(`f1_u_other_${RUN}`)
    try {
      const { held, other } = await interleave(rule.id, { actionConfig: jobConfig(`${project}-x`, { binding: forgedBinding }) }, jobPatch)
      expect(other.ok).toBe(true)
      const row = await storedRule(rule.id)
      expect(row.action_type).toBe('run_integration_job')
      expect(row.action_config).toEqual({ ...jobConfig(), binding: serverBinding })
      expect(held.ok).toBe(false)
      const refusal = (held as { error: Error }).error
      expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
      expect(refusal.message).toBe(RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES.project_mismatch)
      expect((refusal as AutomationRuleValidationError).code).toBe('VALIDATION_ERROR')
    } finally {
      await dropRule(rule.id)
    }
  }, 30_000)

  test('trigger × action, the TRIGGER PATCH held: re-validated against the job it now sits under, it is refused with the coupling message; the rule stays schedule.cron', async () => {
    const rule = await seedPlainCronRule(`f1_d_trigger_${RUN}`)
    try {
      // held: read while the action is record_click (no coupling); other: read while the trigger is schedule.cron
      const { held, other } = await interleave(rule.id, recordTriggerPatch, jobPatch)
      expect(other.ok).toBe(true)
      const row = await storedRule(rule.id)
      expect([row.trigger_type, row.action_type]).toEqual(['schedule.cron', 'run_integration_job'])
      expect(row.action_config).toEqual({ ...jobConfig(), binding: serverBinding })
      expect(held.ok).toBe(false)
      const refusal = (held as { error: Error }).error
      expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
      expect(refusal.message).toBe(COUPLING)
    } finally {
      await dropRule(rule.id)
    }
  }, 30_000)

  test('trigger × action, the JOB PATCH held: re-validated against the trigger the rule now has, it is refused with the coupling message; the action stays what it was', async () => {
    const rule = await seedPlainCronRule(`f1_d_job_${RUN}`)
    try {
      const { held, other } = await interleave(rule.id, jobPatch, recordTriggerPatch)
      expect(other.ok).toBe(true)
      const row = await storedRule(rule.id)
      expect([row.trigger_type, row.action_type]).toEqual(['record.created', 'record_click'])
      expect(row.action_config).toEqual({})
      expect(held.ok).toBe(false)
      const refusal = (held as { error: Error }).error
      expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
      expect(refusal.message).toBe(COUPLING)
    } finally {
      await dropRule(rule.id)
    }
  }, 30_000)

  test('the row changed BETWEEN the two reads of one save (a PATCH of the action AND the trigger config): its write is bound to the FIRST version it read, so it is refused and validated again', async () => {
    const rule = await seedPlainCronRule(`f1_between_reads_${RUN}`)
    try {
      // held: read 1 (the action block) sees schedule.cron, so the job gate passes; read 2 (the trigger block) is held.
      // other: the trigger becomes record.created. Read 2 then sees the NEW row — and a write bound to that read's
      // version would go through, leaving the job on record.created.
      const { held, other } = await interleave(rule.id, { ...jobPatch, triggerConfig: { cron: '0 7 1 1 *', timezone: 'Asia/Shanghai' } }, recordTriggerPatch, { read: 2 })
      expect(other.ok).toBe(true)
      const row = await storedRule(rule.id)
      expect([row.trigger_type, row.action_type]).toEqual(['record.created', 'record_click'])
      expect(row.action_config).toEqual({})
      expect(held.ok).toBe(false)
      const refusal = (held as { error: Error }).error
      expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
      expect(refusal.message).toBe(COUPLING)
    } finally {
      await dropRule(rule.id)
    }
  }, 30_000)

  test('a rule DELETED under a held save answers "not found" (null), as it did before: the second validation reads no row', async () => {
    const rule = await seedPlainCronRule(`f1_deleted_${RUN}`)
    try {
      const hold = A.holdNext()
      const held = settle(A.service.updateRule(rule.id, sheet, { name: `f1_deleted_${RUN}_renamed` }, principalId))
      await hold.reached
      expect(await B.service.deleteRule(rule.id, sheet)).toBe(true)
      hold.release()
      expect(await held).toEqual({ ok: true, value: null })
      expect((await q(`SELECT 1 FROM automation_rules WHERE id = $1`, [rule.id])).rows).toHaveLength(0)
    } finally {
      await dropRule(rule.id)
    }
  }, 30_000)

  test('the row version is strictly increasing: two saves stamped in the SAME millisecond (the app clock frozen) are two versions, so a write held across the second one is not written as it was', async () => {
    const rule = await seedPlainCronRule(`f1_same_ms_${RUN}`)
    // Only `Date` is faked (timers stay real): every `new Date()` in this process answers the same instant, one hour
    // ahead of the database clock, so every save below is stamped with the SAME millisecond by the application.
    const frozen = Date.now() + 3_600_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(frozen)
    try {
      // save 1 (a rename): the row's version becomes the frozen instant
      expect(await B.service.updateRule(rule.id, sheet, { name: `f1_same_ms_${RUN}_renamed` }, principalId)).not.toBeNull()
      expect((await storedRule(rule.id)).version_ms).toBe(String(frozen))
      // held: reads version = frozen. save 2 (the job) is stamped with the same millisecond — and is still a new version.
      const { held, other } = await interleave(rule.id, { actionConfig: jobConfig(project, { timeoutMs: 120_000, binding: forgedBinding }) }, jobPatch)
      expect(other.ok).toBe(true)
      const row = await storedRule(rule.id)
      expect(row.action_type).toBe('run_integration_job')
      expect(row.action_config.binding).toEqual(serverBinding)
      expect(held).toMatchObject({ ok: true })
      expect(row.action_config).toEqual({ ...jobConfig(project, { timeoutMs: 120_000 }), binding: serverBinding })
      // three saves in one application millisecond: three versions, one millisecond apart
      expect(row.version_ms).toBe(String(frozen + 2))
    } finally {
      vi.useRealTimers()
      await dropRule(rule.id)
    }
  }, 30_000)
})

// ── R-69 1c: integration.run_finished on the REAL tables ─────────────────────────────────────────────────────
//
// The action layer's summary, published through the real port, dispatched by a real AutomationService into the
// REAL per-rule claim ledger (meta_automation_event_fires): a replayed step (same deterministic event id) reaches the
// rule once; a new execution reaches it again. And the trigger CHECK migration's up / down on the real constraint.
// The rule's action is never executed here (executeRule is observed, not run): no message is sent.
describeIfDatabase('R-69 1c integration.run_finished on real tables (event-fires claim; trigger CHECK up/down)', () => {
  const RULE = `rule_rf_${RUN}`
  const RF_PROJECT = `PRF-${RUN}`
  const RF_CONFIG = { ...CONFIG, job: { ...CONFIG.job, projectNos: [RF_PROJECT] } }
  const EVENT_FLAG = 'INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED'
  const savedAction = process.env[FLAG]
  const savedEvent = process.env[EVENT_FLAG]
  const savedProjectSheets = process.env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV]
  const insertRule = (id: string, triggerType = 'integration.run_finished') => q(
    `INSERT INTO automation_rules (id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_by)
     VALUES ($1, $2, 'rf', $3, $4::jsonb, 'send_notification', '{}'::jsonb, true, $5)`,
    [id, `sheet_rf_${RUN}`, triggerType, JSON.stringify({ job: { kind: 'stock_prep_pull' }, statuses: ['succeeded'], binding: { principalId: PRINCIPAL_ID, tenantId: TENANT } }), PRINCIPAL_ID],
  )

  beforeAll(async () => {
    await leasesUp(db as never)
    await runFinishedTriggerUp(db as never)
    process.env[FLAG] = 'true'
    process.env[EVENT_FLAG] = 'true'
    process.env[STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV] = 'true'
    await registerRuleSheet()
  })
  afterAll(async () => {
    clearIntegrationRunFinishedSinkForTest()
    for (const [key, saved] of [[FLAG, savedAction], [EVENT_FLAG, savedEvent], [STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, savedProjectSheets]] as const) {
      if (saved === undefined) delete process.env[key]
      else process.env[key] = saved
    }
    await unregisterRuleSheets()
    await q(`DELETE FROM meta_automation_event_fires WHERE rule_id LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    await q(`DELETE FROM automation_rules WHERE id LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    await q(`DELETE FROM meta_automation_outbound_intent WHERE root_execution_id LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    await q(`DELETE FROM meta_automation_job_leases WHERE scope_key LIKE $1`, [`%${RUN}%`]).catch(() => undefined)
    await runFinishedTriggerUp(db as never).catch(() => undefined)
  })

  test('a replayed step (same deterministic id) reaches the rule ONCE through the real claim ledger; a new execution reaches it again', async () => {
    await insertRule(RULE)
    const service = new AutomationService(new EventBus(), db as never, q as never)
    service.setIntegrationRunFinishedCreatorResolverForTest(async () => ({ ok: true, user: { ...PRINCIPAL, permissions: ['integration:read', 'workflow:write'] } }))
    const executeRule = vi.spyOn(service, 'executeRule').mockResolvedValue({} as never)
    registerIntegrationRunFinishedSink(`rf_${RUN}`, (event, route) => service.dispatchIntegrationRunFinished(event, route))
    const X = executorWith(immediatePort, poolTransaction, { leaseTtlMs: 2_000 })
    const first = await X.run(`exec_rf_${RUN}`, RF_CONFIG)
    expect(first.status).toBe('success')
    const replay = await X.run(`exec_rf_${RUN}`, RF_CONFIG) // the same execution again: intent sent ⇒ already_applied, same id
    expect(replay.status).toBe('success')
    expect(executeRule).toHaveBeenCalledTimes(1)
    const fires = await q(`SELECT dedup_key FROM meta_automation_event_fires WHERE rule_id = $1`, [RULE])
    expect(fires.rows).toHaveLength(1)
    expect(String((fires.rows[0] as { dedup_key: string }).dedup_key)).toMatch(/^integration\.run_finished:[0-9a-f]{64}$/)
    const payload = executeRule.mock.calls[0][1] as Record<string, unknown>
    expect(payload.run).toMatchObject({ status: 'succeeded', job: { kind: 'stock_prep_pull', projectNo: RF_PROJECT }, triggeredBy: 'automation' })
    expect(JSON.stringify(payload)).not.toContain(TENANT)
    await X.run(`exec_rf2_${RUN}`, RF_CONFIG) // a new execution: a new id ⇒ the rule runs again
    expect(executeRule).toHaveBeenCalledTimes(2)
  }, 20_000)

  // fix-I5 F5: the tenant wall on the REAL loader (its SQL filter on the stamped binding) AND the in-loop binding
  // check. A rule bound to another tenant (same creator, same job kind, same statuses) must never fire on this
  // tenant's summary. Red only when BOTH layers are removed (each is the other's defense in depth); the unit suite
  // pins the in-loop layer alone.
  test('tenant wall: a rule bound to ANOTHER tenant never fires on this tenant\'s summary (real loader + in-loop check)', async () => {
    const ruleA = `${RULE}_tenant_a`
    const ruleB = `${RULE}_tenant_b`
    const insertBound = (id: string, tenantId: string) => q(
      `INSERT INTO automation_rules (id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_by)
       VALUES ($1, $2, 'rf', 'integration.run_finished', $3::jsonb, 'send_notification', '{}'::jsonb, true, $4)`,
      [id, `sheet_rf_${RUN}`, JSON.stringify({ job: { kind: 'stock_prep_pull' }, statuses: ['succeeded'], binding: { principalId: PRINCIPAL_ID, tenantId } }), PRINCIPAL_ID],
    )
    try {
      await insertBound(ruleA, TENANT)
      await insertBound(ruleB, `${TENANT}_other`)
      const service = new AutomationService(new EventBus(), db as never, q as never)
      service.setIntegrationRunFinishedCreatorResolverForTest(async () => ({ ok: true, user: { ...PRINCIPAL, permissions: ['integration:read', 'workflow:write'] } }))
      const executeRule = vi.spyOn(service, 'executeRule').mockResolvedValue({} as never)
      registerIntegrationRunFinishedSink(`rf_tenant_${RUN}`, (event, route) => service.dispatchIntegrationRunFinished(event, route))
      const X = executorWith(immediatePort, poolTransaction, { leaseTtlMs: 2_000 })
      const step = await X.run(`exec_rft_${RUN}`, RF_CONFIG)
      expect(step.status).toBe('success')
      const fired = executeRule.mock.calls.map((call) => (call[0] as { id: string }).id).filter((id) => id === ruleA || id === ruleB)
      expect(fired).toEqual([ruleA])
    } finally {
      await q(`DELETE FROM meta_automation_event_fires WHERE rule_id = ANY($1::text[])`, [[ruleA, ruleB]])
      await q(`DELETE FROM automation_rules WHERE id = ANY($1::text[])`, [[ruleA, ruleB]])
    }
  }, 20_000)

  test('trigger CHECK migration: up admits the type; down REFUSES while a rule uses it, then restores the prior set; up again', async () => {
    await expect(runFinishedTriggerDown(db as never)).rejects.toThrow(/still use trigger_type 'integration.run_finished'/)
    await q(`DELETE FROM automation_rules WHERE id = $1`, [RULE])
    await runFinishedTriggerDown(db as never)
    await expect(insertRule(`${RULE}_after_down`)).rejects.toMatchObject({ code: '23514' })
    await insertRule(`${RULE}_prior_type`, 'approval.task_created') // the prior set is intact
    await runFinishedTriggerUp(db as never)
    await insertRule(`${RULE}_after_up`)
    const { rows } = await q(`SELECT id FROM automation_rules WHERE id = ANY($1::text[]) ORDER BY id`, [[`${RULE}_after_up`, `${RULE}_prior_type`]])
    expect(rows).toHaveLength(2)
  }, 20_000)
})

// ── ADR §11: the four-fixture permission equivalence matrix (port principal ≡ request-time profile) ─────────────
//
// ADR adr-automation-pipeline-bridge-20261103 §6.x / §11: for the four fixtures below, the permission codes in the
// port's principal context (resolveIntegrationRunPrincipalOnTransaction, on a committed READ COMMITTED transaction)
// equal, code for code, the codes of the REQUEST-TIME profile — AuthService.verifyToken → getUserById →
// resolveRbacProfile, with the dev-only claim-trusting fast path OFF so the profile comes from the database exactly
// as on a production request (precedent: approval-can-decide-current-node.db.test.ts withoutTokenClaimTrust). The
// expected code set of each fixture is ALSO pinned, so the two sides cannot agree by both widening.
//
//   F1  a role granting stock-prep:pull|operate|read + workflow:write, and an ENABLED stock-prep admission
//   F2  the same codes granted DIRECTLY in user_permissions (an enabled stock-prep admission too): no role reaches
//       the namespace ⇒ every stock-prep:* code is dropped on both sides (R-66 ③)
//   F3  the F1 role with NO admission ⇒ every stock-prep:* code is dropped on both sides
//   F4  a role granting legacy integration:write + workflow:write, and an enabled `integration` admission
//       (`integration` is admission-controlled like stock-prep; without the row both sides drop it — F3's case)
//
// PRODUCT_MODE: AuthService adds the attendance self-service codes when supportsAttendanceSelfService(PRODUCT_MODE)
// holds — and an UNSET PRODUCT_MODE normalizes to 'platform', which supports it. So the strict matrix pins
// PRODUCT_MODE to 'plm-workbench' (self-service off), and a second case runs the default (unset) mode and asserts
// the difference explicitly: request − port is exactly {attendance:read, attendance:write}, nothing else differs.
//
// Witness (seen red): replacing the admission-filtered listUserPermissions(id, trx) in automation-run-authority.ts
// with the unfiltered union turns F2 and F3 red.
describeIfDatabase('ADR §11 permission equivalence: port principal codes ≡ request-time profile codes (four fixtures)', () => {
  const MATRIX_TENANT = `tenant_mx_${RUN}`
  const ROLE_PULL = `role_mx_pull_${RUN}`
  const ROLE_LEGACY = `role_mx_legacy_${RUN}`
  const PULL_LADDER = ['stock-prep:operate', 'stock-prep:pull', 'stock-prep:read']
  const ATTENDANCE_SELF_SERVICE = ['attendance:read', 'attendance:write']
  type Fixture = { name: 'F1' | 'F2' | 'F3' | 'F4'; expected: string[] }
  const FIXTURES: Fixture[] = [
    { name: 'F1', expected: [...PULL_LADDER, 'workflow:write'] },
    { name: 'F2', expected: ['workflow:write'] },
    { name: 'F3', expected: ['workflow:write'] },
    { name: 'F4', expected: ['integration:write', 'workflow:write'] },
  ]
  const userIdOf = (fixture: Fixture['name'], mode: 'strict' | 'platform') => `mx_${fixture.toLowerCase()}_${mode}_${RUN}`
  const savedEnv = { PRODUCT_MODE: process.env.PRODUCT_MODE, RBAC_TOKEN_TRUST: process.env.RBAC_TOKEN_TRUST }

  async function seedFixture(fixture: Fixture['name'], userId: string): Promise<void> {
    await q(`INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1, $2, $3, 'x', 'user', true)`, [userId, `${userId}@example.test`, userId])
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [userId, MATRIX_TENANT])
    const admit = (namespace: string) => q(`INSERT INTO user_namespace_admissions (user_id, namespace, enabled) VALUES ($1, $2, true)`, [userId, namespace])
    if (fixture === 'F1') {
      await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, ROLE_PULL])
      await admit('stock-prep')
    } else if (fixture === 'F2') {
      for (const code of [...PULL_LADDER, 'workflow:write']) {
        await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)`, [userId, code])
      }
      await admit('stock-prep')
    } else if (fixture === 'F3') {
      await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, ROLE_PULL])
    } else {
      await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, ROLE_LEGACY])
      await admit('integration')
    }
  }

  /** The port side: the production resolver on a committed READ COMMITTED transaction (the executor's seam shape). */
  async function portPrincipal(userId: string) {
    const resolution = await poolTransaction(async ({ query }) => resolveIntegrationRunPrincipalOnTransaction(
      { query: async (s: string, p?: unknown[]) => { const r = await query(s, p); return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? null } } },
      { principalId: userId, tenantId: MATRIX_TENANT },
    ))
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(`port principal unresolved: ${resolution.reason}`)
    return resolution.user
  }

  /**
   * The request side: a real token through AuthService.verifyToken with the claim-trusting fast path OFF. The
   * token CLAIMS role 'admin' on purpose — the profile must come from the database (role 'user'), never the claim.
   */
  async function requestProfile(userId: string, productMode: string | undefined) {
    const token = authService.createToken({ id: userId, email: `${userId}@example.test`, name: userId, role: 'admin', permissions: [], created_at: new Date(), updated_at: new Date() } as never)
    process.env.RBAC_TOKEN_TRUST = 'false'
    if (productMode === undefined) delete process.env.PRODUCT_MODE
    else process.env.PRODUCT_MODE = productMode
    try {
      const user = await authService.verifyToken(token)
      expect(user).not.toBeNull()
      // tripwire: getUserById's non-production fallback (a DB error) is an admin '*:*' dev user — never this profile
      expect(user!.id).toBe(userId)
      expect(user!.role).toBe('user')
      expect(user!.permissions).not.toContain('*:*')
      return user!
    } finally {
      for (const [key, saved] of Object.entries(savedEnv)) {
        if (saved === undefined) delete process.env[key]
        else process.env[key] = saved
      }
    }
  }

  /** What the plugin's hasPermission reads (http-routes.cjs listUserPermissions): codes ∪ role:${roles[i]} ∪ role:${role}. */
  function pluginView(user: { permissions?: unknown; roles?: unknown; role?: unknown }): string[] {
    const view: string[] = []
    if (Array.isArray(user.permissions)) view.push(...user.permissions.map(String))
    if (Array.isArray(user.roles)) view.push(...user.roles.map((role) => `role:${String(role)}`))
    if (typeof user.role === 'string') view.push(`role:${user.role}`)
    return [...new Set(view)].sort()
  }
  const sorted = (codes: readonly string[]) => [...new Set(codes)].sort()
  const stockPrepCodes = (codes: readonly string[]) => codes.filter((code) => code.startsWith('stock-prep:'))

  beforeAll(async () => {
    for (const code of [...PULL_LADDER, 'workflow:write', 'integration:write']) {
      await q(`INSERT INTO permissions (code, name) SELECT $1::varchar, $1::varchar WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE code = $1::varchar)`, [code])
    }
    await q(`INSERT INTO roles (id, name) VALUES ($1, $1), ($2, $2)`, [ROLE_PULL, ROLE_LEGACY])
    for (const code of [...PULL_LADDER, 'workflow:write']) {
      await q(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)`, [ROLE_PULL, code])
    }
    for (const code of ['integration:write', 'workflow:write']) {
      await q(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)`, [ROLE_LEGACY, code])
    }
    // Every grant is seeded BEFORE any read: the pool-path profile memoizes per user, so no user is re-read after a change.
    for (const fixture of FIXTURES) {
      await seedFixture(fixture.name, userIdOf(fixture.name, 'strict'))
      await seedFixture(fixture.name, userIdOf(fixture.name, 'platform'))
    }
  })
  afterAll(async () => {
    for (const [key, saved] of Object.entries(savedEnv)) {
      if (saved === undefined) delete process.env[key]
      else process.env[key] = saved
    }
    // user_roles by user also removes the attendance_employee row the default-mode backfill persisted.
    for (const [table, column] of [['user_namespace_admissions', 'user_id'], ['user_roles', 'user_id'], ['user_permissions', 'user_id'], ['user_orgs', 'user_id'], ['users', 'id']]) {
      await q(`DELETE FROM ${table} WHERE ${column} LIKE $1`, [`mx_%${RUN}`]).catch(() => undefined)
    }
    await q(`DELETE FROM role_permissions WHERE role_id = ANY($1::text[])`, [[ROLE_PULL, ROLE_LEGACY]]).catch(() => undefined)
    await q(`DELETE FROM roles WHERE id = ANY($1::text[])`, [[ROLE_PULL, ROLE_LEGACY]]).catch(() => undefined)
  })

  test.each(FIXTURES)('$name (PRODUCT_MODE plm-workbench, self-service off): port codes ≡ request-time profile codes, the pinned set; role / roles parity in the plugin view', async (fixture) => {
    const userId = userIdOf(fixture.name, 'strict')
    const port = await portPrincipal(userId)
    const request = await requestProfile(userId, 'plm-workbench')

    expect(sorted(port.permissions)).toEqual(sorted(request.permissions))
    expect(sorted(port.permissions)).toEqual(fixture.expected)
    expect(sorted(request.permissions)).toEqual(fixture.expected)
    // role / roles: the same scalar role from the same rows; the plugin-visible set (codes + role:*) is identical
    expect(port.role).toBe(request.role)
    expect(port.roles).toEqual([])
    expect((request as { roles?: unknown }).roles ?? []).toEqual(port.roles)
    expect(pluginView(port)).toEqual(pluginView(request))
    if (fixture.name === 'F2' || fixture.name === 'F3') {
      expect(stockPrepCodes(port.permissions)).toEqual([])
      expect(stockPrepCodes(request.permissions)).toEqual([])
    }
  }, 20_000)

  test('default PRODUCT_MODE (unset ⇒ platform, self-service ON): the ONLY difference is the attendance self-service pair the profile adds; every other code is equal and the pinned sets hold on the port', async () => {
    // requestProfile(_, undefined) deletes PRODUCT_MODE for the read, whatever the lane's env carries
    for (const fixture of FIXTURES) {
      const userId = userIdOf(fixture.name, 'platform')
      const request = await requestProfile(userId, undefined)
      const port = await portPrincipal(userId)
      const requestCodes = sorted(request.permissions)
      const portCodes = sorted(port.permissions)
      expect(requestCodes.filter((code) => !portCodes.includes(code)), fixture.name).toEqual(ATTENDANCE_SELF_SERVICE)
      expect(portCodes.filter((code) => !requestCodes.includes(code)), fixture.name).toEqual([])
      expect(requestCodes.filter((code) => !ATTENDANCE_SELF_SERVICE.includes(code)), fixture.name).toEqual(fixture.expected)
      expect(portCodes, fixture.name).toEqual(fixture.expected)
      expect(port.role).toBe(request.role)
      if (fixture.name === 'F2' || fixture.name === 'F3') {
        expect(stockPrepCodes(port.permissions), fixture.name).toEqual([])
        expect(stockPrepCodes(request.permissions), fixture.name).toEqual([])
      }
    }
  }, 30_000)
})

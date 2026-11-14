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
 *
 * Two-point wired (plugin-tests.yml multitable real-DB step + vitest.config.ts exclude); EXPECT_DB sentinel.
 */
import { randomUUID } from 'node:crypto'

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest'

import { db } from '../../src/db/db'
import { poolManager } from '../../src/integration/db/connection-pool'
import { up as leasesUp } from '../../src/db/migrations/zzzz20261106111100_create_automation_job_leases'
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
// R-69 1b-ii (conditions refusal, bottom of the file): the real save path on a real automation_rules row.
import { RUN_INTEGRATION_JOB_CONDITIONS_MESSAGE } from '../../src/multitable/automation-run-integration-job'
import { AutomationRuleValidationError as RuleValidationError, AutomationService as RuleService } from '../../src/multitable/automation-service'

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
  const run = (executionId: string, config: typeof CONFIG = CONFIG): Promise<AutomationStepResult> => {
    const context: ExecutionContext = { executionId, ruleId: `rule_${RUN}`, sheetId: 'sheet_1', recordId: '', recordData: {}, ruleCreatedBy: config.binding.principalId, triggerEvent: {}, rootExecutionId: executionId }
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

  beforeAll(async () => {
    await leasesUp(db as never)
    process.env[FLAG] = 'true'
    a = new Client({ connectionString: process.env.DATABASE_URL })
    await a.connect()
  })
  afterAll(async () => {
    if (savedFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = savedFlag
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
})

// R-69 1b-ii (owner-approved 2026-11-11): a run_integration_job rule cannot carry conditions — its schedule trigger
// fires with an empty record, so a condition would skip every fire and no summary would ever be published. On the
// real save path and a real automation_rules row: a refused save leaves NO row (create) or the row BYTE-IDENTICAL
// (update: md5 of the whole row as JSON before and after); the on/off switch and clearing stay open on a row that
// already carries conditions (planted with a direct UPDATE: a row saved before this check).
describeIfDatabase('R-69 1b-ii run_integration_job rules cannot carry conditions (real automation_rules rows)', () => {
  const savedFlag = process.env[FLAG]
  const principalId = `svcc_${RUN}`
  const sheet = `sheetc_${RUN}`
  const conditions = { conjunction: 'AND', conditions: [{ fieldId: 'status', operator: 'equals', value: 'x' }] }
  const job = { job: { kind: 'stock_prep_pull', projectNos: [`PC-${RUN}`], applyMode: 'dry_run_only' } }
  const base = {
    name: `cond_${RUN}`, triggerType: 'schedule.cron', triggerConfig: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
    actionType: 'run_integration_job', actionConfig: job, createdBy: principalId,
  }
  const digest = async (ruleId: string): Promise<string | undefined> =>
    ((await q(`SELECT md5(row_to_json(r)::text) AS d FROM automation_rules r WHERE id = $1`, [ruleId])).rows[0] as { d?: string } | undefined)?.d
  const refusalOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error)
  const expectConditionsRefusal = (error: unknown) => {
    expect(error).toBeInstanceOf(RuleValidationError)
    expect((error as InstanceType<typeof RuleValidationError>).code).toBe('VALIDATION_ERROR')
    expect((error as Error).message).toBe(RUN_INTEGRATION_JOB_CONDITIONS_MESSAGE)
  }

  beforeAll(async () => {
    process.env[FLAG] = 'true'
    await q(`INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1, $2, $3, 'x', 'user', true)`, [principalId, `${principalId}@example.test`, 'svcc'])
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [principalId, TENANT])
  })
  afterAll(async () => {
    if (savedFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = savedFlag
    await q(`DELETE FROM automation_rules WHERE sheet_id = $1`, [sheet]).catch(() => undefined)
    await q(`DELETE FROM user_orgs WHERE user_id = $1`, [principalId]).catch(() => undefined)
    await q(`DELETE FROM users WHERE id = $1`, [principalId]).catch(() => undefined)
  })

  test('create with conditions writes no row; a conditions-only edit adding them, and an action re-save or a trigger edit of a row that already has them, leave the row byte-identical; the switch and clearing still work', async () => {
    const service = new RuleService(new EventBus(), db as never, q as never)
    expectConditionsRefusal(await refusalOf(service.createRule(sheet, { ...base, conditions } as never)))
    expect((await q(`SELECT 1 FROM automation_rules WHERE sheet_id = $1`, [sheet])).rows).toHaveLength(0)
    // control: the same rule without conditions saves (the binding is stamped from the creator's one tenant)
    const rule = await service.createRule(sheet, base as never)
    try {
      const saved = await digest(rule.id)
      expect(saved).toMatch(/^[0-9a-f]{32}$/)
      // (b) a conditions-only edit that ADDS conditions to the stored job rule
      expectConditionsRefusal(await refusalOf(service.updateRule(rule.id, sheet, { conditions } as never)))
      expect(await digest(rule.id)).toBe(saved)
      // a row that already carries conditions (saved before this check): action re-save and trigger edit are refused
      await q(`UPDATE automation_rules SET conditions = $2::jsonb WHERE id = $1`, [rule.id, JSON.stringify(conditions)])
      const planted = await digest(rule.id)
      expect(planted).not.toBe(saved)
      expectConditionsRefusal(await refusalOf(service.updateRule(rule.id, sheet, { actionConfig: job } as never)))
      expect(await digest(rule.id)).toBe(planted)
      expectConditionsRefusal(await refusalOf(service.updateRule(rule.id, sheet, { triggerConfig: { cron: '0 7 * * *', timezone: 'Asia/Shanghai' } } as never)))
      expect(await digest(rule.id)).toBe(planted)
      // the on/off switch stays open on that row, and clearing the conditions is allowed
      expect((await service.setRuleEnabled(rule.id, sheet, false))?.enabled).toBe(false)
      const cleared = await service.updateRule(rule.id, sheet, { conditions: null } as never)
      expect(cleared?.conditions ?? null).toBeNull()
      expect((await q(`SELECT enabled, conditions FROM automation_rules WHERE id = $1`, [rule.id])).rows[0]).toEqual({ enabled: false, conditions: null })
    } finally {
      service.unregisterSchedule(rule.id)
      await q(`DELETE FROM automation_rules WHERE id = $1`, [rule.id]).catch(() => undefined)
    }
  }, 20_000)
})

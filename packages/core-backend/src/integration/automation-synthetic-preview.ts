/**
 * C1/S2 first slice — the manual, short, fixed-order SYNTHETIC integration preview of multitable
 * automation (baseline v2.3 §10.3.1, evidence D):
 *
 *   synthetic input -> named read-only operation -> in-run value passing -> YiDa pure preview
 *
 * Host: the existing AutomationService owns this runtime's lifecycle (AutomationService.previewIntegrationPlan;
 * stopProducerAdmissions aborts and drains it) and the step sequencing is the executor's own typed entry
 * (automation-executor.ts executeSyntheticPreviewPlan). There is no second job engine, no BPMN, no job /
 * outbox / suspension row, no lease. The saved rule only supplies ownership and permission context: its
 * actions are never executed. SA06 `integration_read_preview` is not used and not widened.
 *
 * Switch: AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED, default OFF, exact literal 'true' (no trim, no
 * case folding). It is read on every run and shares nothing with the durable / Class-A / Class-B / YiDa
 * send switches: no other AUTOMATION_* or INTEGRATION_* flag opens or widens this entry.
 *
 * ── Admission protocol (each checkpoint, its own READ COMMITTED transaction, ONE queryable) ──────────────
 * Checkpoints: run start, before EVERY provider page, before the consumer step, before the result is
 * returned. Each one re-proves, on the same transaction handle:
 *   L1 automation_rules  FOR SHARE  the rule exists, belongs to the PATH sheet, and its owner (created_by)
 *                                    is still the actor;
 *   L2 meta_sheets       FOR SHARE  the sheet is live (deleted_at IS NULL);
 *   L3 assertAutomationIntegrationActor (integration/automation-live-authority.ts:62): active user, active
 *                                    membership in the AUTHENTICATED tenant, exact integration authority;
 *                                    its own order user_roles -> role_permissions -> user_permissions ->
 *                                    users -> user_orgs -> user_namespace_admissions, all FOR SHARE;
 *   L4 automation capability codes, FOR SHARE, the SAME table order as L3 (user_roles -> role_permissions
 *                                    -> user_permissions -> users): canManageAutomation keeps its existing
 *                                    OR semantics (admin role, workflow:all|write|create|execute);
 *   L5 sheet scope       platform_member_group_members (optional relation, SAVEPOINT) -> spreadsheet_permissions
 *                                    FOR SHARE; applySheetPermissionScope narrows canManageAutomation exactly
 *                                    like the request resolver (a sheet grant without write refuses), so a
 *                                    workflow:* code never stands in for the sheet scope;
 *   then the flag, the fixed catalog entry and the run budget.
 * LOCK ORDER: automation_rules -> meta_sheets -> user_roles -> role_permissions -> user_permissions ->
 *   users -> user_orgs -> user_namespace_admissions -> platform_member_group_members -> spreadsheet_permissions.
 *   Only shared row locks are taken, and only the rows that carry this actor's authority; no global
 *   metadata table is locked and nothing is held across a provider page.
 * LINEARIZATION POINT: the return of the last locking read (L5) of the checkpoint transaction. Every
 *   positive authority row that contributed is then held FOR SHARE until that transaction COMMITs, so a
 *   concurrent revocation (DELETE/UPDATE of any of those rows) waits for the COMMIT and is seen by the
 *   NEXT checkpoint. Pinned with two connections and barriers in
 *   tests/integration/automation-synthetic-preview-realdb.test.ts (C04).
 * DISCLOSED GAP (not closed by any ordinary check): the one provider page admitted by a checkpoint runs
 *   after its COMMIT, and the HTTP write happens after the final check. A revocation inside those windows
 *   is seen at the next checkpoint (no further page / no consumer step) or not at all for the final write.
 *   This is not "instant revocation of a read that already happened". The provider is synthetic (no
 *   network); a real read needs its own boundary and acceptance. This protocol covers synthetic data only;
 *   real fields/records need the §7.2 (D21) boundary and server-confirmed field-id bindings.
 * Every unknown, missing table, lock error, timeout or query error refuses (UNAVAILABLE): there is no
 * degraded authorization and no fallback to an ordinary write.
 *
 * ── Budget and stop ──────────────────────────────────────────────────────────────────────────────────
 * 5 pages, 100 rows, 256 KiB of encoded synthetic rows, one in-flight provider call, 10 s cooperative
 * deadline (SYNTHETIC_PREVIEW_BUDGET). A page is reserved synchronously (check + increment in one turn, so
 * concurrent internal calls cannot both pass) BEFORE the provider is called; a failed page is not refunded.
 * A repeated cursor, a page/row/byte overflow or the deadline ends the run before any further page.
 * HTTP disconnect, explicit cancel, deadline and host shutdown all abort the same controller; the run then
 * waits for every dependency it started (provider, transactions, hooks, summary insert) before it settles,
 * and a result that arrives after the abort is never published to the value store or the response.
 *
 * ── Values ───────────────────────────────────────────────────────────────────────────────────────────
 * Raw values live only in the run's RunValueStore (multitable/automation-run-values.ts) and in the
 * response's preset-allowed preview view. The persisted summary, every error and every log line are rebuilt
 * from enums and counts (buildSyntheticPreviewSummary); provider/compiler/database errors become fixed
 * codes and their message/cause is dropped.
 */
import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { executeSyntheticPreviewPlan, type SyntheticPreviewStepSummary } from '../multitable/automation-executor'
import { createRunValueStore, isRunValueStoreError, type RunValueRef, type RunValueStore } from '../multitable/automation-run-values'
import { applySheetPermissionScope, summarizeSheetPermissionCodes } from '../multitable/permission-service'
import { deriveCapabilities } from '../multitable/sheet-capabilities'
import { assertAutomationIntegrationActor, AutomationActorAuthorityError } from './automation-live-authority'
import {
  createSyntheticMaterialProvider,
  parseSyntheticPreviewRequest,
  SYNTHETIC_MATERIAL_COLUMNS,
  SYNTHETIC_MATERIAL_OPERATION,
  SYNTHETIC_MATERIAL_OPERATION_ID,
  SYNTHETIC_MATERIAL_PROVIDER_ID,
  SYNTHETIC_PREVIEW_BUDGET,
  SYNTHETIC_PREVIEW_PLAN,
  SYNTHETIC_PREVIEW_PLAN_ID,
  SYNTHETIC_YIDA_PREVIEW_CONSUMER,
  syntheticMaterialFixture,
  syntheticYidaMappingPreset,
  isSyntheticMaterialFixtureId,
  type SyntheticFixturePage,
  type SyntheticMaterialProvider,
  type SyntheticPreviewRequest,
} from './automation-operation-catalog'
import {
  createYidaSyntheticPreviewConsumer,
  YidaSyntheticPreviewError,
  type SyntheticYidaPreviewView,
  type YidaLocalDraftCompile,
} from './yida-automation-preview'

export const SYNTHETIC_PREVIEW_FLAG = 'AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED'

/** Exact literal 'true' only. Never derived from any other flag. */
export function isSyntheticIntegrationPreviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED === 'true'
}

export type SyntheticPreviewScope = Readonly<{ actorId: string; tenantId: string; sheetId: string; ruleId: string }>

export const SYNTHETIC_PREVIEW_OUTCOMES = Object.freeze([
  'OK', 'DENIED', 'NOT_FOUND', 'UNAVAILABLE', 'LIMIT', 'CANCELLED', 'TIMEOUT', 'INACTIVE', 'REJECTED',
] as const)
export type SyntheticPreviewOutcome = (typeof SYNTHETIC_PREVIEW_OUTCOMES)[number]
type ErrorCode = Exclude<SyntheticPreviewOutcome, 'OK'> | 'INPUT' | 'DISABLED'
const ERROR_CODES = new Set<string>(['INPUT', 'DISABLED', ...SYNTHETIC_PREVIEW_OUTCOMES.filter((code) => code !== 'OK')])
const OUTCOME_SET = new Set<string>(SYNTHETIC_PREVIEW_OUTCOMES)

const ownErrors = new WeakMap<object, ErrorCode>()
export class SyntheticPreviewError extends Error {
  readonly code: string
  constructor(code: ErrorCode) {
    const fixed = (ERROR_CODES.has(code) ? code : 'UNAVAILABLE') as ErrorCode
    super(`AUTOMATION_INTEGRATION_PREVIEW_${fixed}`)
    this.name = 'SyntheticPreviewError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
/** Decodes only errors this module created; text or a forged `code` property is never read. */
export function syntheticPreviewErrorCode(error: unknown): ErrorCode | undefined {
  return error && typeof error === 'object' ? ownErrors.get(error) : undefined
}
function fail(code: ErrorCode): never {
  throw new SyntheticPreviewError(code)
}

export type SyntheticPreviewSummary = Readonly<{
  kind: 'automation.synthetic_integration_preview'
  schemaVersion: 1
  planId: typeof SYNTHETIC_PREVIEW_PLAN_ID
  operation: Readonly<{ id: typeof SYNTHETIC_MATERIAL_OPERATION_ID; version: number }>
  providerId: typeof SYNTHETIC_MATERIAL_PROVIDER_ID
  consumer: typeof SYNTHETIC_YIDA_PREVIEW_CONSUMER
  fixtureId: string
  mappingPresetId: string
  outcome: SyntheticPreviewOutcome
  counts: Readonly<{ pages: number; rows: number; bytes: number }>
  durationMs: number
  steps: readonly SyntheticPreviewStepSummary[]
}>

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

const STEP_STATUSES = new Set(['success', 'failed', 'skipped'])

/**
 * Rebuild the summary from enums and counts. Every string is re-selected from the fixed catalog (never
 * copied from a request, a provider page, a compiler result or an error); counts must be safe
 * non-negative integers. Nothing is spread from a raw object.
 */
export function buildSyntheticPreviewSummary(input: Readonly<{
  request: SyntheticPreviewRequest
  outcome: string
  pages: number
  rows: number
  bytes: number
  durationMs: number
  steps: readonly SyntheticPreviewStepSummary[]
}>): SyntheticPreviewSummary {
  const fixture = syntheticMaterialFixture(input.request.fixtureId)
  const preset = syntheticYidaMappingPreset(input.request.mappingPresetId)
  const planSteps = SYNTHETIC_PREVIEW_PLAN.steps
  const steps = planSteps.map((planStep, index) => {
    const reported = input.steps[index]
    const status = reported && reported.stepId === planStep.id && STEP_STATUSES.has(reported.status) ? reported.status : 'skipped'
    return Object.freeze({ stepId: planStep.id, type: planStep.type, status, durationMs: count(reported?.durationMs) })
  })
  return Object.freeze({
    kind: 'automation.synthetic_integration_preview' as const,
    schemaVersion: 1 as const,
    planId: SYNTHETIC_PREVIEW_PLAN_ID,
    operation: Object.freeze({ id: SYNTHETIC_MATERIAL_OPERATION_ID, version: SYNTHETIC_MATERIAL_OPERATION.version }),
    providerId: SYNTHETIC_MATERIAL_PROVIDER_ID,
    consumer: SYNTHETIC_YIDA_PREVIEW_CONSUMER,
    fixtureId: fixture.id,
    mappingPresetId: preset.id,
    outcome: (OUTCOME_SET.has(input.outcome) ? input.outcome : 'UNAVAILABLE') as SyntheticPreviewOutcome,
    counts: Object.freeze({ pages: count(input.pages), rows: count(input.rows), bytes: count(input.bytes) }),
    durationMs: count(input.durationMs),
    steps: Object.freeze(steps),
  })
}

export type SyntheticPreviewResponse = Readonly<{
  ok: true
  synthetic: true
  summary: SyntheticPreviewSummary
  preview: SyntheticYidaPreviewView
  canSend: false
  canApply: false
  tokenIssued: false
  externalWriteAttempted: false
}>

export type SyntheticPreviewSummaryWriter = (trx: Queryable, entry: Readonly<{
  executionId: string
  ruleId: string
  sheetId: string
  actorId: string
  triggeredAt: string
  finishedAt: string
  summary: SyntheticPreviewSummary
}>) => Promise<void>

export type SyntheticPreviewAdmissionPhase = 'start' | 'page' | 'consume' | 'publish'

export type SyntheticPreviewRuntimeDependencies = {
  /** Host RC transaction (BEGIN + SET TRANSACTION ISOLATION LEVEL READ COMMITTED before `work`). */
  database: { transaction<T>(work: (trx: Queryable) => Promise<T>): Promise<T> }
  readEnablement: () => unknown
  loadCompiler: () => Promise<YidaLocalDraftCompile>
  recordSummary: SyntheticPreviewSummaryWriter
  /** Defaults to the host-registered synthetic provider; tests may install a double with the same id. */
  provider?: SyntheticMaterialProvider
  /** Test instrumentation only (barriers). Production never passes it. Awaited inside the run lifecycle. */
  hooks?: Readonly<{
    beforeAdmission?(phase: SyntheticPreviewAdmissionPhase, ordinal: number): unknown
    afterProviderPage?(page: number): unknown
    /** Receives this run's RunOperations handle (to prove concurrent internal calls cannot pass the budget). */
    onOperations?(operations: Readonly<{ request(operation: unknown, args: unknown): Promise<RunValueRef> }>): unknown
    /** Receives this run's value store and the read step's opaque handle (to prove disposal / revocation). */
    onValueStore?(store: RunValueStore): unknown
    onStepValue?(handle: RunValueRef): unknown
  }>
  /** Test only: a SHORTER cooperative deadline. Never above the fixed budget. */
  deadlineMs?: number
}

type Run = {
  controller: AbortController
  reason: 'CANCELLED' | 'TIMEOUT' | 'INACTIVE' | null
  dependencies: Set<Promise<unknown>>
  pending: Promise<unknown>
}

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!

function actorDenied(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && !types.isProxy(error)
    && Object.getPrototypeOf(error) === AutomationActorAuthorityError.prototype
    && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'AUTOMATION_ACTOR_AUTHORITY_DENIED')
}

function canonicalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && value.trim() === value
    // eslint-disable-next-line no-control-regex -- scope ids must refuse embedded ASCII controls.
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function captureScope(value: unknown): SyntheticPreviewScope {
  if (!value || typeof value !== 'object') fail('INPUT')
  const scope = value as Record<string, unknown>
  if (!canonicalId(scope.actorId) || !canonicalId(scope.tenantId) || !canonicalId(scope.sheetId) || !canonicalId(scope.ruleId)) fail('INPUT')
  return Object.freeze({ actorId: scope.actorId, tenantId: scope.tenantId, sheetId: scope.sheetId, ruleId: scope.ruleId })
}

function rowString(row: Record<string, unknown> | undefined, key: string): string | null {
  const value = row?.[key]
  return typeof value === 'string' ? value : null
}

/**
 * L4: the automation capability codes, read with FOR SHARE on the caller's transaction in the same table
 * order as assertAutomationIntegrationActor. Only rows RETURNED by these locking reads contribute.
 */
async function lockAutomationCapability(trx: Queryable, actorId: string): Promise<{ isAdminRole: boolean; permissions: string[]; roleIds: string[] }> {
  const roles = (await trx.query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id FOR SHARE', [actorId])).rows
  const roleIds = [...new Set(roles.map((row) => rowString(row, 'role_id')).filter((id): id is string => Boolean(id)))].sort()
  const rolePermissions = roleIds.length === 0 ? [] : (await trx.query(
    'SELECT role_id, permission_code FROM role_permissions WHERE role_id = ANY($1::text[]) ORDER BY role_id, permission_code FOR SHARE',
    [roleIds],
  )).rows
  const direct = (await trx.query('SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code FOR SHARE', [actorId])).rows
  const users = (await trx.query('SELECT id, permissions FROM users WHERE id = $1 FOR SHARE', [actorId])).rows
  if (users.length !== 1 || users[0]?.id !== actorId) fail('DENIED')
  const legacy = Array.isArray(users[0]?.permissions) ? (users[0].permissions as unknown[]) : []
  const permissions = [...new Set([
    ...rolePermissions.map((row) => rowString(row, 'permission_code')),
    ...direct.map((row) => rowString(row, 'permission_code')),
    ...legacy.map((code) => (typeof code === 'string' ? code : null)),
  ].map((code) => code?.trim() ?? '').filter(Boolean))]
  return { isAdminRole: roleIds.includes('admin'), permissions, roleIds }
}

/** L5: the actor's grants on the sheet (user / role / member-group subject), FOR SHARE. */
async function lockSheetScope(trx: Queryable, sheetId: string, actorId: string, roleIds: readonly string[]) {
  let groupIds: string[] = []
  await trx.query('SAVEPOINT automation_preview_groups')
  try {
    const groups = (await trx.query('SELECT group_id FROM platform_member_group_members WHERE user_id = $1 ORDER BY group_id FOR SHARE', [actorId])).rows
    groupIds = groups.map((row) => (row.group_id == null ? '' : String(row.group_id))).filter(Boolean)
    await trx.query('RELEASE SAVEPOINT automation_preview_groups')
  } catch (error) {
    // Only the optional member-group relation may be absent (42P01); anything else refuses.
    await trx.query('ROLLBACK TO SAVEPOINT automation_preview_groups')
    if ((error as { code?: unknown })?.code !== '42P01') throw error
    groupIds = []
  }
  const grants = (await trx.query(
    `SELECT perm_code, subject_type FROM spreadsheet_permissions
      WHERE sheet_id = $1
        AND ((subject_type = 'user' AND subject_id = $2)
          OR (subject_type = 'role' AND subject_id = ANY($3::text[]))
          OR (subject_type = 'member-group' AND subject_id = ANY($4::text[])))
      ORDER BY subject_type, perm_code
      FOR SHARE`,
    [sheetId, actorId, [...roleIds], groupIds],
  )).rows
  // Same precedence as permission-service.ts loadSheetPermissionScopeMap: direct, then member-group, then role.
  const pick = (type: string) => grants.filter((row) => row.subject_type === type).map((row) => rowString(row, 'perm_code')?.trim() ?? '').filter(Boolean)
  const direct = pick('user')
  const group = pick('member-group')
  const role = pick('role')
  return summarizeSheetPermissionCodes(direct.length > 0 ? direct : group.length > 0 ? group : role)
}

/**
 * One admission checkpoint. Order and locks: see the module header. Throws a fixed DENIED / NOT_FOUND /
 * UNAVAILABLE; never returns partial authority.
 */
async function admitOnTransaction(trx: Queryable, scope: SyntheticPreviewScope): Promise<void> {
  // L1
  const rules = (await trx.query('SELECT id, sheet_id, created_by FROM automation_rules WHERE id = $1 FOR SHARE', [scope.ruleId])).rows
  if (rules.length !== 1 || rules[0]?.id !== scope.ruleId || rules[0]?.sheet_id !== scope.sheetId) fail('NOT_FOUND')
  if (rules[0]?.created_by !== scope.actorId) fail('DENIED')
  // L2
  const sheets = (await trx.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL FOR SHARE', [scope.sheetId])).rows
  if (sheets.length !== 1 || sheets[0]?.id !== scope.sheetId) fail('NOT_FOUND')
  // L3
  try {
    await assertAutomationIntegrationActor(trx, { actorId: scope.actorId, tenantId: scope.tenantId, workspaceId: null })
  } catch (error) {
    if (actorDenied(error)) fail('DENIED')
    fail('UNAVAILABLE')
  }
  // L4
  const capability = await lockAutomationCapability(trx, scope.actorId)
  // L5 — linearization point is the return of this read.
  const sheetScope = await lockSheetScope(trx, scope.sheetId, scope.actorId, capability.roleIds)
  const scoped = applySheetPermissionScope(deriveCapabilities(capability.permissions, capability.isAdminRole), sheetScope, capability.isAdminRole)
  if (!scoped.canManageAutomation) fail('DENIED')
}

export type SyntheticPreviewRuntime = Readonly<{
  run(scope: SyntheticPreviewScope, request: unknown, options?: { signal?: AbortSignal }): Promise<SyntheticPreviewResponse>
  enabled(): boolean
  /** Abort every run and wait until each one settled (provider, transactions, summary insert). Idempotent. */
  stop(): Promise<void>
  /** Values-free count of runs not yet settled (tests / shutdown diagnostics). */
  inFlight(): number
}>

export function createAutomationSyntheticPreviewRuntime(dependencies: SyntheticPreviewRuntimeDependencies): SyntheticPreviewRuntime {
  if (!dependencies?.database || typeof dependencies.database.transaction !== 'function'
    || typeof dependencies.readEnablement !== 'function' || typeof dependencies.loadCompiler !== 'function'
    || typeof dependencies.recordSummary !== 'function') {
    throw new SyntheticPreviewError('UNAVAILABLE')
  }
  const provider = dependencies.provider ?? createSyntheticMaterialProvider()
  if (!provider || provider.id !== SYNTHETIC_MATERIAL_OPERATION.providerId || typeof provider.readPage !== 'function') {
    throw new SyntheticPreviewError('UNAVAILABLE')
  }
  const deadlineMs = Math.min(
    typeof dependencies.deadlineMs === 'number' && dependencies.deadlineMs > 0 ? dependencies.deadlineMs : SYNTHETIC_PREVIEW_BUDGET.deadlineMs,
    SYNTHETIC_PREVIEW_BUDGET.deadlineMs,
  )
  const hooks = dependencies.hooks ?? {}
  const runs = new Set<Run>()
  let stopping = false
  let stopPromise: Promise<void> | null = null

  function enabled(): boolean {
    let value: unknown
    try { value = dependencies.readEnablement() } catch { return false }
    return value === 'true'
  }

  function execute(scopeInput: unknown, requestInput: unknown, options: { signal?: AbortSignal } | undefined): Promise<SyntheticPreviewResponse> {
    // Capture synchronously, before any await.
    const scope = captureScope(scopeInput)
    if (stopping) fail('INACTIVE')
    // OFF: refused before the catalog, the provider and the compiler are touched.
    if (!enabled()) fail('DISABLED')
    const request = parseSyntheticPreviewRequest(requestInput)
    if (!request) fail('INPUT')
    const caller = options?.signal
    if (caller && abortedGetter.call(caller)) fail('CANCELLED')

    const controller = new AbortController()
    const run: Run = { controller, reason: null, dependencies: new Set(), pending: Promise.resolve() }
    const abort = (reason: 'CANCELLED' | 'TIMEOUT' | 'INACTIVE') => {
      if (!run.reason) run.reason = reason
      controller.abort()
    }
    const onCallerAbort = () => abort('CANCELLED')
    if (caller) caller.addEventListener('abort', onCallerAbort, { once: true })
    const timer = setTimeout(() => abort('TIMEOUT'), deadlineMs)
    runs.add(run)

    const checkpoint = () => {
      if (abortedGetter.call(controller.signal)) fail(run.reason ?? 'CANCELLED')
      if (stopping) fail('INACTIVE')
    }
    // Every promise the run starts is registered, so the run (and stop()) waits for it.
    const tracked = <T>(start: () => Promise<T> | T): Promise<T> => {
      const pending = Promise.resolve().then(start)
      run.dependencies.add(pending)
      void pending.then(() => run.dependencies.delete(pending), () => run.dependencies.delete(pending))
      return pending
    }

    // Budget — one run, reserved synchronously before each provider call.
    const budget = { pages: 0, rows: 0, bytes: 0, inFlight: 0 }
    const seenCursors = new Set<string>()
    const reserve = () => {
      if (budget.inFlight >= SYNTHETIC_PREVIEW_BUDGET.maxInFlight) fail('LIMIT')
      if (budget.pages >= SYNTHETIC_PREVIEW_BUDGET.maxPages) fail('LIMIT')
      budget.pages += 1
      budget.inFlight += 1
    }

    let admissionOrdinal = 0
    async function admit(phase: SyntheticPreviewAdmissionPhase): Promise<void> {
      checkpoint()
      const ordinal = ++admissionOrdinal
      if (hooks.beforeAdmission) await tracked(() => hooks.beforeAdmission!(phase, ordinal))
      checkpoint()
      // Flag and catalog are part of every admission, not only of run start.
      if (!enabled()) fail('DISABLED')
      if (!isSyntheticMaterialFixtureId(request!.fixtureId)) fail('INPUT')
      try {
        await tracked(() => dependencies.database.transaction(async (raw) => {
          const trx: Queryable = Object.freeze({
            query: (sql: string, params?: unknown[]) => {
              checkpoint()
              return tracked(() => raw.query(sql, params))
            },
          })
          await admitOnTransaction(trx, scope)
          checkpoint()
        }))
      } catch (error) {
        const code = syntheticPreviewErrorCode(error)
        if (code) throw error
        fail('UNAVAILABLE')
      }
      checkpoint()
    }

    const triggeredAt = new Date()
    const runId = `atp_${randomUUID()}`
    const store = createRunValueStore({ runId, tenantId: scope.tenantId }, {
      stepOrder: SYNTHETIC_PREVIEW_PLAN.steps.map((step) => step.id),
      outputs: [{
        stepId: 'read-materials',
        output: SYNTHETIC_MATERIAL_OPERATION.output.name,
        columns: SYNTHETIC_MATERIAL_COLUMNS,
        consumers: SYNTHETIC_MATERIAL_OPERATION.consumers,
      }],
    })
    let opsOpen = false

    /** RunOperations: host-only handle, bound to THIS run; checked at runtime, not by type. */
    const operations = Object.freeze({
      async request(operation: unknown, args: unknown): Promise<RunValueRef> {
        if (!opsOpen) fail('INACTIVE')
        if (operation !== SYNTHETIC_MATERIAL_OPERATION.id) fail('INPUT')
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1
          || !Object.prototype.hasOwnProperty.call(args, 'fixtureId')) fail('INPUT')
        const fixtureId = (args as { fixtureId?: unknown }).fixtureId
        if (!isSyntheticMaterialFixtureId(fixtureId) || fixtureId !== request!.fixtureId) fail('INPUT')
        const rows: unknown[] = []
        let cursor: string | null = null
        for (;;) {
          await admit('page')
          reserve()
          let page: SyntheticFixturePage
          try {
            page = await tracked(() => provider.readPage(Object.freeze({ fixtureId, cursor })))
          } catch {
            budget.inFlight -= 1
            checkpoint()
            fail('UNAVAILABLE')
          }
          budget.inFlight -= 1
          // A page that arrives after the abort is dropped here, before it is counted or stored.
          checkpoint()
          if (hooks.afterProviderPage) await tracked(() => hooks.afterProviderPage!(budget.pages))
          checkpoint()
          if (!page || typeof page !== 'object' || !Array.isArray(page.rows)) fail('UNAVAILABLE')
          let encoded: number
          try { encoded = Buffer.byteLength(JSON.stringify(page.rows), 'utf8') } catch { fail('UNAVAILABLE') }
          if (budget.rows + page.rows.length > SYNTHETIC_PREVIEW_BUDGET.maxRows) fail('LIMIT')
          if (budget.bytes + encoded > SYNTHETIC_PREVIEW_BUDGET.maxBytes) fail('LIMIT')
          budget.rows += page.rows.length
          budget.bytes += encoded
          rows.push(...page.rows)
          const next = page.nextCursor
          if (next === null) break
          if (typeof next !== 'string' || !next || seenCursors.has(next) || next === cursor) fail('LIMIT')
          seenCursors.add(next)
          // The NEXT page would exceed the page budget: stop now, no further provider call.
          if (budget.pages >= SYNTHETIC_PREVIEW_BUDGET.maxPages) fail('LIMIT')
          cursor = next
        }
        checkpoint()
        try {
          return store.publish('read-materials', SYNTHETIC_MATERIAL_OPERATION.output.name, rows)
        } catch {
          fail('UNAVAILABLE')
        }
      },
    })

    let view: SyntheticYidaPreviewView | null = null
    let handle: RunValueRef | null = null
    const startedAt = Date.now()

    run.pending = (async (): Promise<SyntheticPreviewResponse> => {
      let outcome: SyntheticPreviewOutcome = 'UNAVAILABLE'
      let started = false
      let stepSummaries: readonly SyntheticPreviewStepSummary[] = []
      try {
        try {
          if (hooks.onValueStore) await tracked(() => hooks.onValueStore!(store))
          await admit('start')
          started = true
          opsOpen = true
          if (hooks.onOperations) await tracked(() => hooks.onOperations!(operations))
          const executed = await executeSyntheticPreviewPlan(SYNTHETIC_PREVIEW_PLAN.steps, async (step) => {
            checkpoint()
            if (step.id === 'read-materials') {
              handle = await operations.request(SYNTHETIC_MATERIAL_OPERATION.id, { fixtureId: request!.fixtureId })
              if (hooks.onStepValue) await tracked(() => hooks.onStepValue!(handle!))
              return
            }
            if (step.id === 'yida-preview') {
              await admit('consume')
              const planStep = SYNTHETIC_PREVIEW_PLAN.steps[1]
              const rows = store.resolveForConsumer(handle, planStep.input, planStep.consumer, planStep.id, { runId, tenantId: scope.tenantId })
              const compile = await tracked(() => dependencies.loadCompiler())
              checkpoint()
              const consumer = createYidaSyntheticPreviewConsumer(compile)
              view = consumer.consume(rows, syntheticYidaMappingPreset(request!.mappingPresetId))
              checkpoint()
              return
            }
            fail('UNAVAILABLE')
          })
          stepSummaries = executed.steps
          if ('failure' in executed) throw executed.failure
          opsOpen = false
          await admit('publish')
          outcome = 'OK'
        } catch (error) {
          opsOpen = false
          outcome = run.reason ?? classify(error)
        }
        // The values-free summary row (only once the run passed its start admission: the rule is then
        // proven to be the actor's). It is written on an unchecked handle so a cancelled run still records
        // that it was cancelled; the run waits for it like for every other dependency.
        if (started) {
          const summary = buildSyntheticPreviewSummary({
            request: request!,
            outcome,
            pages: budget.pages,
            rows: budget.rows,
            bytes: budget.bytes,
            durationMs: Date.now() - startedAt,
            steps: stepSummaries,
          })
          try {
            await tracked(() => dependencies.database.transaction((trx) => dependencies.recordSummary(trx, {
              executionId: runId,
              ruleId: scope.ruleId,
              sheetId: scope.sheetId,
              actorId: scope.actorId,
              triggeredAt: triggeredAt.toISOString(),
              finishedAt: new Date().toISOString(),
              summary,
            })))
          } catch {
            // An unrecorded preview is not published.
            if (outcome === 'OK') outcome = 'UNAVAILABLE'
          }
          if (outcome === 'OK') {
            // Last refusal point: an abort that landed during the summary insert still withholds the result.
            if (abortedGetter.call(controller.signal) || stopping) fail(run.reason ?? 'INACTIVE')
            const finalView = view
            if (!finalView) fail('UNAVAILABLE')
            return Object.freeze({
              ok: true as const,
              synthetic: true as const,
              summary,
              preview: finalView,
              canSend: false as const,
              canApply: false as const,
              tokenIssued: false as const,
              externalWriteAttempted: false as const,
            })
          }
        }
        fail(outcome === 'OK' ? 'UNAVAILABLE' : outcome)
      } finally {
        opsOpen = false
        clearTimeout(timer)
        if (caller) caller.removeEventListener('abort', onCallerAbort)
        // No floating promise: everything this run started settles before the run does.
        while (run.dependencies.size > 0) await Promise.allSettled([...run.dependencies])
        store.dispose()
        view = null
        handle = null
        controller.abort()
        runs.delete(run)
      }
    })()
    // An abandoned caller promise must never become an unhandled rejection.
    void run.pending.catch(() => {})
    return run.pending as Promise<SyntheticPreviewResponse>
  }

  function classify(error: unknown): Exclude<SyntheticPreviewOutcome, 'OK'> {
    const code = syntheticPreviewErrorCode(error)
    if (code && code !== 'INPUT' && code !== 'DISABLED') return code
    if (code === 'DISABLED') return 'INACTIVE'
    if (code === 'INPUT') return 'REJECTED'
    if (isRunValueStoreError(error) || error instanceof YidaSyntheticPreviewError) return 'REJECTED'
    return 'UNAVAILABLE'
  }

  return Object.freeze({
    run(scope: SyntheticPreviewScope, request: unknown, options?: { signal?: AbortSignal }) {
      try {
        return execute(scope, request, options)
      } catch (error) {
        const refused = Promise.reject(syntheticPreviewErrorCode(error) ? error : new SyntheticPreviewError('UNAVAILABLE'))
        void refused.catch(() => {})
        return refused as Promise<SyntheticPreviewResponse>
      }
    },
    enabled,
    stop() {
      stopping = true
      for (const run of runs) {
        if (!run.reason) run.reason = 'INACTIVE'
        run.controller.abort()
      }
      stopPromise ??= (async () => {
        while (runs.size > 0) await Promise.allSettled([...runs].map((run) => run.pending))
      })()
      return stopPromise
    },
    inFlight: () => runs.size,
  })
}

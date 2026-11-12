/**
 * Batch-refresh step 6 S6-9a (register rows R-91 and, for 批次标识, R-65) — THE G9 FROZEN-CANDIDATE ACCEPTANCE HARNESS for
 * the continuation marker flip (step-6 design §9.5; the 2026-11-09 rebaseline B-21). Tests only: no product behaviour
 * changes here and `CONTINUATION_SUPPORT_VERSION` STAYS 0 — the positive pilot-enable leg flips it IN MEMORY for one call
 * (the unfrozen export the readiness suite already uses) and the module's afterAll asserts it is back at 0. S6-9 proper
 * flips the literal, re-pins the tests pinned to 0 and runs THIS matrix on a tag-dispatched frozen sha
 * (scripts/ops/stock-prep-g9-frozen-candidate.mjs).
 *
 * This is a CASES MODULE, not a test file. `defineStockPreparationG9AcceptanceRealDbCases(kit)` registers its describe
 * block from INSIDE the S8 describe of stock-preparation-project-write-lock-realdb.cases.ts — the deepest scope that sees
 * both the S3A real stack (`s3aStack`) and the S8 change-plan helpers — so every case runs in the existing real-DB step
 * of plugin-tests.yml (the p4 host stock-preparation-p4-repair-once-realdb.test.ts, aggregated into the required
 * `test (20.x)`) with no workflow edit. Do NOT list it as a standalone file there.
 *
 * The ids are the matrix file's (stock-preparation-g9-matrix.json, read by the runner too). Each case prints exactly ONE
 * `[G9] <id> ok <values-free json>` line AFTER its assertions passed; the runner requires one per id. Values-free:
 * synthetic tenants, projects and parts (S-001, P-001, PART-A, ...), counts and closed codes only.
 *
 *   S3A-02/03/04/05/09/10/14/15/16/20/21/24/25/26  the fourteen step-4 PR-3a plan cases that had hermetic evidence only,
 *            now on real PostgreSQL through the REAL routes, lock, stores and host (plan-final §3.3; obligations in each
 *            title). S3A-26's ledger fault is a REAL 42501 from PostgreSQL scoped to one binding (a throwaway role without
 *            SELECT on the pack ledger, `SET LOCAL ROLE` inside that binding's statements) — never a REVOKE on the
 *            shared table, which would leak into every other case of the step.
 *   G9-U08   the synthetic end-to-end demonstration A01 -> A02 -> A03 -> A05 -> C08 with E06 and E07 injected, on ONE
 *            BI-installed governed sheet with the 批次标识 switch ON: recovery through the puller routes, A03 「无新增物料
 *            批次」 (no new ledger batch), the E10 labels kept across the retry, the export refused / allowed / refused.
 *   G9-U03   the authorization drill over every step-4/5/6 route, 批次标识's routes and every pull step of the operator
 *            split (the capability manifest is the route list; the tier oracle is written out here, independently of the
 *            manifest's own decision function), for the read, operate, pull and stock-prep admin tiers, a TENANTLESS
 *            platform admin and a cross-tenant puller / admin: below the tier 403; the foreign callers are sent THIS
 *            tenant's REAL hold / continuation / execution / change-plan ids with VALID bodies (every field the parsers
 *            require, so the id reaches the scoped read; no non-inert foreign call may stop at body validation unless the
 *            matrix's u03BodyValidationStops lists it) and answer exactly as for ids that exist nowhere (no existence
 *            oracle); tenantId carriers (body, query, params) naming this tenant are refused at the tenant gate; no answer
 *            of any status echoes this tenant's sheet / row / hold / continuation / execution / plan / batch ids; those
 *            refusals write nothing and audit nothing. The large-lane pull steps get inert foreign requests only (the
 *            matrix's u03InertForeignSteps says why).
 *            THE OWNER-GATED EXCEPTION G9-U03-LEGACY-TENANTLESS-ADMIN (matrix manual item, printed by every runner
 *            verdict): PRE-EXISTING product behaviour — requireTableActionAccess's legacy integration:* branch
 *            (http-routes.cjs:1526-1553) lets a tenantless integration:admin naming a tenant (query / params carrier)
 *            PREVIEW AND APPLY into its governed sheet while MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED is off (the
 *            default). G9-U03 PINS the measured writes of that path (never certifies it) and, with the flag exactly
 *            'true' (test env only), that assertVerifiedTenantClaim (:1754) refuses the same caller 403 on every carrier
 *            with nothing written while this tenant's own puller with a verified claim still previews (ready, a token).
 *            RULED 2026-11-11 (owner, register R-91, option A): the legacy path stays for non-pilot use while the flag is
 *            off, and the flag being on is a PILOT-ENABLE PRECONDITION — readiness v6's tenant_claim_required, held by
 *            G9-PE below (flag off ⇒ the enable refused with exactly that id). It gates the enable only.
 *   G9-S9X-01 (C-8, RD G2) the MVP archive identity — the default snapshotBatchId and syncRunId, both derived from
 *            buildArchiveRevision — is unchanged across the 批次标识 install + history backfill of an unchanged GOVERNED
 *            sheet, with the switch ON and OFF: the archive after the install keeps the batch already archived.
 *   G9-U07   the rollback drill's CI half (design §7.5 + B-22): artifacts produced through the REAL routes (an unfinished
 *            execution; a puller close not yet settled; a change plan left confirmed; a recovery-written plan) make the
 *            stop-condition queries non-zero — the 106 one is PARSED OUT OF THE MIGRATION 106 HEADER, never copied —
 *            the current build refuses where they say so, and every query is zero once settled. The old-build half (a
 *            pre-step-6 build against a step-6 database) cannot run in a one-build host: the runner prints it
 *            (`--old-build-drill`); the repair-run artifact is S6-6's (pending id G9-S66-U07).
 *   G9-PE    the positive pilot-enable leg (§9.2) on a fully prepared synthetic sheet — the band installed by the REAL
 *            install route with its history RESOLVED (backfilled, not born empty), views live, the switch ON: with the
 *            marker at 0 `continuation_support_version` is the ONLY failing id and the enable is 409 with nothing done;
 *            with the marker 1 IN MEMORY the readiness is green and the enable 200 stamps the registry with the current
 *            PILOT_READINESS_VERSION (read from the module, never a literal). Readiness v5's component ruling ledger
 *            (S6-5, migration 107) is wired, so its no_unacknowledged_inactive_root_remnant passes on the prepared sheet.
 *            Readiness v6 (owner ruling 2026-11-11, R-91 option A): the leg HOLDS the tenant-claim flag exactly 'true'
 *            (this process's env, restored in finally; every call carries the verified claim) to pass, and its negative
 *            leg — marker 1, flag OFF — is 409 with `tenant_claim_required` the ONLY failing id and nothing done.
 *            Readiness v7 (S6-5b): the prepared sheet wires the REAL sheet-repair ledger (migration 108), so
 *            no_open_sheet_repair_run passes; the leg pins version 7 with that id just before the marker.
 *   G9-S65-V5  (S6-5, #6842) on the same prepared sheet: an inactive-root remnant fails ONLY that v5 id beyond the
 *            marker; the project census lists exactly its handle; the acknowledgement through the REAL route lifts
 *            exactly that check and the revoke restores it; the enable stays 409.
 *   G9-S65B-V7 (S6-5b, readiness v7) on a G9-PE prepared sheet with the marker 1 IN MEMORY and the tenant-claim flag ON: a
 *            repair run of the sheet begun by the REAL repair ledger under a REAL sheet_repair lease and left `running`
 *            (the lease released — a run whose finish never ran) fails ONLY no_open_sheet_repair_run and the enable is 409
 *            with exactly that id and nothing done; the run closed by the ledger's own verified close under a NEW lease,
 *            the readiness is green and the enable 200 stamps PILOT_READINESS_VERSION (7).
 *   G9-S65-U03 (S6-5, #6842) rides G9-U03 (`G9-U03 + G9-S65-U03`): the census and remnant routes join the drill, with a
 *            real component handle and acknowledgement id of this tenant.
 *
 * EXTENSION POINTS (the matrix file's `pending` list; each is a `test.todo` below so the gap is visible in every run):
 *   S6-6 (migration 108): G9-S66-U03, G9-S66-U07, G9-S66-INSTALLING. Whoever lands them replaces the todo with the case
 *   and moves the id to `realDb`. G9-U03's scope is the whole capability manifest minus a named pre-step-4 list, so a
 *   route S6-6 adds fails its manifest equality until it is drilled.
 *   S6-6's three routes (#6843: the repair POST, its fills report, its run list) ARE in G9-U03's tier oracle since
 *   that PR, drilled with the repair switch OFF — the deployment default: 403 below stock-prep admin with nothing
 *   written and no audit row, and the surface's own 404 for every caller at or above the tier (this tenant's admin,
 *   the tenantless platform admin, a cross-tenant admin; real id or bogus; every steering carrier). That is NOT
 *   G9-S66-U03: the drill with the switch ON (the tenant gate and the scoped reads behind it) stays pending.
 */
import { createRequire } from 'module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
const MATRIX_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stock-preparation-g9-matrix.json')
const MIGRATION_106 = path.join(REPO_ROOT, 'packages/core-backend/migrations/106_extend_integration_stock_prep_refresh_execution_for_recovery.sql')
/* eslint-disable @typescript-eslint/no-explicit-any */
const fs = require('node:fs') as typeof import('node:fs')
const nodeCrypto = require('node:crypto') as typeof import('node:crypto')
const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const tableActions = require(path.join(PLUGIN_LIB, 'stock-preparation-table-actions.cjs')) as any
const pairingLib = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-pairing.cjs')) as any
const lockLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-write-lock.cjs')) as any
const templatesLib = require(path.join(PLUGIN_LIB, 'stock-preparation-templates.cjs')) as any
const pullBatchStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pull-batch-store.cjs')) as any
const packInstallStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pack-install-store.cjs')) as any
const continuationStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-store.cjs')) as any
const readinessLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pilot-readiness.cjs')) as any
const continuationSupport = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-support.cjs')) as any
const access = require(path.join(PLUGIN_LIB, 'stock-preparation-workbench-access.cjs')) as any
const mvpProvisioningLib = require(path.join(PLUGIN_LIB, 'stock-preparation-mvp-provisioning.cjs')) as any
const sourceBindingStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-source-binding-store.cjs')) as any
// S6-5 (#6842, readiness v5, migration 107): the component ruling ledger and the census's own handle derivation.
const componentRulingStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-component-ruling-store.cjs')) as any
const sheetCensusLib = require(path.join(PLUGIN_LIB, 'stock-preparation-sheet-census.cjs')) as any
// S6-5b (readiness v7, migration 108): the sheet-repair ledger the open-run check reads.
const sheetRepairStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-sheet-repair-store.cjs')) as any
// The MVP archive's four sheets (the p4 host's set); the batch sheet holds snapshotBatchId and syncRunId.
const BATCH_OBJECT_ID = 'plm_stock_preparation_bom_snapshot_batch'
const MVP_OBJECT_IDS = ['plm_stock_preparation_project', BATCH_OBJECT_ID, 'plm_stock_preparation_bom_snapshot_line', 'plm_stock_preparation_run']

const { REFRESH_STORE_TABLES: RT } = continuationStoreLib
const { PROJECT_WRITE_LOCK_TABLE, sheetWriteScopeKey } = lockLib

export const G9_MATRIX = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8')) as {
  version: number
  describe: string
  hostFile: string
  realDb: string[]
  pending: Array<{ id: string; owner: string; what: string }>
  manual: Array<{ id: string; what: string; ownerGated?: boolean; where?: string }>
  u03InertForeignSteps: { steps: string[]; reason: string }
  u03BodyValidationStops: { codePattern: string; reason: string; entries: Array<{ route: string; leg: string; callers: string[]; why: string }> }
}
// The owner-gated item G9-U03 pins (never certifies); the runner prints its sentence in every verdict.
const LEGACY_TENANTLESS_ADMIN_ID = 'G9-U03-LEGACY-TENANTLESS-ADMIN'
const LEGACY_TENANTLESS_ADMIN_WHAT = 'tenantless platform admin can preview and apply into a named tenant while the tenant-claim flag is off — ruled 2026-11-11: option A — the flag is a pilot-enable precondition; the legacy path stays for non-pilot use while the flag is off'
// The staged tenant-claim door (http-routes.cjs stockPreparationTenantClaimRequired: exactly 'true' after trim / lower).
const TENANT_CLAIM_FLAG = 'MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED'
// The flag as the p4 host process had it when this module loaded: every leg that sets it restores it (afterAll asserts).
const TENANT_CLAIM_FLAG_AT_LOAD = process.env[TENANT_CLAIM_FLAG]
// The pull-batch pure module: the settings vocabulary's own default (a schema-valid settings patch, never a literal).
const pullBatchPureLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pull-batch.cjs')) as any

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const PULL_SWITCH = 'STOCK_PREP_PULL_BATCH_ENABLED'
// S6-6 (#6843): the doubled-sheet repair's switch (default OFF; exact 'true') and its refusal code, spelled by the
// repair library — the switch's one reader.
const sheetRepairLib = require(path.join(PLUGIN_LIB, 'stock-preparation-sheet-repair.cjs')) as any
const SHEET_REPAIR_SWITCH: string = sheetRepairLib.STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED_ENV
const REFRESH_BASE = '/api/integration/stock-preparation/projects/:projectNo/refresh'
const RP = {
  holds: `${REFRESH_BASE}/holds`,
  confirm: `${REFRESH_BASE}/continuations/confirm`,
  executions: `${REFRESH_BASE}/executions`,
  recover: `${REFRESH_BASE}/executions/:executionId/recover`,
}
const PILOT_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/pilot'
const INSTALL_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/pull-batch'
const CENSUS_READ_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/census'
const REMNANT_ACK_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/remnant-acknowledgements'
const REMNANT_REVOKE_PATH = `${REMNANT_ACK_PATH}/:acknowledgementId/revoke`
const RULING_TABLE: string = componentRulingStoreLib.COMPONENT_RULING_TABLE

/** One line per passed case; the runner counts them. Printed only after every assertion of the case held. */
function g9Pass(id: string, summary: unknown) {
  console.log(`[G9] ${id} ok ${JSON.stringify(summary)}`)
}

/** A one-shot gate: `arm()` makes the NEXT `hit()` wait until `open()`; `reached` resolves when it is waiting. */
function oneShotGate() {
  let armed = false
  let release: () => void = () => {}
  let notify: () => void = () => {}
  let reached = new Promise<void>((resolve) => { notify = resolve })
  let gate = Promise.resolve()
  return {
    arm() {
      armed = true
      gate = new Promise<void>((resolve) => { release = resolve })
      reached = new Promise<void>((resolve) => { notify = resolve })
    },
    async hit() {
      if (!armed) return
      armed = false
      notify()
      await gate
    },
    reached: () => reached,
    open: () => release(),
  }
}

export function defineStockPreparationG9AcceptanceRealDbCases(kit: Record<string, any>): void {
  const {
    TOKEN, CF, s3aStack, firstPullApplied, confirmOpenCandidate, errorOf, sameJson, decisionVersionOf, derive, derivedOf,
    testBumpWithin, refreshKit, realRefreshServices, seedOpenHolds, callRoute, cpCall, CPR, boundBody,
    reviewBody, planById, plansOf, stateOf, sourceWith, withSwitch, SWITCH, MVP_SWITCH, carryDecision, seedCarryPair,
    kvTokens, stepFour, createProductionPluginContext, dropSheet,
  } = kit
  const registered: string[] = []
  // A case of the matrix: registered under its id, so the id census below is exact. An extension id that rides an
  // existing case (G9-S65-U03 joins G9-U03's drill) is registered with it and named in the title as `<id> + <id>`; the
  // case prints one ok line per id.
  const g9Case = (ids: string | string[], title: string, fn: () => Promise<void>, timeout = 300000) => {
    const list = Array.isArray(ids) ? ids : [ids]
    registered.push(...list)
    test(`${list.join(' + ')} ${title}`, fn, timeout)
  }
  const both = async <T>(pull: boolean, fn: () => Promise<T>): Promise<T> => {
    const before = { pull: process.env[PULL_SWITCH], sheets: process.env[SWITCH] }
    process.env[SWITCH] = 'true'
    if (pull) process.env[PULL_SWITCH] = 'true'
    else delete process.env[PULL_SWITCH]
    try {
      return await fn()
    } finally {
      if (before.pull === undefined) delete process.env[PULL_SWITCH]; else process.env[PULL_SWITCH] = before.pull
      if (before.sheets === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = before.sheets
    }
  }
  const tenants: string[] = []
  const status = (res: any) => (res && res.body && res.body.data ? res.body.data.status : undefined)
  // No token minted: a 200 answering `dryRunToken: null`, or a refusal with no data at all.
  const tokenOf = (res: any) => (res && res.body && res.body.data ? res.body.data.dryRunToken : null)
  const codeOf = (res: any) => errorOf(res).code || null
  const reasonOf = (res: any) => (errorOf(res).details ? errorOf(res).details.reason : undefined) ?? null
  const executionStatuses = async (st: any) => (await st.executions()).map((row: any) => row.status)
  const continuations = async (st: any) => (await q(`SELECT id, status, status_reason, executed_execution_id, revision FROM ${RT.continuation} WHERE sheet_id = $1 AND project_no = $2 ORDER BY created_at, id`, [st.sheetId, st.projectNo])).rows
  const derivedStatus = async (st: any) => (await derivedOf(st)).status
  const physicalOf = (st: any) => (fieldId: string) => (st.target.fieldIdMap && st.target.fieldIdMap[fieldId]) || fieldId
  const revisionsOf = async (recordIds: string[]) => Number((await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE record_id = ANY($1::text[])', [recordIds])).rows[0].n)
  const rowsByPart = async (st: any) => {
    const p = physicalOf(st)
    return (await st.rows()).map((row: any) => ({ id: row.id, version: Number(row.version), part: row.data[p('componentSourceId')], path: row.data[p('path')], active: row.data[p('active')], key: row.data[p('idempotencyKey')], data: row.data }))
  }

  // ── shared stack builders ───────────────────────────────────────────────────────────────────────────────────────────
  const mvpSheets: string[] = []
  // The MVP archive's sheets in the tenant's staging project (what mvp-persist writes; the p4 host's recipe).
  async function provisionMvp(st: any) {
    const context = { api: { multitable: st.multitable }, storage: {}, config: {} }
    const ensured = await mvpProvisioningLib.ensureStockPreparationMvpTargets({ context, projectId: st.projectId, permission: 'admin', objectIds: MVP_OBJECT_IDS })
    expect(ensured).toMatchObject({ ready: true })
    await mvpProvisioningLib.syncStockPreparationMvpOptions({
      context,
      projectId: st.projectId,
      permission: 'admin',
      objectIds: MVP_OBJECT_IDS,
      optionSets: {
        stock_preparation_project_status_v1: ['active', 'paused', 'closed', 'archived', 'completed'].map((value) => ({ value })),
        stock_preparation_snapshot_status_v1: ['draft', 'active', 'superseded', 'rejected'].map((value) => ({ value })),
        stock_preparation_bom_line_status_v1: ['imported', 'active', 'inactive', 'incomplete'].map((value) => ({ value })),
        stock_preparation_run_type_v1: ['plm_sync', 'erp_material_sync', 'mapping_match', 'unit_match', 'prep_generate'].map((value) => ({ value })),
        stock_preparation_run_status_v1: ['running', 'succeeded', 'failed', 'partial'].map((value) => ({ value })),
      },
    })
    for (const objectId of MVP_OBJECT_IDS) {
      const sheet = await st.multitable.provisioning.findObjectSheet({ projectId: st.projectId, objectId })
      if (sheet && sheet.id) mvpSheets.push(sheet.id)
    }
  }
  // A route-confirmed candidate (PR-4's REAL confirm route: the page read, its receipt, the echo of the hold).
  async function routeConfirmCandidate(st: any, user: any = st.users.puller) {
    const row = (await st.holds()).find((entry: any) => entry.status === 'open' && entry.kind === 'continuation_candidate')
    expect(row, 'an open candidate hold').toBeTruthy()
    const page = await both(false, () => callRoute(st.routes, 'GET', RP.holds, { user, query: {}, params: { projectNo: st.projectNo } }))
    expect(page.statusCode, JSON.stringify(page.body)).toBe(200)
    const entry = page.body.data.page.holds.find((item: any) => item.id === row.id)
    expect(entry, 'the hold is on the page').toBeTruthy()
    const res = await both(false, () => callRoute(st.routes, 'POST', RP.confirm, {
      user,
      params: { projectNo: st.projectNo },
      body: {
        confirmProjectNo: st.projectNo,
        holdId: row.id,
        holdFingerprint: row.fingerprint,
        comparisonFingerprint: row.comparison_fingerprint,
        evidenceFingerprint: row.evidence_fingerprint,
        candidateId: entry.pairingFingerprint,
        readReceipt: page.body.data.readReceipt.id,
        basis: { kind: 'puller_confirmed_same_demand' },
        acknowledge: { historyUnknown: true },
      },
    }))
    expect(res.statusCode, JSON.stringify(res.body)).toBe(201)
    return res.body.data
  }
  // The band installed born empty the way BI-1b's cases install it (one plugin-scoped ensureMissingObjectFields of the
  // template descriptors + the ledger's own capture primitive).
  async function bornEmptyBand(st: any, ledgerStore: any) {
    const p = (fieldId: string) => st.multitable.provisioning.getFieldId(st.projectId, st.objectId, fieldId)
    const added = await st.multitable.provisioning.ensureMissingObjectFields({
      projectId: st.projectId,
      objectId: st.objectId,
      fields: templatesLib.pullBatchBandFieldDescriptors({ locale: 'zh-CN', placement: 'left' }).map((descriptor: any) => ({ ...descriptor, property: { ...descriptor.property } })),
    })
    expect(added.addedFieldIds).toEqual([p('firstPullBatch'), p('pullBatch')])
    const db = createDb({ database: st.pluginContext.api.database })
    await db.transaction((trx: any) => ledgerStore.createSheetRowWithin(trx, { tenantId: st.tenantId, sheetId: st.sheetId, projectNo: st.projectNo, historyStatus: 'born_empty', labelLocale: 'zh-CN', settings: { firstPullBatchRule: 'material', labelFormat: 'ordinal_date' } }))
    return p
  }
  // The REAL install route (dry_run, then install bound to the dry-run's plan digest and inferred count).
  async function installBand(st: any, user: any) {
    const post = (body: any) => both(true, () => callRoute(st.routes, 'POST', INSTALL_PATH, { user, params: { projectNo: st.projectNo }, body: { confirmProjectNo: st.projectNo, ...body }, query: {} }))
    const dry = await post({ mode: 'dry_run' })
    expect(dry.statusCode, JSON.stringify(dry.body)).toBe(200)
    const answer = await post({ mode: 'install', approvalRef: 'R-65', planDigest: dry.body.data.planDigest, confirmHistoricalBatchCount: dry.body.data.requires.confirmHistoricalBatchCount.inferred })
    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200)
    return { dry: dry.body.data, installed: answer.body.data }
  }
  // S6-5 (design §6.1 D2, the item-10 shape S9D-01r seeds): <part>'s old ROOT row left INACTIVE while <part> stays
  // active under its parent — one host-created record, its cells set by SQL. Returns the record id.
  async function seedInactiveRootRemnant(st: any, part: string) {
    const p = physicalOf(st)
    const created = await st.multitable.records.createRecord({ sheetId: st.sheetId, data: { [p('projectNo')]: st.projectNo } })
    const cells = { [p('idempotencyKey')]: `g9-remnant-${part}`, [p('componentSourceId')]: part, [p('parentSourceId')]: '', [p('active')]: false }
    await q('UPDATE meta_records SET data = data || $2::jsonb WHERE id = $1', [created.id, JSON.stringify(cells)])
    return created.id as string
  }
  const censusRead = (st: any, user: any) => both(true, () => callRoute(st.routes, 'GET', CENSUS_READ_PATH, { user, params: { projectNo: st.projectNo }, query: {} }))
  const acknowledgeRemnant = (st: any, user: any, componentHandle: string) => both(true, () => callRoute(st.routes, 'POST', REMNANT_ACK_PATH, {
    user,
    params: { projectNo: st.projectNo },
    query: {},
    body: { confirmProjectNo: st.projectNo, componentHandle, basis: 'head_not_ordered', runbookRef: 'R-91.g9', acknowledge: { customerAnswered: true } },
  }))
  const revokeRemnant = (st: any, user: any, acknowledgementId: string) => both(true, () => callRoute(st.routes, 'POST', REMNANT_REVOKE_PATH, {
    user,
    params: { projectNo: st.projectNo, acknowledgementId },
    query: {},
    body: { confirmProjectNo: st.projectNo, runbookRef: 'R-91.g9-rev' },
  }))
  const rulingStore = () => componentRulingStoreLib.createStockPreparationComponentRulingStore({ db: createDb({ database: createProductionPluginContext().api.database }) })
  const ledgerOf = async (tenantId: string) => ({
    batches: (await q('SELECT batch_no, status, closed_reason, origin FROM integration_stock_prep_pull_batch WHERE tenant_id = $1 ORDER BY batch_no', [tenantId])).rows,
    links: (await q('SELECT refresh_execution_id, writer_status, created_row_count, verified_outcome FROM integration_stock_prep_pull_batch_execution WHERE tenant_id = $1 ORDER BY joined_at, id', [tenantId])).rows,
  })
  const recoverCall = (st: any, executionId: string, body: any, user: any = st.users.puller) => both(true, () => callRoute(st.routes, 'POST', RP.recover, { user, params: { projectNo: st.projectNo, executionId }, body: { confirmProjectNo: st.projectNo, ...body } }))
  async function verifyAndClose(st: any, executionId: string, pull = true) {
    const call = (body: any) => both(pull, () => callRoute(st.routes, 'POST', RP.recover, { user: st.users.puller, params: { projectNo: st.projectNo, executionId }, body: { confirmProjectNo: st.projectNo, ...body } }))
    const verified = await call({ mode: 'verify' })
    expect(verified.statusCode, JSON.stringify(verified.body)).toBe(200)
    const report = verified.body.data.report
    const closed = await call({ mode: 'close', verifyDigest: report.verifyDigest })
    expect(closed.statusCode, JSON.stringify(closed.body)).toBe(200)
    return { report, closed: closed.body.data }
  }
  // A create / patch hook on the ROUTES' multitable (E06: the host refuses the next N creates or patches).
  function hostHook() {
    const hook: any = { failCreates: 0, failPatches: 0, creates: 0, patches: 0, createGate: oneShotGate() }
    const wrap = (multitable: any) => ({
      ...multitable,
      records: {
        ...multitable.records,
        async createRecord(input: any) {
          hook.creates += 1
          if (hook.failCreates > 0) {
            hook.failCreates -= 1
            throw Object.assign(new Error('synthetic create failure'), { code: 'SYN_CREATE_FAILED' })
          }
          const created = await multitable.records.createRecord(input)
          await hook.createGate.hit()
          return created
        },
        async patchRecord(input: any) {
          hook.patches += 1
          if (hook.failPatches > 0) {
            hook.failPatches -= 1
            throw Object.assign(new Error('synthetic patch failure'), { code: 'SYN_PATCH_FAILED' })
          }
          return multitable.records.patchRecord(input)
        },
      },
    })
    return { hook, wrap }
  }
  // The real refresh services with two seams: the NEXT consult may freeze after it answered (S3A-09 / 10), and the next
  // `succeeded` / `partial` finish may throw (E07: the process died after its writes — the row stays running).
  function seamedRefresh() {
    const real = realRefreshServices()
    const consultGate = oneShotGate()
    const crash = { armed: false, fired: false }
    const governance = {
      ...real.governance,
      consult: async (...args: any[]) => {
        const answer = await real.governance.consult(...args)
        await consultGate.hit()
        return answer
      },
    }
    const store = {
      ...real.store,
      finishExecution: async (input: any, ...rest: any[]) => {
        if (crash.armed && input && ['succeeded', 'partial'].includes(input.status)) {
          crash.armed = false
          crash.fired = true
          throw Object.assign(new Error('synthetic process exit after the writes'), { code: '57P01' })
        }
        return real.store.finishExecution(input, ...rest)
      },
    }
    return { refresh: { governance, store }, consultGate, crash, real }
  }

  afterAll(async () => {
    for (const sheetId of mvpSheets) await dropSheet(sheetId)
    for (const tenantId of tenants) {
      for (const table of ['integration_stock_prep_pull_batch_execution', 'integration_stock_prep_pull_batch', 'integration_stock_prep_pull_batch_sheet', 'integration_stock_prep_pack_install', 'integration_stock_prep_source_binding', RULING_TABLE]) {
        await q(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
      }
    }
    // The marker is process-global for the whole p4 file: G9-PE must have restored it.
    expect(continuationSupport.CONTINUATION_SUPPORT_VERSION).toBe(0)
    // So is the tenant-claim flag (G9-U03's claim leg, G9-PE's flag-on legs): restored to what the host had.
    expect(process.env[TENANT_CLAIM_FLAG]).toBe(TENANT_CLAIM_FLAG_AT_LOAD)
  })

  describe(`${G9_MATRIX.describe} (S6-9a, R-91 / R-65): the step-6 §9.5 matrix on real Postgres, the real routes, lock, stores and host`, () => {
    test('G9 census: every real-DB id of the matrix has exactly one case; the marker ships at 0 (S6-9 flips the literal, this harness never does)', () => {
      // Runs after the describe body registered every case (collection is synchronous).
      expect([...registered].sort()).toEqual([...G9_MATRIX.realDb].sort())
      expect(new Set(registered).size).toBe(registered.length)
      expect(continuationSupport.CONTINUATION_SUPPORT_VERSION).toBe(0)
      for (const entry of G9_MATRIX.pending) expect(G9_MATRIX.realDb.includes(entry.id)).toBe(false)
      // The owner-gated exception G9-U03 pins is a MANUAL item with its exact sentence (the runner prints it in every
      // verdict), never a real-DB id: no `[G9] ... ok` line certifies it.
      const ownerGated = G9_MATRIX.manual.filter((entry) => entry.ownerGated === true)
      expect(ownerGated.map((entry) => [entry.id, entry.what])).toEqual([[LEGACY_TENANTLESS_ADMIN_ID, LEGACY_TENANTLESS_ADMIN_WHAT]])
      expect(G9_MATRIX.realDb.includes(LEGACY_TENANTLESS_ADMIN_ID)).toBe(false)
      // The runner's R-3 reading of the log (a FAIL under this describe, a failed host file) uses these two names.
      expect(G9_MATRIX.describe).toBe('G9 frozen-candidate acceptance')
      expect(G9_MATRIX.hostFile).toBe('stock-preparation-p4-repair-once-realdb.test.ts')
    })

    // ── the fourteen hermetic-only S3A cases, on real PostgreSQL ───────────────────────────────────────────────────────
    g9Case('S3A-02', '(A02, X7, T1, G10, B2) a store-seeded confirm of the A01 candidate: the re-preview is 2 ADD and nothing else; the apply leaves every S row (id, version, key, path, person cell) untouched with 0 revisions for them, creates exactly 2 and inactivates 0; the execution succeeded and is the continuation\'s executed execution; the next clean preview settles NAMING it (derived complete)', async () => {
      const st = await s3aStack('g9_s02', { pilot: true })
      await firstPullApplied(st)
      const p = physicalOf(st)
      const sRoot = (await rowsByPart(st)).find((row: any) => row.part === 'S-001' && JSON.parse(String(row.path)).length === 1)
      await st.multitable.records.patchRecord({ sheetId: st.sheetId, recordId: sRoot.id, changes: { [p('notes')]: 'synthetic person note' } })
      const before = await rowsByPart(st)
      const revisionsBefore = await revisionsOf(before.map((row: any) => row.id))
      st.state.data = CF.secondPullSource()
      expect(status(await st.dryRun())).toBe('suspended')
      const confirmed = await confirmOpenCandidate(st)
      const preview = await st.dryRun()
      const counts = preview.body.data.counts
      const applied = await st.apply(st.users.puller, preview.body.data.dryRunToken)
      const after = await rowsByPart(st)
      const kept = before.map((row: any) => after.find((entry: any) => entry.id === row.id))
      const created = after.filter((row: any) => !before.some((entry: any) => entry.id === row.id))
      const executions = await st.executions()
      const newest = executions[executions.length - 1]
      const continuation = (await continuations(st)).find((row: any) => row.id === confirmed.continuationId)
      const settling = await st.dryRun()
      const state = await stateOf(st)
      const observed = {
        preview: { status: status(preview), add: Number(counts.add || 0), update: Number(counts.update || 0), inactive: Number(counts.inactive || 0) },
        applied: { status: applied.statusCode, run: applied.body.data && applied.body.data.status },
        oldRowsByteIdentical: sameJson(kept.map((row: any) => row && [row.id, row.version, row.data]), before.map((row: any) => [row.id, row.version, row.data])),
        oldRowRevisions: (await revisionsOf(before.map((row: any) => row.id))) - revisionsBefore,
        personCell: kept.find((row: any) => row.id === sRoot.id).data[p('notes')],
        created: created.map((row: any) => row.part).sort(),
        inactiveNow: after.filter((row: any) => row.active === false).length,
        executions: executions.map((row: any) => row.status),
        continuationExecuted: continuation.executed_execution_id === newest.id,
        continuationStatus: continuation.status,
        settling: status(settling),
        settledNames: state.settled_execution_id === newest.id,
        derived: await derivedStatus(st),
      }
      expect(observed).toEqual({
        preview: { status: 'ready', add: 2, update: 0, inactive: 0 },
        applied: { status: 200, run: 'succeeded' },
        oldRowsByteIdentical: true,
        oldRowRevisions: 0,
        personCell: 'synthetic person note',
        created: ['N-001', 'P-001'],
        inactiveNow: 0,
        executions: ['succeeded', 'succeeded'],
        continuationExecuted: true,
        continuationStatus: 'active',
        settling: 'ready',
        settledNames: true,
        derived: 'complete',
      })
      g9Pass('S3A-02', observed)
    })

    g9Case('S3A-03', '(A03, X5, X6, H5) after A02 a third IDENTICAL pull: the relationship verifies valid with no hold, the zero-write apply settles itself (complete) and two more loops stay complete; a pilot project whose rows predate the pilot (no step-4 row at all) settles on its first zero-write apply without state_row_absent', async () => {
      const st = await s3aStack('g9_s03', { pilot: true })
      await firstPullApplied(st)
      st.state.data = CF.secondPullSource()
      expect(status(await st.dryRun())).toBe('suspended')
      const confirmed = await confirmOpenCandidate(st)
      const second = await st.dryRun()
      expect((await st.apply(st.users.puller, second.body.data.dryRunToken)).statusCode).toBe(200)
      const loops: unknown[] = []
      for (let round = 0; round < 3; round += 1) {
        const preview = await st.dryRun()
        const applied = await st.apply(st.users.puller, preview.body.data.dryRunToken)
        const continuation = (await continuations(st)).find((row: any) => row.id === confirmed.continuationId)
        loops.push({
          preview: status(preview),
          add: Number(preview.body.data.counts.add || 0),
          openHolds: (await st.holds()).filter((row: any) => row.status === 'open').length,
          written: applied.body.data && applied.body.data.apply ? Number(applied.body.data.apply.written || 0) : null,
          continuation: continuation.status,
          derived: await derivedStatus(st),
        })
      }
      // X6: rows pulled while NOT pilot (no step-4 row), then the pilot stamp — the first zero-write apply settles.
      const late = await s3aStack('g9_s03b', { pilot: false })
      await firstPullApplied(late)
      expect(await late.stepFourRows()).toBe(0)
      await q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = now(), pilot_enabled_by = $3, pilot_readiness_version = 1 WHERE tenant_id = $1 AND project_no = $2', [late.tenantId, late.projectNo, 'u_g9_admin'])
      const latePreview = await late.dryRun()
      const lateApply = await late.apply(late.users.puller, latePreview.body.data.dryRunToken)
      const observed = {
        loops,
        late: { preview: status(latePreview), apply: lateApply.statusCode, code: codeOf(lateApply), derived: await derivedStatus(late) },
      }
      const loop = { preview: 'ready', add: 0, openHolds: 0, written: 0, continuation: 'active', derived: 'complete' }
      expect(observed).toEqual({ loops: [loop, loop, loop], late: { preview: 'ready', apply: 200, code: null, derived: 'complete' } })
      g9Pass('S3A-03', observed)
    })

    g9Case('S3A-04', '(C01) a pilot content change of a pulled part (no relationship yet): the whole pull is suspended with no token and no write; the hold row\'s detail names the changed field with a before / after pair and carries humanColumnsPresent', async () => {
      const st = await s3aStack('g9_s04', { pilot: true })
      await firstPullApplied(st)
      const main0 = await st.main()
      const parts = CF.PARTS.map((part: any) => (part.OBJ_ID === 'PART-A' ? { ...part, Material: 'M-G9-CHANGED' } : part))
      st.state.data = CF.project({ orders: [{ part: 'S-001', qty: 10 }], parts, boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }], 'PART-A': [{ part: 'PART-C', usage: 4 }] } })
      const preview = await st.dryRun()
      const holds = (await q(`SELECT kind, status, detail FROM ${RT.hold} WHERE sheet_id = $1 AND project_no = $2 AND status = 'open'`, [st.sheetId, st.projectNo])).rows
      const detail = holds[0] && (typeof holds[0].detail === 'string' ? JSON.parse(holds[0].detail) : holds[0].detail)
      const fieldEntries = detail && detail.fields ? Object.values(detail.fields) : []
      const observed = {
        preview: { status: status(preview), token: tokenOf(preview) },
        holdKinds: holds.map((row: any) => row.kind),
        changedFields: fieldEntries.length,
        beforeAfter: fieldEntries.every((entry: any) => entry && 'before' in entry && 'after' in entry),
        humanColumnsPresent: Boolean(detail && detail.humanColumnsPresent && typeof detail.humanColumnsPresent === 'object'),
        mainUnchanged: sameJson(await st.main(), main0),
      }
      expect(observed).toEqual({ preview: { status: 'suspended', token: null }, holdKinds: ['content_change'], changedFields: 1, beforeAfter: true, humanColumnsPresent: true, mainUnchanged: true })
      g9Pass('S3A-04', observed)
    })

    g9Case('S3A-05', '(A05) after an executed relationship: a material change inside the continued subtree suspends the pull on a relationship content change (old rows protected, no copy, the apply refused); a child added under S-001 moves the relationship to needs_reconfirmation (structure_changed) and keeps the pull suspended — never an ADD copy or an INACTIVE of the old rows', async () => {
      const outcome: Record<string, unknown> = {}
      for (const leg of ['content', 'structure'] as const) {
        const st = await s3aStack(`g9_s05${leg[0]}`, { pilot: true })
        await firstPullApplied(st)
        st.state.data = CF.secondPullSource()
        expect(status(await st.dryRun())).toBe('suspended')
        const confirmed = await confirmOpenCandidate(st)
        const second = await st.dryRun()
        expect((await st.apply(st.users.puller, second.body.data.dryRunToken)).statusCode).toBe(200)
        const main0 = await st.main()
        st.state.data = leg === 'content'
          ? CF.secondPullSource({ parts: CF.PARTS.map((part: any) => (part.OBJ_ID === 'PART-A' ? { ...part, Material: 'M-G9-CHANGED' } : part)) })
          : CF.secondPullSource({ boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }, { part: 'N-001', usage: 1 }] } })
        const preview = await st.dryRun()
        const forged = await st.apply(st.users.puller, await st.mintToken(`rev_g9_s05_${leg}`))
        const continuation = (await continuations(st)).find((row: any) => row.id === confirmed.continuationId)
        outcome[leg] = {
          preview: status(preview),
          token: tokenOf(preview),
          openHoldKinds: (await st.holds()).filter((row: any) => row.status === 'open').map((row: any) => row.kind).sort(),
          continuation: [continuation.status, continuation.status_reason],
          apply: [forged.statusCode, codeOf(forged)],
          mainUnchanged: sameJson(await st.main(), main0),
        }
      }
      const content: any = outcome.content
      const structure: any = outcome.structure
      expect(content).toMatchObject({ preview: 'suspended', token: null, apply: [409, 'STOCK_PREP_PULL_SUSPENDED'], mainUnchanged: true })
      expect(content.openHoldKinds).toContain('relationship_content_change')
      expect(structure).toMatchObject({ preview: 'suspended', token: null, continuation: ['needs_reconfirmation', 'structure_changed'], apply: [409, 'STOCK_PREP_PULL_SUSPENDED'], mainUnchanged: true })
      g9Pass('S3A-05', outcome)
    })

    g9Case('S3A-09', '(H3, S9; R-C2) a preview frozen AFTER its consult while another session commits a confirm of the open candidate: the frozen preview\'s reconcile misses its decision_version CAS (409 STATE_MOVED, no token), the hold stays resolved; a token minted before the confirm is refused by the apply and nothing is written', async () => {
      const seams = seamedRefresh()
      const st = await s3aStack('g9_s09', { pilot: true, refresh: seams.refresh })
      await firstPullApplied(st)
      st.state.data = CF.secondPullSource()
      expect(status(await st.dryRun())).toBe('suspended')
      const early = await st.mintToken('rev_g9_s09_before_confirm')
      const main0 = await st.main()
      seams.consultGate.arm()
      const frozen = st.dryRun()
      await seams.consultGate.reached()
      const confirmed = await confirmOpenCandidate(st)
      seams.consultGate.open()
      const answer = await frozen
      const holds = await st.holds()
      const stale = await st.apply(st.users.puller, early)
      const observed = {
        frozen: [answer.statusCode, codeOf(answer), tokenOf(answer)],
        candidate: holds.filter((row: any) => row.kind === 'continuation_candidate').map((row: any) => row.status),
        openHolds: holds.filter((row: any) => row.status === 'open').length,
        continuation: (await continuations(st)).find((row: any) => row.id === confirmed.continuationId).status,
        staleApply: stale.statusCode,
        staleCode: codeOf(stale),
        mainUnchanged: sameJson(await st.main(), main0),
      }
      expect(observed.frozen[0]).toBe(409)
      expect(String(observed.frozen[1])).toMatch(/STATE_MOVED$/)
      expect(observed.frozen[2]).not.toEqual(expect.any(String))
      expect(observed).toMatchObject({ candidate: ['resolved'], openHolds: 0, continuation: 'active', staleApply: 409, mainUnchanged: true })
      // The confirm bumped the generation in its transaction: the earlier binding is superseded (plan-final S3A-09 names
      // PLAN_SUPERSEDED, or BINDING_STALE / TOKEN_MISMATCH should a later check fire first).
      expect(['STOCK_PREP_PROJECT_PLAN_SUPERSEDED', 'STOCK_PREP_REFRESH_BINDING_STALE', 'TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH']).toContain(observed.staleCode)
      g9Pass('S3A-09', observed)
    })

    g9Case('S3A-10', '(H2, H4, E01) two concurrent previews of one governed project, the second frozen between its consult and its reconcile while the first commits its reconcile and its small_preview bump: both 200, the same hold set, exactly one open hold row; the first-time variant (no state row yet) never answers 503', async () => {
      const observed: Record<string, unknown> = {}
      for (const leg of ['governed', 'firstTime'] as const) {
        const seams = seamedRefresh()
        const st = await s3aStack(`g9_s10${leg[0]}`, { pilot: leg === 'governed', refresh: seams.refresh })
        await firstPullApplied(st)
        if (leg === 'firstTime') {
          expect(await st.stepFourRows()).toBe(0)
          await q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = now(), pilot_enabled_by = $3, pilot_readiness_version = 1 WHERE tenant_id = $1 AND project_no = $2', [st.tenantId, st.projectNo, 'u_g9_admin'])
        }
        st.state.data = CF.secondPullSource()
        const gen0 = await st.generation()
        seams.consultGate.arm()
        const second = st.dryRun()
        await seams.consultGate.reached()
        const first = await st.dryRun()
        const genBetween = await st.generation()
        seams.consultGate.open()
        const late = await second
        const holds = await st.holds()
        observed[leg] = {
          first: [first.statusCode, status(first)],
          second: [late.statusCode, status(late), codeOf(late)],
          sameHoldSet: first.body.data && late.body.data && first.body.data.refreshHold && late.body.data.refreshHold
            ? first.body.data.refreshHold.holdSetFingerprint === late.body.data.refreshHold.holdSetFingerprint : false,
          openHoldRows: holds.filter((row: any) => row.status === 'open').length,
          firstBumpedBetween: genBetween.generationToken !== gen0.generationToken,
        }
      }
      const leg = { first: [200, 'suspended'], second: [200, 'suspended', null], sameHoldSet: true, openHoldRows: 1, firstBumpedBetween: false }
      expect(observed).toEqual({ governed: leg, firstTime: leg })
      g9Pass('S3A-10', observed)
    })

    g9Case('S3A-14', '(S7, R-6, R-7) an ESCALATED relationship (confirm -> a reconfirm hold reconciled with its verdict -> end escalate_special_repair), the pilot cleared: two previews suspended with no token, exactly one open runbook-only hold row with its STORED fingerprint and no new hold row; the apply 409 with 0 ADD / INACTIVE; the carry 409 runbook_only_hold', async () => {
      const st = await s3aStack('g9_s14', { pilot: true })
      await firstPullApplied(st)
      st.state.data = CF.secondPullSource()
      expect(status(await st.dryRun())).toBe('suspended')
      const confirmed = await confirmOpenCandidate(st)
      const reconfirm = refreshKit.reconfirmHoldFor(confirmed.continuationId)
      await seedOpenHolds(st.refresh.store, st.scope, [reconfirm], await decisionVersionOf(st.scope), { [confirmed.continuationId]: 'source_scope_changed' })
      await st.refresh.store.endContinuation({ ...st.scope, continuationId: confirmed.continuationId, revision: 1, outcome: 'escalate_special_repair', endedBy: st.users.admin.id }, { bumpWithin: testBumpWithin })
      await st.pilotExit()
      const runbook = (await st.holds()).filter((row: any) => row.status === 'open')
      const main0 = await st.main()
      const rounds: unknown[] = []
      for (let round = 0; round < 2; round += 1) {
        const rowsBefore = (await st.holds()).length
        const preview = await st.dryRun()
        const open = (await st.holds()).filter((row: any) => row.status === 'open')
        rounds.push({ status: status(preview), token: tokenOf(preview), open: open.length, sameRow: open.length === 1 && open[0].id === runbook[0].id, storedFingerprint: open.length === 1 && open[0].fingerprint === reconfirm.fingerprint, opened: (await st.holds()).length - rowsBefore })
      }
      const forged = await st.apply(st.users.puller, await st.mintToken('rev_g9_s14_forged'))
      await seedCarryPair({ multitable: st.multitable, sheetId: st.sheetId, target: st.target }, st.projectNo)
      const main1 = await st.main()
      const carry = await st.carry(carryDecision(st.projectNo))
      const observed = {
        runbookRows: runbook.map((row: any) => row.runbook_only),
        rounds,
        apply: [forged.statusCode, codeOf(forged)],
        applyWroteNothing: sameJson(await st.main(), main1) && main1.count === main0.count + 2,
        carry: [carry.statusCode, codeOf(carry), reasonOf(carry)],
      }
      const round = { status: 'suspended', token: null, open: 1, sameRow: true, storedFingerprint: true, opened: 0 }
      expect(observed).toEqual({ runbookRows: [true], rounds: [round, round], apply: [409, 'STOCK_PREP_PULL_SUSPENDED'], applyWroteNothing: true, carry: [409, 'STOCK_PREP_PULL_SUSPENDED', 'runbook_only_hold'] })
      g9Pass('S3A-14', observed)
    })

    g9Case('S3A-15', '(X2, TD-20) an apply held INSIDE its first host write: a parallel consult derives `executing`; the execution row\'s lease_id is the lock row\'s; under the lease the consult\'s generation token is the guard\'s (the lock row\'s) — then the apply finishes succeeded', async () => {
      const { hook, wrap } = hostHook()
      const st = await s3aStack('g9_s15', { pilot: true, routeMultitable: wrap })
      const preview = await st.dryRun()
      expect(status(preview)).toBe('ready')
      hook.createGate.arm()
      const applying = st.apply(st.users.puller, preview.body.data.dryRunToken)
      await hook.createGate.reached()
      const consult = await st.refresh.governance.consult(st.scope)
      const lockRow = (await q(`SELECT lease_id, generation_token FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [st.key])).rows[0]
      const running = (await q(`SELECT lease_id, status FROM ${RT.execution} WHERE sheet_id = $1 AND status = 'running'`, [st.sheetId])).rows
      const during = {
        derived: derive(consult).status,
        runningRows: running.length,
        leaseMatches: running.length === 1 && running[0].lease_id === lockRow.lease_id && lockRow.lease_id !== null,
        consultTokenIsLockToken: Boolean(consult.lock && consult.lock.generation && consult.lock.generation.generationToken === lockRow.generation_token),
      }
      hook.createGate.open()
      const applied = await applying
      const observed = { during, applied: [applied.statusCode, applied.body.data && applied.body.data.status], executions: await executionStatuses(st) }
      expect(observed).toEqual({ during: { derived: 'executing', runningRows: 1, leaseMatches: true, consultTokenIsLockToken: true }, applied: [200, 'succeeded'], executions: ['succeeded'] })
      g9Pass('S3A-15', observed)
    })

    g9Case('S3A-16', '(X1, S8) the process dies after its first host write (the finish never lands): the row stays running, the lease is gone, the derived state is failed_pending_recovery; the next preview answers recovery_pending and an apply under its own lease 409 RECOVERY_PENDING; nothing more written', async () => {
      const seams = seamedRefresh()
      const st = await s3aStack('g9_s16', { pilot: true, refresh: seams.refresh })
      const preview = await st.dryRun()
      seams.crash.armed = true
      const crashed = await st.apply(st.users.puller, preview.body.data.dryRunToken)
      const main1 = await st.main()
      const lockRow = (await q(`SELECT lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [st.key])).rows[0]
      const next = await st.dryRun()
      const forged = await st.apply(st.users.puller, await st.mintToken('rev_g9_s16_forged'))
      const observed = {
        crashFired: seams.crash.fired,
        crashedApply: crashed.statusCode >= 500,
        written: main1.count,
        executions: await executionStatuses(st),
        leaseGone: lockRow.lease_id === null,
        derived: await derivedStatus(st),
        nextPreview: [status(next), tokenOf(next)],
        apply: [forged.statusCode, codeOf(forged)],
        nothingMore: sameJson(await st.main(), main1),
      }
      expect(observed).toEqual({ crashFired: true, crashedApply: true, written: 4, executions: ['running'], leaseGone: true, derived: 'failed_pending_recovery', nextPreview: ['recovery_pending', null], apply: [409, 'STOCK_PREP_REFRESH_RECOVERY_PENDING'], nothingMore: true })
      g9Pass('S3A-16', observed)
    })

    g9Case('S3A-20', '(T2, R-14) the stored settled_sheet_machine_digest equals an INDEPENDENT recompute (the project-scoped reader + the shared digest over the template\'s machine band) and moves away from it after a host-side machine-column write; the stored settled_generation_token is the settling consult\'s, not the generation the same preview bumped to', async () => {
      const st = await s3aStack('g9_s20', { pilot: true })
      await firstPullApplied(st)
      const genBefore = await st.generation()
      const settling = await st.dryRun()
      expect(status(settling)).toBe('ready')
      const genAfter = await st.generation()
      const state = await stateOf(st)
      const normalized = tableActions.assertStockPreparationTargetReady(tableActions.normalizeStockPreparationActionConfig(st.action))
      const recompute = async () => {
        const asRead = await tableActions.__internals.readExistingStockPreparationRows(st.multitable.records, normalized.target, st.projectNo)
        return pairingLib.sheetMachineDigest(asRead, { machineFieldIds: pairingLib.machineBandFieldIds({ template: normalized.template, installedFieldProperties: undefined }) })
      }
      const independent = await recompute()
      const p = physicalOf(st)
      const root = (await rowsByPart(st)).find((row: any) => row.part === 'S-001')
      await st.multitable.records.patchRecord({ sheetId: st.sheetId, recordId: root.id, changes: { [p('material')]: 'M-G9-HOST-EDIT' } })
      const moved = await recompute()
      const observed = {
        digestShape: /^[0-9a-f]{64}$/.test(String(state.settled_sheet_machine_digest)),
        storedEqualsIndependent: state.settled_sheet_machine_digest === independent,
        movedAfterHostWrite: moved !== state.settled_sheet_machine_digest,
        settledTokenIsConsults: state.settled_generation_token === genBefore.generationToken,
        bumpedAway: genAfter.generationToken !== state.settled_generation_token,
      }
      expect(observed).toEqual({ digestShape: true, storedEqualsIndependent: true, movedAfterHostWrite: true, settledTokenIsConsults: true, bumpedAway: true })
      g9Pass('S3A-20', observed)
    })

    g9Case('S3A-21', '(S6(2), M-1) mvp-persist on a SUSPENDED governed project is 409 NOT_READY refresh_suspended and archives nothing; on a governed project whose sheet carries a pack column (ext_nameAndSpec, ledger-installed) with a valid relationship after a successful apply, mvp-persist plans with the same strict band and archives (201)', async () => {
      const batchRows = async (st: any) => {
        const sheet = await st.multitable.provisioning.findObjectSheet({ projectId: st.projectId, objectId: BATCH_OBJECT_ID }).catch(() => null)
        if (!sheet || !sheet.id) return 0
        return Number((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheet.id])).rows[0].n)
      }
      // (a) suspended.
      const st = await s3aStack('g9_s21a', { pilot: true })
      await provisionMvp(st)
      await firstPullApplied(st)
      st.state.data = CF.secondPullSource()
      expect(status(await st.dryRun())).toBe('suspended')
      const archived0 = await batchRows(st)
      const refused = await st.mvpPersist()
      // (b) the pack band: one ledger-installed ext_ column on the sheet, then the A02 path, then the archive.
      const packStore = packInstallStoreLib.createStockPreparationPackInstallStore({ db: createDb({ database: createProductionPluginContext().api.database }) })
      const pk = await s3aStack('g9_s21b', { pilot: true, serviceExtras: { stockPreparationPackInstallStore: packStore } })
      tenants.push(pk.tenantId)
      await provisionMvp(pk)
      await pk.multitable.provisioning.ensureMissingObjectFields({ projectId: pk.projectId, objectId: pk.objectId, fields: [{ id: 'ext_nameAndSpec', name: '名称及规格（合成）', type: 'string', property: {} }] })
      await packStore.recordInstall({ tenantId: pk.tenantId, projectId: pk.projectId, objectId: pk.objectId, packId: 'g9_synthetic_pack', packVersion: '1.0.0', installedFields: [{ fieldId: 'ext_nameAndSpec', ownership: 'plm_system', preserveOnRefresh: false, extension: true }] })
      await firstPullApplied(pk)
      pk.state.data = CF.secondPullSource()
      expect(status(await pk.dryRun())).toBe('suspended')
      await confirmOpenCandidate(pk)
      const second = await pk.dryRun()
      expect((await pk.apply(pk.users.puller, second.body.data.dryRunToken)).statusCode).toBe(200)
      const archive = await pk.mvpPersist()
      const observed = {
        suspended: [refused.statusCode, codeOf(refused), reasonOf(refused), (await batchRows(st)) - archived0],
        pack: [archive.statusCode, archive.body.data && archive.body.data.status, codeOf(archive)],
        relationship: (await continuations(pk)).map((row: any) => row.status),
      }
      expect(observed).toEqual({ suspended: [409, 'STOCK_PREPARATION_MVP_SOURCE_EXPANSION_NOT_READY', 'refresh_suspended', 0], pack: [201, 'created', null], relationship: ['active'] })
      g9Pass('S3A-21', observed)
    })

    g9Case('S3A-24', '(H7, AMB-2, R-4) on a governed project with a relationship, a max_rows TRUNCATED read and, separately, a soft row error: 0 hold or verdict writes, last_computation_* unchanged, the relationship active, no token (the soft error previews failed; the truncated read is the pilot\'s bounded refusal 409 SMALL_LANE_LIMIT_EXCEEDED); a governed token over the same read 409 NOT_APPLYABLE refresh_incomplete_computation with no execution row; the next complete read verifies valid', async () => {
      const observed: Record<string, unknown> = {}
      for (const leg of ['truncated', 'softError'] as const) {
        const st = await s3aStack(`g9_s24${leg[0]}`, { pilot: true })
        await firstPullApplied(st)
        st.state.data = CF.secondPullSource()
        expect(status(await st.dryRun())).toBe('suspended')
        const confirmed = await confirmOpenCandidate(st)
        const second = await st.dryRun()
        expect((await st.apply(st.users.puller, second.body.data.dryRunToken)).statusCode).toBe(200)
        const clean = CF.secondPullSource()
        expect(status(await st.dryRun())).toBe('ready')
        const stepFour0 = await stepFour(st.tenantId)
        const state0 = await stateOf(st)
        const executions0 = (await st.executions()).length
        const original = st.sourceAdapter.read
        if (leg === 'truncated') {
          // The source answers one page and claims more (a truncated read the bounded expander refuses to plan from).
          st.sourceAdapter.read = async (input: any = {}) => {
            const answer = await original(input)
            if (input.object === 'DN_PDM_BomDetailsInfo') return { ...answer, done: false, nextCursor: 'g9_more' }
            return answer
          }
        } else {
          // A soft row error: one BOM line with a non-numeric usage.
          st.state.data = { ...clean, DN_PDM_BomDetailsInfo: clean.DN_PDM_BomDetailsInfo.map((line: any, index: number) => (index === 0 ? { ...line, Bom_ExAttr1: 'not-a-number' } : line)) }
        }
        const preview = await st.dryRun()
        const forged = await st.apply(st.users.puller, await st.mintToken(`rev_g9_s24_${leg}`))
        const state1 = await stateOf(st)
        const lastComputation = (s: any) => [s.last_computation_at && String(s.last_computation_at), s.last_computation_lane, s.last_computation_generation_token, s.last_computation_source_content_digest, s.last_computation_suspended]
        const after = {
          preview: [preview.statusCode, status(preview) ?? codeOf(preview), tokenOf(preview)],
          stepFourUnchanged: sameJson(await stepFour(st.tenantId), stepFour0),
          lastComputationUnchanged: sameJson(lastComputation(state1), lastComputation(state0)),
          relationship: (await continuations(st)).find((row: any) => row.id === confirmed.continuationId).status,
          apply: [forged.statusCode, codeOf(forged), reasonOf(forged)],
          newExecutions: (await st.executions()).length - executions0,
        }
        st.sourceAdapter.read = original
        st.state.data = clean
        const recovered = await st.dryRun()
        observed[leg] = { ...after, next: status(recovered), nextRelationship: (await continuations(st)).find((row: any) => row.id === confirmed.continuationId).status }
      }
      // The truncated (more-pages, max_rows-class) read is the bounded expansion; on a PILOT project its preview is the
      // pilot's form of large_bom_bounded (409 SMALL_LANE_LIMIT_EXCEEDED: the panel never auto-starts the large lane).
      const after = (preview: unknown[]) => ({ preview, stepFourUnchanged: true, lastComputationUnchanged: true, relationship: 'active', apply: [409, 'TABLE_ACTION_DRY_RUN_NOT_APPLYABLE', 'refresh_incomplete_computation'], newExecutions: 0, next: 'ready', nextRelationship: 'active' })
      expect(observed).toEqual({
        truncated: after([409, 'STOCK_PREP_PILOT_SMALL_LANE_LIMIT_EXCEEDED', null]),
        softError: after([200, 'failed', null]),
      })
      g9Pass('S3A-24', observed)
    })

    g9Case('S3A-25', '(R-1, G11) a governed project confirmed against ONE binding; the tenant-wide binding repointed to a second source => dry-run, reconcile, apply and mvp-persist 409 SOURCE_BINDING_SPLIT before any source read, 0 reconcile, the relationship active; the split removed => every lane verifies valid and the relationship stays active', async () => {
      // The REAL binding store over real migration-079 rows: a workspace row and the tenant-wide (null) row.
      const bindingStore = sourceBindingStoreLib.createStockPreparationSourceBindingStore({ db: createDb({ database: createProductionPluginContext().api.database }) })
      const st = await s3aStack('g9_s25', { pilot: true, serviceExtras: { stockPreparationSourceBindingStore: bindingStore } })
      tenants.push(st.tenantId)
      const ES1 = st.action.source.externalSystemId
      const actionId = tableActions.PLM_STOCK_PREPARATION_ACTION_ID
      await q('INSERT INTO integration_stock_prep_source_binding (id, tenant_id, workspace_id, action_id, external_system_id, updated_by) VALUES ($1, $2, $3, $4, $5, $6), ($7, $2, NULL, $4, $5, $6)', [`sb_g9_w_${TOKEN}`, st.tenantId, 'w1', actionId, ES1, 'u_g9_admin', `sb_g9_n_${TOKEN}`])
      const repoint = (systemId: string) => q('UPDATE integration_stock_prep_source_binding SET external_system_id = $2, updated_at = now() WHERE id = $1', [`sb_g9_n_${TOKEN}`, systemId])
      await firstPullApplied(st)
      st.state.data = CF.secondPullSource()
      expect(status(await st.dryRun())).toBe('suspended')
      const confirmed = await confirmOpenCandidate(st)
      await repoint(`${ES1}_other`)
      const reads0 = st.state.reads
      const holdsBefore = JSON.stringify(await st.holds())
      const split = {
        dryRun: codeOf(await st.dryRun()),
        reconcile: codeOf(await st.reconcile()),
        apply: codeOf(await st.apply(st.users.puller, await st.mintToken('rev_g9_s25'))),
        mvp: codeOf(await st.mvpPersist()),
      }
      const during = { reads: st.state.reads - reads0, holdsUnchanged: JSON.stringify(await st.holds()) === holdsBefore, relationship: (await continuations(st)).find((row: any) => row.id === confirmed.continuationId).status }
      await repoint(ES1)
      const healed = await st.dryRun()
      const observed = { split, during, healed: status(healed), relationship: (await continuations(st)).find((row: any) => row.id === confirmed.continuationId).status }
      const SPLIT = 'STOCK_PREP_REFRESH_SOURCE_BINDING_SPLIT'
      // mvp-persist's own #6475 binding guard (the archive's no-digest leg, shared helper sourceBindingDisagreementOf) runs
      // before its governed planning and answers in its own family — the same split, refused before any source read.
      expect(observed).toEqual({ split: { dryRun: SPLIT, reconcile: SPLIT, apply: SPLIT, mvp: 'STOCK_PREPARATION_MVP_SOURCE_BINDING_SPLIT' }, during: { reads: 0, holdsUnchanged: true, relationship: 'active' }, healed: 'ready', relationship: 'active' })
      g9Pass('S3A-25', observed)
    })

    g9Case('S3A-26', '(R-2, M-1) a REAL PostgreSQL 42501 on the pack ledger read (a throwaway role without SELECT on it, scoped to the ledger binding of this case only): a governed project\'s dry-run, reconcile, apply and mvp-persist answer 503 pack_installed_fields with 0 source reads, 0 step-4 writes and nothing settled; the same fault on a NOT-governed project keeps today\'s legacy-band preview', async () => {
      const role = `g9_noledger_${TOKEN}`.toLowerCase().replace(/[^a-z0-9_]/g, '_')
      const me = (await q('SELECT current_user AS u, (SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS can')).rows[0]
      expect(me.can, 'the real-DB step must be able to create a throwaway role (fail, never skip)').toBe(true)
      await q(`CREATE ROLE ${role} NOLOGIN`)
      await q(`GRANT ${role} TO ${me.u}`).catch(() => {})
      try {
        // Every statement of THIS binding runs as the role: the pack ledger SELECT is refused by PostgreSQL itself.
        const refusingDb = createDb({
          database: {
            query: async (sql: string, params?: unknown[]) => {
              const client = await poolManager.get().getInternalPool().connect()
              try {
                await client.query('BEGIN')
                await client.query(`SET LOCAL ROLE ${role}`)
                const result = await client.query(sql, params)
                await client.query('COMMIT')
                return result.rows
              } catch (error) {
                await client.query('ROLLBACK').catch(() => {})
                throw error
              } finally {
                client.release()
              }
            },
            transaction: async () => { throw new Error('not used') },
          },
        })
        const refusing = packInstallStoreLib.createStockPreparationPackInstallStore({ db: refusingDb })
        const healthy = packInstallStoreLib.createStockPreparationPackInstallStore({ db: createDb({ database: createProductionPluginContext().api.database }) })
        const witness = await refusing.listInstalledFieldIds({ tenantId: 't_g9', projectId: 't_g9:integration-core', objectId: 'stockPreparationMain' }).then(() => 'answered', (error: any) => String(error && (error.code || (error.cause && error.cause.code))))
        // The ledger binding of the ROUTES flips to the refusing one after the first pull (a governed first pull reads it too).
        const fault = { on: false }
        const switchable: any = {}
        for (const name of Object.keys(healthy)) {
          switchable[name] = typeof healthy[name] === 'function' ? (...args: any[]) => (fault.on ? refusing : healthy)[name](...args) : healthy[name]
        }
        const st = await s3aStack('g9_s26g', { pilot: true, serviceExtras: { stockPreparationPackInstallStore: switchable } })
        await firstPullApplied(st)
        fault.on = true
        const reads0 = st.state.reads
        const stepFour0 = await stepFour(st.tenantId)
        const answers = {
          dryRun: [(await st.dryRun()).statusCode],
          reconcile: [(await st.reconcile()).statusCode],
          apply: [(await st.apply(st.users.puller, await st.mintToken('rev_g9_s26'))).statusCode],
          mvp: [(await st.mvpPersist()).statusCode],
        }
        const detail = errorOf(await st.dryRun()).details || {}
        const governedLeg = { answers, store: detail.store, reads: st.state.reads - reads0, stepFourUnchanged: sameJson(await stepFour(st.tenantId), stepFour0) }
        const plain = await s3aStack('g9_s26n', { pilot: false, serviceExtras: { stockPreparationPackInstallStore: refusing } })
        fault.on = false
        const legacy = await plain.dryRun()
        const observed = { witness, governed: governedLeg, notGoverned: [legacy.statusCode, status(legacy)] }
        expect(observed).toEqual({
          witness: '42501',
          governed: { answers: { dryRun: [503], reconcile: [503], apply: [503], mvp: [503] }, store: 'pack_installed_fields', reads: 0, stepFourUnchanged: true },
          notGoverned: [200, 'ready'],
        })
        g9Pass('S3A-26', observed)
      } finally {
        await q(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
      }
    })

    // ── G9-U08: the synthetic end-to-end run ────────────────────────────────────────────────────────────────────────
    g9Case('G9-U08', '(U08) the synthetic end-to-end run A01 -> A02 -> A03 -> A05 -> C08 with E06 and E07 injected on ONE BI-installed governed sheet (批次标识 switch ON): the suspension, the confirm, a partial write (E06) recovered and retried with the batch labels kept (E10), the identical pull opening no batch (A03), the content change confirmed, a write whose process died (E07) recovered, the review, the export allowed, and a further change refusing the export again', async () => {
      const steps: Array<Record<string, unknown>> = []
      const { hook, wrap } = hostHook()
      const seams = seamedRefresh()
      const ledgerStore = pullBatchStoreLib.createStockPreparationPullBatchStore({ db: createDb({ database: createProductionPluginContext().api.database }) })
      const st = await s3aStack('g9_u08', { pilot: true, routeMultitable: wrap, refresh: seams.refresh, serviceExtras: { stockPreparationPullBatchStore: ledgerStore } })
      tenants.push(st.tenantId)
      const p = await bornEmptyBand(st, ledgerStore)
      const exportCode = async () => {
        const res = await both(true, () => st.exportLines())
        return res.statusCode === 200 ? 'exported' : `${res.statusCode}:${codeOf(res)}`
      }
      const labels = async () => (await st.rows()).map((row: any) => ({ id: row.id, part: row.data[p('componentSourceId')], first: row.data[p('firstPullBatch')] ?? null, current: row.data[p('pullBatch')] ?? null }))
      // 批次标识's own ledger, per step: every batch (number, status, closed reason, label) and every execution link
      // (its batch, writer status, created-row count, verified outcome). Labels are compared, never printed.
      const ledgerTrace = async () => {
        const batches = (await q('SELECT id, batch_no, status, closed_reason, label FROM integration_stock_prep_pull_batch WHERE tenant_id = $1 ORDER BY batch_no, id', [st.tenantId])).rows
        const links = (await q('SELECT b.batch_no, l.writer_status, l.created_row_count, l.verified_outcome FROM integration_stock_prep_pull_batch_execution l JOIN integration_stock_prep_pull_batch b ON b.id = l.batch_id WHERE l.tenant_id = $1 ORDER BY l.joined_at, l.id', [st.tenantId])).rows
        return {
          batches: batches.map((row: any) => `${row.batch_no}:${row.status}:${row.closed_reason ?? '-'}`),
          links: links.map((row: any) => `${row.batch_no}:${row.writer_status ?? '-'}:${row.created_row_count ?? '-'}:${row.verified_outcome ?? '-'}`),
          labelOf: Object.fromEntries(batches.map((row: any) => [row.batch_no, row.label])) as Record<number, string>,
        }
      }
      const record = async (step: string, extra: Record<string, unknown> = {}) => {
        const ledger = await ledgerTrace()
        const entry: Record<string, any> = { step, derived: await derivedStatus(st), executions: await executionStatuses(st), rows: (await st.main()).count, batches: ledger.batches, links: ledger.links, ...extra }
        steps.push(entry)
        console.log(`[G9-U08] ${JSON.stringify(entry)}`)
        return entry
      }
      const pull = async () => {
        const dry = await both(true, () => st.dryRun())
        const applied = status(dry) === 'ready' ? await both(true, () => st.apply(st.users.puller, dry.body.data.dryRunToken)) : null
        return { dry, applied }
      }
      const unfinished = async () => (await st.executions()).filter((row: any) => ['running', 'partial', 'failed', 'aborted'].includes(row.status))

      // A01 — the first pull (batch 1), then the second pull that nests S-001 in P-001: suspended, nothing written.
      st.state.data = CF.firstPullSource()
      const a01first = await pull()
      expect(a01first.applied && a01first.applied.statusCode).toBe(200)
      st.state.data = CF.secondPullSource()
      const a01 = await pull()
      await record('A01', { preview: status(a01.dry), token: tokenOf(a01.dry), export: await exportCode() })
      const labelsA01 = await labels()
      // A02 — the puller confirms the same demand through the route; the apply hits E06 (the host refuses one of the two
      // creates: partial); the recovery verifies and closes it; the retry lands the missing row in the SAME batch.
      await routeConfirmCandidate(st)
      hook.failCreates = 1
      const a02 = await pull()
      const partial = await unfinished()
      const e06 = await record('A02-E06', { preview: status(a02.dry), applyStatus: a02.applied && a02.applied.statusCode, export: await exportCode() })
      const labelsAfterFailure = await labels()
      const e06Closed = await verifyAndClose(st, partial[0].id)
      const e06Recovered = await record('A02-recovered', { verify: e06Closed.report.result, close: e06Closed.closed.status || 'closed' })
      const retry = await pull()
      const labelsAfterRetry = await labels()
      // E10: EVERY row the failure left carries both labels, and keeps them byte-equal across the retry (a stamping lane
      // gone dead leaves every label null — that must fail here, not pass vacuously).
      const keptLabels = labelsAfterFailure.length > 0 && labelsAfterFailure.every((row: any) => {
        const now = labelsAfterRetry.find((entry: any) => entry.id === row.id)
        return row.first !== null && row.current !== null && now && now.first === row.first && now.current === row.current
      })
      const settleA02 = await both(true, () => st.dryRun())
      const a02done = await record('A02-retried', { retry: retry.applied && retry.applied.body.data.status, keptLabels, settle: status(settleA02), export: await exportCode() })
      // The SAME batch: the row E06 created and the row the retry created both carry batch 2's label (first and current:
      // both are new materials), and every A01 row still carries batch 1's.
      const ledgerA02 = await ledgerTrace()
      const createdByE06 = labelsAfterFailure.filter((row: any) => !labelsA01.some((entry: any) => entry.id === row.id))
      const createdByRetry = labelsAfterRetry.filter((row: any) => !labelsAfterFailure.some((entry: any) => entry.id === row.id))
      const labelState = (rows: any[], batchNo: number) => rows.map((row: any) => (row.first === ledgerA02.labelOf[batchNo] && row.current === ledgerA02.labelOf[batchNo] ? `batch${batchNo}` : `other:${row.first === null ? 'null' : 'set'}/${row.current === null ? 'null' : 'set'}`))
      const sameBatch = {
        labelsDistinct: typeof ledgerA02.labelOf[1] === 'string' && typeof ledgerA02.labelOf[2] === 'string' && ledgerA02.labelOf[1] !== ledgerA02.labelOf[2],
        a01Rows: labelState(labelsAfterRetry.filter((row: any) => labelsA01.some((entry: any) => entry.id === row.id)), 1),
        e06Rows: labelState(labelsAfterRetry.filter((row: any) => createdByE06.some((entry: any) => entry.id === row.id)), 2),
        retryRows: labelState(createdByRetry, 2),
        everyRowLabelled: labelsAfterRetry.every((row: any) => row.first !== null && row.current !== null),
      }
      // A03 — a third identical pull: no hold, no write, no new batch and no new link row.
      const ledgerBeforeA03 = await ledgerTrace()
      const a03 = await pull()
      const ledgerAfterA03 = await ledgerTrace()
      const a03done = await record('A03', {
        preview: status(a03.dry),
        written: a03.applied && a03.applied.body.data.apply ? Number(a03.applied.body.data.apply.written || 0) : null,
        newBatches: ledgerAfterA03.batches.length - ledgerBeforeA03.batches.length,
        newLinks: ledgerAfterA03.links.length - ledgerBeforeA03.links.length,
        ledgerUnchanged: sameJson(ledgerAfterA03, ledgerBeforeA03),
      })
      // A05 + C08 — PART-C's usage changes inside the continued subtree: suspended; the change plan is confirmed through the
      // route; the write lands but the process dies before its finish (E07): recovered (landed); the review; the export.
      st.state.data = CF.secondPullSource({ boms: { 'PART-A': [{ part: 'PART-C', usage: 5 }] } })
      const a05 = await both(true, () => st.dryRun())
      const a05done = await record('A05', { preview: status(a05), token: tokenOf(a05), export: await exportCode() })
      const { body } = await boundBody(st)
      const cp = await both(true, () => cpCall(st, 'POST', CPR.confirm, { body }))
      expect(cp.statusCode, JSON.stringify(cp.body)).toBe(201)
      const cpId = cp.body.data.changePlanId
      seams.crash.armed = true
      const c08write = await pull()
      const running = await unfinished()
      const e07 = await record('C08-E07', { applyStatus: c08write.applied && c08write.applied.statusCode, crashFired: seams.crash.fired, plan: (await planById(cpId)).status, export: await exportCode() })
      const e07Closed = await verifyAndClose(st, running[0].id)
      const afterE07 = await record('C08-recovered', { verify: e07Closed.report.result, plan: (await planById(cpId)).status, export: await exportCode() })
      const { body: review } = await reviewBody(st)
      const reviewed = await both(true, () => cpCall(st, 'POST', CPR.review, { body: review }))
      expect(reviewed.statusCode, JSON.stringify(reviewed.body)).toBe(200)
      const settleC08 = await both(true, () => st.dryRun())
      const c08done = await record('C08-reviewed', { plan: (await planById(cpId)).status, settle: status(settleC08), export: await exportCode() })
      // C08's last step — the source changes again: the review no longer covers it, the export is refused again.
      st.state.data = CF.secondPullSource({ boms: { 'PART-A': [{ part: 'PART-C', usage: 6 }] } })
      const again = await both(true, () => st.dryRun())
      const c08again = await record('C08-changed-again', { preview: status(again), export: await exportCode() })

      const observed = {
        A01: { preview: steps[0].preview, token: steps[0].token, rows: steps[0].rows, exportRefused: String(steps[0].export).startsWith('409'), batches: steps[0].batches, links: steps[0].links },
        E06: { applyStatus: e06.applyStatus, executions: e06.executions, derived: e06.derived, exportRefused: String(e06.export).startsWith('409'), verify: e06Closed.report.result, batches: e06.batches, links: e06.links },
        E06recovered: { batches: e06Recovered.batches, links: e06Recovered.links },
        A02: { retry: a02done.retry, keptLabels: a02done.keptLabels, settle: a02done.settle, derived: a02done.derived, export: a02done.export, rows: a02done.rows, batches: a02done.batches, links: a02done.links, sameBatch },
        A03: { preview: a03done.preview, written: a03done.written, newBatches: a03done.newBatches, newLinks: a03done.newLinks, ledgerUnchanged: a03done.ledgerUnchanged },
        A05: { preview: a05done.preview, token: a05done.token, exportRefused: String(a05done.export).startsWith('409') },
        E07: { crashFired: e07.crashFired, executionsHaveRunning: (e07.executions as string[]).includes('running'), exportRefused: String(e07.export).startsWith('409'), verify: e07Closed.report.result, planAfterClose: afterE07.plan, exportAfterClose: String(afterE07.export).startsWith('409') ? 'refused' : 'exported' },
        C08: { plan: c08done.plan, export: c08done.export, again: c08again.preview, exportAgain: String(c08again.export).startsWith('409') ? 'refused' : 'exported' },
      }
      expect(observed).toEqual({
        // The ledger, per step (`<batch_no>:<status>:<closed_reason>`, links `<batch_no>:<writer>:<created>:<verified>`):
        // A01's pull is batch 1, closed by its own success; E06 opens batch 2 with a PARTIAL link that created 1 row;
        // the mixed close verifies that link verified_mixed and KEEPS batch 2 open (C-3); the retry joins batch 2 (its
        // own succeeded link) and its success closes it; A03 adds no batch and no link.
        A01: { preview: 'suspended', token: null, rows: 4, exportRefused: true, batches: ['1:closed:execution_succeeded'], links: ['1:succeeded:4:-'] },
        E06: { applyStatus: e06.applyStatus, executions: ['succeeded', 'partial'], derived: 'failed_pending_recovery', exportRefused: true, verify: 'mixed', batches: ['1:closed:execution_succeeded', '2:open:-'], links: ['1:succeeded:4:-', '2:partial:1:-'] },
        E06recovered: { batches: ['1:closed:execution_succeeded', '2:open:-'], links: ['1:succeeded:4:-', '2:partial:1:verified_mixed'] },
        A02: {
          retry: 'succeeded', keptLabels: true, settle: 'ready', derived: 'complete', export: 'exported', rows: 6,
          batches: ['1:closed:execution_succeeded', '2:closed:execution_succeeded'],
          links: ['1:succeeded:4:-', '2:partial:1:verified_mixed', '2:succeeded:1:-'],
          sameBatch: { labelsDistinct: true, a01Rows: ['batch1', 'batch1', 'batch1', 'batch1'], e06Rows: ['batch2'], retryRows: ['batch2'], everyRowLabelled: true },
        },
        A03: { preview: 'ready', written: 0, newBatches: 0, newLinks: 0, ledgerUnchanged: true },
        A05: { preview: 'suspended', token: null, exportRefused: true },
        E07: { crashFired: true, executionsHaveRunning: true, exportRefused: true, verify: 'landed', planAfterClose: 'written', exportAfterClose: 'refused' },
        C08: { plan: 'reviewed', export: 'exported', again: 'suspended', exportAgain: 'refused' },
      })
      g9Pass('G9-U08', observed)
    }, 600000)

    // ── G9-U03: the authorization drill ─────────────────────────────────────────────────────────────────────────────
    g9Case(['G9-U03', 'G9-S65-U03'], '(U03; S6-5\'s census and remnant routes join it) every step-4/5/6 route and every 批次标识 route of the capability manifest, plus every pull step of the operator split: below its tier 403 with no audit row and nothing written; the pull / admin tiers admitted; a TENANTLESS platform admin and a cross-tenant puller / admin, sent THIS tenant\'s REAL hold / continuation / execution / change-plan ids with VALID bodies (no unlisted stop at body validation) and steering tenantId carriers, answer exactly what they answer for ids that exist nowhere, are refused 403 at the tenant gate when a carrier names this tenant, never echo this tenant\'s ids, and those refusals write nothing; the OWNER-GATED legacy path (G9-U03-LEGACY-TENANTLESS-ADMIN, pre-existing) is PINNED, not certified: with the tenant-claim flag off the tenantless admin naming this tenant previews (200, a token) and APPLIES (200, written 1) into it, with the flag \'true\' it is refused 403 on every carrier and nothing is written while this tenant\'s own claimed puller still previews (ready, a token)', async () => {
      const ledgerStore = pullBatchStoreLib.createStockPreparationPullBatchStore({ db: createDb({ database: createProductionPluginContext().api.database }) })
      const st = await s3aStack('g9_u03', { pilot: true, serviceExtras: { stockPreparationPullBatchStore: ledgerStore, stockPreparationComponentRulingStore: rulingStore() } })
      tenants.push(st.tenantId)
      // THE FIXTURE: this tenant owns one of every id kind the routes address — ledger batches (the band born empty, two
      // landed pulls), a continuation (the route confirm), executions, a change plan (the route confirm) and holds.
      await bornEmptyBand(st, ledgerStore)
      const pull = async () => {
        const dry = await both(true, () => st.dryRun())
        const applied = status(dry) === 'ready' ? await both(true, () => st.apply(st.users.puller, dry.body.data.dryRunToken)) : null
        return { dry, applied }
      }
      st.state.data = CF.firstPullSource()
      expect((await pull()).applied?.statusCode).toBe(200)
      st.state.data = CF.secondPullSource()
      expect(status((await pull()).dry)).toBe('suspended')
      const confirmed = await routeConfirmCandidate(st)
      expect((await pull()).applied?.statusCode).toBe(200)
      st.state.data = CF.secondPullSource({ boms: { 'PART-A': [{ part: 'PART-C', usage: 5 }] } })
      expect(status(await both(true, () => st.dryRun()))).toBe('suspended')
      const { body: cpBody } = await boundBody(st)
      const cp = await both(true, () => cpCall(st, 'POST', CPR.confirm, { body: cpBody }))
      expect(cp.statusCode, JSON.stringify(cp.body)).toBe(201)
      const holdRows = await st.holds()
      const executionRows = await st.executions()
      const REAL: Record<string, string> = {
        holdId: (holdRows.find((row: any) => row.status === 'open') || holdRows[holdRows.length - 1]).id as string,
        continuationId: confirmed.continuationId as string,
        executionId: executionRows[executionRows.length - 1].id as string,
        changePlanId: cp.body.data.changePlanId as string,
      }
      // S6-5 (G9-S65-U03): an inactive-root remnant and its acknowledgement through the REAL route — a real component handle
      // and a real acknowledgement id of this tenant for the census / remnant routes.
      await seedInactiveRootRemnant(st, 'PART-A')
      const spAdminOfSt = { id: `u_g9_u03_ack_${TOKEN}`, tenantId: st.tenantId, permissions: [access.STOCK_PREP_ADMIN] }
      const componentHandle: string = sheetCensusLib.__internals.componentHandle(st.tenantId, st.projectNo, 'PART-A')
      const acknowledged = await acknowledgeRemnant(st, spAdminOfSt, componentHandle)
      expect(acknowledged.statusCode, JSON.stringify(acknowledged.body)).toBe(201)
      REAL.componentHandle = componentHandle
      REAL.acknowledgementId = acknowledged.body.data.acknowledgementId
      // Well-formed ids that exist nowhere (a handle of no component, a ruling id never minted): the shape checks pass.
      const BOGUS: Record<string, string> = {
        holdId: 'hold_g9_u03_none', continuationId: 'cont_g9_u03_none', executionId: 'exe_g9_u03_none', changePlanId: 'cp_g9_u03_none',
        componentHandle: sheetCensusLib.__internals.componentHandle(st.tenantId, st.projectNo, 'G9-NO-SUCH-PART'),
        acknowledgementId: 'cr_00000000-0000-4000-8000-000000000000',
      }
      const ledgerIds = [
        ...(await q('SELECT id FROM integration_stock_prep_pull_batch WHERE tenant_id = $1', [st.tenantId])).rows.map((row: any) => row.id),
        ...(await q('SELECT id FROM integration_stock_prep_pull_batch_execution WHERE tenant_id = $1', [st.tenantId])).rows.map((row: any) => row.id),
      ]
      const other = await s3aStack('g9_u03x', { pilot: true })
      // THE INDEPENDENT TIER ORACLE: every drilled capability's tier written out HERE (the ladder read < operate < pull <
      // stock-prep admin), never read from the manifest. The handlers gate with their own literal requireAccess(...) calls,
      // so a handler re-tiered without this table turns the drill red; the manifest must agree with this table too.
      const RANK: Record<string, number> = { read: 1, operate: 2, pull: 3, admin: 4 }
      const EXPECTED_TIERS: Record<string, string> = {
        'confirmationQueue.export': 'operate',
        'projectTarget.pilotRead': 'admin',
        'projectTarget.pilotEnable': 'admin',
        'projectTarget.pullBatchRead': 'admin',
        'pullBatch.settingsRead': 'admin',
        'pullBatch.settingsSet': 'admin',
        'projectTarget.pullBatchSettingsSet': 'admin',
        'projectTarget.pullBatchInstall': 'admin',
        'refresh.holds': 'pull',
        'refresh.evidence': 'pull',
        'refresh.keep': 'pull',
        'refresh.confirm': 'pull',
        'refresh.continuation': 'pull',
        'refresh.end': 'pull',
        'refresh.changePlan': 'pull',
        'refresh.changePlanConfirm': 'pull',
        'refresh.reviewComplete': 'pull',
        'refresh.executions': 'pull',
        'refresh.recover': 'pull',
        'refresh.closeUnverified': 'admin',
        // S6-5 (#6842, G9-S65-U03): the doubled-sheet census (tenant-wide and per project) and the remnant acknowledgement.
        'projectTarget.census': 'admin',
        'projectTarget.censusRead': 'admin',
        'projectTarget.remnantAcknowledge': 'admin',
        'projectTarget.remnantRevoke': 'admin',
        // S6-6 (#6843): the doubled-sheet repair (preview / execute of a recipe and of the continuation), its fills
        // report and its run list. Drilled with the repair switch OFF (see `send` below and the block after the drill).
        'projectTarget.sheetRepair': 'admin',
        'projectTarget.sheetRepairFillsReport': 'admin',
        'projectTarget.sheetRepairRuns': 'admin',
        // EVERY pull step of the operator split (STOCK_PREP_OPERATOR_PULL_STEPS): the pull tier for stock-prep callers.
        'pull.dry-run': 'pull',
        'pull.dry-run-job-start': 'pull',
        'pull.dry-run-job-get': 'pull',
        'pull.apply': 'pull',
        'pull.large-bom-expansion-start': 'pull',
        'pull.large-bom-expansion-get': 'pull',
        'pull.large-bom-expansion-run': 'pull',
        'pull.large-bom-expansion-plan': 'pull',
        'pull.large-bom-apply-start': 'pull',
        'pull.large-bom-apply-get': 'pull',
        'pull.large-bom-apply-run': 'pull',
        'pull.large-bom-expansion-cancel': 'pull',
        'pull.reconcile': 'pull',
      }
      // THE SCOPE IS THE WHOLE MANIFEST minus the capabilities that predate step 4 (their own permission-matrix suites
      // drill them), listed by name: a capability any later PR adds (S6-6's repair routes) lands in manifestTiers and
      // fails the equality below until it is drilled here.
      const PRE_STEP_FOUR = new Set([
        'confirmationQueue.readiness', 'confirmationQueue.list', 'confirmationQueue.valueEntry', 'confirmationQueue.confirm',
        'confirmationQueue.projectDirectory', 'handoff.read', 'handoff.advance', 'confirmationQueue.projectBoard',
        'projectTarget.read', 'projectTarget.create', 'projectTarget.list', 'projectTarget.archive', 'projectTarget.restore',
        'projectFields.read', 'projectFields.update', 'projectOverview.refresh', 'projectOverview.ensure',
        'projectTarget.manualRowsRead', 'projectTarget.manualRowsSet', 'confirmationQueue.ensure', 'confirmationQueue.reconcile',
        'members.read', 'members.customRoleCreate', 'members.customRoleUpdate', 'members.customRoleProjectTargets',
      ])
      const inScope = (entry: any) => !PRE_STEP_FOUR.has(entry.capability)
      const manifestTiers = Object.fromEntries(access.STOCK_PREP_WORKBENCH_CAPABILITIES.filter(inScope).map((entry: any) => [entry.capability, String(entry.code).replace(/^stock-prep:/, '')]))
      for (const step of access.STOCK_PREP_OPERATOR_PULL_STEPS) manifestTiers[`pull.${step.step}`] = 'pull'
      // A capability a later PR adds fails THIS equality until it is added above (S6-5's four and S6-6's three are).
      expect(manifestTiers).toEqual(EXPECTED_TIERS)
      const routeOf = (id: string) => {
        if (id.startsWith('pull.')) return access.STOCK_PREP_OPERATOR_PULL_STEPS.find((entry: any) => `pull.${entry.step}` === id)
        return access.STOCK_PREP_WORKBENCH_CAPABILITIES.find((entry: any) => entry.capability === id)
      }
      const drilled = Object.entries(EXPECTED_TIERS).map(([id, tier]) => ({ id, method: routeOf(id).method, path: routeOf(id).path, rank: RANK[tier] }))
      const missing = drilled.filter((entry: any) => !st.routes.has(`${entry.method} ${entry.path}`)).map((entry: any) => entry.id)
      expect(missing).toEqual([])
      // The pull steps a foreign caller is sent only INERT requests for (the matrix records which and why): the S3A stack
      // configures no large lane, so no real job id exists to address, and a valid start from a foreign caller would leave
      // background work running past the case. Their tier legs (below 403, at/above admitted) run like every route's.
      const inertForeign = new Set<string>(G9_MATRIX.u03InertForeignSteps.steps)
      expect([...inertForeign].every((id) => id in EXPECTED_TIERS)).toBe(true)
      const callers: Record<string, any> = {
        reader: { id: `u_g9_r_${TOKEN}`, tenantId: st.tenantId, permissions: [access.STOCK_PREP_READ], rank: 1 },
        operator: { id: `u_g9_o_${TOKEN}`, tenantId: st.tenantId, permissions: [access.STOCK_PREP_READ, access.STOCK_PREP_OPERATE], rank: 2 },
        puller: { id: `u_g9_p_${TOKEN}`, tenantId: st.tenantId, permissions: [access.STOCK_PREP_READ, access.STOCK_PREP_OPERATE, access.STOCK_PREP_PULL], rank: 3 },
        spAdmin: { id: `u_g9_a_${TOKEN}`, tenantId: st.tenantId, permissions: [access.STOCK_PREP_ADMIN], rank: 4 },
      }
      const foreign: Record<string, any> = {
        tenantless: { id: `u_g9_t_${TOKEN}`, roles: ['admin'], permissions: ['integration:admin'] },
        crossPuller: { id: `u_g9_xp_${TOKEN}`, tenantId: other.tenantId, permissions: [access.STOCK_PREP_READ, access.STOCK_PREP_OPERATE, access.STOCK_PREP_PULL] },
        crossAdmin: { id: `u_g9_xa_${TOKEN}`, tenantId: other.tenantId, permissions: [access.STOCK_PREP_ADMIN] },
      }
      const paramsFor = (ids: Record<string, string>) => ({ projectNo: st.projectNo, actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID, holdId: ids.holdId, id: ids.continuationId, executionId: ids.executionId, acknowledgementId: ids.acknowledgementId, jobId: 'job_g9_u03_none', applyJobId: 'ajob_g9_u03_none' })
      // The VALID request of each route — every field its parser requires (any non-empty fingerprint / digest / receipt
      // passes the parse; the scoped read then decides) — so a foreign caller's real id REACHES the tenant gate and the
      // scoped read instead of stopping at body validation (the guard below refuses any such stop the matrix does not
      // list). The settings patches are the vocabulary's own default with a version that matches no row anywhere, so a
      // cross-tenant admin's call answers its OWN tenant's version conflict and writes nothing in any tenant.
      const staleVersion = 987654
      const validRequest = (entry: any, ids: Record<string, string>) => {
        const confirmProjectNo = st.projectNo
        const fp = 'g9_u03_fingerprint'
        const receipt = 'g9_u03_read_receipt'
        const digest = 'g9_u03_content_digest'
        const bodies: Record<string, any> = {
          'refresh.confirm': { confirmProjectNo, holdId: ids.holdId, holdFingerprint: fp, comparisonFingerprint: fp, evidenceFingerprint: fp, readReceipt: receipt },
          'refresh.end': { confirmProjectNo, revision: 1, outcome: 'escalate_special_repair' },
          'refresh.changePlanConfirm': { confirmProjectNo, holdIds: [ids.holdId], holdSetFingerprint: fp, planFingerprint: fp, sourceContentDigest: digest, readReceipt: receipt },
          'refresh.reviewComplete': { confirmProjectNo, changePlanId: ids.changePlanId, contentDigest: digest, conclusion: 'handled', readReceipt: receipt },
          'refresh.recover': { confirmProjectNo, mode: 'verify' },
          'refresh.closeUnverified': { confirmProjectNo, mode: 'inspect' },
          'projectTarget.pullBatchInstall': { confirmProjectNo, mode: 'dry_run' },
          'projectTarget.pullBatchSettingsSet': { confirmProjectNo, expectedVersion: staleVersion, firstPullBatchRule: pullBatchPureLib.DEFAULT_PULL_BATCH_CONFIG.firstPullBatchRule },
          'pullBatch.settingsSet': { expectedVersion: staleVersion, firstPullBatchRule: pullBatchPureLib.DEFAULT_PULL_BATCH_CONFIG.firstPullBatchRule },
          'pull.dry-run': { parameters: { projectNo: st.projectNo } },
          'pull.apply': { parameters: { projectNo: st.projectNo }, confirm: { dryRunToken: 'tok_g9_u03_none' } },
          'pull.reconcile': { parameters: { projectNo: st.projectNo } },
          'projectTarget.remnantAcknowledge': { confirmProjectNo, componentHandle: ids.componentHandle, basis: 'head_not_ordered', runbookRef: 'R-91.g9-u03', acknowledge: { customerAnswered: true } },
          'projectTarget.remnantRevoke': { confirmProjectNo, runbookRef: 'R-91.g9-u03' },
          'projectTarget.sheetRepair': { mode: 'preview', recipe: sheetRepairLib.SHEET_REPAIR_RECIPES[0], confirmProjectNo, componentHandle: ids.componentHandle },
        }
        const body = entry.method === 'GET' ? {} : (bodies[entry.id] || (entry.id.startsWith('refresh.') || entry.id === 'projectTarget.pilotEnable' ? { confirmProjectNo } : {}))
        const query = entry.id === 'confirmationQueue.export' ? { projectNo: st.projectNo } : {}
        return { params: paramsFor(ids), body, query }
      }
      const answerOf = (res: any) => `${res.statusCode}:${codeOf(res) || '-'}`
      // S6-6: EVERY call of this drill runs with the repair switch OFF (the deployment default), whatever the process was
      // started with — the three repair routes then answer their own 404, after the gate and before any IO.
      const repairSwitchOff = async <T>(fn: () => Promise<T>): Promise<T> => {
        const before = process.env[SHEET_REPAIR_SWITCH]
        delete process.env[SHEET_REPAIR_SWITCH]
        try {
          return await fn()
        } finally {
          if (before !== undefined) process.env[SHEET_REPAIR_SWITCH] = before
        }
      }
      const send = (entry: any, user: any, request: { params: any; body: any; query: any }) => repairSwitchOff(() => both(true, () => callRoute(st.routes, entry.method, entry.path, { user, ...request })))
      // The inert request (the admitted phase): made-up ids and an empty body — no admitted call changes anything.
      const inert = () => ({ params: paramsFor(BOGUS), query: {}, body: {} })
      const stTokens = async () => Number((await q(`SELECT count(*)::int AS n FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key LIKE 'integration:table-action:dry-run-token:%' AND value->>'writeScope' = $1`, [st.key])).rows[0].n)
      const tenantRows = async () => {
        const audits = Number((await q('SELECT count(*)::int AS n FROM integration_stock_prep_audit WHERE tenant_id = $1', [st.tenantId])).rows[0].n)
        const plans = (await q(`SELECT id, status FROM ${RT.changePlan} WHERE tenant_id = $1 ORDER BY id`, [st.tenantId])).rows
        const lock = (await q(`SELECT generation, generation_token, lease_id FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [st.key])).rows
        const registry = (await q('SELECT status, pilot_enabled_at, pilot_readiness_version, sheet_id FROM integration_stock_prep_project_target WHERE tenant_id = $1', [st.tenantId])).rows
        const settings = (await q('SELECT * FROM integration_stock_prep_pull_batch_settings WHERE tenant_id = $1', [st.tenantId])).rows
        const rulings = (await q(`SELECT id, kind, status, component_digest FROM ${RULING_TABLE} WHERE tenant_id = $1 ORDER BY id`, [st.tenantId])).rows
        const sheetLedger = (await q('SELECT history_status, version, first_pull_batch_rule, label_format FROM integration_stock_prep_pull_batch_sheet WHERE tenant_id = $1', [st.tenantId])).rows
        const ledger = await ledgerOf(st.tenantId)
        const parts: Record<string, unknown> = { stepFour: await stepFour(st.tenantId), main: await st.main(), continuations: await continuations(st), plans, lock, registry, settings, sheetLedger, rulings, ledger, stTokens: await stTokens() }
        return { audits, parts, fingerprint: JSON.stringify(Object.values(parts)) }
      }
      // The named parts that moved between two snapshots (the owner-gated leg pins them exactly).
      const changedParts = (from: any, to: any) => Object.keys(to.parts).filter((name) => JSON.stringify(to.parts[name]) !== JSON.stringify(from.parts[name]))
      // A route call that carries a VERIFIED tenant claim (req.authenticatedTenantId, which the host's middleware sets only
      // from the verified token; the kit's callRoute carries none): the tenant-claim leg's own-puller control.
      const claimedSend = (entry: any, user: any, request: { params: any; body: any; query: any }, authenticatedTenantId: string) => both(true, async () => {
        const handler = st.routes.get(`${entry.method} ${entry.path}`)
        if (!handler) throw new Error(`route ${entry.method} ${entry.path} is not registered`)
        const res: any = { statusCode: 200, headers: {}, body: undefined }
        res.status = (code: number) => { res.statusCode = code; return res }
        res.json = (payload: unknown) => { res.body = payload; return res }
        res.setHeader = (name: string, value: unknown) => { res.headers[name] = value; return res }
        res.send = (payload: unknown) => { res.body = payload; return res }
        res.end = () => res
        await handler({ user, body: request.body || {}, query: request.query || {}, params: request.params || {}, authenticatedTenantId }, res)
        return res
      })
      // THIS tenant's ids — none may appear in a foreign answer of ANY status, except an id the caller itself sent.
      const tenantIds = [st.sheetId, st.objectId, ...(await st.rows()).map((row: any) => row.id), ...holdRows.map((row: any) => row.id), ...executionRows.map((row: any) => row.id), REAL.continuationId, REAL.changePlanId, REAL.componentHandle, REAL.acknowledgementId, ...ledgerIds]
      const leaks: string[] = []
      const leakCheck = (label: string, res: any, sent: string[]) => {
        const text = JSON.stringify(res.body || {})
        const found = tenantIds.filter((id) => !sent.includes(id) && text.includes(id))
        if (found.length) leaks.push(`${label}:${found.length}`)
      }
      // The control: THIS tenant's own puller / admin, on the same real ids, is answered with the data (the ids are real).
      const ownControl: Record<string, string> = {}
      for (const id of ['refresh.evidence', 'refresh.continuation', 'refresh.recover']) {
        const entry = drilled.find((route: any) => route.id === id)
        ownControl[id] = answerOf(await send(entry, st.users.puller, validRequest(entry, REAL)))
      }
      // The decision body is VALID: this tenant's own puller, on the real plan id, passes the parse and the scoped read and
      // stops at the stale digest — never the 400 / 404 a foreign caller's real id would otherwise be told apart by.
      ownControl['refresh.reviewComplete'] = answerOf(await send(drilled.find((route: any) => route.id === 'refresh.reviewComplete'), st.users.puller, validRequest(drilled.find((route: any) => route.id === 'refresh.reviewComplete'), REAL)))
      ownControl['projectTarget.censusRead'] = answerOf(await censusRead(st, callers.spAdmin))
      ownControl['refresh.closeUnverified'] = answerOf(await send(drilled.find((route: any) => route.id === 'refresh.closeUnverified'), callers.spAdmin, validRequest(drilled.find((route: any) => route.id === 'refresh.closeUnverified'), REAL)))
      // Phase 1 — every caller that must be refused, then the no-write / no-audit proof.
      const before = await tenantRows()
      const refusedAnswers: Record<string, Record<string, string>> = {}
      for (const [name, user] of Object.entries(callers)) {
        for (const entry of drilled.filter((route: any) => user.rank < route.rank)) {
          const res = await send(entry, user, validRequest(entry, REAL))
          ;(refusedAnswers[name] ||= {})[entry.id] = `${res.statusCode}`
        }
      }
      const realSent = Object.values(REAL)
      const foreignAnswers: Record<string, Record<string, string>> = {}
      const realVsBogus: string[] = []
      const steering: Record<string, Record<string, string>> = {}
      // THE BODY-VALIDATION GUARD (R-1): every non-inert foreign answer (real, bogus, each steering carrier) that stopped at
      // body validation, as `<caller>:<route>:<leg>`; compared EXACTLY with the matrix's listed stops below.
      const bodyStopPattern = new RegExp(G9_MATRIX.u03BodyValidationStops.codePattern)
      const bodyStops: string[] = []
      const noteBodyStop = (name: string, id: string, leg: string, res: any) => {
        if (bodyStopPattern.test(answerOf(res))) bodyStops.push(`${name}:${id}:${leg}`)
      }
      // The legacy path is NOT run in this phase: the tenantless admin's pull.dry-run on the query / params carrier is
      // requireTableActionAccess's legacy integration:* branch (http-routes.cjs:1526-1553) and WRITES into this tenant; it
      // is the owner-gated leg after the no-write proof, inside its own write accounting.
      const legacyCarriers = ['query', 'params']
      for (const [name, user] of Object.entries(foreign)) {
        for (const entry of drilled) {
          if (inertForeign.has(entry.id)) {
            const res = await send(entry, user, inert())
            ;(foreignAnswers[name] ||= {})[entry.id] = answerOf(res)
            leakCheck(`${name}:${entry.id}`, res, [])
            continue
          }
          const real = await send(entry, user, validRequest(entry, REAL))
          const bogus = await send(entry, user, validRequest(entry, BOGUS))
          ;(foreignAnswers[name] ||= {})[entry.id] = answerOf(real)
          noteBodyStop(name, entry.id, 'real', real)
          noteBodyStop(name, entry.id, 'bogus', bogus)
          // NO EXISTENCE ORACLE: this tenant's real id is answered exactly like an id that exists nowhere.
          if (answerOf(real) !== answerOf(bogus)) realVsBogus.push(`${name}:${entry.id}:${answerOf(real)}!=${answerOf(bogus)}`)
          leakCheck(`${name}:${entry.id}`, real, realSent)
          leakCheck(`${name}:${entry.id}:bogus`, bogus, [])
          // STEERING: the same valid request naming THIS tenant in the body, the query and the params.
          const request = validRequest(entry, REAL)
          const carriers: Record<string, any> = {
            query: { ...request, query: { ...request.query, tenantId: st.tenantId } },
            params: { ...request, params: { ...request.params, tenantId: st.tenantId } },
          }
          if (entry.method !== 'GET') carriers.body = { ...request, body: { ...request.body, tenantId: st.tenantId } }
          for (const [carrier, steered] of Object.entries(carriers)) {
            if (name === 'tenantless' && entry.id === 'pull.dry-run' && legacyCarriers.includes(carrier)) continue
            const res = await send(entry, user, steered)
            ;(steering[`${name}:${carrier}`] ||= {})[entry.id] = answerOf(res)
            noteBodyStop(name, entry.id, `steer-${carrier}`, res)
            leakCheck(`${name}:${entry.id}:steer-${carrier}`, res, realSent)
          }
        }
      }
      const afterRefusals = await tenantRows()
      // ── THE OWNER-GATED LEG G9-U03-LEGACY-TENANTLESS-ADMIN (PRE-EXISTING product behaviour; ruled 2026-11-11, option A) ──
      const dryRunEntry = drilled.find((route: any) => route.id === 'pull.dry-run')
      const applyEntry = drilled.find((route: any) => route.id === 'pull.apply')
      const pullBody = { parameters: { projectNo: st.projectNo } }
      const carried = (carrier: string, body: any) => (carrier === 'query'
        ? { params: paramsFor(REAL), query: { tenantId: st.tenantId }, body }
        : carrier === 'params'
          ? { params: { ...paramsFor(REAL), tenantId: st.tenantId }, query: {}, body }
          : carrier === 'body'
            ? { params: paramsFor(REAL), query: {}, body: { ...body, tenantId: st.tenantId } }
            : { params: paramsFor(REAL), query: {}, body })
      // (b) FIRST, on the state (a) then writes into: the SAME tenantless caller with the tenant-claim flag exactly 'true'
      //     (this process's env, for this leg only, restored in finally). assertVerifiedTenantClaim (http-routes.cjs:1754)
      //     refuses it 403 on pull.dry-run and pull.apply on every carrier (none / query / params / body) — the apply sent
      //     a LIVE token this tenant's own claimed puller just minted — with nothing written and no audit (the live token
      //     not consumed); this tenant's puller WITHOUT a claim is refused the same way; WITH its verified claim it still
      //     previews (ready, a token). Its token is never applied: the apply would consume the confirmed change plan (a)
      //     then measures.
      const claimFlagBefore = process.env[TENANT_CLAIM_FLAG]
      let claimLeg: Record<string, unknown>
      try {
        process.env[TENANT_CLAIM_FLAG] = 'true'
        const ownDry = await claimedSend(dryRunEntry, st.users.puller, carried('none', pullBody), st.tenantId)
        const liveToken = tokenOf(ownDry)
        const beforeClaimRefusals = await tenantRows()
        const refused: Record<string, string> = {}
        for (const carrier of ['none', 'query', 'params', 'body']) {
          refused[`pull.dry-run:${carrier}`] = answerOf(await send(dryRunEntry, foreign.tenantless, carried(carrier, pullBody)))
          refused[`pull.apply:${carrier}`] = answerOf(await send(applyEntry, foreign.tenantless, carried(carrier, { ...pullBody, confirm: { dryRunToken: typeof liveToken === 'string' ? liveToken : 'tok_g9_u03_none' } })))
        }
        const unclaimedPuller = answerOf(await send(dryRunEntry, st.users.puller, carried('none', pullBody)))
        const afterClaimRefusals = await tenantRows()
        claimLeg = {
          ownDryRun: [answerOf(ownDry), status(ownDry), typeof liveToken],
          refusedNot403Required: Object.entries(refused).filter(([, answer]) => answer !== '403:OPERATOR_SCOPE_TENANT_REQUIRED').map(([key, answer]) => `${key}:${answer}`),
          refusedCalls: Object.keys(refused).length,
          unclaimedPuller,
          refusalsWrote: changedParts(beforeClaimRefusals, afterClaimRefusals),
          refusalsAudited: afterClaimRefusals.audits - beforeClaimRefusals.audits,
        }
      } finally {
        if (claimFlagBefore === undefined) delete process.env[TENANT_CLAIM_FLAG]
        else process.env[TENANT_CLAIM_FLAG] = claimFlagBefore
      }
      // (a) THEN flag OFF (the default): the tenantless integration:admin names THIS tenant on the query / params carrier of
      //     pull.dry-run — the legacy branch admits it, the governed preview runs and mints a token; the token of the
      //     later preview (params) APPLIES; the earlier one is superseded. Every write is accounted and pinned here.
      const afterClaimLeg = await tenantRows()
      const legacyTokens: Record<string, unknown> = {}
      const legacyDryRun: Record<string, unknown[]> = {}
      for (const carrier of legacyCarriers) {
        const res = await send(dryRunEntry, foreign.tenantless, carried(carrier, pullBody))
        legacyTokens[carrier] = tokenOf(res)
        legacyDryRun[carrier] = [answerOf(res), status(res), typeof tokenOf(res)]
        leakCheck(`tenantless:pull.dry-run:legacy-${carrier}`, res, realSent)
      }
      const afterLegacyDryRun = await tenantRows()
      const legacyApply: Record<string, unknown[]> = {}
      const mainBeforeApply = (await st.main()).count
      for (const carrier of ['params', 'query']) {
        const token = legacyTokens[carrier]
        const res = await send(applyEntry, foreign.tenantless, carried(carrier, { ...pullBody, confirm: { dryRunToken: typeof token === 'string' ? token : 'tok_g9_u03_none' } }))
        legacyApply[carrier] = [answerOf(res), status(res) ?? null, res.body && res.body.data && res.body.data.apply ? res.body.data.apply.written : null]
        leakCheck(`tenantless:pull.apply:legacy-${carrier}`, res, realSent)
      }
      const afterLegacyApply = await tenantRows()
      const legacy = {
        dryRun: legacyDryRun,
        dryRunWrote: changedParts(afterClaimLeg, afterLegacyDryRun),
        dryRunTokens: [afterClaimLeg.parts.stTokens, afterLegacyDryRun.parts.stTokens],
        dryRunAudits: afterLegacyDryRun.audits - afterClaimLeg.audits,
        apply: legacyApply,
        applyWrote: changedParts(afterLegacyDryRun, afterLegacyApply),
        applyRowsAdded: (await st.main()).count - mainBeforeApply,
        applyAudits: afterLegacyApply.audits - afterLegacyDryRun.audits,
      }
      console.log(`[G9-OWNER] ${LEGACY_TENANTLESS_ADMIN_ID} measured (pinned, NOT certified; ruled 2026-11-11 option A: the flag is a pilot-enable precondition, readiness v6) ${JSON.stringify({ legacy, claimLeg })}`)
      // Phase 2 — the callers at or above the tier are admitted (an inert request may still be a 4xx; never a 401 / 403).
      const admitted: Record<string, string[]> = {}
      for (const [name, user] of Object.entries(callers)) {
        for (const entry of drilled.filter((route: any) => user.rank >= route.rank)) {
          const res = await send(entry, user, inert())
          if (res.statusCode === 401 || res.statusCode === 403) (admitted[name] ||= []).push(`${entry.id}:${answerOf(res)}`)
        }
      }
      const belowTierNot403 = Object.entries(refusedAnswers).flatMap(([name, answers]) => Object.entries(answers).filter(([, code]) => code !== '403').map(([id, code]) => `${name}:${id}:${code}`))
      const foreign2xx = Object.entries(foreignAnswers).flatMap(([name, answers]) => Object.entries(answers).filter(([, code]) => Number(code.split(':')[0]) < 300).map(([id]) => `${name}:${id}`))
      const steered2xx = Object.entries(steering).flatMap(([name, answers]) => Object.entries(answers).filter(([, code]) => Number(code.split(':')[0]) < 300).map(([id]) => `${name}:${id}`))
      // The decision routes read the carriers (collectExplicitTenantIds): a carrier naming another tenant is refused AT
      // THE GATE (403) for every caller that holds a tenant, whatever the route.
      const steeredRefreshNot403 = Object.entries(steering).filter(([name]) => !name.startsWith('tenantless:')).flatMap(([name, answers]) => Object.entries(answers).filter(([id, code]) => id.startsWith('refresh.') && !code.startsWith('403:')).map(([id, code]) => `${name}:${id}:${code}`))
      console.log(`[G9-U03] own control ${JSON.stringify(ownControl)}`)
      console.log(`[G9-U03] foreign answers ${JSON.stringify(foreignAnswers)}`)
      console.log(`[G9-U03] steering answers ${JSON.stringify(steering)}`)
      // The listed body-validation stops, expanded per caller (the matrix list is exact both ways).
      const listedBodyStops = G9_MATRIX.u03BodyValidationStops.entries.flatMap((entry) => entry.callers.map((caller) => `${caller}:${entry.route}:${entry.leg}`))
      const decisionIds = ['refresh.confirm', 'refresh.end', 'refresh.changePlanConfirm', 'refresh.reviewComplete']
      const observed = {
        drilled: drilled.length,
        ownControl,
        belowTierNot403,
        tenantless2xx: foreign2xx.filter((entry) => entry.startsWith('tenantless:')),
        realVsBogus,
        steered2xx,
        steeredRefreshNot403,
        unlistedBodyStops: bodyStops.filter((stop) => !listedBodyStops.includes(stop)).sort(),
        listedBodyStopsNotSeen: listedBodyStops.filter((stop) => !bodyStops.includes(stop)).sort(),
        // The four decision routes that carry a real id: a cross-tenant caller's VALID body reaches the scoped read.
        decisionForeign: Object.fromEntries(['crossPuller', 'crossAdmin'].map((name) => [name, decisionIds.map((id) => foreignAnswers[name][id])])),
        leaks,
        refusalsWroteNothing: afterRefusals.fingerprint === before.fingerprint,
        refusalsAudited: afterRefusals.audits - before.audits,
        legacy,
        claimLeg,
        admittedRefused: admitted,
      }
      expect(observed).toEqual({
        drilled: Object.keys(EXPECTED_TIERS).length,
        // The ids are REAL: the owner reads the hold's evidence and the continuation; the recovery FINDS the (succeeded)
        // execution and refuses it as not unfinished; the review finds the plan and stops at the stale digest — never the
        // 404 a foreign caller must get.
        ownControl: {
          'refresh.evidence': '200:-',
          'refresh.continuation': '200:-',
          'refresh.recover': '409:STOCK_PREP_REFRESH_EXECUTION_NOT_UNFINISHED',
          'refresh.closeUnverified': '409:STOCK_PREP_REFRESH_EXECUTION_NOT_UNFINISHED',
          'refresh.reviewComplete': '409:STOCK_PREP_CHANGE_REVIEW_STALE',
          'projectTarget.censusRead': '200:-',
        },
        belowTierNot403: [],
        tenantless2xx: [],
        realVsBogus: [],
        steered2xx: [],
        steeredRefreshNot403: [],
        unlistedBodyStops: [],
        listedBodyStopsNotSeen: [],
        decisionForeign: {
          crossPuller: ['404:STOCK_PREP_REFRESH_HOLD_NOT_FOUND', '404:STOCK_PREP_CONTINUATION_NOT_FOUND', '409:STOCK_PREP_CHANGE_PLAN_STALE', '404:STOCK_PREP_CHANGE_PLAN_NOT_FOUND'],
          crossAdmin: ['404:STOCK_PREP_REFRESH_HOLD_NOT_FOUND', '404:STOCK_PREP_CONTINUATION_NOT_FOUND', '409:STOCK_PREP_CHANGE_PLAN_STALE', '404:STOCK_PREP_CHANGE_PLAN_NOT_FOUND'],
        },
        leaks: [],
        refusalsWroteNothing: true,
        refusalsAudited: 0,
        // G9-U03-LEGACY-TENANTLESS-ADMIN — THE MEASURED LEGACY OUTCOME, PINNED (pre-existing; ruled 2026-11-11, option A:
        // the path stays for non-pilot use while the flag is off; a pilot cannot be enabled until it is on): with
        // the flag off the tenantless admin's preview of THIS tenant mints tokens and moves the step-4 / lock rows; its
        // apply WRITES (written 1); the superseded token is refused. Any change to this outcome turns G9-U03 red.
        legacy: {
          dryRun: { query: ['200:-', 'ready', 'string'], params: ['200:-', 'ready', 'string'] },
          dryRunWrote: ['stepFour', 'lock', 'stTokens'],
          dryRunTokens: [1, 3],
          dryRunAudits: 0,
          apply: { params: ['200:-', 'succeeded', 1], query: ['409:STOCK_PREP_PROJECT_PLAN_SUPERSEDED', null, null] },
          applyWrote: ['stepFour', 'main', 'continuations', 'plans', 'stTokens'],
          applyRowsAdded: 0,
          applyAudits: 0,
        },
        // ... and with the flag exactly 'true' the same caller is refused on every carrier, nothing written.
        claimLeg: {
          ownDryRun: ['200:-', 'ready', 'string'],
          refusedNot403Required: [],
          refusedCalls: 8,
          unclaimedPuller: '403:OPERATOR_SCOPE_TENANT_REQUIRED',
          refusalsWrote: [],
          refusalsAudited: 0,
        },
        admittedRefused: {},
      })
      expect(drilled.length).toBeGreaterThanOrEqual(37)
      // The ok line certifies the drill, NOT the owner-gated legacy path (the [G9-OWNER] line above and the matrix item).
      const { legacy: _legacy, claimLeg: _claimLeg, ...certified } = observed
      g9Pass('G9-U03', { ...certified, ownerGatedPinned: LEGACY_TENANTLESS_ADMIN_ID, foreign2xx: foreign2xx.length, steeringCalls: Object.values(steering).reduce((n, answers) => n + Object.keys(answers).length, 0) })
      // G9-S65-U03 rides this drill: S6-5's four routes are in the tier oracle, the manifest equality and every leg above.
      const s65 = ['projectTarget.census', 'projectTarget.censusRead', 'projectTarget.remnantAcknowledge', 'projectTarget.remnantRevoke']
      expect(s65.every((id) => drilled.some((route: any) => route.id === id))).toBe(true)
      g9Pass('G9-S65-U03', { drilled: s65.length, foreign: Object.fromEntries(Object.entries(foreignAnswers).map(([name, answers]) => [name, s65.map((id) => answers[id])])) })
      // S6-6 (#6843): the three repair routes rode this drill with the repair switch OFF. Their tier legs are in the
      // equalities above (below stock-prep admin: 403, nothing written, no audit row; at the tier: admitted). Pinned
      // here: every caller at or above the tier — this tenant's own admin, the tenantless platform admin, the
      // cross-tenant admin; this tenant's real component handle or a bogus one; every steering carrier — is answered
      // the surface's own 404, and the cross-tenant puller 403. NOT the pending id G9-S66-U03 (the switch ON: the
      // tenant gate and the scoped reads behind it), which stays a todo below.
      const s66 = ['projectTarget.sheetRepair', 'projectTarget.sheetRepairFillsReport', 'projectTarget.sheetRepairRuns']
      const repairDisabled = `404:${sheetRepairLib.SHEET_REPAIR_ERROR_CODES.DISABLED}`
      const s66Routes = s66.map((id) => drilled.find((route: any) => route.id === id))
      expect(s66Routes.map((route: any) => (route ? route.rank : null))).toEqual([RANK.admin, RANK.admin, RANK.admin])
      const ownRepair: string[] = []
      for (const route of s66Routes) ownRepair.push(answerOf(await send(route, callers.spAdmin, validRequest(route, REAL))))
      const admittedForeign = ['tenantless', 'crossAdmin']
      const steeredOf = (names: string[]) => Object.entries(steering).filter(([key]) => names.includes(key.split(':')[0])).flatMap(([, answers]) => s66.map((id) => answers[id]).filter((answer) => answer !== undefined))
      expect({
        belowTier: ['reader', 'operator', 'puller'].map((name) => s66.map((id) => refusedAnswers[name][id])),
        ownAdmin: ownRepair,
        foreign: admittedForeign.map((name) => s66.map((id) => foreignAnswers[name][id])),
        // Per admitted foreign caller: the POST on three carriers (query, params, body), each GET on two.
        steered: [steeredOf(admittedForeign).length, Array.from(new Set(steeredOf(admittedForeign)))],
        crossPuller: Array.from(new Set([...s66.map((id) => foreignAnswers.crossPuller[id]), ...steeredOf(['crossPuller'])].map((answer) => answer.split(':')[0]))),
      }).toEqual({
        belowTier: [['403', '403', '403'], ['403', '403', '403'], ['403', '403', '403']],
        ownAdmin: [repairDisabled, repairDisabled, repairDisabled],
        foreign: [[repairDisabled, repairDisabled, repairDisabled], [repairDisabled, repairDisabled, repairDisabled]],
        steered: [14, [repairDisabled]],
        crossPuller: ['403'],
      })
    }, 900000)

    // ── G9-S9X-01: the MVP archive identity across the 批次标识 install + backfill ──────────────────────────────────────
    g9Case('G9-S9X-01', '(C-8, RD G2, E10 clause 3) on an unchanged GOVERNED pilot sheet: the archive before the 批次标识 install, then the REAL install with its history backfill, then the archive again with the switch ON and OFF — the same default snapshotBatchId and syncRunId (both from buildArchiveRevision): the archive replays the kept batch, never a second one', async () => {
      const ledgerStore = pullBatchStoreLib.createStockPreparationPullBatchStore({ db: createDb({ database: createProductionPluginContext().api.database }) })
      const st = await s3aStack('g9_s9x', { pilot: true, serviceExtras: { stockPreparationPullBatchStore: ledgerStore } })
      tenants.push(st.tenantId)
      await provisionMvp(st)
      await firstPullApplied(st)
      const settled = await st.dryRun()
      expect(status(settled)).toBe('ready')
      // The archive's batch / run rows: the snapshot sheets of the staging project, read back by their field ids.
      const persisted = async () => {
        const out: Record<string, string[]> = {}
        for (const template of templatesLib.STOCK_PREPARATION_MVP_TABLE_TEMPLATES) {
          const sheet = await st.multitable.provisioning.findObjectSheet({ projectId: st.projectId, objectId: template.objectId }).catch(() => null)
          if (!sheet || !sheet.id) continue
          const ids: string[] = []
          for (const logical of ['snapshotBatchId', 'syncRunId']) {
            if (!template.fields.some((field: any) => field.id === logical)) continue
            const fieldId = st.multitable.provisioning.getFieldId(st.projectId, template.objectId, logical)
            for (const row of (await q('SELECT data FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheet.id])).rows) {
              const value = row.data && row.data[fieldId]
              if (typeof value === 'string') ids.push(`${logical}:${nodeCrypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`)
            }
          }
          out[template.objectId] = [...new Set(ids)].sort()
        }
        return out
      }
      const archive = async (pull: boolean) => {
        const res = await both(pull, () => st.mvpPersist())
        return [res.statusCode, res.body.data && res.body.data.status, codeOf(res)]
      }
      const first = await archive(false)
      const idsBefore = await persisted()
      const { installed } = await installBand(st, st.users.admin)
      const sheet = (await q('SELECT history_status, history_batch_count FROM integration_stock_prep_pull_batch_sheet WHERE tenant_id = $1', [st.tenantId])).rows[0]
      const afterOn = await archive(true)
      const idsOn = await persisted()
      const afterOff = await archive(false)
      const idsOff = await persisted()
      const observed = {
        first,
        install: [installed.resolved, installed.historyStatus, sheet.history_status, Number(sheet.history_batch_count) >= 1],
        afterOn,
        afterOff,
        idsPresent: Object.values(idsBefore).some((ids) => ids.length > 0),
        sameIdsSwitchOn: sameJson(idsOn, idsBefore),
        sameIdsSwitchOff: sameJson(idsOff, idsBefore),
      }
      expect(observed).toEqual({
        first: [201, 'created', null],
        install: [true, 'backfilled', 'backfilled', true],
        afterOn: [200, 'skipped_existing', null],
        afterOff: [200, 'skipped_existing', null],
        idsPresent: true,
        sameIdsSwitchOn: true,
        sameIdsSwitchOff: true,
      })
      g9Pass('G9-S9X-01', observed)
    })

    // ── G9-U07: the rollback drill, CI half ─────────────────────────────────────────────────────────────────────────
    g9Case('G9-U07', '(U07, §7.5 + B-22) artifacts made through the REAL routes — an unfinished execution, a puller close not yet settled, a change plan left confirmed, a recovery-written plan — each make their stop-condition query non-zero (the 106 one parsed out of the migration 106 header); the current build refuses the export while they do; every query is zero once the artifacts are settled', async () => {
      const header = fs.readFileSync(MIGRATION_106, 'utf8').replace(/\r\n/g, '\n').split('\n')
      const first = header.findIndex((line) => /^--\s+SELECT count\(\*\) FROM integration_stock_prep_refresh_state s\s*$/.test(line))
      const last = header.findIndex((line, index) => index > first && /\)\);\s*$/.test(line))
      expect([first > 0, last > first]).toEqual([true, true])
      const stop106 = header.slice(first, last + 1).map((line) => line.replace(/^--\s?/, '')).join('\n').replace(/;\s*$/, '')
      const stops = async (st: any) => ({
        unfinished: Number((await q(`SELECT count(*)::int AS n FROM ${RT.execution} WHERE tenant_id = $1 AND sheet_id = $2 AND status IN ('running', 'partial', 'failed', 'aborted')`, [st.tenantId, st.sheetId])).rows[0].n),
        unsettled106: Number((await q(`${stop106} AND s.tenant_id = $1 AND s.sheet_id = $2`, [st.tenantId, st.sheetId])).rows[0].count),
        pendingPlans: Number((await q(`SELECT count(*)::int AS n FROM ${RT.changePlan} WHERE tenant_id = $1 AND sheet_id = $2 AND status IN ('confirmed', 'written')`, [st.tenantId, st.sheetId])).rows[0].n),
        recoveredPlans: Number((await q(`SELECT count(*)::int AS n FROM ${RT.changePlan} WHERE tenant_id = $1 AND sheet_id = $2 AND recovered_from_change_plan_id IS NOT NULL AND status IN ('confirmed', 'written')`, [st.tenantId, st.sheetId])).rows[0].n),
      })
      const exportAnswer = async (st: any) => { const res = await both(false, () => st.exportLines()); return res.statusCode === 200 ? 'exported' : `${res.statusCode}` }
      // (1) an unfinished execution, then its puller close not yet settled (E06 on a first pull).
      const one = hostHook()
      const a = await s3aStack('g9_u07a', { pilot: true, routeMultitable: one.wrap })
      one.hook.failCreates = 1
      const dryA = await a.dryRun()
      await a.apply(a.users.puller, dryA.body.data.dryRunToken)
      const stopUnfinished = await stops(a)
      const exportUnfinished = await exportAnswer(a)
      const partialA = (await a.executions()).filter((row: any) => row.status === 'partial')
      await verifyAndClose(a, partialA[0].id, false)
      const stopClosed = await stops(a)
      const exportClosed = await exportAnswer(a)
      const retryA = await a.dryRun()
      await a.apply(a.users.puller, retryA.body.data.dryRunToken)
      await a.dryRun()
      const stopSettledA = await stops(a)
      // (2) a change plan left confirmed, then a plan-bound partial write recovered into a recovery-written plan (P7).
      const two = hostHook()
      const b = await s3aStack('g9_u07b', { pilot: true, routeMultitable: two.wrap })
      await firstPullApplied(b)
      b.state.data = sourceWith({ partCUsage: 5 })
      expect(status(await b.dryRun())).toBe('suspended')
      const { body } = await boundBody(b)
      const cp = await withSwitch(() => cpCall(b, 'POST', CPR.confirm, { body }))
      expect(cp.statusCode, JSON.stringify(cp.body)).toBe(201)
      const stopConfirmed = await stops(b)
      const exportConfirmed = await exportAnswer(b)
      const replan = await b.dryRun()
      two.hook.failPatches = 1
      await b.apply(b.users.puller, replan.body.data.dryRunToken)
      const partialB = (await b.executions()).filter((row: any) => row.status === 'partial')
      await verifyAndClose(b, partialB[0].id, false)
      const rw = (await plansOf(b)).filter((plan: any) => plan.recovered_from_change_plan_id === cp.body.data.changePlanId)
      const stopRecovered = await stops(b)
      const exportRecovered = await exportAnswer(b)
      const observed = {
        unfinished: [stopUnfinished.unfinished, exportUnfinished],
        closedNotSettled: [stopClosed.unfinished, stopClosed.unsettled106, exportClosed],
        settledA: stopSettledA,
        confirmed: [stopConfirmed.pendingPlans, exportConfirmed],
        recoveredWritten: [rw.length, stopRecovered.recoveredPlans, stopRecovered.pendingPlans >= 1, exportRecovered],
      }
      expect(observed).toEqual({
        unfinished: [1, '409'],
        closedNotSettled: [0, 1, '409'],
        settledA: { unfinished: 0, unsettled106: 0, pendingPlans: 0, recoveredPlans: 0 },
        confirmed: [1, '409'],
        recoveredWritten: [1, 1, true, '409'],
      })
      g9Pass('G9-U07', observed)
    }, 600000)

    // ── G9-PE: the positive pilot-enable leg ────────────────────────────────────────────────────────────────────────
    // The fully prepared synthetic sheet (shared by G9-PE and G9-S65-V5): two switch-off pulls, the band installed by the
    // REAL install route with its history backfilled, the recovery store, the pack ledger and (readiness v5, S6-5) the
    // component ruling ledger wired.
    async function preparedPilotSheet(label: string) {
      const ledgerStore = pullBatchStoreLib.createStockPreparationPullBatchStore({ db: createDb({ database: createProductionPluginContext().api.database }) })
      const repairStore = sheetRepairStoreLib.createStockPreparationSheetRepairStore({ db: createDb({ database: createProductionPluginContext().api.database }) })
      const st = await s3aStack(label, {
        pilot: false,
        serviceExtras: {
          stockPreparationPullBatchStore: ledgerStore,
          stockPreparationPackInstallStore: packInstallStoreLib.createStockPreparationPackInstallStore({ db: createDb({ database: createProductionPluginContext().api.database }) }),
          stockPreparationComponentRulingStore: rulingStore(),
          // Readiness v7 (S6-5b): the real sheet-repair ledger (migration 108).
          stockPreparationSheetRepairStore: repairStore,
        },
        routeConfigExtras: { stockPreparationPilot: { specReadPlanSlot: 'not_applicable', customerPack: 'not_applicable' } },
      })
      tenants.push(st.tenantId)
      // Two switch-off pulls with NO restructuring (the second adds a root, inactivates nothing): two inferred batches.
      await both(false, async () => {
        st.state.data = CF.firstPullSource()
        await firstPullApplied(st)
        st.state.data = CF.project({ orders: [{ part: 'S-001', qty: 10 }, { part: 'N-001', qty: 1 }], parts: CF.PARTS.slice(), boms: { 'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }], 'PART-A': [{ part: 'PART-C', usage: 4 }] } })
        const dry = await st.dryRun()
        expect((await st.apply(st.users.puller, dry.body.data.dryRunToken)).statusCode).toBe(200)
      })
      const { installed } = await installBand(st, st.users.admin)
      expect(installed).toMatchObject({ resolved: true, historyStatus: 'backfilled' })
      const spAdmin = { id: `u_g9_pe_${TOKEN}`, tenantId: st.tenantId, permissions: [access.STOCK_PREP_ADMIN] }
      // Readiness v6: the pilot calls carry the VERIFIED tenant claim (req.authenticatedTenantId, which the kit's callRoute
      // drops) — what a tenant-bound admin token sends once the tenant-claim door is on.
      const claimedPilotCall = (method: string, body?: any) => both(true, async () => {
        const handler = st.routes.get(`${method} ${PILOT_PATH}`)
        if (!handler) throw new Error(`route ${method} ${PILOT_PATH} is not registered`)
        const res: any = { statusCode: 200, headers: {}, body: undefined }
        res.status = (code: number) => { res.statusCode = code; return res }
        res.json = (payload: unknown) => { res.body = payload; return res }
        res.setHeader = (name: string, value: unknown) => { res.headers[name] = value; return res }
        res.send = (payload: unknown) => { res.body = payload; return res }
        res.end = () => res
        await handler({ user: spAdmin, params: { projectNo: st.projectNo }, query: {}, body: body || {}, authenticatedTenantId: st.tenantId }, res)
        return res
      })
      const read = () => claimedPilotCall('GET')
      const enable = () => claimedPilotCall('POST', { confirmProjectNo: st.projectNo })
      const registry = async () => (await q('SELECT pilot_enabled_at IS NOT NULL AS enabled, pilot_readiness_version FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2', [st.tenantId, st.projectNo])).rows[0]
      return { st, spAdmin, read, enable, registry, repairStore }
    }

    // Readiness v6 (owner ruling 2026-11-11, R-91 option A): the tenant-claim door for one block, restored in finally
    // (`null` = absent, the default).
    const withTenantClaim = async <T>(value: string | null, fn: () => Promise<T>): Promise<T> => {
      const before = process.env[TENANT_CLAIM_FLAG]
      if (value === null) delete process.env[TENANT_CLAIM_FLAG]
      else process.env[TENANT_CLAIM_FLAG] = value
      try {
        return await fn()
      } finally {
        if (before === undefined) delete process.env[TENANT_CLAIM_FLAG]
        else process.env[TENANT_CLAIM_FLAG] = before
      }
    }

    g9Case('G9-PE', '(§9.2, B-21) a FULLY prepared synthetic sheet — the band installed by the REAL install route with its history backfilled (resolved), views live, the 批次标识 switch ON, the recovery store and the component ruling ledger wired, the tenant-claim flag HELD ON (readiness v6, owner ruling 2026-11-11 option A): with the marker at 0 `continuation_support_version` is the ONLY failing id (readiness v5\'s no_unacknowledged_inactive_root_remnant passes) and the enable is 409 with nothing done; NEGATIVE LEG — the marker 1 IN MEMORY and the flag OFF: `tenant_claim_required` is the ONLY failing id and the enable is 409 with nothing done; with the marker 1 and the flag ON (both restored in finally) the readiness is green and the enable 200 stamps the current PILOT_READINESS_VERSION', async () => {
      const { st, read, enable, registry } = await preparedPilotSheet('g9_pe')
      const gen0 = await st.generation()
      const { atZero, refused } = await withTenantClaim('true', async () => ({ atZero: await read(), refused: await enable() }))
      const genAfterRefusal = await st.generation()
      const registryAfterRefusal = await registry()
      const markerBefore = continuationSupport.CONTINUATION_SUPPORT_VERSION
      expect(markerBefore).toBe(0)
      let flagOffAtOne: any
      let flagOffRefused: any
      let genAfterFlagOffRefusal: any
      let registryAfterFlagOffRefusal: any
      let atOne: any
      let enabled: any
      continuationSupport.CONTINUATION_SUPPORT_VERSION = 1
      try {
        // The NEGATIVE leg FIRST: the enable is set-once, so it must be refused before the positive enable lands.
        ;({ flagOffAtOne, flagOffRefused } = await withTenantClaim(null, async () => ({ flagOffAtOne: await read(), flagOffRefused: await enable() })))
        genAfterFlagOffRefusal = await st.generation()
        registryAfterFlagOffRefusal = await registry()
        ;({ atOne, enabled } = await withTenantClaim('true', async () => ({ atOne: await read(), enabled: await enable() })))
      } finally {
        continuationSupport.CONTINUATION_SUPPORT_VERSION = markerBefore
      }
      const observed = {
        version: atZero.body.data.readiness.version,
        checkIds: atZero.body.data.readiness.checks.map((check: any) => check.id),
        failingAtZero: atZero.body.data.readiness.failing,
        refused: [refused.statusCode, codeOf(refused)],
        refusalDidNothing: sameJson(genAfterRefusal, gen0) && registryAfterRefusal.enabled === false,
        flagOffFailingAtOne: flagOffAtOne.body.data.readiness.failing,
        flagOffMayEnable: flagOffAtOne.body.data.may,
        flagOffRefused: [flagOffRefused.statusCode, codeOf(flagOffRefused), flagOffRefused.body.error && flagOffRefused.body.error.details ? JSON.parse(JSON.stringify(flagOffRefused.body.error.details)).failing : null],
        flagOffRefusalDidNothing: sameJson(genAfterFlagOffRefusal, gen0) && registryAfterFlagOffRefusal.enabled === false,
        failingAtOne: atOne.body.data.readiness.failing,
        enabled: [enabled.statusCode, enabled.body.data && enabled.body.data.enabled],
        registry: await registry(),
        markerRestored: continuationSupport.CONTINUATION_SUPPORT_VERSION,
        flagRestored: process.env[TENANT_CLAIM_FLAG] === TENANT_CLAIM_FLAG_AT_LOAD,
      }
      expect(observed).toEqual({
        version: readinessLib.PILOT_READINESS_VERSION,
        checkIds: [...readinessLib.PILOT_READINESS_CHECK_IDS],
        failingAtZero: ['continuation_support_version'],
        refused: [409, readinessLib.PILOT_READINESS_CHECK_IDS.length ? 'STOCK_PREP_PILOT_NOT_READY' : null],
        refusalDidNothing: true,
        flagOffFailingAtOne: ['tenant_claim_required'],
        flagOffMayEnable: { enable: false },
        flagOffRefused: [409, 'STOCK_PREP_PILOT_NOT_READY', ['tenant_claim_required']],
        flagOffRefusalDidNothing: true,
        failingAtOne: [],
        enabled: [200, true],
        registry: { enabled: true, pilot_readiness_version: readinessLib.PILOT_READINESS_VERSION },
        markerRestored: 0,
        flagRestored: true,
      })
      // Readiness v7 (S6-5b, R-91): the version and the new id, just before the marker; the prepared sheet's real repair
      // ledger (migration 108) answered no open run, so no_open_sheet_repair_run passed on every leg above.
      expect([readinessLib.PILOT_READINESS_VERSION, readinessLib.PILOT_READINESS_CHECK_IDS.slice(-2)]).toEqual([7, ['no_open_sheet_repair_run', 'continuation_support_version']])
      g9Pass('G9-PE', observed)
    })

    // ── G9-S65-V5: readiness v5's remnant check on the prepared sheet (S6-5, #6842) ─────────────────────────────────────
    g9Case('G9-S65-V5', '(S6-5 readiness v5, §9.5) on the G9-PE prepared sheet, the tenant-claim flag at its default OFF (so readiness v6\'s tenant_claim_required fails beside the marker throughout): the v5 check no_unacknowledged_inactive_root_remnant is in the readiness and passes; an inactive-root remnant (PART-A\'s old ROOT row inactive while PART-A stays active under S-001) fails ONLY that id beyond the marker, the project census lists exactly its handle, the acknowledgement through the REAL route lifts exactly that check (back to G9-PE\'s marker-0 answer) and the revoke restores it; the enable stays 409 and the registry unmarked throughout', async () => {
      const { st, spAdmin, read, enable, registry } = await preparedPilotSheet('g9_v5')
      const failing = async () => {
        const res = await read()
        expect(res.statusCode, JSON.stringify(res.body)).toBe(200)
        return res.body.data.readiness.failing as string[]
      }
      const inOrder = (...ids: string[]) => readinessLib.PILOT_READINESS_CHECK_IDS.filter((id: string) => ids.includes(id))
      const prepared = await failing()
      const rows0 = (await st.main()).count
      await seedInactiveRootRemnant(st, 'PART-A')
      const withRemnant = await failing()
      const census = await censusRead(st, spAdmin)
      expect(census.statusCode, JSON.stringify(census.body)).toBe(200)
      const components = census.body.data.components as Array<{ componentHandle: string; acknowledgement: unknown }>
      const handle = sheetCensusLib.__internals.componentHandle(st.tenantId, st.projectNo, 'PART-A')
      const refusedWithRemnant = await enable()
      const acknowledged = await acknowledgeRemnant(st, spAdmin, handle)
      expect(acknowledged.statusCode, JSON.stringify(acknowledged.body)).toBe(201)
      const afterAcknowledge = await failing()
      const ledger = (await q(`SELECT kind, status, component_digest = $2 AS same_handle FROM ${RULING_TABLE} WHERE tenant_id = $1 ORDER BY id`, [st.tenantId, handle])).rows
      const revoked = await revokeRemnant(st, spAdmin, acknowledged.body.data.acknowledgementId)
      const afterRevoke = await failing()
      const refusedAfterRevoke = await enable()
      const observed = {
        v5CheckPresent: readinessLib.PILOT_READINESS_CHECK_IDS.includes('no_unacknowledged_inactive_root_remnant'),
        version: readinessLib.PILOT_READINESS_VERSION,
        prepared,
        withRemnant,
        censusComponents: components.map((entry) => [entry.componentHandle === handle, entry.acknowledgement === null]),
        refusedWithRemnant: [refusedWithRemnant.statusCode, codeOf(refusedWithRemnant)],
        afterAcknowledge,
        ledger,
        revoke: [revoked.statusCode, revoked.body.data && revoked.body.data.status],
        afterRevoke,
        refusedAfterRevoke: [refusedAfterRevoke.statusCode, codeOf(refusedAfterRevoke)],
        rowsAdded: (await st.main()).count - rows0,
        registry: await registry(),
      }
      expect(observed).toEqual({
        v5CheckPresent: true,
        version: readinessLib.PILOT_READINESS_VERSION,
        prepared: inOrder('tenant_claim_required', 'continuation_support_version'),
        withRemnant: inOrder('no_unacknowledged_inactive_root_remnant', 'tenant_claim_required', 'continuation_support_version'),
        censusComponents: [[true, true]],
        refusedWithRemnant: [409, 'STOCK_PREP_PILOT_NOT_READY'],
        afterAcknowledge: inOrder('tenant_claim_required', 'continuation_support_version'),
        ledger: [{ kind: 'remnant_acknowledged', status: 'active', same_handle: true }],
        revoke: [200, 'revoked'],
        afterRevoke: inOrder('no_unacknowledged_inactive_root_remnant', 'tenant_claim_required', 'continuation_support_version'),
        refusedAfterRevoke: [409, 'STOCK_PREP_PILOT_NOT_READY'],
        rowsAdded: 1,
        registry: { enabled: false, pilot_readiness_version: null },
      })
      // Values-free evidence: the check ids and booleans, never the handle.
      g9Pass('G9-S65-V5', { ...observed, censusComponents: observed.censusComponents.length, ledger: ledger.length })
    })

    // ── G9-S65B-V7: readiness v7's open-run check on the prepared sheet (S6-5b) ─────────────────────────────────────────
    g9Case('G9-S65B-V7', '(S6-5b readiness v7) on a G9-PE prepared sheet, the marker 1 IN MEMORY and the tenant-claim flag ON (both restored in finally): a repair run begun by the REAL ledger under a REAL sheet_repair lease and left running (its lease released) fails ONLY no_open_sheet_repair_run and the enable is 409 with exactly that id and nothing done; closed by the ledger\'s verified close under a NEW lease, the readiness is green and the enable 200 stamps PILOT_READINESS_VERSION', async () => {
      const { st, read, enable, registry, repairStore } = await preparedPilotSheet('g9_v7')
      const RT_RUN: string = sheetRepairStoreLib.SHEET_REPAIR_TABLES.run
      const openRuns = async () => Number((await q(`SELECT count(*)::int AS n FROM ${RT_RUN} WHERE sheet_id = $1 AND status = 'running'`, [st.sheetId])).rows[0].n)
      const noAudit = async () => {}
      // A lease of the repair's own purpose, with the holder assert the repair routes hand the ledger.
      const leaseFor = async (runId: string) => {
        const grant = await st.lock.acquire(st.key, { purpose: 'sheet_repair', runId, tenantId: st.tenantId })
        const guard = st.lock.createGuard(grant)
        return {
          grant,
          guard,
          lease: { leaseId: grant.leaseId, fencingEpoch: grant.fencingEpoch },
          holderWithin: (trx: any) => st.lock.assertHolderWithin(trx, st.key, { leaseId: grant.leaseId, fencingEpoch: grant.fencingEpoch, reason: 'sheet_repair' }),
        }
      }
      const runId = `sheet-repair:${nodeCrypto.randomUUID()}`
      const markerBefore = continuationSupport.CONTINUATION_SUPPORT_VERSION
      expect(markerBefore).toBe(0)
      let observed: any
      continuationSupport.CONTINUATION_SUPPORT_VERSION = 1
      try {
        observed = await withTenantClaim('true', async () => {
          const prepared = (await read()).body.data.readiness.failing
          // The run: begun under one lease, the lease released before its finish (what a takeover or a failed finish leaves).
          const first = await leaseFor(`syn-g9-v7-begin-${TOKEN}`)
          const begun = await repairStore.beginRun({
            tenantId: st.tenantId, sheetId: st.sheetId, projectNo: st.projectNo, runId, writeScopeKey: st.key,
            recipe: sheetRepairLib.SHEET_REPAIR_RECIPES[0], planDigest: 'a'.repeat(64), approvalRef: 'R-91:g9-v7', componentHandle: 'b'.repeat(24),
            backup: [['rec_g9_v7_syn_1', 1, true, null, null, null]], plannedCount: 1, expectSequence: 0,
            lease: first.lease, startedBy: 'u_g9_v7', holderWithin: first.holderWithin, auditWithin: noAudit,
          })
          await first.guard.release()
          const openAfterBegin = await openRuns()
          const gen0 = await st.generation()
          const withOpen = await read()
          const refused = await enable()
          const genAfterRefusal = await st.generation()
          const registryAfterRefusal = await registry()
          // The verified close (the continuation's ledger step) under a NEW lease: completed, no open run left.
          const second = await leaseFor(`syn-g9-v7-close-${TOKEN}`)
          const closed = await repairStore.closeVerifiedRun({
            tenantId: st.tenantId, sheetId: st.sheetId, projectNo: st.projectNo, runId, approvalRef: 'R-91:g9-v7-close', closeDigest: 'c'.repeat(64),
            verifiedCount: 1, versionMoved: 0, governed: false, lease: second.lease, holderWithin: second.holderWithin, auditWithin: noAudit,
          })
          await second.guard.release()
          const afterClose = await read()
          const enabled = await enable()
          return {
            prepared,
            begun: [begun.runId === runId, begun.sequence],
            openAfterBegin,
            failingWithOpen: withOpen.body.data.readiness.failing,
            mayWithOpen: withOpen.body.data.may,
            refused: [refused.statusCode, codeOf(refused), refused.body.error && refused.body.error.details ? JSON.parse(JSON.stringify(refused.body.error.details)).failing : null],
            refusalDidNothing: sameJson(genAfterRefusal, gen0) && registryAfterRefusal.enabled === false,
            closed: [closed.status, closed.planned, closed.verified],
            openAfterClose: await openRuns(),
            failingAfterClose: afterClose.body.data.readiness.failing,
            enabled: [enabled.statusCode, enabled.body.data && enabled.body.data.enabled],
            registry: await registry(),
          }
        })
      } finally {
        continuationSupport.CONTINUATION_SUPPORT_VERSION = markerBefore
      }
      expect({ ...observed, markerRestored: continuationSupport.CONTINUATION_SUPPORT_VERSION, flagRestored: process.env[TENANT_CLAIM_FLAG] === TENANT_CLAIM_FLAG_AT_LOAD }).toEqual({
        prepared: [],
        begun: [true, 0],
        openAfterBegin: 1,
        failingWithOpen: ['no_open_sheet_repair_run'],
        mayWithOpen: { enable: false },
        refused: [409, 'STOCK_PREP_PILOT_NOT_READY', ['no_open_sheet_repair_run']],
        refusalDidNothing: true,
        closed: ['completed', 1, 1],
        openAfterClose: 0,
        failingAfterClose: [],
        enabled: [200, true],
        registry: { enabled: true, pilot_readiness_version: readinessLib.PILOT_READINESS_VERSION },
        markerRestored: 0,
        flagRestored: true,
      })
      expect(readinessLib.PILOT_READINESS_VERSION).toBe(7)
      g9Pass('G9-S65B-V7', observed)
    })

    // ── extension points for the PRs still in flight (the matrix file's `pending` list) ─────────────────────────────
    for (const entry of G9_MATRIX.pending) test.todo(`${entry.id} (${entry.owner}) ${entry.what}`)
  })

}

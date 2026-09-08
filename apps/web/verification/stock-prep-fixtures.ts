// 备料工作台 browser-verification FIXTURES — the synthetic world the real components render against.
//
// WHY A ROUTE TABLE RATHER THAN A MODULE MOCK. The whole point of this lane is that the PRODUCTION
// components, the production services and the production `apiFetch` all run unmodified; the only
// thing swapped out is the network. So every response below is shaped exactly the way the plugin's
// own routes shape theirs (`{ ok, data }` envelopes for the integration routes, a BARE object for the
// platform app-catalog route — see installPlan.ts's own note on that asymmetry), and the components
// parse them with their own parsers.
//
// VALUES-FREE, AND SYNTHETIC ON PURPOSE. Nothing here is customer data or is derived from it:
// project numbers are `SYN-PROJ-000n`, names are 「示例项目 A/B」, part-shaped strings are
// `SYN-PART-*`, the tenant is `syn-tenant`, and no host, IP, mailbox, token or credential appears in
// any payload. A spec that asserts a copied-to-clipboard string is values-free can therefore assert
// it against THIS vocabulary and mean it.
//
// AN UNMOCKED ROUTE IS A FAILURE, NOT A FALLTHROUGH. The catch-all answers 404
// `VERIFY_UNMOCKED_ROUTE` and records the path, so a component that grows a new read shows up as a
// visible refusal in the spec that owns it rather than as a silent hit against the Vite dev-server's
// `/api` proxy (which would 502/ECONNREFUSED and look like an unrelated flake).
import type { Page, Route } from '@playwright/test'

// ---------------------------------------------------------------------------
// The synthetic vocabulary. Every business-shaped string in this file is one of these.
// ---------------------------------------------------------------------------

export const SYN_TENANT_ID = 'syn-tenant'
export const SYN_PROJECT_A = 'SYN-PROJ-0001'
export const SYN_PROJECT_B = 'SYN-PROJ-0002'
export const SYN_PROJECT_A_NAME = '示例项目 A'
export const SYN_PROJECT_B_NAME = '示例项目 B'
export const SYN_DECISION_ID = 'syn-decision-0001'
export const SYN_FINGERPRINT = 'synfingerprint0001'

/**
 * The five fixture worlds.
 *
 *   fresh        —— 未装完. Preflight NOT ready with exactly one `http` blocker and one `env`
 *                   blocker (the pair I-8/I-9 splits on), a provisioned project directory whose
 *                   confirmation LEDGER is missing (the `ledger_missing` dead end P0-4 closes).
 *   ready        —— 装完. Preflight ready, two projects, one of them carrying three pending
 *                   decisions, a board with missing components, and audit rows to read back.
 *   readerOnly   —— the values-free `stock-prep:read` queue watcher's world: the directory read is
 *                   refused the way the server refuses a principal with no tenant of its own.
 *   defaults500  —— the manifest/defaults read 500s. Everything else answers, so the spec can tell
 *                   「这一页读不到清单」 apart from 「整页坏了」.
 *   noProjects   —— 装完, but the operator's directory is empty: the `no_projects` home empty state.
 */
export type StockPrepScenario = 'fresh' | 'ready' | 'readerOnly' | 'defaults500' | 'noProjects'

export interface StockPrepRouteOptions {
  /**
   * `/api/admin/roles` is `requiresAdmin` server-side (F10), so the wizard's step ⑤ reads it and gets
   * a 403 for a `stock-prep:admin` holder. 'forbidden' is that account's world; 'ok' is a platform
   * administrator's. Separate from the scenario because it is a fact about the PRINCIPAL, not about
   * how far the deployment got.
   */
  roleCatalog?: 'ok' | 'forbidden'
  /** The source preflight's verdict when the wizard's 「检查这个源」 is pressed. */
  sourceVerdict?: 'go' | 'no-go'
}

export interface StockPrepApiCall {
  method: string
  path: string
  search: string
  url: string
}

export interface StockPrepRouteLog {
  /** Every `/api/**` request the page issued, in order. */
  calls: StockPrepApiCall[]
  /** `METHOD /path` for every request no responder claimed. Must stay empty in a passing spec. */
  unmocked: string[]
  /** How many times a path ENDING in `suffix` was requested with this method. */
  count(method: string, suffix: string): number
  /** Every full URL whose path ends in `suffix`, in order — for query-string assertions. */
  urls(suffix: string): string[]
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function envelope(data: unknown): string {
  return JSON.stringify({ ok: true, data })
}

function refusal(code: string, reason?: string): string {
  return JSON.stringify({ ok: false, error: { code, details: reason ? { reason } : undefined } })
}

function synManifest(): Record<string, unknown> {
  return {
    id: 'stock-preparation',
    displayName: '备料工作台(合成夹具)',
    version: '0.0.0-synthetic',
    valueStatement: '合成验收数据 —— 不含任何真实部署或客户信息。',
    permissions: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin'],
    permissionPolicy: {
      automaticHolders: [],
      note: '合成夹具:装好之后不会自动授予任何人。',
    },
    objects: [
      {
        id: 'syn_main',
        name: '备料主表(合成)',
        displayNames: { 'zh-CN': '备料主表(合成)', en: 'Synthetic prep main table' },
        objectIdPolicy: 'fixed',
        objectId: 'plm_stock_preparation_main',
        objectIdNamespace: 'plm_stock_preparation',
        columnCount: 7,
        ensure: {
          idempotent: true,
          method: 'POST',
          path: '/api/integration/stock-preparation/target/ensure',
          permission: 'admin',
        },
        note: '合成对象,仅供浏览器验收使用。',
      },
      {
        id: 'syn_ledger',
        name: '确认账本(合成)',
        displayNames: { 'zh-CN': '确认账本(合成)', en: 'Synthetic confirmation ledger' },
        objectIdPolicy: 'fixed',
        objectId: 'plm_stock_preparation_decisions',
        objectIdNamespace: 'plm_stock_preparation',
        columnCount: 11,
        ensure: {
          idempotent: true,
          method: 'POST',
          path: '/api/integration/stock-preparation/confirmation-decisions/ensure',
          permission: 'admin',
        },
        note: '合成对象,仅供浏览器验收使用。',
      },
    ],
    configSurfaces: [
      {
        id: 'syn_customer_pack_file',
        name: '客户列清单文件(合成)',
        kind: 'deployment-data-file',
        envVar: 'STOCK_PREPARATION_CUSTOMER_PACK_FILE',
        committed: false,
        note: '合成夹具:这类内容只放在部署机上,本页没有也不应该有输入框。',
      },
    ],
    posture: {
      mode: 'synthetic',
      installerMayModify: false,
      note: '合成夹具:四条硬边界全部关闭。',
      entries: [
        { id: 'syn_fence_write', expectedState: 'off', what: '合成边界:对外写入' },
        { id: 'syn_fence_sql', expectedState: 'off', what: '合成边界:原始 SQL 入口' },
      ],
    },
    acceptance: {
      verifiedBy: { script: 'scripts/ops/synthetic-acceptance.mjs', note: '合成脚本名,不存在于仓库。' },
      criteria: [
        { id: 'SYN-01', statement: '合成验收条目一。' },
        { id: 'SYN-02', statement: '合成验收条目二。' },
      ],
    },
  }
}

/** The `http` blocker — the one the wizard's own 「开始安装」 can supply (I-8). */
const SYN_HTTP_BLOCKER = Object.freeze({
  code: 'STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY',
  what: 'confirmation ledger object is not provisioned',
  fix: Object.freeze({
    kind: 'http' as const,
    run: 'POST /api/integration/stock-preparation/confirmation-decisions/ensure',
    method: 'POST',
    path: '/api/integration/stock-preparation/confirmation-decisions/ensure',
  }),
})

/** The `env` blocker — deployment-machine data, so NO fix button may exist for it (I-9). */
const SYN_ENV_BLOCKER = Object.freeze({
  code: 'STOCK_PREP_CUSTOMER_PACK_NOT_CONFIGURED',
  what: 'customer pack file is not configured for this deployment',
  fix: Object.freeze({
    kind: 'env' as const,
    run: 'STOCK_PREPARATION_CUSTOMER_PACK_FILE=/opt/synthetic/pack.json',
    name: 'STOCK_PREPARATION_CUSTOMER_PACK_FILE',
  }),
})

function synPreflight(ready: boolean): Record<string, unknown> {
  return {
    ready,
    blockerCount: ready ? 0 : 2,
    blockers: ready ? [] : [SYN_HTTP_BLOCKER, SYN_ENV_BLOCKER],
    posture: {
      syn_fence_write: { state: 'off' },
      syn_fence_sql: { state: 'off' },
    },
    checks: { sandboxWriteAuthorization: { droppedNonNamespaceEntries: 0 } },
  }
}

function synProjectRow(input: {
  projectNo: string
  projectName: string
  pendingDecisionCount: number
  heldLineCount: number
  readyLineCount: number
}): Record<string, unknown> {
  return {
    projectId: `syn-project-${input.projectNo.toLowerCase()}`,
    projectNo: input.projectNo,
    projectName: input.projectName,
    projectStatus: 'active',
    lastSyncRunId: 'syn-run-0001',
    snapshotBatchCount: 1,
    openExceptionCount: 0,
    heldLineCount: input.heldLineCount,
    readyLineCount: input.readyLineCount,
    pendingDecisionCount: input.pendingDecisionCount,
    sources: ['mvp'],
    lastChangedFromPlmAt: '2026-09-05T06:20:00.000Z',
    lastChangedFromPlmBounded: false,
    lastExportAt: null,
  }
}

function synDirectory(state: ScenarioState): Record<string, unknown> {
  return {
    tenantId: SYN_TENANT_ID,
    directoryReady: state.directoryReady,
    ledgerReady: state.ledgerReady,
    projectCount: state.projects.length,
    pendingProjectCount: state.projects.filter((row) => (row.pendingDecisionCount as number) > 0).length,
    projects: state.projects,
    pullTargetReady: true,
    directoryMayBeIncomplete: false,
    pullTargetScanCapped: false,
    lastExportAtMayBeIncomplete: false,
  }
}

function synDecisionRow(): Record<string, unknown> {
  return {
    decisionId: SYN_DECISION_ID,
    // The ONE conflict type the confirm endpoint can act on — anything else renders disabled.
    conflictType: 'duplicate_expanded_key',
    status: 'pending',
    resolutionAction: null,
    inputFingerprint: SYN_FINGERPRINT,
    sourceRevisionPresent: true,
    confirmedByPresent: false,
    confirmedAtPresent: false,
    notesPresent: false,
    resolvedValuePresent: false,
    resolvedAuxValuePresent: false,
  }
}

function synQueue(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  const pending = rows.filter((row) => row.status === 'pending').length
  const confirmed = rows.filter((row) => row.status === 'confirmed').length
  return {
    rowCount: rows.length,
    byStatus: { pending, confirmed, superseded: 0 },
    byResolutionAction: {},
    parkedCount: 0,
    rows,
  }
}

function synBoard(projectNo: string, state: ScenarioState): Record<string, unknown> {
  const row = state.projects.find((entry) => entry.projectNo === projectNo)
  const pending = typeof row?.pendingDecisionCount === 'number' ? row.pendingDecisionCount : 0
  return {
    tenantId: SYN_TENANT_ID,
    projectId: `syn-project-${projectNo.toLowerCase()}`,
    projectNo,
    projectName: row?.projectName ?? SYN_PROJECT_A_NAME,
    projectStatus: 'active',
    lastSyncRunId: 'syn-run-0001',
    snapshotBatchCount: 1,
    openExceptionCount: 0,
    heldLineCount: typeof row?.heldLineCount === 'number' ? row.heldLineCount : 0,
    readyLineCount: typeof row?.readyLineCount === 'number' ? row.readyLineCount : 0,
    archivedSnapshotPresent: false,
    pullTargetReady: true,
    pulledRowCount: 1240,
    activePulledRowCount: 1240,
    pulledRowCountBounded: false,
    lastChangedFromPlmAt: '2026-09-05T06:20:00.000Z',
    lastChangedFromPlmBounded: false,
    pendingDecisionCount: pending,
    lastExportAt: null,
    fillTarget: { sheetId: 'syn-sheet-0001', viewId: 'syn-view-0001' },
    directoryReady: state.directoryReady,
    ledgerReady: state.ledgerReady,
  }
}

function synHandoff(projectNo: string): Record<string, unknown> {
  return {
    configured: false,
    projectNo,
    steps: [],
    stepCount: 0,
    stepIndex: null,
    currentStepKey: null,
    terminal: false,
    completed: false,
    isCurrentHandler: false,
    notifiedStepIndex: null,
    resendableStepKey: null,
    lostStepKeys: [],
    notificationsConfigured: false,
  }
}

function synSourceBinding(bound: boolean): Record<string, unknown> {
  return {
    actionId: 'plm.stock-preparation.pull-bom.v1',
    effectiveExternalSystemId: bound ? 'syn-source-0001' : null,
    effectiveSourceKind: bound ? 'sqlserver' : null,
    origin: bound ? 'persisted' : 'unconfigured',
    persistedBinding: bound
      ? {
        tenantId: SYN_TENANT_ID,
        workspaceId: null,
        actionId: 'plm.stock-preparation.pull-bom.v1',
        externalSystemId: 'syn-source-0001',
        updatedBy: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      }
      : null,
    effectiveSourceProblem: null,
    takesEffectWithoutRestart: true,
    eligibleSources: [
      {
        externalSystemId: 'syn-source-0001',
        name: '合成只读源 A',
        kind: 'sqlserver',
        kindLabel: { zh: '合成只读源', en: 'Synthetic read-only source' },
        status: 'active',
        role: 'source',
      },
    ],
  }
}

function synSourcePreflight(verdict: 'go' | 'no-go'): Record<string, unknown> {
  const go = verdict === 'go'
  return {
    ok: true,
    verdict,
    externalSystemId: 'syn-source-0001',
    readPlanId: 'syn-read-plan',
    rowCap: 50000,
    checks: {
      reachability: { reachable: true, objectsProbed: 6, objectsAnswered: go ? 6 : 3, failureCode: null },
      projectData: { hasProjectNumbers: go, populatedMatchRows: go ? 12 : 0, exact: true },
      bomData: { hasBomRows: go, bomDetailRows: go ? 340 : 0, bomDetailExact: true },
      bomStore: { store: go ? 'bom-details' : 'conflicted', reason: go ? null : 'synthetic_conflict' },
      topology: {
        detectedBridge: go ? 'order-module' : 'ambiguous',
        configuredBridge: 'order-module',
        matchesConfigured: go,
        bridgeSource: 'measured',
        undecidableAtCap: false,
        rowCap: 50000,
      },
      presetMatch: {
        presetId: go ? 'syn-preset' : null,
        matchedSignatureTables: go ? 6 : 0,
        requiredSignatureTables: 6,
        reason: go ? null : 'no_signature_match',
      },
      quantityField: { dictionaryEnabledRows: 0 },
      pullDelegation: { evaluated: true, available: true, bindingShape: 'syn-shape', reason: null },
    },
    blockers: go ? [] : [{ code: 'SOURCE_TOPOLOGY_MISMATCH' }],
    warnings: [],
    probes: [
      { object: 'SynProjectTable', columns: ['SynProjectNo', 'SynProjectName'], rowCount: 12 },
      { object: 'SynBomTable', columns: ['SynPartNo', 'SynQty'], rowCount: 340 },
    ],
  }
}

function synRoleCatalog(): Record<string, unknown> {
  return {
    items: [
      {
        id: 'syn-role-operator',
        name: '合成一线角色',
        permissions: ['stock-prep:read', 'stock-prep:operate'],
        memberCount: 6,
      },
      { id: 'admin', name: '平台管理员', permissions: ['integration:admin'], memberCount: 2 },
      { id: 'syn-role-unrelated', name: '合成无关角色', permissions: ['calendar:read'], memberCount: 3 },
    ],
  }
}

function synAuditEntries(): Array<Record<string, unknown>> {
  return [
    {
      id: 'syn-audit-0003',
      createdAt: '2026-09-07T14:10:00.000Z',
      action: 'prep_line_export',
      actor: 'syn-user-self',
      subjectId: null,
      mode: 'synthetic',
      workspaceId: null,
      detail: { syntheticRowCount: 12 },
    },
    {
      id: 'syn-audit-0002',
      createdAt: '2026-09-07T13:48:00.000Z',
      action: 'exception_resolve',
      actor: 'syn-user-other',
      subjectId: null,
      mode: 'synthetic',
      workspaceId: null,
      detail: {},
    },
    {
      id: 'syn-audit-0001',
      createdAt: '2026-09-07T01:02:00.000Z',
      action: 'source_binding_set',
      actor: 'syn-user-other',
      subjectId: null,
      mode: 'synthetic',
      workspaceId: null,
      detail: {},
    },
  ]
}

// ---------------------------------------------------------------------------
// Scenario state — mutable, because a few of the acceptance items are about what happens AFTER an
// action (对账 → 队列自动重读, 就地确认 → 空态换成 nothing_pending).
// ---------------------------------------------------------------------------

interface ScenarioState {
  scenario: StockPrepScenario
  directoryReady: boolean
  ledgerReady: boolean
  preflightReady: boolean
  /** Refuse the operator directory the way the server refuses a principal with no tenant of its own. */
  directoryRefusal: string | null
  projects: Array<Record<string, unknown>>
  queueRows: Array<Record<string, unknown>>
  roleCatalog: 'ok' | 'forbidden'
  sourceVerdict: 'go' | 'no-go'
  manifestStatus: number
}

function createScenarioState(scenario: StockPrepScenario, options: StockPrepRouteOptions): ScenarioState {
  const base: ScenarioState = {
    scenario,
    directoryReady: true,
    ledgerReady: true,
    preflightReady: true,
    directoryRefusal: null,
    projects: [],
    queueRows: [],
    roleCatalog: options.roleCatalog ?? 'ok',
    sourceVerdict: options.sourceVerdict ?? 'go',
    manifestStatus: 200,
  }

  if (scenario === 'fresh') {
    // 未装完:目录建好了、账本还没有 —— `ledger_missing` 的准确形状。
    return {
      ...base,
      preflightReady: false,
      ledgerReady: false,
      projects: [
        synProjectRow({ projectNo: SYN_PROJECT_A, projectName: SYN_PROJECT_A_NAME, pendingDecisionCount: 0, heldLineCount: 0, readyLineCount: 0 }),
        synProjectRow({ projectNo: SYN_PROJECT_B, projectName: SYN_PROJECT_B_NAME, pendingDecisionCount: 0, heldLineCount: 0, readyLineCount: 0 }),
      ],
      queueRows: [],
    }
  }

  if (scenario === 'readerOnly') {
    return { ...base, directoryRefusal: 'OPERATOR_SCOPE_TENANT_REQUIRED', projects: [], queueRows: [] }
  }

  if (scenario === 'defaults500') {
    return {
      ...base,
      manifestStatus: 500,
      preflightReady: false,
      projects: [
        synProjectRow({ projectNo: SYN_PROJECT_A, projectName: SYN_PROJECT_A_NAME, pendingDecisionCount: 0, heldLineCount: 0, readyLineCount: 0 }),
      ],
    }
  }

  if (scenario === 'noProjects') {
    return { ...base, projects: [], queueRows: [] }
  }

  // ready
  return {
    ...base,
    projects: [
      synProjectRow({ projectNo: SYN_PROJECT_A, projectName: SYN_PROJECT_A_NAME, pendingDecisionCount: 3, heldLineCount: 0, readyLineCount: 1240 }),
      synProjectRow({ projectNo: SYN_PROJECT_B, projectName: SYN_PROJECT_B_NAME, pendingDecisionCount: 0, heldLineCount: 7, readyLineCount: 860 }),
    ],
    queueRows: [synDecisionRow()],
  }
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

type Responder = (input: { route: Route; url: URL; state: ScenarioState }) => Promise<void>

function json(route: Route, status: number, body: string): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body })
}

/** Longest-prefix-first: `/confirmation-decisions/confirm` must be matched before `/confirmation-decisions`. */
const ROUTES: Array<{ method: string; path: string; respond: Responder }> = [
  {
    method: 'GET',
    path: '/api/platform/apps/stock-preparation',
    respond: ({ route, state }) => (state.manifestStatus === 200
      ? json(route, 200, JSON.stringify(synManifest()))
      // The catalog is a core-backend router: a BARE payload, and a failure is a bare failure too.
      : json(route, state.manifestStatus, JSON.stringify({ error: 'SYNTHETIC_MANIFEST_FAILURE' }))),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/preflight',
    respond: ({ route, state }) => json(route, 200, envelope(synPreflight(state.preflightReady))),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/operator/projects',
    respond: ({ route, state }) => (state.directoryRefusal
      ? json(route, 403, refusal(state.directoryRefusal))
      : json(route, 200, envelope(synDirectory(state)))),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/confirmation-decisions/readiness',
    respond: ({ route, state }) => json(route, 200, envelope({ ready: state.ledgerReady })),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/confirmation-decisions/value-entry',
    respond: ({ route, url }) => json(route, 200, envelope({
      decisionId: url.searchParams.get('decisionId') ?? SYN_DECISION_ID,
      conflictType: 'duplicate_expanded_key',
      status: 'pending',
      resolutionAction: null,
      inputFingerprint: SYN_FINGERPRINT,
      valueEntry: { resolvedValue: 'SYN-VALUE-01', resolvedAuxValue: 'SYN-AUX-01', notes: '合成备注' },
    })),
  },
  {
    method: 'POST',
    path: '/api/integration/stock-preparation/confirmation-decisions/confirm',
    respond: ({ route, state }) => {
      // 就地确认之后队列真的空了 —— 这正是 P1-3 要证明的那一步。
      state.queueRows = []
      for (const project of state.projects) {
        if (project.projectNo === SYN_PROJECT_A) project.pendingDecisionCount = 0
      }
      return json(route, 200, envelope({ ok: true, status: 'confirmed', resolutionAction: 'keep_multiple_rows' }))
    },
  },
  {
    method: 'POST',
    path: '/api/integration/stock-preparation/confirmation-decisions/ensure',
    respond: ({ route, state }) => {
      state.ledgerReady = true
      return json(route, 200, envelope({ ensured: true }))
    },
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/confirmation-decisions',
    respond: ({ route, state }) => json(route, 200, envelope(synQueue(state.queueRows))),
  },
  {
    method: 'POST',
    path: '/api/integration/stock-preparation/handoff/advance',
    respond: ({ route }) => json(route, 501, refusal('STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED')),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/handoff',
    respond: ({ route, url }) => json(route, 200, envelope(synHandoff(url.searchParams.get('projectNo') ?? ''))),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/source-binding',
    respond: ({ route, state }) => json(route, 200, envelope(synSourceBinding(state.scenario !== 'readerOnly'))),
  },
  {
    method: 'POST',
    path: '/api/integration/stock-preparation/source-binding',
    respond: ({ route }) => json(route, 200, envelope({
      actionId: 'plm.stock-preparation.pull-bom.v1',
      binding: {
        tenantId: SYN_TENANT_ID,
        workspaceId: null,
        actionId: 'plm.stock-preparation.pull-bom.v1',
        externalSystemId: 'syn-source-0001',
        updatedBy: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-08T00:00:00.000Z',
      },
      changed: true,
      takesEffectWithoutRestart: true,
    })),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/source-preflight',
    respond: ({ route, state }) => json(route, 200, envelope(synSourcePreflight(state.sourceVerdict))),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/customer-packs/installs',
    respond: ({ route }) => json(route, 200, envelope({
      objectId: 'plm_stock_preparation_main',
      rowCount: 1,
      installs: [{
        packId: 'syn-pack',
        packVersion: '0.0.0-synthetic',
        mode: 'synthetic',
        status: 'installed',
        fieldCount: 7,
        installedFields: ['syn_field_a', 'syn_field_b'],
        warnings: [],
        lastInstallAt: '2026-09-05T00:00:00.000Z',
      }],
    })),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/customer-packs',
    respond: ({ route }) => json(route, 200, envelope({
      packCount: 1,
      packs: [{
        packId: 'syn-pack',
        packVersion: '0.0.0-synthetic',
        targetObjectId: 'plm_stock_preparation_main',
        extensionFields: [{ id: 'syn_field_a', type: 'text', ownership: 'customer', preserveOnRefresh: true }],
      }],
    })),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/target/readiness',
    respond: ({ route }) => json(route, 200, envelope({
      ready: true,
      mode: 'canonical',
      targetBindingAvailable: true,
      evidence: { missingFields: [], fieldCounts: { total: 7 } },
    })),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/sandbox-target/readiness',
    respond: ({ route }) => json(route, 200, envelope({
      ready: true,
      mode: 'sandbox',
      targetBindingAvailable: true,
      evidence: { missingFields: [], fieldCounts: { total: 7 } },
    })),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/audit',
    respond: ({ route }) => json(route, 200, envelope({ rowCount: 3, entries: synAuditEntries() })),
  },
  {
    method: 'GET',
    path: '/api/integration/stock-preparation/prep-lines/export',
    respond: ({ route }) => route.fulfill({
      status: 200,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      headers: {
        'Content-Disposition': 'attachment; filename="syn-export.xlsx"',
        'X-Stock-Prep-Export-Row-Count': '12',
      },
      body: 'SYNTHETIC-XLSX',
    }),
  },
  {
    method: 'GET',
    path: '/api/admin/roles',
    respond: ({ route, state }) => (state.roleCatalog === 'ok'
      ? json(route, 200, JSON.stringify({ ok: true, data: synRoleCatalog() }))
      : json(route, 403, JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }))),
  },
]

/** `/projects/<no>/board` and the table-action run steps need a pattern rather than a literal. */
const BOARD_PATTERN = /^\/api\/integration\/stock-preparation\/projects\/([^/]+)\/board$/
const TABLE_ACTION_PATTERN = /^\/api\/integration\/table-actions\/([^/]+)\/(.+)$/

function resolveResponder(method: string, path: string): Responder | null {
  for (const entry of ROUTES) {
    if (entry.method === method && path === entry.path) return entry.respond
  }
  if (method === 'GET' && BOARD_PATTERN.test(path)) {
    return ({ route, state }) => {
      const projectNo = decodeURIComponent(BOARD_PATTERN.exec(path)![1])
      const known = state.projects.some((row) => row.projectNo === projectNo)
      if (!known) return json(route, 404, refusal('STOCK_PREPARATION_PROJECT_NOT_FOUND'))
      return json(route, 200, envelope(synBoard(projectNo, state)))
    }
  }
  if (method === 'POST' && TABLE_ACTION_PATTERN.test(path)) {
    const step = TABLE_ACTION_PATTERN.exec(path)![2]
    return ({ route, state }) => {
      if (step === 'confirmation-decisions/reconcile') {
        // 对账成功之后队列必须被重新读一次 —— P0-9 就是靠这个断言的。
        return json(route, 200, envelope({ scanned: 1, pending: state.queueRows.length }))
      }
      return json(route, 200, envelope({ ok: true, step, synthetic: true }))
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/**
 * Route every `/api/**` request this page makes to the synthetic world above.
 *
 * Call it BEFORE `page.goto`. The returned log is live: it keeps filling as the page runs, so a spec
 * can assert 「这次动作之后队列又读了一遍」 by counting entries rather than by waiting on a timer.
 */
export async function installStockPrepRoutes(
  page: Page,
  scenario: StockPrepScenario,
  options: StockPrepRouteOptions = {},
): Promise<StockPrepRouteLog> {
  const state = createScenarioState(scenario, options)
  const calls: StockPrepApiCall[] = []
  const unmocked: string[] = []

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    calls.push({ method, path: url.pathname, search: url.search, url: request.url() })

    const responder = resolveResponder(method, url.pathname)
    if (!responder) {
      unmocked.push(`${method} ${url.pathname}`)
      await json(route, 404, refusal('VERIFY_UNMOCKED_ROUTE'))
      return
    }
    await responder({ route, url, state })
  })

  return {
    calls,
    unmocked,
    count(method: string, suffix: string): number {
      return calls.filter((call) => call.method === method && call.path.endsWith(suffix)).length
    },
    urls(suffix: string): string[] {
      return calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.url)
    },
  }
}

export const STOCK_PREP_HARNESS = '/verification/stock-prep-workbench-harness.html'

export type StockPrepActor = 'reader' | 'operator' | 'stockadmin' | 'platform'

export interface StockPrepOpenOptions {
  actor: StockPrepActor
  scenario: StockPrepScenario
  /** `?tab=` — the shell's deep link into one rail item. Omit to land wherever D2 lands this actor. */
  tab?: string
  /** `?projectNo=` — §2.3's 首页 ⇄ 工作区 state bit. */
  projectNo?: string
  routes?: StockPrepRouteOptions
}

/**
 * Install the fixture world, open the harness, and wait until the shell has actually painted a
 * panel. Returns the live route log.
 *
 * The wait is on the RAIL rather than on a timer: `stock-prep-tabs` renders unconditionally (the
 * D2 landing hold suspends the panel, never the rail), so it is the earliest honest "the shell is
 * up" signal, and every spec below then waits on whichever panel it is about.
 */
export async function openStockPrepHarness(
  page: Page,
  options: StockPrepOpenOptions,
): Promise<StockPrepRouteLog> {
  const log = await installStockPrepRoutes(page, options.scenario, options.routes ?? {})
  const query = new URLSearchParams({ actor: options.actor, scenario: options.scenario })
  if (options.tab) query.set('tab', options.tab)
  if (options.projectNo) query.set('projectNo', options.projectNo)
  await page.goto(`${STOCK_PREP_HARNESS}?${query.toString()}`)
  await page.waitForFunction(
    () => (window as unknown as { __STOCK_PREP_READY__?: boolean }).__STOCK_PREP_READY__ === true,
  )
  await page.locator('[data-testid="stock-prep-tabs"]').waitFor({ state: 'attached' })
  return log
}

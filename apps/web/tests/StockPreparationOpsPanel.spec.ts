import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { createRequire } from 'node:module'

// 「记录与排查」面板 (P1-4/P1-5, 设计稿 §6.2 + 线框 E) — 暗装: this spec drives the real component
// over a mocked `apiFetch`, so the real services (audit.ts, deploymentHealth.ts, plus the reused
// sourceBinding.ts / installPlan.ts / sourcePreflight.ts) run underneath it, same discipline as
// StockPreparationSourceBinding.spec.ts.
//
// THE MOCK PARSES THE QUERY STRING, AND THAT IS LOad-BEARING. An earlier revision dispatched on the
// URL PREFIX only and ignored everything after `?`, which made every filter in this panel untestable
// by construction: the audit search "worked" in the suite while sending a `workspaceId` that filters
// on a column NULL on every row it can match, and the pack tile "worked" while asking two different
// routes about two different tables. `auditResponse` below therefore mirrors
// `stock-preparation-audit-store.cjs`'s `list` (equality filters; a NULL column never matches a
// supplied value) and the installs route echoes the `objectId` it was asked about, exactly as
// `stockPreparationCustomerPackInstallList` does. A guard that cannot fail is not a guard.
//
// Guards this file pins:
//   OP-01 六格三态: idle(未检查, its own neutral tone) / ready / forbidden|unavailable|misconfigured.
//   OP-02 allSettled 隔离: one auto-cell's read failing leaves the other auto-cells rendering fine.
//   OP-03 「未检查」不是绿也不是红 (no success/warning badge class before a manual check runs).
//   OP-04 计划任务恒「未接入监控」— never a success/warning tone, regardless of anything else.
//   OP-05 审计主行零 actor 原值 / 零邮箱 (反向断言) — the raw handle may appear ONLY inside the
//         per-row 技术详情 disclosure, never in the primary time/action/who spans; and the 「谁」
//         column is THREE-valued, so an unreadable account never becomes 「其他同事」.
//   OP-06 三行免责常驻 — present before a search, mid-search, and after one (every branch).
//   OP-07 空态措辞 — "这不等于没人动过", not a generic "暂无数据".
//   OP-08 403 措辞 — "这一格看不了:需要平台管理员" (BOTH halves, every tile).
//   OP-09 词表防漏 — STOCK_PREP_AUDIT_ACTION_PLAIN carries all 14 actions the .cjs store declares,
//         read from that module directly (anti-vacuity, same discipline as
//         StockPreparationPosturePlainLanguage.spec.ts's manifest read).
//   OP-10 目标表一致性 — installs 与 readiness 问同一个 objectId, and WHICH readiness route is used
//         is decided by that id's namespace (canonical vs sandbox), never sent blind.
//   OP-11 反查不带 workspaceId — the regression that made this lookup return zero rows forever.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['stock-prep:admin', 'integration:admin'] as string[],
  currentUserId: 'u_me' as string | null,
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: false, roles: [], permissions: h.permissions }),
    hasAdminAccess: () => false,
    hasPermission: (permission: string) => h.permissions.includes(permission),
    getCurrentUserId: async () => h.currentUserId,
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import StockPreparationOpsPanel from '../src/components/integration/stockPreparation/StockPreparationOpsPanel.vue'
import { STOCK_PREP_AUDIT_ACTION_PLAIN } from '../src/services/integration/stockPreparation/plainLanguage'

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }

/**
 * `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId`. A pack that declares no `targetObjectId` gets
 * THIS server-side (`normalizePackTargetObjectId`), and both packs shipped in
 * `plugins/plugin-integration-core/lib/customer-packs/` declare none — so canonical is the DEFAULT
 * fixture here, not an exotic one. The previous fixture used `sandbox_factory_a_main`, a value the
 * server cannot produce in either direction (it is neither the canonical id nor inside
 * `/^plm_stock_preparation_sandbox(?:$|[_-])/`), which is precisely why the suite stayed green over
 * a panel that 422'd on every real deployment.
 */
const CANONICAL_OBJECT_ID = 'plm_stock_preparation_main'
const SANDBOX_OBJECT_ID = 'plm_stock_preparation_sandbox_factory_a'

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function refusal(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code } }), { status })
}

function queryOf(url: string): URLSearchParams {
  const mark = url.indexOf('?')
  return new URLSearchParams(mark >= 0 ? url.slice(mark + 1) : '')
}

// ---------------------------------------------------------------------------
// Default happy-path payloads for every route this panel can call.
// ---------------------------------------------------------------------------

function sourceBindingPayload(): Record<string, unknown> {
  return {
    actionId: 'plm.stock-preparation.pull-bom.v1',
    effectiveExternalSystemId: 'sys_demo',
    effectiveSourceKind: 'data-source:sql-readonly',
    origin: 'deploy_default',
    persistedBinding: null,
    effectiveSourceProblem: null,
    takesEffectWithoutRestart: true,
    eligibleSources: [
      {
        externalSystemId: 'sys_demo',
        name: '内置演示源',
        kind: 'data-source:sql-readonly',
        kindLabel: { zh: '只读数据库桥接', en: 'Read-only database bridge' },
        status: 'active',
        role: 'source',
      },
    ],
  }
}

function customerPackCatalogPayload(targetObjectId: string | null = CANONICAL_OBJECT_ID): Record<string, unknown> {
  return {
    packCount: 1,
    packs: [
      {
        packId: 'factory-a',
        packVersion: '1.0.0',
        targetObjectId,
        extensionFields: [],
      },
    ],
  }
}

/** Mirrors the route: `objectId` in the response is the one the CALLER asked about (or the default). */
function customerPackInstallsPayload(objectId: string): Record<string, unknown> {
  return {
    objectId,
    rowCount: 1,
    installs: [
      {
        packId: 'factory-a',
        packVersion: '1.0.0',
        mode: 'sandbox',
        status: 'installed',
        fieldCount: 6,
        installedFields: ['f1', 'f2'],
        warnings: [],
        lastInstallAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  }
}

/** `publicStockPreparationSandboxTargetResult` — note `targetBindingAvailable`, a boolean. */
function sandboxReadinessPayload(ready = true): Record<string, unknown> {
  return { ready, mode: ready ? 'sandbox_existing' : 'sandbox_incomplete', targetBindingAvailable: ready, evidence: {} }
}

/** `publicStockPreparationTargetResult` — note `targetBinding`, an OBJECT or null. Different shape. */
function canonicalReadinessPayload(ready = true): Record<string, unknown> {
  return {
    ready,
    mode: ready ? 'canonical_existing' : 'canonical_incomplete',
    targetBinding: ready ? { sheetId: 'sheet-canonical', fieldIdMap: {} } : null,
    evidence: {},
  }
}

function preflightPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ready: true,
    blockerCount: 0,
    blockers: [],
    posture: {
      productionApply: { state: 'closed' },
      k3ExternalWrite: { state: 'permanently_disabled' },
      b2aTrialRegistry: { state: 'dormant' },
      outboundHttpWrite: { state: 'unset' },
    },
    ...overrides,
  }
}

function sourcePreflightPayload(): Record<string, unknown> {
  return {
    ok: true,
    verdict: 'go',
    externalSystemId: 'sys_demo',
    readPlanId: 'plan1',
    rowCap: 200,
    checks: {
      reachability: { reachable: true, objectsProbed: 2, objectsAnswered: 2, failureCode: null },
      projectData: { hasProjectNumbers: true, populatedMatchRows: 5, exact: true },
      bomData: { hasBomRows: true, bomDetailRows: 10, bomDetailExact: true },
      bomStore: { store: 'bom-details', reason: 'ok' },
      topology: {
        detectedBridge: 'order-module',
        matchesConfigured: true,
        undecidableAtCap: false,
        bridgeSource: 'measured',
        rowCap: 200,
        configuredBridge: 'order-module',
      },
      presetMatch: { presetId: 'preset1', matchedSignatureTables: 2, requiredSignatureTables: 2, reason: 'ok' },
      pullDelegation: { evaluated: true, available: true, bindingShape: 'canonical', reason: null },
    },
    blockers: [],
    warnings: [],
    probes: [],
  }
}

// ---------------------------------------------------------------------------
// The audit rows, shaped like the ones the four project-number-stamping actions really write:
// `workspace_id` is NULL on every one of them, because none of `http-routes.cjs`'s eighteen
// `audit.append` call sites passes a workspaceId. This is what makes OP-11 a real regression test —
// a panel that forwards `scope.workspaceId` gets zero rows here, exactly as it would in production.
// ---------------------------------------------------------------------------
interface AuditRow {
  id: string
  tenantId: string
  workspaceId: string | null
  projectId: string | null
  action: string
  subjectId: string | null
  mode: string | null
  actor: string | null
  detail: Record<string, unknown>
  createdAt: string
}

const PLANTED_ACTOR = 'ops.leader@example-corp.internal'
const PLANTED_SUBJECT = 'sha16-deadbeef01'

function auditRows(): AuditRow[] {
  return [
    {
      id: 'row-1',
      tenantId: 'tenant-a',
      workspaceId: null,
      projectId: 'P2026-001',
      action: 'prep_line_export',
      subjectId: PLANTED_SUBJECT,
      mode: 'export_full',
      actor: PLANTED_ACTOR,
      detail: { rowCount: 3 },
      createdAt: '2026-09-01T10:00:00.000Z',
    },
    {
      id: 'row-2',
      tenantId: 'tenant-a',
      workspaceId: null,
      projectId: 'P2026-001',
      action: 'handoff_advance',
      subjectId: 'pull',
      mode: 'advanced',
      actor: 'u_me',
      detail: {},
      createdAt: '2026-09-01T09:00:00.000Z',
    },
  ]
}

/** Mirrors `stock-preparation-audit-store.cjs`'s `list`: equality filters only, NULL never matches. */
function auditResponse(url: string, rows: AuditRow[] = auditRows()): Response {
  const query = queryOf(url)
  let matched = rows.filter((row) => row.tenantId === query.get('tenantId'))
  const workspaceId = query.get('workspaceId')
  if (workspaceId) matched = matched.filter((row) => row.workspaceId === workspaceId)
  const projectId = query.get('projectId')
  if (projectId) matched = matched.filter((row) => row.projectId === projectId)
  const action = query.get('action')
  if (action) matched = matched.filter((row) => row.action === action)
  return envelope({ rowCount: matched.length, entries: matched })
}

interface Routes {
  sourceBinding?: () => Response
  customerPacks?: () => Response
  installs?: (url: string) => Response
  sandboxReadiness?: () => Response
  canonicalReadiness?: () => Response
  preflight?: () => Response
  sourcePreflight?: () => Response
  audit?: (url: string) => Response
}

function installRoutes(routes: Routes = {}): void {
  h.apiFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/stock-preparation/customer-packs/installs')) {
      if (routes.installs) return routes.installs(url)
      return envelope(customerPackInstallsPayload(queryOf(url).get('objectId') || CANONICAL_OBJECT_ID))
    }
    if (url.includes('/stock-preparation/customer-packs')) {
      return routes.customerPacks ? routes.customerPacks() : envelope(customerPackCatalogPayload())
    }
    // Order matters: the sandbox path CONTAINS the canonical one's suffix.
    if (url.includes('/stock-preparation/sandbox-target/readiness')) {
      return routes.sandboxReadiness ? routes.sandboxReadiness() : envelope(sandboxReadinessPayload())
    }
    if (url.includes('/stock-preparation/target/readiness')) {
      return routes.canonicalReadiness ? routes.canonicalReadiness() : envelope(canonicalReadinessPayload())
    }
    if (url.includes('/stock-preparation/source-binding')) {
      return routes.sourceBinding ? routes.sourceBinding() : envelope(sourceBindingPayload())
    }
    if (url.includes('/stock-preparation/source-preflight')) {
      return routes.sourcePreflight ? routes.sourcePreflight() : envelope(sourcePreflightPayload())
    }
    if (url.includes('/stock-preparation/preflight')) {
      return routes.preflight ? routes.preflight() : envelope(preflightPayload())
    }
    if (url.includes('/stock-preparation/audit')) {
      return routes.audit ? routes.audit(url) : auditResponse(url)
    }
    return envelope({})
  })
}

async function flush(cycles = 8): Promise<void> {
  for (let turn = 0; turn < cycles; turn += 1) {
    await new Promise((done) => { setTimeout(done, 0) })
    await nextTick()
  }
}

function urlsMatching(fragment: string): string[] {
  return h.apiFetch.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes(fragment))
}

describe('BOM备料 记录与排查面板 (P1-4/P1-5)', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['stock-prep:admin', 'integration:admin']
    h.currentUserId = 'u_me'
    h.apiFetch.mockReset()
    installRoutes()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountPanel(): Promise<HTMLDivElement> {
    app = createApp(StockPreparationOpsPanel as Component, { scope: SCOPE })
    app.mount(container!)
    await flush()
    return container!
  }

  function node(root: HTMLElement, testid: string): HTMLElement | null {
    return root.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null
  }

  function nodes(root: HTMLElement, testid: string): HTMLElement[] {
    return [...root.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[]
  }

  function text(root: HTMLElement, testid: string): string {
    return node(root, testid)?.textContent ?? ''
  }

  async function search(root: HTMLElement, projectNo: string): Promise<void> {
    const input = node(root, 'stock-prep-ops-audit-project-input') as HTMLInputElement
    input.value = projectNo
    input.dispatchEvent(new Event('input', { bubbles: true }))
    node(root, 'stock-prep-ops-audit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
  }

  // -------------------------------------------------------------------------
  // OP-01 / OP-03 — 六格, and the neutral 未检查 state before any manual check.
  // -------------------------------------------------------------------------

  it('OP-01/OP-03: renders all six health cells; the two manual cells start 未检查 (neutral, not success/warning)', async () => {
    const root = await mountPanel()
    expect(node(root, 'stock-prep-ops-health')).not.toBeNull()

    const cellIds = ['source', 'packs', 'preflight', 'source-preflight', 'fences', 'scheduled-task']
    for (const id of cellIds) {
      expect(node(root, `stock-prep-ops-cell-${id}`), id).not.toBeNull()
    }

    // Manual cells never auto-fire (D6/§6.2): status stays 'idle' and the badge carries no
    // success/warning class — 未检查 is its own third state, not a colour.
    const preflightCell = node(root, 'stock-prep-ops-cell-preflight')!
    expect(preflightCell.getAttribute('data-cell-status')).toBe('idle')
    const preflightBadge = preflightCell.querySelector('.sp-ops__cell-badge')!
    expect(preflightBadge.className).not.toMatch(/success|warning/)
    expect(preflightBadge.className).toMatch(/unchecked/)
    expect(preflightBadge.textContent).toContain('未检查')

    const sourcePreflightCell = node(root, 'stock-prep-ops-cell-source-preflight')!
    expect(sourcePreflightCell.getAttribute('data-cell-status')).toBe('idle')
    expect(sourcePreflightCell.querySelector('.sp-ops__cell-badge')!.className).not.toMatch(/success|warning/)

    // Fences derive from preflight and have not run either — also neutral, also 未检查.
    const fencesCell = node(root, 'stock-prep-ops-cell-fences')!
    expect(fencesCell.querySelector('.sp-ops__cell-badge')!.className).not.toMatch(/success|warning/)
    expect(fencesCell.textContent).toContain('未检查')
  })

  it('OP-01: a manual check runs, colours its own cell, and populates the derived fences cell from the SAME payload', async () => {
    const root = await mountPanel()
    node(root, 'stock-prep-ops-cell-preflight-check')!.dispatchEvent(new Event('click', { bubbles: true }))
    await flush()

    const preflightCell = node(root, 'stock-prep-ops-cell-preflight')!
    expect(preflightCell.getAttribute('data-cell-status')).toBe('ready')
    expect(preflightCell.querySelector('.sp-ops__cell-badge')!.className).toMatch(/success/)
    expect(text(root, 'stock-prep-ops-cell-preflight')).toContain('都齐了')

    // Same click populated the fences cell too — no second network call for it.
    expect(text(root, 'stock-prep-ops-cell-fences')).toContain('全部关闭')
    expect(urlsMatching('/preflight').filter((url) => !url.includes('source-preflight')).length).toBe(1)
  })

  it('四条硬边界 never claims four fences from fewer than four readings', async () => {
    installRoutes({
      preflight: () => envelope(preflightPayload({
        posture: { productionApply: { state: 'closed' }, k3ExternalWrite: { state: 'permanently_disabled' } },
      })),
    })
    const root = await mountPanel()
    node(root, 'stock-prep-ops-cell-preflight-check')!.dispatchEvent(new Event('click', { bubbles: true }))
    await flush()

    const cell = node(root, 'stock-prep-ops-cell-fences')!
    expect(cell.textContent).toContain('2 项这次没读到')
    // A partial reading is never "全部关闭(正常)" green.
    expect(cell.querySelector('.sp-ops__cell-badge')!.className).not.toMatch(/success/)
  })

  it('a preflight that succeeds but carries no posture says so, rather than 未检查 (which invites a pointless re-check)', async () => {
    installRoutes({ preflight: () => envelope(preflightPayload({ posture: {} })) })
    const root = await mountPanel()
    node(root, 'stock-prep-ops-cell-preflight-check')!.dispatchEvent(new Event('click', { bubbles: true }))
    await flush()

    const cell = node(root, 'stock-prep-ops-cell-fences')!
    expect(cell.textContent).toContain('这次自检没带回边界状态')
    expect(cell.textContent).not.toContain('未检查')
  })

  // -------------------------------------------------------------------------
  // OP-02 — allSettled isolation: one of the auto reads fails, the others still render.
  // -------------------------------------------------------------------------

  it('OP-02: source-binding read fails (500) — the packs cell still renders its own data fine', async () => {
    installRoutes({
      sourceBinding: () => refusal(500, 'STOCK_PREPARATION_SOURCE_BINDING_FAILED'),
    })
    const root = await mountPanel()

    const sourceCell = node(root, 'stock-prep-ops-cell-source')!
    expect(sourceCell.getAttribute('data-cell-status')).toBe('unavailable')
    expect(sourceCell.textContent).toContain('暂时看不了')

    const packsCell = node(root, 'stock-prep-ops-cell-packs')!
    expect(packsCell.getAttribute('data-cell-status')).toBe('ready')
    expect(packsCell.textContent).toContain('生产主表已就绪')
  })

  it('OP-02/OP-08: customer-packs catalog read is 403 — that cell says BOTH halves (看不了 + 谁能看); source cell is unaffected', async () => {
    installRoutes({
      customerPacks: () => refusal(403, 'FORBIDDEN'),
    })
    const root = await mountPanel()

    const packsCell = node(root, 'stock-prep-ops-cell-packs')!
    expect(packsCell.getAttribute('data-cell-status')).toBe('forbidden')
    expect(packsCell.textContent).toContain('这一格看不了')
    expect(packsCell.textContent).toContain('需要平台管理员')

    const sourceCell = node(root, 'stock-prep-ops-cell-source')!
    expect(sourceCell.getAttribute('data-cell-status')).toBe('ready')
  })

  it('a deployment with zero configured packs skips the readiness read honestly (idle, not a failure)', async () => {
    installRoutes({
      customerPacks: () => envelope({ packCount: 0, packs: [] }),
      installs: () => envelope({ objectId: CANONICAL_OBJECT_ID, rowCount: 0, installs: [] }),
    })
    const root = await mountPanel()

    expect(node(root, 'stock-prep-ops-cell-packs')!.getAttribute('data-cell-status')).toBe('ready')
    expect(text(root, 'stock-prep-ops-cell-packs')).toContain('还没有配置客户列包')
    // Neither readiness route was called — there was no declared target to ask about, and a guess
    // would be a request this panel cannot honestly attribute to any configured pack.
    expect(urlsMatching('target/readiness').length).toBe(0)
  })

  // -------------------------------------------------------------------------
  // OP-10 — one objectId, and the route chosen by its namespace.
  // -------------------------------------------------------------------------

  it('OP-10: a canonical pack (the shipped shape) is asked about on the CANONICAL route; the sandbox route is never called', async () => {
    const root = await mountPanel()

    // The sandbox route 422s on the canonical id server-side (`assertSandboxObjectId`, reason
    // prod_canonical), so sending it there at all is a guaranteed-failing request.
    expect(urlsMatching('/sandbox-target/readiness').length).toBe(0)
    expect(urlsMatching('/stock-preparation/target/readiness').length).toBe(1)

    const packsCell = node(root, 'stock-prep-ops-cell-packs')!
    expect(packsCell.getAttribute('data-cell-status')).toBe('ready')
    expect(packsCell.textContent).toContain('生产主表已就绪')
    expect(packsCell.textContent).not.toContain('沙箱表')
  })

  it('OP-10: a pack declaring a sandbox-namespace target uses the SANDBOX route, and says 沙箱表', async () => {
    installRoutes({ customerPacks: () => envelope(customerPackCatalogPayload(SANDBOX_OBJECT_ID)) })
    const root = await mountPanel()

    expect(urlsMatching('/sandbox-target/readiness').length).toBe(1)
    expect(urlsMatching('/stock-preparation/target/readiness').length).toBe(0)
    expect(text(root, 'stock-prep-ops-cell-packs')).toContain('沙箱表已就绪')
  })

  it('OP-10: installs and readiness are asked about the SAME objectId — never one table each', async () => {
    installRoutes({ customerPacks: () => envelope(customerPackCatalogPayload(SANDBOX_OBJECT_ID)) })
    const root = await mountPanel()

    const installsUrl = urlsMatching('/customer-packs/installs')[0]
    const readinessUrl = urlsMatching('/sandbox-target/readiness')[0]
    expect(queryOf(installsUrl).get('objectId')).toBe(SANDBOX_OBJECT_ID)
    expect(queryOf(readinessUrl).get('objectId')).toBe(SANDBOX_OBJECT_ID)

    // ...and the 数据落在哪 disclosure names that same table, not the route's canonical default.
    expect(node(root, 'stock-prep-ops-data-location-tech')!.textContent).toContain(SANDBOX_OBJECT_ID)
  })

  it('OP-10: a pack whose target is neither canonical nor sandbox-namespaced is reported as a CONFIG fault, with no doomed request', async () => {
    installRoutes({ customerPacks: () => envelope(customerPackCatalogPayload('sandbox_factory_a_main')) })
    const root = await mountPanel()

    expect(urlsMatching('target/readiness').length).toBe(0)
    const packsCell = node(root, 'stock-prep-ops-cell-packs')!
    expect(packsCell.getAttribute('data-cell-status')).toBe('misconfigured')
    expect(packsCell.textContent).toContain('目标表配置不对')
    // A permanent refusal must not tell an admin to wait it out.
    expect(packsCell.textContent).not.toContain('请稍后再试')
  })

  // -------------------------------------------------------------------------
  // A failed readiness sub-read must be VISIBLE — §6.2 P1-5 applies per sub-read.
  // -------------------------------------------------------------------------

  it('a 403 on the readiness half is visible on the tile (both halves of the sentence), and the install half still renders', async () => {
    installRoutes({ canonicalReadiness: () => refusal(403, 'FORBIDDEN') })
    const root = await mountPanel()

    const packsCell = node(root, 'stock-prep-ops-cell-packs')!
    expect(packsCell.getAttribute('data-cell-status')).toBe('forbidden')
    expect(text(root, 'stock-prep-ops-cell-packs-note')).toContain('表就绪度这一半没读到')
    expect(text(root, 'stock-prep-ops-cell-packs-note')).toContain('这一格看不了')
    expect(text(root, 'stock-prep-ops-cell-packs-note')).toContain('需要平台管理员')
    // The two reads that DID succeed still show their answer.
    expect(packsCell.textContent).toContain('factory-a@1.0.0')
    // ...and the tile never claims a readiness verdict it does not have.
    expect(packsCell.textContent).not.toContain('已就绪')
  })

  it('a 422 on the readiness half is worded as a permanent configuration fault, not a transient one', async () => {
    installRoutes({ canonicalReadiness: () => refusal(422, 'TARGET_SANDBOX_OBJECT_ID_INVALID') })
    const root = await mountPanel()

    const packsCell = node(root, 'stock-prep-ops-cell-packs')!
    expect(packsCell.getAttribute('data-cell-status')).toBe('misconfigured')
    expect(text(root, 'stock-prep-ops-cell-packs-note')).toContain('目标表配置不对')
    expect(text(root, 'stock-prep-ops-cell-packs-note')).not.toContain('请稍后再试')
  })

  it('a 500 on the readiness half stays a TRANSIENT sentence, and still leaves the install half readable', async () => {
    installRoutes({ canonicalReadiness: () => refusal(500, 'BOOM') })
    const root = await mountPanel()

    const packsCell = node(root, 'stock-prep-ops-cell-packs')!
    expect(packsCell.getAttribute('data-cell-status')).toBe('unavailable')
    expect(text(root, 'stock-prep-ops-cell-packs-note')).toContain('暂时看不了')
    expect(packsCell.textContent).toContain('factory-a@1.0.0')
  })

  // -------------------------------------------------------------------------
  // OP-04 — 计划任务 is ALWAYS 未接入监控, never a success/warning tone.
  // -------------------------------------------------------------------------

  it('OP-04: 计划任务 renders 未接入监控 unconditionally, with no success/warning class, before or after every other read settles', async () => {
    const root = await mountPanel()
    const cell = node(root, 'stock-prep-ops-cell-scheduled-task')!
    expect(cell.getAttribute('data-cell-status')).toBe('not_monitored')
    expect(cell.textContent).toContain('未接入监控')
    expect(cell.querySelector('.sp-ops__cell-badge')!.className).toMatch(/neutral/)
    expect(cell.querySelector('.sp-ops__cell-badge')!.className).not.toMatch(/success|warning/)

    // Even after every manual check succeeds, this cell never changes — no route backs it at all.
    node(root, 'stock-prep-ops-cell-preflight-check')!.dispatchEvent(new Event('click', { bubbles: true }))
    node(root, 'stock-prep-ops-cell-source-preflight-check')!.dispatchEvent(new Event('click', { bubbles: true }))
    await flush()
    expect(cell.textContent).toContain('未接入监控')
    expect(urlsMatching('scheduled').length).toBe(0)
  })

  // -------------------------------------------------------------------------
  // OP-05 — the reverse assertion: actor / email never in the primary audit row.
  // -------------------------------------------------------------------------

  it('OP-05: the primary audit row never renders the raw actor handle or an email; it lives ONLY in 技术详情', async () => {
    const root = await mountPanel()
    await search(root, 'P2026-001')

    const row = nodes(root, 'stock-prep-ops-audit-row')[0]
    const primaryText = [
      text(row, 'stock-prep-ops-audit-row-time'),
      text(row, 'stock-prep-ops-audit-row-action'),
      text(row, 'stock-prep-ops-audit-row-who'),
    ].join(' ')
    expect(primaryText).not.toContain(PLANTED_ACTOR)
    expect(primaryText).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
    // PLANTED_ACTOR is not the mocked caller (`u_me`), so the honest reading is 「其他同事」 — the
    // point of this line is that it says ONE of the allowed words, never the handle itself.
    expect(text(row, 'stock-prep-ops-audit-row-who')).toContain('其他同事')

    // The handle DOES surface — deliberately — inside the per-row technical-details disclosure only.
    const detail = node(row, 'stock-prep-ops-audit-row-detail')!
    expect(detail.textContent).toContain(PLANTED_ACTOR)
    expect(detail.textContent).toContain(PLANTED_SUBJECT)
  })

  it('an audit row whose actor equals the caller\'s own id renders 「您」', async () => {
    const root = await mountPanel()
    await search(root, 'P2026-001')

    const selfRow = nodes(root, 'stock-prep-ops-audit-row').find((row) => row.getAttribute('data-who') === 'self')!
    expect(selfRow).toBeTruthy()
    expect(selfRow.getAttribute('data-self')).toBe('true')
    expect(text(selfRow, 'stock-prep-ops-audit-row-who')).toContain('您')
  })

  it('OP-05b: an audit row whose actor is NOT the caller renders 「其他同事」, never a name', async () => {
    const root = await mountPanel()
    await search(root, 'P2026-001')

    const otherRow = nodes(root, 'stock-prep-ops-audit-row').find((row) => row.getAttribute('data-who') === 'other')!
    expect(otherRow.getAttribute('data-self')).toBe('false')
    expect(text(otherRow, 'stock-prep-ops-audit-row-who')).toContain('其他同事')
  })

  it('OP-05c: when the caller\'s OWN id could not be read, no row is claimed for a colleague', async () => {
    // `getCurrentUserId()` goes through bootstrapSession — a network read that can fail. Rendering
    // every row as 「其他同事」 in that case is a positive identification produced by a failed read.
    h.currentUserId = null
    const root = await mountPanel()
    await search(root, 'P2026-001')

    const rows = nodes(root, 'stock-prep-ops-audit-row')
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.getAttribute('data-who')).toBe('unknown_viewer')
      expect(row.getAttribute('data-self')).toBe('unknown')
      expect(text(row, 'stock-prep-ops-audit-row-who')).toContain('不确定是不是您')
      expect(text(row, 'stock-prep-ops-audit-row-who')).not.toContain('其他同事')
    }
  })

  it('OP-05d: a row the store recorded with no actor says so, instead of blaming a colleague', async () => {
    installRoutes({
      audit: (url) => auditResponse(url, [{
        id: 'row-null-actor',
        tenantId: 'tenant-a',
        workspaceId: null,
        projectId: 'P2026-001',
        action: 'generation_run',
        subjectId: null,
        mode: null,
        actor: null,
        detail: {},
        createdAt: '2026-09-01T08:00:00.000Z',
      }]),
    })
    const root = await mountPanel()
    await search(root, 'P2026-001')

    const row = node(root, 'stock-prep-ops-audit-row')!
    expect(row.getAttribute('data-who')).toBe('unknown_actor')
    expect(text(row, 'stock-prep-ops-audit-row-who')).toContain('这条记录没有留下操作者')
    expect(text(row, 'stock-prep-ops-audit-row-who')).not.toContain('其他同事')
  })

  // -------------------------------------------------------------------------
  // OP-11 — the reverse lookup must not filter on a column that is NULL on every row it can match.
  // -------------------------------------------------------------------------

  it('OP-11: the audit request carries tenantId and projectId but NO workspaceId', async () => {
    const root = await mountPanel()
    await search(root, 'P2026-001')

    const auditUrl = urlsMatching('/stock-preparation/audit')[0]
    const query = queryOf(auditUrl)
    expect(query.get('tenantId')).toBe('tenant-a')
    expect(query.get('projectId')).toBe('P2026-001')
    expect(query.has('workspaceId')).toBe(false)
    expect(auditUrl).not.toContain('workspaceId')
  })

  it('OP-11: rows written the way the four project-scoped actions really write them (workspace_id NULL) are actually found', async () => {
    // This is the production shape: `http-routes.cjs` never passes a workspaceId to `audit.append`.
    // A panel that forwarded `scope.workspaceId` would get zero rows here and then explain the empty
    // result away with three caveats, none of which would be the reason.
    const root = await mountPanel()
    await search(root, 'P2026-001')

    expect(nodes(root, 'stock-prep-ops-audit-row').length).toBe(2)
    expect(node(root, 'stock-prep-ops-audit-empty')).toBeNull()
  })

  it('the action filter really filters (anti-vacuity for the query-parsing mock)', async () => {
    const root = await mountPanel()
    const select = node(root, 'stock-prep-ops-audit-action-select') as HTMLSelectElement
    select.value = 'handoff_advance'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    await search(root, 'P2026-001')

    expect(queryOf(urlsMatching('/stock-preparation/audit')[0]).get('action')).toBe('handoff_advance')
    expect(nodes(root, 'stock-prep-ops-audit-row').length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // OP-06 — three-line disclaimer, always present.
  // -------------------------------------------------------------------------

  it('OP-06: the three-line disclaimer renders before any search, and survives every search outcome', async () => {
    const root = await mountPanel()
    expect(nodes(root, 'stock-prep-ops-audit-caveat').length).toBe(3)

    // After a successful, empty search.
    await search(root, 'P2026-999')
    expect(nodes(root, 'stock-prep-ops-audit-caveat').length).toBe(3)

    // After a forbidden search.
    installRoutes({ audit: () => refusal(403, 'FORBIDDEN') })
    node(root, 'stock-prep-ops-audit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(nodes(root, 'stock-prep-ops-audit-caveat').length).toBe(3)
  })

  // -------------------------------------------------------------------------
  // OP-07 — empty-state wording.
  // -------------------------------------------------------------------------

  it('OP-07: the empty state says "not the same as nobody touched it", not a generic empty-data line', async () => {
    const root = await mountPanel()
    await search(root, 'P2026-999')

    const empty = node(root, 'stock-prep-ops-audit-empty')!
    expect(empty.getAttribute('data-empty-state')).toBe('no_entries')
    expect(empty.textContent).toContain('这不等于没有人动过')
  })

  // -------------------------------------------------------------------------
  // OP-08 — 403 wording on the audit search itself, as a §4.3 empty state.
  // -------------------------------------------------------------------------

  it('OP-08: a 403 on the audit search renders "这一格看不了:需要平台管理员" as a not_permitted empty state', async () => {
    installRoutes({ audit: () => refusal(403, 'FORBIDDEN') })
    const root = await mountPanel()
    await search(root, 'P2026-001')

    const forbidden = node(root, 'stock-prep-ops-audit-forbidden')!
    expect(forbidden.getAttribute('data-empty-state')).toBe('not_permitted')
    expect(forbidden.textContent).toContain('这一格看不了')
    expect(forbidden.textContent).toContain('平台管理员')
  })

  it('the search action is disabled until a project number is typed (this lookup is always project-scoped)', async () => {
    const root = await mountPanel()
    const button = node(root, 'stock-prep-ops-audit-search') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    const input = node(root, 'stock-prep-ops-audit-project-input') as HTMLInputElement
    input.value = 'P2026-001'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(button.disabled).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 数据落点 — reuses ②'s already-read data, issues no read of its own.
  // -------------------------------------------------------------------------

  it('数据落点 shows the already-read pack version and object id, with no new network call', async () => {
    const root = await mountPanel()
    const callCountAfterMount = h.apiFetch.mock.calls.length
    expect(text(root, 'stock-prep-ops-data-location-summary')).toContain('备料主表')
    const tech = node(root, 'stock-prep-ops-data-location-tech')!
    expect(tech.textContent).toContain('factory-a')
    expect(tech.textContent).toContain(CANONICAL_OBJECT_ID)
    // ...and it names WHICH table that id is, so the reader is not left to recognise the string.
    expect(tech.textContent).toContain('生产主表')
    expect(h.apiFetch.mock.calls.length).toBe(callCountAfterMount)
  })
})

// ---------------------------------------------------------------------------
// OP-09 — 词表防漏, read from the DB CHECK constraint's own source module (no heavy deps: this file
// only requires `node:crypto`, so a direct `require` is safe — unlike `stock-preparation-source-
// preflight.cjs`, which StockPreparationPosturePlainLanguage.spec.ts deliberately text-scrapes instead
// because IT pulls a heavy dependency chain behind it).
// ---------------------------------------------------------------------------
describe('STOCK_PREP_AUDIT_ACTION_PLAIN (anti-vacuity)', () => {
  const require = createRequire(import.meta.url)
  const storeModule = require('../../../plugins/plugin-integration-core/lib/stock-preparation-audit-store.cjs') as {
    STOCK_PREP_AUDIT_ACTIONS: readonly string[]
  }

  it('reads the shipped 14-action vocabulary (anti-vacuity: the actions really are declared there)', () => {
    expect(storeModule.STOCK_PREP_AUDIT_ACTIONS.length).toBe(14)
  })

  it('carries a plain-language line for EVERY audit action the store vocabulary declares — 词表 key 数 = 动作数', () => {
    const declared = [...storeModule.STOCK_PREP_AUDIT_ACTIONS].sort()
    const translated = Object.keys(STOCK_PREP_AUDIT_ACTION_PLAIN).sort()
    expect(translated.length).toBe(declared.length)
    const missing = declared.filter((action) => !translated.includes(action))
    expect(
      missing,
      `these audit actions have no plain-language line: ${missing.join(', ')}. An admin reading the `
        + 'trail would meet a bare action code — see the file header for why 缺一条 falls back to '
        + '「其他动作(代码)」 rather than crashing.',
    ).toEqual([])
    // ...and no STALE entry for an action the store no longer declares.
    const extra = translated.filter((action) => !declared.includes(action))
    expect(extra, `STOCK_PREP_AUDIT_ACTION_PLAIN has entries for actions the store does not declare: ${extra.join(', ')}`).toEqual([])
  })

  it('every entry resolves in both languages, with non-empty text', () => {
    for (const action of storeModule.STOCK_PREP_AUDIT_ACTIONS) {
      const plain = STOCK_PREP_AUDIT_ACTION_PLAIN[action]
      expect(plain, action).toBeTruthy()
      expect(String(plain.zh ?? '').trim().length, `${action}.zh`).toBeGreaterThan(0)
      expect(String(plain.en ?? '').trim().length, `${action}.en`).toBeGreaterThan(0)
    }
  })
})

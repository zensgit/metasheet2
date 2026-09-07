import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { createRequire } from 'node:module'

// 「记录与排查」面板 (P1-4/P1-5, 设计稿 §6.2 + 线框 E) — 暗装: this spec drives the real component
// over a mocked `apiFetch`, so the real services (audit.ts, deploymentHealth.ts, plus the reused
// sourceBinding.ts / installPlan.ts / sourcePreflight.ts) run underneath it, same discipline as
// StockPreparationSourceBinding.spec.ts.
//
// Guards this file pins:
//   OP-01 六格三态: idle(未检查, neutral) / ready / forbidden|unavailable — never a fourth colour.
//   OP-02 allSettled 隔离: one auto-cell's read failing leaves the other auto-cells rendering fine.
//   OP-03 「未检查」不是绿也不是红 (no success/warning badge class before a manual check runs).
//   OP-04 计划任务恒「未接入监控」— never a success/warning tone, regardless of anything else.
//   OP-05 审计主行零 actor 原值 / 零邮箱 (反向断言) — the raw handle may appear ONLY inside the
//         per-row 技术详情 disclosure, never in the primary time/action/who spans.
//   OP-06 三行免责常驻 — present before a search, mid-search, and after one (every branch).
//   OP-07 空态措辞 — "这不等于没人动过", not a generic "暂无数据".
//   OP-08 403 措辞 — "这一格看不了:需要平台管理员".
//   OP-09 词表防漏 — STOCK_PREP_AUDIT_ACTION_PLAIN carries all 14 actions the .cjs store declares,
//         read from that module directly (anti-vacuity, same discipline as
//         StockPreparationPosturePlainLanguage.spec.ts's manifest read).

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

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function refusal(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code } }), { status })
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

function customerPackCatalogPayload(): Record<string, unknown> {
  return {
    packCount: 1,
    packs: [
      {
        packId: 'factory-a',
        packVersion: '1.0.0',
        targetObjectId: 'sandbox_factory_a_main',
        extensionFields: [],
      },
    ],
  }
}

function customerPackInstallsPayload(): Record<string, unknown> {
  return {
    objectId: 'plm_stock_preparation_main',
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

function sandboxReadinessPayload(ready = true): Record<string, unknown> {
  return { ready, mode: ready ? 'sandbox_existing' : 'sandbox_incomplete', targetBindingAvailable: ready, evidence: {} }
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

interface Routes {
  sourceBinding?: () => Response
  customerPacks?: () => Response
  installs?: () => Response
  sandboxReadiness?: () => Response
  preflight?: () => Response
  sourcePreflight?: () => Response
  audit?: () => Response
}

function installRoutes(routes: Routes = {}): void {
  h.apiFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/stock-preparation/customer-packs/installs')) {
      return routes.installs ? routes.installs() : envelope(customerPackInstallsPayload())
    }
    if (url.includes('/stock-preparation/customer-packs')) {
      return routes.customerPacks ? routes.customerPacks() : envelope(customerPackCatalogPayload())
    }
    if (url.includes('/stock-preparation/sandbox-target/readiness')) {
      return routes.sandboxReadiness ? routes.sandboxReadiness() : envelope(sandboxReadinessPayload())
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
      return routes.audit ? routes.audit() : envelope({ rowCount: 0, entries: [] })
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
    expect(preflightBadge.textContent).toContain('未检查')

    const sourcePreflightCell = node(root, 'stock-prep-ops-cell-source-preflight')!
    expect(sourcePreflightCell.getAttribute('data-cell-status')).toBe('idle')
    expect(sourcePreflightCell.querySelector('.sp-ops__cell-badge')!.className).not.toMatch(/success|warning/)

    // Fences derive from preflight and have not run either — also neutral, also 未检查.
    const fencesCell = node(root, 'stock-prep-ops-cell-fences')!
    expect(fencesCell.querySelector('.sp-ops__cell-badge')!.className).not.toMatch(/success|warning/)
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
    const fenceCalls = h.apiFetch.mock.calls.filter(([input]) => String(input).includes('/preflight') && !String(input).includes('source-preflight'))
    expect(fenceCalls.length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // OP-02 — allSettled isolation: one of the three auto reads fails, the other two still render.
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
    expect(packsCell.textContent).toContain('沙箱表已就绪')
  })

  it('OP-02/OP-08: customer-packs catalog read is 403 — that cell says who can see it; source cell is unaffected', async () => {
    installRoutes({
      customerPacks: () => refusal(403, 'FORBIDDEN'),
    })
    const root = await mountPanel()

    const packsCell = node(root, 'stock-prep-ops-cell-packs')!
    expect(packsCell.getAttribute('data-cell-status')).toBe('forbidden')
    expect(packsCell.textContent).toContain('需要平台管理员')

    const sourceCell = node(root, 'stock-prep-ops-cell-source')!
    expect(sourceCell.getAttribute('data-cell-status')).toBe('ready')
  })

  it('a deployment with zero configured packs skips the sandbox-readiness read honestly (idle, not a failure)', async () => {
    installRoutes({
      customerPacks: () => envelope({ packCount: 0, packs: [] }),
      installs: () => envelope({ objectId: 'plm_stock_preparation_main', rowCount: 0, installs: [] }),
    })
    const root = await mountPanel()

    expect(node(root, 'stock-prep-ops-cell-packs')!.getAttribute('data-cell-status')).toBe('ready')
    expect(text(root, 'stock-prep-ops-cell-packs')).toContain('还没有配置客户列包')
    // No third call was ever made — there was no objectId to ask sandbox-target/readiness about.
    expect(h.apiFetch.mock.calls.some(([input]) => String(input).includes('sandbox-target/readiness'))).toBe(false)
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
    expect(h.apiFetch.mock.calls.some(([input]) => String(input).includes('scheduled'))).toBe(false)
  })

  // -------------------------------------------------------------------------
  // OP-05 — the reverse assertion: actor / email never in the primary audit row.
  // -------------------------------------------------------------------------

  const PLANTED_ACTOR = 'ops.leader@example-corp.internal'
  const PLANTED_SUBJECT = 'sha16-deadbeef01'

  it('OP-05: the primary audit row never renders the raw actor handle or an email; it lives ONLY in 技术详情', async () => {
    installRoutes({
      audit: () => envelope({
        rowCount: 1,
        entries: [{
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
        }],
      }),
    })
    const root = await mountPanel()
    const input = node(root, 'stock-prep-ops-audit-project-input') as HTMLInputElement
    input.value = 'P2026-001'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    node(root, 'stock-prep-ops-audit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    const row = node(root, 'stock-prep-ops-audit-row')!
    // Primary spans only.
    const primaryText = [
      text(row, 'stock-prep-ops-audit-row-time'),
      text(row, 'stock-prep-ops-audit-row-action'),
      text(row, 'stock-prep-ops-audit-row-who'),
    ].join(' ')
    expect(primaryText).not.toContain(PLANTED_ACTOR)
    expect(primaryText).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
    // PLANTED_ACTOR is not the mocked caller (`u_me`), so the honest reading is 「其他同事」 — the
    // point of this line is that it says ONE of the two allowed words, never the handle itself.
    expect(text(row, 'stock-prep-ops-audit-row-who')).toContain('其他同事')

    // The handle DOES surface — deliberately — inside the per-row technical-details disclosure only.
    const detail = node(row, 'stock-prep-ops-audit-row-detail')!
    expect(detail.textContent).toContain(PLANTED_ACTOR)
    expect(detail.textContent).toContain(PLANTED_SUBJECT)
  })

  it('an audit row whose actor equals the caller\'s own id renders 「您」', async () => {
    installRoutes({
      audit: () => envelope({
        rowCount: 1,
        entries: [{
          id: 'row-self', action: 'prep_line_export', subjectId: null, mode: null,
          actor: 'u_me', detail: {}, createdAt: '2026-09-01T11:00:00.000Z',
        }],
      }),
    })
    const root = await mountPanel()
    const input = node(root, 'stock-prep-ops-audit-project-input') as HTMLInputElement
    input.value = 'P2026-001'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    node(root, 'stock-prep-ops-audit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    const row = node(root, 'stock-prep-ops-audit-row')!
    expect(row.getAttribute('data-self')).toBe('true')
    expect(text(row, 'stock-prep-ops-audit-row-who')).toContain('您')
  })

  it('OP-05b: an audit row whose actor is NOT the caller renders 「其他同事」, never a name', async () => {
    installRoutes({
      audit: () => envelope({
        rowCount: 1,
        entries: [{
          id: 'row-2', action: 'generation_run', subjectId: null, mode: 'confirmation_reconcile_requested',
          actor: 'someone.else@example-corp.internal', detail: {}, createdAt: '2026-09-01T09:00:00.000Z',
        }],
      }),
    })
    const root = await mountPanel()
    const input = node(root, 'stock-prep-ops-audit-project-input') as HTMLInputElement
    input.value = 'P2026-001'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    node(root, 'stock-prep-ops-audit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    const row = node(root, 'stock-prep-ops-audit-row')!
    expect(row.getAttribute('data-self')).toBe('false')
    expect(text(row, 'stock-prep-ops-audit-row-who')).toContain('其他同事')
  })

  // -------------------------------------------------------------------------
  // OP-06 — three-line disclaimer, always present.
  // -------------------------------------------------------------------------

  it('OP-06: the three-line disclaimer renders before any search, and survives every search outcome', async () => {
    const root = await mountPanel()
    expect(nodes(root, 'stock-prep-ops-audit-caveat').length).toBe(3)

    // After a successful, empty search.
    const input = node(root, 'stock-prep-ops-audit-project-input') as HTMLInputElement
    input.value = 'P2026-999'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    node(root, 'stock-prep-ops-audit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
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
    const input = node(root, 'stock-prep-ops-audit-project-input') as HTMLInputElement
    input.value = 'P2026-999'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    node(root, 'stock-prep-ops-audit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    const empty = node(root, 'stock-prep-ops-audit-empty')!
    expect(empty.getAttribute('data-empty-state')).toBe('no_entries')
    expect(empty.textContent).toContain('这不等于没有人动过')
  })

  // -------------------------------------------------------------------------
  // OP-08 — 403 wording on the audit search itself.
  // -------------------------------------------------------------------------

  it('OP-08: a 403 on the audit search renders "这一格看不了:需要平台管理员"', async () => {
    installRoutes({ audit: () => refusal(403, 'FORBIDDEN') })
    const root = await mountPanel()
    const input = node(root, 'stock-prep-ops-audit-project-input') as HTMLInputElement
    input.value = 'P2026-001'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    node(root, 'stock-prep-ops-audit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    expect(text(root, 'stock-prep-ops-audit-forbidden')).toContain('这一格看不了')
    expect(text(root, 'stock-prep-ops-audit-forbidden')).toContain('平台管理员')
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
    expect(tech.textContent).toContain('plm_stock_preparation_main')
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

  it('carries a plain-language line for EVERY audit action the store vocabulary declares — 渲染条目数 = 词表 key 数', () => {
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

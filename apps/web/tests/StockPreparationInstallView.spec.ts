import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// BOM备料 安装页 — the DOM half.
//
// §14 of docs/development/platform-overall-design/multitable-application-model-20260830.md:
// "安装不是「填表」,是「看默认值并确认」". This suite drives the real component over a mocked
// `apiFetch`, so the real services (installPlan.ts / installRun.ts) run underneath it.
//
// Guards (each RED-witnessed by mutation; see the PR body's mutation table):
//   V-01 every §14 row renders FROM the served manifest — display names, the read-only objectIds and
//        permission codes with their locked tags, config surfaces marked deployment data, the four
//        fences, the acceptance criteria
//   V-02 the defaults section is a READING, not a form: no input/select/textarea anywhere in it, and
//        no control at all beside a fence
//   V-03 a preflight blocker renders its code and the route's own paste-able `fix.run`, VERBATIM
//   V-04 SKIP IS RENDERED — a held step and a "deployment data not supplied yet" step both show as
//        SKIP with their reason, and the run still reports no failure
//   V-05 R-11: the run control renders only for a platform admin; a workbench admin sees the
//        defaults, the preflight and a line saying who runs it
//   V-06 stop-on-FAIL still renders every step that completed
//   V-07 VALUES-FREE: business values planted throughout the payloads never reach the DOM

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: [] as string[],
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

// Exact-code matching, the same double the workspace shell spec uses: the permission LADDER lives in
// workbenchAccess.ts and is exercised by stockPrepPermissionMatrix.spec.ts, so reproducing it here
// would only give the two a way to drift.
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    hasPermission: (permission: string) => h.permissions.includes(permission),
    hasAdminAccess: () => false,
    getAccessSnapshot: () => ({ isAdmin: false, roles: [], permissions: h.permissions }),
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import StockPreparationInstallView from '../src/components/integration/stockPreparation/StockPreparationInstallView.vue'

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }

/** Planted business values / credentials. None may reach the DOM. */
const PLANTED_DRAWING_NO = 'DWG-51190-C'
const PLANTED_MATERIAL_CODE = 'MAT-KK7781'
const PLANTED_PROJECT_NAME = '涡轮增压器总成'
const PLANTED_DSN = 'sqlserver://sa:hunter2@10.2.3.4/PLM'
const FORBIDDEN = [PLANTED_DRAWING_NO, PLANTED_MATERIAL_CODE, PLANTED_PROJECT_NAME, PLANTED_DSN]

const LEDGER_OBJECT_ID = 'plm_stock_preparation_confirmation_decision'
const SANDBOX_NAMESPACE = 'plm_stock_preparation_sandbox'
const PACKS_PATH_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH'
const B2A_ENV = 'INTEGRATION_CORE_B2A_REGISTRY_PATH'

/** The catalog payload, shaped like the widened /api/platform/apps projection. */
function manifestPayload(): Record<string, unknown> {
  return {
    id: 'stock-preparation',
    displayName: 'BOM备料',
    version: '0.1.0',
    valueStatement: '从 PLM 拉取项目 BOM,逐层展开为备料明细;冲突交人工确认,人工列永不被系统覆盖。',
    permissions: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin'],
    permissionPolicy: {
      automaticHolders: [],
      note: 'R-11 映射零自动:安装只把三个码种子化,持有者为零。',
    },
    objects: [
      {
        id: 'confirmationDecisionLedger',
        name: '备料确认账本',
        backing: 'multitable',
        objectIdPolicy: 'fixed',
        objectId: LEDGER_OBJECT_ID,
        displayNames: { 'zh-CN': '备料确认账本', en: 'Stock Preparation Confirmation Decision' },
        columnCount: 16,
        ensure: { idempotent: true, method: 'POST', path: '/api/integration/stock-preparation/confirmation-decisions/ensure' },
        note: '受管对象,按需创建。',
      },
      {
        id: 'sandboxTarget',
        name: '备料沙箱目标表',
        backing: 'multitable',
        objectIdPolicy: 'from-config',
        objectIdNamespace: SANDBOX_NAMESPACE,
        objectIdFrom: { configSurface: 'customerPack', field: 'targetObjectId' },
        displayNames: { 'zh-CN': '备料沙箱目标表', en: 'PLM Stock Preparation Sandbox' },
        columnCount: 25,
        ensure: { idempotent: true, method: 'POST', path: '/api/integration/stock-preparation/sandbox-target/ensure' },
      },
    ],
    configSurfaces: [
      {
        id: 'customerPack',
        name: '客户包(装 ext_ 列与字典)',
        kind: 'deployment-data-file',
        envVar: PACKS_PATH_ENV,
        serverConfigKey: 'stockPreparationCustomerPacks',
        committed: false,
        note: '部署期数据,永不入库、永不经请求、永不进仓库。',
      },
    ],
    posture: {
      mode: 'reported-not-installed',
      installerMayModify: false,
      note: '这四道围栏只报状态,永远没有「修复」按钮。',
      entries: [
        { id: 'productionApply', expectedState: 'closed', what: '生产 Apply 关闭。' },
        { id: 'b2aTrialRegistry', expectedState: 'dormant', envVar: B2A_ENV, what: 'B2a 试用登记休眠。' },
      ],
    },
    acceptance: {
      verifiedBy: { script: 'scripts/ops/stock-prep-acceptance-bootstrap.mjs' },
      runbook: 'docs/development/takeover-beiliao-20260821/r6-upgrade-222-runbook.md',
      criteria: [
        { id: 'ext-columns-written-human-band-untouched', statement: 'ext_ 列出现非空值,而 human_preserved 一档保持为空。' },
        { id: 'second-refresh-all-skip', statement: '同配置的第二次 dry-run 计划全部为 skip。' },
      ],
    },
    // Planted: a projection that stringified the payload rather than reading named fields would
    // carry these into the DOM.
    instance: { config: { dsn: PLANTED_DSN, projectName: PLANTED_PROJECT_NAME } },
  }
}

const LEDGER_FIX = 'POST /api/integration/stock-preparation/confirmation-decisions/ensure {}'

function preflightPayload(options: { ready?: boolean } = {}): Record<string, unknown> {
  const ready = options.ready !== false
  return {
    ready,
    blockerCount: ready ? 0 : 1,
    blockers: ready ? [] : [{
      code: 'STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY',
      what: `账本表尚未创建(drawing ${PLANTED_DRAWING_NO} 无关)`.replace(PLANTED_DRAWING_NO, 'n/a'),
      fix: {
        kind: 'http',
        method: 'POST',
        path: '/api/integration/stock-preparation/confirmation-decisions/ensure',
        body: {},
        run: LEDGER_FIX,
      },
    }],
    posture: {
      productionApply: { state: 'closed' },
      k3ExternalWrite: { state: 'permanently_disabled' },
      b2aTrialRegistry: { state: 'dormant', envVar: B2A_ENV },
      outboundHttpWrite: { state: 'unset', envVar: 'INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS' },
    },
  }
}

interface RouteBehaviour {
  preflightReady?: boolean
  packs?: Array<Record<string, unknown>>
  ledgerStatus?: number
}

function installRoutes(behaviour: RouteBehaviour = {}): void {
  const envelope = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify({ ok: status < 400, data }), { status })

  h.apiFetch.mockImplementation(async (input: string) => {
    const url = String(input)
    if (url.includes('/api/platform/apps/stock-preparation')) {
      return new Response(JSON.stringify(manifestPayload()), { status: 200 })
    }
    if (url.includes('/stock-preparation/preflight')) {
      return envelope(preflightPayload({ ready: behaviour.preflightReady }))
    }
    if (url.includes('/confirmation-decisions/ensure')) {
      const status = behaviour.ledgerStatus ?? 200
      return status >= 400
        ? new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }), { status })
        : envelope({ mode: 'exists', projectName: PLANTED_PROJECT_NAME })
    }
    if (url.includes('/stock-preparation/customer-packs')) {
      const packs = behaviour.packs ?? []
      return envelope({ packCount: packs.length, packs })
    }
    if (url.includes('/sandbox-target/ensure')) {
      return envelope({ mode: 'exists', ready: true, dsn: PLANTED_DSN })
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

describe('BOM备料 install page (§14 defaults for confirmation)', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['stock-prep:admin']
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

  async function mountView(): Promise<HTMLDivElement> {
    app = createApp(StockPreparationInstallView as Component, { scope: SCOPE })
    app.mount(container!)
    await flush()
    return container!
  }

  function text(root: HTMLElement, selector: string): string {
    return (root.querySelector(selector) as HTMLElement | null)?.textContent ?? ''
  }

  // ---------------------------------------------------------------------------
  // V-01 the defaults
  // ---------------------------------------------------------------------------

  it('V-01: renders every §14 row from the served manifest', async () => {
    const root = await mountView()
    const defaultsSection = root.querySelector('[data-testid="stock-prep-install-defaults"]') as HTMLElement
    expect(defaultsSection).not.toBeNull()

    // Identity + the display name the owner set (read from the manifest, never restated here).
    expect(text(root, '[data-testid="stock-prep-install-app"]')).toContain('BOM备料')
    expect(text(root, '[data-testid="stock-prep-install-app"]')).toContain('stock-preparation')

    // Managed tables: display name (customer vocabulary) + the id nobody may retype.
    const objectRows = root.querySelectorAll('[data-testid="stock-prep-install-object-row"]')
    expect(objectRows.length).toBe(2)
    expect(defaultsSection.textContent).toContain('备料确认账本')
    expect(text(root, '[data-testid="stock-prep-install-object-id"]')).toContain(LEDGER_OBJECT_ID)
    // The from-config object shows its NAMESPACE and where the concrete id comes from — the two
    // facts that stopped operators inventing table names.
    expect(text(root, '[data-testid="stock-prep-install-object-namespace"]')).toContain(SANDBOX_NAMESPACE)
    expect(defaultsSection.textContent).toContain('customerPack.targetObjectId')
    // ...and both id cells are tagged read-only.
    expect(objectRows[0].textContent).toContain('不可改')

    // Permission codes, and R-11's zero automatic holders stated rather than inferred.
    const permissions = text(root, '[data-testid="stock-prep-install-permissions"]')
    for (const code of ['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin']) {
      expect(permissions).toContain(code)
    }
    expect(permissions).toContain('不可改')
    expect(text(root, '[data-testid="stock-prep-install-permission-holders"]')).toContain('零自动持有')

    // Config surfaces: marked deployment data, named by their ENV VAR (never a value).
    const surface = root.querySelector('[data-testid="stock-prep-install-config-surface"]') as HTMLElement
    expect(surface.textContent).toContain('部署期数据')
    expect(surface.textContent).toContain(PACKS_PATH_ENV)

    // Fences: shown, with the contract that no installer may arm one.
    const fences = root.querySelectorAll('[data-testid="stock-prep-install-posture-entry"]')
    expect(fences.length).toBe(2)
    expect(fences[0].textContent).toContain('productionApply')
    expect(fences[0].textContent).toContain('closed')
    expect(text(root, '[data-testid="stock-prep-install-no-switch"]')).toContain('无开关')
    expect(text(root, '[data-testid="stock-prep-install-installer-may-modify"]')).toContain('false')

    // Acceptance: what "installed" means, and who proves it.
    const acceptance = text(root, '[data-testid="stock-prep-install-acceptance"]')
    expect(acceptance).toContain('ext-columns-written-human-band-untouched')
    expect(acceptance).toContain('second-refresh-all-skip')
    expect(defaultsSection.textContent).toContain('scripts/ops/stock-prep-acceptance-bootstrap.mjs')
  })

  // ---------------------------------------------------------------------------
  // V-02 a reading, not a form
  // ---------------------------------------------------------------------------

  it('V-02: the defaults are a READING — no field to fill and no switch beside a fence', async () => {
    const root = await mountView()
    const defaultsSection = root.querySelector('[data-testid="stock-prep-install-defaults"]') as HTMLElement

    // §14's judgement criterion: "客户全程零填空". A rename box here would also contradict §12 —
    // display names are adjusted in the multitable, and the page says so instead of offering one.
    expect(defaultsSection.querySelectorAll('input').length).toBe(0)
    expect(defaultsSection.querySelectorAll('select').length).toBe(0)
    expect(defaultsSection.querySelectorAll('textarea').length).toBe(0)
    // §4: "posture 四项只展示,永无「修复」按钮" — and the whole defaults panel carries no control.
    expect(defaultsSection.querySelectorAll('button').length).toBe(0)
    expect(text(root, '[data-testid="stock-prep-install-edit-note"]')).toContain('多维表')
  })

  // ---------------------------------------------------------------------------
  // V-03 the preflight and its verbatim fixes
  // ---------------------------------------------------------------------------

  it('V-03: a blocker renders its code and the route\'s own paste-able fix line, verbatim', async () => {
    installRoutes({ preflightReady: false })
    const root = await mountView()

    ;(root.querySelector('[data-testid="stock-prep-install-preflight-run"]') as HTMLButtonElement).click()
    await flush()

    expect(text(root, '[data-testid="stock-prep-install-preflight-result"]')).toContain('未就绪')
    const blocker = root.querySelector('[data-testid="stock-prep-install-blocker"]') as HTMLElement
    expect(blocker.textContent).toContain('STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY')
    // VERBATIM — the operator copies this line; rewriting it would be rewriting the fix.
    expect(text(root, '[data-testid="stock-prep-install-blocker-fix"]').trim()).toBe(LEDGER_FIX)

    // Posture is reported below, states only, and with no control anywhere near it.
    const fences = root.querySelectorAll('[data-testid="stock-prep-install-preflight-posture"]')
    expect(fences.length).toBe(4)
    const preflightPanel = root.querySelector('[data-testid="stock-prep-install-preflight"]') as HTMLElement
    // One button in the whole panel: "run preflight". No fix button, no arm button.
    expect(preflightPanel.querySelectorAll('button').length).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // V-04 SKIP IS RENDERED
  // ---------------------------------------------------------------------------

  it('V-04: SKIP is rendered with its reason — a held plan is human work, not a broken install', async () => {
    h.permissions = ['stock-prep:admin', 'integration:admin']
    // Deployment data not supplied yet: the ledger provisions, the pack catalog is empty.
    installRoutes({ packs: [] })
    const root = await mountView()

    ;(root.querySelector('[data-testid="stock-prep-install-run"]') as HTMLButtonElement).click()
    await flush(14)

    const stepsByKey = new Map<string, HTMLElement>()
    for (const node of root.querySelectorAll('[data-testid="stock-prep-install-step"]')) {
      stepsByKey.set((node as HTMLElement).dataset.step as string, node as HTMLElement)
    }
    expect(stepsByKey.size).toBe(9)

    // The dynamic SKIP: the ledger IS provisioned and the reason says the pack is what is missing.
    const managed = stepsByKey.get('managed-tables')!
    expect(managed.dataset.status).toBe('skip')
    expect(managed.textContent).toContain('SKIP')
    expect(managed.textContent).toContain('客户包未配置')
    expect(managed.textContent).toContain('ledgerMode=exists')

    // The five HELD steps: each SKIP, each carrying the reason it is held.
    for (const key of ['source-wiring', 'confirmation-queue', 'acceptance-dry-run', 'acceptance-apply', 'acceptance-idempotent']) {
      const node = stepsByKey.get(key)!
      expect(node.dataset.status, `${key} must render as SKIP`).toBe('skip')
      expect((node.textContent ?? '').length, `${key} must say why it is held`).toBeGreaterThan(20)
    }
    // ...and the queue names the load-bearing order it is part of.
    expect(stepsByKey.get('confirmation-queue')!.textContent).toContain('先排空')

    // A run of OK + SKIP has NOT failed. Saying so is the whole point of a first-class SKIP.
    const summary = text(root, '[data-testid="stock-prep-install-summary"]')
    expect(summary).toContain('FAIL 0')
    expect(summary).toContain('无失败')
    expect(root.querySelectorAll('[data-status="fail"]').length).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // V-05 R-11 on the run control
  // ---------------------------------------------------------------------------

  it('V-05: the run control is platform-admin only; a workbench admin is told who runs it', async () => {
    h.permissions = ['stock-prep:admin']
    const workbenchAdmin = await mountView()
    expect(workbenchAdmin.querySelector('[data-testid="stock-prep-install-run"]')).toBeNull()
    expect(text(workbenchAdmin, '[data-testid="stock-prep-install-run-denied"]')).toContain('平台管理员')
    // ...but the defaults and the preflight ARE theirs: nothing on this page 403s for them.
    expect(workbenchAdmin.querySelector('[data-testid="stock-prep-install-defaults"]')).not.toBeNull()
    expect(workbenchAdmin.querySelector('[data-testid="stock-prep-install-preflight-run"]')).not.toBeNull()

    if (app) app.unmount()
    app = null
    container!.innerHTML = ''

    h.permissions = ['stock-prep:admin', 'integration:admin']
    const platformAdmin = await mountView()
    expect(platformAdmin.querySelector('[data-testid="stock-prep-install-run"]')).not.toBeNull()
    expect(platformAdmin.querySelector('[data-testid="stock-prep-install-run-denied"]')).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // V-06 stop on FAIL, render what completed
  // ---------------------------------------------------------------------------

  it('V-06: a FAIL stops the run and everything that completed stays on screen', async () => {
    h.permissions = ['stock-prep:admin', 'integration:admin']
    installRoutes({ ledgerStatus: 403 })
    const root = await mountView()

    ;(root.querySelector('[data-testid="stock-prep-install-run"]') as HTMLButtonElement).click()
    await flush(14)

    const preflightStep = root.querySelector('[data-testid="stock-prep-install-step"][data-step="preflight"]') as HTMLElement
    expect(preflightStep.dataset.status).toBe('ok')
    const managed = root.querySelector('[data-testid="stock-prep-install-step"][data-step="managed-tables"]') as HTMLElement
    expect(managed.dataset.status).toBe('fail')
    expect(managed.textContent).toContain('status=403')
    // Steps after the failure are listed but never ran.
    const pack = root.querySelector('[data-testid="stock-prep-install-step"][data-step="customer-pack"]') as HTMLElement
    expect(pack.dataset.status).toBe('pending')
    expect(text(root, '[data-testid="stock-prep-install-summary"]')).toContain('managed-tables')
  })

  // ---------------------------------------------------------------------------
  // V-07 values-free
  // ---------------------------------------------------------------------------

  it('V-07: no planted business value or credential reaches the DOM', async () => {
    h.permissions = ['stock-prep:admin', 'integration:admin']
    installRoutes({ preflightReady: false, packs: [] })
    const root = await mountView()
    ;(root.querySelector('[data-testid="stock-prep-install-preflight-run"]') as HTMLButtonElement).click()
    await flush()
    ;(root.querySelector('[data-testid="stock-prep-install-run"]') as HTMLButtonElement).click()
    await flush(14)

    const rendered = root.textContent ?? ''
    for (const forbidden of FORBIDDEN) {
      expect(rendered, `values-free: "${forbidden}" reached the DOM`).not.toContain(forbidden)
    }
    // Positive control: the page IS populated, so the assertion above is not vacuous.
    expect(rendered).toContain(LEDGER_OBJECT_ID)
    expect(rendered).toContain('STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY')
  })
})

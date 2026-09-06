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
//   V-08 a 2xx that is not this API's envelope renders FAIL — a gateway answering 200 with HTML must
//        never read as a provisioned table
//
// V-03 also covers the polluted-allowlist COUNT: the server withholds any sandbox write-allowlist
// entry outside the namespace, so the page can only ever report how many there were.

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

function preflightPayload(options: { ready?: boolean; polluted?: number } = {}): Record<string, unknown> {
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
    checks: {
      // The count the server reports when the sandbox write-allowlist env holds something that is
      // not a sandbox objectId. The entries themselves never cross — the plugin filters them out
      // before the response exists (stock-preparation-preflight.cjs; plugin suite P-15).
      sandboxWriteAuthorization: { droppedNonNamespaceEntries: options.polluted ?? 0 },
    },
  }
}

/** Minimal well-formed source-preflight payload — only the fields the copilot-signals derivation reads. */
function sourcePreflightPayload(): Record<string, unknown> {
  return {
    ok: true,
    verdict: 'go',
    externalSystemId: 'plm-1',
    readPlanId: 'plan-1',
    rowCap: 200,
    checks: {
      reachability: { reachable: true, objectsProbed: 2, objectsAnswered: 2, failureCode: null },
      projectData: {
        entryObject: null, entryObjectPresent: true, matchField: 'x', rowsObserved: 1, exact: true,
        populatedMatchRows: 1, nodeTypeColumn: null, projectNodeType: null, projectNodeRows: null,
        hasProjectNumbers: true, livenessSamples: [], errorCode: null,
      },
      bomData: {
        bomHeadObject: null, bomHeadRows: 1, bomHeadExact: true, bomHeadPresent: true,
        bomDetailObject: null, bomDetailRows: 1, bomDetailExact: true, bomDetailPresent: true, hasBomRows: true,
      },
      bomStore: {
        store: 'bom-details', reason: 'ok', signals: [], strongSignals: [], volumeUndecidableAtCap: false,
        rowCap: 200, authorityBasis: null, dominanceRatio: 1, minLines: 0, candidates: [],
      },
      topology: {
        detectedBridge: 'order-module', reason: 'ok', bridgeSource: 'measured', declaredBridge: null,
        declarationContradictsMeasurement: false, measuredBridge: 'order-module', undecidableAtCap: false,
        rowCap: 200, configuredBridge: 'order-module', matchesConfigured: true, dominanceRatio: 1,
        minLines: 0, candidates: [],
      },
      presetMatch: {
        matchedBy: 'signature', presetId: null, reason: 'ok', tablesAnswered: 2,
        matchedSignatureTables: 0, requiredSignatureTables: null, missingSignatureTables: [],
      },
      quantityField: {
        carrierObject: null, carrierStore: 'bom-details', carrierUndecided: false, carrierShape: 'columnar-numeric',
        jsonSlotColumn: null, jsonFamilySlotKeys: [], jsonOtherKeyCount: 0, jsonPopulatedSlotRows: 0,
        slotsUndetectable: false, configuredField: 'qty', dictionaryObject: null, dictionaryReadable: false,
        dictionaryKeyColumn: null, dictionaryEnabledRows: 0, dictionarySlot: null, measuredSlot: 'qty',
        measuredNumericRatio: 0.9, measuredCandidates: [], qualifyingSlots: [], measuredAmbiguous: false,
        configuredAmongCandidates: true, resolvedSlot: 'qty', readingsAgree: true, matchesConfigured: true,
        numericDensityFloor: 0.5,
      },
    },
    blockers: [],
    warnings: [],
    probes: [
      { role: 'project', object: 'plm_order_head', present: true, rowsObserved: 5, exact: true, columns: ['proj_no', 'status'], errorCode: null },
      { role: 'bomDetail', object: 'plm_bom_detail', present: true, rowsObserved: 12, exact: true, columns: ['material_code', 'qty', 'status'], errorCode: null },
    ],
  }
}

interface RouteBehaviour {
  preflightReady?: boolean
  pollutedAllowlistCount?: number
  packs?: Array<Record<string, unknown>>
  ledgerStatus?: number
  sourcePreflight?: boolean
}

function installRoutes(behaviour: RouteBehaviour = {}): void {
  const envelope = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify({ ok: status < 400, data }), { status })

  h.apiFetch.mockImplementation(async (input: string) => {
    const url = String(input)
    if (url.includes('/api/platform/apps/stock-preparation')) {
      return new Response(JSON.stringify(manifestPayload()), { status: 200 })
    }
    if (url.includes('/stock-preparation/source-preflight')) {
      return envelope(sourcePreflightPayload())
    }
    if (url.includes('/stock-preparation/preflight')) {
      return envelope(preflightPayload({ ready: behaviour.preflightReady, polluted: behaviour.pollutedAllowlistCount }))
    }
    if (url.includes('/confirmation-decisions/ensure')) {
      const status = behaviour.ledgerStatus ?? 200
      return status >= 400
        ? new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }), { status })
        : envelope({ mode: 'confirmation_decision_existing', projectName: PLANTED_PROJECT_NAME })
    }
    if (url.includes('/stock-preparation/customer-packs')) {
      const packs = behaviour.packs ?? []
      return envelope({ packCount: packs.length, packs })
    }
    if (url.includes('/sandbox-target/ensure')) {
      return envelope({ mode: 'sandbox_existing', ready: true, dsn: PLANTED_DSN })
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
    // ...each led by WHAT THE HOLDER CAN DO, not by the code (2026-08-31 plain-language wave).
    expect(permissions).toContain('填写数据')
    expect(permissions).toContain('管理表结构')
    // R-11's zero automatic holders, said the way the person reading it needs to hear it: nobody
    // holds these yet and an admin has to assign them. The manifest's own wording is not lost — it
    // is in the panel's 技术详情 disclosure, asserted below.
    const holders = text(root, '[data-testid="stock-prep-install-permission-holders"]')
    expect(holders).toContain('暂无人持有')
    expect(holders).toContain('管理员')

    // Config surfaces: what has to be set up on the server, named by their ENV VAR (never a value).
    const surface = root.querySelector('[data-testid="stock-prep-install-config-surface"]') as HTMLElement
    expect(surface.textContent).toContain('装在服务器上')
    expect(surface.textContent).toContain(PACKS_PATH_ENV)

    // Fences: shown, with the contract that no installer may arm one.
    const fences = root.querySelectorAll('[data-testid="stock-prep-install-posture-entry"]')
    expect(fences.length).toBe(2)
    expect(fences[0].textContent).toContain('productionApply')
    expect(fences[0].textContent).toContain('closed')
    // §4's 「只展示,无开关」 contract, said as a promise rather than as a posture name: this page
    // reports the boundaries and offers no switch, and an unset/closed reading is the correct one.
    const noSwitch = text(root, '[data-testid="stock-prep-install-no-switch"]')
    expect(noSwitch).toContain('没有开关')
    expect(noSwitch).toContain('不是漏配')
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

  it('V-03: a polluted sandbox allowlist is reported as a COUNT — the page never receives the entries', async () => {
    // The server withholds any allowlist entry outside the sandbox namespace before the response
    // exists (stock-preparation-preflight.cjs; plugin suite P-15 proves it, including with a
    // connection string seeded into that env). All this side can ever have is the count, and it must
    // say so rather than leave a polluted deployment looking clean.
    installRoutes({ preflightReady: false, pollutedAllowlistCount: 3 })
    const root = await mountView()
    ;(root.querySelector('[data-testid="stock-prep-install-preflight-run"]') as HTMLButtonElement).click()
    await flush()

    const notice = text(root, '[data-testid="stock-prep-install-allowlist-polluted"]')
    expect(notice).toContain('3')
    expect(notice).toContain('命名空间')

    // ...and a clean deployment gets no notice at all: the line has to distinguish states.
    if (app) app.unmount()
    app = null
    container!.innerHTML = ''
    installRoutes({ preflightReady: false })
    const clean = await mountView()
    ;(clean.querySelector('[data-testid="stock-prep-install-preflight-run"]') as HTMLButtonElement).click()
    await flush()
    expect(clean.querySelector('[data-testid="stock-prep-install-allowlist-polluted"]')).toBeNull()
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
    expect(managed.textContent).toContain('ledgerMode=confirmation_decision_existing')

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
    // The verdict answers 「装好了吗?」 in words before the tally that an implementer scans for.
    expect(summary).toContain('没有失败')
    expect(text(root, '[data-testid="stock-prep-install-verdict"]')).toContain('装好了')
    expect(root.querySelectorAll('[data-status="fail"]').length).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // COPILOT SIGNALS — the dead-control fix: 获取列映射建议 must not be permanently disabled.
  // ---------------------------------------------------------------------------

  it('copilot signals stay null (button stays disabled, empty-state copy shows) until a source preflight lands', async () => {
    h.permissions = ['stock-prep:admin', 'integration:admin']
    installRoutes()
    const root = await mountView()

    const propose = root.querySelector('[data-testid="copilot-propose"]') as HTMLButtonElement
    expect(propose).not.toBeNull()
    expect(propose.disabled).toBe(true)
    expect(root.textContent || '').toContain('尚无来源结构信号')
  })

  it('copilot signals become non-null and the propose button enables once the source preflight succeeds', async () => {
    h.permissions = ['stock-prep:admin', 'integration:admin']
    installRoutes()
    const root = await mountView()

    const runSource = root.querySelector('[data-testid="stock-prep-source-preflight-run"]') as HTMLButtonElement
    expect(runSource).not.toBeNull()
    runSource.click()
    await flush()

    const propose = root.querySelector('[data-testid="copilot-propose"]') as HTMLButtonElement
    expect(propose.disabled).toBe(false)
    expect(root.textContent || '').not.toContain('尚无来源结构信号')
  })

  // ---------------------------------------------------------------------------
  // V-09 / V-10 — the two behaviours the plain-language rewrite must not regress
  // ---------------------------------------------------------------------------

  it('V-09: a skipped step still renders its REASON — the sentence that stops SKIP reading as failure', async () => {
    // The rewrite turned `SKIP` into 跳过 and put the raw token beside it. The load-bearing half is
    // NOT the badge: it is the reason underneath, which says why this step was skipped and whether
    // that is a problem. A SKIP with no reason is indistinguishable from a broken install, which is
    // the exact confusion this page existed to cause and now exists to prevent.
    h.permissions = ['stock-prep:admin', 'integration:admin']
    installRoutes({ packs: [] })
    const root = await mountView()
    ;(root.querySelector('[data-testid="stock-prep-install-run"]') as HTMLButtonElement).click()
    await flush(14)

    const managed = root.querySelector(
      '[data-testid="stock-prep-install-step"][data-step="managed-tables"]',
    ) as HTMLElement
    expect(managed.dataset.status).toBe('skip')
    // 跳过, in words, in the colour the panel already uses for that state.
    expect(managed.textContent).toContain('跳过')

    const reason = managed.querySelector('[data-testid="stock-prep-install-step-reason"]') as HTMLElement
    expect(reason, 'a skipped step must carry a reason element').not.toBeNull()
    const reasonText = (reason.textContent ?? '').trim()
    expect(reasonText.length, 'the reason must not be blank').toBeGreaterThan(20)
    expect(reasonText).toContain('客户包未配置')
    // ...and it must say this is outstanding work rather than a failure.
    expect(reasonText).toContain('不是安装失败')

    // Every HELD step carries one too — those are the five that are ALWAYS skipped, so a blank
    // reason there would leave the operator with five unexplained amber lines and no next step.
    for (const key of ['source-wiring', 'confirmation-queue', 'acceptance-dry-run', 'acceptance-apply', 'acceptance-idempotent']) {
      const step = root.querySelector(`[data-testid="stock-prep-install-step"][data-step="${key}"]`) as HTMLElement
      const held = step.querySelector('[data-testid="stock-prep-install-step-reason"]') as HTMLElement
      expect(held, `${key} must carry a reason element`).not.toBeNull()
      expect((held.textContent ?? '').trim().length, `${key} must say why it is skipped`).toBeGreaterThan(20)
    }
  })

  it('V-10: the 技术详情 disclosure carries the paste-able fix line VERBATIM', async () => {
    // Plain language is the default and the technical detail is DEMOTED, never deleted. The fix line
    // is the sharpest case: an operator copies it into a terminal, so a summarised, prettified or
    // re-composed version is a WRONG fix. It has to survive the rewrite byte-for-byte, inside a real
    // disclosure that is keyboard-operable and reports its own state.
    installRoutes({ preflightReady: false })
    const root = await mountView()
    ;(root.querySelector('[data-testid="stock-prep-install-preflight-run"]') as HTMLButtonElement).click()
    await flush()

    const disclosure = root.querySelector('[data-testid="stock-prep-install-preflight-tech"]') as HTMLDetailsElement
    expect(disclosure, 'the preflight panel must carry a technical disclosure').not.toBeNull()
    expect(disclosure.tagName.toLowerCase(), 'a real <details>, not a CSS-only hide').toBe('details')

    // Collapsed by default, and the state is on the summary rather than implied.
    const summary = disclosure.querySelector('summary') as HTMLElement
    expect(summary).not.toBeNull()
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(disclosure.open).toBe(false)
    summary.click()
    await nextTick()
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(disclosure.open).toBe(true)

    // THE fix line, inside that disclosure, verbatim and alone in its element.
    const fix = disclosure.querySelector('[data-testid="stock-prep-install-blocker-fix"]') as HTMLElement
    expect(fix, 'the fix line must live inside the technical disclosure').not.toBeNull()
    expect((fix.textContent ?? '').trim()).toBe(LEDGER_FIX)

    // ...and the blocker itself reads as a sentence out in the open, with its code subordinate.
    const blocker = root.querySelector('[data-testid="stock-prep-install-blocker"]') as HTMLElement
    expect(blocker.textContent).toContain('确认账本这张表还没建好')
    expect(text(root, '[data-testid="stock-prep-install-blocker-next"]')).toContain('开始安装')
    expect(blocker.textContent).toContain('STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY')
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
  // V-08 a proxy answering 200 with HTML must not read as a finished install
  // ---------------------------------------------------------------------------

  it('V-08: a 2xx that is not the API envelope renders FAIL, not OK', async () => {
    h.permissions = ['stock-prep:admin', 'integration:admin']
    installRoutes()
    // Everything up to the ledger ensure behaves; the ensure gets an auth proxy's sign-in page.
    const good = h.apiFetch.getMockImplementation() as (input: string) => Promise<Response>
    h.apiFetch.mockImplementation(async (input: string) => (
      String(input).includes('/confirmation-decisions/ensure')
        ? new Response('<!doctype html><title>Sign in</title>', { status: 200, headers: { 'Content-Type': 'text/html' } })
        : good(input)
    ))

    const root = await mountView()
    ;(root.querySelector('[data-testid="stock-prep-install-run"]') as HTMLButtonElement).click()
    await flush(14)

    const managed = root.querySelector('[data-testid="stock-prep-install-step"][data-step="managed-tables"]') as HTMLElement
    expect(managed.dataset.status, 'a 200 carrying HTML must not read as a provisioned table').toBe('fail')
    expect(managed.textContent).toContain('status=200')
    // The operator is told WHICH failure this is — a gateway answered, not the server refusing.
    expect(managed.textContent).toContain('网关')
    expect(text(root, '[data-testid="stock-prep-install-summary"]')).toContain('FAIL 1')
    // And nothing of the HTML body reaches the page.
    expect(root.textContent ?? '').not.toContain('Sign in')
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

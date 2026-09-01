import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// BOM备料 数据来源 — the DOM half of 工作台里选源.
//
// WHAT THE PANEL REPLACES. Pointing 备料 at a customer's own PLM used to mean an implementer opened a
// shell, edited INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON, and restarted the backend.
// This is that, as a dropdown. The suite drives the real component over a mocked `apiFetch`, so the
// real service (sourceBinding.ts) runs underneath it.
//
// Guards (each RED-witnessed by mutation; see the PR body's mutation table):
//   S-01 the current source and its ORIGIN render in plain words, name first, id beside it
//   S-02 the picker offers exactly what the SERVER called eligible — the page filters nothing itself
//   S-03 Save is a CONFIRM-then-act, and it POSTs the chosen id (and only that id) to the route
//   S-04 the 生效无需重启 affordance renders, and is driven by the server's own flag rather than
//        asserted by the page
//   S-05 R-11: a `stock-prep:admin` holder gets a READ-ONLY panel — no select, no Save — and is told
//        who changes it; and the page never calls the admin-tier route on their behalf
//   S-06 a refusal renders the server's closed REASON in plain words plus the HTTP status, and never
//        a server message
//   S-07 VALUES-FREE: business values and a credential planted in the payloads never reach the DOM

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

// Exact-code matching, the same double the neighbouring stock-prep suites use: the permission LADDER
// lives in workbenchAccess.ts and is exercised by stockPrepPermissionMatrix.spec.ts, so reproducing
// it here would only give the two a way to drift.
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

import StockPreparationSourceBindingPanel from '../src/components/integration/stockPreparation/StockPreparationSourceBindingPanel.vue'

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-default' }
const BINDING_ROUTE = '/api/integration/stock-preparation/source-binding'

const DEMO_SOURCE = 'sys_synthetic_demo'
const CUSTOMER_PLM = 'sys_customer_plm'

/** Planted business values / credentials. None may reach the DOM. */
const PLANTED_DSN = 'sqlserver://sa:hunter2@10.2.3.4/PLM'
const PLANTED_DRAWING_NO = 'DWG-51190-C'
const PLANTED_PROJECT_NAME = '涡轮增压器总成'
const FORBIDDEN = [PLANTED_DSN, PLANTED_DRAWING_NO, PLANTED_PROJECT_NAME]

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}

function refusal(status: number, code: string, reason?: string): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code,
        // A server MESSAGE that quotes a value. The page must never render it.
        message: `refused for ${PLANTED_DSN}`,
        ...(reason ? { details: { reason } } : {}),
      },
    }),
    { status },
  )
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalSystemId: CUSTOMER_PLM,
    name: '客户 PLM 只读库',
    kind: 'data-source:sql-readonly',
    kindLabel: { zh: '只读数据库桥接', en: 'Read-only database bridge' },
    status: 'active',
    role: 'source',
    ...overrides,
  }
}

function bindingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actionId: 'plm.stock-preparation.pull-bom.v1',
    effectiveExternalSystemId: DEMO_SOURCE,
    effectiveSourceKind: 'data-source:sql-readonly',
    origin: 'deploy_default',
    persistedBinding: null,
    effectiveSourceProblem: null,
    takesEffectWithoutRestart: true,
    eligibleSources: [
      candidate({ externalSystemId: DEMO_SOURCE, name: '内置演示源' }),
      candidate(),
      candidate({
        externalSystemId: 'sys_bridge',
        name: '旧库桥接',
        kind: 'bridge:legacy-sql-readonly',
        kindLabel: { zh: '旧库只读桥接 (Bridge Agent)', en: 'Legacy read-only bridge (Bridge Agent)' },
      }),
    ],
    ...overrides,
  }
}

interface Behaviour {
  get?: () => Response
  post?: () => Response
  /** The payload the SECOND GET (the post-save re-read) returns. */
  afterSave?: Record<string, unknown>
}

let posted: Array<{ url: string; body: unknown }> = []
let getCount = 0

function installRoutes(behaviour: Behaviour = {}): void {
  posted = []
  getCount = 0
  h.apiFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes('/stock-preparation/source-binding')) return envelope({})
    if (init?.method === 'POST') {
      posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      return behaviour.post ? behaviour.post() : envelope({
        actionId: 'plm.stock-preparation.pull-bom.v1',
        binding: {
          tenantId: SCOPE.tenantId,
          workspaceId: SCOPE.workspaceId,
          actionId: 'plm.stock-preparation.pull-bom.v1',
          externalSystemId: CUSTOMER_PLM,
          updatedBy: 'u_admin',
          createdAt: 't0',
          updatedAt: 't0',
        },
        changed: true,
        takesEffectWithoutRestart: true,
      })
    }
    getCount += 1
    if (getCount > 1 && behaviour.afterSave) return envelope(behaviour.afterSave)
    return behaviour.get ? behaviour.get() : envelope(bindingPayload())
  })
}

async function flush(cycles = 8): Promise<void> {
  for (let turn = 0; turn < cycles; turn += 1) {
    await new Promise((done) => { setTimeout(done, 0) })
    await nextTick()
  }
}

describe('BOM备料 数据来源 (工作台里选源)', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    // A platform admin by default — the tier both source-binding routes require.
    h.permissions = ['integration:admin', 'stock-prep:admin']
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
    app = createApp(StockPreparationSourceBindingPanel as Component, { scope: SCOPE })
    app.mount(container!)
    await flush()
    return container!
  }

  function node(root: HTMLElement, testid: string): HTMLElement | null {
    return root.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null
  }

  function text(root: HTMLElement, testid: string): string {
    return node(root, testid)?.textContent ?? ''
  }

  // -------------------------------------------------------------------------
  // S-01 — the current source, in words.
  // -------------------------------------------------------------------------

  it('S-01: shows the current source by NAME with its id beside it, and says where that choice came from', async () => {
    const root = await mountPanel()
    expect(node(root, 'stock-prep-source-binding')).not.toBeNull()

    // Name first (#5391), the identifier subordinate.
    expect(text(root, 'stock-prep-source-current-name')).toContain('内置演示源')
    expect(text(root, 'stock-prep-source-current-id')).toContain(DEMO_SOURCE)

    // ORIGIN in plain words: nothing chosen yet, so the deploy-time default is in use. This is the
    // sentence that tells an admin the screen is theirs to act on.
    const origin = text(root, 'stock-prep-source-origin')
    expect(origin).toContain('尚未选择')
    expect(origin).toContain('默认源')

    // ...and once a source IS bound, the origin line says so instead.
    if (app) app.unmount()
    installRoutes({
      get: () => envelope(bindingPayload({
        effectiveExternalSystemId: CUSTOMER_PLM,
        origin: 'persisted',
        persistedBinding: {
          tenantId: SCOPE.tenantId,
          workspaceId: SCOPE.workspaceId,
          actionId: 'plm.stock-preparation.pull-bom.v1',
          externalSystemId: CUSTOMER_PLM,
          updatedBy: 'u_admin',
          createdAt: 't0',
          updatedAt: 't1',
        },
      })),
    })
    const bound = await mountPanel()
    expect(text(bound, 'stock-prep-source-current-name')).toContain('客户 PLM 只读库')
    expect(text(bound, 'stock-prep-source-origin')).toContain('已在本页选定')
  })

  // -------------------------------------------------------------------------
  // S-02 — the page filters nothing.
  // -------------------------------------------------------------------------

  it('S-02: offers exactly the sources the server called eligible, labelled in plain language', async () => {
    const root = await mountPanel()
    const options = Array.from(root.querySelectorAll('[data-testid="stock-prep-source-option"]')) as HTMLOptionElement[]
    expect(options.map((option) => option.value).sort()).toEqual([CUSTOMER_PLM, DEMO_SOURCE, 'sys_bridge'].sort())

    // The connector KIND is shown in words from 对接总览's own register, not as a raw token.
    const labels = options.map((option) => option.textContent ?? '')
    expect(labels.join(' ')).toContain('只读数据库桥接')
    expect(labels.join(' ')).toContain('旧库只读桥接 (Bridge Agent)')
    expect(labels.join(' ')).toContain('客户 PLM 只读库')

    // A server that filters everything out yields the "register one first" line, not an empty
    // dropdown with no explanation.
    if (app) app.unmount()
    installRoutes({ get: () => envelope(bindingPayload({ eligibleSources: [] })) })
    const empty = await mountPanel()
    expect(node(empty, 'stock-prep-source-empty')).not.toBeNull()
    expect(text(empty, 'stock-prep-source-empty')).toContain('先在「对接」里登记')
    expect(empty.querySelectorAll('[data-testid="stock-prep-source-option"]').length).toBe(0)
  })

  // -------------------------------------------------------------------------
  // S-03 — confirm, then act; and the request carries the id and nothing else.
  // -------------------------------------------------------------------------

  it('S-03: Save asks for confirmation first, then POSTs only the chosen external system id', async () => {
    const root = await mountPanel()
    const select = node(root, 'stock-prep-source-select') as HTMLSelectElement
    const save = node(root, 'stock-prep-source-save') as HTMLButtonElement

    // Nothing to save while the selection is still the current source.
    expect(save.disabled).toBe(true)

    select.value = CUSTOMER_PLM
    select.dispatchEvent(new Event('change'))
    await flush(2)
    expect((node(root, 'stock-prep-source-save') as HTMLButtonElement).disabled).toBe(false)

    // Pressing Save does NOT write — repointing 备料 at a different database changes what every
    // later row is built from, so it is a confirm-then-act.
    ;(node(root, 'stock-prep-source-save') as HTMLButtonElement).click()
    await flush(2)
    expect(posted).toEqual([])
    const confirm = node(root, 'stock-prep-source-confirm')
    expect(confirm).not.toBeNull()
    expect(text(root, 'stock-prep-source-confirm-text')).toContain('客户 PLM 只读库')
    expect(text(root, 'stock-prep-source-confirm-text')).toContain('每一次')

    ;(node(root, 'stock-prep-source-confirm-save') as HTMLButtonElement).click()
    await flush()

    expect(posted.length).toBe(1)
    // The body may name a source and NOTHING else: the server's allowlist 400s any other key, and
    // sending one would be a client trying to move what/how rather than where.
    expect(posted[0].body).toEqual({ externalSystemId: CUSTOMER_PLM })
    expect(node(root, 'stock-prep-source-saved')).not.toBeNull()
    expect(text(root, 'stock-prep-source-saved')).toContain('不用重启')

    // Cancel is a real escape hatch: it writes nothing.
    if (app) app.unmount()
    installRoutes()
    const second = await mountPanel()
    const secondSelect = node(second, 'stock-prep-source-select') as HTMLSelectElement
    secondSelect.value = CUSTOMER_PLM
    secondSelect.dispatchEvent(new Event('change'))
    await flush(2)
    ;(node(second, 'stock-prep-source-save') as HTMLButtonElement).click()
    await flush(2)
    ;(node(second, 'stock-prep-source-cancel') as HTMLButtonElement).click()
    await flush(2)
    expect(posted).toEqual([])
    expect(node(second, 'stock-prep-source-confirm')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // S-04 — the affordance, and that the SERVER drives it.
  // -------------------------------------------------------------------------

  it('S-04: renders 生效无需重启, and drops the claim when the server does not make it', async () => {
    const root = await mountPanel()
    const affordance = text(root, 'stock-prep-source-no-restart')
    expect(affordance).toContain('立即生效')
    expect(affordance).toContain('不需要重启')
    expect(affordance).toContain('不需要改服务器上的配置文件')

    // The page must not assert a backend property on its own authority: a server that stops claiming
    // it renders no claim, rather than a stale promise.
    if (app) app.unmount()
    installRoutes({ get: () => envelope(bindingPayload({ takesEffectWithoutRestart: false })) })
    const quiet = await mountPanel()
    expect(node(quiet, 'stock-prep-source-no-restart')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // S-05 — R-11.
  // -------------------------------------------------------------------------

  it('S-05: a workbench admin gets a read-only panel and the page never calls the admin route for them', async () => {
    h.permissions = ['stock-prep:admin', 'stock-prep:read', 'stock-prep:operate']
    const root = await mountPanel()

    // No control the caller cannot exercise.
    expect(node(root, 'stock-prep-source-select')).toBeNull()
    expect(node(root, 'stock-prep-source-save')).toBeNull()
    expect(node(root, 'stock-prep-source-confirm')).toBeNull()

    // Told, in words, who does change it — rather than shown a button that 403s.
    expect(text(root, 'stock-prep-source-readonly')).toContain('只有平台管理员')

    // And no admin-tier call was made on their behalf: a 403 rendered as an error would tell them a
    // control exists that does not exist for them.
    expect(h.apiFetch).not.toHaveBeenCalled()

    // An integration WRITER is outside this tier too — the picker is the POST's authority stated in
    // advance, so a principal the POST would refuse must not see it.
    if (app) app.unmount()
    h.permissions = ['integration:write', 'integration:read']
    const writer = await mountPanel()
    expect(node(writer, 'stock-prep-source-select')).toBeNull()
    expect(h.apiFetch).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // S-06 — refusals in words, never a server message.
  // -------------------------------------------------------------------------

  it('S-06: a refusal renders the closed reason in plain words plus the status, never the server message', async () => {
    const cases: Array<[number, string, string, string]> = [
      [422, 'SOURCE_BINDING_SOURCE_INELIGIBLE', 'kind_ineligible', '不是只读数据库类型'],
      [422, 'SOURCE_BINDING_SOURCE_INELIGIBLE', 'not_active', '还没有启用'],
      [422, 'SOURCE_BINDING_SOURCE_INELIGIBLE', 'data_source_not_accessible', '不归您管理'],
      [422, 'SOURCE_BINDING_SOURCE_INELIGIBLE', 'role_ineligible', '写入目标'],
      [404, 'SOURCE_BINDING_SOURCE_NOT_FOUND', 'not_found', '找不到这个连接'],
    ]
    for (const [status, code, reason, expected] of cases) {
      if (app) app.unmount()
      installRoutes({ post: () => refusal(status, code, reason) })
      const root = await mountPanel()
      const select = node(root, 'stock-prep-source-select') as HTMLSelectElement
      select.value = CUSTOMER_PLM
      select.dispatchEvent(new Event('change'))
      await flush(2)
      ;(node(root, 'stock-prep-source-save') as HTMLButtonElement).click()
      await flush(2)
      ;(node(root, 'stock-prep-source-confirm-save') as HTMLButtonElement).click()
      await flush()

      const error = text(root, 'stock-prep-source-error')
      expect(error, `${reason} renders its plain-language explanation`).toContain(expected)
      expect(error).toContain(`HTTP ${status}`)
      // The server's own message quoted a credential. It must not be on the page.
      expect(root.textContent).not.toContain(PLANTED_DSN)
      expect(root.textContent).not.toContain('refused for')
      // Nothing claims a save happened.
      expect(node(root, 'stock-prep-source-saved')).toBeNull()
    }

    // A refusal with no reason token still renders honestly rather than blank.
    if (app) app.unmount()
    installRoutes({ get: () => refusal(500, 'INTERNAL_ERROR') })
    const opaque = await mountPanel()
    expect(text(opaque, 'stock-prep-source-error')).toContain('HTTP 500')
    expect(opaque.textContent).not.toContain(PLANTED_DSN)
  })

  // -------------------------------------------------------------------------
  // S-08 — the cross-kind refusal, and the unusable-current-source warning.
  //
  // The server refuses a cross-kind bind (its `source.kind` is frozen deploy config and the read
  // path re-checks it), and it only claims 生效无需重启 when the current source actually works. The
  // page has to render BOTH honestly, or the admin is back to discovering the problem on a failed
  // refresh — the exact cost this feature removes.
  // -------------------------------------------------------------------------

  it('S-08: a kind_mismatch refusal is explained in plain words, and an unusable current source is named', async () => {
    installRoutes({ post: () => refusal(422, 'SOURCE_BINDING_SOURCE_INELIGIBLE', 'kind_mismatch') })
    const root = await mountPanel()
    const select = node(root, 'stock-prep-source-select') as HTMLSelectElement
    select.value = CUSTOMER_PLM
    select.dispatchEvent(new Event('change'))
    await flush(2)
    ;(node(root, 'stock-prep-source-save') as HTMLButtonElement).click()
    await flush(2)
    ;(node(root, 'stock-prep-source-confirm-save') as HTMLButtonElement).click()
    await flush()

    const error = text(root, 'stock-prep-source-error')
    // Not "wrong kind" but WHY it cannot be used here, and who can change it.
    expect(error).toContain('按另一种连接方式装的')
    expect(error).toContain('实施同事')
    expect(error).toContain('HTTP 422')
    expect(root.textContent).not.toContain(PLANTED_DSN)
    expect(node(root, 'stock-prep-source-saved')).toBeNull()

    // A deployment whose CURRENT source is unreadable: the problem is named, and the no-restart
    // promise is withheld because the server withheld it.
    if (app) app.unmount()
    installRoutes({
      get: () => envelope(bindingPayload({
        effectiveSourceProblem: 'not_active',
        takesEffectWithoutRestart: false,
      })),
    })
    const broken = await mountPanel()
    expect(node(broken, 'stock-prep-source-problem')).not.toBeNull()
    expect(text(broken, 'stock-prep-source-problem')).toContain('当前来源现在读不了')
    expect(text(broken, 'stock-prep-source-problem')).toContain('还没有启用')
    expect(node(broken, 'stock-prep-source-no-restart')).toBeNull()
    // The picker still renders — this state is repairable, and this screen is the repair.
    expect(node(broken, 'stock-prep-source-select')).not.toBeNull()

    // A healthy payload shows no problem line.
    if (app) app.unmount()
    installRoutes()
    const healthy = await mountPanel()
    expect(node(healthy, 'stock-prep-source-problem')).toBeNull()
    expect(node(healthy, 'stock-prep-source-no-restart')).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // S-07 — values-free.
  // -------------------------------------------------------------------------

  it('S-07: business values and credentials planted in the payloads never reach the DOM', async () => {
    installRoutes({
      get: () => envelope({
        ...bindingPayload(),
        // A server that grew value-bearing keys must not be able to paint them onto this page.
        dsn: PLANTED_DSN,
        lastProjectName: PLANTED_PROJECT_NAME,
        eligibleSources: [
          candidate({ dsn: PLANTED_DSN, sampleDrawingNo: PLANTED_DRAWING_NO }),
          candidate({ externalSystemId: DEMO_SOURCE, name: '内置演示源', config: { dataSourceId: 'ds_demo', password: 'hunter2' } }),
        ],
      }),
    })
    const root = await mountPanel()
    for (const forbidden of FORBIDDEN) {
      expect(root.textContent, `must not render ${forbidden}`).not.toContain(forbidden)
    }
    expect(root.textContent).not.toContain('hunter2')
    expect(root.textContent).not.toContain('ds_demo')
    // ...while still rendering the things it is supposed to.
    expect(root.textContent).toContain('客户 PLM 只读库')
  })
})
